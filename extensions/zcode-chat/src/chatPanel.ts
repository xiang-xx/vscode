/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentProgressEvent } from './agentRuntime';
import type { AskUserAnswer, AskUserPrompt, AskUserResult } from './askUser';
import { getAuthService } from './authSession';
import {
	BRAIN_LABELS,
	BRAINS,
	getActiveBrain,
	getCursorAgentMode,
	getCursorModel,
	pickActiveBrain,
	setActiveBrain,
	setCursorAgentMode,
	setCursorModel,
	type CursorAgentMode,
} from './brains';
import { completeChatTurn, getBridgeMode, getCursorBrainStatusLine, workspaceRoot, type ChatMessage } from './bridge';
import { buildPlusMenuSections, formatSlashInsert } from './composerActions';
import {
	formatWorkDuration,
	newItemId,
	toolDisplayName,
	type ConversationItem,
	type TodoItem,
} from './conversation';
import { listCursorModels } from './cursorAuth';
import {
	ensureModelForProvider,
	ensureReasoningLevelForModel,
	getSelectedModelId,
	getSelectedReasoningLevel,
	modelsForProvider,
	REASONING_LABELS,
	setSelectedModelId,
	setSelectedReasoningLevel,
} from './models';
import {
	getProviderMode,
	pickProviderMode,
	PROVIDER_LABELS,
	PROVIDER_MODES,
	setProviderMode,
	type ProviderMode,
} from './providers';
import {
	getFileEditSession,
	type FileChangeView,
	type FileEditSession,
} from './fileEditSession';
import {
	IDE_CHAT_SOURCE_CURSOR,
	IDE_CHAT_SOURCE_ZCODE,
	IdeChatStore,
	titleFromMessages,
	type IdeChatSessionMeta,
} from './ideChatStore';
import { computeContextUsage, type ContextUsageSnapshot } from './contextUsage';
import { getZcodeScheduleTip } from './zcodeScheduleTip';

const VIEW_ID = 'zcode.chatView';

const CHAT_FONT_SIZE_DEFAULT = 15;
const CHAT_FONT_SIZE_MIN = 11;
const CHAT_FONT_SIZE_MAX = 24;

/** Chat stream font size from `zcode.chatFontSize`, clamped to a sane range. */
function getChatFontSize(): number {
	const size = vscode.workspace.getConfiguration('zcode').get<number>('chatFontSize');
	if (typeof size !== 'number' || !Number.isFinite(size)) {
		return CHAT_FONT_SIZE_DEFAULT;
	}
	return Math.min(CHAT_FONT_SIZE_MAX, Math.max(CHAT_FONT_SIZE_MIN, size));
}

interface AttachmentChip {
	id: string;
	name: string;
	fsPath: string;
	/** Prompt header for an editor selection, e.g. a relative path and line range. */
	detail?: string;
	/** Selected text included verbatim when the message is sent. */
	excerpt?: string;
	languageId?: string;
}

function formatAttachmentBlock(attachments: AttachmentChip[]): string {
	if (!attachments.length) {
		return '';
	}
	const blocks = attachments.map(attachment => {
		if (attachment.excerpt === undefined) {
			return `- ${attachment.fsPath}`;
		}
		const header = attachment.detail ?? attachment.name;
		const body = attachment.excerpt.replace(/\s+$/, '');
		const lang = attachment.languageId ?? '';
		return `${header}\n\`\`\`${lang}\n${body}\n\`\`\``;
	});
	const selectionOnly = attachments.every(attachment => attachment.excerpt !== undefined);
	if (selectionOnly) {
		return `The user attached the following editor selection as context. Use it when answering.\n\n${blocks.join('\n\n')}\n\n`;
	}
	return `Attachments:\n${blocks.join('\n\n')}\n\n`;
}

function selectionLineSpan(range: vscode.Range): { start: number; end: number } {
	const start = range.start.line + 1;
	let end = range.end.line + 1;
	if (range.end.character === 0 && end > start) {
		end -= 1;
	}
	return { start, end };
}

interface QueuedMessage {
	id: string;
	text: string;
}

/** Mutable chat fields shared by the active view and parked background sessions. */
interface MutableChat {
	items: ConversationItem[];
	todos: TodoItem[];
	persisted: boolean;
	draftText: string;
	attachments: AttachmentChip[];
	queue: QueuedMessage[];
	queuePaused: boolean;
	activeStatusId?: string;
	activeAssistantId?: string;
	activeReasoningId?: string;
	activeReasoningStartedAt?: number;
	activeWorkId?: string;
	turnStartedAt?: number;
}

