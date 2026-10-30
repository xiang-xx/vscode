/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
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
import {
	buildIdeBrowserMcpServers,
	ensureWorkspaceIdeBrowserMcp,
	IDE_BROWSER_PROMPT_HINT,
} from './browserMcp';
import { CursorAcpClient, type AcpSessionUpdate } from './cursorAcpClient';
import { getCursorAuthStatus, promptCursorLogin } from './cursorAuth';
import { getFileEditSession } from './fileEditSession';
import { formatSessionAwareness, type SessionAwareness } from './sessionAwareness';

export interface CursorAgentRunOptions {
	messages: ChatMessage[];
	workspaceRoot?: string;
	token: vscode.CancellationToken;
	onProgress?: (event: AgentProgressEvent) => void;
	initialTodos?: TodoItem[];
	mode?: 'agent' | 'plan' | 'ask';
	model?: string;
	askUser?: AskUserHandler;
	sessionAwareness?: SessionAwareness;
	promptPreamble?: string;
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
	let mcpServers: Awaited<ReturnType<typeof buildIdeBrowserMcpServers>> = [];
	try {
		mcpServers = await buildIdeBrowserMcpServers();
		await ensureWorkspaceIdeBrowserMcp();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		options.onProgress?.({ type: 'status', text: `IDE browser MCP unavailable: ${msg.slice(0, 120)}` });
	}
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

	/** Baselines captured before an agent edit (open docs, then files the agent names). */
	const originals = new Map<string, string>();
	for (const doc of vscode.workspace.textDocuments) {
		if (doc.uri.scheme === 'file' && doc.uri.fsPath.startsWith(root) && !doc.isUntitled) {
			originals.set(doc.uri.toString(), doc.getText());
		}
	}
	/**
	 * Only these paths belong to the agent. A workspace build (or anything else
	 * writing under this folder) must not become a chat edit or open an editor.
	 */
	const agentTouched = new Set<string>();

