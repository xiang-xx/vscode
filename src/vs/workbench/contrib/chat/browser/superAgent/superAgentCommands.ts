/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { getActiveElement } from '../../../../../base/browser/dom.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IChatWidgetService } from '../chat.js';
import { IChatRouterService, ISuperAgentWorkerHandle, SuperAgentWorkerState } from '../../common/superAgent/chatRouterService.js';
import { ISuperAgentPresentationQueue } from '../../common/superAgent/superAgentPresentationQueue.js';
import { zcodeSessionResource } from './zcodeSessionUri.js';

/**
 * Internal toggle for the Workers page (pinned first tab of the chat surface).
 * Registered by `SuperAgentChatPageContribution`; `show` undefined = toggle.
 */
export const ZCODE_INTERNAL_TOGGLE_SUPERAGENT_WORKERS = 'zcode.internal.toggleSuperAgentWorkersPage';

/** Forces the Router timeline under the Workers strip (used after dispatch). */
export const ZCODE_INTERNAL_SUPERAGENT_SHOW_ROUTER = 'zcode.internal.superAgent.showRouter';

/** Force-presents a worker timeline under the strip (dispatch card click). */
export const ZCODE_INTERNAL_SUPERAGENT_PRESENT_WORKER = 'zcode.internal.superAgent.presentWorker';

/**
 * True while the bottom-right toast / pending queue offers a worker to view.
 * Gates ⌘] so the editor's default indent (⌘] / Ctrl+]) keeps working when
 * there is nothing to enter. Maintained by SuperAgentPresentationUiContribution.
 */
export const SuperAgentWorkerViewable = new RawContextKey<boolean>('superAgentWorkerViewable', false);

/**
 * True while a worker detail timeline is presented (instead of the Router
 * main page). Gates ⌘[; combined with `!editorTextFocus` so outdent (⌘[ /
 * Ctrl+[) always wins inside text editors.
 */
export const SuperAgentWorkerDetailOpen = new RawContextKey<boolean>('superAgentWorkerDetailOpen', false);

/**
 * Shows (toggles) the Super Agent Workers page — the pinned first tab of the
 * chat surface. This is what the pinned tab click and the F1 palette run.
 */
export class ShowSuperAgentWorkersPageAction extends Action2 {

	static readonly ID = 'workbench.action.chat.superAgent.showWorkersPage';

