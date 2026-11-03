/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable, DisposableResourceMap, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { autorunDelta, autorunIterableDelta } from '../../../../../base/common/observable.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { FocusMode } from '../../../../../platform/native/common/native.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { ChatConfiguration, ChatNotificationMode } from '../../common/constants.js';
import { IChatRouterService, ISuperAgentWorkerHandle, SuperAgentWorkerState } from '../../common/superAgent/chatRouterService.js';
import { ViewPendingSuperAgentWorkerAction } from './superAgentCommands.js';

/**
 * States in which a worker needs the user's attention. Reaching one of these
 * while the window is in the background (covered by other apps, minimized…)
 * is exactly when an OS-level signal is warranted: the in-app presentation
 * toast is invisible until the user returns.
 */
const ATTENTION_STATES: ReadonlySet<SuperAgentWorkerState> = new Set([
	SuperAgentWorkerState.Completed,
	SuperAgentWorkerState.Failed,
	SuperAgentWorkerState.WatchdogTripped,
	SuperAgentWorkerState.AwaitingUser,
]);

function attentionBodyFor(state: SuperAgentWorkerState): string {
	switch (state) {
		case SuperAgentWorkerState.Failed:
			return localize('superAgent.dockNotifier.failed', "任务失败，需要处理。");
		case SuperAgentWorkerState.WatchdogTripped:
			return localize('superAgent.dockNotifier.stalled', "Worker 疑似卡死（长时间无活动）。");
		case SuperAgentWorkerState.AwaitingUser:
			return localize('superAgent.dockNotifier.awaiting', "Worker 正在等待你的输入。");
		default:
			return localize('superAgent.dockNotifier.completed', "任务已完成，待查看。");
	}
}

/**
 * Announces attention-worthy worker state transitions to the OS when the
 * window is not focused:
 *
 * - dock bounce + badge dot on macOS (taskbar flash on Windows/Linux) via
 *   `FocusMode.Notify` — the badge clears automatically once the window is
 *   focused again;
 * - an OS notification toast with a「查看」action that forces the window to
 *   the front and opens the pending worker's page.
 *
 * Gated by the existing `chat.notifyWindowOnResponseReceived` setting
 * (default: only when the window is not focused).
 */
export class SuperAgentDockNotifier extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.superAgentDockNotifier';

	private readonly _activeNotifications = this._register(new DisposableResourceMap());

	/** Bumped per worker so repeated completions re-notify instead of being deduped away. */
	private readonly _occurrences = new Map<string, number>();

	constructor(
		@IChatRouterService private readonly _routerService: IChatRouterService,
		@IHostService private readonly _hostService: IHostService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();

		const trackers = this._register(new DisposableResourceMap());
		this._register(autorunIterableDelta(
			reader => this._routerService.workers.read(reader),
			({ addedValues, removedValues }) => {
				for (const worker of addedValues) {
					trackers.set(worker.chatSessionResource, this._trackWorker(worker));
				}
				for (const worker of removedValues) {
					trackers.deleteAndDispose(worker.chatSessionResource);
					this._occurrences.delete(worker.id);
				}
			}
		));
	}

	private _trackWorker(worker: ISuperAgentWorkerHandle): DisposableStore {
		const store = new DisposableStore();
		store.add(autorunDelta(worker.state, ({ lastValue, newValue }) => {
			// Skip the initial observation (window reload / restore): a worker
			// that was already attention-worthy before the reload must not
			// replay as a fresh notification.
			if (lastValue === undefined || newValue === undefined) {
				return;
			}
			if (lastValue === newValue || !ATTENTION_STATES.has(newValue)) {
				return;
			}
			void this._notify(worker, newValue);
		}));
		return store;
	}

	private async _notify(worker: ISuperAgentWorkerHandle, state: SuperAgentWorkerState): Promise<void> {
		const mode = this._configurationService.getValue<ChatNotificationMode>(ChatConfiguration.NotifyWindowOnResponseReceived);
		if (mode === ChatNotificationMode.Off) {
			return;
		}

		const isFocused = mainWindow.document.hasFocus();
		if (mode !== ChatNotificationMode.Always && isFocused) {
			return; // foreground: the in-app presentation toast already covers it
		}

		if (!isFocused) {
			// Dock bounce + badge dot (macOS) / taskbar flash (Win/Linux).
			// The main process clears the badge when the window regains focus.
			await this._hostService.focus(mainWindow, { mode: FocusMode.Notify });
		}

		const cts = new CancellationTokenSource();
		this._activeNotifications.set(worker.chatSessionResource, toDisposable(() => cts.dispose(true)));

		const occurrence = (this._occurrences.get(worker.id) ?? 0) + 1;
		this._occurrences.set(worker.id, occurrence);

		try {
			const result = await this._hostService.showToast({
				title: worker.label,
				body: attentionBodyFor(state),
				actions: [localize('superAgent.dockNotifier.view', "查看")],
				dedupeKey: `superagent:${worker.id}:${occurrence}`,
			}, cts.token);

			if (result.clicked || typeof result.actionIndex === 'number') {
				await this._hostService.focus(mainWindow, { mode: FocusMode.Force });
				await this._commandService.executeCommand(ViewPendingSuperAgentWorkerAction.ID);
			}
		} finally {
			this._activeNotifications.deleteAndDispose(worker.chatSessionResource);
		}
	}
}
