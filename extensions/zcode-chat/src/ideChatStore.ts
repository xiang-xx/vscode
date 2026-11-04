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
	/** Session role on the Super Agent board: Router shell vs spawned worker. */
	kind?: 'router' | 'worker';
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

/**
 * True when `title` is still a placeholder / first-message truncation, not an
 * AI (or user-chosen) short label. Used so title summarization can replace the
 * long provisional stamp after the first completed turn.
 */
export function isProvisionalSessionTitle(title: string | undefined, messages: IdeChatMessage[]): boolean {
	if (!title || title === '新对话' || title === 'Worker') {
		return true;
	}
	const fallback = titleFromMessages(messages);
	if (title === fallback) {
		return true;
	}
	const first = messages.find(m => m.role === 'user' && m.content.trim() && !m.content.startsWith('此前对话摘要：'));
	if (!first) {
		return false;
	}
	const oneLine = first.content.replace(/\s+/g, ' ').trim();
	if (!oneLine) {
		return false;
	}
	if (title === oneLine) {
		return true;
	}
	// createWorkerSession / router dispatch used to stamp message.slice(0, N)
	// (sometimes with a trailing …). AI titles are capped at 80 chars, so only
	// longer prefixes of the first user message are still provisional.
	if (title.endsWith('…')) {
		const stem = title.slice(0, -1);
		if (stem && oneLine.startsWith(stem)) {
			return true;
		}
	}
	if (title.length > 80 && oneLine.startsWith(title)) {
		return true;
	}
	return false;
}