	constructor() {
		super({
			id: ShowSuperAgentWorkersPageAction.ID,
			title: localize2('showWorkersPage', "Show Super Agent Workers Page"),
			category: localize2('superAgentCategory0', "Chat"),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<unknown> {
		return accessor.get(ICommandService).executeCommand(ZCODE_INTERNAL_TOGGLE_SUPERAGENT_WORKERS, true);
	}
}

/**
 * Spawns a worker: creates a fresh chat session for it, binds the worker to
 * that session, then steps the chat surface aside so the new session shows.
 */
export class NewSuperAgentWorkerAction extends Action2 {

	static readonly ID = 'workbench.action.chat.superAgent.newWorker';

	constructor() {
		super({
			id: NewSuperAgentWorkerAction.ID,
			title: localize2('newSuperAgentWorker', "New Super Agent Worker"),
			category: localize2('superAgentCategory', "Chat"),
			icon: Codicon.plus,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const routerService = accessor.get(IChatRouterService);
		const commandService = accessor.get(ICommandService);
		const notificationService = accessor.get(INotificationService);
		const presentationQueue = accessor.get(ISuperAgentPresentationQueue);

		const label = await quickInputService.input({
			prompt: localize('newWorker.prompt', "What should this worker do?"),
			placeHolder: localize('newWorker.placeholder', "e.g. Fix flaky login tests"),
		});
		if (!label || !label.trim()) {
			return;
		}

		// Fresh isolated zcode session for the worker (Router+Worker: one session per worker).
		let sessionId: string | undefined;
		try {
			sessionId = await commandService.executeCommand<string>('zcode.createWorkerSession', { title: label.trim() });
		} catch (err) {
			notificationService.warn(localize('newWorker.createFailed', "Creating the worker session failed: {0}", toErrorMessage(err)));
			return;
		}
		if (!sessionId || typeof sessionId !== 'string') {
			notificationService.warn(localize('newWorker.noSession', "Worker session was not created."));
			return;
		}

		const sessionResource = zcodeSessionResource(sessionId);
		const worker = routerService.createWorker({ label: label.trim(), chatSessionResource: sessionResource });
		// Stay on the Workers page; ChatPage renders this worker's timeline in place.
		presentationQueue.present(worker.id, { force: true });
		await commandService.executeCommand(ZCODE_INTERNAL_TOGGLE_SUPERAGENT_WORKERS, true);
	}
}

/**
 * Promotes the chat session the user is currently in to a worker — the manual
 * path of Router dispatch until intent parsing arrives (Phase 3).
 */
export class BindCurrentChatAsWorkerAction extends Action2 {

	static readonly ID = 'workbench.action.chat.superAgent.bindCurrentChat';

	constructor() {
		super({
			id: BindCurrentChatAsWorkerAction.ID,
			title: localize2('bindCurrentChat', "Bind Current Chat as Super Agent Worker"),
			category: localize2('superAgentCategory2', "Chat"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const chatWidgetService = accessor.get(IChatWidgetService);
		const routerService = accessor.get(IChatRouterService);
		const quickInputService = accessor.get(IQuickInputService);
		const commandService = accessor.get(ICommandService);
		const notificationService = accessor.get(INotificationService);

		let sessionResource = chatWidgetService.lastFocusedWidget?.viewModel?.sessionResource;
		if (!sessionResource) {
			// ZCode fork: the visible chat is the webview — fall back to its active tab.
			const zcodeId = await commandService.executeCommand<string>('zcode.getActiveSessionId');
			if (typeof zcodeId === 'string' && zcodeId) {
				sessionResource = zcodeSessionResource(zcodeId);
			}
		}
		if (!sessionResource) {
			notificationService.info(localize('bind.noSession', "Focus a chat session first, then run this command."));
			return;
		}

		const existing = routerService.getWorkerForChatSession(sessionResource);
		if (existing) {
			routerService.focusWorker(existing.id);
			await commandService.executeCommand(ZCODE_INTERNAL_TOGGLE_SUPERAGENT_WORKERS, true);
			return;
		}

		const label = await quickInputService.input({
			prompt: localize('bind.prompt', "Label this worker"),
			placeHolder: localize('bind.placeholder', "e.g. Refactor auth module"),
		});
		if (!label || !label.trim()) {
			return;
		}

		routerService.createWorker({ label: label.trim(), chatSessionResource: sessionResource });
		await commandService.executeCommand(ZCODE_INTERNAL_TOGGLE_SUPERAGENT_WORKERS, true);
	}
}

/**
 * Same as clicking the bottom-right toast「查看」: jump to the next pending
 * worker that needs attention. ⌘] / Ctrl+] ("enter"), gated on
 * `superAgentWorkerViewable` so it only takes the key while the toast /
 * pending queue is live — the editor's default indent keeps the chord the
 * rest of the time.
 */
export class ViewPendingSuperAgentWorkerAction extends Action2 {

	static readonly ID = 'workbench.action.chat.superAgent.viewPendingWorker';

	constructor() {
		super({
			id: ViewPendingSuperAgentWorkerAction.ID,
			title: localize2('viewPendingWorker', "View Pending Super Agent Worker"),
			category: localize2('superAgentCategory3', "Chat"),
			f1: true,
			keybinding: {
				// ⌘] / Ctrl+] — bracket-right "enters" the pending worker detail.
				primary: KeyMod.CtrlCmd | KeyCode.BracketRight,
				weight: KeybindingWeight.WorkbenchContrib + 10,
				when: SuperAgentWorkerViewable,
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const presentationQueue = accessor.get(ISuperAgentPresentationQueue);
		const commandService = accessor.get(ICommandService);
		const routerService = accessor.get(IChatRouterService);

		// Toast first (FIFO), then the pending queue, then — once the toast was
		// dismissed and the queue drained — the most recently completed worker.
		// Without the fallback the chord is a silent no-op right after the
		// bottom-right toast disappears, which reads as "shortcut not working".
		const queuedId = presentationQueue.toast.get()?.workerId
			?? presentationQueue.pending.get()[0]?.workerId;
		let latest: ISuperAgentWorkerHandle | undefined;
		if (!queuedId) {
			for (const worker of routerService.workers.get()) {
				if (worker.state.get() !== SuperAgentWorkerState.Completed) {
					continue;
				}
				if (!latest || worker.createdAt > latest.createdAt) {
					latest = worker;
				}
			}
		}
		const workerId = queuedId ?? latest?.id;
		if (!workerId) {
			return;
		}

		await commandService.executeCommand(ZCODE_INTERNAL_SUPERAGENT_PRESENT_WORKER, workerId);
	}
}

/**
 * Leaves a presented worker timeline and returns to the Router main page —
 * the "read it, then jump back" counterpart of {@link ViewPendingSuperAgentWorkerAction}.
 * ⌘[ / Ctrl+[ ("exit"), gated on `superAgentWorkerDetailOpen` and never
 * while a text editor has focus, so outdent keeps its default chord.
 */
export class BackToSuperAgentRouterAction extends Action2 {

	static readonly ID = 'workbench.action.chat.superAgent.backToRouter';

	constructor() {
		super({
			id: BackToSuperAgentRouterAction.ID,
			title: localize2('backToRouter', "Back to Super Agent Router Page"),
			category: localize2('superAgentCategory4', "Chat"),
			f1: true,
			keybinding: {
				// ⌘[ / Ctrl+[ — bracket-left "exits" back to the Router main page.
				primary: KeyMod.CtrlCmd | KeyCode.BracketLeft,
				weight: KeybindingWeight.WorkbenchContrib + 10,
				when: ContextKeyExpr.and(SuperAgentWorkerDetailOpen, ContextKeyExpr.notEquals('editorTextFocus', true)),
			},
		});
	}

	override run(accessor: ServicesAccessor): Promise<unknown> {
		// Same `editorTextFocus` gate as the keybinding above, applied to the
		// callers the `when` clause never sees (mouse back side button,
		// webview-forwarded clicks): a text editor that owns the caret keeps
		// the back gesture for its own Go Back navigation. Resolved against
		// the focused element because the key is editor-scoped.
		if (accessor.get(IContextKeyService).getContext(getActiveElement()).getValue(EditorContextKeys.editorTextFocus.key) === true) {
			return Promise.resolve();
		}
		return accessor.get(ICommandService).executeCommand(ZCODE_INTERNAL_SUPERAGENT_SHOW_ROUTER);
	}
}

export function registerSuperAgentActions(): void {
	registerAction2(ShowSuperAgentWorkersPageAction);
	registerAction2(NewSuperAgentWorkerAction);
	registerAction2(BindCurrentChatAsWorkerAction);
	registerAction2(ViewPendingSuperAgentWorkerAction);
	registerAction2(BackToSuperAgentRouterAction);
}
