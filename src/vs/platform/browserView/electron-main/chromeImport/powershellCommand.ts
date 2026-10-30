/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/** Minimal PowerShell EncodedCommand helper (from ZCode desktop scripts). */

export function createEncodedPowerShellArgs(script: string, args: string[] = []): string[] {
	const preamble = args
		.map((value, index) => `$zcodeArg${index}=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, 'utf8').toString('base64')}'));`)
		.join('');
	const encoded = Buffer.from(`${preamble}${script}`, 'utf16le').toString('base64');
	return ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
}

export function createWindowsPowerShellSecurityArgs(): string[] {
	return ['-ExecutionPolicy', 'Bypass'];
}
