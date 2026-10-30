/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { $, addDisposableListener, append, clearNode, prepend } from '../../../../../base/browser/dom.js';
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

export interface ZCodeTitleTab {
	id: string;
	title: string;
	active?: boolean;
	running?: boolean;
	done?: boolean;
}

/**
 * When AI Chat owns the auxiliary bar:
 * - hide the "AI Chat" title / composite-bar label
 * - render session tabs on the left of the title row
 * - render New Chat (+) and History in the title row (reliable; not ViewTitle-dependent)
 * - keep workbench title-actions (… / maximize / close) on the right
 */
export class ZCodeAuxiliaryBarChrome extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.zcodeAuxiliaryBarChrome';

	private tabsHost: HTMLElement | undefined;
	private tabsList: HTMLElement | undefined;
	private chromeActions: HTMLElement | undefined;
	private tabs: ZCodeTitleTab[] = [];
	private readonly tabListeners = this._register(new DisposableStore());
	private readonly actionListeners = this._register(new DisposableStore());
	private openingSessionId: string | undefined;

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
		this._register(CommandsRegistry.registerCommand('zcode.internal.setTitleTabs', (_accessor, tabs: unknown) => {
			this.tabs = Array.isArray(tabs) ? tabs as ZCodeTitleTab[] : [];
			this.renderTabs();
		}));
		this.update();
	}

	private update(): void {
		const active = this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar);
		const isZcode = active?.getId() === ZCODE_VIEW_CONTAINER_ID;
		const container = this.layoutService.getContainer(mainWindow, Parts.AUXILIARYBAR_PART);
		container?.classList.toggle('zcode-chat-active', !!isZcode);
		if (isZcode) {
			this.ensureChrome();
			this.renderTabs();
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

		this.tabsList = append(this.tabsHost, $('div.zcode-session-tabs'));
		this.tabsList.setAttribute('role', 'tablist');
		this.tabsList.setAttribute('aria-label', 'Recent chats');

		this.chromeActions = append(this.tabsHost, $('div.zcode-chrome-actions'));
		this.renderChromeActions();
	}

	private renderChromeActions(): void {
		if (!this.chromeActions) {
			return;
		}
		this.actionListeners.clear();
		clearNode(this.chromeActions);

		const newChat = append(this.chromeActions, $<HTMLButtonElement>('button.zcode-chrome-action', {
			type: 'button',
			title: 'New Chat',
			'aria-label': 'New Chat',
		}));
		newChat.classList.add(...ThemeIcon.asClassNameArray(Codicon.plus));
		this.bindActionClick(newChat, () => {
			void this.commandService.executeCommand('zcode.newChat');
		});

		const history = append(this.chromeActions, $<HTMLButtonElement>('button.zcode-chrome-action', {
			type: 'button',
			title: 'Chat History',
			'aria-label': 'Chat History',
		}));
		history.classList.add(...ThemeIcon.asClassNameArray(Codicon.history));
		this.bindActionClick(history, () => {
			void this.commandService.executeCommand('zcode.toggleHistory');
		});
	}

	private bindActionClick(el: HTMLElement, run: () => void): void {
		const stop = (e: Event) => {
			e.preventDefault();
			e.stopPropagation();
			(e as { stopImmediatePropagation?: () => void }).stopImmediatePropagation?.();
		};
		let lastPointerRunAt = 0;
		this.actionListeners.add(addDisposableListener(el, 'pointerdown', e => {
			if ((e as PointerEvent).button !== 0) {
				return;
			}
			stop(e);
			lastPointerRunAt = Date.now();
			run();
		}));
		// Fallback for environments without reliable pointer events. The click that
		// follows our own pointerdown must NOT run again, or toggles fire twice
		// (history drawer opens on press and hides on release).
		this.actionListeners.add(addDisposableListener(el, 'click', e => {
			stop(e);
			if (Date.now() - lastPointerRunAt < 800) {
				return;
			}
			run();
		}));
	}

	private teardownChrome(): void {
		this.tabListeners.clear();
		this.actionListeners.clear();
		this.tabsHost?.remove();
		this.tabsHost = undefined;
		this.tabsList = undefined;
		this.chromeActions = undefined;
	}

	private renderTabs(): void {
		this.ensureChrome();
		if (!this.tabsList) {
			return;
		}

		const nextIds = this.tabs.map(t => t.id).join('\0');
		const prevIds = [...this.tabsList.querySelectorAll('.zcode-session-tab')]
			.map(el => el.getAttribute('data-session-id') ?? '')
			.join('\0');

		// Same set of tabs: update in place so a mid-click rebuild cannot swallow the click.
		if (nextIds === prevIds && this.tabsList.childElementCount === this.tabs.length) {
			this.patchTabsInPlace();
			return;
		}

		this.tabListeners.clear();
		clearNode(this.tabsList);

		for (const tab of this.tabs) {
			this.mountTab(tab);
		}

		const activeEl = this.tabsList.querySelector('.zcode-session-tab.active') as HTMLElement | null;
		activeEl?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}

	private patchTabsInPlace(): void {
		if (!this.tabsList) {
			return;
		}
		const buttons = [...this.tabsList.querySelectorAll('.zcode-session-tab')] as HTMLButtonElement[];
		for (let i = 0; i < this.tabs.length; i++) {
			const tab = this.tabs[i]!;
			const btn = buttons[i];
			if (!btn) {
				continue;
			}
			btn.classList.toggle('active', !!tab.active);
			btn.setAttribute('aria-selected', tab.active ? 'true' : 'false');
			btn.title = tab.title || '新对话';

			let mark = btn.querySelector('.zcode-tab-mark') as HTMLElement | null;
			if (tab.running || tab.done) {
				if (!mark) {
					mark = document.createElement('span');
					mark.className = 'zcode-tab-mark';
					btn.insertBefore(mark, btn.firstChild);
				}
				mark.classList.toggle('running', !!tab.running);
				mark.classList.toggle('done', !!tab.done && !tab.running);
				mark.title = tab.running ? '正在运行' : '已完成';
			} else if (mark) {
				mark.remove();
			}

			const title = btn.querySelector('.zcode-tab-title');
			if (title) {
				title.textContent = tab.title || '新对话';
			}
		}
	}

	private mountTab(tab: ZCodeTitleTab): void {
		if (!this.tabsList) {
			return;
		}
		const btn = append(this.tabsList, $<HTMLButtonElement>('button.zcode-session-tab', { type: 'button' }));
		btn.setAttribute('role', 'tab');
		btn.setAttribute('data-session-id', tab.id);
		btn.setAttribute('aria-selected', tab.active ? 'true' : 'false');
		btn.title = tab.title || '新对话';
		btn.classList.toggle('active', !!tab.active);

		if (tab.running || tab.done) {
			const mark = append(btn, $('span.zcode-tab-mark'));
			mark.classList.add(tab.running ? 'running' : 'done');
			mark.title = tab.running ? '正在运行' : '已完成';
		}

		const title = append(btn, $('span.zcode-tab-title'));
		title.textContent = tab.title || '新对话';

		const close = append(btn, $('span.zcode-tab-close'));
		close.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
		close.setAttribute('role', 'button');
		close.setAttribute('aria-label', '关闭');
		close.title = '关闭';

		const activate = (e: Event) => {
			e.preventDefault();
			e.stopPropagation();
			(e as { stopImmediatePropagation?: () => void }).stopImmediatePropagation?.();
			if (this.openingSessionId === tab.id) {
				return;
			}
			this.openingSessionId = tab.id;
			// Optimistic active state so the UI responds on the first press.
			for (const el of this.tabsList?.querySelectorAll('.zcode-session-tab') ?? []) {
				const active = el.getAttribute('data-session-id') === tab.id;
				el.classList.toggle('active', active);
				el.setAttribute('aria-selected', active ? 'true' : 'false');
			}
			// openSession already clears the done badge; avoid an extra pushState
			// that would rebuild tabs mid-press.
			void (async () => {
				try {
					await this.commandService.executeCommand('zcode.openSession', tab.id);
				} finally {
					if (this.openingSessionId === tab.id) {
						this.openingSessionId = undefined;
					}
				}
			})();
		};

		// pointerdown fires before focus/click quirks in the title bar; primary button only.
		this.tabListeners.add(addDisposableListener(btn, 'pointerdown', e => {
			if (e.button !== 0) {
				return;
			}
			if ((e.target as HTMLElement | null)?.closest?.('.zcode-tab-close')) {
				return;
			}
			activate(e);
		}));
		let closePointerAt = 0;
		const closeTab = () => {
			void this.commandService.executeCommand('zcode.closeTab', tab.id);
		};
		this.tabListeners.add(addDisposableListener(close, 'pointerdown', e => {
			if (e.button !== 0) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			(e as { stopImmediatePropagation?: () => void }).stopImmediatePropagation?.();
			closePointerAt = Date.now();
			closeTab();
		}));
		// Click is normally a no-op stopper (pointerdown already ran); it doubles
		// as the close fallback where pointer events are unavailable.
		this.tabListeners.add(addDisposableListener(btn, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			const onClose = !!(e.target as HTMLElement | null)?.closest?.('.zcode-tab-close');
			if (onClose && Date.now() - closePointerAt >= 800) {
				closeTab();
			}
		}));
	}
}
