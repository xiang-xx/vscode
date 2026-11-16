/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** Start Plan, BigModel Coding Plan, and the official DeepSeek Messages API. */
export type ProviderMode = 'startPlan' | 'bigmodel' | 'deepseek';

/**
 * Picker list for the ZCode brain. DeepSeek is a peer brain now (zcode.activeBrain),
 * so it is not offered as a ZCode sub-provider anymore; the id stays in the type so
 * stored sessions (and the deepseek brain) keep resolving.
 */
export const PROVIDER_MODES: readonly ProviderMode[] = ['startPlan', 'bigmodel'];

export const PROVIDER_LABELS: Record<ProviderMode, string> = {
	startPlan: 'ZCode Start Plan',
	bigmodel: 'BigModel',
	deepseek: 'DeepSeek',
};

export const PROVIDER_HINTS: Record<ProviderMode, string> = {
	startPlan: 'Uses your ZCode account JWT (Start Plan quota / discount).',
	bigmodel: 'Uses BigModel Coding Plan API key → /api/coding/paas/v4 (not the pay-as-you-go wallet).',
	deepseek: 'Official DeepSeek Messages API (api.deepseek.com). API key as x-api-key. Thinking: off / low / high / max.',
};

export function isProviderMode(value: unknown): value is ProviderMode {
	return value === 'startPlan' || value === 'bigmodel' || value === 'deepseek';
}

/**
 * Map legacy settings (`zcode`, `glm`, and the pre-peer-brain `deepseek` sub-provider)
 * onto the current modes. The activation step additionally flips a legacy
 * `deepseek` providerMode over to the DeepSeek brain.
 */
export function normalizeProviderMode(value: unknown): ProviderMode {
	if (value === 'zcode') {
		return 'startPlan';
	}
	if (value === 'glm') {
		return 'bigmodel';
	}
	if (value === 'startPlan' || value === 'bigmodel') {
		return value;
	}
	return 'startPlan';
}

export function getProviderMode(): ProviderMode {
	const raw = vscode.workspace.getConfiguration('zcode').get<string>('providerMode');
	return normalizeProviderMode(raw);
}

export async function setProviderMode(mode: ProviderMode): Promise<void> {
	await vscode.workspace.getConfiguration('zcode').update('providerMode', mode, vscode.ConfigurationTarget.Global);
}

export async function pickProviderMode(current?: ProviderMode): Promise<ProviderMode | undefined> {
	const active = current ?? getProviderMode();
	const picked = await vscode.window.showQuickPick(
		PROVIDER_MODES.map(mode => ({
			label: PROVIDER_LABELS[mode],
			description: mode === active ? 'current' : undefined,
			detail: PROVIDER_HINTS[mode],
			mode,
		})),
		{ title: 'ZCode provider', placeHolder: 'Select AI provider (same as ZCode)' },
	);
	return picked?.mode;
}
