/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Feishu bot bridge — drive Super-Agent workers from a phone.
 *
 * Transport: 官方 @larksuiteoapi/node-sdk 的 WSClient 长连接。飞书网关协议
 * (POST /callback/ws/endpoint 换一次性 URL → wss://msg-frontier.feishu.cn +
 * protobuf 帧、分片重组、ACK、心跳) 已多次轮换，手写实现会在协议再次变更时
 * 静默失效，因此传输层整体交给 SDK：它自带 pong 看门狗与无限自动重连。
 * 出站回复仍走 REST（缓存的 tenant_access_token，401 自动刷新）。
 *
 * Single-chat mode: everything — dispatch, follow-ups, results, questions —
 * happens in the bot's 1:1 chat with the user. An earlier revision gave every
 * worker its own Feishu group; the churn of creating/dissolving groups on each
 * dispatch and removal made the phone noisy, so that was rolled back. Nothing
 * creates groups anymore; the old map file survives read-only for the one-off
 * 「清理专属群」 command, and a message landing in a leftover group gets a
 * "group retired, use our 1:1 chat" bounce.
 *
 * Phone commands (single chat with the bot):
 *   帮助 | help
 *   列表 | ls            — current worker sessions (most recent first)
 *   选 N | use N         — bind follow-up messages to worker #N of the last 列表
 *   当前 | binding       — what the next free text will hit
 *   取消 | cancel        — unbind; free text then spawns a NEW worker
 *   新 <任务> | new <任务> — spawn a fresh worker
 *   状态 | status        — bridge connection + in-flight turns
 *   清理专属群           — dissolve leftover groups from the group era
 *   <任意文本>           — follow-up to the bound worker, else spawns a new one
 *
 * Every ack names the worker it hit (title + short tag), and every result
 * card restates the binding, so the phone always knows which task it is on
 * without switching chats.
 *
 * Completion detection polls IdeChatStore (no event hook needed). The turn's
 * own timeline is the ground truth: `work` flips running→false in startTurn's
 * finally, `status{tone:error}` marks failures, `question{status:pending}`
 * means the agent is blocked waiting for a desktop answer (the phone gets a
 * notice), and 15 idle minutes surface instead of black-holing. The final
 * assistant message is then pushed to the phone — intermediate streaming
 * never leaves the desktop.
 *
 * Multi-window guard: a heartbeat lock file in ~/.zcode ensures only one
 * window runs the bridge (long-connection events are delivered to every
 * connection — a second bridge would double-reply). DEV and the installed
 * app share that one lock, because they share one Feishu app. Their chat
 * histories are separate, so the phone only sees and only drives the runtime
 * that currently holds the lock.
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import type { IdeChatStore } from './ideChatStore';
import type { ConversationItem } from './conversation';
import { zcodeRuntimeEnv, zcodeRuntimeLabel, type ZcodeRuntimeEnv } from './runtimeEnv';

// ---------------------------------------------------------------- config & secrets

export const FEISHU_SECRET_KEY = 'zcode.feishu.appSecret';

let secretStore: vscode.SecretStorage | undefined;

export function bindFeishuSecrets(store: vscode.SecretStorage): void {
	secretStore = store;
}

async function readAppSecret(): Promise<string | undefined> {
	try {
		return await secretStore?.get(FEISHU_SECRET_KEY);
	} catch {
		return undefined;
	}
}

interface FeishuConfig {
	enabled: boolean;
	appId: string;
	allowOpenIds: string[];
}

function readConfig(): FeishuConfig {
	const config = vscode.workspace.getConfiguration('zcode');
	return {
		enabled: config.get<boolean>('feishu.enabled', false),
		appId: (config.get<string>('feishu.appId', '') || '').trim(),
		allowOpenIds: config.get<string[]>('feishu.allowOpenIds', []) ?? [],
	};
}

// ---------------------------------------------------------------- panel adapter

/**
 * Minimal surface of ChatPanel the bridge drives. `startTurn` /
 * `mirrorWorkerFollowUpToRouter` / `runs` are class-private in chatPanel.ts —
 * TypeScript private is compile-time only, and FeishuPanelAdapter is applied
 * via an `unknown` assertion in ensureFeishuBridge (the classes themselves
 * are not structurally assignable across the private boundary), so refactors
 * in chatPanel.ts only need this shape kept in sync.
 */
export interface FeishuPanelAdapter {
	createWorkerSession(opts: { title?: string; message?: string }): Promise<string>;
	startTurn?(sessionId: string, content: string, display?: { text?: string }): Promise<void>;
	mirrorWorkerFollowUpToRouter?(text: string, sessionId: string, queued?: boolean): Promise<void>;
	ensureRouterSession?(): Promise<string>;
	runs?: Map<string, unknown>;
	/** Resolves a pending askUser prompt — same call the webview's option buttons make. */
	resolveAsk?(id: string, result: FeishuAskResult): void;
	/**
	 * Lands a Router dispatch card in the panel's in-memory chat and persists
	 * it (idempotent by card id; merges into an existing card of the same
	 * worker). Store-only stamps never reach an open board.
	 */
	upsertRouterDispatchCard?(routerId: string, card: ConversationItem): Promise<void>;
}

// ---------------------------------------------------------------- tiny utils

/** Where an outbound message goes: the 1:1 console chat or a worker group. */
interface PushTarget {
	receiveIdType: 'open_id' | 'chat_id';
	receiveId: string;
}

namespace PushTarget {
	export function p2p(openId: string): PushTarget {
		return { receiveIdType: 'open_id', receiveId: openId };
	}
	export function group(chatId: string): PushTarget {
		return { receiveIdType: 'chat_id', receiveId: chatId };
	}
	export function query(target: PushTarget): string {
		return `?receive_id_type=${target.receiveIdType}`;
	}
}

/** A callback button on an interactive card. `value` round-trips through the
 *  card.action.trigger event when the user taps it on the phone. */
interface FeishuCardButton {
	text: string;
	value: Record<string, unknown>;
	type?: 'primary' | 'default' | 'danger';
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function hashStr(text: string): string {
	let hash = 5381;
	for (let i = 0; i < text.length; i++) {
		hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}

function relTime(ts: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
	if (seconds < 60) {
		return '刚刚';
	}
	if (seconds < 3600) {
		return `${Math.floor(seconds / 60)}分钟前`;
	}
	if (seconds < 86400) {
		return `${Math.floor(seconds / 3600)}小时前`;
	}
	return `${Math.floor(seconds / 86400)}天前`;
}

function chunkText(text: string, size: number): string[] {
	if (text.length <= size) {
		return [text];
	}
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > size) {
		let cut = rest.lastIndexOf('\n', size);
		if (cut < size * 0.5) {
			cut = size;
		}
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n+/, '');
	}
	if (rest) {
		chunks.push(rest);
	}
	return chunks.length ? chunks : [''];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

/**
 * Feishu card markdown has no table support — raw table rows render as pipe
 * soup. Wrap contiguous table-looking lines into fenced code blocks; pass
 * everything else through untouched.
 */
function mdForFeishuCard(md: string): string {
	const lines = md.split('\n');
	const out: string[] = [];
	let inTable = false;
	for (const line of lines) {
		const isRow = /^\s*\|.*\|\s*$/.test(line);
		if (isRow && !inTable) {
			out.push('```');
			inTable = true;
		} else if (!isRow && inTable) {
			out.push('```');
			inTable = false;
		}
		out.push(line);
	}
	if (inTable) {
		out.push('```');
	}
	return out.join('\n');
}

// ---------------------------------------------------------------- legacy worker groups

/**
 * Leftovers from the per-worker-group era (rolled back): sessionId → Feishu
 * group bindings, one file per runtime. Read-only now — nothing creates or
 * reuses these groups; the file exists only so 「清理专属群」 can dissolve
 * them on demand.
 */
interface WorkerGroupEntry {
	sessionId: string;
	chatId: string;
	title: string;
	createdAt: number;
}

function legacyGroupMapPath(): string {
	const name = zcodeRuntimeEnv() === 'dev' ? 'feishu-worker-groups-dev.json' : 'feishu-worker-groups.json';
	return path.join(os.homedir(), '.zcode', name);
}

function loadLegacyGroupMap(): WorkerGroupEntry[] {
	try {
		const parsed = JSON.parse(fs.readFileSync(legacyGroupMapPath(), 'utf8')) as { entries?: WorkerGroupEntry[] };
		return Array.isArray(parsed.entries) ? parsed.entries.filter(e => e && e.sessionId && e.chatId) : [];
	} catch {
		return [];
	}
}

function dropLegacyGroupMap(): void {
	try {
		fs.unlinkSync(legacyGroupMapPath());
	} catch {
		// already gone
	}
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------- Feishu REST

class FeishuRestClient {
	private tokenInfo: { token: string; expiresAt: number } | undefined;

	constructor(
		private readonly appId: string,
		private readonly appSecret: string,
		private readonly log: (line: string) => void,
	) { }

	private async ensureToken(force: boolean): Promise<string> {
		if (!force && this.tokenInfo && this.tokenInfo.expiresAt > Date.now() + 5 * 60_000) {
			return this.tokenInfo.token;
		}
		const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
		});
		if (!res.ok) {
			throw new Error(`tenant_access_token HTTP ${res.status}`);
		}
		const json = asRecord(await res.json().catch(() => undefined));
		const code = asNumber(json?.code) ?? -1;
		if (code !== 0) {
			throw new Error(`tenant_access_token code=${code} ${asString(json?.msg) ?? ''}`.trim());
		}
		const token = asString(json?.tenant_access_token);
		if (!token) {
			throw new Error('tenant_access_token response missing token');
		}
		const expireSeconds = asNumber(json?.expire) ?? 3600;
		this.tokenInfo = { token, expiresAt: Date.now() + expireSeconds * 1000 };
		return token;
	}

	/** Send a text message; long text is split into numbered chunks. */
	async sendText(target: PushTarget, text: string): Promise<void> {
		const chunks = chunkText(text, 3600);
		for (let i = 0; i < chunks.length; i++) {
			const body = chunks.length > 1 ? `${chunks[i]}\n(${i + 1}/${chunks.length})` : chunks[i];
			await this.post(`/open-apis/im/v1/messages?receive_id_type=${target.receiveIdType}`, {
				receive_id: target.receiveId,
				msg_type: 'text',
				content: JSON.stringify({ text: body }),
				uuid: crypto.randomUUID(),
			});
			if (i < chunks.length - 1) {
				await delay(400);
			}
		}
	}