	const watch = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(vscode.Uri.file(root), '**/*'),
	);

	const rememberAgentFile = (filePath: string | undefined) => {
		if (!filePath?.trim()) {
			return;
		}
		const abs = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
		const uri = vscode.Uri.file(abs);
		if (uri.scheme !== 'file' || !uri.fsPath.startsWith(root) || isGeneratedPath(uri.fsPath)) {
			return;
		}
		const key = uri.toString();
		agentTouched.add(key);
		if (originals.has(key)) {
			return;
		}
		try {
			originals.set(key, fs.readFileSync(abs, 'utf8'));
		} catch {
			originals.set(key, '');
		}
	};

	const shouldTrack = (uri: vscode.Uri) => {
		if (uri.scheme !== 'file' || !uri.fsPath.startsWith(root)) {
			return false;
		}
		if (!agentTouched.has(uri.toString()) || isGeneratedPath(uri.fsPath)) {
			return false;
		}
		return true;
	};

	const ownerSessionId = options.sessionAwareness?.sessionId;
	const publishExternal = async (uri: vscode.Uri, baseline: string) => {
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			const next = Buffer.from(bytes).toString('utf8');
			if (next === baseline) {
				return;
			}
			const edits = getFileEditSession();
			const peer = edits.ownerOf(uri.fsPath);
			if (peer && ownerSessionId && peer !== ownerSessionId) {
				options.onProgress?.({
					type: 'status',
					text: `Skipped tracking ${path.relative(root, uri.fsPath)} — pending edits belong to another session`,
				});
				return;
			}
			await edits.trackExternalWrite(uri.fsPath, next, root, baseline, ownerSessionId);
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
		void publishExternal(uri, originals.get(key) ?? '');
	});
	watch.onDidChange(uri => {
		if (!shouldTrack(uri)) {
			return;
		}
		const key = uri.toString();
		if (!originals.has(key)) {
			return;
		}
		void publishExternal(uri, originals.get(key) ?? '');
	});

	const client = new CursorAcpClient({
		cwd: root,
		mode,
		model: model || undefined,
		mcpServers,
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
				noteAgentFile: rememberAgentFile,
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

		const promptText = buildPrompt(options.messages, options.sessionAwareness, options.promptPreamble);
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

function buildPrompt(messages: ChatMessage[], awareness?: SessionAwareness, preamble?: string): string {
	const lastUser = [...messages].reverse().find(m => m.role === 'user');
	if (!lastUser) {
		return '';
	}
	const header = formatSessionAwareness(awareness);
	// Include short prior context so ACP session can continue shared history.
	const prior = messages
		.filter(m => m !== lastUser)
		.slice(-6)
		.map(m => `${m.role.toUpperCase()}: ${m.content}`)
		.join('\n\n');
	const body = !prior.trim()
		? lastUser.content
		: `Prior conversation (shared IDE history):\n${prior}\n\nUSER:\n${lastUser.content}`;
	const parts = [preamble, header, IDE_BROWSER_PROMPT_HINT, body].filter(Boolean);
	return parts.join('\n\n');
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
		noteAgentFile?: (filePath: string | undefined) => void;
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
		const name = resolveToolName(update);
		const pathLabel = extractToolPath(update);
		if (isFileMutation(update, name)) {
			ctx.noteAgentFile?.(pathLabel);
		}
		const invocation = toolInvocationText(update);
		const summary = usefulToolSummary(pathLabel, name, invocation);
		ctx.finalizeReasoning();
		ctx.onProgress?.({
			type: 'tool_start',
			id,
			toolName: name,
			summary,
			detail: invocation || (isGenericToolLabel(name) ? undefined : name),
		});
		return;
	}

	if (kind === 'tool_call_update' || kind === 'tool_call_end') {
		const id = update.toolCallId || [...ctx.toolIds.keys()].pop() || 'tool';
		const ok = update.status !== 'failed' && update.status !== 'error';
		const name = resolveToolName(update);
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
		if (isFileMutation(update, name)) {
			ctx.noteAgentFile?.(extractToolPath(update));
		}
		const done = update.status === 'completed' || update.status === 'failed'
			|| update.status === 'error' || kind === 'tool_call_end';
		if (!done) {
			const streamed = ctx.toolDetails.get(id);
			const invocation = toolInvocationText(update);
			const pathLabel = extractToolPath(update);
			const detail = [invocation, streamed].filter(Boolean).join('\n\n') || undefined;
			const summary = usefulToolSummary(pathLabel, name, invocation);
			// Only push summary when we have a real label — never overwrite with "tool".
			ctx.onProgress?.({
				type: 'tool_update',
				id,
				...(summary ? { summary } : {}),
				...(detail ? { detail } : {}),
			});
			return;
		}
		const pathLabel = extractToolPath(update);
		if (isFileMutation(update, name)) {
			ctx.noteAgentFile?.(pathLabel);
		}
		const detail = ctx.toolDetails.get(id) || text || undefined;
		const uri = pathLabel
			? vscode.Uri.file(
				pathLabel.startsWith('/') || /^[A-Za-z]:[\\/]/.test(pathLabel)
					? pathLabel
					: `${ctx.workspaceRoot}/${pathLabel}`,
			).toString()
			: undefined;
		const summary = usefulToolSummary(pathLabel, name, detail) || undefined;
		ctx.onProgress?.({
			type: 'tool_end',
			id,
			toolName: name,
			summary,
			ok,
			detail,
			path: pathLabel,
			uri,
		});
		void enrichEditToolDetail(id, name, ok, uri, pathLabel, detail, ctx.onProgress);
		return;
	}
}

function rawInputObject(update: AcpSessionUpdate): Record<string, unknown> | undefined {
	const raw = update.raw as Record<string, unknown> | undefined;
	const input = raw?.rawInput ?? raw?.input;
	if (input && typeof input === 'object' && !Array.isArray(input)) {
		return input as Record<string, unknown>;
	}
	return undefined;
}

function toolInvocationText(update: AcpSessionUpdate): string | undefined {
	const raw = update.raw as Record<string, unknown> | undefined;
	const input = rawInputObject(update);
	const command = raw?.command ?? raw?.cmd ?? input?.command ?? input?.cmd;
	if (typeof command === 'string' && command.trim()) {
		return `$ ${command.trim()}`;
	}
	if (typeof raw?.input === 'string' && raw.input.trim() && !raw.input.trim().startsWith('{')) {
		return `$ ${raw.input.trim()}`;
	}
	const title = update.title?.trim();
	if (title && !isGenericToolLabel(title)) {
		return title;
	}
	return undefined;
}

/** ACP placeholders / kind defaults that must not appear as the tool summary line. */
function isGenericToolLabel(label: string | undefined): boolean {
	if (!label) {
		return true;
	}
	const t = label.trim().toLowerCase();
	return !t
		|| t === 'tool'
		|| t === 'other'
		|| t === 'mcp: tool'
		|| t === 'mcp tool'
		|| t === 'called mcp tool'
		|| t === 'pending'
		|| t === 'in_progress'
		|| t === 'completed'
		|| t === 'failed'
		|| t === 'error'
		|| t === 'done'
		|| t === 'running';
}

/**
 * Prefer programmatic name → kind → non-generic title.
 * Never fall back to the literal string "tool" (ACP placeholder).
 */
function resolveToolName(update: AcpSessionUpdate): string {
	const raw = update.raw as Record<string, unknown> | undefined;
	const candidates = [
		update.name,
		typeof raw?.name === 'string' ? raw.name : undefined,
		typeof raw?.toolName === 'string' ? raw.toolName : undefined,
		update.kind,
		typeof raw?.kind === 'string' ? raw.kind : undefined,
		update.title,
	];
	for (const c of candidates) {
		if (typeof c === 'string' && c.trim() && !isGenericToolLabel(c)) {
			return c.trim();
		}
	}
	// Last resort: kind even if generic-ish "other" — map to empty and let UI show nothing useful
	if (update.kind && update.kind !== 'other') {
		return update.kind;
	}
	return 'tool';
}

/** Prefer a short path/command snippet over Cursor's verbose "Called MCP Tool" titles. */
function shortToolSummary(title: string, detail?: string): string {
	if (detail) {
		const first = detail.split('\n').map(l => l.trim()).find(Boolean) || '';
		if (first.startsWith('$ ')) {
			const cmd = first.slice(2).trim();
			return cmd.length > 64 ? `${cmd.slice(0, 62)}…` : cmd;
		}
		if (first && !/^called\s|^ran\s|^edited?\b/i.test(first) && first.length < 80 && !isGenericToolLabel(first)) {
			return first;
		}
	}
	const t = title.trim();
	if (isGenericToolLabel(t)) {
		return '';
	}
	if (/^called\s+mcp/i.test(t)) {
		return '';
	}
	if (/^ran\s+shell/i.test(t)) {
		return 'shell';
	}
	return t;
}

/** Path first; never emit a bare ACP placeholder like "tool". */
function usefulToolSummary(pathLabel: string | undefined, name: string, detail?: string): string | undefined {
	if (pathLabel) {
		return pathLabel;
	}
	const short = shortToolSummary(name, detail);
	if (!short || isGenericToolLabel(short) || short === name) {
		// Same as the verb title — UI already shows toolName; omit duplicate.
		return undefined;
	}
	return short;
}

/** Build output and dependencies are never this task's edits, even if a watcher sees them. */
function isGeneratedPath(fsPath: string): boolean {
	return /[/\\](node_modules|\.git|out|out-build|dist|build|\.build|coverage|\.next|target)([/\\]|$)/.test(fsPath);
}

function isFileMutation(update: AcpSessionUpdate, name: string): boolean {
	const raw = update.raw as Record<string, unknown> | undefined;
	const kind = typeof raw?.kind === 'string' ? raw.kind : update.kind;
	const tool = typeof raw?.toolName === 'string' ? raw.toolName : name;
	const label = `${kind || ''} ${tool || ''}`;
	return /\b(edit|write|delete|patch|strreplace|str_replace|multiedit|apply_patch)\b/i.test(label);
}

function extractToolPath(update: AcpSessionUpdate): string | undefined {
	const raw = update.raw as Record<string, unknown> | undefined;
	const input = rawInputObject(update);
	const locations = (raw?.locations as Array<{ path?: string }> | undefined)
		?? (update.raw as { locations?: Array<{ path?: string }> } | undefined)?.locations;
	const candidates = [
		raw?.path,
		raw?.filePath,
		raw?.file_path,
		raw?.target_file,
		raw?.targetFile,
		input?.path,
		input?.filePath,
		input?.file_path,
		input?.target_file,
		input?.targetFile,
		input?.filename,
		input?.file,
		locations?.[0]?.path,
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
	if (!uri) {
		return;
	}
	const edits = getFileEditSession();
	const targetUri = uri;
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
