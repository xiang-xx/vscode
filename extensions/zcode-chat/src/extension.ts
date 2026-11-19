/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { registerAuthProvider } from './authProvider';
import { registerAuthStatusBar } from './authStatusBar';
import { setAuthService, ZCodeAuthService } from './authSession';
import { disposeBrowserBridge, ensureBrowserBridge } from './browserBridgeHttp';
import { setBrowserMcpExtensionRoot } from './browserMcp';
import { BRAIN_LABELS, getActiveBrain, setActiveBrain } from './brains';
import { getBridgeStatusText } from './bridge';
import { registerChatParticipant, switchModelCommand, switchReasoningLevelCommand } from './chatParticipant';
import { registerChatPanel } from './chatPanel';
import { EditDecorationController } from './editDecorations';
import { bindFeishuSecrets, disposeFeishuBridge, ensureFeishuBridge, FEISHU_SECRET_KEY, getFeishuBridgeStatus } from './feishuBridge';
import { getFileEditSession, resetFileEditSession } from './fileEditSession';
import {
	IDE_CHAT_SOURCE_CURSOR,
	IDE_CHAT_SOURCE_DEEPSEEK,
	IDE_CHAT_SOURCE_QIANWEN,
	IDE_CHAT_SOURCE_ZCODE,
	IdeChatStore,
	type IdeChatExtensionApi,
} from './ideChatStore';
import { ensureModelForProvider, ensureReasoningLevelForModel, getSelectedModelId, getSelectedReasoningLevel } from './models';
import { bindDeepseekSecrets, isRetiredDeepseekModel, prepareDeepseekProvider, promptDeepseekApiKey } from './deepseekProvider';
import { bindQianwenSecrets, prepareQianwenProvider, promptQianwenApiKey } from './qianwenProvider';
import { getProviderMode, isProviderMode, PROVIDER_LABELS, setProviderMode } from './providers';
import { stampZcodeRuntime } from './runtimeEnv';
import { searchChatSessions, type SessionSearchMatch } from './sessionSearch';
import { disposePluginHosts } from './chatPlugins';
import { registerPluginCommands } from './pluginCommands';
import type { DispatchStatus } from './conversation';

const DISPATCH_STATUSES: ReadonlySet<string> = new Set([
	'pending', 'queued', 'starting', 'running', 'awaiting', 'done', 'failed', 'cancelled', 'stalled',
]);

function isDispatchStatus(value: unknown): value is DispatchStatus {
	return typeof value === 'string' && DISPATCH_STATUSES.has(value);
}

