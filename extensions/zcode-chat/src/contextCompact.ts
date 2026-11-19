/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { newItemId, toolDisplayName, type ConversationItem } from './conversation';
import { contextWindowForModel, estimateTokens } from './contextUsage';

/** Compact once the local estimate crosses this fraction of the model window. */
const COMPACT_AT = 0.72;
/** Keep the newest turns inside this fraction so the reply still fits. */
const KEEP_RATIO = 0.45;

/**
 * Total token budget for one folded summary. The old flat transcript clip
 * (280/220 chars per turn, 1.5K total) read like a truncated dump — the model
 * lost the task thread the moment a compact fired. The summary now carries
 * structured sections (goal / edits / commands / decisions / directives /
 * conclusions) under this budget.
 */
const SUMMARY_TOKEN_BUDGET = 4_500;
/** Last-resort character cap so a pathological head cannot blow the prompt. */
const SUMMARY_HARD_CHAR_CAP = 22_000;

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

/** Rough inverse of estimateTokens: chars that approximate the given budget. */
function roughCharsForTokens(tokens: number): number {
	return Math.max(80, Math.floor(tokens * 1.6));
}

interface SummarySection {
	title: string;
	lines: string[];
	/** Token share this section may take when the budget gets tight. */
	quota: number;
	/** When trimming, keep this many leading lines before the ellipsis. */
	keepHead: number;
}

/**
 * Fit a section under its token quota. Over-quota sections keep their head
 * lines, an explicit ellipsis marker, and as many trailing lines as fit —
 * the newest entries (last edits, latest commands) survive, only the middle
 * bulk is dropped.
 */
function fitSection(section: SummarySection): { lines: string[]; used: number } {
	const total = estimateTokens(section.lines.join('\n'));
	if (total <= section.quota) {
		return { lines: section.lines, used: total };
	}
	if (section.lines.length === 1) {
		// Single long block (goal / prior summary): trim the text itself.
		const line = clip(section.lines[0], roughCharsForTokens(section.quota));
		return { lines: [line], used: estimateTokens(line) };
	}
	const head = section.lines.slice(0, section.keepHead);
	let used = estimateTokens(head.join('\n'));
	const tail: string[] = [];
	for (let index = section.lines.length - 1; index > section.keepHead - 1; index--) {
		const cost = estimateTokens(section.lines[index]);
		if (used + cost + 24 > section.quota) {
			break;
		}
		tail.unshift(section.lines[index]);
		used += cost;
	}
	const omitted = section.lines.length - head.length - tail.length;
	if (omitted <= 0) {
		return { lines: section.lines, used: total };
	}
	const marker = `…（中间省略 ${omitted} 条，最新记录已保留在下方）…`;
	used += estimateTokens(marker);
	return { lines: [...head, marker, ...tail], used };
}

/** One line per file-mutating tool call: the changelog the model needs to resume. */
function editLine(item: Extract<ConversationItem, { kind: 'tool' }>): string {
	const name = toolDisplayName(item.toolName);
	const target = item.path || item.summary || '';
	const delta = typeof item.added === 'number' || typeof item.removed === 'number'
		? ` (+${item.added ?? 0}/-${item.removed ?? 0})`
		: '';
	const flag = item.status === 'error' ? ' ✗失败' : '';
	return `- [${name}] ${clip(target, 140)}${delta}${flag}`;
}

/** One line per shell command — errors flagged so the model does not retry blind. */
function commandLine(item: Extract<ConversationItem, { kind: 'tool' }>): string {
	const flag = item.status === 'error' ? ' ✗失败' : '';
	return `- ${clip(item.summary || item.toolName, 160)}${flag}`;
}

/** AskUserQuestion rounds carry direction decisions — keep the chosen answers. */
function decisionLines(item: Extract<ConversationItem, { kind: 'question' }>): string[] {
	if (item.status === 'pending' || !item.answers?.length) {
		return [];
	}
	const lines: string[] = [];
	for (const question of item.questions) {
		const answer = item.answers.find(a => a.questionId === question.id);
		if (!answer) {
			continue;
		}
		const chosen = [
			...answer.selectedOptionIds
				.map(id => question.options.find(option => option.id === id)?.label)
				.filter((label): label is string => !!label),
			...(answer.freeText ? [answer.freeText] : []),
		].join('、');
		if (chosen) {
			lines.push(`- 问: ${clip(question.prompt, 90)} → 答: ${clip(chosen, 90)}`);
		}
	}
	return lines;
}

