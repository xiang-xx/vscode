/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IObservable } from '../../../../../base/common/observable.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';

/**
 * Why a worker is being surfaced on the single Router page (§5 of
 * superAgentRedesign.md). Running workers stay silent; only these reasons
 * may enter the presentation queue.
 */
export type SuperAgentPresentationReason =
	| 'completed'
	| 'failed'
	| 'awaitingUser'
	| 'watchdogTripped'
	| 'turnDone';

export interface ISuperAgentPresentationItem {
	readonly workerId: string;
	readonly reason: SuperAgentPresentationReason;
	readonly enqueuedAt: number;
}

/**
 * Attention gate for the single-page Super Agent surface.
 *
 * - At most one worker is **presented** (page-bottom interaction) at a time.
 * - If the user is already interacting with a presented worker, new arrivals
 *   stay in {@link pending} and only a bottom-right tip is shown.
 * - Dismissing the presented worker promotes the queue head automatically.
 */
export interface ISuperAgentPresentationQueue {
	_serviceBrand: undefined;

	/** Worker currently filling the page-bottom interaction slot, if any. */
	readonly presentedWorkerId: IObservable<string | undefined>;
	/** Workers waiting because the slot is occupied (FIFO). */
	readonly pending: IObservable<readonly ISuperAgentPresentationItem[]>;
	/** Tip shown at the bottom-right while {@link pending} is non-empty. */
	readonly toast: IObservable<ISuperAgentPresentationItem | undefined>;

	/**
	 * Offer a worker for presentation. No-op if already presented or pending.
	 * Presents immediately when the slot is free; otherwise enqueues + toast.
	 */
	offer(workerId: string, reason: SuperAgentPresentationReason): void;

	/**
	 * Force-present a worker (e.g. user clicked the toast or a status row).
	 * When the slot is occupied and `force` is false, only reorders the queue.
	 * When `force` replaces a presented worker, only AwaitingUser /
	 * WatchdogTripped are parked back into pending; completed / failed
	 * are dropped so toast「查看」does not ping-pong. Presenting a
	 * Completed worker acknowledges it (→ Idle).
	 */
	present(workerId: string, options?: { force?: boolean; reason?: SuperAgentPresentationReason }): void;

	/**
	 * User finished with the current presented worker (sent a follow-up /
	 * closed the slot) → promote the next attention item.
	 * Order: pending queue head, else live Completed / AwaitingUser /
	 * WatchdogTripped / Failed workers, else clear to Router.
	 */
	dismissPresented(): void;

	/**
	 * Show the Router timeline without promoting pending and without
	 * dropping the toast queue. Used after Router dispatch / "+" so the
	 * dispatch log stays visible while 待查看 workers remain claimable.
	 */
	clearPresented(): void;

	/** Drop a worker from pending/toast without presenting it. */
	dismissPending(workerId: string): void;
}

export const ISuperAgentPresentationQueue = createDecorator<ISuperAgentPresentationQueue>('ISuperAgentPresentationQueue');
