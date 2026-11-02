/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Extension-side line markers for pending ZCode edits.
 * Diff styling only — Keep/Undo actions live behind an opt-in preference and
 * are not shown here.
 */

import * as vscode from 'vscode';
import type { FileEditSession } from './fileEditSession';

interface LineHunk {
	/** 0-based start line in the modified document. */
	start: number;
	/** 0-based exclusive end line. */
	end: number;
	kind: 'add' | 'mod';
}

function computeHunks(before: string, after: string): LineHunk[] {
	if (before === after) {
		return [];
	}
	const a = before.split(/\r?\n/);
	const b = after.split(/\r?\n/);
	const hunks: LineHunk[] = [];
	let start = -1;
	let kind: 'add' | 'mod' = 'add';
	const max = Math.max(a.length, b.length);
	for (let i = 0; i < max; i++) {
		const inAfter = i < b.length;
		const same = inAfter && a[i] === b[i];
		if (inAfter && !same) {
			if (start < 0) {
				start = i;
				kind = a[i] === undefined ? 'add' : 'mod';
			}
		} else if (start >= 0) {
			hunks.push({ start, end: i, kind });
			start = -1;
		}
	}
	if (start >= 0) {
		hunks.push({ start, end: b.length, kind });
	}
	return hunks;
}

export class EditDecorationController implements vscode.Disposable {
	private readonly added = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
		overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
		overviewRulerLane: vscode.OverviewRulerLane.Left,
	});
	private readonly modified = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: new vscode.ThemeColor('diffEditor.modifiedLineBackground'),
		overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.modifiedForeground'),
		overviewRulerLane: vscode.OverviewRulerLane.Left,
	});
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly session: FileEditSession) {
		this.disposables.push(
			this.added,
			this.modified,
			session.onDidChange(() => void this.refresh()),
			vscode.window.onDidChangeActiveTextEditor(() => void this.refresh()),
			vscode.workspace.onDidChangeTextDocument(e => {
				if (this.session.list().some(f => f.uri === e.document.uri.toString())) {
					void this.refresh();
				}
			}),
		);
		void this.refresh();
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	private async refresh(): Promise<void> {
		const files = this.session.list();
		const byUri = new Set(files.map(f => f.uri));

		for (const editor of vscode.window.visibleTextEditors) {
			const key = editor.document.uri.toString();
			if (!byUri.has(key)) {
				editor.setDecorations(this.added, []);
				editor.setDecorations(this.modified, []);
				continue;
			}
			const original = this.session.getOriginalForFile(editor.document.uri);
			if (original === undefined) {
				editor.setDecorations(this.added, []);
				editor.setDecorations(this.modified, []);
				continue;
			}
			const hunks = computeHunks(original, editor.document.getText());
			const addedRanges: vscode.Range[] = [];
			const modRanges: vscode.Range[] = [];
			for (const h of hunks) {
				const range = new vscode.Range(h.start, 0, Math.max(h.start, h.end - 1), Number.MAX_SAFE_INTEGER);
				(h.kind === 'add' ? addedRanges : modRanges).push(range);
			}
			editor.setDecorations(this.added, addedRanges);
			editor.setDecorations(this.modified, modRanges);
		}
	}
}
