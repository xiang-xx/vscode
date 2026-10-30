/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Extension-callable bridge onto Playwright browser tools.
 * Used by zcode-chat (ZCode harness + Cursor MCP) so both brains drive the
 * integrated BrowserView — open/read/click/type/screenshot/navigate.
 */

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { getAgentBrowserViewCreationDefaults } from '../../../../../platform/browserView/common/browserView.js';
import { IPlaywrightService } from '../../../../../platform/browserView/common/playwrightService.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { registerWorkbenchContribution2, WorkbenchPhase, type IWorkbenchContribution } from '../../../../common/contributions.js';
import { BrowserViewSharingState, IBrowserViewWorkbenchService } from '../../common/browserView.js';
import { BrowserEditorInput } from '../../common/browserEditorInput.js';
import { playwrightInvokeRaw } from './browserToolHelpers.js';

export const BROWSER_AGENT_BRIDGE_COMMAND = 'workbench.action.browser.agent';

/** Stable Playwright session used by ZCode / Cursor IDE bridge (not VS Code Chat). */
export const ZCODE_BROWSER_AGENT_SESSION = 'zcode-ide-browser';

export type BrowserAgentAction =
	| 'open'
	| 'list'
	| 'read'
	| 'navigate'
	| 'reload'
	| 'back'
	| 'forward'
	| 'click'
	| 'type'
	| 'hover'
	| 'screenshot';

export interface BrowserAgentRequest {
	action: BrowserAgentAction;
	sessionId?: string;
	url?: string;
	pageId?: string;
	forceNew?: boolean;
	ref?: string;
	selector?: string;
	element?: string;
	text?: string;
	key?: string;
	submit?: boolean;
	dblClick?: boolean;
	button?: 'left' | 'right' | 'middle';
	fullPage?: boolean;
}

export interface BrowserAgentResponse {
	ok: boolean;
	content: string;
	pageId?: string;
	error?: string;
}

const OPEN_READY_TIMEOUT_MS = 8_000;

class BrowserAgentBridgeContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'browserView.agentBridge';

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this._register(CommandsRegistry.registerCommand(BROWSER_AGENT_BRIDGE_COMMAND, async (_accessor, raw?: BrowserAgentRequest) => {
			return this.instantiationService.invokeFunction(accessor => runBrowserAgentAction(accessor, raw));
		}));
	}
}

registerWorkbenchContribution2(BrowserAgentBridgeContribution.ID, BrowserAgentBridgeContribution, WorkbenchPhase.AfterRestored);

async function runBrowserAgentAction(accessor: ServicesAccessor, raw?: BrowserAgentRequest): Promise<BrowserAgentResponse> {
	if (!raw || typeof raw !== 'object' || !raw.action) {
		return { ok: false, content: '', error: 'Missing action' };
	}

	const playwright = accessor.get(IPlaywrightService);
	const browserViews = accessor.get(IBrowserViewWorkbenchService);
	const editorService = accessor.get(IEditorService);
	const environment = accessor.get(IWorkbenchEnvironmentService);
	const sessionId = (typeof raw.sessionId === 'string' && raw.sessionId.trim())
		? raw.sessionId.trim()
		: ZCODE_BROWSER_AGENT_SESSION;

	try {
		switch (raw.action) {
			case 'open':
				return await openPage(browserViews, playwright, environment, sessionId, raw);
			case 'list':
				return listPages(browserViews, editorService);
			case 'read':
				return await readPage(playwright, sessionId, raw.pageId);
			case 'navigate':
			case 'reload':
			case 'back':
			case 'forward':
				return await navigatePage(playwright, sessionId, raw);
			case 'click':
				return await clickPage(playwright, sessionId, raw);
			case 'type':
				return await typePage(playwright, sessionId, raw);
			case 'hover':
				return await hoverPage(playwright, sessionId, raw);
			case 'screenshot':
				return await screenshotPage(playwright, sessionId, raw);
			default:
				return { ok: false, content: '', error: `Unknown action: ${(raw as BrowserAgentRequest).action}` };
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, content: '', error: message };
	}
}

