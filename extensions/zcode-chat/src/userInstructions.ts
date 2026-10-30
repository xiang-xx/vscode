/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Same cap as ZCode personalization and the CLI reader. Overflow is dropped. */
export const USER_INSTRUCTIONS_MAX_BYTES = 100 * 1024;

export interface InstructionSource {
	scope: 'user' | 'workspace';
	filePath: string;
	content: string;
	truncated: boolean;
}

export function zcodeHomeDir(): string {
	const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
	return envHome || os.homedir();
}

export function personalInstructionsPath(): string {
	return path.join(zcodeHomeDir(), '.zcode', 'AGENTS.md');
}

export function projectInstructionsPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, 'AGENTS.md');
}

export function loadInstructionSources(workspaceRoot?: string): InstructionSource[] {
	const sources: InstructionSource[] = [];
	const personal = readCapped(personalInstructionsPath(), 'user');
	if (personal) {
		sources.push(personal);
	}
	if (workspaceRoot) {
		const project = readCapped(projectInstructionsPath(workspaceRoot), 'workspace');
		if (project) {
			sources.push(project);
		}
	}
	return sources;
}

/**
 * Personal `~/.zcode/AGENTS.md` plus this workspace's `AGENTS.md`.
 * Paths are always named so the agent can edit them even when the files are empty.
 */
export function formatInstructionBlock(workspaceRoot?: string): string {
	const sources = loadInstructionSources(workspaceRoot);
	const lines: string[] = [];
	if (sources.length) {
		lines.push(
			'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.',
			'',
		);
		for (const source of sources) {
			const scope = source.scope === 'user'
				? "user's private global instructions for all projects"
				: 'project instructions, checked into the codebase';
			const body = source.truncated
				? `${source.content}\n\n[File truncated: AGENTS.md]`
				: source.content;
			lines.push(`Contents of ${source.filePath} (${scope}):`, '', body.trim(), '');
		}
	}
	lines.push(`Personal instructions file (applies to every project): ${personalInstructionsPath()}`);
	if (workspaceRoot) {
		lines.push(`Project instructions file (this workspace): ${projectInstructionsPath(workspaceRoot)}`);
	}
	lines.push('When the user asks to change personal or project instructions, edit those files.');
	return lines.join('\n');
}

function readCapped(filePath: string, scope: InstructionSource['scope']): InstructionSource | undefined {
	let buf: Buffer;
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile() || stat.size === 0) {
			return undefined;
		}
		const fd = fs.openSync(filePath, 'r');
		try {
			const length = Math.min(stat.size, USER_INSTRUCTIONS_MAX_BYTES);
			buf = Buffer.alloc(length);
			fs.readSync(fd, buf, 0, length, 0);
		} finally {
			fs.closeSync(fd);
		}
		const truncated = stat.size > USER_INSTRUCTIONS_MAX_BYTES;
		let content = buf.toString('utf8');
		if (truncated) {
			content = content.replace(/\uFFFD+$/, '');
		}
		content = content.trim();
		if (!content) {
			return undefined;
		}
		return { scope, filePath, content, truncated };
	} catch {
		return undefined;
	}
}
