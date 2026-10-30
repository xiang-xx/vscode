/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/** Timeline items — subset of ZCode conversation rows (user / reasoning / tools / assistant / work). */

import type { AskUserAnswer, AskUserQuestion } from './askUser';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
	id: string;
	content: string;
	status: TodoStatus;
}

/** Attachment summary stored on a user bubble for display. */
export interface UserAttachmentRef {
	id: string;
	name: string;
	/** Rendered as a clickable image thumbnail instead of a file pill. */
	image?: boolean;
	/** Webview-loadable URI for image previews. */
	uri?: string;
	/** Absolute path, used to open the file on click. */
	path?: string;
}

export type ConversationItem =
	| {
		id: string;
		kind: 'user';
		text: string;
		attachments?: UserAttachmentRef[];
	}
	| {
		id: string;
		kind: 'reasoning';
		text: string;
		streaming?: boolean;
		durationMs?: number;
		expanded?: boolean;
		startedAt?: number;
	}
	| {
		id: string;
		kind: 'assistant';
		text: string;
		streaming?: boolean;
	}
	| {
		id: string;
		kind: 'tool';
		toolName: string;
		summary: string;
		status: 'running' | 'done' | 'error';
		/** Expandable preview (diff / file snippet / list output). */
		detail?: string;
		path?: string;
		uri?: string;
		added?: number;
		removed?: number;
		expanded?: boolean;
	}
	| {
		id: string;
		kind: 'question';
		title?: string;
		questions: AskUserQuestion[];
		status: 'pending' | 'answered' | 'skipped';
		answers?: AskUserAnswer[];
	}
	| {
		id: string;
		kind: 'status';
		text: string;
		tone?: 'info' | 'error';
	}
	| {
		id: string;
		kind: 'summary';
		text: string;
		/** How many earlier user turns were folded into this summary. */
		turnCount: number;
	}
	| {
		id: string;
		kind: 'work';
		label: string;
		startedAt: number;
		elapsedMs: number;
		running?: boolean;
	};

export function newItemId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function toolDisplayName(name: string): string {
	switch (name) {
		case 'read_file':
		case 'Read':
			return 'Read';
		case 'write_file':
		case 'Write':
			return 'Write';
		case 'str_replace':
		case 'Edit':
			return 'Edit';
		case 'delete_file':
		case 'Delete':
			return 'Delete';
		case 'list_dir':
			return 'List';
		case 'run_terminal_cmd':
		case 'Bash':
		case 'bash':
			return 'Bash';
		case 'get_diagnostics':
			return 'Diagnostics';
		case 'web_fetch':
		case 'WebFetch':
			return 'Fetch';
		case 'grep':
		case 'Grep':
			return 'Grep';
		case 'glob':
		case 'Glob':
			return 'Glob';
		case 'open_browser_page':
		case 'browser_navigate':
		case 'browser_reload':
		case 'browser_go_back':
		case 'browser_go_forward':
		case 'browser_new_tab':
		case 'browser_list_or_open':
		case 'browser_toggle_devtools':
			return 'Browser';
		case 'browser_import_chrome_data':
			return 'Chrome Sync';
		case 'TodoWrite':
			return 'Todos';
		case 'AskUserQuestion':
			return 'Question';
		default:
			return name;
	}
}

/**
 * Compact line diff for tool previews. Not a full Myers diff — enough to scan edits inline.
 */
export function formatLineDiff(before: string, after: string, maxLines = 80): string {
	if (before === after) {
		return '(no textual change)';
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
	const ctx = 2;
	const from = Math.max(0, start - ctx);
	const toA = Math.min(a.length - 1, endA + ctx);
	const toB = Math.min(b.length - 1, endB + ctx);
	const lines: string[] = [];
	for (let i = from; i < start; i++) {
		lines.push(`  ${a[i] ?? ''}`);
	}
	for (let i = start; i <= endA; i++) {
		lines.push(`- ${a[i] ?? ''}`);
	}
	for (let i = start; i <= endB; i++) {
		lines.push(`+ ${b[i] ?? ''}`);
	}
	for (let i = endA + 1; i <= toA && i < a.length; i++) {
		const mirror = endB + 1 + (i - (endA + 1));
		if (mirror <= toB && b[mirror] === a[i]) {
			lines.push(`  ${a[i]}`);
		}
	}
	if (lines.length > maxLines) {
		return `${lines.slice(0, maxLines).join('\n')}\n… (${lines.length - maxLines} more lines)`;
	}
	return lines.join('\n') || '(changed)';
}

/** Match ZCode `formatConversationWorkDuration` style (zh-friendly). */
export function formatWorkDuration(durationMs: number): string {
	const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const parts: string[] = [];
	if (hours > 0) {
		parts.push(`${hours} 小时`);
	}
	if (minutes > 0) {
		parts.push(`${minutes} 分钟`);
	}
	if (seconds > 0 || parts.length === 0) {
		parts.push(`${seconds} 秒`);
	}
	return parts.slice(0, 2).join(' ');
}
