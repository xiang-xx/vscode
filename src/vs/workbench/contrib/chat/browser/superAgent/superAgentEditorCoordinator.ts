/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../../../base/common/async.js';
import { autorun, runOnChange } from '../../../../../base/common/observable.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { BrowserEditorInput } from '../../../browserView/common/browserEditorInput.js';
import { EditorsOrder } from '../../../../common/editor.js';
import { IDecorationData, IDecorationsProvider, IDecorationsService } from '../../../../services/decorations/common/decorations.js';
import { IEditorGroupsService, IEditorWorkingSet } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IChatEditReviewSession, IChatEditingSession, IChatEditingService } from '../../common/editing/chatEditingService.js';
import { IChatRouterService, ISuperAgentWorkerHandle } from '../../common/superAgent/chatRouterService.js';

/** Working-set map key for the Router/root chat stream (`focusedWorkerId === undefined`). */
const ROOT_OWNER_KEY = '__super_agent_root__';
/** Maximized auxiliary bar (Chat fullscreen) last chosen on the Router homepage. */
const ROUTER_AUX_BAR_MAXIMIZED_KEY = 'zcode.chatRouter.auxiliaryBarMaximized';

function isFullEditingSession(session: IChatEditReviewSession): session is IChatEditingSession {
	return 'show' in session;
}

/**
 * Attributes working-set files to their owning worker. Files owned by the
 * focused worker stay clean because their changes are "on stage" in the editor
 * area; files owned by background workers get a slot badge + accent color so
 * it is always clear which task touched which code.
 */
class SuperAgentWorkerDecorationsProvider extends Disposable implements IDecorationsProvider {

	readonly label = localize('superAgentDecorations', "Super Agent Workers");

	private readonly _onDidChange = new Emitter<readonly URI[]>();
	readonly onDidChange: Event<readonly URI[]> = this._onDidChange.event;

	constructor(
		private readonly _routerService: IChatRouterService,
		private readonly _chatEditingService: IChatEditingService,
	) {
		super();
		this._register(this._onDidChange);
		this._register(autorun(reader => {
			// Subscribe to everything that can change attribution: the worker
			// roster, the focused worker, and every session's working set.
			this._routerService.workers.read(reader);
			this._routerService.focusedWorkerId.read(reader);
			const uris: URI[] = [];
			for (const session of this._chatEditingService.editingSessionsObs.read(reader)) {
				for (const entry of session.entries.read(reader)) {
					uris.push(entry.modifiedURI);
				}
			}
			this._onDidChange.fire(uris);
		}));
	}

	provideDecorations(uri: URI): IDecorationData | undefined {
		const worker = this._workerForFile(uri);
		if (!worker || worker.isFocused.get()) {
			return undefined;
		}
		return {
			bubble: true,
			letter: worker.badge,
			color: worker.accentColorId,
			tooltip: localize('superAgentFileOwner', "Background worker {0} ({1}) edited this file", worker.badge, worker.label),
			weight: 10,
		};
	}

	private _workerForFile(uri: URI): ISuperAgentWorkerHandle | undefined {
		for (const session of this._chatEditingService.editingSessionsObs.get()) {
			const ownsFile = session.entries.get().some(entry => isEqual(entry.modifiedURI, uri) || isEqual(entry.originalURI, uri));
			if (!ownsFile) {
				continue;
			}
			const worker = this._routerService.getWorkerForChatSession(session.chatSessionResource);
			if (worker) {
				return worker;
			}
		}
		return undefined;
	}
}

/**
 * Links the Super-Agent router to the editor area.
 *
 * Ownership model: the editor area belongs to whoever owns the chat stream —
 * the focused worker, or the Router/root when `focusedWorkerId` is undefined.
 * When ownership moves, the coordinator snapshots the outgoing owner's open
 * editors (files, built-in browser tabs, layout) and restores the incoming
 * owner's set. The Router homepage also keeps its own fullscreen choice:
 * opening a file on a worker detail reveals the editor and the explorer, and
 * returning to the homepage puts that fullscreen back. Suggested-edits
 * multi-diff is only forced open on a worker's first visit with an empty set.
 * Background workers surface through file decorations instead of stealing tabs.
 *
 * Browser tabs survive the swap alive: while a working set is being applied,
 * disposal of open `BrowserEditorInput`s is vetoed, so the live browser view
 * is parked in memory with its owner. Restoring that owner's set resolves the
 * same input instance (the browser view service dedupes by id) and reconnects
 * to the still-live view instead of reloading the page by URL.
 */