export class ZCodeChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = VIEW_ID;

	private view?: vscode.WebviewView;
	private items: ConversationItem[] = [];
	private attachments: AttachmentChip[] = [];
	private todos: TodoItem[] = [];
	private draftText = '';
	/** Focus the composer after the webview finishes loading. */
	private pendingFocusInput = false;
	/** Selection chips that must survive the first session bootstrap. */
	private selectionQueue: AttachmentChip[] | undefined;
	private queue: QueuedMessage[] = [];
	/** After stop/error, do not auto-drain until the user resumes. */
	private queuePaused = false;
	/** Prefer this text on the next idle tick (send-now / interrupt). */
	private pendingForceSend?: string;
	private pendingAsk?: {
		id: string;
		resolve: (result: AskUserResult) => void;
	};
	private sessionId?: string;
	private sessionList: IdeChatSessionMeta[] = [];
	/** Open session tabs (persisted via IdeChatStore + optional draft). */
	private openTabIds: string[] = [];
	/** False until the first non-empty persist — empty drafts stay out of history. */
	private sessionPersisted = false;
	/** Webview history drawer visibility (toggled from view title). */
	private historyOpen = false;
	/** Sessions that finished a turn and still need a done badge. */
	private unreadDoneIds = new Set<string>();
	/** Session currently running an AI turn (for pulse marker). */
	private runningSessionId?: string;
	private runCancel?: vscode.CancellationTokenSource;
	/** Parked sessions (including a mid-run chat while viewing another tab). */
	private readonly parked = new Map<string, MutableChat>();
	private activeStatusId?: string;
	private activeAssistantId?: string;
	private activeReasoningId?: string;
	private activeReasoningStartedAt?: number;
	private activeWorkId?: string;
	private turnStartedAt?: number;
	private elapsedTimer?: ReturnType<typeof setInterval>;

	private fileChanges: FileChangeView[] = [];
	private cursorModels: string[] = [];
	private cursorAccountLabel = 'Cursor · checking…';
	/** Last provider-reported total tokens for the active session (if any). */
	private reportedUsageTokens?: number;

	/** True when the visible tab is the one with an in-flight AI turn. */
	private get busy(): boolean {
		return !!this.runningSessionId && this.runningSessionId === this.sessionId;
	}

	private scheduleTipTimer?: ReturnType<typeof setInterval>;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly ideChat: IdeChatStore,
		private readonly fileEdits: FileEditSession,
	) {
		this.fileEdits.onDidChange(() => {
			this.fileChanges = this.fileEdits.list();
			this.pushState();
		});
		void this.refreshCursorMeta();
	}

	private async refreshCursorMeta(): Promise<void> {
		this.cursorAccountLabel = await getCursorBrainStatusLine();
		if (getActiveBrain() === 'cursor') {
			this.cursorModels = await listCursorModels().catch(() => []);
		}
		this.pushState();
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
		};
		webviewView.webview.html = this.renderHtml(webviewView.webview);
		webviewView.webview.onDidReceiveMessage(async (message) => {
			await this.onMessage(message);
		});
		webviewView.onDidDispose(() => {
			if (this.scheduleTipTimer) {
				clearInterval(this.scheduleTipTimer);
				this.scheduleTipTimer = undefined;
			}
		});
		if (this.scheduleTipTimer) {
			clearInterval(this.scheduleTipTimer);
		}
		// Refresh tip when crossing the 14:00 / 18:00 boundary without user action.
		this.scheduleTipTimer = setInterval(() => this.pushState(), 60_000);
		void this.bootstrapSession();
	}

	async newChat(): Promise<void> {
		await this.startNewSession();
	}

	async openSessionFromTitle(sessionId: string): Promise<void> {
		await this.openSession(sessionId);
	}

	async closeTabFromTitle(sessionId: string): Promise<void> {
		await this.closeTab(sessionId);
	}

	/** Cmd/Ctrl+W while the chat view has focus: close the selected tab. */
	async closeActiveTab(): Promise<void> {
		if (this.sessionId) {
			await this.closeTab(this.sessionId);
		}
	}

	clearTabDoneFromTitle(sessionId: string): void {
		this.unreadDoneIds.delete(sessionId);
		this.pushState();
	}

	toggleHistory(): void {
		this.historyOpen = !this.historyOpen;
		this.pushState();
	}

	private isSessionEmpty(): boolean {
		return IdeChatStore.messagesFromTimeline(this.items).length === 0;
	}

	private draftSessionOptions() {
		return {
			source: this.sessionSource(),
			workspaceRoot: workspaceRoot(),
			provider: getActiveBrain() === 'cursor' ? 'cursor' : getProviderMode(),
			model: getActiveBrain() === 'cursor' ? getCursorModel() : getSelectedModelId(getProviderMode()),
		};
	}

	async open(): Promise<void> {
		await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar');
		await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
	}

	/**
	 * Cursor-style add-to-chat: the active selection becomes a composer chip.
	 * An empty selection uses the line the cursor is on.
	 */
	async addEditorSelectionToChat(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		this.selectionQueue = editor ? this.buildSelectionChips(editor) : [];
		this.applySelectionQueue();
		if (this.view) {
			await this.open();
			this.pushState({ focusInput: true });
			this.selectionQueue = undefined;
			return;
		}
		this.pendingFocusInput = true;
		await this.open();
	}

	async switchProvider(): Promise<void> {
		if (getActiveBrain() === 'cursor') {
			await this.switchBrain();
			return;
		}
		const next = await pickProviderMode();
		if (!next) {
			return;
		}
		await this.applyProvider(next);
		void vscode.window.setStatusBarMessage(`ZCode provider: ${PROVIDER_LABELS[next]}`, 2500);
	}

	async switchBrain(): Promise<void> {
		const next = await pickActiveBrain();
		if (!next) {
			return;
		}
		await setActiveBrain(next);
		await this.refreshCursorMeta();
		void vscode.window.setStatusBarMessage(`AI brain: ${BRAIN_LABELS[next]}`, 2500);
		this.pushState();
	}

	refresh(): void {
		void this.refreshCursorMeta();
		this.pushState();
	}

	private async applyProvider(provider: ProviderMode): Promise<void> {
		await setProviderMode(provider);
		const modelId = await ensureModelForProvider(provider);
		await ensureReasoningLevelForModel(provider, modelId);
		this.pushState();
	}

	private async onMessage(message: unknown): Promise<void> {
		if (!message || typeof message !== 'object') {
			return;
		}
		const msg = message as {
			type?: string;
			text?: string;
			id?: string;
			uri?: string;
			mode?: string;
			brain?: string;
			sessionId?: string;
			provider?: string;
			model?: string;
			reasoningLevel?: string;
			actionId?: string;
			slash?: string;
			draft?: string;
			attachmentId?: string;
			open?: boolean;
			answers?: AskUserAnswer[];
			reason?: string;
		};

		if (msg.type === 'ready') {
			void this.bootstrapSession().then(() => {
				if (!this.pendingFocusInput) {
					return;
				}
				this.applySelectionQueue();
				this.pendingFocusInput = false;
				this.selectionQueue = undefined;
				this.pushState({ focusInput: true });
			});
			return;
		}
		if (msg.type === 'draft' && typeof msg.draft === 'string') {
			this.draftText = msg.draft;
			this.pushContextUsage();
			return;
		}
		if (msg.type === 'openPlus') {
			if (typeof msg.draft === 'string') {
				this.draftText = msg.draft;
			}
			this.pushState({ openPlus: true });
			return;
		}
		if (msg.type === 'setBrain' && (msg.brain === 'zcode' || msg.brain === 'cursor')) {
			await setActiveBrain(msg.brain);
			await this.refreshCursorMeta();
			this.pushState();
			return;
		}
		if (msg.type === 'setProvider' && (msg.provider === 'startPlan' || msg.provider === 'bigmodel')) {
			await this.applyProvider(msg.provider);
			return;
		}
		if (msg.type === 'setCursorMode' && (msg.mode === 'agent' || msg.mode === 'plan' || msg.mode === 'ask')) {
			await setCursorAgentMode(msg.mode);
			this.pushState();
			return;
		}
		if (msg.type === 'setCursorModel' && typeof msg.model === 'string') {
			await setCursorModel(msg.model);
			this.pushState();
			return;
		}
		if (msg.type === 'setModel' && typeof msg.model === 'string') {
			if (getActiveBrain() === 'cursor') {
				await setCursorModel(msg.model);
				this.pushState();
				return;
			}
			const provider = getProviderMode();
			if (modelsForProvider(provider).some(m => m.id === msg.model)) {
				await setSelectedModelId(msg.model);
				await ensureReasoningLevelForModel(provider, msg.model);
				this.pushState();
			}
			return;
		}
		if (msg.type === 'setReasoningLevel' && typeof msg.reasoningLevel === 'string') {
			const provider = getProviderMode();
			const model = modelsForProvider(provider).find(m => m.id === getSelectedModelId(provider));
			if (model?.reasoningLevels.includes(msg.reasoningLevel)) {
				await setSelectedReasoningLevel(msg.reasoningLevel);
				this.pushState();
			}
			return;
		}
		if (msg.type === 'clear' || msg.type === 'newChat') {
			await this.startNewSession();
			return;
		}
		if (msg.type === 'stop') {
			this.stopRunning();
			return;
		}
		if (msg.type === 'answerQuestion' && typeof msg.id === 'string' && Array.isArray(msg.answers)) {
			this.resolveAsk(msg.id, { outcome: 'answered', answers: msg.answers });
			return;
		}
		if (msg.type === 'skipQuestion' && typeof msg.id === 'string') {
			this.resolveAsk(msg.id, {
				outcome: 'skipped',
				reason: typeof msg.reason === 'string' ? msg.reason : 'User skipped',
			});
			return;
		}
		if (msg.type === 'enqueue' && typeof msg.text === 'string') {
			await this.enqueueMessage(msg.text);
			return;
		}
		if (msg.type === 'removeQueueItem' && typeof msg.id === 'string') {
			this.queue = this.queue.filter(item => item.id !== msg.id);
			this.pushState();
			return;
		}
		if (msg.type === 'editQueueItem' && typeof msg.id === 'string') {
			const item = this.queue.find(row => row.id === msg.id);
			if (!item) {
				return;
			}
			if (this.draftText.trim() || this.attachments.length) {
				void vscode.window.showWarningMessage('请先发送或清空当前草稿，再编辑队列消息。');
				return;
			}
			this.queue = this.queue.filter(row => row.id !== msg.id);
			this.draftText = item.text;
			this.pushState({ clearDraft: true, insertText: item.text });
			return;
		}
		if (msg.type === 'runQueueItem' && typeof msg.id === 'string') {
			await this.runQueueItemNow(msg.id);
			return;
		}
		if (msg.type === 'resumeQueue') {
			this.queuePaused = false;
			this.pushState();
			void this.flushQueue(this.sessionId);
			return;
		}
		if (msg.type === 'toggleHistory') {
			this.historyOpen = !this.historyOpen;
			this.pushState();
			return;
		}
		if (msg.type === 'setHistoryOpen') {
			this.historyOpen = msg.open === true;
			this.pushState();
			return;
		}
		if (msg.type === 'openSession' && typeof msg.sessionId === 'string') {
			await this.openSession(msg.sessionId);
			return;
		}
		if (msg.type === 'closeTab' && typeof msg.sessionId === 'string') {
			await this.closeTab(msg.sessionId);
			return;
		}
		if (msg.type === 'clearTabDone' && typeof msg.sessionId === 'string') {
			this.unreadDoneIds.delete(msg.sessionId);
			this.pushState();
			return;
		}
		if (msg.type === 'deleteSession' && typeof msg.sessionId === 'string') {
			await this.deleteSession(msg.sessionId);
			return;
		}
		if (msg.type === 'openFileChange' && typeof msg.uri === 'string') {
			await this.fileEdits.open(msg.uri, msg.mode === 'diff' ? 'diff' : 'file');
			return;
		}
		if (msg.type === 'keepFileChanges') {
			await this.fileEdits.keep(typeof msg.uri === 'string' ? [msg.uri] : undefined);
			return;
		}
		if (msg.type === 'undoFileChanges') {
			await this.fileEdits.undo(typeof msg.uri === 'string' ? [msg.uri] : undefined);
			return;
		}
		if (msg.type === 'viewAllFileChanges') {
			await this.fileEdits.openAllChanges();
			return;
		}
		if (msg.type === 'toggleReasoning' && typeof msg.id === 'string') {
			const row = this.items.find(i => i.id === msg.id);
			if (row && row.kind === 'reasoning') {
				row.expanded = !row.expanded;
				this.pushState();
			}
			return;
		}
		if (msg.type === 'toggleTool' && typeof msg.id === 'string') {
			const row = this.items.find(i => i.id === msg.id);
			if (row && row.kind === 'tool' && (row.detail || row.uri)) {
				row.expanded = !row.expanded;
				this.pushState();
			}
			return;
		}
		if (msg.type === 'manageAccount') {
			await vscode.commands.executeCommand('zcode.manageAccount');
			return;
		}
		if (msg.type === 'removeAttachment' && typeof msg.attachmentId === 'string') {
			this.attachments = this.attachments.filter(a => a.id !== msg.attachmentId);
			this.pushState();
			return;
		}
		if (msg.type === 'plusAction' && typeof msg.actionId === 'string') {
			await this.handlePlusAction(msg.actionId, msg.slash);
			return;
		}
		if (msg.type === 'send' && typeof msg.text === 'string') {
			this.draftText = msg.text;
			const text = msg.text.trim();
			if (!text && this.attachments.length === 0) {
				return;
			}
			if (this.busy) {
				await this.enqueueMessage(msg.text);
				return;
			}
			await this.handleSend(text);
		}
	}

	private async handlePlusAction(actionId: string, slash?: string): Promise<void> {
		if (actionId === 'attach-files') {
			await this.pickAttachments();
			return;
		}
		if (actionId === 'mention-file') {
			await this.pickFileMention();
			return;
		}
		if (actionId.startsWith('slash:') || slash) {
			const name = slash ?? actionId.slice('slash:'.length);
			if (name === 'new' || name === 'clear') {
				await this.startNewSession();
				return;
			}
			if (name === 'effort') {
				await vscode.commands.executeCommand('zcode.switchReasoningLevel');
				return;
			}
			if (name === 'model') {
				await vscode.commands.executeCommand('zcode.switchModel');
				return;
			}
			if (name === 'login') {
				await vscode.commands.executeCommand('zcode.signIn');
				return;
			}
			this.pushState({ insertText: formatSlashInsert(name) });
		}
	}

	private async pickAttachments(): Promise<void> {
		const uris = await vscode.window.showOpenDialog({
			canSelectMany: true,
			openLabel: 'Attach',
			title: 'Attach files to ZCode message',
		});
		if (!uris?.length) {
			return;
		}
		for (const uri of uris) {
			this.attachments.push({
				id: `${uri.fsPath}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
				name: path.basename(uri.fsPath),
				fsPath: uri.fsPath,
			});
		}
		this.pushState();
	}

	private buildSelectionChips(editor: vscode.TextEditor): AttachmentChip[] {
		const document = editor.document;
		const ranges = editor.selections.some(selection => !selection.isEmpty)
			? editor.selections.filter(selection => !selection.isEmpty)
			: [document.lineAt(editor.selection.active.line).range];
		const root = workspaceRoot();
		const filePath = document.uri.fsPath;
		const fsPath = document.uri.scheme === 'file' ? filePath : document.uri.toString();
		const base = path.basename(document.fileName);
		const inWorkspace = document.uri.scheme === 'file' && !!root && (filePath === root || filePath.startsWith(root + path.sep));
		const relative = inWorkspace && root
			? path.relative(root, filePath).split(path.sep).join('/')
			: base;
		const chips: AttachmentChip[] = [];
		for (const range of ranges) {
			const { start, end } = selectionLineSpan(range);
			const lineLabel = start === end ? `L${start}` : `L${start}-L${end}`;
			chips.push({
				id: `sel:${fsPath}:${document.offsetAt(range.start)}:${document.offsetAt(range.end)}`,
				name: `${base} (${lineLabel})`,
				fsPath,
				detail: `\`${relative}\` lines ${start}-${end}`,
				excerpt: document.getText(range),
				languageId: document.languageId,
			});
		}
		return chips;
	}

	private applySelectionQueue(): void {
		for (const chip of this.selectionQueue ?? []) {
			if (!this.attachments.some(attachment => attachment.id === chip.id)) {
				this.attachments.push(chip);
			}
		}
	}

	private async pickFileMention(): Promise<void> {
		const uris = await vscode.window.showOpenDialog({
			canSelectMany: false,
			openLabel: 'Reference',
			title: 'Insert @file reference',
			defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
		});
		const uri = uris?.[0];
		if (!uri) {
			return;
		}
		const root = workspaceRoot();
		const mention = root && uri.fsPath.startsWith(root)
			? `@${path.relative(root, uri.fsPath).split(path.sep).join('/')}`
			: `@${uri.fsPath}`;
		this.pushState({ insertText: `${mention} ` });
	}

	private stopRunning(): void {
		if (!this.runningSessionId || !this.runCancel) {
			return;
		}
		// Stopping pauses auto-drain so queued follow-ups are not lost silently.
		if (this.runningSessionId === this.sessionId) {
			this.queuePaused = true;
		} else {
			const parked = this.parked.get(this.runningSessionId);
			if (parked) {
				parked.queuePaused = true;
				this.parked.set(this.runningSessionId, parked);
			}
		}
		if (this.pendingAsk) {
			this.resolveAsk(this.pendingAsk.id, { outcome: 'cancelled' });
		}
		this.runCancel.cancel();
		this.pushState();
	}

	private waitForAsk(
		prompt: AskUserPrompt,
		token: vscode.CancellationToken,
	): Promise<AskUserResult> {
		if (this.pendingAsk) {
			this.resolveAsk(this.pendingAsk.id, { outcome: 'cancelled' });
		}
		return new Promise(resolve => {
			const cancel = token.onCancellationRequested(() => {
				this.resolveAsk(prompt.id, { outcome: 'cancelled' });
			});
			this.pendingAsk = {
				id: prompt.id,
				resolve: result => {
					cancel.dispose();
					resolve(result);
				},
			};
			this.mutateRunChat(chat => {
				this.clearStatusOn(chat);
				this.finishReasoningOn(chat);
				const existing = chat.items.find(i => i.id === prompt.id && i.kind === 'question');
				if (existing && existing.kind === 'question') {
					existing.title = prompt.title;
					existing.questions = prompt.questions;
					existing.status = 'pending';
					existing.answers = undefined;
				} else {
					chat.items.push({
						id: prompt.id,
						kind: 'question',
						title: prompt.title,
						questions: prompt.questions,
						status: 'pending',
					});
				}
				this.pinWorkToEndOn(chat);
			});
			this.pushState();
		});
	}

	private resolveAsk(id: string, result: AskUserResult): void {
		if (!this.pendingAsk || this.pendingAsk.id !== id) {
			return;
		}
		const pending = this.pendingAsk;
		this.pendingAsk = undefined;
		this.mutateRunChat(chat => {
			const row = chat.items.find(i => i.id === id && i.kind === 'question');
			if (row && row.kind === 'question') {
				row.status = result.outcome === 'answered' ? 'answered' : 'skipped';
				row.answers = result.outcome === 'answered' ? result.answers : undefined;
			}
		});
		this.pushState();
		pending.resolve(result);
	}

	private async enqueueMessage(raw: string): Promise<void> {
		const attachmentBlock = formatAttachmentBlock(this.attachments);
		const text = `${attachmentBlock}${raw}`.trim();
		if (!text) {
			return;
		}
		this.queue.push({ id: newItemId('queue'), text });
		this.attachments = [];
		this.draftText = '';
		this.pushState({ clearDraft: true });
	}

	private async runQueueItemNow(id: string): Promise<void> {
		const index = this.queue.findIndex(item => item.id === id);
		if (index < 0) {
			return;
		}
		const [item] = this.queue.splice(index, 1);
		this.queuePaused = false;
		this.pushState();
		if (this.busy) {
			this.pendingForceSend = item.text;
			this.runCancel?.cancel();
			return;
		}
		await this.handleSend(item.text);
	}

	private async flushQueue(sessionId: string | undefined): Promise<void> {
		if (!sessionId || sessionId !== this.sessionId || this.runningSessionId) {
			return;
		}
		if (this.queuePaused || !this.queue.length) {
			return;
		}
		const next = this.queue.shift()!;
		this.pushState();
		await this.handleSend(next.text);
	}

	private captureView(): MutableChat {
		return {
			items: this.items,
			todos: this.todos,
			persisted: this.sessionPersisted,
			draftText: this.draftText,
			attachments: [...this.attachments],
			queue: [...this.queue],
			queuePaused: this.queuePaused,
			activeStatusId: this.activeStatusId,
			activeAssistantId: this.activeAssistantId,
			activeReasoningId: this.activeReasoningId,
			activeReasoningStartedAt: this.activeReasoningStartedAt,
			activeWorkId: this.activeWorkId,
			turnStartedAt: this.turnStartedAt,
		};
	}

	private adoptView(chat: MutableChat): void {
		this.items = chat.items;
		this.todos = chat.todos;
		this.sessionPersisted = chat.persisted;
		this.draftText = chat.draftText;
		this.attachments = [...chat.attachments];
		this.queue = [...(chat.queue ?? [])];
		this.queuePaused = !!chat.queuePaused;
		this.activeStatusId = chat.activeStatusId;
		this.activeAssistantId = chat.activeAssistantId;
		this.activeReasoningId = chat.activeReasoningId;
		this.activeReasoningStartedAt = chat.activeReasoningStartedAt;
		this.activeWorkId = chat.activeWorkId;
		this.turnStartedAt = chat.turnStartedAt;
	}

	private parkCurrent(): void {
		if (!this.sessionId) {
			return;
		}
		this.parked.set(this.sessionId, this.captureView());
		this.stopElapsedTimer();
	}

	/**
	 * Apply a mutation to the running chat. When the run is parked, write back
	 * into `parked`; when it's the visible tab, write back onto `this`.
	 */
	private mutateRunChat(mutator: (chat: MutableChat) => void): void {
		const id = this.runningSessionId;
		if (!id) {
			return;
		}
		if (id === this.sessionId) {
			const chat = this.captureView();
			mutator(chat);
			this.adoptView(chat);
			return;
		}
		const parked = this.parked.get(id);
		if (!parked) {
			return;
		}
		mutator(parked);
		this.parked.set(id, parked);
	}

	private async handleSend(text: string): Promise<void> {
		if (this.busy) {
			await this.enqueueMessage(text);
			return;
		}
		if (this.runningSessionId && this.runningSessionId !== this.sessionId) {
			this.items.push({
				id: newItemId('status'),
				kind: 'status',
				text: '另一个对话仍在运行，请先停止或等待完成。',
				tone: 'error',
			});
			this.pushState();
			return;
		}
		if (!this.sessionId) {
			return;
		}
		const attachmentBlock = formatAttachmentBlock(this.attachments);
		const content = `${attachmentBlock}${text}`.trim();

		this.items.push({ id: newItemId('user'), kind: 'user', text: content });
		this.attachments = [];
		this.draftText = '';
		this.runningSessionId = this.sessionId;
		this.unreadDoneIds.delete(this.sessionId);
		this.activeStatusId = undefined;
		this.activeAssistantId = undefined;
		this.activeReasoningId = undefined;
		this.activeReasoningStartedAt = undefined;
		this.turnStartedAt = Date.now();
		this.activeWorkId = newItemId('work');
		this.items.push({
			id: this.activeWorkId,
			kind: 'work',
			label: 'Working',
			startedAt: this.turnStartedAt,
			elapsedMs: 0,
			running: true,
		});
		this.startElapsedTimer();
		this.pushState({ clearDraft: true });

		const runSessionId = this.sessionId;
		const brain = getActiveBrain();
		const provider = getProviderMode();
		const model = brain === 'cursor'
			? (getCursorModel() || undefined)
			: getSelectedModelId(provider);
		const reasoningLevel = getSelectedReasoningLevel(provider, getSelectedModelId(provider));
		const history: ChatMessage[] = this.items
			.filter((item): item is Extract<ConversationItem, { kind: 'user' | 'assistant' }> =>
				item.kind === 'user' || (item.kind === 'assistant' && !item.streaming && !!item.text))
			.map(item => ({
				role: item.kind === 'user' ? 'user' : 'assistant',
				content: item.text,
			}));
		const initialTodos = [...this.todos];

		this.runCancel?.dispose();
		const cancel = new vscode.CancellationTokenSource();
		this.runCancel = cancel;
		let cancelled = false;
		let turnFailed = false;
		try {
			const result = await completeChatTurn({
				messages: history,
				brain,
				provider,
				model,
				reasoningLevel,
				workspaceRoot: workspaceRoot(),
				initialTodos,
				onProgress: event => this.applyProgress(event),
				askUser: (prompt, token) => this.waitForAsk(prompt, token),
			}, cancel.token);

			this.mutateRunChat(chat => {
				this.clearStatusOn(chat);
				this.finishReasoningOn(chat);
				if (result.todos?.length) {
					chat.todos = result.todos;
				}
				if (chat.activeAssistantId) {
					const existing = chat.items.find(i => i.id === chat.activeAssistantId);
					if (existing && existing.kind === 'assistant') {
						existing.text = result.content;
						existing.streaming = false;
					}
				} else if (result.content.trim()) {
					chat.activeAssistantId = newItemId('assistant');
					chat.items.push({
						id: chat.activeAssistantId,
						kind: 'assistant',
						text: result.content,
					});
				}
				this.pinAssistantBeforeWorkOn(chat);
				this.finishWorkOn(chat, true);
			});
		} catch (error) {
			cancelled = error instanceof vscode.CancellationError
				|| (error instanceof Error && /cancel|abort/i.test(error.message));
			turnFailed = !cancelled;
			this.mutateRunChat(chat => {
				this.clearStatusOn(chat);
				this.finishReasoningOn(chat);
				this.finishWorkOn(chat, false);
				chat.items.push({
					id: newItemId('status'),
					kind: 'status',
					text: cancelled ? '已停止' : (error instanceof Error ? error.message : String(error)),
					tone: cancelled ? 'info' : 'error',
				});
			});
		} finally {
			const finished = runSessionId === this.sessionId
				? this.captureView()
				: this.parked.get(runSessionId);
			if (finished) {
				finished.activeStatusId = undefined;
				finished.activeAssistantId = undefined;
				finished.activeReasoningId = undefined;
				finished.activeReasoningStartedAt = undefined;
				finished.activeWorkId = undefined;
				finished.turnStartedAt = undefined;
				if ((cancelled || turnFailed) && !this.pendingForceSend) {
					finished.queuePaused = true;
				}
				if (runSessionId === this.sessionId) {
					this.adoptView(finished);
				} else {
					this.parked.set(runSessionId, finished);
				}
			}
			this.stopElapsedTimer();
			if (this.runningSessionId === runSessionId) {
				this.runningSessionId = undefined;
			}
			if (this.runCancel === cancel) {
				this.runCancel = undefined;
			}
			cancel.dispose();
			if (!cancelled) {
				this.unreadDoneIds.add(runSessionId);
			} else {
				this.unreadDoneIds.delete(runSessionId);
			}
			await this.persistSessionById(runSessionId);
			this.pushState();

			const force = this.pendingForceSend;
			if (force && runSessionId === this.sessionId) {
				this.pendingForceSend = undefined;
				this.queuePaused = false;
				void this.handleSend(force);
			} else if (!cancelled && !turnFailed) {
				void this.flushQueue(runSessionId);
			}
		}
	}

	private async bootstrapSession(): Promise<void> {
		await this.ideChat.pruneEmptySessions();
		const active = await this.ideChat.getActiveSession();
		if (active && active.messages.length > 0) {
			this.applySession(active.id, active.timeline ?? [], active.todos ?? [], true);
		} else {
			if (active) {
				await this.ideChat.deleteSession(active.id);
			}
			const draft = this.ideChat.createDraftSession(this.draftSessionOptions());
			this.applySession(draft.id, [], [], false);
		}
		await this.refreshSessionList();
		this.pushState();
	}

	private sessionSource(): typeof IDE_CHAT_SOURCE_ZCODE | typeof IDE_CHAT_SOURCE_CURSOR {
		return getActiveBrain() === 'cursor' ? IDE_CHAT_SOURCE_CURSOR : IDE_CHAT_SOURCE_ZCODE;
	}

	private buildContextUsage(): ContextUsageSnapshot {
		const brain = getActiveBrain();
		const modelId = brain === 'cursor'
			? (getCursorModel() || undefined)
			: getSelectedModelId(getProviderMode());
		return computeContextUsage({
			items: this.items,
			draftText: this.draftText,
			modelId,
			reportedUsed: this.reportedUsageTokens,
		});
	}

	private pushContextUsage(): void {
		void this.view?.webview.postMessage({
			type: 'contextUsage',
			contextUsage: this.buildContextUsage(),
		});
	}

	private applySession(id: string, items: ConversationItem[], todos: TodoItem[], persisted = true): void {
		this.stopElapsedTimer();
		this.sessionId = id;
		this.sessionPersisted = persisted;
		this.reportedUsageTokens = undefined;
		const freezeRunning = this.runningSessionId === id;
		this.items = items.map(item => {
			if (freezeRunning) {
				return item;
			}
			if (item.kind === 'assistant') {
				return { ...item, streaming: false };
			}
			if (item.kind === 'reasoning') {
				return { ...item, streaming: false, expanded: false };
			}
			if (item.kind === 'work') {
				return { ...item, running: false };
			}
			if (item.kind === 'tool' && item.status === 'running') {
				return { ...item, status: 'done' as const };
			}
			return item;
		});
		this.todos = todos;
		this.attachments = [];
		this.applySelectionQueue();
		this.draftText = '';
		this.queue = [];
		this.queuePaused = false;
		this.pendingForceSend = undefined;
		if (!freezeRunning) {
			this.activeStatusId = undefined;
			this.activeAssistantId = undefined;
			this.activeReasoningId = undefined;
			this.activeWorkId = undefined;
			this.turnStartedAt = undefined;
		}
	}

	private async startNewSession(opts?: { force?: boolean }): Promise<void> {
		this.historyOpen = false;
		// Already on an empty draft — keep a single blank chat, don't spam history.
		if (!opts?.force && this.isSessionEmpty() && !this.sessionPersisted && this.runningSessionId !== this.sessionId) {
			this.pushState({ clearDraft: true });
			return;
		}
		if (this.sessionId && (this.runningSessionId === this.sessionId || !this.isSessionEmpty() || this.sessionPersisted)) {
			this.parkCurrent();
			if (this.isSessionEmpty() && this.sessionPersisted && this.runningSessionId !== this.sessionId) {
				await this.ideChat.deleteSession(this.sessionId);
				this.parked.delete(this.sessionId);
			} else if (!this.isSessionEmpty()) {
				await this.persistSession(true);
			}
		}
		const draft = this.ideChat.createDraftSession(this.draftSessionOptions());
		this.applySession(draft.id, [], [], false);
		if (this.sessionId && !this.openTabIds.includes(this.sessionId)) {
			this.openTabIds = [...this.openTabIds, this.sessionId];
		}
		this.fileChanges = this.fileEdits.list();
		await this.refreshSessionList();
		this.pushState({ clearDraft: true });
	}

	private async openSession(sessionId: string): Promise<void> {
		this.unreadDoneIds.delete(sessionId);
		if (sessionId === this.sessionId) {
			this.pushState();
			return;
		}
		if (this.sessionId) {
			this.parkCurrent();
			if (!this.isSessionEmpty() || this.sessionPersisted) {
				await this.persistSession(true);
			}
		}
		this.historyOpen = false;

		const parked = this.parked.get(sessionId);
		if (parked) {
			this.sessionId = sessionId;
			this.adoptView(parked);
			this.parked.delete(sessionId);
			if (this.runningSessionId === sessionId) {
				this.startElapsedTimer();
			}
			await this.ideChat.setActiveSession(sessionId).catch(() => undefined);
			await this.refreshSessionList();
			this.pushState({ clearDraft: true });
			if (this.runningSessionId !== sessionId) {
				void this.flushQueue(sessionId);
			}
			return;
		}

		const session = await this.ideChat.setActiveSession(sessionId);
		if (!session) {
			return;
		}
		this.applySession(session.id, session.timeline ?? [], session.todos ?? [], true);
		await this.refreshSessionList();
		this.pushState({ clearDraft: true });
	}

	private async closeTab(sessionId: string): Promise<void> {
		if (this.runningSessionId === sessionId) {
			this.stopRunning();
			this.stopElapsedTimer();
			// Detach the run marker now — the async run loop's tail must not keep
			// the closed tab alive via refreshSessionList()/persistSessionById().
			this.runningSessionId = undefined;
		}
		const closingActive = this.sessionId === sessionId;
		const closingDraft = closingActive && !this.sessionPersisted && this.runningSessionId !== sessionId;

		// Snapshot and drop the closing chat FIRST. openSession()/startNewSession()
		// both park the current view, which used to resurrect the closed tab at the
		// end of the tab strip.
		const closingChat = closingActive ? this.captureView() : this.parked.get(sessionId);
		this.parked.delete(sessionId);
		this.unreadDoneIds.delete(sessionId);
		this.openTabIds = this.openTabIds.filter(id => id !== sessionId);

		// Save unsaved content, but never reopen a tab or mark it active for a
		// session the user just closed.
		if (closingChat) {
			await this.persistChat(sessionId, closingChat, false, { background: true });
		}
		if (!closingDraft) {
			await this.ideChat.closeOpenTab(sessionId);
		}

		if (closingActive) {
			// Detach before switching so parkCurrent() cannot re-add the closed session.
			this.sessionId = undefined;
			this.items = [];
			this.todos = [];
			this.sessionPersisted = false;
			this.draftText = '';
			this.attachments = [];
			this.queue = [];
			this.queuePaused = false;
			const nextId = this.openTabIds.find(id => id !== sessionId);
			if (nextId) {
				await this.openSession(nextId);
				return;
			}
			await this.startNewSession({ force: true });
			return;
		}
		await this.refreshSessionList();
		this.pushState();
	}

	private async deleteSession(sessionId: string): Promise<void> {
		if (this.runningSessionId === sessionId) {
			this.stopRunning();
		}
		this.parked.delete(sessionId);
		await this.ideChat.deleteSession(sessionId);
		this.unreadDoneIds.delete(sessionId);
		this.openTabIds = this.openTabIds.filter(id => id !== sessionId);
		if (this.sessionId === sessionId) {
			const next = await this.ideChat.getActiveSession();
			if (next) {
				const parked = this.parked.get(next.id);
				if (parked) {
					this.sessionId = next.id;
					this.adoptView(parked);
					this.parked.delete(next.id);
				} else {
					this.applySession(next.id, next.timeline ?? [], next.todos ?? [], true);
				}
			} else {
				await this.startNewSession({ force: true });
				return;
			}
		}
		await this.refreshSessionList();
		this.pushState();
	}

	private async refreshSessionList(): Promise<void> {
		this.sessionList = await this.ideChat.listSessions({
			workspaceRoot: workspaceRoot(),
			limit: 80,
		});
		const stored = await this.ideChat.getOpenTabIds();
		const known = new Set(this.sessionList.map(s => s.id));
		const allowed = new Set<string>([...stored, ...this.parked.keys()]);
		if (this.sessionId) {
			allowed.add(this.sessionId);
		}
		if (this.runningSessionId) {
			allowed.add(this.runningSessionId);
		}

		// Keep existing tab order stable across switches; only append newcomers.
		const next: string[] = [];
		const seen = new Set<string>();
		const append = (id: string | undefined) => {
			if (!id || seen.has(id) || !allowed.has(id)) {
				return;
			}
			if (
				known.has(id)
				|| this.parked.has(id)
				|| id === this.sessionId
				|| id === this.runningSessionId
			) {
				next.push(id);
				seen.add(id);
			}
		};
		for (const id of this.openTabIds) {
			append(id);
		}
		for (const id of stored) {
			append(id);
		}
		for (const id of this.parked.keys()) {
			append(id);
		}
		append(this.sessionId);
		append(this.runningSessionId);
		this.openTabIds = next;
	}

	private async persistSession(_immediate = true): Promise<void> {
		if (!this.sessionId) {
			return;
		}
		await this.persistChat(this.sessionId, this.captureView(), true);
	}

	private async persistSessionById(sessionId: string): Promise<void> {
		const chat = sessionId === this.sessionId
			? this.captureView()
			: this.parked.get(sessionId);
		if (!chat) {
			return;
		}
		// Background flush of a parked session must not resurrect a closed tab
		// nor steal the active marker from the visible session.
		await this.persistChat(sessionId, chat, sessionId === this.sessionId, {
			background: sessionId !== this.sessionId,
		});
	}

	private async persistChat(sessionId: string, chat: MutableChat, adoptPersistedFlag: boolean, opts?: { background?: boolean }): Promise<void> {
		const messages = IdeChatStore.messagesFromTimeline(chat.items);
		if (messages.length === 0) {
			if (chat.persisted) {
				await this.ideChat.deleteSession(sessionId);
				chat.persisted = false;
				if (adoptPersistedFlag) {
					this.sessionPersisted = false;
				}
				await this.refreshSessionList();
			}
			return;
		}
		const brain = getActiveBrain();
		const provider = brain === 'cursor' ? 'cursor' : getProviderMode();
		const model = brain === 'cursor' ? getCursorModel() : getSelectedModelId(getProviderMode());
		const createdAt = this.sessionList.find(s => s.id === sessionId)?.createdAt ?? Date.now();
		await this.ideChat.saveSession({
			id: sessionId,
			title: titleFromMessages(messages),
			createdAt,
			updatedAt: Date.now(),
			source: this.sessionSource(),
			workspaceRoot: workspaceRoot(),
			provider,
			model,
			messages,
			timeline: chat.items,
			todos: chat.todos,
		}, opts);
		chat.persisted = true;
		if (adoptPersistedFlag) {
			this.sessionPersisted = true;
		}
		await this.refreshSessionList();
	}

	private applyProgress(event: AgentProgressEvent): void {
		if (event.type === 'file_change') {
			this.fileChanges = this.fileEdits.list();
			this.pushState();
			return;
		}

		this.mutateRunChat(chat => {
			if (event.type === 'status') {
				if (chat.activeStatusId) {
					const row = chat.items.find(i => i.id === chat.activeStatusId);
					if (row && row.kind === 'status') {
						row.text = event.text;
						return;
					}
				}
				chat.activeStatusId = newItemId('status');
				chat.items.push({ id: chat.activeStatusId, kind: 'status', text: event.text });
				return;
			}

			if (event.type === 'reasoning') {
				this.clearStatusOn(chat);
				this.dropInterimAssistantOn(chat);
				if (!chat.activeReasoningId) {
					chat.activeReasoningId = newItemId('reasoning');
					chat.activeReasoningStartedAt = Date.now();
					chat.items.push({
						id: chat.activeReasoningId,
						kind: 'reasoning',
						text: event.text,
						streaming: !event.done,
						expanded: true,
						startedAt: chat.activeReasoningStartedAt,
					});
				} else {
					const row = chat.items.find(i => i.id === chat.activeReasoningId);
					if (row && row.kind === 'reasoning') {
						row.text = event.text;
						row.streaming = !event.done;
						if (event.done && chat.activeReasoningStartedAt) {
							row.durationMs = Date.now() - chat.activeReasoningStartedAt;
							row.expanded = false;
						}
					}
				}
				if (event.done) {
					chat.activeReasoningId = undefined;
					chat.activeReasoningStartedAt = undefined;
				}
				this.pinWorkToEndOn(chat);
				return;
			}

			if (event.type === 'todos') {
				chat.todos = event.todos;
				return;
			}

			if (event.type === 'tool_start') {
				this.clearStatusOn(chat);
				this.finishReasoningOn(chat);
				this.dropInterimAssistantOn(chat);
				chat.items.push({
					id: event.id,
					kind: 'tool',
					toolName: event.toolName,
					summary: event.summary || toolDisplayName(event.toolName),
					status: 'running',
				});
				this.pinWorkToEndOn(chat);
				return;
			}

			if (event.type === 'tool_end') {
				const patch = {
					summary: event.summary,
					status: (event.ok ? 'done' : 'error') as 'done' | 'error',
					detail: event.detail,
					path: event.path,
					uri: event.uri,
					added: event.added,
					removed: event.removed,
				};
				const row = chat.items.find(i => i.id === event.id);
				if (row && row.kind === 'tool') {
					Object.assign(row, patch);
					if (row.detail || row.uri) {
						row.expanded = row.expanded ?? false;
					}
				} else {
					chat.items.push({
						id: event.id,
						kind: 'tool',
						toolName: event.toolName,
						...patch,
						expanded: false,
					});
				}
				return;
			}

			if (event.type === 'assistant') {
				this.clearStatusOn(chat);
				this.finishReasoningOn(chat);
				if (!chat.activeAssistantId) {
					chat.activeAssistantId = newItemId('assistant');
					chat.items.push({
						id: chat.activeAssistantId,
						kind: 'assistant',
						text: event.text,
						streaming: !event.done,
					});
				} else {
					const row = chat.items.find(i => i.id === chat.activeAssistantId);
					if (row && row.kind === 'assistant') {
						row.text = event.text;
						row.streaming = !event.done;
					}
				}
				this.pinAssistantBeforeWorkOn(chat);
			}
		});
		this.pushState();
	}

	private dropInterimAssistantOn(chat: MutableChat): void {
		if (!chat.activeAssistantId) {
			return;
		}
		const row = chat.items.find(i => i.id === chat.activeAssistantId);
		if (row && row.kind === 'assistant') {
			chat.items = chat.items.filter(i => i.id !== chat.activeAssistantId);
			chat.activeAssistantId = undefined;
		}
	}

	private pinAssistantBeforeWorkOn(chat: MutableChat): void {
		if (!chat.activeAssistantId) {
			return;
		}
		const aIdx = chat.items.findIndex(i => i.id === chat.activeAssistantId);
		if (aIdx < 0) {
			return;
		}
		const [assistant] = chat.items.splice(aIdx, 1);
		const workIdx = chat.activeWorkId
			? chat.items.findIndex(i => i.id === chat.activeWorkId)
			: -1;
		if (workIdx >= 0) {
			chat.items.splice(workIdx, 0, assistant);
		} else {
			chat.items.push(assistant);
		}
	}

	private finishReasoningOn(chat: MutableChat): void {
		if (!chat.activeReasoningId) {
			return;
		}
		const row = chat.items.find(i => i.id === chat.activeReasoningId);
		if (row && row.kind === 'reasoning') {
			row.streaming = false;
			row.expanded = false;
			if (chat.activeReasoningStartedAt) {
				row.durationMs = Date.now() - chat.activeReasoningStartedAt;
			}
		}
		chat.activeReasoningId = undefined;
		chat.activeReasoningStartedAt = undefined;
	}

	private finishWorkOn(chat: MutableChat, ok: boolean): void {
		if (!chat.activeWorkId || !chat.turnStartedAt) {
			return;
		}
		const row = chat.items.find(i => i.id === chat.activeWorkId);
		if (row && row.kind === 'work') {
			row.running = false;
			row.elapsedMs = Date.now() - chat.turnStartedAt;
			row.label = ok ? 'Completed' : 'Failed';
		}
		this.pinWorkToEndOn(chat);
	}

	private pinWorkToEndOn(chat: MutableChat): void {
		if (!chat.activeWorkId) {
			return;
		}
		const idx = chat.items.findIndex(i => i.id === chat.activeWorkId);
		if (idx < 0 || idx === chat.items.length - 1) {
			return;
		}
		const [row] = chat.items.splice(idx, 1);
		chat.items.push(row);
	}

	private startElapsedTimer(): void {
		this.stopElapsedTimer();
		this.elapsedTimer = setInterval(() => {
			if (!this.busy || !this.activeWorkId || !this.turnStartedAt) {
				return;
			}
			const chat = this.captureView();
			const row = chat.items.find(i => i.id === chat.activeWorkId);
			if (row && row.kind === 'work' && row.running && chat.turnStartedAt) {
				row.elapsedMs = Date.now() - chat.turnStartedAt;
				this.pinWorkToEndOn(chat);
				this.adoptView(chat);
				this.pushState();
			}
		}, 500);
	}

	private stopElapsedTimer(): void {
		if (this.elapsedTimer) {
			clearInterval(this.elapsedTimer);
			this.elapsedTimer = undefined;
		}
	}

	private clearStatusOn(chat: MutableChat): void {
		if (!chat.activeStatusId) {
			return;
		}
		chat.items = chat.items.filter(i => i.id !== chat.activeStatusId);
		chat.activeStatusId = undefined;
	}

	private pushState(extra?: { clearDraft?: boolean; insertText?: string; openPlus?: boolean; focusInput?: boolean }): void {
		const brain = getActiveBrain();
		const provider = getProviderMode();
		const modelId = getSelectedModelId(provider);
		const reasoningLevel = getSelectedReasoningLevel(provider, modelId);
		const models = modelsForProvider(provider).map(m => ({
			id: m.id,
			label: m.label,
			reasoningLevels: m.reasoningLevels.map(level => ({
				id: level,
				label: REASONING_LABELS[level] ?? level,
			})),
		}));
		const cursorMode = getCursorAgentMode();
		const cursorModel = getCursorModel();
		const cursorModels = (this.cursorModels.length ? this.cursorModels : cursorModel ? [cursorModel] : [])
			.map(id => ({ id, label: id }));

		let accountLabel = 'Signed out';
		let signedIn = false;
		try {
			const session = getAuthService().getSession();
			if (session) {
				signedIn = true;
				accountLabel = `${session.accountLabel} · ${session.provider}`;
			}
		} catch {
			// auth not ready
		}
		if (brain === 'cursor') {
			accountLabel = this.cursorAccountLabel;
			signedIn = !/not logged in/i.test(this.cursorAccountLabel);
		}

		const items = this.items.map(item => {
			if (item.kind === 'work') {
				return {
					...item,
					durationLabel: formatWorkDuration(item.elapsedMs),
				};
			}
			if (item.kind === 'reasoning') {
				return {
					...item,
					durationLabel: item.durationMs !== undefined
						? formatWorkDuration(item.durationMs)
						: undefined,
				};
			}
			return item;
		});

		void this.view?.webview.postMessage({
			type: 'state',
			brain,
			brains: BRAINS.map(id => ({ id, label: BRAIN_LABELS[id] })),
			provider,
			providers: PROVIDER_MODES.map(mode => ({
				id: mode,
				label: PROVIDER_LABELS[mode],
			})),
			model: brain === 'cursor' ? cursorModel : modelId,
			models: brain === 'cursor' ? cursorModels : models,
			cursorMode,
			cursorModes: [
				{ id: 'agent' as CursorAgentMode, label: 'Agent' },
				{ id: 'plan' as CursorAgentMode, label: 'Plan' },
				{ id: 'ask' as CursorAgentMode, label: 'Ask' },
			],
			reasoningLevel,
			reasoningLabel: REASONING_LABELS[reasoningLevel] ?? reasoningLevel,
			reasoningLevels: models.find(m => m.id === modelId)?.reasoningLevels
				?? models[0]?.reasoningLevels
				?? [],
			bridgeMode: brain === 'cursor' ? 'cursor-acp' : getBridgeMode(),
			workspaceRoot: workspaceRoot(),
			items,
			todos: this.todos,
			fileChanges: this.fileChanges,
			sessionId: this.sessionId,
			sessions: this.sessionList.map(s => ({
				id: s.id,
				title: s.title,
				updatedAt: s.updatedAt,
				source: s.source,
				active: s.id === this.sessionId,
				open: this.openTabIds.includes(s.id),
				running: this.runningSessionId === s.id,
				done: this.unreadDoneIds.has(s.id),
			})),
			tabs: this.buildTitleTabs(),
			attachments: this.attachments.map(a => ({ id: a.id, name: a.name, title: a.detail ?? a.fsPath })),
			queue: this.queue.map(item => ({ id: item.id, text: item.text })),
			queuePaused: this.queuePaused,
			plusSections: buildPlusMenuSections({ emptyDraft: this.draftText.trim().length === 0 }),
			accountLabel,
			signedIn,
			busy: this.busy,
			historyOpen: this.historyOpen,
			fontSize: getChatFontSize(),
			contextUsage: this.buildContextUsage(),
			scheduleTip: getZcodeScheduleTip(brain),
			clearDraft: extra?.clearDraft ?? false,
			insertText: extra?.insertText,
			openPlus: extra?.openPlus ?? false,
			focusInput: extra?.focusInput ?? false,
		});
		void vscode.commands.executeCommand('zcode.internal.setTitleTabs', this.buildTitleTabs());
	}

	private buildTitleTabs(): Array<{
		id: string;
		title: string;
		source?: string;
		active: boolean;
		running: boolean;
		done: boolean;
		draft: boolean;
	}> {
		return this.openTabIds.map(id => {
			const s = this.sessionList.find(row => row.id === id);
			const parked = this.parked.get(id);
			const live = id === this.sessionId ? this.items : parked?.items;
			const isDraft = (id === this.sessionId && !this.sessionPersisted)
				|| (!!parked && !parked.persisted && !s);
			const title = s?.title
				|| (live ? titleFromMessages(IdeChatStore.messagesFromTimeline(live)) : '')
				|| '新对话';
			return {
				id,
				title,
				source: s?.source ?? (isDraft ? this.sessionSource() : undefined),
				active: id === this.sessionId,
				running: this.runningSessionId === id,
				done: this.unreadDoneIds.has(id),
				draft: isDraft,
			};
		});
	}

	private renderHtml(webview: vscode.Webview): string {
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chatView.css'));
		const highlightStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'highlight-vscode.css'));
		const markdownItUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'markdown-it.min.js'));
		const highlightUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'highlight.min.js'));
		const markdownUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'markdown.js'));
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chatView.js'));
		const csp = [
			`default-src 'none'`,
			`style-src ${webview.cspSource}`,
			`script-src ${webview.cspSource}`,
		].join('; ');

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>ZCode</title>
	<link rel="stylesheet" href="${styleUri}" />
	<link rel="stylesheet" href="${highlightStyleUri}" />
