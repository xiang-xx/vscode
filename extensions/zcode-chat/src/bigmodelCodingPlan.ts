/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createZCodeCipher } from './zcodeCipher';

/**
 * BigModel Coding Plan auth the way ZCode desktop actually performs it.
 *
 * When the desktop is connected through OAuth (the common case — no API key
 * pasted by hand), `~/.zcode/v2/credentials.json` never contains a long-lived
 * `account-provider:coding-plan:…:api-key` entry. Instead the desktop keeps
 * a `project-key-location:v1:…` pointer to the account service's per-project
 * API key and exchanges the OAuth access token for a short-lived project
 * token (`token_use: project_access`) right before each coding-endpoint call.
 *
 * This module mirrors that exchange so chat works on machines where only the
 * OAuth session exists. Callers should still prefer a standalone API key
 * (`loadCodingPlanApiKey`) when the user configured one.
 */

const BIGMODEL_ORIGIN = 'https://bigmodel.cn';
const CLIENT_TYPE = 'zcode';
// Matches what the local ZCode desktop sends; the account service logs it.
const CLIENT_VERSION = '3.17.2';
const CODING_PLAN_USAGE_SCENE = 1;
const PERSONAL_KEY_NAME = 'zcode-api-key';
const DEFAULT_ORG_HINT = '默认机构';
const DEFAULT_PROJECT_HINT = '默认项目';
/** Refresh a cached project token this long before its `exp`. */
const TOKEN_MIN_TTL_MS = 120_000;
/** Exchange/request timeout. Auth resolution must not hang a chat send. */
const AUTH_TIMEOUT_MS = 15_000;

interface ProjectKeyLocation {
	organizationId: string;
	projectId: string;
	apiKeyId: string;
}

interface CachedToken {
	token: string;
	expiresAtMs: number;
}

interface CustomerInfoOrganization {
	organizationId?: string;
	organizationName?: string;
	projects?: Array<{ projectId?: string; projectName?: string; projectType?: string }>;
}

type TokenExchange =
	| { kind: 'ok'; token: string; expiresAtMs: number }
	| { kind: 'revoked' }
	| { kind: 'failed' };

let cached: CachedToken | undefined;

/**
 * Resolve a credential for `https://open.bigmodel.cn/api/coding/paas/v4`:
 * the standalone API key's location pointer → OAuth project-token exchange.
 * Returns undefined whenever any step is missing or fails; callers decide
 * which error to surface.
 */
export async function resolveBigModelCodingApiKey(): Promise<string | undefined> {
	if (cached && cached.expiresAtMs - TOKEN_MIN_TTL_MS > Date.now()) {
		return cached.token;
	}
	const store = await readRawCredentialStore();
	const oauth = decryptStoreValue(store, 'oauth:bigmodel:access_token');
	if (!oauth) {
		return undefined;
	}
	let found = findProjectKeyLocation(store);
	// One retry after a revoked pointer: re-resolve it like the desktop does.
	for (let attempt = 0; attempt < 2; attempt++) {
		if (!found) {
			const ensured = await ensureProjectKeyLocation(oauth, store);
			if (!ensured) {
				return undefined;
			}
			found = { key: ensured.key, location: ensured.location };
		}
		const exchange = await exchangeProjectToken(oauth, found.location);
		if (exchange.kind === 'ok') {
			cached = { token: exchange.token, expiresAtMs: exchange.expiresAtMs };
			return exchange.token;
		}
		if (exchange.kind === 'failed') {
			// Transient or unexpected: keep the pointer, fail this send.
			return undefined;
		}
		// Revoked server-side: drop the stale pointer and re-resolve once.
		delete store[found.key];
		cached = undefined;
		found = undefined;
	}
	return undefined;
}

/** Sign-out / account switch must not serve the previous account's token. */
export function resetBigModelCodingPlanCache(): void {
	cached = undefined;
}

