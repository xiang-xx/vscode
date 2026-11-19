/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Qianwen (Qwen) OpenAI-compatible transport:
 *   POST {baseURL}/chat/completions   header `Authorization: Bearer <key>`
 *   GET  {baseURL}/models             replaces the default catalog when it succeeds.
 * Default base URL is the Qianwen MaaS compatible mode
 * (https://maas.qianwenaiapi.com/compatible-mode/v1); DashScope-style
 * compatible endpoints work too by changing `zcode.qianwen.baseUrl`.
 *
 * Thinking is binary on Qwen (`enable_thinking`), and Qwen only allows thinking
 * with streaming requests, so the non-stream fallback path always disables it.
 * Prior assistant reasoning is NOT replayed (no signature round-trip like the
 * Anthropic Messages format); Qwen regenerates thinking each turn.
 */

const SECRET_KEY = 'zcode.qianwen.apiKey';
const DEFAULT_BASE_URL = 'https://maas.qianwenaiapi.com/compatible-mode/v1';
/** Advisory default for qwen3-family models on the compatible mode. */
const DEFAULT_CONTEXT_WINDOW = 131_072;
/** Per-request output ceiling; Qwen models accept up to 8K+ but agent turns stay bounded. */
export const QIANWEN_MAX_OUTPUT_TOKENS = 8_192;
const USER_AGENT = 'zcode-chat/0.1.0 (+https://zcode.z.ai)';

const THINKING_LEVELS = ['off', 'high'] as const;

export interface QianwenModelOption {
	id: string;
	label: string;
	reasoningLevels: readonly string[];
	defaultReasoningLevel: string;
}

/**
 * Advisory fallback while no key is stored or `GET /models` has not answered:
 * the marketplace flagships (qianwenai.com/models). Listing replaces this when
 * it succeeds, and manual entries (`zcode.qianwen.customModels`) are merged on
 * top so every marketplace id stays selectable.
 */
const DEFAULT_MODELS: readonly QianwenModelOption[] = [
	{
		id: 'qwen4-max',
		label: 'Qwen4-Max',
		reasoningLevels: THINKING_LEVELS,
		defaultReasoningLevel: 'high',
	},
	{
		id: 'qwen3.8-flash',
		label: 'Qwen3.8-Flash',
		reasoningLevels: THINKING_LEVELS,
		defaultReasoningLevel: 'high',
	},
	{
		id: 'qwen3-coder-plus',
		label: 'Qwen3-Coder-Plus',
		reasoningLevels: THINKING_LEVELS,
		defaultReasoningLevel: 'high',
	},
	{
		id: 'qwen3-max',
		label: 'Qwen3-Max',
		reasoningLevels: THINKING_LEVELS,
		defaultReasoningLevel: 'high',
	},
];

export interface QianwenReplayMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content?: string | null;
	tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
	tool_call_id?: string;
}

export interface QianwenParsedTurn {
	content: string;
	reasoning: string;
	toolCalls: Array<{ id: string; name: string; arguments: string }>;
	usageTokens?: number;
}

export interface QianwenAccumulator {
	content: string;
	reasoning: string;
	toolCalls: Map<number, { id: string; name: string; arguments: string }>;
	usageTokens?: number;
}

export interface QianwenStreamUpdate {
	reasoning: string;
	content: string;
	hasTools: boolean;
}

let secrets: vscode.SecretStorage | undefined;
let catalogOverride: QianwenModelOption[] | undefined;
const contextWindows = new Map<string, number>();

for (const model of DEFAULT_MODELS) {
	contextWindows.set(model.id, DEFAULT_CONTEXT_WINDOW);
}

export function bindQianwenSecrets(storage: vscode.SecretStorage): void {
	secrets = storage;
}

export function qianwenCatalog(): readonly QianwenModelOption[] {
	const base = catalogOverride?.length ? catalogOverride : [...DEFAULT_MODELS];
	const customIds = readQianwenCustomModelIds();
	if (!customIds.length) {
		return base;
	}
	const seen = new Set(base.map(model => model.id));
	const merged = [...base];
	for (const id of customIds) {
		if (seen.has(id)) {
			continue;
		}
		seen.add(id);
		if (!contextWindows.has(id)) {
			contextWindows.set(id, DEFAULT_CONTEXT_WINDOW);
		}
		merged.push({
			id,
			label: id,
			reasoningLevels: THINKING_LEVELS,
			defaultReasoningLevel: defaultLevelForId(id),
		});
	}
	return merged;
}

