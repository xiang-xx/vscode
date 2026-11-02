/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ViewContainerLocation } from '../../../../common/views.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../../services/panecomposite/browser/panecomposite.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { IChatRouterService } from '../../common/superAgent/chatRouterService.js';
import { ISuperAgentPresentationQueue } from '../../common/superAgent/superAgentPresentationQueue.js';
import { ZCODE_VIEW_CONTAINER_ID } from '../zcode/zcodeAuxiliaryBarChrome.js';
import { ViewPendingSuperAgentWorkerAction, ZCODE_INTERNAL_TOGGLE_SUPERAGENT_WORKERS } from './superAgentCommands.js';

/**
 * Single-page presentation chrome (§5.5):
 * - bottom-right toast while more workers wait in the queue.
 *
 * Selection state lives in the Workers list itself — no page-bottom dock.
 * Timeline content under the Workers strip is owned by
 * SuperAgentChatPageContribution — this contribution never opens session tabs.
 */
export class SuperAgentPresentationUiContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chat.superAgentPresentationUi';

	private toastEl: HTMLElement | undefined;
	private readonly toastListeners = this._register(new DisposableStore());
	/** Last presented id we forced the Workers page open for (avoid re-entry on state ticks). */
	private lastPresentedForPage: string | undefined;

	constructor(
		@ISuperAgentPresentationQueue private readonly presentationQueue: ISuperAgentPresentationQueue,
		@IChatRouterService private readonly routerService: IChatRouterService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
		@ICommandService private readonly commandService: ICommandService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {
		super();

		this._register(this.paneCompositeService.onDidPaneCompositeOpen(e => {
			if (e.viewContainerLocation === ViewContainerLocation.AuxiliaryBar) {
				this.refresh();
			}
		}));
		this._register(this.paneCompositeService.onDidPaneCompositeClose(e => {
			if (e.viewContainerLocation === ViewContainerLocation.AuxiliaryBar) {
				this.refresh();
			}
		}));

		this._register(autorun(reader => {
			const presentedId = this.presentationQueue.presentedWorkerId.read(reader);
			const toastItem = this.presentationQueue.toast.read(reader);
			const pending = this.presentationQueue.pending.read(reader);
			if (presentedId) {
				this.routerService.getWorker(presentedId)?.state.read(reader);
			}
			this.syncChrome(presentedId, toastItem?.workerId, pending.length);
		}));
	}

	private refresh(): void {
		const presentedId = this.presentationQueue.presentedWorkerId.get();
		const toastItem = this.presentationQueue.toast.get();
		const pending = this.presentationQueue.pending.get();
		this.syncChrome(presentedId, toastItem?.workerId, pending.length);
	}

	private syncChrome(presentedId: string | undefined, toastWorkerId: string | undefined, pendingCount: number): void {
		const onChat = this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar)?.getId() === ZCODE_VIEW_CONTAINER_ID;
		if (!onChat) {
			this.teardown();
			return;
		}

		// Keep the Workers page up so the timeline renders under the strip.
		if (presentedId && presentedId !== this.lastPresentedForPage) {
			this.lastPresentedForPage = presentedId;
			void this.commandService.executeCommand(ZCODE_INTERNAL_TOGGLE_SUPERAGENT_WORKERS, true).catch(() => { });
		} else if (!presentedId) {
			this.lastPresentedForPage = undefined;
		}

		this.renderToast(toastWorkerId, pendingCount);
	}

	private renderToast(toastWorkerId: string | undefined, pendingCount: number): void {
		this.toastListeners.clear();
		const container = this.layoutService.getContainer(mainWindow, Parts.AUXILIARYBAR_PART);
		if (!container || !toastWorkerId || pendingCount <= 0) {
			this.toastEl?.remove();
			this.toastEl = undefined;
			return;
		}
		const worker = this.routerService.getWorker(toastWorkerId);
		if (!worker) {
			this.toastEl?.remove();
			this.toastEl = undefined;
			return;
		}

		if (!this.toastEl || !this.toastEl.isConnected) {
			this.toastEl?.remove();
			this.toastEl = dom.append(container, dom.$('.zcode-superagent-toast'));
		}
		dom.clearNode(this.toastEl);

		const label = dom.append(this.toastEl, dom.$('span.zcode-superagent-toast-label'));
		if (pendingCount > 1) {
			label.textContent = localize('toast.many', "{0} 等 {1} 个待查看", worker.label, pendingCount);
		} else {
			label.textContent = localize('toast.one', "{0}", worker.label);
		}

		const view = dom.append(this.toastEl, dom.$<HTMLButtonElement>('button.zcode-superagent-toast-btn', { type: 'button' }));
		const kb = this.keybindingService.lookupKeybinding(ViewPendingSuperAgentWorkerAction.ID)?.getLabel();
		view.textContent = kb
			? localize('toast.viewWithKb', "查看 ({0})", kb)
			: localize('toast.view', "查看");
		view.title = kb
			? localize('toast.viewTitleWithKb', "查看该 Worker（{0}）", kb)
			: localize('toast.viewTitle', "查看该 Worker");
		this.toastListeners.add(dom.addDisposableListener(view, dom.EventType.CLICK, () => {
			void this.commandService.executeCommand(ViewPendingSuperAgentWorkerAction.ID);
		}));
	}

	private teardown(): void {
		this.toastListeners.clear();
		this.toastEl?.remove();
		this.toastEl = undefined;
	}

	override dispose(): void {
		this.teardown();
		super.dispose();
	}
}
