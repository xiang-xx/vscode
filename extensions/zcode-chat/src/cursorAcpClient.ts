/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Minimal Cursor Agent ACP client (newline-delimited JSON-RPC over stdio).
 * @see https://cursor.com/docs/cli/acp
 */

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as readline from 'readline';
import { getCursorAgentPath, type CursorAgentMode } from './brains';
import { assertDirectory, assertExecutableFile } from './processUtils';
import { resolveAgentBinary } from './cursorAuth';

export type AcpPermissionOutcome = 'allow-once' | 'allow-always' | 'reject-once';

export interface AcpSessionUpdate {
	sessionUpdate?: string;
	content?: { type?: string; text?: string };
	toolCallId?: string;
	/** Human-readable title for this invocation. */
	title?: string;
	/** Programmatic tool name (e.g. read_file). */
	name?: string;
	status?: string;
	kind?: string;
	raw: unknown;
}

export interface AcpMcpServerConfig {
	type?: 'stdio' | 'http' | 'sse';
	name: string;
	command?: string;
	args?: string[];
	env?: Array<{ name: string; value: string }> | Record<string, string>;
	url?: string;
}

export interface AcpClientOptions {
	cwd: string;
	mode?: CursorAgentMode;
	model?: string;
	/** Injected into session/new so Cursor can use IDE browser MCP tools. */
	mcpServers?: AcpMcpServerConfig[];
	/** Full environment for the agent child. Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	onUpdate?: (update: AcpSessionUpdate) => void;
	onPermission?: (params: unknown) => AcpPermissionOutcome | Promise<AcpPermissionOutcome>;
	onCursorNotification?: (method: string, params: unknown) => void | Promise<void>;
	onCursorRequest?: (method: string, params: unknown) => unknown | Promise<unknown>;
	onLog?: (line: string) => void;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	/** When set, activity (session/update etc.) resets this idle timer. */
	idleTimeoutMs?: number;
	timer?: ReturnType<typeof setTimeout>;
	method: string;
}

/** Idle timeout for long-running session/prompt (resets on ACP activity). */
const PROMPT_IDLE_TIMEOUT_MS = 10 * 60_000;
/** Absolute ceiling so a wedged prompt cannot hang forever. */
const PROMPT_MAX_TIMEOUT_MS = 60 * 60_000;
/**
 * cursor_login validates the stored Cursor credentials against Cursor's
 * backend; proxies and slow networks regularly push it past 20s. Give it a
 * generous budget and one fresh-process retry before surfacing the error.
 */
const AUTH_TIMEOUT_MS = 60_000;
const START_ATTEMPTS = 3;

/**
 * Transport failures the Cursor CLI labels RetriableError.
 * ACP runs with enableAgentRetries off, so these arrive here on the first drop:
 * "Stream ended without turnEnded", "Connection stalled" (30s inbound watchdog),
 * HTTP/2 CANCEL, stalled PINGs, and DNS blips.
 */
const TRANSPORT_DROP_RE = /RetriableError|ConnectError|Stream ended without turnEnded|Connection stalled|PING timed out|http\/2 stream closed|bidi_append_deadline_exceeded|ECONNRESET|socket hang up|EAI_AGAIN|ETIMEDOUT|ENOTFOUND|\[unavailable\]|\[deadline_exceeded\]|\[aborted\]/i;

export function isCursorTransportDrop(message: string): boolean {
	const text = message.trim();
	if (!text) {
		return false;
	}
	const head = text.split(/\r?\n/, 1)[0];
	return TRANSPORT_DROP_RE.test(head) || TRANSPORT_DROP_RE.test(text.slice(0, 500));
}

/** Assistant text that is only a leaked transport dump, not a real answer. */
export function isCursorTransportDump(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed || trimmed.length > 400 || trimmed.includes('```')) {
		return false;
	}
	if (/unauthorized|payment|subscription|not logged in|rate limit/i.test(trimmed)) {
		return false;
	}
	return /^(?:Error:\s*)?(?:RetriableError|ConnectError)\b/i.test(trimmed)
		|| /^Stream ended without turnEnded/i.test(trimmed)
		|| /^Connection stalled\b/i.test(trimmed);
}

