/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cursor ACP / .cursor/mcp.json wiring for the integrated Browser MCP.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ensureBrowserBridge, getBrowserBridgeUrl } from './browserBridgeHttp';

export const IDE_BROWSER_MCP_NAME = 'zcode-ide-browser';

export interface AcpMcpServer {
	type: 'stdio';
	name: string;
	command: string;
	args: string[];
	env: Array<{ name: string; value: string }>;
}

let extensionRoot: string | undefined;

export function setBrowserMcpExtensionRoot(root: string): void {
	extensionRoot = root;
}

function mcpServerScript(): string {
	if (!extensionRoot) {
		throw new Error('Browser MCP extension root not set');
	}
	return path.join(extensionRoot, 'mcp', 'browser-mcp-server.mjs');
}

/** Prefer system `node` for MCP child — Electron's execPath is not a Node CLI. */
function nodeCommand(): string {
	return 'node';
}

export async function buildIdeBrowserMcpServers(): Promise<AcpMcpServer[]> {
	const bridgeUrl = await ensureBrowserBridge();
	const script = mcpServerScript();
	try {
		await fs.access(script);
	} catch {
		throw new Error(`Browser MCP server missing at ${script}`);
	}
	return [{
		type: 'stdio',
		name: IDE_BROWSER_MCP_NAME,
		command: nodeCommand(),
		args: [script],
		env: [{ name: 'ZCODE_BROWSER_BRIDGE_URL', value: bridgeUrl }],
	}];
}

/**
 * Merge IDE browser MCP into user-level `~/.cursor/mcp.json` so Cursor ACP can
 * discover it when session/new injection is ignored. Does not touch the workspace.
 */
export async function ensureWorkspaceIdeBrowserMcp(): Promise<void> {
	const bridgeUrl = getBrowserBridgeUrl() || await ensureBrowserBridge();
	const script = mcpServerScript();
	const cursorDir = path.join(os.homedir(), '.cursor');
	const mcpPath = path.join(cursorDir, 'mcp.json');

	let existing: Record<string, unknown> = {};
	try {
		const raw = await fs.readFile(mcpPath, 'utf8');
		existing = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		existing = {};
	}

	const servers = (existing.mcpServers && typeof existing.mcpServers === 'object'
		? { ...(existing.mcpServers as Record<string, unknown>) }
		: {}) as Record<string, unknown>;

	servers[IDE_BROWSER_MCP_NAME] = {
		type: 'stdio',
		command: nodeCommand(),
		args: [script],
		env: {
			ZCODE_BROWSER_BRIDGE_URL: bridgeUrl,
		},
	};

	await fs.mkdir(cursorDir, { recursive: true });
	const next = { ...existing, mcpServers: servers };
	await fs.writeFile(mcpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

export const IDE_BROWSER_PROMPT_HINT = [
	'Browser (IDE): Prefer MCP tools from server "zcode-ide-browser" — open_browser_page, browser_list_pages, browser_read_page, browser_click, browser_type, browser_hover, browser_screenshot, browser_navigate — to drive the integrated Browser editor.',
	'Do not open an external system browser when these tools are available. Keep pageId across steps: open → read → click/type.',
].join(' ');
