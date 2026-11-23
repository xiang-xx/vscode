/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { zcodeHomeDir } from './userInstructions';

/**
 * Composer quick actions — the ⚡ pill under the chat input.
 * Globally customized via ~/.zcode/quick-actions.json (or .yaml/.yml).
 * Each entry can pin brain / model / 思考深度 (reasoningLevel) / 思考范围 (pace)
 * and optionally send a prompt to the current worker session.
 */
export interface QuickActionDefinition {
	id: string;
	label: string;
	description?: string;
	brain?: string;
	model?: string;
	/** 思考深度：low / high / max / disabled / enabled …（随模型支持而定） */
	reasoningLevel?: string;
	/** 思考范围（节奏）：fast / balanced / thorough */
	pace?: string;
	/** 点击后发送到当前会话的一句话；留空则只应用设置 */
	prompt?: string;
}

/**
 * One-shot per-turn overrides for a quick reply (an action WITH a prompt).
 * Resolved from the action's pins but never written back into the global
 * selection — the composer's own 模型 / 思考深度 / 思考范围 stays untouched.
 */
export interface TurnOverrides {
	brain?: string;
	model?: string;
	reasoningLevel?: string;
	/** fast / balanced / thorough */
	pace?: string;
}

const MAX_ACTIONS = 30;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_LABEL_CHARS = 60;
const MAX_PROMPT_CHARS = 4000;
const CACHE_TTL_MS = 3000;
const VALID_PACES = new Set(['fast', 'balanced', 'thorough']);

/** Probed in order; the first one that exists wins. */
const CONFIG_CANDIDATES = ['quick-actions.json', 'quick-actions.yaml', 'quick-actions.yml'] as const;

export function quickActionsConfigPath(): string {
	const dir = path.join(zcodeHomeDir(), '.zcode');
	for (const name of CONFIG_CANDIDATES) {
		try {
			if (fs.statSync(path.join(dir, name)).isFile()) {
				return path.join(dir, name);
			}
		} catch { /* keep probing */ }
	}
	return path.join(dir, CONFIG_CANDIDATES[0]);
}

let cache: { at: number; actions: QuickActionDefinition[] } | undefined;

/** Cached read (3s TTL) so every pushState can call it cheaply. */
export function loadQuickActions(): QuickActionDefinition[] {
	const now = Date.now();
	if (cache && now - cache.at < CACHE_TTL_MS) {
		return cache.actions;
	}
	const actions = readQuickActionsFile();
	cache = { at: now, actions };
	return actions;
}

/** Drop the read cache so the next loadQuickActions() re-reads from disk. */
export function invalidateQuickActionsCache(): void {
	cache = undefined;
}

/**
 * Watch the config candidates in ~/.zcode and call onChange (debounced) when
 * one is created/changed/renamed — e.g. the user saved the file in the editor.
 * Without this the webview keeps the quickActions snapshot from the last
 * pushState and the ⚡ dropdown stays stale after config edits.
 */
export function watchQuickActionsConfig(onChange: () => void): vscode.Disposable {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const fire = () => {
		if (timer) {
			clearTimeout(timer);
		}
		timer = setTimeout(() => {
			timer = undefined;
			invalidateQuickActionsCache();
			onChange();
		}, 200);
	};
	const dispose = () => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
	};
	try {
		const watcher = fs.watch(path.join(zcodeHomeDir(), '.zcode'), (_event, filename) => {
			const name = filename ?? '';
			if ((CONFIG_CANDIDATES as readonly string[]).includes(name)) {
				fire();
			}
		});
		return new vscode.Disposable(() => {
			dispose();
			watcher.close();
		});
	} catch {
		// ~/.zcode missing or watching unavailable — the 3s read cache still
		// picks changes up on the next unrelated pushState.
		return new vscode.Disposable(dispose);
	}
}

function readQuickActionsFile(): QuickActionDefinition[] {
	for (const name of CONFIG_CANDIDATES) {
		const filePath = path.join(zcodeHomeDir(), '.zcode', name);
		let raw: string;
		try {
			const stat = fs.statSync(filePath);
			if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) {
				continue;
			}
			raw = fs.readFileSync(filePath, 'utf8');
		} catch {
			continue;
		}
		const parsed = name.endsWith('.json') ? parseJson(raw) : parseYamlSubset(raw);
		const actions = normalizeQuickActions(parsed);
		if (actions) {
			return actions;
		}
	}
	return [];
}

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw.replace(/^\uFEFF/, ''));
	} catch {
		return undefined;
	}
}

type RawEntry = Record<string, unknown>;

function normalizeQuickActions(parsed: unknown): QuickActionDefinition[] | undefined {
	if (parsed === undefined || parsed === null) {
		return undefined;
	}
	const container = parsed as RawEntry;
	const list: unknown[] = Array.isArray(parsed)
		? parsed
		: Array.isArray(container.actions)
			? container.actions
			: Array.isArray(container.quickActions)
				? container.quickActions
				: typeof parsed === 'object' && parsed !== null
					? [parsed]
					: [];
	const actions: QuickActionDefinition[] = [];
	const seen = new Set<string>();
	for (const entry of list) {
		if (actions.length >= MAX_ACTIONS || typeof entry !== 'object' || entry === null) {
			continue;
		}
		const record = entry as RawEntry;
		const action = normalizeEntry(record, actions.length + 1);
		if (!action) {
			continue;
		}
		let id = action.id;
		for (let i = 2; seen.has(id); i++) {
			id = `${action.id}-${i}`;
		}
		seen.add(id);
		actions.push({ ...action, id });
	}
	return actions;
}

