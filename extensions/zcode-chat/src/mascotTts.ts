/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { basename, dirname, join } from 'path';

/**
 * Spoken audio for mascot lines (桌面精灵台词的语音朗读).
 *
 * Three local engines, all configured under `zcode.mascot.tts.*`:
 * - `qwen`: local Qwen3-TTS (open Hugging Face weights) via `tts/ttsServer.py`.
 *   Voices are zero-shot clones of reference audio dropped into the refs dir
 *   (空目录会用 say 生成几个种子音色兜底). Falls back to `system` when the
 *   python worker cannot start.
 * - `system`: the macOS `say` command. Offline, zero dependencies. Lines are
 *   rendered to a temp WAVE file and handed to the webview as a data URI.
 *   Other platforms stay silent.
 * - `openai`: any local OpenAI-compatible `/audio/speech` endpoint, e.g.
 *   GPT-SoVITS / CosyVoice / fish-speech compatibility wrappers.
 */

export interface MascotTtsVoiceInfo {
	name: string;
	locale: string;
	/** Stable picker value (`clone:foo`); defaults to `name`. */
	value?: string;
}

export interface MascotTtsState {
	enabled: boolean;
	supported: boolean;
	voices: MascotTtsVoiceInfo[];
	voiceMap: Record<string, string>;
	/** Per-character native clip options (`native:<rel>` from the model dir). */
	nativeVoices: Record<string, Array<{ name: string; value: string }>>;
	/** Per-line budget the webview gives one synthesis (qwen loads slowly). */
	timeoutMs: number;
	/** Where custom reference wavs live (shown in the picker hint). */
	refsDir: string;
}

export interface MascotTtsAudio {
	mime: string;
	base64: string;
}

/** One entry of the qwen synthesis disk cache (按条管理的合成缓存). */
export interface MascotTtsCacheEntry {
	key: string;
	text: string;
	voice: string;
	refPath?: string;
	seconds: number;
	bytes: number;
	created: number;
}

export interface MascotTtsInput {
	id: string;
	persona?: string;
	text: string;
	/** Absolute path to a bundled model clip (角色原声) to clone from. */
	refAudioPath?: string;
}

interface TtsSettings {
	engine: string;
	baseUrl: string;
	model: string;
	apiKey: string;
	defaultVoice: string;
	python: string;
	refsDir: string;
}

const ENABLED_KEY = 'zcode.mascotTts.enabled';
const VOICES_KEY = 'zcode.mascotTts.voiceMap';
const CACHE_LIMIT = 48;
const SAY_TIMEOUT_MS = 10000;
const OPENAI_TIMEOUT_MS = 20000;
/** qwen 首句要等模型加载（MPS 上 20-40s），预算放宽。 */
const QWEN_TIMEOUT_MS = 90000;
const QWEN_BOOT_TIMEOUT_MS = 15000;
/** python 解释器候选：配置项优先，其次配音 demo 的现成 venv（已装 qwen-tts
 *  且 HF 模型已缓存），最后系统的 python3。 */
const PYTHON_CANDIDATES = [
	'/Users/xiang/projects/audio-i18n-demo/.venv/bin/python',
	'python3',
];

/** Auto-pick pool (zh), tried in order; a character without an explicit voice
 *  rotates through the installed subset so squadmates don't all sound alike. */
const AUTO_ROTATION = [
	'Tingting',
	'Meijia',
	'Sinji',
	'Shelley (中文（中国大陆）)',
	'Flo (中文（中国大陆）)',
	'Sandy (中文（中国大陆）)',
	'Eddy (中文（中国大陆）)',
	'Reed (中文（中国大陆）)',
];
const BASE_WPM = 205;

/** Persona id fragments → speaking-rate multiplier. Unknown ids speak at 1.0. */
const PERSONA_RATE: ReadonlyArray<readonly [RegExp, number]> = [
	[/genki|idol|loli|energy|star|mascot/i, 1.12],
	[/sleep|doze|lazy|mellow|kuudere|goth/i, 0.88],
	[/tsun|impat|cat|fox/i, 1.06],
	[/cool|onee|butler|master/i, 0.94],
];

function settings(): TtsSettings {
	const config = vscode.workspace.getConfiguration('zcode.mascot.tts');
	return {
		engine: config.get<string>('engine', 'qwen'),
		baseUrl: config.get<string>('baseUrl', 'http://127.0.0.1:9880/v1'),
		model: config.get<string>('model', ''),
		apiKey: config.get<string>('apiKey', ''),
		defaultVoice: config.get<string>('voice', ''),
		python: config.get<string>('python', ''),
		refsDir: config.get<string>('refsDir', ''),
	};
}

