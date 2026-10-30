/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { runWorkspaceAgent, type AgentProgressEvent } from './agentRuntime';
import type { AskUserHandler } from './askUser';
import { getAuthService } from './authSession';
import { BRAIN_LABELS, getActiveBrain, getCursorAgentMode, getCursorModel, type ActiveBrain } from './brains';
import { runCursorAgent } from './cursorAgentRuntime';
import { getCursorAuthStatus } from './cursorAuth';
import { getSelectedModelId, getSelectedReasoningLevel } from './models';
import { getProviderMode, PROVIDER_HINTS, PROVIDER_LABELS, type ProviderMode } from './providers';
import { loadCodingPlanApiKey } from './zcodeCredentialsStore';

export type BridgeMode = 'agent' | 'stub' | 'http' | 'cursor-acp';

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface ChatTurnRequest {
	messages: ChatMessage[];
	provider: ProviderMode;
	brain?: ActiveBrain;
	model?: string;
	reasoningLevel?: string;
	workspaceRoot?: string;
	onProgress?: (event: AgentProgressEvent) => void;
	initialTodos?: import('./conversation').TodoItem[];
	askUser?: AskUserHandler;
}

export interface ChatTurnResult {
	content: string;
	provider: ProviderMode;
	brain: ActiveBrain;
	bridgeMode: BridgeMode;
	stub?: boolean;
	todos?: import('./conversation').TodoItem[];
}

export function getBridgeMode(): BridgeMode {
	const raw = vscode.workspace.getConfiguration('zcode').get<string>('bridge.mode');
	if (raw === 'stub' || raw === 'http' || raw === 'agent') {
		return raw;
	}
	return 'agent';
}

export function getBridgeEndpoint(): string {
	return vscode.workspace.getConfiguration('zcode').get<string>('bridge.endpoint')
		?? 'http://127.0.0.1:4096/api/chat';
}

export function getBridgeStatusText(): string {
	const brain = getActiveBrain();
	if (brain === 'cursor') {
		return [
			`Brain: ${BRAIN_LABELS.cursor}`,
			`Mode: ${getCursorAgentMode()}`,
			`Model: ${getCursorModel() || '(CLI default)'}`,
			`Bridge: cursor-acp (agent acp)`,
			'Auth: Cursor CLI (`agent login` / CURSOR_API_KEY)',
		].join('\n');
	}
	const provider = getProviderMode();
	const model = getSelectedModelId(provider);
	const reasoningLevel = getSelectedReasoningLevel(provider, model);
	const bridge = getBridgeMode();
	const endpoint = getBridgeEndpoint();
	const session = safeSession();
	return [
		`Brain: ${BRAIN_LABELS.zcode}`,
		`Provider: ${PROVIDER_LABELS[provider]} (${provider})`,
		`Model: ${model} · thinking ${reasoningLevel}`,
		`Account: ${session ? `${session.accountLabel} (${session.provider})` : 'signed out'}`,
		`Bridge: ${bridge}`,
		bridge === 'http' ? `Endpoint: ${endpoint}` : bridge === 'agent'
			? 'Endpoint: BigModel Coding Plan / Start Plan (direct)'
			: 'Endpoint: (stub — no network)',
		PROVIDER_HINTS[provider],
	].join('\n');
}

/**
 * Routes by top-level brain. ZCode uses BigModel/Start Plan tool loop (or stub/http);
 * Cursor uses official `agent acp`.
 */
export async function completeChatTurn(
	request: ChatTurnRequest,
	token: vscode.CancellationToken,
): Promise<ChatTurnResult> {
	const brain = request.brain ?? getActiveBrain();
	if (brain === 'cursor') {
		return completeViaCursorAcp(request, token);
	}
	const bridgeMode = getBridgeMode();
	if (bridgeMode === 'http') {
		return completeViaHttp(request, token);
	}
	if (bridgeMode === 'stub') {
		return completeViaStub(request);
	}
	return completeViaAgent(request, token);
}

async function completeViaCursorAcp(
	request: ChatTurnRequest,
	token: vscode.CancellationToken,
): Promise<ChatTurnResult> {
	const result = await runCursorAgent({
		messages: request.messages,
		workspaceRoot: request.workspaceRoot,
		token,
		onProgress: request.onProgress,
		initialTodos: request.initialTodos,
		mode: getCursorAgentMode(),
		model: request.model || getCursorModel() || undefined,
		askUser: request.askUser,
	});
	return {
		content: result.text,
		provider: request.provider,
		brain: 'cursor',
		bridgeMode: 'cursor-acp',
		todos: result.todos,
	};
}

