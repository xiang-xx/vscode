/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, IDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ViewContainerLocation } from '../../../../common/views.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../../services/panecomposite/browser/panecomposite.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { IChatRouterService, ISuperAgentWorkerHandle, SuperAgentWorkerState } from '../../common/superAgent/chatRouterService.js';
import { ISuperAgentPresentationQueue } from '../../common/superAgent/superAgentPresentationQueue.js';
import { ZCODE_VIEW_CONTAINER_ID } from '../zcode/zcodeAuxiliaryBarChrome.js';
import { registerSuperAgentActions, ZCODE_INTERNAL_SUPERAGENT_PRESENT_WORKER, ZCODE_INTERNAL_SUPERAGENT_SHOW_ROUTER, ZCODE_INTERNAL_TOGGLE_SUPERAGENT_WORKERS } from './superAgentCommands.js';
import { ZCODE_INTERNAL_SUPERAGENT_OPEN_ROUTER } from './superAgentRouterDispatcher.js';
import { SuperAgentWorkersPanel } from './superAgentWorkersView.js';
import { openSuperAgentSession } from './zcodeSessionUri.js';

/** Mirrors the `zcode.internal.*` pattern of the chat chrome. */
const ZCODE_INTERNAL_SET_WORKERS_TAB = 'zcode.internal.setSuperAgentWorkersTab';
/** Opens the Workers page and toggles (or forces) closed-worker history mode. */
const ZCODE_INTERNAL_TOGGLE_WORKER_HISTORY = 'zcode.internal.toggleSuperAgentWorkerHistory';

/**
 * Super Agent single-page shell (§5 of superAgentRedesign.md).
 *
 * One page only: Workers status strip pinned to the bottom of the auxiliary
 * bar (always open — no expand/collapse). Chat timeline fills the space above;
 * the strip reserves height via margin-bottom so it never paints over chat.
 * Clicking a worker renders that worker's timeline in place — never as a
 * title-bar session tab. Router is the default timeline when nothing is
 * presented. Presentation toast lives in SuperAgentPresentationUiContribution.
 */
