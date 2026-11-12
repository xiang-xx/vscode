/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Schemas } from '../../../../base/common/network.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IChatUsage } from './chatService/chatService.js';

/**
 * A live usage report for one chat turn. `sessionTitle` is whatever the owning
 * session currently calls itself and is refreshed on every report.
 */
export interface IChatTokenUsageTurn {
	readonly sessionId: string;
	readonly sessionTitle: string | undefined;
	readonly responseId: string;
	/** When the turn started; the ledger attributes tokens to this day. */
	readonly timestamp: number;
	readonly usage: IChatUsage;
}

/**
 * Receives every live usage report for a chat turn. Chat response models cannot
 * inject services (they are constructed from many call sites), so
 * {@link ChatTokenUsageService} installs itself into this module-level slot when
 * the workbench starts and `chatModel.ts` reports through it.
 */
export interface IChatTokenUsageStore {
	recordTurnUsage(turn: IChatTokenUsageTurn, isNewModelCall: boolean): void;
}

let chatTokenUsageStore: IChatTokenUsageStore | undefined;

export function setChatTokenUsageStore(store: IChatTokenUsageStore): void {
	chatTokenUsageStore = store;
}

export function getChatTokenUsageStore(): IChatTokenUsageStore | undefined {
	return chatTokenUsageStore;
}

interface IChatTokenUsageModelNumbers {
	inputTokens: number;
	cachedTokens: number;
	outputTokens: number;
}

type IChatTokenUsageModelMap = Record<string, IChatTokenUsageModelNumbers>;

interface IChatTokenUsageSessionEntry {
	title: string | undefined;
	/** How many turns contributed tokens to this session on this day. */
	turns: number;
	models: IChatTokenUsageModelMap;
}

interface IChatTokenUsageDayEntry {
	models: IChatTokenUsageModelMap;
	sessions: Record<string, IChatTokenUsageSessionEntry>;
}

interface IChatTokenUsageLedgerData {
	version: 1;
	days: Record<string, IChatTokenUsageDayEntry>;
}

/** Per-response memory of what this ledger has already recorded, so re-emitted
 * usage reports (refinements, replays within a window) never double count. */
interface IChatTokenUsageResponseState {
	/** Running per-model totals this ledger has already attributed to the response. */
	recorded: Map<string, IChatTokenUsageModelNumbers>;
	/** The last raw per-call report, used to detect refinements when no model totals exist. */
	lastCall: { model: string; promptTokens: number; completionTokens: number } | undefined;
	/** Days the response has already been counted as a turn on. */
	countedDays: Set<string>;
}

export interface IChatTokenUsageService {
	readonly _serviceBrand: undefined;

	readonly ledgerUri: URI;

	/** Text report of daily per-model and per-task totals, newest day first. */
	renderReport(days: number): Promise<string>;

	/** Persists any pending ledger changes. */
	flush(): Promise<void>;
}

export const IChatTokenUsageService = createDecorator<IChatTokenUsageService>('IChatTokenUsageService');

const MAX_TRACKED_RESPONSES = 3000;
const SAVE_DEBOUNCE_MS = 2000;
const UNKNOWN_MODEL = 'unknown';

export class ChatTokenUsageService implements IChatTokenUsageService, IChatTokenUsageStore {

	declare readonly _serviceBrand: undefined;

	readonly ledgerUri: URI;

