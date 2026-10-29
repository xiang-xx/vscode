/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/** Timeline items — subset of ZCode conversation rows (user / reasoning / tools / assistant / work). */

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
	id: string;
	content: string;
	status: TodoStatus;
}

export type ConversationItem =
	| {
		id: string;
		kind: 'user';
		text: string;
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
	}
	| {
		id: string;
		kind: 'status';
		text: string;
		tone?: 'info' | 'error';
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
			return 'Read';
		case 'write_file':
			return 'Write';
		case 'str_replace':
			return 'Edit';
		case 'list_dir':
			return 'List';
		case 'TodoWrite':
			return 'Todos';
		default:
			return name;
	}
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
