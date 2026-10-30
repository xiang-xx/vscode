/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	formatZCodeAskToolContent,
	normalizeZCodeAsk,
	summarizeAskResult,
	type AskUserHandler,
} from './askUser';
import { getAuthService } from './authSession';
import type { ChatMessage } from './bridge';
import { formatLineDiff, type TodoItem, type TodoStatus } from './conversation';
import {
	buildPaceSystemLines,
	buildReasoningRequestFields,
	exploreNudgeAfterRounds,
	getAgentPace,
	isExploreTool,
	maxToolTurnsForPace,
	type AgentPace,
} from './agentPace';
import { getFileEditSession, type FileChangeKind } from './fileEditSession';
import {
	ellipsize,
	resolveDirForSpawn,
	runShellCommand,
	spawnCapture,
	truncatePreview,
} from './processUtils';
import type { ProviderMode } from './providers';
import { BROWSER_TOOL_DEFS, executeBrowserTool } from './browserTools';
import { formatSessionAwareness, type SessionAwareness } from './sessionAwareness';
import { normalizeToolArgs, normalizeToolName } from './toolNormalize';
import { loadCodingPlanApiKey } from './zcodeCredentialsStore';

/** Match ZCode Read default line budget. */
const READ_DEFAULT_MAX_LINES = 2_000;

/**
 * BigModel Coding Plan Chat Completions endpoint.
 * Must NOT use `/api/paas/v4` — that is the pay-as-you-go API wallet and returns
 * 「余额不足或无可用资源包」even when Coding Plan quota remains.
 * @see ZCode config: account:bigmodel-*-coding-plan → /api/coding/paas/v4 (legacy OpenAI path)
 */
const BIGMODEL_CODING_CHAT_URL = 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions';
/** ZCode Start Plan is Anthropic Messages — not OpenAI `/chat/completions` (that path 404s). */
const START_PLAN_ANTHROPIC_URL = 'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages';
const MAX_TOOL_TURNS_FALLBACK = 96;

