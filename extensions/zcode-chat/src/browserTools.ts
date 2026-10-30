/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Bridge ZCode harness (+ Cursor MCP) onto the integrated BrowserView.
 * Interactive ops go through `workbench.action.browser.agent` (Playwright).
 */

import * as vscode from 'vscode';

export interface ToolExecResult {
	summary: string;
	content: string;
	detail?: string;
	path?: string;
	uri?: string;
	added?: number;
	removed?: number;
}

const AGENT = 'workbench.action.browser.agent';
const IMPORT_CHROME = 'workbench.action.browser.importChromeData';
const TOGGLE_DEVTOOLS = 'workbench.action.browser.toggleDevTools';
const OPEN_OR_LIST = 'workbench.action.browser.openOrList';

interface AgentResponse {
	ok?: boolean;
	content?: string;
	pageId?: string;
	error?: string;
}

async function agent(action: string, args: Record<string, unknown> = {}): Promise<ToolExecResult> {
	const result = await vscode.commands.executeCommand<AgentResponse>(AGENT, { action, ...args });
	if (!result?.ok) {
		const err = result?.error || result?.content || 'Browser agent action failed';
		return {
			summary: `browser ${action} failed`,
			content: `Error: ${err}`,
		};
	}
	const pageHint = result.pageId ? ` [pageId=${result.pageId}]` : '';
	return {
		summary: `browser ${action}${pageHint}`,
		content: result.content || 'ok',
	};
}

