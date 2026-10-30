/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentProgressEvent } from './agentRuntime';
import type { AskUserAnswer, AskUserPrompt, AskUserResult } from './askUser';
import { getAuthService } from './authSession';
import {
	AGENT_PACE_LABELS,
	AGENT_PACES,
	getAgentPace,
	setAgentPace,
	type AgentPace,
} from './agentPace';
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
import { compactConversation } from './contextCompact';
import { buildPlusMenuSections, formatSlashInsert } from './composerActions';
import {
	formatWorkDuration,
	newItemId,
	toolDisplayName,
	type ConversationItem,
	type TodoItem,
	type UserAttachmentRef,
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
import { filterSkills, listLocalSkills, prepareComposerTurn } from './localSkills';
import {
	claimManualPlan,
	fetchAccountQuota,
	fetchClaimOffer,
	QUOTA_NOTICE_SEEN_KEY,
	readSeenQuotaNotices,
	selectQuotaNotice,
	type AccountQuota,
	type ClaimOffer,
} from './planBilling';
import { buildPromptPreamble } from './promptContext';
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
import type { SessionAwareness } from './sessionAwareness';
import { getZcodeScheduleTip } from './zcodeScheduleTip';

const VIEW_ID = 'zcode.chatView';

const CHAT_FONT_SIZE_DEFAULT = 14;
const CHAT_FONT_SIZE_MIN = 11;
const CHAT_FONT_SIZE_MAX = 24;

const CHAT_LINE_HEIGHT_DEFAULT = 1.8;
const CHAT_LINE_HEIGHT_MIN = 1.3;
const CHAT_LINE_HEIGHT_MAX = 2.4;

/** Chat stream font size from `zcode.chatFontSize`, clamped to a sane range. */
function getChatFontSize(): number {
	const size = vscode.workspace.getConfiguration('zcode').get<number>('chatFontSize');
	if (typeof size !== 'number' || !Number.isFinite(size)) {
		return CHAT_FONT_SIZE_DEFAULT;
	}
	return Math.min(CHAT_FONT_SIZE_MAX, Math.max(CHAT_FONT_SIZE_MIN, size));
}

/** Chat stream line height from `zcode.chatLineHeight`, clamped to a sane range. */
function getChatLineHeight(): number {
	const value = vscode.workspace.getConfiguration('zcode').get<number>('chatLineHeight');
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return CHAT_LINE_HEIGHT_DEFAULT;
	}
	return Math.min(CHAT_LINE_HEIGHT_MAX, Math.max(CHAT_LINE_HEIGHT_MIN, value));
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
	attachments: AttachmentChip[];
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

/** In-flight agent turn for one IDE chat session (ZCode-style per-session abort). */
interface SessionRun {
	cancel: vscode.CancellationTokenSource;
	pendingAsk?: {
		id: string;
		resolve: (result: AskUserResult) => void;
	};
	/** Prefer this text on the next idle tick (send-now / interrupt). */
	pendingForceSend?: { content: string; text: string; attachments: AttachmentChip[] };
}

function getAttachmentDir(): string {
	return path.join(os.tmpdir(), 'zcode-chat-attachments');
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
	/**
	 * Concurrent agent turns keyed by IDE chat session id.
	 * Matches ZCode: many sessions may run; only one foreground turn per session.
	 */
	private readonly runs = new Map<string, SessionRun>();
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
	private claimOffer: ClaimOffer | null = null;
	private claimError: string | undefined;
	private claimBusy = false;
	private accountQuota: AccountQuota | null = null;
	private seenNotices = new Set<string>();
	private billingSeq = 0;

	private isRunning(sessionId: string | undefined): boolean {
		return !!sessionId && this.runs.has(sessionId);
	}

	/** True when the visible tab has an in-flight AI turn. */
	private get busy(): boolean {
		return this.isRunning(this.sessionId);
	}

	private scheduleTipTimer?: ReturnType<typeof setInterval>;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly ideChat: IdeChatStore,
		private readonly fileEdits: FileEditSession,
		private readonly globalState: vscode.Memento,
	) {
		this.seenNotices = new Set(readSeenQuotaNotices(this.globalState.get<string[]>(QUOTA_NOTICE_SEEN_KEY)));
		this.fileEdits.onDidChange(() => {
			this.refreshFileChanges();
			this.pushState();
		});
		try {
			getAuthService().onDidChangeSession(() => {
				void this.refreshBilling();
			});
		} catch {
			// Auth service is registered before the panel in activate.
		}
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
			localResourceRoots: [
				vscode.Uri.joinPath(this.extensionUri, 'media'),
				vscode.Uri.file(getAttachmentDir()),
			],
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
		this.scheduleTipTimer = setInterval(() => {
			this.pushState();
			void this.refreshBilling();
		}, 60_000);
		void this.bootstrapSession();
		void this.refreshBilling();
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
		// Only re-render when a badge was actually dismissed.
		if (this.unreadDoneIds.delete(sessionId)) {
			this.pushState();
		}
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
			pace?: string;
			actionId?: string;
			slash?: string;
			draft?: string;
			attachmentId?: string;
			path?: string;
			open?: boolean;
			answers?: AskUserAnswer[];
			reason?: string;
			planId?: string;
			query?: string;
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
		if (msg.type === 'setAgentPace' && typeof msg.pace === 'string'
			&& (AGENT_PACES as readonly string[]).includes(msg.pace)) {
			await setAgentPace(msg.pace as AgentPace);
			this.pushState();
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
		if (msg.type === 'rewind' && typeof msg.id === 'string') {
			await this.rewindToUser(msg.id, 'keep');
			return;
		}
		if (msg.type === 'editUser' && typeof msg.id === 'string') {
			await this.rewindToUser(msg.id, 'edit');
			return;
		}
		if (msg.type === 'retry' && typeof msg.id === 'string') {
			await this.retryFromAssistant(msg.id);
			return;
		}
		if (msg.type === 'claimPlan') {
			await this.claimCurrentPlan(typeof msg.planId === 'string' ? msg.planId : undefined);
			return;
		}
		if (msg.type === 'dismissQuotaNotice' && typeof msg.id === 'string') {
			await this.dismissQuotaNotice(msg.id);
			return;
		}
		if (msg.type === 'querySkills') {
			const query = typeof msg.query === 'string' ? msg.query : '';
			const skills = filterSkills(this.cachedSkills(), query).map(skill => ({
				name: skill.name,
				description: skill.description,
				scope: skill.scope,
			}));
			void this.view?.webview.postMessage({ type: 'skillMatches', query, skills });
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
			// Fired on any press in the page; skip the re-render when the active
			// tab had no badge to dismiss.
			if (this.unreadDoneIds.delete(msg.sessionId)) {
				this.pushState();
			}
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
			await this.fileEdits.keep(
				typeof msg.uri === 'string' ? [msg.uri] : undefined,
				this.sessionId,
			);
			return;
		}
		if (msg.type === 'undoFileChanges') {
			await this.fileEdits.undo(
				typeof msg.uri === 'string' ? [msg.uri] : undefined,
				this.sessionId,
			);
			return;
		}
		if (msg.type === 'viewAllFileChanges') {
			await this.fileEdits.openAllChanges(this.sessionId);
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
			if (row && row.kind === 'tool') {
				row.expanded = !row.expanded;
				this.pushState();
			}
			return;
		}
		if (msg.type === 'manageAccount') {
			await vscode.commands.executeCommand('zcode.manageAccount');
			return;
		}
		if (msg.type === 'openAttachment' && typeof msg.path === 'string') {
			try {
				void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path));
			} catch {
				// ignore invalid paths
			}
			return;
		}
		if (msg.type === 'removeAttachment' && typeof msg.attachmentId === 'string') {
			this.attachments = this.attachments.filter(a => a.id !== msg.attachmentId);
			this.pushState();
			return;
		}
		if (msg.type === 'attachTransfer') {
			this.handleAttachTransfer(msg);
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

	/**
	 * Attach a file pasted/dropped into the webview. Images are written to a
	 * temp file so the agent can read them from disk; text files are inlined
	 * as an excerpt chip like editor selections.
	 */
	private handleAttachTransfer(msg: {
		name?: string;
		mime?: string;
		base64?: string;
		text?: string;
	}): void {
		const name = (msg.name ?? 'pasted-file').split(/[\\/]/).pop() || 'pasted-file';
		const stamp = `${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
		if (typeof msg.base64 === 'string' && msg.base64) {
			const extFromName = path.extname(name).replace(/^\./, '');
			const mimeExt = (msg.mime ?? '').split('/')[1]?.split(';')[0] ?? '';
			const ext = extFromName || mimeExt.replace('jpeg', 'jpg') || 'png';
			try {
				const dir = getAttachmentDir();
				fs.mkdirSync(dir, { recursive: true });
				const base = name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'image';
				const file = path.join(dir, `${base}-${stamp.replace(/[:]/g, '-')}.${ext}`);
				fs.writeFileSync(file, Buffer.from(msg.base64, 'base64'));
				this.attachments.push({ id: `paste:${file}:${stamp}`, name, fsPath: file, detail: name });
			} catch {
				void vscode.window.showErrorMessage('Failed to save pasted image.');
			}
			this.pushState();
			return;
		}
		if (typeof msg.text === 'string' && msg.text.trim()) {
			const ext = path.extname(name).replace(/^\./, '');
			this.attachments.push({
				id: `paste:${name}:${stamp}`,
				name,
				fsPath: name,
				detail: name,
				excerpt: msg.text,
				languageId: ext,
			});
			this.pushState();
		}
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

	/** Stop the visible session's turn, or a specific session when closing/deleting. */
	private stopRunning(sessionId?: string): void {
		const id = sessionId ?? this.sessionId;
		if (!id) {
			return;
		}
		const run = this.runs.get(id);
		if (!run) {
			return;
		}
		// Stopping pauses auto-drain so queued follow-ups are not lost silently.
		this.mutateChat(id, chat => {
			chat.queuePaused = true;
		});
		if (run.pendingAsk) {
			this.resolveAsk(run.pendingAsk.id, { outcome: 'cancelled' });
		}
		run.cancel.cancel();
		this.pushState();
	}

	private waitForAsk(
		sessionId: string,
		prompt: AskUserPrompt,
		token: vscode.CancellationToken,
	): Promise<AskUserResult> {
		const run = this.runs.get(sessionId);
		if (!run) {
			return Promise.resolve({ outcome: 'cancelled' });
		}
		if (run.pendingAsk) {
			this.resolveAsk(run.pendingAsk.id, { outcome: 'cancelled' });
		}
		return new Promise(resolve => {
			const cancel = token.onCancellationRequested(() => {
				this.resolveAsk(prompt.id, { outcome: 'cancelled' });
			});
			run.pendingAsk = {
				id: prompt.id,
				resolve: result => {
					cancel.dispose();
					resolve(result);
				},
			};
			this.mutateChat(sessionId, chat => {
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
		for (const [sessionId, run] of this.runs) {
			if (!run.pendingAsk || run.pendingAsk.id !== id) {
				continue;
			}
			const pending = run.pendingAsk;
			run.pendingAsk = undefined;
			this.mutateChat(sessionId, chat => {
				const row = chat.items.find(i => i.id === id && i.kind === 'question');
				if (row && row.kind === 'question') {
					row.status = result.outcome === 'answered' ? 'answered' : 'skipped';
					row.answers = result.outcome === 'answered' ? result.answers : undefined;
				}
			});
			this.pushState();
			pending.resolve(result);
			return;
		}
	}

	private async enqueueMessage(raw: string, pendingAttachments?: AttachmentChip[]): Promise<void> {
		const chips = pendingAttachments ?? this.attachments;
		const attachmentBlock = formatAttachmentBlock(chips);
		const text = `${attachmentBlock}${raw}`.trim();
		if (!text) {
			return;
		}
		this.queue.push({
			id: newItemId('queue'),
			text: raw.trim() || text,
			attachments: [...chips],
		});
		if (!pendingAttachments) {
			this.attachments = [];
		}
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
		if (this.busy && this.sessionId) {
			const run = this.runs.get(this.sessionId);
			if (run) {
				run.pendingForceSend = {
					content: `${formatAttachmentBlock(item.attachments)}${item.text}`.trim(),
					text: item.text,
					attachments: item.attachments,
				};
				run.cancel.cancel();
			}
			return;
		}
		await this.handleSend(item.text, item.attachments);
	}

	private async flushQueue(sessionId: string | undefined): Promise<void> {
		if (!sessionId || this.runs.has(sessionId)) {
			return;
		}
		let next: QueuedMessage | undefined;
		if (sessionId === this.sessionId) {
			if (this.queuePaused || !this.queue.length) {
				return;
			}
			next = this.queue.shift()!;
			this.pushState();
		} else {
			const parked = this.parked.get(sessionId);
			if (!parked || parked.queuePaused || !parked.queue.length) {
				return;
			}
			next = parked.queue.shift()!;
			this.parked.set(sessionId, parked);
		}
		await this.startTurn(sessionId, `${formatAttachmentBlock(next.attachments)}${next.text}`.trim(), { text: next.text, attachments: next.attachments });
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

	/** Working-set rows for the visible chat only. */
	private refreshFileChanges(): void {
		this.fileChanges = this.sessionId
			? this.fileEdits.listOwnedBy(this.sessionId)
			: [];
	}

	/**
	 * After switching sessions: restore composer draft (parked in draftText) and
	 * scope editor review markers to this chat's pending files.
	 */
	private pushAfterSessionSwitch(extra?: { focusInput?: boolean }): void {
		this.refreshFileChanges();
		void this.fileEdits.syncToChatEditing(this.sessionId);
		const draft = this.draftText;
		this.pushState({
			clearDraft: true,
			...(draft ? { insertText: draft } : {}),
			focusInput: extra?.focusInput,
		});
	}

	/**
	 * Apply a mutation to a session's chat. Visible tab writes through
	 * capture/adopt; background tabs write into `parked`.
	 */
	private mutateChat(sessionId: string, mutator: (chat: MutableChat) => void): void {
		if (sessionId === this.sessionId) {
			const chat = this.captureView();
			mutator(chat);
			this.adoptView(chat);
			return;
		}
		const parked = this.parked.get(sessionId);
		if (!parked) {
			return;
		}
		mutator(parked);
		this.parked.set(sessionId, parked);
	}

	private async refreshBilling(): Promise<void> {
		const seq = ++this.billingSeq;
		const [offer, quota] = await Promise.all([fetchClaimOffer(), fetchAccountQuota()]);
		if (seq !== this.billingSeq) {
			return;
		}
		this.claimOffer = offer;
		this.accountQuota = quota;
		this.pushState();
	}

	private skillCache?: { at: number; root: string; skills: ReturnType<typeof listLocalSkills> };

	private cachedSkills() {
		const root = workspaceRoot() ?? '';
		const now = Date.now();
		if (this.skillCache && this.skillCache.root === root && now - this.skillCache.at < 3000) {
			return this.skillCache.skills;
		}
		const skills = listLocalSkills(root || undefined);
		this.skillCache = { at: now, root, skills };
		return skills;
	}

	private async dismissQuotaNotice(id: string): Promise<void> {
		const noticeId = id.trim();
		if (!noticeId) {
			return;
		}
		this.seenNotices.add(noticeId);
		await this.globalState.update(QUOTA_NOTICE_SEEN_KEY, [...this.seenNotices].slice(-200));
		this.pushState();
	}

	private async claimCurrentPlan(planId?: string): Promise<void> {
		const id = planId || this.claimOffer?.planId;
		if (!id || this.claimBusy) {
			return;
		}
		this.claimBusy = true;
		this.claimError = undefined;
		this.pushState();
		const result = await claimManualPlan(id);
		this.claimBusy = false;
		if (result.ok) {
			this.claimError = undefined;
			this.claimOffer = null;
			void vscode.window.showInformationMessage('已领取免费额度');
			await this.refreshBilling();
			return;
		}
		this.claimError = result.message;
		this.pushState();
	}

	private async retryFromAssistant(assistantId: string): Promise<void> {
		if (!this.sessionId) {
			return;
		}
		const assistantIndex = this.items.findIndex(item => item.id === assistantId && item.kind === 'assistant');
		if (assistantIndex < 0) {
			return;
		}
		let userId: string | undefined;
		for (let i = assistantIndex; i >= 0; i--) {
			const item = this.items[i];
			if (item.kind === 'user') {
				userId = item.id;
				break;
			}
		}
		if (!userId) {
			return;
		}
		await this.rewindToUser(userId, 'retry');
	}

	private async rewindToUser(userId: string, mode: 'keep' | 'edit' | 'retry'): Promise<void> {
		if (!this.sessionId || this.busy) {
			return;
		}
		const index = this.items.findIndex(item => item.id === userId && item.kind === 'user');
		const user = this.items[index];
		if (!user || user.kind !== 'user') {
			return;
		}
		const hasTail = index < this.items.length - 1;
		const fileCount = this.fileEdits.filesFromCheckpoint(userId, this.sessionId);
		if (mode !== 'edit' && !hasTail && fileCount === 0) {
			return;
		}
		if (mode !== 'edit' || hasTail || fileCount > 0) {
			const label = mode === 'edit' ? '修改' : mode === 'retry' ? '重试' : '回到这里';
			const detail = mode === 'edit'
				? '修改这条消息会去掉它和之后的回复，并撤销这之后记录到的文件改动。'
				: mode === 'retry'
					? '重试会去掉这条回复和之后的内容，撤销这轮记录到的文件改动，然后原样再发一次。'
					: '回到这一轮会去掉之后的回复，并撤销这之后记录到的文件改动。';
			const confirmed = await vscode.window.showWarningMessage(detail, { modal: true }, label);
			if (confirmed !== label) {
				return;
			}
		}
		const restored = await this.fileEdits.restoreToCheckpoint(userId, this.sessionId, {
			drop: mode === 'edit',
		});
		this.items = mode === 'edit' ? this.items.slice(0, index) : this.items.slice(0, index + 1);
		this.todos = [];
		this.activeStatusId = undefined;
		this.activeAssistantId = undefined;
		this.activeReasoningId = undefined;
		this.activeReasoningStartedAt = undefined;
		this.activeWorkId = undefined;
		this.turnStartedAt = undefined;
		this.reportedUsageTokens = undefined;
		const chips = (user.attachments ?? []).flatMap(ref => ref.path ? [{
			id: ref.id,
			name: ref.name,
			fsPath: ref.path,
		}] : []);
		if (mode === 'edit') {
			this.attachments = chips;
			this.draftText = user.text;
			this.pushState({ clearDraft: true, insertText: user.text, focusInput: true });
			await this.persistSession();
			return;
		}
		if (!restored.hadCheckpoint && fileCount === 0 && this.fileEdits.listOwnedBy(this.sessionId).length > 0) {
			void vscode.window.showInformationMessage('对话已回到这一轮。更早启动里的文件改动没有按轮记录，需要的话请用 Undo 撤销。');
		}
		if (mode === 'retry') {
			this.pushState();
			const content = `${formatAttachmentBlock(chips)}${user.text}`.trim();
			await this.startTurn(this.sessionId, content, { text: user.text, attachments: chips }, userId);
			return;
		}
		this.pushState();
		await this.persistSession();
	}

	private maybeCompact(runSessionId: string): boolean {
		const chat = runSessionId === this.sessionId
			? this.captureView()
			: this.parked.get(runSessionId);
		if (!chat) {
			return false;
		}
		const brain = getActiveBrain();
		const model = brain === 'cursor'
			? (getCursorModel() || undefined)
			: getSelectedModelId(getProviderMode());
		const next = compactConversation(chat.items, model);
		if (!next.compacted) {
			return false;
		}
		this.mutateChat(runSessionId, current => {
			current.items = next.items;
		});
		if (runSessionId === this.sessionId) {
			this.reportedUsageTokens = undefined;
		}
		return true;
	}

	private async handleSend(text: string, pendingAttachments?: AttachmentChip[]): Promise<void> {
		if (!this.sessionId) {
			return;
		}
		if (this.busy) {
			await this.enqueueMessage(text, pendingAttachments);
			return;
		}
		const attachments = pendingAttachments ?? this.attachments;
		const prepared = prepareComposerTurn(text, workspaceRoot());
		if (!prepared.modelText) {
			this.noteComposer(prepared.notice || '没有可发送的内容');
			return;
		}
		const content = `${formatAttachmentBlock(attachments)}${prepared.modelText}`.trim();
		if (!content) {
			return;
		}
		this.attachments = [];
		this.draftText = '';
		this.pushState({ clearDraft: true });
		await this.startTurn(this.sessionId, content, { text: prepared.displayText, attachments });
	}

	/** Local slash replies (/skill list, unknown skill) stay in the timeline. */
	private noteComposer(text: string): void {
		if (!this.sessionId) {
			return;
		}
		const sessionId = this.sessionId;
		this.mutateChat(sessionId, chat => {
			chat.items.push({
				id: newItemId('status'),
				kind: 'status',
				text,
				tone: 'info',
			});
		});
		this.draftText = '';
		this.pushState({ clearDraft: true });
		void this.persistSessionById(sessionId);
	}

	/**
	 * Snapshot of other open/running chats + foreign pending files for prompt injection.
	 */
	private buildSessionAwareness(runSessionId: string): SessionAwareness {
		const titleById = new Map<string, string>();
		for (const tab of this.buildTitleTabs()) {
			titleById.set(tab.id, tab.title);
		}
		for (const s of this.sessionList) {
			if (!titleById.has(s.id)) {
				titleById.set(s.id, s.title);
			}
		}

		const peerIds = new Set<string>();
		for (const id of this.runs.keys()) {
			if (id !== runSessionId) {
				peerIds.add(id);
			}
		}
		for (const id of this.openTabIds) {
			if (id !== runSessionId) {
				peerIds.add(id);
			}
		}
		for (const id of this.parked.keys()) {
			if (id !== runSessionId) {
				peerIds.add(id);
			}
		}

		const peers = [...peerIds].map(id => {
			const chat = id === this.sessionId
				? this.captureView()
				: this.parked.get(id);
			const todos = (chat?.todos ?? [])
				.filter(t => t.status !== 'completed')
				.map(t => t.content.trim())
				.filter(Boolean)
				.slice(0, 5);
			const recentTools = (chat?.items ?? [])
				.filter((item): item is Extract<ConversationItem, { kind: 'tool' }> => item.kind === 'tool')
				.slice(-5)
				.map(item => `${item.toolName}: ${item.summary}`);
			return {
				id,
				title: titleById.get(id) || '对话',
				running: this.runs.has(id),
				todos,
				recentTools,
			};
		}).filter(peer => peer.running || peer.todos.length > 0 || peer.recentTools.length > 0);

		const foreignFiles = this.fileEdits.listOwnedByOthers(runSessionId).map(f => ({
			path: f.relativePath,
			kind: f.kind,
			ownerSessionId: f.ownerSessionId!,
			ownerTitle: f.ownerSessionId ? titleById.get(f.ownerSessionId) : undefined,
		}));

		// Always surface file owners even when the peer tab was filtered as idle/empty.
		for (const file of foreignFiles) {
			if (peers.some(p => p.id === file.ownerSessionId)) {
				continue;
			}
			peers.push({
				id: file.ownerSessionId,
				title: file.ownerTitle || '对话',
				running: this.runs.has(file.ownerSessionId),
				todos: [],
				recentTools: [],
			});
		}

		return {
			sessionId: runSessionId,
			peers,
			foreignFiles,
		};
	}

	/**
	 * Start an agent turn for any open session (visible or parked).
	 * Concurrent across sessions; serialized within one session via `runs`.
	 */
	private toAttachmentRefs(attachments?: AttachmentChip[]): UserAttachmentRef[] | undefined {
		if (!attachments?.length) {
			return undefined;
		}
		return attachments.map(a => {
			const isImage = !a.excerpt && !!a.fsPath && /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(a.fsPath);
			let uri: string | undefined;
			if (isImage && a.fsPath) {
				try {
					uri = this.view?.webview.asWebviewUri(vscode.Uri.file(a.fsPath)).toString();
				} catch {
					uri = undefined;
				}
			}
			return { id: a.id, name: a.name, image: isImage, uri, path: a.fsPath };
		});
	}

	private async startTurn(runSessionId: string, content: string, display?: { text?: string; attachments?: AttachmentChip[] }, reuseUserId?: string): Promise<void> {
		if (!content.trim() || this.runs.has(runSessionId)) {
			return;
		}
		const displayText = display?.text ?? content;
		const attachmentRefs = this.toAttachmentRefs(display?.attachments);
		let sentUserId = reuseUserId ?? '';

		this.mutateChat(runSessionId, chat => {
			const reused = reuseUserId
				? chat.items.find(item => item.id === reuseUserId && item.kind === 'user')
				: undefined;
			const userId = reused ? reused.id : newItemId('user');
			sentUserId = userId;
			if (!reused) {
				chat.items.push({ id: userId, kind: 'user', text: displayText, attachments: attachmentRefs });
			}
			this.fileEdits.beginCheckpoint(userId, runSessionId);
			chat.activeStatusId = undefined;
			chat.activeAssistantId = undefined;
			chat.activeReasoningId = undefined;
			chat.activeReasoningStartedAt = undefined;
			chat.turnStartedAt = Date.now();
			chat.activeWorkId = newItemId('work');
			chat.items.push({
				id: chat.activeWorkId,
				kind: 'work',
				label: 'Working',
				startedAt: chat.turnStartedAt,
				elapsedMs: 0,
				running: true,
			});
		});
		this.unreadDoneIds.delete(runSessionId);
		if (runSessionId === this.sessionId) {
			this.startElapsedTimer();
		}
		this.pushState();
		if (this.maybeCompact(runSessionId)) {
			this.pushState();
		}

		const snapshot = runSessionId === this.sessionId
			? this.captureView()
			: this.parked.get(runSessionId);
		if (!snapshot) {
			return;
		}

		const brain = getActiveBrain();
		const provider = getProviderMode();
		const model = brain === 'cursor'
			? (getCursorModel() || undefined)
			: getSelectedModelId(provider);
		const reasoningLevel = getSelectedReasoningLevel(provider, getSelectedModelId(provider));
		const history: ChatMessage[] = snapshot.items
			.filter((item): item is Extract<ConversationItem, { kind: 'user' | 'assistant' | 'summary' }> =>
				item.kind === 'user'
				|| item.kind === 'summary'
				|| (item.kind === 'assistant' && !item.streaming && !!item.text))
			.map(item => {
				if (item.kind === 'summary') {
					return { role: 'user' as const, content: `此前对话已压缩为摘要，请据此继续：\n${item.text}` };
				}
				if (item.kind === 'assistant') {
					return { role: 'assistant' as const, content: item.text };
				}
				if (item.id === sentUserId) {
					return { role: 'user' as const, content };
				}
				const chips = (item.attachments ?? []).flatMap(ref => ref.path ? [{
					id: ref.id,
					name: ref.name,
					fsPath: ref.path,
				}] : []);
				return { role: 'user' as const, content: `${formatAttachmentBlock(chips)}${item.text}`.trim() };
			});
		const initialTodos = [...snapshot.todos];
		const sessionAwareness = this.buildSessionAwareness(runSessionId);

		const cancel = new vscode.CancellationTokenSource();
		const run: SessionRun = { cancel };
		this.runs.set(runSessionId, run);
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
				sessionAwareness,
				agentPace: getAgentPace(),
				promptPreamble: buildPromptPreamble(workspaceRoot()),
				onProgress: event => this.applyProgress(runSessionId, event),
				askUser: (prompt, token) => this.waitForAsk(runSessionId, prompt, token),
			}, cancel.token);

			this.mutateChat(runSessionId, chat => {
				this.clearStatusOn(chat);
				this.finishReasoningOn(chat);
				if (result.todos?.length) {
					chat.todos = result.todos;
				}
				if (chat.activeAssistantId) {
					const existing = chat.items.find(i => i.id === chat.activeAssistantId);
					if (existing && existing.kind === 'assistant') {
						if (result.content.trim() && result.content.length >= existing.text.length) {
							existing.text = result.content;
						}
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
			this.mutateChat(runSessionId, chat => {
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
			const force = run.pendingForceSend;
			this.mutateChat(runSessionId, chat => {
				chat.activeStatusId = undefined;
				chat.activeAssistantId = undefined;
				chat.activeReasoningId = undefined;
				chat.activeReasoningStartedAt = undefined;
				chat.activeWorkId = undefined;
				chat.turnStartedAt = undefined;
				if ((cancelled || turnFailed) && !force) {
					chat.queuePaused = true;
				}
			});
			if (runSessionId === this.sessionId) {
				this.stopElapsedTimer();
			}
			// Identity-compare like ZCode: only clear if this turn still owns the slot.
			if (this.runs.get(runSessionId)?.cancel === cancel) {
				this.runs.delete(runSessionId);
			}
			cancel.dispose();
			if (!cancelled) {
				this.unreadDoneIds.add(runSessionId);
			} else {
				this.unreadDoneIds.delete(runSessionId);
			}
			await this.persistSessionById(runSessionId);
			this.pushState();

			if (force) {
				this.mutateChat(runSessionId, chat => {
					chat.queuePaused = false;
				});
				void this.startTurn(runSessionId, force.content, { text: force.text, attachments: force.attachments });
			} else if (!cancelled && !turnFailed && this.sessionHasPendingQueue(runSessionId)) {
				void this.flushQueue(runSessionId);
			} else if (!cancelled) {
				// Notify when this session is idle again (not on Stop, not mid-queue).
				this.playCompletionSound(turnFailed ? 'error' : 'success');
			}
		}
	}

	private sessionHasPendingQueue(sessionId: string): boolean {
		if (sessionId === this.sessionId) {
			return !this.queuePaused && this.queue.length > 0;
		}
		const parked = this.parked.get(sessionId);
		return !!parked && !parked.queuePaused && parked.queue.length > 0;
	}

	/** Soft chime in the chat webview when a turn settles. */
	private playCompletionSound(outcome: 'success' | 'error'): void {
		const enabled = vscode.workspace.getConfiguration('zcode').get<boolean>('completionSound');
		if (enabled === false) {
			return;
		}
		void this.view?.webview.postMessage({ type: 'playCompletionSound', outcome });
	}

	private async bootstrapSession(): Promise<void> {
		await this.ideChat.pruneEmptySessions();
		const active = await this.ideChat.getActiveSession(this.sessionListScope());
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
		const freezeRunning = this.runs.has(id);
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
			if (item.kind === 'tool') {
				const next = item.status === 'running' && !freezeRunning
					? { ...item, status: 'done' as const }
					: { ...item };
				// Historical tool diffs stay one click away — never dump cards into the stream.
				next.expanded = false;
				return next;
			}
			return item;
		});
		this.todos = todos;
		this.attachments = [];
		this.applySelectionQueue();
		this.draftText = '';
		this.queue = [];
		this.queuePaused = false;
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
		if (!opts?.force && this.isSessionEmpty() && !this.sessionPersisted && !this.isRunning(this.sessionId)) {
			this.pushState({ clearDraft: true });
			return;
		}
		if (this.sessionId && (this.isRunning(this.sessionId) || !this.isSessionEmpty() || this.sessionPersisted)) {
			this.parkCurrent();
			if (this.isSessionEmpty() && this.sessionPersisted && !this.isRunning(this.sessionId)) {
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
		await this.refreshSessionList();
		this.pushAfterSessionSwitch();
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
			if (this.runs.has(sessionId)) {
				this.startElapsedTimer();
			}
			await this.ideChat.setActiveSession(sessionId).catch(() => undefined);
			await this.refreshSessionList();
			this.pushAfterSessionSwitch();
			if (!this.runs.has(sessionId)) {
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
		this.pushAfterSessionSwitch();
	}

	private async closeTab(sessionId: string): Promise<void> {
		if (this.runs.has(sessionId)) {
			this.stopRunning(sessionId);
			if (sessionId === this.sessionId) {
				this.stopElapsedTimer();
			}
			// Detach the run marker now — the async run loop's tail must not keep
			// the closed tab alive via refreshSessionList()/persistSessionById().
			this.runs.delete(sessionId);
		}
		const closingActive = this.sessionId === sessionId;
		const closingDraft = closingActive && !this.sessionPersisted && !this.runs.has(sessionId);

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
		if (this.runs.has(sessionId)) {
			this.stopRunning(sessionId);
			this.runs.delete(sessionId);
		}
		this.parked.delete(sessionId);
		await this.ideChat.deleteSession(sessionId);
		this.unreadDoneIds.delete(sessionId);
		this.openTabIds = this.openTabIds.filter(id => id !== sessionId);
		if (this.sessionId === sessionId) {
			const next = await this.ideChat.getActiveSession(this.sessionListScope());
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

	/** Scope history and tabs to the opened folder. No folder keeps the unscoped list. */
	private sessionListScope(): { workspaceRoot: string } | undefined {
		const root = workspaceRoot();
		return root ? { workspaceRoot: root } : undefined;
	}

	private async refreshSessionList(): Promise<void> {
		const scope = this.sessionListScope();
		this.sessionList = await this.ideChat.listSessions({
			...scope,
			limit: 80,
		});
		const stored = await this.ideChat.getOpenTabIds(scope);
		const known = new Set(this.sessionList.map(s => s.id));
		const allowed = new Set<string>([...stored, ...this.parked.keys(), ...this.runs.keys()]);
		if (this.sessionId) {
			allowed.add(this.sessionId);
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
				|| this.runs.has(id)
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
		for (const id of this.runs.keys()) {
			append(id);
		}
		append(this.sessionId);
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

	private applyProgress(sessionId: string, event: AgentProgressEvent): void {
		if (event.type === 'file_change') {
			// Only refresh the visible working set when the active tab owns the edit.
			if (sessionId === this.sessionId) {
				this.refreshFileChanges();
				this.pushState();
			}
			return;
		}

		this.mutateChat(sessionId, chat => {
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
				this.settleAssistantOn(chat);
				if (!chat.activeReasoningId) {
					chat.activeReasoningId = newItemId('reasoning');
					chat.activeReasoningStartedAt = Date.now();
					chat.items.push({
						id: chat.activeReasoningId,
						kind: 'reasoning',
						text: event.text,
						streaming: !event.done,
						// Match Cursor: stay collapsed; header shows a one-line preview while streaming.
						expanded: false,
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
				this.settleAssistantOn(chat);
				const startSummary = event.summary && !isUselessToolSummary(event.summary, event.toolName)
					? event.summary
					: undefined;
				chat.items.push({
					id: event.id,
					kind: 'tool',
					toolName: event.toolName,
					summary: startSummary || toolDisplayName(event.toolName),
					detail: event.detail,
					status: 'running',
					expanded: false,
				});
				this.pinWorkToEndOn(chat);
				return;
			}

			if (event.type === 'tool_update') {
				const row = chat.items.find(i => i.id === event.id);
				if (row && row.kind === 'tool' && row.status === 'running') {
					if (event.summary && !isUselessToolSummary(event.summary, row.toolName)) {
						row.summary = event.summary;
					}
					if (typeof event.detail === 'string') {
						row.detail = event.detail;
					}
				}
				return;
			}

			if (event.type === 'tool_end') {
				const row = chat.items.find(i => i.id === event.id);
				if (row && row.kind === 'tool') {
					if (event.summary && !isUselessToolSummary(event.summary, row.toolName)) {
						row.summary = event.summary;
					} else if (event.path) {
						row.summary = event.path;
					}
					row.status = event.ok ? 'done' : 'error';
					if (typeof event.detail === 'string') {
						row.detail = event.detail;
					}
					if (event.path) {
						row.path = event.path;
					}
					if (event.uri) {
						row.uri = event.uri;
					}
					if (typeof event.added === 'number') {
						row.added = event.added;
					}
					if (typeof event.removed === 'number') {
						row.removed = event.removed;
					}
					row.expanded = row.expanded ?? false;
				} else {
					let endSummary = toolDisplayName(event.toolName);
					if (event.path) {
						endSummary = event.path;
					}
					if (event.summary && !isUselessToolSummary(event.summary, event.toolName)) {
						endSummary = event.summary;
					}
					chat.items.push({
						id: event.id,
						kind: 'tool',
						toolName: event.toolName,
						summary: endSummary,
						status: event.ok ? 'done' : 'error',
						detail: event.detail,
						path: event.path,
						uri: event.uri,
						added: event.added,
						removed: event.removed,
						expanded: false,
					});
				}
				return;
			}

			if (event.type === 'assistant') {
				this.clearStatusOn(chat);
				this.finishReasoningOn(chat);
				const next = event.text;
				let row = chat.activeAssistantId
					? chat.items.find(i => i.id === chat.activeAssistantId)
					: undefined;
				if (row && row.kind === 'assistant' && row.text && next && !next.startsWith(row.text)) {
					// A new segment, not a longer version of the text already on screen.
					row.streaming = false;
					chat.activeAssistantId = undefined;
					row = undefined;
				}
				if (!row || row.kind !== 'assistant') {
					const carried = this.assistantContinuing(chat, next);
					if (carried) {
						row = carried;
						chat.activeAssistantId = carried.id;
					}
				}
				if (!row || row.kind !== 'assistant') {
					chat.activeAssistantId = newItemId('assistant');
					chat.items.push({
						id: chat.activeAssistantId,
						kind: 'assistant',
						text: next,
						streaming: !event.done,
					});
				} else if (next.length >= row.text.length) {
					row.text = next;
					row.streaming = !event.done;
				} else {
					row.streaming = !event.done;
				}
				this.pinAssistantBeforeWorkOn(chat);
			}
		});
		this.pushState();
	}

	/** Keep text already shown. The next answer segment starts a new row. */
	private settleAssistantOn(chat: MutableChat): void {
		if (!chat.activeAssistantId) {
			return;
		}
		const row = chat.items.find(i => i.id === chat.activeAssistantId);
		if (row && row.kind === 'assistant') {
			if (!row.text.trim()) {
				chat.items = chat.items.filter(i => i.id !== chat.activeAssistantId);
			} else {
				row.streaming = false;
			}
		}
		chat.activeAssistantId = undefined;
	}

	/** Cursor sends the full answer so far; reuse that row instead of duplicating it. */
	private assistantContinuing(chat: MutableChat, next: string): Extract<ConversationItem, { kind: 'assistant' }> | undefined {
		if (!next) {
			return undefined;
		}
		for (let i = chat.items.length - 1; i >= 0; i--) {
			const item = chat.items[i];
			if (item.kind === 'user') {
				return undefined;
			}
			if (item.kind === 'assistant') {
				return item.text && next.startsWith(item.text) ? item : undefined;
			}
		}
		return undefined;
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
		const agentPace = getAgentPace();
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
			agentPace,
			agentPaceLabel: AGENT_PACE_LABELS[agentPace],
			agentPaces: AGENT_PACES.map(id => ({ id, label: AGENT_PACE_LABELS[id] })),
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
				running: this.runs.has(s.id),
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
			lineHeight: getChatLineHeight(),
			contextUsage: this.buildContextUsage(),
			claimOffer: this.claimOffer,
			claimError: this.claimError,
			claimBusy: this.claimBusy,
			accountQuota: this.accountQuota ? { lines: this.accountQuota.lines } : null,
			quotaNotice: selectQuotaNotice(this.accountQuota, getSelectedModelId(provider), this.seenNotices),
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
				running: this.runs.has(id),
				done: this.unreadDoneIds.has(id),
				draft: isDraft,
			};
		});
	}

	/** Bust webview HTTP cache so CSS/JS edits show after Reload Window. */
	private mediaUri(webview: vscode.Webview, ...pathSegments: string[]): vscode.Uri {
		const file = vscode.Uri.joinPath(this.extensionUri, ...pathSegments);
		let ver = '1';
		try {
			ver = String(fs.statSync(file.fsPath).mtimeMs | 0);
		} catch {
			ver = String(Date.now());
		}
		return webview.asWebviewUri(file).with({ query: `v=${ver}` });
	}

	private renderHtml(webview: vscode.Webview): string {
		const styleUri = this.mediaUri(webview, 'media', 'chatView.css');
		const highlightStyleUri = this.mediaUri(webview, 'media', 'highlight-vscode.css');
		const markdownItUri = this.mediaUri(webview, 'media', 'markdown-it.min.js');
		const highlightUri = this.mediaUri(webview, 'media', 'highlight.min.js');
		const markdownUri = this.mediaUri(webview, 'media', 'markdown.js');
		const scriptUri = this.mediaUri(webview, 'media', 'chatView.js');
		const csp = [
			`default-src 'none'`,
			`style-src ${webview.cspSource}`,
			`script-src ${webview.cspSource}`,
			`img-src ${webview.cspSource} data:`,
		].join('; ');

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<meta name="zcode-chat-ui" content="compact-v2" />
	<title>ZCode</title>
	<link rel="stylesheet" href="${styleUri}" />
	<link rel="stylesheet" href="${highlightStyleUri}" />
</head>
<body class="zcode-compact">
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
	<div class="quota-notice" id="quotaNotice" hidden>
		<span id="quotaNoticeText"></span>
		<button type="button" id="quotaNoticeClose" aria-label="关闭">×</button>
	</div>
	<div class="claim-banner" id="claimBanner" hidden>
		<div class="claim-copy">
			<div class="claim-title" id="claimTitle"></div>
			<div class="claim-meta" id="claimMeta"></div>
			<div class="claim-error" id="claimError" hidden></div>
		</div>
		<button type="button" class="monaco-text-button" id="claimBtn">领取</button>
	</div>
	<div class="chat-input-container" id="composer">
		<div class="menu" id="plusMenu" role="menu"></div>
		<div class="menu" id="pickerMenu" role="listbox"></div>
		<textarea id="input" rows="2" placeholder="Plan, @ for context, / for commands, $ for skills"></textarea>
		<div class="chat-input-toolbars" id="composerToolbar">
			<div class="toolbar-left">
				<button class="icon-btn" id="plus" type="button" title="Add" aria-label="Add">+</button>
				<span id="zcodePills" data-brain-chrome="zcode">
					<button class="pill" id="providerBtn" type="button" title="Provider"><span class="label" id="providerLabel">Start Plan</span><span class="chev">▾</span></button>
					<button class="pill" id="modelBtn" type="button" title="Model"><span class="label" id="modelLabel">Model</span><span class="chev">▾</span></button>
					<button class="pill" id="paceBtn" type="button" title="Agent pace"><span class="label" id="paceLabel">快速</span><span class="chev">▾</span></button>
					<button class="pill thought" id="thoughtBtn" type="button" title="Thinking intensity"><span class="brain">◎</span><span class="label" id="thoughtLabel">Low</span><span class="chev">▾</span></button>
				</span>
				<span id="cursorPills" data-brain-chrome="cursor" hidden>
					<button class="pill" id="cursorModeBtn" type="button" title="Cursor mode"><span class="label" id="cursorModeLabel">Agent</span><span class="chev">▾</span></button>
					<button class="pill" id="cursorModelBtn" type="button" title="Cursor model"><span class="label" id="cursorModelLabel">Default</span><span class="chev">▾</span></button>
				</span>
			</div>
			<div class="toolbar-right">
				<span class="quota-chip" id="quotaChip" hidden title="Start Plan 剩余额度"></span>
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
	<div class="brain-bar">
		<div class="brain-switch" id="brainSwitch" role="tablist" aria-label="AI brain">
			<button type="button" class="brain-tab" data-brain="zcode" id="brainZcode">ZCode</button>
			<button type="button" class="brain-tab" data-brain="cursor" id="brainCursor">Cursor</button>
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
	const provider = new ZCodeChatViewProvider(context.extensionUri, ideChat, fileEdits, context.globalState);
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

/** ACP placeholders that must not replace a better tool summary. */
function isUselessToolSummary(summary: string, toolName?: string): boolean {
	const t = summary.trim().toLowerCase();
	if (!t) {
		return true;
	}
	if (
		t === 'tool'
		|| t === 'other'
		|| t === 'mcp: tool'
		|| t === 'mcp tool'
		|| t === 'called mcp tool'
		|| t === 'pending'
		|| t === 'in_progress'
		|| t === 'completed'
		|| t === 'failed'
		|| t === 'error'
		|| t === 'done'
		|| t === 'running'
	) {
		return true;
	}
	if (toolName && t === toolName.trim().toLowerCase()) {
		return true;
	}
	return false;
}
