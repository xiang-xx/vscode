/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { buildReasoningRequestFields } from './agentPace';
import { getAuthService } from './authSession';
import { findMascotCatalog } from './mascotCatalog';
import { defaultMascotPersonaId, findMascotPersona, type MascotPersona } from './mascotPersona';
import { getProviderMode } from './providers';
import { loadCodingPlanApiKey } from './zcodeCredentialsStore';

/**
 * Corner-mascot lines. Always GLM-5.3-Flash at its lowest thinking level
 * (`low` — Flash has no off/disabled step), on whichever GLM login the user
 * already uses for chat. A few dozen tokens per line; the coding model and
 * its thinking setting are left alone.
 */
const VOICE_MODEL = 'GLM-5.3-Flash';
const VOICE_REASONING = 'low';
const VOICE_MAX_TOKENS = 512;
const VOICE_TIMEOUT_MS = 8000;
const VOICE_COOLDOWN_MS = 800;
const MEMORY_KEY = 'zcode.mascotVoiceMemory';
const MEMORY_NOTES = 8;
const MEMORY_TURNS = 10;

const BIGMODEL_CODING_CHAT_URL = 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions';
const START_PLAN_ANTHROPIC_URL = 'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages';

const SYSTEM_PROMPT = [
	'你是用户写代码时，坐在聊天面板角落里的 Live2D 桌面精灵。你只负责说一句台词。',
	'身份和人设都在用户消息里。用那个名字说话，口吻始终符合那个人设，不要换成另一个人。',
	'怎么说：',
	'- 中文口语，一句，8 到 20 个字。像旁边的人随口说的，不像客服，不像播报。',
	'- 先接住「刚才发生的事」，再决定要不要用到「记得的事」。记得的事用不上就别提。',
	'- 不要重复「最近说过的话」，也不要换个说法再说同一句。',
	'- 不要每句都提醒喝水、保存、加油。偶尔可以，连着两句不行。',
	'- 用户在写程序。可以轻轻带一句他正在忙的事，不要给方案，不要复述代码，不要指挥他。',
	'- 不要自称人工智能、模型、助手。不要引号、括号、列表、表情符号、markdown。',
	'记忆：',
	'- 只有出现了以后还用得上的小事，才另起一行写「记：」加不超过 16 个字。例如称呼、作息、在做的功能、你们之间的玩笑。',
	'- 不要记代码、路径、密钥、原话复读。没有新的事就不要写「记：」。',
	'- 台词单独占第一行，前面不要加任何标签。',
].join('\n');

export type MascotVoiceTrigger = 'tap' | 'combo' | 'pet' | 'chatter' | 'dispatch' | 'complete';

export interface MascotVoiceInput {
	id: string;
	label: string;
	trigger: string;
	zone: string;
	gift: string;
	glimpse: { user: string; assistant: string };
	/** Speaking-style id. Empty uses that character's built-in default. */
	persona?: string;
}

export interface MascotVoiceOutcome {
	line?: string;
	/** Local fallback should show. A dropped call was superseded and must not touch the bubble. */
	skipped: boolean;
	dropped?: boolean;
}

interface VoiceTurn {
	at: number;
	id: string;
	label: string;
	trigger: MascotVoiceTrigger;
	line: string;
}

interface VoiceMemory {
	notes: string[];
	turns: VoiceTurn[];
}

interface VoiceAuth {
	api: 'openai' | 'anthropic';
	url: string;
	apiKey: string;
}

const TRIGGERS: readonly MascotVoiceTrigger[] = ['tap', 'combo', 'pet', 'chatter', 'dispatch', 'complete'];

const TRIGGER_LABEL: Record<MascotVoiceTrigger, string> = {
	tap: '被点到',
	combo: '被连点',
	pet: '被摸头',
	chatter: '闲着',
	dispatch: '任务开始',
	complete: '任务做完',
};

const ZONE_WORDS: Record<string, string> = {
	head: '头',
	ear: '耳朵',
	body: '身上',
	foot: '脚',
};

const GIFT_WORDS: Record<string, string> = {
	'☕': '一杯咖啡',
	'🍪': '一块饼干',
	'📖': '一本书',
	'🐟': '一条鱼',
	'⭐': '一颗星星',
	'🎵': '一首歌',
	'🍀': '一株四叶草',
	'🧋': '一杯奶茶',
	'💡': '一个点子',
};

function normalizeTrigger(value: string): MascotVoiceTrigger {
	return (TRIGGERS as readonly string[]).includes(value) ? value as MascotVoiceTrigger : 'tap';
}

