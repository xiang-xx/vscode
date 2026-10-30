/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Working-set style file edits (same UX shape as VS Code Chat):
 * - Track original → modified per URI
 * - Bottom file list with +/- stats
 * - Open as diff (review) or go-to-file
 * - Keep / Undo (all or per file)
 *
 * Originals are served via TextDocumentContentProvider so we can reuse
 * `vscode.diff` / `vscode.changes` like the built-in chat multi-diff flow.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { formatLineDiff } from './conversation';

export const ORIGINAL_SCHEME = 'zcode-chat-original';

export type FileChangeKind = 'create' | 'edit' | 'delete';

export interface FileChangeEntry {
	uri: vscode.Uri;
	fsPath: string;
	relativePath: string;
	kind: FileChangeKind;
	added: number;
	removed: number;
	/** Snapshot before first edit in this turn/session working set. */
	original: string;
	/** True once user kept the change. */
	kept?: boolean;
	/** IDE chat session that produced this pending edit (for multi-session awareness). */
	ownerSessionId?: string;
}

export interface FileChangeView {
	uri: string;
	fsPath: string;
	relativePath: string;
	kind: FileChangeKind;
	added: number;
	removed: number;
	name: string;
	ownerSessionId?: string;
}

/**
 * Net line +/- between two snapshots (original → current), matching git-style
 * counts. Index-aligned comparison falsely counts every shifted line as both
 * deleted and added; LCS after trimming the common head/tail avoids that.
 */
function lineStats(before: string, after: string): { added: number; removed: number } {
	if (before === after) {
		return { added: 0, removed: 0 };
	}
	const a = before.split(/\r?\n/);
	const b = after.split(/\r?\n/);
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) {
		start++;
	}
	let endA = a.length - 1;
	let endB = b.length - 1;
	while (endA >= start && endB >= start && a[endA] === b[endB]) {
		endA--;
		endB--;
	}
	const aa = a.slice(start, endA + 1);
	const bb = b.slice(start, endB + 1);
	if (aa.length === 0) {
		return { added: bb.length, removed: 0 };
	}
	if (bb.length === 0) {
		return { added: 0, removed: aa.length };
	}
	// Guard huge middles: fall back to whole-block counts (still better than
	// index-aligned, and matches a single contiguous hunk).
	if (aa.length * bb.length > 2_000_000) {
		return { added: bb.length, removed: aa.length };
	}
	const lcs = longestCommonSubsequenceLength(aa, bb);
	return { added: bb.length - lcs, removed: aa.length - lcs };
}

function longestCommonSubsequenceLength(xs: readonly string[], ys: readonly string[]): number {
	const n = xs.length;
	const m = ys.length;
	if (n === 0 || m === 0) {
		return 0;
	}
	const short = n <= m ? xs : ys;
	const long = n <= m ? ys : xs;
	const cols = short.length;
	const rows = long.length;
	let prev = new Uint32Array(cols + 1);
	let curr = new Uint32Array(cols + 1);
	for (let i = 1; i <= rows; i++) {
		const rowVal = long[i - 1];
		for (let j = 1; j <= cols; j++) {
			curr[j] = rowVal === short[j - 1]
				? prev[j - 1] + 1
				: Math.max(prev[j], curr[j - 1]);
		}
		const swap = prev;
		prev = curr;
		curr = swap;
		curr.fill(0);
	}
	return prev[cols];
}

export class FileEditSession {
	private readonly entries = new Map<string, FileChangeEntry>();
	private readonly originals = new Map<string, string>();
	/** Per user-turn snapshots of file contents before that turn's edits. null means the file did not exist. */
	private checkpoints: Array<{ id: string; sessionId: string; files: Map<string, string | null> }> = [];
	private readonly activeBySession = new Map<string, string>();
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	constructor(_workspaceRoot?: string) { }

	dispose(): void {
		this._onDidChange.dispose();
		this.entries.clear();
		this.originals.clear();
		this.checkpoints.length = 0;
		this.activeBySession.clear();
	}

	clear(): void {
		this.entries.clear();
		this.originals.clear();
		this.checkpoints.length = 0;
		this.activeBySession.clear();
		this._onDidChange.fire();
		void vscode.commands.executeCommand('_zcode.editing.clear').then(undefined, () => { /* ignore */ });
	}

	list(): FileChangeView[] {
		return [...this.entries.values()]
			.filter(e => !e.kept)
			.map(e => this.toView(e));
	}

