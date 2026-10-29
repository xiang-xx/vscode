/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getAuthService } from './authSession';
import type { ChatMessage } from './bridge';
import type { TodoItem, TodoStatus } from './conversation';
import { getFileEditSession, type FileChangeKind } from './fileEditSession';
import type { ProviderMode } from './providers';
import { loadCodingPlanApiKey } from './zcodeCredentialsStore';

const BIGMODEL_CHAT_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const START_PLAN_CHAT_URL = 'https://zcode.z.ai/api/v1/zcode-plan/chat/completions';
const MAX_TOOL_TURNS = 16;

interface ToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

interface ChatCompletionMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content?: string | null;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
	name?: string;
	reasoning_content?: string | null;
}

export type AgentProgressEvent =
	| { type: 'status'; text: string }
	| { type: 'reasoning'; text: string; done: boolean }
	| { type: 'assistant'; text: string; done: boolean }
	| { type: 'tool_start'; id: string; toolName: string; summary: string }
	| { type: 'tool_end'; id: string; toolName: string; summary: string; ok: boolean }
	| { type: 'todos'; todos: TodoItem[] }
	| {
		type: 'file_change';
		uri: string;
		path: string;
		kind: FileChangeKind;
		added: number;
		removed: number;
	};

const TOOLS = [
	{
		type: 'function',
		function: {
			name: 'read_file',
			description: 'Read a UTF-8 text file from the workspace.',
			parameters: {
				type: 'object',
				properties: { path: { type: 'string' } },
				required: ['path'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'write_file',
			description: 'Create or overwrite a UTF-8 text file in the workspace.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					content: { type: 'string' },
				},
				required: ['path', 'content'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'str_replace',
			description: 'Replace the first exact occurrence of old_string with new_string in a file.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					old_string: { type: 'string' },
					new_string: { type: 'string' },
				},
				required: ['path', 'old_string', 'new_string'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'list_dir',
			description: 'List files and directories under a path.',
			parameters: {
				type: 'object',
				properties: { path: { type: 'string' } },
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'TodoWrite',
			description:
				'Create or update the task list shown in the chat UI (like ZCode TodoWrite). Use for multi-step work.',
			parameters: {
				type: 'object',
				properties: {
					todos: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								id: { type: 'string' },
								content: { type: 'string' },
								status: {
									type: 'string',
									enum: ['pending', 'in_progress', 'completed'],
								},
							},
							required: ['id', 'content', 'status'],
						},
					},
					merge: {
						type: 'boolean',
						description: 'If true, merge by id; if false, replace the whole list.',
					},
				},
				required: ['todos'],
			},
		},
	},
] as const;

