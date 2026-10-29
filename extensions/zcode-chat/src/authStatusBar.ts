/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ZCodeAuthService } from './authSession';

/** Bottom-left status bar account affordance (near the system / accounts area). */
export function registerAuthStatusBar(
	context: vscode.ExtensionContext,
	auth: ZCodeAuthService,
): vscode.StatusBarItem {
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
	item.command = 'zcode.manageAccount';

	const refresh = () => {
		const session = auth.getSession();
		if (session) {
			item.text = `$(account) ZCode: ${session.accountLabel}`;
			item.tooltip = `Signed in via ${session.provider}\nClick to manage account`;
			item.backgroundColor = undefined;
		} else {
			item.text = '$(sign-in) Sign in to ZCode';
			item.tooltip = 'Reuse ZCode desktop login, or sign in with BigModel / Z.ai';
			item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		}
		item.show();
	};

	refresh();
	context.subscriptions.push(item);
	context.subscriptions.push(auth.onDidChangeSession(refresh));
	void auth.waitUntilReady().then(refresh);
	return item;
}
