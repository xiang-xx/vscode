/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { $, addDisposableListener, append, EventType, isHTMLElement, prepend } from '../../../../../base/browser/dom.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ViewContainerLocation } from '../../../../common/views.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../../services/panecomposite/browser/panecomposite.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ZCODE_INTERNAL_SUPERAGENT_PRESENT_WORKER, ZCODE_INTERNAL_SUPERAGENT_SHOW_ROUTER } from '../superAgent/superAgentCommands.js';
import { IChatRouterService, ISuperAgentWorkerHistoryEntry } from '../../common/superAgent/chatRouterService.js';

/** Extension viewsContainers id `zcode` → workbench container id. */
export const ZCODE_VIEW_CONTAINER_ID = 'workbench.view.extension.zcode';
export const ZCODE_CHAT_VIEW_ID = 'zcode.chatView';

/**
 * When AI Chat owns the auxiliary bar:
 * - hide the "AI Chat" title / composite-bar label
 * - render the passive Workers status chip on the left of the title row and
 *   the Home / History function buttons at the right end (next to the
 *   workbench title actions). The chip is not a switch; Home forces the
 *   Router timeline, History opens a lightweight dropdown to restore /
 *   delete / clear archived workers
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
	/** Right-end host for the Home / History function buttons. */
	private actionsHost: HTMLElement | undefined;
	/** Live history dropdown — lightweight replacement for the retired strip's history drawer. */
	private historyMenu: { panel: HTMLElement; disposables: IDisposable[] } | undefined;

	constructor(
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
		@IChatRouterService private readonly routerService: IChatRouterService,
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
		// Function buttons belong at the right end of the title row, right
		// before the workbench title actions (… / maximize / close) — not at
		// the far left.
		const actionsHost = $('div.zcode-title-tabs-host.zcode-chrome-actions-host');
		actionsHost.style.display = 'flex';
		actionsHost.style.alignItems = 'center';
		actionsHost.style.marginLeft = 'auto';
		const titleActions = title.querySelector(':scope > .title-actions');
		if (titleActions) {
			title.insertBefore(actionsHost, titleActions);
		} else {
			append(title, actionsHost);
		}
		this.actionsHost = actionsHost;
		this.mountTitleActions();
	}

	/**
	 * Home + History — the right-end function area of the title row. Home
	 * forces the Router main timeline back onto the surface; History opens a
	 * lightweight dropdown (restore / delete / clear archived workers) — the
	 * old full-width history drawer went away with the Workers strip.
	 */
	private mountTitleActions(): void {
		if (!this.actionsHost) {
			return;
		}
		const actions = append(this.actionsHost, $('div.zcode-chrome-actions'));

		const home = append(actions, $('button.zcode-chrome-action', {
			type: 'button',
			title: localize('superAgentHome', "首页"),
			'aria-label': localize('superAgentHome', "首页"),
		}));
		home.classList.add(...ThemeIcon.asClassNameArray(Codicon.home));
		this._register(addDisposableListener(home, EventType.CLICK, () => {
			void this.commandService.executeCommand(ZCODE_INTERNAL_SUPERAGENT_SHOW_ROUTER);
		}));

		const history = append(actions, $('button.zcode-chrome-action', {
			type: 'button',
			title: localize('workerHistory', "历史会话"),
			'aria-label': localize('workerHistory', "历史会话"),
		}));
		history.classList.add(...ThemeIcon.asClassNameArray(Codicon.history));
		this._register(addDisposableListener(history, EventType.CLICK, () => {
			this.showHistoryMenu(history);
		}));
	}

	/**
	 * Lightweight history dropdown anchored under the History button. Replaces
	 * the retired strip's history drawer: click a row to restore the worker
	 * (and jump straight to its session), ✕ to drop one entry, footer button
	 * to clear everything. The list is live — it re-renders from the router
	 * service's history observable, so restores/deletes reflect instantly.
	 */
	private showHistoryMenu(anchor: HTMLElement): void {
		this.hideHistoryMenu();

		const panel = $('div.zcode-history-menu');
		const style = panel.style;
		style.position = 'fixed';
		style.zIndex = '3000';
		style.minWidth = '300px';
		style.maxWidth = '420px';
		style.maxHeight = '60vh';
		style.display = 'flex';
		style.flexDirection = 'column';
		style.overflow = 'hidden';
		style.padding = '4px';
		style.borderRadius = '5px';
		style.color = 'var(--vscode-menu-foreground, var(--vscode-foreground))';
		style.background = 'var(--vscode-menu-background, var(--vscode-editorWidget-background, var(--vscode-editor-background)))';
		style.border = '1px solid var(--vscode-menu-border, var(--vscode-widget-border, var(--vscode-panel-border, transparent)))';
		style.boxShadow = '0 2px 10px var(--vscode-widget-shadow, rgba(0, 0, 0, .36))';

		const rect = anchor.getBoundingClientRect();
		style.top = `${Math.round(rect.bottom + 4)}px`;
		if (rect.left < 440) {
			style.left = '8px';
			style.right = 'auto';
		} else {
			style.left = 'auto';
			style.right = `${Math.round(mainWindow.innerWidth - rect.right)}px`;
		}

		const header = append(panel, $('div.zcode-history-menu-header'));
		header.textContent = localize('workerHistoryMenuTitle', "历史会话");
		header.style.padding = '6px 8px';
		header.style.fontWeight = '600';
		header.style.fontSize = '11px';
		header.style.textTransform = 'uppercase';
		header.style.color = 'var(--vscode-descriptionForeground)';

		const list = append(panel, $('div.zcode-history-menu-list'));
		list.style.overflowY = 'auto';
		list.style.display = 'flex';
		list.style.flexDirection = 'column';
		list.style.gap = '2px';
		list.style.padding = '2px';

		const disposables: IDisposable[] = [];
		disposables.push(autorun(reader => {
			this.renderHistoryList(list, this.routerService.history.read(reader));
		}));

		// Mount INSIDE the workbench element: every --vscode-* theme variable
		// (menu background/foreground, borders, shadows, description colors) is
		// defined on `.monaco-workbench`, so a body-level panel rendered with
		// every fallback unresolved — transparent background, missing colors.
		// position:fixed keeps viewport anchoring regardless of the parent.
		const auxContainer = this.layoutService.getContainer(mainWindow, Parts.AUXILIARYBAR_PART);
		const mountHost = (auxContainer?.closest('.monaco-workbench') as HTMLElement | null) ?? auxContainer ?? mainWindow.document.body;
		append(mountHost, panel);
		this.historyMenu = { panel, disposables };

		disposables.push(addDisposableListener(mainWindow.document, EventType.MOUSE_DOWN, (e: MouseEvent) => {
			const target = e.target;
			if (!(target instanceof Node) || !panel.contains(target)) {
				this.hideHistoryMenu();
			}
		}, true));
		disposables.push(addDisposableListener(mainWindow.document, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				this.hideHistoryMenu();
			}
		}, true));
		disposables.push(addDisposableListener(mainWindow, EventType.RESIZE, () => this.hideHistoryMenu()));
		// Clicks inside the chat surface live in a webview iframe and never
		// bubble to the capture listener above — but moving focus into an
		// iframe blurs this window, so use that as the close signal too.
		disposables.push(addDisposableListener(mainWindow, EventType.BLUR, () => this.hideHistoryMenu()));
	}

	private renderHistoryList(list: HTMLElement, entries: readonly ISuperAgentWorkerHistoryEntry[]): void {
		list.textContent = '';
		if (entries.length === 0) {
			const empty = append(list, $('div.zcode-history-menu-empty'));
			empty.textContent = localize('workerHistoryEmpty', "暂无历史会话");
			empty.style.padding = '12px 8px';
			empty.style.fontSize = '12px';
			empty.style.color = 'var(--vscode-descriptionForeground)';
			return;
		}
		for (const entry of entries) {
			const row = append(list, $('button.zcode-history-menu-row', { type: 'button' }));
			row.style.display = 'flex';
			row.style.alignItems = 'center';
			row.style.gap = '8px';
			row.style.width = '100%';
			row.style.padding = '6px 8px';
			row.style.border = 'none';
			row.style.borderRadius = '4px';
			row.style.background = 'transparent';
			row.style.color = 'inherit';
			row.style.font = 'inherit';
			row.style.fontSize = '12px';
			row.style.textAlign = 'left';
			row.style.cursor = 'pointer';
			const entryTitle = historyEntryTitle(entry);
			row.title = entryTitle;

			const label = append(row, $('span.zcode-history-menu-label'));
			label.textContent = entryTitle;
			label.style.flex = '1';
			label.style.overflow = 'hidden';
			label.style.textOverflow = 'ellipsis';
			label.style.whiteSpace = 'nowrap';

			const time = append(row, $('span.zcode-history-menu-time'));
			const ts = historyEntryTimestamp(entry);
			time.textContent = ts !== undefined ? formatHistoryTime(ts) : '';
			time.style.fontSize = '11px';
			time.style.color = 'var(--vscode-descriptionForeground)';
			time.style.flexShrink = '0';

			const del = append(row, $('span.zcode-history-menu-delete'));
			del.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
			del.title = localize('deleteHistoryEntryTitle', "删除该条历史");
			del.style.flexShrink = '0';
			del.style.fontSize = '13px';
			del.style.opacity = '0';
			del.style.color = 'var(--vscode-descriptionForeground)';
			del.addEventListener('mouseenter', () => del.style.color = 'var(--vscode-errorForeground)');
			del.addEventListener('mouseleave', () => del.style.color = 'var(--vscode-descriptionForeground)');

			row.addEventListener('mouseenter', () => {
				row.style.background = 'var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground))';
				del.style.opacity = '1';
			});
			row.addEventListener('mouseleave', () => {
				row.style.background = 'transparent';
				del.style.opacity = '0';
			});
			del.addEventListener('click', e => {
				e.stopPropagation();
				this.routerService.deleteHistoryEntry(entry.id);
			});
			row.addEventListener('click', () => {
				const restored = this.routerService.restoreWorker(entry.id);
				this.hideHistoryMenu();
				if (restored) {
					void this.commandService.executeCommand(ZCODE_INTERNAL_SUPERAGENT_PRESENT_WORKER, entry.id);
				}
			});
		}

		const clear = append(list, $('button.zcode-history-menu-clear', { type: 'button' }));
		clear.textContent = localize('clearAllHistoryTitle', "清空全部历史");
		clear.style.marginTop = '4px';
		clear.style.padding = '6px 8px';
		clear.style.border = 'none';
		clear.style.borderRadius = '4px';
		clear.style.background = 'transparent';
		clear.style.color = 'var(--vscode-descriptionForeground)';
		clear.style.font = 'inherit';
		clear.style.fontSize = '12px';
		clear.style.textAlign = 'center';
		clear.style.cursor = 'pointer';
		clear.addEventListener('mouseenter', () => {
			clear.style.background = 'var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground))';
			clear.style.color = 'var(--vscode-errorForeground)';
		});
		clear.addEventListener('mouseleave', () => {
			clear.style.background = 'transparent';
			clear.style.color = 'var(--vscode-descriptionForeground)';
		});
		clear.addEventListener('click', () => this.routerService.clearHistory());
	}

	private hideHistoryMenu(): void {
		if (!this.historyMenu) {
			return;
		}
		for (const d of this.historyMenu.disposables) {
			d.dispose();
		}
		this.historyMenu.panel.remove();
		this.historyMenu = undefined;
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
		this.hideHistoryMenu();
		this.tabsHost?.remove();
		this.tabsHost = undefined;
		this.actionsHost?.remove();
		this.actionsHost = undefined;
		this.workersTabEl = undefined;
	}
}

/** Tolerant display title: label first, id as last resort. */
function historyEntryTitle(entry: ISuperAgentWorkerHistoryEntry): string {
	return entry.label?.trim() ? entry.label.trim() : entry.id;
}

function historyEntryTimestamp(entry: ISuperAgentWorkerHistoryEntry): number | undefined {
	return entry.closedAt || entry.createdAt || undefined;
}

function formatHistoryTime(ms: number): string {
	const d = new Date(ms);
	const hh = String(d.getHours()).padStart(2, '0');
	const mm = String(d.getMinutes()).padStart(2, '0');
	return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}
