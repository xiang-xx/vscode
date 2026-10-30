/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * ZCode ships a signed Windows elevation helper for Chrome App-Bound cookies.
 * This fork does not bundle that helper — App-Bound cookies are reported as unsupported.
 */

export type WindowsChromeAppBoundImportErrorCode =
	| 'chrome_cookie_elevation_cancelled'
	| 'chrome_cookie_helper_verification_failed'
	| 'chrome_cookie_app_bound_decryption_failed'
	| 'chrome_cookie_protection_unsupported';

export class WindowsChromeAppBoundImportError extends Error {
	constructor(readonly code: WindowsChromeAppBoundImportErrorCode) {
		super(code);
		this.name = 'WindowsChromeAppBoundImportError';
	}
}

export type WindowsChromeAppBoundKeyReader = (options: {
	allowElevatedChromeDecryption?: boolean;
	chromeExecutablePath?: string;
	encryptedValue?: Uint8Array;
	logger?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
	userDataDir?: string;
}) => Promise<Buffer>;

export async function readWindowsChromeAppBoundKey(_options: {
	allowElevatedChromeDecryption?: boolean;
	chromeExecutablePath?: string;
	encryptedValue?: Uint8Array;
	logger?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
	userDataDir?: string;
}): Promise<Buffer> {
	throw new WindowsChromeAppBoundImportError('chrome_cookie_protection_unsupported');
}