	/** Pending edits attributed to other IDE chat sessions. */
	listOwnedByOthers(sessionId: string): FileChangeView[] {
		return [...this.entries.values()]
			.filter(e => !e.kept && !!e.ownerSessionId && e.ownerSessionId !== sessionId)
			.map(e => this.toView(e));
	}

	listOwnedBy(sessionId: string): FileChangeView[] {
		return [...this.entries.values()]
			.filter(e => !e.kept && e.ownerSessionId === sessionId)
			.map(e => this.toView(e));
	}

	/** Owner of a pending (unkept) working-set entry, if any. */
	ownerOf(fsPath: string): string | undefined {
		const entry = this.entries.get(vscode.Uri.file(fsPath).toString());
		if (!entry || entry.kept) {
			return undefined;
		}
		return entry.ownerSessionId;
	}

	private toView(e: FileChangeEntry): FileChangeView {
		return {
			uri: e.uri.toString(),
			fsPath: e.fsPath,
			relativePath: e.relativePath,
			kind: e.kind,
			added: e.added,
			removed: e.removed,
			name: path.basename(e.fsPath),
			ownerSessionId: e.ownerSessionId,
		};
	}

	originalUriFor(fileUri: vscode.Uri): vscode.Uri {
		return fileUri.with({ scheme: ORIGINAL_SCHEME, query: fileUri.toString() });
	}

	getOriginalText(originalUri: vscode.Uri): string | undefined {
		const key = originalUri.query || originalUri.path;
		return this.originals.get(key);
	}

	/** Baseline snapshot for a workspace file URI (for decorations / lenses). */
	getOriginalForFile(fileUri: vscode.Uri): string | undefined {
		return this.entries.get(fileUri.toString())?.original ?? this.originals.get(fileUri.toString());
	}

	/** Inline diff preview for an entry currently in the working set. */
	async getDiffPreview(uriString: string, maxLines = 80): Promise<{
		detail: string;
		path: string;
		added: number;
		removed: number;
	} | undefined> {
		const entry = this.entries.get(uriString);
		if (!entry) {
			return undefined;
		}
		let next = entry.original;
		try {
			const bytes = await vscode.workspace.fs.readFile(entry.uri);
			next = Buffer.from(bytes).toString('utf8');
		} catch {
			// keep original as fallback
		}
		return {
			detail: formatLineDiff(entry.original, next, maxLines),
			path: entry.relativePath,
			added: entry.added,
			removed: entry.removed,
		};
	}

	/**
	 * Record a file that an external agent (e.g. Cursor ACP) already wrote to disk.
	 * Does not rewrite content; only seeds review/working-set state.
	 */
	async trackExternalWrite(
		fsPath: string,
		nextContent: string,
		root: string,
		baseline?: string,
		ownerSessionId?: string,
	): Promise<void> {
		const uri = vscode.Uri.file(fsPath);
		const key = uri.toString();
		const existing = this.entries.get(key);
		let kind: FileChangeKind = 'edit';
		let original = existing?.original ?? baseline;

		if (original === undefined) {
			try {
				original = baseline ?? '';
				if (baseline === undefined) {
					const bytes = await vscode.workspace.fs.readFile(uri);
					// Content already new — cannot recover prior; treat empty as create if missing.
					original = Buffer.from(bytes).toString('utf8') === nextContent ? nextContent : '';
					if (original === nextContent) {
						// Lost the true baseline; skip review noise.
						return;
					}
				}
				if (original === '') {
					kind = 'create';
				}
			} catch {
				original = '';
				kind = 'create';
			}
			this.originals.set(key, original);
		} else if (existing?.kind === 'create') {
			kind = 'create';
		}

		if (!existing && original === nextContent) {
			return;
		}

		const before = !existing && kind === 'create'
			? null
			: (baseline !== undefined ? baseline : (existing?.original ?? original));
		this.rememberBefore(ownerSessionId, key, before);

		const stats = lineStats(original, nextContent);
		const relativePath = root ? (path.relative(root, fsPath) || path.basename(fsPath)) : fsPath;
		this.entries.set(key, {
			uri,
			fsPath,
			relativePath: relativePath.split(path.sep).join('/'),
			kind,
			added: stats.added,
			removed: stats.removed,
			original,
			ownerSessionId: ownerSessionId ?? existing?.ownerSessionId,
		});
		this.originals.set(key, original);
		this._onDidChange.fire();
		await this.applyViaChatEditing(uri, nextContent, original, kind);
	}