/**
 * ACP replies put the actionable text in `error.data.details` and leave
 * `error.message` as a bare "Internal error". Keeping only the message threw
 * away every transport reason ("[aborted] Client network socket disconnected
 * before secure TLS connection was established"), so the retry regex never
 * matched and a single proxy blip ended the turn.
 */
function formatAcpError(error: { message?: string; code?: number; data?: unknown }): string {
	const head = error.message || `ACP error ${error.code ?? '?'}`;
	const data = error.data as { details?: unknown } | undefined;
	const details = typeof data?.details === 'string' ? data.details.trim() : '';
	if (details && !head.includes(details)) {
		return `${head}: ${details}`;
	}
	return head;
}

/** A direct (unproxied) TLS attempt to api2.cursor.sh stalls ~5s and then aborts. */
const DIRECT_TLS_DROP_RE = /Client network socket disconnected|before secure TLS connection/i;

/**
 * Shown after retries are exhausted. Must not contain "cancel" or "abort":
 * the chat panel treats those substrings as a user stop.
 */
export function formatCursorTransportFailure(attempts: number, last: string): string {
	const first = last.split(/\r?\n/, 1)[0].trim();
	const safe = first
		.replace(/\[canceled\]/gi, '[stream closed]')
		.replace(/cancel(?:led|ed|lation)?/gi, 'dropped')
		.replace(/abort(?:ed)?/gi, 'dropped');
	const hint = DIRECT_TLS_DROP_RE.test(last)
		? ' The TLS handshake to api2.cursor.sh never completed — set Settings › http.proxy (or check your VPN) and retry.'
		: '';
	return `Cursor Agent connection dropped after ${attempts} attempts. ${safe}${hint}`;
}

export class CursorAcpClient {
	private child?: ChildProcessWithoutNullStreams;
	/** Marks the current child as intentionally killed so its exit is not treated as a crash. */
	private retireChild?: () => void;
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private sessionId?: string;
	private closed = false;
	/** Ignore session/update replay while session/load is in flight. */
	private suppressUpdates = 0;

	constructor(private readonly options: AcpClientOptions) { }

	get activeSessionId(): string | undefined {
		return this.sessionId;
	}

	get isRunning(): boolean {
		return !!this.child && !this.closed && !this.child.killed && this.child.exitCode === null;
	}

	/** Process exited or dispose() ran. A new client is required. */
	get isClosed(): boolean {
		return this.closed;
	}