function toMeta(session: IdeChatSession): IdeChatSessionMeta {
	return {
		id: session.id,
		title: session.title,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		source: session.source,
		kind: session.kind,
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
		// Serialize within this process AND across windows: the chain keeps
		// one extension host ordered, the lock file keeps concurrent ext
		// hosts (Code - OSS + ZCode.app windows sharing ~/.zcode) from
		// read-modify-writing the index over each other — a lost update is
		// how worker sessions used to vanish from the list.
		const run = () => this.withIndexLock(op);
		this.writeChain = this.writeChain.then(run, run);
		return this.writeChain;
	}

	/**
	 * Cross-process mutex around index mutations. O_EXCL create + steal on
	 * staleness; on timeout we proceed unlocked (best effort) so a wedged
	 * lock can never block the chat UI forever.
	 */
	private async withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
		await this.ensureDirs();
		const lockPath = path.join(this.rootDir, 'index.lock');
		const deadline = Date.now() + 10_000;
		let locked = false;
		while (!locked && Date.now() < deadline) {
			try {
				await fs.writeFile(lockPath, String(process.pid), { flag: 'wx' });
				locked = true;
			} catch (err) {
				if ((err as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') {
					throw err;
				}
				try {
					const st = await fs.stat(lockPath);
					// Crashed window left the lock behind — steal it.
					if (Date.now() - st.mtimeMs > 5_000) {
						await fs.unlink(lockPath).catch(() => undefined);
					}
				} catch {
					// Lock vanished between create-fail and stat — retry now.
				}
				await new Promise(resolve => setTimeout(resolve, 25 + Math.random() * 25));
			}
		}
		try {
			return await fn();
		} finally {
			if (locked) {
				await fs.unlink(lockPath).catch(() => undefined);
			}
		}
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
		await this.atomicWrite(this.indexPath, JSON.stringify(index, null, 2));
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
	createDraftSession(partial?: Partial<Pick<IdeChatSession, 'source' | 'workspaceRoot' | 'provider' | 'model' | 'title' | 'kind'>>): IdeChatSession {
		const now = Date.now();
		return {
			id: newId(),
			title: partial?.title?.trim() || '新对话',
			createdAt: now,
			updatedAt: now,
			source: partial?.source ?? IDE_CHAT_SOURCE_ZCODE,
			kind: partial?.kind,
			workspaceRoot: partial?.workspaceRoot,
			provider: partial?.provider,
			model: partial?.model,
			messages: [],
			timeline: [],
			todos: [],
		};
	}

	async createSession(partial?: Partial<Pick<IdeChatSession, 'source' | 'workspaceRoot' | 'provider' | 'model' | 'title' | 'kind'>>): Promise<IdeChatSession> {
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
			// Keep the Super Agent Router even while it has no messages yet —
			// it is a dedicated dispatch surface, not an abandoned draft.
			if (meta.title === 'Router') {
				continue;
			}
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
			// A session belongs to the folder it was created in: once it has a
			// workspaceRoot, a save issued from a window whose folder differs
			// must not re-tag it (re-tagging is how windows used to "steal"
			// each other's Router/worker boards). Sessions saved before roots
			// were tracked (undefined) still adopt the current folder.
			const existing = await this.getSession(next.id);
			if (existing?.workspaceRoot && !sameWorkspaceRoot(existing.workspaceRoot, next.workspaceRoot)) {
				next.workspaceRoot = existing.workspaceRoot;
			}
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

	/**
	 * Merge dispatch cards into a session's timeline without rewriting the
	 * rest of it. Used by Router-board rehydration: a whole-session save from
	 * a window that never loaded the cards used to wipe them (lost update),
	 * so card recovery must be a targeted, idempotent read-merge-write that
	 * leaves every other timeline item untouched.
	 */
	async upsertDispatchCards(sessionId: string, cards: ConversationItem[]): Promise<void> {
		const incoming = new Map(cards.map(card => [card.id, card]));
		if (!incoming.size) {
			return;
		}
		await this.enqueue(async () => {
			const session = await this.getSession(sessionId);
			if (!session) {
				return;
			}
			const timeline: ConversationItem[] = [];
			let changed = false;
			for (const item of session.timeline ?? []) {
				if (item?.kind === 'dispatch' && incoming.has(item.id)) {
					timeline.push(incoming.get(item.id)!);
					incoming.delete(item.id);
					changed = true;
				} else {
					timeline.push(item);
				}
			}
			for (const card of incoming.values()) {
				timeline.push(card);
				changed = true;
			}
			if (!changed) {
				return;
			}
			session.timeline = timeline;
			session.updatedAt = Date.now();
			await this.writeSessionFile(session);
			const index = await this.readIndex();
			const meta = index.sessions.find(s => s.id === sessionId);
			if (meta && meta.updatedAt !== session.updatedAt) {
				meta.updatedAt = session.updatedAt;
				await this.writeIndex(index);
			}
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
			// Board-removal registry hygiene: deleting a Router drops its whole
			// suppression list; deleting a worker session lifts the key from
			// every list so the registry never references dead sessions.
			const removals = await this.readRemovedWorkersMap();
			if (removals.size) {
				let removalsChanged = removals.delete(id);
				for (const [routerId, keys] of removals) {
					const next = keys.filter(key => key !== id);
					if (next.length !== keys.length) {
						removalsChanged = true;
						if (next.length) {
							removals.set(routerId, next);
						} else {
							removals.delete(routerId);
						}
					}
				}
				if (removalsChanged) {
					await this.writeRemovedWorkersMap(removals);
				}
			}
		});
	}

	/**
	 * Board-removal registry (removed-workers.json).
	 *
	 * "✕'d off the Router board" is a durable, user-global intent. The workbench
	 * roster lives in per-app workspace storage, but board rehydration runs in
	 * every editor sharing ~/.zcode — without this registry a removed worker's
	 * session (roster history row / `kind: 'worker'` tag) would resurrect its
	 * dispatch card on the next window open. Values mix worker session ids and
	 * worker ids; matching treats either as removed. Kept in its own file so
	 * whole-session saves from another window can never drop it.
	 *
	 * Keys are workspace-scoped, not router-scoped: a removal is recorded under
	 * BOTH the Router session id (legacy compat) and `wr:<normalized root>` —
	 * the opened folder. The window's Router binding can legitimately change
	 * between launches (another Router holds more dispatch cards, a second
	 * editor app binds its own), and a removal pinned to one router id used to
	 * vanish with it, resurrecting the card. Reads therefore union the router
	 * key, the workspace key, and every sibling Router of the same folder.
	 */
	async getRemovedWorkers(routerId: string, opts?: { workspaceRoot?: string }): Promise<string[]> {
		const map = await this.readRemovedWorkersMap();
		const out = new Set<string>(map.get(routerId) ?? []);
		const root = opts?.workspaceRoot;
		if (root) {
			for (const key of map.get(this.workspaceRemovalKey(root)) ?? []) {
				out.add(key);
			}
			for (const sibling of await this.siblingRouterIds(root)) {
				for (const key of map.get(sibling) ?? []) {
					out.add(key);
				}
			}
		}
		return [...out];
	}

	async addRemovedWorkers(routerId: string, keys: string[], opts?: { workspaceRoot?: string }): Promise<void> {
		const add = keys.filter(key => typeof key === 'string' && !!key && key !== routerId);
		if (!routerId || !add.length) {
			return;
		}
		const targets = [routerId];
		if (opts?.workspaceRoot) {
			targets.push(this.workspaceRemovalKey(opts.workspaceRoot));
		}
		await this.enqueue(async () => {
			const map = await this.readRemovedWorkersMap();
			for (const target of targets) {
				const next = new Set(map.get(target) ?? []);
				for (const key of add) {
					next.add(key);
				}
				map.set(target, [...next]);
			}
			await this.writeRemovedWorkersMap(map);
		});
	}

	/** Lift a removal (e.g. worker restored from the history menu and re-boarded). */
	async clearRemovedWorkers(routerId: string, keys: string[], opts?: { workspaceRoot?: string }): Promise<void> {
		if (!routerId) {
			return;
		}
		const drop = new Set(keys.filter(key => typeof key === 'string' && !!key));
		if (!drop.size) {
			return;
		}
		const targets = [routerId];
		if (opts?.workspaceRoot) {
			targets.push(this.workspaceRemovalKey(opts.workspaceRoot));
			for (const sibling of await this.siblingRouterIds(opts.workspaceRoot)) {
				targets.push(sibling);
			}
		}
		await this.enqueue(async () => {
			const map = await this.readRemovedWorkersMap();
			let changed = false;
			for (const target of targets) {
				const current = map.get(target);
				if (!current || !current.some(key => drop.has(key))) {
					continue;
				}
				const next = current.filter(key => !drop.has(key));
				if (next.length) {
					map.set(target, next);
				} else {
					map.delete(target);
				}
				changed = true;
			}
			if (changed) {
				await this.writeRemovedWorkersMap(map);
			}
		});
	}

	/**
	 * Self-heal: drop timeline dispatch cards whose worker keys sit in the
	 * removal registry. The registry is the durable ✕ intent, but the Router
	 * session file is shared by every editor app on this machine — a window on
	 * older code (or one whose workbench roster still lists the worker as
	 * live) can write the card right back after the removal. Rehydration prunes
	 * first so suppression stays authoritative over whatever is on disk, not
	 * just over rebuild candidates. Returns whether the timeline changed.
	 */
	async pruneSuppressedDispatchCards(sessionId: string): Promise<boolean> {
		let changed = false;
		await this.enqueue(async () => {
			const session = await this.getSession(sessionId);
			if (!session) {
				return;
			}
			const removed = new Set(await this.getRemovedWorkers(sessionId, { workspaceRoot: session.workspaceRoot }));
			if (!removed.size) {
				return;
			}
			const timeline = session.timeline ?? [];
			const next = timeline.filter(item => {
				if (item?.kind !== 'dispatch') {
					return true;
				}
				const dispatch = item as Extract<ConversationItem, { kind: 'dispatch' }>;
				return !(removed.has(dispatch.workerSessionId ?? '') || (dispatch.workerId ? removed.has(dispatch.workerId) : false));
			});
			if (next.length === timeline.length) {
				return;
			}
			changed = true;
			session.timeline = next;
			session.updatedAt = Date.now();
			await this.writeSessionFile(session);
			const index = await this.readIndex();
			const meta = index.sessions.find(s => s.id === sessionId);
			if (meta && meta.updatedAt !== session.updatedAt) {
				meta.updatedAt = session.updatedAt;
				await this.writeIndex(index);
			}
		});
		return changed;
	}

	/** Registry key that scopes board removals to the opened folder. */
	private workspaceRemovalKey(workspaceRoot: string): string {
		return `wr:${normalizeWorkspaceRoot(workspaceRoot)}`;
	}

	/** Router session ids sharing `workspaceRoot` (legacy per-router removal keys live under these). */
	private async siblingRouterIds(workspaceRoot: string): Promise<string[]> {
		try {
			const index = await this.readIndex();
			return index.sessions
				.filter(meta => (meta.kind === 'router' || meta.title === 'Router')
					&& sameWorkspaceRoot(meta.workspaceRoot, workspaceRoot))
				.slice(0, 30)
				.map(meta => meta.id);
		} catch {
			return [];
		}
	}

	private removedWorkersPath(): string {
		return path.join(this.rootDir, 'removed-workers.json');
	}

	private async readRemovedWorkersMap(): Promise<Map<string, string[]>> {
		try {
			const raw = await fs.readFile(this.removedWorkersPath(), 'utf8');
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			const map = new Map<string, string[]>();
			for (const [routerId, keys] of Object.entries(parsed ?? {})) {
				if (Array.isArray(keys)) {
					const list = keys.filter((key): key is string => typeof key === 'string' && !!key);
					if (list.length) {
						map.set(routerId, list);
					}
				}
			}
			return map;
		} catch {
			return new Map();
		}
	}

	private async writeRemovedWorkersMap(map: Map<string, string[]>): Promise<void> {
		await this.ensureDirs();
		await this.atomicWrite(this.removedWorkersPath(), JSON.stringify(Object.fromEntries(map), null, 2));
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
		await this.ensureDirs();
		await this.atomicWrite(this.sessionPath(session.id), JSON.stringify(session, null, 2));
	}

	/**
	 * Atomic replace that survives concurrent writers in OTHER processes.
	 *
	 * The store root is user-global, and every editor window runs its own
	 * extension host with its own IdeChatStore — the in-process writeChain
	 * cannot serialize them. With a fixed `<file>.tmp` name two windows used
	 * to race (A writes tmp, B writes tmp, A renames — tmp gone, B renames)
	 * and the loser threw ENOENT up to `ensureRouterSession`, surfacing as
	 * "Opening the Router chat session failed: rename … index.json.tmp".
	 * A per-write unique tmp name keeps `rename` atomic with no cross-process
	 * clobbering; transient fs errors get a short retry as belt and braces.
	 */
	private async atomicWrite(file: string, data: string): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			// Unique per call: never shared with another process or write.
			const tmp = `${file}.${process.pid}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.tmp`;
			try {
				await fs.writeFile(tmp, data, 'utf8');
				await fs.rename(tmp, file);
				return;
			} catch (err) {
				try {
					await fs.unlink(tmp);
				} catch {
					// best-effort cleanup
				}
				const code = (err as NodeJS.ErrnoException | undefined)?.code;
				const transient = code === 'ENOENT' || code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
				if (attempt >= 2 || !transient) {
					throw err;
				}
				await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
			}
		}
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
