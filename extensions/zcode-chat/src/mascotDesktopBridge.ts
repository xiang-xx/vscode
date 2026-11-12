/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Local bridge for the standalone desktop pet (`/Users/xiang/apps/mascot-desktop`).
 *
 * The pet owns its own look (squad, size, position, persona); this bridge only
 * streams chat activity and speaks its lines. Loopback only,
 * plain node:http, no dependencies:
 *   GET  /events    → SSE stream: hello / user / reply / react events
 *   POST /speak     → { trigger, id, label, persona, zone, gift }
 *                     → { line, skipped } (reuses the GLM-Flash voice pipeline)
 *   GET  /personas  → speaking-style list for the pet's persona picker
 *   GET  /ping      → liveness probe the pet uses to find the port
 *
 * Ports 5791–5795 are tried in order; the pet scans the same range. The server
 * binds 127.0.0.1 only. Kept as a module singleton so several chat panels share
 * one server while events from any panel fan out to the pet.
 */

import * as http from 'http';

export type MascotDesktopEvent =
	| { type: 'hello'; port: number }
	| { type: 'user'; text: string; ts: number }
	| { type: 'reply'; text: string; ts: number }
	| { type: 'react'; kind: 'dispatch' | 'complete'; ts: number };

const PORT_CANDIDATES = [5791, 5792, 5793, 5794, 5795];
const BODY_LIMIT = 8 * 1024;

export class MascotDesktopBridge {
	private server?: http.Server;
	private port = 0;
	private clients = new Set<http.ServerResponse>();
	private speakHandler?: (voice: Record<string, unknown>) => Promise<{ line?: string; skipped: boolean }>;
	private personasHandler?: () => unknown;

	/** Idempotent; resolves false when no port in the range is free. */
	start(): Promise<boolean> {
		if (this.server) { return Promise.resolve(true); }
		return new Promise(resolve => {
			const attempt = (index: number) => {
				if (index >= PORT_CANDIDATES.length) {
					resolve(false);
					return;
				}
				const port = PORT_CANDIDATES[index];
				const server = http.createServer((req, res) => this.handle(req, res));
				const onListenError = (error: NodeJS.ErrnoException) => {
					server.close();
					if (error.code === 'EADDRINUSE') {
						attempt(index + 1);
					} else {
						resolve(false);
					}
				};
				server.once('error', onListenError);
				server.listen(port, '127.0.0.1', () => {
					server.removeListener('error', onListenError);
					// Later errors (dead pet socket) must not crash the host.
					server.on('error', () => { /* ignore */ });
					this.server = server;
					this.port = port;
					resolve(true);
				});
			};
			attempt(0);
		});
	}

	onSpeak(handler: (voice: Record<string, unknown>) => Promise<{ line?: string; skipped: boolean }>): void {
		this.speakHandler = handler;
	}

	onPersonas(handler: () => unknown): void {
		this.personasHandler = handler;
	}

	emit(event: MascotDesktopEvent): void {
		if (!this.clients.size) { return; }
		const frame = `data: ${JSON.stringify(event)}\n\n`;
		for (const res of [...this.clients]) {
			try {
				res.write(frame);
			} catch {
				this.clients.delete(res);
			}
		}
	}

	private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
		const url = new URL(req.url || '/', 'http://127.0.0.1');
		if (url.pathname === '/ping') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end('{"ok":true}');
			return;
		}
		if (url.pathname === '/events') {
			res.writeHead(200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			});
			res.write('retry: 3000\n\n');
			res.write(`data: ${JSON.stringify({ type: 'hello', port: this.port })}\n\n`);
			this.clients.add(res);
			req.on('close', () => { this.clients.delete(res); });
			return;
		}
		if (url.pathname === '/speak' && req.method === 'POST') {
			void this.readBody(req).then(body => {
				let voice: Record<string, unknown> = {};
				try {
					voice = JSON.parse(body || '{}') as Record<string, unknown>;
				} catch {
					// An unparsable body just speaks with an empty voice.
				}
				const handler = this.speakHandler;
				if (!handler) {
					res.writeHead(503, { 'Content-Type': 'application/json' });
					res.end('{"line":"","skipped":true}');
					return;
				}
				return handler(voice).then(outcome => {
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ line: outcome.line ?? '', skipped: !!outcome.skipped }));
				}, () => {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end('{"line":"","skipped":true}');
				});
			});
			return;
		}
		if (url.pathname === '/personas') {
			this.jsonFromHandler(res, this.personasHandler);
			return;
		}
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end('{"error":"not found"}');
	}

	private jsonFromHandler(res: http.ServerResponse, handler: (() => unknown) | undefined): void {
		if (!handler) {
			res.writeHead(503, { 'Content-Type': 'application/json' });
			res.end('{"error":"no panel"}');
			return;
		}
		try {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(handler()));
		} catch {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end('{"error":"failed"}');
		}
	}

	private readBody(req: http.IncomingMessage): Promise<string> {
		return new Promise(resolve => {
			let body = '';
			req.on('data', (chunk: Buffer) => {
				if (body.length < BODY_LIMIT) {
					body += chunk.toString('utf8');
				}
			});
			req.on('end', () => resolve(body));
			req.on('error', () => resolve(''));
		});
	}
}

let singleton: MascotDesktopBridge | undefined;

/** One bridge per extension host; panels come and go, the pet keeps its stream. */
export function mascotDesktopBridge(): MascotDesktopBridge {
	if (!singleton) {
		singleton = new MascotDesktopBridge();
	}
	return singleton;
}

export function emitMascotDesktopEvent(event: MascotDesktopEvent): void {
	mascotDesktopBridge().emit(event);
}