function cleanLabel(value: string): string {
	return value.replace(/\s+/g, ' ').trim().slice(0, 16);
}

function clipTalk(text: string, max: number): string {
	const flat = text
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!flat) {
		return '';
	}
	return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function readMemory(value: unknown): VoiceMemory {
	const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
	const notes = Array.isArray(raw.notes)
		? raw.notes
			.filter((note): note is string => typeof note === 'string')
			.map(note => note.trim())
			.filter(note => acceptableNote(note))
			.slice(-MEMORY_NOTES)
		: [];
	const turns: VoiceTurn[] = [];
	if (Array.isArray(raw.turns)) {
		for (const row of raw.turns) {
			if (!row || typeof row !== 'object') {
				continue;
			}
			const turn = row as Record<string, unknown>;
			const line = typeof turn.line === 'string' ? turn.line.trim() : '';
			const label = typeof turn.label === 'string' ? cleanLabel(turn.label) : '';
			const at = typeof turn.at === 'number' && Number.isFinite(turn.at) ? turn.at : 0;
			if (!line || !label || !at) {
				continue;
			}
			turns.push({
				at,
				id: typeof turn.id === 'string' ? turn.id : '',
				label,
				trigger: normalizeTrigger(typeof turn.trigger === 'string' ? turn.trigger : ''),
				line: line.slice(0, 24),
			});
		}
	}
	return { notes, turns: turns.slice(-MEMORY_TURNS) };
}

function acceptableNote(fact: string): boolean {
	if (fact.length < 2 || fact.length > 24) {
		return false;
	}
	if (/[\\/]/.test(fact) || /key|token|密码|密钥|api/i.test(fact)) {
		return false;
	}
	return true;
}

function rememberNote(notes: string[], fact: string): string[] {
	if (!acceptableNote(fact)) {
		return notes;
	}
	const richer = notes.find(note => note !== fact && note.includes(fact));
	if (richer) {
		return notes;
	}
	const kept = notes.filter(note => note !== fact && !fact.includes(note));
	kept.push(fact);
	return kept.slice(-MEMORY_NOTES);
}

