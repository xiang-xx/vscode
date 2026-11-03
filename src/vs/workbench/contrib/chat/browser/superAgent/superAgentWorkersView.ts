/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Action, IAction, Separator } from '../../../../../base/common/actions.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { autorun, observableValue } from '../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IChatRouterService, ISuperAgentWorkerHandle, ISuperAgentWorkerHistoryEntry, SuperAgentWorkerState, superAgentWorkerStateIsActive } from '../../common/superAgent/chatRouterService.js';
import { ISuperAgentPresentationQueue } from '../../common/superAgent/superAgentPresentationQueue.js';

interface IWorkerVisuals { readonly chipClass: string; readonly stateLabel: string }

function workerVisuals(state: SuperAgentWorkerState): IWorkerVisuals {
	switch (state) {
		case SuperAgentWorkerState.Queued: return { chipClass: 'st-muted', stateLabel: localize('state.queued', "排队中") };
		case SuperAgentWorkerState.Starting: return { chipClass: 'st-starting', stateLabel: localize('state.starting', "启动中") };
		case SuperAgentWorkerState.Running: return { chipClass: 'st-running', stateLabel: localize('state.running', "进行中") };
		case SuperAgentWorkerState.AwaitingUser: return { chipClass: 'st-attention', stateLabel: localize('state.awaitingUser', "需要你输入") };
		case SuperAgentWorkerState.Idle: return { chipClass: 'st-muted', stateLabel: localize('state.idle', "空闲") };
		case SuperAgentWorkerState.WatchdogTripped: return { chipClass: 'st-error', stateLabel: localize('state.stalled', "疑似卡死") };
		case SuperAgentWorkerState.Completed: return { chipClass: 'st-done', stateLabel: localize('state.completed', "已完成") };
		case SuperAgentWorkerState.Failed: return { chipClass: 'st-error', stateLabel: localize('state.failed', "失败") };
		case SuperAgentWorkerState.Cancelled: return { chipClass: 'st-muted', stateLabel: localize('state.cancelled', "已取消") };
	}
}

function needsAttention(worker: ISuperAgentWorkerHandle): boolean {
	const state = worker.state.get();
	return state === SuperAgentWorkerState.AwaitingUser || state === SuperAgentWorkerState.WatchdogTripped;
}

/** Idle + terminal rows can leave the live list and land in history. */
function canArchiveWorker(state: SuperAgentWorkerState): boolean {
	return state === SuperAgentWorkerState.Idle
		|| state === SuperAgentWorkerState.Completed
		|| state === SuperAgentWorkerState.Failed
		|| state === SuperAgentWorkerState.Cancelled;
}

/** Fixed row height used for content-hugging strip sizing (2-column grid). */
const CELL_HEIGHT = 28;
const EMPTY_HEIGHT = 48;
/** Columns of the fixed bottom strip — matches the stylesheet's grid default. */
const GRID_COLUMNS = 2;

/**
 * The Workers hub — a fixed bottom strip with a 2-column grid of compact
 * worker cells. Design rules:
 *
 * - **Always open.** No expand/collapse; the strip hugs content height.
 * - **Two columns.** Fixed by the stylesheet; rows re-flow as workers come and go.
 * - **Status = dot + text.** No pill/chip chrome.
 * - **Focused highlights in place.** Selection lives on the cell; no dock bar.
 */
export class SuperAgentWorkersPanel extends Disposable {

	private summaryEl: HTMLElement | undefined;
	private gridEl: HTMLElement | undefined;
	private readonly summaryListeners = this._register(new DisposableStore());
	private readonly gridListeners = this._register(new DisposableStore());

	private _historyMode = false;
	private lastDesiredHeight = EMPTY_HEIGHT;

	private readonly _renderSignal = observableValue<number>(this, 0);

	private readonly _onDidFocusWorker = this._register(new Emitter<ISuperAgentWorkerHandle>());
	readonly onDidFocusWorker: Event<ISuperAgentWorkerHandle> = this._onDidFocusWorker.event;

