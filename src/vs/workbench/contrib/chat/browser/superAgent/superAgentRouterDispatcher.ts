/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { localize } from '../../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IChatRouterService, SuperAgentWorkerState } from '../../common/superAgent/chatRouterService.js';
import { ZCODE_INTERNAL_SUPERAGENT_SHOW_ROUTER } from './superAgentCommands.js';
import { parseZcodeSessionId, zcodeSessionResource } from './zcodeSessionUri.js';

/** DispatchStatus values mirrored in zcode-chat conversation.ts. */
type DispatchStatus =
	| 'pending'
	| 'queued'
	| 'starting'
	| 'running'
	| 'awaiting'
	| 'done'
	| 'failed'
	| 'cancelled'
	| 'stalled';

function dispatchStatusFromWorkerState(state: SuperAgentWorkerState): DispatchStatus {
	switch (state) {
		case SuperAgentWorkerState.Starting:
			return 'starting';
		case SuperAgentWorkerState.Running:
			return 'running';
		case SuperAgentWorkerState.AwaitingUser:
			return 'awaiting';
		case SuperAgentWorkerState.WatchdogTripped:
			return 'stalled';
		case SuperAgentWorkerState.Failed:
			return 'failed';
		case SuperAgentWorkerState.Cancelled:
			return 'cancelled';
		case SuperAgentWorkerState.Completed:
		case SuperAgentWorkerState.Idle:
			return 'done';
		default:
			return 'running';
	}
}

/** Binding a receipt means a turn is starting — don't stamp a stale Idle/Completed onto it. */
function dispatchStatusForBind(state: SuperAgentWorkerState): DispatchStatus {
	const live = dispatchStatusFromWorkerState(state);
	return (live === 'done' || live === 'failed' || live === 'cancelled') ? 'running' : live;
}

/** Opens (and creates once) the Router chat session; resolves to its zcode session id. */
export const ZCODE_INTERNAL_SUPERAGENT_OPEN_ROUTER = 'zcode.internal.superAgent.openRouter';

/** Fired by zcode-chat when the user submits in the Router session. */
export const ZCODE_INTERNAL_SUPERAGENT_ROUTER_SUBMIT = 'zcode.internal.superAgent.routerSubmit';

/** Bind worker identity onto a Router follow-up dispatch card. */
export const ZCODE_INTERNAL_SUPERAGENT_BIND_ROUTER_DISPATCH = 'zcode.internal.superAgent.bindRouterDispatch';

/** Asks the router service whether a zcode chat session belongs to a worker. */
export const ZCODE_INTERNAL_SUPERAGENT_IS_WORKER_CHAT_SESSION = 'zcode.internal.superAgent.isWorkerChatSession';

/** All chat-session ids the router service knows (live workers + history). */
export const ZCODE_INTERNAL_SUPERAGENT_LIST_WORKER_SESSIONS = 'zcode.internal.superAgent.listWorkerChatSessions';

interface IRouterSubmitPayload {
	readonly text?: string;
	readonly sessionId?: string;
	readonly dispatchItemId?: string;
}

interface IBindRouterDispatchPayload {
	readonly sessionId?: string;
	readonly dispatchItemId?: string;
	readonly workerSessionId?: string;
}

/**
 * Worker title shown on the Router board. Keep the label intact — the card
 * sizes it to the available width and ellipsizes only when the panel is narrower.
 */
function dispatchTitleBadge(label: string): string {
	return label.trim().replace(/\s+/g, ' ');
}

