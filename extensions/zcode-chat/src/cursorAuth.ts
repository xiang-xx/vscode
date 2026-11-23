/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import { getCursorAgentPath } from './brains';
import { assertExecutableFile } from './processUtils';

export interface CursorAuthStatus {
	loggedIn: boolean;
	email?: string;
	agentPath: string;
	agentExists: boolean;
	raw: string;
}

export async function resolveAgentBinary(): Promise<{ path: string; exists: boolean }> {
	const agentPath = getCursorAgentPath();
	try {
		const st = await fs.stat(agentPath);
		if (st.isDirectory()) {
			return { path: agentPath, exists: false };
		}
		await assertExecutableFile(agentPath);
		return { path: agentPath, exists: true };
	} catch {
		// Fall back to PATH lookup via `which`/`where` is overkill; try bare `agent`.
		return { path: 'agent', exists: false };
	}
}

function runAgent(args: string[], timeoutMs = 15_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise(async (resolve) => {
		const { path: bin, exists } = await resolveAgentBinary();
		if (!exists && bin !== 'agent') {
			resolve({ code: 1, stdout: '', stderr: `Cursor agent path is missing or a directory: ${bin}` });
			return;
		}
		const child = spawn(bin, args, {
			env: { ...process.env },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => {
			child.kill('SIGTERM');
		}, timeoutMs);
		child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
		child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
		child.on('error', (err) => {
			clearTimeout(timer);
			const msg = err instanceof Error ? err.message : String(err);
			resolve({
				code: 1,
				stdout,
				stderr: stderr || (/ENOTDIR/i.test(msg)
					? `${msg} (agent path must be a file, not a directory)`
					: msg),
			});
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

export async function getCursorAuthStatus(): Promise<CursorAuthStatus> {
	const { path: agentPath, exists } = await resolveAgentBinary();
	if (process.env.CURSOR_API_KEY || process.env.CURSOR_AUTH_TOKEN) {
		return {
			loggedIn: true,
			email: 'API key',
			agentPath,
			agentExists: exists,
			raw: 'Authenticated via CURSOR_API_KEY / CURSOR_AUTH_TOKEN',
		};
	}

	const result = await runAgent(['status']);
	const combined = `${result.stdout}\n${result.stderr}`;
	const emailMatch = combined.match(/logged in as\s+(\S+)/i);
	const loggedIn = Boolean(emailMatch) && !/not logged in/i.test(combined);
	return {
		loggedIn,
		email: emailMatch?.[1],
		agentPath,
		agentExists: exists || result.code === 0 || combined.length > 0,
		raw: combined.trim(),
	};
}

/**
 * `agent --list-models` hits api2.cursor.sh over the network, so proxies
 * intermittently kill the TLS handshake (`[aborted] Client network socket
 * disconnected...`, exit 1). Retry a few times before surfacing the failure,
 * and never mine model ids out of the error text (the old parser happily
 * turned "Failed to load models: ..." into a bogus model named "Failed").
 */
const LIST_MODELS_ATTEMPTS = 3;

export async function listCursorModels(): Promise<string[]> {
	let lastText = '';
	for (let attempt = 1; attempt <= LIST_MODELS_ATTEMPTS; attempt++) {
		const result = await runAgent(['--list-models'], 20_000);
		const text = `${result.stdout}\n${result.stderr}`;
		if (/authentication required|not logged in/i.test(text)) {
			return [];
		}
		if (result.code === 0) {
			return parseModelLines(text);
		}
		lastText = text;
		if (attempt < LIST_MODELS_ATTEMPTS) {
			await new Promise(resolve => setTimeout(resolve, attempt * 1000));
		}
	}
	const firstLine = lastText.split(/\r?\n/).map(l => l.trim()).find(l => l) || '';
	const reason = firstLine || (lastText ? 'empty output' : 'no output from agent CLI');
	throw new Error(`agent --list-models failed: ${reason.slice(0, 300)}`);
}

function parseModelLines(text: string): string[] {
	const models: string[] = [];
	for (const raw of text.split(/\r?\n/)) {
		// Cursor embeds zero-width/bidi noise in its output; strip before parsing.
		const line = raw.replace(/[\u200B-\u200D\uFEFF\u2060\u202A-\u202E]/g, '').trim();
		if (!line || /^error/i.test(line) || /^usage:/i.test(line)) {
			continue;
		}
		// Header/footer prose lines that are not model rows.
		if (/^available models$/i.test(line) || /^tip\b/i.test(line)) {
			continue;
		}
		// Model rows are "model-id - Label" (or a bare id with no spaces).
		const id = line.split(/\s+/)[0];
		if (!id || id.length <= 1 || !/^[a-zA-Z0-9][\w.\[\]=,-]*$/.test(id)) {
			continue;
		}
		const rest = line.slice(id.length).trim();
		if (rest && !rest.startsWith('-')) {
			continue;
		}
		models.push(id);
	}
	return [...new Set(models)];
}

export async function promptCursorLogin(): Promise<void> {
	const choice = await vscode.window.showInformationMessage(
		'Cursor Agent CLI is not logged in. Run `agent login` in a terminal (or set CURSOR_API_KEY).',
		'Copy login command',
		'Open terminal',
	);
	if (choice === 'Copy login command') {
		await vscode.env.clipboard.writeText('agent login');
		void vscode.window.showInformationMessage('Copied: agent login');
	} else if (choice === 'Open terminal') {
		const term = vscode.window.createTerminal('Cursor Agent Login');
		term.show();
		term.sendText('agent login');
	}
}
