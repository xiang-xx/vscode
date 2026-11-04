/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * `present` tool ported from dsh: the agent lists its 1-4 final deliverable
 * files, which are appended to the final answer as a deliverables card.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { ToolExecResult } from './browserTools';

export interface Deliverable {
	label: string;
	absPath: string;
	uri: string;
	description: string;
}

const MAX_DELIVERABLES = 8;

export class DeliverableTracker {
	readonly items: Deliverable[] = [];

	async add(filePath: string, root: string, description = ''): Promise<Deliverable | Error> {
		const trimmed = filePath.trim();
		if (!trimmed) {
			return new Error('path is required');
		}
		const abs = path.isAbsolute(trimmed) ? trimmed : path.resolve(root, trimmed);
		const normRoot = path.resolve(root);
		const norm = path.resolve(abs);
		if (norm !== normRoot && !norm.startsWith(normRoot + path.sep)) {
			return new Error(`path escapes workspace: ${filePath}`);
		}
		try {
			const st = await fs.stat(norm);
			if (!st.isFile()) {
				return new Error(`not a file: ${filePath}`);
			}
		} catch {
			return new Error(`not found: ${filePath}`);
		}
		if (this.items.some(d => d.absPath === norm)) {
			return new Error(`already presented: ${filePath}`);
		}
		if (this.items.length >= MAX_DELIVERABLES) {
			return new Error(`too many deliverables (max ${MAX_DELIVERABLES})`);
		}
		const item: Deliverable = {
			label: path.relative(normRoot, norm) || norm,
			absPath: norm,
			uri: vscode.Uri.file(norm).toString(),
			description: description.trim(),
		};
		this.items.push(item);
		return item;
	}

	/** Markdown block appended to the final assistant message. */
	markdown(): string {
		if (!this.items.length) {
			return '';
		}
		const lines = this.items.map((d, i) => `${i + 1}. \`${d.label}\`${d.description ? ` — ${d.description}` : ''}`);
		return `\n\n---\n\n**📦 Deliverables**\n\n${lines.join('\n')}`;
	}
}

export const PRESENT_TOOL_DEF = {
	type: 'function' as const,
	function: {
		name: 'present',
		description:
			'Present the final deliverable files as cards. Call once when the task is done, with the 1-4 files the user should look at.',
		parameters: {
			type: 'object',
			properties: {
				items: {
					type: 'array',
					description: 'Deliverables (preferred form).',
					items: {
						type: 'object',
						properties: {
							path: { type: 'string', description: 'File path (workspace-relative or absolute).' },
							description: { type: 'string', description: 'One-line note about what this file delivers.' },
						},
						required: ['path'],
					},
				},
				paths: {
					type: 'array',
					items: { type: 'string' },
					description: 'Alternative: plain list of file paths.',
				},
				description: { type: 'string', description: 'Optional overall note shown above the cards.' },
			},
		},
	},
};

export async function executePresentTool(
	args: Record<string, unknown>,
	tracker: DeliverableTracker,
	root: string,
): Promise<ToolExecResult> {
	const raw: Array<{ path: string; description?: string }> = [];
	if (Array.isArray(args.items)) {
		for (const item of args.items) {
			if (item && typeof item === 'object' && typeof (item as { path?: unknown }).path === 'string') {
				raw.push({
					path: (item as { path: string }).path,
					description: typeof (item as { description?: unknown }).description === 'string'
						? (item as { description: string }).description
						: '',
				});
			}
		}
	}
	if (!raw.length && Array.isArray(args.paths)) {
		for (const p of args.paths) {
			if (typeof p === 'string') {
				raw.push({ path: p, description: '' });
			}
		}
	}
	if (!raw.length) {
		return { summary: 'present empty', content: 'Error: items[] (or paths[]) with at least one file is required' };
	}

	const added: string[] = [];
	const errors: string[] = [];
	for (const item of raw.slice(0, MAX_DELIVERABLES)) {
		const result = await tracker.add(item.path, root, item.description ?? '');
		if (result instanceof Error) {
			errors.push(`${item.path}: ${result.message}`);
		} else {
			added.push(`${result.label}${result.description ? ` — ${result.description}` : ''}`);
		}
	}

	const note = typeof args.description === 'string' && args.description.trim() ? `${args.description.trim()}\n\n` : '';
	const body = [
		note + (added.length ? `Deliverables (${added.length}):\n${added.map((l, i) => `${i + 1}. ${l}`).join('\n')}` : ''),
		errors.length ? `Errors:\n${errors.join('\n')}` : '',
	].filter(Boolean).join('\n\n');

	const first = tracker.items[0];
	return {
		summary: `deliverables (${tracker.items.length})`,
		content: body,
		path: first?.label,
		uri: first?.uri,
	};
}