export async function runWorkspaceAgent(options: {
	messages: ChatMessage[];
	provider: ProviderMode;
	model: string;
	reasoningLevel: string;
	workspaceRoot?: string;
	token: vscode.CancellationToken;
	onProgress?: (event: AgentProgressEvent) => void;
	initialTodos?: TodoItem[];
}): Promise<{ text: string; todos: TodoItem[] }> {
	const root = options.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		throw new Error('Open a folder/workspace first so the agent can edit files.');
	}

	const emit = (event: AgentProgressEvent) => options.onProgress?.(event);
	emit({ type: 'status', text: `Calling ${options.model}…` });

	let todos = [...(options.initialTodos ?? [])];
	const auth = await resolveAuth(options.provider);
	const apiMessages: ChatCompletionMessage[] = [
		{
			role: 'system',
			content: [
				'You are ZCode agent inside a VS Code fork.',
				`Workspace root: ${root}`,
				'Use tools to inspect and modify files. Prefer str_replace for small edits.',
				'For multi-step tasks, call TodoWrite first and keep it updated (one in_progress item).',
				'After finishing, briefly summarize what you changed in plain language.',
				'Do not dump raw tool logs or reasoning in the final answer; the UI shows those separately.',
				`Thinking intensity preference: ${options.reasoningLevel}.`,
			].join('\n'),
		},
		...options.messages.map(m => ({ role: m.role, content: m.content }) as ChatCompletionMessage),
	];

	for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
		if (options.token.isCancellationRequested) {
			throw new vscode.CancellationError();
		}

		emit({ type: 'status', text: turn === 0 ? 'Thinking…' : 'Continuing…' });

		const choice = await streamOrCompleteChat({
			url: auth.url,
			apiKey: auth.apiKey,
			model: options.model,
			messages: apiMessages,
			token: options.token,
			onReasoning: text => emit({ type: 'reasoning', text, done: false }),
			onAssistant: text => emit({ type: 'assistant', text, done: false }),
		});

		if (choice.reasoning?.trim()) {
			emit({ type: 'reasoning', text: choice.reasoning.trim(), done: true });
		}

		apiMessages.push({
			role: 'assistant',
			content: choice.content ?? null,
			tool_calls: choice.tool_calls,
			...(choice.reasoning ? { reasoning_content: choice.reasoning } : {}),
		});

		const toolCalls = choice.tool_calls ?? [];
		if (!toolCalls.length) {
			const text = (choice.content ?? '').trim() || '(done)';
			emit({ type: 'assistant', text, done: true });
			return { text, todos };
		}

		// Content alongside tool_calls is not the final answer — keep it out of the timeline
		// so the conclusion stays below tools when the loop finishes.

		for (const call of toolCalls) {
			if (options.token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			const preview = previewToolArgs(call.function.name, call.function.arguments);
			emit({
				type: 'tool_start',
				id: call.id,
				toolName: call.function.name,
				summary: preview,
			});

			let result: { summary: string; content: string };
			if (call.function.name === 'TodoWrite') {
				const applied = applyTodoWrite(todos, call.function.arguments);
				todos = applied.todos;
				result = { summary: applied.summary, content: applied.content };
				emit({ type: 'todos', todos });
			} else {
				result = await executeTool(call.function.name, call.function.arguments, root, change => {
					emit({
						type: 'file_change',
						uri: change.uri.toString(),
						path: change.path,
						kind: change.kind,
						added: change.added,
						removed: change.removed,
					});
				});
			}

			const ok = !result.content.startsWith('Error:');
			emit({
				type: 'tool_end',
				id: call.id,
				toolName: call.function.name,
				summary: result.summary,
				ok,
			});
			apiMessages.push({
				role: 'tool',
				tool_call_id: call.id,
				name: call.function.name,
				content: result.content,
			});
		}
	}

	throw new Error('Agent stopped: too many tool turns without a final answer.');
}