/** Drops emoji, arrows and leading dashes (a leading dash would confuse `say`). */
export function cleanSpeechText(text: string): string {
	return text
		.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{FE0F}\u{200D}]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^[-–—]+/, '')
		.trim()
		.slice(0, 80);
}

function personaRate(persona?: string): number {
	if (!persona) {
		return 1;
	}
	for (const [pattern, rate] of PERSONA_RATE) {
		if (pattern.test(persona)) {
			return rate;
		}
	}
	return 1;
}

function sniffMime(bytes: Uint8Array): string {
	if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
		return 'audio/wav';
	}
	if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
		return 'audio/mpeg';
	}
	if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
		return 'audio/mpeg';
	}
	if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
		return 'audio/ogg';
	}
	if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) {
		return 'audio/flac';
	}
	return 'audio/mpeg';
}

function zhRank(locale: string): number {
	const value = locale.toLowerCase();
	if (value.startsWith('zh-cn')) {
		return 0;
	}
	if (value.startsWith('zh')) {
		return 1;
	}
	return 2;
}

function spawnCapture(binary: string, args: string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, args);
		let out = '';
		const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
		child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
		child.on('error', (error) => { clearTimeout(timer); reject(error); });
		child.on('close', () => { clearTimeout(timer); resolve(out); });
	});
}

/** Owns the `tts/ttsServer.py` worker process (Qwen3-TTS on MPS). */
class QwenServer {
	private child?: ChildProcessByStdio<null, Readable, Readable>;
	private port?: number;
	private booting?: Promise<number>;
	private voicesCache?: MascotTtsVoiceInfo[];
	readonly refsDir = settings().refsDir || join(homedir(), '.zcode', 'mascot-voice-refs');

	constructor(private readonly scriptPath: string) {
		process.on('exit', () => this.kill());
	}

	kill(): void {
		this.port = undefined;
		this.voicesCache = undefined;
		if (this.child) {
			this.child.kill('SIGTERM');
			this.child = undefined;
		}
	}

	private tryStart(python: string): Promise<number> {
		return new Promise((resolve, reject) => {
			let child: ChildProcessByStdio<null, Readable, Readable>;
			try {
				child = spawn(python, [this.scriptPath, '--refs', this.refsDir], { stdio: ['ignore', 'pipe', 'pipe'] });
			} catch (error) {
				reject(error);
				return;
			}
			let portLine = '';
			const timer = setTimeout(() => {
				child.kill('SIGKILL');
				reject(new Error(`no PORT line from ${python}`));
			}, QWEN_BOOT_TIMEOUT_MS);
			child.stdout.on('data', (chunk: Buffer) => {
				portLine += chunk.toString('utf8');
				const match = /PORT=(\d+)/.exec(portLine);
				if (match) {
					clearTimeout(timer);
					this.child = child;
					resolve(Number(match[1]));
				}
			});
			child.on('error', (error) => { clearTimeout(timer); reject(error); });
			child.on('close', () => { clearTimeout(timer); reject(new Error(`${python} exited before serving`)); });
			// qwen_tts 的 sox 告警走 stderr，转发到控制台即可，不影响协议。
			child.stderr.on('data', () => undefined);
		});
	}

	async ensurePort(): Promise<number> {
		if (this.port) {
			return this.port;
		}
		if (!this.booting) {
			const candidates = [settings().python, ...PYTHON_CANDIDATES].filter(Boolean);
			this.booting = (async () => {
				let lastError: unknown;
				for (const python of candidates) {
					try {
						const port = await this.tryStart(python);
						console.info(`[mascot] qwen tts worker on :${port} (${python})`);
						return port;
					} catch (error) {
						lastError = error;
					}
				}
				throw new Error(`本地 qwen tts 服务起不来（试过 ${candidates.join(', ')}）。装 qwen-tts 或用 zcode.mascot.tts.python 指定解释器；最后修改因：${lastError instanceof Error ? lastError.message : lastError}`);
			})().finally(() => { this.booting = undefined; });
		}
		this.port = await this.booting;
		return this.port;
	}

