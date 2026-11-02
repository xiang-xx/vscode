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
		case SuperAgentWorkerState.Queued:
			return 'queued';
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

/** Compact chip text under a Router dispatch receipt (not the slot number). */
function dispatchTitleBadge(label: string): string {
	const trimmed = label.trim().replace(/\s+/g, ' ');
	if (!trimmed) {
		return '';
	}
	return trimmed.length > 16 ? `${trimmed.slice(0, 14)}…` : trimmed;
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
		// Title + live turn status → keep Router receipts in sync with the worker rail.
		this._register(this.routerService.onDidWorkerEvent(e => {
			if (e.kind === 'labelChanged' && e.detail) {
				this.syncDispatchTitle(e.workerId, e.detail);
				return;
			}
			if (e.kind === 'stateChanged' || e.kind === 'watchdogTripped' || e.kind === 'workerCreated') {
				this.syncDispatchStatus(e.workerId);
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

		// Provisional rail label until the first turn's AI title lands.
		const label = task.length > 24 ? `${task.slice(0, 21)}…` : task;
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
			void this.commandService.executeCommand('zcode.patchRouterDispatch', {
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
		void this.commandService.executeCommand(ZCODE_INTERNAL_SUPERAGENT_SHOW_ROUTER).catch(() => { });
	}
}

export function isSuperAgentZcodeSession(resource: URI): boolean {
	return !!parseZcodeSessionId(resource);
}
