/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { autorun } from '../../../../../base/common/observable.js';
import { combinedDisposable, Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IChatService } from '../../common/chatService/chatService.js';
import type { IChatModel } from '../../common/model/chatModel.js';
import { IChatRouterService, SuperAgentWorkerState } from '../../common/superAgent/chatRouterService.js';
import { zcodeSessionResource } from './zcodeSessionUri.js';

/** Fired by zcode-chat when a worker-bound session makes progress. */
export const ZCODE_INTERNAL_SUPERAGENT_WORKER_ACTIVITY = 'zcode.internal.superAgent.workerActivity';
/** Fired by zcode-chat when a worker turn ends (success, failure, or cancel). */
export const ZCODE_INTERNAL_SUPERAGENT_WORKER_IDLE = 'zcode.internal.superAgent.workerIdle';
/** Fired by zcode-chat when a worker is blocked on ask-user / permission. */
export const ZCODE_INTERNAL_SUPERAGENT_WORKER_AWAITING = 'zcode.internal.superAgent.workerAwaitingUser';
/** Fired by zcode-chat after AI title summarization for a worker session. */
export const ZCODE_INTERNAL_SUPERAGENT_RENAME_WORKER = 'zcode.internal.superAgent.renameWorker';
/** Fired by zcode-chat when the user force-deletes a worker card from the Router board. */
export const ZCODE_INTERNAL_SUPERAGENT_FORCE_REMOVE_WORKER = 'zcode.internal.superAgent.forceRemoveWorker';

interface IZcodeWorkerSignal {
	readonly sessionId?: unknown;
	readonly detail?: unknown;
	readonly label?: unknown;
	readonly workerId?: unknown;
}

function readSessionId(payload: unknown): string | undefined {
	if (!payload || typeof payload !== 'object') {
		return undefined;
	}
	const sessionId = (payload as IZcodeWorkerSignal).sessionId;
	return typeof sessionId === 'string' && sessionId ? sessionId : undefined;
}

function readDetail(payload: unknown): string | undefined {
	if (!payload || typeof payload !== 'object') {
		return undefined;
	}
	const detail = (payload as IZcodeWorkerSignal).detail;
	return typeof detail === 'string' && detail ? detail : undefined;
}

function readLabel(payload: unknown): string | undefined {
	if (!payload || typeof payload !== 'object') {
		return undefined;
	}
	const label = (payload as IZcodeWorkerSignal).label;
	return typeof label === 'string' && label.trim() ? label.trim() : undefined;
}

function readWorkerId(payload: unknown): string | undefined {
	if (!payload || typeof payload !== 'object') {
		return undefined;
	}
	const workerId = (payload as IZcodeWorkerSignal).workerId;
	return typeof workerId === 'string' && workerId ? workerId : undefined;
}

/**
 * Feeds real chat execution signals into the router so worker state and the
 * watchdog reflect actual progress instead of requiring manual heartbeats.
 *
 * ZCode path (primary): zcode-chat sessions are not `IChatService` models, so
 * the extension fires {@link ZCODE_INTERNAL_SUPERAGENT_WORKER_ACTIVITY} /
 * idle / awaiting commands from turn progress.
 *
 * Native path (fallback): still wired for any worker bound to a vscode-chat
 * session resource.
 */
