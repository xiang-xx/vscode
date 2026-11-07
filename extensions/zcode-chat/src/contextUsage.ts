/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { ConversationItem } from './conversation';
import { deepseekContextWindow } from './deepseekProvider';

/**
 * Context windows in tokens.
 * GLM rows mirror ZCode builtin specs.
 * Cursor rows are the default window for that model id (Cursor docs):
 * Grok 4.7 is 256K, and the separate "Grok 4.7 500k" model is 500K.
 * Grok 4.5 is 256K. GPT-5.6 Luna / Terra / Sol are 272K.
 * Ids that do not match stay on the 200K default.
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	'GLM-5.3': 1_000_000,
	'GLM-5.3-Flash': 1_000_000,
	'GLM-5.2': 1_000_000,
	'GLM-5-Turbo': 200_000,
	'GLM-5': 200_000,
	'grok-4.7-500000': 500_000,
	'grok-4.7-500k': 500_000,
	'grok-4.7': 256_000,
	'grok-4.5': 256_000,
	'gpt-5.6': 272_000,
	'deepseek-flash': 1_048_576,
	'deepseek-v4-pro': 1_048_576,
	'deepseek-v4-flash': 1_048_576,
};

const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Fixed overhead for system / tool schemas (aligned with ZCode-ish baseline). */
const SYSTEM_OVERHEAD_TOKENS = 2_400;

export type ContextUsageSource =
	| 'messages'
	| 'reasoning'
	| 'tools'
	| 'draft'
	| 'system';

export interface ContextUsageBreakdownItem {
	source: ContextUsageSource;
	tokens: number;
}

export interface ContextUsageSnapshot {
	used: number;
	size: number;
	percent: number;
	estimated: boolean;
	breakdown: ContextUsageBreakdownItem[];
}

/** Lowercase forms so "Grok 4.7", "grok-4-7", and "grok-4.7" share one key. */
function modelIdNeedles(modelId: string): string[] {
	const raw = modelId.trim().toLowerCase();
	const hyphenated = raw.replace(/[\s_]+/g, '-');
	const dotted = hyphenated.replace(/(\d)-(\d)/g, '$1.$2');
	const dashed = hyphenated.replace(/(\d)\.(\d)/g, '$1-$2');
	return [...new Set([raw, hyphenated, dotted, dashed])];
}

function keyMatches(hay: string, key: string): boolean {
	let from = 0;
	while (from <= hay.length - key.length) {
		const at = hay.indexOf(key, from);
		if (at < 0) {
			return false;
		}
		const beforeOk = at === 0 || !/[a-z0-9]/i.test(hay[at - 1] ?? '');
		const afterIdx = at + key.length;
		const afterOk = afterIdx === hay.length || !/[a-z0-9]/i.test(hay[afterIdx] ?? '');
		if (beforeOk && afterOk) {
			return true;
		}
		from = at + 1;
	}
	return false;
}

export function contextWindowForModel(modelId: string | undefined): number {
	if (!modelId?.trim()) {
		return DEFAULT_CONTEXT_WINDOW;
	}
	const listed = deepseekContextWindow(modelId);
	if (listed) {
		return listed;
	}
	let bestKey = '';
	let bestSize = DEFAULT_CONTEXT_WINDOW;
	for (const hay of modelIdNeedles(modelId)) {
		for (const [id, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
			const key = id.toLowerCase();
			if (key.length > bestKey.length && keyMatches(hay, key)) {
				bestKey = key;
				bestSize = size;
			}
		}
	}
	if (!bestKey && /deepseek/i.test(modelId)) {
		return 1_048_576;
	}
	return bestSize;
}

/**
 * Rough tokenizer: CJK ideographs ≈ 1 token, other code points ≈ 0.25 (≈ chars/4).
 * Good enough for a capacity gauge when the provider does not report usage.
 */
export function estimateTokens(text: string): number {
	if (!text) {
		return 0;
	}
	let tokens = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if (code >= 0x4e00 && code <= 0x9fff) {
			tokens += 1;
		} else if (code <= 0x7f) {
			tokens += 0.25;
		} else {
			tokens += 0.5;
		}
	}
	return Math.max(0, Math.ceil(tokens));
}

export function formatCompactTokens(value: number): string {
	if (!Number.isFinite(value) || value < 0) {
		return '0';
	}
	if (value < 1000) {
		return String(Math.round(value));
	}
	if (value < 1_000_000) {
		const k = value / 1000;
		return `${k >= 100 ? Math.round(k) : k.toFixed(k >= 10 ? 0 : 1).replace(/\.0$/, '')}K`;
	}
	const m = value / 1_000_000;
	return `${m >= 10 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, '')}M`;
}

export function computeContextUsage(opts: {
	items: ConversationItem[];
	draftText?: string;
	modelId?: string;
	/** Prefer provider-reported prompt+completion when available. */
	reportedUsed?: number;
}): ContextUsageSnapshot {
	const size = contextWindowForModel(opts.modelId);
	const buckets: Record<ContextUsageSource, number> = {
		messages: 0,
		reasoning: 0,
		tools: 0,
		draft: 0,
		system: SYSTEM_OVERHEAD_TOKENS,
	};

	for (const item of opts.items) {
		if (item.kind === 'user' || item.kind === 'assistant') {
			buckets.messages += estimateTokens(item.text || '');
		} else if (item.kind === 'reasoning') {
			buckets.reasoning += estimateTokens(item.text || '');
		} else if (item.kind === 'tool') {
			buckets.tools += estimateTokens(
				[item.toolName, item.summary, item.detail, item.path].filter(Boolean).join('\n'),
			);
		} else if (item.kind === 'status' || item.kind === 'summary') {
			buckets.messages += estimateTokens(item.text || '');
		}
	}
	buckets.draft = estimateTokens(opts.draftText || '');

	const estimatedUsed = Object.values(buckets).reduce((a, b) => a + b, 0);
	const used = opts.reportedUsed && opts.reportedUsed > 0
		? Math.max(opts.reportedUsed, buckets.draft + SYSTEM_OVERHEAD_TOKENS)
		: estimatedUsed;
	const percent = size > 0 ? Math.min(1, Math.max(0, used / size)) : 0;
	const breakdown = (Object.entries(buckets) as Array<[ContextUsageSource, number]>)
		.filter(([, tokens]) => tokens > 0)
		.map(([source, tokens]) => ({ source, tokens }))
		.sort((a, b) => b.tokens - a.tokens);

	return {
		used,
		size,
		percent,
		estimated: !(opts.reportedUsed && opts.reportedUsed > 0),
		breakdown,
	};
}
