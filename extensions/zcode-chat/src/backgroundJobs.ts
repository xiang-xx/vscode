/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Background job tools (job_list / job_output / job_kill) ported from dsh.
 * Long-running shell commands that hit the foreground timeout are converted
 * into background jobs instead of being killed, so the agent can poll them.
 *
 * Additionally every job lifecycle change is broadcast (onJobEvent) so the
 * chat UI can show the user which background processes the worker started
 * and how they are doing — the agent no longer keeps this to itself.
 */

import { spawn, type ChildProcess } from 'child_process';
import type { ToolExecResult } from './browserTools';
import { assertDirectory } from './processUtils';

const MAX_JOBS = 24;
const MAX_BUFFER = 2_000_000;
const MAX_PREVIEW = 30_000;
const MAX_TAIL_CHARS = 600;
const UPDATE_THROTTLE_MS = 500;

export interface ShellJob {
	id: string;
	command: string;
	cwd: string;
	startedAt: number;
	child: ChildProcess | null;
	finishedAt: number | null;
	exitCode: number | null;
	killed: boolean;
	stdout: string;
	stderr: string;
}

export interface ShellRunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	jobId?: string;
}

/** Serializable view of a job, pushed to the webview panel. */
export interface JobSnapshot {
	id: string;
	command: string;
	cwd: string;
	startedAt: number;
	finishedAt: number | null;
	exitCode: number | null;
	killed: boolean;
	running: boolean;
	status: string;
	elapsedSec: number;
	stdoutLen: number;
	stderrLen: number;
	stdoutTail: string;
	stderrTail: string;
}

export type JobEventKind = 'created' | 'updated' | 'finished';
export interface JobEvent {
	kind: JobEventKind;
	job: JobSnapshot;
}
export type JobEventListener = (event: JobEvent) => void;

const jobs = new Map<string, ShellJob>();
let seq = 0;

const jobEventListeners = new Set<JobEventListener>();
const jobEmitMarks = new WeakMap<object, number>();

/** Subscribe to job lifecycle events. Returns an unsubscribe function. */
export function onJobEvent(listener: JobEventListener): () => void {
	jobEventListeners.add(listener);
	return () => {
		jobEventListeners.delete(listener);
	};
}

function emitJob(kind: JobEventKind, job: ShellJob, throttleMs = 0): void {
	if (throttleMs > 0 && kind === 'updated') {
		const now = Date.now();
		const last = jobEmitMarks.get(job) ?? 0;
		if (now - last < throttleMs) {
			return;
		}
		jobEmitMarks.set(job, now);
	}
	const event: JobEvent = { kind, job: snapshotOf(job) };
	for (const listener of [...jobEventListeners]) {
		try {
			listener(event);
		} catch {
			// A broken UI listener must never take down the job pipeline.
		}
	}
}

function tailText(text: string, max = MAX_TAIL_CHARS): string {
	const clean = text.replace(/\n{3,}/g, '\n\n');
	return clean.length > max ? `…${clean.slice(clean.length - max)}` : clean;
}

function snapshotOf(job: ShellJob): JobSnapshot {
	return {
		id: job.id,
		command: job.command,
		cwd: job.cwd,
		startedAt: job.startedAt,
		finishedAt: job.finishedAt,
		exitCode: job.exitCode,
		killed: job.killed,
		running: !job.finishedAt,
		status: statusOf(job),
		elapsedSec: Math.max(0, Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000)),
		stdoutLen: job.stdout.length,
		stderrLen: job.stderr.length,
		stdoutTail: tailText(job.stdout),
		stderrTail: tailText(job.stderr),
	};
}

/** All jobs (latest first) as plain snapshots for the UI. */
export function getJobsSnapshot(): JobSnapshot[] {
	return [...jobs.values()]
		.sort((a, b) => b.startedAt - a.startedAt)
		.slice(0, 30)
		.map(snapshotOf);
}