/** Provisional card title until the first turn's AI title lands. */
function provisionalWorkerLabel(task: string): string {
	const collapsed = task.trim().replace(/\s+/g, ' ');
	const max = 120;
	return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/**
 * The Router half of the Super Agent dispatch loop (§5 of superAgentRedesign.md).
 *
 * In this ZCode fork the visible chat surface is the zcode-chat webview, so the
 * Router is a **real zcode session** (title "Router"), not a hidden native
 * `vscode-chat-session` URI:
 *
 *   user types a task in the Router session's composer
 *     → zcode-chat intercepts the send (no model turn on Router)
 *     → fires {@link ZCODE_INTERNAL_SUPERAGENT_ROUTER_SUBMIT}
 *     → a worker is created with a fresh, isolated zcode session
 *     → the task text is sent to that session immediately
 *     → the Workers rail reflects the new worker; its transcript stays
 *       reachable through the rail while the Router stays focused for the
 *       next dispatch.
 */
export class SuperAgentRouterDispatcher extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chat.superAgentRouterDispatcher';

	private routerSessionResource: URI | undefined;

	constructor(
		@IChatRouterService private readonly routerService: IChatRouterService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(CommandsRegistry.registerCommand(ZCODE_INTERNAL_SUPERAGENT_OPEN_ROUTER, () => this.openRouterSession()));
		this._register(CommandsRegistry.registerCommand(ZCODE_INTERNAL_SUPERAGENT_ROUTER_SUBMIT, (_accessor, payload: unknown) => {
			const body = (payload && typeof payload === 'object') ? payload as IRouterSubmitPayload : undefined;
			const text = typeof body?.text === 'string' ? body.text : undefined;
			const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined;
			const dispatchItemId = typeof body?.dispatchItemId === 'string' ? body.dispatchItemId : undefined;
			if (sessionId && !this.routerSessionResource) {
				this.routerSessionResource = zcodeSessionResource(sessionId);
				this.syncAllDispatchTitles();
				this.syncAllDispatchStatuses();
			}
			void this.dispatch(text, { routerSessionId: sessionId, dispatchItemId });
		}));
		this._register(CommandsRegistry.registerCommand(ZCODE_INTERNAL_SUPERAGENT_BIND_ROUTER_DISPATCH, (_accessor, payload: unknown) => {
			const body = (payload && typeof payload === 'object') ? payload as IBindRouterDispatchPayload : undefined;
			const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined;
			const dispatchItemId = typeof body?.dispatchItemId === 'string' ? body.dispatchItemId : undefined;
			const workerSessionId = typeof body?.workerSessionId === 'string' ? body.workerSessionId : undefined;
			if (!sessionId || !dispatchItemId || !workerSessionId) {
				return;
			}
			if (!this.routerSessionResource) {
				this.routerSessionResource = zcodeSessionResource(sessionId);
			}
			const worker = this.routerService.getWorkerForChatSession(zcodeSessionResource(workerSessionId));
			if (!worker) {
				return;
			}
			// A follow-up means this worker is live again. Failed/Cancelled are terminal
			// states that heartbeats ignore — revive explicitly so `stateChanged` fires
			// and the receipt + rail resync instead of staying stuck on "failed".
			this.routerService.reviveWorker(worker.id, 'follow-up submitted');
			void this.commandService.executeCommand('zcode.patchRouterDispatch', {
				sessionId,
				dispatchItemId,
				workerId: worker.id,
				workerSessionId,
				badge: dispatchTitleBadge(worker.label),
				accent: worker.accentColorId,
				status: dispatchStatusForBind(worker.state.get()),
			}).catch(() => { });
		}));
		this._register(CommandsRegistry.registerCommand(ZCODE_INTERNAL_SUPERAGENT_IS_WORKER_CHAT_SESSION, (_accessor, sessionId: unknown) => {
			// Authoritative worker↔session lookup — lets zcode-chat recognize
			// restored worker sessions without depending on dispatch-card data.
			return typeof sessionId === 'string'
				&& !!this.routerService.getWorkerForChatSession(zcodeSessionResource(sessionId));
		}));
		this._register(CommandsRegistry.registerCommand(ZCODE_INTERNAL_SUPERAGENT_LIST_WORKER_SESSIONS, () => {
			// Durable worker roster for Router-board rehydration in zcode-chat:
			// live workers plus closed-worker history. Dispatch cards are the
			// only board renderer, and they used to be lost to cross-window
			// saves — this roster survives in workspace storage and lets the
			// board be rebuilt from it, including workerId for card clicks.
			const rows: { sessionId: string; workerId: string; label: string; live: boolean }[] = [];
			const push = (workerId: string, label: string, resource: URI, live: boolean): void => {
				const sessionId = parseZcodeSessionId(resource);
				if (sessionId && !rows.some(row => row.sessionId === sessionId)) {
					rows.push({ sessionId, workerId, label, live });
				}
			};
			// Live first: a worker that is both live and archived reports live,
			// so board rehydration re-boards it instead of honoring a stale ✕.
			for (const worker of this.routerService.workers.get()) {
				push(worker.id, worker.label, worker.chatSessionResource, true);
			}
			for (const entry of this.routerService.history.get()) {
				push(entry.id, entry.label, entry.chatSessionResource, false);
			}
			return rows;
		}));
		// Title + live turn status → keep Router receipts in sync with the worker rail.
		this._register(this.routerService.onDidWorkerEvent(e => {
			if (e.kind === 'labelChanged' && e.detail) {
				this.syncDispatchTitle(e.workerId, e.detail);
				return;
			}
			if (e.kind === 'workerRemoved') {
				this.removeWorkerDispatches(e.workerId, e.workerSessionId, e.detail);
				return;
			}
			if (e.kind === 'stateChanged' || e.kind === 'watchdogTripped' || e.kind === 'workerCreated') {
				this.syncDispatchStatus(e.workerId);
				// A worker restored from the history menu is live again — re-run
				// board rehydration right away so its dispatch card returns
				// without a window reload. Rehydration honors the durable ✕ for
				// live rows too now, so the restore must lift it first: pass
				// both worker keys and let zcode-chat clear them pre-reconcile.
				if (e.kind === 'workerCreated' && e.detail?.startsWith('restored:')) {
					const worker = this.routerService.workers.get().find(w => w.id === e.workerId);
					void this.commandService.executeCommand('zcode.reconcileWorkerBoard', worker ? {
						lift: [{ workerId: e.workerId, workerSessionId: parseZcodeSessionId(worker.chatSessionResource) }]
					} : undefined).catch(() => { });
				}
			}
		}));
	}

	isRouterSession(resource: URI): boolean {
		return !!this.routerSessionResource && resource.toString() === this.routerSessionResource.toString();
	}

	/**
	 * Creates the Router session once per window (via zcode-chat), titles it,
	 * and focuses it under the Workers rail. Returns the plain session id so
	 * the chrome can match it against title-tab ids.
	 */
	async openRouterSession(): Promise<string | undefined> {
		try {
			const sessionId = await this.commandService.executeCommand<string>('zcode.ensureRouterSession');
			if (!sessionId || typeof sessionId !== 'string') {
				throw new Error(localize('router.noSession', "zcode.ensureRouterSession returned no session id"));
			}
			this.routerSessionResource = zcodeSessionResource(sessionId);
			this.syncAllDispatchTitles();
			this.syncAllDispatchStatuses();
			return sessionId;
		} catch (error) {
			this.notificationService.error(localize('router.openFailed', "Opening the Router chat session failed: {0}", toErrorMessage(error)));
			this.logService.error('[superAgent] openRouterSession failed', error);
			return undefined;
		}
	}

	private routerSessionId(): string | undefined {
		return this.routerSessionResource ? parseZcodeSessionId(this.routerSessionResource) : undefined;
	}

	private syncDispatchTitle(workerId: string, label: string): void {
		const sessionId = this.routerSessionId();
		const badge = dispatchTitleBadge(label);
		if (!sessionId || !workerId || !badge) {
			return;
		}
		void this.commandService.executeCommand('zcode.patchRouterDispatchLabel', {
			sessionId,
			workerId,
			badge,
		}).catch(() => { });
	}

	private syncAllDispatchTitles(): void {
		for (const worker of this.routerService.workers.get()) {
			this.syncDispatchTitle(worker.id, worker.label);
		}
	}

	private syncDispatchStatus(workerId: string): void {
		const sessionId = this.routerSessionId();
		const worker = this.routerService.workers.get().find(w => w.id === workerId);
		if (!sessionId || !worker) {
			return;
		}
		void this.commandService.executeCommand('zcode.patchRouterDispatchStatus', {
			sessionId,
			workerId,
			status: dispatchStatusFromWorkerState(worker.state.get()),
		}).catch(() => { });
	}

	private syncAllDispatchStatuses(): void {
		for (const worker of this.routerService.workers.get()) {
			this.syncDispatchStatus(worker.id);
		}
	}

	/**
	 * Dropping a worker from the rail also clears its dispatch bubbles from the
	 * Router transcript, so the main list doesn't accumulate deleted tasks.
	 * The worker chat session id rides along (when known) so the extension can
	 * record BOTH suppression keys; `detail` distinguishes an archive (✕ keeps
	 * the transcript restorable) from a history-menu delete (transcript goes).
	 */
	private removeWorkerDispatches(workerId: string, workerSessionId?: string, detail?: string): void {
		const sessionId = this.routerSessionId();
		if (!sessionId || !workerId) {
			return;
		}
		void this.commandService.executeCommand('zcode.removeWorkerDispatches', {
			sessionId,
			workerId,
			workerSessionId,
		}).catch(() => { });
		if ((detail === 'history-deleted' || detail === 'history-cleared') && workerSessionId) {
			void this.commandService.executeCommand('zcode.deleteChatSession', workerSessionId).catch(() => { });
		}
	}

	private markDispatchFailed(opts?: { routerSessionId?: string; dispatchItemId?: string }): void {
		if (!opts?.routerSessionId || !opts.dispatchItemId) {
			return;
		}
		void this.commandService.executeCommand('zcode.patchRouterDispatchStatus', {
			sessionId: opts.routerSessionId,
			dispatchItemId: opts.dispatchItemId,
			status: 'failed' satisfies DispatchStatus,
		}).catch(() => { });
	}

	private async dispatch(
		message: string | undefined,
		opts?: { routerSessionId?: string; dispatchItemId?: string },
	): Promise<void> {
		const task = message?.trim();
		if (!task) {
			return;
		}

		// Provisional card title until the first turn's AI title lands.
		const label = provisionalWorkerLabel(task);
		let sessionId: string | undefined;
		try {
			// Do not stamp the full task as the session title — createWorkerSession
			// keeps a placeholder; generateTitle replaces it after the first reply.
			sessionId = await this.commandService.executeCommand<string>('zcode.createWorkerSession', { message: task });
		} catch (error) {
			this.markDispatchFailed(opts);
			this.notificationService.warn(localize('dispatch.createFailed', "Creating a worker session failed: {0}", toErrorMessage(error)));
			this.logService.error('[superAgent] createWorkerSession failed', error);
			return;
		}
		if (!sessionId || typeof sessionId !== 'string') {
			this.markDispatchFailed(opts);
			this.notificationService.warn(localize('dispatch.noSession', "Worker session was not created."));
			return;
		}

		const sessionResource = zcodeSessionResource(sessionId);
		const worker = this.routerService.createWorker({ label, chatSessionResource: sessionResource });
		// Stay on the Router page while the worker runs silently (§5).
		// Presentation queue will surface it when the turn needs the user.
		this.routerService.recordActivity(worker.id, 'request submitted');

		if (opts?.routerSessionId && opts.dispatchItemId) {
			// Await the identity stamp (and its disk write) before showing the
			// homepage. Otherwise board rehydration reads a card that still has
			// no worker session and treats this live worker as missing.
			await this.commandService.executeCommand('zcode.patchRouterDispatch', {
				sessionId: opts.routerSessionId,
				dispatchItemId: opts.dispatchItemId,
				workerId: worker.id,
				workerSessionId: sessionId,
				badge: dispatchTitleBadge(worker.label),
				accent: worker.accentColorId,
				status: dispatchStatusForBind(worker.state.get()),
			}).catch(() => { });
		}
		// Ensure the webview stays on the Router dispatch log (not a worker stream).
		await this.commandService.executeCommand(ZCODE_INTERNAL_SUPERAGENT_SHOW_ROUTER).catch(() => { });
	}
}

export function isSuperAgentZcodeSession(resource: URI): boolean {
	return !!parseZcodeSessionId(resource);
}