	private readonly _onDidChangeContent = this._register(new Emitter<void>());
	/** Fired after every re-render; the host uses it to re-hug the strip height. */
	readonly onDidChangeContent: Event<void> = this._onDidChangeContent.event;

	private readonly _onDidChangeHistoryMode = this._register(new Emitter<boolean>());
	readonly onDidChangeHistoryMode: Event<boolean> = this._onDidChangeHistoryMode.event;

	get historyMode(): boolean {
		return this._historyMode;
	}

	constructor(
		@IChatRouterService private readonly routerService: IChatRouterService,
		@ISuperAgentPresentationQueue private readonly presentationQueue: ISuperAgentPresentationQueue,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
	) {
		super();
	}

	/**
	 * @param options.summaryHost When set (strip header), summary chips render
	 * there instead of above the grid.
	 */
	render(container: HTMLElement, options?: { summaryHost?: HTMLElement }): void {
		this.summaryEl = options?.summaryHost ?? dom.append(container, dom.$('.super-agent-rail-summary'));
		this.summaryEl.classList.add('super-agent-rail-summary');
		this.gridEl = dom.append(container, dom.$('.super-agent-rail'));

		this._register(autorun(reader => {
			this._renderSignal.read(reader);
			const workers = this.routerService.workers.read(reader);
			const history = this.routerService.history.read(reader);
			for (const worker of workers) {
				worker.state.read(reader);
				worker.lastActivityAt.read(reader);
				worker.queuedInputs.read(reader);
				worker.isFocused.read(reader);
			}
			this.renderGrid(workers, history);
		}));
	}

	setHistoryMode(enabled: boolean): void {
		if (this._historyMode === enabled) {
			return;
		}
		this._historyMode = enabled;
		this.gridEl?.classList.toggle('history-mode', enabled);
		this._onDidChangeHistoryMode.fire(enabled);
		this._renderSignal.set(Date.now(), undefined);
	}

	toggleHistoryMode(): void {
		this.setHistoryMode(!this._historyMode);
	}

	layout(_height: number, width: number): void {
		if (this.gridEl) {
			this.gridEl.style.width = `${Math.max(0, width)}px`;
		}
	}

	focus(): void {
		this.gridEl?.focus();
	}

	/** Content-hugging grid height (summary is in the page header). */
	getDesiredHeight(): number {
		return this.lastDesiredHeight;
	}

	private renderGrid(workers: readonly ISuperAgentWorkerHandle[], history: readonly ISuperAgentWorkerHistoryEntry[]): void {
		if (!this.gridEl || !this.summaryEl) {
			return;
		}

		this.gridListeners.clear();
		dom.clearNode(this.gridEl);

		if (this._historyMode) {
			this.renderHistoryGrid(history);
			return;
		}

		const bySlot = (a: ISuperAgentWorkerHandle, b: ISuperAgentWorkerHandle): number => a.slot - b.slot;
		// Keep grid order stable by slot so status changes don't reshuffle positions.
		const ordered = workers.slice().sort(bySlot);
		const attention = workers.filter(w => needsAttention(w));
		const running = workers.filter(w => {
			const s = w.state.get();
			return s === SuperAgentWorkerState.Starting || s === SuperAgentWorkerState.Running;
		});
		const completed = workers.filter(w => w.state.get() === SuperAgentWorkerState.Completed);
		const idle = workers.filter(w => w.state.get() === SuperAgentWorkerState.Idle);
		const queued = workers.filter(w => w.state.get() === SuperAgentWorkerState.Queued);

		if (ordered.length === 0) {
			this.renderEmpty(false);
		} else {
			for (const worker of ordered) {
				this.mountWorkerCell(worker, needsAttention(worker));
			}
		}

		this.summaryListeners.clear();
		dom.clearNode(this.summaryEl);
		if (workers.length > 0) {
			if (attention.length > 0) {
				const el = dom.append(this.summaryEl, dom.$('span.attention'));
				el.textContent = localize('summary.attention', "⚠ {0} 个需要你", attention.length);
			}
			if (running.length > 0) {
				const el = dom.append(this.summaryEl, dom.$('span.slots'));
				el.textContent = localize('summary.running', "{0} 运行中", running.length);
			}
			if (completed.length > 0) {
				const el = dom.append(this.summaryEl, dom.$('span.done'));
				el.textContent = localize('summary.completed', "{0} 已完成", completed.length);
			}
			if (idle.length > 0) {
				const el = dom.append(this.summaryEl, dom.$('span.idle'));
				el.textContent = localize('summary.idle', "{0} 空闲", idle.length);
			}
			if (queued.length > 0) {
				const el = dom.append(this.summaryEl, dom.$('span.queued'));
				el.textContent = localize('summary.queued', "◷ {0} 排队", queued.length);
			}
			if (history.length > 0) {
				const el = dom.append(this.summaryEl, dom.$('span.history'));
				el.textContent = localize('summary.history', "历史 {0}", history.length);
			}
		}

		const rows = ordered.length === 0 ? 1 : Math.ceil(ordered.length / GRID_COLUMNS);
		this.lastDesiredHeight = ordered.length === 0 ? EMPTY_HEIGHT : rows * CELL_HEIGHT;
		this._onDidChangeContent.fire();
	}

