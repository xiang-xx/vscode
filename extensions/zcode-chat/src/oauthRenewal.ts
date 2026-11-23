/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { loginWithZCodeCliPolling } from './oauthLogin';
import { resetBigModelCodingPlanCache } from './bigmodelCodingPlan';
import {
	loadZCodeDesktopSession,
	saveZCodeDesktopSession,
	type ZCodeOAuthProvider,
	type ZCodeStoredSession,
} from './zcodeCredentialsStore';

/**
 * Session renewal for the ZCode OAuth login.
 *
 * There is **no silent token refresh** for BigModel or Z.ai as of 2026-11:
 * - the stored access token is opaque (no JWT `exp`, so expiry is not
 *   knowable locally);
 * - `https://bigmodel.cn/api/auth/tokenByRefreshToken` answers 404, and
 *   `https://zcode.z.ai/api/v1/oauth/{refresh,token/refresh,refresh_token}`
 *   all answer 404 — only `oauth/cli/{init,poll}` and `oauth/token` exist;
 * - the store on this machine carries no `refresh_token`, and the ZCode
 *   desktop's own BigModel adapter ships no `refreshToken` exchange at all
 *   (`docs/oauth/jwt-401-auto-logout.md`: "不新增刷新能力").
 *
 * `POST https://bigmodel.cn/api/auth/refresh` with the live token answers
 * `{"code":200,"data":null}` — it mints nothing, so it cannot renew either.
 *
 * What actually works is re-authorization: the CLI polling flow issues a brand
 * new session, and when the browser still holds the account cookie it completes
 * without any click. So renewal here = re-run that flow once, persist the new
 * session, and let the caller retry the request it was about to send.
 */

/** Renew when a token is this close to its (parsed) expiry. */
const EXPIRY_SKEW_MS = 5 * 60_000;
/** Never start two renewal flows back to back. */
const RENEW_COOLDOWN_MS = 60_000;
/** Hard cap on one interactive renewal, so a chat send cannot hang forever. */
const RENEW_TIMEOUT_MS = 3 * 60_000;

export interface RenewalResult {
	renewed: boolean;
	/** Why renewal did not happen; safe to show to the user. */
	detail?: string;
}

let inFlight: Promise<RenewalResult> | undefined;
let lastAttemptAt = 0;
let lastDetail: string | undefined;
let renewedSession: ZCodeStoredSession | undefined;

/** Technical detail behind the last failed renewal. */
export function lastRenewalDetail(): string | undefined {
	return lastDetail;
}

/** Session produced by the last successful renewal, if any. */
export function lastRenewedSession(): ZCodeStoredSession | undefined {
	return renewedSession;
}

/** `exp` of a JWT-shaped token, in ms. Opaque tokens return undefined. */
export function tokenExpiresAt(token: string): number | undefined {
	const payload = token.split('.')[1];
	if (!payload) {
		return undefined;
	}
	try {
		const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
		return typeof decoded.exp === 'number' && decoded.exp > 0 ? decoded.exp * 1000 : undefined;
	} catch {
		return undefined;
	}
}

export interface SessionExpiry {
	present: boolean;
	expiresAtMs?: number;
	/** Opaque token: we know it exists but not when it dies. */
	opaque: boolean;
}

/** Read the stored session's expiry without touching the network. */
export async function currentSessionExpiry(): Promise<SessionExpiry> {
	const session = await loadZCodeDesktopSession().catch(() => undefined);
	if (!session?.accessToken) {
		return { present: false, opaque: false };
	}
	const expiresAtMs = tokenExpiresAt(session.accessToken);
	return { present: true, expiresAtMs, opaque: expiresAtMs === undefined };
}

/**
 * Proactive half of the renewal: when the stored token carries a readable
 * `exp` that is inside the skew window, re-authorize before the request goes
 * out. Opaque tokens (BigModel today) cannot be checked and are left alone.
 */
export async function renewIfExpiringSoon(provider?: ZCodeOAuthProvider): Promise<RenewalResult> {
	const expiry = await currentSessionExpiry();
	if (!expiry.present || expiry.expiresAtMs === undefined) {
		return { renewed: false, detail: '令牌不透明，无法判断到期时间' };
	}
	if (expiry.expiresAtMs - Date.now() > EXPIRY_SKEW_MS) {
		return { renewed: false, detail: '令牌仍然有效' };
	}
	return ensureSessionRenewed({ provider, force: true });
}