/** Manually entered marketplace ids persisted in `zcode.qianwen.customModels`. */
function readQianwenCustomModelIds(): string[] {
	const raw = vscode.workspace.getConfiguration('zcode').get<readonly string[]>('qianwen.customModels');
	if (!Array.isArray(raw)) {
		return [];
	}
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		const id = typeof entry === 'string' ? entry.trim() : '';
		if (id && !seen.has(id)) {
			seen.add(id);
			ids.push(id);
		}
	}
	return ids;
}

/** Remember a manually entered model id so it survives reloads and refreshes. */
export async function addQianwenCustomModel(modelId: string): Promise<string> {
	const id = modelId.trim();
	if (!/^[\w.:-]{1,120}$/u.test(id)) {
		throw new Error('模型 ID 只能包含字母、数字、点、下划线、连字符或冒号。');
	}
	const ids = readQianwenCustomModelIds().filter(existing => existing.toLowerCase() !== id.toLowerCase());
	ids.unshift(id);
	await vscode.workspace.getConfiguration('zcode').update('qianwen.customModels', ids, vscode.ConfigurationTarget.Global);
	contextWindows.set(id, DEFAULT_CONTEXT_WINDOW);
	return id;
}

/** Re-list models via `GET /models` with the stored key; false when unavailable. */
export async function refreshQianwenCatalogFromConfig(): Promise<boolean> {
	const key = await resolveQianwenApiKey();
	if (!key) {
		return false;
	}
	try {
		await refreshQianwenCatalog(key);
		return true;
	} catch {
		return false;
	}
}

export function qianwenContextWindow(modelId: string | undefined): number | undefined {
	const id = modelId?.trim();
	if (!id) {
		return undefined;
	}
	return contextWindows.get(id);
}

export async function resolveQianwenApiKey(): Promise<string | undefined> {
	const fromSecret = (await secrets?.get(SECRET_KEY))?.trim();
	if (fromSecret) {
		return fromSecret;
	}
	const fromEnv = process.env.QIANWEN_API_KEY?.trim() || process.env.DASHSCOPE_API_KEY?.trim();
	if (fromEnv) {
		return fromEnv;
	}
	const fromConfig = vscode.workspace.getConfiguration('zcode').get<string>('qianwen.apiKey')?.trim();
	return fromConfig || undefined;
}

export async function promptQianwenApiKey(): Promise<string | undefined> {
	const value = await vscode.window.showInputBox({
		title: '千问 API Key',
		prompt: '千问 MaaS（maas.qianwenaiapi.com）的 API Key，以 Authorization: Bearer 发送。留空取消。也可设置环境变量 QIANWEN_API_KEY。',
		password: true,
		ignoreFocusOut: true,
		placeHolder: 'sk-…',
	});
	const key = value?.trim();
	if (!key) {
		return undefined;
	}
	if (!secrets) {
		throw new Error('千问 key 存储未就绪。重新加载窗口后重试。');
	}
	await secrets.store(SECRET_KEY, key);
	return key;
}

/** Ask for a key when none is configured, then refresh the model list. */
export async function prepareQianwenProvider(): Promise<void> {
	let key = await resolveQianwenApiKey();
	if (!key) {
		key = await promptQianwenApiKey();
	}
	if (!key) {
		return;
	}
	try {
		await refreshQianwenCatalog(key);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/HTTP 401|HTTP 403|authentication|invalid api key/i.test(message)) {
			void vscode.window.showWarningMessage(`千问 API Key 被拒绝：${message}`);
		}
	}
}

export function qianwenChatUrl(): string {
	return `${configuredBaseUrl()}/chat/completions`;
}

export function qianwenModelsUrl(): string {
	return `${configuredBaseUrl()}/models`;
}

export function qianwenHeaders(apiKey: string, stream: boolean): Record<string, string> {
	return {
		'content-type': 'application/json',
		accept: stream ? 'text/event-stream' : 'application/json',
		authorization: `Bearer ${apiKey}`,
		'user-agent': USER_AGENT,
	};
}

/** Map the chat thinking picker onto Qwen `enable_thinking` (binary). */
export function qianwenThinkingEnabled(reasoningLevel: string): boolean {
	const level = (reasoningLevel || '').trim().toLowerCase();
	return !(level === 'off' || level === 'disabled' || level === 'none' || level === 'nothink');
}