	private renderHistoryGrid(history: readonly ISuperAgentWorkerHistoryEntry[]): void {
		if (!this.gridEl || !this.summaryEl) {
			return;
		}
		if (history.length === 0) {
			this.renderEmpty(true);
		} else {
			for (const entry of history) {
				this.mountHistoryCell(entry);
			}
		}

		this.summaryListeners.clear();
		dom.clearNode(this.summaryEl);
		const title = dom.append(this.summaryEl, dom.$('span.slots'));
		title.textContent = localize('summary.historyMode', "已关闭的 Worker · {0}", history.length);
		if (history.length > 0) {
			const clear = dom.append(this.summaryEl, dom.$<HTMLButtonElement>('button.rail-btn', { type: 'button' }));
			clear.textContent = localize('btn.clearHistory', "清空");
			clear.style.marginLeft = 'auto';
			this.summaryListeners.add(dom.addDisposableListener(clear, dom.EventType.CLICK, () => {
				this.routerService.clearHistory();
			}));
		}

		const rows = history.length === 0 ? 1 : Math.ceil(history.length / GRID_COLUMNS);
		this.lastDesiredHeight = history.length === 0 ? EMPTY_HEIGHT : rows * CELL_HEIGHT;
		this._onDidChangeContent.fire();
	}

	private renderEmpty(history: boolean): void {
		if (!this.gridEl) {
			return;
		}
		const root = dom.append(this.gridEl, dom.$('.rail-empty'));
		const line1 = dom.append(root, dom.$('.line1'));
		const line2 = dom.append(root, dom.$('.line2'));
		if (history) {
			line1.textContent = localize('empty.historyTitle', "还没有关闭的 Worker");
			line2.textContent = localize('empty.historyHint', "从列表移除的任务会出现在这里，可随时恢复");
		} else {
			line1.textContent = localize('empty.title', "还没有在跑的任务");
			line2.textContent = localize('empty.hint', "在上方输入框向 Router 描述任务,回车即派发");
		}
	}

