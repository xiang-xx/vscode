/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Map ZCode CLI tool names / arg shapes onto the zcode-chat harness.
 * @see /Users/xiang/apps/ZCode/apps/zcode-cli/packages/core/src/tool/handlers
 */

/** Canonical harness tool names. */
export type HarnessToolName =
	| 'read_file'
	| 'write_file'
	| 'str_replace'
	| 'delete_file'
	| 'list_dir'
	| 'run_terminal_cmd'
	| 'get_diagnostics'
	| 'web_fetch'
	| 'grep'
	| 'glob'
	| 'TodoWrite'
	| 'AskUserQuestion';

const NAME_ALIASES: Record<string, HarnessToolName> = {
	// ZCode PascalCase
	Read: 'read_file',
	Write: 'write_file',
	Edit: 'str_replace',
	Bash: 'run_terminal_cmd',
	Grep: 'grep',
	Glob: 'glob',
	WebFetch: 'web_fetch',
	TodoWrite: 'TodoWrite',
	TodoRead: 'TodoWrite', // no separate read — return via write merge noop
	AskUserQuestion: 'AskUserQuestion',
	// lowercase / snake variants models invent
	read: 'read_file',
	write: 'write_file',
	edit: 'str_replace',
	bash: 'run_terminal_cmd',
	shell: 'run_terminal_cmd',
	run_terminal_cmd: 'run_terminal_cmd',
	delete: 'delete_file',
	delete_file: 'delete_file',
	list_dir: 'list_dir',
	ls: 'list_dir',
	get_diagnostics: 'get_diagnostics',
	diagnostics: 'get_diagnostics',
	web_fetch: 'web_fetch',
	webfetch: 'web_fetch',
	grep: 'grep',
	glob: 'glob',
	read_file: 'read_file',
	write_file: 'write_file',
	str_replace: 'str_replace',
};

export function normalizeToolName(name: string): string {
	return NAME_ALIASES[name] ?? name;
}

/**
 * Accept both zcode-chat snake args and ZCode CLI shapes
 * (file_path, timeout, working_directory, head_limit, -i, …).
 */
export function normalizeToolArgs(
	name: string,
	args: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...args };
	const canonical = normalizeToolName(name);

	const pathVal = firstString(out.path, out.file_path, out.filePath, out.target_file);
	if (pathVal !== undefined) {
		out.path = pathVal;
	}

	switch (canonical) {
		case 'read_file': {
			if (out.offset === undefined && typeof out.offsetLine === 'number') {
				out.offset = out.offsetLine;
			}
			if (out.limit === undefined && typeof out.limitLines === 'number') {
				out.limit = out.limitLines;
			}
			break;
		}
		case 'write_file': {
			const content = firstString(out.content, out.contents, out.new_string);
			if (content !== undefined) {
				out.content = content;
			}
			break;
		}
		case 'str_replace': {
			const oldS = firstString(out.old_string, out.oldString, out.old_str);
			const newS = firstString(out.new_string, out.newString, out.new_str);
			if (oldS !== undefined) {
				out.old_string = oldS;
			}
			if (newS !== undefined) {
				out.new_string = newS;
			}
			if (out.replace_all === undefined && typeof out.replaceAll === 'boolean') {
				out.replace_all = out.replaceAll;
			}
			break;
		}
		case 'run_terminal_cmd': {
			const command = firstString(out.command, out.cmd);
			if (command !== undefined) {
				out.command = command;
			}
			const cwd = firstString(out.cwd, out.working_directory, out.workingDirectory, out.workdir);
			if (cwd !== undefined) {
				out.cwd = cwd;
			}
			if (out.timeout_ms === undefined) {
				const t = out.timeout ?? out.timeoutMs;
				if (typeof t === 'number') {
					out.timeout_ms = t;
				} else if (typeof t === 'string' && t.trim() && !Number.isNaN(Number(t))) {
					out.timeout_ms = Number(t);
				}
			}
			break;
		}
		case 'grep': {
			if (out.case_insensitive === undefined) {
				if (out['-i'] === true || out.ignoreCase === true || out.i === true) {
					out.case_insensitive = true;
				}
			}
			if (out.max_results === undefined) {
				const h = out.head_limit ?? out.headLimit ?? out.maxResults;
				if (typeof h === 'number') {
					out.max_results = h;
				}
			}
			if (out.output_mode === undefined && typeof out.outputMode === 'string') {
				out.output_mode = out.outputMode;
			}
			break;
		}
		case 'glob': {
			const pattern = firstString(out.pattern, out.glob_pattern, out.globPattern);
			if (pattern !== undefined) {
				out.pattern = pattern;
			}
			if (out.max_results === undefined) {
				const h = out.head_limit ?? out.maxResults;
				if (typeof h === 'number') {
					out.max_results = h;
				}
			}
			break;
		}
		case 'web_fetch': {
			const url = firstString(out.url, out.uri);
			if (url !== undefined) {
				out.url = url;
			}
			if (out.max_chars === undefined) {
				const m = out.maxChars ?? out.max_characters;
				if (typeof m === 'number') {
					out.max_chars = m;
				}
			}
			break;
		}
		default:
			break;
	}

	return out;
}

function firstString(...values: unknown[]): string | undefined {
	for (const v of values) {
		if (typeof v === 'string' && v.length > 0) {
			return v;
		}
	}
	return undefined;
}