export class SuperAgentChatPageContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chat.superAgentChatPage';

	private overlayEl: HTMLElement | undefined;
	private headerEl: HTMLElement | undefined;
	private titleEl: HTMLElement | undefined;
	private bodyEl: HTMLElement | undefined;
	/** Auxiliary-bar `.content` sibling — chat lives here; we shrink it to make room for the strip. */
	private contentEl: HTMLElement | undefined;
	private panel: SuperAgentWorkersPanel | undefined;
	private resizeObserver: ResizeObserver | undefined;
	private contentObserver: ResizeObserver | undefined;
	/** True while we are rewriting `.content` geometry so the observer does not re-enter. */
	private reservingChatSpace = false;
	private visible = false;
	private tabStateRegistration: IDisposable | undefined;
	private tabStateCommandReady = false;
	/** Resource string of the Router session, for the chrome's pinned-tab logic. */
	private routerSessionId: string | undefined;
	/** Attention count at the last tab-state push — drives the one-shot badge pulse. */
	private prevAttentionCount = 0;
	/** Session resource currently shown above the Workers strip (Router or a worker). */
	private shownSessionKey: string | undefined;
	private contentSyncToken = 0;
	private summaryEl: HTMLElement | undefined;

	constructor(
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
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
		this._register(CommandsRegistry.registerCommand(ZCODE_INTERNAL_TOGGLE_WORKER_HISTORY, async (_accessor, show?: boolean) => {
			await this.setVisible(true);
			if (!this.panel) {
				return;
			}
			this.panel.setHistoryMode(show === undefined ? !this.panel.historyMode : !!show);
		}));
		// Dispatch / "+" / dismiss: force the Router timeline above the strip.
		this._register(CommandsRegistry.registerCommand(ZCODE_INTERNAL_SUPERAGENT_SHOW_ROUTER, () => {
			void this.setVisible(true);
			this.showRouterOnPage();
		}));
		this._register(CommandsRegistry.registerCommand(ZCODE_INTERNAL_SUPERAGENT_PRESENT_WORKER, (_accessor, workerId?: string) => {
			if (typeof workerId !== 'string' || !workerId || !this.routerService.getWorker(workerId)) {
				return;
			}
			void this.setVisible(true);
			this.presentationQueue.present(workerId, { force: true });
		}));

		// Single-page default: when the chat surface is on screen, the status
		// strip + Router session are the page — no need to click a pinned tab.
		// Presentation of finished workers is owned by the presentation queue.
		this._register(this.routerService.onDidWorkerEvent(e => {
			if (e.kind !== 'stateChanged' && e.kind !== 'watchdogTripped' && e.kind !== 'workerCreated') { return; }
			if (this.visible) { return; }
			const active = this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar);
			if (active?.getId() !== ZCODE_VIEW_CONTAINER_ID) { return; }
			void this.setVisible(true);
		}));

		// Mount/unmount with the chat container; auto-enter the single page.
		const syncWithChatSurface = (location: ViewContainerLocation): void => {
			if (location !== ViewContainerLocation.AuxiliaryBar) {
				return;
			}
			this.syncOverlay();
			const active = this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar);
			if (active?.getId() === ZCODE_VIEW_CONTAINER_ID && !this.visible) {
				void this.setVisible(true);
			}
		};
		this._register(this.paneCompositeService.onDidPaneCompositeOpen(e => syncWithChatSurface(e.viewContainerLocation)));
		this._register(this.paneCompositeService.onDidPaneCompositeClose(e => syncWithChatSurface(e.viewContainerLocation)));
		this.syncOverlay();
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

		// Presented worker ↔ timeline above this strip (no session-tab switch).
		// Depend on `workers` so AI title renames refresh the page header label.
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
			this.syncOverlay();
			this.overlayEl?.classList.add('visible');
			this.applyStripHeight();
			this.layoutOverlay();
			this.panel?.focus();
			// Stay on this page: show the presented worker's timeline, or Router.
			const presentedId = this.presentationQueue.presentedWorkerId.get();
			const worker = presentedId ? this.routerService.getWorker(presentedId) : undefined;
			await this.syncTimelineContent(worker);
		} else {
			this.overlayEl?.classList.remove('visible');
			this.reserveChatSpace();
		}
		this.pushTabState();
	}

	/**
	 * Renders Router or a worker timeline above the Workers strip. Never opens
	 * a title-bar session tab — the webview content swaps in place.
	 */
	private async syncTimelineContent(worker: ISuperAgentWorkerHandle | undefined): Promise<void> {
		const token = ++this.contentSyncToken;
		if (worker) {
			this.updateHeaderTitle(worker);
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

		this.updateHeaderTitle(undefined);
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
			// Dispatcher not ready — strip still works standalone.
		}
	}

	private updateHeaderTitle(worker: ISuperAgentWorkerHandle | undefined): void {
		if (!this.titleEl) {
			return;
		}
		// The back arrow only exists off the main (Router) surface: while a
		// worker timeline or the history list is shown.
		const offMain = !!worker || !!this.panel?.historyMode;
		const back = this.headerEl?.querySelector<HTMLButtonElement>('.zcode-superagent-back');
		if (back) {
			back.style.display = offMain ? '' : 'none';
		}
		if (this.panel?.historyMode) {
			this.titleEl.textContent = localize('superAgentHistoryTitle', "History");
			return;
		}
		if (worker) {
			this.titleEl.textContent = worker.label;
			return;
		}
		this.titleEl.textContent = localize('superAgentPageTitle', "Workers");
	}

	/** Back to the Router dispatch surface on this same page. */
	private showRouterOnPage(): void {
		// Keep the 待查看 toast queue — only clear the presented slot so the
		// Router dispatch log shows. After the user sends on a worker,
		// dismissPresented will hand off to those waiting workers.
		this.presentationQueue.clearPresented();
		void this.syncTimelineContent(undefined);
	}

	//#region Overlay lifecycle

	private syncOverlay(): void {
		const active = this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar);
		if (active?.getId() === ZCODE_VIEW_CONTAINER_ID) {
			this.ensureOverlay();
			this.overlayEl?.classList.toggle('visible', this.visible);
			if (this.visible) {
				this.applyStripHeight();
				this.layoutOverlay();
			}
		} else {
			this.teardownOverlay();
		}
	}

	private ensureOverlay(): void {
		const container = this.layoutService.getContainer(mainWindow, Parts.AUXILIARYBAR_PART);
		if (!container || (this.overlayEl?.isConnected && this.overlayEl.parentElement === container)) {
			return;
		}
		this.teardownOverlay();

		this.overlayEl = dom.append(container, dom.$('.zcode-superagent-page'));

		const header = dom.append(this.overlayEl, dom.$('.zcode-superagent-page-header'));
		this.headerEl = header;
		this.titleEl = dom.append(header, dom.$('span.zcode-superagent-page-title'));
		this.titleEl.textContent = localize('superAgentPageTitle', "Workers");

		const back = dom.append(header, dom.$<HTMLButtonElement>('button.zcode-chrome-action.zcode-superagent-back', {
			type: 'button',
			title: localize('backToRouterChat', "Back to main chat"),
			'aria-label': localize('backToRouterChat', "Back to main chat"),
		}));
		back.classList.add(...ThemeIcon.asClassNameArray(Codicon.arrowLeft));
		back.style.display = 'none';
		this._register(dom.addDisposableListener(back, dom.EventType.CLICK, () => {
			this.panel?.setHistoryMode(false);
			this.showRouterOnPage();
		}));

		const newTask = dom.append(header, dom.$<HTMLButtonElement>('button.zcode-chrome-action', { type: 'button', title: localize('newTaskInRouter', "New task — type it in the Router chat above") }));
		newTask.classList.add(...ThemeIcon.asClassNameArray(Codicon.plus));
		this._register(dom.addDisposableListener(newTask, dom.EventType.CLICK, () => {
			this.panel?.setHistoryMode(false);
			this.showRouterOnPage();
		}));

		this.summaryEl = dom.append(header, dom.$('span.zcode-superagent-page-summary'));

		// Always-visible home sits left of history (bottom-right of the strip).
		const homeBtn = dom.append(header, dom.$<HTMLButtonElement>('button.zcode-chrome-action', {
			type: 'button',
			title: localize('superAgentHome', "首页"),
			'aria-label': localize('superAgentHome', "首页"),
		}));
		homeBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.home));
		this._register(dom.addDisposableListener(homeBtn, dom.EventType.CLICK, () => {
			this.panel?.setHistoryMode(false);
			this.showRouterOnPage();
		}));

		const historyBtn = dom.append(header, dom.$<HTMLButtonElement>('button.zcode-chrome-action', {
			type: 'button',
			title: localize('workerHistory', "Closed worker history"),
			'aria-label': localize('workerHistory', "Closed worker history"),
		}));
		historyBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.history));
		this._register(dom.addDisposableListener(historyBtn, dom.EventType.CLICK, () => {
			this.panel?.toggleHistoryMode();
		}));

		this.bodyEl = dom.append(this.overlayEl, dom.$('.zcode-superagent-page-body'));

		this.bindContentReservation(container);

		this.panel = this._register(this.instantiationService.createInstance(SuperAgentWorkersPanel));
		this.panel.render(this.bodyEl, { summaryHost: this.summaryEl });
		this._register(this.panel.onDidChangeHistoryMode(historyMode => {
			historyBtn.classList.toggle('active', historyMode);
			const presentedId = this.presentationQueue.presentedWorkerId.get();
			this.updateHeaderTitle(presentedId ? this.routerService.getWorker(presentedId) : undefined);
		}));
		// Clicking a worker keeps this page and swaps the timeline above.
		this._register(this.panel.onDidFocusWorker(() => {
			if (!this.visible) {
				void this.setVisible(true);
			}
		}));
		this._register(this.panel.onDidChangeContent(() => {
			this.applyStripHeight();
			this.layoutOverlay();
		}));

		this.resizeObserver = new ResizeObserver(() => this.layoutOverlay());
		this.resizeObserver.observe(this.bodyEl);
	}

	/**
	 * Track the auxiliary-bar `.content` pane so Part re-layouts (which rewrite
	 * its height) are followed by a matching chat-space reservation.
	 */
	private bindContentReservation(container: HTMLElement): void {
		const content = container.querySelector(':scope > .content');
		if (!dom.isHTMLElement(content)) {
			return;
		}
		this.contentEl = content;
		this.contentObserver?.disconnect();
		this.contentObserver = new ResizeObserver(() => {
			if (!this.reservingChatSpace) {
				this.reserveChatSpace();
			}
		});
		this.contentObserver.observe(content);
	}

	private teardownOverlay(): void {
		this.resizeObserver?.disconnect();
		this.resizeObserver = undefined;
		this.contentObserver?.disconnect();
		this.contentObserver = undefined;
		this.clearChatSpaceReservation();
		this.contentEl = undefined;
		this.overlayEl?.remove();
		this.overlayEl = undefined;
		this.headerEl = undefined;
		this.titleEl = undefined;
		this.summaryEl = undefined;
		this.bodyEl = undefined;
		this.shownSessionKey = undefined;
		if (this.panel) {
			this.panel.dispose();
			this.panel = undefined;
		}
	}

	/**
	 * Heights live inline. The strip hugs the worker list (multi-column grid) and
	 * still leaves ~160px of chat above. After sizing, push chat up by the
	 * same amount so the list occupies chat space instead of covering it.
	 */
	private applyStripHeight(): void {
		if (!this.overlayEl || !this.overlayEl.parentElement) {
			return;
		}
		const container = this.overlayEl.parentElement;
		const containerRect = container.getBoundingClientRect();
		const headerH = this.headerEl?.clientHeight ?? 32;
		// Keep a usable slice of the transcript + composer above the strip.
		const maxHeight = Math.max(140, containerRect.height - 160);
		const desired = headerH + (this.panel?.getDesiredHeight() ?? 0) + 6;
		const stripH = Math.round(Math.max(headerH + 40, Math.min(desired, maxHeight)));
		this.overlayEl.style.height = `${stripH}px`;
		// Toast is a sibling of this strip — put the height token on the shared parent.
		container.style.setProperty('--zcode-superagent-strip-h', `${stripH}px`);
		this.reserveChatSpace();
	}

	/**
	 * Sit the Workers strip below chat by claiming the same height from the
	 * auxiliary-bar `.content` pane (margin-bottom + reduced height). Part layout
	 * rewrites `.content` height; {@link bindContentReservation} re-applies.
	 */
	private reserveChatSpace(): void {
		if (!this.contentEl?.isConnected) {
			return;
		}
		const container = this.contentEl.parentElement;
		if (!container) {
			return;
		}
		const title = container.querySelector(':scope > .composite.title');
		const titleH = dom.isHTMLElement(title) ? title.getBoundingClientRect().height : 0;
		const fullContentH = Math.max(0, Math.round(container.getBoundingClientRect().height - titleH));
		const stripH = this.visible && this.overlayEl
			? Math.round(this.overlayEl.getBoundingClientRect().height)
			: 0;

		this.reservingChatSpace = true;
		try {
			if (stripH > 0) {
				this.contentEl.style.marginTop = '';
				this.contentEl.style.marginBottom = `${stripH}px`;
				this.contentEl.style.height = `${Math.max(0, fullContentH - stripH)}px`;
			} else {
				this.contentEl.style.marginTop = '';
				this.contentEl.style.marginBottom = '';
				this.contentEl.style.height = `${fullContentH}px`;
			}
			const viewPaneContainer = this.paneCompositeService
				.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar)
				?.getViewPaneContainer() as { layout?(dimension: Dimension): void } | undefined;
			viewPaneContainer?.layout?.(new Dimension(this.contentEl.clientWidth, this.contentEl.clientHeight));
		} finally {
			this.reservingChatSpace = false;
		}
	}

	private clearChatSpaceReservation(): void {
		if (!this.contentEl) {
			return;
		}
		this.reservingChatSpace = true;
		try {
			this.contentEl.style.marginTop = '';
			this.contentEl.style.marginBottom = '';
			// Leave height to the next Part layout pass.
			this.contentEl.style.height = '';
			this.contentEl.parentElement?.style.removeProperty('--zcode-superagent-strip-h');
		} finally {
			this.reservingChatSpace = false;
		}
	}

	private layoutOverlay(): void {
		if (this.bodyEl && this.panel) {
			this.panel.layout(this.bodyEl.clientHeight, this.bodyEl.clientWidth);
		}
	}

	//#endregion
}
