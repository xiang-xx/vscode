/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import { IObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';

//#region Constants

/**
 * Execution budget: how many workers may occupy a concurrency slot at once.
 * Extra tasks are queued until a slot frees up, so dispatching never
 * overwhelms the machine.
 *
 * This is deliberately NOT the human attention budget (humans track ~3-5
 * sessions at full fidelity). Attention is rationed by the UI layer —
 * one page, a presentation queue, and a bottom-right tip (see §5 of
 * superAgentRedesign.md) — not by refusing work or switching tabs.
 */
export const DEFAULT_MAX_CONCURRENT_WORKERS = 10;

/** Default inactivity budget before a worker's watchdog trips. */
export const DEFAULT_WATCHDOG_INTERVAL_MS = 120_000;

/**
 * Theme color ids assigned round-robin to workers (by slot) so that every
 * worker's edits are visually attributable across the workbench.
 *
 * The palette holds every `charts.*` hue registered in this checkout
 * (6 total; `charts.pink` does not exist here). When slots (10) exceed the
 * palette, hues repeat via modulo — the slot badge is the unique attribution
 * key, the hue is a secondary cue. Phase 2 may register dedicated
 * `superAgent.*` theme colors if 10-way distinctness proves necessary.
 */
export const SUPER_AGENT_WORKER_ACCENTS = [
	'charts.blue',
	'charts.orange',
	'charts.purple',
	'charts.green',
	'charts.red',
	'charts.yellow',
] as const;

//#endregion

//#region Worker model

/**
 * Lifecycle of a Super-Agent worker. The router owns this state machine;
 * execution layers (chat requests, tool runs) report progress into it via
 * {@link IChatRouterService.recordActivity} and terminal transitions.
 */
export const enum SuperAgentWorkerState {
	/** Waiting for a free concurrency slot. */
	Queued = 'Queued',
	/** Warming up: context assembly, first model call. */
	Starting = 'Starting',
	/** Making progress on the current turn. */
	Running = 'Running',
	/** Asked the user a question or hit a permission prompt. */
	AwaitingUser = 'AwaitingUser',
	/**
	 * Turn finished and the user has already viewed this worker.
	 * No bottom-right tip; ready for follow-up input.
	 */
	Idle = 'Idle',
	/** The watchdog fired: no activity within the configured budget. */
	WatchdogTripped = 'WatchdogTripped',
	/**
	 * Turn finished but not yet viewed — "已完成 / 待查看".
	 * Surfaced via the presentation toast until the user opens it, then → Idle.
	 */
	Completed = 'Completed',
	/** Task failed. */
	Failed = 'Failed',
	/** Cancelled by the user or the router. */
	Cancelled = 'Cancelled',
}

/** Whether a state occupies one of the concurrency slots. */
export function superAgentWorkerStateIsActive(state: SuperAgentWorkerState): boolean {
	return state === SuperAgentWorkerState.Starting
		|| state === SuperAgentWorkerState.Running
		|| state === SuperAgentWorkerState.AwaitingUser
		|| state === SuperAgentWorkerState.Idle
		|| state === SuperAgentWorkerState.Completed
		|| state === SuperAgentWorkerState.WatchdogTripped;
}

export type SuperAgentEventKind =
	| 'workerCreated'
	| 'workerRemoved'
	| 'stateChanged'
	| 'labelChanged'
	| 'activity'
	| 'inputQueued'
	| 'interrupted'
	| 'watchdogTripped'
	| 'focusChanged';

/**
 * A single item on the Super-Agent event bus. The Router UI, the editor-area
 * coordinator, telemetry and the (future) main-process watchdog all subscribe
 * to this stream instead of polling worker state.
 */
export interface ISuperAgentEvent {
	readonly workerId: string;
	readonly kind: SuperAgentEventKind;
	readonly timestamp: number;
	readonly detail?: string;
}

/**
 * Live handle onto a worker. All mutable facets are observables so that UI and
 * editor integrations can react without imperative wiring.
 */
export interface ISuperAgentWorkerHandle {
	readonly id: string;
	/** Short user-facing label of the task, e.g. "Fix flaky tests". */
	readonly label: string;
	/**
	 * The chat session this worker executes in. This is the key that binds a
	 * worker to its {@link IChatEditingSession} (working set, checkpoints).
	 */
	readonly chatSessionResource: URI;
	readonly createdAt: number;
	/** Stable 1-based slot number; reused for badges and accent color. */
	readonly slot: number;
	/** Badge glyph ("1".."10", the 1-based slot number) used for file attribution decorations. */
	readonly badge: string;
	/** Theme color id for all visuals belonging to this worker. */
	readonly accentColorId: string;

	readonly state: IObservable<SuperAgentWorkerState>;
	/** Timestamp of the last activity heartbeat (drives the watchdog). */
	readonly lastActivityAt: IObservable<number>;
	/** Inputs queued while the worker was mid-turn (full-duplex input channel). */
	readonly queuedInputs: IObservable<readonly string[]>;
	/** Set while a cooperative interrupt is pending. */
	readonly pendingInterrupt: IObservable<boolean>;
	/** Whether this worker currently owns the editor area. */
	readonly isFocused: IObservable<boolean>;
}

export interface ISuperAgentWorkerOptions {
	label: string;
	chatSessionResource: URI;
	/** Inactivity budget in ms before this worker's watchdog trips. */
	watchdogIntervalMs?: number;
}

/**
 * A worker that was closed (removed from the live list). The underlying chat
 * session stays on disk so {@link IChatRouterService.restoreWorker} can bring
 * it back into the Workers list.
 */
export interface ISuperAgentWorkerHistoryEntry {
	readonly id: string;
	readonly label: string;
	readonly chatSessionResource: URI;
	readonly createdAt: number;
	/** When the worker was removed from the live list. */
	readonly closedAt: number;
	readonly slot: number;
	readonly badge: string;
	readonly accentColorId: string;
	readonly finalState: SuperAgentWorkerState;
}

//#endregion

export interface IChatRouterService {

	_serviceBrand: undefined;

	/** The Super-Agent event bus: one stream for all workers and kinds. */
	readonly onDidWorkerEvent: Event<ISuperAgentEvent>;
	readonly workers: IObservable<readonly ISuperAgentWorkerHandle[]>;
	/**
	 * Closed workers (removed from the live list). Newest first. Survives
	 * window reload so the user can restore a finished task.
	 */
	readonly history: IObservable<readonly ISuperAgentWorkerHistoryEntry[]>;
	/**
	 * The worker that owns the editor area right now. `undefined` means the
	 * Router/root chat stream owns it (see SuperAgentEditorCoordinator).
	 */
	readonly focusedWorkerId: IObservable<string | undefined>;

	/**
	 * Creates a worker bound to a chat session. Starts immediately when a
	 * concurrency slot is free, otherwise the worker is queued.
	 */
	createWorker(options: ISuperAgentWorkerOptions): ISuperAgentWorkerHandle;
	getWorker(workerId: string): ISuperAgentWorkerHandle | undefined;
	/** Finds the worker executing in the given chat session, if any. */
	getWorkerForChatSession(chatSessionResource: URI): ISuperAgentWorkerHandle | undefined;
	/**
	 * Replaces the worker's short label (e.g. after AI title summarization).
	 * No-op when the worker is missing or the label is unchanged.
	 */
	renameWorker(workerId: string, label: string): void;
	/**
	 * Removes a worker from the live list and archives it into {@link history}
	 * so it can be restored later. Does not delete the chat session.
	 */
	removeWorker(workerId: string): void;
	/**
	 * Force-removes a worker from the live list regardless of state — nothing
	 * is archived into {@link history}, and any history rows sharing the
	 * worker's id or chat session are dropped as well so the entry cannot be
	 * restored later. Escape hatch for stale roster entries (e.g. the chat
	 * session was already deleted). Does not delete the chat session itself.
	 */
	forceRemoveWorker(workerId: string): void;
	/**
	 * Re-opens a closed worker from {@link history} into the live list (Idle).
	 * Returns undefined if the history entry is missing.
	 */
	restoreWorker(workerId: string): ISuperAgentWorkerHandle | undefined;
	/** Permanently drops a history entry (chat session is left on disk). */
	deleteHistoryEntry(workerId: string): void;
	clearHistory(): void;

	/**
	 * Transfers editor-area ownership to a worker: the coordinator parks the
	 * outgoing owner's open editors (files, built-in browser tabs, layout) and
	 * restores this worker's set so background workers never steal the stage
	 * (see SuperAgentEditorCoordinator).
	 */
	focusWorker(workerId: string): void;
	/**
	 * Returns editor-area ownership to the Router/root chat stream. The
	 * coordinator parks the outgoing worker's tabs and restores the root set.
	 */
	clearFocusedWorker(): void;

	/**
	 * Full-duplex input: queues a user message for a worker that may be
	 * mid-turn. The execution layer drains these between tool calls / on turn
	 * boundaries via {@link takeQueuedInputs}.
	 */
	queueInput(workerId: string, input: string): void;
	/** Drains and clears queued inputs, returning them in order. */
	takeQueuedInputs(workerId: string): string[];

	/**
	 * Cooperative interrupt: marks the worker and emits `interrupted` on the
	 * bus. The execution layer cancels the in-flight request at the next
	 * opportunity, optionally injecting the interrupt reason into the context.
	 */
	interrupt(workerId: string, reason?: string): void;
	/** Clears the pending-interrupt flag once the execution layer reacted. */
	acknowledgeInterrupt(workerId: string): void;

	/**
	 * Heartbeat: any progress (streaming token, tool call, checkpoint) resets
	 * the worker's watchdog. A heartbeat after a trip recovers the worker.
	 */
	recordActivity(workerId: string, detail?: string): void;

	/**
	 * A deliberate follow-up dispatch to a terminal (Failed/Cancelled) worker
	 * makes it Running again. Heartbeats alone can't do this — they ignore
	 * terminal states — so call this when the user re-dispatches to a worker.
	 */
	reviveWorker(workerId: string, detail?: string): void;

	/**
	 * User viewed a finished turn (or acknowledged the worker). Moves
	 * Completed → Idle so the tip / toast clears. Keeps the concurrency slot.
	 */
	markIdle(workerId: string, detail?: string): void;

	/**
	 * Worker is blocked on a human answer (permission / ask-user). Cancels the
	 * watchdog until the next heartbeat — silence here is expected.
	 */
	markAwaitingUser(workerId: string, detail?: string): void;

	/**
	 * Turn finished successfully, unread. Moves to Completed so the presentation
	 * queue can toast「查看」; viewing then calls {@link markIdle}.
	 * Still occupies a concurrency slot (unlike Failed / Cancelled).
	 */
	completeWorker(workerId: string, detail?: string): void;
	failWorker(workerId: string, detail?: string): void;
	cancelWorker(workerId: string, detail?: string): void;
}

export const IChatRouterService = createDecorator<IChatRouterService>('IChatRouterService');