export class SuperAgentChatBridge extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chat.superAgentChatBridge';

	constructor(
		@IChatRouterService private readonly routerService: IChatRouterService,
		@IChatService private readonly chatService: IChatService,
		@ILogService logService: ILogService,
	) {
		super();

		this._registerZcodeSignals();

		// Native (1) Turn started: user submitted into a worker-bound session.
		this._register(this.chatService.onDidSubmitRequest(e => {
			const worker = this.routerService.getWorkerForChatSession(e.chatSessionResource);
			if (worker) {
				this.routerService.recordActivity(worker.id, 'request submitted');
			}
		}));

		// Native (2) Streaming heartbeat + (3) turn-done → Completed (unread).
		const modelListeners = new Map<string, { model: IChatModel; disposable: IDisposable }>();
		this._register(toDisposable(() => {
			for (const entry of modelListeners.values()) {
				entry.disposable.dispose();
			}
			modelListeners.clear();
		}));
		this._register(autorun(reader => {
			const workerByResource = new Map<string, string>();
			for (const worker of this.routerService.workers.read(reader)) {
				workerByResource.set(worker.chatSessionResource.toString(), worker.id);
			}
			const liveResources = new Set<string>();
			for (const model of this.chatService.chatModels.read(reader)) {
				const key = model.sessionResource.toString();
				liveResources.add(key);
				const workerId = workerByResource.get(key);
				if (workerId && !modelListeners.has(key)) {
					let wasInProgress = model.requestInProgress.read(undefined);
					const disposable = combinedDisposable(
						model.onDidChange(() => this.routerService.recordActivity(workerId, 'chat model change')),
						autorun(r => {
							const inProgress = model.requestInProgress.read(r);
							if (wasInProgress && !inProgress) {
								const worker = this.routerService.getWorker(workerId);
								const state = worker?.state.read(undefined);
								if (state === SuperAgentWorkerState.Running || state === SuperAgentWorkerState.Starting || state === SuperAgentWorkerState.WatchdogTripped) {
									this.routerService.completeWorker(workerId, 'request finished');
								}
							}
							wasInProgress = inProgress;
						}),
					);
					modelListeners.set(key, { model, disposable });
				} else if (!workerId && modelListeners.has(key)) {
					modelListeners.get(key)!.disposable.dispose();
					modelListeners.delete(key);
				}
			}
			for (const [key, entry] of modelListeners) {
				if (!liveResources.has(key)) {
					entry.disposable.dispose();
					modelListeners.delete(key);
				}
			}
		}));

		// Native (4) Session gone: its worker cannot continue.
		this._register(this.chatService.onDidDisposeSession(e => {
			for (const sessionResource of e.sessionResources) {
				const worker = this.routerService.getWorkerForChatSession(sessionResource);
				if (worker) {
					logService.trace(`[superAgent] cancelling worker ${worker.badge} (${worker.label}): chat session disposed (${e.reason})`);
					this.routerService.cancelWorker(worker.id, `chat session ${e.reason}`);
				}
			}
		}));
	}

	private _registerZcodeSignals(): void {
		const resolve = (payload: unknown) => {
			const sessionId = readSessionId(payload);
			if (!sessionId) {
				return undefined;
			}
			return this.routerService.getWorkerForChatSession(zcodeSessionResource(sessionId));
		};

		this._register(CommandsRegistry.registerCommand(ZCODE_INTERNAL_SUPERAGENT_WORKER_ACTIVITY, (_accessor, payload: unknown) => {
			const worker = resolve(payload);
			if (worker) {
				this.routerService.recordActivity(worker.id, readDetail(payload) ?? 'zcode progress');
			}
		}));
		this._register(CommandsRegistry.registerCommand(ZCODE_INTERNAL_SUPERAGENT_WORKER_IDLE, (_accessor, payload: unknown) => {
			const worker = resolve(payload);
			if (!worker) {
				return;
			}
			const detail = readDetail(payload) ?? 'zcode turn finished';
			const state = worker.state.get();
			const active = state === SuperAgentWorkerState.Running
				|| state === SuperAgentWorkerState.Starting
				|| state === SuperAgentWorkerState.WatchdogTripped
				|| state === SuperAgentWorkerState.AwaitingUser;
			if (!active) {
				return;
			}
			if (/turn failed/i.test(detail)) {
				this.routerService.failWorker(worker.id, detail);
				return;
			}
			if (/turn cancelled/i.test(detail)) {
				this.routerService.cancelWorker(worker.id, detail);
				return;
			}
			// Unread "已完成" until the user opens this worker in the chat stream.
			this.routerService.completeWorker(worker.id, detail);
		}));
		this._register(CommandsRegistry.registerCommand(ZCODE_INTERNAL_SUPERAGENT_WORKER_AWAITING, (_accessor, payload: unknown) => {
			const worker = resolve(payload);
			if (worker) {
				this.routerService.markAwaitingUser(worker.id, readDetail(payload) ?? 'zcode ask user');
			}
		}));
		this._register(CommandsRegistry.registerCommand(ZCODE_INTERNAL_SUPERAGENT_RENAME_WORKER, (_accessor, payload: unknown) => {
			const worker = resolve(payload);
			const label = readLabel(payload);
			if (worker && label) {
				this.routerService.renameWorker(worker.id, label);
			}
		}));
		this._register(CommandsRegistry.registerCommand(ZCODE_INTERNAL_SUPERAGENT_FORCE_REMOVE_WORKER, (_accessor, payload: unknown) => {
			const workerId = readWorkerId(payload);
			if (workerId) {
				this.routerService.forceRemoveWorker(workerId);
			}
		}));
	}
}