	private async http(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
		const port = await this.ensurePort();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await fetch(`http://127.0.0.1:${port}${path}`, { ...init, signal: controller.signal });
		} finally {
			clearTimeout(timer);
		}
	}

	async voices(): Promise<MascotTtsVoiceInfo[]> {
		if (this.voicesCache) {
			return this.voicesCache;
		}
		const response = await this.http('/voices', { method: 'GET' }, 30000);
		if (!response.ok) {
			throw new Error(`/voices ${response.status}`);
		}
		const data = await response.json() as { voices?: Array<{ name: string; value?: string; locale?: string }> };
		this.voicesCache = (data.voices || []).map(entry => ({
			name: entry.name,
			locale: entry.locale || 'zh',
			value: entry.value || entry.name,
		}));
		return this.voicesCache;
	}

	invalidateVoices(): void {
		this.voicesCache = undefined;
	}

	/** Disk-cache listing from the worker (survives restarts, per-entry managed). */
	async cacheList(): Promise<{ entries: MascotTtsCacheEntry[]; dir: string }> {
		const response = await this.http('/cache', { method: 'GET' }, 10000);
		if (!response.ok) {
			throw new Error(`/cache ${response.status}`);
		}
		return await response.json() as { entries: MascotTtsCacheEntry[]; dir: string };
	}

	async cacheDelete(key: string): Promise<void> {
		await this.http('/cache/delete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ key }),
		}, 10000);
	}

	async cacheClear(): Promise<void> {
		await this.http('/cache/clear', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{}',
		}, 10000);
	}

	async synthesize(text: string, voice: string, refPath?: string): Promise<MascotTtsAudio | undefined> {
		const body: Record<string, unknown> = { text, voice };
		if (refPath) {
			body.ref_path = refPath;
		}
		const response = await this.http('/synthesize', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		}, QWEN_TIMEOUT_MS);
		if (!response.ok) {
			const detail = await response.text().catch(() => '');
			throw new Error(`/synthesize ${response.status} ${detail.slice(0, 200)}`);
		}
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (!bytes.length) {
			return undefined;
		}
		return { mime: sniffMime(bytes), base64: Buffer.from(bytes).toString('base64') };
	}
}

export class MascotTts {
	private voices?: MascotTtsVoiceInfo[];
	private readonly cache = new Map<string, MascotTtsAudio>();
	private readonly qwen: QwenServer;

	constructor(private readonly globalState: vscode.Memento, extensionUri: vscode.Uri) {
		this.qwen = new QwenServer(join(extensionUri.fsPath, 'tts', 'ttsServer.py'));
	}

	dispose(): void {
		this.qwen.kill();
	}

	isEnabled(): boolean {
		return !!this.globalState.get<boolean>(ENABLED_KEY, false) && this.isSupported();
	}

	async setEnabled(enabled: boolean): Promise<void> {
		await this.globalState.update(ENABLED_KEY, enabled);
	}

	isSupported(): boolean {
		const engine = settings().engine;
		return engine === 'qwen' || engine === 'openai' || process.platform === 'darwin';
	}

	async describe(options?: { nativeVoices?: Record<string, Array<{ name: string; value: string }>> }): Promise<MascotTtsState> {
		const engine = settings().engine;
		let voices: MascotTtsVoiceInfo[] = [];
		if (engine === 'system') {
			voices = await this.listVoices();
		} else if (engine === 'qwen' && this.isEnabled()) {
			// 只有开关真开了才去拉 python 进程，面板冷启动不背这个成本。
			try {
				voices = await this.qwen.voices();
			} catch (error) {
				console.warn('[mascot] qwen voices unavailable:', error instanceof Error ? error.message : error);
			}
		}
		return {
			enabled: this.isEnabled(),
			supported: this.isSupported(),
			voices,
			voiceMap: this.readVoiceMap(),
			nativeVoices: options?.nativeVoices ?? {},
			timeoutMs: engine === 'qwen' ? QWEN_TIMEOUT_MS : 9000,
			refsDir: this.qwen.refsDir,
		};
	}

	async setVoice(id: string, voice: string | null): Promise<void> {
		if (!id) {
			return;
		}
		const map = this.readVoiceMap();
		if (voice) {
			map[id] = voice;
		} else {
			delete map[id];
		}
		await this.globalState.update(VOICES_KEY, map);
	}

	/** Disk cache of synthesized qwen lines; unreachable worker → empty listing. */
	async cacheList(): Promise<{ entries: MascotTtsCacheEntry[]; dir: string }> {
		try {
			return await this.qwen.cacheList();
		} catch {
			return { entries: [], dir: this.ttsCacheDir() };
		}
	}

