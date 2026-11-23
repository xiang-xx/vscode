/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { homedir, platform, userInfo } from 'os';
import { dirname, join, resolve } from 'path';

const ENCRYPTED_VALUE_PREFIX = 'enc:v1:';
/** Current desktop format: `enc:v2:<source>:<fingerprint>:<iv>.<tag>.<ciphertext>`. */
const SYSTEM_ENCRYPTED_PREFIX = 'enc:v2:';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const SECRET_ENV_KEY = 'ZCODE_CREDENTIAL_SECRET';
const SECRET_FILE_ENV_KEY = 'ZCODE_CREDENTIAL_SECRET_FILE';
const MANAGED_SECRET_FILE = 'credential-secret';
/** macOS Keychain / Secret Service entry the desktop stores its data key under. */
const KEYRING_SERVICE = 'ZCode Credential Encryption';
const KEY_FINGERPRINT_HEX_LENGTH = 24;

export interface ZCodeCipher {
	encrypt(value: string): string;
	decrypt(value: string): string;
}

/** Where the shared credential store lives (same lookup the ZCode CLI/desktop uses). */
export function resolveZCodeCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.ZCODE_CONFIG_DIR?.trim();
	if (override) {
		return join(override, 'credentials.json');
	}
	return join(homedir(), '.zcode', 'v2', 'credentials.json');
}

/**
 * Mirrors ZCode's credentialCipherProvider so this shell can read/write
 * `~/.zcode/v2/credentials.json` with the same key material.
 *
 * Two generations exist in the wild:
 * - `enc:v1:…` — AES-GCM under a machine-local key derived from the user/OS
 *   fallback string, or from `ZCODE_CREDENTIAL_SECRET` when configured.
 *   Still written here for backwards compatibility; the desktop migrates these
 *   to v2 on its next read.
 * - `enc:v2:<source>:<fingerprint>:…` — current format. `<source>` is `os`
 *   (key parked in the OS keychain) or `env` (key derived from a managed
 *   secret). The fingerprint is the first 24 hex chars of `sha256(key)`, which
 *   lets us verify a candidate key without touching the ciphertext.
 *
 * Reading v2 wrong is what makes a logged-in store look like an expired token:
 * the old code passed the raw `enc:v2:…` string through as the "token".
 */
export function createZCodeCipher(
	env: NodeJS.ProcessEnv = process.env,
	storePath: string = resolveZCodeCredentialsPath(env),
): ZCodeCipher {
	const legacyKey = createHash('sha256').update(defaultSecret(env)).digest();

	return {
		encrypt(value: string): string {
			const iv = randomBytes(IV_BYTES);
			const cipher = createCipheriv(ALGORITHM, legacyKey, iv);
			const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
			const authTag = cipher.getAuthTag();
			return [
				ENCRYPTED_VALUE_PREFIX,
				iv.toString('base64url'),
				'.',
				authTag.toString('base64url'),
				'.',
				encrypted.toString('base64url'),
			].join('');
		},
		decrypt(value: string): string {
			if (value.startsWith(SYSTEM_ENCRYPTED_PREFIX)) {
				const key = systemKeyFor(value, storePath, env);
				return openSealed(value.slice(SYSTEM_ENCRYPTED_PREFIX.length).split(':')[2] ?? '', key);
			}
			if (value.startsWith(ENCRYPTED_VALUE_PREFIX)) {
				return openSealed(value.slice(ENCRYPTED_VALUE_PREFIX.length), legacyKey);
			}
			if (value.startsWith('enc:')) {
				// Never hand back ciphertext as if it were a credential.
				throw new Error(`Unsupported ZCode credential ciphertext (${value.slice(0, 8)}…)`);
			}
			return value;
		},
	};
}

function openSealed(payload: string, key: Buffer): string {
	const parts = payload.split('.');
	const [ivRaw, authTagRaw, cipherRaw] = parts;
	if (!ivRaw || !authTagRaw || cipherRaw === undefined || parts.length !== 3) {
		throw new Error('ZCode credential ciphertext is malformed');
	}
	const iv = Buffer.from(ivRaw, 'base64url');
	const authTag = Buffer.from(authTagRaw, 'base64url');
	const cipherText = Buffer.from(cipherRaw, 'base64url');
	if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
		throw new Error('ZCode credential ciphertext has invalid IV/tag length');
	}
	const decipher = createDecipheriv(ALGORITHM, key, iv);
	decipher.setAuthTag(authTag);
	return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8');
}

