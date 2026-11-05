/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Chat scene backgrounds. The homepage picture covers the page. On a Worker
 * page the picture stays in the side gutters and the center column is solid.
 *
 * Local entries are files shipped with the extension or picked on this machine.
 * Unsplash entries are free photos. The built-in list is a fallback. With an
 * Access Key the picker browses Unsplash topics (their categories) through
 * api.unsplash.com and hotlinks images.unsplash.com. `fit=max` keeps the CDN
 * from upscaling; the width cap is high enough to keep the original pixels.
 */

import { createHash } from 'crypto';
import * as path from 'path';

export const CHAT_SCENE_STATE_KEY = 'zcode.chatScene';
export const DEFAULT_CHAT_SCENE_ID = 'bundled:pastoral';
export const CHAT_SCENE_NONE = 'none';

const MAX_LOCAL_FILES = 8;
const MAX_UNSPLASH_PICKS = 12;
/** Originals are often wider than 6000. fit=max will not upscale past the file. */
const UNSPLASH_FULL_WIDTH = 12000;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp']);

export interface ChatSceneFile {
	id: string;
	path: string;
	name: string;
}

/** A photo the user picked from the live Unsplash catalog. */
export interface SavedUnsplashScene {
	id: string;
	label: string;
	author: string;
	authorUrl: string;
	image: string;
	thumb: string;
	width: number;
	height: number;
	/** Full-resolution copy downloaded into global storage, when cached. */
	localPath?: string;
}

export interface PersistedChatScene {
	selectedId: string;
	files: ChatSceneFile[];
	unsplash: SavedUnsplashScene[];
}

export interface ChatSceneDef {
	id: string;
	label: string;
	group: 'local' | 'unsplash';
	file?: string;
	photo?: string;
	/** CSS object-position. Pastoral art is biased upward so the sky stays in the top gutter. */
	position?: string;
}

export const BUNDLED_CHAT_SCENES: readonly ChatSceneDef[] = [
	{ id: 'bundled:pastoral', label: '田园', group: 'local', file: 'pastoral-scene.jpg', position: 'center 38%' },
	{ id: 'bundled:anime-4k', label: '田园 4K', group: 'local', file: 'anime-pastoral-4k.jpg', position: 'center 38%' },
];

/** Free Unsplash photos. First two are on the Wallpapers topic as of 2026-11-05. */
export const UNSPLASH_CHAT_SCENES: readonly ChatSceneDef[] = [
	{ id: 'unsplash:photo-1790655725655-2d4ffa2231fa', label: '雪山倒影', group: 'unsplash', photo: 'photo-1790655725655-2d4ffa2231fa' },
	{ id: 'unsplash:photo-1793189288803-5fbc6572f75e', label: '雨窗', group: 'unsplash', photo: 'photo-1793189288803-5fbc6572f75e' },
	{ id: 'unsplash:photo-1506744038136-46273834b3fb', label: '山谷', group: 'unsplash', photo: 'photo-1506744038136-46273834b3fb' },
	{ id: 'unsplash:photo-1469474968028-56623f02e42e', label: '林光', group: 'unsplash', photo: 'photo-1469474968028-56623f02e42e' },
	{ id: 'unsplash:photo-1470071459604-3b5ec3a7fe05', label: '雾山', group: 'unsplash', photo: 'photo-1470071459604-3b5ec3a7fe05' },
	{ id: 'unsplash:photo-1441974231531-c6227db76b6e', label: '森林', group: 'unsplash', photo: 'photo-1441974231531-c6227db76b6e' },
	{ id: 'unsplash:photo-1501785888041-af3ef285b470', label: '湖岸', group: 'unsplash', photo: 'photo-1501785888041-af3ef285b470' },
	{ id: 'unsplash:photo-1519681393784-d120267933ba', label: '星空', group: 'unsplash', photo: 'photo-1519681393784-d120267933ba' },
	{ id: 'unsplash:photo-1464822759023-fed622ff2c3b', label: '雪山', group: 'unsplash', photo: 'photo-1464822759023-fed622ff2c3b' },
	{ id: 'unsplash:photo-1439066615861-d1af74d74000', label: '湖边', group: 'unsplash', photo: 'photo-1439066615861-d1af74d74000' },
	{ id: 'unsplash:photo-1507525428034-b723cf961d3e', label: '海滩', group: 'unsplash', photo: 'photo-1507525428034-b723cf961d3e' },
	{ id: 'unsplash:photo-1418065460487-3e41a6c84dc5', label: '晨雾', group: 'unsplash', photo: 'photo-1418065460487-3e41a6c84dc5' },
	{ id: 'unsplash:photo-1475924156734-496f6cac6ec1', label: '晚霞', group: 'unsplash', photo: 'photo-1475924156734-496f6cac6ec1' },
	{ id: 'unsplash:photo-1472214103451-9374bd1c798e', label: '草地', group: 'unsplash', photo: 'photo-1472214103451-9374bd1c798e' },
];

const KNOWN_SCENE_IDS = new Set<string>([
	CHAT_SCENE_NONE,
	...BUNDLED_CHAT_SCENES.map(scene => scene.id),
	...UNSPLASH_CHAT_SCENES.map(scene => scene.id),
]);