	private mountWorkerCell(worker: ISuperAgentWorkerHandle, attention: boolean): void {
		if (!this.gridEl) {
			return;
		}
		const state = worker.state.get();
		const visuals = workerVisuals(state);

		const root = dom.append(this.gridEl, dom.$('.super-agent-worker-row'));
		root.classList.toggle('attention', attention);
		root.classList.toggle('focused', worker.isFocused.get());
		root.title = localize('workerTooltip', "{0} — {1}", worker.label, visuals.stateLabel);
		root.tabIndex = 0;

		const label = dom.append(root, dom.$('.worker-label'));
		label.textContent = worker.label;

		const tail = dom.append(root, dom.$('.row-tail'));

		const stateEl = dom.append(tail, dom.$('.state-text'));
		stateEl.classList.add(visuals.chipClass);
		dom.append(stateEl, dom.$('.chip-dot'));
		const chipText = dom.append(stateEl, dom.$('span.chip-text'));
		chipText.textContent = visuals.stateLabel;

		const queued = worker.queuedInputs.get().length;
		if (queued > 0) {
			const queuedChip = dom.append(tail, dom.$('.queued-chip'));
			queuedChip.textContent = localize('queuedChip', "+{0}", queued);
		}

		// Inline decision only when the user must act — keeps dense cells calm.
		if (state === SuperAgentWorkerState.AwaitingUser) {
			this.mountActionBtn(tail, localize('btn.answer', "去回答"), true, () => this.focusWorkerElement(worker));
		} else if (state === SuperAgentWorkerState.WatchdogTripped) {
			this.mountActionBtn(tail, localize('btn.inspect', "查看"), true, () => this.focusWorkerElement(worker));
			this.mountActionBtn(tail, localize('btn.kill', "终止"), false, () => this.routerService.cancelWorker(worker.id, 'cancelled from workers hub'));
		} else if (state === SuperAgentWorkerState.Queued) {
			this.mountActionBtn(tail, localize('btn.cancelQueued', "取消"), false, () => this.routerService.cancelWorker(worker.id, 'cancelled from workers hub'));
		}

		// Always reserve the close slot so Running rows stay aligned with Idle/Completed.
		const closeBtn = dom.append(tail, dom.$<HTMLButtonElement>('button.rail-close', {
			type: 'button',
		}));
		closeBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
		if (canArchiveWorker(state)) {
			closeBtn.title = localize('btn.closeArchive', "关闭并归档到历史");
			closeBtn.setAttribute('aria-label', localize('btn.closeArchive', "关闭并归档到历史"));
			this.gridListeners.add(dom.addDisposableListener(closeBtn, dom.EventType.CLICK, e => {
				e.stopPropagation();
				this.routerService.removeWorker(worker.id);
			}));
			this.gridListeners.add(dom.addDisposableListener(closeBtn, dom.EventType.POINTER_DOWN, e => e.stopPropagation()));
		} else {
			// Active/stuck rows (Queued/Starting/Running/AwaitingUser/WatchdogTripped):
			// force-delete the roster entry outright — the escape hatch for stale
			// workers whose chat session is already gone (dirty data).
			closeBtn.title = localize('btn.forceRemove', "强制删除该 Worker（不进历史）");
			closeBtn.setAttribute('aria-label', localize('btn.forceRemove', "强制删除该 Worker（不进历史）"));
			this.gridListeners.add(dom.addDisposableListener(closeBtn, dom.EventType.CLICK, e => {
				e.stopPropagation();
				this.routerService.forceRemoveWorker(worker.id);
			}));
			this.gridListeners.add(dom.addDisposableListener(closeBtn, dom.EventType.POINTER_DOWN, e => e.stopPropagation()));
		}

		this.gridListeners.add(dom.addDisposableListener(root, dom.EventType.CLICK, () => this.focusWorkerElement(worker)));
		this.gridListeners.add(dom.addDisposableListener(root, dom.EventType.CONTEXT_MENU, e => {
			e.preventDefault();
			e.stopPropagation();
			this.showWorkerContextMenu(worker, { x: e.clientX, y: e.clientY });
		}));
		this.gridListeners.add(dom.addDisposableListener(root, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this.focusWorkerElement(worker);
			}
		}));
	}

	private mountHistoryCell(entry: ISuperAgentWorkerHistoryEntry): void {
		if (!this.gridEl) {
			return;
		}
		const visuals = workerVisuals(entry.finalState);

		const root = dom.append(this.gridEl, dom.$('.super-agent-worker-row.history'));
		root.title = localize('historyTooltip', "{0} — 已关闭，可恢复", entry.label);
		root.tabIndex = 0;

		const label = dom.append(root, dom.$('.worker-label'));
		label.textContent = entry.label;

		const tail = dom.append(root, dom.$('.row-tail'));
		const stateEl = dom.append(tail, dom.$('.state-text'));
		stateEl.classList.add(visuals.chipClass);
		dom.append(stateEl, dom.$('.chip-dot'));
		const chipText = dom.append(stateEl, dom.$('span.chip-text'));
		chipText.textContent = visuals.stateLabel;

		this.mountActionBtn(tail, localize('btn.restore', "恢复"), true, () => this.restoreHistoryEntry(entry));
		this.mountActionBtn(tail, localize('btn.forget', "删除"), false, () => this.routerService.deleteHistoryEntry(entry.id));

		this.gridListeners.add(dom.addDisposableListener(root, dom.EventType.CLICK, () => this.restoreHistoryEntry(entry)));
		this.gridListeners.add(dom.addDisposableListener(root, dom.EventType.CONTEXT_MENU, e => {
			e.preventDefault();
			e.stopPropagation();
			this.showHistoryContextMenu(entry, { x: e.clientX, y: e.clientY });
		}));
	}

	private mountActionBtn(parent: HTMLElement, text: string, primary: boolean, action: () => void): void {
		const btn = dom.append(parent, dom.$<HTMLButtonElement>(`button.rail-btn${primary ? '.primary' : ''}`, { type: 'button' }));
		btn.textContent = text;
		this.gridListeners.add(dom.addDisposableListener(btn, dom.EventType.CLICK, e => {
			e.stopPropagation();
			action();
		}));
		this.gridListeners.add(dom.addDisposableListener(btn, dom.EventType.POINTER_DOWN, e => e.stopPropagation()));
	}

	focusWorkerElement(worker: ISuperAgentWorkerHandle): void {
		// Force-present: an explicit click means the user wants this worker now.
		this.presentationQueue.present(worker.id, { force: true });
		this._onDidFocusWorker.fire(worker);
	}

	private restoreHistoryEntry(entry: ISuperAgentWorkerHistoryEntry): void {
		const worker = this.routerService.restoreWorker(entry.id);
		if (!worker) {
			return;
		}
		this.setHistoryMode(false);
		this.focusWorkerElement(worker);
	}

	private showWorkerContextMenu(worker: ISuperAgentWorkerHandle, anchor: { x: number; y: number }): void {
		const state = worker.state.get();
		const isActive = superAgentWorkerStateIsActive(state);
		const canArchive = canArchiveWorker(state);
		const actions: IAction[] = [
			new Action('superAgent.focus', localize('action.focus', "在本页查看该 Worker"), undefined, true, () => { this.focusWorkerElement(worker); return Promise.resolve(); }),
			new Action('superAgent.interrupt', localize('action.interrupt', "打断当前回合"), undefined, isActive && state !== SuperAgentWorkerState.AwaitingUser && state !== SuperAgentWorkerState.Idle, () => { this.routerService.interrupt(worker.id, 'interrupted from workers hub'); return Promise.resolve(); }),
			new Separator(),
			new Action('superAgent.cancel', localize('action.cancel', "取消任务"), undefined, isActive && !canArchive, () => { this.routerService.cancelWorker(worker.id, 'cancelled from workers hub'); return Promise.resolve(); }),
			new Action('superAgent.remove', localize('action.remove', "关闭并归档到历史"), undefined, canArchive, () => { this.routerService.removeWorker(worker.id); return Promise.resolve(); }),
			new Action('superAgent.forceRemove', localize('action.forceRemove', "强制删除（不进历史）"), undefined, true, () => { this.routerService.forceRemoveWorker(worker.id); return Promise.resolve(); }),
		];
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
		});
	}

	private showHistoryContextMenu(entry: ISuperAgentWorkerHistoryEntry, anchor: { x: number; y: number }): void {
		const actions: IAction[] = [
			new Action('superAgent.restore', localize('action.restore', "恢复到 Workers 列表"), undefined, true, () => { this.restoreHistoryEntry(entry); return Promise.resolve(); }),
			new Action('superAgent.forget', localize('action.forget', "从历史删除"), undefined, true, () => { this.routerService.deleteHistoryEntry(entry.id); return Promise.resolve(); }),
		];
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
		});
	}
}