async function completeViaAgent(
	request: ChatTurnRequest,
	token: vscode.CancellationToken,
): Promise<ChatTurnResult> {
	const provider = request.provider;
	const model = request.model ?? getSelectedModelId(provider);
	const reasoningLevel = request.reasoningLevel ?? getSelectedReasoningLevel(provider, model);
	const result = await runWorkspaceAgent({
		messages: request.messages,
		provider,
		model,
		reasoningLevel,
		workspaceRoot: request.workspaceRoot,
		token,
		onProgress: request.onProgress,
		initialTodos: request.initialTodos,
		askUser: request.askUser,
	});
	return {
		content: result.text,
		provider,
		brain: 'zcode',
		bridgeMode: 'agent',
		todos: result.todos,
	};
}

async function completeViaStub(request: ChatTurnRequest): Promise<ChatTurnResult> {
	const lastUser = [...request.messages].reverse().find(m => m.role === 'user');
	const prompt = lastUser?.content?.trim() || '(empty)';
	const provider = request.provider;
	const model = request.model ?? getSelectedModelId(provider);
	const reasoningLevel = request.reasoningLevel ?? getSelectedReasoningLevel(provider, model);
	const session = safeSession();
	const codingKey = await loadCodingPlanApiKey('bigmodel').catch(() => undefined);
	const content = [
		`[ZCode stub · ${PROVIDER_LABELS[provider]} · ${model} · thinking ${reasoningLevel}]`,
		'',
		`Received: ${truncate(prompt, 400)}`,
		'',
		session
			? `Signed in as ${session.accountLabel} (${session.provider}).`
			: 'Not signed in.',
		codingKey ? 'Coding Plan API key: found.' : 'Coding Plan API key: missing.',
		'',
		'Stub mode is on. Set `zcode.bridge.mode` to `agent` (default) to run for real.',
	].join('\n');

	return {
		content,
		provider,
		brain: 'zcode',
		bridgeMode: 'stub',
		stub: true,
	};
}

async function completeViaHttp(
	request: ChatTurnRequest,
	token: vscode.CancellationToken,
): Promise<ChatTurnResult> {
	const endpoint = getBridgeEndpoint();
	const apiKey = await resolveHttpApiKey(request.provider);
	const controller = new AbortController();
	const cancel = token.onCancellationRequested(() => controller.abort());

	const model = request.model ?? getSelectedModelId(request.provider);
	const reasoningLevel = request.reasoningLevel ?? getSelectedReasoningLevel(request.provider, model);

	try {
		const response = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
				'X-ZCode-Provider': request.provider,
				'X-ZCode-Reasoning-Level': reasoningLevel,
			},
			body: JSON.stringify({
				model,
				messages: request.messages,
				stream: false,
				metadata: {
					workspaceRoot: request.workspaceRoot,
					provider: request.provider,
					reasoningLevel,
				},
			}),
			signal: controller.signal,
		});

		if (!response.ok) {
			const body = await response.text().catch(() => '');
			throw new Error(`Bridge HTTP ${response.status}: ${body || response.statusText}`);
		}

		const data = await response.json() as {
			choices?: Array<{ message?: { content?: string } }>;
			content?: string;
			message?: string;
		};

		const content =
			data.choices?.[0]?.message?.content
			?? data.content
			?? data.message
			?? JSON.stringify(data);

		return {
			content,
			provider: request.provider,
			brain: 'zcode',
			bridgeMode: 'http',
		};
	} finally {
		cancel.dispose();
	}
}

/** Async status line for Cursor brain (CLI login). */
export async function getCursorBrainStatusLine(): Promise<string> {
	const status = await getCursorAuthStatus();
	if (status.loggedIn) {
		return status.email ? `Cursor · ${status.email}` : 'Cursor · signed in';
	}
	return 'Cursor · not logged in';
}

async function resolveHttpApiKey(provider: ProviderMode): Promise<string | undefined> {
	if (provider === 'bigmodel') {
		return (await loadCodingPlanApiKey('bigmodel'))
			?? emptyToUndefined(safeSession()?.accessToken);
	}
	return emptyToUndefined(safeSession()?.zcodeJwtToken);
}

function safeSession() {
	try {
		return getAuthService().getSession();
	} catch {
		return undefined;
	}
}

function emptyToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	return `${text.slice(0, max)}…`;
}

/**
 * Workspace folder the agents should run in: prefer the folder that owns the
 * active editor, else the first workspace folder. Never prompts for a path.
 */
export function workspaceRoot(): string | undefined {
	const active = vscode.window.activeTextEditor?.document.uri;
	if (active && (active.scheme === 'file' || active.scheme === 'vscode-remote')) {
		const folder = vscode.workspace.getWorkspaceFolder(active);
		if (folder) {
			return folder.uri.fsPath;
		}
	}
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