export function buildQianwenBody(options: {
	model: string;
	reasoningLevel: string;
	messages: readonly QianwenReplayMessage[];
	tools: ReadonlyArray<{ function: { name: string; description: string; parameters: Record<string, unknown> } }>;
	stream: boolean;
}): Record<string, unknown> {
	// Qwen rejects thinking on non-stream requests ("enable_thinking only
	// support stream call"), so the non-stream fallback path turns it off.
	const thinking = options.stream && qianwenThinkingEnabled(options.reasoningLevel);
	// `enable_thinking` is a Qwen extension; the marketplace also proxies
	// non-Qwen ids (GLM, DeepSeek, Kimi…) that may reject the field outright,
	// so only Qwen families carry it.
	const supportsQwenThinking = /qwen|qwq/i.test(options.model);
	return {
		model: options.model,
		max_tokens: QIANWEN_MAX_OUTPUT_TOKENS,
		stream: options.stream,
		...(supportsQwenThinking ? { enable_thinking: thinking } : {}),
		messages: toQianwenMessages(options.messages),
		...(options.tools.length ? {
			tools: options.tools.map(tool => ({
				type: 'function',
				function: {
					name: tool.function.name,
					description: tool.function.description,
					parameters: tool.function.parameters,
				},
			})),
			tool_choice: 'auto',
		} : {}),
	};
}

export function createQianwenAccumulator(): QianwenAccumulator {
	return {
		content: '',
		reasoning: '',
		toolCalls: new Map(),
		usageTokens: undefined,
	};
}

/** Fold one decoded SSE payload (OpenAI chat.completion.chunk shape). Throws on an error event. */
export function applyQianwenStreamEvent(state: QianwenAccumulator, event: unknown): QianwenStreamUpdate | undefined {
	const row = asRecord(event);
	if (!row) {
		return undefined;
	}
	const err = asRecord(row.error);
	if (typeof err?.message === 'string' && err.message) {
		throw new Error(err.message);
	}
	noteUsage(state, row.usage);
	const choices = Array.isArray(row.choices) ? row.choices : [];
	const delta = asRecord(asRecord(choices[0])?.delta);
	if (!delta) {
		return undefined;
	}
	if (typeof delta.reasoning_content === 'string') {
		state.reasoning += delta.reasoning_content;
	}
	if (typeof delta.content === 'string') {
		state.content += delta.content;
	}
	if (Array.isArray(delta.tool_calls)) {
		for (const raw of delta.tool_calls) {
			const call = asRecord(raw);
			const fn = asRecord(call?.function);
			if (!call) {
				continue;
			}
			const index = typeof call.index === 'number' && call.index >= 0 ? call.index : state.toolCalls.size;
			const existing = state.toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
			if (typeof call.id === 'string' && call.id) {
				existing.id = call.id;
			}
			if (fn && typeof fn.name === 'string' && fn.name) {
				existing.name = existing.name || fn.name;
			}
			if (fn && typeof fn.arguments === 'string') {
				existing.arguments += fn.arguments;
			}
			state.toolCalls.set(index, existing);
		}
	}
	return {
		reasoning: state.reasoning,
		content: state.content,
		hasTools: state.toolCalls.size > 0,
	};
}

export function finishQianwenTurn(state: QianwenAccumulator): QianwenParsedTurn {
	return {
		content: state.content,
		reasoning: state.reasoning,
		toolCalls: [...state.toolCalls.keys()].sort((a, b) => a - b).map((index, position) => {
			const call = state.toolCalls.get(index)!;
			return {
				id: call.id || `call_${position}`,
				name: call.name,
				arguments: call.arguments || '{}',
			};
		}).filter(call => call.name),
		usageTokens: state.usageTokens,
	};
}

export function parseQianwenCompletion(body: unknown): QianwenParsedTurn {
	const data = asRecord(body);
	const err = asRecord(data?.error);
	if (typeof err?.message === 'string' && err.message) {
		throw new Error(err.message);
	}
	const state = createQianwenAccumulator();
	const choices = Array.isArray(data?.choices) ? data.choices : [];
	const message = asRecord(asRecord(choices[0])?.message);
	if (message) {
		if (typeof message.reasoning_content === 'string') {
			state.reasoning = message.reasoning_content;
		}
		if (typeof message.content === 'string') {
			state.content = message.content;
		}
		if (Array.isArray(message.tool_calls)) {
			message.tool_calls.forEach((raw, index) => {
				const call = asRecord(raw);
				const fn = asRecord(call?.function);
				if (!fn || typeof fn.name !== 'string' || !fn.name) {
					return;
				}
				state.toolCalls.set(index, {
					id: typeof call?.id === 'string' && call.id ? call.id : `call_${index}`,
					name: fn.name,
					arguments: typeof fn.arguments === 'string' ? fn.arguments : '{}',
				});
			});
		}
	}
	noteUsage(state, data?.usage);
	return finishQianwenTurn(state);
}

