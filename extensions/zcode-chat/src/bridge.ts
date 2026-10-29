/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { runWorkspaceAgent, type AgentProgressEvent } from './agentRuntime';
import { getAuthService } from './authSession';
import { getSelectedModelId, getSelectedReasoningLevel } from './models';
import { getProviderMode, PROVIDER_HINTS, PROVIDER_LABELS, type ProviderMode } from './providers';
import { loadCodingPlanApiKey } from './zcodeCredentialsStore';

export type BridgeMode = 'agent' | 'stub' | 'http';

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface ChatTurnRequest {
	messages: ChatMessage[];
	provider: ProviderMode;
	model?: string;
	reasoningLevel?: string;
	workspaceRoot?: string;
	onProgress?: (event: AgentProgressEvent) => void;
	initialTodos?: import('./conversation').TodoItem[];
}

export interface ChatTurnResult {
	content: string;
	provider: ProviderMode;
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
	const provider = getProviderMode();
	const model = getSelectedModelId(provider);
	const reasoningLevel = getSelectedReasoningLevel(provider, model);
	const bridge = getBridgeMode();
	const endpoint = getBridgeEndpoint();
	const session = safeSession();
	return [
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
 * Default `agent` mode talks to BigModel Coding Plan (or Start Plan JWT) and
 * runs a local tool loop (read/write/str_replace/list_dir) against the workspace.
 */
export async function completeChatTurn(
	request: ChatTurnRequest,
	token: vscode.CancellationToken,
): Promise<ChatTurnResult> {
	const bridgeMode = getBridgeMode();
	if (bridgeMode === 'http') {
		return completeViaHttp(request, token);
	}
	if (bridgeMode === 'stub') {
		return completeViaStub(request);
	}
	return completeViaAgent(request, token);
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
	});
	return {
		content: result.text,
		provider,
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
			bridgeMode: 'http',
		};
	} finally {
		cancel.dispose();
	}
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

export function workspaceRoot(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