function applyTodoWrite(
	current: TodoItem[],
	argsJson: string,
): { todos: TodoItem[]; summary: string; content: string } {
	try {
		const args = JSON.parse(argsJson || '{}') as {
			todos?: Array<{ id?: string; content?: string; status?: string }>;
			merge?: boolean;
		};
		const incoming = (args.todos ?? [])
			.map((t, index) => {
				const status = normalizeTodoStatus(t.status);
				const id = (t.id ?? `todo-${index}`).trim();
				const content = (t.content ?? '').trim();
				if (!id || !content || !status) {
					return undefined;
				}
				return { id, content, status } satisfies TodoItem;
			})
			.filter((t): t is TodoItem => !!t);

		if (!incoming.length) {
			return { todos: current, summary: 'TodoWrite empty', content: 'Error: todos array required' };
		}

		let next: TodoItem[];
		if (args.merge === false) {
			next = incoming;
		} else {
			const map = new Map(current.map(t => [t.id, t]));
			for (const item of incoming) {
				map.set(item.id, item);
			}
			next = [...map.values()];
		}

		const active = next.find(t => t.status === 'in_progress') ?? next.find(t => t.status === 'pending');
		const done = next.filter(t => t.status === 'completed').length;
		return {
			todos: next,
			summary: active ? `${done}/${next.length} · ${active.content}` : `${done}/${next.length}`,
			content: JSON.stringify({ ok: true, todos: next }),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { todos: current, summary: 'TodoWrite failed', content: `Error: ${message}` };
	}
}

function normalizeTodoStatus(value: unknown): TodoStatus | undefined {
	if (value === 'pending' || value === 'in_progress' || value === 'completed') {
		return value;
	}
	return undefined;
}

function previewToolArgs(name: string, argsJson: string): string {
	try {
		const args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
		if (name === 'TodoWrite') {
			const todos = Array.isArray(args.todos) ? args.todos : [];
			return `TodoWrite (${todos.length})`;
		}
		const p = typeof args.path === 'string' ? args.path : '';
		return p ? `${name} ${p}` : name;
	} catch {
		return name;
	}
}

async function resolveAuth(provider: ProviderMode): Promise<{ url: string; apiKey: string }> {
	if (provider === 'startPlan') {
		try {
			const jwt = getAuthService().getSession()?.zcodeJwtToken?.trim();
			if (jwt) {
				return { url: START_PLAN_CHAT_URL, apiKey: jwt };
			}
		} catch {
			// fall through
		}
	}

	const codingKey = await loadCodingPlanApiKey('bigmodel');
	if (codingKey) {
		return { url: BIGMODEL_CHAT_URL, apiKey: codingKey };
	}

	try {
		const access = getAuthService().getSession()?.accessToken;
		if (access) {
			return { url: BIGMODEL_CHAT_URL, apiKey: access };
		}
	} catch {
		// ignore
	}

	throw new Error(
		'No BigModel Coding Plan API key found in ~/.zcode/v2/credentials.json. Sign in with BigModel in ZCode desktop (or this IDE) and ensure Coding Plan is connected.',
	);
}

async function streamOrCompleteChat(options: {
	url: string;
	apiKey: string;
	model: string;
	messages: ChatCompletionMessage[];
	token: vscode.CancellationToken;
	onReasoning: (text: string) => void;
	onAssistant: (text: string) => void;
}): Promise<{ content: string; reasoning: string; tool_calls?: ToolCall[] }> {
	try {
		return await streamChatCompletions(options);
	} catch (error) {
		if (options.token.isCancellationRequested) {
			throw error;
		}
		// Fall back to non-stream (still surfaces reasoning_content when present).
		const data = await completeChatCompletions(options);
		const message = data.choices?.[0]?.message;
		if (!message) {
			throw new Error(`Empty model response: ${JSON.stringify(data).slice(0, 400)}`);
		}
		const reasoning = extractReasoning(message);
		const content = message.content ?? '';
		if (reasoning) {
			options.onReasoning(reasoning);
		}
		const toolCalls = message.tool_calls;
		if (content && !(toolCalls && toolCalls.length)) {
			options.onAssistant(content);
		}
		return {
			content,
			reasoning,
			tool_calls: message.tool_calls,
		};
	}
}

function extractReasoning(message: ChatCompletionMessage & Record<string, unknown>): string {
	const direct = message.reasoning_content;
	if (typeof direct === 'string' && direct.trim()) {
		return direct;
	}
	const alt = message.reasoning;
	if (typeof alt === 'string' && alt.trim()) {
		return alt;
	}
	return '';
}

async function completeChatCompletions(options: {
	url: string;
	apiKey: string;
	model: string;
	messages: ChatCompletionMessage[];
	token: vscode.CancellationToken;
}): Promise<{
	choices?: Array<{ message?: ChatCompletionMessage & Record<string, unknown> }>;
	error?: { message?: string };
	msg?: string;
	code?: number;
}> {
	const controller = new AbortController();
	const cancel = options.token.onCancellationRequested(() => controller.abort());
	try {
		const response = await fetch(options.url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${options.apiKey}`,
			},
			body: JSON.stringify({
				model: options.model,
				messages: options.messages,
				tools: TOOLS,
				tool_choice: 'auto',
				stream: false,
			}),
			signal: controller.signal,
		});
		const raw = await response.text();
		let data: {
			choices?: Array<{ message?: ChatCompletionMessage & Record<string, unknown> }>;
			error?: { message?: string };
			msg?: string;
			code?: number;
		};
		try {
			data = JSON.parse(raw) as typeof data;
		} catch {
			throw new Error(`Provider returned non-JSON (${response.status}): ${raw.slice(0, 300)}`);
		}
		if (!response.ok) {
			throw new Error(data.error?.message || data.msg || `HTTP ${response.status}: ${raw.slice(0, 300)}`);
		}
		if (typeof data.code === 'number' && data.code !== 0 && !data.choices) {
			throw new Error(data.msg || `Provider error code ${data.code}`);
		}
		return data;
	} finally {
		cancel.dispose();
	}
}

async function streamChatCompletions(options: {
	url: string;
	apiKey: string;
	model: string;
	messages: ChatCompletionMessage[];
	token: vscode.CancellationToken;
	onReasoning: (text: string) => void;
	onAssistant: (text: string) => void;
}): Promise<{ content: string; reasoning: string; tool_calls?: ToolCall[] }> {
	const controller = new AbortController();
	const cancel = options.token.onCancellationRequested(() => controller.abort());
	try {
		const response = await fetch(options.url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${options.apiKey}`,
				Accept: 'text/event-stream',
			},
			body: JSON.stringify({
				model: options.model,
				messages: options.messages,
				tools: TOOLS,
				tool_choice: 'auto',
				stream: true,
			}),
			signal: controller.signal,
		});

		if (!response.ok || !response.body) {
			const raw = await response.text().catch(() => '');
			throw new Error(`Stream HTTP ${response.status}: ${raw.slice(0, 300)}`);
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let content = '';
		let reasoning = '';
		const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
		let lastReasoningEmit = 0;
		let lastContentEmit = 0;

		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const parts = buffer.split('\n');
			buffer = parts.pop() ?? '';

			for (const line of parts) {
				const trimmed = line.trim();
				if (!trimmed.startsWith('data:')) {
					continue;
				}
				const payload = trimmed.slice(5).trim();
				if (!payload || payload === '[DONE]') {
					continue;
				}
				let json: {
					choices?: Array<{
						delta?: {
							content?: string | null;
							reasoning_content?: string | null;
							reasoning?: string | null;
							tool_calls?: Array<{
								index?: number;
								id?: string;
								function?: { name?: string; arguments?: string };
							}>;
						};
						message?: ChatCompletionMessage & Record<string, unknown>;
					}>;
					error?: { message?: string };
				};
				try {
					json = JSON.parse(payload) as typeof json;
				} catch {
					continue;
				}
				if (json.error?.message) {
					throw new Error(json.error.message);
				}

				const choice = json.choices?.[0];
				const delta = choice?.delta;
				if (delta) {
					const r = delta.reasoning_content ?? delta.reasoning;
					if (typeof r === 'string' && r) {
						reasoning += r;
						const now = Date.now();
						if (now - lastReasoningEmit > 80) {
							options.onReasoning(reasoning);
							lastReasoningEmit = now;
						}
					}
					for (const tc of delta.tool_calls ?? []) {
						const index = tc.index ?? 0;
						const existing = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
						if (tc.id) {
							existing.id = tc.id;
						}
						if (tc.function?.name) {
							existing.name += tc.function.name;
						}
						if (tc.function?.arguments) {
							existing.arguments += tc.function.arguments;
						}
						toolCalls.set(index, existing);
					}
					if (typeof delta.content === 'string' && delta.content) {
						content += delta.content;
						// Only stream visible answer text while no tool calls are in flight.
						if (toolCalls.size === 0) {
							const now = Date.now();
							if (now - lastContentEmit > 80) {
								options.onAssistant(content);
								lastContentEmit = now;
							}
						}
					}
				}

				// Some gateways send a final non-delta message.
				if (choice?.message) {
					if (!content && choice.message.content) {
						content = choice.message.content;
					}
					const msgReasoning = extractReasoning(choice.message);
					if (!reasoning && msgReasoning) {
						reasoning = msgReasoning;
					}
				}
			}
		}

		if (reasoning) {
			options.onReasoning(reasoning);
		}

		const calls: ToolCall[] = [...toolCalls.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([, value], index) => ({
				id: value.id || `call_${index}`,
				type: 'function' as const,
				function: {
					name: value.name,
					arguments: value.arguments,
				},
			}))
			.filter(c => c.function.name);

		// Final answer streams only when this completion has no tools.
		if (content && !calls.length) {
			options.onAssistant(content);
		}

		return {
			content,
			reasoning,
			...(calls.length ? { tool_calls: calls } : {}),
		};
	} finally {
		cancel.dispose();
	}
}

