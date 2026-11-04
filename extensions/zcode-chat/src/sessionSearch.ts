/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Full-text search over the global IDE chat history (`~/.zcode/v2/ide-chat`),
 * ported from DeepSeek Harness's `session_search` / `session_event_search`
 * tools: every past session stays retrievable — not only the open tabs — and a
 * hit jumps straight back into that conversation.
 *
 * Storage shape (see README / ideChatStore.ts):
 *   index.json          → { sessions: { id, title, updatedAt, ... }[] }
 *   sessions/<id>.json  → { messages: { role, content }[] , ... }
 *
 * This module intentionally parses the files directly instead of importing
 * IdeChatStore, so search keeps working regardless of store refactors.
 */

export interface SessionSearchMatch {
	sessionId: string;
	title: string;
	updatedAt: number;
	role: 'user' | 'assistant' | 'system';
	/** Flattened text around the first hit, for QuickPick detail. */
	snippet: string;
	/** Occurrences inside the matched message. */
	matchCount: number;
	/** Occurrences across the whole session (ranking). */
	sessionMatchCount: number;
}

export interface SessionSearchOptions {
	/** Max returned matches. Default 60. */
	limit?: number;
	/** Max matches reported per session. Default 3. */
	maxPerSession?: number;
	/** Skip session files larger than this (bytes). Default 8 MB. */
	maxFileBytes?: number;
}

interface SessionFileShape {
	messages?: Array<{ role?: string; content?: unknown }>;
}

interface IndexFileShape {
	sessions?: Array<{ id?: string; title?: string; updatedAt?: number }>;
}

const DEFAULT_LIMIT = 60;
const DEFAULT_MAX_PER_SESSION = 3;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

const SNIPPET_RADIUS = 70;

function storeRoot(): string {
	return path.join(os.homedir(), '.zcode', 'v2', 'ide-chat');
}

function flattenText(value: unknown): string {
	return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** `query` → lowercase AND-terms; `/pattern/` opts into a case-insensitive regex. */
function compileQuery(query: string): { regex: RegExp | undefined; terms: string[] } {
	const regexForm = /^\/(.+)\/$/.exec(query);
	if (regexForm) {
		try {
			return { regex: new RegExp(regexForm[1], 'gi'), terms: [] };
		} catch {
			// Invalid regex — fall through and treat the raw text as plain terms.
		}
	}
	return { regex: undefined, terms: query.toLowerCase().split(/\s+/).filter(Boolean) };
}

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) {
		return 0;
	}
	let count = 0;
	let idx = haystack.toLowerCase().indexOf(needle);
	while (idx !== -1) {
		count++;
		idx = haystack.toLowerCase().indexOf(needle, idx + needle.length);
	}
	return count;
}

function snippetAround(text: string, index: number): string {
	if (!text) {
		return '';
	}
	const start = Math.max(0, index - SNIPPET_RADIUS);
	const end = Math.min(text.length, index + SNIPPET_RADIUS);
	const prefix = start > 0 ? '…' : '';
	const suffix = end < text.length ? '…' : '';
	return `${prefix}${text.slice(start, end)}${suffix}`;
}

async function readJsonTolerant(file: string, maxBytes: number): Promise<unknown> {
	let raw: string;
	try {
		const stat = await fs.promises.stat(file);
		if (!stat.isFile() || stat.size > maxBytes) {
			return undefined;
		}
		raw = await fs.promises.readFile(file, 'utf8');
	} catch {
		return undefined;
	}
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

export async function searchChatSessions(
	query: string,
	options: SessionSearchOptions = {},
): Promise<SessionSearchMatch[]> {
	const trimmed = query.trim();
	if (!trimmed) {
		return [];
	}
	const limit = options.limit ?? DEFAULT_LIMIT;
	const maxPerSession = options.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
	const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	const { regex, terms } = compileQuery(trimmed);
	if (!regex && terms.length === 0) {
		return [];
	}

	const root = storeRoot();
	const index = await readJsonTolerant(path.join(root, 'index.json'), maxFileBytes) as IndexFileShape | undefined;
	const metaById = new Map<string, { title: string; updatedAt: number }>();
	for (const meta of index?.sessions ?? []) {
		if (typeof meta?.id === 'string') {
			metaById.set(meta.id, {
				title: typeof meta.title === 'string' && meta.title.trim() ? meta.title : meta.id,
				updatedAt: typeof meta.updatedAt === 'number' ? meta.updatedAt : 0,
			});
		}
	}

	let files: string[] = [];
	try {
		files = (await fs.promises.readdir(path.join(root, 'sessions')))
			.filter(name => name.endsWith('.json'))
			.map(name => path.join(root, 'sessions', name));
	} catch {
		return [];
	}

	const perSession = new Map<string, SessionSearchMatch[]>();
	await Promise.all(files.map(async file => {
		const sessionId = path.basename(file, '.json');
		const session = await readJsonTolerant(file, maxFileBytes) as SessionFileShape | undefined;
		const messages = session?.messages;
		if (!Array.isArray(messages)) {
			return;
		}
		let sessionMatchCount = 0;
		const hits: SessionSearchMatch[] = [];
		for (const message of messages) {
			const content = flattenText(message?.content);
			if (!content) {
				continue;
			}
			const role = message?.role === 'user' || message?.role === 'assistant' || message?.role === 'system'
				? message.role
				: 'assistant';
			let matchCount = 0;
			let firstIndex = -1;
			if (regex) {
				regex.lastIndex = 0;
				let m: RegExpExecArray | null;
				while ((m = regex.exec(content)) !== null) {
					if (matchCount === 0) {
						firstIndex = m.index;
					}
					matchCount++;
					if (m.index === regex.lastIndex) {
						regex.lastIndex++; // zero-width match guard
					}
				}
			} else {
				let allTermsHit = true;
				let firstTermIndex = content.length;
				for (const term of terms) {
					const occurrences = countOccurrences(content, term);
					if (occurrences === 0) {
						allTermsHit = false;
						break;
					}
					matchCount += occurrences;
					const at = content.toLowerCase().indexOf(term);
					if (at !== -1 && at < firstTermIndex) {
						firstTermIndex = at;
					}
				}
				if (allTermsHit) {
					firstIndex = firstTermIndex;
				} else {
					matchCount = 0;
				}
			}
			if (matchCount === 0) {
				continue;
			}
			sessionMatchCount += matchCount;
			if (hits.length < maxPerSession) {
				const meta = metaById.get(sessionId);
				hits.push({
					sessionId,
					title: meta?.title ?? sessionId,
					updatedAt: meta?.updatedAt ?? 0,
					role,
					snippet: snippetAround(content, firstIndex === -1 ? 0 : firstIndex),
					matchCount,
					sessionMatchCount: 0, // filled once the session scan completes
				});
			}
		}
		if (hits.length > 0) {
			for (const hit of hits) {
				hit.sessionMatchCount = sessionMatchCount;
			}
			perSession.set(sessionId, hits);
		}
	}));

	// Rank sessions by hit count, then recency; flatten best hits per session.
	const ranked = [...perSession.values()].sort((a, b) => {
		const byHits = (b[0]?.sessionMatchCount ?? 0) - (a[0]?.sessionMatchCount ?? 0);
		if (byHits !== 0) {
			return byHits;
		}
		return (b[0]?.updatedAt ?? 0) - (a[0]?.updatedAt ?? 0);
	});
	const matches = ranked.flat();
	return matches.slice(0, limit);
}