/** Read a job's tail output for the UI (independent of the agent tool path). */
export function readJobOutput(id: string, tailLinesCount = 120): { found: boolean; text: string } {
	const job = jobs.get(id);
	if (!job) {
		return { found: false, text: `no such job: ${id}` };
	}
	const header = `job ${job.id} · ${statusOf(job)} · ${job.command}`;
	const out = job.stdout ? tailLines(job.stdout, tailLinesCount) : '(no stdout yet)';
	const err = job.stderr ? `\n\nstderr:\n${tailLines(job.stderr, tailLinesCount)}` : '';
	return { found: true, text: `${header}\n\nstdout:\n${out}${err}` };
}

/** Terminate a running job from the UI. Safe to call on finished jobs. */
export function killJobById(id: string): { found: boolean; killed: boolean; message: string } {
	const job = jobs.get(id);
	if (!job) {
		return { found: false, killed: false, message: `no such job: ${id}` };
	}
	if (job.finishedAt) {
		return { found: true, killed: false, message: `already ${statusOf(job)}` };
	}
	job.killed = true;
	job.child?.kill('SIGTERM');
	emitJob('updated', job);
	setTimeout(() => {
		if (!job.finishedAt && job.child) {
			job.child.kill('SIGKILL');
		}
	}, 3000);
	return { found: true, killed: true, message: `SIGTERM sent to ${job.id}` };
}

function attach(job: ShellJob, child: ChildProcess): void {
	job.child = child;
	child.stdout?.on('data', (chunk: Buffer) => {
		if (job.stdout.length < MAX_BUFFER) {
			job.stdout += chunk.toString('utf8');
		}
		emitJob('updated', job, UPDATE_THROTTLE_MS);
	});
	child.stderr?.on('data', (chunk: Buffer) => {
		if (job.stderr.length < MAX_BUFFER) {
			job.stderr += chunk.toString('utf8');
		}
		emitJob('updated', job, UPDATE_THROTTLE_MS);
	});
	child.on('error', (err) => {
		job.stderr += `\n${err.message}`;
		job.finishedAt = Date.now();
		job.child = null;
		emitJob('finished', job);
	});
	child.on('close', (code) => {
		job.finishedAt = Date.now();
		job.exitCode = code;
		job.child = null;
		emitJob('finished', job);
	});
}

function register(command: string, cwd: string, child: ChildProcess, seedOut = '', seedErr = ''): ShellJob {
	const job: ShellJob = {
		id: `j${++seq}`,
		command,
		cwd,
		startedAt: Date.now(),
		child: null,
		finishedAt: null,
		exitCode: null,
		killed: false,
		stdout: seedOut,
		stderr: seedErr,
	};
	attach(job, child);
	jobs.set(job.id, job);
	pruneJobs();
	emitJob('created', job);
	return job;
}

function pruneJobs(): void {
	if (jobs.size <= MAX_JOBS) {
		return;
	}
	const finished = [...jobs.values()]
		.filter(j => j.finishedAt)
		.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
	for (const j of finished) {
		if (jobs.size <= MAX_JOBS) {
			break;
		}
		jobs.delete(j.id);
	}
}

/**
 * Like processUtils.runShellCommand, but on timeout the process keeps running
 * as a background job and its id is returned so the agent can poll it.
 */
export async function runShellWithJobFallback(options: {
	command: string;
	cwd: string;
	timeoutMs: number;
	env?: NodeJS.ProcessEnv;
}): Promise<ShellRunResult> {
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
		const finish = (result: ShellRunResult) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			if (settled) {
				return;
			}
			const job = register(options.command, cwd, child, stdout, stderr);
			finish({ code: null, stdout, stderr, timedOut: true, jobId: job.id });
		}, options.timeoutMs);
		child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
		child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
		child.on('error', (err) => {
			const msg = err instanceof Error ? err.message : String(err);
			stderr = stderr || msg;
			finish({ code: null, stdout, stderr, timedOut: false });
		});
		child.on('close', (code) => {
			finish({ code, stdout, stderr, timedOut: false });
		});
	});
}