type ProviderApiKind = 'openai' | 'anthropic';

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
	| { type: 'tool_start'; id: string; toolName: string; summary?: string; detail?: string }
	| { type: 'tool_update'; id: string; summary?: string; detail?: string }
	| {
		type: 'tool_end';
		id: string;
		toolName: string;
		summary?: string;
		ok: boolean;
		detail?: string;
		path?: string;
		uri?: string;
		added?: number;
		removed?: number;
	}
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
			description: [
				'Read a UTF-8 text file (ZCode Read). Returns cat -n style line numbers.',
				'Default reads up to 2000 lines; use offset/limit for large files.',
				'Path alias: file_path.',
			].join(' '),
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Workspace-relative or absolute path (alias: file_path).' },
					offset: {
						type: 'number',
						description: '1-based start line. Negative counts from end (e.g. -20 = last 20 lines when used with limit).',
					},
					limit: {
						type: 'number',
						description: 'Max number of lines to return (default 2000).',
					},
				},
				required: ['path'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'write_file',
			description: 'Create or overwrite a UTF-8 text file in the workspace (ZCode Write).',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Alias: file_path.' },
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
			description: [
				'Exact string replacement (ZCode Edit).',
				'old_string must match exactly and be unique unless replace_all is true.',
			].join(' '),
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Alias: file_path.' },
					old_string: { type: 'string' },
					new_string: { type: 'string' },
					replace_all: {
						type: 'boolean',
						description: 'If true, replace every occurrence of old_string (default false). Alias: replaceAll.',
					},
				},
				required: ['path', 'old_string', 'new_string'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'delete_file',
			description: 'Delete a file in the workspace. Prefer this over shell rm for tracked edits.',
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
			name: 'run_terminal_cmd',
			description: [
				'Run a shell command in the workspace (ZCode Bash equivalent).',
				'Use for git, tests, builds, package managers, and quick scripts — not for reading files (use read_file/grep).',
				'Do not use for long-lived servers; prefer non-interactive flags.',
			].join(' '),
			parameters: {
				type: 'object',
				properties: {
					command: { type: 'string', description: 'Shell command to run.' },
					description: {
						type: 'string',
						description: 'Short active-voice summary of what the command does (5–15 words).',
					},
					cwd: {
						type: 'string',
						description: 'Optional working directory (alias: working_directory). Default: workspace root.',
					},
					timeout_ms: {
						type: 'number',
						description: 'Kill after this many ms (alias: timeout). Default 60000, max 600000.',
					},
				},
				required: ['command'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'get_diagnostics',
			description:
				'Read VS Code/TypeScript/ESLint diagnostics (errors/warnings) for a file or the whole workspace. Call after edits to verify.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Optional file path. Omit to sample workspace diagnostics.',
					},
					max_results: {
						type: 'number',
						description: 'Max diagnostics to return (default 50, hard cap 200).',
					},
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'web_fetch',
			description:
				'Fetch a public http(s) URL and return text content (HTML/JSON/markdown). Use for docs or API references. Not for authenticated or private URLs.',
			parameters: {
				type: 'object',
				properties: {
					url: { type: 'string' },
					max_chars: {
						type: 'number',
						description: 'Truncate body to this many characters (default 30000, max 80000).',
					},
				},
				required: ['url'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'grep',
			description:
				'Search file contents in the workspace with a regex or literal pattern (like ripgrep). Prefer this over reading many files to find symbols or strings.',
			parameters: {
				type: 'object',
				properties: {
					pattern: {
						type: 'string',
						description: 'Search pattern (regex by default).',
					},
					path: {
						type: 'string',
						description:
							'Optional subdirectory or single file to search (relative to workspace). File paths are OK.',
					},
					glob: {
						type: 'string',
						description: 'Optional file glob filter, e.g. "*.ts" or "**/*.{ts,tsx}".',
					},
					case_insensitive: {
						type: 'boolean',
						description: 'Case-insensitive search (default false). Alias: -i.',
					},
					output_mode: {
						type: 'string',
						enum: ['content', 'files_with_matches', 'count'],
						description: 'content = matching lines (default); files_with_matches = paths only; count = per-file counts.',
					},
					max_results: {
						type: 'number',
						description: 'Max matches to return (alias: head_limit). Default 50, hard cap 200.',
					},
				},
				required: ['pattern'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'glob',
			description:
				'Find files by glob pattern under the workspace (e.g. "**/*.ts", "src/**/foo.ts"). Returns matching paths.',
			parameters: {
				type: 'object',
				properties: {
					pattern: {
						type: 'string',
						description: 'Glob pattern relative to workspace (or to path if set).',
					},
					path: {
						type: 'string',
						description: 'Optional subdirectory to search under.',
					},
					max_results: {
						type: 'number',
						description: 'Max paths to return (default 200, hard cap 500).',
					},
				},
				required: ['pattern'],
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
	{
		type: 'function',
		function: {
			name: 'AskUserQuestion',
			description: [
				'Ask the user multiple-choice clarification questions when blocked on a decision only they can make.',
				'Prefer 1–3 short questions with 2–4 options each. Put a recommended option first and append "(Recommended)" to its label when helpful.',
				'Users can always pick Other and type free text. Set multiSelect true when choices are not mutually exclusive.',
				'Do not use this for facts you can verify in the codebase or for choices with an obvious default.',
			].join(' '),
			parameters: {
				type: 'object',
				properties: {
					questions: {
						type: 'array',
						description: 'One or more questions (preferred).',
						items: {
							type: 'object',
							properties: {
								header: {
									type: 'string',
									description: 'Short chip label (max ~12 chars).',
								},
								question: {
									type: 'string',
									description: 'Full question text shown to the user.',
								},
								options: {
									type: 'array',
									items: {
										type: 'object',
										properties: {
											label: { type: 'string' },
											description: { type: 'string' },
										},
										required: ['label'],
									},
								},
								multiSelect: { type: 'boolean' },
							},
							required: ['question', 'options'],
						},
					},
					header: { type: 'string', description: 'Short label when asking a single question.' },
					question: { type: 'string', description: 'Single-question form (alternative to questions[]).' },
					options: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								label: { type: 'string' },
								description: { type: 'string' },
							},
							required: ['label'],
						},
					},
					multiSelect: { type: 'boolean' },
				},
			},
		},
	},
	...BROWSER_TOOL_DEFS,
];

export async function runWorkspaceAgent(options: {
	messages: ChatMessage[];
	provider: ProviderMode;
	model: string;
	reasoningLevel: string;
	workspaceRoot?: string;
	token: vscode.CancellationToken;
	onProgress?: (event: AgentProgressEvent) => void;
	initialTodos?: TodoItem[];
	askUser?: AskUserHandler;
	sessionAwareness?: SessionAwareness;
	agentPace?: AgentPace;
	/** Personal instructions, project AGENTS.md, and skill names. */
	promptPreamble?: string;
}): Promise<{ text: string; todos: TodoItem[] }> {
	const root = options.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		throw new Error('Open a folder/workspace first so the agent can edit files.');
	}

	const pace = options.agentPace ?? getAgentPace();
	const maxToolTurns = maxToolTurnsForPace(pace) || MAX_TOOL_TURNS_FALLBACK;
	const exploreNudgeAt = exploreNudgeAfterRounds(pace);
	const emit = (event: AgentProgressEvent) => options.onProgress?.(event);
	emit({ type: 'status', text: `${options.model} · ${pace} · ${root}` });

	let todos = [...(options.initialTodos ?? [])];
	const auth = await resolveAuth(options.provider);
	const awareness = formatSessionAwareness(options.sessionAwareness);
	const readFileState = new Map<string, { mtimeMs: number; size: number }>();
	let exploreOnlyRounds = 0;
	let exploreNudgeSent = false;
	const apiMessages: ChatCompletionMessage[] = [
		{
			role: 'system',
			content: [
				'You are ZCode agent inside a VS Code fork (same tool philosophy as ZCode CLI).',
				`Workspace root: ${root}`,
				'Tools: read_file, write_file, str_replace, delete_file, list_dir, grep, glob, run_terminal_cmd, get_diagnostics, web_fetch, open_browser_page, browser_list_pages, browser_read_page, browser_click, browser_type, browser_hover, browser_screenshot, browser_navigate, browser_import_chrome_data, TodoWrite, AskUserQuestion.',
				'ZCode CLI names also work (Read/Write/Edit/Bash/Grep/Glob/WebFetch).',
				'Prefer str_replace for small edits; set replace_all when renaming a symbol across a file. Read a file before editing when you lack exact text.',
				'Use run_terminal_cmd (Bash) for git/tests/builds — not for reading files. Use get_diagnostics after substantive edits.',
				'Browser: always use the integrated Browser tools (open_browser_page → keep pageId → browser_read_page → browser_click/browser_type). Do not open an external browser. Sync Chrome login with browser_import_chrome_data only after asking the user.',
				'When blocked on a user decision, call AskUserQuestion and wait for their choices before continuing.',
				'After finishing, briefly summarize what you changed in plain language.',
				'Do not dump raw tool logs or reasoning in the final answer; the UI shows those separately.',
				...buildPaceSystemLines(pace),
				`Thinking intensity preference: ${options.reasoningLevel}.`,
				awareness,
				options.promptPreamble,
			].filter(Boolean).join('\n'),
		},
		...options.messages.map(m => ({ role: m.role, content: m.content }) as ChatCompletionMessage),
	];

	for (let turn = 0; turn < maxToolTurns; turn++) {
		if (options.token.isCancellationRequested) {
			throw new vscode.CancellationError();
		}

		emit({ type: 'status', text: turn === 0 ? 'Thinking…' : 'Continuing…' });

		// Once near the cap, nudge the model to wrap up (only once).
		if (turn === maxToolTurns - 3) {
			apiMessages.push({
				role: 'user',
				content: `You are near the tool-turn limit (${turn + 1}/${maxToolTurns}). Finish remaining critical edits if any, then reply with a brief final summary and do not call more tools.`,
			});
		}

		let choice: { content: string; reasoning: string; tool_calls?: ToolCall[] };
		try {
			choice = await streamOrCompleteChat({
				url: auth.url,
				apiKey: auth.apiKey,
				api: auth.api,
				model: options.model,
				reasoningLevel: options.reasoningLevel,
				messages: apiMessages,
				token: options.token,
				onReasoning: text => emit({ type: 'reasoning', text, done: false }),
				onAssistant: text => emit({ type: 'assistant', text, done: false }),
			});
		} catch (error) {
			if (error instanceof vscode.CancellationError || options.token.isCancellationRequested) {
				throw error;
			}
			const message = error instanceof Error ? error.message : String(error);
			throw annotateProviderError(message, options.provider);
		}

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

		// Text already streamed stays in the timeline. Tool rows are appended after it,
		// and the next round starts a new assistant segment.

		const roundNames = toolCalls.map(call => normalizeToolName(call.function.name));
		const roundIsExploreOnly = roundNames.length > 0
			&& roundNames.every(name => isExploreTool(name) || name === 'TodoWrite');
		if (roundIsExploreOnly) {
			exploreOnlyRounds += 1;
		} else {
			exploreOnlyRounds = 0;
		}

		for (const call of toolCalls) {
			if (options.token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			const toolName = normalizeToolName(call.function.name);
			const preview = previewToolArgs(toolName, call.function.arguments);
			emit({
				type: 'tool_start',
				id: call.id,
				toolName,
				summary: preview,
				detail: describeToolInvocation(toolName, call.function.arguments),
			});

			let result: ToolExecResult;
			if (toolName === 'TodoWrite') {
				const applied = applyTodoWrite(todos, call.function.arguments);
				todos = applied.todos;
				result = { summary: applied.summary, content: applied.content };
				emit({ type: 'todos', todos });
			} else if (toolName === 'AskUserQuestion') {
				result = await executeAskUserQuestion(
					call.id,
					call.function.arguments,
					options.askUser,
					options.token,
				);
			} else {
				result = await executeTool(toolName, call.function.arguments, root, {
					sessionId: options.sessionAwareness?.sessionId,
					readFileState,
					onFileChange: change => {
						emit({
							type: 'file_change',
							uri: change.uri.toString(),
							path: change.path,
							kind: change.kind,
							added: change.added,
							removed: change.removed,
						});
					},
				});
			}

			const ok = !result.content.startsWith('Error:');
			emit({
				type: 'tool_end',
				id: call.id,
				toolName,
				summary: result.summary,
				ok,
				detail: result.detail,
				path: result.path,
				uri: result.uri,
				added: result.added,
				removed: result.removed,
			});
			apiMessages.push({
				role: 'tool',
				tool_call_id: call.id,
				name: toolName,
				content: result.content,
			});
		}

		if (!exploreNudgeSent && exploreOnlyRounds >= exploreNudgeAt) {
			exploreNudgeSent = true;
			apiMessages.push({
				role: 'user',
				content: 'Stop exploring. You have enough context — apply the code changes with write_file/str_replace now (or say what single fact is still blocking you).',
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

/** Full command or arguments shown when a running tool row is expanded. */
function describeToolInvocation(name: string, argsJson: string): string | undefined {
	try {
		const args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
		if (name === 'run_terminal_cmd') {
			const command = typeof args.command === 'string' ? args.command.trim() : '';
			if (!command) {
				return undefined;
			}
			const cwd = typeof args.cwd === 'string' ? args.cwd.trim() : '';
			return cwd ? `$ ${command}\n# cwd: ${cwd}` : `$ ${command}`;
		}
		if (name === 'web_fetch') {
			const url = typeof args.url === 'string' ? args.url.trim() : '';
			return url || undefined;
		}
		const text = JSON.stringify(args, null, 2);
		return text && text !== '{}' ? text : undefined;
	} catch {
		const raw = argsJson.trim();
		return raw || undefined;
	}
}

function previewToolArgs(name: string, argsJson: string): string {
	try {
		const args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
		if (name === 'TodoWrite') {
			const todos = Array.isArray(args.todos) ? args.todos : [];
			return `TodoWrite (${todos.length})`;
		}
		if (name === 'AskUserQuestion') {
			const prompt = normalizeZCodeAsk(args, 'ask');
			if (prompt.questions.length === 1) {
				return prompt.questions[0].prompt;
			}
			return prompt.questions.length
				? `AskUserQuestion (${prompt.questions.length})`
				: 'AskUserQuestion';
		}
		if (name === 'grep') {
			const pattern = typeof args.pattern === 'string' ? args.pattern : '';
			const glob = typeof args.glob === 'string' ? args.glob : '';
			return glob ? `grep ${pattern} (${glob})` : `grep ${pattern || '(empty)'}`;
		}
		if (name === 'glob') {
			const pattern = typeof args.pattern === 'string' ? args.pattern : '';
			return `glob ${pattern || '(empty)'}`;
		}
		if (name === 'run_terminal_cmd') {
			const command = typeof args.command === 'string' ? args.command.trim() : '';
			return command ? `shell ${ellipsize(command, 80)}` : 'shell';
		}
		if (name === 'get_diagnostics') {
			const p = typeof args.path === 'string' ? args.path : '';
			return p ? `diagnostics ${p}` : 'diagnostics';
		}
		if (name === 'web_fetch') {
			const url = typeof args.url === 'string' ? args.url : '';
			return url ? `fetch ${ellipsize(url, 80)}` : 'fetch';
		}
		if (name === 'delete_file') {
			const p = typeof args.path === 'string' ? args.path : '';
			return p ? `delete ${p}` : 'delete';
		}
		if (name === 'open_browser_page' || name === 'browser_navigate') {
			const url = typeof args.url === 'string' ? args.url : '';
			return url ? `browser ${ellipsize(url, 80)}` : 'browser';
		}
		if (name === 'browser_click' || name === 'browser_type' || name === 'browser_hover') {
			const el = typeof args.element === 'string' ? args.element
				: typeof args.ref === 'string' ? args.ref
					: typeof args.selector === 'string' ? args.selector : '';
			return el ? `${name.replace(/_/g, ' ')} ${ellipsize(el, 48)}` : name.replace(/_/g, ' ');
		}
		if (name.startsWith('browser_')) {
			return name.replace(/_/g, ' ');
		}
		const p = typeof args.path === 'string' ? args.path : '';
		return p ? `${name} ${p}` : name;
	} catch {
		return name;
	}
}

async function executeAskUserQuestion(
	callId: string,
	argsJson: string,
	askUser: AskUserHandler | undefined,
	token: vscode.CancellationToken,
): Promise<ToolExecResult> {
	let args: Record<string, unknown> = {};
	try {
		args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
	} catch {
		return { summary: 'AskUserQuestion invalid JSON', content: 'Error: tool arguments must be JSON' };
	}

	const prompt = normalizeZCodeAsk(args, callId);
	if (!prompt.questions.length) {
		return {
			summary: 'AskUserQuestion empty',
			content: 'Error: provide questions[{question,options}] or a single question+options',
		};
	}

	if (!askUser) {
		return {
			summary: 'AskUserQuestion unavailable',
			content: formatZCodeAskToolContent(prompt, { outcome: 'skipped', reason: 'UI not available' }),
		};
	}

	if (token.isCancellationRequested) {
		throw new vscode.CancellationError();
	}

	const result = await askUser(prompt, token);
	if (result.outcome === 'cancelled' || token.isCancellationRequested) {
		throw new vscode.CancellationError();
	}

	return {
		summary: summarizeAskResult(prompt, result),
		content: formatZCodeAskToolContent(prompt, result),
		detail: formatZCodeAskToolContent(prompt, result),
	};
}

async function resolveAuth(provider: ProviderMode): Promise<{ url: string; apiKey: string; api: ProviderApiKind }> {
	if (provider === 'startPlan') {
		try {
			const jwt = getAuthService().getSession()?.zcodeJwtToken?.trim();
			if (jwt) {
				return { url: START_PLAN_ANTHROPIC_URL, apiKey: jwt, api: 'anthropic' };
			}
		} catch {
			// ignore
		}
		throw new Error(
			'Start Plan needs a ZCode login JWT. Sign in, or switch the provider to BigModel to use your Coding Plan package.',
		);
	}

	const codingKey = await loadCodingPlanApiKey('bigmodel');
	if (codingKey) {
		return { url: BIGMODEL_CODING_CHAT_URL, apiKey: codingKey, api: 'openai' };
	}

	throw new Error(
		'No BigModel Coding Plan API key found in ~/.zcode/v2/credentials.json. Sign in with BigModel in ZCode desktop (or this IDE) and ensure Coding Plan is connected.',
	);
}

function annotateProviderError(message: string, provider: ProviderMode): Error {
	const quotaHint = /余额不足|无可用资源包|insufficient|quota|credit/i.test(message);
	if (!quotaHint) {
		return new Error(message);
	}
	if (provider === 'startPlan') {
		return new Error(
			`${message}\n（当前是 Start Plan。若额度在 BigModel Coding Plan 上，请把 provider 切到 BigModel。）`,
		);
	}
	return new Error(
		`${message}\n（已走 Coding Plan 接口 /api/coding/paas/v4。若仍报余额不足，请在 bigmodel.cn Coding Plan 页确认套餐未过期，或换模型重试。）`,
	);
}

function toAnthropicTools(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
	return TOOLS.map(tool => ({
		name: tool.function.name,
		description: tool.function.description,
		input_schema: tool.function.parameters as Record<string, unknown>,
	}));
}

function toAnthropicPayload(messages: ChatCompletionMessage[]): {
	system: string;
	messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
} {
	const systemParts: string[] = [];
	const out: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];

	const pushUser = (content: unknown) => {
		const last = out[out.length - 1];
		if (last?.role === 'user' && Array.isArray(last.content) && Array.isArray(content)) {
			last.content = [...last.content, ...content];
			return;
		}
		out.push({ role: 'user', content });
	};

	for (const message of messages) {
		if (message.role === 'system') {
			if (typeof message.content === 'string' && message.content.trim()) {
				systemParts.push(message.content.trim());
			}
			continue;
		}
		if (message.role === 'user') {
			pushUser(message.content ?? '');
			continue;
		}
		if (message.role === 'assistant') {
			const blocks: Array<Record<string, unknown>> = [];
			if (typeof message.content === 'string' && message.content) {
				blocks.push({ type: 'text', text: message.content });
			}
			for (const call of message.tool_calls ?? []) {
				let input: unknown = {};
				try {
					input = JSON.parse(call.function.arguments || '{}');
				} catch {
					input = { raw: call.function.arguments };
				}
				blocks.push({
					type: 'tool_use',
					id: call.id,
					name: call.function.name,
					input,
				});
			}
			out.push({ role: 'assistant', content: blocks.length ? blocks : '' });
			continue;
		}
		if (message.role === 'tool') {
			pushUser([{
				type: 'tool_result',
				tool_use_id: message.tool_call_id,
				content: message.content ?? '',
			}]);
		}
	}

	// Anthropic requires the conversation to start with a user turn.
	if (out.length && out[0].role !== 'user') {
		out.unshift({ role: 'user', content: '(continue)' });
	}

	return { system: systemParts.join('\n\n'), messages: out };
}

function anthropicHeaders(apiKey: string): Record<string, string> {
	return {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${apiKey}`,
		'anthropic-version': '2023-06-01',
		'x-api-key': apiKey,
	};
}

function parseAnthropicContent(content: unknown): { text: string; tool_calls?: ToolCall[] } {
	if (typeof content === 'string') {
		return { text: content };
	}
	if (!Array.isArray(content)) {
		return { text: '' };
	}
	let text = '';
	const toolCalls: ToolCall[] = [];
	for (const block of content) {
		if (!block || typeof block !== 'object') {
			continue;
		}
		const row = block as Record<string, unknown>;
		if (row.type === 'text' && typeof row.text === 'string') {
			text += row.text;
		}
		if (row.type === 'tool_use' && typeof row.id === 'string' && typeof row.name === 'string') {
			toolCalls.push({
				id: row.id,
				type: 'function',
				function: {
					name: row.name,
					arguments: JSON.stringify(row.input ?? {}),
				},
			});
		}
	}
	return { text, tool_calls: toolCalls.length ? toolCalls : undefined };
}

async function completeAnthropicMessages(options: {
	url: string;
	apiKey: string;
	model: string;
	messages: ChatCompletionMessage[];
	token: vscode.CancellationToken;
	onReasoning: (text: string) => void;
	onAssistant: (text: string) => void;
}): Promise<{ content: string; reasoning: string; tool_calls?: ToolCall[] }> {
	const { system, messages } = toAnthropicPayload(options.messages);
	const controller = new AbortController();
	const cancel = options.token.onCancellationRequested(() => controller.abort());
	try {
		const response = await fetch(options.url, {
			method: 'POST',
			headers: anthropicHeaders(options.apiKey),
			body: JSON.stringify({
				model: options.model,
				max_tokens: 16_384,
				system: system || undefined,
				messages,
				tools: toAnthropicTools(),
				stream: false,
			}),
			signal: controller.signal,
		});
		const raw = await response.text();
		let data: { content?: unknown; error?: { message?: string }; msg?: string };
		try {
			data = JSON.parse(raw) as typeof data;
		} catch {
			throw new Error(`Provider returned non-JSON (${response.status}): ${raw.slice(0, 300)}`);
		}
		if (!response.ok) {
			throw new Error(data.error?.message || data.msg || `HTTP ${response.status}: ${raw.slice(0, 300)}`);
		}
		const parsed = parseAnthropicContent(data.content);
		if (parsed.text && !(parsed.tool_calls && parsed.tool_calls.length)) {
			options.onAssistant(parsed.text);
		}
		return { content: parsed.text, reasoning: '', tool_calls: parsed.tool_calls };
	} finally {
		cancel.dispose();
	}
}

async function streamAnthropicMessages(options: {
	url: string;
	apiKey: string;
	model: string;
	messages: ChatCompletionMessage[];
	token: vscode.CancellationToken;
	onReasoning: (text: string) => void;
	onAssistant: (text: string) => void;
}): Promise<{ content: string; reasoning: string; tool_calls?: ToolCall[] }> {
	const { system, messages } = toAnthropicPayload(options.messages);
	const controller = new AbortController();
	const cancel = options.token.onCancellationRequested(() => controller.abort());
	try {
		const response = await fetch(options.url, {
			method: 'POST',
			headers: {
				...anthropicHeaders(options.apiKey),
				Accept: 'text/event-stream',
			},
			body: JSON.stringify({
				model: options.model,
				max_tokens: 16_384,
				system: system || undefined,
				messages,
				tools: toAnthropicTools(),
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
		const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
		let lastContentEmit = 0;
		let currentToolIndex = -1;

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
					type?: string;
					index?: number;
					content_block?: { type?: string; id?: string; name?: string; text?: string };
					delta?: { type?: string; text?: string; partial_json?: string };
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
				if (json.type === 'content_block_start' && json.content_block?.type === 'tool_use') {
					currentToolIndex += 1;
					toolCalls.set(currentToolIndex, {
						id: json.content_block.id || `tool_${currentToolIndex}`,
						name: json.content_block.name || '',
						arguments: '',
					});
					continue;
				}
				if (json.type === 'content_block_delta') {
					if (json.delta?.type === 'text_delta' && typeof json.delta.text === 'string') {
						content += json.delta.text;
						if (toolCalls.size === 0) {
							const now = Date.now();
							if (now - lastContentEmit > 80) {
								options.onAssistant(content);
								lastContentEmit = now;
							}
						}
					}
					if (json.delta?.type === 'input_json_delta' && typeof json.delta.partial_json === 'string') {
						const index = typeof json.index === 'number' ? json.index : currentToolIndex;
						const existing = toolCalls.get(index);
						if (existing) {
							existing.arguments += json.delta.partial_json;
							toolCalls.set(index, existing);
						}
					}
				}
			}
		}

		if (content && toolCalls.size === 0) {
			options.onAssistant(content);
		}
		const calls = [...toolCalls.values()]
			.filter(call => call.name)
			.map(call => ({
				id: call.id,
				type: 'function' as const,
				function: { name: call.name, arguments: call.arguments || '{}' },
			}));
		return {
			content,
			reasoning: '',
			tool_calls: calls.length ? calls : undefined,
		};
	} finally {
		cancel.dispose();
	}
}

async function streamOrCompleteChat(options: {
	url: string;
	apiKey: string;
	api: ProviderApiKind;
	model: string;
	reasoningLevel: string;
	messages: ChatCompletionMessage[];
	token: vscode.CancellationToken;
	onReasoning: (text: string) => void;
	onAssistant: (text: string) => void;
}): Promise<{ content: string; reasoning: string; tool_calls?: ToolCall[] }> {
	if (options.api === 'anthropic') {
		try {
			return await streamAnthropicMessages(options);
		} catch (error) {
			if (options.token.isCancellationRequested) {
				throw error;
			}
			return completeAnthropicMessages(options);
		}
	}

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
	reasoningLevel: string;
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
				...buildReasoningRequestFields(options.reasoningLevel),
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
	reasoningLevel: string;
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
				...buildReasoningRequestFields(options.reasoningLevel),
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

interface ToolExecResult {
	summary: string;
	content: string;
	detail?: string;
	path?: string;
	uri?: string;
	added?: number;
	removed?: number;
}

interface ToolExecContext {
	sessionId?: string;
	readFileState?: Map<string, { mtimeMs: number; size: number }>;
	onFileChange?: FileChangeReporter;
}

async function rememberReadState(
	filePath: string,
	readFileState: Map<string, { mtimeMs: number; size: number }> | undefined,
): Promise<void> {
	if (!readFileState) {
		return;
	}
	try {
		const st = await fs.stat(filePath);
		readFileState.set(filePath, { mtimeMs: st.mtimeMs, size: st.size });
	} catch {
		readFileState.delete(filePath);
	}
}

async function assertWritableFresh(
	filePath: string,
	pathLabel: string,
	sessionId: string | undefined,
	readFileState: Map<string, { mtimeMs: number; size: number }> | undefined,
): Promise<ToolExecResult | undefined> {
	const edits = getFileEditSession();
	const owner = edits.ownerOf(filePath);
	if (owner && sessionId && owner !== sessionId) {
		return {
			summary: `write blocked ${pathLabel}`,
			content: `Error: write_file_conflict — another chat session (${owner}) already has pending edits on ${pathLabel}. Do not overwrite; work on a different file or ask the user.`,
			path: pathLabel,
			uri: vscode.Uri.file(filePath).toString(),
		};
	}
	const prior = readFileState?.get(filePath);
	if (!prior) {
		return undefined;
	}
	try {
		const st = await fs.stat(filePath);
		if (st.mtimeMs !== prior.mtimeMs || st.size !== prior.size) {
			return {
				summary: `stale ${pathLabel}`,
				content: `Error: write_file_stale — File has been modified since read (by the user, another session, or a tool). Read ${pathLabel} again before writing.`,
				path: pathLabel,
				uri: vscode.Uri.file(filePath).toString(),
			};
		}
	} catch {
		// File may be a create path; allow write.
	}
	return undefined;
}

async function executeTool(
	rawName: string,
	argsJson: string,
	root: string,
	ctx?: ToolExecContext,
): Promise<ToolExecResult> {
	const name = normalizeToolName(rawName);
	let args: Record<string, unknown> = {};
	try {
		args = normalizeToolArgs(name, JSON.parse(argsJson || '{}') as Record<string, unknown>);
	} catch {
		return { summary: 'invalid JSON args', content: 'Error: tool arguments must be JSON' };
	}

	const edits = getFileEditSession();
	const onFileChange = ctx?.onFileChange;
	const sessionId = ctx?.sessionId;
	const readFileState = ctx?.readFileState;

	try {
		switch (name) {
			case 'read_file': {
				const filePath = resolvePath(String(args.path ?? ''), root);
				const text = await fs.readFile(filePath, 'utf8');
				await rememberReadState(filePath, readFileState);
				const pathLabel = rel(filePath, root);
				const peerOwner = edits.ownerOf(filePath);
				const peerNote = peerOwner && sessionId && peerOwner !== sessionId
					? `\n\n<system-reminder>Pending edits on this file belong to another chat session (${peerOwner}). Prefer not to write it unless the user explicitly asks.</system-reminder>`
					: '';
				if (!text) {
					return {
						summary: `read ${pathLabel} (empty)`,
						content: `<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>${peerNote}`,
						path: pathLabel,
						uri: vscode.Uri.file(filePath).toString(),
					};
				}
				const offset = typeof args.offset === 'number' ? args.offset : undefined;
				// Match ZCode Read: default cap 2000 lines unless limit omitted intentionally with offset-only.
				const limit = typeof args.limit === 'number'
					? args.limit
					: (offset !== undefined ? undefined : READ_DEFAULT_MAX_LINES);
				const sliced = sliceFileLines(text, offset, limit);
				const clipped = sliced.text.length > 80_000
					? `${sliced.text.slice(0, 80_000)}\n…(truncated)`
					: sliced.text;
				return {
					summary: sliced.rangeLabel
						? `read ${pathLabel} ${sliced.rangeLabel}`
						: `read ${pathLabel} (${text.length} chars)`,
					content: `${clipped}${peerNote}`,
					detail: clipped.length > 12_000 ? `${clipped.slice(0, 12_000)}\n…(preview)` : clipped,
					path: pathLabel,
					uri: vscode.Uri.file(filePath).toString(),
				};
			}
			case 'write_file': {
				const filePath = resolvePath(String(args.path ?? ''), root);
				const pathLabel = rel(filePath, root);
				const blocked = await assertWritableFresh(filePath, pathLabel, sessionId, readFileState);
				if (blocked) {
					return blocked;
				}
				const content = String(args.content ?? '');
				let before = '';
				try {
					before = await fs.readFile(filePath, 'utf8');
				} catch {
					before = '';
				}
				const applied = await edits.writeFile(filePath, content, root, sessionId);
				await rememberReadState(filePath, readFileState);
				onFileChange?.({
					uri: applied.uri,
					path: pathLabel,
					kind: applied.kind,
					added: applied.added,
					removed: applied.removed,
				});
				return {
					summary: applied.summary,
					content: 'ok',
					detail: formatLineDiff(before, content),
					path: pathLabel,
					uri: applied.uri.toString(),
					added: applied.added,
					removed: applied.removed,
				};
			}
			case 'str_replace': {
				const filePath = resolvePath(String(args.path ?? ''), root);
				const pathLabel = rel(filePath, root);
				const blocked = await assertWritableFresh(filePath, pathLabel, sessionId, readFileState);
				if (blocked) {
					return blocked;
				}
				const oldString = String(args.old_string ?? '');
				const newString = String(args.new_string ?? '');
				const replaceAll = args.replace_all === true;
				if (!oldString) {
					return { summary: 'str_replace empty', content: 'Error: old_string is required' };
				}
				const text = await fs.readFile(filePath, 'utf8');
				if (!text.includes(oldString)) {
					return {
						summary: `str_replace miss ${pathLabel}`,
						content: 'Error: old_string not found',
					};
				}
				let next: string;
				let count = 0;
				if (replaceAll) {
					next = text.split(oldString).join(newString);
					count = text.split(oldString).length - 1;
				} else {
					const index = text.indexOf(oldString);
					next = text.slice(0, index) + newString + text.slice(index + oldString.length);
					count = 1;
				}
				const applied = await edits.writeFile(filePath, next, root, sessionId);
				await rememberReadState(filePath, readFileState);
				onFileChange?.({
					uri: applied.uri,
					path: pathLabel,
					kind: applied.kind,
					added: applied.added,
					removed: applied.removed,
				});
				return {
					summary: replaceAll
						? `${applied.summary} · ${count} replacement${count === 1 ? '' : 's'}`
						: applied.summary,
					content: 'ok',
					detail: formatLineDiff(oldString, newString),
					path: pathLabel,
					uri: applied.uri.toString(),
					added: applied.added,
					removed: applied.removed,
				};
			}
			case 'delete_file': {
				const filePath = resolvePath(String(args.path ?? ''), root);
				const pathLabel = rel(filePath, root);
				const uri = vscode.Uri.file(filePath);
				const blocked = await assertWritableFresh(filePath, pathLabel, sessionId, readFileState);
				if (blocked) {
					return {
						...blocked,
						summary: `delete blocked ${pathLabel}`,
						content: blocked.content.replace('write_file_conflict', 'delete_file_conflict').replace('write_file_stale', 'delete_file_stale'),
					};
				}
				try {
					await fs.access(filePath);
				} catch {
					return { summary: `delete miss ${pathLabel}`, content: `Error: file not found: ${pathLabel}` };
				}
				const removed = await edits.deleteFile(filePath, root, sessionId);
				onFileChange?.({
					uri: removed.uri,
					path: removed.path,
					kind: 'delete',
					added: 0,
					removed: 0,
				});
				return {
					summary: `deleted ${pathLabel}`,
					content: 'ok',
					path: pathLabel,
					uri: uri.toString(),
				};
			}
			case 'run_terminal_cmd':
				return executeShell(args, root);
			case 'get_diagnostics':
				return executeDiagnostics(args, root);
			case 'web_fetch':
				return executeWebFetch(args);
			case 'list_dir': {
				const dirPath = resolvePath(String(args.path ?? '.'), root);
				const entries = await fs.readdir(dirPath, { withFileTypes: true });
				const lines = entries.slice(0, 200).map(e => `${e.isDirectory() ? 'dir' : 'file'}\t${e.name}`);
				const listing = lines.join('\n') || '(empty)';
				const pathLabel = rel(dirPath, root);
				return {
					summary: `list ${pathLabel} (${entries.length})`,
					content: listing,
					detail: listing,
					path: pathLabel,
				};
			}
			case 'grep':
				return executeGrep(args, root);
			case 'glob':
				return executeGlob(args, root);
			default: {
				const browser = await executeBrowserTool(name, args);
				if (browser) {
					return browser;
				}
				return { summary: `unknown tool ${name}`, content: `Error: unknown tool ${name}` };
			}
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

const DEFAULT_SEARCH_EXCLUDE =
	'**/{node_modules,.git,out,dist,build,.build,coverage,.next,vendor}/**';

async function executeGrep(args: Record<string, unknown>, root: string): Promise<ToolExecResult> {
	const pattern = String(args.pattern ?? '').trim();
	if (!pattern) {
		return { summary: 'grep empty', content: 'Error: pattern is required' };
	}

	const maxResults = Math.min(
		200,
		Math.max(1, Math.floor(typeof args.max_results === 'number' ? args.max_results : 50)),
	);
	const caseInsensitive = args.case_insensitive === true;
	const globFilter = typeof args.glob === 'string' && args.glob.trim() ? args.glob.trim() : undefined;
	const outputMode = normalizeGrepOutputMode(args.output_mode);
	const scopePath = typeof args.path === 'string' && args.path.trim()
		? resolvePath(args.path, root)
		: root;
	const scope = await resolveSearchScope(scopePath, root);

	try {
		const rg = await runRipgrep({
			pattern,
			cwd: scope.cwd,
			searchTarget: scope.searchTarget,
			root,
			caseInsensitive,
			globFilter,
			maxResults,
			outputMode,
		});
		if (rg) {
			return rg;
		}
	} catch {
		// fall through to JS walk
	}

	return grepWalkFallback({
		pattern,
		scopePath: scope.filePath ?? scope.cwd,
		root,
		caseInsensitive,
		globFilter,
		maxResults,
		outputMode,
	});
}

function normalizeGrepOutputMode(value: unknown): 'content' | 'files_with_matches' | 'count' {
	if (value === 'files_with_matches' || value === 'count' || value === 'content') {
		return value;
	}
	return 'content';
}

async function executeGlob(args: Record<string, unknown>, root: string): Promise<ToolExecResult> {
	const pattern = String(args.pattern ?? '').trim();
	if (!pattern) {
		return { summary: 'glob empty', content: 'Error: pattern is required' };
	}

	const maxResults = Math.min(
		500,
		Math.max(1, Math.floor(typeof args.max_results === 'number' ? args.max_results : 200)),
	);
	const rawScope = typeof args.path === 'string' && args.path.trim()
		? resolvePath(args.path, root)
		: root;
	const scope = await resolveSearchScope(rawScope, root);
	const scopePath = scope.cwd;

	const include = new vscode.RelativePattern(
		vscode.Uri.file(scopePath),
		pattern.startsWith('**/') || pattern.includes('/') ? pattern : `**/${pattern}`,
	);
	const uris = await vscode.workspace.findFiles(include, DEFAULT_SEARCH_EXCLUDE, maxResults);
	const paths = uris.map(uri => rel(uri.fsPath, root));
	const truncated = paths.length >= maxResults;
	const body = paths.length
		? `${paths.join('\n')}${truncated ? `\n…(truncated at ${maxResults})` : ''}`
		: 'No files matched.';
	return {
		summary: `glob ${paths.length} file${paths.length === 1 ? '' : 's'}`,
		content: body,
		detail: body.length > 12_000 ? `${body.slice(0, 12_000)}\n…(truncated)` : body,
		path: scopePath === path.resolve(root) ? undefined : rel(scopePath, root),
	};
}

async function runRipgrep(options: {
	pattern: string;
	cwd: string;
	/** Relative to cwd, or absolute. Prefer '.' for dirs, basename for single files. */
	searchTarget: string;
	root: string;
	caseInsensitive: boolean;
	globFilter?: string;
	maxResults: number;
	outputMode: 'content' | 'files_with_matches' | 'count';
}): Promise<ToolExecResult | undefined> {
	const args = [
		'--color', 'never',
		'--glob', '!**/node_modules/**',
		'--glob', '!**/.git/**',
		'--glob', '!**/out/**',
		'--glob', '!**/dist/**',
	];
	if (options.outputMode === 'files_with_matches') {
		args.push('-l');
	} else if (options.outputMode === 'count') {
		args.push('-c');
	} else {
		args.push('--line-number', '--no-heading', '--max-count', String(options.maxResults));
	}
	if (options.caseInsensitive) {
		args.push('-i');
	}
	if (options.globFilter) {
		args.push('--glob', options.globFilter);
	}
	args.push('--', options.pattern, options.searchTarget);

	const { code, stdout, stderr } = await spawnCapture('rg', args, options.cwd, 20_000);
	// rg exits 1 when no matches; 2 on error.
	if (code !== 0 && code !== 1) {
		if (/ENOENT|ENOTDIR|not found|rg:/i.test(stderr) || code === null) {
			return undefined;
		}
		return {
			summary: 'grep failed',
			content: `Error: ${stderr.trim() || `rg exited ${code}`}`,
		};
	}

	const rawLines = stdout.split(/\r?\n/).filter(Boolean);
	const truncated = rawLines.length >= options.maxResults;
	const lines = rawLines.slice(0, options.maxResults).map(line => {
		if (options.cwd === path.resolve(options.root)) {
			return line;
		}
		if (options.outputMode === 'files_with_matches') {
			return rel(path.resolve(options.cwd, line), options.root);
		}
		if (options.outputMode === 'count') {
			const cm = /^(.+):(\d+)$/.exec(line);
			if (!cm) {
				return line;
			}
			return `${rel(path.resolve(options.cwd, cm[1]!), options.root)}:${cm[2]}`;
		}
		const m = /^([^:]+):(\d+):(.*)$/.exec(line);
		if (!m) {
			return line;
		}
		const abs = path.resolve(options.cwd, m[1]!);
		return `${rel(abs, options.root)}:${m[2]}:${m[3]}`;
	});
	const body = lines.length
		? `${lines.join('\n')}${truncated ? `\n…(truncated at ${options.maxResults})` : ''}`
		: 'No matches found.';
	const noun = options.outputMode === 'files_with_matches' ? 'file' : 'match';
	return {
		summary: `grep ${lines.length} ${noun}${lines.length === 1 ? '' : 'es'}`,
		content: body,
		detail: body.length > 12_000 ? `${body.slice(0, 12_000)}\n…(preview)` : body,
		path: options.cwd === path.resolve(options.root) ? undefined : rel(options.cwd, options.root),
	};
}

async function grepWalkFallback(options: {
	pattern: string;
	scopePath: string;
	root: string;
	caseInsensitive: boolean;
	globFilter?: string;
	maxResults: number;
	outputMode: 'content' | 'files_with_matches' | 'count';
}): Promise<ToolExecResult> {
	let regex: RegExp;
	try {
		regex = new RegExp(options.pattern, options.caseInsensitive ? 'i' : '');
	} catch {
		return { summary: 'grep invalid regex', content: `Error: invalid regex: ${options.pattern}` };
	}

	let uris: vscode.Uri[] = [];
	try {
		const st = await fs.stat(options.scopePath);
		if (st.isFile()) {
			uris = [vscode.Uri.file(options.scopePath)];
		}
	} catch {
		// fall through to findFiles
	}
	if (!uris.length) {
		const base = await resolveDirForSpawn(options.scopePath, options.root);
		const include = new vscode.RelativePattern(
			vscode.Uri.file(base),
			options.globFilter
				? (options.globFilter.startsWith('**/') || options.globFilter.includes('/')
					? options.globFilter
					: `**/${options.globFilter}`)
				: '**/*',
		);
		uris = await vscode.workspace.findFiles(include, DEFAULT_SEARCH_EXCLUDE, 2_000);
	}
	const contentLines: string[] = [];
	const fileHits = new Map<string, number>();
	for (const uri of uris) {
		if (options.outputMode === 'content' && contentLines.length >= options.maxResults) {
			break;
		}
		if (options.outputMode !== 'content' && fileHits.size >= options.maxResults) {
			break;
		}
		let text: string;
		try {
			text = await fs.readFile(uri.fsPath, 'utf8');
		} catch {
			continue;
		}
		if (text.includes('\0')) {
			continue;
		}
		const fileLines = text.split(/\r?\n/);
		const pathLabel = rel(uri.fsPath, options.root);
		let fileCount = 0;
		for (let i = 0; i < fileLines.length; i++) {
			if (options.outputMode === 'content' && contentLines.length >= options.maxResults) {
				break;
			}
			const line = fileLines[i] ?? '';
			if (regex.test(line)) {
				fileCount++;
				if (options.outputMode === 'content') {
					contentLines.push(`${pathLabel}:${i + 1}: ${line.trim().slice(0, 240)}`);
				}
			}
		}
		if (fileCount > 0 && options.outputMode !== 'content') {
			fileHits.set(pathLabel, fileCount);
		}
	}

	let lines: string[];
	if (options.outputMode === 'files_with_matches') {
		lines = [...fileHits.keys()];
	} else if (options.outputMode === 'count') {
		lines = [...fileHits.entries()].map(([p, n]) => `${p}:${n}`);
	} else {
		lines = contentLines;
	}
	const truncated = lines.length >= options.maxResults;
	const body = lines.length
		? `${lines.join('\n')}${truncated ? `\n…(truncated at ${options.maxResults})` : ''}`
		: 'No matches found.';
	const noun = options.outputMode === 'files_with_matches' ? 'file' : 'match';
	return {
		summary: `grep ${lines.length} ${noun}${lines.length === 1 ? '' : 'es'}`,
		content: body,
		detail: body.length > 12_000 ? `${body.slice(0, 12_000)}\n…(preview)` : body,
		path: options.scopePath === path.resolve(options.root) ? undefined : rel(options.scopePath, options.root),
	};
}

async function resolveSearchScope(
	scopePath: string,
	root: string,
): Promise<{ cwd: string; searchTarget: string; filePath?: string }> {
	try {
		const st = await fs.stat(scopePath);
		if (st.isFile()) {
			return {
				cwd: path.dirname(scopePath),
				searchTarget: path.basename(scopePath),
				filePath: scopePath,
			};
		}
		if (st.isDirectory()) {
			return { cwd: scopePath, searchTarget: '.' };
		}
	} catch {
		// missing path — search from root
	}
	const cwd = await resolveDirForSpawn(scopePath, root);
	return { cwd, searchTarget: '.' };
}

/** ZCode Read uses cat -n style: `${line}\t${content}`. */
function sliceFileLines(
	raw: string,
	offset: number | undefined,
	limit: number | undefined,
): { text: string; rangeLabel?: string } {
	const lines = raw.split(/\r?\n/);
	const total = lines.length;
	const maxLines = limit !== undefined && Number.isFinite(limit)
		? Math.max(1, Math.min(Math.floor(limit), 5_000))
		: undefined;

	let start: number;
	if (offset === undefined || !Number.isFinite(offset)) {
		start = 1;
	} else if (offset < 0) {
		const fromEnd = Math.abs(Math.floor(offset));
		start = Math.max(1, total - fromEnd + 1);
	} else {
		start = Math.max(1, Math.floor(offset));
	}

	const from = Math.min(start - 1, total);
	const slice = maxLines === undefined ? lines.slice(from) : lines.slice(from, from + maxLines);
	const end = from + slice.length;
	const numbered = slice.map((line, i) => `${from + i + 1}\t${line}`).join('\n');
	const truncated = end < total || (maxLines !== undefined && from === 0 && total > maxLines);
	const rangeLabel = truncated || from > 0
		? `L${from + 1}-${end}/${total}${end < total ? ' (truncated)' : ''}`
		: undefined;
	return { text: numbered, rangeLabel };
}

async function executeShell(
	args: Record<string, unknown>,
	root: string,
): Promise<ToolExecResult> {
	const command = typeof args.command === 'string' ? args.command.trim() : '';
	if (!command) {
		return { summary: 'shell empty', content: 'Error: command is required' };
	}
	let cwd = root;
	if (typeof args.cwd === 'string' && args.cwd.trim()) {
		const resolved = resolvePath(args.cwd.trim(), root);
		const normalizedRoot = path.resolve(root);
		if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
			return {
				summary: 'shell blocked',
				content: 'Error: cwd must stay inside the workspace.',
			};
		}
		cwd = resolved;
	}
	cwd = await resolveDirForSpawn(cwd, root);
	const rawTimeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : 60_000;
	const timeoutMs = Math.max(1_000, Math.min(Math.floor(rawTimeout), 600_000));
	const description = typeof args.description === 'string' ? args.description.trim() : '';

	const result = await runShellCommand({ command, cwd, timeoutMs });
	const parts = [
		`exit ${result.code ?? 'null'}`,
		result.stdout ? `stdout:\n${result.stdout}` : '(no stdout)',
		result.stderr ? `stderr:\n${result.stderr}` : '',
		result.timedOut ? '(timed out)' : '',
	].filter(Boolean);
	const body = parts.join('\n\n');
	const detail = `$ ${command}\n\n${body.length > 12_000 ? `${body.slice(0, 12_000)}\n…(truncated)` : body}`;
	const label = description || command;
	if (result.timedOut) {
		return {
			summary: `shell timed out · ${ellipsize(label, 48)}`,
			content: truncatePreview(body, 30_000),
			detail,
		};
	}
	if (result.code === null && result.stderr) {
		return {
			summary: 'shell failed',
			content: `Error: ${result.stderr}`,
			detail,
		};
	}
	return {
		summary: result.code === 0
			? `shell ok · ${ellipsize(label, 48)}`
			: `shell exit ${result.code}`,
		content: truncatePreview(body, 30_000),
		detail,
	};
}

async function executeDiagnostics(
	args: Record<string, unknown>,
	root: string,
): Promise<ToolExecResult> {
	const maxResultsRaw = typeof args.max_results === 'number' ? args.max_results : 50;
	const maxResults = Math.max(1, Math.min(Math.floor(maxResultsRaw), 200));
	const pathArg = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined;

	if (pathArg) {
		const filePath = resolvePath(pathArg, root);
		if (!filePath.startsWith(root)) {
			return { summary: 'path outside workspace', content: `Error: Path outside workspace: ${pathArg}` };
		}
		const uri = vscode.Uri.file(filePath);
		const label = rel(filePath, root);
		const diags = vscode.languages.getDiagnostics(uri)
			.filter(d => d.severity !== vscode.DiagnosticSeverity.Hint)
			.slice(0, maxResults);
		if (!diags.length) {
			return { summary: `no diagnostics in ${label}`, content: `No problems in ${label}.` };
		}
		return {
			summary: `${diags.length} problem(s) in ${label}`,
			content: diags.map(d => formatDiagnosticLine(uri, d)).join('\n'),
		};
	}

	const rows: { uri: vscode.Uri; d: vscode.Diagnostic }[] = [];
	for (const [uri, list] of vscode.languages.getDiagnostics()) {
		if (!uri.fsPath.startsWith(root)) {
			continue;
		}
		for (const d of list) {
			if (d.severity === vscode.DiagnosticSeverity.Hint) {
				continue;
			}
			rows.push({ uri, d });
		}
	}
	rows.sort((a, b) => a.d.severity - b.d.severity);
	const limited = rows.slice(0, maxResults);
	if (!limited.length) {
		return { summary: 'no diagnostics', content: 'No problems in the workspace.' };
	}
	const extra = rows.length > limited.length ? `\n… and ${rows.length - limited.length} more` : '';
	return {
		summary: `${rows.length} problem(s)`,
		content: limited.map(({ uri, d }) => formatDiagnosticLine(uri, d)).join('\n') + extra,
	};
}

function formatDiagnosticLine(uri: vscode.Uri, d: vscode.Diagnostic): string {
	const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'error'
		: d.severity === vscode.DiagnosticSeverity.Warning ? 'warning'
			: d.severity === vscode.DiagnosticSeverity.Information ? 'info' : 'hint';
	const file = vscode.workspace.asRelativePath(uri, false);
	const line = d.range.start.line + 1;
	const col = d.range.start.character + 1;
	return `${sev} ${file}:${line}:${col} ${d.message}`;
}

async function executeWebFetch(args: Record<string, unknown>): Promise<ToolExecResult> {
	const url = typeof args.url === 'string' ? args.url.trim() : '';
	if (!url) {
		return { summary: 'fetch empty', content: 'Error: url is required' };
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { summary: 'invalid url', content: `Error: Invalid URL: ${url}` };
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return { summary: 'unsupported scheme', content: 'Error: Only http(s) URLs are allowed.' };
	}
	const maxCharsRaw = typeof args.max_chars === 'number' ? args.max_chars : 30_000;
	const maxChars = Math.max(1_000, Math.min(Math.floor(maxCharsRaw), 80_000));

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 20_000);
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			redirect: 'follow',
			headers: { 'User-Agent': 'ZCode-Harness/1.0', Accept: 'text/*,application/json,application/xhtml+xml' },
		});
		const contentType = res.headers.get('content-type') || '';
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.byteLength > 512_000) {
			return {
				summary: `fetch ${res.status} too large`,
				content: `Error: Response is ${buf.byteLength} bytes (max 512KB).`,
			};
		}
		let text = buf.toString('utf8');
		if (/html/i.test(contentType) || /^\s*</.test(text)) {
			text = htmlToReadableText(text);
		}
		return {
			summary: `fetch ${res.status}`,
			content: truncatePreview(
				`URL: ${url}\nStatus: ${res.status} ${res.statusText}\nContent-Type: ${contentType}\n\n${text}`,
				maxChars,
			),
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { summary: 'fetch failed', content: `Error: ${msg}` };
	} finally {
		clearTimeout(timer);
	}
}

function htmlToReadableText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/\s+/g, ' ')
		.trim();
}