	async start(): Promise<void> {
		if (this.child) {
			return;
		}
		let lastError: unknown;
		for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
			try {
				await this.spawnChild();
				await this.request('initialize', {
					protocolVersion: 1,
					clientCapabilities: {
						fs: { readTextFile: false, writeTextFile: false },
						terminal: false,
					},
					clientInfo: { name: 'zcode-chat-acp', version: '0.1.0' },
				});
				await this.request('authenticate', { methodId: 'cursor_login' }, AUTH_TIMEOUT_MS);
				return;
			} catch (err) {
				lastError = err;
				this.teardownChild();
				const msg = err instanceof Error ? err.message : String(err);
				// A missing/misconfigured binary, a bad cwd, a crashed process, or
				// dispose() during start: respawning cannot fix these. Skip the retry.
				if (this.closed || /binary unavailable|^spawn |Cursor ACP cwd/i.test(msg)) {
					break;
				}
				// cursor_login is a network round-trip that loses the TLS handshake
				// about one time in five behind a proxy. Space the attempts out so a
				// respawn does not land in the same bad window.
				if (attempt < START_ATTEMPTS) {
					await new Promise(resolve => setTimeout(resolve, 800 * attempt));
				}
			}
		}
		throw new Error(formatAuthenticateFailure(lastError));
	}

	/**
	 * Spawn the agent child and wire its stdio. Split from start() so a failed
	 * authenticate can retry on a fresh process.
	 */
	private async spawnChild(): Promise<void> {
		const cwd = await assertDirectory(this.options.cwd, 'Cursor ACP cwd');
		const resolved = await resolveAgentBinary();
		const configured = getCursorAgentPath();
		const binPath = resolved.exists ? resolved.path : configured;
		let bin: string;
		try {
			bin = await assertExecutableFile(binPath);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Cursor agent binary unavailable (${msg}). Install Cursor CLI or set zcode.cursor.agentPath.`,
			);
		}

		const spawnArgs: string[] = [];
		if (this.options.mode && this.options.mode !== 'agent') {
			spawnArgs.push('--mode', this.options.mode);
		}
		if (this.options.model?.trim()) {
			spawnArgs.push('--model', this.options.model.trim());
		}
		// Auto-approve project MCP (incl. zcode-ide-browser) when the CLI supports it.
		spawnArgs.push('--approve-mcps');
		spawnArgs.push('acp');

		try {
			this.child = spawn(bin, spawnArgs, {
				cwd,
				env: this.options.env ? { ...this.options.env } : { ...process.env },
				stdio: ['pipe', 'pipe', 'pipe'],
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(formatSpawnError(msg, bin, cwd));
		}

		const child = this.child;
		// Set when this child is killed on purpose (start retry, dispose()): its
		// exit must not be reported as a crash, and its late output ignored.
		let retired = false;
		this.retireChild = () => {
			retired = true;
			if (this.child === child) {
				this.child = undefined;
			}
		};

		child.on('error', (err) => {
			if (retired) {
				return;
			}
			const msg = err instanceof Error ? err.message : String(err);
			this.failAll(new Error(formatSpawnError(msg, bin, cwd)));
		});
		child.on('close', (code) => {
			if (retired) {
				return;
			}
			this.closed = true;
			this.failAll(new Error(`Cursor agent exited (code ${code ?? '?'})`));
		});

		child.stderr.on('data', (chunk: Buffer) => {
			this.options.onLog?.(chunk.toString('utf8'));
		});

		const rl = readline.createInterface({ input: child.stdout });
		rl.on('line', line => {
			if (this.closed || this.child !== child) {
				return;
			}
			void this.onLine(line);
		});
	}

	/** Kill the current child without marking the client permanently closed. */
	private teardownChild(): void {
		const child = this.child;
		this.retireChild?.();
		this.retireChild = undefined;
		if (!child) {
			return;
		}
		try {
			child.stdin.end();
		} catch { /* ignore */ }
		child.kill('SIGTERM');
	}

	async newSession(): Promise<string> {
		const cwd = await assertDirectory(this.options.cwd, 'Cursor ACP cwd');
		const mcpServers = (this.options.mcpServers ?? []).map(normalizeAcpMcpServer);
		const result = await this.request('session/new', {
			cwd,
			mcpServers,
		}) as { sessionId?: string };
		if (!result?.sessionId) {
			throw new Error('ACP session/new did not return sessionId');
		}
		this.sessionId = result.sessionId;
		return result.sessionId;
	}

	/**
	 * Resume a Cursor chat created earlier in this turn.
	 * History replay notifications are swallowed so the timeline is not duplicated.
	 * Cursor sometimes returns "Session not found" for a live id; callers should
	 * fall back to session/new.
	 */
	async loadSession(sessionId: string): Promise<string> {
		const cwd = await assertDirectory(this.options.cwd, 'Cursor ACP cwd');
		const mcpServers = (this.options.mcpServers ?? []).map(normalizeAcpMcpServer);
		this.suppressUpdates++;
		try {
			const result = await this.request('session/load', {
				sessionId,
				cwd,
				mcpServers,
			}, 30_000) as { sessionId?: string };
			this.sessionId = result?.sessionId || sessionId;
			return this.sessionId;
		} finally {
			this.suppressUpdates--;
		}
	}

	async prompt(text: string): Promise<{ stopReason?: string }> {
		if (!this.sessionId) {
			await this.newSession();
		}
		const result = await this.request('session/prompt', {
			sessionId: this.sessionId,
			prompt: [{ type: 'text', text }],
		}, {
			timeoutMs: PROMPT_MAX_TIMEOUT_MS,
			idleTimeoutMs: PROMPT_IDLE_TIMEOUT_MS,
		}) as { stopReason?: string };
		return result ?? {};
	}

	async cancel(timeoutMs = 120_000): Promise<void> {
		if (!this.sessionId || this.closed) {
			return;
		}
		try {
			await this.request('session/cancel', { sessionId: this.sessionId }, timeoutMs);
		} catch {
			// ignore
		}
	}

	dispose(): void {
		this.closed = true;
		this.failAll(new Error('ACP client disposed'));
		this.teardownChild();
	}

	private request(
		method: string,
		params: unknown,
		options: number | { timeoutMs?: number; idleTimeoutMs?: number } = 120_000,
	): Promise<unknown> {
		if (!this.child || this.closed) {
			return Promise.reject(new Error('ACP client is not running'));
		}
		const timeoutMs = typeof options === 'number' ? options : (options.timeoutMs ?? 120_000);
		const idleTimeoutMs = typeof options === 'number' ? undefined : options.idleTimeoutMs;
		const id = this.nextId++;
		const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
		return new Promise((resolve, reject) => {
			const pending: Pending = {
				method,
				idleTimeoutMs,
				resolve: (value) => {
					this.clearPendingTimer(pending);
					resolve(value);
				},
				reject: (err) => {
					this.clearPendingTimer(pending);
					reject(err);
				},
			};
			this.armPendingTimer(id, pending, idleTimeoutMs ?? timeoutMs, idleTimeoutMs
				? `ACP ${method} idle-timed out after ${idleTimeoutMs}ms without activity`
				: `ACP ${method} timed out after ${timeoutMs}ms`);
			// Absolute ceiling when using idle reset.
			if (idleTimeoutMs) {
				const hard = setTimeout(() => {
					if (this.pending.has(id)) {
						this.pending.delete(id);
						pending.reject(new Error(`ACP ${method} exceeded max duration ${timeoutMs}ms`));
					}
				}, timeoutMs);
				const prevReject = pending.reject;
				const prevResolve = pending.resolve;
				pending.reject = (err) => { clearTimeout(hard); prevReject(err); };
				pending.resolve = (value) => { clearTimeout(hard); prevResolve(value); };
			}
			this.pending.set(id, pending);
			this.child!.stdin.write(payload + '\n', err => {
				if (err) {
					this.pending.delete(id);
					pending.reject(err instanceof Error ? err : new Error(String(err)));
				}
			});
		});
	}

	private clearPendingTimer(pending: Pending): void {
		if (pending.timer) {
			clearTimeout(pending.timer);
			pending.timer = undefined;
		}
	}

	private armPendingTimer(id: number, pending: Pending, ms: number, message: string): void {
		this.clearPendingTimer(pending);
		pending.timer = setTimeout(() => {
			if (this.pending.has(id)) {
				this.pending.delete(id);
				pending.reject(new Error(message));
			}
		}, ms);
	}

	/** Reset idle timers for long-running requests (e.g. session/prompt) while ACP is active. */
	private bumpIdleTimers(): void {
		for (const [id, pending] of this.pending) {
			if (!pending.idleTimeoutMs) {
				continue;
			}
			this.armPendingTimer(
				id,
				pending,
				pending.idleTimeoutMs,
				`ACP ${pending.method} idle-timed out after ${pending.idleTimeoutMs}ms without activity`,
			);
		}
	}

	private respond(id: number, result: unknown): void {
		if (!this.child || this.closed) {
			return;
		}
		this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
	}

	private async onLine(line: string): Promise<void> {
		const trimmed = line.trim();
		if (!trimmed) {
			return;
		}
		let msg: {
			id?: number;
			method?: string;
			params?: unknown;
			result?: unknown;
			error?: { message?: string; code?: number; data?: unknown };
		};
		try {
			msg = JSON.parse(trimmed);
		} catch {
			this.options.onLog?.(`ACP non-JSON: ${trimmed.slice(0, 200)}`);
			return;
		}

		if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
			const waiter = this.pending.get(msg.id);
			if (!waiter) {
				return;
			}
			this.pending.delete(msg.id);
			if (msg.error) {
				waiter.reject(new Error(formatAcpError(msg.error)));
			} else {
				waiter.resolve(msg.result);
			}
			return;
		}

		if (msg.method === 'session/update') {
			if (this.suppressUpdates > 0) {
				return;
			}
			this.bumpIdleTimers();
			const params = msg.params as { update?: Record<string, unknown> } | undefined;
			const update = params?.update ?? {};
			this.options.onUpdate?.({
				sessionUpdate: typeof update.sessionUpdate === 'string' ? update.sessionUpdate : undefined,
				content: update.content as AcpSessionUpdate['content'],
				toolCallId: typeof update.toolCallId === 'string' ? update.toolCallId : undefined,
				title: typeof update.title === 'string' ? update.title : undefined,
				name: typeof update.name === 'string' ? update.name : undefined,
				status: typeof update.status === 'string' ? update.status : undefined,
				kind: typeof update.kind === 'string' ? update.kind : undefined,
				raw: update,
			});
			return;
		}

		if (msg.method === 'session/request_permission' && msg.id !== undefined) {
			this.bumpIdleTimers();
			const outcome = await this.options.onPermission?.(msg.params) ?? 'allow-once';
			// ACP permission result shape used by Cursor CLI docs / avante.
			this.respond(msg.id, { outcome: { outcome: 'selected', optionId: outcome } });
			return;
		}

		if (msg.method?.startsWith('cursor/') && msg.id !== undefined) {
			this.bumpIdleTimers();
			try {
				const result = await this.options.onCursorRequest?.(msg.method, msg.params);
				this.respond(msg.id, result ?? defaultCursorResponse(msg.method));
			} catch (err) {
				this.respond(msg.id, {
					outcome: { outcome: 'rejected', reason: err instanceof Error ? err.message : String(err) },
				});
			}
			return;
		}

		if (msg.method?.startsWith('cursor/')) {
			if (this.suppressUpdates > 0) {
				return;
			}
			this.bumpIdleTimers();
			void this.options.onCursorNotification?.(msg.method, msg.params);
		}
	}

	private failAll(err: Error): void {
		for (const [, waiter] of this.pending) {
			waiter.reject(err);
		}
		this.pending.clear();
	}
}

/**
 * Wraps a failed start() for the chat timeline. Must not contain "cancel" or
 * "abort": the chat panel treats those substrings as a user stop. Common
 * causes: a stale Cursor CLI login (cursor_login then waits for an interactive
 * flow that never completes over ACP stdio), or the auth round-trip losing its
 * TLS handshake when the proxy is missing or SOCKS-only.
 */
function formatAuthenticateFailure(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err);
	const msg = raw
		.replace(/\[aborted\]/gi, '[stream closed]')
		.replace(/cancel(?:led|ed|lation)?/gi, 'dropped')
		.replace(/abort(?:ed)?/gi, 'dropped');
	if (DIRECT_TLS_DROP_RE.test(raw)) {
		return `Cursor Agent could not reach api2.cursor.sh (${msg}). The TLS handshake never completed — set Settings › http.proxy to an HTTP/HTTPS proxy (a SOCKS-only proxy cannot be used here) or fix your VPN, then retry.`;
	}
	if (/authenticate/i.test(raw)) {
		return `${msg} — usually a stale Cursor login or a proxy blocking the auth check. Run \`agent login\` in a terminal (or set CURSOR_API_KEY) and retry; if already logged in, check the proxy.`;
	}
	return msg;
}