	/**
	 * Send an interactive card whose body is a markdown element — the only
	 * message type that renders markdown (headings/bold/lists/code blocks)
	 * in Feishu. Long markdown is split across multiple cards. Callback
	 * buttons (when given) ride on the first chunk.
	 */
	async sendCard(target: PushTarget, opts: {
		header: string;
		markdown: string;
		template?: string;
		subheader?: string;
		buttons?: FeishuCardButton[];
	}): Promise<void> {
		const chunks = chunkText(opts.markdown, 3400);
		for (let i = 0; i < chunks.length; i++) {
			const header = chunks.length > 1 ? `${opts.header}（${i + 1}/${chunks.length}）` : opts.header;
			const elements: Record<string, unknown>[] = [{ tag: 'markdown', content: chunks[i] }];
			if (i === 0 && opts.subheader) {
				elements.unshift({ tag: 'markdown', content: opts.subheader });
			}
			if (i === 0 && opts.buttons?.length) {
				// Feishu caps an action element at a handful of buttons —
				// overflow spills into further action elements.
				for (let b = 0; b < opts.buttons.length; b += 4) {
					elements.push({
						tag: 'action',
						actions: opts.buttons.slice(b, b + 4).map(button => ({
							tag: 'button',
							text: { tag: 'plain_text', content: button.text },
							type: button.type ?? 'default',
							value: button.value,
						})),
					});
				}
			}
			const card: Record<string, unknown> = {
				config: { wide_markdown_mode: true },
				elements,
			};
			if (header) {
				card.header = {
					title: { tag: 'plain_text', content: header },
					template: opts.template ?? 'default',
				};
			}
			await this.post(`/open-apis/im/v1/messages?receive_id_type=${target.receiveIdType}`, {
				receive_id: target.receiveId,
				msg_type: 'interactive',
				content: JSON.stringify(card),
				uuid: crypto.randomUUID(),
			});
			if (i < chunks.length - 1) {
				await delay(400);
			}
		}
	}

	/**
	 * Rewrite an already-sent card — used to retire a question card after it
	 * was answered (buttons would otherwise stay tappable and confusing).
	 * Needs im:message:update; failures are non-fatal and latched by caller.
	 */
	async patchCard(messageId: string, opts: { header: string; markdown: string; template?: string }): Promise<void> {
		const card: Record<string, unknown> = {
			config: { wide_markdown_mode: true },
			elements: [{ tag: 'markdown', content: opts.markdown }],
		};
		if (opts.header) {
			card.header = {
				title: { tag: 'plain_text', content: opts.header },
				template: opts.template ?? 'default',
			};
		}
		await this.request('PATCH', `/open-apis/im/v1/messages/${messageId}`, {
			msg_type: 'interactive',
			content: JSON.stringify(card),
		});
	}

	/**
	 * Dissolve a bot-owned group from the retired per-worker-group era. Only
	 * the explicit 「清理专属群」 command calls this — nothing creates groups
	 * anymore.
	 */
	async deleteGroup(chatId: string): Promise<void> {
		await this.request('DELETE', `/open-apis/im/v1/chats/${chatId}?user_id_type=open_id`);
	}

	private post(pathname: string, body: unknown): Promise<Record<string, unknown>> {
		return this.request('POST', pathname, body);
	}

	private async request(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', pathname: string, body?: unknown): Promise<Record<string, unknown>> {
		let lastError = 'unreachable';
		for (let attempt = 0; attempt < 2; attempt++) {
			const token = await this.ensureToken(attempt > 0);
			let json: Record<string, unknown> | undefined;
			try {
				const res = await fetch(`https://open.feishu.cn${pathname}`, {
					method,
					headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
					body: body === undefined ? undefined : JSON.stringify(body),
				});
				json = asRecord(await res.json().catch(() => undefined));
			} catch (err) {
				lastError = errText(err);
				this.log(`feishu api ${pathname} network error: ${lastError}`);
				continue;
			}
			const code = asNumber(json?.code) ?? -1;
			if (code === 0) {
				return json ?? {};
			}
			// 99991661/99991663/99991664: token invalid or expired — refresh once and retry.
			if ((code === 99991661 || code === 99991663 || code === 99991664) && attempt === 0) {
				continue;
			}
			throw new Error(`feishu api ${pathname} code=${code} ${asString(json?.msg) ?? ''}`.trim());
		}
		throw new Error(lastError);
	}
}

// ---------------------------------------------------------------- long-connection event stream

interface InboundFeishuMessage {
	openId: string;
	chatId: string;
	chatType: string;
	messageId: string;
	text: string;
}

/** A card button tap, already normalized: `value` is the button's JSON value. */
interface InboundFeishuCardAction {
	openId: string;
	chatId: string;
	messageId: string;
	value: Record<string, unknown>;
}

type FeishuLinkState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

/**
 * Long-connection event stream backed by the official SDK's WSClient.
 *
 * Feishu's current gateway protocol is: POST /callback/ws/endpoint with
 * {AppID, AppSecret} → one-time wss://msg-frontier.feishu.cn URL → protobuf
 * frames with fragmentation + mandatory ACKs. The SDK owns all of that plus
 * the pong liveness watchdog and infinite auto-reconnect (server pushes
 * ReconnectCount=-1). This wrapper maps lifecycle callbacks onto logs,
 * funnels SDK errors into the bridge output channel, and parses inbound
 * message events. Terminal failures (bad secret, long-connection not
 * enabled) do not self-heal inside the SDK, so a slow 5-minute restart
 * timer recovers them once the console config is fixed.
 */
class FeishuEventStream {
	private client: WSClient | undefined;
	private stopped = false;
	private state: FeishuLinkState = 'idle';
	private stateDetail = '';
	private restartTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly opts: {
		appId: string;
		appSecret: string;
		onMessage: (message: InboundFeishuMessage) => void;
		onCardAction: (action: InboundFeishuCardAction) => void;
		onLog: (line: string) => void;
	}) { }

	get connected(): boolean {
		return this.state === 'connected';
	}

	get statusLine(): string {
		return this.stateDetail ? `${this.state} · ${this.stateDetail}` : this.state;
	}

	start(): void {
		this.stopped = false;
		this.setState('connecting');
		// SDK errors/warnings surface in the bridge output channel; info+debug stay silent.
		const sdkLogger = {
			error: (...msg: unknown[]) => this.opts.onLog(`sdk error: ${joinLog(msg)}`),
			warn: (...msg: unknown[]) => this.opts.onLog(`sdk warn: ${joinLog(msg)}`),
			info: () => undefined,
			debug: () => undefined,
			trace: () => undefined,
		};
		const dispatcher = new EventDispatcher({}).register({
			'im.message.receive_v1': (data: unknown) => this.handleEvent(data),
			// Card button taps. Delivered through the same persistent connection
			// as message events once the app subscribes via long connection.
			'card.action.trigger': (data: unknown) => this.handleCardAction(data),
		});
		const client = new WSClient({
			appId: this.opts.appId,
			appSecret: this.opts.appSecret,
			logger: sdkLogger,
			handshakeTimeoutMs: 15_000,
			onReady: () => {
				this.setState('connected');
				this.opts.onLog('长连接已建立（官方 SDK，自动心跳+自动重连）');
			},
			onReconnecting: () => {
				this.setState('reconnecting');
				this.opts.onLog('连接断开，SDK 自动重连中');
			},
			onReconnected: () => {
				this.setState('connected');
				this.opts.onLog('已重新连接');
			},
			onError: err => {
				this.setState('failed', errText(err));
				this.opts.onLog(`连接失败：${errText(err)}。常见原因：App Secret 不对、事件订阅未用“长连接”模式、未订阅“接收消息 im.message.receive_v1”或缺少 im:message 权限。5 分钟后自动重试；改完配置即可，无需重启窗口。`);
				this.scheduleRestart(300_000);
			},
		});
		this.client = client;
		void client.start({ eventDispatcher: dispatcher }).catch(err => {
			this.opts.onLog(`client.start 异常：${errText(err)}`);
		});
	}

	close(): void {
		this.stopped = true;
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = undefined;
		}
		try {
			this.client?.close({ force: true });
		} catch {
			// best effort
		}
		this.client = undefined;
		this.setState('idle');
	}

	private setState(state: FeishuLinkState, detail = ''): void {
		this.state = state;
		this.stateDetail = detail;
	}

	private scheduleRestart(ms: number): void {
		if (this.stopped || this.restartTimer) {
			return;
		}
		this.restartTimer = setTimeout(() => {
			this.restartTimer = undefined;
			if (!this.stopped) {
				this.start();
			}
		}, ms);
	}

	/**
	 * Message events arrive in Feishu's v2 flat schema ({schema:'2.0',
	 * event_type, message:{…}, sender:{…}}); older nested {header,event}
	 * payloads are accepted too. Handler return value is ignored — the SDK
	 * ACKs 200 for every delivered event.
	 */
	private handleEvent(data: unknown): void {
		const root = asRecord(data);
		if (!root) {
			return;
		}
		const nested = asRecord(root.event);
		const inner = nested && asRecord(nested.message) ? nested : root;
		const message = asRecord(inner?.message);
		const sender = asRecord(inner?.sender);
		const senderId = asRecord(sender?.sender_id);
		const openId = asString(senderId?.open_id) ?? asString(senderId?.user_id);
		const messageId = asString(message?.message_id) ?? '';
		const chatType = asString(message?.chat_type) ?? 'p2p';
		const messageType = asString(message?.message_type) ?? '';
		const contentRaw = asString(message?.content) ?? '';
		let body = '';
		if (messageType === 'text') {
			try {
				body = asString(asRecord(JSON.parse(contentRaw))?.text) ?? '';
			} catch {
				body = contentRaw;
			}
		}
		// Strip @mention tokens so group-style "@bot 帮助" works as "帮助".
		body = body.replace(/@_user_\d+/g, '').trim();
		if (!openId || !messageId) {
			this.opts.onLog(`消息事件缺 open_id/message_id：${truncate(JSON.stringify(data), 200)}`);
			return;
		}
		if (!body) {
			this.opts.onLog(`忽略 ${messageType || 'unknown'} 类型消息 ${messageId}`);
			return;
		}
		this.opts.onMessage({
			openId,
			chatId: asString(message?.chat_id) ?? '',
			chatType,
			messageId,
			text: body,
		});
	}

	/**
	 * Card callback payload: {context:{open_message_id, open_chat_id},
	 * operator:{open_id}, action:{value, tag}} with flat fallbacks (field
	 * names mirror the SDK's own normalizeCardAction). `value` is whatever
	 * JSON the button was created with.
	 */
	private handleCardAction(data: unknown): void {
		const root = asRecord(data);
		if (!root) {
			return;
		}
		const nested = asRecord(root.event);
		const inner = nested && asRecord(nested.action) ? nested : root;
		const context = asRecord(inner?.context);
		const operator = asRecord(inner?.operator);
		const action = asRecord(inner?.action);
		const messageId = asString(context?.open_message_id) ?? asString(inner?.open_message_id) ?? '';
		const chatId = asString(context?.open_chat_id) ?? asString(inner?.open_chat_id) ?? '';
		const openId = asString(operator?.open_id) ?? '';
		let value = action?.value;
		if (typeof value === 'string') {
			try {
				value = JSON.parse(value);
			} catch {
				// keep raw string; rejected below
			}
		}
		if (!messageId || !openId || !asRecord(value)) {
			this.opts.onLog(`卡片回调缺字段，忽略：${truncate(JSON.stringify(data), 220)}`);
			return;
		}
		this.opts.onCardAction({ messageId, chatId, openId, value: asRecord(value) as Record<string, unknown> });
	}
}

