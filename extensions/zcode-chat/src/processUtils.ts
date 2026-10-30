/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared child_process helpers for ZCode harness + Cursor ACP.
 * spawn() requires cwd to be a real directory — models often pass a file path.
 */

import { spawn, type SpawnOptionsWithoutStdio } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';

export async function resolveDirForSpawn(candidate: string, fallback: string): Promise<string> {
	for (const p of [candidate, fallback]) {
		if (!p) {
			continue;
		}
		try {
			const st = await fs.stat(p);
			if (st.isDirectory()) {
				return p;
			}
			if (st.isFile()) {
				return path.dirname(p);
			}
		} catch {
			// try next
		}
	}
	return fallback;
}

export async function assertDirectory(cwd: string, label = 'cwd'): Promise<string> {
	try {
		const st = await fs.stat(cwd);
		if (st.isDirectory()) {
			return cwd;
		}
		if (st.isFile()) {
			return path.dirname(cwd);
		}
	} catch {
		// fall through
	}
	throw new Error(`${label} is not a usable directory: ${cwd}`);
}

export async function assertExecutableFile(bin: string): Promise<string> {
	try {
		const st = await fs.stat(bin);
		if (st.isDirectory()) {
			throw new Error(`Executable path is a directory (ENOTDIR): ${bin}`);
		}
		if (!st.isFile() && !st.isSymbolicLink()) {
			// On some platforms CLI wrappers are sockets/etc.; still try.
			return bin;
		}
		return bin;
	} catch (err) {
		if (err instanceof Error && /ENOTDIR|directory/i.test(err.message)) {
			throw err;
		}
		throw new Error(`Executable not found: ${bin}`);
	}
}

export function truncatePreview(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars)}\n… truncated (${text.length} chars total)`;
}

export function ellipsize(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function spawnCapture(
	command: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
	options?: Pick<SpawnOptionsWithoutStdio, 'env' | 'shell'>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise(resolve => {
		let settled = false;
		const child = spawn(command, args, {
			cwd,
			env: options?.env ?? process.env,
			shell: options?.shell ?? false,
		});
		let stdout = '';
		let stderr = '';
		const finish = (code: number | null, errText?: string) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve({ code, stdout, stderr: errText !== undefined ? (stderr || errText) : stderr });
		};
		const timer = setTimeout(() => {
			child.kill('SIGTERM');
			finish(null, stderr || 'timed out');
		}, timeoutMs);
		child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
		child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
		child.on('error', (err) => {
			const msg = err instanceof Error ? err.message : String(err);
			finish(null, msg);
		});
		child.on('close', (code) => finish(code));
	});
}

export async function runShellCommand(options: {
	command: string;
	cwd: string;
	timeoutMs: number;
	env?: NodeJS.ProcessEnv;
}): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
	const cwd = await assertDirectory(options.cwd, 'shell cwd');
	return new Promise(resolve => {
		let settled = false;
		const child = spawn(options.command, [], {
			cwd,
			env: options.env ?? process.env,
			shell: true,
		});
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		const finish = (code: number | null) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve({ code, stdout, stderr, timedOut });
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGTERM');
			finish(null);
		}, options.timeoutMs);
		child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
		child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
		child.on('error', (err) => {
			const msg = err instanceof Error ? err.message : String(err);
			stderr = stderr || (/ENOTDIR/i.test(msg)
				? `${msg} (cwd must be a directory; got ${cwd})`
				: msg);
			finish(null);
		});
		child.on('close', (code) => finish(code));
	});
}
