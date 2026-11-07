/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * DeepSeek official Messages transport, following deepseek-harness
 * `@deepseek-ai/dsh-llm-deepseek`:
 *   POST {baseURL}/v1/messages
 *   header `x-api-key` (no Bearer), `anthropic-version: 2023-06-01`, redirects refused.
 * Thinking is `thinking.type` plus `output_config.effort` (`off` | `low` | `high` | `max`).
 * Prior assistant thinking blocks are replayed with their signatures.
 *
 * Harness-only telemetry (`dsh_session_log`, `dsh_plugin_packages`, anonymous user id)
 * is not sent.
 */

const SECRET_KEY = 'zcode.deepseek.apiKey';
const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic';
/** Official listing context window for V4 Flash / V4 Pro. */
const DEFAULT_CONTEXT_WINDOW = 1_048_576;
/**
 * Per-request output ceiling. Harness defaults to 256000; this stays under that
 * so one agent turn cannot run away, while still leaving room for thinking plus tools.
 */
export const DEEPSEEK_MAX_OUTPUT_TOKENS = 32_768;
const USER_AGENT = 'zcode-chat/0.1.0 (+https://zcode.z.ai)';

const REASONING_LEVELS = ['off', 'low', 'high', 'max'] as const;

export interface DeepseekModelOption {
	id: string;
	label: string;
	reasoningLevels: readonly string[];
	defaultReasoningLevel: string;
}

/** Advisory catalog from dsh-llm-deepseek `DEFAULT_MODELS`. Listing replaces this when it succeeds. */
const DEFAULT_MODELS: readonly DeepseekModelOption[] = [
	{
		id: 'deepseek-flash',
		label: 'DeepSeek-V4.1-Flash',
		reasoningLevels: REASONING_LEVELS,
		defaultReasoningLevel: 'high',
	},
	{
		id: 'deepseek-v4-pro',
		label: 'DeepSeek-V4-Pro',
		reasoningLevels: REASONING_LEVELS,
		defaultReasoningLevel: 'high',
	},
];

export interface DeepseekReplayMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content?: string | null;
	tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
	tool_call_id?: string;
	reasoning_content?: string | null;
	reasoning_blocks?: ReadonlyArray<{ text: string; signature?: string }>;
}

export interface DeepseekThinkingBlock {
	text: string;
	signature?: string;
}

export interface DeepseekParsedTurn {
	content: string;
	reasoning: string;
	reasoningBlocks: DeepseekThinkingBlock[];
	toolCalls: Array<{ id: string; name: string; arguments: string }>;
	usageTokens?: number;
}

interface UsageBucket {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

type AccBlock =
	| { type: 'thinking'; text: string; signature: string }
	| { type: 'text' }
	| { type: 'tool'; id: string; name: string; arguments: string };

export interface DeepseekAccumulator {
	content: string;
	blocks: Map<number, AccBlock>;
	usage: UsageBucket;
}

let secrets: vscode.SecretStorage | undefined;
let catalogOverride: DeepseekModelOption[] | undefined;
const contextWindows = new Map<string, number>();

for (const model of DEFAULT_MODELS) {
	contextWindows.set(model.id, DEFAULT_CONTEXT_WINDOW);
}

export function bindDeepseekSecrets(storage: vscode.SecretStorage): void {
	secrets = storage;
}

export function deepseekCatalog(): readonly DeepseekModelOption[] {
	return catalogOverride?.length ? catalogOverride : DEFAULT_MODELS;
}

export function deepseekContextWindow(modelId: string | undefined): number | undefined {
	const id = modelId?.trim();
	if (!id) {
		return undefined;
	}
	return contextWindows.get(id);
}

export async function resolveDeepseekApiKey(): Promise<string | undefined> {
	const fromSecret = (await secrets?.get(SECRET_KEY))?.trim();
	if (fromSecret) {
		return fromSecret;
	}
	const fromEnv = process.env.DEEPSEEK_API_KEY?.trim();
	if (fromEnv) {
		return fromEnv;
	}
	const fromConfig = vscode.workspace.getConfiguration('zcode').get<string>('deepseek.apiKey')?.trim();
	return fromConfig || undefined;
}

export async function promptDeepseekApiKey(): Promise<string | undefined> {
	const value = await vscode.window.showInputBox({
		title: 'DeepSeek API Key',
		prompt: '官方 API Key，以 x-api-key 发给 api.deepseek.com。留空取消。也可设置环境变量 DEEPSEEK_API_KEY。',
		password: true,
		ignoreFocusOut: true,
		placeHolder: 'sk-…',
	});
	const key = value?.trim();
	if (!key) {
		return undefined;
	}
	if (!secrets) {
		throw new Error('DeepSeek key store is not ready. Reload the window and try again.');
	}
	await secrets.store(SECRET_KEY, key);
	return key;
}

/** Ask for a key when none is configured, then refresh the official model list. */
export async function prepareDeepseekProvider(): Promise<void> {
	let key = await resolveDeepseekApiKey();
	if (!key) {
		key = await promptDeepseekApiKey();
	}
	if (!key) {
		return;
	}
	try {
		await refreshDeepseekCatalog(key);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/HTTP 401|HTTP 403|authentication|invalid api key/i.test(message)) {
			void vscode.window.showWarningMessage(`DeepSeek API Key 被拒绝：${message}`);
		}
	}
}

