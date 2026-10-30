/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentProgressEvent } from './agentRuntime';
import {
	cursorAskResponse,
	normalizeCursorAsk,
	type AskUserHandler,
} from './askUser';
import { getCursorAgentMode, getCursorModel } from './brains';
import type { ChatMessage } from './bridge';
import type { TodoItem, TodoStatus } from './conversation';
import { CursorAcpClient, type AcpSessionUpdate } from './cursorAcpClient';
import { getCursorAuthStatus, promptCursorLogin } from './cursorAuth';
import { getFileEditSession } from './fileEditSession';

export interface CursorAgentRunOptions {
	messages: ChatMessage[];
	workspaceRoot?: string;
	token: vscode.CancellationToken;
	onProgress?: (event: AgentProgressEvent) => void;
	initialTodos?: TodoItem[];
	mode?: 'agent' | 'plan' | 'ask';
	model?: string;
	askUser?: AskUserHandler;
}

export interface CursorAgentRunResult {
	text: string;
	todos: TodoItem[];
}

/**
 * Run one chat turn through Cursor CLI ACP, mapping updates onto the shared
 * AgentProgressEvent timeline and tracking disk edits for the working set.
 */
export async function runCursorAgent(options: CursorAgentRunOptions): Promise<CursorAgentRunResult> {
	const auth = await getCursorAuthStatus();
	if (!auth.loggedIn && !process.env.CURSOR_API_KEY && !process.env.CURSOR_AUTH_TOKEN) {
		await promptCursorLogin();
		throw new Error('Cursor Agent is not logged in. Run `agent login` or set CURSOR_API_KEY.');
	}

	const rootRaw = options.workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!rootRaw) {
		throw new Error('Open a workspace folder to use Cursor Agent.');
	}
	// ACP spawn requires a real directory (same ENOTDIR pitfall as ZCode Bash/grep).
	let root = rootRaw;
	try {
		const st = await vscode.workspace.fs.stat(vscode.Uri.file(rootRaw));
		if (st.type === vscode.FileType.File) {
			root = path.dirname(rootRaw);
		}
	} catch {
		// keep rootRaw; ACP start() will assertDirectory with a clear error
	}

	const mode = options.mode ?? getCursorAgentMode();
	const model = options.model ?? getCursorModel();
	let assistantText = '';
	let reasoningText = '';
	let reasoningFinalized = false;
	let todos: TodoItem[] = options.initialTodos ? [...options.initialTodos] : [];
	const toolIds = new Map<string, string>();
	const toolDetails = new Map<string, string>();

	const finalizeReasoning = () => {
		if (reasoningFinalized || !reasoningText) {
			return;
		}
		reasoningFinalized = true;
		options.onProgress?.({ type: 'reasoning', text: reasoningText, done: true });
	};

	/** Baselines captured before ACP writes (open docs + first-seen creates). */
	const originals = new Map<string, string>();
	for (const doc of vscode.workspace.textDocuments) {
		if (doc.uri.scheme === 'file' && doc.uri.fsPath.startsWith(root) && !doc.isUntitled) {
			originals.set(doc.uri.toString(), doc.getText());
		}
	}

	const watch = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(vscode.Uri.file(root), '**/*'),
	);

	const shouldTrack = (uri: vscode.Uri) => {
		if (uri.scheme !== 'file' || !uri.fsPath.startsWith(root)) {
			return false;
		}
		return !/[/\\](node_modules|\.git|out|dist)[/\\]/.test(uri.fsPath);
	};

	const publishExternal = async (uri: vscode.Uri, baseline: string) => {
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			const next = Buffer.from(bytes).toString('utf8');
			if (next === baseline) {
				return;
			}
			const edits = getFileEditSession();
			await edits.trackExternalWrite(uri.fsPath, next, root, baseline);
			const view = edits.list().find(f => f.uri === uri.toString());
			if (view) {
				options.onProgress?.({
					type: 'file_change',
					uri: view.uri,
					path: view.relativePath,
					kind: view.kind,
					added: view.added,
					removed: view.removed,
				});
			}
		} catch {
			// ignore binary / deleted mid-flight
		}
	};

	watch.onDidCreate(uri => {
		if (!shouldTrack(uri)) {
			return;
		}
		const key = uri.toString();
		if (!originals.has(key)) {
			originals.set(key, '');
		}
		void publishExternal(uri, originals.get(key) ?? '');
	});
	watch.onDidChange(uri => {
		if (!shouldTrack(uri)) {
			return;
		}
		const key = uri.toString();
		// Unknown file changed without a pre-snapshot — treat prior as empty only if new;
		// otherwise skip rather than invent a wrong baseline.
		if (!originals.has(key)) {
			return;
		}
		void publishExternal(uri, originals.get(key) ?? '');
	});

	const client = new CursorAcpClient({
		cwd: root,
		mode,
		model: model || undefined,
		onPermission: async (): Promise<'allow-once'> => 'allow-once',
		onLog: (line) => {
			// Keep stderr quiet in the timeline — only surface short actionable lines.
			const trimmed = line.trim();
			if (trimmed && /error|fail|login|auth|denied/i.test(trimmed)) {
				options.onProgress?.({ type: 'status', text: trimmed.slice(0, 160) });
			}
		},
		onUpdate: (update) => {
			applyUpdate(update, {
				onProgress: options.onProgress,
				getAssistant: () => assistantText,
				setAssistant: (t) => { assistantText = t; },
				getReasoning: () => reasoningText,
				setReasoning: (t) => { reasoningText = t; },
				finalizeReasoning,
				toolIds,
				toolDetails,
				workspaceRoot: root,
			});
		},
		onCursorNotification: async (method, params) => {
			if (method === 'cursor/update_todos') {
				todos = mapTodos(params);
				options.onProgress?.({ type: 'todos', todos });
			}
		},
		onCursorRequest: async (method, params) => {
			if (method === 'cursor/update_todos') {
				todos = mapTodos(params);
				options.onProgress?.({ type: 'todos', todos });
				return { outcome: { outcome: 'accepted', todos } };
			}
			if (method === 'cursor/create_plan') {
				const plan = (params as { plan?: string })?.plan;
				if (plan) {
					options.onProgress?.({ type: 'assistant', text: plan, done: false });
					assistantText = plan;
				}
				return { outcome: { outcome: 'accepted' } };
			}
			if (method === 'cursor/ask_question') {
				if (!options.askUser) {
					return { outcome: { outcome: 'skipped', reason: 'UI not available' } };
				}
				const prompt = normalizeCursorAsk(params, `ask-${Date.now().toString(36)}`);
				if (!prompt.questions.length) {
					return { outcome: { outcome: 'skipped', reason: 'No questions provided' } };
				}
				const result = await options.askUser(prompt, options.token);
				return cursorAskResponse(result);
			}
			return { outcome: { outcome: 'cancelled' } };
		},
	});

	const cancelSub = options.token.onCancellationRequested(() => {
		void client.cancel();
		client.dispose();
	});

	try {
		options.onProgress?.({ type: 'status', text: `Cursor Agent · ${root}` });
		await client.start();
		await client.newSession();

		const promptText = buildPrompt(options.messages);
		options.onProgress?.({ type: 'status', text: 'Cursor Agent is working…' });
		await client.prompt(promptText);

		finalizeReasoning();
		if (assistantText) {
			options.onProgress?.({ type: 'assistant', text: assistantText, done: true });
		}

		return {
			text: assistantText.trim() || '(Cursor Agent finished with no text response.)',
			todos,
		};
	} finally {
		cancelSub.dispose();
		watch.dispose();
		client.dispose();
	}
}