async function openPage(
	browserViews: IBrowserViewWorkbenchService,
	playwright: IPlaywrightService,
	environment: IWorkbenchEnvironmentService,
	sessionId: string,
	raw: BrowserAgentRequest,
): Promise<BrowserAgentResponse> {
	const url = typeof raw.url === 'string' ? raw.url.trim() : '';
	if (!url) {
		return { ok: false, content: '', error: 'url is required' };
	}
	let href: string;
	try {
		href = new URL(url).href;
	} catch {
		return { ok: false, content: '', error: `Invalid URL: ${url}` };
	}

	if (!raw.forceNew) {
		const candidates = [...browserViews.getContextualBrowserViews().values()]
			.filter(e => e.model?.sharingState === BrowserViewSharingState.Shared
				|| e.model?.sharingState === BrowserViewSharingState.Available);
		const match = candidates.find(e => {
			try {
				return !!e.url && new URL(e.url).host === new URL(href).host;
			} catch {
				return false;
			}
		});
		if (match) {
			await ensureShared(match);
			await playwrightInvokeRaw(playwright, sessionId, match.id, (page, target) => page.goto(target, { waitUntil: 'domcontentloaded' }), href);
			const summary = await playwright.getSummary(sessionId, match.id) ?? '(no summary)';
			return {
				ok: true,
				pageId: match.id,
				content: `Reused page ${match.id}\nURL: ${href}\n\n${summary}`,
			};
		}
	}

	const affinity = environment.isSessionsWindow ? sessionId : undefined;
	const input = await browserViews.createBrowserView({
		...getAgentBrowserViewCreationDefaults(sessionId, affinity, browserViews.resolveNetwork({ type: 'agent', sessionId })),
		initialUrl: href,
		openSource: 'cdpCreated',
	}, { preserveFocus: true });

	const summary = await playwright.waitForPageAndGetSummary(sessionId, input.id, href, OPEN_READY_TIMEOUT_MS)
		?? '(page opened; summary unavailable)';
	return {
		ok: true,
		pageId: input.id,
		content: `Opened page ${input.id}\nURL: ${href}\n\n${summary}`,
	};
}

function listPages(
	browserViews: IBrowserViewWorkbenchService,
	editorService: IEditorService,
): BrowserAgentResponse {
	const views = [...browserViews.getContextualBrowserViews().values()];
	if (!views.length) {
		return { ok: true, content: 'No integrated browser pages are open.' };
	}
	const active = editorService.activeEditor;
	const lines = views.map((e, i) => {
		const hint = e === active ? ' (active)' : '';
		const shared = e.model?.sharingState === BrowserViewSharingState.Shared ? ' shared' : '';
		return `${i + 1}. [${e.id}] ${e.title || 'Untitled'} (${e.url || 'about:blank'})${shared}${hint}`;
	});
	return { ok: true, content: `Browser pages:\n${lines.join('\n')}` };
}

async function ensureShared(editor: BrowserEditorInput): Promise<void> {
	const model = await editor.resolve();
	if (model.sharingState === BrowserViewSharingState.Shared) {
		return;
	}
	// Prefer silent share for agent-owned tabs; user tabs may prompt once.
	await model.setSharedWithAgent(true);
}

async function requirePageId(pageId: string | undefined): Promise<string> {
	if (!pageId?.trim()) {
		throw new Error('pageId is required. Call open first and reuse the returned pageId.');
	}
	return pageId.trim();
}

async function readPage(playwright: IPlaywrightService, sessionId: string, pageId: string | undefined): Promise<BrowserAgentResponse> {
	const id = await requirePageId(pageId);
	const summary = await playwright.getSummary(sessionId, id);
	if (!summary) {
		return { ok: false, pageId: id, content: '', error: 'No page summary available.' };
	}
	return { ok: true, pageId: id, content: summary };
}

async function navigatePage(playwright: IPlaywrightService, sessionId: string, raw: BrowserAgentRequest): Promise<BrowserAgentResponse> {
	const id = await requirePageId(raw.pageId);
	if (raw.action === 'reload') {
		await playwrightInvokeRaw(playwright, sessionId, id, (page) => page.reload({ waitUntil: 'domcontentloaded' }));
		return { ok: true, pageId: id, content: `Reloaded ${id}` };
	}
	if (raw.action === 'back') {
		await playwrightInvokeRaw(playwright, sessionId, id, (page) => page.goBack({ waitUntil: 'domcontentloaded' }));
		return { ok: true, pageId: id, content: `Went back on ${id}` };
	}
	if (raw.action === 'forward') {
		await playwrightInvokeRaw(playwright, sessionId, id, (page) => page.goForward({ waitUntil: 'domcontentloaded' }));
		return { ok: true, pageId: id, content: `Went forward on ${id}` };
	}
	const url = typeof raw.url === 'string' ? raw.url.trim() : '';
	if (!url) {
		return { ok: false, pageId: id, content: '', error: 'url is required for navigate' };
	}
	const href = new URL(url).href;
	await playwrightInvokeRaw(playwright, sessionId, id, (page, target) => page.goto(target, { waitUntil: 'domcontentloaded' }), href);
	const summary = await playwright.getSummary(sessionId, id) ?? '';
	return { ok: true, pageId: id, content: `Navigated ${id} to ${href}\n\n${summary}` };
}

