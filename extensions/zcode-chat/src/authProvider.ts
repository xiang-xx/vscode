/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ZCodeAuthService } from './authSession';

export const ZCODE_AUTH_PROVIDER_ID = 'zcode';

export class ZCodeAuthenticationProvider implements vscode.AuthenticationProvider, vscode.Disposable {
	private readonly _onDidChangeSessions = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	readonly onDidChangeSessions = this._onDidChangeSessions.event;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly auth: ZCodeAuthService) {
		this.disposables.push(
			auth.onDidChangeSession(() => {
				const session = this.toVsCodeSession();
				this._onDidChangeSessions.fire({
					added: session ? [session] : [],
					removed: session ? [] : [{ id: 'zcode', accessToken: '', account: { id: 'zcode', label: 'ZCode' }, scopes: [] }],
					changed: session ? [session] : [],
				});
			}),
		);
	}

	async getSessions(scopes?: readonly string[]): Promise<vscode.AuthenticationSession[]> {
		await this.auth.waitUntilReady();
		const session = this.toVsCodeSession(scopes);
		return session ? [session] : [];
	}

	async createSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
		await this.auth.signIn();
		const session = this.toVsCodeSession(scopes);
		if (!session) {
			throw new Error('ZCode sign-in did not produce a session');
		}
		return session;
	}

	async removeSession(_sessionId: string): Promise<void> {
		await this.auth.signOut();
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
		this._onDidChangeSessions.dispose();
	}

	private toVsCodeSession(scopes: readonly string[] = []): vscode.AuthenticationSession | undefined {
		const current = this.auth.getSession();
		if (!current) {
			return undefined;
		}
		return {
			id: `zcode:${current.provider}:${current.accountId}`,
			accessToken: current.zcodeJwtToken,
			account: {
				id: current.accountId,
				label: current.accountLabel,
			},
			scopes: [...scopes],
		};
	}
}

export function registerAuthProvider(
	context: vscode.ExtensionContext,
	auth: ZCodeAuthService,
): ZCodeAuthenticationProvider {
	const provider = new ZCodeAuthenticationProvider(auth);
	context.subscriptions.push(provider);
	context.subscriptions.push(
		vscode.authentication.registerAuthenticationProvider(
			ZCODE_AUTH_PROVIDER_ID,
			'ZCode',
			provider,
			{ supportsMultipleAccounts: false },
		),
	);
	return provider;
}
