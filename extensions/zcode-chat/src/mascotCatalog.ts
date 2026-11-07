/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Chat mascots: Live2D chibi companions that sit beside the composer.
 *
 * Models are the free Live2D sample characters (Cubism 4 format). We do not
 * ship them in the repo; the first use downloads the model's files from the
 * official sample repository through jsDelivr into the extension's media dir
 * (gitignored `media/mascots/`), then the webview loads them through a webview
 * URI. The sample-data license allows personal use and modification, and
 * per-user download from the same public source keeps redistribution rules
 * intact.
 *
 * Storage lives under the extension dir (not global storage) because this
 * fork's webview resource loader 401s global-storage paths even when they are
 * declared in localResourceRoots, while extension-dir paths serve reliably.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { isMascotPersonaId } from './mascotPersona';

export const CHAT_MASCOT_STATE_KEY = 'zcode.chatMascot';
export const MASCOTS_DIR_NAME = 'mascots';

export const MASCOT_SIZE_OPTIONS = ['small', 'medium', 'large'] as const;
export type ChatMascotSize = typeof MASCOT_SIZE_OPTIONS[number];

/** Legacy preset chips -> CSS-pixel height, kept for configs saved by older versions. */
const MASCOT_SIZE_PRESET_PX: Record<ChatMascotSize, number> = { small: 220, medium: 300, large: 380 };
export function mascotSizeToPx(size: ChatMascotSize): number {
	return MASCOT_SIZE_PRESET_PX[size] ?? MASCOT_SIZE_PRESET_PX.medium;
}

/** Size slider range, in CSS pixels of on-screen height. */
export const MASCOT_SIZE_MIN = 160;
export const MASCOT_SIZE_MAX = 1000;
export const MASCOT_SIZE_STEP = 10;

/** Up to three slots queue on the right side of the composer. */

const MODEL3_GLOB = '.model3.json';
const COMPLETE_MARKER = '.zcode-complete';
/**
 * Default jsDelivr GitHub source. Catalog entries may override both the repo
 * ("owner/name@ref") and the in-repo path prefix, so models from other public
 * GitHub repos download through the same per-user mechanism. Pinned to a
 * commit: the official repo updates samples in place (Ren became an
 * unloadable moc3 v6 in 2025-08), and pins keep downloads reproducible.
 */
const DEFAULT_REPO = 'Live2D/CubismWebSamples@ed1e0b714826d92469b9e51cacc3346f4e393f03';
const DEFAULT_ROOT = 'Samples/Resources';

function repoRef(entry: MascotCatalog): string {
	return entry.repo ?? DEFAULT_REPO;
}

function repoRoot(entry: MascotCatalog): string {
	return entry.repoRoot ?? DEFAULT_ROOT;
}

/** raw.githubusercontent.com wants owner/repo/<ref>/path; jsDelivr uses name@ref. */
function rawRepoParts(entry: MascotCatalog): { ownerRepo: string; ref: string } {
	const repo = repoRef(entry);
	const at = repo.indexOf('@');
	return at >= 0
		? { ownerRepo: repo.slice(0, at), ref: repo.slice(at + 1) }
		: { ownerRepo: repo, ref: 'master' };
}

export interface MascotCatalogEntry {
	/** Stable id, also the storage folder name. */
	id: string;
	/** Display name (Chinese) shown in the picker. */
	label: string;
	/** English source name, useful when reporting errors. */
	source: string;
	/** Rough download size in MB, for the picker hint. */
	sizeMB: number;
}

export interface MascotCatalog {
	id: string;
	label: string;
	source: string;
	/** Folder inside the source repo root. */
	folder: string;
	model3: string;
	sizeMB: number;
	/** GitHub source "owner/name@ref" for jsDelivr; defaults to the official samples repo. */
	repo?: string;
	/** Path prefix inside the repo; defaults to "Samples/Resources". */
	repoRoot?: string;
	/**
	 * Download from raw.githubusercontent.com instead of jsDelivr. Needed for
	 * repos over jsDelivr's 50MB package limit (game-rip collections); the
	 * file list comes from the model3.json references instead of the CDN tree.
	 */
	origin?: 'raw';
	/** Tooltip hint about where this model comes from. */
	note?: string;
}

/**
 * Official sample characters plus curated mirrors from public GitHub
 * collections (personal-use forks only: several entries are game-rip models
 * with unclear redistribution terms, so they download per-user from the same
 * public source instead of shipping in this repo).
 *
 * Sources:
 * - Live2D/CubismWebSamples (official, jsDelivr)
 * - hajimikitty/oc-assets (official/free sample mirrors + covers, raw)
 * - Eikanya/Live2d-model, jianchengwang/live2d_models (game rips, raw)
 * Refs are pinned to commits so paths stay stable.
 */
const OC_ASSETS_REPO = 'hajimikitty/oc-assets@9bc81ad59b6423118a059ffd4cc61acb78ee3544';
const OC_ASSETS_ROOT = 'live2d-models';
const EIKANYA_REPO = 'Eikanya/Live2d-model@7e446cbd95ec352cdb0f73c079e4d075d7d528ac';
const FOXHIME_ROOT = 'galgame live2d/Fox Hime Zero';
const JCW_REPO = 'jianchengwang/live2d_models@5576426791fd0acce133208fd0d1969076280d56';
const JCW_ROOT = 'assets/model/moc3';
const NOTE_GAME = '游戏提取模型 · 仅个人使用';

