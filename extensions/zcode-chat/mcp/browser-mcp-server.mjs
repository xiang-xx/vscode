#!/usr/bin/env node
/**
 * Minimal MCP stdio server that proxies browser tools to the zcode-chat
 * loopback bridge (workbench.action.browser.agent).
 *
 * Env: ZCODE_BROWSER_BRIDGE_URL=http://127.0.0.1:<port>
 */

import { createInterface } from 'readline';

const bridgeUrl = (process.env.ZCODE_BROWSER_BRIDGE_URL || '').replace(/\/$/, '');
if (!bridgeUrl) {
	console.error('ZCODE_BROWSER_BRIDGE_URL is required');
	process.exit(1);
}

const TOOLS = [
	{
		name: 'open_browser_page',
		description: 'Open a URL in the IDE integrated Browser. Returns pageId for follow-up tools.',
		inputSchema: {
			type: 'object',
			properties: {
				url: { type: 'string' },
				force_new: { type: 'boolean' },
			},
			required: ['url'],
		},
	},
	{
		name: 'browser_list_pages',
		description: 'List open integrated browser pages with pageId values.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'browser_read_page',
		description: 'Read an accessibility snapshot of a browser page (use refs for click/type).',
		inputSchema: {
			type: 'object',
			properties: { pageId: { type: 'string' } },
			required: ['pageId'],
		},
	},
	{
		name: 'browser_navigate',
		description: 'Navigate a page (pageId) to a URL, or open a new page if pageId omitted.',
		inputSchema: {
			type: 'object',
			properties: {
				url: { type: 'string' },
				pageId: { type: 'string' },
			},
			required: ['url'],
		},
	},
	{
		name: 'browser_click',
		description: 'Click an element. Prefer ref from browser_read_page.',
		inputSchema: {
			type: 'object',
			properties: {
				pageId: { type: 'string' },
				ref: { type: 'string' },
				selector: { type: 'string' },
				element: { type: 'string' },
				dblClick: { type: 'boolean' },
				button: { type: 'string' },
			},
			required: ['pageId', 'element'],
		},
	},
	{
		name: 'browser_type',
		description: 'Type text or press a key on a page.',
		inputSchema: {
			type: 'object',
			properties: {
				pageId: { type: 'string' },
				text: { type: 'string' },
				key: { type: 'string' },
				ref: { type: 'string' },
				selector: { type: 'string' },
				element: { type: 'string' },
				submit: { type: 'boolean' },
			},
			required: ['pageId'],
		},
	},
	{
		name: 'browser_hover',
		description: 'Hover an element on a page.',
		inputSchema: {
			type: 'object',
			properties: {
				pageId: { type: 'string' },
				ref: { type: 'string' },
				selector: { type: 'string' },
				element: { type: 'string' },
			},
			required: ['pageId', 'element'],
		},
	},
	{
		name: 'browser_screenshot',
		description: 'Capture a screenshot confirmation for a page.',
		inputSchema: {
			type: 'object',
			properties: {
				pageId: { type: 'string' },
				fullPage: { type: 'boolean' },
			},
			required: ['pageId'],
		},
	},
	{
		name: 'browser_reload',
		description: 'Reload a browser page.',
		inputSchema: {
			type: 'object',
			properties: { pageId: { type: 'string' } },
		},
	},
	{
		name: 'browser_go_back',
		description: 'Go back in page history.',
		inputSchema: {
			type: 'object',
			properties: { pageId: { type: 'string' } },
		},
	},
	{
		name: 'browser_go_forward',
		description: 'Go forward in page history.',
		inputSchema: {
			type: 'object',
			properties: { pageId: { type: 'string' } },
		},
	},
];

function mapToolToAction(name, args) {
	switch (name) {
		case 'open_browser_page':
			return { action: 'open', url: args.url, forceNew: !!args.force_new };
		case 'browser_list_pages':
			return { action: 'list' };
		case 'browser_read_page':
			return { action: 'read', pageId: args.pageId };
		case 'browser_navigate':
			return args.pageId
				? { action: 'navigate', pageId: args.pageId, url: args.url }
				: { action: 'open', url: args.url };
		case 'browser_click':
			return {
				action: 'click',
				pageId: args.pageId,
				ref: args.ref,
				selector: args.selector,
				element: args.element,
				dblClick: !!args.dblClick,
				button: args.button,
			};
		case 'browser_type':
			return {
				action: 'type',
				pageId: args.pageId,
				text: args.text,
				key: args.key,
				ref: args.ref,
				selector: args.selector,
				element: args.element,
				submit: !!args.submit,
			};
		case 'browser_hover':
			return {
				action: 'hover',
				pageId: args.pageId,
				ref: args.ref,
				selector: args.selector,
				element: args.element,
			};
		case 'browser_screenshot':
			return { action: 'screenshot', pageId: args.pageId, fullPage: !!args.fullPage };
		case 'browser_reload':
			return { action: 'reload', pageId: args.pageId };
		case 'browser_go_back':
			return { action: 'back', pageId: args.pageId };
		case 'browser_go_forward':
			return { action: 'forward', pageId: args.pageId };
		default:
			return null;
	}
}

async function callBridge(payload) {
	const res = await fetch(`${bridgeUrl}/action`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});
	const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
	return json;
}

function write(msg) {
	process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(msg) {
	const { id, method, params } = msg;
	if (method === 'initialize') {
		write({
			jsonrpc: '2.0',
			id,
			result: {
				protocolVersion: params?.protocolVersion || '2024-11-05',
				capabilities: { tools: {} },
				serverInfo: { name: 'zcode-ide-browser', version: '0.1.0' },
			},
		});
		return;
	}
	if (method === 'notifications/initialized' || method === 'initialized') {
		return;
	}
	if (method === 'tools/list') {
		write({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
		return;
	}
	if (method === 'tools/call') {
		const name = params?.name;
		const args = params?.arguments || {};
		const action = mapToolToAction(name, args);
		if (!action) {
			write({
				jsonrpc: '2.0',
				id,
				result: {
					content: [{ type: 'text', text: `Unknown tool: ${name}` }],
					isError: true,
				},
			});
			return;
		}
		try {
			const result = await callBridge(action);
			const text = result.ok
				? (result.content || 'ok')
				: `Error: ${result.error || result.content || 'failed'}`;
			write({
				jsonrpc: '2.0',
				id,
				result: {
					content: [{ type: 'text', text }],
					isError: !result.ok,
				},
			});
		} catch (err) {
			write({
				jsonrpc: '2.0',
				id,
				result: {
					content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
					isError: true,
				},
			});
		}
		return;
	}
	if (method === 'ping') {
		write({ jsonrpc: '2.0', id, result: {} });
		return;
	}
	if (id !== undefined) {
		write({
			jsonrpc: '2.0',
			id,
			error: { code: -32601, message: `Method not found: ${method}` },
		});
	}
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
	const trimmed = line.trim();
	if (!trimmed) {
		return;
	}
	let msg;
	try {
		msg = JSON.parse(trimmed);
	} catch {
		return;
	}
	void handle(msg);
});
