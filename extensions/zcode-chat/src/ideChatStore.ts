/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE chat history shared by ZCode, DeepSeek, and future AI modules.
 *
 * Storage is user-global, but each opened folder only sees its own sessions.
 * `workspaceRoot` is the workspace folder that was open when the session was
 * saved. Listing, open tabs, and the restored active session stay inside that
 * root so `/Users/xiang/apps` and `/Users/xiang/projects` do not mix.
 *
 * On-disk layout (user-global, not per-extension):
 *   ~/.zcode/v2/ide-chat/
 *     index.json
 *     sessions/<id>.json
 *
 * Canonical continuation data is `messages` (role/content). Rich `timeline` is
 * optional UI state; other modules may ignore it and still resume from messages.
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ConversationItem, TodoItem } from './conversation';

export const IDE_CHAT_STORE_VERSION = 1;
export const IDE_CHAT_SOURCE_ZCODE = 'zcode';
export const IDE_CHAT_SOURCE_CURSOR = 'cursor';
export const IDE_CHAT_SOURCE_DEEPSEEK = 'deepseek';

export type IdeChatSource =
	| typeof IDE_CHAT_SOURCE_ZCODE
	| typeof IDE_CHAT_SOURCE_CURSOR
	| typeof IDE_CHAT_SOURCE_DEEPSEEK
	| string;

export interface IdeChatMessage {
	role: 'user' | 'assistant' | 'system';
	content: string;
}

export interface IdeChatSessionMeta {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	source: IdeChatSource;
	workspaceRoot?: string;
	provider?: string;
	model?: string;
}

export interface IdeChatSession extends IdeChatSessionMeta {
	/** Provider-agnostic turns — DeepSeek / ZCode both continue from this. */
	messages: IdeChatMessage[];
	/** Rich ZCode (or other) timeline; optional for cross-module resume. */
	timeline?: ConversationItem[];
	todos?: TodoItem[];
}

interface IdeChatIndex {
	version: number;
	activeSessionId?: string;
	/** Recently opened session tabs (Cursor-style); closed tabs stay in history. */
	openTabIds?: string[];
	sessions: IdeChatSessionMeta[];
}

export interface IdeChatStoreOptions {
	/** Override root (tests). Default: ~/.zcode/v2/ide-chat */
	rootDir?: string;
}

function defaultRoot(): string {
	return path.join(os.homedir(), '.zcode', 'v2', 'ide-chat');
}

function newId(): string {
	return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function titleFromMessages(messages: IdeChatMessage[]): string {
	const first = messages.find(m => m.role === 'user' && m.content.trim() && !m.content.startsWith('此前对话摘要：'));
	if (!first) {
		return messages.some(m => m.content.startsWith('此前对话摘要：')) ? '已压缩的对话' : '新对话';
	}
	const oneLine = first.content.replace(/\s+/g, ' ').trim();
	return oneLine.length > 42 ? `${oneLine.slice(0, 42)}…` : oneLine;
}

function toMeta(session: IdeChatSession): IdeChatSessionMeta {
	return {
		id: session.id,
		title: session.title,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		source: session.source,
		workspaceRoot: session.workspaceRoot,
		provider: session.provider,
		model: session.model,
	};
}

/** Compare workspace folders without trailing slashes or macOS/Windows case differences. */
export function sameWorkspaceRoot(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) {
		return false;
	}
	return normalizeWorkspaceRoot(a) === normalizeWorkspaceRoot(b);
}

function normalizeWorkspaceRoot(root: string): string {
	let resolved = path.resolve(root);
	if (resolved.length > 1) {
		resolved = resolved.replace(/[/\\]+$/, '');
	}
	if (process.platform === 'win32' || process.platform === 'darwin') {
		resolved = resolved.toLowerCase();
	}
	return resolved;
}

function sessionInWorkspace(meta: IdeChatSessionMeta | undefined, workspaceRoot?: string): boolean {
	if (!meta) {
		return false;
	}
	return !workspaceRoot || sameWorkspaceRoot(meta.workspaceRoot, workspaceRoot);
}

