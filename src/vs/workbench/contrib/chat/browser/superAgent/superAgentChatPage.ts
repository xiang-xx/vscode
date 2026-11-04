/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ViewContainerLocation } from '../../../../common/views.js';
import { IPaneCompositePartService } from '../../../../services/panecomposite/browser/panecomposite.js';
import { IChatRouterService, ISuperAgentWorkerHandle, SuperAgentWorkerState } from '../../common/superAgent/chatRouterService.js';
import { ISuperAgentPresentationQueue } from '../../common/superAgent/superAgentPresentationQueue.js';
import { ZCODE_VIEW_CONTAINER_ID } from '../zcode/zcodeAuxiliaryBarChrome.js';
import { registerSuperAgentActions, ZCODE_INTERNAL_SUPERAGENT_PRESENT_WORKER, ZCODE_INTERNAL_SUPERAGENT_SHOW_ROUTER, ZCODE_INTERNAL_TOGGLE_SUPERAGENT_WORKERS } from './superAgentCommands.js';
import { ZCODE_INTERNAL_SUPERAGENT_OPEN_ROUTER } from './superAgentRouterDispatcher.js';
import { openSuperAgentSession } from './zcodeSessionUri.js';

/** Mirrors the `zcode.internal.*` pattern of the chat chrome. */
const ZCODE_INTERNAL_SET_WORKERS_TAB = 'zcode.internal.setSuperAgentWorkersTab';

/**
 * Super Agent chat surface owner (§5 of superAgentRedesign.md).
 *
 * The bottom Workers strip is retired: the Router main page's worker board
 * (rendered inside the chat webview) is the single worker hub. This
 * contribution now only owns:
 *
 * - which timeline fills the chat surface (Router by default, a worker while
 *   the presentation queue presents one) — never a title-bar session tab;
 * - the internal commands dispatch/+/back use to force that timeline;
 * - the Workers status chip state pushed to the title-row chrome.
 *
 * History / Home live in the title row (`ZCodeAuxiliaryBarChrome`); the
 * presentation toast lives in `SuperAgentPresentationUiContribution`.
 */
