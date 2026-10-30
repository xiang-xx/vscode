/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ViewContainerLocation } from '../../../../common/views.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts, Position } from '../../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../../services/panecomposite/browser/panecomposite.js';
import { ZCODE_VIEW_CONTAINER_ID } from './zcodeAuxiliaryBarChrome.js';

const LAYOUT_APPLIED_KEY = 'zcode.chatFirstLayout.applied.v6';
/** When editor is open, keep Chat as the dominant center pane. */
const CHAT_WIDTH_RATIO = 0.58;

/**
 * Chat-first workbench layout:
 * - Explorer left | Chat (+ terminal below) center | editor right
 *   (via `zcode.layout.chatPosition: center`)
 * - Chat is never auto-maximized; it sits center with editor to its right
 *
 * Chat is never auto-maximized; on restore any persisted maximized state is undone.
 */
export class ZCodeChatLayoutContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.zcodeChatLayout';

	private readonly resizeTimers = this._register(new DisposableStore());
	private hadEditors = false;
	private applyingSize = false;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();

		this.hadEditors = this.editorService.visibleEditors.length > 0;
		void this.bootstrap();
		this._register(this.editorService.onDidVisibleEditorsChange(() => this.onEditorsChanged()));
	}

	private async bootstrap(): Promise<void> {
		const applied = this.storageService.getBoolean(LAYOUT_APPLIED_KEY, StorageScope.PROFILE, false);
		if (!applied) {
			await this.applyChatFirstDefaults();
			this.storageService.store(LAYOUT_APPLIED_KEY, true, StorageScope.PROFILE, StorageTarget.MACHINE);
		}

		await this.ensureChatSurface();
		// Keep terminal under Chat (middle column) once the grid is up.
		try {
			if (this.layoutService.getPanelPosition() !== Position.BOTTOM) {
				this.layoutService.setPanelPosition(Position.BOTTOM);
			}
			if (this.layoutService.getPanelAlignment() !== 'center') {
				this.layoutService.setPanelAlignment('center');
			}
		} catch {
			// ignore if panel not ready yet
		}

		// Wait for editors/layout restore before unmaximizing/width decisions.
		await this.layoutService.whenRestored;
		this.hadEditors = this.editorService.visibleEditors.length > 0;

		// Chat must never auto-maximize: undo any persisted maximized state on restore.
		if (this.layoutService.isAuxiliaryBarMaximized()) {
			this.layoutService.setAuxiliaryBarMaximized(false);
			this.resizeTimers.clear();
			this.scheduleChatDominantWidth(50);
			this.scheduleChatDominantWidth(250);
			this.scheduleChatDominantWidth(600);
			return;
		}

		this.onEditorsChanged();
	}

	private async applyChatFirstDefaults(): Promise<void> {
		const updates: Array<Promise<void>> = [];
		// Explorer | Chat(+terminal) | Editor
		if (this.configurationService.getValue('workbench.sideBar.location') !== 'left') {
			updates.push(this.configurationService.updateValue('workbench.sideBar.location', 'left'));
		}
		if (this.configurationService.getValue('zcode.layout.chatPosition') !== 'center') {
			updates.push(this.configurationService.updateValue('zcode.layout.chatPosition', 'center'));
		}
		if (this.configurationService.getValue('workbench.panel.defaultLocation') !== 'bottom') {
			updates.push(this.configurationService.updateValue('workbench.panel.defaultLocation', 'bottom'));
		}
		if (this.configurationService.getValue('workbench.secondarySideBar.forceMaximized') !== false) {
			updates.push(this.configurationService.updateValue('workbench.secondarySideBar.forceMaximized', false));
		}
		const visibility = this.configurationService.getValue<string>('workbench.secondarySideBar.defaultVisibility');
		if (visibility !== 'visible' && visibility !== 'visibleInWorkspace') {
			updates.push(this.configurationService.updateValue('workbench.secondarySideBar.defaultVisibility', 'visibleInWorkspace'));
		}
		// Keep the primary activity bar on the left (not top).
		const activityBar = this.configurationService.getValue<string>('workbench.activityBar.location');
		if (activityBar === 'top' || activityBar === 'bottom' || activityBar === 'hidden') {
			updates.push(this.configurationService.updateValue('workbench.activityBar.location', 'default'));
		}
		if (this.configurationService.getValue('workbench.startupEditor') !== 'none') {
			updates.push(this.configurationService.updateValue('workbench.startupEditor', 'none'));
		}
		await Promise.all(updates);
	}

	private async ensureChatSurface(): Promise<void> {
		this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		await this.paneCompositeService.openPaneComposite(ZCODE_VIEW_CONTAINER_ID, ViewContainerLocation.AuxiliaryBar, true);
	}

	private onEditorsChanged(): void {
		const hasVisibleEditors = this.editorService.visibleEditors.length > 0;
		const openedEditors = hasVisibleEditors && !this.hadEditors;
		this.hadEditors = hasVisibleEditors;

		if (!hasVisibleEditors) {
			// Chat must never auto-maximize, not even with an empty editor area.
			return;
		}

		// If a previous session left Chat maximized, restore side-by-side.
		const wasMaximized = this.layoutService.isAuxiliaryBarMaximized();
		if (wasMaximized) {
			this.layoutService.setAuxiliaryBarMaximized(false);
		}

		if (openedEditors || wasMaximized) {
			this.resizeTimers.clear();
			this.scheduleChatDominantWidth(50);
			this.scheduleChatDominantWidth(250);
			this.scheduleChatDominantWidth(600);
		}
	}

	private scheduleChatDominantWidth(delayMs: number): void {
		const handle = setTimeout(() => this.applyChatDominantWidth(), delayMs);
		this.resizeTimers.add({ dispose: () => clearTimeout(handle) });
	}

	private applyChatDominantWidth(): void {
		if (this.applyingSize) {
			return;
		}
		// If still maximized (restore race), leave maximized mode then size Chat.
		if (this.layoutService.isAuxiliaryBarMaximized()) {
			if (this.editorService.visibleEditors.length === 0) {
				return;
			}
			this.layoutService.setAuxiliaryBarMaximized(false);
		}
		if (!this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
			return;
		}
		if (this.editorService.visibleEditors.length === 0) {
			return;
		}

		const total = this.layoutService.mainContainerDimension.width;
		if (total < 600) {
			return;
		}

		const target = Math.round(total * CHAT_WIDTH_RATIO);
		const current = this.layoutService.getSize(Parts.AUXILIARYBAR_PART).width;
		const delta = target - current;
		if (Math.abs(delta) < 24) {
			return;
		}

		this.applyingSize = true;
		try {
			this.layoutService.resizePart(Parts.AUXILIARYBAR_PART, delta, 0);
		} finally {
			this.applyingSize = false;
		}
	}
}