export const MASCOT_CATALOG: readonly MascotCatalog[] = [
	// Official Cubism samples (jsDelivr, same as before).
	{ id: 'wanko', label: '小汪', source: 'Wanko', folder: 'Wanko', model3: 'Wanko.model3.json', sizeMB: 0.7 },
	{ id: 'rice', label: '米粒', source: 'Rice', folder: 'Rice', model3: 'Rice.model3.json', sizeMB: 2.5 },
	{ id: 'haru', label: '小春', source: 'Haru', folder: 'Haru', model3: 'Haru.model3.json', sizeMB: 5.8 },
	{ id: 'hiyori', label: '日和', source: 'Hiyori', folder: 'Hiyori', model3: 'Hiyori.model3.json', sizeMB: 3.6 },
	{ id: 'mao', label: '真绪', source: 'Mao', folder: 'Mao', model3: 'Mao.model3.json', sizeMB: 3.9 },
	{ id: 'mark', label: '马克', source: 'Mark', folder: 'Mark', model3: 'Mark.model3.json', sizeMB: 4.6 },
	{ id: 'natori', label: '纳托里', source: 'Natori', folder: 'Natori', model3: 'Natori.model3.json', sizeMB: 4.4 },
	// Official / free sample mirrors from oc-assets (Cubism 4/5).
	{ id: 'kei', label: 'Kei', source: 'Kei (lip-sync sample)', repo: OC_ASSETS_REPO, repoRoot: OC_ASSETS_ROOT, origin: 'raw', note: '官方样例镜像 · 支持口型同步', folder: 'kei', model3: 'kei_basic_free.model3.json', sizeMB: 12.9 },
	{ id: 'miara', label: '米亚拉', source: 'Miara Pro (full-body sample)', repo: OC_ASSETS_REPO, repoRoot: OC_ASSETS_ROOT, origin: 'raw', note: '官方样例镜像 · 全身动作', folder: 'miara', model3: 'miara_pro_t03.model3.json', sizeMB: 13.5 },
	{ id: 'hibiki', label: '响', source: 'Hibiki', repo: OC_ASSETS_REPO, repoRoot: OC_ASSETS_ROOT, origin: 'raw', note: '官方样例镜像', folder: 'hibiki', model3: 'hibiki.model3.json', sizeMB: 4.0 },
	{ id: 'izumi', label: '泉', source: 'Izumi', repo: OC_ASSETS_REPO, repoRoot: OC_ASSETS_ROOT, origin: 'raw', note: '官方样例镜像', folder: 'izumi', model3: 'izumi_illust.model3.json', sizeMB: 6.5 },
	{ id: 'haruto', label: '春人', source: 'Haruto (Koharu & Haruto)', repo: OC_ASSETS_REPO, repoRoot: OC_ASSETS_ROOT, origin: 'raw', note: '官方样例镜像', folder: 'koharu-and-haruto', model3: 'haruto.model3.json', sizeMB: 1.5 },
	{ id: 'gantzert', label: '钢铁双雄', source: 'Gantzert & Felixander', repo: OC_ASSETS_REPO, repoRoot: OC_ASSETS_ROOT, origin: 'raw', note: '官方样例镜像 · 机器人双人组', folder: 'gantzert-and-felixander', model3: 'Gantzert_Felixander.model3.json', sizeMB: 13.8 },
	{ id: 'chitose', label: '千岁', source: 'Chitose', repo: OC_ASSETS_REPO, repoRoot: OC_ASSETS_ROOT, origin: 'raw', note: '官方样例镜像', folder: 'chitose', model3: 'chitose.model3.json', sizeMB: 2.0 },
	{ id: 'epsilon', label: 'Epsilon', source: 'Epsilon', repo: OC_ASSETS_REPO, repoRoot: OC_ASSETS_ROOT, origin: 'raw', note: '免费模型镜像', folder: 'epsilon', model3: 'Epsilon.model3.json', sizeMB: 2.6 },
	{ id: 'goth-mofu', label: '哥特Mofu', source: 'Goth L2D (Mofu)', repo: OC_ASSETS_REPO, repoRoot: OC_ASSETS_ROOT, origin: 'raw', note: '免费模型镜像', folder: 'goth-mofu', model3: 'GothL2D.model3.json', sizeMB: 7.9 },
	{ id: 'slime', label: '史莱姆', source: 'Free Slime Model (Rhaps)', repo: OC_ASSETS_REPO, repoRoot: OC_ASSETS_ROOT, origin: 'raw', note: '免费模型镜像', folder: 'free-slime-model-rhaps', model3: 'SlimeModel.model3.json', sizeMB: 6.6 },
	{ id: 'hijiki', label: '黑猫Hijiki', source: 'Hijiki (Tororo & Hijiki)', repo: OC_ASSETS_REPO, repoRoot: OC_ASSETS_ROOT, origin: 'raw', note: '官方样例镜像 · 黑猫', folder: 'tororo-and-hijiki', model3: 'hijiki.model3.json', sizeMB: 1.3 },
	{ id: 'hiyori-pro', label: '日和·Pro', source: 'Hiyori Pro t11', repo: OC_ASSETS_REPO, repoRoot: OC_ASSETS_ROOT, origin: 'raw', note: '官方样例镜像 · 动作更丰富', folder: 'hiyori-momose', model3: 'hiyori_pro_t11.model3.json', sizeMB: 4.7 },
	{ id: 'haru-greeter', label: '小春·前台', source: 'Haru greeter t05', repo: OC_ASSETS_REPO, repoRoot: OC_ASSETS_ROOT, origin: 'raw', note: '官方样例镜像 · 前台制服版', folder: 'haru-receptionist-version', model3: 'haru_greeter_t05.model3.json', sizeMB: 3.4 },
	{ id: 'shizuku', label: '雫', source: 'Shizuku (Cubism 3)', repo: OC_ASSETS_REPO, repoRoot: OC_ASSETS_ROOT, origin: 'raw', note: '经典样例 · moc3 重制版', folder: 'shizuku', model3: 'shizuku.model3.json', sizeMB: 5.0 },
	{ id: 'wanko-touch', label: '汪汪·Touch', source: 'Wanko touch (wankoromochi)', repo: OC_ASSETS_REPO, repoRoot: OC_ASSETS_ROOT, origin: 'raw', note: '官方样例镜像', folder: 'wankoromochi', model3: 'wanko_touch.model3.json', sizeMB: 0.8 },
	{ id: 'nito', label: 'Nito', source: 'Nito', repo: OC_ASSETS_REPO, repoRoot: OC_ASSETS_ROOT, origin: 'raw', note: '官方样例镜像', folder: 'nito', model3: 'nito.model3.json', sizeMB: 11.2 },
	// Game-rip models (personal use only).
	{ id: 'senko', label: '仙狐小姐', source: 'Senko (Sewayaki Kitsune)', repo: EIKANYA_REPO, repoRoot: 'Live2D', origin: 'raw', note: NOTE_GAME, folder: 'Senko_Normals', model3: 'senko.model3.json', sizeMB: 7.8 },
	{ id: 'mori-miko', label: '森·巫女', source: 'Fox Hime Zero · mori_miko', repo: EIKANYA_REPO, repoRoot: FOXHIME_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'mori_miko', model3: 'mori_miko.model3.json', sizeMB: 6.0 },
	{ id: 'ruri-miko', label: '琉璃·巫女', source: 'Fox Hime Zero · ruri_miko', repo: EIKANYA_REPO, repoRoot: FOXHIME_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'ruri_miko', model3: 'ruri_miko.model3.json', sizeMB: 6.0 },
	{ id: 'mori-suit', label: '森·西装', source: 'Fox Hime Zero · mori_suit', repo: EIKANYA_REPO, repoRoot: FOXHIME_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'mori_suit', model3: 'mori_suit.model3.json', sizeMB: 6.0 },
	{ id: 'lafei', label: '拉菲', source: 'Laffey (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'lafei', model3: 'lafei.model3.json', sizeMB: 3.4 },
	{ id: 'mingshi', label: '明石', source: 'Akashi (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'mingshi', model3: 'mingshi.model3.json', sizeMB: 1.7 },
	{ id: 'biaoqiang', label: '标枪', source: 'Javelin (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'biaoqiang', model3: 'biaoqiang.model3.json', sizeMB: 2.7 },
	{ id: 'lingbo', label: '绫波', source: 'Ayanami (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'lingbo', model3: 'lingbo.model3.json', sizeMB: 2.1 },
	{ id: 'xuefeng', label: '雪风', source: 'Yukikaze (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'xuefeng', model3: 'xuefeng.model3.json', sizeMB: 2.6 },
	{ id: 'xukufu', label: '絮库夫', source: 'Surcouf (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'xukufu_2', model3: 'xukufu_2.model3.json', sizeMB: 3.7 },
	{ id: 'chuixue', label: '吹雪', source: 'Fubuki (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'chuixue_3', model3: 'chuixue_3.model3.json', sizeMB: 4.0 },
	{ id: 'xixuegui', label: '吸血鬼', source: 'Vampire (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'xixuegui_4', model3: 'xixuegui_4.model3.json', sizeMB: 4.8 },
	{ id: 'shengluyisi', label: '圣路易斯', source: 'St. Louis (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'shengluyisi_3', model3: 'shengluyisi_3.model3.json', sizeMB: 5.7 },
	{ id: 'rangbaer', label: '让·巴尔', source: 'Jean Bart (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'rangbaer_3', model3: 'rangbaer_3.model3.json', sizeMB: 5.6 },
	{ id: 'kelifulan', label: '克利夫兰', source: 'Cleveland (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'kelifulan_3', model3: 'kelifulan_3.model3.json', sizeMB: 6.1 },
	{ id: 'aierdeliqi', label: '爱丁堡', source: 'Edinburgh (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'aierdeliqi_4', model3: 'aierdeliqi_4.model3.json', sizeMB: 5.5 },
	{ id: 'banrenma', label: '半人马', source: 'Centaur (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'banrenma_2', model3: 'banrenma_2.model3.json', sizeMB: 4.4 },
	{ id: 'heitaizi', label: '黑太子', source: 'Black Prince (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'heitaizi_2', model3: 'heitaizi_2.model3.json', sizeMB: 5.9 },
	{ id: 'pinghai', label: '平海', source: 'Ping Hai (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'pinghai_4', model3: 'pinghai_4.model3.json', sizeMB: 5.1 },
	{ id: 'xianghe', label: '翔鹤', source: 'Shoukaku (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'xianghe_2', model3: 'xianghe_2.model3.json', sizeMB: 7.3 },
	{ id: 'nengdai', label: '能代', source: 'Noshiro (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'nengdai_2', model3: 'nengdai_2.model3.json', sizeMB: 7.0 },
	{ id: 'dujiaoshou', label: '独角兽', source: 'Unicorn (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'dujiaoshou_6', model3: 'dujiaoshou_6.model3.json', sizeMB: 8.9 },
	{ id: 'huonululu', label: '火奴鲁鲁', source: 'Honolulu (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'huonululu_5', model3: 'huonululu_5.model3.json', sizeMB: 10.1 },
	{ id: 'longfeng', label: '龙凤', source: 'Ryuuhou (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'longfeng_2', model3: 'longfeng_2.model3.json', sizeMB: 8.8 },
	{ id: 'aqua-card', label: 'Aqua', source: 'Aqua (jcw)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: '1014100aqua', model3: '1014100aqua.model3.json', sizeMB: 3.3 },
	{ id: 'card-1024100', label: '1024100', source: '1024100 (jcw)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: '1024100', model3: '1024100.model3.json', sizeMB: 3.1 },
	{ id: 'card-1033113', label: '1033113', source: '1033113 (jcw)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: '1033113', model3: '1033113.model3.json', sizeMB: 2.8 },
	{ id: 'card-1044100', label: '1044100', source: '1044100 (jcw)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: '1044100', model3: '1044100.model3.json', sizeMB: 2.7 },
	{ id: 'sixxb', label: '6xb', source: '6xb (jcw)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: '6xb', model3: '6xb.model3.json', sizeMB: 12.4 },
	{ id: 'alexia', label: 'Alexia', source: 'Alexia', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'Alexia', model3: 'Alexia.model3.json', sizeMB: 27.8 },
	{ id: 'gloria', label: 'Gloria', source: 'Gloria', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'Gloria', model3: 'Gloria.model3.json', sizeMB: 16.8 },
	{ id: 'icegirl', label: 'IceGirl', source: 'IceGirl', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'IceGirl', model3: 'IceGirl.model3.json', sizeMB: 18.6 },
	{ id: 'kitu15', label: 'KITU15', source: 'KITU15', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'KITU15', model3: 'KITU15.model3.json', sizeMB: 18.6 },
	{ id: 'liveroid-y01', label: 'LiveroiD Y01', source: 'LiveroiD A-Y01', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'LiveroiD_A-Y01', model3: 'LiveroiD_A-Y01.model3.json', sizeMB: 31.2 },
	{ id: 'liveroid-y02', label: 'LiveroiD Y02', source: 'LiveroiD A-Y02', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'LiveroiD_A-Y02', model3: 'LiveroiD_A-Y02.model3.json', sizeMB: 31.2 },
	{ id: 'ariu', label: 'Ariu', source: 'Ariu', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'ariu', model3: 'ariu.model3.json', sizeMB: 18.2 },
	{ id: 'biaoqiang-3', label: '标枪（新装）', source: 'Javelin (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'biaoqiang_3', model3: 'biaoqiang_3.model3.json', sizeMB: 2.9 },
	{ id: 'edu-3', label: 'edu', source: 'edu (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'edu_3', model3: 'edu_3.model3.json', sizeMB: 4.3 },
	{ id: 'genaisennao-2', label: 'genaisennao', source: 'genaisennao (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'genaisennao_2', model3: 'genaisennao_2.model3.json', sizeMB: 5.4 },
	{ id: 'huohuo', label: '藿藿', source: 'Huohuo (Honkai: Star Rail)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'huohuo', model3: 'huohuo.model3.json', sizeMB: 51.3 },
	{ id: 'kkk', label: 'kkk', source: 'kkk (jcw)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'kkk', model3: 'kkk.model3.json', sizeMB: 0.9 },
	{ id: 'kubo-2', label: 'kubo', source: 'kubo (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'kubo_2', model3: 'kubo_2.model3.json', sizeMB: 4.1 },
	{ id: 'kyoutani-ron', label: 'Kyoutani Ron', source: 'Kyoutani Ron', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'kyoutani_ron', model3: 'kyoutani_ron.model3.json', sizeMB: 4.3 },
	{ id: 'monv', label: '魔女', source: 'Monv (jcw)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'monv', model3: 'monv.model3.json', sizeMB: 42.5 },
	{ id: 'xgw', label: 'xgw', source: 'xgw (jcw)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'xgw', model3: 'xgw.model3.json', sizeMB: 35.7 },
	{ id: 'xuefeng-3', label: '雪风（新装）', source: 'Yukikaze (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'xuefeng_3', model3: 'xuefeng_3.model3.json', sizeMB: 4.3 },
	{ id: 'lafei-4', label: '拉菲（新装）', source: 'Laffey (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'lafei_4', model3: 'lafei_4.model3.json', sizeMB: 4.0 },
	{ id: 'yichui-2', label: 'yichui', source: 'yichui (Azur Lane)', repo: JCW_REPO, repoRoot: JCW_ROOT, origin: 'raw', note: NOTE_GAME, folder: 'yichui_2', model3: 'yichui_2.model3.json', sizeMB: 8.2 },
];

export const DEFAULT_MASCOT_SLOTS: readonly string[] = ['wanko', 'rice'];

export interface PersistedChatMascot {
	enabled: boolean;
	size: ChatMascotSize;
	/** Slot -> catalog id. Empty slots are null. */
	slots: (string | null)[];
	/** Slider height in CSS px; absent in configs saved by older versions. */
	sizePx?: number;
	/** Character id -> hand-dragged position, normalized to the viewport
	 *  (x in 0..1; y is the character's feet line and may exceed 1 when the
	 *  legs sink past the fold, like the default queue overhang). Survives
	 *  re-adding. */
	positions?: { [id: string]: { x: number; y: number } };
	/** Character id -> its own display height in CSS px. Wheel-resizing a
	 *  mascot saves here; models without an entry use the global sizePx. */
	sizes?: { [id: string]: number };
	/** Catalog ids parked in the trash bin: still listed (restorable) but
	 *  filtered out of the default roster. */
	hidden?: string[];
	/** Most-recently-used catalog ids, newest first. Feeds the quick-pick
	 *  strip at the top of the picker; capped at a dozen entries. */
	recent?: string[];
	/** Character id -> chosen speaking style. Missing ids use that
	 *  character's built-in default. */
	personas?: { [id: string]: string };
}

export function defaultChatMascot(): PersistedChatMascot {
	return { enabled: false, size: 'medium', slots: DEFAULT_MASCOT_SLOTS.map(id => id.toLowerCase()) };
}

const MASCOT_ID = /^[a-z][a-z0-9-]{0,30}$/;
const catalogIds = new Set(MASCOT_CATALOG.map(entry => entry.id));

export function findMascotCatalog(id: string): MascotCatalog | undefined {
	return MASCOT_CATALOG.find(entry => entry.id === id);
}

export function readPersistedChatMascot(value: unknown): PersistedChatMascot {
	const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
	const size = MASCOT_SIZE_OPTIONS.includes(raw.size as ChatMascotSize)
		? raw.size as ChatMascotSize
		: 'medium';
	const sizePx = typeof raw.sizePx === 'number' && Number.isFinite(raw.sizePx)
		? Math.min(MASCOT_SIZE_MAX, Math.max(MASCOT_SIZE_MIN, Math.round(raw.sizePx)))
		: undefined;
	const positions: { [id: string]: { x: number; y: number } } = {};
	if (raw.positions && typeof raw.positions === 'object') {
		for (const [id, value] of Object.entries(raw.positions as Record<string, unknown>)) {
			if (!catalogIds.has(id) || !value || typeof value !== 'object') { continue; }
			const p = value as Record<string, unknown>;
			const x = typeof p.x === 'number' && Number.isFinite(p.x) ? Math.min(1, Math.max(0, p.x)) : null;
			// y > 1 = feet below the viewport fold; 2 is far past any useful sink.
			const y = typeof p.y === 'number' && Number.isFinite(p.y) ? Math.min(2, Math.max(0, p.y)) : null;
			if (x === null || y === null) { continue; }
			positions[id] = { x, y };
		}
	}
	const sizes: { [id: string]: number } = {};
	if (raw.sizes && typeof raw.sizes === 'object') {
		for (const [id, value] of Object.entries(raw.sizes as Record<string, unknown>)) {
			if (!catalogIds.has(id) || typeof value !== 'number' || !Number.isFinite(value)) { continue; }
			sizes[id] = Math.min(MASCOT_SIZE_MAX, Math.max(MASCOT_SIZE_MIN, Math.round(value)));
		}
	}
	const hidden: string[] = [];
	if (Array.isArray(raw.hidden)) {
		for (const id of raw.hidden) {
			if (typeof id === 'string' && catalogIds.has(id) && hidden.indexOf(id) < 0) {
				hidden.push(id);
			}
		}
	}
	const recent: string[] = [];
	if (Array.isArray(raw.recent)) {
		for (const id of raw.recent) {
			if (typeof id === 'string' && catalogIds.has(id) && recent.indexOf(id) < 0) {
				recent.push(id);
			}
			if (recent.length >= 12) {
				break;
			}
		}
	}
	const personas: { [id: string]: string } = {};
	if (raw.personas && typeof raw.personas === 'object') {
		for (const [id, value] of Object.entries(raw.personas as Record<string, unknown>)) {
			if (!catalogIds.has(id) || typeof value !== 'string' || !isMascotPersonaId(value)) {
				continue;
			}
			personas[id] = value;
		}
	}
	const slots: (string | null)[] = [];
	if (Array.isArray(raw.slots)) {
		for (const item of raw.slots) {
			if (typeof item === 'string' && MASCOT_ID.test(item) && catalogIds.has(item)) {
				slots.push(item);
			} else {
				slots.push(null);
			}
		}
	}
	return { enabled: raw.enabled === true, size, slots, sizePx, positions, sizes, hidden, recent, personas };
}

export function mascotsDir(storageUri: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(storageUri, MASCOTS_DIR_NAME);
}

/**
 * One-time move of mascot models from the legacy global-storage location into
 * the extension media dir. Cheap no-op when nothing is left behind.
 */
export function migrateLegacyMascotModels(fromStorage: vscode.Uri, toStorage: vscode.Uri): void {
	try {
		const fromDir = mascotsDir(fromStorage).fsPath;
		if (!fs.existsSync(fromDir)) {
			return;
		}
		const toDir = mascotsDir(toStorage).fsPath;
		fs.mkdirSync(toDir, { recursive: true });
		for (const entry of fs.readdirSync(fromDir)) {
			const from = path.join(fromDir, entry);
			if (!fs.statSync(from).isDirectory()) {
				continue;
			}
			const to = path.join(toDir, entry);
			if (fs.existsSync(to)) {
				continue;
			}
			try {
				fs.renameSync(from, to);
			} catch {
				// Cross-device rename: fall back to copy; leave the source for retry.
				fs.cpSync(from, to, { recursive: true });
			}
		}
	} catch {
		// Migration is best-effort; a fresh download re-creates the model anyway.
	}
}

export function mascotModelDir(storageUri: vscode.Uri, id: string): vscode.Uri {
	return vscode.Uri.joinPath(mascotsDir(storageUri), id);
}

/** Shipped render snapshots used as picker thumbnails (media/mascot-previews). */
export const MASCOT_PREVIEWS_DIR_NAME = 'mascot-previews';

export function mascotPreviewFile(storageUri: vscode.Uri, id: string): vscode.Uri {
	return vscode.Uri.joinPath(storageUri, MASCOT_PREVIEWS_DIR_NAME, `${id}.png`);
}

function isMascotId(id: string): boolean {
	return MASCOT_ID.test(id) && catalogIds.has(id);
}

/** A model is usable when its model3.json exists and every referenced file is on disk. */
export function isMascotModelComplete(storageUri: vscode.Uri, id: string): boolean {
	if (!isMascotId(id)) {
		return false;
	}
	const dir = mascotModelDir(storageUri, id);
	const model3 = findModel3File(dir.fsPath);
	if (!model3) {
		return false;
	}
	try {
		const settings = JSON.parse(fs.readFileSync(model3, 'utf8')) as {
			FileReferences?: {
				Moc?: string;
				Textures?: string[];
				Physics?: string;
				Pose?: string;
				Expressions?: { File: string }[];
				Motions?: Record<string, { File: string }[]>;
			};
		};
		const refs = settings.FileReferences ?? {};
		const files = [
			refs.Moc,
			...(Array.isArray(refs.Textures) ? refs.Textures : []),
			refs.Physics,
			...(Array.isArray(refs.Expressions) ? refs.Expressions.map(row => row.File) : []),
			...Object.values(refs.Motions ?? {}).flat().map(row => row.File),
		].filter((file): file is string => typeof file === 'string' && file.length > 0);
		// Guard against absurd metadata blowing up stat() loops.
		if (files.length > 400) {
			return fs.existsSync(path.join(path.dirname(model3), COMPLETE_MARKER));
		}
		return files.every(file => fs.existsSync(path.join(path.dirname(model3), file)));
	} catch {
		return false;
	}
}

function findModel3File(dir: string): string | undefined {
	try {
		for (const name of fs.readdirSync(dir)) {
			if (name.endsWith(MODEL3_GLOB) && !name.startsWith('.')) {
				return path.join(dir, name);
			}
		}
	} catch {
		// Not downloaded yet.
	}
	return undefined;
}

export function mascotModel3Path(storageUri: vscode.Uri, id: string): string | undefined {
	if (!isMascotId(id)) {
		return undefined;
	}
	return findModel3File(mascotModelDir(storageUri, id).fsPath);
}

export interface MascotDownloadProgress {
	id: string;
	done: number;
	total: number;
}

interface JsDelivrTreeFile {
	name: string;
	size: number;
}

/** File extensions the webview runtime actually needs from a model folder. */
const MODEL_FILE_RE = /\.(moc3|png|jpe?g|webp|physics3\.json|pose3\.json|exp3\.json|motion3\.json|cdi3\.json|cd3\.json|model3\.json)$/i;

/** Bundled voice clips (角色原声): downloaded for TTS voice cloning, not for
 *  the webview stage. Never part of the completeness check. */
const MASCOT_AUDIO_RE = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;
/** Written after one audio-scan pass so we stop hitting the GitHub trees API. */
const AUDIO_SCAN_MARKER = '.zcode-audio-scan';

/** Collects every file path referenced anywhere under `node` (FileReferences). */
function collectModelRefs(node: unknown, out: Set<string>): void {
	if (typeof node === 'string') {
		const file = node.replace(/\\/g, '/');
		if (file.length > 0 && !file.includes('://') && !file.startsWith('/')
			&& !file.split('/').includes('..') && MODEL_FILE_RE.test(file)) {
			out.add(file);
		}
	} else if (Array.isArray(node)) {
		for (const item of node) {
			collectModelRefs(item, out);
		}
	} else if (node && typeof node === 'object') {
		for (const value of Object.values(node as Record<string, unknown>)) {
			collectModelRefs(value, out);
		}
	}
}

function encodeRepoPath(rel: string): string {
	return rel.split('/').map(encodeURIComponent).join('/');
}

async function listModelFiles(entry: MascotCatalog): Promise<string[]> {
	const response = await fetch(`https://data.jsdelivr.com/v1/packages/gh/${repoRef(entry)}?structure=flat`);
	if (!response.ok) {
		throw new Error(`列模型文件失败（jsDelivr ${response.status}）`);
	}
	const tree = await response.json() as { files?: JsDelivrTreeFile[] };
	const prefix = `/${repoRoot(entry)}/${entry.folder}/`;
	const files = (tree.files ?? [])
		.filter(file => file.name.startsWith(prefix))
		.map(file => file.name.slice(1))
		.filter(file => path.basename(file) !== COMPLETE_MARKER);
	if (!files.some(file => file.endsWith(`${entry.folder}/${entry.model3}`))) {
		throw new Error(`找不到模型 ${entry.source} 的清单文件`);
	}
	// Audio (mp3/wav) ships in some sample repos; the stage ignores it but the
	// TTS voice-cloner uses it as the character's native voice.
	return files;
}

/**
 * raw.githubusercontent.com variant for repos over jsDelivr's package limit:
 * the model3.json is fetched first and its FileReferences drive the file list.
 * Returns folder-relative paths, ready to be joined onto the model dir.
 */
async function listRawModelFiles(entry: MascotCatalog): Promise<string[]> {
	const { ownerRepo, ref } = rawRepoParts(entry);
	const rawBase = `https://raw.githubusercontent.com/${ownerRepo}/${ref}/`;
	const response = await fetch(rawBase + encodeRepoPath(`${repoRoot(entry)}/${entry.folder}/${entry.model3}`));
	if (!response.ok) {
		throw new Error(`拉取 ${entry.source} 清单失败（${response.status}）`);
	}
	const settings = await response.json() as unknown;
	const refs = new Set<string>([entry.model3]);
	collectModelRefs((settings as { FileReferences?: unknown })?.FileReferences ?? settings, refs);
	// Bundled voice clips are usually not referenced by model3.json; ask the
	// GitHub trees API for the folder's audio files (null = listing unavailable,
	// e.g. rate limited, keep refs-only as before).
	const audio = await listRawModelAudio(entry);
	for (const rel of audio ?? []) {
		refs.add(rel);
	}
	return [...refs];
}

/**
 * Audio files inside the model folder of a raw-origin repo, via the GitHub
 * trees API on the pinned ref. Returns null when the listing is unavailable
 * (rate limit / network) so callers can retry later, [] when the folder ships
 * no audio, otherwise folder-relative paths.
 */
async function listRawModelAudio(entry: MascotCatalog): Promise<string[] | null> {
	const { ownerRepo, ref } = rawRepoParts(entry);
	let response: Response;
	try {
		response = await fetch(`https://api.github.com/repos/${ownerRepo}/git/trees/${ref}?recursive=1`, {
			headers: { Accept: 'application/vnd.github+json' },
		});
	} catch {
		return null;
	}
	if (!response.ok) {
		console.warn(`[mascot] trees api ${response.status} for ${ownerRepo}; 原声跳过`);
		return null;
	}
	const tree = await response.json() as { truncated?: boolean; tree?: Array<{ path: string; type: string }> };
	if (tree.truncated || !Array.isArray(tree.tree)) {
		return null;
	}
	const prefix = `${repoRoot(entry)}/${entry.folder}/`;
	return tree.tree
		.filter(item => item.type === 'blob' && item.path.startsWith(prefix) && MASCOT_AUDIO_RE.test(item.path))
		.map(item => item.path.slice(prefix.length));
}

/**
 * Downloads every model file into global storage. Safe to call again for an
 * interrupted download — files are simply overwritten.
 */
export async function downloadMascotModel(
	storageUri: vscode.Uri,
	id: string,
	onProgress?: (progress: MascotDownloadProgress) => void,
): Promise<void> {
	const entry = findMascotCatalog(id);
	if (!entry) {
		throw new Error(`未知精灵 ${id}`);
	}
	const root = repoRoot(entry);
	const dir = mascotModelDir(storageUri, id);
	fs.mkdirSync(dir.fsPath, { recursive: true });
	// Each branch ends with (queue, urlFor, targetFor): repo-rooted vs
	// folder-relative paths, jsDelivr vs raw GitHub base.
	let queue: string[];
	let urlFor: (rel: string) => string;
	let targetFor: (rel: string) => vscode.Uri;
	if (entry.origin === 'raw') {
		queue = await listRawModelFiles(entry);
		const { ownerRepo, ref } = rawRepoParts(entry);
		const rawBase = `https://raw.githubusercontent.com/${ownerRepo}/${ref}/${repoRoot(entry)}/${entry.folder}/`;
		urlFor = rel => rawBase + encodeRepoPath(rel);
		targetFor = rel => vscode.Uri.joinPath(dir, ...rel.split('/'));
	} else {
		queue = await listModelFiles(entry);
		const rawBase = `https://cdn.jsdelivr.net/gh/${repoRef(entry)}/`;
		urlFor = rel => rawBase + encodeRepoPath(rel);
		const skip = `${root}/${entry.folder}/`.length;
		targetFor = rel => vscode.Uri.joinPath(dir, ...rel.slice(skip).split('/'));
	}
	const total = queue.length;
	let done = 0;
	const workers = Array.from({ length: 4 }, async () => {
		while (queue.length > 0) {
			const rel = queue.shift()!;
			const response = await fetch(urlFor(rel));
			if (!response.ok) {
				throw new Error(`下载 ${entry.source} 的 ${path.basename(rel)} 失败（${response.status}）`);
			}
			const target = targetFor(rel);
			fs.mkdirSync(path.dirname(target.fsPath), { recursive: true });
			fs.writeFileSync(target.fsPath, Buffer.from(await response.arrayBuffer()));
			done += 1;
			onProgress?.({ id, done, total });
		}
	});
	await Promise.all(workers);
	fs.writeFileSync(path.join(dir.fsPath, COMPLETE_MARKER), String(Date.now()));
}

export interface MascotAudioFile {
	rel: string;
	size: number;
}

/** Voice clips inside a downloaded model folder (角色原声), rel → model dir. */
export function listMascotAudioFiles(storageUri: vscode.Uri, id: string): MascotAudioFile[] {
	const root = mascotModelDir(storageUri, id).fsPath;
	const out: MascotAudioFile[] = [];
	const walk = (rel: string): void => {
		let items: fs.Dirent[];
		try {
			items = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
		} catch {
			return;
		}
		for (const item of items) {
			const relPath = rel ? `${rel}/${item.name}` : item.name;
			if (item.isDirectory()) {
				walk(relPath);
			} else if (MASCOT_AUDIO_RE.test(item.name)) {
				try {
					out.push({ rel: relPath, size: fs.statSync(path.join(root, relPath)).size });
				} catch {
					// unreadable clip: ignore
				}
			}
		}
	};
	walk('');
	return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Default clone source: the longest clip within ~4–40s, else the shortest one. */
export function pickMascotNativeAudio(files: MascotAudioFile[]): MascotAudioFile | undefined {
	if (!files.length) {
		return undefined;
	}
	const band = files.filter(file => file.size >= 80_000 && file.size <= 1_600_000);
	if (band.length) {
		return band.reduce((best, file) => (file.size > best.size ? file : best));
	}
	return files.reduce((best, file) => (file.size < best.size ? file : best));
}

/**
 * One-time pass that fetches a completed model's bundled voice clips so the
 * TTS voice-cloner can offer them as the character's native voice. Models
 * downloaded before audio support keep working: this only adds files.
 */
export async function ensureMascotModelAudio(storageUri: vscode.Uri, id: string): Promise<void> {
	const entry = findMascotCatalog(id);
	if (!entry) {
		return;
	}
	const dir = mascotModelDir(storageUri, id);
	if (!fs.existsSync(path.join(dir.fsPath, COMPLETE_MARKER))
		|| fs.existsSync(path.join(dir.fsPath, AUDIO_SCAN_MARKER))) {
		return;
	}
	let rels: string[] | null;
	if (entry.origin === 'raw') {
		rels = await listRawModelAudio(entry);
	} else {
		try {
			const skip = `${repoRoot(entry)}/${entry.folder}/`.length;
			rels = (await listModelFiles(entry))
				.filter(file => MASCOT_AUDIO_RE.test(file) && file.length > skip)
				.map(file => file.slice(skip));
		} catch {
			rels = null;
		}
	}
	if (rels === null) {
		// Listing unavailable (rate limit / CDN): retry on a later pass.
		return;
	}
	let urlBase: string;
	if (entry.origin === 'raw') {
		const { ownerRepo, ref } = rawRepoParts(entry);
		urlBase = `https://raw.githubusercontent.com/${ownerRepo}/${ref}/${repoRoot(entry)}/${entry.folder}/`;
	} else {
		urlBase = `https://cdn.jsdelivr.net/gh/${repoRef(entry)}/${repoRoot(entry)}/${entry.folder}/`;
	}
	for (const rel of rels) {
		const target = vscode.Uri.joinPath(dir, ...rel.split('/'));
		if (fs.existsSync(target.fsPath)) {
			continue;
		}
		const response = await fetch(urlBase + encodeRepoPath(rel));
		if (!response.ok) {
			console.warn(`[mascot] 原声 ${id}/${rel} 下载失败（${response.status}）`);
			continue;
		}
		fs.mkdirSync(path.dirname(target.fsPath), { recursive: true });
		fs.writeFileSync(target.fsPath, Buffer.from(await response.arrayBuffer()));
	}
	fs.writeFileSync(path.join(dir.fsPath, AUDIO_SCAN_MARKER), String(Date.now()));
}

/** Removes the model folder. Returns false when nothing was on disk. */
export function deleteMascotModel(storageUri: vscode.Uri, id: string): boolean {
	if (!isMascotId(id)) {
		return false;
	}
	const dir = mascotModelDir(storageUri, id).fsPath;
	if (!fs.existsSync(dir)) {
		return false;
	}
	fs.rmSync(dir, { recursive: true, force: true });
	return true;
}