function buildPrompt(messages: ChatMessage[]): string {
	const lastUser = [...messages].reverse().find(m => m.role === 'user');
	if (!lastUser) {
		return '';
	}
	// Include short prior context so ACP session can continue shared history.
	const prior = messages
		.filter(m => m !== lastUser)
		.slice(-6)
		.map(m => `${m.role.toUpperCase()}: ${m.content}`)
		.join('\n\n');
	if (!prior.trim()) {
		return lastUser.content;
	}
	return `Prior conversation (shared IDE history):\n${prior}\n\nUSER:\n${lastUser.content}`;
}

function extractUpdateText(update: AcpSessionUpdate): string {
	const raw = update.raw as Record<string, unknown> | undefined;
	const candidates = [update.content, raw?.content, raw?.text, raw?.thought, raw?.message];
	for (const c of candidates) {
		if (typeof c === 'string' && c) {
			return c;
		}
		if (c && typeof c === 'object') {
			const obj = c as { text?: unknown; content?: unknown; type?: unknown };
			if (typeof obj.text === 'string' && obj.text) {
				return obj.text;
			}
			if (typeof obj.content === 'string' && obj.content) {
				return obj.content;
			}
			if (Array.isArray(obj.content)) {
				const joined = obj.content
					.map((part: unknown) => {
						if (typeof part === 'string') {
							return part;
						}
						if (part && typeof part === 'object' && typeof (part as { text?: string }).text === 'string') {
							return (part as { text: string }).text;
						}
						return '';
					})
					.join('');
				if (joined) {
					return joined;
				}
			}
		}
	}
	return '';
}

function isThoughtUpdate(kind: string): boolean {
	const k = kind.toLowerCase();
	return k.includes('thought') || k.includes('reasoning') || k === 'thinking' || k === 'agent_thinking';
}

function isMessageUpdate(kind: string): boolean {
	const k = kind.toLowerCase();
	return k.includes('message') && !isThoughtUpdate(k);
}