/** Build the folded-summary text for everything before the compact cut. */
function summarize(head: ConversationItem[]): { text: string; turnCount: number } {
	let turnCount = 0;
	let priorSummary: string | undefined;
	const goalLines: string[] = [];
	const directiveLines: string[] = [];
	const decisionLinesAcc: string[] = [];
	const conclusionLines: string[] = [];
	const editLines: string[] = [];
	const commandLines: string[] = [];
	let readOps = 0;
	const otherCounts = new Map<string, number>();

	for (const item of head) {
		if (item.kind === 'summary') {
			turnCount += item.turnCount;
			priorSummary = priorSummary
				? `${priorSummary}\n${item.text}`
				: item.text;
		} else if (item.kind === 'user' && item.text.trim()) {
			turnCount += 1;
			if (goalLines.length === 0) {
				goalLines.push(clip(item.text, 1_200));
			} else {
				directiveLines.push(clip(item.text, 240));
			}
		} else if (item.kind === 'assistant' && item.text.trim()) {
			conclusionLines.push(clip(item.text, 300));
		} else if (item.kind === 'question') {
			decisionLinesAcc.push(...decisionLines(item));
		} else if (item.kind === 'tool') {
			const name = toolDisplayName(item.toolName);
			const raw = item.toolName.toLowerCase();
			if (['write_file', 'str_replace', 'delete_file', 'write', 'edit', 'delete'].includes(raw)) {
				editLines.push(editLine(item));
			} else if (['run_terminal_cmd', 'bash'].includes(raw)) {
				commandLines.push(commandLine(item));
			} else if (['read_file', 'read', 'grep', 'glob', 'list_dir', 'list'].includes(raw)) {
				readOps += 1;
			} else {
				otherCounts.set(name, (otherCounts.get(name) ?? 0) + 1);
			}
		}
	}

	const miscParts: string[] = [];
	if (readOps > 0) {
		miscParts.push(`读取/搜索 ${readOps} 次`);
	}
	for (const [name, count] of otherCounts) {
		miscParts.push(`${name} ${count} 次`);
	}

	const sections: SummarySection[] = [];
	if (goalLines.length) {
		sections.push({ title: '任务目标（最初指令）', lines: goalLines, quota: 1_400, keepHead: 1 });
	}
	if (priorSummary?.trim()) {
		sections.push({ title: '更早进程（上一份摘要）', lines: [priorSummary.trim()], quota: 1_600, keepHead: 1 });
	}
	if (editLines.length) {
		sections.push({ title: '文件改动记录', lines: editLines, quota: 900, keepHead: 6 });
	}
	if (commandLines.length) {
		sections.push({ title: '执行过的命令', lines: commandLines, quota: 700, keepHead: 4 });
	}
	if (decisionLinesAcc.length) {
		sections.push({ title: '用户中途决策', lines: decisionLinesAcc, quota: 500, keepHead: 3 });
	}
	if (directiveLines.length) {
		sections.push({ title: '用户后续指令/补充', lines: directiveLines, quota: 700, keepHead: 4 });
	}
	if (conclusionLines.length) {
		sections.push({ title: '助手阶段结论', lines: conclusionLines, quota: 900, keepHead: 3 });
	}
	if (miscParts.length) {
		sections.push({ title: '其他操作统计', lines: [`- ${miscParts.join('；')}`], quota: 200, keepHead: 1 });
	}

	let used = 0;
	const blocks: string[] = [];
	for (const section of sections) {
		const remaining = SUMMARY_TOKEN_BUDGET - used;
		if (remaining <= 120) {
			break;
		}
		const fitted = fitSection({ ...section, quota: Math.min(section.quota, remaining) });
		blocks.push(`【${section.title}】\n${fitted.lines.join('\n')}`);
		used += fitted.used + estimateTokens(section.title) + 4;
	}

	let text = blocks.join('\n\n');
	if (estimateTokens(text) > SUMMARY_TOKEN_BUDGET) {
		text = `${text.slice(0, SUMMARY_HARD_CHAR_CAP)}…`;
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
