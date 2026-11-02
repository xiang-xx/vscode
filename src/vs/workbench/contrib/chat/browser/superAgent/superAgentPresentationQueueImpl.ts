/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IObservable, observableValue, transaction } from '../../../../../base/common/observable.js';
import { IChatRouterService, SuperAgentWorkerState } from '../../common/superAgent/chatRouterService.js';
import { ISuperAgentPresentationItem, ISuperAgentPresentationQueue, SuperAgentPresentationReason } from '../../common/superAgent/superAgentPresentationQueue.js';

/**
 * FIFO presentation queue (§5.5). The presented slot is exclusive: while the
 * user is interacting with worker A, worker B only gets a toast.
 */
export class SuperAgentPresentationQueue extends Disposable implements ISuperAgentPresentationQueue {

	declare readonly _serviceBrand: undefined;

	private readonly _presented = observableValue<string | undefined>(this, undefined);
	private readonly _pending = observableValue<readonly ISuperAgentPresentationItem[]>(this, []);
	private readonly _toast = observableValue<ISuperAgentPresentationItem | undefined>(this, undefined);

	readonly presentedWorkerId: IObservable<string | undefined> = this._presented;
	readonly pending: IObservable<readonly ISuperAgentPresentationItem[]> = this._pending;
	readonly toast: IObservable<ISuperAgentPresentationItem | undefined> = this._toast;

	constructor(
		@IChatRouterService private readonly routerService: IChatRouterService,
	) {
		super();

		// Auto-offer when a worker enters a "needs human" terminal-ish state.
		this._register(this.routerService.onDidWorkerEvent(e => {
			if (e.kind !== 'stateChanged' && e.kind !== 'watchdogTripped') {
				return;
			}
			const worker = this.routerService.getWorker(e.workerId);
			if (!worker) {
				return;
			}
			const state = worker.state.get();
			// Already looking at this worker when the turn finishes → treat as viewed.
			if (state === SuperAgentWorkerState.Completed && this._presented.get() === worker.id) {
				this.routerService.markIdle(worker.id, 'already presented');
				return;
			}
			// Viewed (Idle): clear any leftover toast for this worker.
			if (state === SuperAgentWorkerState.Idle) {
				this.dismissPending(worker.id);
				return;
			}
			const reason = reasonFromState(state);
			if (reason) {
				this.offer(worker.id, reason);
			} else if (state === SuperAgentWorkerState.Running || state === SuperAgentWorkerState.Starting) {
				// A new turn is underway: drop any stale "已完成 / 待查看" chrome.
				// Pending toast alone was not enough — if the user already clicked
				// 查看, the worker still occupies the presented dock and keeps
				// showing in the bottom-right attention UI while it runs.
				this.dismissPending(worker.id);
				if (this._presented.get() === worker.id) {
					this.dismissPresented();
				}
			}
			// Drop removed/cancelled workers from the queue so tips stay honest.
			if (state === SuperAgentWorkerState.Cancelled) {
				this.dismissPending(worker.id);
				if (this._presented.get() === worker.id) {
					this.dismissPresented();
				}
			}
		}));

		this._register(this.routerService.onDidWorkerEvent(e => {
			if (e.kind === 'workerRemoved') {
				this.dismissPending(e.workerId);
				if (this._presented.get() === e.workerId) {
					this.dismissPresented();
				}
			}
		}));
	}

	offer(workerId: string, reason: SuperAgentPresentationReason): void {
		if (!this.routerService.getWorker(workerId)) {
			return;
		}
		if (this._presented.get() === workerId) {
			return;
		}
		if (this._pending.get().some(p => p.workerId === workerId)) {
			return;
		}

		const item: ISuperAgentPresentationItem = { workerId, reason, enqueuedAt: Date.now() };
		// Only steal the timeline for human-blocked states. Completed /
		// Failed stay as toast so Router dispatch log remains visible (§5 silent run).
		const stealTimeline = reason === 'awaitingUser' || reason === 'watchdogTripped';
		if (!this._presented.get() && stealTimeline) {
			this._setPresented(workerId);
			return;
		}
		transaction(tx => {
			this._pending.set([...this._pending.get(), item], tx);
			this._toast.set(this._pending.get()[0], tx);
		});
	}

	present(workerId: string, options?: { force?: boolean; reason?: SuperAgentPresentationReason }): void {
		if (!this.routerService.getWorker(workerId)) {
			return;
		}
		const current = this._presented.get();
		if (current === workerId) {
			this._acknowledgeViewed(workerId);
			return;
		}

		const reason = options?.reason ?? reasonFromState(this.routerService.getWorker(workerId)!.state.get()) ?? 'completed';
		const without = this._pending.get().filter(p => p.workerId !== workerId);
		const force = options?.force === true;

		if (current && !force) {
			// Slot busy: move to front of queue + refresh toast; do not steal focus.
			const item: ISuperAgentPresentationItem = { workerId, reason, enqueuedAt: Date.now() };
			transaction(tx => {
				this._pending.set([item, ...without], tx);
				this._toast.set(this._pending.get()[0], tx);
			});
			return;
		}

		// Force (or free slot): present this worker. Only re-park the previous
		// one when it still needs human attention (awaiting input / watchdog).
		// Completed / failed were already shown — parking them back makes
		// toast「查看」ping-pong between finished workers forever.
		let nextPending = without;
		if (current && force) {
			this._acknowledgeViewed(current);
			const prevReason = reasonFromState(this.routerService.getWorker(current)?.state.get() ?? SuperAgentWorkerState.Idle);
			if (prevReason === 'awaitingUser' || prevReason === 'watchdogTripped') {
				nextPending = [{ workerId: current, reason: prevReason, enqueuedAt: Date.now() }, ...without.filter(p => p.workerId !== current)];
			}
		}
		transaction(tx => {
			this._pending.set(nextPending, tx);
			this._toast.set(nextPending[0], tx);
			this._presented.set(workerId, tx);
		});
		this.routerService.focusWorker(workerId);
		this._acknowledgeViewed(workerId);
	}

