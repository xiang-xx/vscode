/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TimeoutTimer } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { derived, IObservable, observableValue, transaction } from '../../../../../base/common/observable.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { DEFAULT_MAX_CONCURRENT_WORKERS, DEFAULT_WATCHDOG_INTERVAL_MS, IChatRouterService, ISuperAgentEvent, ISuperAgentWorkerHandle, ISuperAgentWorkerHistoryEntry, ISuperAgentWorkerOptions, SuperAgentEventKind, SuperAgentWorkerState, superAgentWorkerStateIsActive, SUPER_AGENT_WORKER_ACCENTS } from '../../common/superAgent/chatRouterService.js';
import { parseZcodeSessionId } from './zcodeSessionUri.js';

const WORKERS_STORAGE_KEY = 'chat.superAgent.workers.v1';
const HISTORY_LIMIT = 100;

interface IPersistedWorker {
	readonly id: string;
	readonly label: string;
	readonly chatSessionResource: string;
	readonly createdAt: number;
	readonly slot: number;
	readonly state: SuperAgentWorkerState;
	readonly lastActivityAt: number;
	readonly watchdogIntervalMs: number;
}

interface IPersistedHistoryEntry extends IPersistedWorker {
	readonly closedAt: number;
}

interface IPersistedRoster {
	readonly version: 1;
	readonly workers: readonly IPersistedWorker[];
	readonly history: readonly IPersistedHistoryEntry[];
}

interface IWorkerRestoreSeed {
	readonly id: string;
	readonly createdAt: number;
	readonly state: SuperAgentWorkerState;
	readonly lastActivityAt: number;
}

class SuperAgentWorker extends Disposable implements ISuperAgentWorkerHandle {

	readonly id: string;
	readonly createdAt: number;
	readonly badge: string;
	readonly accentColorId: string;

	private _label: string;
	get label(): string { return this._label; }

	readonly state = observableValue<SuperAgentWorkerState>(this, SuperAgentWorkerState.Starting);
	readonly lastActivityAt = observableValue<number>(this, Date.now());
	readonly queuedInputs = observableValue<readonly string[]>(this, []);
	readonly pendingInterrupt = observableValue<boolean>(this, false);
	readonly isFocused = observableValue<boolean>(this, false);

	readonly watchdog = this._register(new TimeoutTimer());

	constructor(
		label: string,
		readonly chatSessionResource: URI,
		readonly slot: number,
		readonly watchdogIntervalMs: number,
		private readonly _onTrip: (worker: SuperAgentWorker) => void,
		seed?: IWorkerRestoreSeed,
	) {
		super();
		this._label = label;
		this.id = seed?.id ?? generateUuid();
		this.createdAt = seed?.createdAt ?? Date.now();
		this.badge = String(slot);
		this.accentColorId = SUPER_AGENT_WORKER_ACCENTS[(slot - 1) % SUPER_AGENT_WORKER_ACCENTS.length];
		if (seed) {
			this.state.set(seed.state, undefined);
			this.lastActivityAt.set(seed.lastActivityAt, undefined);
		}
	}

	setLabel(label: string): void {
		this._label = label;
	}

	/** (Re)arms the watchdog. Called for every activity heartbeat. */
	armWatchdog(): void {
		this.watchdog.cancelAndSet(() => this._onTrip(this), this.watchdogIntervalMs);
	}

	setWorkerState(state: SuperAgentWorkerState): void {
		this.state.set(state, undefined);
	}
}

/**
 * Super-Agent router: orchestrates worker chat sessions behind a single
 * conversation. Workers execute concurrently (budgeted), report into a shared
 * event bus, are supervised by per-worker watchdogs and never block user
 * input (full-duplex). See `superAgentRedesign.md` for the full design.
 *
 * Live workers and closed-worker history are persisted in workspace storage so
 * a window reload keeps the Workers list and lets finished tasks be restored.
 */
export class ChatRouterService extends Disposable implements IChatRouterService {

	_serviceBrand: undefined;

	private readonly _workersObs = observableValue<readonly SuperAgentWorker[]>(this, []);
	private readonly _historyObs = observableValue<readonly ISuperAgentWorkerHistoryEntry[]>(this, []);
	private readonly _focusedWorkerIdObs = observableValue<string | undefined>(this, undefined);

