/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { $, append, isHTMLElement, prepend } from '../../../../../base/browser/dom.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
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
 * - render the passive Workers status chip (session tabs / New Chat /
 *   History drawer entry points are retired — everything lives in the
 *   Router + Workers page, which is the chat surface itself and opens
 *   automatically, so the chip is not a switch and has no click behavior)
 * - keep workbench title-actions (… / maximize / close) on the right
 */
export class ZCodeAuxiliaryBarChrome extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.zcodeAuxiliaryBarChrome';

	private tabsHost: HTMLElement | undefined;
	/**
	 * Passive Workers status chip — the only title-row chat chrome.
	 * The page itself (a layer above the chat webview) is owned by
	 * `SuperAgentChatPageContribution`; this chrome only renders the chip and
	 * reflects state pushed via `zcode.internal.setSuperAgentWorkersTab`:
	 * no number bubble (per-state counts live in the strip header), just an
	 * attention dot while some worker awaits the user.
	 */
	private workersTabEl: HTMLElement | undefined;
	private workersTab: { active: boolean; badge: number; attention: boolean; routerSession?: string; pulse?: boolean } = { active: false, badge: 0, attention: false };

	constructor(
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
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
	 * The Workers status chip. It lives alone in the title host — no session
	 * tab strip, no New Chat / History chrome actions. It is *not* a button:
	 * the Workers page is the single chat surface and opens on its own, so a
	 * toggle here would only hide the page until the next worker event yanks
	 * it back. The chip just labels the area and flags attention.
	 */
	private mountWorkersTab(): void {
		if (!this.tabsHost) {
			return;
		}
		const chip = append(this.tabsHost, $('span.zcode-session-tab.zcode-tab-pinned'));
		chip.setAttribute('role', 'status');
		chip.title = 'Workers';

		const icon = append(chip, $('span.zcode-tab-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.layers));

		const label = append(chip, $('span.zcode-tab-title'));
		label.textContent = 'Workers';

		append(chip, $('span.zcode-tab-attention'));

		this.workersTabEl = chip;
		this.updateWorkersTab();
	}

	private updateWorkersTab(): void {
		const chip = this.workersTabEl;
		if (!chip) {
			return;
		}
		chip.classList.toggle('active', this.workersTab.active);
		const running = this.workersTab.badge;
		chip.title = this.workersTab.attention
			? (running > 0 ? `Workers — ${running} 个任务进行中，有任务需要你处理` : 'Workers — 有任务需要你处理')
			: (running > 0 ? `Workers — ${running} 个任务进行中` : 'Workers');
		const dot = chip.querySelector('.zcode-tab-attention');
		if (dot) {
			dot.classList.toggle('hidden', !this.workersTab.attention);
			// One-shot pulse when attention appears: retrigger via reflow.
			if (this.workersTab.pulse && isHTMLElement(dot)) {
				dot.classList.remove('pulse');
				void dot.offsetWidth;
				dot.classList.add('pulse');
			}
		}
	}

	private teardownChrome(): void {
		this.tabsHost?.remove();
		this.tabsHost = undefined;
		this.workersTabEl = undefined;
	}
}