function autoRenewEnabled(): boolean {
	return vscode.workspace.getConfiguration('zcode').get<boolean>('auth.autoRenew', true);
}

/**
 * Renew the sign-in when it is known to be expiring, or when the caller has
 * already been told the token is dead (`force`).
 *
 * `force` skips the expiry heuristic but still honours `zcode.auth.autoRenew`
 * and the cooldown: a burst of 401s starts a single authorization flow, and an
 * opted-out user is never sent to the browser behind their back.
 */
export async function ensureSessionRenewed(options: {
	force?: boolean;
	provider?: ZCodeOAuthProvider;
} = {}): Promise<RenewalResult> {
	if (inFlight) {
		return inFlight;
	}
	if (!autoRenewEnabled()) {
		return { renewed: false, detail: '自动续期已关闭（设置项 zcode.auth.autoRenew）' };
	}
	const expiry = await currentSessionExpiry();
	if (!expiry.present) {
		lastDetail = '没有找到 ZCode 登录会话';
		return { renewed: false, detail: lastDetail };
	}
	// Nothing to do when the token is comfortably valid — unless a 401 forced us.
	if (!options.force) {
		if (expiry.opaque || expiry.expiresAtMs === undefined) {
			return { renewed: false, detail: '令牌不透明，无法判断到期时间' };
		}
		if (expiry.expiresAtMs - Date.now() > EXPIRY_SKEW_MS) {
			return { renewed: false, detail: '令牌仍然有效' };
		}
	}
	if (Date.now() - lastAttemptAt < RENEW_COOLDOWN_MS) {
		return { renewed: false, detail: '刚刚已经尝试过续期，请稍等一分钟' };
	}

	inFlight = runRenewal(options.provider).finally(() => {
		lastAttemptAt = Date.now();
		inFlight = undefined;
	});
	return inFlight;
}

async function runRenewal(provider?: ZCodeOAuthProvider): Promise<RenewalResult> {
	const existing = await loadZCodeDesktopSession().catch(() => undefined);
	const target = provider ?? existing?.provider ?? 'bigmodel';
	try {
		const session = await authorizeSession(target);
		await saveZCodeDesktopSession(session);
		resetBigModelCodingPlanCache();
		renewedSession = session;
		lastDetail = undefined;
		void vscode.window.showInformationMessage(`${providerLabel(target)} 登录已自动续期（${session.accountLabel}）。`);
		return { renewed: true };
	} catch (error) {
		lastDetail = (error as Error)?.message ?? String(error);
		// Cancelling is a user decision, not an error worth a toast.
		if (!(error instanceof vscode.CancellationError) && !/cancel/i.test(lastDetail)) {
			void vscode.window.showWarningMessage(`${providerLabel(target)} 自动续期没有完成：${lastDetail}`);
		}
		return { renewed: false, detail: lastDetail };
	}
}

function providerLabel(provider: ZCodeOAuthProvider): string {
	return provider === 'zai' ? 'Z.ai' : 'BigModel';
}

/**
 * Run one authorization round-trip. Nothing is persisted here; the caller
 * decides where the session lands.
 */
export async function authorizeSession(target: ZCodeOAuthProvider): Promise<ZCodeStoredSession> {
	return vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: `${providerLabel(target)} 登录需要重新授权…`,
			cancellable: true,
		},
		async (progress, token) => {
			progress.report({ message: '浏览器会自动打开；已登录时无需点击。' });
			return withTimeout(loginWithZCodeCliPolling(target, token), RENEW_TIMEOUT_MS, token);
		},
	);
}

function withTimeout<T>(promise: Promise<T>, ms: number, token: vscode.CancellationToken): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`自动续期超时（${Math.round(ms / 1000)} 秒）`)), ms);
		const sub = token.onCancellationRequested(() => {
			clearTimeout(timer);
			sub.dispose();
			reject(new vscode.CancellationError());
		});
		promise.then(
			value => { clearTimeout(timer); sub.dispose(); resolve(value); },
			error => { clearTimeout(timer); sub.dispose(); reject(error); },
		);
	});
}

/** Test seam: forget cooldown/backoff state. */
export function resetRenewalState(): void {
	inFlight = undefined;
	lastAttemptAt = 0;
	lastDetail = undefined;
	renewedSession = undefined;
}
