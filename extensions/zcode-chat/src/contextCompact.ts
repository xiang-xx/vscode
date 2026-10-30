/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { newItemId, type ConversationItem } from './conversation';
import { contextWindowForModel, estimateTokens } from './contextUsage';

/** Compact once the local estimate crosses this fraction of the model window. */
const COMPACT_AT = 0.72;
/** Keep the newest turns inside this fraction so the reply still fits. */
const KEEP_RATIO = 0.45;

export function estimateConversationTokens(items: ConversationItem[]): number {
	let tokens = 0;
	for (const item of items) {
		if (item.kind === 'user' || item.kind === 'assistant' || item.kind === 'summary' || item.kind === 'status') {
			tokens += estimateTokens(item.text || '');
		} else if (item.kind === 'reasoning') {
			tokens += estimateTokens(item.text || '');
		} else if (item.kind === 'tool') {
			tokens += estimateTokens([item.toolName, item.summary, item.detail, item.path].filter(Boolean).join('\n'));
		} else if (item.kind === 'question') {
			tokens += estimateTokens(JSON.stringify(item.questions));
		}
	}
	return tokens;
}

function clip(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, ' ').trim();
	if (oneLine.length <= max) {
		return oneLine;
	}
	return `${oneLine.slice(0, max)}…`;
}

function summarize(head: ConversationItem[]): { text: string; turnCount: number } {
	const lines: string[] = [];
	let turnCount = 0;
	for (const item of head) {
		if (item.kind === 'summary') {
			turnCount += item.turnCount;
			lines.push(item.text);
		} else if (item.kind === 'user' && item.text.trim()) {
			turnCount += 1;
			lines.push(`用户: ${clip(item.text, 280)}`);
		} else if (item.kind === 'assistant' && item.text.trim()) {
			lines.push(`助手: ${clip(item.text, 220)}`);
		}
	}
	let text = lines.join('\n');
	if (estimateTokens(text) > 1_500) {
		text = `${text.slice(0, 6_000)}…`;
	}
	return { text, turnCount };
}

/**
 * Fold earlier turns into one summary when the conversation is near the
 * context window. The latest user message and everything after it stay intact.
 */
export function compactConversation(
	items: ConversationItem[],
	modelId: string | undefined,
): { items: ConversationItem[]; compacted: boolean } {
	const size = contextWindowForModel(modelId);
	if (size <= 0 || estimateConversationTokens(items) / size < COMPACT_AT) {
		return { items, compacted: false };
	}
	const lastUser = items.reduce((found, item, index) => item.kind === 'user' ? index : found, -1);
	if (lastUser <= 0) {
		return { items, compacted: false };
	}
	const budget = Math.floor(size * KEEP_RATIO);
	let cut = lastUser;
	for (let index = 1; index <= lastUser; index++) {
		if (items[index]?.kind !== 'user') {
			continue;
		}
		if (estimateConversationTokens(items.slice(index)) <= budget) {
			cut = index;
			break;
		}
	}
	const head = items.slice(0, cut);
	if (!head.some(item => item.kind === 'user' || item.kind === 'assistant')) {
		return { items, compacted: false };
	}
	const summary = summarize(head);
	if (!summary.text.trim()) {
		return { items, compacted: false };
	}
	const summaryItem: ConversationItem = {
		id: newItemId('summary'),
		kind: 'summary',
		text: summary.text,
		turnCount: Math.max(1, summary.turnCount),
	};
	return { items: [summaryItem, ...items.slice(cut)], compacted: true };
}
