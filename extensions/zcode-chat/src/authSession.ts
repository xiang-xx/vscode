/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { loginWithZCodeCliPolling } from './oauthLogin';
import {
	clearZCodeDesktopSession,
	getZCodeCredentialsPath,
	loadZCodeDesktopSession,
	saveZCodeDesktopSession,
	type ZCodeOAuthProvider,
	type ZCodeStoredSession,
} from './zcodeCredentialsStore';

const SECRET_KEY = 'zcode.session.v1';

export class ZCodeAuthService {
	private readonly _onDidChangeSession = new vscode.EventEmitter<void>();
	readonly onDidChangeSession = this._onDidChangeSession.event;

	private session: ZCodeStoredSession | undefined;
	private ready: Promise<void>;

	constructor(private readonly secrets: vscode.SecretStorage) {
		this.ready = this.bootstrap();
	}

	async waitUntilReady(): Promise<void> {
		await this.ready;
	}

	getSession(): ZCodeStoredSession | undefined {
		return this.session;
	}

	isSignedIn(): boolean {
		return !!this.session?.zcodeJwtToken;
	}

	async refreshFromDesktop(): Promise<ZCodeStoredSession | undefined> {
		const desktop = await loadZCodeDesktopSession().catch(() => undefined);
		if (desktop) {
			this.session = desktop;
			await this.secrets.store(SECRET_KEY, JSON.stringify(desktop));
			this._onDidChangeSession.fire();
			return desktop;
		}
		return this.session;
	}

	async signIn(provider?: ZCodeOAuthProvider): Promise<ZCodeStoredSession> {
		await this.waitUntilReady();

		// Prefer already-logged-in ZCode desktop credentials on this machine.
		const existing = await loadZCodeDesktopSession().catch(() => undefined);
		if (existing && (!provider || existing.provider === provider)) {
			this.session = existing;
			await this.secrets.store(SECRET_KEY, JSON.stringify(existing));
			this._onDidChangeSession.fire();
			void vscode.window.showInformationMessage(
				`Using ZCode desktop login (${existing.accountLabel} · ${existing.provider}).`,
			);
			return existing;
		}

		const picked = provider ?? await this.pickProvider();
		if (!picked) {
			throw new vscode.CancellationError();
		}

		const session = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Signing in to ZCode (${picked})…`,
				cancellable: true,
			},
			async (_progress, token) => loginWithZCodeCliPolling(picked, token),
		);

		await saveZCodeDesktopSession(session);
		this.session = session;
		await this.secrets.store(SECRET_KEY, JSON.stringify(session));
		this._onDidChangeSession.fire();
		void vscode.window.showInformationMessage(
			`Signed in to ZCode as ${session.accountLabel}.`,
		);
		return session;
	}

	async signOut(options?: { clearDesktop?: boolean }): Promise<void> {
		await this.waitUntilReady();
		this.session = undefined;
		await this.secrets.delete(SECRET_KEY);
		if (options?.clearDesktop) {
			await clearZCodeDesktopSession().catch(() => undefined);
		}
		this._onDidChangeSession.fire();
	}

	async showAccountMenu(): Promise<void> {
		await this.waitUntilReady();
		if (!this.session) {
			const action = await vscode.window.showQuickPick(
				[
					{ label: '$(desktop-download) Use ZCode desktop login', id: 'reuse' as const },
					{ label: '$(globe) Sign in with BigModel (CN)', id: 'bigmodel' as const },
					{ label: '$(globe) Sign in with Z.ai (Global)', id: 'zai' as const },
				],
				{ title: 'ZCode account', placeHolder: 'Sign in to use Start Plan' },
			);
			if (!action) {
				return;
			}
			if (action.id === 'reuse') {
				const desktop = await this.refreshFromDesktop();
				if (!desktop) {
					void vscode.window.showWarningMessage(
						`No ZCode login found at ${getZCodeCredentialsPath()}. Sign in below instead.`,
					);
					await this.signIn();
				}
				return;
			}
			await this.signIn(action.id);
			return;
		}

		const action = await vscode.window.showQuickPick(
			[
				{
					label: `$(account) ${this.session.accountLabel}`,
					description: `${this.session.provider} · signed in`,
					id: 'noop' as const,
				},
				{ label: '$(refresh) Reload from ZCode desktop', id: 'reload' as const },
				{ label: '$(sign-out) Sign out (this IDE only)', id: 'out-ide' as const },
				{ label: '$(trash) Sign out (IDE + ZCode desktop credentials)', id: 'out-all' as const },
			],
			{ title: 'ZCode account' },
		);
		if (!action || action.id === 'noop') {
			return;
		}
		if (action.id === 'reload') {
			const desktop = await this.refreshFromDesktop();
			void vscode.window.showInformationMessage(
				desktop
					? `Reloaded ${desktop.accountLabel} from ZCode desktop.`
					: 'No desktop session found; keeping current IDE session.',
			);
			return;
		}
		await this.signOut({ clearDesktop: action.id === 'out-all' });
		void vscode.window.showInformationMessage('Signed out of ZCode.');
	}

	private async bootstrap(): Promise<void> {
		try {
			const desktop = await loadZCodeDesktopSession();
			if (desktop) {
				this.session = desktop;
				await this.secrets.store(SECRET_KEY, JSON.stringify(desktop));
				return;
			}
		} catch {
			// fall through to secret storage
		}

		try {
			const raw = await this.secrets.get(SECRET_KEY);
			if (raw) {
				this.session = JSON.parse(raw) as ZCodeStoredSession;
			}
		} catch {
			this.session = undefined;
		}
	}

	private async pickProvider(): Promise<ZCodeOAuthProvider | undefined> {
		const picked = await vscode.window.showQuickPick(
			[
				{ label: 'BigModel (CN)', description: 'China region', provider: 'bigmodel' as const },
				{ label: 'Z.ai (Global)', description: 'Global region', provider: 'zai' as const },
			],
			{ title: 'ZCode login provider', placeHolder: 'Choose account region' },
		);
		return picked?.provider;
	}
}

let sharedAuth: ZCodeAuthService | undefined;

export function getAuthService(): ZCodeAuthService {
	if (!sharedAuth) {
		throw new Error('ZCodeAuthService not initialized');
	}
	return sharedAuth;
}

export function setAuthService(service: ZCodeAuthService): void {
	sharedAuth = service;
}
