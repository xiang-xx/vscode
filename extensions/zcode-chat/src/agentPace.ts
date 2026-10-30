/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** How aggressively the ZCode agent explores before editing. */
export type AgentPace = 'fast' | 'balanced' | 'thorough';

export const AGENT_PACES: readonly AgentPace[] = ['fast', 'balanced', 'thorough'];

export const AGENT_PACE_LABELS: Record<AgentPace, string> = {
	fast: '快速',
	balanced: '均衡',
	thorough: '深入',
};

const EXPLORE_TOOLS = new Set([
	'read_file',
	'list_dir',
	'grep',
	'glob',
	'web_fetch',
	'WebFetch',
	'Read',
	'Grep',
	'Glob',
	'LS',
]);

export function isExploreTool(toolName: string): boolean {
	return EXPLORE_TOOLS.has(toolName);
}

export function getAgentPace(): AgentPace {
	const raw = vscode.workspace.getConfiguration('zcode').get<string>('agentPace');
	if (raw === 'fast' || raw === 'balanced' || raw === 'thorough') {
		return raw;
	}
	return 'fast';
}

export async function setAgentPace(pace: AgentPace): Promise<void> {
	await vscode.workspace.getConfiguration('zcode').update(
		'agentPace',
		pace,
		vscode.ConfigurationTarget.Global,
	);
}

export function maxToolTurnsForPace(pace: AgentPace): number {
	switch (pace) {
		case 'fast':
			return 48;
		case 'thorough':
			return 96;
		default:
			return 72;
	}
}

/** After this many explore-only rounds, inject a "start editing" nudge. */
export function exploreNudgeAfterRounds(pace: AgentPace): number {
	switch (pace) {
		case 'fast':
			return 2;
		case 'thorough':
			return 8;
		default:
			return 4;
	}
}

export function buildPaceSystemLines(pace: AgentPace): string[] {
	switch (pace) {
		case 'fast':
			return [
				'Pace: FAST. Bias hard toward making edits quickly.',
				'If the user named a file/symbol/path, go there first — do not survey the repo.',
				'At most 1–2 explore tools (grep/glob/read) before your first write/str_replace.',
				'Skip TodoWrite unless the task clearly has 4+ independent steps.',
				'Do not open the browser or run broad searches unless the user asked.',
				'Keep the final summary to 1–3 short sentences.',
			];
		case 'thorough':
			return [
				'Pace: THOROUGH. Prefer understanding before large edits.',
				'Use grep/glob to locate call sites when changing shared APIs.',
				'TodoWrite is encouraged for multi-step work.',
			];
		default:
			return [
				'Pace: BALANCED. Explore briefly, then edit.',
				'Prefer grep/glob before reading broadly; avoid multi-file sightseeing tours.',
				'Use TodoWrite for multi-step tasks; skip it for single-file tweaks.',
			];
	}
}

/**
 * Request-body fields that actually control GLM / Coding Plan thinking cost.
 * Mirrors ZCode openai-chat-completions reasoningLevel map.
 */
export function buildReasoningRequestFields(reasoningLevel: string): Record<string, unknown> {
	const level = (reasoningLevel || '').trim().toLowerCase();
	const disabled = level === 'disabled'
		|| level === 'none'
		|| level === 'off'
		|| level === 'nothink';
	if (disabled) {
		return {
			thinking: { type: 'disabled' },
			enable_thinking: false,
			reasoning_effort: 'none',
			reasoning: { effort: 'none' },
		};
	}
	const effort = level === 'enabled' || level === 'on' ? 'high' : (level || 'low');
	return {
		thinking: { type: 'enabled' },
		enable_thinking: true,
		reasoning_effort: effort,
		reasoning: { effort },
	};
}
