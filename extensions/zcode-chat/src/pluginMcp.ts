/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tiny MCP client for plugin servers.
 * Stdio uses Content-Length framing (and newline JSON if a server writes that).
 * HTTP speaks the streamable-HTTP POST shape: one JSON-RPC body, JSON or SSE back.
 * Both ZCode's tool loop and Cursor's ACP session use the same server config;
 * this client is only the ZCode side.
 */

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';

export interface McpEndpoint {
	type: 'stdio' | 'http';
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	url?: string;
}

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

interface LiveClient {
	endpointKey: string;
	stdio?: StdioMcp;
	http?: HttpMcp;
}

const pool = new Map<string, LiveClient>();

export function endpointKey(endpoint: McpEndpoint): string {
	return JSON.stringify({
		type: endpoint.type,
		command: endpoint.command ?? '',
		args: endpoint.args ?? [],
		cwd: endpoint.cwd ?? '',
		url: endpoint.url ?? '',
	});
}

export async function mcpListTools(endpoint: McpEndpoint, timeoutMs: number): Promise<McpToolInfo[]> {
	const client = await ensureClient(endpoint, timeoutMs);
	const result = await rpc(client, 'tools/list', {}, timeoutMs) as { tools?: unknown };
	const tools = Array.isArray(result?.tools) ? result.tools : [];
	const out: McpToolInfo[] = [];
	for (const tool of tools) {
		if (!tool || typeof tool !== 'object') {
			continue;
		}
		const rec = tool as { name?: unknown; description?: unknown; inputSchema?: unknown };
		if (typeof rec.name !== 'string' || !rec.name.trim()) {
			continue;
		}
		out.push({
			name: rec.name,
			description: typeof rec.description === 'string' ? rec.description : undefined,
			inputSchema: rec.inputSchema && typeof rec.inputSchema === 'object'
				? rec.inputSchema as Record<string, unknown>
				: undefined,
		});
	}
	return out;
}

export async function mcpCallTool(
	endpoint: McpEndpoint,
	toolName: string,
	args: Record<string, unknown>,
	timeoutMs: number,
): Promise<string> {
	const client = await ensureClient(endpoint, timeoutMs);
	const result = await rpc(client, 'tools/call', { name: toolName, arguments: args }, timeoutMs) as {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
	};
	const text = (result?.content ?? [])
		.map(part => (typeof part?.text === 'string' ? part.text : ''))
		.filter(Boolean)
		.join('\n');
	if (result?.isError) {
		throw new Error(text || 'MCP tool failed');
	}
	return text;
}

export function disposeMcpClients(): void {
	for (const client of pool.values()) {
		client.stdio?.kill();
	}
	pool.clear();
}

async function ensureClient(endpoint: McpEndpoint, timeoutMs: number): Promise<LiveClient> {
	const key = endpointKey(endpoint);
	const existing = pool.get(key);
	if (existing?.stdio && !existing.stdio.alive) {
		pool.delete(key);
	} else if (existing) {
		return existing;
	}
	if (endpoint.type === 'http') {
		if (!endpoint.url) {
			throw new Error('HTTP MCP server is missing a url');
		}
		const http = new HttpMcp(endpoint.url);
		await http.initialize(timeoutMs);
		const client: LiveClient = { endpointKey: key, http };
		pool.set(key, client);
		return client;
	}
	if (!endpoint.command) {
		throw new Error('stdio MCP server is missing a command');
	}
	const stdio = new StdioMcp(endpoint);
	try {
		await stdio.initialize(timeoutMs);
	} catch (err) {
		stdio.kill();
		throw err;
	}
	const client: LiveClient = { endpointKey: key, stdio };
	pool.set(key, client);
	return client;
}

async function rpc(client: LiveClient, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
	try {
		if (client.http) {
			return await client.http.request(method, params, timeoutMs);
		}
		if (!client.stdio) {
			throw new Error('MCP client is not connected');
		}
		return await client.stdio.request(method, params, timeoutMs);
	} catch (err) {
		pool.delete(client.endpointKey);
		client.stdio?.kill();
		throw err;
	}
}

class HttpMcp {
	private sessionId: string | undefined;

	constructor(private readonly url: string) { }

	async initialize(timeoutMs: number): Promise<void> {
		await this.request('initialize', {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: { name: 'zcode-chat', version: '0.1.0' },
		}, timeoutMs);
		await this.notify('notifications/initialized', timeoutMs);
	}

