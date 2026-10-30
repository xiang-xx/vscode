/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';

export interface AskUserOption {
	id: string;
	label: string;
	description?: string;
}

export interface AskUserQuestion {
	id: string;
	prompt: string;
	header?: string;
	options: AskUserOption[];
	allowMultiple?: boolean;
	/** When true, show an "Other" free-text field (ZCode). Cursor ACP has no freeform. */
	allowFreeform?: boolean;
}

export interface AskUserPrompt {
	id: string;
	title?: string;
	questions: AskUserQuestion[];
}

export interface AskUserAnswer {
	questionId: string;
	selectedOptionIds: string[];
	freeText?: string;
}

export type AskUserResult =
	| { outcome: 'answered'; answers: AskUserAnswer[] }
	| { outcome: 'skipped'; reason?: string }
	| { outcome: 'cancelled' };

export type AskUserHandler = (
	prompt: AskUserPrompt,
	token: vscode.CancellationToken,
) => Promise<AskUserResult>;

interface CursorAskQuestionRequest {
	toolCallId?: string;
	title?: string;
	questions?: Array<{
		id?: string;
		prompt?: string;
		options?: Array<{ id?: string; label?: string }>;
		allowMultiple?: boolean;
	}>;
}

export function normalizeCursorAsk(params: unknown, fallbackId: string): AskUserPrompt {
	const raw = (params && typeof params === 'object' ? params : {}) as CursorAskQuestionRequest;
	const questions: AskUserQuestion[] = [];
	for (const [index, q] of (Array.isArray(raw.questions) ? raw.questions : []).entries()) {
		const options: AskUserOption[] = [];
		for (const [oi, o] of (Array.isArray(q.options) ? q.options : []).entries()) {
			const label = typeof o.label === 'string' ? o.label.trim() : '';
			if (!label) {
				continue;
			}
			const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : `opt-${oi}`;
			options.push({ id, label });
		}
		const prompt = typeof q.prompt === 'string' ? q.prompt.trim() : '';
		if (!prompt || !options.length) {
			continue;
		}
		questions.push({
			id: typeof q.id === 'string' && q.id.trim() ? q.id.trim() : `q-${index}`,
			prompt,
			options,
			allowMultiple: !!q.allowMultiple,
			allowFreeform: false,
		});
	}

	return {
		id: typeof raw.toolCallId === 'string' && raw.toolCallId.trim()
			? raw.toolCallId.trim()
			: fallbackId,
		title: typeof raw.title === 'string' ? raw.title : undefined,
		questions,
	};
}

export function cursorAskResponse(result: AskUserResult): unknown {
	if (result.outcome === 'answered') {
		return {
			outcome: {
				outcome: 'answered',
				answers: result.answers.map(a => ({
					questionId: a.questionId,
					selectedOptionIds: a.selectedOptionIds,
				})),
			},
		};
	}
	if (result.outcome === 'skipped') {
		return { outcome: { outcome: 'skipped', reason: result.reason } };
	}
	return { outcome: { outcome: 'cancelled' } };
}

/**
 * Accept ZCode-style `{ questions: [...] }` or flat `{ header, question, options }`.
 */
export function normalizeZCodeAsk(
	args: Record<string, unknown>,
	callId: string,
): AskUserPrompt {
	const list = Array.isArray(args.questions)
		? args.questions
		: typeof args.question === 'string' && Array.isArray(args.options)
			? [args]
			: [];

	const questions: AskUserQuestion[] = [];
	for (const [index, raw] of list.entries()) {
		if (!raw || typeof raw !== 'object') {
			continue;
		}
		const q = raw as Record<string, unknown>;
		const prompt = readString(q, ['question', 'prompt', 'text']);
		if (!prompt) {
			continue;
		}
		const options: AskUserOption[] = [];
		for (const [oi, o] of (Array.isArray(q.options) ? q.options : []).entries()) {
			const opt = normalizeOption(o, oi);
			if (opt) {
				options.push(opt);
			}
		}
		if (!options.length) {
			continue;
		}
		const header = readString(q, ['header', 'title']);
		questions.push({
			id: readString(q, ['id', 'key', 'name']) ?? header ?? `q-${index}`,
			prompt,
			header,
			options,
			allowMultiple: q.multiSelect === true || q.allowMultiple === true || q.multiple === true,
			allowFreeform: true,
		});
	}

	return {
		id: callId,
		title: questions[0]?.header,
		questions,
	};
}

export function formatZCodeAskToolContent(prompt: AskUserPrompt, result: AskUserResult): string {
	if (result.outcome !== 'answered' || !result.answers.length) {
		return 'The user did not provide answers to these questions. Continue using your best judgment; do not treat this as a rejection or invent a user preference.';
	}

	const answers: Record<string, string> = {};
	for (const q of prompt.questions) {
		const a = result.answers.find(x => x.questionId === q.id);
		if (!a) {
			continue;
		}
		const labels = a.selectedOptionIds
			.map(id => q.options.find(o => o.id === id)?.label ?? id)
			.filter(Boolean);
		const free = a.freeText?.trim();
		const text = free
			? (labels.length ? `${labels.join(', ')}; Other: ${free}` : free)
			: labels.join(', ');
		if (text) {
			answers[q.prompt] = text;
		}
	}

	if (!Object.keys(answers).length) {
		return 'The user did not provide answers to these questions. Continue using your best judgment; do not treat this as a rejection or invent a user preference.';
	}

	const answersText = Object.entries(answers)
		.map(([question, answer]) => `"${question}"="${answer}"`)
		.join(', ');
	return `User answers: ${answersText}`;
}

export function summarizeAskResult(prompt: AskUserPrompt, result: AskUserResult): string {
	if (result.outcome === 'cancelled') {
		return 'Ask cancelled';
	}
	if (result.outcome === 'skipped') {
		return 'Ask skipped';
	}
	const parts = result.answers.map(a => {
		const q = prompt.questions.find(x => x.id === a.questionId);
		const labels = a.selectedOptionIds
			.map(id => q?.options.find(o => o.id === id)?.label ?? id)
			.filter(Boolean);
		const free = a.freeText?.trim();
		return free
			? (labels.length ? `${labels.join(', ')}; ${free}` : free)
			: labels.join(', ');
	}).filter(Boolean);
	return parts.length ? `Answered: ${parts.join(' · ')}` : 'Answered';
}

function normalizeOption(value: unknown, index: number): AskUserOption | undefined {
	if (typeof value === 'string') {
		const label = value.trim();
		return label ? { id: `opt-${index}`, label } : undefined;
	}
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const o = value as Record<string, unknown>;
	const label = readString(o, ['label', 'name', 'title', 'text', 'value']);
	if (!label) {
		return undefined;
	}
	return {
		id: readString(o, ['id', 'optionId', 'value', 'key']) ?? label,
		label,
		description: readString(o, ['description', 'detail', 'help', 'hint']),
	};
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}