export class SuperAgentChatPageContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chat.superAgentChatPage';

	private visible = false;
	private tabStateRegistration: IDisposable | undefined;
	private tabStateCommandReady = false;
	/** Resource string of the Router session, for the chrome's pinned-tab logic. */
	private routerSessionId: string | undefined;
	/** Attention count at the last tab-state push — drives the one-shot badge pulse. */
	private prevAttentionCount = 0;
	/** Session resource currently filling the chat surface (Router or a worker). */
	private shownSessionKey: string | undefined;
	private contentSyncToken = 0;

	constructor(
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
		@ICommandService private readonly commandService: ICommandService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatRouterService private readonly routerService: IChatRouterService,
		@ISuperAgentPresentationQueue private readonly presentationQueue: ISuperAgentPresentationQueue,
	) {
		super();

		registerSuperAgentActions();

		// The pinned tab, the F1 action and the worker-commands all go through
		// this one toggle: `show` undefined = toggle, true/false = force.
		this._register(CommandsRegistry.registerCommand(ZCODE_INTERNAL_TOGGLE_SUPERAGENT_WORKERS, (_accessor, show?: boolean) => {
			return this.setVisible(show === undefined ? !this.visible : !!show);
		}));
		// Dispatch / "首页" / back: force the Router timeline onto the surface.
		this._register(CommandsRegistry.registerCommand(ZCODE_INTERNAL_SUPERAGENT_SHOW_ROUTER, async () => {
			// Await visibility BEFORE swapping content: syncTimelineContent bails
			// out when !visible, and the fire-and-forget reveal used to lose that
			// race — leaving a stale/empty surface after "back to home".
			await this.setVisible(true);
			this.showRouterOnPage();
		}));
		this._register(CommandsRegistry.registerCommand(ZCODE_INTERNAL_SUPERAGENT_PRESENT_WORKER, async (_accessor, workerId?: string) => {
			if (typeof workerId !== 'string' || !workerId || !this.routerService.getWorker(workerId)) {
				return;
			}
			// Same visibility race as SHOW_ROUTER: present() bails when the page
			// is not yet visible, so the worker detail would never swap in.
			await this.setVisible(true);
			this.presentationQueue.present(workerId, { force: true });
		}));

		// Single-page default: when the chat surface is on screen, Router is
		// the page. Presentation of finished workers is owned by the queue.
		this._register(this.routerService.onDidWorkerEvent(e => {
			if (e.kind !== 'stateChanged' && e.kind !== 'watchdogTripped' && e.kind !== 'workerCreated') { return; }
			if (this.visible) { return; }
			const active = this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar);
			if (active?.getId() !== ZCODE_VIEW_CONTAINER_ID) { return; }
			void this.setVisible(true);
		}));

		// Auto-enter the single page when the chat container opens.
		const syncWithChatSurface = (location: ViewContainerLocation): void => {
			if (location !== ViewContainerLocation.AuxiliaryBar) {
				return;
			}
			const active = this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar);
			if (active?.getId() === ZCODE_VIEW_CONTAINER_ID && !this.visible) {
				void this.setVisible(true);
			}
		};
		this._register(this.paneCompositeService.onDidPaneCompositeOpen(e => syncWithChatSurface(e.viewContainerLocation)));
		this._register(this.paneCompositeService.onDidPaneCompositeClose(e => syncWithChatSurface(e.viewContainerLocation)));
		{
			const active = this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar);
			if (active?.getId() === ZCODE_VIEW_CONTAINER_ID) {
				void this.setVisible(true);
			}
		}

		// Live state on the Workers chip: attention dot while any worker needs
		// the user (AwaitingUser / watchdog); the running count only feeds the
		// chip tooltip.
		this._register(autorun(reader => {
			const workers = this.routerService.workers.read(reader);
			for (const worker of workers) {
				worker.state.read(reader);
			}
			this.pushTabState();
		}));

		// Presented worker ↔ chat surface (no session-tab switch). Depend on
		// `workers` so AI title renames refresh the chip.
		this._register(autorun(reader => {
			const presentedId = this.presentationQueue.presentedWorkerId.read(reader);
			const workers = this.routerService.workers.read(reader);
			const worker = presentedId ? workers.find(w => w.id === presentedId) : undefined;
			if (!this.visible) {
				return;
			}
			void this.syncTimelineContent(worker);
		}));
	}

	//#region Pinned-tab state

	/**
	 * Pushes the pinned-tab state to the chrome. The chrome contribution may
	 * instantiate after this one (same workbench phase, different files), so
	 * wait for its `zcode.internal.*` command to appear before the first push.
	 */
	private pushTabState(): void {
		const workers = this.routerService.workers.get();
		let attentionCount = 0;
		let badge = 0;
		for (const worker of workers) {
			const state = worker.state.get();
			// Count only workers that are actually executing — Idle/Completed
			// workers stay in the live list and must not inflate the number.
			if (state === SuperAgentWorkerState.Starting || state === SuperAgentWorkerState.Running) {
				badge++;
			}
			if (state === SuperAgentWorkerState.AwaitingUser || state === SuperAgentWorkerState.WatchdogTripped) {
				attentionCount++;
			}
		}
		const pulse = attentionCount > this.prevAttentionCount;
		this.prevAttentionCount = attentionCount;
		const payload = { active: this.visible, badge, attention: attentionCount > 0, routerSession: this.routerSessionId, pulse };
		const send = (): void => {
			Promise.resolve(this.commandService.executeCommand(ZCODE_INTERNAL_SET_WORKERS_TAB, payload)).catch(() => { });
		};
		if (this.tabStateCommandReady || CommandsRegistry.getCommand(ZCODE_INTERNAL_SET_WORKERS_TAB)) {
			this.tabStateCommandReady = true;
			send();
		} else if (!this.tabStateRegistration) {
			this.tabStateRegistration = this._register(CommandsRegistry.onDidRegisterCommand(id => {
				if (id !== ZCODE_INTERNAL_SET_WORKERS_TAB) {
					return;
				}
				this.tabStateCommandReady = true;
				this.tabStateRegistration?.dispose();
				this.tabStateRegistration = undefined;
				send();
			}));
		}
	}

	//#endregion

	private async setVisible(visible: boolean): Promise<void> {
		if (visible && this.visible) {
			// Already on this page — timeline sync is owned by the presentation autorun.
			this.pushTabState();
			return;
		}
		this.visible = visible;
		if (visible) {
			// Make sure the chat surface is actually on screen (F1 from anywhere).
			await this.paneCompositeService.openPaneComposite(ZCODE_VIEW_CONTAINER_ID, ViewContainerLocation.AuxiliaryBar, true);
			// Stay on this page: show the presented worker's timeline, or Router.
			const presentedId = this.presentationQueue.presentedWorkerId.get();
			const worker = presentedId ? this.routerService.getWorker(presentedId) : undefined;
			await this.syncTimelineContent(worker);
		} else {
			this.shownSessionKey = undefined;
		}
		this.pushTabState();
	}

	/**
	 * Renders Router or a worker timeline on the chat surface. Never opens a
	 * title-bar session tab — the webview content swaps in place.
	 */
	private async syncTimelineContent(worker: ISuperAgentWorkerHandle | undefined): Promise<void> {
		const token = ++this.contentSyncToken;
		if (worker) {
			const key = worker.chatSessionResource.toString();
			if (this.shownSessionKey === key) {
				return;
			}
			try {
				await this.instantiationService.invokeFunction(openSuperAgentSession, worker.chatSessionResource);
			} catch {
				return;
			}
			if (token !== this.contentSyncToken || !this.visible) {
				return;
			}
			this.shownSessionKey = key;
			return;
		}

		if (this.shownSessionKey?.startsWith('router:')) {
			return;
		}
		try {
			const router = await this.commandService.executeCommand(ZCODE_INTERNAL_SUPERAGENT_OPEN_ROUTER) as string | undefined;
			if (token !== this.contentSyncToken || !this.visible) {
				return;
			}
			if (router) {
				this.routerSessionId = router;
				this.shownSessionKey = `router:${router}`;
			} else {
				this.shownSessionKey = undefined;
			}
		} catch {
			// Dispatcher not ready — the chip still works standalone.
		}
	}

	/** Back to the Router dispatch surface. */
	private showRouterOnPage(): void {
		// Keep the 待查看 toast queue — only clear the presented slot so the
		// Router board shows. After the user sends on a worker,
		// dismissPresented will hand off to those waiting workers.
		this.presentationQueue.clearPresented();
		// Force the swap: shownSessionKey can claim "router:" while the surface
		// actually shows a worker timeline (chip updater writes it, and it
		// survives webview reloads). Without this reset syncTimelineContent
		// early-returns and the home board never receives its data.
		this.shownSessionKey = undefined;
		void this.syncTimelineContent(undefined);
	}
}