	dismissPresented(): void {
		const leaving = this._presented.get();
		if (leaving) {
			this._acknowledgeViewed(leaving);
		}

		// Prefer the explicit FIFO toast queue, then any live worker that still
		// needs the user (pending can be empty after showRouter cleared the
		// slot without wiping worker state — Completed stays "待查看").
		const queued = this._pending.get().find(p => p.workerId !== leaving && this.routerService.getWorker(p.workerId));
		const fallbackId = queued?.workerId ?? this._nextAttentionWorkerId(leaving);
		const withoutQueued = queued
			? this._pending.get().filter(p => p.workerId !== queued.workerId)
			: this._pending.get().filter(p => p.workerId !== leaving);

		transaction(tx => {
			if (fallbackId) {
				const rest = withoutQueued.filter(p => p.workerId !== fallbackId);
				this._pending.set(rest, tx);
				this._toast.set(rest[0], tx);
				this._presented.set(fallbackId, tx);
			} else {
				this._pending.set(withoutQueued, tx);
				this._toast.set(withoutQueued[0], tx);
				this._presented.set(undefined, tx);
			}
		});
		const presented = this._presented.get();
		if (presented) {
			this.routerService.focusWorker(presented);
			this._acknowledgeViewed(presented);
		} else {
			// Back on the Router/root chat stream — give it the editor stage.
			this.routerService.clearFocusedWorker();
		}
	}

	clearPresented(): void {
		const leaving = this._presented.get();
		if (leaving) {
			this._acknowledgeViewed(leaving);
		}
		// Keep pending/toast intact so 待查看 workers remain reachable after
		// Router dispatch. Reseed from live state in case an earlier wipe
		// dropped Completed workers from the queue while they still need review.
		this._reseedPending(leaving);
		if (this._presented.get() !== undefined) {
			transaction(tx => this._presented.set(undefined, tx));
		}
		// Router timeline is showing: park the worker's tabs and restore root's.
		this.routerService.clearFocusedWorker();
	}

	dismissPending(workerId: string): void {
		const next = this._pending.get().filter(p => p.workerId !== workerId);
		if (next.length === this._pending.get().length) {
			return;
		}
		transaction(tx => {
			this._pending.set(next, tx);
			this._toast.set(next[0], tx);
		});
	}

	/** Oldest attention-needed worker, excluding `exceptId`. */
	private _nextAttentionWorkerId(exceptId: string | undefined): string | undefined {
		const ranked = this.routerService.workers.get()
			.filter(w => w.id !== exceptId && reasonFromState(w.state.get()))
			.sort((a, b) => {
				const pa = attentionPriority(a.state.get());
				const pb = attentionPriority(b.state.get());
				if (pa !== pb) {
					return pa - pb;
				}
				return a.lastActivityAt.get() - b.lastActivityAt.get();
			});
		return ranked[0]?.id;
	}

	/** Ensure every live attention-needed worker (except `exceptId`) is queued. */
	private _reseedPending(exceptId: string | undefined): void {
		const existing = new Set(this._pending.get().map(p => p.workerId));
		const additions: ISuperAgentPresentationItem[] = [];
		for (const worker of this.routerService.workers.get()) {
			if (worker.id === exceptId || existing.has(worker.id)) {
				continue;
			}
			const reason = reasonFromState(worker.state.get());
			if (!reason) {
				continue;
			}
			additions.push({ workerId: worker.id, reason, enqueuedAt: worker.lastActivityAt.get() });
		}
		if (additions.length === 0) {
			return;
		}
		additions.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
		transaction(tx => {
			const next = [...this._pending.get(), ...additions];
			this._pending.set(next, tx);
			this._toast.set(next[0], tx);
		});
	}

	private _setPresented(workerId: string): void {
		transaction(tx => {
			this._presented.set(workerId, tx);
		});
		this.routerService.focusWorker(workerId);
		this._acknowledgeViewed(workerId);
	}

	/** Completed (unread) → Idle once the user has this worker on the chat stream. */
	private _acknowledgeViewed(workerId: string): void {
		if (this.routerService.getWorker(workerId)?.state.get() === SuperAgentWorkerState.Completed) {
			this.routerService.markIdle(workerId, 'viewed');
		}
	}
}

function reasonFromState(state: SuperAgentWorkerState): SuperAgentPresentationReason | undefined {
	switch (state) {
		case SuperAgentWorkerState.Completed: return 'completed';
		case SuperAgentWorkerState.Failed: return 'failed';
		case SuperAgentWorkerState.AwaitingUser: return 'awaitingUser';
		case SuperAgentWorkerState.WatchdogTripped: return 'watchdogTripped';
		// Idle = already viewed — never toast.
		default: return undefined;
	}
}

/** Lower = earlier when handoff-scanning live workers. */
function attentionPriority(state: SuperAgentWorkerState): number {
	switch (state) {
		case SuperAgentWorkerState.AwaitingUser: return 0;
		case SuperAgentWorkerState.WatchdogTripped: return 1;
		case SuperAgentWorkerState.Completed: return 2;
		case SuperAgentWorkerState.Failed: return 3;
		default: return 9;
	}
}
