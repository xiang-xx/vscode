/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Persistent terminal tools (terminal_open/send/read/list/kill) ported from dsh.
 * Each named shell is a real child shell process that keeps cwd/env/venv state
 * across commands, surfaced as a VS Code pseudoterminal the user can watch.
 * Pipes (not a TTY), so full-screen TUI apps are unsupported.
 */

import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import type { ToolExecResult } from './browserTools';
import { assertDirectory } from './processUtils';

const MAX_BUFFER = 200_000;
const MAX_DRAIN = 30_000;
const MARKER = /__ZC_DONE_([a-z0-9]+):(-?\d+)__/;

class AgentShell {
	readonly name: string;
	readonly createdCwd: string;
	readonly createdAt = Date.now();
	private child: ChildProcess | null = null;
	private terminal: vscode.Terminal | null = null;
	private readonly writeEmitter = new vscode.EventEmitter<string>();
	private buffer = '';
	private drainMark = 0;
	private readonly waiters = new Map<string, (code: number) => void>();
	exitCode: number | null = null;

	constructor(name: string, cwd: string) {
		this.name = name;
		this.createdCwd = cwd;
	}

	alive(): boolean {
		return !!this.child && this.exitCode === null;
	}

	async start(cwd: string): Promise<void> {
		const dir = await assertDirectory(cwd, 'terminal cwd');
		const shell = process.env.SHELL || '/bin/bash';
		const child = spawn(shell, [], { cwd: dir, env: process.env });
		this.child = child;
		this.exitCode = null;
		child.stdin?.on('error', () => { /* shell died; ignore EPIPE */ });
		child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk.toString('utf8')));
		child.stderr?.on('data', (chunk: Buffer) => this.onData(chunk.toString('utf8')));
		child.on('close', (code) => {
			this.exitCode = code;
			this.child = null;
			for (const [, resolve] of this.waiters) {
				resolve(-1);
			}
			this.waiters.clear();
			this.writeEmitter.fire(`\r\n\x1b[90m[shell exited code ${code}]\x1b[0m\r\n`);
		});
		const pty: vscode.Pseudoterminal = {
			onDidWrite: this.writeEmitter.event,
			open: () => this.writeEmitter.fire(`\x1b[90mzcode persistent shell "${this.name}" (${dir})\x1b[0m\r\n`),
			close: () => this.dispose(),
			handleInput: (data) => {
				try {
					this.child?.stdin?.write(data);
				} catch {
					// shell died; ignore
				}
			},
		};
		this.terminal = vscode.window.createTerminal({ name: `zcode: ${this.name}`, pty });
	}

	private onData(text: string): void {
		this.buffer += text;
		if (this.buffer.length > MAX_BUFFER) {
			const cut = this.buffer.length - MAX_BUFFER;
			this.buffer = this.buffer.slice(cut);
			this.drainMark = Math.max(0, this.drainMark - cut);
		}
		for (const [nonce, resolve] of this.waiters) {
			const idx = this.buffer.indexOf(`__ZC_DONE_${nonce}:`);
			if (idx >= 0) {
				const match = MARKER.exec(this.buffer.slice(idx, idx + 64));
				if (match) {
					this.waiters.delete(nonce);
					resolve(parseInt(match[2], 10));
				}
			}
		}
		const display = text
			.replace(/__ZC_DONE_[a-z0-9]+:-?\d+__(\r?\n)?/g, '')
			.replace(/\n/g, '\r\n');
		if (display) {
			this.writeEmitter.fire(display);
		}
	}

	/** Send a command and wait (bounded) for its completion marker. */
	async run(command: string, waitSeconds: number): Promise<{ output: string; exitCode: number | null }> {
		if (!this.alive()) {
			const state = this.exitCode !== null ? `exited ${this.exitCode}` : 'not running';
			return { output: `Error: shell "${this.name}" is ${state}. Call terminal_open first.`, exitCode: null };
		}
		const nonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
		const before = this.buffer.length;
		const done = new Promise<number | null>(resolve => {
			this.waiters.set(nonce, resolve);
			setTimeout(() => {
				if (this.waiters.delete(nonce)) {
					resolve(null);
				}
			}, waitSeconds * 1000);
		});
		this.child?.stdin?.write(`${command}\necho "__ZC_DONE_${nonce}:$?"\n`);
		const code = await done;
		await new Promise(r => setTimeout(r, 60)); // grace for trailing output
		const raw = this.drain(before);
		return { output: raw.replace(/__ZC_DONE_[a-z0-9]+:-?\d+__(\r?\n)?/g, '').trim(), exitCode: code };
	}

	/** Return output accumulated since the last drain. */
	drain(from = this.drainMark): string {
		const start = Math.min(from, this.buffer.length);
		const text = this.buffer.slice(start);
		this.drainMark = this.buffer.length;
		if (text.length > MAX_DRAIN) {
			return `…(older output truncated)\n${text.slice(text.length - MAX_DRAIN)}`;
		}
		return text;
	}

	show(): void {
		this.terminal?.show();
	}

	dispose(): void {
		this.waiters.clear();
		this.child?.kill('SIGTERM');
		this.child = null;
		if (this.terminal) {
			const terminal = this.terminal;
			this.terminal = null;
			terminal.dispose();
		}
	}
}

