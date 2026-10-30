/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cross-session occupancy brief so concurrent chats avoid stepping on each other.
 * Soft guidance in the prompt + hard guards at write time (see agentRuntime / FileEditSession).
 */

export interface PeerSessionInfo {
	id: string;
	title: string;
	running: boolean;
	/** Incomplete todo headlines from that session. */
	todos: string[];
	/** Recent tool summaries from that session's timeline. */
	recentTools: string[];
}

export interface ForeignFileInfo {
	path: string;
	kind: string;
	ownerSessionId: string;
	ownerTitle?: string;
}

export interface SessionAwareness {
	sessionId: string;
	peers: PeerSessionInfo[];
	foreignFiles: ForeignFileInfo[];
}

/** Prompt block injected into ZCode system / Cursor ACP preamble. */
export function formatSessionAwareness(ctx: SessionAwareness | undefined): string {
	if (!ctx) {
		return '';
	}
	const hasPeers = ctx.peers.length > 0;
	const hasFiles = ctx.foreignFiles.length > 0;
	if (!hasPeers && !hasFiles) {
		return '';
	}

	const lines: string[] = [
		'<concurrent-sessions>',
		'Other IDE chat sessions share this workspace. Do not duplicate their work or overwrite their pending files.',
		`Your session id: ${ctx.sessionId}`,
	];

	if (hasPeers) {
		lines.push('Peer sessions:');
		for (const peer of ctx.peers) {
			const state = peer.running ? 'running' : 'idle';
			lines.push(`- [${peer.id}] "${peer.title}" (${state})`);
			for (const todo of peer.todos.slice(0, 5)) {
				lines.push(`  todo: ${todo}`);
			}
			for (const tool of peer.recentTools.slice(0, 5)) {
				lines.push(`  recent: ${tool}`);
			}
		}
	}

	if (hasFiles) {
		lines.push('Files with pending edits from other sessions (do not write these unless the user explicitly asks):');
		for (const file of ctx.foreignFiles) {
			const who = file.ownerTitle ? `"${file.ownerTitle}"` : file.ownerSessionId;
			lines.push(`- ${file.path} (${file.kind}, owned by ${who})`);
		}
	}

	lines.push('If you need a peer-owned file, Read it only; ask the user before conflicting edits.');
	lines.push('</concurrent-sessions>');
	return lines.join('\n');
}
