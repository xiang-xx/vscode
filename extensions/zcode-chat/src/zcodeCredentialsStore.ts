/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createZCodeCipher } from './zcodeCipher';

export type ZCodeOAuthProvider = 'zai' | 'bigmodel';

export interface ZCodeStoredSession {
	provider: ZCodeOAuthProvider;
	zcodeJwtToken: string;
	accessToken: string;
	refreshToken?: string;
	accountId: string;
	accountLabel: string;
}

const ACTIVE_PROVIDER_KEY = 'oauth:active_provider';
const ZCODE_JWT_KEY = 'zcodejwttoken';

function credentialsPath(): string {
	const override = process.env.ZCODE_CONFIG_DIR?.trim();
	if (override) {
		return join(override, 'credentials.json');
	}
	return join(homedir(), '.zcode', 'v2', 'credentials.json');
}

function accessTokenKey(provider: ZCodeOAuthProvider): string {
	return `oauth:${provider}:access_token`;
}

function refreshTokenKey(provider: ZCodeOAuthProvider): string {
	return `oauth:${provider}:refresh_token`;
}

function userInfoKey(provider: ZCodeOAuthProvider): string {
	return `oauth:${provider}:user_info`;
}

async function readRawStore(): Promise<Record<string, string>> {
	try {
		const raw = await fs.readFile(credentialsPath(), 'utf8');
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {};
		}
		const out: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof value === 'string') {
				out[key] = value;
			}
		}
		return out;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return {};
		}
		throw error;
	}
}

async function writeRawStore(data: Record<string, string>): Promise<void> {
	const file = credentialsPath();
	await fs.mkdir(join(file, '..'), { recursive: true });
	await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

function isProvider(value: string | null | undefined): value is ZCodeOAuthProvider {
	return value === 'zai' || value === 'bigmodel';
}

function labelFromUserInfo(raw: string | null): { id: string; label: string } | undefined {
	if (!raw) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const rawProfile = parsed.rawProfile && typeof parsed.rawProfile === 'object'
			? parsed.rawProfile as Record<string, unknown>
			: undefined;
		const id =
			(typeof parsed.id === 'string' && parsed.id)
			|| (typeof rawProfile?.user_id === 'string' && rawProfile.user_id)
			|| 'zcode-user';
		const label =
			(typeof parsed.displayName === 'string' && parsed.displayName)
			|| (typeof parsed.username === 'string' && parsed.username)
			|| (typeof rawProfile?.name === 'string' && rawProfile.name)
			|| (typeof rawProfile?.email === 'string' && rawProfile.email)
			|| id;
		return { id, label };
	} catch {
		return undefined;
	}
}

export async function loadZCodeDesktopSession(): Promise<ZCodeStoredSession | undefined> {
	const cipher = createZCodeCipher();
	const store = await readRawStore();
	const providerRaw = store[ACTIVE_PROVIDER_KEY] ? cipher.decrypt(store[ACTIVE_PROVIDER_KEY]) : null;
	if (!isProvider(providerRaw)) {
		return undefined;
	}
	const jwtRaw = store[ZCODE_JWT_KEY];
	const accessRaw = store[accessTokenKey(providerRaw)];
	if (!jwtRaw || !accessRaw) {
		return undefined;
	}
	const zcodeJwtToken = cipher.decrypt(jwtRaw);
	const accessToken = cipher.decrypt(accessRaw);
	const refreshRaw = store[refreshTokenKey(providerRaw)];
	const refreshToken = refreshRaw ? cipher.decrypt(refreshRaw) : undefined;
	const user = labelFromUserInfo(store[userInfoKey(providerRaw)] ? cipher.decrypt(store[userInfoKey(providerRaw)]) : null);
	if (!zcodeJwtToken || !accessToken) {
		return undefined;
	}
	return {
		provider: providerRaw,
		zcodeJwtToken,
		accessToken,
		...(refreshToken ? { refreshToken } : {}),
		accountId: user?.id ?? 'zcode-user',
		accountLabel: user?.label ?? `${providerRaw} account`,
	};
}

export async function saveZCodeDesktopSession(session: ZCodeStoredSession): Promise<void> {
	const cipher = createZCodeCipher();
	const store = await readRawStore();
	store[ACTIVE_PROVIDER_KEY] = cipher.encrypt(session.provider);
	store[ZCODE_JWT_KEY] = cipher.encrypt(session.zcodeJwtToken);
	store[accessTokenKey(session.provider)] = cipher.encrypt(session.accessToken);
	if (session.refreshToken) {
		store[refreshTokenKey(session.provider)] = cipher.encrypt(session.refreshToken);
	}
	store[userInfoKey(session.provider)] = cipher.encrypt(JSON.stringify({
		id: session.accountId,
		username: session.accountLabel,
		displayName: session.accountLabel,
		rawProfile: {
			user_id: session.accountId,
			name: session.accountLabel,
			zcodeProfileSchemaVersion: 2,
		},
	}));
	// Keep only one active provider's oauth mirror, matching ZCode desktop behavior.
	const other: ZCodeOAuthProvider = session.provider === 'zai' ? 'bigmodel' : 'zai';
	delete store[accessTokenKey(other)];
	delete store[refreshTokenKey(other)];
	delete store[userInfoKey(other)];
	await writeRawStore(store);
}

export async function clearZCodeDesktopSession(): Promise<void> {
	const store = await readRawStore();
	delete store[ACTIVE_PROVIDER_KEY];
	delete store[ZCODE_JWT_KEY];
	for (const provider of ['zai', 'bigmodel'] as const) {
		delete store[accessTokenKey(provider)];
		delete store[refreshTokenKey(provider)];
		delete store[userInfoKey(provider)];
	}
	await writeRawStore(store);
}

/**
 * Coding Plan API keys live beside OAuth tokens in the shared store, e.g.
 * `account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:<id>:api-key`.
 * BigModel chat/completions needs this key — the OAuth access_token alone is not enough.
 */
export async function loadCodingPlanApiKey(
	family: ZCodeOAuthProvider = 'bigmodel',
): Promise<string | undefined> {
	const cipher = createZCodeCipher();
	const store = await readRawStore();
	const needle = `account-provider:coding-plan:account:${family}-individual-coding-plan:`;
	const teamNeedle = `account-provider:coding-plan:account:${family}-team-coding-plan:`;
	const keys = Object.keys(store).filter(
		key => (key.includes(needle) || key.includes(teamNeedle)) && key.endsWith(':api-key'),
	);
	// Prefer individual over team when both exist.
	keys.sort((a, b) => Number(a.includes('-team-')) - Number(b.includes('-team-')));
	for (const key of keys) {
		try {
			const value = cipher.decrypt(store[key]!).trim();
			if (value) {
				return value;
			}
		} catch {
			// try next
		}
	}
	return undefined;
}

export function getZCodeCredentialsPath(): string {
	return credentialsPath();
}