export function qianwenHttpError(status: number, raw: string): Error {
	try {
		const data = JSON.parse(raw) as { error?: { message?: string }; message?: string; msg?: string };
		const message = data.error?.message || data.message || data.msg;
		if (message) {
			return new Error(message);
		}
	} catch {
		// status text below
	}
	return new Error(`千问 HTTP ${status}: ${raw.slice(0, 300)}`);
}

function configuredBaseUrl(): string {
	const configured = vscode.workspace.getConfiguration('zcode').get<string>('qianwen.baseUrl')?.trim();
	const base = (configured || DEFAULT_BASE_URL).replace(/\/+$/u, '');
	let parsed: URL;
	try {
		parsed = new URL(base);
	} catch {
		throw new Error(`千问 base URL 无效：${configured || DEFAULT_BASE_URL}`);
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new Error('千问 base URL 必须是 http 或 https。');
	}
	if (parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new Error('千问 base URL 不能带凭据、查询串或片段。');
	}
	return base;
}

async function refreshQianwenCatalog(apiKey: string): Promise<void> {
	const response = await fetch(qianwenModelsUrl(), {
		method: 'GET',
		redirect: 'error',
		headers: {
			accept: 'application/json',
			authorization: `Bearer ${apiKey}`,
			'user-agent': USER_AGENT,
		},
		signal: AbortSignal.timeout(20_000),
	});
	const raw = await response.text();
	if (!response.ok) {
		throw qianwenHttpError(response.status, raw);
	}
	let body: unknown;
	try {
		body = JSON.parse(raw) as unknown;
	} catch {
		throw new Error('千问 model listing was not JSON.');
	}
	const listed = parseListedModels(body);
	if (!listed.length) {
		return;
	}
	catalogOverride = listed.map(model => ({
		id: model.id,
		label: model.label,
		reasoningLevels: THINKING_LEVELS,
		defaultReasoningLevel: defaultLevelForId(model.id),
	}));
	for (const model of listed) {
		contextWindows.set(model.id, model.contextWindow ?? DEFAULT_CONTEXT_WINDOW);
	}
}

function defaultLevelForId(modelId: string): string {
	return /coder|max/i.test(modelId) ? 'high' : 'off';
}

function parseListedModels(body: unknown): Array<{ id: string; label: string; contextWindow?: number }> {
	const data = asRecord(body)?.data;
	if (!Array.isArray(data)) {
		return [];
	}
	const out: Array<{ id: string; label: string; contextWindow?: number }> = [];
	const seen = new Set<string>();
	// The compatible-mode /models list also carries non-chat models; skip the
	// obvious non-text ones so the picker stays usable.
	const NON_CHAT = /embedding|rerank|tts|asr|audio|speech|realtime|qvq/i;
	for (const row of data) {
		const entry = asRecord(row);
		const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
		if (!entry || !id || seen.has(id) || NON_CHAT.test(id)) {
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

function toQianwenMessages(input: readonly QianwenReplayMessage[]): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	for (const message of input) {
		if (message.role === 'system') {
			const text = message.content?.trim();
			if (text) {
				out.push({ role: 'system', content: text });
			}
			continue;
		}
		if (message.role === 'user') {
			const text = message.content ?? '';
			if (text) {
				out.push({ role: 'user', content: text });
			}
			continue;
		}
		if (message.role === 'assistant') {
			const calls = (message.tool_calls ?? []).map(call => ({
				id: call.id,
				type: 'function',
				function: { name: call.function.name, arguments: call.function.arguments || '{}' },
			}));
			out.push({
				role: 'assistant',
				content: message.content ?? '',
				...(calls.length ? { tool_calls: calls } : {}),
			});
			continue;
		}
		out.push({ role: 'tool', tool_call_id: message.tool_call_id, content: message.content ?? '' });
	}
	return out;
}

function noteUsage(state: QianwenAccumulator, raw: unknown): void {
	const fields = asRecord(raw);
	if (!fields) {
		return;
	}
	const take = (key: string): number | undefined => {
		const value = fields[key];
		return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
	};
	const prompt = take('prompt_tokens');
	const completion = take('completion_tokens');
	const total = take('total_tokens') ?? ((prompt ?? 0) + (completion ?? 0) || undefined);
	if (total !== undefined && total > 0) {
		state.usageTokens = total;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}
