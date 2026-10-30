/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** Top-level AI brain — ZCode and Cursor are peers. */
export type ActiveBrain = 'zcode' | 'cursor';

export const BRAINS: readonly ActiveBrain[] = ['zcode', 'cursor'];

export const BRAIN_LABELS: Record<ActiveBrain, string> = {
	zcode: 'ZCode',
	cursor: 'Cursor',
};

export function isActiveBrain(value: unknown): value is ActiveBrain {
	return value === 'zcode' || value === 'cursor';
}

export function getActiveBrain(): ActiveBrain {
	const raw = vscode.workspace.getConfiguration('zcode').get<string>('activeBrain');
	return isActiveBrain(raw) ? raw : 'zcode';
}

export async function setActiveBrain(brain: ActiveBrain): Promise<void> {
	await vscode.workspace.getConfiguration('zcode').update('activeBrain', brain, vscode.ConfigurationTarget.Global);
}

export async function pickActiveBrain(current?: ActiveBrain): Promise<ActiveBrain | undefined> {
	const active = current ?? getActiveBrain();
	const picked = await vscode.window.showQuickPick(
		BRAINS.map(brain => ({
			label: BRAIN_LABELS[brain],
			description: brain === active ? 'current' : undefined,
			detail: brain === 'zcode'
				? 'Start Plan / BigModel via ZCode credentials'
				: 'Official Cursor Agent CLI (ACP)',
			brain,
		})),
		{ title: 'AI brain', placeHolder: 'ZCode and Cursor are peers' },
	);
	return picked?.brain;
}

export type CursorAgentMode = 'agent' | 'plan' | 'ask';

export function getCursorAgentMode(): CursorAgentMode {
	const raw = vscode.workspace.getConfiguration('zcode').get<string>('cursor.mode');
	if (raw === 'plan' || raw === 'ask' || raw === 'agent') {
		return raw;
	}
	return 'agent';
}

export async function setCursorAgentMode(mode: CursorAgentMode): Promise<void> {
	await vscode.workspace.getConfiguration('zcode').update('cursor.mode', mode, vscode.ConfigurationTarget.Global);
}

export function getCursorModel(): string {
	return vscode.workspace.getConfiguration('zcode').get<string>('cursor.model')?.trim() || '';
}

export async function setCursorModel(model: string): Promise<void> {
	await vscode.workspace.getConfiguration('zcode').update('cursor.model', model, vscode.ConfigurationTarget.Global);
}

export function getCursorAgentPath(): string {
	const configured = vscode.workspace.getConfiguration('zcode').get<string>('cursor.agentPath')?.trim();
	if (configured) {
		return configured;
	}
	const home = process.env.HOME || process.env.USERPROFILE || '';
	return home ? `${home}/.local/bin/agent` : 'agent';
}