export function deepseekMessagesUrl(): string {
	return `${messagesRoot(configuredBaseUrl())}/messages`;
}

export function deepseekHeaders(apiKey: string, stream: boolean): Record<string, string> {
	return {
		'content-type': 'application/json',
		accept: stream ? 'text/event-stream' : 'application/json',
		'x-api-key': apiKey,
		'anthropic-version': '2023-06-01',
		'user-agent': USER_AGENT,
	};
}

export type DeepseekEffort = 'off' | 'low' | 'high' | 'max';

/** Map the chat thinking picker onto DeepSeek `output_config.effort`. */
export function deepseekEffort(reasoningLevel: string): DeepseekEffort {
	const level = (reasoningLevel || '').trim().toLowerCase();
	if (level === 'off' || level === 'disabled' || level === 'none' || level === 'nothink') {
		return 'off';
	}
	if (level === 'low' || level === 'minimal') {
		return 'low';
	}
	if (level === 'max' || level === 'xhigh' || level === 'ultra') {
		return 'max';
	}
	return 'high';
}

export function buildDeepseekBody(options: {
	model: string;
	reasoningLevel: string;
	messages: readonly DeepseekReplayMessage[];
	tools: ReadonlyArray<{ name: string; description: string; input_schema: Record<string, unknown> }>;
	stream: boolean;
}): Record<string, unknown> {
	const { system, messages } = toDeepseekMessages(options.messages);
	const effort = deepseekEffort(options.reasoningLevel);
	return {
		model: options.model,
		max_tokens: DEEPSEEK_MAX_OUTPUT_TOKENS,
		stream: options.stream,
		messages,
		...(system ? { system } : {}),
		...(options.tools.length ? { tools: options.tools } : {}),
		thinking: { type: effort === 'off' ? 'disabled' : 'enabled' },
		...(effort === 'off' ? {} : { output_config: { effort } }),
	};
}

export function createDeepseekAccumulator(): DeepseekAccumulator {
	return {
		content: '',
		blocks: new Map(),
		usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
	};
}

export interface DeepseekStreamUpdate {
	reasoning: string;
	content: string;
	hasTools: boolean;
}

