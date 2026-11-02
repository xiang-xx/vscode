/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { $, addDisposableListener, append, isHTMLElement, prepend } from '../../../../../base/browser/dom.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ViewContainerLocation } from '../../../../common/views.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../../services/panecomposite/browser/panecomposite.js';
import { mainWindow } from '../../../../../base/browser/window.js';

/** Extension viewsContainers id `zcode` → workbench container id. */
export const ZCODE_VIEW_CONTAINER_ID = 'workbench.view.extension.zcode';
export const ZCODE_CHAT_VIEW_ID = 'zcode.chatView';

/**
 * When AI Chat owns the auxiliary bar:
 * - hide the "AI Chat" title / composite-bar label
 * - render the pinned Super Agent Workers tab (session tabs / New Chat /
 *   History drawer entry points are retired — everything lives in the
 *   Router + Workers page)
 * - keep workbench title-actions (… / maximize / close) on the right
 */
export class ZCodeAuxiliaryBarChrome extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.zcodeAuxiliaryBarChrome';

	private tabsHost: HTMLElement | undefined;
	/**
	 * Pinned Super Agent Workers tab — the only title-row chat chrome.
	 * The page itself (a layer above the chat webview) is owned by
	 * `SuperAgentChatPageContribution`; this chrome only renders the tab and
	 * reflects state pushed via `zcode.internal.setSuperAgentWorkersTab`.
	 */
	private workersTabEl: HTMLButtonElement | undefined;
	private workersTab: { active: boolean; badge: number; attention: boolean; routerSession?: string; pulse?: boolean } = { active: false, badge: 0, attention: false };
	private readonly pinnedListeners = this._register(new DisposableStore());

	constructor(
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		this._register(this.paneCompositeService.onDidPaneCompositeOpen(e => {
			if (e.viewContainerLocation === ViewContainerLocation.AuxiliaryBar) {
				this.update();
			}
		}));
		this._register(this.paneCompositeService.onDidPaneCompositeClose(e => {
			if (e.viewContainerLocation === ViewContainerLocation.AuxiliaryBar) {
				this.update();
			}
		}));
		this._register(CommandsRegistry.registerCommand('zcode.internal.setSuperAgentWorkersTab', (_accessor, state: unknown) => {
			if (state && typeof state === 'object') {
				const s = state as { active?: unknown; badge?: unknown; attention?: unknown; routerSession?: unknown; pulse?: unknown };
				this.workersTab = {
					active: !!s.active,
					badge: Math.max(0, Math.floor(Number(s.badge) || 0)),
					attention: !!s.attention,
					routerSession: typeof s.routerSession === 'string' ? s.routerSession : undefined,
					pulse: !!s.pulse,
				};
				this.updateWorkersTab();
			}
		}));
		// Legacy no-op: session title tabs are retired under Router+Worker mode.
		this._register(CommandsRegistry.registerCommand('zcode.internal.setTitleTabs', () => { }));
		this.update();
	}

	private update(): void {
		const active = this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar);
		const isZcode = active?.getId() === ZCODE_VIEW_CONTAINER_ID;
		const container = this.layoutService.getContainer(mainWindow, Parts.AUXILIARYBAR_PART);
		container?.classList.toggle('zcode-chat-active', !!isZcode);
		if (isZcode) {
			this.ensureChrome();
		} else {
			this.teardownChrome();
		}
	}

	private ensureChrome(): void {
		const container = this.layoutService.getContainer(mainWindow, Parts.AUXILIARYBAR_PART);
		const title = container?.querySelector('.composite.title') as HTMLElement | null;
		if (!title) {
			return;
		}
		if (this.tabsHost?.isConnected && this.tabsHost.parentElement === title) {
			return;
		}
		this.teardownChrome();
		this.tabsHost = prepend(title, $('div.zcode-title-tabs-host'));
		this.mountWorkersTab();
	}

	/**
	 * The pinned Workers tab. It lives alone in the title host — no session
	 * tab strip, no New Chat / History chrome actions.
	 */
	private mountWorkersTab(): void {
		if (!this.tabsHost) {
			return;
		}
		const btn = append(this.tabsHost, $<HTMLButtonElement>('button.zcode-session-tab.zcode-tab-pinned', { type: 'button' }));
		btn.setAttribute('role', 'tab');
		btn.setAttribute('aria-selected', 'false');
		btn.title = 'Super Agent Workers';

		const icon = append(btn, $('span.zcode-tab-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.layers));

		const label = append(btn, $('span.zcode-tab-title'));
		label.textContent = 'Workers';

		append(btn, $('span.zcode-tab-badge'));

		const activate = (e: Event) => {
			e.preventDefault();
			e.stopPropagation();
			(e as { stopImmediatePropagation?: () => void }).stopImmediatePropagation?.();
			// Toggle semantics live in the page contribution, which pushes the
			// authoritative active state back via zcode.internal.setSuperAgentWorkersTab.
			void this.commandService.executeCommand('workbench.action.chat.superAgent.showWorkersPage');
		};
		this.pinnedListeners.add(addDisposableListener(btn, 'pointerdown', e => {
			if (e.button === 0) {
				activate(e);
			}
		}));
		this.pinnedListeners.add(addDisposableListener(btn, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
		}));

		this.workersTabEl = btn;
		this.updateWorkersTab();
	}

	private updateWorkersTab(): void {
		const btn = this.workersTabEl;
		if (!btn) {
			return;
		}
		btn.classList.toggle('active', this.workersTab.active);
		btn.setAttribute('aria-selected', this.workersTab.active ? 'true' : 'false');
		btn.title = this.workersTab.attention ? 'Super Agent Workers — a worker needs you' : 'Super Agent Workers';
		const badge = btn.querySelector('.zcode-tab-badge');
		if (badge) {
			badge.textContent = this.workersTab.badge > 0 ? String(this.workersTab.badge) : '';
			badge.classList.toggle('hidden', this.workersTab.badge <= 0);
			badge.classList.toggle('attention', this.workersTab.attention);
			// One-shot attention pulse: retrigger the animation via reflow.
			if (this.workersTab.pulse && isHTMLElement(badge)) {
				badge.classList.remove('pulse');
				void badge.offsetWidth;
				badge.classList.add('pulse');
			}
		}
	}

	private teardownChrome(): void {
		this.pinnedListeners.clear();
		this.tabsHost?.remove();
		this.tabsHost = undefined;
		this.workersTabEl = undefined;
	}
}