	async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
		const payload = await this.post({ jsonrpc: '2.0', id: 1, method, params }, timeoutMs);
		if (payload && typeof payload === 'object' && 'error' in payload) {
			const error = (payload as { error?: { message?: string } }).error;
			throw new Error(error?.message || `MCP ${method} failed`);
		}
		return (payload as { result?: unknown } | undefined)?.result;
	}

	private async notify(method: string, timeoutMs: number): Promise<void> {
		await this.post({ jsonrpc: '2.0', method }, timeoutMs);
	}

	private async post(body: unknown, timeoutMs: number): Promise<unknown> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			'MCP-Protocol-Version': '2024-11-05',
		};
		if (this.sessionId) {
			headers['Mcp-Session-Id'] = this.sessionId;
		}
		const response = await fetch(this.url, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const session = response.headers.get('mcp-session-id');
		if (session) {
			this.sessionId = session;
		}
		const text = await response.text();
		if (response.status === 202 || !text.trim()) {
			return undefined;
		}
		const payload = parseRpcBody(text);
		if (!response.ok && !payload) {
			throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 180)}`);
		}
		return payload;
	}
}

class StdioMcp {
	private readonly child: ChildProcessWithoutNullStreams;
	private buffer = Buffer.alloc(0);
	private nextId = 1;
	private stderr = '';
	private dead = false;
	private readonly pending = new Map<number, {
		resolve: (value: unknown) => void;
		reject: (err: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();

	constructor(endpoint: McpEndpoint) {
		this.child = spawn(endpoint.command || '', endpoint.args ?? [], {
			cwd: endpoint.cwd,
			env: { ...process.env, ...endpoint.env },
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
		this.child.stderr.on('data', (chunk: Buffer) => {
			this.stderr = (this.stderr + chunk.toString('utf8')).slice(-800);
		});
		this.child.on('error', err => this.failAll(err instanceof Error ? err.message : String(err)));
		this.child.on('exit', () => this.failAll(this.stderr.trim() || 'MCP server exited'));
	}

	get alive(): boolean {
		return !this.dead && this.child.exitCode === null;
	}

	async initialize(timeoutMs: number): Promise<void> {
		await this.request('initialize', {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: { name: 'zcode-chat', version: '0.1.0' },
		}, timeoutMs);
		this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
	}

	request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
		if (this.dead) {
			return Promise.reject(new Error(this.stderr.trim() || 'MCP server is not running'));
		}
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP ${method} timed out`));
				this.kill();
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.send({ jsonrpc: '2.0', id, method, params });
		});
	}

	kill(): void {
		this.dead = true;
		this.child.kill('SIGTERM');
	}

	private send(message: unknown): void {
		const json = Buffer.from(JSON.stringify(message), 'utf8');
		const header = Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, 'utf8');
		this.child.stdin.write(Buffer.concat([header, json]));
	}

	private onData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (this.buffer.length) {
			if (this.buffer[0] === 0x7b) {
				const nl = this.buffer.indexOf(0x0a);
				if (nl < 0) {
					return;
				}
				const line = this.buffer.slice(0, nl).toString('utf8').trim();
				this.buffer = this.buffer.slice(nl + 1);
				if (line) {
					this.onMessage(line);
				}
				continue;
			}
			const headerEnd = this.buffer.indexOf('\r\n\r\n');
			if (headerEnd < 0) {
				return;
			}
			const header = this.buffer.slice(0, headerEnd).toString('utf8');
			const match = /Content-Length:\s*(\d+)/i.exec(header);
			if (!match) {
				this.buffer = this.buffer.slice(headerEnd + 4);
				continue;
			}
			const length = Number(match[1]);
			const start = headerEnd + 4;
			if (this.buffer.length < start + length) {
				return;
			}
			const body = this.buffer.slice(start, start + length).toString('utf8');
			this.buffer = this.buffer.slice(start + length);
			this.onMessage(body);
		}
	}

	private onMessage(body: string): void {
		let message: { id?: number; result?: unknown; error?: { message?: string }; method?: string };
		try {
			message = JSON.parse(body) as typeof message;
		} catch {
			return;
		}
		if (typeof message.id !== 'number') {
			return;
		}
		if (message.method) {
			const result = message.method === 'ping' ? {} : undefined;
			this.send(result
				? { jsonrpc: '2.0', id: message.id, result }
				: { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
			return;
		}
		const pending = this.pending.get(message.id);
		if (!pending) {
			return;
		}
		clearTimeout(pending.timer);
		this.pending.delete(message.id);
		if (message.error) {
			pending.reject(new Error(message.error.message || 'MCP request failed'));
			return;
		}
		pending.resolve(message.result);
	}

	private failAll(message: string): void {
		if (this.dead) {
			return;
		}
		this.dead = true;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error(message));
		}
		this.pending.clear();
	}
}

function parseRpcBody(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed.startsWith('{')) {
		try {
			return JSON.parse(trimmed) as unknown;
		} catch {
			return undefined;
		}
	}
	let last: unknown;
	for (const line of trimmed.split(/\r?\n/)) {
		const data = line.startsWith('data:') ? line.slice(5).trim() : '';
		if (!data.startsWith('{')) {
			continue;
		}
		try {
			last = JSON.parse(data) as unknown;
		} catch {
			continue;
		}
	}
	return last;
}