async function exchangeProjectToken(oauth: string, location: ProjectKeyLocation): Promise<TokenExchange> {
	const url = `${BIGMODEL_ORIGIN}/api/biz/v1/organization/${encodeURIComponent(location.organizationId)}`
		+ `/projects/${encodeURIComponent(location.projectId)}`
		+ `/api_keys/${encodeURIComponent(location.apiKeyId)}/access_tokens`;
	const response = await requestJson(url, 'POST', { Authorization: `Bearer ${oauth}` }, {
		clientType: CLIENT_TYPE,
		clientVersion: CLIENT_VERSION,
	});
	if (response?.status === 404) {
		return { kind: 'revoked' };
	}
	if (!response || response.parsed?.code !== 200) {
		return { kind: 'failed' };
	}
	const data = response.parsed.data as { enabled?: boolean; accessToken?: string; expiresAt?: number } | undefined;
	if (!data || data.enabled === false || typeof data.accessToken !== 'string' || !data.accessToken) {
		return { kind: 'failed' };
	}
	const expiresAtMs = resolveTokenExpiry(data.accessToken, data.expiresAt);
	if (expiresAtMs <= Date.now()) {
		return { kind: 'failed' };
	}
	return { kind: 'ok', token: data.accessToken, expiresAtMs };
}

/**
 * The desktop resolves (creating on first use) the personal coding-plan key
 * `zcode-api-key` under the account's default organization/project, then
 * remembers it as a `project-key-location` pointer. Mirror that so a fresh
 * install works without ever opening the desktop's key management UI.
 */
async function ensureProjectKeyLocation(
	oauth: string,
	store: Record<string, string>,
): Promise<{ key: string; location: ProjectKeyLocation } | undefined> {
	const info = await requestJson(`${BIGMODEL_ORIGIN}/api/biz/customer/getCustomerInfo`, 'GET', { Authorization: `Bearer ${oauth}` });
	const organizations = (info?.parsed?.data as { organizations?: CustomerInfoOrganization[] } | undefined)?.organizations;
	if (!Array.isArray(organizations)) {
		return undefined;
	}
	const usable = organizations
		.map(org => ({
			org,
			projects: (org.projects ?? []).filter(p => String(p.projectType ?? '').trim() !== '2'),
		}))
		.filter(entry => entry.org.organizationId && entry.projects.length);
	const pickedOrg = usable.find(entry => entry.org.organizationName?.includes(DEFAULT_ORG_HINT)) ?? usable[0];
	const pickedProject = pickedOrg
		? (pickedOrg.projects.find(p => p.projectName?.includes(DEFAULT_PROJECT_HINT)) ?? pickedOrg.projects[0])
		: undefined;
	const organizationId = pickedOrg?.org.organizationId;
	const projectId = pickedProject?.projectId;
	if (!organizationId || !projectId) {
		return undefined;
	}
	const accountId = resolveAccountId(store, oauth);
	if (!accountId) {
		return undefined;
	}
	const keysUrl = `${BIGMODEL_ORIGIN}/api/biz/v1/organization/${encodeURIComponent(organizationId)}`
		+ `/projects/${encodeURIComponent(projectId)}/api_keys`;
	// Personal bigmodel requests send the raw OAuth token (no Bearer prefix),
	// matching the desktop.
	const headers = { Authorization: oauth };
	const listResponse = await requestJson(keysUrl, 'GET', headers);
	const existing = (listResponse?.parsed?.data as Array<{ name?: string; apiKey?: string }> | undefined)
		?.find(key => key?.name === PERSONAL_KEY_NAME && key.apiKey);
	let apiKeyId = existing?.apiKey;
	if (!apiKeyId) {
		const created = await requestJson(keysUrl, 'POST', headers, {
			name: PERSONAL_KEY_NAME,
			usageScene: CODING_PLAN_USAGE_SCENE,
		});
		apiKeyId = (created?.parsed?.data as { apiKey?: string } | undefined)?.apiKey;
		if (!apiKeyId) {
			// A concurrent client (e.g. the desktop) may already have created
			// it; the list is truth when the POST didn't hand us the key.
			const relisted = await requestJson(keysUrl, 'GET', headers);
			apiKeyId = (relisted?.parsed?.data as Array<{ name?: string; apiKey?: string }> | undefined)
				?.find(key => key?.name === PERSONAL_KEY_NAME && key.apiKey)?.apiKey;
		}
	}
	if (!apiKeyId) {
		return undefined;
	}
	const location: ProjectKeyLocation = { organizationId, projectId, apiKeyId };
	const key = projectKeyLocationKeyName(accountId);
	try {
		const cipher = createZCodeCipher();
		const next = { ...store };
		// ZCode desktop rewrites the whole store; keep every other entry.
		next[key] = cipher.encrypt(JSON.stringify(location));
		const file = credentialsPath();
		await fs.mkdir(join(file, '..'), { recursive: true });
		await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
		store[key] = next[key];
	} catch {
		// Persisting is an optimization; the in-memory location still works.
	}
	return { key, location };
}