/** Next open tab in the same root. Does not fall through to another folder's history. */
function nextOpenTabId(index: IdeChatIndex, workspaceRoot?: string): string | undefined {
	for (const id of index.openTabIds ?? []) {
		if (sessionInWorkspace(index.sessions.find(s => s.id === id), workspaceRoot)) {
			return id;
		}
	}
	return undefined;
}

function uniquePreserve(ids: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of ids) {
		if (seen.has(id)) {
			continue;
		}
		seen.add(id);
		out.push(id);
	}
	return out;
}

/** Ensure `id` is in the open-tab list without reshuffling existing order. */
function ensureTabPresent(existing: string[] | undefined, id: string, position: 'front' | 'end' = 'end'): string[] {
	const tabs = uniquePreserve(existing ?? []);
	if (tabs.includes(id)) {
		return tabs;
	}
	return position === 'front' ? [id, ...tabs] : [...tabs, id];
}

export class IdeChatStore {
	readonly rootDir: string;
	private readonly indexPath: string;
	private readonly sessionsDir: string;
	private writeChain: Promise<void> = Promise.resolve();

	constructor(options?: IdeChatStoreOptions) {
		this.rootDir = options?.rootDir ?? defaultRoot();
		this.indexPath = path.join(this.rootDir, 'index.json');
		this.sessionsDir = path.join(this.rootDir, 'sessions');
	}

	private enqueue(op: () => Promise<void>): Promise<void> {
		this.writeChain = this.writeChain.then(op, op);
		return this.writeChain;
	}

	private async ensureDirs(): Promise<void> {
		await fs.mkdir(this.sessionsDir, { recursive: true });
	}

	private async readIndex(): Promise<IdeChatIndex> {
		try {
			const raw = await fs.readFile(this.indexPath, 'utf8');
			const parsed = JSON.parse(raw) as IdeChatIndex;
			if (!parsed || !Array.isArray(parsed.sessions)) {
				return { version: IDE_CHAT_STORE_VERSION, sessions: [] };
			}
			return {
				version: parsed.version ?? IDE_CHAT_STORE_VERSION,
				activeSessionId: parsed.activeSessionId,
				openTabIds: Array.isArray(parsed.openTabIds)
					? parsed.openTabIds.filter((id): id is string => typeof id === 'string')
					: undefined,
				sessions: parsed.sessions,
			};
		} catch {
			return { version: IDE_CHAT_STORE_VERSION, sessions: [] };
		}
	}

	private async writeIndex(index: IdeChatIndex): Promise<void> {
		await this.ensureDirs();
		const tmp = `${this.indexPath}.tmp`;
		await fs.writeFile(tmp, JSON.stringify(index, null, 2), 'utf8');
		await fs.rename(tmp, this.indexPath);
	}

	private sessionPath(id: string): string {
		return path.join(this.sessionsDir, `${id}.json`);
	}