export class SuperAgentEditorCoordinator extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chat.superAgentEditorCoordinator';

	private readonly _workingSets = new Map<string, IEditorWorkingSet>();
	private readonly _workingSetSequencer = new Sequencer();
	private _applyGeneration = 0;
	/** Skip the initial undefined→undefined observation; first real switch parks/applies. */
	private _hasSeenOwner = false;

	/**
	 * Browser tabs whose disposal was vetoed during a working-set swap. Key is
	 * the owner the tab was parked with; the live view is freed when that owner
	 * (a worker) leaves the live list.
	 */
	private readonly _retainedBrowserInputs = new Map<BrowserEditorInput, string>();
	private readonly _browserInputListeners = new Map<BrowserEditorInput, DisposableStore>();
	/** True only while this coordinator applies a working set (the swap window). */
	private _isSwappingEditorSets = false;
	private _parkedOwnerKeyDuringSwap: string | undefined;
	/**
	 * Fullscreen (maximized auxiliary bar) last chosen on the Router homepage.
	 * Seeded from the previous session. After layout restore, toggles and
	 * leaving the homepage refresh it. Unmaximizing on a detail does not.
	 */
	private _routerMaximized: boolean | undefined;
	private _layoutReady = false;

	constructor(
		@IChatRouterService private readonly _routerService: IChatRouterService,
		@IChatEditingService private readonly _chatEditingService: IChatEditingService,
		@IDecorationsService decorationsService: IDecorationsService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@IEditorService private readonly _editorService: IEditorService,
		@ILogService private readonly _logService: ILogService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();

		this._routerMaximized = this._storageService.getBoolean(ROUTER_AUX_BAR_MAXIMIZED_KEY, StorageScope.WORKSPACE);
		void this._layoutService.whenRestored.then(() => {
			this._layoutReady = true;
			// Landed on the homepage: the restored layout is that page's choice.
			if (this._routerService.focusedWorkerId.get() === undefined) {
				this._rememberRouterLayout();
			}
		});

		// (1) File attribution for background workers (explorer, open editors, tabs)
		this._register(decorationsService.registerDecorationsProvider(
			new SuperAgentWorkerDecorationsProvider(this._routerService, this._chatEditingService)
		));

		// Homepage fullscreen toggles count only while that page is showing.
		// A detail unmaximize (opening a file) must not erase the homepage choice.
		this._register(this._layoutService.onDidChangeAuxiliaryBarMaximized(() => {
			if (this._layoutReady && this._routerService.focusedWorkerId.get() === undefined) {
				this._rememberRouterLayout();
			}
		}));

		// (2) Editor tabs + layout follow the chat-stream owner (root or worker)
		this._register(runOnChange(this._routerService.focusedWorkerId, (focusedId, previousId) => {
			const prevKey = ownerKey(previousId);
			const nextKey = ownerKey(focusedId);
			if (prevKey === nextKey) {
				return;
			}

			let restoreRouterMaximized: boolean | undefined;
			if (previousId === undefined && focusedId !== undefined && this._layoutReady) {
				this._rememberRouterLayout();
			}
			if (focusedId === undefined && previousId !== undefined && this._routerMaximized !== undefined) {
				restoreRouterMaximized = this._routerMaximized;
			}

			// Park the outgoing owner unless that worker was just removed
			// (workerRemoved already dropped its parked set; re-saving under a
			// dead id would leak an orphan entry).
			const outgoingStillOwns =
				previousId === undefined || !!this._routerService.getWorker(previousId);
			if (outgoingStillOwns && (this._hasSeenOwner || this._editorService.visibleEditors.length > 0)) {
				this._saveWorkingSet(prevKey);
			}
			this._hasSeenOwner = true;

			void this._applyWorkingSetFor(nextKey, focusedId, prevKey, restoreRouterMaximized);
		}));

		// Drop parked editors when the worker leaves the live list.
		this._register(this._routerService.onDidWorkerEvent(e => {
			if (e.kind === 'workerRemoved') {
				this._deleteWorkingSet(e.workerId);
				this._disposeRetainedBrowserInputs(e.workerId);
			}
		}));
	}

	private _rememberRouterLayout(): void {
		const maximized = this._layoutService.isAuxiliaryBarMaximized();
		this._routerMaximized = maximized;
		this._storageService.store(ROUTER_AUX_BAR_MAXIMIZED_KEY, maximized, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private _saveWorkingSet(ownerId: string): void {
		this._deleteWorkingSet(ownerId);
		if (this._editorService.visibleEditors.length === 0) {
			return;
		}
		const label = ownerId === ROOT_OWNER_KEY
			? 'super-agent-root'
			: `super-agent-worker:${ownerId}`;
		const workingSet = this._editorGroupsService.saveWorkingSet(label);
		this._workingSets.set(ownerId, workingSet);
	}

	private _deleteWorkingSet(ownerId: string): void {
		const existing = this._workingSets.get(ownerId);
		if (!existing) {
			return;
		}
		this._workingSets.delete(ownerId);
		this._editorGroupsService.deleteWorkingSet(existing);
	}

	private async _applyWorkingSetFor(ownerId: string, focusedWorkerId: string | undefined, parkedOwnerKey: string, restoreRouterMaximized?: boolean): Promise<void> {
		const generation = ++this._applyGeneration;
		const workingSet: IEditorWorkingSet | 'empty' = this._workingSets.get(ownerId) ?? 'empty';
		try {
			await this._workingSetSequencer.queue(async () => {
				if (generation !== this._applyGeneration) {
					return;
				}
				let applied = false;
				try {
					// The swap window: browser tabs closed by the set replacement get
					// their disposal vetoed so the live view is parked, not destroyed.
					this._trackOpenBrowserInputs();
					this._parkedOwnerKeyDuringSwap = parkedOwnerKey;
					this._isSwappingEditorSets = true;
					try {
						applied = await this._editorGroupsService.applyWorkingSet(workingSet, { preserveFocus: true });
					} finally {
						this._isSwappingEditorSets = false;
						this._parkedOwnerKeyDuringSwap = undefined;
						this._releaseRestoredBrowserInputs();
					}
					if (generation !== this._applyGeneration || !applied) {
						return;
					}
					// First visit to a worker (empty stage): surface suggested edits if any.
					// Root and returning visits restore the exact tabs/active editor instead.
					if (workingSet === 'empty' && focusedWorkerId) {
						await this._showSuggestedEdits(focusedWorkerId);
					}
				} catch (err) {
					this._logService.error('[superAgent] failed to apply editor working set for focused owner', err);
				} finally {
					// After the detail's editors are parked, put the homepage's
					// fullscreen back. Doing it earlier lets an in-flight editor
					// close treat the hidden editor area as a user open and drop
					// the maximized state again.
					if (generation === this._applyGeneration && restoreRouterMaximized !== undefined) {
						this._layoutService.setAuxiliaryBarMaximized(restoreRouterMaximized);
					}
				}
			});
		} catch (err) {
			this._logService.error('[superAgent] failed to apply editor working set for focused owner', err);
		}
	}

	/** Watch every open browser tab so the swap window can veto its disposal. */
	private _trackOpenBrowserInputs(): void {
		for (const { editor } of this._editorService.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)) {
			if (editor instanceof BrowserEditorInput) {
				this._trackBrowserInput(editor);
			}
		}
	}

	private _trackBrowserInput(input: BrowserEditorInput): void {
		if (this._browserInputListeners.has(input)) {
			return;
		}
		const store = new DisposableStore();
		this._browserInputListeners.set(input, store);
		store.add(input.onBeforeDispose(e => {
			if (!this._isSwappingEditorSets) {
				return; // genuine close (user action, shutdown): allow disposal
			}
			// Park with the outgoing owner; restoring its set reconnects to the
			// same live instance (the browser view service dedupes by input id).
			e.veto();
			this._retainedBrowserInputs.set(input, this._parkedOwnerKeyDuringSwap ?? ROOT_OWNER_KEY);
		}));
		Event.once(input.onWillDispose)(() => {
			store.dispose();
			this._browserInputListeners.delete(input);
			this._retainedBrowserInputs.delete(input);
		});
	}

	/** Tabs that the applied set brought back are no longer parked. */
	private _releaseRestoredBrowserInputs(): void {
		if (this._retainedBrowserInputs.size === 0) {
			return;
		}
		const open = new Set(this._editorService.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).map(({ editor }) => editor));
		for (const input of [...this._retainedBrowserInputs.keys()]) {
			if (open.has(input)) {
				this._retainedBrowserInputs.delete(input);
			}
		}
	}

	/** Frees live browser views parked with an owner that left the live list. */
	private _disposeRetainedBrowserInputs(ownerKey: string): void {
		for (const [input, parkedWith] of [...this._retainedBrowserInputs]) {
			if (parkedWith === ownerKey) {
				input.dispose(true); // force: bypass the veto, frees the live view
			}
		}
	}

	public override dispose(): void {
		for (const store of this._browserInputListeners.values()) {
			store.dispose();
		}
		this._browserInputListeners.clear();
		super.dispose();
	}

	private async _showSuggestedEdits(workerId: string): Promise<void> {
		const worker = this._routerService.getWorker(workerId);
		if (!worker) {
			return;
		}
		const session = this._chatEditingService.getEditingSession(worker.chatSessionResource);
		if (!session || !isFullEditingSession(session) || session.entries.get().length === 0) {
			return;
		}
		try {
			await session.show();
		} catch (err) {
			this._logService.error('[superAgent] failed to show working set of focused worker', err);
		}
	}
}

function ownerKey(focusedWorkerId: string | undefined): string {
	return focusedWorkerId ?? ROOT_OWNER_KEY;
}