/**
 * Locate the desktop's pointer to the coding-plan API key. The entry name
 * encodes `[origin, family, accountId, team, usageScene, projectSelection]`;
 * only family `bigmodel` and the personal (non-team) scene are handled.
 */
function findProjectKeyLocation(store: Record<string, string>): { key: string; location: ProjectKeyLocation } | undefined {
	for (const key of Object.keys(store)) {
		if (!key.startsWith('project-key-location:v1:')) {
			continue;
		}
		try {
			const [origin, family, , team, usageScene] = JSON.parse(decodeURIComponent(key.slice('project-key-location:v1:'.length))) as [string, string, string, unknown, number, string];
			if (origin !== BIGMODEL_ORIGIN || family !== 'bigmodel' || team !== null || usageScene !== CODING_PLAN_USAGE_SCENE) {
				continue;
			}
		} catch {
			continue;
		}
		try {
			const parsed = JSON.parse(decryptStoreValue(store, key)!) as Partial<ProjectKeyLocation>;
			if (parsed.organizationId && parsed.projectId && parsed.apiKeyId) {
				return {
					key,
					location: {
						organizationId: parsed.organizationId,
						projectId: parsed.projectId,
						apiKeyId: parsed.apiKeyId,
					},
				};
			}
		} catch {
			// Unreadable pointer: ignore and re-resolve via ensure.
		}
	}
	return undefined;
}

/** Key name matching the desktop's personal bigmodel coding-plan pointer. */
function projectKeyLocationKeyName(accountId: string): string {
	return `project-key-location:v1:${encodeURIComponent(JSON.stringify([
		BIGMODEL_ORIGIN,
		'bigmodel',
		accountId,
		null,
		CODING_PLAN_USAGE_SCENE,
		'non-team',
	]))}`;
}

function resolveAccountId(store: Record<string, string>, oauth: string): string | undefined {
	const fromUserInfo = decryptStoreValue(store, 'oauth:bigmodel:user_info');
	if (fromUserInfo) {
		try {
			const parsed = JSON.parse(fromUserInfo) as { id?: string; rawProfile?: { user_id?: string } };
			const id = parsed.id || parsed.rawProfile?.user_id;
			if (id) {
				return id;
			}
		} catch {
			// Fall through to the JWT subject.
		}
	}
	const payload = oauth.split('.')[1];
	if (payload) {
		try {
			const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string };
			if (decoded.sub) {
				return decoded.sub;
			}
		} catch {
			// Not a JWT.
		}
	}
	return undefined;
}

async function readRawCredentialStore(): Promise<Record<string, string>> {
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

function credentialsPath(): string {
	const override = process.env.ZCODE_CONFIG_DIR?.trim();
	if (override) {
		return join(override, 'credentials.json');
	}
	return join(homedir(), '.zcode', 'v2', 'credentials.json');
}

function decryptStoreValue(store: Record<string, string>, key: string): string | undefined {
	const value = store[key];
	if (!value) {
		return undefined;
	}
	try {
		const decrypted = createZCodeCipher().decrypt(value).trim();
		return decrypted || undefined;
	} catch {
		return undefined;
	}
}

interface JsonResponse {
	status: number;
	parsed?: { code?: number; data?: unknown };
}

async function requestJson(
	url: string,
	method: 'GET' | 'POST',
	headers: Record<string, string>,
	body?: unknown,
): Promise<JsonResponse | undefined> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
		try {
			const response = await fetch(url, {
				method,
				headers: { 'Content-Type': 'application/json', ...headers },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: controller.signal,
			});
			if (!response.ok && response.status !== 404) {
				return undefined;
			}
			if (response.status === 404) {
				return { status: 404 };
			}
			return { status: response.status, parsed: await response.json() as { code?: number; data?: unknown } };
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return undefined;
	}
}

/** Prefer the JWT's own `exp`; fall back to the response's `expiresAt`. */
function resolveTokenExpiry(token: string, expiresAt?: number): number {
	const payload = token.split('.')[1];
	if (payload) {
		try {
			const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
			if (typeof decoded.exp === 'number' && decoded.exp > 0) {
				return decoded.exp * 1000;
			}
		} catch {
			// Not a JWT: use expiresAt below.
		}
	}
	if (typeof expiresAt === 'number' && expiresAt > 0) {
		// Tolerate second-precision timestamps.
		return expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
	}
	return Date.now();
}