	async cacheDelete(key: string): Promise<void> {
		this.cache.clear(); // 内存 LRU 同步作废，避免删了还播旧音频
		await this.qwen.cacheDelete(key);
	}

	async cacheClear(): Promise<void> {
		this.cache.clear();
		await this.qwen.cacheClear();
	}

	/** One cached wav back as a playable payload (for the cache manager panel). */
	async cacheAudio(key: string): Promise<MascotTtsAudio | undefined> {
		const safe = key.replace(/[^0-9a-f]/gi, '');
		if (!safe) {
			return undefined;
		}
		try {
			const bytes = await readFile(join(this.ttsCacheDir(), `${safe}.wav`));
			return bytes.length ? { mime: 'audio/wav', base64: bytes.toString('base64') } : undefined;
		} catch {
			return undefined;
		}
	}

	/** Copies a user-picked reference audio (mp3…) into the refs dir as a new voice. */
	async addVoiceFile(): Promise<string | undefined> {
		const picks = await vscode.window.showOpenDialog({
			canSelectMany: false,
			openLabel: '添加音色',
			title: '选择参考音频（真人干声 5–10 秒最佳；放同名 .txt 写参考文案效果更好）',
			filters: { '音频': ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'aac'] },
		});
		const picked = picks?.[0];
		if (!picked) {
			return undefined;
		}
		const dir = this.qwen.refsDir;
		await mkdir(dir, { recursive: true });
		let name = basename(picked.fsPath);
		if (existsSync(join(dir, name))) {
			name = `${Date.now().toString(36)}-${name}`;
		}
		await copyFile(picked.fsPath, join(dir, name));
		this.qwen.invalidateVoices();
		this.voices = undefined;
		return name;
	}

	private ttsCacheDir(): string {
		return join(dirname(this.qwen.refsDir), 'mascot-tts-cache');
	}

	/** Renders one line to a data-URI payload. Undefined = nothing to speak. */
	async synthesize(input: MascotTtsInput): Promise<MascotTtsAudio | undefined> {
		const text = cleanSpeechText(input.text);
		if (!text) {
			return undefined;
		}
		const rate = personaRate(input.persona);
		const refAudio = settings().engine === 'qwen' && input.refAudioPath ? input.refAudioPath : undefined;
		const voice = refAudio ? '' : await this.resolveVoice(input.id);
		const engine = settings().engine;
		const key = `${engine}|${voice}|${refAudio ?? ''}|${rate}|${text}`;
		const hit = this.cache.get(key);
		if (hit) {
			this.cache.delete(key);
			this.cache.set(key, hit);
			return hit;
		}
		let audio: MascotTtsAudio | undefined;
		if (engine === 'openai') {
			audio = await this.synthesizeOpenAI(text, voice, rate);
		} else if (engine === 'qwen') {
			try {
				audio = await this.qwen.synthesize(text, voice, refAudio);
			} catch (error) {
				// qwen 起不来/超时：退回系统 say，保证出声。
				console.warn('[mascot] qwen tts failed, falling back to say:', error instanceof Error ? error.message : error);
				audio = await this.synthesizeSay(text, await this.resolveSayVoice(input.id), rate);
			}
		} else {
			audio = await this.synthesizeSay(text, voice, rate);
		}
		if (!audio) {
			return undefined;
		}
		this.cache.set(key, audio);
		while (this.cache.size > CACHE_LIMIT) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.cache.delete(oldest);
		}
		return audio;
	}

	/** System voices for the per-character picker, zh locales first. */
	async listVoices(): Promise<MascotTtsVoiceInfo[]> {
		if (this.voices) {
			return this.voices;
		}
		if (process.platform !== 'darwin') {
			this.voices = [];
			return this.voices;
		}
		try {
			const stdout = await spawnCapture('say', ['-v', '?'], SAY_TIMEOUT_MS);
			const voices: MascotTtsVoiceInfo[] = [];
			for (const row of stdout.split(/\r?\n/)) {
				const match = /^(.*?)\s+([a-z]{2,3}[-_][A-Za-z0-9]+)\s*#\s*(.*)$/.exec(row);
				if (!match) {
					continue;
				}
				const name = match[1].trim();
				const locale = match[2].replace('_', '-');
				if (!name) {
					continue;
				}
				voices.push({ name, locale });
			}
			voices.sort((a, b) => zhRank(a.locale) - zhRank(b.locale) || a.name.localeCompare(b.name));
			this.voices = voices.slice(0, 120);
		} catch {
			this.voices = [];
		}
		return this.voices;
	}

	private readVoiceMap(): Record<string, string> {
		const raw = this.globalState.get<Record<string, unknown>>(VOICES_KEY);
		const map: Record<string, string> = {};
		if (raw && typeof raw === 'object') {
			for (const [id, voice] of Object.entries(raw)) {
				if (typeof voice === 'string' && voice) {
					map[id] = voice;
				}
			}
		}
		return map;
	}

	/** Current per-character voice choice, e.g. `native:sounds/haru_03.wav`. */
	voiceFor(id: string): string | undefined {
		return this.readVoiceMap()[id];
	}

	private async resolveVoice(id: string): Promise<string> {
		if (settings().engine !== 'qwen') {
			return this.resolveSayVoice(id);
		}
		const override = this.readVoiceMap()[id];
		// qwen 的音色值都带 clone:/builtin: 前缀；纯名字是旧 say 值，不认。
		if (override && override.includes(':')) {
			// 参考音频可能被用户删掉（换音色池），失效值改为按 id 轮换，不盲发。
			try {
				const voices = await this.qwen.voices();
				if (!voices.length || voices.some((v) => v.value === override || v.name === override)) {
					return override;
				}
			} catch {
				return override; // 服务暂不可达时保留原值，交给合成端报错回退
			}
		}
		const fallback = settings().defaultVoice;
		if (fallback && fallback.includes(':')) {
			return fallback;
		}
		try {
			const voices = await this.qwen.voices();
			if (!voices.length) {
				return '';
			}
			let hash = 0;
			for (const ch of id) {
				hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
			}
			return voices[hash % voices.length].value || voices[hash % voices.length].name;
		} catch {
			return '';
		}
	}

	private async resolveSayVoice(id: string): Promise<string> {
		const override = this.readVoiceMap()[id];
		if (override && !override.includes(':')) {
			return override;
		}
		const fallback = settings().defaultVoice;
		if (fallback && !fallback.includes(':')) {
			return fallback;
		}
		if (settings().engine === 'openai') {
			return 'default';
		}
		const voices = await this.listVoices();
		const zh = voices.filter(voice => voice.locale.toLowerCase().startsWith('zh'));
		const candidates: string[] = [];
		for (const name of AUTO_ROTATION) {
			const found = zh.find(voice => voice.name === name);
			if (found) {
				candidates.push(found.name);
			}
		}
		if (!candidates.length) {
			return zh[0]?.name || 'Tingting';
		}
		let hash = 0;
		for (const ch of id) {
			hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
		}
		return candidates[hash % candidates.length];
	}

	private async synthesizeSay(text: string, voice: string, rate: number): Promise<MascotTtsAudio | undefined> {
		if (process.platform !== 'darwin') {
			return undefined;
		}
		const dir = await mkdtemp(join(tmpdir(), 'zcode-tts-'));
		const file = join(dir, 'line.wav');
		try {
			const wpm = Math.max(120, Math.min(280, Math.round(BASE_WPM * rate)));
			await spawnCapture('say', ['-o', file, '--data-format=LEI16@22050', '-v', voice, '-r', String(wpm), text], SAY_TIMEOUT_MS * 2);
			const bytes = await readFile(file);
			if (!bytes.length) {
				return undefined;
			}
			return { mime: 'audio/wav', base64: bytes.toString('base64') };
		} finally {
			void rm(dir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	private async synthesizeOpenAI(text: string, voice: string, rate: number): Promise<MascotTtsAudio | undefined> {
		const { baseUrl, model, apiKey } = settings();
		const root = baseUrl.replace(/\/+$/, '');
		if (!/^https?:\/\//.test(root)) {
			throw new Error('zcode.mascot.tts.baseUrl 未配置');
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
		try {
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };
			if (apiKey) {
				headers.Authorization = `Bearer ${apiKey}`;
			}
			const body: Record<string, unknown> = {
				input: text,
				voice,
				response_format: 'wav',
				speed: Math.max(0.5, Math.min(2, rate)),
			};
			if (model) {
				body.model = model;
			}
			const response = await fetch(`${root}/audio/speech`, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!response.ok) {
				const detail = (await response.text()).slice(0, 160);
				throw new Error(`TTS 服务 HTTP ${response.status}: ${detail}`);
			}
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (!bytes.length) {
				return undefined;
			}
			return { mime: sniffMime(bytes), base64: Buffer.from(bytes).toString('base64') };
		} finally {
			clearTimeout(timer);
		}
	}
}
