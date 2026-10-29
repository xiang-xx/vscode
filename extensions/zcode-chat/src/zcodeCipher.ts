/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { homedir, platform, userInfo } from 'os';

const ENCRYPTED_VALUE_PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const SECRET_ENV_KEY = 'ZCODE_CREDENTIAL_SECRET';

/**
 * Mirrors ZCode's credentialCipherProvider so this shell can read/write
 * `~/.zcode/v2/credentials.json` with the same machine-local key material.
 */
export function createZCodeCipher(env: NodeJS.ProcessEnv = process.env): {
	encrypt(value: string): string;
	decrypt(value: string): string;
} {
	const key = createHash('sha256').update(defaultSecret(env)).digest();

	return {
		encrypt(value: string): string {
			const iv = randomBytes(IV_BYTES);
			const cipher = createCipheriv(ALGORITHM, key, iv);
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
			if (!value.startsWith(ENCRYPTED_VALUE_PREFIX)) {
				return value;
			}
			const parts = value.slice(ENCRYPTED_VALUE_PREFIX.length).split('.');
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
		},
	};
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
