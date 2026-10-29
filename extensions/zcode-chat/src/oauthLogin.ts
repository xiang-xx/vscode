/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import type { ZCodeOAuthProvider, ZCodeStoredSession } from './zcodeCredentialsStore';

const DEFAULT_API_ORIGIN = 'https://zcode.z.ai';

interface FlowInitData {
	flow_id?: string;
	authorize_url?: string;
	expires_at?: number;
	poll_interval_sec?: number;
}

interface FlowEnvelope {
	code?: number;
	msg?: string;
	data?: FlowInitData & {
		status?: string;
		token?: string;
		user?: Record<string, unknown>;
		zai?: Record<string, unknown>;
		bigmodel?: Record<string, unknown>;
	};
}

/**
 * ZCode desktop registers `zcode://oauth/callback`. Code-OSS cannot claim that
 * scheme without fighting the desktop app, so we reuse the **CLI polling**
 * login that ZCode already exposes: open the browser, then poll until tokens
 * are ready. No custom URI callback into VS Code is required.
 */
export async function loginWithZCodeCliPolling(
	provider: ZCodeOAuthProvider,
	token: vscode.CancellationToken,
): Promise<ZCodeStoredSession> {
	const apiOrigin = vscode.workspace.getConfiguration('zcode').get<string>('oauth.apiOrigin')?.trim()
		|| DEFAULT_API_ORIGIN;
	const pollToken = randomBytes(32).toString('hex');
	const initUrl = `${apiOrigin.replace(/\/$/, '')}/api/v1/oauth/cli/init`;

	const initResponse = await fetch(initUrl, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${pollToken}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ provider }),
		signal: toAbortSignal(token),
	});
	if (!initResponse.ok) {
		throw new Error(`OAuth init failed: HTTP ${initResponse.status}`);
	}
	const envelope = await initResponse.json() as FlowEnvelope;
	const data = envelope.data;
	if (
		envelope.code !== 0
		|| !data?.flow_id
		|| !data.authorize_url
		|| !Number.isFinite(data.expires_at)
		|| !Number.isFinite(data.poll_interval_sec)
	) {
		throw new Error(envelope.msg || 'OAuth init response invalid');
	}

	const authorizeUrl = new URL(data.authorize_url);
	if (provider === 'bigmodel') {
		authorizeUrl.searchParams.set('redirect', 'zcode://oauth/callback');
	} else {
		authorizeUrl.searchParams.set('redirect_uri', 'zcode://oauth/callback');
	}

	await vscode.env.openExternal(vscode.Uri.parse(authorizeUrl.toString()));

	const flowId = data.flow_id;
	const expiresAt = data.expires_at! * 1000;
	const pollIntervalMs = Math.max(1000, data.poll_interval_sec! * 1000);
	const pollUrl = `${apiOrigin.replace(/\/$/, '')}/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`;

	while (!token.isCancellationRequested) {
		if (Date.now() >= expiresAt) {
			throw new Error('OAuth flow expired — try signing in again');
		}
		await delay(pollIntervalMs, token);
		if (token.isCancellationRequested) {
			throw new vscode.CancellationError();
		}

		const pollResponse = await fetch(pollUrl, {
			headers: { Authorization: `Bearer ${pollToken}` },
			signal: toAbortSignal(token),
		});
		if (!pollResponse.ok) {
			if (pollResponse.status >= 400 && pollResponse.status < 500 && pollResponse.status !== 408 && pollResponse.status !== 429) {
				throw new Error(`OAuth poll failed: HTTP ${pollResponse.status}`);
			}
			continue;
		}
		const pollEnvelope = await pollResponse.json() as FlowEnvelope;
		const pollData = pollEnvelope.data;
		const status = pollData?.status;
		if (pollEnvelope.code === 0 && status === 'pending') {
			continue;
		}
		if (pollEnvelope.code !== 0 || !pollData) {
			throw new Error(pollEnvelope.msg || 'OAuth poll response invalid');
		}
		if (status === 'failed') {
			throw new Error('OAuth authorization failed');
		}
		if (status !== 'ready') {
			throw new Error('OAuth poll response invalid');
		}

		const user = pollData.user ?? {};
		const providerBlob = provider === 'zai' ? pollData.zai : pollData.bigmodel;
		const accessToken =
			readString(providerBlob?.access_token)
			|| readString(providerBlob?.accessToken);
		const refreshToken =
			readString(providerBlob?.refresh_token)
			|| readString(providerBlob?.refreshToken);
		const zcodeJwtToken = readString(pollData.token);
		const accountId = readString(user.user_id) || 'zcode-user';
		const accountLabel =
			readString(user.name)
			|| readString(user.email)
			|| accountId;
		if (!zcodeJwtToken || !accessToken) {
			throw new Error('OAuth poll response missing tokens');
		}

		return {
			provider,
			zcodeJwtToken,
			accessToken,
			...(refreshToken ? { refreshToken } : {}),
			accountId,
			accountLabel,
		};
	}

	throw new vscode.CancellationError();
}

function readString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function delay(ms: number, token: vscode.CancellationToken): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		const sub = token.onCancellationRequested(() => {
			clearTimeout(timer);
			sub.dispose();
			reject(new vscode.CancellationError());
		});
	});
}

function toAbortSignal(token: vscode.CancellationToken): AbortSignal | undefined {
	if (typeof AbortSignal === 'undefined') {
		return undefined;
	}
	const controller = new AbortController();
	if (token.isCancellationRequested) {
		controller.abort();
	} else {
		token.onCancellationRequested(() => controller.abort());
	}
	return controller.signal;
}
