/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentProgressEvent } from './agentRuntime';
import { getAuthService } from './authSession';
import { completeChatTurn, getBridgeMode, workspaceRoot, type ChatMessage } from './bridge';
import { buildPlusMenuSections, formatSlashInsert } from './composerActions';
import {
	formatWorkDuration,
	newItemId,
	toolDisplayName,
	type ConversationItem,
	type TodoItem,
} from './conversation';
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
	IDE_CHAT_SOURCE_ZCODE,
	IdeChatStore,
	titleFromMessages,
	type IdeChatSessionMeta,
} from './ideChatStore';

const VIEW_ID = 'zcode.chatView';

interface AttachmentChip {
	id: string;
	name: string;
	fsPath: string;
}

export class ZCodeChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = VIEW_ID;

	private view?: vscode.WebviewView;
	private items: ConversationItem[] = [];
	private attachments: AttachmentChip[] = [];
	private todos: TodoItem[] = [];
	private draftText = '';
	private busy = false;
	private sessionId?: string;
	private sessionList: IdeChatSessionMeta[] = [];
	private activeStatusId?: string;
	private activeAssistantId?: string;
	private activeReasoningId?: string;
	private activeReasoningStartedAt?: number;
	private activeWorkId?: string;
	private turnStartedAt?: number;
	private elapsedTimer?: ReturnType<typeof setInterval>;

	private fileChanges: FileChangeView[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly ideChat: IdeChatStore,
		private readonly fileEdits: FileEditSession,
	) {
		this.fileEdits.onDidChange(() => {
			this.fileChanges = this.fileEdits.list();
			this.pushState();
		});
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
		void this.bootstrapSession();
	}

	async newChat(): Promise<void> {
		await this.startNewSession();
	}

	async open(): Promise<void> {
		await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar');
		await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
	}

	async switchProvider(): Promise<void> {
		const next = await pickProviderMode();
		if (!next) {
			return;
		}
		await this.applyProvider(next);
		void vscode.window.setStatusBarMessage(`ZCode provider: ${PROVIDER_LABELS[next]}`, 2500);
	}

	refresh(): void {
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
			sessionId?: string;
			provider?: string;
			model?: string;
			reasoningLevel?: string;
			actionId?: string;
			slash?: string;
			draft?: string;
			attachmentId?: string;
		};

		if (msg.type === 'ready') {
			void this.bootstrapSession();
			return;
		}
		if (msg.type === 'draft' && typeof msg.draft === 'string') {
			this.draftText = msg.draft;
			return;
		}
		if (msg.type === 'openPlus') {
			if (typeof msg.draft === 'string') {
				this.draftText = msg.draft;
			}
			this.pushState({ openPlus: true });
			return;
		}
		if (msg.type === 'setProvider' && (msg.provider === 'startPlan' || msg.provider === 'bigmodel')) {
			await this.applyProvider(msg.provider);
			return;
		}
		if (msg.type === 'setModel' && typeof msg.model === 'string') {
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
		if (msg.type === 'openSession' && typeof msg.sessionId === 'string') {
			await this.openSession(msg.sessionId);
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

	private async handleSend(text: string): Promise<void> {
		if (this.busy) {
			return;
		}
		const attachmentBlock = this.attachments.length
			? `Attachments:\n${this.attachments.map(a => `- ${a.fsPath}`).join('\n')}\n\n`
			: '';
		const content = `${attachmentBlock}${text}`.trim();

		this.items.push({ id: newItemId('user'), kind: 'user', text: content });
		this.attachments = [];
		this.draftText = '';
		this.busy = true;
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

		const provider = getProviderMode();
		const model = getSelectedModelId(provider);
		const reasoningLevel = getSelectedReasoningLevel(provider, model);
		const history: ChatMessage[] = this.items
			.filter((item): item is Extract<ConversationItem, { kind: 'user' | 'assistant' }> =>
				item.kind === 'user' || (item.kind === 'assistant' && !item.streaming && !!item.text))
			.map(item => ({
				role: item.kind === 'user' ? 'user' : 'assistant',
				content: item.text,
			}));

		const cancel = new vscode.CancellationTokenSource();
		try {
			const result = await completeChatTurn({
				messages: history,
				provider,
				model,
				reasoningLevel,
				workspaceRoot: workspaceRoot(),
				initialTodos: this.todos,
				onProgress: event => this.applyProgress(event),
			}, cancel.token);

			this.clearStatus();
			this.finishReasoning();
			if (result.todos?.length) {
				this.todos = result.todos;
			}
			if (this.activeAssistantId) {
				const existing = this.items.find(i => i.id === this.activeAssistantId);
				if (existing && existing.kind === 'assistant') {
					existing.text = result.content;
					existing.streaming = false;
				}
			} else if (result.content.trim()) {
				this.activeAssistantId = newItemId('assistant');
				this.items.push({
					id: this.activeAssistantId,
					kind: 'assistant',
					text: result.content,
				});
			}
			this.pinAssistantBeforeWork();
			this.finishWork(true);
		} catch (error) {
			this.clearStatus();
			this.finishReasoning();
			this.finishWork(false);
			const errText = error instanceof Error ? error.message : String(error);
			this.items.push({
				id: newItemId('status'),
				kind: 'status',
				text: errText,
				tone: 'error',
			});
		} finally {
			this.stopElapsedTimer();
			this.busy = false;
			this.activeStatusId = undefined;
			this.activeAssistantId = undefined;
			this.activeReasoningId = undefined;
			this.activeWorkId = undefined;
			this.turnStartedAt = undefined;
			await this.persistSession(true);
			this.pushState();
		}
	}

	private async bootstrapSession(): Promise<void> {
		const active = await this.ideChat.getActiveSession();
		if (active) {
			this.applySession(active.id, active.timeline ?? [], active.todos ?? []);
		} else {
			const created = await this.ideChat.createSession({
				source: IDE_CHAT_SOURCE_ZCODE,
				workspaceRoot: workspaceRoot(),
				provider: getProviderMode(),
				model: getSelectedModelId(getProviderMode()),
			});
			this.applySession(created.id, [], []);
		}
		await this.refreshSessionList();
		this.pushState();
	}

	private applySession(id: string, items: ConversationItem[], todos: TodoItem[]): void {
		this.stopElapsedTimer();
		this.sessionId = id;
		this.items = items.map(item => {
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
		this.draftText = '';
		this.busy = false;
		this.activeStatusId = undefined;
		this.activeAssistantId = undefined;
		this.activeReasoningId = undefined;
		this.activeWorkId = undefined;
		this.turnStartedAt = undefined;
	}

	private async startNewSession(): Promise<void> {
		if (this.busy) {
			return;
		}
		await this.persistSession(true);
		const created = await this.ideChat.createSession({
			source: IDE_CHAT_SOURCE_ZCODE,
			workspaceRoot: workspaceRoot(),
			provider: getProviderMode(),
			model: getSelectedModelId(getProviderMode()),
		});
		this.applySession(created.id, [], []);
		this.fileChanges = this.fileEdits.list();
		await this.refreshSessionList();
		this.pushState({ clearDraft: true });
	}

	private async openSession(sessionId: string): Promise<void> {
		if (this.busy || sessionId === this.sessionId) {
			return;
		}
		await this.persistSession(true);
		const session = await this.ideChat.setActiveSession(sessionId);
		if (!session) {
			return;
		}
		this.applySession(session.id, session.timeline ?? [], session.todos ?? []);
		await this.refreshSessionList();
		this.pushState({ clearDraft: true });
	}

	private async deleteSession(sessionId: string): Promise<void> {
		if (this.busy) {
			return;
		}
		await this.ideChat.deleteSession(sessionId);
		if (this.sessionId === sessionId) {
			const next = await this.ideChat.getActiveSession();
			if (next) {
				this.applySession(next.id, next.timeline ?? [], next.todos ?? []);
			} else {
				await this.startNewSession();
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
	}

	private async persistSession(_immediate = true): Promise<void> {
		if (!this.sessionId) {
			return;
		}
		const provider = getProviderMode();
		const model = getSelectedModelId(provider);
		const messages = IdeChatStore.messagesFromTimeline(this.items);
		const createdAt = this.sessionList.find(s => s.id === this.sessionId)?.createdAt ?? Date.now();
		await this.ideChat.saveSession({
			id: this.sessionId,
			title: titleFromMessages(messages),
			createdAt,
			updatedAt: Date.now(),
			source: IDE_CHAT_SOURCE_ZCODE,
			workspaceRoot: workspaceRoot(),
			provider,
			model,
			messages,
			timeline: this.items,
			todos: this.todos,
		});
		await this.refreshSessionList();
	}

	private applyProgress(event: AgentProgressEvent): void {
		if (event.type === 'status') {
			if (this.activeStatusId) {
				const row = this.items.find(i => i.id === this.activeStatusId);
				if (row && row.kind === 'status') {
					row.text = event.text;
					this.pushState();
					return;
				}
			}
			this.activeStatusId = newItemId('status');
			this.items.push({ id: this.activeStatusId, kind: 'status', text: event.text });
			this.pushState();
			return;
		}

		if (event.type === 'reasoning') {
			this.clearStatus();
			this.dropInterimAssistant();
			if (!this.activeReasoningId) {
				this.activeReasoningId = newItemId('reasoning');
				this.activeReasoningStartedAt = Date.now();
				this.items.push({
					id: this.activeReasoningId,
					kind: 'reasoning',
					text: event.text,
					streaming: !event.done,
					expanded: true,
					startedAt: this.activeReasoningStartedAt,
				});
			} else {
				const row = this.items.find(i => i.id === this.activeReasoningId);
				if (row && row.kind === 'reasoning') {
					row.text = event.text;
					row.streaming = !event.done;
					if (event.done && this.activeReasoningStartedAt) {
						row.durationMs = Date.now() - this.activeReasoningStartedAt;
						row.expanded = false;
					}
				}
			}
			if (event.done) {
				this.activeReasoningId = undefined;
				this.activeReasoningStartedAt = undefined;
			}
			this.pinWorkToEnd();
			this.pushState();
			return;
		}

		if (event.type === 'todos') {
			this.todos = event.todos;
			this.pushState();
			return;
		}

		if (event.type === 'file_change') {
			this.fileChanges = this.fileEdits.list();
			this.pushState();
			return;
		}

		if (event.type === 'tool_start') {
			this.clearStatus();
			this.finishReasoning();
			this.dropInterimAssistant();
			this.items.push({
				id: event.id,
				kind: 'tool',
				toolName: event.toolName,
				summary: event.summary || toolDisplayName(event.toolName),
				status: 'running',
			});
			this.pinWorkToEnd();
			this.pushState();
			return;
		}

		if (event.type === 'tool_end') {
			const row = this.items.find(i => i.id === event.id);
			if (row && row.kind === 'tool') {
				row.summary = event.summary;
				row.status = event.ok ? 'done' : 'error';
			} else {
				this.items.push({
					id: event.id,
					kind: 'tool',
					toolName: event.toolName,
					summary: event.summary,
					status: event.ok ? 'done' : 'error',
				});
			}
			this.pushState();
			return;
		}

		if (event.type === 'assistant') {
			this.clearStatus();
			this.finishReasoning();
			if (!this.activeAssistantId) {
				this.activeAssistantId = newItemId('assistant');
				this.items.push({
					id: this.activeAssistantId,
					kind: 'assistant',
					text: event.text,
					streaming: !event.done,
				});
			} else {
				const row = this.items.find(i => i.id === this.activeAssistantId);
				if (row && row.kind === 'assistant') {
					row.text = event.text;
					row.streaming = !event.done;
				}
			}
			this.pinAssistantBeforeWork();
			this.pushState();
		}
	}

	/** Drop answer text that streamed before tool_calls arrived. */
	private dropInterimAssistant(): void {
		if (!this.activeAssistantId) {
			return;
		}
		const row = this.items.find(i => i.id === this.activeAssistantId);
		if (row && row.kind === 'assistant' && row.streaming) {
			this.items = this.items.filter(i => i.id !== this.activeAssistantId);
			this.activeAssistantId = undefined;
			return;
		}
		// Non-streaming mid-loop content also belongs above later tools — remove it.
		if (row && row.kind === 'assistant') {
			this.items = this.items.filter(i => i.id !== this.activeAssistantId);
			this.activeAssistantId = undefined;
		}
	}

	/** Keep conclusion above the work duration footer. */
	private pinAssistantBeforeWork(): void {
		if (!this.activeAssistantId) {
			return;
		}
		const aIdx = this.items.findIndex(i => i.id === this.activeAssistantId);
		if (aIdx < 0) {
			return;
		}
		const [assistant] = this.items.splice(aIdx, 1);
		const workIdx = this.activeWorkId
			? this.items.findIndex(i => i.id === this.activeWorkId)
			: -1;
		if (workIdx >= 0) {
			this.items.splice(workIdx, 0, assistant);
		} else {
			this.items.push(assistant);
		}
	}

	private finishReasoning(): void {
		if (!this.activeReasoningId) {
			return;
		}
		const row = this.items.find(i => i.id === this.activeReasoningId);
		if (row && row.kind === 'reasoning') {
			row.streaming = false;
			row.expanded = false;
			if (this.activeReasoningStartedAt) {
				row.durationMs = Date.now() - this.activeReasoningStartedAt;
			}
		}
		this.activeReasoningId = undefined;
		this.activeReasoningStartedAt = undefined;
	}

	private finishWork(ok: boolean): void {
		if (!this.activeWorkId || !this.turnStartedAt) {
			return;
		}
		const row = this.items.find(i => i.id === this.activeWorkId);
		if (row && row.kind === 'work') {
			row.running = false;
			row.elapsedMs = Date.now() - this.turnStartedAt;
			row.label = ok ? 'Completed' : 'Failed';
		}
		this.pinWorkToEnd();
	}

	private pinWorkToEnd(): void {
		if (!this.activeWorkId) {
			return;
		}
		const idx = this.items.findIndex(i => i.id === this.activeWorkId);
		if (idx < 0 || idx === this.items.length - 1) {
			return;
		}
		const [row] = this.items.splice(idx, 1);
		this.items.push(row);
	}

	private startElapsedTimer(): void {
		this.stopElapsedTimer();
		this.elapsedTimer = setInterval(() => {
			if (!this.activeWorkId || !this.turnStartedAt) {
				return;
			}
			const row = this.items.find(i => i.id === this.activeWorkId);
			if (row && row.kind === 'work' && row.running) {
				row.elapsedMs = Date.now() - this.turnStartedAt;
				this.pinWorkToEnd();
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

	private clearStatus(): void {
		if (!this.activeStatusId) {
			return;
		}
		this.items = this.items.filter(i => i.id !== this.activeStatusId);
		this.activeStatusId = undefined;
	}

	private pushState(extra?: { clearDraft?: boolean; insertText?: string; openPlus?: boolean }): void {
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
			provider,
			providers: PROVIDER_MODES.map(mode => ({
				id: mode,
				label: PROVIDER_LABELS[mode],
			})),
			model: modelId,
			models,
			reasoningLevel,
			reasoningLabel: REASONING_LABELS[reasoningLevel] ?? reasoningLevel,
			reasoningLevels: models.find(m => m.id === modelId)?.reasoningLevels
				?? models[0]?.reasoningLevels
				?? [],
			bridgeMode: getBridgeMode(),
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
			})),
			attachments: this.attachments.map(a => ({ id: a.id, name: a.name })),
			plusSections: buildPlusMenuSections({ emptyDraft: this.draftText.trim().length === 0 }),
			accountLabel,
			signedIn,
			busy: this.busy,
			clearDraft: extra?.clearDraft ?? false,
			insertText: extra?.insertText,
			openPlus: extra?.openPlus ?? false,
		});
	}

	private renderHtml(webview: vscode.Webview): string {
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chatView.css'));
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
</head>
<body>
	<div class="topbar">
		<div class="brand">ZCode</div>
		<div class="topbar-actions">
			<button class="linkish" id="historyBtn" type="button" title="聊天历史">历史</button>
			<button class="linkish" id="newChatBtn" type="button" title="新对话">新对话</button>
			<button class="linkish" id="account" type="button">Account</button>
		</div>
	</div>
	<div class="history-drawer" id="historyDrawer" hidden>
		<div class="history-header">
			<span>聊天历史</span>
			<button class="linkish" id="historyClose" type="button">关闭</button>
		</div>
		<div class="history-hint">全局会话，DeepSeek 等模块可继续同一条历史</div>
		<ul class="history-list" id="historyList"></ul>
	</div>
	<div class="timeline" id="timeline">
		<div class="empty">Ask ZCode to edit, explain, or run something in this workspace.</div>
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
				<button type="button" class="monaco-text-button secondary" id="undoAllBtn" title="Undo All Edits">Undo</button>
				<button type="button" class="monaco-text-button secondary icon" id="viewAllBtn" title="View All Edits" aria-label="View All Edits">⧉</button>
			</div>
		</div>
		<ul class="chat-summary-list" id="workingSetList"></ul>
	</div>
	<div class="chips" id="chips"></div>
	<div class="chat-input-container" id="composer">
		<div class="menu" id="plusMenu" role="menu"></div>
		<div class="menu" id="pickerMenu" role="listbox"></div>
		<textarea id="input" rows="2" placeholder="Plan, @ for context, / for commands"></textarea>
		<div class="chat-input-toolbars">
			<div class="toolbar-left">
				<button class="icon-btn" id="plus" type="button" title="Add" aria-label="Add">+</button>
				<button class="pill" id="providerBtn" type="button" title="Provider"><span class="label" id="providerLabel">Start Plan</span><span class="chev">▾</span></button>
				<button class="pill" id="modelBtn" type="button" title="Model"><span class="label" id="modelLabel">Model</span><span class="chev">▾</span></button>
				<button class="pill thought" id="thoughtBtn" type="button" title="Thinking intensity"><span class="brain">◎</span><span class="label" id="thoughtLabel">High</span><span class="chev">▾</span></button>
			</div>
			<div class="toolbar-right">
				<button class="send-btn" id="send" type="button" title="Send (Enter)" aria-label="Send">↑</button>
			</div>
		</div>
	</div>
	<div class="hint" id="hint"></div>
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