/** Pulls the spoken line and an optional `记：` fact out of a small model reply. */
export function parseMascotLine(raw: string): { line?: string; note?: string } {
	let line = '';
	let note = '';
	for (const row of raw.split(/\r?\n/)) {
		const text = row.trim();
		if (!text) {
			continue;
		}
		const memory = /^记[:：]\s*(.+)$/.exec(text);
		if (memory) {
			const fact = memory[1].replace(/^[「」"'“”]+|[「」"'“”]+$/g, '').trim();
			if (!note && fact && fact !== '无' && fact !== '没有') {
				note = fact.slice(0, 24);
			}
			continue;
		}
		if (!line) {
			line = text.replace(/^(说|台词)[:：]\s*/, '').replace(/^[「」"'“”]+|[「」"'“”]+$/g, '').trim();
		}
	}
	line = clampLine(line);
	if (!line || /语言模型|作为 ?AI|作为一个|我是 ?AI|系统提示/i.test(line)) {
		return {};
	}
	return note && acceptableNote(note) ? { line, note } : { line };
}

function clampLine(line: string): string {
	const clean = line.replace(/\s+/g, ' ').trim();
	if (clean.length < 2) {
		return '';
	}
	if (clean.length <= 24) {
		return clean;
	}
	const cut = clean.slice(0, 24);
	const punct = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('~'), cut.lastIndexOf('～'));
	return punct >= 8 ? cut.slice(0, punct) : cut;
}

function nowLabel(): string {
	return new Intl.DateTimeFormat('zh-CN', {
		timeZone: 'Asia/Shanghai',
		weekday: 'short',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).format(new Date());
}

function describeMoment(trigger: MascotVoiceTrigger, zone: string, gift: string, again: boolean): string {
	const present = GIFT_WORDS[gift];
	const giftBit = present ? `，还递来${present}` : '';
	switch (trigger) {
		case 'tap':
			return `用户点了你的${ZONE_WORDS[zone] || '身上'}${giftBit}`;
		case 'combo':
			return `用户连着点了你好几下${giftBit}`;
		case 'pet':
			return again ? '用户过了一会儿又来摸你的头' : '用户按着不放，在摸你的头';
		case 'chatter':
			return again ? '又安静了一会儿，用户还在屏幕前' : '安静了几分钟，用户还在屏幕前';
		case 'dispatch':
			return '一个编程任务刚派出去，开始做了';
		case 'complete':
			return '一个编程任务刚刚做完';
		default:
			return '用户看了你一眼';
	}
}

function buildUserPrompt(label: string, persona: MascotPersona, trigger: MascotVoiceTrigger, zone: string, gift: string, glimpse: { user: string; assistant: string }, memory: VoiceMemory): string {
	const last = memory.turns[memory.turns.length - 1];
	const again = !!last && last.label === label && last.trigger === trigger && Date.now() - last.at < 10 * 60 * 1000;
	const notes = memory.notes.length
		? memory.notes.map(note => `- ${note}`).join('\n')
		: '- 还没有';
	const turns = memory.turns.length
		? memory.turns.slice(-6).map(turn => `- ${turn.label}（${TRIGGER_LABEL[turn.trigger]}）：${turn.line}`).join('\n')
		: '- 还没有';
	const userLine = glimpse.user
		? `用户刚发给编程助手的话：${glimpse.user}`
		: '用户这会儿没在聊天里说话。';
	const assistantLine = glimpse.assistant
		? `编程助手刚回复的大意：${glimpse.assistant}`
		: '';
	return [
		`时刻：${nowLabel()}`,
		`你是：${label}`,
		`人设：${persona.label}。${persona.voice}`,
		`刚才：${describeMoment(trigger, zone, gift, again)}`,
		userLine,
		assistantLine,
		'记得的事：',
		notes,
		'最近说过的话（里面可能有别人的，不要学他们的口吻）：',
		turns,
		'现在说一句。',
	].filter(Boolean).join('\n');
}

function httpStatus(error: unknown): number {
	return error && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number'
		? (error as { status: number }).status
		: 0;
}

async function postJson(url: string, apiKey: string, extraHeaders: Record<string, string>, body: unknown, signal: AbortSignal): Promise<unknown> {
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
			...extraHeaders,
		},
		body: JSON.stringify(body),
		signal,
	});
	const raw = await response.text();
	let data: unknown;
	try {
		data = JSON.parse(raw) as unknown;
	} catch {
		data = undefined;
	}
	if (!response.ok) {
		const message = data && typeof data === 'object'
			? ((data as { error?: { message?: string }; msg?: string }).error?.message
				|| (data as { msg?: string }).msg
				|| '')
			: '';
		const error = new Error(message || `HTTP ${response.status}: ${raw.slice(0, 180)}`);
		(error as Error & { status: number }).status = response.status;
		throw error;
	}
	return data;
}

function textFromOpenAI(data: unknown): string {
	if (!data || typeof data !== 'object') {
		return '';
	}
	const content = (data as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
	return typeof content === 'string' ? content : '';
}

function textFromAnthropic(data: unknown): string {
	if (!data || typeof data !== 'object') {
		return '';
	}
	const content = (data as { content?: unknown }).content;
	if (typeof content === 'string') {
		return content;
	}
	if (!Array.isArray(content)) {
		return '';
	}
	let text = '';
	for (const block of content) {
		if (!block || typeof block !== 'object') {
			continue;
		}
		const row = block as { type?: string; text?: string };
		if (row.type === 'text' && typeof row.text === 'string') {
			text += row.text;
		}
	}
	return text;
}

async function resolveVoiceAuth(): Promise<VoiceAuth | undefined> {
	const mode = getProviderMode();
	if (mode === 'bigmodel' || mode === 'deepseek') {
		try {
			const apiKey = await loadCodingPlanApiKey('bigmodel');
			if (apiKey) {
				return { api: 'openai', url: BIGMODEL_CODING_CHAT_URL, apiKey };
			}
		} catch {
			// Missing credentials fall through to the other GLM login, then to canned lines.
		}
		if (mode === 'bigmodel') {
			return undefined;
		}
	}
	try {
		const apiKey = getAuthService().getSession()?.zcodeJwtToken?.trim();
		if (apiKey) {
			return { api: 'anthropic', url: START_PLAN_ANTHROPIC_URL, apiKey };
		}
	} catch {
		// Not signed in.
	}
	return undefined;
}

export class MascotVoice {
	private memory: VoiceMemory;
	private nextAt = 0;
	private current?: AbortController;

	constructor(private readonly globalState: vscode.Memento) {
		this.memory = readMemory(globalState.get(MEMORY_KEY));
	}

	async speak(input: MascotVoiceInput): Promise<MascotVoiceOutcome> {
		const now = Date.now();
		if (now < this.nextAt) {
			return { skipped: true };
		}
		this.nextAt = now + VOICE_COOLDOWN_MS;
		this.current?.abort();
		const controller = new AbortController();
		this.current = controller;
		const timer = setTimeout(() => controller.abort(), VOICE_TIMEOUT_MS);
		try {
			const entry = findMascotCatalog(input.id);
			const label = cleanLabel(entry?.label || input.label) || '精灵';
			const trigger = normalizeTrigger(input.trigger);
			const zone = ZONE_WORDS[input.zone] ? input.zone : '';
			const gift = GIFT_WORDS[input.gift] ? input.gift : '';
			const glimpse = {
				user: clipTalk(input.glimpse.user, 80),
				assistant: clipTalk(input.glimpse.assistant, 60),
			};
			const persona = findMascotPersona(input.persona) || findMascotPersona(defaultMascotPersonaId(input.id)) || findMascotPersona('soft');
			if (!persona) {
				return { skipped: true };
			}
			const spoken = await this.complete(label, persona, trigger, zone, gift, glimpse, controller.signal);
			if (this.current !== controller) {
				return { skipped: true, dropped: true };
			}
			if (!spoken) {
				return { skipped: true };
			}
			this.memory.turns.push({ at: Date.now(), id: input.id, label, trigger, line: spoken.line });
			this.memory.turns = this.memory.turns.slice(-MEMORY_TURNS);
			if (spoken.note) {
				this.memory.notes = rememberNote(this.memory.notes, spoken.note);
			}
			void this.globalState.update(MEMORY_KEY, this.memory);
			return { line: spoken.line, skipped: false };
		} catch (error) {
			if (this.current !== controller) {
				return { skipped: true, dropped: true };
			}
			console.warn('[mascot] voice failed:', error instanceof Error ? error.message : error);
			return { skipped: true };
		} finally {
			clearTimeout(timer);
		}
	}

	private async complete(label: string, persona: MascotPersona, trigger: MascotVoiceTrigger, zone: string, gift: string, glimpse: { user: string; assistant: string }, signal: AbortSignal): Promise<{ line: string; note?: string } | undefined> {
		const auth = await resolveVoiceAuth();
		if (!auth) {
			return undefined;
		}
		const user = buildUserPrompt(label, persona, trigger, zone, gift, glimpse, this.memory);
		const raw = auth.api === 'openai'
			? await this.completeOpenAI(auth, user, signal)
			: await this.completeAnthropic(auth, user, signal);
		const parsed = parseMascotLine(raw);
		return parsed.line ? { line: parsed.line, note: parsed.note } : undefined;
	}

	private async completeOpenAI(auth: VoiceAuth, user: string, signal: AbortSignal): Promise<string> {
		const messages = [
			{ role: 'system', content: SYSTEM_PROMPT },
			{ role: 'user', content: user },
		];
		const minimal = {
			model: VOICE_MODEL,
			messages,
			max_tokens: VOICE_MAX_TOKENS,
			stream: false,
		};
		try {
			const data = await postJson(auth.url, auth.apiKey, {}, {
				...minimal,
				temperature: 0.9,
				...buildReasoningRequestFields(VOICE_REASONING),
			}, signal);
			return textFromOpenAI(data);
		} catch (error) {
			if (httpStatus(error) !== 400 || signal.aborted) {
				throw error;
			}
			const data = await postJson(auth.url, auth.apiKey, {}, minimal, signal);
			return textFromOpenAI(data);
		}
	}

	private async completeAnthropic(auth: VoiceAuth, user: string, signal: AbortSignal): Promise<string> {
		const headers = {
			'anthropic-version': '2023-06-01',
			'x-api-key': auth.apiKey,
		};
		const minimal = {
			model: VOICE_MODEL,
			max_tokens: VOICE_MAX_TOKENS,
			system: SYSTEM_PROMPT,
			messages: [{ role: 'user', content: user }],
			stream: false,
		};
		try {
			const data = await postJson(auth.url, auth.apiKey, headers, {
				...minimal,
				temperature: 0.9,
				...buildReasoningRequestFields(VOICE_REASONING),
			}, signal);
			return textFromAnthropic(data);
		} catch (error) {
			if (httpStatus(error) !== 400 || signal.aborted) {
				throw error;
			}
			const data = await postJson(auth.url, auth.apiKey, headers, minimal, signal);
			return textFromAnthropic(data);
		}
	}
}