const keyCache = new Map<string, Buffer>();

/** Cache key includes the store path: the keyring account is derived from it. */
function systemKeyFor(value: string, storePath: string, env: NodeJS.ProcessEnv): Buffer {
	const [source, fingerprint] = value.slice(SYSTEM_ENCRYPTED_PREFIX.length).split(':');
	if (!source || !fingerprint) {
		throw new Error('ZCode credential ciphertext is malformed');
	}
	if (source !== 'os' && source !== 'env') {
		throw new Error(`Unsupported ZCode credential key source "${source}"`);
	}
	if (!/^[a-f0-9]{24}$/.test(fingerprint)) {
		throw new Error('ZCode credential key fingerprint is malformed');
	}
	const cacheKey = `${source}:${fingerprint}:${resolve(storePath)}`;
	const cached = keyCache.get(cacheKey);
	if (cached) {
		return cached;
	}
	const key = source === 'env'
		? keyFromManagedSecret(storePath, env)
		: keyFromKeychain(storePath);
	if (sha256HexOf(key).slice(0, KEY_FINGERPRINT_HEX_LENGTH) !== fingerprint) {
		throw new Error('ZCode credential key does not match the store (was the account re-encrypted?)');
	}
	keyCache.set(cacheKey, key);
	return key;
}

function keyFromManagedSecret(storePath: string, env: NodeJS.ProcessEnv): Buffer {
	const fromEnv = env[SECRET_ENV_KEY];
	if (fromEnv) {
		return createHash('sha256').update(fromEnv).digest();
	}
	const file = env[SECRET_FILE_ENV_KEY]?.trim() || join(dirname(resolve(storePath)), MANAGED_SECRET_FILE);
	let raw: string;
	try {
		raw = readFileSync(file, 'utf8');
	} catch (error) {
		throw new Error(
			`ZCode credentials are sealed with a managed secret (${file}) that cannot be read: ${(error as Error).message}`,
		);
	}
	if (raw.length < 32 || raw.length > 4096) {
		throw new Error(`ZCode credential secret at ${file} is not 32–4096 bytes`);
	}
	return createHash('sha256').update(raw).digest();
}

function keyFromKeychain(storePath: string): Buffer {
	const account = createHash('sha256').update(resolve(storePath)).digest('hex');
	const password = readKeyringPassword(account);
	if (!password) {
		throw new Error(
			`Cannot read the ZCode credential key from the system keychain (service "${KEYRING_SERVICE}"). `
			+ 'Unlock the login keychain, or run "ZCode: Sign in" to rebuild the store.',
		);
	}
	const key = Buffer.from(password, 'base64url');
	if (key.length !== KEY_BYTES) {
		throw new Error('ZCode credential key in the system keychain has an unexpected length');
	}
	return key;
}

function readKeyringPassword(account: string): string | undefined {
	if (platform() === 'darwin') {
		try {
			const out = execFileSync(
				'security',
				['find-generic-password', '-s', KEYRING_SERVICE, '-a', account, '-w'],
				{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
			);
			return out.trim() || undefined;
		} catch {
			return undefined;
		}
	}
	try {
		// Optional native binding; only present when the OS store is used off macOS.
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const keyring = require('@napi-rs/keyring') as {
			Entry?: new (service: string, account: string) => { getPassword(): string | null };
		};
		const entry = keyring.Entry ? new keyring.Entry(KEYRING_SERVICE, account) : undefined;
		return entry?.getPassword()?.trim() || undefined;
	} catch {
		return undefined;
	}
}

function sha256HexOf(value: Buffer): string {
	return createHash('sha256').update(value).digest('hex');
}

function defaultSecret(env: NodeJS.ProcessEnv): string {
	const configured = env[SECRET_ENV_KEY];
	if (configured) {
		return configured;
	}
	let username = 'unknown';
	try {
		username = userInfo().username;
	} catch {
		// ignore
	}
	return `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
}
