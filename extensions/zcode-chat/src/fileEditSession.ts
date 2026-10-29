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
}

export interface FileChangeView {
	uri: string;
	fsPath: string;
	relativePath: string;
	kind: FileChangeKind;
	added: number;
	removed: number;
	name: string;
}

function lineStats(before: string, after: string): { added: number; removed: number } {
	if (before === after) {
		return { added: 0, removed: 0 };
	}
	const a = before.split(/\r?\n/);
	const b = after.split(/\r?\n/);
	let added = 0;
	let removed = 0;
	const max = Math.max(a.length, b.length);
	for (let i = 0; i < max; i++) {
		if (a[i] === undefined) {
			added++;
		} else if (b[i] === undefined) {
			removed++;
		} else if (a[i] !== b[i]) {
			added++;
			removed++;
		}
	}
	return { added, removed };
}

export class FileEditSession {
	private readonly entries = new Map<string, FileChangeEntry>();
	private readonly originals = new Map<string, string>();
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	constructor(_workspaceRoot?: string) { }

	dispose(): void {
		this._onDidChange.dispose();
		this.entries.clear();
		this.originals.clear();
	}

	clear(): void {
		this.entries.clear();
		this.originals.clear();
		this._onDidChange.fire();
		void vscode.commands.executeCommand('_zcode.editing.clear').then(undefined, () => { /* ignore */ });
	}

	list(): FileChangeView[] {
		return [...this.entries.values()]
			.filter(e => !e.kept)
			.map(e => ({
				uri: e.uri.toString(),
				fsPath: e.fsPath,
				relativePath: e.relativePath,
				kind: e.kind,
				added: e.added,
				removed: e.removed,
				name: path.basename(e.fsPath),
			}));
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

	/**
	 * Apply a full-file write while remembering the first original for Keep/Undo/diff.
	 */
	async writeFile(fsPath: string, nextContent: string, root: string): Promise<{
		summary: string;
		kind: FileChangeKind;
		added: number;
		removed: number;
		uri: vscode.Uri;
	}> {
		const uri = vscode.Uri.file(fsPath);
		const key = uri.toString();
		let kind: FileChangeKind = 'edit';
		let original = this.entries.get(key)?.original;

		if (original === undefined) {
			try {
				const bytes = await vscode.workspace.fs.readFile(uri);
				original = Buffer.from(bytes).toString('utf8');
			} catch {
				original = '';
				kind = 'create';
			}
			this.originals.set(key, original);
		} else if (this.entries.get(key)?.kind === 'create') {
			kind = 'create';
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

	async keep(uris?: string[]): Promise<void> {
		const keys = uris?.length ? uris : [...this.entries.keys()];
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
		await this.syncToChatEditing();
	}

	async undo(uris?: string[]): Promise<void> {
		const keys = uris?.length ? uris : [...this.entries.keys()];
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
		await this.syncToChatEditing();
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
	 */
	async syncToChatEditing(): Promise<void> {
		const files = [...this.entries.values()].map(e => ({
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

	async openAllChanges(): Promise<void> {
		const pending = [...this.entries.values()].filter(e => !e.kept);
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