function normalizeEntry(record: RawEntry, ordinal: number): QuickActionDefinition | undefined {
	const label = clampText(record.label ?? record.name, MAX_LABEL_CHARS);
	if (!label) {
		return undefined;
	}
	const action: QuickActionDefinition = {
		id: clampText(record.id, 64) || slugify(label) || `action-${ordinal}`,
		label,
	};
	const description = clampText(record.description, 200);
	if (description) {
		action.description = description;
	}
	const brain = clampText(record.brain, 32)?.toLowerCase();
	if (brain) {
		action.brain = brain;
	}
	const model = clampText(record.model, 120);
	if (model) {
		action.model = model;
	}
	const reasoningLevel = clampText(record.reasoningLevel ?? record.thinking, 32)?.toLowerCase();
	if (reasoningLevel) {
		action.reasoningLevel = reasoningLevel;
	}
	const pace = clampText(record.pace, 16)?.toLowerCase();
	if (pace && VALID_PACES.has(pace)) {
		action.pace = pace;
	}
	const prompt = clampText(record.prompt ?? record.text, MAX_PROMPT_CHARS);
	if (prompt) {
		action.prompt = prompt;
	}
	return action;
}

function clampText(value: unknown, max: number): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const text = value.replace(/\s+/g, ' ').trim();
	if (!text) {
		return undefined;
	}
	return text.length > max ? text.slice(0, max) : text;
}

function slugify(label: string): string {
	return (label.match(/[A-Za-z0-9][A-Za-z0-9._-]*/g)?.join('-') ?? '')
		.toLowerCase()
		.slice(0, 64)
		.replace(/^-+|-+$/g, '');
}

/**
 * Minimal YAML subset for this schema only: an optional `actions:` top key
 * followed by `- key: value` items with flat scalar continuation lines.
 * Multi-line strings are not supported — use JSON for those.
 */
function parseYamlSubset(raw: string): unknown {
	const items: RawEntry[] = [];
	let current: RawEntry | undefined;
	let inActions = false;
	for (const rawLine of raw.replace(/^\uFEFF/, '').split(/\r?\n/)) {
		const line = rawLine.replace(/\t/g, '  ');
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}
		const topMatch = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
		if (topMatch && !line.startsWith(' ')) {
			const key = (topMatch[1] ?? '').toLowerCase();
			inActions = key === 'actions' || key === 'quickactions' || key === 'quick_actions';
			continue;
		}
		const dashMatch = /^\s+-\s*(.*)$/.exec(line);
		if (dashMatch) {
			current = {};
			items.push(current);
			applyYamlKeyValue(current, dashMatch[1] ?? '');
			continue;
		}
		if (current && inActions) {
			applyYamlKeyValue(current, trimmed);
		}
	}
	return items;
}

function applyYamlKeyValue(target: RawEntry, text: string): void {
	const match = /^([\w-]+)\s*:\s*(.*)$/.exec(text.trim());
	if (!match) {
		return;
	}
	const key = (match[1] ?? '').toLowerCase();
	let value = (match[2] ?? '').trim();
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		value = value.slice(1, -1);
	} else {
		const hash = value.indexOf(' #');
		if (hash >= 0) {
			value = value.slice(0, hash).trim();
		}
	}
	target[key] = value;
}

const EXAMPLE_CONFIG = `{
  "_readme": "聊天输入框下方 ⚡ 下拉的快捷功能。字段：label 显示名；brain 可选 zcode/cursor/deepseek/qianwen；model 模型 ID；reasoningLevel 思考深度（low/high/max/disabled/enabled，随模型支持）；pace 思考范围 fast/balanced/thorough；prompt 点击后发送到当前 Worker 的一句话，可留空只切设置。",
  "actions": [
    {
      "id": "merge-test",
      "label": "合并到 test 并推送",
      "brain": "zcode",
      "model": "GLM-5.3-Flash",
      "reasoningLevel": "low",
      "pace": "fast",
      "prompt": "把当前的 feature 分支合并到 test 分支并推送。"
    }
  ]
}
`;

/** Open the config file in the editor, seeding an example when missing. */
export async function openQuickActionsConfigFile(): Promise<void> {
	const filePath = quickActionsConfigPath();
	try {
		if (!fs.existsSync(filePath)) {
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, EXAMPLE_CONFIG, 'utf8');
			cache = undefined;
		}
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
		await vscode.window.showTextDocument(document, { preview: false });
	} catch (error) {
		void vscode.window.showErrorMessage(`无法打开快捷功能配置：${error instanceof Error ? error.message : String(error)}`);
	}
}