export async function activate(context: vscode.ExtensionContext): Promise<IdeChatExtensionApi> {
	// Before any session file is opened: DEV and the installed app keep
	// separate chat histories. See runtimeEnv.ts.
	stampZcodeRuntime(vscode.env.appName);
	setBrowserMcpExtensionRoot(context.extensionPath);
	void ensureBrowserBridge().catch(() => { /* bridge starts lazily on first Cursor run */ });
	context.subscriptions.push({ dispose: () => disposeBrowserBridge() });

	registerPluginCommands(context);
	bindDeepseekSecrets(context.secrets);
	bindQianwenSecrets(context.secrets);

	const auth = new ZCodeAuthService(context.secrets);
	setAuthService(auth);
	registerAuthProvider(context, auth);
	registerAuthStatusBar(context, auth);

	const ideChat = new IdeChatStore();
	const fileEdits = resetFileEditSession(context);
	context.subscriptions.push(new EditDecorationController(fileEdits));

	// Built-in Chat editing overlay Keep/Undo settles entries via this command.
	context.subscriptions.push(
		vscode.commands.registerCommand('zcode.fileEdits.onSettled', (payload?: { uri?: vscode.Uri; outcome?: 'keep' | 'undo' }) => {
			const uri = payload?.uri;
			if (!uri) {
				return;
			}
			getFileEditSession().dismissSettled(uri.toString(), payload?.outcome ?? 'keep');
		}),
		vscode.commands.registerCommand('zcode.debugEditingBridge', async () => {
			try {
				const status = await vscode.commands.executeCommand('_zcode.editing.status');
				await vscode.window.showInformationMessage(`ZCode editing bridge: ${JSON.stringify(status)}`);
			} catch (err) {
				await vscode.window.showErrorMessage(`ZCode editing bridge unavailable: ${err instanceof Error ? err.message : String(err)}`);
			}
		}),
	);

	// Migrate legacy providerMode values (`zcode`, `glm`) onto Start Plan / BigModel.
	// The pre-peer-brain `deepseek` sub-provider setting migrates onto the
	// DeepSeek brain, so nobody loses their provider by upgrading.
	const configuredMode = vscode.workspace.getConfiguration('zcode').get<string>('providerMode');
	if (configuredMode === 'deepseek') {
		await setProviderMode('startPlan');
		if (getActiveBrain() === 'zcode') {
			await setActiveBrain('deepseek');
		}
	} else if (configuredMode && !isProviderMode(configuredMode)) {
		await setProviderMode(getProviderMode());
	}
	// Users who still have the old default `stub` should get real agent runs.
	const bridgeMode = vscode.workspace.getConfiguration('zcode').get<string>('bridge.mode');
	if (bridgeMode === 'stub') {
		await vscode.workspace.getConfiguration('zcode').update('bridge.mode', 'agent', vscode.ConfigurationTarget.Global);
	}

	// A model id left over from another brain (for example the retired harness id
	// `deepseek-flash` → "DeepSeek-V4.1-Flash") must never be sent to
	// api.deepseek.com: pin an official catalog id before the first turn, even if
	// the user never re-picks a brain. A custom `zcode.deepseek.baseUrl` proxy may
	// legitimately serve other ids, so only retired ids are rewritten there.
	if (getActiveBrain() === 'deepseek') {
		const stored = vscode.workspace.getConfiguration('zcode').get<string>('model')?.trim();
		const customBaseUrl = !!vscode.workspace.getConfiguration('zcode').get<string>('deepseek.baseUrl')?.trim();
		const retired = isRetiredDeepseekModel(stored);
		if (stored && (retired || !customBaseUrl)) {
			const modelId = await ensureModelForProvider('deepseek');
			await ensureReasoningLevelForModel('deepseek', modelId);
			if (retired && modelId !== stored) {
				void vscode.window.showInformationMessage(
					`DeepSeek 模型已改为 ${modelId}：${stored} 不是官方 API 模型（官方只有 deepseek-chat / deepseek-reasoner）。`,
				);
			}
		}
	}
	// Same idea for the Qianwen brain: never send another brain's model id to
	// the Qwen endpoint; pin a catalog id before the first turn.
	if (getActiveBrain() === 'qianwen') {
		const modelId = await ensureModelForProvider('qianwen');
		await ensureReasoningLevelForModel('qianwen', modelId);
	}

	const panel = registerChatPanel(context, ideChat, fileEdits);
	registerChatParticipant(context);

	// Feishu bot bridge: phone → Super Agent workers. Runs in at most one
	// window (heartbeat lock in ~/.zcode); see feishuBridge.ts for commands.
	bindFeishuSecrets(context.secrets);
	context.subscriptions.push({ dispose: () => disposeFeishuBridge() });
	void ensureFeishuBridge(panel, ideChat).catch(err =>
		console.warn('[zcode-chat] feishu bridge start failed:', err));

	const providerStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	providerStatus.command = 'zcode.switchBrain';
	const refreshProviderStatus = () => {
		const brain = getActiveBrain();
		if (brain === 'cursor') {
			providerStatus.text = `$(hubot) Cursor`;
			providerStatus.tooltip = `${BRAIN_LABELS.cursor}\n${getBridgeStatusText()}`;
		} else if (brain === 'deepseek') {
			const model = getSelectedModelId('deepseek');
			const thinking = getSelectedReasoningLevel('deepseek', model);
			providerStatus.text = `$(sparkle) DeepSeek · ${model}`;
			providerStatus.tooltip = `${BRAIN_LABELS.deepseek} · thinking ${thinking}\n${getBridgeStatusText()}`;
		} else if (brain === 'qianwen') {
			const model = getSelectedModelId('qianwen');
			const thinking = getSelectedReasoningLevel('qianwen', model);
			providerStatus.text = `$(sparkle) Qianwen · ${model}`;
			providerStatus.tooltip = `${BRAIN_LABELS.qianwen} · thinking ${thinking}\n${getBridgeStatusText()}`;
		} else {
			const mode = getProviderMode();
			const model = getSelectedModelId(mode);
			const thinking = getSelectedReasoningLevel(mode, model);
			providerStatus.text = `$(sparkle) ${model}`;
			providerStatus.tooltip = `${BRAIN_LABELS.zcode} · ${PROVIDER_LABELS[mode]} · thinking ${thinking}\n${getBridgeStatusText()}`;
		}
		providerStatus.show();
	};
	refreshProviderStatus();
	context.subscriptions.push(providerStatus);
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('zcode')) {
				refreshProviderStatus();
				panel.refresh();
			}
		}),
		auth.onDidChangeSession(() => {
			refreshProviderStatus();
			panel.refresh();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zcode.openChat', async () => {
			await panel.open();
		}),
		vscode.commands.registerCommand('zcode.addSelectionToChat', async () => {
			await panel.addEditorSelectionToChat();
		}),
		vscode.commands.registerCommand('zcode.newChat', async () => {
			// Router+Worker: "new chat" means focus the Router dispatch surface.
			await panel.ensureRouterSession();
			await vscode.commands.executeCommand('workbench.action.chat.superAgent.showWorkersPage');
		}),
		vscode.commands.registerCommand('zcode.ensureRouterSession', async () => {
			return panel.ensureRouterSession();
		}),
		vscode.commands.registerCommand('zcode.createWorkerSession', async (opts?: { title?: string; message?: string }) => {
			return panel.createWorkerSession({
				title: typeof opts?.title === 'string' ? opts.title : undefined,
				message: typeof opts?.message === 'string' ? opts.message : undefined,
			});
		}),
		vscode.commands.registerCommand('zcode.patchRouterDispatch', async (opts?: {
			sessionId?: string;
			dispatchItemId?: string;
			workerId?: string;
			workerSessionId?: string;
			badge?: string;
			accent?: string;
			status?: string;
		}) => {
			if (!opts || typeof opts.sessionId !== 'string' || typeof opts.dispatchItemId !== 'string' || typeof opts.workerId !== 'string') {
				return;
			}
			await panel.patchRouterDispatch({
				sessionId: opts.sessionId,
				dispatchItemId: opts.dispatchItemId,
				workerId: opts.workerId,
				workerSessionId: typeof opts.workerSessionId === 'string' ? opts.workerSessionId : undefined,
				badge: typeof opts.badge === 'string' ? opts.badge : undefined,
				accent: typeof opts.accent === 'string' ? opts.accent : undefined,
				status: isDispatchStatus(opts.status) ? opts.status : undefined,
			});
		}),
		vscode.commands.registerCommand('zcode.patchRouterDispatchLabel', async (opts?: {
			sessionId?: string;
			workerId?: string;
			badge?: string;
		}) => {
			if (!opts || typeof opts.sessionId !== 'string' || typeof opts.workerId !== 'string' || typeof opts.badge !== 'string') {
				return;
			}
			panel.patchRouterDispatchLabel({
				sessionId: opts.sessionId,
				workerId: opts.workerId,
				badge: opts.badge,
			});
		}),
		vscode.commands.registerCommand('zcode.patchRouterDispatchStatus', async (opts?: {
			sessionId?: string;
			workerId?: string;
			dispatchItemId?: string;
			status?: string;
		}) => {
			if (!opts || typeof opts.sessionId !== 'string' || !isDispatchStatus(opts.status)) {
				return;
			}
			panel.patchRouterDispatchStatus({
				sessionId: opts.sessionId,
				workerId: typeof opts.workerId === 'string' ? opts.workerId : undefined,
				dispatchItemId: typeof opts.dispatchItemId === 'string' ? opts.dispatchItemId : undefined,
				status: opts.status,
			});
		}),
		vscode.commands.registerCommand('zcode.getActiveSessionId', () => panel.getActiveSessionId()),
		vscode.commands.registerCommand('zcode.openSession', async (sessionId?: string) => {
			if (typeof sessionId !== 'string' || !sessionId) {
				return;
			}
			// Do not focus the webview here — title-tab clicks already sit in the
			// auxiliary bar, and re-focusing steals the first click / feels like a no-op.
			await panel.openSessionFromTitle(sessionId);
		}),
		vscode.commands.registerCommand('zcode.closeTab', async (sessionId?: string) => {
			if (typeof sessionId !== 'string' || !sessionId) {
				return;
			}
			await panel.closeTabFromTitle(sessionId);
		}),
		vscode.commands.registerCommand('zcode.closeActiveTab', async () => {
			await panel.closeActiveTab();
		}),
		vscode.commands.registerCommand('zcode.clearTabDone', async (sessionId?: string) => {
			if (typeof sessionId !== 'string' || !sessionId) {
				return;
			}
			panel.clearTabDoneFromTitle(sessionId);
		}),
		vscode.commands.registerCommand('zcode.toggleHistory', async () => {
			// Router+Worker: History is the chat webview's session drawer
			// (ZCode 与 Cursor 共用) — worker sessions are real zcode sessions.
			await panel.toggleHistory();
		}),
		vscode.commands.registerCommand('zcode.searchHistory', async () => {
			// Ported from DeepSeek Harness `session_search` / `session_event_search`:
			// full-text search across this runtime's saved sessions,
			// then jump back into the conversation that matched.
			const query = await vscode.window.showInputBox({
				placeHolder: 'Search all chat history (wrap in /…/ for regex)',
				prompt: 'ZCode: search user + assistant messages in every saved session.',
			});
			const trimmed = query?.trim();
			if (!trimmed) {
				return;
			}
			let matches: SessionSearchMatch[];
			try {
				matches = await searchChatSessions(trimmed, { limit: 60 });
			} catch (err) {
				void vscode.window.showErrorMessage(`Chat history search failed: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			if (!matches.length) {
				void vscode.window.showInformationMessage(`No chat-history matches for “${trimmed}”.`);
				return;
			}
			const picks = matches.map(match => ({
				label: match.role === 'user' ? `$(comment) ${match.title}` : `$(sparkle) ${match.title}`,
				description: `${new Date(match.updatedAt).toLocaleString()} · ${match.matchCount} hit${match.matchCount === 1 ? '' : 's'} · ${match.sessionMatchCount} in session`,
				detail: `${match.role === 'user' ? 'You' : 'AI'}: ${match.snippet}`,
				sessionId: match.sessionId,
			}));
			const pick = await vscode.window.showQuickPick(picks, {
				placeHolder: `Chat history matches for “${trimmed}” — Enter opens that session`,
				matchOnDescription: true,
				matchOnDetail: true,
			});
			if (pick) {
				await panel.openSessionFromTitle(pick.sessionId);
			}
		}),
		vscode.commands.registerCommand('zcode.switchBrain', async () => {
			await panel.switchBrain();
			refreshProviderStatus();
		}),
		vscode.commands.registerCommand('zcode.switchProvider', async () => {
			await panel.switchProvider();
			refreshProviderStatus();
		}),
		vscode.commands.registerCommand('zcode.setDeepseekApiKey', async () => {
			const key = await promptDeepseekApiKey();
			if (key) {
				void vscode.window.showInformationMessage('DeepSeek API Key 已保存。');
				// Pull the official model listing with the fresh key, then repaint.
				await prepareDeepseekProvider().catch(() => undefined);
				panel.refresh();
			}
		}),
		vscode.commands.registerCommand('zcode.setQianwenApiKey', async () => {
			const key = await promptQianwenApiKey();
			if (key) {
				void vscode.window.showInformationMessage('千问 API Key 已保存。');
				// Pull the model listing with the fresh key, then repaint.
				await prepareQianwenProvider().catch(() => undefined);
				panel.refresh();
			}
		}),
		vscode.commands.registerCommand('zcode.setFeishuSecret', async () => {
			const value = await vscode.window.showInputBox({
				password: true,
				prompt: '飞书自建应用 App Secret（配套 zcode.feishu.appId，存入系统凭据库，不进 settings 文件）',
				placeHolder: 'App Secret',
				ignoreFocusOut: true,
			});
			if (value === undefined) {
				return;
			}
			await context.secrets.store(FEISHU_SECRET_KEY, value.trim());
			await ensureFeishuBridge(panel, ideChat).catch(err =>
				void vscode.window.showErrorMessage(`飞书桥启动失败：${err instanceof Error ? err.message : String(err)}`));
			void vscode.window.showInformationMessage(getFeishuBridgeStatus());
		}),
		vscode.commands.registerCommand('zcode.showFeishuStatus', async () => {
			await ensureFeishuBridge(panel, ideChat).catch(() => undefined);
			void vscode.window.showInformationMessage(getFeishuBridgeStatus());
		}),
		vscode.commands.registerCommand('zcode.switchModel', async () => {
			if (getActiveBrain() === 'cursor') {
				await panel.switchBrain();
				return;
			}
			await switchModelCommand();
			panel.refresh();
			refreshProviderStatus();
		}),
		vscode.commands.registerCommand('zcode.switchReasoningLevel', async () => {
			await switchReasoningLevelCommand();
			panel.refresh();
			refreshProviderStatus();
		}),
		vscode.commands.registerCommand('zcode.showBridgeStatus', async () => {
			await vscode.window.showInformationMessage(getBridgeStatusText(), { modal: false });
		}),
		vscode.commands.registerCommand('zcode.manageAccount', async () => {
			const brain = getActiveBrain();
			if (brain === 'cursor') {
				await vscode.commands.executeCommand('zcode.showBridgeStatus');
				return;
			}
			if (brain === 'deepseek') {
				// The DeepSeek brain's "account" is its API key.
				await vscode.commands.executeCommand('zcode.setDeepseekApiKey');
				return;
			}
			if (brain === 'qianwen') {
				// The Qianwen brain's "account" is its API key.
				await vscode.commands.executeCommand('zcode.setQianwenApiKey');
				return;
			}
			await auth.showAccountMenu();
		}),
		vscode.commands.registerCommand('zcode.signIn', async () => {
			await auth.signIn();
		}),
		vscode.commands.registerCommand('zcode.signOut', async () => {
			await auth.signOut();
			void vscode.window.showInformationMessage('Signed out of ZCode (IDE session).');
		}),
	);

	await auth.waitUntilReady();
	panel.refresh();

	// Reveal the secondary side bar chat once so the right-hand AI pane is discoverable.
	void vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar').then(() => {
		return vscode.commands.executeCommand('zcode.chatView.focus');
	}, () => {
		// Auxiliary bar may be unavailable in some layouts; ignore.
	});

	return {
		ideChat,
		sources: {
			zcode: IDE_CHAT_SOURCE_ZCODE,
			cursor: IDE_CHAT_SOURCE_CURSOR,
			deepseek: IDE_CHAT_SOURCE_DEEPSEEK,
			qianwen: IDE_CHAT_SOURCE_QIANWEN,
		},
	};
}

export function deactivate(): void {
	disposePluginHosts();
	disposeBrowserBridge();
	disposeFeishuBridge();
}