/** Fold one decoded SSE payload. Throws on a provider error event. */
export function applyDeepseekStreamEvent(state: DeepseekAccumulator, event: unknown): DeepseekStreamUpdate | undefined {
	const row = asRecord(event);
	if (!row) {
		return undefined;
	}
	const err = asRecord(row.error);
	if (typeof err?.message === 'string' && err.message) {
		throw new Error(err.message);
	}
	if (row.type === 'message_start') {
		noteUsage(state, asRecord(row.message)?.usage);
		return undefined;
	}
	if (row.type === 'message_delta') {
		noteUsage(state, row.usage);
		return undefined;
	}
	if (row.type === 'content_block_start') {
		const index = blockIndex(row, state.blocks.size);
		const block = asRecord(row.content_block);
		if (!block || typeof block.type !== 'string') {
			return undefined;
		}
		if (block.type === 'thinking') {
			state.blocks.set(index, {
				type: 'thinking',
				text: typeof block.thinking === 'string' ? block.thinking : '',
				signature: typeof block.signature === 'string' ? block.signature : '',
			});
		} else if (block.type === 'text') {
			state.blocks.set(index, { type: 'text' });
			if (typeof block.text === 'string') {
				state.content += block.text;
			}
		} else if (block.type === 'tool_use') {
			const seededInput = block.input && typeof block.input === 'object' && !Array.isArray(block.input)
				&& Object.keys(block.input).length > 0
				? JSON.stringify(block.input)
				: '';
			state.blocks.set(index, {
				type: 'tool',
				id: typeof block.id === 'string' && block.id ? block.id : `tool_${index}`,
				name: typeof block.name === 'string' ? block.name : '',
				arguments: seededInput,
			});
		}
		return snapshot(state);
	}
	if (row.type === 'content_block_delta') {
		const index = blockIndex(row, state.blocks.size);
		const delta = asRecord(row.delta);
		if (!delta || typeof delta.type !== 'string') {
			return undefined;
		}
		if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
			const block = ensureThinking(state, index);
			block.text += delta.thinking;
		} else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
			const block = ensureThinking(state, index);
			block.signature += delta.signature;
		} else if (delta.type === 'text_delta' && typeof delta.text === 'string') {
			state.content += delta.text;
		} else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
			const block = state.blocks.get(index);
			if (block?.type === 'tool') {
				block.arguments += delta.partial_json;
			}
		}
		return snapshot(state);
	}
	return undefined;
}

export function finishDeepseekTurn(state: DeepseekAccumulator): DeepseekParsedTurn {
	return turnFromParts(state.content, orderedBlocks(state), usageTotal(state.usage));
}

export function parseDeepseekCompletion(body: unknown): DeepseekParsedTurn {
	const data = asRecord(body);
	const err = asRecord(data?.error);
	if (typeof err?.message === 'string' && err.message) {
		throw new Error(err.message);
	}
	const blocks = new Map<number, AccBlock>();
	let content = '';
	const items = Array.isArray(data?.content) ? data.content : [];
	items.forEach((item, index) => {
		const block = asRecord(item);
		if (!block || typeof block.type !== 'string') {
			return;
		}
		if (block.type === 'thinking' && typeof block.thinking === 'string') {
			blocks.set(index, {
				type: 'thinking',
				text: block.thinking,
				signature: typeof block.signature === 'string' ? block.signature : '',
			});
		} else if (block.type === 'text' && typeof block.text === 'string') {
			blocks.set(index, { type: 'text' });
			content += block.text;
		} else if (block.type === 'tool_use' && typeof block.name === 'string') {
			blocks.set(index, {
				type: 'tool',
				id: typeof block.id === 'string' && block.id ? block.id : `tool_${index}`,
				name: block.name,
				arguments: jsonArguments(block.input),
			});
		}
	});
	const usage: UsageBucket = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
	noteUsage({ content, blocks, usage }, data?.usage);
	return turnFromParts(content, orderedBlocks({ content, blocks, usage }), usageTotal(usage));
}

export function deepseekHttpError(status: number, raw: string): Error {
	try {
		const data = JSON.parse(raw) as { error?: { message?: string }; message?: string; msg?: string };
		const message = data.error?.message || data.message || data.msg;
		if (message) {
			return new Error(message);
		}
	} catch {
		// status text below
	}
	return new Error(`DeepSeek HTTP ${status}: ${raw.slice(0, 300)}`);
}

function configuredBaseUrl(): string {
	const configured = vscode.workspace.getConfiguration('zcode').get<string>('deepseek.baseUrl')?.trim();
	return configured || DEFAULT_BASE_URL;
}

function messagesRoot(baseURL: string): string {
	const base = baseURL.replace(/\/+$/u, '');
	let parsed: URL;
	try {
		parsed = new URL(base);
	} catch {
		throw new Error(`DeepSeek base URL is not valid: ${baseURL}`);
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new Error('DeepSeek base URL must be http or https.');
	}
	if (parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new Error('DeepSeek base URL cannot include credentials, a query, or a fragment.');
	}
	return parsed.pathname.endsWith('/v1') ? base : `${base}/v1`;
}