function resolveSelector(raw: BrowserAgentRequest): string {
	if (raw.ref) {
		return `aria-ref=${raw.ref}`;
	}
	if (raw.selector) {
		return raw.selector;
	}
	throw new Error('Either ref (from read_page snapshot) or selector is required.');
}

async function clickPage(playwright: IPlaywrightService, sessionId: string, raw: BrowserAgentRequest): Promise<BrowserAgentResponse> {
	const id = await requirePageId(raw.pageId);
	const selector = resolveSelector(raw);
	const button = raw.button ?? 'left';
	if (raw.dblClick) {
		await playwrightInvokeRaw(playwright, sessionId, id, (page, sel, btn) => page.locator(sel).dblclick({ button: btn }), selector, button);
		return { ok: true, pageId: id, content: `Double-clicked ${raw.element || selector} on ${id}` };
	}
	await playwrightInvokeRaw(playwright, sessionId, id, (page, sel, btn) => page.locator(sel).click({ button: btn }), selector, button);
	return { ok: true, pageId: id, content: `Clicked ${raw.element || selector} on ${id}` };
}

async function typePage(playwright: IPlaywrightService, sessionId: string, raw: BrowserAgentRequest): Promise<BrowserAgentResponse> {
	const id = await requirePageId(raw.pageId);
	if (raw.key) {
		const selector = raw.ref || raw.selector ? resolveSelector(raw) : undefined;
		if (selector) {
			await playwrightInvokeRaw(playwright, sessionId, id, (page, sel, key) => page.locator(sel).press(key), selector, raw.key);
		} else {
			await playwrightInvokeRaw(playwright, sessionId, id, (page, key) => page.keyboard.press(key), raw.key);
		}
		return { ok: true, pageId: id, content: `Pressed ${raw.key} on ${id}` };
	}
	if (!raw.text) {
		return { ok: false, pageId: id, content: '', error: 'text or key is required' };
	}
	const selector = raw.ref || raw.selector ? resolveSelector(raw) : undefined;
	if (selector) {
		await playwrightInvokeRaw(playwright, sessionId, id, async (page, sel, text, submit) => {
			const loc = page.locator(sel);
			await loc.fill(text);
			if (submit) {
				await loc.press('Enter');
			}
		}, selector, raw.text, !!raw.submit);
	} else {
		await playwrightInvokeRaw(playwright, sessionId, id, async (page, text, submit) => {
			await page.keyboard.type(text);
			if (submit) {
				await page.keyboard.press('Enter');
			}
		}, raw.text, !!raw.submit);
	}
	return { ok: true, pageId: id, content: `Typed into ${raw.element || selector || id}` };
}

async function hoverPage(playwright: IPlaywrightService, sessionId: string, raw: BrowserAgentRequest): Promise<BrowserAgentResponse> {
	const id = await requirePageId(raw.pageId);
	const selector = resolveSelector(raw);
	await playwrightInvokeRaw(playwright, sessionId, id, (page, sel) => page.locator(sel).hover(), selector);
	return { ok: true, pageId: id, content: `Hovered ${raw.element || selector} on ${id}` };
}

async function screenshotPage(playwright: IPlaywrightService, sessionId: string, raw: BrowserAgentRequest): Promise<BrowserAgentResponse> {
	const id = await requirePageId(raw.pageId);
	const fullPage = raw.fullPage === true;
	// Prefer returning a short confirmation; binary image is not useful in text tool loops.
	await playwrightInvokeRaw(playwright, sessionId, id, async (page, full) => {
		await page.screenshot({ fullPage: full, type: 'png' });
		return true;
	}, fullPage);
	return {
		ok: true,
		pageId: id,
		content: `Captured screenshot of ${id}${fullPage ? ' (full page)' : ''}. Use read_page for structured content.`,
	};
}