	private _ledger: IChatTokenUsageLedgerData = { version: 1, days: {} };
	private readonly _responseStates = new Map<string, IChatTokenUsageResponseState>();
	private readonly _loaded: Promise<void>;
	private readonly _saveScheduler = new RunOnceScheduler(() => this._save(), SAVE_DEBOUNCE_MS);
	private _savePromise: Promise<void> = Promise.resolve();

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IUserDataProfilesService userDataProfilesService: IUserDataProfilesService,
		@ILogService private readonly logService: ILogService,
	) {
		this.ledgerUri = joinPath(userDataProfilesService.defaultProfile.globalStorageHome, 'chat-token-usage-ledger.json');
		setChatTokenUsageStore(this);
		this._loaded = this._load();
	}

	recordTurnUsage(turn: IChatTokenUsageTurn, isNewModelCall: boolean): void {
		try {
			this._recordTurnUsage(turn, isNewModelCall);
		} catch (err) {
			this.logService.error('ChatTokenUsageService: failed to record usage', err);
		}
	}

	private _recordTurnUsage(turn: IChatTokenUsageTurn, isNewModelCall: boolean): void {
		const state = this._ensureResponseState(turn.responseId);
		const usage = turn.usage;

		// Whole-turn totals per model are authoritative when the provider reports
		// them. Without them, prompt/completion tokens describe the most recent
		// model call only, so each *new* call accumulates onto its model's bucket.
		const targets: [model: string, total: IChatTokenUsageModelNumbers][] = [];
		if (usage.modelTotals?.length) {
			for (const total of usage.modelTotals) {
				if (!total?.model) {
					continue;
				}
				targets.push([total.model, {
					inputTokens: nonNegative(total.inputTokens),
					cachedTokens: nonNegative(total.cachedTokens),
					outputTokens: nonNegative(total.outputTokens),
				}]);
			}
		} else if (isNewModelCall) {
			const model = usage.actualModelId ?? UNKNOWN_MODEL;
			const lastCall = state.lastCall;
			const isRefinement = !!lastCall
				&& lastCall.model === model
				&& lastCall.promptTokens === usage.promptTokens
				&& lastCall.completionTokens === usage.completionTokens;
			if (!isRefinement) {
				state.lastCall = { model, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens };
				const previous = state.recorded.get(model) ?? { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
				targets.push([model, {
					inputTokens: previous.inputTokens + nonNegative(usage.promptTokens),
					cachedTokens: previous.cachedTokens,
					outputTokens: previous.outputTokens + nonNegative(usage.completionTokens),
				}]);
			}
		}

		if (!targets.length) {
			return;
		}

		const day = dayKeyFromTimestamp(turn.timestamp);
		let changed = false;
		for (const [model, target] of targets) {
			const previous = state.recorded.get(model) ?? { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
			const delta = {
				inputTokens: target.inputTokens - previous.inputTokens,
				cachedTokens: target.cachedTokens - previous.cachedTokens,
				outputTokens: target.outputTokens - previous.outputTokens,
			};
			if (delta.inputTokens !== 0 || delta.cachedTokens !== 0 || delta.outputTokens !== 0) {
				this._applyDelta(day, turn, model, delta);
				changed = true;
			}
			state.recorded.set(model, target);
		}

		if (changed) {
			this._saveScheduler.schedule();
		}
	}

	private _ensureResponseState(responseId: string): IChatTokenUsageResponseState {
		let state = this._responseStates.get(responseId);
		if (!state) {
			if (this._responseStates.size >= MAX_TRACKED_RESPONSES) {
				const oldest = this._responseStates.keys().next().value;
				if (typeof oldest === 'string') {
					this._responseStates.delete(oldest);
				}
			}
			state = { recorded: new Map(), lastCall: undefined, countedDays: new Set() };
			this._responseStates.set(responseId, state);
		}
		return state;
	}

	private _applyDelta(day: string, turn: IChatTokenUsageTurn, model: string, delta: { inputTokens: number; cachedTokens: number; outputTokens: number }): void {
		const dayEntry = this._ledger.days[day] ??= { models: {}, sessions: {} };
		addToModelMap(dayEntry.models, model, delta);
		const sessionEntry = dayEntry.sessions[turn.sessionId] ??= { title: turn.sessionTitle, turns: 0, models: {} };
		if (turn.sessionTitle !== undefined) {
			sessionEntry.title = turn.sessionTitle;
		}
		addToModelMap(sessionEntry.models, model, delta);

		const state = this._responseStates.get(turn.responseId);
		if (state && !state.countedDays.has(day)) {
			state.countedDays.add(day);
			sessionEntry.turns++;
		}
	}

	private _load(): Promise<void> {
		return (async () => {
			try {
				const content = await this.fileService.readFile(this.ledgerUri);
				const parsed = JSON.parse(content.value.toString()) as IChatTokenUsageLedgerData;
				if (parsed?.version === 1 && parsed.days && typeof parsed.days === 'object') {
					this._ledger = parsed;
				}
			} catch (err) {
				if (err instanceof FileOperationError && err.fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
					return; // first run — no ledger yet
				}
				this.logService.warn('ChatTokenUsageService: could not load ledger, starting fresh', err);
			}
		})();
	}

	private _save(): void {
		this._savePromise = this._savePromise.then(async () => {
			await this._loaded;
			const content = JSON.stringify(this._ledger, null, '\t');
			await this.fileService.writeFile(this.ledgerUri, VSBuffer.fromString(content));
		}).catch(err => {
			this.logService.error('ChatTokenUsageService: could not save ledger', err);
		});
	}

	async flush(): Promise<void> {
		this._saveScheduler.cancel();
		this._save();
		await this._savePromise;
	}

	async renderReport(days: number): Promise<string> {
		await this._loaded;
		const dayKeys = Object.keys(this._ledger.days).sort().reverse().slice(0, Math.max(1, days));
		const lines: string[] = [];
		lines.push(`Chat Token Usage (local time, generated ${new Date().toLocaleString()})`);
		lines.push(`Ledger file: ${this.ledgerUri.scheme === Schemas.file ? this.ledgerUri.fsPath : this.ledgerUri.toString(true)}`);

		lines.push('', '== Daily totals by model ==');
		for (const day of dayKeys) {
			lines.push(`${day}`);
			for (const [model, totals] of sortedByTotalTokens(this._ledger.days[day].models)) {
				lines.push(`  ${pad(model, 34)} input ${fmt(totals.inputTokens)}  cached ${fmt(totals.cachedTokens)}  output ${fmt(totals.outputTokens)}`);
			}
		}
		if (!dayKeys.length) {
			lines.push('(no token usage recorded yet)');
		}

		lines.push('', '== Daily breakdown by task (session) ==');
		for (const day of dayKeys) {
			const sessions = Object.entries(this._ledger.days[day].sessions)
				.sort(([, a], [, b]) => sessionTotalTokens(b) - sessionTotalTokens(a));
			if (!sessions.length) {
				continue;
			}
			lines.push(`${day}`);
			for (const [sessionId, session] of sessions) {
				lines.push(`  [${sessionId.slice(0, 8)}] ${session.title ?? '(untitled)'} — ${session.turns} turn${session.turns === 1 ? '' : 's'}`);
				for (const [model, totals] of sortedByTotalTokens(session.models)) {
					lines.push(`      ${pad(model, 30)} input ${fmt(totals.inputTokens)}  cached ${fmt(totals.cachedTokens)}  output ${fmt(totals.outputTokens)}`);
				}
			}
		}
		if (!dayKeys.length) {
			lines.push('(no tasks recorded yet)');
		}

		lines.push('', 'Notes: "input" counts full context per model call, "cached" is the provider-reported');
		lines.push('cached portion of input. Turns without provider model totals are best effort.');
		return lines.join('\n');
	}
}

function dayKeyFromTimestamp(timestamp: number): string {
	const date = new Date(timestamp);
	const month = `${date.getMonth() + 1}`.padStart(2, '0');
	const day = `${date.getDate()}`.padStart(2, '0');
	return `${date.getFullYear()}-${month}-${day}`;
}

function nonNegative(value: number | undefined): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function addToModelMap(map: IChatTokenUsageModelMap, model: string, delta: { inputTokens: number; cachedTokens: number; outputTokens: number }): void {
	const entry = map[model] ?? { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
	entry.inputTokens = Math.max(0, entry.inputTokens + delta.inputTokens);
	entry.cachedTokens = Math.max(0, entry.cachedTokens + delta.cachedTokens);
	entry.outputTokens = Math.max(0, entry.outputTokens + delta.outputTokens);
	map[model] = entry;
}

function sortedByTotalTokens(map: IChatTokenUsageModelMap): [string, IChatTokenUsageModelNumbers][] {
	return Object.entries(map).sort(([, a], [, b]) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
}

function sessionTotalTokens(session: IChatTokenUsageSessionEntry): number {
	return Object.values(session.models).reduce((sum, totals) => sum + totals.inputTokens + totals.outputTokens, 0);
}

function fmt(value: number): string {
	return value.toLocaleString();
}

function pad(value: string, length: number): string {
	return value.length >= length ? value : value + ' '.repeat(length - value.length);
}
