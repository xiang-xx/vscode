/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live Unsplash wallpaper catalog.
 *
 * Official API: https://unsplash.com/documentation
 *   Authorization: Client-ID <Access Key>
 *   GET /topics, GET /topics/:slug/photos
 * The website's /napi list is behind a bot wall and is not used.
 * Images stay on images.unsplash.com. Choosing a photo pings the download
 * endpoint so the photographer gets the download credit Unsplash requires.
 */

import { parseSavedUnsplash, type SavedUnsplashScene } from './chatScene';

const API = 'https://api.unsplash.com';
const PER_PAGE = 16;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface UnsplashTopic {
	slug: string;
	title: string;
}

/** Featured topics on unsplash.com, used when the topics call fails. */
export const UNSPLASH_TOPIC_FALLBACK: readonly UnsplashTopic[] = [
	{ slug: 'wallpapers', title: 'Wallpapers' },
	{ slug: 'nature', title: 'Nature' },
	{ slug: '3d-renders', title: '3D Renders' },
	{ slug: 'textures-patterns', title: 'Textures & Patterns' },
	{ slug: 'architecture-interior', title: 'Architecture & Interiors' },
	{ slug: 'travel', title: 'Travel' },
	{ slug: 'film', title: 'Film' },
	{ slug: 'street-photography', title: 'Street Photography' },
	{ slug: 'experimental', title: 'Experimental' },
	{ slug: 'animals', title: 'Animals' },
	{ slug: 'food-drink', title: 'Food & Drink' },
	{ slug: 'athletics', title: 'Athletics' },
];

export interface UnsplashBrowsePage {
	topic: string;
	page: number;
	topics: UnsplashTopic[];
	photos: SavedUnsplashScene[];
	hasMore: boolean;
}

export class UnsplashKeyRejectedError extends Error {
	constructor() {
		super('Access Key 无效');
	}
}

export function unsplashErrorMessage(status: number): string {
	if (status === 401) {
		return 'Access Key 无效';
	}
	if (status === 403) {
		return '这个应用还不能读 Unsplash 目录';
	}
	if (status === 404) {
		return '没有这个分类';
	}
	if (status === 429) {
		return 'Unsplash 请求太频繁，过一会儿再加载';
	}
	return '拉不到 Unsplash 目录';
}

export function parseUnsplashTopics(value: unknown): UnsplashTopic[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const rows: Array<UnsplashTopic & { featured: boolean }> = [];
	for (const item of value) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const row = item as Record<string, unknown>;
		const slug = typeof row.slug === 'string' ? row.slug : '';
		const title = typeof row.title === 'string' ? row.title.replace(/\s+/g, ' ').trim() : '';
		if (!SLUG.test(slug) || !title) {
			continue;
		}
		rows.push({
			slug,
			title: title.slice(0, 48),
			featured: row.featured === true || row.visibility === 'featured',
		});
	}
	const featured = rows.filter(topic => topic.featured);
	const source = featured.length >= 4 ? featured : rows;
	const ordered = [
		...source.filter(topic => topic.slug === 'wallpapers'),
		...source.filter(topic => topic.slug !== 'wallpapers'),
	];
	const seen = new Set<string>();
	const topics: UnsplashTopic[] = [];
	for (const topic of ordered) {
		if (seen.has(topic.slug)) {
			continue;
		}
		seen.add(topic.slug);
		topics.push({ slug: topic.slug, title: topic.title });
		if (topics.length >= 20) {
			break;
		}
	}
	if (!topics.some(topic => topic.slug === 'wallpapers')) {
		topics.unshift(UNSPLASH_TOPIC_FALLBACK[0]);
	}
	return topics.slice(0, 20);
}

/** Hotlink at the photo's own width. fit=max does not enlarge a smaller file. */
export function unsplashWallpaperUrl(raw: string, width: number, quality = 92): string | undefined {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return undefined;
	}
	if (url.protocol !== 'https:' || url.hostname !== 'images.unsplash.com') {
		return undefined;
	}
	const capped = Math.max(1, Math.min(Math.round(width) || 12000, 12000));
	url.searchParams.set('fm', 'jpg');
	url.searchParams.set('fit', 'max');
	const q = Math.max(40, Math.min(Math.round(quality) || 92, 100));
	url.searchParams.set('q', String(q));
	url.searchParams.set('w', String(capped));
	url.searchParams.delete('auto');
	url.searchParams.delete('crop');
	url.searchParams.delete('h');
	url.searchParams.delete('dpr');
	return url.toString();
}

export function parseUnsplashPhotos(value: unknown): SavedUnsplashScene[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const photos: SavedUnsplashScene[] = [];
	for (const item of value) {
		const pick = parseUnsplashPhoto(item);
		if (pick && !photos.some(saved => saved.id === pick.id)) {
			photos.push(pick);
		}
	}
	return photos;
}

