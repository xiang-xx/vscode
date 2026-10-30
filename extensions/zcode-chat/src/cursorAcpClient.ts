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

export class CursorAcpClient {
	private child?: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private sessionId?: string;
	private closed = false;

	constructor(private readonly options: AcpClientOptions) { }

	get activeSessionId(): string | undefined {
		return this.sessionId;
	}

	async start(): Promise<void> {
		if (this.child) {
			return;
		}
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
				env: { ...process.env },
				stdio: ['pipe', 'pipe', 'pipe'],
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(formatSpawnError(msg, bin, cwd));
		}

		this.child.on('error', (err) => {
			const msg = err instanceof Error ? err.message : String(err);
			this.failAll(new Error(formatSpawnError(msg, bin, cwd)));
		});
		this.child.on('close', (code) => {
			this.closed = true;
			this.failAll(new Error(`Cursor agent exited (code ${code ?? '?'})`));
		});

		this.child.stderr.on('data', (chunk: Buffer) => {
			this.options.onLog?.(chunk.toString('utf8'));
		});

		const rl = readline.createInterface({ input: this.child.stdout });
		rl.on('line', line => void this.onLine(line));

		await this.request('initialize', {
			protocolVersion: 1,
			clientCapabilities: {
				fs: { readTextFile: false, writeTextFile: false },
				terminal: false,
			},
			clientInfo: { name: 'zcode-chat-acp', version: '0.1.0' },
		});

		await this.request('authenticate', { methodId: 'cursor_login' }, 20_000);
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

	async cancel(): Promise<void> {
		if (!this.sessionId || this.closed) {
			return;
		}
		try {
			await this.request('session/cancel', { sessionId: this.sessionId });
		} catch {
			// ignore
		}
	}

	dispose(): void {
		this.closed = true;
		this.failAll(new Error('ACP client disposed'));
		try {
			this.child?.stdin.end();
		} catch { /* ignore */ }
		this.child?.kill('SIGTERM');
		this.child = undefined;
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
			error?: { message?: string; code?: number };
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
				waiter.reject(new Error(msg.error.message || `ACP error ${msg.error.code}`));
			} else {
				waiter.resolve(msg.result);
			}
			return;
		}

		if (msg.method === 'session/update') {
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