function formatSpawnError(message: string, bin: string, cwd: string): string {
	if (/ENOTDIR/i.test(message)) {
		return `spawn ENOTDIR — agent="${bin}" cwd="${cwd}" (cwd must be a directory; agent path must not be a folder)`;
	}
	if (/ENOENT/i.test(message)) {
		return `spawn ENOENT — Cursor agent not found at "${bin}". Install CLI or set zcode.cursor.agentPath.`;
	}
	return `Cursor agent spawn failed: ${message}`;
}

function defaultCursorResponse(method: string): unknown {
	if (method === 'cursor/ask_question') {
		return { outcome: { outcome: 'skipped', reason: 'UI not implemented' } };
	}
	if (method === 'cursor/create_plan') {
		return { outcome: { outcome: 'accepted' } };
	}
	return { outcome: { outcome: 'cancelled' } };
}

function normalizeAcpMcpServer(server: AcpMcpServerConfig): Record<string, unknown> {
	const envEntries = Array.isArray(server.env)
		? server.env
		: server.env
			? Object.entries(server.env).map(([name, value]) => ({ name, value: String(value) }))
			: [];
	if (server.type === 'http' || server.type === 'sse') {
		return {
			type: server.type,
			name: server.name,
			url: server.url,
		};
	}
	return {
		type: 'stdio',
		name: server.name,
		command: server.command || '',
		args: Array.isArray(server.args) ? server.args : [],
		env: envEntries,
	};
}
