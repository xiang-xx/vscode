/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** Matches ZCode’s primary account-backed routes: Start Plan + BigModel. */
export type ProviderMode = 'startPlan' | 'bigmodel';

export const PROVIDER_MODES: readonly ProviderMode[] = ['startPlan', 'bigmodel'];

export const PROVIDER_LABELS: Record<ProviderMode, string> = {
	startPlan: 'ZCode Start Plan',
	bigmodel: 'BigModel',
};

export const PROVIDER_HINTS: Record<ProviderMode, string> = {
	startPlan: 'Uses your ZCode account JWT (Start Plan quota / discount).',
	bigmodel: 'Uses your BigModel OAuth session from the shared ZCode credentials.',
};

export function isProviderMode(value: unknown): value is ProviderMode {
	return value === 'startPlan' || value === 'bigmodel';
}

/** Map legacy P0 settings (deepseek / glm / zcode) onto the ZCode-aligned modes. */
export function normalizeProviderMode(value: unknown): ProviderMode {
	if (isProviderMode(value)) {
		return value;
	}
	if (value === 'zcode' || value === 'deepseek') {
		return 'startPlan';
	}
	if (value === 'glm') {
		return 'bigmodel';
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