function applyUpdate(
	update: AcpSessionUpdate,
	ctx: {
		onProgress?: (event: AgentProgressEvent) => void;
		getAssistant: () => string;
		setAssistant: (t: string) => void;
		getReasoning: () => string;
		setReasoning: (t: string) => void;
		finalizeReasoning: () => void;
		toolIds: Map<string, string>;
		toolDetails: Map<string, string>;
		workspaceRoot: string;
	},
): void {
	const kind = update.sessionUpdate || '';
	const text = extractUpdateText(update);

	if (isThoughtUpdate(kind)) {
		if (text) {
			ctx.setReasoning(ctx.getReasoning() + text);
			ctx.onProgress?.({ type: 'reasoning', text: ctx.getReasoning(), done: false });
		}
		return;
	}

	if (isMessageUpdate(kind)) {
		if (text) {
			ctx.finalizeReasoning();
			ctx.setAssistant(ctx.getAssistant() + text);
			ctx.onProgress?.({ type: 'assistant', text: ctx.getAssistant(), done: false });
		}
		return;
	}

	if (kind === 'tool_call' || kind === 'tool_call_start') {
		const id = update.toolCallId || `tool-${ctx.toolIds.size + 1}`;
		ctx.toolIds.set(id, id);
		const name = update.title || update.kind || 'tool';
		ctx.finalizeReasoning();
		ctx.onProgress?.({
			type: 'tool_start',
			id,
			toolName: name,
			summary: name,
		});
		return;
	}

	if (kind === 'tool_call_update' || kind === 'tool_call_end') {
		const id = update.toolCallId || [...ctx.toolIds.keys()].pop() || 'tool';
		const ok = update.status !== 'failed' && update.status !== 'error';
		const name = update.title || update.kind || 'tool';
		// Some builds stream "thinking" as a tool call title.
		if (/think|reason/i.test(name) && text) {
			ctx.setReasoning(ctx.getReasoning() + text);
			ctx.onProgress?.({
				type: 'reasoning',
				text: ctx.getReasoning(),
				done: false,
			});
			if (update.status === 'completed' || kind === 'tool_call_end') {
				ctx.finalizeReasoning();
			}
			return;
		}
		if (text) {
			ctx.toolDetails.set(id, (ctx.toolDetails.get(id) || '') + text);
		}
		const done = update.status === 'completed' || update.status === 'failed'
			|| update.status === 'error' || kind === 'tool_call_end';
		if (!done) {
			return;
		}
		const pathLabel = extractToolPath(update);
		const detail = ctx.toolDetails.get(id) || text || undefined;
		const uri = pathLabel
			? vscode.Uri.file(
				pathLabel.startsWith('/') || /^[A-Za-z]:[\\/]/.test(pathLabel)
					? pathLabel
					: `${ctx.workspaceRoot}/${pathLabel}`,
			).toString()
			: undefined;
		ctx.onProgress?.({
			type: 'tool_end',
			id,
			toolName: name,
			summary: update.title || update.status || 'done',
			ok,
			detail,
			path: pathLabel,
			uri,
		});
		void enrichEditToolDetail(id, name, ok, uri, pathLabel, detail, ctx.onProgress);
		return;
	}
}

function extractToolPath(update: AcpSessionUpdate): string | undefined {
	const raw = update.raw as Record<string, unknown> | undefined;
	const candidates = [
		raw?.path,
		raw?.filePath,
		raw?.file_path,
		(raw?.locations as Array<{ path?: string }> | undefined)?.[0]?.path,
		(raw?.content as { path?: string } | undefined)?.path,
	];
	for (const c of candidates) {
		if (typeof c === 'string' && c.trim()) {
			return c.trim();
		}
	}
	return undefined;
}

async function enrichEditToolDetail(
	id: string,
	toolName: string,
	ok: boolean,
	uri: string | undefined,
	pathLabel: string | undefined,
	existingDetail: string | undefined,
	onProgress?: (event: AgentProgressEvent) => void,
): Promise<void> {
	if (!/edit|write|file/i.test(toolName)) {
		return;
	}
	const edits = getFileEditSession();
	let targetUri = uri;
	if (!targetUri) {
		const latest = edits.list()[0];
		targetUri = latest?.uri;
		pathLabel = pathLabel || latest?.relativePath;
	}
	if (!targetUri) {
		return;
	}
	const preview = await edits.getDiffPreview(targetUri);
	if (!preview) {
		return;
	}
	onProgress?.({
		type: 'tool_end',
		id,
		toolName,
		summary: pathLabel || preview.path,
		ok,
		detail: existingDetail && existingDetail.length > preview.detail.length
			? existingDetail
			: preview.detail,
		path: pathLabel || preview.path,
		uri: targetUri,
		added: preview.added,
		removed: preview.removed,
	});
}

function mapTodos(params: unknown): TodoItem[] {
	const list = (params as { todos?: Array<{ id?: string; content?: string; status?: string }> })?.todos;
	if (!Array.isArray(list)) {
		return [];
	}
	return list.map((t, i) => ({
		id: t.id || `todo-${i}`,
		content: t.content || '',
		status: normalizeTodoStatus(t.status),
	}));
}

function normalizeTodoStatus(status: string | undefined): TodoStatus {
	if (status === 'completed' || status === 'in_progress' || status === 'pending') {
		return status;
	}
	if (status === 'cancelled') {
		return 'completed';
	}
	return 'pending';
}