/** Width is a cap. The CDN serves the original when it is smaller. */
export function unsplashImageUrl(photo: string, width = UNSPLASH_FULL_WIDTH, quality = 92): string {
	const capped = Math.max(1, Math.min(Math.round(width) || UNSPLASH_FULL_WIDTH, UNSPLASH_FULL_WIDTH));
	return `https://images.unsplash.com/${photo}?fm=jpg&fit=max&w=${capped}&q=${quality}`;
}

export function isUnsplashImageUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && url.hostname === 'images.unsplash.com';
	} catch {
		return false;
	}
}

const UNSPLASH_ID = /^unsplash:[A-Za-z0-9_-]{1,80}$/;

export function parseSavedUnsplash(value: unknown): SavedUnsplashScene | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const row = value as Record<string, unknown>;
	if (typeof row.id !== 'string' || !UNSPLASH_ID.test(row.id)) {
		return undefined;
	}
	if (typeof row.image !== 'string' || !isUnsplashImageUrl(row.image)) {
		return undefined;
	}
	if (typeof row.thumb !== 'string' || !isUnsplashImageUrl(row.thumb)) {
		return undefined;
	}
	const label = typeof row.label === 'string' ? row.label.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
	const author = typeof row.author === 'string' ? row.author.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
	let authorUrl = '';
	if (typeof row.authorUrl === 'string' && row.authorUrl.startsWith('https://unsplash.com/')) {
		try {
			const url = new URL(row.authorUrl);
			if (url.protocol === 'https:' && url.hostname === 'unsplash.com') {
				authorUrl = url.toString();
			}
		} catch {
			authorUrl = '';
		}
	}
	const width = typeof row.width === 'number' && row.width > 0 ? Math.round(row.width) : 0;
	const height = typeof row.height === 'number' && row.height > 0 ? Math.round(row.height) : 0;
	const localPath = typeof row.localPath === 'string' && path.isAbsolute(row.localPath)
		? row.localPath.slice(0, 1024)
		: '';
	return {
		id: row.id,
		label: label || author || 'Unsplash',
		author,
		authorUrl,
		image: row.image,
		thumb: row.thumb,
		width,
		height,
		localPath: localPath || undefined,
	};
}

export function findCatalogScene(id: string): ChatSceneDef | undefined {
	return BUNDLED_CHAT_SCENES.find(scene => scene.id === id)
		?? UNSPLASH_CHAT_SCENES.find(scene => scene.id === id);
}

export function isSceneImagePath(fsPath: string): boolean {
	return IMAGE_EXT.has(path.extname(fsPath).toLowerCase());
}

export function sceneFileId(fsPath: string): string {
	return `file:${createHash('sha1').update(fsPath).digest('hex').slice(0, 12)}`;
}

export function readPersistedChatScene(value: unknown): PersistedChatScene {
	const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
	const selectedId = typeof raw.selectedId === 'string' && raw.selectedId
		? raw.selectedId
		: DEFAULT_CHAT_SCENE_ID;
	const files: ChatSceneFile[] = [];
	if (Array.isArray(raw.files)) {
		for (const item of raw.files) {
			if (!item || typeof item !== 'object') {
				continue;
			}
			const row = item as Record<string, unknown>;
			if (typeof row.path !== 'string' || typeof row.id !== 'string' || typeof row.name !== 'string') {
				continue;
			}
			if (!row.id.startsWith('file:') || !isSceneImagePath(row.path)) {
				continue;
			}
			files.push({ id: row.id, path: row.path, name: row.name });
			if (files.length >= MAX_LOCAL_FILES) {
				break;
			}
		}
	}
	const unsplash: SavedUnsplashScene[] = [];
	if (Array.isArray(raw.unsplash)) {
		for (const item of raw.unsplash) {
			const pick = parseSavedUnsplash(item);
			if (!pick || unsplash.some(saved => saved.id === pick.id)) {
				continue;
			}
			unsplash.push(pick);
			if (unsplash.length >= MAX_UNSPLASH_PICKS) {
				break;
			}
		}
	}
	return { selectedId, files, unsplash };
}

export function rememberSceneFile(state: PersistedChatScene, fsPath: string): PersistedChatScene {
	const id = sceneFileId(fsPath);
	const name = path.basename(fsPath);
	const files = [
		{ id, path: fsPath, name },
		...state.files.filter(file => file.path !== fsPath && file.id !== id),
	].slice(0, MAX_LOCAL_FILES);
	return { selectedId: id, files, unsplash: state.unsplash };
}

export function rememberUnsplashPick(state: PersistedChatScene, pick: SavedUnsplashScene): PersistedChatScene {
	// Re-picking an already cached photo keeps its local copy.
	const existing = state.unsplash.find(item => item.id === pick.id);
	const merged = existing?.localPath && !pick.localPath ? { ...pick, localPath: existing.localPath } : pick;
	const unsplash = [
		merged,
		...state.unsplash.filter(item => item.id !== pick.id),
	].slice(0, MAX_UNSPLASH_PICKS);
	return { ...state, selectedId: pick.id, unsplash };
}

export function selectionIsKnown(state: PersistedChatScene, id: string): boolean {
	if (id === CHAT_SCENE_NONE || KNOWN_SCENE_IDS.has(id)) {
		return true;
	}
	if (state.files.some(file => file.id === id)) {
		return true;
	}
	return state.unsplash.some(item => item.id === id);
}