async function refreshDeepseekCatalog(apiKey: string): Promise<void> {
	const url = new URL('/models', new URL(deepseekMessagesUrl()).origin).href;
	const response = await fetch(url, {
		method: 'GET',
		redirect: 'error',
		headers: {
			accept: 'application/json',
			'x-api-key': apiKey,
			'anthropic-version': '2023-06-01',
			'user-agent': USER_AGENT,
		},
		signal: AbortSignal.timeout(20_000),
	});
	const raw = await response.text();
	if (!response.ok) {
		throw deepseekHttpError(response.status, raw);
	}
	let body: unknown;
	try {
		body = JSON.parse(raw) as unknown;
	} catch {
		throw new Error('DeepSeek model listing was not JSON.');
	}
	const listed = parseListedModels(body);
	if (!listed.length) {
		return;
	}
	catalogOverride = listed.map(model => ({
		id: model.id,
		label: model.label,
		reasoningLevels: REASONING_LEVELS,
		defaultReasoningLevel: 'high',
	}));
	for (const model of listed) {
		contextWindows.set(model.id, model.contextWindow ?? DEFAULT_CONTEXT_WINDOW);
	}
}

function parseListedModels(body: unknown): Array<{ id: string; label: string; contextWindow?: number }> {
	const data = asRecord(body)?.data;
	if (!Array.isArray(data)) {
		return [];
	}
	const out: Array<{ id: string; label: string; contextWindow?: number }> = [];
	const seen = new Set<string>();
	for (const row of data) {
		const entry = asRecord(row);
		const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
		if (!entry || !id || seen.has(id)) {
			continue;
		}
		const capabilities = asRecord(entry.api_capabilities);
		if (capabilities && !asRecord(capabilities.anthropic_messages)) {
			continue;
		}
		if (Array.isArray(entry.output_modalities) && !entry.output_modalities.includes('text')) {
			continue;
		}
		seen.add(id);
		const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id;
		const contextWindow = typeof entry.context_window === 'number' && entry.context_window > 0
			? entry.context_window
			: undefined;
		out.push({ id, label: name, contextWindow });
	}
	return out;
}

function toDeepseekMessages(input: readonly DeepseekReplayMessage[]): {
	system: string;
	messages: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }>;
} {
	const systemParts: string[] = [];
	const messages: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> = [];

	const pushUser = (blocks: Array<Record<string, unknown>>) => {
		if (!blocks.length) {
			return;
		}
		const last = messages[messages.length - 1];
		if (last?.role === 'user') {
			const merged = [...last.content, ...blocks];
			const results = merged.filter(block => block.type === 'tool_result');
			const rest = merged.filter(block => block.type !== 'tool_result');
			last.content = [...results, ...rest];
			return;
		}
		const results = blocks.filter(block => block.type === 'tool_result');
		const rest = blocks.filter(block => block.type !== 'tool_result');
		messages.push({ role: 'user', content: [...results, ...rest] });
	};

	for (const message of input) {
		if (message.role === 'system') {
			if (typeof message.content === 'string' && message.content.trim()) {
				systemParts.push(message.content.trim());
			}
			continue;
		}
		if (message.role === 'user') {
			if (typeof message.content === 'string' && message.content) {
				pushUser([{ type: 'text', text: message.content }]);
			}
			continue;
		}
		if (message.role === 'tool') {
			const text = typeof message.content === 'string' ? message.content : '';
			pushUser([{
				type: 'tool_result',
				tool_use_id: message.tool_call_id,
				content: text ? [{ type: 'text', text }] : [],
			}]);
			continue;
		}
		const blocks: Array<Record<string, unknown>> = [];
		const thinking = message.reasoning_blocks?.length
			? message.reasoning_blocks
			: (typeof message.reasoning_content === 'string' && message.reasoning_content
				? [{ text: message.reasoning_content }]
				: []);
		for (const block of thinking) {
			if (!block.text) {
				continue;
			}
			blocks.push({
				type: 'thinking',
				thinking: block.text,
				...(block.signature ? { signature: block.signature } : {}),
			});
		}
		if (typeof message.content === 'string' && message.content) {
			blocks.push({ type: 'text', text: message.content });
		}
		for (const call of message.tool_calls ?? []) {
			blocks.push({
				type: 'tool_use',
				id: call.id,
				name: call.function.name,
				input: objectArguments(call.function.arguments),
			});
		}
		if (blocks.length) {
			messages.push({ role: 'assistant', content: blocks });
		}
	}

	if (messages.length && messages[0].role !== 'user') {
		messages.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });
	}
	return { system: systemParts.join('\n\n'), messages };
}

