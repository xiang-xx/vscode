/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';

/**
 * Source launch vs the installed app.
 *
 * `scripts/code.sh` exports VSCODE_DEV, and the workbench then stamps the
 * product name (`Code - OSS Dev`) and the user-data dir (`code-oss-dev`).
 * The extension host process is started from the login shell, which often
 * does not inherit VSCODE_DEV, so `activate` stamps the name it actually
 * received before any store is opened.
 */
export type ZcodeRuntimeEnv = 'dev' | 'installed';

let stamped: ZcodeRuntimeEnv | undefined;

export function stampZcodeRuntime(appName: string | undefined): void {
	stamped = resolveRuntime(appName);
}

export function zcodeRuntimeEnv(): ZcodeRuntimeEnv {
	return stamped ?? resolveRuntime(undefined);
}

/**
 * Phone-facing mark. A source window is 「DEV」.
 * The installed app is the normal build and carries no mark.
 */
export function zcodeRuntimeLabel(): string {
	return zcodeRuntimeEnv() === 'dev' ? 'DEV' : '';
}

/**
 * Chat history is per runtime. The installed app keeps
 * `~/.zcode/v2/ide-chat` (existing sessions stay there). A source window
 * uses `~/.zcode/v2/ide-chat-dev` and does not read or write the other one.
 * Folder filtering inside one runtime is unchanged.
 */
export function ideChatRootDir(): string {
	const base = path.join(os.homedir(), '.zcode', 'v2', 'ide-chat');
	return zcodeRuntimeEnv() === 'dev' ? `${base}-dev` : base;
}

function resolveRuntime(appName: string | undefined): ZcodeRuntimeEnv {
	if (process.env.VSCODE_DEV) {
		return 'dev';
	}
	if (appName && /\bDev$/.test(appName)) {
		return 'dev';
	}
	return 'installed';
}