	/**
	 * Apply a full-file write while remembering the first original for Keep/Undo/diff.
	 */
	async writeFile(
		fsPath: string,
		nextContent: string,
		root: string,
		ownerSessionId?: string,
	): Promise<{
		summary: string;
		kind: FileChangeKind;
		added: number;
		removed: number;
		uri: vscode.Uri;
	}> {
		const uri = vscode.Uri.file(fsPath);
		const key = uri.toString();
		const existing = this.entries.get(key);
		let kind: FileChangeKind = 'edit';
		let original = existing?.original;

		if (original === undefined) {
			try {
				const bytes = await vscode.workspace.fs.readFile(uri);
				original = Buffer.from(bytes).toString('utf8');
			} catch {
				original = '';
				kind = 'create';
			}
			this.originals.set(key, original);
			this.rememberBefore(ownerSessionId, key, kind === 'create' ? null : original);
		} else if (existing?.kind === 'create') {
			kind = 'create';
			let current = original;
			try {
				current = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
			} catch {
				current = original;
			}
			this.rememberBefore(ownerSessionId, key, current);
		} else {
			let current = original;
			try {
				current = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
			} catch {
				current = original;
			}
			this.rememberBefore(ownerSessionId, key, current);
		}

		// Always persist first so the workspace model/disk agree, then ask the
		// workbench Chat editing bridge to attach review markers on top.
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(fsPath)));
		await vscode.workspace.fs.writeFile(uri, Buffer.from(nextContent, 'utf8'));

		const stats = lineStats(original, nextContent);
		const relativePath = root ? (path.relative(root, fsPath) || path.basename(fsPath)) : fsPath;
		this.entries.set(key, {
			uri,
			fsPath,
			relativePath: relativePath.split(path.sep).join('/'),
			kind,
			added: stats.added,
			removed: stats.removed,
			original,
			ownerSessionId: ownerSessionId ?? existing?.ownerSessionId,
		});
		this._onDidChange.fire();

		await this.applyViaChatEditing(uri, nextContent, original, kind);

		const label = kind === 'create' ? 'created' : 'edited';
		return {
			summary: `${label} ${relativePath.split(path.sep).join('/')} (+${stats.added}/-${stats.removed})`,
			kind,
			added: stats.added,
			removed: stats.removed,
			uri,
		};
	}

	/**
	 * Ask workbench `_zcode.editing.applyEdit` to create a review entry and
	 * paint Chat Keep/Undo markers. Failures are logged; extension decorations
	 * still cover the file via {@link EditDecorationController}.
	 */
	private async applyViaChatEditing(
		uri: vscode.Uri,
		content: string,
		original: string,
		kind: FileChangeKind,
	): Promise<void> {
		try {
			const result = await vscode.commands.executeCommand<{ changes?: number }>(
				'_zcode.editing.applyEdit',
				{ uri, content, original, kind, reveal: true },
			);
			console.info('[zcode-chat] applyEdit ok', uri.toString(), result);
		} catch (err) {
			console.warn('[zcode-chat] applyEdit failed; extension decorations still active', err);
			try {
				await vscode.commands.executeCommand('_zcode.editing.sync', [{ uri, original, kind }]);
			} catch (syncErr) {
				console.warn('[zcode-chat] sync fallback failed', syncErr);
			}
		}
	}

	async keep(uris?: string[], sessionId?: string): Promise<void> {
		const keys = (uris?.length ? uris : [...this.entries.keys()]).filter(key => {
			const entry = this.entries.get(key);
			if (!entry || entry.kept) {
				return false;
			}
			if (sessionId && entry.ownerSessionId && entry.ownerSessionId !== sessionId) {
				return false;
			}
			return true;
		});
		for (const key of keys) {
			const entry = this.entries.get(key);
			if (!entry) {
				continue;
			}
			entry.kept = true;
			this.entries.delete(key);
			this.originals.delete(key);
		}
		this._onDidChange.fire();
		await this.syncToChatEditing(sessionId);
	}

	async undo(uris?: string[], sessionId?: string): Promise<void> {
		const keys = (uris?.length ? uris : [...this.entries.keys()]).filter(key => {
			const entry = this.entries.get(key);
			if (!entry) {
				return false;
			}
			if (sessionId && entry.ownerSessionId && entry.ownerSessionId !== sessionId) {
				return false;
			}
			return true;
		});
		if (!keys.length) {
			return;
		}
		const label = keys.length === 1
			? (this.entries.get(keys[0])?.relativePath || path.basename(keys[0]))
			: `${keys.length} 个文件`;
		const confirmed = await vscode.window.showWarningMessage(
			`确定撤销对「${label}」的修改？此操作不可恢复。`,
			{ modal: true },
			'撤销',
		);
		if (confirmed !== '撤销') {
			return;
		}
		for (const key of keys) {
			const entry = this.entries.get(key);
			if (!entry) {
				continue;
			}
			if (entry.kind === 'create') {
				try {
					await vscode.workspace.fs.delete(entry.uri, { useTrash: true });
				} catch {
					// ignore
				}
			} else {
				await vscode.workspace.fs.writeFile(entry.uri, Buffer.from(entry.original, 'utf8'));
			}
			this.entries.delete(key);
			this.originals.delete(key);
		}
		this._onDidChange.fire();
		await this.syncToChatEditing(sessionId);
	}

	/** Drop a pending entry after the built-in Chat editing overlay Keep/Undo settles it. */
	dismissSettled(uriString: string, outcome: 'keep' | 'undo'): void {
		const entry = this.entries.get(uriString);
		if (!entry) {
			return;
		}
		this.entries.delete(uriString);
		this.originals.delete(uriString);
		this._onDidChange.fire();
		void outcome;
	}

	/**
	 * Push pending edits into the workbench Chat editing review session so the
	 * editor gets the same decorations / hunk Keep·Undo as Copilot Chat.
	 * When `sessionId` is set, only that chat's pending files are shown.
	 */
	async syncToChatEditing(sessionId?: string): Promise<void> {
		const files = [...this.entries.values()]
			.filter(e => !e.kept && (!sessionId || e.ownerSessionId === sessionId))
			.map(e => ({
				uri: e.uri,
				original: e.original,
				kind: e.kind,
			}));
		try {
			await vscode.commands.executeCommand('_zcode.editing.sync', files);
		} catch {
			// Bridge not loaded (older shell) — editor decorations fall back to extension styling.
		}
	}

	async open(uriString: string, mode: 'diff' | 'file' = 'file'): Promise<void> {
		const entry = this.entries.get(uriString);
		if (!entry) {
			const fallback = vscode.Uri.parse(uriString);
			await vscode.window.showTextDocument(fallback);
			return;
		}
		if (mode === 'diff') {
			const originalUri = this.originalUriFor(entry.uri);
			const title = `${path.basename(entry.fsPath)} (ZCode)`;
			await vscode.commands.executeCommand('vscode.diff', originalUri, entry.uri, title);
			return;
		}
		// Open the live file so Chat-style line markers can decorate the editor.
		await vscode.window.showTextDocument(entry.uri, { preview: false });
	}

	async openAllChanges(sessionId?: string): Promise<void> {
		const pending = [...this.entries.values()].filter(e =>
			!e.kept && (!sessionId || e.ownerSessionId === sessionId));
		if (!pending.length) {
			return;
		}
		if (pending.length === 1) {
			await this.open(pending[0].uri.toString(), 'diff');
			return;
		}
		const resources: [vscode.Uri, vscode.Uri, vscode.Uri][] = pending.map(e => [
			e.uri,
			this.originalUriFor(e.uri),
			e.uri,
		]);
		await vscode.commands.executeCommand('vscode.changes', 'ZCode Changes', resources);
	}

	/** Start a user turn. Later writes in this session record their pre-image here. */
	beginCheckpoint(id: string, sessionId: string): void {
		const sessionCps = this.checkpoints.filter(c => c.sessionId === sessionId);
		const index = sessionCps.findIndex(c => c.id === id);
		if (index >= 0) {
			this.checkpoints = this.checkpoints.filter(c => {
				if (c.sessionId !== sessionId) {
					return true;
				}
				return sessionCps.findIndex(row => row.id === c.id) < index;
			});
		}
		this.checkpoints.push({ id, sessionId, files: new Map() });
		this.activeBySession.set(sessionId, id);
	}

	filesFromCheckpoint(id: string, sessionId: string): number {
		const sessionCps = this.checkpoints.filter(c => c.sessionId === sessionId);
		const index = sessionCps.findIndex(c => c.id === id);
		if (index < 0) {
			return 0;
		}
		const keys = new Set<string>();
		for (const cp of sessionCps.slice(index)) {
			for (const key of cp.files.keys()) {
				keys.add(key);
			}
		}
		return keys.size;
	}

	/**
	 * Restore files to the state at the start of a user turn.
	 * Later checkpoints for that session are dropped. The target checkpoint stays
	 * unless `drop` is set (edit-and-resend removes the message).
	 */
	async restoreToCheckpoint(id: string, sessionId: string, opts?: { drop?: boolean }): Promise<{ hadCheckpoint: boolean; fileCount: number }> {
		const sessionCps = this.checkpoints.filter(c => c.sessionId === sessionId);
		const index = sessionCps.findIndex(c => c.id === id);
		if (index < 0) {
			return { hadCheckpoint: false, fileCount: 0 };
		}
		const merged = new Map<string, string | null>();
		for (const cp of sessionCps.slice(index)) {
			for (const [key, content] of cp.files) {
				if (!merged.has(key)) {
					merged.set(key, content);
				}
			}
		}
		for (const [key, content] of merged) {
			await this.applyRestored(key, content);
		}
		this.checkpoints = this.checkpoints.filter(c => {
			if (c.sessionId !== sessionId) {
				return true;
			}
			return sessionCps.findIndex(row => row.id === c.id) < index;
		});
		if (!opts?.drop) {
			this.checkpoints.push({ id, sessionId, files: new Map() });
			this.activeBySession.set(sessionId, id);
		} else if (this.activeBySession.get(sessionId) === id) {
			this.activeBySession.delete(sessionId);
		}
		this._onDidChange.fire();
		await this.syncToChatEditing(sessionId);
		return { hadCheckpoint: true, fileCount: merged.size };
	}

	async deleteFile(
		fsPath: string,
		root: string,
		ownerSessionId?: string,
	): Promise<{ uri: vscode.Uri; path: string }> {
		const uri = vscode.Uri.file(fsPath);
		const key = uri.toString();
		const existing = this.entries.get(key);
		let before: string | null = null;
		try {
			before = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		} catch {
			before = null;
		}
		this.rememberBefore(ownerSessionId, key, before);
		try {
			await vscode.workspace.fs.delete(uri, { useTrash: true });
		} catch {
			// already gone
		}
		const relativePath = root ? (path.relative(root, fsPath) || path.basename(fsPath)) : fsPath;
		if (before === null) {
			this.entries.delete(key);
			this.originals.delete(key);
		} else if (existing?.kind === 'create') {
			this.entries.delete(key);
			this.originals.delete(key);
		} else {
			const original = existing?.original ?? before;
			const stats = lineStats(original, '');
			this.entries.set(key, {
				uri,
				fsPath,
				relativePath: relativePath.split(path.sep).join('/'),
				kind: 'delete',
				added: 0,
				removed: stats.removed,
				original,
				ownerSessionId: ownerSessionId ?? existing?.ownerSessionId,
			});
			this.originals.set(key, original);
		}
		this._onDidChange.fire();
		await this.syncToChatEditing(ownerSessionId);
		return { uri, path: relativePath.split(path.sep).join('/') };
	}

	private rememberBefore(sessionId: string | undefined, key: string, content: string | null): void {
		if (!sessionId) {
			return;
		}
		const id = this.activeBySession.get(sessionId);
		if (!id) {
			return;
		}
		const cp = this.checkpoints.find(row => row.id === id && row.sessionId === sessionId);
		if (!cp || cp.files.has(key)) {
			return;
		}
		cp.files.set(key, content);
	}

	private async applyRestored(key: string, content: string | null): Promise<void> {
		const uri = vscode.Uri.parse(key);
		const entry = this.entries.get(key);
		if (content === null) {
			try {
				await vscode.workspace.fs.delete(uri, { useTrash: true });
			} catch {
				// already gone
			}
			this.entries.delete(key);
			this.originals.delete(key);
			return;
		}
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
		await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
		if (!entry) {
			return;
		}
		if (entry.original === content) {
			this.entries.delete(key);
			this.originals.delete(key);
			return;
		}
		const stats = lineStats(entry.original, content);
		entry.added = stats.added;
		entry.removed = stats.removed;
		if (entry.kind === 'delete') {
			entry.kind = 'edit';
		}
		await this.applyViaChatEditing(uri, content, entry.original, entry.kind);
	}

	registerContentProvider(context: vscode.ExtensionContext): void {
		context.subscriptions.push(
			vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, {
				provideTextDocumentContent: (uri) => this.getOriginalText(uri) ?? '',
			}),
		);
	}
}

/** Singleton used by the panel + agent for the current window. */
let activeSession: FileEditSession | undefined;

export function getFileEditSession(): FileEditSession {
	if (!activeSession) {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		activeSession = new FileEditSession(root);
	}
	return activeSession;
}

export function resetFileEditSession(context: vscode.ExtensionContext): FileEditSession {
	activeSession?.dispose();
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	activeSession = new FileEditSession(root);
	activeSession.registerContentProvider(context);
	return activeSession;
}