function objectArguments(raw: string): Record<string, unknown> {
	try {
		const value = JSON.parse(raw || '{}') as unknown;
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			return value as Record<string, unknown>;
		}
	} catch {
		// Historical tool arguments that are not objects replay as {}.
	}
	return {};
}

function jsonArguments(input: unknown): string {
	if (typeof input === 'string') {
		try {
			const value = JSON.parse(input) as unknown;
			if (value && typeof value === 'object' && !Array.isArray(value)) {
				return input;
			}
		} catch {
			return '{}';
		}
		return '{}';
	}
	if (input && typeof input === 'object' && !Array.isArray(input)) {
		return JSON.stringify(input);
	}
	return '{}';
}

function orderedBlocks(state: DeepseekAccumulator): AccBlock[] {
	return [...state.blocks.keys()].sort((a, b) => a - b).map(index => state.blocks.get(index)!);
}

function turnFromParts(content: string, blocks: AccBlock[], usageTokens: number | undefined): DeepseekParsedTurn {
	const reasoningBlocks: DeepseekThinkingBlock[] = [];
	const toolCalls: DeepseekParsedTurn['toolCalls'] = [];
	for (const block of blocks) {
		if (block.type === 'thinking' && block.text) {
			reasoningBlocks.push({
				text: block.text,
				...(block.signature ? { signature: block.signature } : {}),
			});
		} else if (block.type === 'tool' && block.name) {
			toolCalls.push({
				id: block.id,
				name: block.name,
				arguments: block.arguments || '{}',
			});
		}
	}
	return {
		content,
		reasoning: reasoningBlocks.map(block => block.text).join('\n'),
		reasoningBlocks,
		toolCalls,
		usageTokens,
	};
}

function snapshot(state: DeepseekAccumulator): DeepseekStreamUpdate {
	const reasoning = orderedBlocks(state)
		.filter((block): block is Extract<AccBlock, { type: 'thinking' }> => block.type === 'thinking' && !!block.text)
		.map(block => block.text)
		.join('\n');
	return {
		reasoning,
		content: state.content,
		hasTools: [...state.blocks.values()].some(block => block.type === 'tool'),
	};
}

function ensureThinking(state: DeepseekAccumulator, index: number): Extract<AccBlock, { type: 'thinking' }> {
	const existing = state.blocks.get(index);
	if (existing?.type === 'thinking') {
		return existing;
	}
	const created: Extract<AccBlock, { type: 'thinking' }> = { type: 'thinking', text: '', signature: '' };
	state.blocks.set(index, created);
	return created;
}

function blockIndex(event: Record<string, unknown>, fallback: number): number {
	return typeof event.index === 'number' && event.index >= 0 ? event.index : fallback;
}

function noteUsage(state: DeepseekAccumulator, raw: unknown): void {
	const fields = asRecord(raw);
	if (!fields) {
		return;
	}
	const take = (key: string): number | undefined => {
		const value = fields[key];
		return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
	};
	const input = take('input_tokens');
	const output = take('output_tokens');
	const cacheRead = take('cache_read_input_tokens');
	const cacheWrite = take('cache_creation_input_tokens');
	if (input !== undefined) {
		state.usage.inputTokens = input;
	}
	if (output !== undefined) {
		state.usage.outputTokens = output;
	}
	if (cacheRead !== undefined) {
		state.usage.cacheReadTokens = cacheRead;
	}
	if (cacheWrite !== undefined) {
		state.usage.cacheWriteTokens = cacheWrite;
	}
}

function usageTotal(usage: UsageBucket): number | undefined {
	const total = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
	return total > 0 ? total : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}
