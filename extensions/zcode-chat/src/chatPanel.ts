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
import { getJobsSnapshot, killJobById, onJobEvent, readJobOutput } from './backgroundJobs';
import { getTerminalsSnapshot, showTerminalByName } from './persistentTerminal';
import { compactConversation } from './contextCompact';
import { buildPlusMenuSections, formatSlashInsert, CAPABILITY_COMMANDS, QUICK_ADD_COMMANDS } from './composerActions';
import {
	BUNDLED_CHAT_SCENES,
	CHAT_SCENE_NONE,
	CHAT_SCENE_STATE_KEY,
	DEFAULT_CHAT_SCENE_ID,
	UNSPLASH_CHAT_SCENES,
	findCatalogScene,
	isSceneImagePath,
	parseSavedUnsplash,
	readPersistedChatScene,
	rememberSceneFile,
	rememberUnsplashPick,
	selectionIsKnown,
	unsplashImageUrl,
	type PersistedChatScene,
	type SavedUnsplashScene,
} from './chatScene';
import { MASCOT_PERSONAS, resolveMascotPersonaId, isMascotPersonaId } from './mascotPersona';
import { mascotDesktopBridge, emitMascotDesktopEvent } from './mascotDesktopBridge';
import { fetchUnsplashBrowse, trackUnsplashDownload, UnsplashKeyRejectedError, type UnsplashTopic } from './unsplashCatalog';
import {
	dispatchStatusLabel,
	formatWorkDuration,
	isDispatchStatusActive,
	isDispatchStatusTerminal,
	newItemId,
	toolDisplayName,
	type ConversationItem,
	type DispatchStatus,
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
	CLAIM_NOTICE_SEEN_KEY,
	readSeenQuotaNotices,
	selectQuotaNotice,
	type AccountQuota,
	type ClaimOffer,
} from './planBilling';
import { buildPromptPreamble } from './promptContext';
import { prepareDeepseekProvider } from './deepseekProvider';
import {
	getProviderMode,
	isProviderMode,
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
	isProvisionalSessionTitle,
	sameWorkspaceRoot,
	titleFromMessages,
	type IdeChatSessionMeta,
} from './ideChatStore';
import { computeContextUsage, type ContextUsageSnapshot } from './contextUsage';
import type { SessionAwareness } from './sessionAwareness';
import { getZcodeScheduleTip } from './zcodeScheduleTip';
import { MascotVoice } from './mascotVoice';

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
	/** Live-ticks Router dispatch cards while any task is still active. */
	private dispatchElapsedTimer?: ReturnType<typeof setInterval>;

	private fileChanges: FileChangeView[] = [];
	private cursorModels: string[] = [];
	private cursorAccountLabel = 'Cursor · checking…';
	/** Last provider-reported total tokens for the active session (if any). */
	private reportedUsageTokens?: number;
	private claimOffer: ClaimOffer | null = null;
	private claimError: string | undefined;
	private claimBusy = false;
	private seenClaimNotices: Set<string>;
	private accountQuota: AccountQuota | null = null;
	private seenNotices = new Set<string>();
	/** Side-gutter background on the Router board and Worker pages. */
	private scenePersisted: PersistedChatScene = { selectedId: DEFAULT_CHAT_SCENE_ID, files: [], unsplash: [] };
	/** Model downloads in flight; progress is polled by the pet's settings page. */
	// Desktop-pet bridge dedupe state (see shareActivityWithDesktopPet).
	private desktopPetLastBusy: boolean | undefined;
	private unsplashTopics: UnsplashTopic[] | null = null;
	private unsplashLoadSeq = 0;
	private unsplashWorkingKey = '';
	/** Cached Unsplash wallpapers live under global storage, outside the repo. */
	private readonly wallpaperDir: string;
	private readonly wallpaperDownloads = new Set<string>();
	private billingSeq = 0;
	/** Session id of the Super Agent Router dispatch surface (pinned Workers page). */
	private routerSessionId: string | undefined;
	/**
	 * Composer follow-up target on the Router page: clicking a dispatch card
	 * binds the next sends to that worker instead of spawning a new one.
	 */
	private dispatchTarget: { workerId: string; workerSessionId: string; badge?: string; accent?: string } | undefined;
	/** zcode session ids spawned via createWorkerSession (this window's run). */
	private readonly workerSessionIds = new Set<string>();
	/** Resolved once the initial session restore finishes (Router open must wait). */
	private readonly bootstrapDone: Promise<void>;
	private resolveBootstrapDone: (() => void) | undefined;
	/** Throttle Super Agent worker heartbeats (streaming can be very chatty). */
	private readonly routerActivityAt = new Map<string, number>();
	/**
	 * Keepalive for the whole in-flight turn. Long model gaps / silent shell tools
	 * otherwise trip the router's 120s watchdog → sticky "疑似卡死".
	 */
	private readonly routerTurnKeepalives = new Map<string, ReturnType<typeof setInterval>>();
	/** Nested-tool keepalive (belt-and-suspenders while a tool is open). */
	private readonly routerToolKeepalives = new Map<string, { count: number; timer: ReturnType<typeof setInterval> }>();

	private isRunning(sessionId: string | undefined): boolean {
		return !!sessionId && this.runs.has(sessionId);
	}

	/** Heartbeat the Super Agent router so Workers do not false-trip "疑似卡死". */
	private notifyRouterWorkerActivity(sessionId: string, detail?: string, opts?: { force?: boolean }): void {
		if (sessionId === this.routerSessionId) {
			return;
		}
		const now = Date.now();
		if (!opts?.force) {
			const last = this.routerActivityAt.get(sessionId) ?? 0;
			if (now - last < 1000) {
				return;
			}
		}
		this.routerActivityAt.set(sessionId, now);
		void vscode.commands.executeCommand('zcode.internal.superAgent.workerActivity', { sessionId, detail });
	}

	private notifyRouterWorkerIdle(sessionId: string, detail?: string): void {
		if (sessionId === this.routerSessionId) {
			return;
		}
		this.clearRouterTurnKeepalive(sessionId);
		this.clearRouterToolKeepalive(sessionId);
		this.routerActivityAt.delete(sessionId);
		void vscode.commands.executeCommand('zcode.internal.superAgent.workerIdle', { sessionId, detail });
	}

	private notifyRouterWorkerAwaiting(sessionId: string, detail?: string): void {
		if (sessionId === this.routerSessionId) {
			return;
		}
		// Waiting on the human is intentionally quiet — stop keepalives so we do
		// not keep "recovering" into Running while AwaitingUser.
		this.clearRouterTurnKeepalive(sessionId);
		this.clearRouterToolKeepalive(sessionId);
		void vscode.commands.executeCommand('zcode.internal.superAgent.workerAwaitingUser', { sessionId, detail });
	}

	private startRouterTurnKeepalive(sessionId: string): void {
		if (sessionId === this.routerSessionId) {
			return;
		}
		this.clearRouterTurnKeepalive(sessionId);
		const timer = setInterval(() => {
			this.notifyRouterWorkerActivity(sessionId, 'turn keepalive', { force: true });
		}, 45_000);
		this.routerTurnKeepalives.set(sessionId, timer);
	}

	private clearRouterTurnKeepalive(sessionId: string): void {
		const timer = this.routerTurnKeepalives.get(sessionId);
		if (!timer) {
			return;
		}
		clearInterval(timer);
		this.routerTurnKeepalives.delete(sessionId);
	}

	private noteRouterToolStart(sessionId: string): void {
		if (sessionId === this.routerSessionId) {
			return;
		}
		let entry = this.routerToolKeepalives.get(sessionId);
		if (!entry) {
			entry = {
				count: 0,
				timer: setInterval(() => {
					this.notifyRouterWorkerActivity(sessionId, 'tool keepalive', { force: true });
				}, 45_000),
			};
			this.routerToolKeepalives.set(sessionId, entry);
		}
		entry.count++;
	}

	private noteRouterToolEnd(sessionId: string): void {
		const entry = this.routerToolKeepalives.get(sessionId);
		if (!entry) {
			return;
		}
		entry.count = Math.max(0, entry.count - 1);
		if (entry.count === 0) {
			this.clearRouterToolKeepalive(sessionId);
		}
	}

	private clearRouterToolKeepalive(sessionId: string): void {
		const entry = this.routerToolKeepalives.get(sessionId);
		if (!entry) {
			return;
		}
		clearInterval(entry.timer);
		this.routerToolKeepalives.delete(sessionId);
	}

	/** True when the visible tab has an in-flight AI turn. */
	private get busy(): boolean {
		return this.isRunning(this.sessionId);
	}

	private scheduleTipTimer?: ReturnType<typeof setInterval>;
	private readonly mascotVoice: MascotVoice;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly ideChat: IdeChatStore,
		private readonly fileEdits: FileEditSession,
		private readonly globalState: vscode.Memento,
		private readonly globalStorageUri: vscode.Uri,
	) {
		this.wallpaperDir = path.join(this.globalStorageUri.fsPath, 'wallpapers');
		this.seenNotices = new Set(readSeenQuotaNotices(this.globalState.get<string[]>(QUOTA_NOTICE_SEEN_KEY)));
		this.seenClaimNotices = new Set(readSeenQuotaNotices(this.globalState.get<string[]>(CLAIM_NOTICE_SEEN_KEY)));
		this.scenePersisted = readPersistedChatScene(this.globalState.get(CHAT_SCENE_STATE_KEY));
		this.mascotVoice = new MascotVoice(globalState);
		// Standalone desktop pet (apps/mascot-desktop): loopback event bridge.
		// Module singleton, so extra panels reuse the first server; harmless
		// when no pet is running. The pet owns its squad/size/position/persona
		const desktopBridge = mascotDesktopBridge();
		void desktopBridge.start().then(started => {
			if (started) {
				desktopBridge.onSpeak(voice => this.generateMascotLine(voice));
				desktopBridge.onPersonas(() => MASCOT_PERSONAS.map(persona => ({
					id: persona.id,
					label: persona.label,
					group: persona.group,
					hint: persona.hint,
				})));
			}
		});
		this.bootstrapDone = new Promise<void>(resolve => {
			this.resolveBootstrapDone = resolve;
		});
		this.fileEdits.onDidChange(() => {
			this.refreshFileChanges();
			this.syncRouterDispatchFiles();
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
		// Title-row columns toggle (workbench chrome) → webview: the board's
		// columns control moved next to Home/History, so its clicks arrive as
		// this command and bounce into the webview that owns the layout.
		vscode.commands.registerCommand('zcode.cycleBoardColumns', () => {
			void this.view?.webview.postMessage({ type: 'cycleBoardColumns' });
		});
		// Worker-rail cleanup bridge — lives here so all dispatch-state sync
		// (bind/patch/remove) stays in one class.
		vscode.commands.registerCommand('zcode.removeWorkerDispatches', (opts?: {
			sessionId?: string;
			workerId?: string;
			workerSessionId?: string;
		}) => {
			if (!opts || typeof opts.workerId !== 'string' || !opts.workerId) {
				return;
			}
			const workerId = opts.workerId;
			// The workbench's workerRemoved event now forwards the worker chat
			// session id — after a history-menu delete the roster row is already
			// gone, so this is the only source for the second suppression key.
			const payloadSessionId = typeof opts.workerSessionId === 'string' ? opts.workerSessionId : '';
			// The board owner is the panel's Router binding; the workbench
			// payload may be stale or missing the id.
			const routerId = this.routerSessionId
				?? (typeof opts.sessionId === 'string' && opts.sessionId ? opts.sessionId : undefined);
			if (!routerId) {
				return;
			}
			// This command is also the workbench's channel for rail closes and
			// history-menu deletes (workerRemoved event) — record durable
			// suppression keys for those too, completing the sessionId from
			// the board card or the workbench roster, or the kind:'worker'
			// rehydration scan resurrects the worker on the next board open.
			const collectKeys = async (): Promise<string[]> => {
				if (payloadSessionId) {
					return [workerId, payloadSessionId];
				}
				const chat = routerId === this.sessionId ? this.captureView() : this.parked.get(routerId);
				const cardSessionId = chat?.items
					.find((row): row is Extract<ConversationItem, { kind: 'dispatch' }> => row?.kind === 'dispatch' && row.workerId === workerId)
					?.workerSessionId;
				if (cardSessionId) {
					return [workerId, cardSessionId];
				}
				try {
					const rows = await vscode.commands.executeCommand<{ sessionId?: string; workerId?: string }[]>('zcode.internal.superAgent.listWorkerChatSessions');
					const hit = Array.isArray(rows) ? rows.find(row => row?.workerId === workerId) : undefined;
					return [workerId, hit?.sessionId].filter((key): key is string => !!key);
				} catch {
					return [workerId];
				}
			};
			this.removeWorkerDispatches({ sessionId: routerId, workerId, workerSessionId: payloadSessionId || undefined });
			void collectKeys().then(keys => this.ideChat.addRemovedWorkers(routerId, keys, this.sessionListScope())).catch(() => undefined);
		});
		// History-menu delete terminal flow: dropping a closed worker from the
		// workbench history must also delete its chat session file — the
		// `kind: 'worker'` tag on that file is what rehydration scans, and a
		// leftover file resurrected the worker as an unclickable zombie card.
		vscode.commands.registerCommand('zcode.deleteChatSession', async (sessionId?: unknown) => {
			if (typeof sessionId !== 'string' || !sessionId) {
				return;
			}
			if (sessionId === this.routerSessionId) {
				return; // never delete the Router through this side channel
			}
			await this.deleteSession(sessionId).catch(() => undefined);
		});
		// Restore-from-history flow: re-run board rehydration immediately so the
		// restored worker's card comes back (and its ✕ suppression lifts)
		// without waiting for the next window reload.
		vscode.commands.registerCommand('zcode.reconcileWorkerBoard', (opts?: {
			// History-menu restore: lift the durable ✕ for these worker keys
			// BEFORE rehydrating — rehydration now honors suppression for live
			// rows too, so an unlifed key would keep the restored worker off
			// the board forever.
			lift?: { workerId?: string; workerSessionId?: string }[];
		}) => {
			const run = async (): Promise<void> => {
				const routerId = this.routerSessionId;
				if (!routerId) {
					return;
				}
				const keys = (opts?.lift ?? [])
					.flatMap(entry => [entry?.workerId, entry?.workerSessionId])
					.filter((key): key is string => typeof key === 'string' && !!key);
				if (keys.length) {
					await this.ideChat.clearRemovedWorkers(routerId, keys, this.sessionListScope()).catch(() => undefined);
				}
				await this.reconcileWorkerBoard(routerId);
			};
			void run();
		});
	}

	private async refreshCursorMeta(): Promise<void> {
		this.cursorAccountLabel = await getCursorBrainStatusLine();
		if (getActiveBrain() === 'cursor') {
			this.cursorModels = await listCursorModels().catch(() => []);
		}
		this.pushState();
	}

	// ===== 后台进程面板（Worker 拉起的后台 job / 常驻终端对用户可见） =====
	// shell 命令超时会转成后台 job（backgroundJobs），terminal_open 会建常驻
	// 终端（persistentTerminal）。这里把两者的实时状态推给 webview 右下角的
	// 「后台进程」面板，用户随时能看到 worker 起了哪些进程、跑得怎么样。

	private jobsFeedStarted = false;
	private lastJobsPayload = '';

	private startJobsFeed(): void {
		if (this.jobsFeedStarted) {
			return;
		}
		this.jobsFeedStarted = true;
		// 事件驱动的即时推送：job 创建/有新输出/结束。
		onJobEvent(() => this.pushJobsState(true));
		// 每秒对账一次：运行中的 job/终端时长在快照里变化才推送，
		// 序列化结果没变（空闲）时不会向 webview 发消息。
		setInterval(() => this.pushJobsState(), 1000);
		this.pushJobsState(true);
	}

	private buildJobsPayload(): { type: string; jobs: ReturnType<typeof getJobsSnapshot>; terminals: ReturnType<typeof getTerminalsSnapshot> } {
		return { type: 'jobsState', jobs: getJobsSnapshot(), terminals: getTerminalsSnapshot() };
	}

	private pushJobsState(force = false): void {
		const view = this.view;
		if (!view) {
			return;
		}
		const payload = this.buildJobsPayload();
		const serialized = JSON.stringify(payload);
		if (!force && serialized === this.lastJobsPayload) {
			return;
		}
		this.lastJobsPayload = serialized;
		void view.webview.postMessage(payload);
	}

	private async onJobsPanelMessage(message: unknown): Promise<void> {
		if (!message || typeof message !== 'object') {
			return;
		}
		const msg = message as { type?: unknown; id?: unknown; name?: unknown; tailLines?: unknown };
		switch (msg.type) {
			case 'jobsRequest':
				this.pushJobsState(true);
				break;
			case 'jobsKill': {
				killJobById(String(msg.id ?? ''));
				this.pushJobsState(true);
				break;
			}
			case 'jobsOutput': {
				const id = String(msg.id ?? '');
				const tail = Math.max(1, Math.min(Math.floor(Number(msg.tailLines) || 120), 1000));
				const result = readJobOutput(id, tail);
				void this.view?.webview.postMessage({ type: 'jobsOutput', id, found: result.found, text: result.text });
				break;
			}
			case 'jobsShowTerminal':
				showTerminalByName(String(msg.name ?? ''));
				break;
			default:
				break;
		}
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this.view = webviewView;
		this.applyWebviewOptions();
		webviewView.webview.html = this.renderHtml(webviewView.webview);
		webviewView.webview.onDidReceiveMessage(async (message) => {
			await this.onMessage(message);
		});
		// 后台进程面板的独立消息通道（jobsRequest/jobsKill/jobsOutput/jobsShowTerminal），
		// 与 onMessage 的主协议解耦，互不影响。
		webviewView.webview.onDidReceiveMessage((message) => {
			void this.onJobsPanelMessage(message);
		});
		this.startJobsFeed();
		webviewView.onDidDispose(() => {
			if (this.scheduleTipTimer) {
				clearInterval(this.scheduleTipTimer);
				this.scheduleTipTimer = undefined;
			}
			if (this.pushCoalesceTimer) {
				clearTimeout(this.pushCoalesceTimer);
				this.pushCoalesceTimer = undefined;
				this.pushCoalescePending = false;
			}
			if (this.draftUsageTimer) {
				clearTimeout(this.draftUsageTimer);
				this.draftUsageTimer = undefined;
			}
			for (const sessionId of [...this.routerTurnKeepalives.keys()]) {
				this.clearRouterTurnKeepalive(sessionId);
			}
			for (const sessionId of [...this.routerToolKeepalives.keys()]) {
				this.clearRouterToolKeepalive(sessionId);
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
		void this.bootstrapSession().finally(() => {
			this.resolveBootstrapDone?.();
			this.resolveBootstrapDone = undefined;
		});
		void this.refreshBilling();
	}

	async newChat(): Promise<void> {
		await this.startNewSession();
	}

	/**
	 * Ranks Router-session candidates: dispatch-card count wins — an empty
	 * shell (including a freshly minted one) must never outrank the Router
	 * that actually holds the dispatch history; latest activity breaks ties.
	 * Reads sessions defensively — unreadable candidates score 0.
	 */
	private async pickRouterCandidate(candidates: { id: string }[], preferredId?: string, workspaceRoot?: string): Promise<{ id: string } | undefined> {
		let best: { id: string; cards: number; score: number } | undefined;
		for (const candidate of candidates) {
			let updatedAt = 0;
			let cards = 0;
			let readable = false;
			try {
				const session = await this.ideChat.getSession(candidate.id) as { updatedAt?: number; createdAt?: number; timeline?: { kind?: string }[]; workspaceRoot?: string } | undefined;
				if (session) {
					// Defense in depth: never bind this window to a Router that
					// was created under a different folder — following the
					// editor's opened directory is the whole contract here.
					if (workspaceRoot && !sameWorkspaceRoot(session.workspaceRoot, workspaceRoot)) {
						continue;
					}
					readable = true;
					updatedAt = Number(session.updatedAt ?? session.createdAt ?? 0) || 0;
					cards = (session.timeline ?? []).filter(row => row?.kind === 'dispatch').length;
				}
			} catch {
				// Unreadable session — score 0.
			}
			if (!readable) {
				continue; // deleted or corrupt — never bind to it
			}
			// Preferred (previously bound) id wins exact ties so we stay
			// stable across activations instead of flip-flopping between
			// equally-empty shells.
			const score = updatedAt + (candidate.id === preferredId ? 1 : 0);
			if (!best || cards > best.cards || (cards === best.cards && score > best.score)) {
				best = { id: candidate.id, cards, score };
			}
		}
		return best ? { id: best.id } : undefined;
	}

	/**
	 * Ensures a dedicated "Router" chat session exists and is focused.
	 * The Workers rail docks above this session — its composer is the
	 * Super Agent dispatch box (messages spawn workers instead of answering).
	 */
	async ensureRouterSession(): Promise<string> {
		await this.open();
		// Webview resolve bootstraps a draft asynchronously; wait so it cannot
		// delete the empty Router session we are about to create/reuse.
		await Promise.race([
			this.bootstrapDone,
			new Promise<void>(resolve => setTimeout(resolve, 4000)),
		]);

		const reuse = async (id: string): Promise<string> => {
			this.routerSessionId = id;
			if (this.sessionId === id) {
				void this.reconcileWorkerBoard(id); // already displaying it — nothing to reopen
				return id;
			}
			await this.openSession(id);
			void this.reconcileWorkerBoard(id);
			return id;
		};

		// Router selection is STRICTLY scoped to the folder this window has
		// open. A Router and its workers belong to the workspace root they
		// were created under; adopting another folder's Router makes the next
		// save re-tag it, which is how windows used to "steal" each other's
		// worker boards. Candidates therefore come only from this root: the
		// cached id (verified against the store), this window's tabs and
		// session list (already root-scoped), and a root-scoped store query.
		// Rank by dispatch-card count so an empty Router shell never
		// outranks the Router that holds the dispatch history; mint a fresh
		// Router only when no same-root candidate is readable.
		const scope = this.sessionListScope();
		const seen = new Set<string>();
		const candidates: { id: string }[] = [];
		const push = (id: string | undefined) => {
			if (id && !seen.has(id)) {
				seen.add(id);
				candidates.push({ id });
			}
		};
		if (this.routerSessionId) {
			// A cached binding minted by an older (cross-root) run may point
			// at another folder's Router — verify before trusting it.
			const cached = await this.ideChat.getSession(this.routerSessionId).catch(() => undefined);
			if (cached && (!scope || sameWorkspaceRoot(cached.workspaceRoot, scope.workspaceRoot))) {
				push(this.routerSessionId);
			} else {
				this.routerSessionId = undefined;
			}
		}
		for (const candidate of [
			...this.buildTitleTabs().filter(t => t.title === 'Router'),
			...this.sessionList.filter(s => s.title === 'Router'),
		]) {
			push(candidate.id);
		}
		try {
			for (const meta of await this.ideChat.listSessions({ ...scope, limit: 500 })) {
				if (meta.title === 'Router') {
					push(meta.id);
				}
			}
		} catch {
			// Store unreadable — cached/tab candidates above still apply.
		}
		const titled = await this.pickRouterCandidate(candidates, this.routerSessionId, scope?.workspaceRoot);
		if (titled) {
			return reuse(titled.id);
		}

		// Park whatever is currently open, then create a persisted Router session.
		if (this.sessionId && (this.isRunning(this.sessionId) || !this.isSessionEmpty() || this.sessionPersisted)) {
			const leavingId = this.sessionId;
			const leavingChat = this.captureView();
			this.parkCurrent();
			if (!this.isSessionEmpty() || this.sessionPersisted) {
				// Background-save the leaving chat (openSession/closeTab pattern):
				// minting the Router must not wait on that disk flush.
				void this.persistChat(leavingId, leavingChat, false, { background: true })
					.catch(err => console.warn('[zcode-chat] persist leaving session failed:', err));
			}
		}
		const session = await this.ideChat.createSession({
			...this.draftSessionOptions(),
			title: 'Router',
			kind: 'router',
		});
		this.applySession(session.id, [], [], true);
		// Router+Worker mode: no session tab strip. Keep the Router as the
		// focused surface under the Workers rail without open-tab bookkeeping.
		this.routerSessionId = session.id;
		void this.refreshSessionList().then(() => this.pushState()).catch(() => undefined);
		this.pushAfterSessionSwitch({ focusInput: true });
		return session.id;
	}

	/**
	 * Spawns an isolated worker session (optionally starts its first turn in
	 * the background without stealing focus from the Router).
	 */
	async createWorkerSession(opts: { title?: string; message?: string }): Promise<string> {
		// Keep a provisional title only. The first completed turn replaces it
		// with a short AI summary — never stamp the full user task as the title.
		const title = opts.title?.trim() || '新对话';
		const session = await this.ideChat.createSession({
			...this.draftSessionOptions(),
			title,
			kind: 'worker',
		});
		this.workerSessionIds.add(session.id);
		this.parked.set(session.id, {
			items: [],
			todos: [],
			persisted: true,
			draftText: '',
			attachments: [],
			queue: [],
			queuePaused: false,
		});
		// Workers are reached via the Super Agent rail / presentation dock —
		// never as title-bar session tabs.
		await this.refreshSessionList();
		this.pushState();

		const message = opts.message?.trim();
		if (message) {
			void this.startTurn(session.id, message, { text: message });
		}
		return session.id;
	}

	/** Dispatch card ids this window has loaded or merged — protects cross-window saves. */
	private knownDispatchIds = new Set<string>();

	/**
	 * Is this chat session a Super Agent worker (not the Router, not a plain
	 * user chat)? Known by creation in this window, or by a bound dispatch
	 * card in the Router log (covers restored-after-reload workers).
	 */
	private isWorkerChatSession(sessionId: string | undefined): boolean {
		if (!sessionId || sessionId === this.routerSessionId) {
			return false;
		}
		if (this.workerSessionIds.has(sessionId)) {
			return true;
		}
		const routerId = this.routerSessionId;
		if (!routerId) {
			return false;
		}
		const chat = routerId === this.sessionId ? this.captureView() : this.parked.get(routerId);
		return (chat?.items ?? []).some(row => row.kind === 'dispatch' && row.workerSessionId === sessionId);
	}

	/**
	 * A queued follow-up just started its turn — flip its Router dispatch card
	 * from "queued" to "running" so the status and the elapsed timer only begin
	 * when the worker actually picks the task up (FIFO: oldest queued card).
	 */
	/** Throttled live-output preview for running workers (webview only, never persisted). */
	private readonly dispatchLiveTimers = new Map<string, { text: string; timer: NodeJS.Timeout | undefined }>();

	private pushDispatchLive(workerSessionId: string, text: string): void {
		if (!text) {
			return;
		}
		let entry = this.dispatchLiveTimers.get(workerSessionId);
		if (!entry) {
			entry = { text: '', timer: undefined };
			this.dispatchLiveTimers.set(workerSessionId, entry);
		}
		entry.text = text;
		if (entry.timer) {
			return;
		}
		// Trailing-edge throttle: at most ~1.4 updates/sec per worker, so a chatty
		// stream cannot flood the Router timeline.
		entry.timer = setTimeout(() => {
			const current = this.dispatchLiveTimers.get(workerSessionId);
			if (current) {
				current.timer = undefined;
			}
			const source = current?.text ?? '';
			if (!source) {
				return;
			}
			const tail = source.trim().split('\n').slice(-4).join('\n').slice(-400);
			void this.view?.webview.postMessage({ type: 'dispatchLive', sessionId: workerSessionId, text: tail });
		}, 700);
	}

	private clearDispatchLive(workerSessionId: string): void {
		const entry = this.dispatchLiveTimers.get(workerSessionId);
		if (entry?.timer) {
			clearTimeout(entry.timer);
		}
		this.dispatchLiveTimers.delete(workerSessionId);
		void this.view?.webview.postMessage({ type: 'dispatchLive', sessionId: workerSessionId, text: null });
	}
	private promoteQueuedDispatch(workerSessionId: string): void {
		const routerId = this.routerSessionId;
		if (!routerId || workerSessionId === routerId) {
			return;
		}
		let promoted = false;
		const applied = this.mutateChat(routerId, chat => {
			const card = chat.items.find(row =>
				row.kind === 'dispatch' && row.workerSessionId === workerSessionId && row.status === 'queued') as
				| { status?: DispatchStatus; receipt?: string; startedAt?: number }
				| undefined;
			if (!card) {
				return;
			}
			card.status = 'running';
			card.receipt = dispatchStatusLabel('running');
			card.startedAt = Date.now();
			promoted = true;
		});
		if (!applied || !promoted) {
			return;
		}
		if (this.sessionId === routerId) {
			this.startDispatchElapsedTimer();
			this.pushState();
		}
		void this.persistSessionById(routerId);
	}

	/**
	 * When the user follows up on a presented Worker, mirror that text onto the
	 * Router transcript as a dispatch receipt so handing off back to Router
	 * still shows "what I just sent". Called from handleSend at submit time —
	 * before queueing/turn start — so the card exists immediately even when
	 * the worker is busy and the message only runs after the current turn.
	 */
	private async mirrorWorkerFollowUpToRouter(text: string, workerSessionId: string, queued = false): Promise<void> {
		const routerId = this.routerSessionId;
		const trimmed = text.trim();
		if (!routerId || !trimmed || workerSessionId === routerId) {
			if (!routerId && trimmed) {
				console.warn('[zcode-chat] mirror follow-up skipped: routerSessionId not restored yet');
			}
			return;
		}
		if (this.sessionId !== routerId && !this.parked.has(routerId)) {
			const session = await this.ideChat.getSession(routerId);
			if (!session) {
				return;
			}
			this.parked.set(routerId, {
				items: [...(session.timeline ?? [])],
				todos: [...(session.todos ?? [])],
				persisted: true,
				draftText: '',
				attachments: [],
				queue: [],
				queuePaused: false,
			});
		}
		const dispatchItemId = newItemId('dispatch');
		const applied = this.mutateChat(routerId, chat => {
			chat.items.push({
				id: dispatchItemId,
				kind: 'dispatch',
				text: trimmed,
				workerSessionId,
				receipt: dispatchStatusLabel(queued ? 'queued' : 'running'),
				status: queued ? 'queued' : 'running',
				...(queued ? {} : { startedAt: Date.now() }),
			});
		});
		if (!applied) {
			return;
		}
		if (this.sessionId === routerId) {
			if (!queued) {
				this.startDispatchElapsedTimer();
			}
			this.pushState();
		}
		await this.persistSessionById(routerId);
		void vscode.commands.executeCommand('zcode.internal.superAgent.bindRouterDispatch', {
			sessionId: routerId,
			dispatchItemId,
			workerSessionId,
		});
	}

	/**
	 * Ground truth for the Worker board: while a worker turn is executing, the
	 * newest Router dispatch card for that worker must read "running". Covers
	 * submits that bypassed mirrorWorkerFollowUpToRouter (router binding not
	 * restored yet) and queued cards that were never promoted — creating the
	 * receipt card from the submitted text when the mirror missed entirely.
	 */
	private markRouterDispatchRunning(workerSessionId: string, text?: string): void {
		const routerId = this.routerSessionId;
		if (!routerId || workerSessionId === routerId) {
			return;
		}
		let changed = false;
		const applied = this.mutateChat(routerId, chat => {
			for (let i = chat.items.length - 1; i >= 0; i--) {
				const row = chat.items[i];
				if (row.kind !== 'dispatch' || row.workerSessionId !== workerSessionId) {
					continue;
				}
				if (row.status !== 'running') {
					row.status = 'running';
					row.receipt = dispatchStatusLabel('running');
					row.startedAt = row.startedAt ?? Date.now();
					changed = true;
				}
				return;
			}
			// Homepage submit writes the card first; patchRouterDispatch stamps
			// workerSessionId a tick later. The first turn used to miss that card
			// and push a second one with only the session id. Two turns make
			// 「查看全部历史」show immediately, and the extra card then picks up a
			// synthetic fw- id that presentWorker cannot open. Claim the unbound
			// card instead of minting that duplicate.
			for (let i = chat.items.length - 1; i >= 0; i--) {
				const row = chat.items[i];
				if (row.kind !== 'dispatch' || row.workerSessionId || isDispatchStatusTerminal(row.status)) {
					continue;
				}
				row.workerSessionId = workerSessionId;
				if (row.status !== 'running') {
					row.status = 'running';
					row.receipt = dispatchStatusLabel('running');
					row.startedAt = row.startedAt ?? Date.now();
				}
				changed = true;
				return;
			}
			if (text && text.trim()) {
				chat.items.push({
					id: newItemId('dispatch'),
					kind: 'dispatch',
					text: text.trim(),
					workerSessionId,
					receipt: dispatchStatusLabel('running'),
					status: 'running',
					startedAt: Date.now(),
				});
				changed = true;
			}
		});
		if (!applied || !changed) {
			return;
		}
		if (this.sessionId === routerId) {
			this.startDispatchElapsedTimer();
			this.pushState();
		}
		void this.persistSessionById(routerId);
	}

	/**
	 * Reconcile dispatch card statuses against live runs every time a chat
	 * (re)loads — returning to the home board, switching tabs, webview reload.
	 * A worker session still present in this.runs forces its card back to
	 * "running" (a stale parked snapshot must not wipe 进行中 on the way home),
	 * while cards claiming running/queued with no live run settle to "done".
	 */
	private syncDispatchRunState(chatId: string): void {
		if (!chatId) {
			return;
		}
		let changed = false;
		let anyRunning = false;
		const applied = this.mutateChat(chatId, chat => {
			for (const row of chat.items) {
				if (row.kind !== 'dispatch' || !row.workerSessionId) {
					continue;
				}
				const live = this.runs.has(row.workerSessionId);
				const st = row.status as string | undefined;
				if (live && (!st || st === 'queued' || st === 'pending' || st === 'starting')) {
					row.status = 'running';
					row.receipt = dispatchStatusLabel('running');
					row.startedAt = row.startedAt ?? Date.now();
					changed = true;
				} else if (!live && (st === 'running' || st === 'starting' || st === 'queued' || st === 'pending')) {
					row.status = 'done';
					row.receipt = dispatchStatusLabel('done');
					changed = true;
				}
				if (row.status === 'running') {
					anyRunning = true;
				}
			}
		});
		if (!applied || !changed) {
			return;
		}
		if (this.sessionId === chatId && anyRunning) {
			this.startDispatchElapsedTimer();
		}
		void this.persistSessionById(chatId);
	}

	/**
	 * Fills worker identity onto a Router dispatch card after the worker exists.
	 */
	async patchRouterDispatch(opts: {
		sessionId: string;
		dispatchItemId: string;
		workerId: string;
		workerSessionId?: string;
		badge?: string;
		accent?: string;
		status?: DispatchStatus;
	}): Promise<void> {
		const { sessionId, dispatchItemId, workerId, workerSessionId, badge, accent, status } = opts;
		if (!sessionId || !dispatchItemId || !workerId) {
			return;
		}
		this.mutateChat(sessionId, chat => {
			const item = chat.items.find(row => row.id === dispatchItemId && row.kind === 'dispatch');
			if (!item || item.kind !== 'dispatch') {
				return;
			}
			item.workerId = workerId;
			if (workerSessionId) {
				item.workerSessionId = workerSessionId;
			}
			if (badge) {
				item.badge = badge;
			}
			if (accent) {
				item.accent = accent;
			}
			if (status) {
				this.applyDispatchStatus(item, status);
			} else if (!item.status) {
				this.applyDispatchStatus(item, 'running');
			} else {
				if (!item.startedAt) {
					item.startedAt = Date.now();
				}
				item.receipt = item.receipt || dispatchStatusLabel(item.status);
			}
		});
		if (this.sessionId === sessionId) {
			this.startDispatchElapsedTimer();
			this.pushState();
		}
		// The homepage reload that follows dispatch reads this card back from
		// disk. Returning before the write lets that reload miss the worker.
		await this.persistSessionById(sessionId);
	}

	/**
	 * Updates the short title chip on every Router dispatch receipt for a worker
	 * (e.g. after AI title summarization).
	 */
	patchRouterDispatchLabel(opts: {
		sessionId: string;
		workerId: string;
		badge: string;
	}): void {
		const { sessionId, workerId, badge } = opts;
		const next = badge.trim();
		if (!sessionId || !workerId || !next) {
			return;
		}
		let changed = false;
		this.mutateChat(sessionId, chat => {
			for (const item of chat.items) {
				if (item.kind !== 'dispatch' || item.workerId !== workerId || item.badge === next) {
					continue;
				}
				item.badge = next;
				changed = true;
			}
		});
		if (!changed) {
			return;
		}
		if (this.sessionId === sessionId) {
			this.pushState();
		}
		void this.persistSessionById(sessionId);
	}

	/**
	 * Syncs live worker turn status onto a Router dispatch receipt.
	 * Prefer a specific dispatchItemId; otherwise update the latest card for workerId.
	 */
	patchRouterDispatchStatus(opts: {
		sessionId: string;
		status: DispatchStatus;
		workerId?: string;
		dispatchItemId?: string;
	}): void {
		const { sessionId, status, workerId, dispatchItemId } = opts;
		if (!sessionId || !status) {
			return;
		}
		if (!dispatchItemId && !workerId) {
			return;
		}
		let changed = false;
		this.mutateChat(sessionId, chat => {
			let item: ConversationItem | undefined;
			if (dispatchItemId) {
				item = chat.items.find(row => row.id === dispatchItemId && row.kind === 'dispatch');
			} else if (workerId) {
				for (let i = chat.items.length - 1; i >= 0; i--) {
					const row = chat.items[i];
					if (row.kind === 'dispatch' && row.workerId === workerId) {
						item = row;
						break;
					}
				}
			}
			if (!item || item.kind !== 'dispatch') {
				return;
			}
			// Historical cards stay frozen once a turn ends; only the active
			// (latest) card should flip back to running on a follow-up.
			const terminal = isDispatchStatusTerminal(item.status);
			const nextTerminal = isDispatchStatusTerminal(status);
			if (terminal && !nextTerminal && !dispatchItemId) {
				return;
			}
			if (item.status === status && item.receipt === dispatchStatusLabel(status)) {
				// Still stamp timing if a terminal card somehow missed durationMs.
				if (nextTerminal && item.durationMs === undefined && item.startedAt) {
					item.durationMs = Math.max(0, Date.now() - item.startedAt);
					changed = true;
				}
				return;
			}
			this.applyDispatchStatus(item, status);
			changed = true;
		});
		if (!changed) {
			return;
		}
		if (isDispatchStatusTerminal(status)) {
			// Once the turn ends, capture the worker's final reply onto the card.
			let targetId = dispatchItemId;
			if (!targetId && workerId) {
				for (let i = this.items.length - 1; i >= 0; i--) {
					const row = this.items[i];
					if (row.kind === 'dispatch' && row.workerId === workerId) {
						targetId = row.id;
						break;
					}
				}
			}
			if (targetId) {
				void this.refreshDispatchCardOutput(sessionId, targetId).then(mutated => {
					if (!mutated) {
						return;
					}
					if (this.sessionId === sessionId) {
						this.pushState();
					}
					void this.persistSessionById(sessionId);
				});
			}
		}
		if (this.sessionId === sessionId) {
			this.startDispatchElapsedTimer();
			this.pushState();
		}
		void this.persistSessionById(sessionId);
	}

	/**
	 * Removing a worker from the Workers rail also drops its dispatch bubbles
	 * from the Router transcript, so the main list doesn't pile up dead tasks.
	 * Matches by workerId OR workerSessionId OR cardId: cards rebuilt from bare
	 * kind:'worker' sessions carry no workerId, and legacy dirty cards can
	 * carry neither key — they used to be undeletable (immortal zombie cards
	 * on the home board).
	 */
	removeWorkerDispatches(opts: { sessionId: string; workerId?: string; workerSessionId?: string; cardId?: string }): void {
		const { sessionId, workerId, workerSessionId, cardId } = opts;
		if (!sessionId || (!workerId && !workerSessionId && !cardId)) {
			return;
		}
		let changed = false;
		this.mutateChat(sessionId, chat => {
			const next = chat.items.filter(row => !(row.kind === 'dispatch'
				&& ((!!workerId && row.workerId === workerId) || (!!workerSessionId && row.workerSessionId === workerSessionId) || (!!cardId && row.id === cardId))));
			if (next.length !== chat.items.length) {
				chat.items = next;
				changed = true;
			}
		});
		if (!changed) {
			return;
		}
		// The composer can't target a worker that no longer exists.
		if (workerId && this.dispatchTarget && this.dispatchTarget.workerId === workerId) {
			this.dispatchTarget = undefined;
		}
		if (this.sessionId === sessionId) {
			this.pushState();
		}
		void this.persistSessionById(sessionId);
	}

	/**
	 * Land a Router dispatch card in the in-memory chat (active tab or parked)
	 * and persist it — idempotent by card id.
	 *
	 * The phone bridge used to write its stamped card straight to the store:
	 * the open board renders the in-memory chat, so the stamp never showed and
	 * markRouterDispatchRunning minted a duplicate receipt card without a
	 * workerId. The webview only renders the ✕ remove button for groups that
	 * carry a workerId, so the phone-dispatched task could not be deleted from
	 * the desktop (again). Desktop dispatches are memory-first; phone stamps
	 * take the same path now, merging into an existing card of the same worker
	 * instead of adding a second turn.
	 */
	async upsertRouterDispatchCard(routerId: string, card: ConversationItem): Promise<void> {
		if (!routerId || !card || card.kind !== 'dispatch') {
			return;
		}
		if (this.sessionId !== routerId && !this.parked.has(routerId)) {
			const session = await this.ideChat.getSession(routerId);
			if (!session) {
				return;
			}
			this.parked.set(routerId, {
				items: [...(session.timeline ?? [])],
				todos: [...(session.todos ?? [])],
				persisted: true,
				draftText: '',
				attachments: [],
				queue: [],
				queuePaused: false,
			});
		}
		const workerSessionId = card.workerSessionId;
		const applied = this.mutateChat(routerId, chat => {
			const byId = chat.items.findIndex(row => row.id === card.id);
			if (byId >= 0) {
				chat.items[byId] = card;
				return;
			}
			if (workerSessionId) {
				for (let i = chat.items.length - 1; i >= 0; i--) {
					const row = chat.items[i];
					if (row.kind !== 'dispatch' || row.workerSessionId !== workerSessionId) {
						continue;
					}
					row.workerId = card.workerId;
					row.badge = row.badge || card.badge;
					row.accent = row.accent || card.accent;
					if (!row.status || row.status === 'pending' || row.status === 'starting') {
						row.status = card.status;
						row.receipt = card.receipt ?? row.receipt;
					}
					row.startedAt = row.startedAt ?? card.startedAt;
					return;
				}
			}
			chat.items.push(card);
		});
		if (!applied) {
			return;
		}
		if (this.sessionId === routerId) {
			this.startDispatchElapsedTimer();
			this.pushState();
		}
		await this.persistSessionById(routerId);
	}

	/**
	 * Self-heal: drop Router board cards whose worker session no longer exists.
	 * Deleting a session (history list) used to leave its dispatch receipt on
	 * the home board forever, pinned at the bottom by newest-activity ordering.
	 */
	private pruneOrphanWorkerDispatches(): void {
		const routerId = this.routerSessionId;
		if (!routerId) {
			return;
		}
		const chat = routerId === this.sessionId ? this.captureView() : this.parked.get(routerId);
		if (!chat) {
			return;
		}
		const alive = new Set<string>(this.sessionList.map(s => s.id));
		if (this.sessionId) {
			alive.add(this.sessionId);
		}
		for (const id of this.parked.keys()) {
			alive.add(id);
		}
		const orphanWorkers = new Set<string>();
		const orphanSessions = new Set<string>();
		for (const row of chat.items) {
			if (row.kind === 'dispatch' && row.workerSessionId && !alive.has(row.workerSessionId)) {
				// Cards without workerId (rebuilt from kind:'worker' sessions)
				// must prune by sessionId — they used to linger forever.
				if (row.workerId) {
					orphanWorkers.add(row.workerId);
				} else {
					orphanSessions.add(row.workerSessionId);
				}
			}
		}
		for (const workerId of orphanWorkers) {
			this.removeWorkerDispatches({ sessionId: routerId, workerId });
		}
		for (const workerSessionId of orphanSessions) {
			this.removeWorkerDispatches({ sessionId: routerId, workerSessionId });
		}
	}

	getActiveSessionId(): string | undefined {
		return this.sessionId;
	}

	/**
	 * Dispatch target for the webview: refreshed badge/accent from the newest
	 * router card so AI title updates reflect on the composer chip live.
	 */
	private buildDispatchTargetState(): { workerId: string; workerSessionId: string; badge?: string; accent?: string } | undefined {
		const target = this.dispatchTarget;
		const routerId = this.routerSessionId;
		if (!target || !routerId) {
			return undefined;
		}
		// Self-heal: drop the target once its worker session is gone (deleted).
		const alive = target.workerSessionId === this.sessionId
			|| this.parked.has(target.workerSessionId)
			|| this.sessionList.some(s => s.id === target.workerSessionId);
		if (!alive) {
			this.dispatchTarget = undefined;
			return undefined;
		}
		const chat = routerId === this.sessionId ? this.captureView() : this.parked.get(routerId);
		for (let i = (chat?.items.length ?? 0) - 1; i >= 0; i--) {
			const row = chat!.items[i];
			if (row.kind === 'dispatch' && row.workerSessionId === target.workerSessionId) {
				return {
					workerId: target.workerId,
					workerSessionId: target.workerSessionId,
					badge: row.badge || target.badge,
					accent: row.accent || target.accent,
				};
			}
		}
		return target;
	}

	/**
	 * Mirrors a worker turn's final reply and working-set files onto its Router
	 * dispatch receipt, so the Root page alone shows the full task outcome.
	 */
	private syncRouterDispatchResult(workerSessionId: string, opts?: { failed?: boolean; cancelled?: boolean }): void {
		this.clearDispatchLive(workerSessionId);
		const routerId = this.routerSessionId;
		if (!routerId || !workerSessionId || workerSessionId === routerId) {
			return;
		}
		const workerChat = workerSessionId === this.sessionId
			? this.captureView()
			: this.parked.get(workerSessionId);
		const lastReply = [...(workerChat?.items ?? [])]
			.reverse()
			.find(item => item.kind === 'assistant' && item.text.trim());
		const resultText = opts?.cancelled || opts?.failed
			? undefined
			: lastReply && lastReply.kind === 'assistant' ? lastReply.text.trim() : undefined;
		const files = this.fileEdits.listOwnedBy(workerSessionId).map(f => ({
			uri: f.uri,
			relativePath: f.relativePath,
			added: f.added,
			removed: f.removed,
		}));
		if (!resultText && !files.length) {
			return;
		}
		let changed = false;
		this.mutateChat(routerId, chat => {
			// Stamp the latest still-active card for this worker; fall back to the
			// latest card overall so a fast turn that already flipped terminal still
			// gets its result. (Reassigning on every match used to leave `target`
			// on the OLDEST card — results vanished into history.)
			let target: Extract<ConversationItem, { kind: 'dispatch' }> | undefined;
			let newest: Extract<ConversationItem, { kind: 'dispatch' }> | undefined;
			for (let i = chat.items.length - 1; i >= 0; i--) {
				const row = chat.items[i];
				if (row.kind !== 'dispatch' || row.workerSessionId !== workerSessionId) {
					continue;
				}
				newest ??= row;
				if (!isDispatchStatusTerminal(row.status)) {
					target = row;
					break;
				}
			}
			target ??= newest;
			if (!target) {
				return;
			}
			if (resultText && target.resultText !== resultText) {
				target.resultText = resultText;
				changed = true;
			}
			const nextJson = JSON.stringify(files);
			if (JSON.stringify(target.files ?? []) !== nextJson) {
				target.files = files;
				changed = true;
			}
		});
		if (!changed) {
			return;
		}
		if (this.sessionId === routerId) {
			this.pushState();
		}
		void this.persistSessionById(routerId);
	}

	/** Live-syncs working-set files onto still-active Router dispatch cards. */
	private syncRouterDispatchFiles(): void {
		const routerId = this.routerSessionId;
		if (!routerId) {
			return;
		}
		let changed = false;
		this.mutateChat(routerId, chat => {
			const byWorker = new Map<string, string>();
			for (const row of chat.items) {
				if (row.kind !== 'dispatch' || !row.workerSessionId || isDispatchStatusTerminal(row.status)) {
					continue;
				}
				byWorker.set(row.workerSessionId, row.id);
			}
			for (const workerSessionId of byWorker.keys()) {
				const files = this.fileEdits.listOwnedBy(workerSessionId).map(f => ({
					uri: f.uri,
					relativePath: f.relativePath,
					added: f.added,
					removed: f.removed,
				}));
				const item = chat.items.find(row => row.id === byWorker.get(workerSessionId));
				if (!item || item.kind !== 'dispatch') {
					continue;
				}
				if (JSON.stringify(item.files ?? []) !== JSON.stringify(files)) {
					item.files = files;
					changed = true;
				}
			}
		});
		if (changed && this.sessionId === routerId) {
			this.pushState();
		}
	}

	async openSessionFromTitle(sessionId: string): Promise<void> {
		await this.openSession(sessionId);
		// Worker recognition previously relied on the in-memory creation set or
		// on dispatch cards carrying workerSessionId. Both are lost for workers
		// restored after a restart (cards written before the field existed never
		// match), which silently disabled Router mirroring for their follow-ups.
		// The workbench router service owns the authoritative worker↔session map,
		// so ask it every time a session is surfaced.
		if (sessionId !== this.routerSessionId && !this.workerSessionIds.has(sessionId)) {
			void Promise.resolve(vscode.commands.executeCommand<boolean>('zcode.internal.superAgent.isWorkerChatSession', sessionId))
				.then(isWorker => {
					if (isWorker) {
						this.workerSessionIds.add(sessionId);
					}
				})
				.catch(() => undefined);
		}
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
		if (provider === 'deepseek') {
			await prepareDeepseekProvider();
		}
		const modelId = await ensureModelForProvider(provider);
		await ensureReasoningLevelForModel(provider, modelId);
		this.pushState();
	}

	/**
	 * Opens a file reference clicked in chat markdown (anchors injected by
	 * media/markdown.js). Relative paths resolve against the folder this
	 * window has open first — the chat follows the editor's workspace root —
	 * then fall back to a workspace-wide search. Jumps to the referenced
	 * line/range when the link carries one.
	 */
	private async openChatFileLink(rawPath: string, loc?: { line?: number; endLine?: number; col?: number }): Promise<void> {
		const ref = String(rawPath || '').trim();
		if (!ref) {
			return;
		}
		const candidates: vscode.Uri[] = [];
		const push = (p: string) => {
			if (!p) {
				return;
			}
			const uri = vscode.Uri.file(p);
			if (!candidates.some(c => c.fsPath === uri.fsPath)) {
				candidates.push(uri);
			}
		};
		if (ref.startsWith('~/') && process.env.HOME) {
			push(process.env.HOME + ref.slice(1));
		} else if (ref.startsWith('/')) {
			push(ref);
		} else {
			const roots: string[] = [];
			const scope = this.sessionListScope();
			if (scope?.workspaceRoot) {
				roots.push(scope.workspaceRoot);
			}
			for (const folder of vscode.workspace.workspaceFolders ?? []) {
				if (!roots.includes(folder.uri.fsPath)) {
					roots.push(folder.uri.fsPath);
				}
			}
			for (const root of roots) {
				push(vscode.Uri.joinPath(vscode.Uri.file(root), ref.replace(/^\.\//, '')).fsPath);
			}
		}
		let target: vscode.Uri | undefined;
		for (const uri of candidates) {
			try {
				await vscode.workspace.fs.stat(uri);
				target = uri;
				break;
			} catch {
				// not there — try the next candidate
			}
		}
		if (!target && !ref.startsWith('/') && !ref.startsWith('~/')) {
			try {
				const found = await vscode.workspace.findFiles('**/' + ref.replace(/^\.\//, ''), undefined, 1);
				if (found.length > 0) {
					target = found[0];
				}
			} catch {
				// glob-invalid reference — leave unlinked
			}
		}
		if (!target) {
			void vscode.window.showWarningMessage(`ZCode Chat：未找到文件 ${ref}`);
			return;
		}
		const line = Math.max(0, (loc?.line ?? 1) - 1);
		const endLine = loc?.endLine && loc.endLine > (loc.line ?? 1) ? loc.endLine - 1 : line;
		const col = Math.max(0, (loc?.col ?? 1) - 1);
		await vscode.window.showTextDocument(target, {
			selection: new vscode.Range(line, col, endLine, col),
			preview: true,
		});
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
			line?: number;
			endLine?: number;
			col?: number;
			answers?: AskUserAnswer[];
			reason?: string;
			planId?: string;
			query?: string;
			workerId?: string;
			target?: unknown;
			topic?: string;
			page?: number;
			photo?: unknown;
			url?: string;
			patch?: {
				enabled?: unknown;
				size?: unknown;
				slot?: unknown;
				slotId?: unknown;
				removeId?: unknown;
				appendId?: unknown;
			};
			voice?: unknown;
			setting?: string;
			effective?: number;
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
			this.scheduleDraftContextUsage();
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
		if (msg.type === 'setProvider' && isProviderMode(msg.provider)) {
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
			this.noteDesktopPetUserMessage(msg.text.trim());
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
		if (msg.type === 'querySlash') {
			const raw = typeof msg.query === 'string' ? msg.query : '';
			const query = raw.toLowerCase();
			const commands = [...QUICK_ADD_COMMANDS, ...CAPABILITY_COMMANDS]
				.filter(cmd => cmd.name.toLowerCase().startsWith(query))
				.map(cmd => ({ name: cmd.name, description: cmd.summary }));
			void this.view?.webview.postMessage({ type: 'slashMatches', query: raw, commands });
			return;
		}
		if (msg.type === 'queryMentions') {
			const raw = typeof msg.query === 'string' ? msg.query : '';
			const files = await this.searchMentionFiles(raw);
			void this.view?.webview.postMessage({ type: 'mentionMatches', query: raw, files });
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
		if (msg.type === 'openDispatch') {
			const workerId = typeof msg.workerId === 'string' ? msg.workerId : '';
			const workerSessionId = typeof (msg as { workerSessionId?: unknown }).workerSessionId === 'string'
				? (msg as { workerSessionId?: unknown }).workerSessionId as string
				: '';
			const present = (id: string) => {
				void vscode.commands.executeCommand('zcode.internal.superAgent.presentWorker', id);
			};
			// Synthetic fw- ids (phone identity backfill) are not router worker
			// ids. presentWorker no-ops on them, which is the homepage
			// 「查看全部历史」click doing nothing. A real id opens directly;
			// anything else is resolved from the live roster by session.
			if (workerId && !workerId.startsWith('fw-')) {
				present(workerId);
				return;
			}
			if (!workerSessionId) {
				if (workerId) {
					present(workerId);
				}
				return;
			}
			void Promise.resolve(vscode.commands.executeCommand<{ sessionId?: string; workerId?: string }[]>('zcode.internal.superAgent.listWorkerChatSessions'))
				.then(rows => {
					const hit = Array.isArray(rows) ? rows.find(row => row?.sessionId === workerSessionId) : undefined;
					if (hit?.workerId) {
						present(hit.workerId);
						return;
					}
					if (workerId) {
						present(workerId);
					}
				})
				.catch(() => {
					if (workerId) {
						present(workerId);
					}
				});
			return;
		}
		if (msg.type === 'removeWorkerCard') {
			// Homepage board "✕": the workbench archives the worker into its
			// history menu (restorable from there) and the card / dispatch
			// bubbles leave this board right away. Record the removal durably
			// (user-global store) so board rehydration — roster history rows or
			// kind:'worker' session tags — cannot resurrect the card on the
			// next window open in ANY editor sharing ~/.zcode.
			//
			// A card may carry only one of the two keys (older webviews omit
			// workerSessionId; cards rebuilt from bare kind:'worker' sessions
			// have no workerId) — accept either key, then complete the pair
			// from the live Router card BEFORE removal. Suppression must cover
			// both keys, or the kind:'worker' rehydration scan resurrects the
			// worker as an unclickable, unremovable zombie card.
			const workerId = typeof msg.workerId === 'string' ? msg.workerId : '';
			let workerSessionId = typeof (msg as { workerSessionId?: unknown }).workerSessionId === 'string'
				? (msg as { workerSessionId?: unknown }).workerSessionId as string
				: '';
			// Legacy dirty cards may carry NEITHER key — the webview then sends
			// the card id. `dispatch-rebuilt-<sessionId>` ids still encode the
			// session id, so recover it for durable suppression.
			const cardId = typeof (msg as { cardId?: unknown }).cardId === 'string'
				? (msg as { cardId?: unknown }).cardId as string
				: '';
			if (cardId.startsWith('dispatch-rebuilt-')) {
				workerSessionId = workerSessionId || cardId.slice('dispatch-rebuilt-'.length);
			}
			if (!workerId && !workerSessionId && !cardId) {
				return;
			}
			if (workerId) {
				void vscode.commands.executeCommand('zcode.internal.superAgent.forceRemoveWorker', { workerId });
			}
			const routerId = this.routerSessionId;
			if (!routerId) {
				return;
			}
			if (!workerId || !workerSessionId) {
				const chat = routerId === this.sessionId ? this.captureView() : this.parked.get(routerId);
				const card = chat?.items.find((row): row is Extract<ConversationItem, { kind: 'dispatch' }> =>
					row?.kind === 'dispatch'
					&& ((!!workerId && row.workerId === workerId) || (!!workerSessionId && row.workerSessionId === workerSessionId) || (!!cardId && row.id === cardId)));
				if (card) {
					workerSessionId = workerSessionId || card.workerSessionId || '';
				}
			}
			if (!workerId && workerSessionId) {
				// Legacy card without workerId: reverse-lookup the roster so the
				// workbench still archives the worker into its history menu.
				void Promise.resolve(vscode.commands.executeCommand<{ sessionId?: string; workerId?: string }[]>('zcode.internal.superAgent.listWorkerChatSessions'))
					.then(rows => {
						const hit = Array.isArray(rows) ? rows.find(row => row?.sessionId === workerSessionId) : undefined;
						if (hit?.workerId) {
							return vscode.commands.executeCommand('zcode.internal.superAgent.forceRemoveWorker', { workerId: hit.workerId });
						}
						return undefined;
					})
					.catch(() => undefined);
			}
			this.removeWorkerDispatches({ sessionId: routerId, workerId: workerId || undefined, workerSessionId: workerSessionId || undefined, cardId: cardId || undefined });
			const keys = [workerId, workerSessionId].filter((key): key is string => !!key);
			// Workspace-scoped: the Router binding can change between launches
			// (another Router outranks it, a second editor app binds its own) —
			// pinning the suppression to one router id let the card resurrect.
			void this.ideChat.addRemovedWorkers(routerId, keys, this.sessionListScope()).catch(() => undefined);
			return;
		}
		if (msg.type === 'viewPendingWorker') {
			// Chord pressed inside the webview (iframe keydown never reaches the
			// workbench keybinding service) — re-dispatch to the same command the
			// workbench ⌘]/Ctrl+] keybinding runs.
			void vscode.commands.executeCommand('workbench.action.chat.superAgent.viewPendingWorker');
			return;
		}
		if (msg.type === 'backToRouter') {
			// ⌘[ / Ctrl+[ inside the webview — leave the presented worker
			// timeline and return to the Router main page (same re-dispatch
			// pattern as viewPendingWorker above).
			void vscode.commands.executeCommand('workbench.action.chat.superAgent.backToRouter');
			return;
		}
		if (msg.type === 'setDispatchTarget') {
			const body = msg.target && typeof msg.target === 'object' ? msg.target as {
				workerId?: unknown; workerSessionId?: unknown; badge?: unknown; accent?: unknown;
			} : undefined;
			const workerId = typeof body?.workerId === 'string' ? body.workerId : '';
			const workerSessionId = typeof body?.workerSessionId === 'string' ? body.workerSessionId : '';
			if (!workerId || !workerSessionId) {
				this.dispatchTarget = undefined;
			} else {
				this.dispatchTarget = {
					workerId,
					workerSessionId,
					badge: typeof body?.badge === 'string' ? body.badge : undefined,
					accent: typeof body?.accent === 'string' ? body.accent : undefined,
				};
			}
			this.pushState();
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
		if (msg.type === 'openChatFileLink' && typeof msg.path === 'string') {
			await this.openChatFileLink(msg.path, {
				line: typeof msg.line === 'number' ? msg.line : undefined,
				endLine: typeof msg.endLine === 'number' ? msg.endLine : undefined,
				col: typeof msg.col === 'number' ? msg.col : undefined,
			});
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
		if (msg.type === 'setScene' && typeof msg.id === 'string') {
			await this.setChatScene(msg.id);
			return;
		}
		if (msg.type === 'pickSceneFile') {
			await this.pickChatSceneFile();
			return;
		}
		if (msg.type === 'removeSceneFile' && typeof msg.id === 'string') {
			await this.removeChatSceneFile(msg.id);
			return;
		}
		if (msg.type === 'removeSceneUnsplash' && typeof msg.id === 'string') {
			await this.removeUnsplashScene(msg.id);
			return;
		}
		if (msg.type === 'openDevTools') {
			await openWebviewDevTools();
			return;
		}
		if (msg.type === 'loadUnsplash') {
			const topic = typeof msg.topic === 'string' ? msg.topic : 'wallpapers';
			const page = typeof msg.page === 'number' ? msg.page : 1;
			await this.loadUnsplashBrowse(topic, page);
			return;
		}
		if (msg.type === 'setUnsplashKey') {
			await this.promptUnsplashAccessKey();
			return;
		}
		if (msg.type === 'useUnsplash') {
			await this.useUnsplashPhoto(msg.photo);
			return;
		}
		if (msg.type === 'openExternal' && typeof msg.url === 'string' && msg.url.startsWith('https://unsplash.com/')) {
			await this.openUnsplashLink(msg.url);
			return;
		}
		if (msg.type === 'boardColumnsState') {
			// Webview owns the board layout; relay its live columns state to
			// the workbench title-row toggle (zcode.internal.setBoardColumns).
			const setting = typeof msg.setting === 'string' && msg.setting ? msg.setting : 'auto';
			const effective = Math.max(0, Math.floor(Number(msg.effective) || 0));
			void Promise.resolve(vscode.commands.executeCommand('zcode.internal.setBoardColumns', { setting, effective })).catch(() => undefined);
			return;
		}
		if (msg.type === 'send' && typeof msg.text === 'string') {
			this.draftText = msg.text;
			const text = msg.text.trim();
			if (!text && this.attachments.length === 0) {
				return;
			}
			this.noteDesktopPetUserMessage(text);
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
		this.notifyRouterWorkerAwaiting(sessionId, prompt.title || 'ask user');
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
			if (result.outcome === 'answered') {
				// Ask done — worker is live again; clear AwaitingUser / any sticky stall.
				this.notifyRouterWorkerActivity(sessionId, 'ask resolved', { force: true });
				this.startRouterTurnKeepalive(sessionId);
			}
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
		// Queuing while a turn is still running means the user wants follow-ups
		// to auto-drain after it finishes — clear a stale pause from an earlier
		// stop/error so the banner does not claim "队列已暂停" mid-run.
		if (this.busy) {
			this.queuePaused = false;
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
		this.safePushState({ clearDraft: true });
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
		// Drained message = a queued Router dispatch card: flip it to "running"
		// now that the worker actually picked the task up. promoteQueuedDispatch
		// ignores the Router's own session id, so this covers both branches.
		this.promoteQueuedDispatch(sessionId);
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
		this.stopDispatchElapsedTimer();
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
	 * @returns false when the session is neither active nor parked.
	 */
	private mutateChat(sessionId: string, mutator: (chat: MutableChat) => void): boolean {
		if (sessionId === this.sessionId) {
			const chat = this.captureView();
			mutator(chat);
			this.adoptView(chat);
			return true;
		}
		const parked = this.parked.get(sessionId);
		if (!parked) {
			return false;
		}
		mutator(parked);
		this.parked.set(sessionId, parked);
		return true;
	}

	private async refreshBilling(): Promise<void> {
		const seq = ++this.billingSeq;
		const [offer, quota] = await Promise.all([fetchClaimOffer(), fetchAccountQuota()]);
		if (seq !== this.billingSeq) {
			return;
		}
		this.claimOffer = offer;
		this.accountQuota = quota;
		if (offer) {
			void this.notifyClaimOffer(offer);
		}
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

	private mentionCache?: { at: number; root: string; files: string[] };

	/** Workspace file matches for the `@`-mention picker, cached briefly so typing stays snappy. */
	private async searchMentionFiles(query: string): Promise<Array<{ path: string; detail: string }>> {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders?.length) {
			return [];
		}
		const root = folders[0].uri.toString();
		const now = Date.now();
		if (!this.mentionCache || this.mentionCache.root !== root || now - this.mentionCache.at > 3000) {
			const uris = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/dist/**,**/.hg/**,**/.svn/**}', 1000);
			this.mentionCache = {
				at: now,
				root,
				files: uris.map(uri => vscode.workspace.asRelativePath(uri, false)),
			};
		}
		const q = query.trim().toLowerCase();
		const scored: Array<{ path: string; score: number }> = [];
		for (const file of this.mentionCache.files) {
			const lower = file.toLowerCase();
			const base = lower.slice(lower.lastIndexOf('/') + 1);
			let score = -1;
			if (!q) {
				score = 2;
			} else if (base.startsWith(q)) {
				score = 0;
			} else if (lower.startsWith(q)) {
				score = 1;
			} else if (base.includes(q)) {
				score = 2;
			} else if (lower.includes(q)) {
				score = 3;
			} else {
				let from = 0;
				let ok = true;
				for (const ch of q) {
					const at = lower.indexOf(ch, from);
					if (at < 0) { ok = false; break; }
					from = at + 1;
				}
				if (ok) { score = 4; }
			}
			if (score >= 0) {
				scored.push({ path: file, score });
			}
		}
		scored.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path));
		return scored.slice(0, 20).map(entry => ({ path: entry.path, detail: '文件' }));
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

	/**
	 * Native prompt so a claimable plan is hard to miss: one notification per
	 * plan id, claiming directly from its button. The in-chat banner remains
	 * available for later, quieter claims.
	 */
	private async notifyClaimOffer(offer: ClaimOffer): Promise<void> {
		if (this.seenClaimNotices.has(offer.planId)) {
			return;
		}
		this.seenClaimNotices.add(offer.planId);
		await this.globalState.update(CLAIM_NOTICE_SEEN_KEY, [...this.seenClaimNotices].slice(-200));
		const pick = await vscode.window.showInformationMessage(
			`可领取免费额度：${offer.name}`,
			{ detail: offer.detail },
			'领取',
		);
		if (pick === '领取') {
			await this.claimCurrentPlan(offer.planId);
			if (this.claimError) {
				void vscode.window.showWarningMessage(`领取未成功：${this.claimError}`);
			}
		}
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
		if (this.busy && this.sessionId !== this.routerSessionId) {
			// Worker follow-up while its turn is still running: mirror onto the
			// Router log NOW. The queue only flushes after the current turn, by
			// which time the page may have handed off — mirroring at flush time
			// (as before) meant these messages never showed up in Router at all.
			if (this.isWorkerChatSession(this.sessionId)) {
				// Never let a mirroring failure swallow the send itself. The card
				// lands as "queued" — promoteQueuedDispatch flips it (and starts
				// the timer) only when the drained turn actually begins.
				await this.mirrorWorkerFollowUpToRouter(text, this.sessionId, true)
					.catch(err => console.warn('[zcode-chat] mirror follow-up failed:', err));
			}
			await this.enqueueMessage(text, pendingAttachments);
			return;
		}
		// Router dispatches (new worker or follow-up) never queue: a leaked run
		// entry on the Router session must not swallow the submit — the card is
		// created immediately below either way.
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

		// Router session: dispatch, don't answer. The workbench Super Agent
		// dispatcher listens on zcode.internal.superAgent.routerSubmit.
		if (this.sessionId === this.routerSessionId) {
			const sessionId = this.sessionId;
			const displayText = prepared.displayText;
			const target = this.dispatchTarget;
			if (target?.workerSessionId && target.workerSessionId !== sessionId) {
				// Follow-up to a selected worker: bound dispatch card + turn on the
				// worker session (queue it if that worker is still busy).
				const workerBusy = this.runs.has(target.workerSessionId);
				const dispatchItemId = newItemId('dispatch');
				this.mutateChat(sessionId, chat => {
					chat.items.push({
						id: dispatchItemId,
						kind: 'dispatch',
						text: displayText,
						workerId: target.workerId,
						workerSessionId: target.workerSessionId,
						badge: target.badge,
						accent: target.accent,
						receipt: dispatchStatusLabel(workerBusy ? 'queued' : 'running'),
						status: workerBusy ? 'queued' : 'running',
						...(workerBusy ? {} : { startedAt: Date.now() }),
					});
				});
				if (!workerBusy) {
					this.startDispatchElapsedTimer();
				}
				this.safePushState({ clearDraft: true });
				void this.persistSessionById(sessionId);
				// Bind the service to this card (same as mirrorWorkerFollowUpToRouter)
				// so a brand-new worker — which has no prior dispatch card to inherit
				// badge/accent from — still gets its identity chip, accent color and
				// status stamped onto the homepage card, keeping it visually
				// identical to cards of workers that already have content.
				void vscode.commands.executeCommand("zcode.internal.superAgent.bindRouterDispatch", {
					sessionId,
					dispatchItemId,
					workerSessionId: target.workerSessionId,
				});
				if (this.runs.has(target.workerSessionId)) {
					this.mutateChat(target.workerSessionId, chat => {
						chat.queuePaused = false;
						chat.queue.push({
							id: newItemId('queue'),
							text: displayText,
							attachments: [],
						});
					});
				} else {
					void this.startTurn(target.workerSessionId, content, { text: displayText, attachments });
				}
				return;
			}
			const dispatchItemId = newItemId('dispatch');
			this.mutateChat(sessionId, chat => {
				chat.items.push({
					id: dispatchItemId,
					kind: 'dispatch',
					text: displayText,
					receipt: dispatchStatusLabel('pending'),
					status: 'pending',
					startedAt: Date.now(),
				});
			});
			this.startDispatchElapsedTimer();
			this.safePushState({ clearDraft: true });
			// The card must be on disk before the workbench opens the homepage
			// again — that reload rebuilds the board from the session file, and
			// a memory-only card disappears until the worker's first turn ends.
			await this.persistSessionById(sessionId, { deferListRefresh: true }).catch(err => console.warn('[zcode-chat] persist dispatch card failed:', err));
			void vscode.commands.executeCommand('zcode.internal.superAgent.routerSubmit', {
				sessionId,
				text: prepared.modelText,
				dispatchItemId,
			});
			return;
		}

		// Direct send on a presented worker: mirror the message onto the Router
		// log before the turn starts, so the exchange card exists immediately.
		// (Queued sends mirror in the busy branch above; startTurn itself no
		// longer mirrors to avoid double cards on queue flushes.)
		if (this.isWorkerChatSession(this.sessionId)) {
			// Never let a mirroring failure swallow the send itself.
			await this.mirrorWorkerFollowUpToRouter(prepared.displayText, this.sessionId)
				.catch(err => console.warn('[zcode-chat] mirror follow-up failed:', err));
		}

		this.safePushState({ clearDraft: true });
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
		this.safePushState({ clearDraft: true });
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
		// Direct dispatches (router submit / idle worker) are unaffected; only
		// queued follow-ups have a matching "queued" card waiting to flip.
		this.promoteQueuedDispatch(runSessionId);
		if (!content.trim() || this.runs.has(runSessionId)) {
			return;
		}
		// Restart / another window: the target worker session can be neither the
		// active view nor parked (both are in-memory only). mutateChat below used
		// to silently drop the dispatched message then — the Router card showed
		// "running" but the worker's chat flow never received it. Seed a parked
		// view from the persisted store so the follow-up actually lands.
		if (runSessionId !== this.sessionId && !this.parked.has(runSessionId)) {
			const session = await this.ideChat.getSession(runSessionId).catch(() => undefined);
			if (!session) {
				return;
			}
			this.parked.set(runSessionId, {
				items: (session.timeline ?? []).map(item => ({ ...item })),
				todos: [...(session.todos ?? [])],
				persisted: true,
				draftText: '',
				attachments: [],
				queue: [],
				queuePaused: false,
			});
		}
		// Worker follow-ups: prior round's edits are already on disk (auto-applied).
		// Accept them out of the working set so File Changed / live dispatch files
		// reset for this task instead of growing forever. Completed cards keep
		// their stamped file snapshots.
		if (this.isWorkerChatSession(runSessionId)) {
			await this.fileEdits.acceptOwned(runSessionId);
		}
		const displayText = display?.text ?? content;
		const attachmentRefs = this.toAttachmentRefs(display?.attachments);
		let sentUserId = reuseUserId ?? '';

		this.mutateChat(runSessionId, chat => {
			// Starting work again re-arms auto-drain; a prior stop/error pause
			// must not stick across the new turn (and its queued follow-ups).
			chat.queuePaused = false;
			const reused = reuseUserId
				? chat.items.find(item => item.id === reuseUserId && item.kind === 'user')
				: undefined;
			const userId = reused ? reused.id : newItemId('user');
			sentUserId = userId;
			if (!reused) {
				chat.items.push({ id: userId, kind: 'user', text: displayText, attachments: attachmentRefs });
			}
			this.fileEdits.beginCheckpoint(userId, runSessionId);
			// New user turn: drop the previous Tasks panel so it does not stay
			// pinned across rounds. Prior chat history still carries context.
			chat.todos = [];
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
		// Fresh Tasks list each turn; agent rewrites via TodoWrite when needed.
		const initialTodos: TodoItem[] = [];
		const sessionAwareness = this.buildSessionAwareness(runSessionId);

		const cancel = new vscode.CancellationTokenSource();
		const run: SessionRun = { cancel };
		this.runs.set(runSessionId, run);
		// Follow-ups sent on a presented worker are mirrored to the Router log
		// by handleSend at submit time (covers queued sends too, which flush
		// after the page may have handed off). Background first turns from
		// createWorkerSession stay off this path — Router already has the
		// initial dispatch card from handleSend.
		this.notifyRouterWorkerActivity(runSessionId, 'turn started', { force: true });
		this.markRouterDispatchRunning(runSessionId, content);
		this.startRouterTurnKeepalive(runSessionId);
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
				chat.todos = result.todos ?? [];
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
			this.notifyRouterWorkerIdle(
				runSessionId,
				cancelled ? 'turn cancelled' : turnFailed ? 'turn failed' : 'turn finished',
			);
			// Same chime for a finished, failed, or cancelled agent turn.
			// Title side-calls never reach here. The "待查看" pill stays success-only.
			const doneTitle = this.sessionList.find(s => s.id === runSessionId)?.title;
			void this.view?.webview.postMessage({
				type: 'turnCompleted',
				sessionId: runSessionId,
				outcome: cancelled ? 'cancelled' : turnFailed ? 'failed' : 'completed',
				title: doneTitle && doneTitle !== '新对话' ? doneTitle : undefined,
			});
			if (!cancelled && !turnFailed) {
				this.maybeSummarizeTitle(runSessionId);
			}
			if (!cancelled) {
				this.unreadDoneIds.add(runSessionId);
			} else {
				this.unreadDoneIds.delete(runSessionId);
			}
			// Paint the terminal state (已停止 / 完成回复 / work 行) BEFORE the
			// disk flush: the full-timeline save + session-list rescan below used
			// to gate the last frame, so stopping a busy worker looked stuck.
			this.pushState();
			await this.persistSessionById(runSessionId);
			// Mirror the finished turn's reply + working set onto its Router
			// dispatch card before the state push so Root shows the outcome at once.
			this.syncRouterDispatchResult(runSessionId, { failed: turnFailed, cancelled });
			this.pushState();

			if (force) {
				this.mutateChat(runSessionId, chat => {
					chat.queuePaused = false;
				});
				void this.startTurn(runSessionId, force.content, { text: force.text, attachments: force.attachments });
			} else if (!cancelled && !turnFailed && this.sessionHasPendingQueue(runSessionId)) {
				void this.flushQueue(runSessionId);
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

	private async bootstrapSession(): Promise<void> {
		await this.ideChat.pruneEmptySessions();
		const active = await this.ideChat.getActiveSession(this.sessionListScope());
		if (active && active.messages.length > 0) {
			this.applySession(active.id, active.timeline ?? [], active.todos ?? [], true);
		} else if (active && active.title === 'Router') {
			// Keep the Super Agent Router even when still empty — bootstrap must
			// not replace it with a blank draft.
			this.applySession(active.id, active.timeline ?? [], active.todos ?? [], true);
			this.routerSessionId = active.id;
		} else {
			if (active) {
				await this.ideChat.deleteSession(active.id);
			}
			const draft = this.ideChat.createDraftSession(this.draftSessionOptions());
			this.applySession(draft.id, [], [], false);
		}
		await this.refreshSessionList();
		// Adopt a pre-existing Router even when it already has messages —
		// dispatch/mirror logic keys off routerSessionId and, before this,
		// nothing set it until the Router page happened to be presented.
		if (!this.routerSessionId) {
			const router = this.sessionList.find(s => s.title === 'Router');
			if (router) {
				this.routerSessionId = router.id;
			}
		}
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
		this.stopDispatchElapsedTimer();
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
		// Remember which dispatch cards this window has seen: a later save that
		// drops one of them is a deliberate removal, while disk-only cards this
		// window never loaded must survive the save (see preserveForeignDispatchCards).
		for (const item of items) {
			if (item?.kind === 'dispatch') {
				this.knownDispatchIds.add(item.id);
			}
		}
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
		// Board self-heal on every load: dispatch card statuses must match the
		// set of live runs, or a stale snapshot wipes "进行中" on the way home.
		this.syncDispatchRunState(id);
	}

	private async startNewSession(opts?: { force?: boolean }): Promise<void> {
		this.historyOpen = false;
		// Already on an empty draft — keep a single blank chat, don't spam history.
		if (!opts?.force && this.isSessionEmpty() && !this.sessionPersisted && !this.isRunning(this.sessionId)) {
			this.safePushState({ clearDraft: true });
			return;
		}
		if (this.sessionId && (this.isRunning(this.sessionId) || !this.isSessionEmpty() || this.sessionPersisted)) {
			const leavingId = this.sessionId;
			const leavingChat = this.captureView();
			this.parkCurrent();
			if (this.isSessionEmpty() && this.sessionPersisted && !this.isRunning(leavingId) && leavingId !== this.routerSessionId) {
				await this.ideChat.deleteSession(leavingId);
				this.parked.delete(leavingId);
			} else if (!this.isSessionEmpty()) {
				// Background-save the leaving chat (openSession/closeTab pattern)
				// so the blank draft appears immediately, not after a full
				// timeline write + session-list rescan.
				void this.persistChat(leavingId, leavingChat, false, { background: true })
					.catch(err => console.warn('[zcode-chat] persist leaving session failed:', err));
			}
		}
		const draft = this.ideChat.createDraftSession(this.draftSessionOptions());
		this.applySession(draft.id, [], [], false);
		if (this.sessionId && !this.openTabIds.includes(this.sessionId)) {
			this.openTabIds = [...this.openTabIds, this.sessionId];
		}
		void this.refreshSessionList().then(() => this.pushState()).catch(() => undefined);
		this.pushAfterSessionSwitch();
	}

	private async openSession(sessionId: string): Promise<void> {
		this.unreadDoneIds.delete(sessionId);
		if (sessionId === this.sessionId) {
			this.pushState();
			return;
		}
		if (this.sessionId) {
			// Snapshot the leaving chat BEFORE any id switch: persistSession()
			// reads this.sessionId at run time, so a deferred save must carry its
			// own snapshot or it would write the NEXT session's view.
			const leavingId = this.sessionId;
			const leavingChat = this.captureView();
			this.parkCurrent();
			if (!this.isSessionEmpty() || this.sessionPersisted) {
				// The leaving chat's save is a whole-timeline write plus a
				// session-list rescan. Awaiting it gated the view switch — that
				// disk round-trip is what made returning to the home board feel
				// frozen. closeTab already background-saves the same way.
				void this.persistChat(leavingId, leavingChat, false, { background: true })
					.catch(err => console.warn('[zcode-chat] persist leaving session failed:', err));
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
			this.syncDispatchRunState(sessionId);
			await this.ideChat.setActiveSession(sessionId).catch(() => undefined);
			// List refresh is a disk index rescan; painting the parked chat must
			// not wait for it. The refreshed list rides the next pushState.
			void this.refreshSessionList().then(() => this.pushState()).catch(() => undefined);
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
		void this.refreshSessionList().then(() => this.pushState()).catch(() => undefined);
		this.pushAfterSessionSwitch();
	}

	private async closeTab(sessionId: string): Promise<void> {
		if (this.runs.has(sessionId)) {
			this.stopRunning(sessionId);
			if (sessionId === this.sessionId) {
				this.stopElapsedTimer();
				this.stopDispatchElapsedTimer();
			}
			// Detach the run marker now — the async run loop's tail must not keep
			// the closed tab alive via refreshSessionList()/persistSessionById().
			this.runs.delete(sessionId);
		}
		const closingActive = this.sessionId === sessionId;
		const closingDraft = closingActive && !this.sessionPersisted && !this.runs.has(sessionId);
		if (sessionId === this.routerSessionId) {
			this.routerSessionId = undefined;
		}

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
		// Self-heal: drop Router board cards whose worker session was deleted.
		this.pruneOrphanWorkerDispatches();
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

	/**
	 * Cross-window wipe protection for the Router board. `chat` may be a stale
	 * snapshot: another window can have appended dispatch cards this one never
	 * loaded, and saving the snapshot wholesale would delete them (that lost
	 * update is how whole worker boards vanished). Disk cards that are absent
	 * here AND were never seen by this window are re-attached before the
	 * save; ids this window has seen but dropped stay dropped — that is a
	 * deliberate removal (worker removal filters its cards out).
	 */
	private async preserveForeignDispatchCards(sessionId: string, chat: MutableChat): Promise<void> {
		try {
			const disk = await this.ideChat.getSession(sessionId);
			if (!disk) {
				return;
			}
			// Durable board removals apply in both directions: cards this window
			// still holds in memory for a worker ✕'d off the board (possibly in
			// ANOTHER window) must not be written back, and foreign disk cards
			// for removed workers must not be re-attached either.
			const removedKeys = new Set(await this.ideChat.getRemovedWorkers(sessionId, { workspaceRoot: disk.workspaceRoot }));
			if (removedKeys.size) {
				chat.items = chat.items.filter(item => {
					if (item?.kind !== 'dispatch') {
						return true;
					}
					const dispatch = item as Extract<ConversationItem, { kind: 'dispatch' }>;
					return !(removedKeys.has(dispatch.workerSessionId ?? '') || (dispatch.workerId ? removedKeys.has(dispatch.workerId) : false));
				});
			}
			const incoming = new Set(
				chat.items
					.filter(item => item?.kind === 'dispatch')
					.map(item => (item as Extract<ConversationItem, { kind: 'dispatch' }>).id),
			);
			const foreign: ConversationItem[] = [];
			for (const item of disk.timeline ?? []) {
				if (item?.kind !== 'dispatch') {
					continue;
				}
				if (removedKeys.size) {
					const dispatch = item as Extract<ConversationItem, { kind: 'dispatch' }>;
					if (removedKeys.has(dispatch.workerSessionId ?? '') || (dispatch.workerId ? removedKeys.has(dispatch.workerId) : false)) {
						continue;
					}
				}
				if (!incoming.has(item.id) && !this.knownDispatchIds.has(item.id)) {
					foreign.push(item);
					this.knownDispatchIds.add(item.id);
				}
			}
			if (foreign.length) {
				chat.items.push(...foreign);
			}
		} catch {
			// Best effort — a failed check must not block the save.
		}
	}

	/**
	 * Rehydrates Router dispatch cards for workers whose cards are missing.
	 * Worker transcripts live in their own session files, but the Workers
	 * board renders the Router's dispatch cards — once those were wiped
	 * (stale cross-window saves emptied the Router timeline) every worker
	 * turned invisible even though its session was intact. Cards are rebuilt
	 * from durable sources: the workbench router roster (live workers plus
	 * history — covers workers created before sessions carried a kind tag)
	 * and `kind: 'worker'` session tags. Idempotent: workers already bound
	 * to a card are skipped, rebuilt cards use stable ids.
	 */
	private async reconcileWorkerBoard(routerId: string): Promise<void> {
		try {
			// Suppression is authoritative over the shared session file: another
			// window (older build, or one whose roster still holds the worker as
			// live) can re-write a ✕'d card into the timeline after the removal.
			// Prune those FIRST so `bound` below reflects the cleaned board.
			const pruned = await this.ideChat.pruneSuppressedDispatchCards(routerId);
			const router = await this.ideChat.getSession(routerId);
			if (!router) {
				return;
			}
			const bound = new Set(
				(router.timeline ?? [])
					.filter((row): row is Extract<ConversationItem, { kind: 'dispatch' }> => row?.kind === 'dispatch')
					.map(card => card.workerSessionId)
					.filter((id): id is string => !!id),
			);
			// Keys the user explicitly ✕'d off this board. Live roster workers
			// honor them too now — restores lift the key BEFORE rehydrating (see
			// the zcode.reconcileWorkerBoard lift arg), so a remaining key for a
			// live row means another window's roster never saw the ✕ and must
			// not resurrect the card into the shared Router session file.
			const removed = new Set(await this.ideChat.getRemovedWorkers(routerId, { workspaceRoot: router.workspaceRoot }));
			// A card this window just dispatched may not be on disk yet. Treat
			// it as bound so rehydration does not mint a second card for the
			// same live worker.
			const memoryItems = routerId === this.sessionId
				? this.items
				: (this.parked.get(routerId)?.items ?? []);
			for (const row of memoryItems) {
				if (row.kind !== 'dispatch' || !row.workerSessionId) {
					continue;
				}
				if (removed.has(row.workerSessionId) || (row.workerId ? removed.has(row.workerId) : false)) {
					continue;
				}
				bound.add(row.workerSessionId);
			}
			const liveWorkers = new Set<string>();
			const candidates = new Set<string>();
			const rosterInfo = new Map<string, { workerId?: string; label?: string }>();
			const add = (id: unknown, info?: { workerId?: string; label?: string }, live = false): void => {
				if (typeof id !== 'string' || !id || id === routerId || bound.has(id)) {
					return;
				}
				if (live) {
					liveWorkers.add(id);
				}
				if (removed.has(id) || (info?.workerId ? removed.has(info.workerId) : false)) {
					return; // ✕'d off this board and never restored — the history menu owns it
				}
				candidates.add(id);
				if (info?.workerId || info?.label) {
					rosterInfo.set(id, info);
				}
			};
			try {
				const roster = await vscode.commands.executeCommand<unknown>('zcode.internal.superAgent.listWorkerChatSessions');
				for (const row of Array.isArray(roster) ? roster : []) {
					if (typeof row === 'string') {
						add(row);
					} else if (row && typeof row === 'object' && typeof (row as { sessionId?: unknown }).sessionId === 'string') {
						const typed = row as { sessionId: string; workerId?: unknown; label?: unknown; live?: unknown };
						add(typed.sessionId, {
							workerId: typeof typed.workerId === 'string' ? typed.workerId : undefined,
							label: typeof typed.label === 'string' ? typed.label : undefined,
						}, typed.live === true);
					}
				}
			} catch {
				// Older workbench without the command — the kind-tag scan below still applies.
			}
			try {
				const metas = await this.ideChat.listSessions({ workspaceRoot: router.workspaceRoot, limit: 500 });
				for (const meta of metas) {
					if (meta.kind === 'worker') {
						add(meta.id);
					}
				}
			} catch {
				// Index unreadable — roster candidates still apply.
			}
			if (!candidates.size) {
				return;
			}
			const cards: Extract<ConversationItem, { kind: 'dispatch' }>[] = [];
			for (const workerId of candidates) {
				const session = await this.ideChat.getSession(workerId);
				if (!session) {
					continue; // deleted
				}
				// A live worker's transcript is written when the turn finishes.
				// Skipping empty sessions here is why a new dispatch stayed off
				// the homepage until that first task completed.
				const live = liveWorkers.has(workerId);
				if (!session.messages?.length && !live) {
					continue;
				}
				const info = rosterInfo.get(workerId);
				const title = info?.label?.trim() || session.title?.trim() || 'Worker';
				const firstUser = session.messages.find(m => m.role === 'user' && m.content.trim());
				const lastAssistant = [...session.messages].reverse().find(m => m.role === 'assistant' && m.content.trim());
				const inFlight = live && !session.messages?.length;
				// The submit path already pushed a pending card that patch binds
				// a moment later. Rebuilding here would leave two turns on one
				// worker (the pending card plus dispatch-rebuilt-*).
				if (inFlight && [...memoryItems, ...(router.timeline ?? [])].some(row =>
					row?.kind === 'dispatch'
					&& !row.workerSessionId
					&& !row.workerId
					&& (row.status === 'pending' || row.status === 'starting' || row.status === 'running'))) {
					continue;
				}
				const card: Extract<ConversationItem, { kind: 'dispatch' }> = {
					id: `dispatch-rebuilt-${workerId}`,
					kind: 'dispatch',
					text: ((firstUser?.content ?? title).replace(/\s+/g, ' ').trim()).slice(0, 200) || title,
					workerId: info?.workerId,
					workerSessionId: workerId,
					badge: title,
					status: inFlight ? 'running' : 'done',
					startedAt: session.createdAt,
					...(inFlight ? {} : { durationMs: Math.max(0, (session.updatedAt ?? session.createdAt) - session.createdAt) }),
				};
				const resultText = inFlight ? '' : lastAssistant?.content.trim();
				if (resultText) {
					card.resultText = resultText.length > 600 ? `…${resultText.slice(-600)}` : resultText;
				}
				cards.push(card);
			}
			if (!cards.length) {
				return;
			}
			cards.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
			await this.ideChat.upsertDispatchCards(routerId, cards);
			// A rebuilt card for a LIVE roster worker means the user restored it
			// from the history menu (restoreWorker → workerCreated): lift the
			// old ✕ removal so future rehydration keeps it on the board.
			const lifted = cards
				.filter(card => liveWorkers.has(card.workerSessionId ?? ''))
				.flatMap(card => [card.workerSessionId, card.workerId])
				.filter((key): key is string => !!key && removed.has(key));
			if (lifted.length) {
				await this.ideChat.clearRemovedWorkers(routerId, lifted, { workspaceRoot: router.workspaceRoot }).catch(() => undefined);
			}
			if (this.sessionId === routerId && (cards.length || pruned)) {
				// Re-apply from disk so the rebuilt (or just pruned) board is
				// visible immediately. Keep dispatch cards that exist only in
				// memory — a dispatch that has not finished saving must not
				// vanish when this reload replaces the timeline.
				const fresh = await this.ideChat.getSession(routerId);
				if (fresh) {
					const diskTimeline = fresh.timeline ?? [];
					const diskIds = new Set(diskTimeline.map(item => item.id));
					const kept = this.items.filter(item => {
						if (item.kind !== 'dispatch' || diskIds.has(item.id)) {
							return false;
						}
						return !(removed.has(item.workerSessionId ?? '') || (item.workerId ? removed.has(item.workerId) : false));
					});
					this.applySession(routerId, [...diskTimeline, ...kept], fresh.todos ?? [], true);
					this.pushState();
				}
			}
		} catch {
			// Rehydration is best-effort — it must never block opening the Router.
		}
	}

	private async persistSession(_immediate = true): Promise<void> {
		if (!this.sessionId) {
			return;
		}
		await this.persistChat(this.sessionId, this.captureView(), true);
	}

	private async persistSessionById(sessionId: string, opts?: { deferListRefresh?: boolean }): Promise<void> {
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
			deferListRefresh: opts?.deferListRefresh,
		});
	}

	private async persistChat(sessionId: string, chat: MutableChat, adoptPersistedFlag: boolean, opts?: { background?: boolean; titleOverride?: string; deferListRefresh?: boolean }): Promise<void> {
		if (sessionId === this.routerSessionId) {
			await this.preserveForeignDispatchCards(sessionId, chat);
		}
		const messages = IdeChatStore.messagesFromTimeline(chat.items);
		// Dispatch cards are not chat messages. A Router board that only holds
		// them used to take the empty-session return below, so a newly
		// dispatched worker never reached disk — the homepage only gained its
		// card later, when the first turn finished and rehydration rebuilt it.
		const hasDispatchCards = chat.items.some(item => item.kind === 'dispatch');
		if (messages.length === 0 && !hasDispatchCards) {
			// Never garbage-collect the Super Agent Router while it is still empty.
			if (chat.persisted && sessionId !== this.routerSessionId) {
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
		// A stored title that is not still provisional (first-message truncation /
		// placeholder) is an AI-generated or user-chosen label — keep it.
		const storedTitle = this.sessionList.find(s => s.id === sessionId)?.title;
		const fallbackTitle = titleFromMessages(messages);
		const keptTitle = storedTitle && !isProvisionalSessionTitle(storedTitle, messages) ? storedTitle : '';
		const title = opts?.titleOverride?.trim() || keptTitle || fallbackTitle;
		await this.ideChat.saveSession({
			id: sessionId,
			title,
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
		// The session-list rescan is metadata-only. The dispatch submit path
		// defers it so the card write — which must precede routerSubmit's
		// homepage reload — is the only disk round-trip gating the send.
		if (opts?.deferListRefresh) {
			void this.refreshSessionList().then(() => this.safePushState()).catch(() => undefined);
		} else {
			await this.refreshSessionList();
		}
	}

	/** In-flight AI title jobs, keyed by session id (prevents duplicate side calls). */
	private aiTitleJobs = new Map<string, Promise<void>>();

	/**
	 * After the first completed exchange, replace the truncated-first-message
	 * fallback title with a short AI summary of what the session is about.
	 * Idempotent: once a real title exists, later turns never re-summarize.
	 */
	private maybeSummarizeTitle(sessionId: string): void {
		if (this.aiTitleJobs.has(sessionId)) {
			return;
		}
		const chat = sessionId === this.sessionId ? this.captureView() : this.parked.get(sessionId);
		if (!chat) {
			return;
		}
		const messages = IdeChatStore.messagesFromTimeline(chat.items);
		const stored = this.sessionList.find(s => s.id === sessionId)?.title;
		if (!isProvisionalSessionTitle(stored, messages)) {
			return; // already carries a real (AI-generated / user-chosen) title
		}
		if (!messages.some(m => m.role === 'user') || !messages.some(m => m.role === 'assistant')) {
			return;
		}
		const job = this.generateTitle(sessionId).catch(() => undefined);
		this.aiTitleJobs.set(sessionId, job);
		void job.finally(() => this.aiTitleJobs.delete(sessionId));
	}

	private async generateTitle(sessionId: string): Promise<void> {
		const chat = sessionId === this.sessionId ? this.captureView() : this.parked.get(sessionId);
		if (!chat) {
			return;
		}
		const messages = IdeChatStore.messagesFromTimeline(chat.items)
			.filter(m => m.content.trim() && !m.content.startsWith('此前对话摘要：'))
			.slice(0, 4);
		if (!messages.some(m => m.role === 'user') || !messages.some(m => m.role === 'assistant')) {
			return;
		}
		const transcript = messages
			.map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content.replace(/\s+/g, ' ').slice(0, 400)}`)
			.join('\n');
		const brain = getActiveBrain();
		const provider = getProviderMode();
		const model = brain === 'cursor'
			? (getCursorModel() || undefined)
			: getSelectedModelId(provider);
		const cancel = new vscode.CancellationTokenSource();
		try {
			// Silent side call: no progress handler, no UI rows — title only.
			const result = await completeChatTurn({
				messages: [{
					role: 'user',
					content: [
						'根据下面的对话生成一个会话标题，要求：',
						'- 用一句完整的话概括核心任务，控制在 40 个字以内',
						'- 不要只写几个字，也不要截成半句话',
						'- 概括用户的核心诉求或任务主题',
						'- 不要引号、标点结尾、序号或前缀，直接输出标题本身',
						'',
						'对话：',
						transcript,
					].join('\n'),
				}],
				brain,
				provider,
				model,
				reasoningLevel: getSelectedReasoningLevel(provider, getSelectedModelId(provider)),
				workspaceRoot: workspaceRoot(),
				promptPreamble: buildPromptPreamble(workspaceRoot()),
			}, cancel.token);
			const raw = result.content.split('\n').map(l => l.trim()).filter(Boolean)[0] ?? '';
			const title = raw.replace(/^["'「」『』【】\s]+/, '').replace(/["'「」『』【】。.!！？?\s]+$/, '').slice(0, 80).trim();
			if (!title) {
				return;
			}
			// Re-validate at apply time: another title may have landed while we ran.
			const chatNow = sessionId === this.sessionId ? this.captureView() : this.parked.get(sessionId);
			if (!chatNow) {
				return;
			}
			const messagesNow = IdeChatStore.messagesFromTimeline(chatNow.items);
			const storedNow = this.sessionList.find(s => s.id === sessionId)?.title;
			if (!isProvisionalSessionTitle(storedNow, messagesNow)) {
				return;
			}
			await this.persistChat(sessionId, chatNow, sessionId === this.sessionId, { titleOverride: title });
			// Workers rail / page header read router worker.label — keep it in sync.
			if (sessionId !== this.routerSessionId) {
				void vscode.commands.executeCommand('zcode.internal.superAgent.renameWorker', {
					sessionId,
					label: title,
				});
			}
			this.pushState();
		} finally {
			cancel.dispose();
		}
	}

	private applyProgress(sessionId: string, event: AgentProgressEvent): void {
		if (event.type === 'usage') {
			if (event.totalTokens > 0) {
				this.reportedUsageTokens = event.totalTokens;
			}
			this.pushState();
			return;
		}
		if (event.type === 'file_change') {
			// Only refresh the visible working set when the active tab owns the edit.
			if (sessionId === this.sessionId) {
				this.refreshFileChanges();
				this.pushState();
			}
			return;
		}

		// Any real turn progress proves the worker is alive — clears sticky "疑似卡死".
		this.notifyRouterWorkerActivity(sessionId, event.type);
		if (event.type === 'tool_start') {
			this.noteRouterToolStart(sessionId);
		} else if (event.type === 'tool_end') {
			this.noteRouterToolEnd(sessionId);
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
				if (this.isWorkerChatSession(sessionId)) {
					this.pushDispatchLive(sessionId, next);
				}
				this.pinAssistantBeforeWorkOn(chat);
			}
		});
		// A full pushState per streaming segment used to saturate the
		// extension host (whole-timeline serialize + scene stat calls +
		// token estimation, dozens of times per second) — user actions
		// (send / stop / back to board) queued behind that work and felt
		// stuck. Hidden sessions already stream through dispatchLive and
		// the 1s board timer; visible ones coalesce streaming pushes.
		if (sessionId !== this.sessionId) {
			return;
		}
		if (event.type === 'assistant' || event.type === 'reasoning'
			|| event.type === 'status' || event.type === 'tool_update') {
			this.pushStateCoalesced();
		} else {
			this.pushState();
		}
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

	/**
	 * Applies live status onto a Router dispatch card and keeps per-task timing.
	 * Duration is task-scoped (this card), not worker lifetime.
	 */
	private applyDispatchStatus(
		item: Extract<ConversationItem, { kind: 'dispatch' }>,
		status: DispatchStatus,
	): void {
		const wasTerminal = isDispatchStatusTerminal(item.status);
		const nextTerminal = isDispatchStatusTerminal(status);
		if (wasTerminal && !nextTerminal) {
			item.startedAt = Date.now();
			item.durationMs = undefined;
		} else if (!item.startedAt) {
			item.startedAt = Date.now();
		}
		if (nextTerminal && item.durationMs === undefined && item.startedAt) {
			item.durationMs = Math.max(0, Date.now() - item.startedAt);
		}
		item.status = status;
		item.receipt = dispatchStatusLabel(status);
	}

	private hasActiveDispatchTiming(items: readonly ConversationItem[]): boolean {
		return items.some(item =>
			item.kind === 'dispatch'
			&& isDispatchStatusActive(item.status)
			&& item.durationMs === undefined
			&& !!item.startedAt);
	}

	private startDispatchElapsedTimer(): void {
		if (this.dispatchElapsedTimer) {
			return;
		}
		if (!this.hasActiveDispatchTiming(this.items)) {
			return;
		}
		this.dispatchElapsedTimer = setInterval(() => {
			if (!this.hasActiveDispatchTiming(this.items)) {
				this.stopDispatchElapsedTimer();
				return;
			}
			this.tickDispatchLiveOutputs();
			this.pushState();
		}, 1000);
	}

	private stopDispatchElapsedTimer(): void {
		if (this.dispatchElapsedTimer) {
			clearInterval(this.dispatchElapsedTimer);
			this.dispatchElapsedTimer = undefined;
		}
	}

	private dispatchLiveInFlight = false;
	private dispatchLivePersistAt = 0;

	/**
	 * Live-mirrors worker output onto active Router dispatch cards while the
	 * elapsed timer ticks (1s cadence, active session only). Streaming writes
	 * are throttled (persist at most every 5s); the final reply is captured by
	 * refreshDispatchCardOutput once the turn reaches a terminal status.
	 */
	private tickDispatchLiveOutputs(): void {
		if (this.dispatchLiveInFlight) {
			return;
		}
		const sessionId = this.sessionId;
		if (!sessionId) {
			return;
		}
		const cardIds = this.items
			.filter(item => item.kind === 'dispatch'
				&& !isDispatchStatusTerminal(item.status)
				&& !!item.workerSessionId)
			.map(item => (item as Extract<ConversationItem, { kind: 'dispatch' }>).id);
		if (!cardIds.length) {
			return;
		}
		this.dispatchLiveInFlight = true;
		void (async () => {
			try {
				let mutated = false;
				for (const id of cardIds) {
					mutated = await this.refreshDispatchCardOutput(sessionId, id) || mutated;
				}
				if (mutated) {
					const now = Date.now();
					if (now - this.dispatchLivePersistAt >= 5000) {
						this.dispatchLivePersistAt = now;
						void this.persistSessionById(sessionId);
					}
				}
			} finally {
				this.dispatchLiveInFlight = false;
			}
		})();
	}

	/**
	 * Copies the worker's latest assistant reply for this dispatch onto the
	 * Router card (resultText) so the main page streams worker output in place.
	 * Only assistant items after the dispatched task text are considered, so a
	 * running card never shows the previous turn's reply.
	 */
	private async refreshDispatchCardOutput(sessionId: string, dispatchItemId: string): Promise<boolean> {
		const card = this.items.find(
			(item): item is Extract<ConversationItem, { kind: 'dispatch' }> =>
				item.kind === 'dispatch' && item.id === dispatchItemId,
		);
		const workerSessionId = card?.workerSessionId;
		if (!card || !workerSessionId) {
			return false;
		}
		// Prefer the in-memory chat (active view or parked): it updates live,
		// segment by segment, while the persisted timeline only lands after the
		// turn settles — that lag is why intermediate output never reached the
		// main page before (only the final conclusion did).
		const liveChat = workerSessionId === this.sessionId
			? this.captureView()
			: this.parked.get(workerSessionId);
		let timeline: readonly ConversationItem[] = liveChat?.items ?? [];
		if (!timeline.length) {
			try {
				const session = await this.ideChat.getSession(workerSessionId);
				timeline = session?.timeline ?? [];
			} catch {
				return false;
			}
		}
		const norm = (value?: string) => (value ?? '').trim();
		let anchor = -1;
		if (norm(card.text)) {
			for (let i = timeline.length - 1; i >= 0; i--) {
				const row = timeline[i];
				if (row.kind === 'user' && norm(row.text) === norm(card.text)) {
					anchor = i;
					break;
				}
			}
		}
		let text = '';
		for (let i = timeline.length - 1, end = anchor >= 0 ? anchor + 1 : 0; i >= end; i--) {
			const row = timeline[i];
			if (row.kind === 'assistant' && norm(row.text)) {
				text = norm(row.text);
				break;
			}
		}
		if (!text) {
			return false;
		}
		if (text.length > 6000) {
			text = '…' + text.slice(-6000);
		}
		let mutated = false;
		this.mutateChat(sessionId, chat => {
			const row = chat.items.find(r => r.id === dispatchItemId && r.kind === 'dispatch');
			if (row && row.kind === 'dispatch' && row.resultText !== text) {
				row.resultText = text;
				mutated = true;
			}
		});
		return mutated;
	}

	private clearStatusOn(chat: MutableChat): void {
		if (!chat.activeStatusId) {
			return;
		}
		chat.items = chat.items.filter(i => i.id !== chat.activeStatusId);
		chat.activeStatusId = undefined;
	}

	private pushCoalesceTimer: ReturnType<typeof setTimeout> | undefined;
	private pushCoalescePending = false;
	private draftUsageTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * Coalesced pushState for streaming progress events (assistant/reasoning/
	 * status/tool_update — dozens per second while a turn streams). Each event
	 * used to run a full state build: whole-timeline serialize, scene stat
	 * calls, token estimation. That saturated the extension host and made
	 * other webview actions (send, stop, back to board) feel stuck behind it.
	 * Leading edge schedules, later events in the window only mark a trailing
	 * flush; the flush always reads current state, so nothing is lost.
	 */
	private pushStateCoalesced(intervalMs = 120): void {
		if (this.pushCoalesceTimer) {
			this.pushCoalescePending = true;
			return;
		}
		this.pushCoalesceTimer = setTimeout(() => {
			this.pushCoalesceTimer = undefined;
			const pending = this.pushCoalescePending;
			this.pushCoalescePending = false;
			this.safePushState();
			if (pending) {
				this.pushStateCoalesced(intervalMs);
			}
		}, intervalMs);
	}

	/** Draft typing recomputes token usage over the whole timeline — throttle it. */
	private scheduleDraftContextUsage(): void {
		if (this.draftUsageTimer) {
			return;
		}
		this.draftUsageTimer = setTimeout(() => {
			this.draftUsageTimer = undefined;
			this.pushContextUsage();
		}, 150);
	}

	/**
	 * pushState that can never take the whole update down with it: if building
	 * the full payload throws (model/auth/quota fields), post a minimal state
	 * anyway so the board — and any brand-new dispatch card — still renders.
	 */
	private safePushState(extra?: { clearDraft?: boolean; insertText?: string; openPlus?: boolean; focusInput?: boolean }): void {
		try {
			this.pushState(extra);
		} catch (err) {
			console.error('[zcode-chat] pushState failed, posting minimal state', err);
			try {
				void this.view?.webview.postMessage({
					type: 'state',
					sessionId: this.sessionId,
					isRouter: this.sessionId === this.routerSessionId,
					isWorker: this.isWorkerChatSession(this.sessionId),
					busy: this.busy,
					items: this.items,
				});
			} catch {
				// webview already disposed — nothing to update
			}
		}
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
			if (item.kind === 'dispatch') {
				let durationLabel: string | undefined;
				if (item.durationMs !== undefined) {
					durationLabel = formatWorkDuration(item.durationMs);
				} else if (item.startedAt && isDispatchStatusActive(item.status)) {
					durationLabel = formatWorkDuration(Date.now() - item.startedAt);
				}
				return {
					...item,
					durationLabel,
				};
			}
			return item;
		});
		if (this.hasActiveDispatchTiming(this.items)) {
			this.startDispatchElapsedTimer();
		} else {
			this.stopDispatchElapsedTimer();
		}

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
			// Session tabs retired under Router+Worker — Workers rail owns navigation.
			tabs: [],
			isRouter: !!this.routerSessionId && this.sessionId === this.routerSessionId,
			isWorker: this.isWorkerChatSession(this.sessionId),
			dispatchTarget: this.buildDispatchTargetState(),
			attachments: this.attachments.map(a => ({ id: a.id, name: a.name, title: a.detail ?? a.fsPath })),
			queue: this.queue.map(item => ({ id: item.id, text: item.text })),
			queuePaused: this.queuePaused,
			plusSections: buildPlusMenuSections({ emptyDraft: this.draftText.trim().length === 0 }),
			accountLabel,
			signedIn,
			busy: this.busy,
			// Legacy history drawer stays closed; closed workers live in Super Agent History.
			historyOpen: false,
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
			scene: this.view ? this.sceneStateFor(this.view.webview) : undefined,
		});
		this.shareActivityWithDesktopPet();
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

	private applyWebviewOptions(): void {
		const webview = this.view?.webview;
		if (!webview) {
			return;
		}
		const roots = [
			vscode.Uri.joinPath(this.extensionUri, 'media'),
			vscode.Uri.file(getAttachmentDir()),
			vscode.Uri.file(this.wallpaperDir),
			this.globalStorageUri,
		];
		const seen = new Set(roots.map(uri => uri.fsPath));
		for (const file of this.scenePersisted.files) {
			const dir = path.dirname(file.path);
			if (!dir || seen.has(dir) || !fs.existsSync(file.path)) {
				continue;
			}
			seen.add(dir);
			roots.push(vscode.Uri.file(dir));
		}
		webview.options = {
			enableScripts: true,
			localResourceRoots: roots,
		};
	}

	private async saveChatScene(): Promise<void> {
		this.sceneStateVersion++;
		await this.globalState.update(CHAT_SCENE_STATE_KEY, this.scenePersisted);
	}

	private async setChatScene(id: string): Promise<void> {
		if (!selectionIsKnown(this.scenePersisted, id)) {
			return;
		}
		if (id.startsWith('file:')) {
			const file = this.scenePersisted.files.find(item => item.id === id);
			if (!file || !fs.existsSync(file.path)) {
				return;
			}
		}
		this.scenePersisted = { ...this.scenePersisted, selectedId: id };
		await this.saveChatScene();
		this.pushState();
	}

	private async pickChatSceneFile(): Promise<void> {
		const picked = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			openLabel: '用作背景',
			title: '选择本地聊天背景',
			filters: {
				Images: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp'],
			},
		});
		const fsPath = picked?.[0]?.fsPath;
		if (!fsPath || !isSceneImagePath(fsPath)) {
			return;
		}
		this.scenePersisted = rememberSceneFile(this.scenePersisted, fsPath);
		await this.saveChatScene();
		this.applyWebviewOptions();
		this.pushState();
	}

	private async removeChatSceneFile(id: string): Promise<void> {
		if (!id.startsWith('file:')) {
			return;
		}
		const files = this.scenePersisted.files.filter(file => file.id !== id);
		const selectedId = this.scenePersisted.selectedId === id
			? DEFAULT_CHAT_SCENE_ID
			: this.scenePersisted.selectedId;
		this.scenePersisted = { selectedId, files, unsplash: this.scenePersisted.unsplash };
		await this.saveChatScene();
		this.applyWebviewOptions();
		this.pushState();
	}

	private unsplashAccessKey(): string {
		return this.unsplashKeyCandidates()[0] || '';
	}

	// Settings key first, then the local key file. A stale settings key no longer
	// blocks browsing: loadUnsplashBrowse falls back to the next candidate on 401.
	private unsplashKeyCandidates(): string[] {
		const keys: string[] = [];
		const fromSettings = (vscode.workspace.getConfiguration('zcode').get<string>('unsplashAccessKey') || '').trim();
		if (fromSettings) {
			keys.push(fromSettings);
		}
		// Local file so the key stays out of git.
		try {
			const fileKey = fs.readFileSync(path.join(this.extensionUri.fsPath, '.unsplash-access-key'), 'utf8').trim();
			if (fileKey && !keys.includes(fileKey)) {
				keys.push(fileKey);
			}
		} catch {
			// No key file; settings only.
		}
		if (this.unsplashWorkingKey) {
			return [this.unsplashWorkingKey, ...keys.filter(candidate => candidate !== this.unsplashWorkingKey)];
		}
		return keys;
	}

	private postUnsplash(body: {
		topic: string;
		page: number;
		append: boolean;
		hasMore: boolean;
		needsKey: boolean;
		error: string;
		topics: UnsplashTopic[];
		photos: PersistedChatScene['unsplash'];
	}): void {
		void this.view?.webview.postMessage({ type: 'unsplashBrowse', ...body });
	}

	private async loadUnsplashBrowse(topic: string, page: number): Promise<void> {
		const seq = ++this.unsplashLoadSeq;
		const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(topic) ? topic : 'wallpapers';
		const safePage = Math.max(1, Math.min(Math.floor(page) || 1, 40));
		const keyCandidates = this.unsplashKeyCandidates();
		if (!keyCandidates.length) {
			this.postUnsplash({
				topic: slug,
				page: 1,
				append: false,
				hasMore: false,
				needsKey: true,
				error: '',
				topics: [],
				photos: [],
			});
			return;
		}
		let result: Awaited<ReturnType<typeof fetchUnsplashBrowse>> | undefined;
		let failure: Error | undefined;
		for (const key of keyCandidates) {
			try {
				result = await fetchUnsplashBrowse(key, slug, safePage, this.unsplashTopics);
				this.unsplashWorkingKey = key;
				break;
			} catch (err) {
				failure = err instanceof Error && err.message ? err : new Error('拉不到 Unsplash 目录');
				if (!(failure instanceof UnsplashKeyRejectedError)) {
					break;
				}
				// 401: this key was rejected, try the next candidate (e.g. a stale settings key).
			}
		}
		if (seq !== this.unsplashLoadSeq) {
			return;
		}
		if (!result) {
			const message = failure?.message || '拉不到 Unsplash 目录';
			this.postUnsplash({
				topic: slug,
				page: safePage > 1 ? safePage - 1 : 1,
				append: safePage > 1,
				hasMore: safePage > 1,
				needsKey: false,
				error: message,
				topics: this.unsplashTopics || [],
				photos: [],
			});
			return;
		}
		if (result.topics.length) {
			this.unsplashTopics = result.topics;
		}
		this.postUnsplash({
			topic: result.topic,
			page: result.page,
			append: safePage > 1,
			hasMore: result.hasMore,
			needsKey: false,
			error: '',
			topics: result.topics,
			photos: result.photos,
		});
	}

	private async promptUnsplashAccessKey(): Promise<void> {
		const entered = await vscode.window.showInputBox({
			title: 'Unsplash Access Key',
			prompt: '在 unsplash.com/developers 创建应用，把 Access Key 贴到这里',
			placeHolder: 'Access Key',
			password: true,
			ignoreFocusOut: true,
		});
		const key = entered?.trim();
		if (!key) {
			return;
		}
		await vscode.workspace.getConfiguration('zcode').update('unsplashAccessKey', key, vscode.ConfigurationTarget.Global);
		this.unsplashTopics = null;
		this.unsplashWorkingKey = '';
		await this.loadUnsplashBrowse('wallpapers', 1);
	}

	private async useUnsplashPhoto(raw: unknown): Promise<void> {
		const pick = parseSavedUnsplash(raw);
		if (!pick) {
			return;
		}
		const before = this.scenePersisted.unsplash;
		this.scenePersisted = rememberUnsplashPick(this.scenePersisted, pick);
		this.pruneWallpaperCache(before, this.scenePersisted.unsplash);
		await this.saveChatScene();
		this.pushState();
		const key = this.unsplashAccessKey();
		if (key) {
			void trackUnsplashDownload(key, pick.id.slice('unsplash:'.length));
		}
		// Keep a local copy so the pick survives offline and loads instantly.
		void this.cacheUnsplashWallpaper(this.scenePersisted.unsplash[0] ?? pick);
	}

	/** Delete cached files of picks that fell out of the remembered list. */
	private pruneWallpaperCache(before: PersistedChatScene['unsplash'], after: PersistedChatScene['unsplash']): void {
		const kept = new Set(after.map(item => item.id));
		for (const old of before) {
			if (!kept.has(old.id) && old.localPath) {
				fs.unlink(old.localPath, () => undefined);
			}
		}
	}

	/** Download the full-resolution photo into global storage and pin it to the pick. */
	private async cacheUnsplashWallpaper(pick: SavedUnsplashScene | undefined): Promise<void> {
		if (!pick || this.wallpaperDownloads.has(pick.id)) {
			return;
		}
		if (pick.localPath && fs.existsSync(pick.localPath)) {
			return;
		}
		const photoId = pick.id.slice('unsplash:'.length);
		if (!/^[A-Za-z0-9_-]{1,80}$/.test(photoId)) {
			return;
		}
		this.wallpaperDownloads.add(pick.id);
		try {
			await fs.promises.mkdir(this.wallpaperDir, { recursive: true });
			const target = path.join(this.wallpaperDir, `${photoId}.jpg`);
			// The image CDN is separate from the rate-limited API.
			const response = await fetch(pick.image, { signal: AbortSignal.timeout(120000) });
			const type = response.headers.get('content-type') || '';
			if (!response.ok || !type.startsWith('image/')) {
				return;
			}
			const bytes = Buffer.from(await response.arrayBuffer());
			if (!bytes.length) {
				return;
			}
			await fs.promises.writeFile(target, bytes);
			const current = this.scenePersisted.unsplash.find(item => item.id === pick.id);
			if (!current) {
				fs.unlink(target, () => undefined);
				return;
			}
			this.scenePersisted = {
				...this.scenePersisted,
				unsplash: this.scenePersisted.unsplash.map(item => item.id === pick.id ? { ...item, localPath: target } : item),
			};
			await this.saveChatScene();
			this.applyWebviewOptions();
			this.pushState();
		} catch {
			// The hotlinked copy still works without a local cache.
		} finally {
			this.wallpaperDownloads.delete(pick.id);
		}
	}

	private async removeUnsplashScene(id: string): Promise<void> {
		const existing = this.scenePersisted.unsplash.find(item => item.id === id);
		if (!existing) {
			return;
		}
		const unsplash = this.scenePersisted.unsplash.filter(item => item.id !== id);
		const selectedId = this.scenePersisted.selectedId === id
			? DEFAULT_CHAT_SCENE_ID
			: this.scenePersisted.selectedId;
		this.scenePersisted = { ...this.scenePersisted, selectedId, unsplash };
		await this.saveChatScene();
		if (existing.localPath) {
			fs.unlink(existing.localPath, () => undefined);
		}
		this.pushState();
	}

	private async openUnsplashLink(value: string): Promise<void> {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			return;
		}
		if (url.protocol !== 'https:' || url.hostname !== 'unsplash.com') {
			return;
		}
		await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
	}

	private sceneStateVersion = 0;
	private sceneStateCache: { webview: vscode.Webview; version: number; value: object } | undefined;

	/**
	 * buildSceneState stats every scene file/URI on disk; running it inside
	 * every pushState (i.e. per streaming token) hammered statSync and froze
	 * the host thread. Cache per (webview, scene version) — every scene
	 * mutation bumps the version via saveChatScene, wallpaper backfill
	 * included, so picks still flip to their local cache promptly.
	 */
	private sceneStateFor(webview: vscode.Webview): object {
		if (this.sceneStateCache && this.sceneStateCache.webview === webview
			&& this.sceneStateCache.version === this.sceneStateVersion) {
			return this.sceneStateCache.value;
		}
		const value = this.buildSceneState(webview);
		this.sceneStateCache = { webview, version: this.sceneStateVersion, value };
		return value;
	}

	private buildSceneState(webview: vscode.Webview): {
		selectedId: string;
		image: string;
		position: string;
		choices: Array<{ id: string; label: string; group: 'local' | 'unsplash'; thumb: string }>;
		used: Array<{ id: string; label: string; author: string; authorUrl: string; thumb: string }>;
	} {
		const files = this.scenePersisted.files.filter(file => fs.existsSync(file.path));
		let selectedId = this.scenePersisted.selectedId;
		if (!selectionIsKnown({ ...this.scenePersisted, files }, selectedId)) {
			selectedId = DEFAULT_CHAT_SCENE_ID;
		}
		if (selectedId.startsWith('file:') && !files.some(file => file.id === selectedId)) {
			selectedId = DEFAULT_CHAT_SCENE_ID;
		}
		const choices: Array<{ id: string; label: string; group: 'local' | 'unsplash'; thumb: string }> = [];
		for (const scene of BUNDLED_CHAT_SCENES) {
			if (!scene.file) {
				continue;
			}
			const thumb = this.mediaUri(webview, 'media', scene.file).toString();
			choices.push({ id: scene.id, label: scene.label, group: 'local', thumb });
		}
		for (const file of files) {
			choices.push({
				id: file.id,
				label: file.name,
				group: 'local',
				thumb: webview.asWebviewUri(vscode.Uri.file(file.path)).toString(),
			});
		}
		for (const scene of UNSPLASH_CHAT_SCENES) {
			if (!scene.photo) {
				continue;
			}
			choices.push({
				id: scene.id,
				label: scene.label,
				group: 'unsplash',
				thumb: unsplashImageUrl(scene.photo, 640, 75),
			});
		}
		// "Recently used" row: picked photos stay one click away for switching back.
		const used: Array<{ id: string; label: string; author: string; authorUrl: string; thumb: string }> = [];
		for (const pick of this.scenePersisted.unsplash) {
			if (UNSPLASH_CHAT_SCENES.some(scene => scene.id === pick.id)) {
				continue; // Static catalog entry; already shown in the Unsplash grid.
			}
			const local = pick.localPath && fs.existsSync(pick.localPath)
				? webview.asWebviewUri(vscode.Uri.file(pick.localPath)).toString()
				: '';
			used.push({
				id: pick.id,
				label: pick.label,
				author: pick.author,
				authorUrl: pick.authorUrl,
				thumb: local || pick.thumb,
			});
		}
		// Backfill the active photo so the current background also works offline.
		const activePick = this.scenePersisted.unsplash.find(item => item.id === selectedId);
		if (activePick) {
			void this.cacheUnsplashWallpaper(activePick);
		}
		const resolved = this.resolveSceneImage(webview, selectedId, files);
		return {
			selectedId,
			image: resolved.image,
			position: resolved.position,
			choices,
			used,
		};
	}

	/** Shared model catalog for the standalone pet's settings page: paths and
	 *  previews are media-relative, so the pet's own file server can serve them. */

	/** Last user line and the assistant's last reply, short enough to sit in a mascot prompt. */
	private mascotChatGlimpse(): { user: string; assistant: string } {
		let user = '';
		let assistant = '';
		for (let i = this.items.length - 1; i >= 0 && (!user || !assistant); i--) {
			const item = this.items[i];
			if (!user && item.kind === 'user') {
				user = item.text;
			} else if (!assistant && item.kind === 'assistant' && !item.streaming) {
				assistant = item.text;
			}
		}
		return { user, assistant };
	}

	/** Tell the standalone desktop pet (mascot-desktop) what the user just sent. */
	private noteDesktopPetUserMessage(text: string): void {
		if (!text) { return; }
		emitMascotDesktopEvent({ type: 'user', text: text.slice(0, 2000), ts: Date.now() });
	}

	/** Fan run state out to the standalone desktop pet. Called from every
	 *  webview state push: busy edges become reactions plus a reply glimpse.
	 *  The pet's own look is configured in the pet app, never pushed from here.
	 *  Decorative — never breaks the push. */
	private shareActivityWithDesktopPet(): void {
		try {
			const busy = !!this.busy;
			if (this.desktopPetLastBusy !== undefined && this.desktopPetLastBusy !== busy) {
				emitMascotDesktopEvent({ type: 'react', kind: busy ? 'dispatch' : 'complete', ts: Date.now() });
				if (!busy) {
					const replyGlimpse = this.mascotChatGlimpse().assistant.replace(/\s+/g, ' ').trim().slice(0, 200);
		if (replyGlimpse) { emitMascotDesktopEvent({ type: 'reply', text: replyGlimpse, ts: Date.now() }); }
				}
			}
			this.desktopPetLastBusy = busy;
		} catch { /* decorative only */ }
	}

	/** One GLM-Flash mascot line for the standalone desktop pet bridge; never throws. */
	private async generateMascotLine(raw: Record<string, unknown>): Promise<{ line?: string; skipped: boolean; dropped?: boolean }> {
		let outcome: { line?: string; skipped: boolean; dropped?: boolean } = { skipped: true };
		try {
			outcome = await this.mascotVoice.speak({
				id: typeof raw.id === 'string' ? raw.id : '',
				label: typeof raw.label === 'string' ? raw.label : '',
				trigger: typeof raw.trigger === 'string' ? raw.trigger : '',
				zone: typeof raw.zone === 'string' ? raw.zone : '',
				gift: typeof raw.gift === 'string' ? raw.gift : '',
				glimpse: this.mascotChatGlimpse(),
				// The pet owns persona picks now; fall back to the character default.
				persona: typeof raw.persona === 'string' && isMascotPersonaId(raw.persona)
					? raw.persona
					: resolveMascotPersonaId(typeof raw.id === 'string' ? raw.id : ''),
			});
		} catch (error) {
			console.warn('[mascot] voice failed:', error instanceof Error ? error.message : error);
		}
		return outcome;
	}


	private resolveSceneImage(
		webview: vscode.Webview,
		selectedId: string,
		files: PersistedChatScene['files'],
	): { image: string; position: string } {
		if (selectedId === CHAT_SCENE_NONE) {
			return { image: '', position: 'center center' };
		}
		const pick = this.scenePersisted.unsplash.find(item => item.id === selectedId);
		if (pick?.localPath && fs.existsSync(pick.localPath)) {
			// Cached download loads instantly and survives offline.
			return {
				image: webview.asWebviewUri(vscode.Uri.file(pick.localPath)).toString(),
				position: 'center center',
			};
		}
		const catalog = findCatalogScene(selectedId);
		if (catalog?.file) {
			return {
				image: this.mediaUri(webview, 'media', catalog.file).toString(),
				position: catalog.position || 'center center',
			};
		}
		if (catalog?.photo) {
			return {
				image: unsplashImageUrl(catalog.photo),
				position: 'center center',
			};
		}
		if (pick) {
			return { image: pick.image, position: 'center center' };
		}
		const file = files.find(item => item.id === selectedId);
		if (file && fs.existsSync(file.path)) {
			return {
				image: webview.asWebviewUri(vscode.Uri.file(file.path)).toString(),
				position: 'center center',
			};
		}
		return {
			image: this.mediaUri(webview, 'media', 'pastoral-scene.jpg').toString(),
			position: 'center 38%',
		};
	}

	private escapeAttr(value: string): string {
		return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
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
		const resolvedScene = this.resolveSceneImage(
			webview,
			this.scenePersisted.selectedId,
			this.scenePersisted.files.filter(file => fs.existsSync(file.path)),
		);
		const sceneUri = this.escapeAttr(resolvedScene.image || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
		const highlightStyleUri = this.mediaUri(webview, 'media', 'highlight-vscode.css');
		const markdownItUri = this.mediaUri(webview, 'media', 'markdown-it.min.js');
		const highlightUri = this.mediaUri(webview, 'media', 'highlight.min.js');
		const markdownUri = this.mediaUri(webview, 'media', 'markdown.js');
		const scriptUri = this.mediaUri(webview, 'media', 'chatView.js');
		// Must load BEFORE chatView.js — it acquires the shared webview API and
		// re-exposes it, so chatView.js's own acquire keeps working (see note in
		// the file). Forwards ⌘]/⌘[ keydowns to the host while composer-focused.
		const superAgentKeysUri = this.mediaUri(webview, 'media', 'superAgentKeys.js');
		const csp = [
			`default-src 'none'`,
			// Markdown renderer (syntax token colors) emits inline style attrs;
			// same allowance as VS Code's built-in markdown preview.
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`connect-src ${webview.cspSource}`,
			`script-src ${webview.cspSource} 'wasm-unsafe-eval'`,
			`img-src ${webview.cspSource} data: https://images.unsplash.com`,
			// 桌面精灵语音朗读：合成结果以 data:/blob: 音频在 webview 里播放。
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
	<div class="page-scene" aria-hidden="true">
		<img class="scene-art" alt="" src="${sceneUri}" />
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
				<button type="button" class="monaco-text-button secondary icon" id="viewAllBtn" title="View All Edits" aria-label="View All Edits">⧉</button>
			</div>
		</div>
		<ul class="chat-summary-list" id="workingSetList"></ul>
	</div>
	<div class="dispatch-target" id="dispatchTarget" hidden>
		<span class="dispatch-target-label">发给</span>
		<span class="dispatch-target-badge" id="dispatchTargetBadge"></span>
		<button type="button" class="dispatch-target-clear" id="dispatchTargetClear" title="取消绑定，回到派发新任务">×</button>
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
		<div class="menu scene-menu" id="sceneMenu" role="listbox" aria-label="聊天背景"></div>
		<div class="menu" id="plusMenu" role="menu"></div>
		<div class="menu" id="pickerMenu" role="listbox"></div>
		<textarea id="input" rows="2" placeholder="Plan, @ for context, / for commands, $ for skills"></textarea>
		<div class="chat-input-toolbars" id="composerToolbar">
			<div class="toolbar-left">
				<button class="icon-btn" id="plus" type="button" title="Add" aria-label="Add">+</button>
				<button class="pill" id="sceneBtn" type="button" title="选择聊天背景" aria-label="聊天背景" aria-expanded="false" aria-haspopup="listbox"><span class="label">背景</span></button>
				<button class="pill" id="brainBtn" type="button" title="ZCode / Cursor" aria-label="ZCode / Cursor" aria-expanded="false" aria-haspopup="listbox"><span class="label" id="brainLabel">ZCode</span><span class="chev">▾</span></button>
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
	<div class="schedule-tip" id="scheduleTip" hidden role="status"></div>
	<script src="${markdownItUri}"></script>
	<script src="${highlightUri}"></script>
	<script src="${markdownUri}"></script>
	<script src="${superAgentKeysUri}"></script>
	<script src="${scriptUri}"></script>
</body>
</html>`;
	}
}

/** Opens webview devtools; the built-in command id differs across builds. */
async function openWebviewDevTools(): Promise<void> {
	const candidates = ['webview.openDeveloperTools', 'workbench.action.webview.openDeveloperTools'];
	for (const command of candidates) {
		try {
			await vscode.commands.executeCommand(command);
			return;
		} catch {
			// Try the next command id.
		}
	}
}

export function registerChatPanel(
	context: vscode.ExtensionContext,
	ideChat: IdeChatStore,
	fileEdits: FileEditSession = getFileEditSession(),
): ZCodeChatViewProvider {
	const provider = new ZCodeChatViewProvider(context.extensionUri, ideChat, fileEdits, context.globalState, context.globalStorageUri);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ZCodeChatViewProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zcode.openChatDevTools', () => openWebviewDevTools()),
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