export const JOB_TOOL_DEFS = [
	{
		type: 'function' as const,
		function: {
			name: 'job_list',
			description: 'List background jobs (long commands that outlived their foreground timeout).',
			parameters: { type: 'object' as const, properties: {} },
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'job_output',
			description:
				'Read output of a background job. Optionally wait until the job finishes or new output arrives (wait_seconds, max 30).',
			parameters: {
				type: 'object' as const,
				properties: {
					job_id: { type: 'string', description: 'Job id from job_list (also accepts id).' },
					id: { type: 'string' },
					tail_lines: { type: 'number', description: 'Show only the last N lines per stream (default 120).' },
					wait_seconds: { type: 'number', description: 'Block up to N seconds waiting for completion or new output (default 0).' },
				},
				required: ['job_id'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'job_kill',
			description: 'Terminate a background job (SIGTERM, escalating to SIGKILL after 3s).',
			parameters: {
				type: 'object' as const,
				properties: {
					job_id: { type: 'string' },
					id: { type: 'string' },
				},
				required: ['job_id'],
			},
		},
	},
];

function jobIdOf(args: Record<string, unknown>): string | undefined {
	const raw = typeof args.job_id === 'string' ? args.job_id : typeof args.id === 'string' ? args.id : '';
	const trimmed = raw.trim();
	return trimmed || undefined;
}

function statusOf(job: ShellJob): string {
	if (job.finishedAt) {
		return `exited ${job.exitCode ?? 'null'}`;
	}
	return job.killed ? 'killing' : 'running';
}

function tailLines(text: string, lines: number): string {
	const all = text.split('\n');
	const tail = all.slice(-Math.max(1, lines)).join('\n');
	return tail.length > MAX_PREVIEW ? `${tail.slice(tail.length - MAX_PREVIEW)}\n…(truncated)` : tail;
}

async function waitForActivity(job: ShellJob, waitSeconds: number, startLen: number): Promise<void> {
	const deadline = Date.now() + Math.min(30, Math.max(0, waitSeconds)) * 1000;
	while (Date.now() < deadline) {
		if (job.finishedAt) {
			return;
		}
		if (job.stdout.length + job.stderr.length > startLen) {
			return;
		}
		await new Promise(r => setTimeout(r, 250));
	}
}

export async function executeJobTool(
	name: string,
	args: Record<string, unknown>,
): Promise<ToolExecResult | undefined> {
	switch (name) {
		case 'job_list': {
			const rows = getJobsSnapshot().map(j => {
				const cmd = j.command.length > 80 ? `${j.command.slice(0, 79)}…` : j.command;
				return `${j.id}\t${j.status}\t${j.elapsedSec}s\t${cmd}`;
			});
			return {
				summary: `${jobs.size} job(s)`,
				content: rows.length ? rows.join('\n') : 'No background jobs.',
			};
		}
		case 'job_output': {
			const id = jobIdOf(args);
			if (!id) {
				return { summary: 'job id required', content: 'Error: job_id is required' };
			}
			const job = jobs.get(id);
			if (!job) {
				return { summary: `job ${id} not found`, content: `Error: no such job: ${id}. See job_list.` };
			}
			const tail = Math.floor(typeof args.tail_lines === 'number' ? args.tail_lines : 120);
			const waitSeconds = typeof args.wait_seconds === 'number' ? args.wait_seconds : 0;
			if (waitSeconds > 0 && !job.finishedAt) {
				await waitForActivity(job, waitSeconds, job.stdout.length + job.stderr.length);
			}
			const { text } = readJobOutput(id, tail);
			return {
				summary: `job ${job.id} ${statusOf(job)}`,
				content: text,
			};
		}
		case 'job_kill': {
			const id = jobIdOf(args);
			if (!id) {
				return { summary: 'job id required', content: 'Error: job_id is required' };
			}
			const result = killJobById(id);
			if (!result.found) {
				return { summary: `job ${id} not found`, content: `Error: no such job: ${id}. See job_list.` };
			}
			if (!result.killed) {
				return { summary: `job ${id} ${result.message}`, content: `Job ${id} ${result.message}.` };
			}
			return { summary: `killed job ${id}`, content: `Sent SIGTERM to job ${id}.` };
		}
		default:
			return undefined;
	}
}
