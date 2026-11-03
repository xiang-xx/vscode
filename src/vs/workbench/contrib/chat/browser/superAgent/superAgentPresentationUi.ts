/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ViewContainerLocation } from '../../../../common/views.js';
import { IPaneCompositePartService } from '../../../../services/panecomposite/browser/panecomposite.js';
import { IChatRouterService } from '../../common/superAgent/chatRouterService.js';
import { ISuperAgentPresentationQueue } from '../../common/superAgent/superAgentPresentationQueue.js';
import { ZCODE_VIEW_CONTAINER_ID } from '../zcode/zcodeAuxiliaryBarChrome.js';
import { SuperAgentWorkerDetailOpen, SuperAgentWorkerViewable, ZCODE_INTERNAL_TOGGLE_SUPERAGENT_WORKERS } from './superAgentCommands.js';

/**
 * Single-page presentation chrome (§5.5):
 * - ⌘]/⌘[ context-key gates and Workers-page upkeep while workers wait.
 *
 * Selection state lives in the Workers list itself — no page-bottom dock and
 * no bottom-right toast: completed workers are surfaced by the chat page's
 * "待查看" pill above the composer.
 * Timeline content under the Workers strip is owned by
 * SuperAgentChatPageContribution — this contribution never opens session tabs.
 */
export class SuperAgentPresentationUiContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chat.superAgentPresentationUi';

	/** Last presented id we forced the Workers page open for (avoid re-entry on state ticks). */
	private lastPresentedForPage: string | undefined;
	/** ⌘] gate — see {@link SuperAgentWorkerViewable}. */
	private readonly workerViewable: IContextKey<boolean>;
	/** ⌘[ gate — see {@link SuperAgentWorkerDetailOpen}. */
	private readonly workerDetailOpen: IContextKey<boolean>;

	constructor(
		@ISuperAgentPresentationQueue private readonly presentationQueue: ISuperAgentPresentationQueue,
		@IChatRouterService private readonly routerService: IChatRouterService,
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this.workerViewable = SuperAgentWorkerViewable.bindTo(contextKeyService);
		this.workerDetailOpen = SuperAgentWorkerDetailOpen.bindTo(contextKeyService);

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
			this.workerViewable.set(false);
			this.workerDetailOpen.set(false);
			return;
		}

		// The ⌘] / ⌘[ chords (superAgentCommands.ts) only own the bracket keys
		// while there is something to enter / exit; text editors keep their
		// default indent / outdent the rest of the time.
		this.workerViewable.set(!!toastWorkerId || pendingCount > 0);
		this.workerDetailOpen.set(!!presentedId);

		// Keep the Workers page up so the timeline renders under the strip.
		if (presentedId && presentedId !== this.lastPresentedForPage) {
			this.lastPresentedForPage = presentedId;
			void this.commandService.executeCommand(ZCODE_INTERNAL_TOGGLE_SUPERAGENT_WORKERS, true).catch(() => { });
		} else if (!presentedId) {
			this.lastPresentedForPage = undefined;
		}
	}
}