function joinLog(msg: unknown[]): string {
	return msg.map(part => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ');
}

// ---------------------------------------------------------------- ask snapshot

/** Mirror of askUser.ts AskUserOption/AskUserQuestion (timeline persisted form). */
export interface FeishuAskOption { id: string; label: string; description?: string; }
export interface FeishuAskQuestion {
	id: string;
	prompt: string;
	header?: string;
	options: FeishuAskOption[];
	allowMultiple?: boolean;
	allowFreeform?: boolean;
}
export interface FeishuAskSnapshot { id: string; title?: string; questions: FeishuAskQuestion[]; }
export type FeishuAskResult =
	| { outcome: 'answered'; answers: Array<{ questionId: string; selectedOptionIds: string[]; freeText?: string }> }
	| { outcome: 'skipped'; reason?: string };

/**
 * Defensive coercion of a persisted `question` timeline row into the ask
 * snapshot the phone card needs. Malformed rows (missing id/options) yield
 * undefined so the bridge falls back to the plain "answer on desktop" text.
 */
function normalizeAskSnapshot(row: unknown): FeishuAskSnapshot | undefined {
	const record = asRecord(row);
	const id = asString(record?.id);
	if (!record || !id) {
		return undefined;
	}
	const questions: FeishuAskQuestion[] = [];
	for (const raw of Array.isArray(record.questions) ? record.questions : []) {
		const q = asRecord(raw);
		const qid = asString(q?.id);
		if (!q || !qid) {
			continue;
		}
		const options: FeishuAskOption[] = [];
		for (const rawOpt of Array.isArray(q.options) ? q.options : []) {
			const opt = asRecord(rawOpt);
			const oid = asString(opt?.id);
			const label = asString(opt?.label);
			if (oid && label) {
				options.push({ id: oid, label, description: asString(opt?.description) });
			}
		}
		questions.push({
			id: qid,
			prompt: asString(q?.prompt) ?? '',
			header: asString(q?.header),
			options,
			allowMultiple: q?.allowMultiple === true,
			allowFreeform: q?.allowFreeform === true,
		});
	}
	return { id, title: asString(record.title), questions };
}

// ---------------------------------------------------------------- completion watcher

interface TurnWatchEntry {
	sessionId: string;
	title: string;
	openId: string;
	startedAt: number;
	lastSignature: string;
	stableCount: number;
	/** Timeline length at watch start — only items after this belong to the watched turn. */
	baseTimelineLength: number;
	/** One-shot flag: the "agent is waiting for your answer" notice already went out. */
	askNotified: boolean;
	timer: ReturnType<typeof setInterval>;
}

/**
 * Authoritative turn-end detection for the phone bridge.
 *
 * The panel's `startTurn` stamps the watched turn into the persisted timeline:
 * a `work` item (running=true) at turn start, `running=false` in its finally,
 * `status` items for errors/cancellations, and `question` items while the
 * agent is blocked waiting for a human answer in the desktop webview. The old
 * "assistant message stable for 12s" heuristic missed every one of those, so a
 * failed or ask-blocked turn looked like silence for two hours. Now:
 *
 *   - question pending  → notify the phone once ("waiting for you in VS Code")
 *   - status error      → push the error text, stop watching
 *   - work running=false→ turn finished: push the final assistant reply
 *   - nothing at all    → after 15 min idle, report instead of black-holing
 */
class CompletionWatcher {
	private readonly entries = new Map<string, TurnWatchEntry>();

	constructor(private readonly opts: {
		store: IdeChatStore;
		onResult: (result: { sessionId: string; title: string; openId: string; content: string }) => void;
		onTimeout: (result: { sessionId: string; title: string; openId: string; note: string }) => void;
		onAwaitingUser: (result: { sessionId: string; title: string; openId: string; question: string; ask?: FeishuAskSnapshot }) => void;
		log: (line: string) => void;
	}) { }

	watch(sessionId: string, title: string, openId: string): void {
		const existing = this.entries.get(sessionId);
		if (existing) {
			// Follow-up on an already-watched session: rearm everything.
			existing.lastSignature = '';
			existing.stableCount = 0;
			existing.startedAt = Date.now();
			existing.askNotified = false;
			// Baseline refresh is async-read below via rebase(); the sync path
			// covers it by ignoring pre-existing terminal items on the next tick.
			void this.rebase(existing);
			return;
		}
		const entry: TurnWatchEntry = {
			sessionId,
			title,
			openId,
			startedAt: Date.now(),
			lastSignature: '',
			stableCount: 0,
			baseTimelineLength: Number.MAX_SAFE_INTEGER,
			askNotified: false,
			timer: setInterval(() => void this.tick(entry), 4000),
		};
		this.entries.set(sessionId, entry);
		void this.rebase(entry);
	}

	/** Record the current timeline length so only this turn's items are judged. */
	private async rebase(entry: TurnWatchEntry): Promise<void> {
		try {
			const session = await this.opts.store.getSession(entry.sessionId);
			entry.baseTimelineLength = session?.timeline?.length ?? 0;
		} catch {
			// Store read failed — MAX_SAFE_INTEGER keeps every item ignored, and
			// the idle timeout below still reports instead of hanging silently.
		}
	}

	isWatched(sessionId: string): boolean {
		return this.entries.has(sessionId);
	}

	watchedIds(): string[] {
		return [...this.entries.keys()];
	}

	drop(sessionId: string): void {
		const entry = this.entries.get(sessionId);
		if (entry) {
			clearInterval(entry.timer);
			this.entries.delete(sessionId);
		}
	}

	/** Immediate check after an awaited startTurn — skips the 4s poll latency. */
	pollNow(sessionId: string): void {
		const entry = this.entries.get(sessionId);
		if (entry) {
			void this.tick(entry);
		}
	}

	private async tick(entry: TurnWatchEntry): Promise<void> {
		try {
			const session = await this.opts.store.getSession(entry.sessionId);
			if (!session) {
				this.expire(entry, '会话已不存在（可能被清理）');
				return;
			}
			const items = (session.timeline ?? []).slice(entry.baseTimelineLength === Number.MAX_SAFE_INTEGER
				? 0
				: entry.baseTimelineLength);
			const ageMinutes = (Date.now() - entry.startedAt) / 60_000;

			// 1. Agent blocked on an askUser card — the phone must know, and when
			//    the persisted row carries structured options it can answer it.
			const pendingAskRow = [...items].reverse()
				.find(row => row?.kind === 'question' && (row as { status?: string }).status === 'pending');
			if (pendingAskRow && !entry.askNotified) {
				entry.askNotified = true;
				this.opts.onAwaitingUser({
					sessionId: entry.sessionId,
					title: entry.title,
					openId: entry.openId,
					question: (asString((pendingAskRow as { title?: unknown }).title) ?? '需要你的输入').trim(),
					ask: normalizeAskSnapshot(pendingAskRow),
				});
			}

			// 2. Terminal error status — push the failure text now.
			const errStatus = [...items].reverse().find(row => row?.kind === 'status'
				&& (row as { tone?: string }).tone === 'error') as { text?: string } | undefined;
			if (errStatus) {
				this.finish(entry, `❌ 任务失败：${(errStatus.text ?? '未知错误').trim()}`);
				return;
			}

			// 3. Authoritative completion: this turn's work item flipped to done.
			const lastWork = [...items].reverse().find(row => row?.kind === 'work') as
				| { running?: boolean }
				| undefined;
			const messages = session.messages ?? [];
			const last = messages.length ? messages[messages.length - 1] : undefined;
			if (lastWork && lastWork.running === false) {
				const stopped = [...items].reverse().find(row => row?.kind === 'status') as { text?: string } | undefined;
				if (stopped && /已停止/.test(stopped.text ?? '')) {
					this.finish(entry, `⏹ 任务被停止（未完成）。可回复内容继续追问。`);
					return;
				}
				const content = last?.role === 'assistant' && last.content.trim()
					? last.content.trim()
					: '（本轮没有文本输出——可能只做了文件改动。可继续追问让它汇报。）';
				this.finish(entry, content);
				return;
			}

			// 4. Turn still streaming — keep the stable-signature fallback for
			//    sessions persisted by older builds without a fresh work item.
			if (last && last.role === 'assistant' && last.content.trim()) {
				const signature = `${messages.length}:${last.content.length}:${hashStr(last.content)}`;
				if (signature === entry.lastSignature) {
					entry.stableCount += 1;
				} else {
					entry.lastSignature = signature;
					entry.stableCount = 0;
				}
				if (entry.stableCount >= 3 && !lastWork) {
					this.finish(entry, last.content.trim());
					return;
				}
			}

			// 5. Nothing happening at all — surface it instead of black-holing.
			if (ageMinutes > 15) {
				const hint = pendingAskRow
					? '它仍在等你回答（点手机上的问题卡片作答，或打开 VS Code 的 Chat 面板）'
					: '15 分钟内没有任何进展，可能派发未生效或被挂起';
				this.expire(entry, hint);
			}
		} catch (err) {
			this.opts.log(`watch ${entry.sessionId.slice(0, 8)} error: ${errText(err)}`);
		}
	}

	private finish(entry: TurnWatchEntry, content: string): void {
		this.drop(entry.sessionId);
		this.opts.onResult({ sessionId: entry.sessionId, title: entry.title, openId: entry.openId, content });
	}

	private expire(entry: TurnWatchEntry, note: string): void {
		this.drop(entry.sessionId);
		this.opts.log(`watch ${entry.sessionId.slice(0, 8)} ${note}`);
		this.opts.onTimeout({ sessionId: entry.sessionId, title: entry.title, openId: entry.openId, note });
	}

	dispose(): void {
		for (const entry of this.entries.values()) {
			clearInterval(entry.timer);
		}
		this.entries.clear();
	}
}

// ---------------------------------------------------------------- single-window lock

function lockFilePath(): string {
	return path.join(os.homedir(), '.zcode', 'feishu-bridge.lock');
}

function readLockFile(): { pid?: number; ts?: number; env?: ZcodeRuntimeEnv } {
	try {
		return JSON.parse(fs.readFileSync(lockFilePath(), 'utf8')) as { pid?: number; ts?: number; env?: ZcodeRuntimeEnv };
	} catch {
		return {};
	}
}

function processAlive(pid: number | undefined): boolean {
	if (!pid || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------- bridge

/** A pending askUser prompt being answered from the phone. */
interface FeishuAskDraft {
	sessionId: string;
	openId: string;
	title: string;
	snapshot: FeishuAskSnapshot;
	/** questionId → picked option ids (+ freeform text when allowed). */
	answers: Map<string, { optionIds: Set<string>; freeText?: string }>;
	/** Message id of the question card — latched from the first button tap for the retire-patch. */
	cardMessageId?: string;
	createdAt: number;
	/** True when at least one question is multi-select/freeform and an explicit 提交答案 tap is required. */
	needsSubmit: boolean;
}

/** Deterministic key for a button value — click dedup relies on stable ordering. */
function stableValueKey(value: Record<string, unknown>): string {
	return Object.keys(value).sort()
		.map(key => `${key}=${typeof value[key] === 'object' && value[key] !== null ? JSON.stringify(value[key]) : String(value[key])}`)
		.join('&');
}

function helpText(): string {
	const dev = zcodeRuntimeEnv() === 'dev';
	return [
		dev ? 'ZCode 飞书桥 · DEV' : 'ZCode 飞书桥',
		'',
		dev
			? '当前连着的是 DEV。DEV 和正式窗口共用这一条长连接：手机上看到的、以及新派发的任务，都属于现在拿着连接的那一边。'
			: '当前连着的是正式窗口。DEV 和正式窗口共用这一条长连接：手机上看到的、以及新派发的任务，都属于现在拿着连接的那一边。',
		'',
		'与机器人的这个单聊就是唯一入口，所有任务都在这里进行：',
		'新 <任务> —— 派发新 Worker（例：新 总结 icard-server 最近的提交）',
		'列表 —— 查看当前 Worker（与 VS Code 首页面板同源）',
		'选 N —— 绑定列表里的第 N 个 Worker，之后发文本=追问它',
		'当前 —— 查看现在绑定的是哪个任务',
		'取消 —— 解除绑定，此后发文本=派发新 Worker',
		'状态 —— 桥连接与任务监控状态',
		'',
		'发任意文本：有绑定 → 发给绑定的任务；没绑定 → 自动当作新任务派发。两种情况都会有回复说明发给了谁。',
		'每张结果卡片都标着任务名，结尾提示当前绑定；不确定自己在哪个任务下时，看最近一张结果卡或发「当前」。',
		'',
		'任务完成后只推送最终结果；中间过程在电脑上的 Router 主页查看。',
		'',
		'Worker 中途向你提问时会收到一张问题卡片：直接点卡片上的选项按钮作答；',
		'多选题先点选各项再点【提交答案】；需要自由文字的问题直接回复一条消息即可。',
		'',
		'旧版给每个 Worker 建过专属群，现已停用；残留的群回复「清理专属群」可一次性解散。',
	].join('\n');
}

class FeishuBridge implements vscode.Disposable {
	private readonly output: vscode.OutputChannel;
	private panel: FeishuPanelAdapter | undefined;
	private store: IdeChatStore | undefined;
	private config: FeishuConfig | undefined;
	private rest: FeishuRestClient | undefined;
	private stream: FeishuEventStream | undefined;
	private watcher: CompletionWatcher | undefined;
	private readonly selection = new Map<string, string>();
	/** openId → bound worker display identity, so acks/状态 can name the task without a store read. */
	private readonly selectionMeta = new Map<string, { sessionId: string; title: string }>();
	private readonly lastListing = new Map<string, Array<{ sessionId: string; title: string }>>();
	private readonly seenMessages = new Set<string>();
	private readonly seenOrder: string[] = [];
	private lockHeartbeat: ReturnType<typeof setInterval> | undefined;
	/** In-flight askUser prompts the phone is answering via card buttons / freeform text, by prompt id. */
	private readonly askDrafts = new Map<string, FeishuAskDraft>();
	/** Card-click dedup: Feishu redelivers card.action.trigger; the same key inside 3s is a redelivery. */
	private readonly seenActions = new Map<string, number>();
	/** Latched off after the first patchCard rejection (im:message:update missing). */
	private cardPatchSupport = true;

	constructor() {
		this.output = vscode.window.createOutputChannel('ZCode 飞书桥');
	}

	private log(line: string): void {
		const stamp = new Date().toLocaleTimeString();
		this.output.appendLine(`[${stamp}] ${line}`);
	}

	async start(panel: FeishuPanelAdapter, store: IdeChatStore): Promise<void> {
		this.stop();
		this.panel = panel;
		this.store = store;
		const config = readConfig();
		this.config = config;
		const secret = await readAppSecret();
		if (!config.enabled) {
			this.log('未启动：zcode.feishu.enabled=false');
			return;
		}
		if (!config.appId || !secret) {
			this.log(`未启动：appId ${config.appId ? '已配置' : '缺失（设置 zcode.feishu.appId）'}，App Secret ${secret ? '已保存' : '缺失（命令面板执行 “ZCode: 设置飞书机器人 App Secret”）'}`);
			return;
		}
		if (!this.acquireLock()) {
			const prev = readLockFile();
			const holder = prev.env === 'dev' ? 'DEV' : prev.env === 'installed' ? '正式窗口' : '另一个窗口';
			const mine = zcodeRuntimeLabel();
			const across = prev.env && prev.env !== zcodeRuntimeEnv();
			this.log(across
				? `未启动：${holder}已占用飞书长连接（~/.zcode/feishu-bridge.lock），本窗口（${mine || '正式窗口'}）让位。手机消息会进${holder}。`
				: `未启动：另一个${mine}窗口已在运行飞书桥（~/.zcode/feishu-bridge.lock 心跳新鲜），本窗口让位`);
			return;
		}
		this.rest = new FeishuRestClient(config.appId, secret, line => this.log(line));
		this.watcher = new CompletionWatcher({
			store,
			onResult: result => void this.pushResult(result),
			onTimeout: result => {
				void this.pushTextTo(result.sessionId, result.openId, `⚠️「${truncate(result.title, 40)}」已停止监控：${result.note}。中间状态请在电脑上的 Router 主页查看；也可以直接再发一次任务。`).catch(err => this.log(`reply failed: ${errText(err)}`));
			},
			onAwaitingUser: result => {
				void this.handleAskPending(result).catch(err => this.log(`问题卡片推送失败：${errText(err)}`));
			},
			log: line => this.log(line),
		});
		this.stream = new FeishuEventStream({
			appId: config.appId,
			appSecret: secret,
			onMessage: message => void this.handleInbound(message),
			onCardAction: action => void this.handleCardAction(action),
			onLog: line => this.log(line),
		});
		this.stream.start();
		const startedAs = zcodeRuntimeLabel();
		this.log(`飞书桥启动${startedAs ? `（${startedAs}）` : ''}：聊天记录 ${store.rootDir}，单聊模式（不再为每个 Worker 建群），appId=${config.appId}，白名单=${config.allowOpenIds.length ? config.allowOpenIds.join(',') : '空（任何人都不可用）'}。传输层为官方 SDK 长连接（自动心跳、自动重连、断线期间手机消息会丢失，重发即可）。`);
		this.notifyLegacyGroups();
	}

	/** One notice per start when leftovers from the group era still exist. */
	private notifyLegacyGroups(): void {
		const owner = this.config?.allowOpenIds[0];
		const leftovers = loadLegacyGroupMap();
		if (!owner || !leftovers.length || !this.rest) {
			return;
		}
		void this.rest.sendText(PushTarget.p2p(owner),
			`检测到 ${leftovers.length} 个旧 Worker 专属群（专属群模式已下线，任务都改在这个单聊里进行）。回复「清理专属群」可一次性解散它们；不清理也不影响使用。`)
			.catch(err => this.log(`旧专属群提示发送失败：${errText(err)}`));
	}

	stop(): void {
		this.stream?.close();
		this.stream = undefined;
		this.watcher?.dispose();
		this.watcher = undefined;
		this.rest = undefined;
		this.releaseLock();
	}

	dispose(): void {
		this.stop();
		this.output.dispose();
	}

	statusText(): string {
		if (!this.config?.enabled) {
			return '飞书桥：未启用（zcode.feishu.enabled=false）';
		}
		const connection = this.stream ? (this.stream.connected ? '已连接' : `连接状态：${this.stream.statusLine}`) : '未启动';
		const watched = this.watcher ? [...this.entriesSnapshot()].length : 0;
		const mark = zcodeRuntimeLabel();
		const owner = this.config.allowOpenIds[0];
		const bound = owner ? this.bindingLabel(owner) : undefined;
		return `飞书桥${mark ? `（${mark}）` : ''}：${connection}，监控中任务 ${watched} 个，手机当前绑定：${bound ?? '未绑定（发文本=派发新任务）'}，appId=${this.config.appId || '未配置'}，白名单 ${this.config.allowOpenIds.length} 人。DEV 和正式窗口不会同时在线。详见输出面板 “ZCode 飞书桥”。`;
	}

	/**
	 * Short stable per-worker tag (last 4 hex of the session id, uppercased).
	 * Unlike the 1..N numbers of a 列表 rendering it never shifts between
	 * listings, so acks and result cards can reference a worker unambiguously.
	 */
	private static workerTag(sessionId: string): string {
		return `·${sessionId.replace(/-/g, '').slice(-4).toUpperCase()}`;
	}

	/** 「title ·TAG」 for sync displays (状态), read from the meta cache. */
	private bindingLabel(openId: string): string | undefined {
		const meta = this.selectionMeta.get(openId);
		return meta ? `「${truncate(meta.title, 40)}」${FeishuBridge.workerTag(meta.sessionId)}` : undefined;
	}

	private entriesSnapshot(): string[] {
		return this.watcher?.watchedIds() ?? [];
	}

	private acquireLock(): boolean {
		try {
			fs.mkdirSync(path.dirname(lockFilePath()), { recursive: true });
			const prev = readLockFile();
			if (
				prev.pid !== process.pid &&
				Date.now() - (prev.ts ?? 0) < 90_000 &&
				processAlive(prev.pid)
			) {
				return false;
			}
			this.writeLock();
			this.lockHeartbeat = setInterval(() => this.writeLock(), 20_000);
			return true;
		} catch (err) {
			this.log(`锁文件不可写，跳过多窗口互斥：${errText(err)}`);
			return true;
		}
	}

	private writeLock(): void {
		try {
			fs.writeFileSync(lockFilePath(), JSON.stringify({ pid: process.pid, ts: Date.now(), env: zcodeRuntimeEnv() }));
		} catch {
			// non-fatal: worst case another window also bridges
		}
	}

	private releaseLock(): void {
		if (this.lockHeartbeat) {
			clearInterval(this.lockHeartbeat);
			this.lockHeartbeat = undefined;
		}
		try {
			if (readLockFile().pid === process.pid) {
				fs.unlinkSync(lockFilePath());
			}
		} catch {
			// already gone
		}
	}

	// ---------------- inbound ----------------

	private async handleInbound(message: InboundFeishuMessage): Promise<void> {
		if (this.seenMessages.has(message.messageId)) {
			return;
		}
		this.seenMessages.add(message.messageId);
		this.seenOrder.push(message.messageId);
		while (this.seenOrder.length > 300) {
			const evicted = this.seenOrder.shift();
			if (evicted) {
				this.seenMessages.delete(evicted);
			}
		}
		const allow = this.config?.allowOpenIds ?? [];
		if (!allow.length || !allow.includes(message.openId)) {
			// In groups never reply to strangers — a bot posting "unauthorized"
			// into someone else's chat would be noise. 1:1 keeps the hint so the
			// owner can copy their open_id.
			if (message.chatType === 'group') {
				this.log(`忽略未授权群消息（open_id=${message.openId}，chat_id=${message.chatId}）`);
				return;
			}
			await this.reply(message.openId, [
				'未授权。把下面这个 open_id 加入设置 zcode.feishu.allowOpenIds 后再试：',
				message.openId,
			].join('\n')).catch(err => this.log(`reply failed: ${errText(err)}`));
			return;
		}
		const text = message.text.trim();
		if (!text) {
			return;
		}
		// Worker groups are retired — bounce stragglers back to the 1:1 chat.
		if (message.chatType === 'group') {
			this.log(`忽略旧专属群消息（chat_id=${message.chatId}）：${truncate(text, 80)}`);
			await this.rest?.sendText(PushTarget.group(message.chatId),
				'这个专属群已停用：任务改在【与机器人的单聊】里进行。回到单聊发「帮助」查看用法；发「清理专属群」可解散残留的群。')
				.catch(err => this.log(`旧群回复失败：${errText(err)}`));
			return;
		}
		this.log(`收到：${truncate(text, 120)}`);
		try {
			await this.dispatch(message.openId, text);
		} catch (err) {
			this.log(`处理失败：${errText(err)}`);
			await this.reply(message.openId, `处理出错：${errText(err)}`).catch(() => undefined);
		}
	}

	private async dispatch(openId: string, text: string): Promise<void> {
		if (/^(帮助|help|\?|？)$/.test(text)) {
			await this.rest!.sendCard(PushTarget.p2p(openId), {
				header: 'ZCode 飞书桥 · 帮助',
				template: 'turquoise',
				markdown: mdForFeishuCard(helpText()),
				buttons: [
					{ text: '📋 Worker 列表', value: { t: 'cmd', c: '列表' }, type: 'primary' },
					{ text: '📍 当前绑定', value: { t: 'cmd', c: '当前' } },
					{ text: '🧭 桥状态', value: { t: 'cmd', c: '状态' } },
				],
			}).catch(async err => {
				this.log(`帮助卡片失败，退回纯文本：${errText(err)}`);
				await this.reply(openId, helpText());
			});
			return;
		}
		if (/^(状态|status)$/.test(text)) {
			await this.reply(openId, this.statusText());
			return;
		}
		if (/^(列表|list|ls|workers|w)$/.test(text)) {
			await this.listWorkers(openId);
			return;
		}
		if (/^(取消|unselect|cancel)$/.test(text)) {
			this.selection.delete(openId);
			this.selectionMeta.delete(openId);
			await this.reply(openId, '已解除绑定。此后发送文本=派发新 Worker。');
			return;
		}
		if (/^(清理专属群|清理群|清理旧群)$/.test(text)) {
			await this.cleanupLegacyGroups(openId);
			return;
		}
		const select = text.match(/^(?:选|选择|use|sel)\s*#?(\d+)$/);
		if (select) {
			await this.selectWorker(openId, Number(select[1]));
			return;
		}
		if (/^(当前|绑定中|binding|cur)$/.test(text)) {
			await this.showBinding(openId);
			return;
		}
		const newTask = text.match(/^new\s+([\s\S]+)$/i) ?? text.match(/^(?:新|新建|派发)[:：\s]*([\s\S]+)$/);
		if (newTask) {
			await this.spawnWorker(openId, newTask[1].trim(), 'explicit');
			return;
		}
		const bound = this.selection.get(openId);
		if (bound) {
			await this.continueWorker(openId, bound, text);
			return;
		}
		await this.spawnWorker(openId, text, 'implicit');
	}

	/** 当前：what the next free text will hit, plus the switch commands. */
	private async showBinding(openId: string): Promise<void> {
		const bound = this.selection.get(openId);
		if (!bound) {
			await this.reply(openId, '当前没有绑定任务：下一条文本会派发**新 Worker**。要追问已有任务，先发「列表」再「选 N」。');
			return;
		}
		const session = await this.store!.getSession(bound).catch(() => undefined);
		const title = (session?.title ?? '').trim() || this.selectionMeta.get(openId)?.title || 'Worker';
		const running = this.watcher?.isWatched(bound) ?? false;
		await this.reply(openId, [
			`当前绑定：「${truncate(title, 40)}」${FeishuBridge.workerTag(bound)}${running ? '（执行中，完成后推送结果）' : ''}`,
			'直接发文本=追问它；「取消」解绑；「列表」可切换到其他任务。',
		].join('\n'));
	}

	/** One-off dissolve of the retired era's leftover worker groups. */
	private async cleanupLegacyGroups(openId: string): Promise<void> {
		const entries = loadLegacyGroupMap();
		if (!entries.length) {
			await this.reply(openId, `没有记录在案的旧专属群（${legacyGroupMapPath()}）。手机上如还有残留群，属于另一环境的记录，手动删除即可。`);
			return;
		}
		let dissolved = 0;
		const stuck: string[] = [];
		for (const entry of entries) {
			try {
				await this.rest!.deleteGroup(entry.chatId);
				dissolved++;
			} catch (err) {
				const message = errText(err);
				if (/2300(01|02)|not exist|不存在|已解散/i.test(message)) {
					dissolved++; // already gone — counts as cleaned
				} else {
					stuck.push(truncate(entry.title, 24));
					this.log(`清理专属群失败（${truncate(entry.title, 30)}）：${message}`);
				}
			}
			await delay(300);
		}
		if (!stuck.length) {
			dropLegacyGroupMap();
		}
		await this.reply(openId, stuck.length
			? `已解散 ${dissolved}/${entries.length} 个旧专属群；失败：${stuck.join('、')}。稍后再发一次「清理专属群」重试。`
			: `已解散 ${dissolved} 个旧专属群，记录已清空。以后任务都在这个单聊里进行。`);
	}

	// ---------------- commands ----------------

	/**
	 * The Worker board's ground truth is the Router session's dispatch cards —
	 * not `kind === 'worker'` store tags. Desktop-spawned workers (the ones the
	 * user actually sees on the home rail) carry a dispatch card in the Router
	 * timeline; filtering the store by kind only ever surfaced bridge-spawned
	 * sessions. Mirror the board: read the Router timeline, dedupe per worker,
	 * and keep only sessions still alive in the store.
	 */
	private async collectWorkers(): Promise<{ sessionId: string; title: string; status: string; ts?: number }[]> {
		const metas = await this.store!.listSessions({ limit: 500 });
		const routerMeta = metas
			.filter(meta => meta.title === 'Router')
			.sort((a, b) => b.updatedAt - a.updatedAt)[0];
		if (!routerMeta) {
			return [];
		}
		const router = await this.store!.getSession(routerMeta.id).catch(() => undefined);
		const cards = (router?.timeline ?? [])
			.filter(row => row?.kind === 'dispatch') as unknown as
			{ workerSessionId?: string; text?: string; status?: string; startedAt?: number }[];
		const newest = new Map<string, { sessionId: string; title: string; status: string; ts?: number }>();
		for (const card of cards) {
			const id = card.workerSessionId;
			if (!id || id === routerMeta.id) {
				continue;
			}
			// Later cards win — a worker re-dispatched shows its latest state.
			newest.set(id, {
				sessionId: id,
				title: (card.text ?? '').trim() || 'Worker',
				status: card.status ?? '',
				ts: card.startedAt,
			});
		}
		const alive: { sessionId: string; title: string; status: string; ts?: number }[] = [];
		for (const worker of newest.values()) {
			const session = await this.store!.getSession(worker.sessionId).catch(() => undefined);
			if (session) {
				// Prefer the worker session's own title: after the first turn the
				// IDE replaces the provisional task-text truncation with a short
				// AI label — that label is the worker's display name everywhere
				// (list, result cards, and the dedicated group name).
				alive.push({ ...worker, title: (session.title ?? '').trim() || worker.title });
			}
		}
		// Heal pre-fix phone dispatches in place (see backfillWorkerIdentity).
		await this.backfillWorkerIdentity(routerMeta.id, cards);
		return alive;
	}

	/**
	 * Stable identity for phone-spawned workers. The board's ✕ remove button
	 * only renders for cards whose group carries a workerId (chatView gates it
	 * on group.workerId), so every card this bridge writes must stamp one.
	 * Derived from the session id → same worker keeps the same identity across
	 * dispatches and window reloads.
	 */
	private static phoneWorkerId(sessionId: string): string {
		return `fw-${sessionId.replace(/-/g, '').slice(-10)}`;
	}

	/** Deterministic accent per worker, same palette the desktop identity chips use. */
	private static accentFor(sessionId: string): string {
		const palette = ['charts.blue', 'charts.green', 'charts.orange', 'charts.purple', 'charts.yellow', 'charts.pink', 'charts.teal'];
		let hash = 0;
		for (const ch of sessionId) {
			hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
		}
		return palette[hash % palette.length];
	}

	/**
	 * Desktop dispatch cards carry full identity (workerId/badge/accent); the
	 * phone path used to land only the fallback receipt card from
	 * markRouterDispatchRunning (workerSessionId, no workerId) — visible on
	 * the board but with no ✕. Write the exact shape the desktop submit path
	 * writes, then bind the super-agent service to the card the same way
	 * mirrorWorkerFollowUpToRouter does, so live status lands on it too.
	 *
	 * The stamp must land in the panel's in-memory Router chat FIRST: the open
	 * board renders memory, and a store-only write used to leave
	 * markRouterDispatchRunning minting its identity-less duplicate anyway —
	 * the regression that made phone tasks undeletable from the desktop again.
	 */
	private async stampDispatchCard(routerId: string, sessionId: string, task: string, title: string): Promise<void> {
		const workerId = FeishuBridge.phoneWorkerId(sessionId);
		const card = {
			id: `dispatch-fw-${crypto.randomUUID()}`,
			kind: 'dispatch' as const,
			text: task,
			workerId,
			workerSessionId: sessionId,
			badge: title,
			accent: FeishuBridge.accentFor(sessionId),
			receipt: '处理中',
			status: 'running',
			startedAt: Date.now(),
		};
		if (this.panel?.upsertRouterDispatchCard) {
			await this.panel.upsertRouterDispatchCard(routerId, card as ConversationItem);
		} else {
			await this.store!.upsertDispatchCards(routerId, [card as ConversationItem]);
		}
		void vscode.commands.executeCommand('zcode.internal.superAgent.bindRouterDispatch', {
			sessionId: routerId,
			dispatchItemId: card.id,
			workerSessionId: sessionId,
		}).then(undefined, err => this.log(`bindRouterDispatch skipped: ${errText(err)}`));
		this.log(`已写入派发卡（${workerId}）→ Router ${routerId.slice(0, 8)}`);
	}

	/**
	 * In-place identity backfill for dispatch cards that predate the stamp
	 * above (phone dispatches whose only card came from
	 * markRouterDispatchRunning). Re-upserts the SAME card id with the missing
	 * identity fields through the store's idempotent merge — no new cards, no
	 * timeline rewrite. A desktop worker's real router id, when any sibling
	 * card already has one, is copied onto the blanks. Synthetic fw- ids are
	 * only for sessions that never received a router id, and an fw- stamp that
	 * landed on a desktop card is repaired once a real id shows up — that
	 * stamp is what made 「查看全部历史」call presentWorker with an id the
	 * router does not know. Runs from collectWorkers.
	 */
	private async backfillWorkerIdentity(routerId: string, cards: { id?: string; workerId?: string; workerSessionId?: string; text?: string; badge?: string; accent?: string }[]): Promise<void> {
		const bySession = new Map<string, (typeof cards)[number][]>();
		for (const card of cards) {
			if (!card.id || !card.workerSessionId || card.workerSessionId === routerId) {
				continue;
			}
			const list = bySession.get(card.workerSessionId) ?? [];
			list.push(card);
			bySession.set(card.workerSessionId, list);
		}
		const patches: ConversationItem[] = [];
		for (const [sessionId, list] of bySession) {
			const real = [...list].reverse().find(card => !!card.workerId && !card.workerId.startsWith('fw-'));
			const workerId = real?.workerId || FeishuBridge.phoneWorkerId(sessionId);
			const donor = real ?? [...list].reverse().find(card => card.badge || card.accent);
			for (const card of list) {
				if (!card.id || card.workerId === workerId) {
					continue;
				}
				// Another real router id on this card is a different binding.
				if (card.workerId && !card.workerId.startsWith('fw-')) {
					continue;
				}
				patches.push({
					...card,
					workerId,
					badge: card.badge || donor?.badge || (card.text ?? '').trim().slice(0, 24) || 'Worker',
					accent: card.accent || donor?.accent || FeishuBridge.accentFor(sessionId),
				} as ConversationItem);
			}
		}
		if (!patches.length) {
			return;
		}
		// Route through the panel hook when available so an OPEN board also
		// picks the healed identity up — the ✕ button renders from memory, and
		// a store-only patch leaves the visible card undeletable until reload.
		if (this.panel?.upsertRouterDispatchCard) {
			for (const patch of patches) {
				await this.panel.upsertRouterDispatchCard(routerId, patch).catch(() => undefined);
			}
		}
		await this.store!.upsertDispatchCards(routerId, patches).catch(err =>
			this.log(`identity backfill failed: ${errText(err)}`));
		this.log(`已为 ${patches.length} 张历史派发卡补齐身份（✕ 按钮恢复）`);
	}

	/** Newest Router session id, or undefined when none exists yet. */
	private async findRouterId(): Promise<string | undefined> {
		const metas = await this.store!.listSessions({ limit: 500 });
		return metas
			.filter(meta => meta.title === 'Router')
			.sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id;
	}

	private static statusLabel(raw: string): string {
		switch (raw) {
			case 'running': return '执行中';
			case 'queued': return '排队中';
			case 'done': case 'complete': case 'completed': case 'success': return '已完成';
			case 'error': case 'failed': return '失败';
			case 'awaiting': case 'waiting': return '等你输入';
			default: return raw || '—';
		}
	}

	private async listWorkers(openId: string): Promise<void> {
		let workers = (await this.collectWorkers())
			.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
			.slice(0, 12);
		if (!workers.length) {
			// Fallback for stores without a Router yet (fresh profile): the
			// bridge's own workers still carry the kind tag.
			const metas = (await this.store!.listSessions({ limit: 50 }))
				.filter(meta => meta.kind === 'worker')
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.slice(0, 12);
			workers = metas.map(meta => ({ sessionId: meta.id, title: meta.title, status: '' }));
		}
		if (!workers.length) {
			const mark = zcodeRuntimeLabel();
			await this.reply(openId, `${mark ? `当前是 ${mark}，` : ''}这边还没有 Worker。另一边的任务不会出现在这里。发送「新 <任务>」在这一边派发。`);
			return;
		}
		this.lastListing.set(openId, workers.map(w => ({ sessionId: w.sessionId, title: w.title })));
		const lines = workers.map((worker, index) => {
			const running = this.watcher?.isWatched(worker.sessionId) ?? false;
			const bound = this.selection.get(openId) === worker.sessionId ? ' ← 当前绑定' : '';
			const label = FeishuBridge.statusLabel(worker.status);
			const when = worker.ts ? ` · ${relTime(worker.ts)}` : '';
			const state = running ? '**执行中**' : `${label}`;
			return `${index + 1}. ${state}${when} — ${truncate(worker.title, 40)} ${FeishuBridge.workerTag(worker.sessionId)}${bound}`;
		});
		const mark = zcodeRuntimeLabel();
		const footer = '回复「选 N」绑定（之后发文本=追问它）；「新 <任务>」派发新任务；「当前」随时查看绑定。';
		await this.rest!.sendCard(PushTarget.p2p(openId), {
			header: mark ? `Worker 列表 · ${mark}` : 'Worker 列表',
			template: 'blue',
			markdown: mdForFeishuCard([
				`${mark ? `当前是 ${mark}，` : ''}与这台窗口的首页面板同源，按最近派发（不按文件夹拆开）：`,
				'',
				...lines,
				'',
				footer,
			].join('\n')),
			buttons: [
				{ text: '🔄 刷新列表', value: { t: 'cmd', c: '列表' } },
				{ text: '📍 当前绑定', value: { t: 'cmd', c: '当前' } },
			],
		}).catch(async err => {
			this.log(`列表卡片失败，退回纯文本：${errText(err)}`);
			await this.reply(openId, [
				`${mark ? `Worker 列表 · ${mark}` : 'Worker 列表'}（与这台窗口的首页面板同源，按最近派发）：`,
				...lines,
				'',
				footer,
			].join('\n'));
		});
	}

	private async selectWorker(openId: string, index: number): Promise<void> {
		const listing = this.lastListing.get(openId);
		if (!listing) {
			await this.reply(openId, '先发「列表」，再「选 N」。');
			return;
		}
		const hit = listing[index - 1];
		if (!hit) {
			await this.reply(openId, `序号超出范围（1-${listing.length}）。`);
			return;
		}
		this.selection.set(openId, hit.sessionId);
		this.selectionMeta.set(openId, hit);
		await this.reply(openId, `已绑定「${truncate(hit.title, 40)}」${FeishuBridge.workerTag(hit.sessionId)}。之后发的文本都发给它（回复会注明发给了谁）；「取消」解除，「列表」可换别的。`);
	}

	private async spawnWorker(openId: string, task: string, origin: 'explicit' | 'implicit'): Promise<void> {
		if (!task) {
			await this.reply(openId, '用法：新 <任务描述>');
			return;
		}
		const title = task.length > 24 ? `${task.slice(0, 24)}…` : task;
		try {
			// Make sure the Router exists first so this dispatch lands on the
			// desktop board exactly like a home-panel dispatch (best effort —
			// a missing Router must not block the spawn itself).
			await this.panel!.ensureRouterSession?.().catch(err =>
				this.log(`ensureRouterSession skipped: ${errText(err)}`));
			// Spawn WITHOUT the message: createWorkerSession fires its first
			// turn via `void startTurn(...)` — any throw there vanishes as an
			// unhandled rejection and the phone waits forever. Starting the turn
			// here makes every failure observable and reportable.
			const sessionId = await this.panel!.createWorkerSession({ title });
			// Stamp a desktop-shaped dispatch card (workerId/badge/accent) BEFORE
			// the turn starts, so the board card is fully aligned with desktop
			// dispatches — in particular the ✕ remove button, which the webview
			// only renders when the card's group carries a workerId. Without
			// this, markRouterDispatchRunning's fallback card (no workerId)
			// leaves the worker visible but undeletable. Best effort only: the
			// run itself must never depend on the card.
			const routerId = await this.findRouterId();
			if (routerId) {
				await this.stampDispatchCard(routerId, sessionId, task, title).catch(err =>
					this.log(`dispatch card stamp failed: ${errText(err)}`));
			}
			if (!this.panel?.startTurn) {
				await this.reply(openId, '当前版本的 ChatPanel 没有暴露执行入口，Worker 已创建但未启动。请更新后重试。');
				return;
			}
			await this.panel.startTurn(sessionId, task, { text: task });
			this.selection.set(openId, sessionId);
			this.selectionMeta.set(openId, { sessionId, title });
			this.watcher?.watch(sessionId, title, openId);
			this.watcher?.pollNow(sessionId);
			this.log(`已派发 Worker ${sessionId.slice(0, 8)}「${title}」`);
			const mark = zcodeRuntimeLabel();
			const dispatched = mark ? `已在 ${mark} 派发` : '已派发';
			const head = origin === 'implicit'
				? `${dispatched}新任务「${truncate(title, 40)}」（这条没有绑定的任务，就当作新任务了）`
				: `${dispatched}新任务「${truncate(title, 40)}」`;
			await this.reply(openId, [
				`🆕 ${head}，已自动绑定到它 ${FeishuBridge.workerTag(sessionId)}。`,
				'之后在这里发文本=追问它；结果卡片会标着任务名推送。',
				'要并行开别的任务：发「新 <任务>」（原任务继续跑，互不影响）；「列表」随时切换绑定。',
			].join('\n'));
		} catch (err) {
			const message = errText(err);
			this.log(`派发失败：${message}`);
			await this.reply(openId, `❌ 派发失败：${truncate(message, 500)}\n可在 VS Code 里直接发同一任务验证 Chat 面板本身是否正常。`);
		}
	}

	// ---------------- phone askUser (question cards) ----------------

	/** Entry from the completion watcher: a worker's turn is blocked on askUser. */
	private async handleAskPending(result: { sessionId: string; title: string; openId: string; question: string; ask?: FeishuAskSnapshot }): Promise<void> {
		const snapshot = result.ask;
		if (!snapshot || !snapshot.questions.length || !this.panel?.resolveAsk) {
			// No structured options (or old panel) — card buttons cannot work.
			await this.pushTextTo(result.sessionId, result.openId, `⏸「${truncate(result.title, 40)}」在等你回答：${truncate(result.question, 200)}\n这个问题没有可点选项，请打开电脑上的 Chat 面板作答；答完继续执行，结果仍会推送。`).catch(err => this.log(`reply failed: ${errText(err)}`));
			return;
		}
		if (this.askDrafts.has(snapshot.id)) {
			return; // card already out for this prompt
		}
		const draft: FeishuAskDraft = {
			sessionId: result.sessionId,
			openId: result.openId,
			title: result.title,
			snapshot,
			answers: new Map(),
			createdAt: Date.now(),
			needsSubmit: snapshot.questions.some(q => q.allowMultiple || q.allowFreeform),
		};
		this.askDrafts.set(snapshot.id, draft);
		this.sweepAskDrafts();
		await this.pushAskCard(draft, false);
	}

	/** The question card: one button per option, plus submit/skip. */
	private async pushAskCard(draft: FeishuAskDraft, isResend: boolean): Promise<void> {
		if (!this.rest) {
			return;
		}
		const target = PushTarget.p2p(draft.openId);
		const lines: string[] = [];
		if (isResend) {
			lines.push('（重发）这个 Worker 仍在等你作答：', '');
		}
		for (const [qi, q] of draft.snapshot.questions.entries()) {
			const head = q.header?.trim() || `问题 ${qi + 1}`;
			lines.push(`**${head}**`, q.prompt);
			for (const opt of q.options) {
				lines.push(`- ${opt.label}${opt.description ? ` —— ${truncate(opt.description, 60)}` : ''}`);
			}
			if (q.allowMultiple) {
				lines.push('> 可多选：点多个按钮后再点【提交答案】');
			}
			if (q.allowFreeform) {
				lines.push('> 也可直接回复一条文字作答');
			}
			lines.push('');
		}
		const multiQuestion = draft.snapshot.questions.length > 1;
		const buttons: FeishuCardButton[] = [];
		for (const [qi, q] of draft.snapshot.questions.entries()) {
			for (const [oi, opt] of q.options.entries()) {
				if (buttons.length >= 20) {
					break; // card sanity cap
				}
				buttons.push({
					text: truncate(`${multiQuestion ? `${qi + 1}-` : ''}${oi + 1}. ${opt.label}`, 20),
					value: { t: 'ask', pid: draft.snapshot.id, qid: q.id, oid: opt.id },
					type: 'default',
				});
			}
		}
		if (draft.needsSubmit) {
			buttons.push({ text: '✅ 提交答案', value: { t: 'askSubmit', pid: draft.snapshot.id }, type: 'primary' });
		}
		buttons.push({ text: '跳过', value: { t: 'askSkip', pid: draft.snapshot.id }, type: 'danger' });
		await this.rest.sendCard(target, {
			header: `🙋 ${truncate(draft.snapshot.title || draft.title || '需要你的输入', 40)}`,
			template: 'orange',
			markdown: mdForFeishuCard(lines.join('\n')),
			buttons,
		});
		this.log(`问题卡片已推送「${truncate(draft.title, 30)}」（${draft.snapshot.questions.length} 问 / ${buttons.length} 钮）`);
	}

	/** Card button taps arrive here through the same persistent connection. */
	private async handleCardAction(action: InboundFeishuCardAction): Promise<void> {
		const key = `${action.openId}:${action.messageId}:${stableValueKey(action.value)}`;
		const now = Date.now();
		const last = this.seenActions.get(key);
		this.seenActions.set(key, now);
		for (const [k, ts] of this.seenActions) {
			if (now - ts > 10_000) {
				this.seenActions.delete(k);
			}
		}
		if (last && now - last < 3_000) {
			return; // Feishu redelivery of the same tap
		}
		const allow = this.config?.allowOpenIds ?? [];
		if (!allow.length || !allow.includes(action.openId)) {
			this.log(`忽略未授权卡片点击（open_id=${action.openId}）`);
			return;
		}
		this.sweepAskDrafts();
		const type = asString(action.value.t) ?? '';
		const pid = asString(action.value.pid) ?? '';
		const draft = pid ? this.askDrafts.get(pid) : undefined;
		if (draft && !draft.cardMessageId) {
			draft.cardMessageId = action.messageId;
		}
		try {
			if (type === 'ask' && draft) {
				await this.recordAskPick(draft, asString(action.value.qid) ?? '', asString(action.value.oid) ?? '');
			} else if (type === 'askSubmit' && draft) {
				if (!this.tryFinalizeAsk(draft)) {
					await this.replyAtDraft(draft, this.askMissingHint(draft));
				}
			} else if (type === 'askSkip' && draft) {
				this.finalizeAsk(draft, { outcome: 'skipped', reason: 'skipped from Feishu' }, '已跳过。Worker 会收到“用户跳过了这个问题”并继续。');
			} else if (type === 'cmd') {
				const cmd = asString(action.value.c) ?? '';
				this.log(`卡片快捷按钮：${cmd}`);
				if (cmd) {
					await this.dispatch(action.openId, cmd);
				}
			} else {
				this.log(`未知卡片动作：${truncate(JSON.stringify(action.value), 120)}`);
			}
		} catch (err) {
			this.log(`卡片动作处理失败：${errText(err)}`);
		}
	}

	private async recordAskPick(draft: FeishuAskDraft, questionId: string, optionId: string): Promise<void> {
		const question = draft.snapshot.questions.find(q => q.id === questionId);
		const option = question?.options.find(o => o.id === optionId);
		if (!question || !option) {
			await this.replyAtDraft(draft, '这个选项已失效（问题可能已被回答），请看最新的问题卡片。');
			return;
		}
		const answer = draft.answers.get(questionId) ?? { optionIds: new Set<string>() };
		if (question.allowMultiple) {
			if (answer.optionIds.has(optionId)) {
				answer.optionIds.delete(optionId);
			} else {
				answer.optionIds.add(optionId);
			}
			draft.answers.set(questionId, answer);
			const picked = question.options.filter(o => answer.optionIds.has(o.id)).map(o => o.label);
			await this.replyAtDraft(draft, picked.length
				? `已选（多选）：${picked.map(l => truncate(l, 20)).join('、')}。选完点【提交答案】。`
				: `已取消全部选择（问题：${truncate(question.prompt, 40)}）。`);
			return;
		}
		answer.optionIds.clear();
		answer.optionIds.add(optionId);
		draft.answers.set(questionId, answer);
		if (!draft.needsSubmit && this.tryFinalizeAsk(draft)) {
			return; // finalized — the finalize notice already went out
		}
		await this.replyAtDraft(draft, `已选「${truncate(option.label, 30)}」${draft.needsSubmit ? '，选完点【提交答案】。' : '。'}`);
	}

	/** Every question answered → resolve into the panel and retire the card. */
	private tryFinalizeAsk(draft: FeishuAskDraft): boolean {
		const answers: Array<{ questionId: string; selectedOptionIds: string[]; freeText?: string }> = [];
		for (const q of draft.snapshot.questions) {
			const a = draft.answers.get(q.id);
			if (!a || (!a.optionIds.size && !a.freeText)) {
				return false;
			}
			answers.push({ questionId: q.id, selectedOptionIds: [...a.optionIds], freeText: a.freeText });
		}
		const summary = draft.snapshot.questions.map(q => {
			const a = draft.answers.get(q.id)!;
			if (a.freeText) {
				return truncate(a.freeText, 60);
			}
			return q.options.filter(o => a.optionIds.has(o.id)).map(o => truncate(o.label, 24)).join('、') || '（空）';
		}).join('；');
		this.finalizeAsk(draft, { outcome: 'answered', answers }, `✅ 已回答：${truncate(summary, 300)}\nWorker 继续执行，完成后推送结果。`);
		return true;
	}

	private finalizeAsk(draft: FeishuAskDraft, result: FeishuAskResult, notice: string): void {
		this.askDrafts.delete(draft.snapshot.id);
		try {
			this.panel?.resolveAsk?.(draft.snapshot.id, result);
		} catch (err) {
			this.log(`resolveAsk 异常：${errText(err)}`);
		}
		void this.replyAtDraft(draft, notice).catch(err => this.log(`reply failed: ${errText(err)}`));
		// Retire the question card (buttons vanish) — a nicety; latches off on rejection.
		if (this.rest && this.cardPatchSupport && draft.cardMessageId) {
			void this.rest.patchCard(draft.cardMessageId, {
				header: `🙋 ${truncate(draft.snapshot.title || draft.title || '问题', 40)}`,
				template: 'grey',
				markdown: `此卡片已作答，按钮已收回。\n\n${notice}`,
			}).catch(err => {
				const message = errText(err);
				if (/99991672|scope|权限/i.test(message)) {
					this.cardPatchSupport = false;
					this.log(`问题卡片回收已停用（缺 im:message:update 权限，不影响答题）：${truncate(message, 120)}`);
				} else {
					this.log(`问题卡片回收失败（不影响答题）：${truncate(message, 120)}`);
				}
			});
		}
	}

	private askMissingHint(draft: FeishuAskDraft): string {
		const missing = draft.snapshot.questions
			.filter(q => {
				const a = draft.answers.get(q.id);
				return !a || (!a.optionIds.size && !a.freeText);
			})
			.map(q => q.header?.trim() || truncate(q.prompt, 30));
		const freeform = draft.snapshot.questions.some(q => q.allowFreeform);
		return `还有问题没答：${missing.join('；')}。点选项按钮作答${freeform ? '，或直接回复文字' : ''}。`;
	}

	private async replyAtDraft(draft: FeishuAskDraft, text: string): Promise<void> {
		if (!this.rest) {
			return;
		}
		await this.rest.sendText(PushTarget.p2p(draft.openId), text);
	}

	private sweepAskDrafts(): void {
		const now = Date.now();
		for (const [id, draft] of this.askDrafts) {
			if (now - draft.createdAt > 30 * 60_000) {
				this.askDrafts.delete(id);
			}
		}
	}

	/**
	 * Inbound text while this worker's turn is blocked on askUser: consume it
	 * as the freeform answer instead of bouncing it off the busy-run check
	 * (the run map is occupied by the ask itself, so normal text would drop).
	 * Returns true when the text was consumed by an ask.
	 */
	private async interceptPendingAsk(openId: string, sessionId: string, text: string): Promise<boolean> {
		this.sweepAskDrafts();
		let draft = [...this.askDrafts.values()].find(d => d.sessionId === sessionId);
		if (!draft) {
			// Bridge restarted or the card predates this window — rebuild the
			// draft from the persisted pending question and resend the card.
			const session = await this.store!.getSession(sessionId).catch(() => undefined);
			const row = [...(session?.timeline ?? [])].reverse()
				.find(r => r?.kind === 'question' && (r as { status?: string }).status === 'pending');
			const snapshot = row ? normalizeAskSnapshot(row) : undefined;
			if (!snapshot || !snapshot.questions.length || !this.panel?.resolveAsk) {
				return false;
			}
			draft = {
				sessionId,
				openId,
				title: session?.title || 'Worker',
				snapshot,
				answers: new Map(),
				createdAt: Date.now(),
				needsSubmit: snapshot.questions.some(q => q.allowMultiple || q.allowFreeform),
			};
			this.askDrafts.set(snapshot.id, draft);
			await this.pushAskCard(draft, true).catch(err => this.log(`问题卡片重发失败：${errText(err)}`));
		}
		const freeform = draft.snapshot.questions.find(q => q.allowFreeform
			&& !(draft.answers.get(q.id)?.optionIds.size) && !draft.answers.get(q.id)?.freeText);
		if (freeform) {
			draft.answers.set(freeform.id, { optionIds: new Set(), freeText: text });
			const rest = draft.snapshot.questions.filter(q => {
				const a = draft.answers.get(q.id);
				return q.id !== freeform.id && (!a || (!a.optionIds.size && !a.freeText));
			});
			if (!rest.length && this.tryFinalizeAsk(draft)) {
				return true;
			}
			await this.rest?.sendText(PushTarget.p2p(openId), `已记录回答：「${truncate(text, 80)}」${rest.length ? `。${this.askMissingHint(draft)}` : '，点【提交答案】生效。'}`).catch(() => undefined);
			return true;
		}
		await this.rest?.sendText(PushTarget.p2p(openId), `它在等你在问题卡片上点选作答（或点【跳过】）——这条没有当作追问发出。${this.askMissingHint(draft)}`).catch(() => undefined);
		return true;
	}

	/** Follow-up path: send the text to the bound worker and ack with its name. */
	private async continueWorker(openId: string, sessionId: string, text: string): Promise<void> {
		const replyAt = (msg: string) => this.rest ? this.rest.sendText(PushTarget.p2p(openId), msg) : Promise.resolve();
		const session = await this.store!.getSession(sessionId);
		if (!session) {
			this.selection.delete(openId);
			this.selectionMeta.delete(openId);
			await replyAt('绑定的 Worker 会话已不存在（可能被清理）。已解除绑定；再发一次即派发新 Worker。').catch(() => undefined);
			return;
		}
		const title = (session.title ?? '').trim() || 'Worker';
		if (!this.panel?.startTurn) {
			await replyAt('当前版本的 ChatPanel 没有暴露续聊入口，请改为派发新 Worker。').catch(() => undefined);
			return;
		}
		// A pending askUser outranks a new turn — while a question is open the
		// run map holds the ask itself and ordinary text would bounce below.
		if (await this.interceptPendingAsk(openId, sessionId, text)) {
			return;
		}
		const runs = this.panel.runs;
		if (runs instanceof Map && runs.has(sessionId)) {
			await replyAt(`⏳「${truncate(title, 40)}」还在处理上一个任务，完成后会推送；这条没有发出，请稍后重发。`).catch(() => undefined);
			return;
		}
		// Mirror the follow-up onto the Router log so the desktop board shows
		// phone-issued turns too. Best effort — never blocks the send.
		if (this.panel.mirrorWorkerFollowUpToRouter) {
			await this.panel.mirrorWorkerFollowUpToRouter(text, sessionId).catch(err =>
				this.log(`mirror follow-up failed: ${errText(err)}`));
		}
		try {
			await this.panel.startTurn(sessionId, text, { text });
		} catch (err) {
			const message = errText(err);
			this.log(`续聊失败 ${sessionId.slice(0, 8)}：${message}`);
			await replyAt(`❌ 发给「${truncate(title, 40)}」失败：${truncate(message, 500)}`).catch(() => undefined);
			return;
		}
		this.selectionMeta.set(openId, { sessionId, title });
		this.watcher?.watch(sessionId, title, openId);
		this.watcher?.pollNow(sessionId);
		this.log(`续聊 ${sessionId.slice(0, 8)}：${truncate(text, 80)}`);
		await replyAt(`➡️ 已发给「${truncate(title, 40)}」${FeishuBridge.workerTag(sessionId)}，完成后在这里推送结果。`).catch(() => undefined);
	}

	// ---------------- outbound ----------------

	private async pushTextTo(_sessionId: string, openId: string, text: string): Promise<void> {
		if (!this.rest) {
			return;
		}
		await this.rest.sendText(PushTarget.p2p(openId), text);
	}

	private async pushResult(result: { sessionId: string; title: string; openId: string; content: string }): Promise<void> {
		if (!this.rest) {
			return;
		}
		// The turn just finished — the AI title summarization may have landed a
		// fresher, shorter worker title than the dispatch-time snapshot carried
		// by the watcher. Prefer it for the card header and the binding footer.
		const freshTitle = ((await this.store!.getSession(result.sessionId).catch(() => undefined))?.title ?? '').trim();
		const title = freshTitle || result.title;
		const tag = FeishuBridge.workerTag(result.sessionId);
		const content = result.content.length > 28000
			? `${result.content.slice(0, 28000)}\n…（过长已截断，完整结果在 IDE）`
			: result.content;
		this.log(`Worker「${title}」完成，推送结果到单聊（${result.content.length} 字）`);
		const mark = zcodeRuntimeLabel();
		// Binding footer: with everything in one chat this is how the phone
		// stays oriented — a result from a worker other than the current
		// binding gets a switch hint instead of silently adopting it.
		const bound = this.selection.get(result.openId);
		const footer = bound === result.sessionId
			? `📍 当前绑定就是它：「${truncate(title, 40)}」${tag}。继续发文本=追问这个任务；「新 <任务>」开新任务；「列表」切换。`
			: bound
				? `📍 注意：当前绑定是别的任务（发「当前」查看）。要追问这个「${truncate(title, 40)}」${tag}，先发「列表」再「选 N」。`
				: `📍 当前没有绑定任务：下一条文本会派发新 Worker。要追问这个「${truncate(title, 40)}」${tag}，先发「列表」再「选 N」。`;
		await this.rest.sendCard(PushTarget.p2p(result.openId), {
			header: mark ? `✅ ${mark} · ${truncate(title, 28)}` : `✅ ${truncate(title, 28)}`,
			template: 'green',
			markdown: mdForFeishuCard(`${content}\n\n---\n${footer}`),
			buttons: [
				{ text: '📋 列表', value: { t: 'cmd', c: '列表' } },
				{ text: '📍 当前', value: { t: 'cmd', c: '当前' } },
			],
		});
	}

	private async reply(openId: string, text: string): Promise<void> {
		if (!this.rest) {
			return;
		}
		await this.rest.sendText(PushTarget.p2p(openId), text);
	}
}

// CompletionWatcher exposes watchedIds() for status display.

// ---------------------------------------------------------------- module API

let bridge: FeishuBridge | undefined;
let configListener: vscode.Disposable | undefined;
let lastPanel: FeishuPanelAdapter | undefined;
let lastStore: IdeChatStore | undefined;

/**
 * Start (or restart) the bridge. `panel` is the ZCodeChatViewProvider from
 * registerChatPanel, typed `unknown` here because the adapter reaches
 * class-private members that block structural assignability.
 */
export async function ensureFeishuBridge(panel: unknown, store: IdeChatStore): Promise<void> {
	const adapter = panel as FeishuPanelAdapter;
	lastPanel = adapter;
	lastStore = store;
	bridge ??= new FeishuBridge();
	await bridge.start(adapter, store);
	configListener ??= vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('zcode.feishu') && bridge && lastPanel && lastStore) {
			void bridge.start(lastPanel, lastStore).catch(err =>
				console.warn('[zcode-chat] feishu bridge restart failed:', err));
		}
	});
}

export function disposeFeishuBridge(): void {
	configListener?.dispose();
	configListener = undefined;
	bridge?.dispose();
	bridge = undefined;
}

export function getFeishuBridgeStatus(): string {
	return bridge?.statusText() ?? '飞书桥：未启动';
}