	private readonly _onDidWorkerEvent = new Emitter<ISuperAgentEvent>();

	readonly onDidWorkerEvent: Event<ISuperAgentEvent> = this._onDidWorkerEvent.event;
	readonly workers: IObservable<readonly ISuperAgentWorkerHandle[]> = derived(reader => this._workersObs.read(reader));
	readonly history: IObservable<readonly ISuperAgentWorkerHistoryEntry[]> = this._historyObs;
	readonly focusedWorkerId: IObservable<string | undefined> = this._focusedWorkerIdObs;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this._register(this._onDidWorkerEvent);
		this._restoreFromStorage();
		this._register(this.storageService.onWillSaveState(() => this._persist()));
	}

	createWorker(options: ISuperAgentWorkerOptions): ISuperAgentWorkerHandle {
		const hasFreeSlot = this._workersObs.get().filter(w => superAgentWorkerStateIsActive(w.state.get())).length < DEFAULT_MAX_CONCURRENT_WORKERS;
		const worker = new SuperAgentWorker(
			options.label,
			options.chatSessionResource,
			this._nextSlot(),
			options.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS,
			w => this._onWatchdogTripped(w),
		);
		worker.setWorkerState(hasFreeSlot ? SuperAgentWorkerState.Starting : SuperAgentWorkerState.Queued);
		transaction(tx => {
			this._workersObs.set([...this._workersObs.get(), worker], tx);
		});
		if (worker.state.get() !== SuperAgentWorkerState.Queued) {
			worker.armWatchdog();
		}
		this._fire(worker.id, 'workerCreated', options.label);
		this._persist();

		// Do not auto-focus on create: running workers stay silent until the
		// presentation queue surfaces them (§5). Editor ownership follows present().
		return worker;
	}

	getWorker(workerId: string): ISuperAgentWorkerHandle | undefined {
		return this._workersObs.get().find(w => w.id === workerId);
	}

	getWorkerForChatSession(chatSessionResource: URI): ISuperAgentWorkerHandle | undefined {
		return this._workersObs.get().find(w => isEqual(w.chatSessionResource, chatSessionResource));
	}

	renameWorker(workerId: string, label: string): void {
		const next = label.trim();
		if (!next) {
			return;
		}
		const worker = this._workersObs.get().find(w => w.id === workerId);
		if (!worker || worker.label === next) {
			return;
		}
		worker.setLabel(next);
		// New array identity so UI autoruns that depend on `workers` re-render labels.
		transaction(tx => {
			this._workersObs.set([...this._workersObs.get()], tx);
		});
		this._fire(workerId, 'labelChanged', next);
		this._persist();
	}

	removeWorker(workerId: string): void {
		const worker = this._workersObs.get().find(w => w.id === workerId);
		if (!worker) {
			return;
		}
		worker.watchdog.cancel();
		const entry = this._toHistoryEntry(worker, Date.now());
		transaction(tx => {
			this._workersObs.set(this._workersObs.get().filter(w => w.id !== workerId), tx);
			this._historyObs.set(
				[entry, ...this._historyObs.get().filter(h => h.id !== workerId)].slice(0, HISTORY_LIMIT),
				tx,
			);
		});
		worker.dispose();
		this._fire(workerId, 'workerRemoved', worker.label, parseZcodeSessionId(worker.chatSessionResource));

		if (this._focusedWorkerIdObs.get() === workerId) {
			const next = this._workersObs.get()[0];
			if (next) {
				this.focusWorker(next.id);
			} else {
				this.clearFocusedWorker();
			}
		}
		this._maybePromoteQueued();
		this._persist();
	}

	/**
	 * Force-remove: no state gate, but the worker is still archived into
	 * history so it can be restored or cleared from there. Older history rows
	 * pointing at the same chat session are replaced by the fresh entry (no
	 * duplicates), and rows sharing the id are deduped the same way.
	 */
	forceRemoveWorker(workerId: string): void {
		const worker = this._workersObs.get().find(w => w.id === workerId);
		if (!worker) {
			// Not live anymore — at least purge a matching history row.
			this.deleteHistoryEntry(workerId);
			return;
		}
		worker.watchdog.cancel();
		const entry = this._toHistoryEntry(worker, Date.now());
		const session = worker.chatSessionResource.toString();
		transaction(tx => {
			this._workersObs.set(this._workersObs.get().filter(w => w.id !== workerId), tx);
			this._historyObs.set(
				[entry, ...this._historyObs.get().filter(h => h.id !== workerId && h.chatSessionResource.toString() !== session)].slice(0, HISTORY_LIMIT),
				tx,
			);
		});
		worker.dispose();
		this._fire(workerId, 'workerRemoved', `force-removed:${worker.label}`, parseZcodeSessionId(worker.chatSessionResource));

		if (this._focusedWorkerIdObs.get() === workerId) {
			const next = this._workersObs.get()[0];
			if (next) {
				this.focusWorker(next.id);
			} else {
				this.clearFocusedWorker();
			}
		}
		this._maybePromoteQueued();
		this._persist();
	}

	restoreWorker(workerId: string): ISuperAgentWorkerHandle | undefined {
		const entry = this._historyObs.get().find(h => h.id === workerId);
		if (!entry) {
			return undefined;
		}
		if (this.getWorker(workerId) || this.getWorkerForChatSession(entry.chatSessionResource)) {
			// Already live — just drop the duplicate history row.
			transaction(tx => {
				this._historyObs.set(this._historyObs.get().filter(h => h.id !== workerId), tx);
			});
			this._persist();
			return this.getWorker(workerId) ?? this.getWorkerForChatSession(entry.chatSessionResource);
		}

		const worker = new SuperAgentWorker(
			entry.label,
			entry.chatSessionResource,
			entry.slot,
			DEFAULT_WATCHDOG_INTERVAL_MS,
			w => this._onWatchdogTripped(w),
			{
				id: entry.id,
				createdAt: entry.createdAt,
				state: SuperAgentWorkerState.Idle,
				lastActivityAt: entry.closedAt,
			},
		);
		transaction(tx => {
			this._historyObs.set(this._historyObs.get().filter(h => h.id !== workerId), tx);
			this._workersObs.set([...this._workersObs.get(), worker], tx);
		});
		this._fire(worker.id, 'workerCreated', `restored:${worker.label}`);
		this._persist();
		return worker;
	}

	deleteHistoryEntry(workerId: string): void {
		const entry = this._historyObs.get().find(h => h.id === workerId);
		const prev = this._historyObs.get();
		const next = prev.filter(h => h.id !== workerId);
		if (next.length === prev.length) {
			return;
		}
		transaction(tx => this._historyObs.set(next, tx));
		// Deleting a history row must also purge the worker's Router board
		// card — fire the same event a rail removal does, so the dispatcher
		// tells zcode-chat to drop the dispatch bubbles and record the
		// removal instead of leaving an unclickable zombie card behind. The
		// session id rides along so the extension can also delete the
		// worker's session file (its kind:'worker' tag is what rehydration
		// scans — a leftover file resurrected the card on every reload).
		this._fire(workerId, 'workerRemoved', 'history-deleted', entry ? parseZcodeSessionId(entry.chatSessionResource) : undefined);
		this._persist();
	}

	clearHistory(): void {
		const prev = this._historyObs.get();
		if (prev.length === 0) {
			return;
		}
		transaction(tx => this._historyObs.set([], tx));
		// Same purge as deleteHistoryEntry, for every cleared row.
		for (const entry of prev) {
			this._fire(entry.id, 'workerRemoved', 'history-cleared', parseZcodeSessionId(entry.chatSessionResource));
		}
		this._persist();
	}

	focusWorker(workerId: string): void {
		const worker = this.getWorker(workerId);
		if (!worker || this._focusedWorkerIdObs.get() === workerId) {
			return;
		}
		transaction(tx => {
			for (const w of this._workersObs.get()) {
				w.isFocused.set(w.id === workerId, tx);
			}
			this._focusedWorkerIdObs.set(workerId, tx);
		});
		this._fire(workerId, 'focusChanged', worker.label);
	}

	clearFocusedWorker(): void {
		if (this._focusedWorkerIdObs.get() === undefined) {
			return;
		}
		transaction(tx => {
			for (const w of this._workersObs.get()) {
				w.isFocused.set(false, tx);
			}
			this._focusedWorkerIdObs.set(undefined, tx);
		});
		this._fire('', 'focusChanged', 'router');
	}

	queueInput(workerId: string, input: string): void {
		const worker = this._workerById(workerId);
		if (!worker) {
			return;
		}
		worker.queuedInputs.set([...worker.queuedInputs.get(), input], undefined);
		this.recordActivity(workerId);
		this._fire(workerId, 'inputQueued', input);
	}

	takeQueuedInputs(workerId: string): string[] {
		const worker = this._workerById(workerId);
		if (!worker) {
			return [];
		}
		const inputs = worker.queuedInputs.get();
		worker.queuedInputs.set([], undefined);
		return [...inputs];
	}

	interrupt(workerId: string, reason?: string): void {
		const worker = this._workerById(workerId);
		if (!worker) {
			return;
		}
		worker.pendingInterrupt.set(true, undefined);
		this._fire(workerId, 'interrupted', reason);
	}

	acknowledgeInterrupt(workerId: string): void {
		const worker = this._workerById(workerId);
		if (worker) {
			worker.pendingInterrupt.set(false, undefined);
		}
	}

	recordActivity(workerId: string, detail?: string): void {
		const worker = this._workerById(workerId);
		if (!worker || !superAgentWorkerStateIsActive(worker.state.get())) {
			return;
		}
		worker.lastActivityAt.set(Date.now(), undefined);
		worker.armWatchdog();
		const state = worker.state.get();
		if (state === SuperAgentWorkerState.WatchdogTripped) {
			// Heartbeat recovered the worker — clear sticky "疑似卡死".
			worker.setWorkerState(SuperAgentWorkerState.Running);
			this._fire(workerId, 'stateChanged', 'watchdog recovered');
			this._persist();
		} else if (state === SuperAgentWorkerState.Starting) {
			// First heartbeat: the worker's first turn is demonstrably underway.
			worker.setWorkerState(SuperAgentWorkerState.Running);
			this._fire(workerId, 'stateChanged', 'first activity');
		} else if (
			state === SuperAgentWorkerState.Idle
			|| state === SuperAgentWorkerState.Completed
			|| state === SuperAgentWorkerState.AwaitingUser
		) {
			// A new turn (or resumed answer) is underway — resume progress supervision.
			worker.setWorkerState(SuperAgentWorkerState.Running);
			this._fire(workerId, 'stateChanged', 'resumed');
		}
		this._fire(workerId, 'activity', detail);
	}

	/**
	 * A deliberate follow-up dispatch makes a terminal worker live again.
	 * `recordActivity` ignores Failed/Cancelled (its heartbeats can't distinguish
	 * a new turn from teardown noise), so without an explicit revive the worker
	 * rail and Router receipts stay stuck on "failed"/"cancelled" while the new
	 * turn is actually running.
	 */
	reviveWorker(workerId: string, detail?: string): void {
		const worker = this._workerById(workerId);
		if (!worker) {
			return;
		}
		const state = worker.state.get();
		if (state !== SuperAgentWorkerState.Failed && state !== SuperAgentWorkerState.Cancelled) {
			return;
		}
		worker.lastActivityAt.set(Date.now(), undefined);
		worker.armWatchdog();
		worker.setWorkerState(SuperAgentWorkerState.Running);
		this._fire(workerId, 'stateChanged', detail ?? 'revived');
	}

	markIdle(workerId: string, detail?: string): void {
		const worker = this._workerById(workerId);
		if (!worker || !superAgentWorkerStateIsActive(worker.state.get())) {
			return;
		}
		if (worker.state.get() === SuperAgentWorkerState.Idle) {
			return;
		}
		// Viewed / between-turns silence is expected — stop supervising until the
		// next heartbeat. Leaving the timer armed falsely trips WatchdogTripped.
		worker.watchdog.cancel();
		worker.setWorkerState(SuperAgentWorkerState.Idle);
		this._fire(workerId, 'stateChanged', detail ?? 'viewed');
		this._persist();
	}

	markAwaitingUser(workerId: string, detail?: string): void {
		const worker = this._workerById(workerId);
		if (!worker || !superAgentWorkerStateIsActive(worker.state.get())) {
			return;
		}
		if (worker.state.get() === SuperAgentWorkerState.AwaitingUser) {
			return;
		}
		// Waiting on the human is intentionally quiet — do not let the watchdog
		// brand a blocked prompt as stalled.
		worker.watchdog.cancel();
		worker.setWorkerState(SuperAgentWorkerState.AwaitingUser);
		this._fire(workerId, 'stateChanged', detail ?? 'awaiting user');
		this._persist();
	}

	completeWorker(workerId: string, detail?: string): void {
		this._finish(workerId, SuperAgentWorkerState.Completed, detail);
	}

	failWorker(workerId: string, detail?: string): void {
		this._finish(workerId, SuperAgentWorkerState.Failed, detail);
	}

	cancelWorker(workerId: string, detail?: string): void {
		this._finish(workerId, SuperAgentWorkerState.Cancelled, detail);
	}

	override dispose(): void {
		this._persist();
		for (const worker of this._workersObs.get()) {
			worker.dispose();
		}
		transaction(tx => this._workersObs.set([], tx));
		super.dispose();
	}

	private _workerById(workerId: string): SuperAgentWorker | undefined {
		return this._workersObs.get().find(w => w.id === workerId);
	}

	private _finish(workerId: string, state: SuperAgentWorkerState, detail?: string): void {
		const worker = this._workerById(workerId);
		if (!worker) {
			return;
		}
		worker.watchdog.cancel();
		worker.setWorkerState(state);
		this._fire(workerId, 'stateChanged', detail);
		this._maybePromoteQueued();
		this._persist();
	}

	private _onWatchdogTripped(worker: SuperAgentWorker): void {
		const state = worker.state.get();
		// Only Starting/Running expect continuous heartbeats. Idle / Completed /
		// AwaitingUser are intentionally quiet (between turns or waiting on the human).
		if (state !== SuperAgentWorkerState.Starting && state !== SuperAgentWorkerState.Running) {
			return;
		}
		worker.setWorkerState(SuperAgentWorkerState.WatchdogTripped);
		this._fire(worker.id, 'watchdogTripped', `no activity for ${worker.watchdogIntervalMs}ms`);
		this._persist();
	}

	private _maybePromoteQueued(): void {
		const workers = this._workersObs.get();
		let activeCount = workers.filter(w => superAgentWorkerStateIsActive(w.state.get())).length;
		for (const worker of workers) {
			if (activeCount >= DEFAULT_MAX_CONCURRENT_WORKERS) {
				break;
			}
			if (worker.state.get() === SuperAgentWorkerState.Queued) {
				worker.setWorkerState(SuperAgentWorkerState.Starting);
				worker.armWatchdog();
				this._fire(worker.id, 'stateChanged', 'promoted from queue');
				activeCount++;
			}
		}
	}

	private _nextSlot(): number {
		const liveMax = this._workersObs.get().reduce((max, w) => Math.max(max, w.slot), 0);
		const historyMax = this._historyObs.get().reduce((max, h) => Math.max(max, h.slot), 0);
		return Math.max(liveMax, historyMax) + 1;
	}

	private _fire(workerId: string, kind: SuperAgentEventKind, detail?: string, workerSessionId?: string): void {
		this._onDidWorkerEvent.fire({ workerId, kind, timestamp: Date.now(), detail, workerSessionId });
	}

	private _toHistoryEntry(worker: SuperAgentWorker, closedAt: number): ISuperAgentWorkerHistoryEntry {
		return {
			id: worker.id,
			label: worker.label,
			chatSessionResource: worker.chatSessionResource,
			createdAt: worker.createdAt,
			closedAt,
			slot: worker.slot,
			badge: worker.badge,
			accentColorId: worker.accentColorId,
			finalState: worker.state.get(),
		};
	}

	/**
	 * After a reload, mid-turn workers cannot resume the aborted request.
	 * Keep terminal states; collapse every other state to Idle so the user
	 * still sees the worker and can continue in its chat session.
	 */
	private _stateAfterReload(state: SuperAgentWorkerState): SuperAgentWorkerState {
		switch (state) {
			case SuperAgentWorkerState.Completed:
			case SuperAgentWorkerState.Failed:
			case SuperAgentWorkerState.Cancelled:
				return state;
			default:
				return SuperAgentWorkerState.Idle;
		}
	}

	private _restoreFromStorage(): void {
		const raw = this.storageService.get(WORKERS_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return;
		}
		let roster: IPersistedRoster | undefined;
		try {
			roster = JSON.parse(raw) as IPersistedRoster;
		} catch {
			return;
		}
		if (!roster || roster.version !== 1 || !Array.isArray(roster.workers) || !Array.isArray(roster.history)) {
			return;
		}

		const workers: SuperAgentWorker[] = [];
		const seenSessions = new Set<string>();
		for (const row of roster.workers) {
			if (!row?.id || !row.chatSessionResource || !row.label) {
				continue;
			}
			if (seenSessions.has(row.chatSessionResource)) {
				continue;
			}
			seenSessions.add(row.chatSessionResource);
			let resource: URI;
			try {
				resource = URI.parse(row.chatSessionResource);
			} catch {
				continue;
			}
			const worker = new SuperAgentWorker(
				row.label,
				resource,
				Math.max(1, Math.floor(row.slot) || workers.length + 1),
				row.watchdogIntervalMs || DEFAULT_WATCHDOG_INTERVAL_MS,
				w => this._onWatchdogTripped(w),
				{
					id: row.id,
					createdAt: row.createdAt || Date.now(),
					state: this._stateAfterReload(row.state),
					lastActivityAt: row.lastActivityAt || row.createdAt || Date.now(),
				},
			);
			workers.push(worker);
		}

		const history: ISuperAgentWorkerHistoryEntry[] = [];
		for (const row of roster.history) {
			if (!row?.id || !row.chatSessionResource || !row.label) {
				continue;
			}
			if (seenSessions.has(row.chatSessionResource) || history.some(h => h.id === row.id)) {
				continue;
			}
			let resource: URI;
			try {
				resource = URI.parse(row.chatSessionResource);
			} catch {
				continue;
			}
			const slot = Math.max(1, Math.floor(row.slot) || 1);
			history.push({
				id: row.id,
				label: row.label,
				chatSessionResource: resource,
				createdAt: row.createdAt || Date.now(),
				closedAt: row.closedAt || row.lastActivityAt || Date.now(),
				slot,
				badge: String(slot),
				accentColorId: SUPER_AGENT_WORKER_ACCENTS[(slot - 1) % SUPER_AGENT_WORKER_ACCENTS.length],
				finalState: row.state || SuperAgentWorkerState.Cancelled,
			});
		}

		transaction(tx => {
			this._workersObs.set(workers, tx);
			this._historyObs.set(history.slice(0, HISTORY_LIMIT), tx);
		});
	}

	private _persist(): void {
		const workers: IPersistedWorker[] = this._workersObs.get().map(w => ({
			id: w.id,
			label: w.label,
			chatSessionResource: w.chatSessionResource.toString(),
			createdAt: w.createdAt,
			slot: w.slot,
			state: w.state.get(),
			lastActivityAt: w.lastActivityAt.get(),
			watchdogIntervalMs: w.watchdogIntervalMs,
		}));
		const history: IPersistedHistoryEntry[] = this._historyObs.get().map(h => ({
			id: h.id,
			label: h.label,
			chatSessionResource: h.chatSessionResource.toString(),
			createdAt: h.createdAt,
			slot: h.slot,
			state: h.finalState,
			lastActivityAt: h.closedAt,
			watchdogIntervalMs: DEFAULT_WATCHDOG_INTERVAL_MS,
			closedAt: h.closedAt,
		}));
		const roster: IPersistedRoster = { version: 1, workers, history };
		this.storageService.store(WORKERS_STORAGE_KEY, JSON.stringify(roster), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}