</head>
<body>
	<div class="brain-bar">
		<div class="brain-switch" id="brainSwitch" role="tablist" aria-label="AI brain">
			<button type="button" class="brain-tab" data-brain="zcode" id="brainZcode">ZCode</button>
			<button type="button" class="brain-tab" data-brain="cursor" id="brainCursor">Cursor</button>
		</div>
	</div>
	<div class="history-drawer" id="historyDrawer" hidden>
		<div class="history-header">
			<div class="history-header-text">
				<span class="history-title">历史会话</span>
				<span class="history-hint">ZCode 与 Cursor 共用</span>
			</div>
			<button class="icon-btn" id="historyClose" type="button" title="关闭" aria-label="关闭">×</button>
		</div>
		<ul class="history-list" id="historyList"></ul>
	</div>
	<div class="timeline" id="timeline" data-brain="zcode">
		<div class="empty">Ask ZCode or Cursor to edit, explain, or run something in this workspace.</div>
	</div>
	<div class="todo-panel" id="todoPanel" hidden>
		<div class="todo-header">
			<span class="todo-title">Tasks</span>
			<span class="todo-count" id="todoCount"></span>
		</div>
		<ul class="todo-list" id="todoList"></ul>
	</div>
	<div class="chat-session-working-set" id="workingSet" hidden>
		<div class="working-set-overview">
			<button type="button" class="working-set-collapse" id="workingSetCollapse" aria-expanded="true" title="Collapse">
				<span class="chev">▾</span>
				<span class="working-set-title" id="workingSetTitle">0 files changed</span>
				<span class="insertions-and-deletions" id="workingSetTotals"><span class="insertions"></span><span class="deletions"></span></span>
			</button>
			<div class="working-set-actions">
				<button type="button" class="monaco-text-button" id="keepAllBtn" title="Keep All Edits">Keep</button>
				<button type="button" class="monaco-text-button secondary undo-quiet" id="undoAllBtn" title="撤销全部修改（需确认）">Undo</button>
				<button type="button" class="monaco-text-button secondary icon" id="viewAllBtn" title="View All Edits" aria-label="View All Edits">⧉</button>
			</div>
		</div>
		<ul class="chat-summary-list" id="workingSetList"></ul>
	</div>
	<div class="chips" id="chips"></div>
	<div class="queue-panel" id="queuePanel" hidden>
		<div class="queue-paused" id="queuePausedBanner" hidden>
			<span class="queue-paused-text" id="queuePausedText">队列已暂停</span>
			<button type="button" class="queue-resume" id="queueResume">继续</button>
		</div>
		<ul class="queue-list" id="queueList"></ul>
	</div>
	<div class="chat-input-container" id="composer">
		<div class="menu" id="plusMenu" role="menu"></div>
		<div class="menu" id="pickerMenu" role="listbox"></div>
		<textarea id="input" rows="2" placeholder="Plan, @ for context, / for commands"></textarea>
		<div class="chat-input-toolbars" id="composerToolbar">
			<div class="toolbar-left">
				<button class="icon-btn" id="plus" type="button" title="Add" aria-label="Add">+</button>
				<span id="zcodePills" data-brain-chrome="zcode">
					<button class="pill" id="providerBtn" type="button" title="Provider"><span class="label" id="providerLabel">Start Plan</span><span class="chev">▾</span></button>
					<button class="pill" id="modelBtn" type="button" title="Model"><span class="label" id="modelLabel">Model</span><span class="chev">▾</span></button>
					<button class="pill thought" id="thoughtBtn" type="button" title="Thinking intensity"><span class="brain">◎</span><span class="label" id="thoughtLabel">High</span><span class="chev">▾</span></button>
				</span>
				<span id="cursorPills" data-brain-chrome="cursor" hidden>
					<button class="pill" id="cursorModeBtn" type="button" title="Cursor mode"><span class="label" id="cursorModeLabel">Agent</span><span class="chev">▾</span></button>
					<button class="pill" id="cursorModelBtn" type="button" title="Cursor model"><span class="label" id="cursorModelLabel">Default</span><span class="chev">▾</span></button>
				</span>
			</div>
			<div class="toolbar-right">
				<button class="context-usage" id="contextUsageBtn" type="button" title="上下文容量" aria-label="上下文容量" aria-expanded="false" hidden>
					<svg class="context-ring" viewBox="0 0 24 24" aria-hidden="true">
						<circle class="ring-bg" cx="12" cy="12" r="10"></circle>
						<circle class="ring-arc" cx="12" cy="12" r="10"></circle>
					</svg>
					<span class="context-pct" id="contextUsagePct"></span>
				</button>
				<div class="context-panel" id="contextPanel" hidden>
					<div class="context-panel-head">
						<span class="context-panel-title">上下文容量</span>
						<span class="context-panel-summary" id="contextPanelSummary"></span>
					</div>
					<div class="context-panel-bar"><div class="context-panel-fill" id="contextPanelFill"></div></div>
					<p class="context-panel-desc">提示词、工具调用和回复都会共享上下文窗口。</p>
					<ul class="context-breakdown" id="contextBreakdown"></ul>
					<p class="context-panel-note" id="contextPanelNote"></p>
				</div>
				<button class="send-btn" id="send" type="button" title="Send (Enter)" aria-label="Send">↑</button>
			</div>
		</div>
	</div>
	<div class="schedule-tip" id="scheduleTip" hidden role="status"></div>
	<div class="hint" id="hint"></div>
	<script src="${markdownItUri}"></script>
	<script src="${highlightUri}"></script>
	<script src="${markdownUri}"></script>
	<script src="${scriptUri}"></script>
</body>
</html>`;
	}
}

export function registerChatPanel(
	context: vscode.ExtensionContext,
	ideChat: IdeChatStore,
	fileEdits: FileEditSession = getFileEditSession(),
): ZCodeChatViewProvider {
	const provider = new ZCodeChatViewProvider(context.extensionUri, ideChat, fileEdits);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ZCodeChatViewProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	);
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('zcode')) {
				provider.refresh();
			}
		}),
	);
	return provider;
}
