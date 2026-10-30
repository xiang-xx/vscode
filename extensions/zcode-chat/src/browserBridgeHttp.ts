/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Loopback HTTP bridge so the Cursor ACP MCP process can drive the integrated
 * browser via `workbench.action.browser.agent`.
 */

import * as http from 'http';
import { invokeBrowserAgentAction } from './browserTools';

let server: http.Server | undefined;
let bridgeUrl: string | undefined;

export function getBrowserBridgeUrl(): string | undefined {
	return bridgeUrl;
}

export async function ensureBrowserBridge(): Promise<string> {
	if (bridgeUrl && server) {
		return bridgeUrl;
	}

	server = http.createServer(async (req, res) => {
		res.setHeader('Content-Type', 'application/json; charset=utf-8');
		if (req.method === 'GET' && req.url === '/health') {
			res.writeHead(200);
			res.end(JSON.stringify({ ok: true }));
			return;
		}
		if (req.method !== 'POST' || req.url !== '/action') {
			res.writeHead(404);
			res.end(JSON.stringify({ ok: false, error: 'Not found' }));
			return;
		}
		try {
			const body = await readBody(req);
			const payload = JSON.parse(body || '{}') as Record<string, unknown>;
			const result = await invokeBrowserAgentAction(payload);
			res.writeHead(result.ok ? 200 : 400);
			res.end(JSON.stringify(result));
		} catch (err) {
			res.writeHead(500);
			res.end(JSON.stringify({
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			}));
		}
	});

	await new Promise<void>((resolve, reject) => {
		server!.once('error', reject);
		server!.listen(0, '127.0.0.1', () => resolve());
	});

	const addr = server.address();
	if (!addr || typeof addr === 'string') {
		throw new Error('Browser bridge failed to bind a TCP port');
	}
	bridgeUrl = `http://127.0.0.1:${addr.port}`;
	return bridgeUrl;
}

export function disposeBrowserBridge(): void {
	try {
		server?.close();
	} catch { /* ignore */ }
	server = undefined;
	bridgeUrl = undefined;
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}
