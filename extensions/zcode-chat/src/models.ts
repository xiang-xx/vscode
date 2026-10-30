/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ProviderMode } from './providers';

/**
 * Default model catalogs mirrored from ZCode `config/provider/zcode-builtin.json`
 * (Start Plan + BigModel coding-plan families) and their reasoningLevel optionSpecs.
 */
export interface ZCodeModelOption {
	id: string;
	label: string;
	reasoningLevels: readonly string[];
	defaultReasoningLevel: string;
}

const START_PLAN_MODELS: readonly ZCodeModelOption[] = [
	{
		id: 'GLM-5.3-Flash',
		label: 'GLM-5.3-Flash',
		reasoningLevels: ['low', 'high', 'max'],
		defaultReasoningLevel: 'low',
	},
	{
		id: 'GLM-5.2',
		label: 'GLM-5.2',
		reasoningLevels: ['disabled', 'high', 'max'],
		defaultReasoningLevel: 'disabled',
	},
	{
		id: 'GLM-5-Turbo',
		label: 'GLM-5-Turbo',
		reasoningLevels: ['disabled', 'enabled'],
		defaultReasoningLevel: 'disabled',
	},
];

const BIGMODEL_MODELS: readonly ZCodeModelOption[] = [
	{
		id: 'GLM-5.3',
		label: 'GLM-5.3',
		reasoningLevels: ['low', 'high', 'max'],
		defaultReasoningLevel: 'low',
	},
	{
		id: 'GLM-5.3-Flash',
		label: 'GLM-5.3-Flash',
		reasoningLevels: ['low', 'high', 'max'],
		defaultReasoningLevel: 'low',
	},
];

/** Display labels aligned with ZCode thought-level wording. */
export const REASONING_LABELS: Record<string, string> = {
	disabled: 'Off',
	enabled: 'On',
	off: 'Off',
	on: 'On',
	none: 'Off',
	nothink: 'Off',
	low: 'Low',
	minimal: 'Minimal',
	medium: 'Medium',
	high: 'High',
	xhigh: 'Extra high',
	max: 'Max',
	ultra: 'Ultra',
};

export function modelsForProvider(provider: ProviderMode): readonly ZCodeModelOption[] {
	return provider === 'bigmodel' ? BIGMODEL_MODELS : START_PLAN_MODELS;
}

export function findModel(provider: ProviderMode, modelId: string | undefined): ZCodeModelOption {
	const models = modelsForProvider(provider);
	return models.find(m => m.id === modelId) ?? models[0]!;
}

export function getSelectedModelId(provider: ProviderMode): string {
	const raw = vscode.workspace.getConfiguration('zcode').get<string>('model');
	return findModel(provider, raw).id;
}

/** Persist a valid model for the provider when the stored id is not in that catalog. */
export async function ensureModelForProvider(provider: ProviderMode): Promise<string> {
	const raw = vscode.workspace.getConfiguration('zcode').get<string>('model');
	const models = modelsForProvider(provider);
	if (raw && models.some(m => m.id === raw)) {
		return raw;
	}
	const next = models[0]!.id;
	await setSelectedModelId(next);
	return next;
}

export function getSelectedReasoningLevel(provider: ProviderMode, modelId?: string): string {
	const model = findModel(provider, modelId ?? getSelectedModelId(provider));
	const raw = vscode.workspace.getConfiguration('zcode').get<string>('reasoningLevel');
	if (raw && model.reasoningLevels.includes(raw)) {
		return raw;
	}
	return model.defaultReasoningLevel;
}

export async function setSelectedModelId(modelId: string): Promise<void> {
	await vscode.workspace.getConfiguration('zcode').update('model', modelId, vscode.ConfigurationTarget.Global);
}

export async function setSelectedReasoningLevel(level: string): Promise<void> {
	await vscode.workspace.getConfiguration('zcode').update('reasoningLevel', level, vscode.ConfigurationTarget.Global);
}

/** When provider/model changes, keep reasoningLevel valid for the new model. */
export async function ensureReasoningLevelForModel(provider: ProviderMode, modelId: string): Promise<string> {
	const model = findModel(provider, modelId);
	const current = vscode.workspace.getConfiguration('zcode').get<string>('reasoningLevel');
	if (current && model.reasoningLevels.includes(current)) {
		return current;
	}
	await setSelectedReasoningLevel(model.defaultReasoningLevel);
	return model.defaultReasoningLevel;
}

export async function pickModel(provider: ProviderMode): Promise<string | undefined> {
	const current = getSelectedModelId(provider);
	const picked = await vscode.window.showQuickPick(
		modelsForProvider(provider).map(m => ({
			label: m.label,
			description: m.id === current ? 'current' : undefined,
			detail: `Thinking: ${m.reasoningLevels.map(l => REASONING_LABELS[l] ?? l).join(' / ')}`,
			id: m.id,
		})),
		{ title: 'ZCode model', placeHolder: 'Select model (ZCode defaults)' },
	);
	return picked?.id;
}

export async function pickReasoningLevel(provider: ProviderMode, modelId?: string): Promise<string | undefined> {
	const model = findModel(provider, modelId ?? getSelectedModelId(provider));
	const current = getSelectedReasoningLevel(provider, model.id);
	const picked = await vscode.window.showQuickPick(
		model.reasoningLevels.map(level => ({
			label: REASONING_LABELS[level] ?? level,
			description: level === current ? 'current' : level,
			level,
		})),
		{ title: 'Thinking intensity', placeHolder: 'Select reasoning level' },
	);
	return picked?.level;
}