type FileChangeReporter = (change: {
	uri: import('vscode').Uri;
	path: string;
	kind: FileChangeKind;
	added: number;
	removed: number;
}) => void;

async function executeTool(
	name: string,
	argsJson: string,
	root: string,
	onFileChange?: FileChangeReporter,
): Promise<{ summary: string; content: string }> {
	let args: Record<string, unknown> = {};
	try {
		args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
	} catch {
		return { summary: 'invalid JSON args', content: 'Error: tool arguments must be JSON' };
	}

	const edits = getFileEditSession();

	try {
		switch (name) {
			case 'read_file': {
				const filePath = resolvePath(String(args.path ?? ''), root);
				const text = await fs.readFile(filePath, 'utf8');
				const clipped = text.length > 80_000 ? `${text.slice(0, 80_000)}\n…(truncated)` : text;
				return { summary: `read ${rel(filePath, root)} (${text.length} chars)`, content: clipped };
			}
			case 'write_file': {
				const filePath = resolvePath(String(args.path ?? ''), root);
				const content = String(args.content ?? '');
				const applied = await edits.writeFile(filePath, content, root);
				onFileChange?.({
					uri: applied.uri,
					path: rel(filePath, root),
					kind: applied.kind,
					added: applied.added,
					removed: applied.removed,
				});
				return { summary: applied.summary, content: 'ok' };
			}
			case 'str_replace': {
				const filePath = resolvePath(String(args.path ?? ''), root);
				const oldString = String(args.old_string ?? '');
				const newString = String(args.new_string ?? '');
				const text = await fs.readFile(filePath, 'utf8');
				const index = text.indexOf(oldString);
				if (index < 0) {
					return {
						summary: `str_replace miss ${rel(filePath, root)}`,
						content: 'Error: old_string not found',
					};
				}
				const next = text.slice(0, index) + newString + text.slice(index + oldString.length);
				const applied = await edits.writeFile(filePath, next, root);
				onFileChange?.({
					uri: applied.uri,
					path: rel(filePath, root),
					kind: applied.kind,
					added: applied.added,
					removed: applied.removed,
				});
				return { summary: applied.summary, content: 'ok' };
			}
			case 'list_dir': {
				const dirPath = resolvePath(String(args.path ?? '.'), root);
				const entries = await fs.readdir(dirPath, { withFileTypes: true });
				const lines = entries.slice(0, 200).map(e => `${e.isDirectory() ? 'dir' : 'file'}\t${e.name}`);
				return {
					summary: `list ${rel(dirPath, root)} (${entries.length})`,
					content: lines.join('\n') || '(empty)',
				};
			}
			default:
				return { summary: `unknown tool ${name}`, content: `Error: unknown tool ${name}` };
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { summary: `${name} failed`, content: `Error: ${message}` };
	}
}

function resolvePath(input: string, root: string): string {
	const trimmed = input.trim();
	if (!trimmed) {
		return root;
	}
	const absolute = path.isAbsolute(trimmed) ? trimmed : path.resolve(root, trimmed);
	const normalizedRoot = path.resolve(root) + path.sep;
	const normalized = path.resolve(absolute);
	if (normalized !== path.resolve(root) && !normalized.startsWith(normalizedRoot)) {
		throw new Error(`Path escapes workspace: ${input}`);
	}
	return normalized;
}

function rel(filePath: string, root: string): string {
	return path.relative(root, filePath) || '.';
}