function parseUnsplashPhoto(value: unknown): SavedUnsplashScene | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const row = value as Record<string, unknown>;
	if (row.premium === true || row.plus === true) {
		return undefined;
	}
	const photoId = typeof row.id === 'string' ? row.id : '';
	if (!/^[A-Za-z0-9_-]{1,80}$/.test(photoId)) {
		return undefined;
	}
	const width = typeof row.width === 'number' && row.width > 0 ? Math.round(row.width) : 0;
	const height = typeof row.height === 'number' && row.height > 0 ? Math.round(row.height) : 0;
	const urls = row.urls && typeof row.urls === 'object' ? row.urls as Record<string, unknown> : {};
	const raw = typeof urls.raw === 'string' ? urls.raw : '';
	const image = unsplashWallpaperUrl(raw, width || 12000);
	const thumb = unsplashWallpaperUrl(typeof urls.small === 'string' ? urls.small : raw, 640, 75);
	if (!image || !thumb) {
		return undefined;
	}
	const user = row.user && typeof row.user === 'object' ? row.user as Record<string, unknown> : {};
	const author = typeof user.name === 'string' ? user.name.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
	const username = typeof user.username === 'string' ? user.username : '';
	const authorUrl = /^[A-Za-z0-9_-]{1,80}$/.test(username)
		? `https://unsplash.com/@${username}?utm_source=zcode&utm_medium=referral`
		: '';
	const description = typeof row.alt_description === 'string' && row.alt_description.trim()
		? row.alt_description
		: (typeof row.description === 'string' ? row.description : '');
	const label = description.replace(/\s+/g, ' ').trim().slice(0, 80) || author || 'Unsplash';
	return parseSavedUnsplash({
		id: `unsplash:${photoId}`,
		label,
		author,
		authorUrl,
		image,
		thumb,
		width,
		height,
	});
}

async function unsplashJson(key: string, path: string): Promise<{ json: unknown; total: number | undefined }> {
	let response: Response;
	try {
		response = await fetch(`${API}${path}`, {
			headers: {
				Authorization: `Client-ID ${key}`,
				'Accept-Version': 'v1',
				Accept: 'application/json',
			},
			signal: AbortSignal.timeout(20000),
		});
	} catch {
		throw new Error('连不上 Unsplash');
	}
	const totalHeader = response.headers.get('x-total');
	const totalValue = totalHeader ? Number(totalHeader) : NaN;
	if (response.status === 401) {
		throw new UnsplashKeyRejectedError();
	}
	if (!response.ok) {
		throw new Error(unsplashErrorMessage(response.status));
	}
	try {
		const json: unknown = await response.json();
		return { json, total: Number.isFinite(totalValue) ? totalValue : undefined };
	} catch {
		throw new Error('拉不到 Unsplash 目录');
	}
}

export async function fetchUnsplashBrowse(
	key: string,
	slug: string,
	page: number,
	knownTopics: readonly UnsplashTopic[] | null,
): Promise<UnsplashBrowsePage> {
	const topic = SLUG.test(slug) ? slug : 'wallpapers';
	const safePage = Math.max(1, Math.min(Math.floor(page) || 1, 40));
	let topics = knownTopics && knownTopics.length ? [...knownTopics] : [];
	if (!topics.length) {
		try {
			const listed = await unsplashJson(key, '/topics?per_page=30&order_by=featured');
			topics = parseUnsplashTopics(listed.json);
		} catch {
			topics = [...UNSPLASH_TOPIC_FALLBACK];
		}
		if (!topics.length) {
			topics = [...UNSPLASH_TOPIC_FALLBACK];
		}
	}
	const loaded = await unsplashJson(
		key,
		`/topics/${encodeURIComponent(topic)}/photos?page=${safePage}&per_page=${PER_PAGE}`,
	);
	const photos = parseUnsplashPhotos(loaded.json);
	const reachedEnd = loaded.total !== undefined && safePage * PER_PAGE >= loaded.total;
	return {
		topic,
		page: safePage,
		topics,
		photos,
		hasMore: photos.length === PER_PAGE && !reachedEnd,
	};
}

/** Unsplash requires this when a photo is actually used. Failures are ignored. */
export async function trackUnsplashDownload(key: string, photoId: string): Promise<void> {
	if (!key || !/^[A-Za-z0-9_-]{1,80}$/.test(photoId)) {
		return;
	}
	try {
		await fetch(`${API}/photos/${encodeURIComponent(photoId)}/download`, {
			headers: {
				Authorization: `Client-ID ${key}`,
				'Accept-Version': 'v1',
			},
			signal: AbortSignal.timeout(15000),
		});
	} catch {
		// The wallpaper still applies if the credit ping fails.
	}
}
