/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { registerAuthProvider } from './authProvider';
import { registerAuthStatusBar } from './authStatusBar';
import { setAuthService, ZCodeAuthService } from './authSession';
import { BRAIN_LABELS, getActiveBrain } from './brains';
import { getBridgeStatusText } from './bridge';
import { registerChatParticipant, switchModelCommand, switchReasoningLevelCommand } from './chatParticipant';
import { registerChatPanel } from './chatPanel';
import { EditDecorationController } from './editDecorations';
import { getFileEditSession, resetFileEditSession } from './fileEditSession';
import {
	IDE_CHAT_SOURCE_CURSOR,
	IDE_CHAT_SOURCE_DEEPSEEK,
	IDE_CHAT_SOURCE_ZCODE,
	IdeChatStore,
	type IdeChatExtensionApi,
} from './ideChatStore';
import { getSelectedModelId, getSelectedReasoningLevel } from './models';
import { getProviderMode, isProviderMode, PROVIDER_LABELS, setProviderMode } from './providers';

export async function activate(context: vscode.ExtensionContext): Promise<IdeChatExtensionApi> {
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

	// Migrate legacy providerMode values (deepseek / glm / zcode) to Start Plan / BigModel.
	const configuredMode = vscode.workspace.getConfiguration('zcode').get<string>('providerMode');
	if (configuredMode && !isProviderMode(configuredMode)) {
		await setProviderMode(getProviderMode());
	}
	// Users who still have the old default `stub` should get real agent runs.
	const bridgeMode = vscode.workspace.getConfiguration('zcode').get<string>('bridge.mode');
	if (bridgeMode === 'stub') {
		await vscode.workspace.getConfiguration('zcode').update('bridge.mode', 'agent', vscode.ConfigurationTarget.Global);
	}

	const panel = registerChatPanel(context, ideChat, fileEdits);
	registerChatParticipant(context);

	const providerStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	providerStatus.command = 'zcode.switchBrain';
	const refreshProviderStatus = () => {
		const brain = getActiveBrain();
		if (brain === 'cursor') {
			providerStatus.text = `$(hubot) Cursor`;
			providerStatus.tooltip = `${BRAIN_LABELS.cursor}\n${getBridgeStatusText()}`;
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
			await panel.newChat();
			await panel.open();
		}),
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
			panel.toggleHistory();
			await panel.open();
		}),
		vscode.commands.registerCommand('zcode.switchBrain', async () => {
			await panel.switchBrain();
			refreshProviderStatus();
		}),
		vscode.commands.registerCommand('zcode.switchProvider', async () => {
			await panel.switchProvider();
			refreshProviderStatus();
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
			if (getActiveBrain() === 'cursor') {
				await vscode.commands.executeCommand('zcode.showBridgeStatus');
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
		},
	};
}

export function deactivate(): void {
	// nothing
}