const shells = new Map<string, AgentShell>();

function shellNameOf(args: Record<string, unknown>): string {
	const raw = typeof args.name === 'string' ? args.name : typeof args.terminal_id === 'string' ? args.terminal_id : '';
	return raw.trim() || 'agent';
}

function resolveTerminalCwd(args: Record<string, unknown>, root: string): string {
	const raw = typeof args.cwd === 'string' ? args.cwd.trim() : '';
	if (!raw) {
		return root;
	}
	const abs = path.isAbsolute(raw) ? raw : path.resolve(root, raw);
	const normRoot = path.resolve(root);
	const norm = path.resolve(abs);
	if (norm !== normRoot && !norm.startsWith(normRoot + path.sep)) {
		throw new Error(`cwd must stay inside the workspace: ${raw}`);
	}
	return norm;
}

async function ensureShell(name: string, cwd: string, show: boolean): Promise<AgentShell> {
	const existing = shells.get(name);
	if (existing?.alive()) {
		if (show) {
			existing.show();
		}
		return existing;
	}
	existing?.dispose();
	const shell = new AgentShell(name, cwd);
	await shell.start(cwd);
	shells.set(name, shell);
	if (show) {
		shell.show();
	}
	return shell;
}

export const TERMINAL_TOOL_DEFS = [
	{
		type: 'function' as const,
		function: {
			name: 'terminal_open',
			description:
				'Open (or reuse) a named persistent shell. cwd/env/venv state persists across terminal_send calls. Also visible to the user as a VS Code terminal.',
			parameters: {
				type: 'object' as const,
				properties: {
					name: { type: 'string', description: 'Shell name (default "agent"). Reuse the same name to keep state.' },
					cwd: { type: 'string', description: 'Working directory (workspace-relative or absolute, default workspace root).' },
					show: { type: 'boolean', description: 'Reveal the terminal panel to the user (default false).' },
				},
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'terminal_send',
			description:
				'Run a command in a persistent shell and wait for it to finish (wait_seconds, default 30, 0 = fire-and-forget). State (cd, env, venv, REPL) persists. Not a TTY: interactive TUI apps unsupported. For long builds prefer run_terminal_cmd + job_output.',
			parameters: {
				type: 'object' as const,
				properties: {
					command: { type: 'string' },
					name: { type: 'string', description: 'Shell name (default "agent").' },
					wait_seconds: { type: 'number', description: 'Max seconds to wait for completion (default 30, max 120).' },
				},
				required: ['command'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'terminal_read',
			description: 'Drain new output from a persistent shell (for commands still running or REPL output).',
			parameters: {
				type: 'object' as const,
				properties: {
					name: { type: 'string' },
					wait_seconds: { type: 'number', description: 'Wait up to N seconds for new output before draining (default 0).' },
				},
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'terminal_list',
			description: 'List persistent shells with their status.',
			parameters: { type: 'object' as const, properties: {} },
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'terminal_kill',
			description: 'Kill a persistent shell.',
			parameters: {
				type: 'object' as const,
				properties: { name: { type: 'string', description: 'Shell name (default "agent").' } },
			},
		},
	},
];

export async function executeTerminalTool(
	name: string,
	args: Record<string, unknown>,
	root: string,
): Promise<ToolExecResult | undefined> {
	switch (name) {
		case 'terminal_open': {
			const shellName = shellNameOf(args);
			const cwd = resolveTerminalCwd(args, root);
			const shell = await ensureShell(shellName, cwd, args.show === true);
			return {
				summary: `terminal "${shell.name}" ready`,
				content: `Persistent shell "${shell.name}" running in ${shell.createdCwd}. Use terminal_send (state persists).`,
			};
		}
		case 'terminal_send': {
			const command = typeof args.command === 'string' ? args.command.trim() : '';
			if (!command) {
				return { summary: 'terminal command required', content: 'Error: command is required' };
			}
			const shellName = shellNameOf(args);
			const shell = shells.get(shellName);
			if (!shell) {
				return {
					summary: `terminal "${shellName}" not open`,
					content: `Error: no shell named "${shellName}". Call terminal_open first.`,
				};
			}
			const rawWait = typeof args.wait_seconds === 'number' ? args.wait_seconds : 30;
			const waitSeconds = Math.min(120, Math.max(0, rawWait));
			const { output, exitCode } = await shell.run(command, waitSeconds);
			if (exitCode === null) {
				return {
					summary: `terminal "${shell.name}" still running · ${command.slice(0, 48)}`,
					content: `Still running after ${waitSeconds}s. Output so far:\n${output || '(none yet)'}\n\nPoll with terminal_read.`,
				};
			}
			return {
				summary: `terminal "${shell.name}" exit ${exitCode}`,
				content: `${output || '(no output)'}`,
			};
		}
		case 'terminal_read': {
			const shell = shells.get(shellNameOf(args));
			if (!shell) {
				return { summary: 'terminal not open', content: 'Error: no such shell. Call terminal_open first.' };
			}
			const waitSeconds = typeof args.wait_seconds === 'number' ? Math.min(30, Math.max(0, args.wait_seconds)) : 0;
			if (waitSeconds > 0 && shell.alive()) {
				await new Promise(r => setTimeout(r, waitSeconds * 1000));
			}
			const text = shell.drain().replace(/__ZC_DONE_[a-z0-9]+:-?\d+__(\r?\n)?/g, '').trim();
			return {
				summary: `terminal "${shell.name}" read`,
				content: text || `(no new output; shell ${shell.alive() ? 'running' : `exited ${shell.exitCode ?? 'null'}`})`,
			};
		}
		case 'terminal_list': {
			const rows = [...shells.values()].map(s => {
				const status = s.alive() ? 'running' : `exited ${s.exitCode ?? 'null'}`;
				return `${s.name}\t${status}\t${s.createdCwd}`;
			});
			return {
				summary: `${shells.size} shell(s)`,
				content: rows.length ? rows.join('\n') : 'No persistent shells. Use terminal_open.',
			};
		}
		case 'terminal_kill': {
			const shellName = shellNameOf(args);
			const shell = shells.get(shellName);
			if (!shell) {
				return { summary: `terminal "${shellName}" not open`, content: `Error: no shell named "${shellName}".` };
			}
			shell.dispose();
			shells.delete(shellName);
			return { summary: `terminal "${shellName}" killed`, content: `Killed persistent shell "${shellName}".` };
		}
		default:
			return undefined;
	}
}

/** Serializable view of a persistent shell, for the chat UI's process panel. */
export interface TerminalSnapshot {
	name: string;
	cwd: string;
	running: boolean;
	exitCode: number | null;
	elapsedSec: number;
}

/** All persistent shells as plain snapshots for the UI. */
export function getTerminalsSnapshot(): TerminalSnapshot[] {
	const now = Date.now();
	return [...shells.values()].map(s => ({
		name: s.name,
		cwd: s.createdCwd,
		running: s.alive(),
		exitCode: s.exitCode,
		elapsedSec: Math.max(0, Math.round((now - s.createdAt) / 1000)),
	}));
}

/** Reveal a persistent shell's VS Code terminal. Returns false if unknown. */
export function showTerminalByName(name: string): boolean {
	const shell = shells.get(name);
	if (!shell) {
		return false;
	}
	shell.show();
	return true;
}