export const BROWSER_TOOL_DEFS = [
	{
		type: 'function' as const,
		function: {
			name: 'open_browser_page',
			description:
				'Open a URL in the integrated Browser editor. Returns a pageId for follow-up tools (read/click/type). Prefer reusing tabs unless force_new.',
			parameters: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'Absolute http(s) or file URL.' },
					force_new: { type: 'boolean', description: 'Force a new tab even if a similar host is open.' },
					forceNew: { type: 'boolean' },
				},
				required: ['url'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'browser_navigate',
			description: 'Navigate an existing integrated browser page (by pageId) to a URL, or open if pageId omitted.',
			parameters: {
				type: 'object',
				properties: {
					url: { type: 'string' },
					pageId: { type: 'string', description: 'Page id from open_browser_page / browser_list_pages.' },
					page_id: { type: 'string' },
				},
				required: ['url'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'browser_list_pages',
			description: 'List open integrated browser pages with their pageId values.',
			parameters: { type: 'object', properties: {} },
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'browser_read_page',
			description: 'Read an accessibility snapshot of a browser page (better than screenshot for finding refs to click/type).',
			parameters: {
				type: 'object',
				properties: {
					pageId: { type: 'string' },
					page_id: { type: 'string' },
				},
				required: ['pageId'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'browser_click',
			description: 'Click an element on a browser page. Prefer ref from browser_read_page; selector is a fallback.',
			parameters: {
				type: 'object',
				properties: {
					pageId: { type: 'string' },
					page_id: { type: 'string' },
					ref: { type: 'string', description: 'aria-ref from the read_page snapshot.' },
					selector: { type: 'string', description: 'Playwright selector when ref is unavailable.' },
					element: { type: 'string', description: 'Human-readable element label.' },
					dblClick: { type: 'boolean' },
					button: { type: 'string', enum: ['left', 'right', 'middle'] },
				},
				required: ['pageId', 'element'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'browser_type',
			description: 'Type text or press a key on a browser page. Target via ref/selector when possible.',
			parameters: {
				type: 'object',
				properties: {
					pageId: { type: 'string' },
					page_id: { type: 'string' },
					text: { type: 'string' },
					key: { type: 'string', description: 'Key to press instead of typing text (e.g. Enter, Tab).' },
					ref: { type: 'string' },
					selector: { type: 'string' },
					element: { type: 'string' },
					submit: { type: 'boolean', description: 'Press Enter after typing.' },
				},
				required: ['pageId'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'browser_hover',
			description: 'Hover an element on a browser page.',
			parameters: {
				type: 'object',
				properties: {
					pageId: { type: 'string' },
					page_id: { type: 'string' },
					ref: { type: 'string' },
					selector: { type: 'string' },
					element: { type: 'string' },
				},
				required: ['pageId', 'element'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'browser_screenshot',
			description: 'Capture a screenshot of a browser page (confirmation only; prefer browser_read_page for structure).',
			parameters: {
				type: 'object',
				properties: {
					pageId: { type: 'string' },
					page_id: { type: 'string' },
					fullPage: { type: 'boolean' },
				},
				required: ['pageId'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'browser_reload',
			description: 'Reload a browser page (pageId) or the active tab.',
			parameters: {
				type: 'object',
				properties: {
					pageId: { type: 'string' },
					page_id: { type: 'string' },
					hard: { type: 'boolean' },
				},
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'browser_go_back',
			description: 'Go back in a browser page history.',
			parameters: {
				type: 'object',
				properties: {
					pageId: { type: 'string' },
					page_id: { type: 'string' },
				},
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'browser_go_forward',
			description: 'Go forward in a browser page history.',
			parameters: {
				type: 'object',
				properties: {
					pageId: { type: 'string' },
					page_id: { type: 'string' },
				},
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'browser_list_or_open',
			description: 'Show the integrated browser tab picker UI.',
			parameters: { type: 'object', properties: {} },
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'browser_import_chrome_data',
			description:
				'Sync Chrome sign-in state into the integrated browser (cookies + LocalStorage). Prefer asking the user first.',
			parameters: { type: 'object', properties: {} },
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'browser_toggle_devtools',
			description: 'Toggle DevTools for the active integrated browser tab.',
			parameters: { type: 'object', properties: {} },
		},
	},
];

function pageIdOf(args: Record<string, unknown>): string | undefined {
	if (typeof args.pageId === 'string' && args.pageId.trim()) {
		return args.pageId.trim();
	}
	if (typeof args.page_id === 'string' && args.page_id.trim()) {
		return args.page_id.trim();
	}
	return undefined;
}

export async function executeBrowserTool(
	name: string,
	args: Record<string, unknown>,
): Promise<ToolExecResult | undefined> {
	switch (name) {
		case 'open_browser_page': {
			const url = typeof args.url === 'string' ? args.url.trim() : '';
			if (!url) {
				return { summary: 'browser url required', content: 'Error: url is required' };
			}
			return agent('open', {
				url,
				forceNew: args.force_new === true || args.forceNew === true,
			});
		}
		case 'browser_navigate': {
			const url = typeof args.url === 'string' ? args.url.trim() : '';
			if (!url) {
				return { summary: 'browser url required', content: 'Error: url is required' };
			}
			const pageId = pageIdOf(args);
			if (pageId) {
				return agent('navigate', { pageId, url });
			}
			return agent('open', { url });
		}
		case 'browser_list_pages':
			return agent('list');
		case 'browser_read_page': {
			const pageId = pageIdOf(args);
			if (!pageId) {
				return { summary: 'browser pageId required', content: 'Error: pageId is required' };
			}
			return agent('read', { pageId });
		}
		case 'browser_click': {
			const pageId = pageIdOf(args);
			if (!pageId) {
				return { summary: 'browser pageId required', content: 'Error: pageId is required' };
			}
			return agent('click', {
				pageId,
				ref: args.ref,
				selector: args.selector,
				element: args.element,
				dblClick: args.dblClick === true,
				button: args.button,
			});
		}
		case 'browser_type': {
			const pageId = pageIdOf(args);
			if (!pageId) {
				return { summary: 'browser pageId required', content: 'Error: pageId is required' };
			}
			return agent('type', {
				pageId,
				text: args.text,
				key: args.key,
				ref: args.ref,
				selector: args.selector,
				element: args.element,
				submit: args.submit === true,
			});
		}
		case 'browser_hover': {
			const pageId = pageIdOf(args);
			if (!pageId) {
				return { summary: 'browser pageId required', content: 'Error: pageId is required' };
			}
			return agent('hover', {
				pageId,
				ref: args.ref,
				selector: args.selector,
				element: args.element,
			});
		}
		case 'browser_screenshot': {
			const pageId = pageIdOf(args);
			if (!pageId) {
				return { summary: 'browser pageId required', content: 'Error: pageId is required' };
			}
			return agent('screenshot', { pageId, fullPage: args.fullPage === true });
		}
		case 'browser_reload': {
			const pageId = pageIdOf(args);
			if (pageId) {
				return agent('reload', { pageId });
			}
			await vscode.commands.executeCommand(
				args.hard === true ? 'workbench.action.browser.hardReload' : 'workbench.action.browser.reload',
			);
			return { summary: 'browser reload', content: 'Reloaded active browser tab.' };
		}
		case 'browser_go_back': {
			const pageId = pageIdOf(args);
			if (pageId) {
				return agent('back', { pageId });
			}
			await vscode.commands.executeCommand('workbench.action.browser.goBack');
			return { summary: 'browser back', content: 'Went back.' };
		}
		case 'browser_go_forward': {
			const pageId = pageIdOf(args);
			if (pageId) {
				return agent('forward', { pageId });
			}
			await vscode.commands.executeCommand('workbench.action.browser.goForward');
			return { summary: 'browser forward', content: 'Went forward.' };
		}
		case 'browser_list_or_open': {
			await vscode.commands.executeCommand(OPEN_OR_LIST);
			return { summary: 'browser list', content: 'Opened browser tab picker.' };
		}
		case 'browser_import_chrome_data': {
			await vscode.commands.executeCommand(IMPORT_CHROME);
			return {
				summary: 'browser import chrome',
				content: 'Started Chrome sign-in sync into the integrated browser (see notification for result).',
			};
		}
		case 'browser_toggle_devtools': {
			await vscode.commands.executeCommand(TOGGLE_DEVTOOLS);
			return { summary: 'browser devtools', content: 'Toggled browser DevTools.' };
		}
		default:
			return undefined;
	}
}

/** Shared entry used by the Cursor MCP HTTP bridge. */
export async function invokeBrowserAgentAction(payload: Record<string, unknown>): Promise<AgentResponse> {
	const action = typeof payload.action === 'string' ? payload.action : '';
	if (!action) {
		return { ok: false, error: 'action required' };
	}
	const result = await vscode.commands.executeCommand<AgentResponse>(AGENT, payload);
	return result ?? { ok: false, error: 'No response from browser agent bridge' };
}