	async listSessions(opts?: { workspaceRoot?: string; limit?: number }): Promise<IdeChatSessionMeta[]> {
		const index = await this.readIndex();
		let list = [...index.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
		if (opts?.workspaceRoot) {
			list = list.filter(s => sameWorkspaceRoot(s.workspaceRoot, opts.workspaceRoot));
		}
		if (opts?.limit && opts.limit > 0) {
			list = list.slice(0, opts.limit);
		}
		return list;
	}

	async getActiveSessionId(): Promise<string | undefined> {
		const index = await this.readIndex();
		return index.activeSessionId;
	}

	async getSession(id: string): Promise<IdeChatSession | undefined> {
		try {
			const raw = await fs.readFile(this.sessionPath(id), 'utf8');
			return JSON.parse(raw) as IdeChatSession;
		} catch {
			return undefined;
		}
	}

	/**
	 * Session to restore for this window. With `workspaceRoot`, a marker that
	 * points at another folder is ignored; we resume this folder's open tab
	 * instead of the global last-active chat.
	 */
	async getActiveSession(opts?: { workspaceRoot?: string }): Promise<IdeChatSession | undefined> {
		const index = await this.readIndex();
		const root = opts?.workspaceRoot;
		const inScope = (id: string | undefined) =>
			sessionInWorkspace(index.sessions.find(s => s.id === id), root);
		let id = inScope(index.activeSessionId) ? index.activeSessionId : undefined;
		if (!id && root) {
			const tabs = (index.openTabIds ?? []).filter(tabId => inScope(tabId));
			const byId = new Map(index.sessions.map(s => [s.id, s]));
			id = [...tabs].sort((a, b) => (byId.get(b)?.updatedAt ?? 0) - (byId.get(a)?.updatedAt ?? 0))[0];
		}
		if (!id) {
			return undefined;
		}
		return this.getSession(id);
	}

	/** In-memory draft only — not written to history until the first real message. */
	createDraftSession(partial?: Partial<Pick<IdeChatSession, 'source' | 'workspaceRoot' | 'provider' | 'model' | 'title'>>): IdeChatSession {
		const now = Date.now();
		return {
			id: newId(),
			title: partial?.title?.trim() || '新对话',
			createdAt: now,
			updatedAt: now,
			source: partial?.source ?? IDE_CHAT_SOURCE_ZCODE,
			workspaceRoot: partial?.workspaceRoot,
			provider: partial?.provider,
			model: partial?.model,
			messages: [],
			timeline: [],
			todos: [],
		};
	}

	async createSession(partial?: Partial<Pick<IdeChatSession, 'source' | 'workspaceRoot' | 'provider' | 'model' | 'title'>>): Promise<IdeChatSession> {
		const session = this.createDraftSession(partial);
		await this.enqueue(async () => {
			await this.ensureDirs();
			await this.writeSessionFile(session);
			const index = await this.readIndex();
			index.sessions = [toMeta(session), ...index.sessions.filter(s => s.id !== session.id)];
			index.activeSessionId = session.id;
			index.openTabIds = ensureTabPresent(index.openTabIds, session.id, 'end');
			await this.writeIndex(index);
		});
		return session;
	}

	/** Drop empty sessions that were never used (and clear active if it pointed at one). */
	async pruneEmptySessions(): Promise<void> {
		const index = await this.readIndex();
		const emptyIds: string[] = [];
		for (const meta of index.sessions) {
			const session = await this.getSession(meta.id);
			if (!session || session.messages.length === 0) {
				emptyIds.push(meta.id);
			}
		}
		if (!emptyIds.length) {
			return;
		}
		await this.enqueue(async () => {
			const current = await this.readIndex();
			for (const id of emptyIds) {
				try {
					await fs.unlink(this.sessionPath(id));
				} catch {
					// missing ok
				}
			}
			const drop = new Set(emptyIds);
			current.sessions = current.sessions.filter(s => !drop.has(s.id));
			current.openTabIds = (current.openTabIds ?? []).filter(id => !drop.has(id));
			if (current.activeSessionId && drop.has(current.activeSessionId)) {
				const dropped = index.sessions.find(s => s.id === current.activeSessionId);
				current.activeSessionId = nextOpenTabId(current, dropped?.workspaceRoot);
			}
			await this.writeIndex(current);
		});
	}

	async setActiveSession(id: string): Promise<IdeChatSession | undefined> {
		const session = await this.getSession(id);
		if (!session) {
			return undefined;
		}
		await this.enqueue(async () => {
			const index = await this.readIndex();
			index.activeSessionId = id;
			index.openTabIds = ensureTabPresent(index.openTabIds, id, 'end');
			await this.writeIndex(index);
		});
		return session;
	}

	/**
	 * Persist a session. `background: true` is for writes that must not reopen a
	 * closed tab or steal the active marker (flush of a parked / closed session).
	 */
	async saveSession(session: IdeChatSession, opts?: { background?: boolean }): Promise<void> {
		const next: IdeChatSession = {
			...session,
			title: session.title?.trim() || titleFromMessages(session.messages) || '新对话',
			updatedAt: Date.now(),
		};
		await this.enqueue(async () => {
			await this.ensureDirs();
			await this.writeSessionFile(next);
			const index = await this.readIndex();
			const meta = toMeta(next);
			index.sessions = [meta, ...index.sessions.filter(s => s.id !== next.id)];
			if (!opts?.background) {
				index.activeSessionId = next.id;
				index.openTabIds = ensureTabPresent(index.openTabIds, next.id, 'end');
			}
			await this.writeIndex(index);
		});
	}

	async getOpenTabIds(opts?: { workspaceRoot?: string }): Promise<string[]> {
		const index = await this.readIndex();
		const inScope = (id: string) =>
			sessionInWorkspace(index.sessions.find(s => s.id === id), opts?.workspaceRoot);
		const tabs = (index.openTabIds ?? []).filter(inScope);
		const active = index.activeSessionId;
		if (active && inScope(active) && !tabs.includes(active)) {
			tabs.push(active);
		}
		return tabs;
	}

	async setOpenTabIds(ids: string[]): Promise<void> {
		await this.enqueue(async () => {
			const index = await this.readIndex();
			const known = new Set(index.sessions.map(s => s.id));
			index.openTabIds = uniquePreserve(ids.filter(id => known.has(id)));
			await this.writeIndex(index);
		});
	}

	async closeOpenTab(id: string): Promise<void> {
		await this.enqueue(async () => {
			const index = await this.readIndex();
			const closing = index.sessions.find(s => s.id === id);
			index.openTabIds = (index.openTabIds ?? []).filter(tabId => tabId !== id);
			// getOpenTabIds() force-appends activeSessionId; drop it as well so a
			// closed tab cannot resurrect itself on the next read. Stay in this
			// folder — the next tab must not be another workspace's chat.
			if (index.activeSessionId === id) {
				index.activeSessionId = nextOpenTabId(index, closing?.workspaceRoot);
			}
			await this.writeIndex(index);
		});
	}

	async deleteSession(id: string): Promise<void> {
		await this.enqueue(async () => {
			try {
				await fs.unlink(this.sessionPath(id));
			} catch {
				// missing ok
			}
			const index = await this.readIndex();
			const removed = index.sessions.find(s => s.id === id);
			index.sessions = index.sessions.filter(s => s.id !== id);
			index.openTabIds = (index.openTabIds ?? []).filter(tabId => tabId !== id);
			if (index.activeSessionId === id) {
				index.activeSessionId = nextOpenTabId(index, removed?.workspaceRoot);
			}
			await this.writeIndex(index);
		});
	}

	/**
	 * Build canonical messages from a ZCode timeline (user + final assistant only).
	 * Other modules should prefer reading `session.messages` directly.
	 */
	static messagesFromTimeline(items: ConversationItem[]): IdeChatMessage[] {
		const out: IdeChatMessage[] = [];
		for (const item of items) {
			if (item.kind === 'summary' && item.text.trim()) {
				out.push({ role: 'user', content: `此前对话摘要：\n${item.text}` });
			}
			if (item.kind === 'user' && item.text.trim()) {
				out.push({ role: 'user', content: item.text });
			}
			if (item.kind === 'assistant' && !item.streaming && item.text.trim()) {
				out.push({ role: 'assistant', content: item.text });
			}
		}
		return out;
	}

	private async writeSessionFile(session: IdeChatSession): Promise<void> {
		const file = this.sessionPath(session.id);
		const tmp = `${file}.tmp`;
		await fs.writeFile(tmp, JSON.stringify(session, null, 2), 'utf8');
		await fs.rename(tmp, file);
	}
}

/** API surface exported from the zcode-chat extension for DeepSeek / Cursor / others. */
export interface IdeChatExtensionApi {
	readonly ideChat: IdeChatStore;
	readonly sources: {
		zcode: typeof IDE_CHAT_SOURCE_ZCODE;
		cursor: typeof IDE_CHAT_SOURCE_CURSOR;
		deepseek: typeof IDE_CHAT_SOURCE_DEEPSEEK;
	};
}
