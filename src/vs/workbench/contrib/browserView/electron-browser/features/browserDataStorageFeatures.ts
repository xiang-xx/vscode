/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { BrowserEditor, BrowserEditorContribution, BrowserActionCategory, BrowserActionGroup } from '../browserEditor.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { workbenchConfigurationNodeBase } from '../../../../common/configuration.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../common/browserView.js';
import { BrowserViewCommandId, BrowserViewStorageScope } from '../../../../../platform/browserView/common/browserView.js';
import { IContextKey, IContextKeyService, ContextKeyExpr, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { Action2, registerAction2, MenuId } from '../../../../../platform/actions/common/actions.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { isWindows } from '../../../../../base/common/platform.js';

export const CONTEXT_BROWSER_STORAGE_SCOPE = new RawContextKey<string>('browserStorageScope', '', localize('browser.storageScope', "The storage scope of the current browser view"));

class BrowserEditorStorageScopeContribution extends BrowserEditorContribution {
	private readonly _storageScopeContext: IContextKey<string>;

	constructor(
		editor: BrowserEditor,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super(editor);
		this._storageScopeContext = CONTEXT_BROWSER_STORAGE_SCOPE.bindTo(contextKeyService);
	}

	protected override onModelAttached(model: IBrowserViewModel, _store: DisposableStore): void {
		this._storageScopeContext.set(model.storageScope);
	}

	override onModelDetached(): void {
		this._storageScopeContext.reset();
	}
}

BrowserEditor.registerContribution(BrowserEditorStorageScopeContribution);

class ClearGlobalBrowserStorageAction extends Action2 {
	static readonly ID = BrowserViewCommandId.ClearGlobalStorage;

	constructor() {
		super({
			id: ClearGlobalBrowserStorageAction.ID,
			title: localize2('browser.clearGlobalStorageAction', 'Clear Storage (Global)'),
			category: BrowserActionCategory,
			icon: Codicon.clearAll,
			f1: true,
			menu: {
				id: MenuId.BrowserActionsToolbar,
				group: BrowserActionGroup.Data,
				order: 20,
				when: ContextKeyExpr.equals(CONTEXT_BROWSER_STORAGE_SCOPE.key, BrowserViewStorageScope.Global),
				isHiddenByDefault: true,
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const browserViewWorkbenchService = accessor.get(IBrowserViewWorkbenchService);
		await browserViewWorkbenchService.clearGlobalStorage();
	}
}

class ClearWorkspaceBrowserStorageAction extends Action2 {
	static readonly ID = BrowserViewCommandId.ClearWorkspaceStorage;

	constructor() {
		super({
			id: ClearWorkspaceBrowserStorageAction.ID,
			title: localize2('browser.clearWorkspaceStorageAction', 'Clear Storage (Workspace)'),
			category: BrowserActionCategory,
			icon: Codicon.clearAll,
			f1: true,
			menu: {
				id: MenuId.BrowserActionsToolbar,
				group: BrowserActionGroup.Data,
				order: 20,
				when: ContextKeyExpr.equals(CONTEXT_BROWSER_STORAGE_SCOPE.key, BrowserViewStorageScope.Workspace),
				isHiddenByDefault: true,
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const browserViewWorkbenchService = accessor.get(IBrowserViewWorkbenchService);
		await browserViewWorkbenchService.clearWorkspaceStorage();
	}
}

class ClearEphemeralBrowserStorageAction extends Action2 {
	static readonly ID = BrowserViewCommandId.ClearEphemeralStorage;

	constructor() {
		super({
			id: ClearEphemeralBrowserStorageAction.ID,
			title: localize2('browser.clearEphemeralStorageAction', 'Clear Storage (Ephemeral)'),
			category: BrowserActionCategory,
			icon: Codicon.clearAll,
			f1: true,
			precondition: ContextKeyExpr.equals(CONTEXT_BROWSER_STORAGE_SCOPE.key, BrowserViewStorageScope.Ephemeral),
			menu: {
				id: MenuId.BrowserActionsToolbar,
				group: BrowserActionGroup.Data,
				order: 20,
				when: ContextKeyExpr.equals(CONTEXT_BROWSER_STORAGE_SCOPE.key, BrowserViewStorageScope.Ephemeral),
				isHiddenByDefault: true,
			}
		});
	}

	async run(accessor: ServicesAccessor, browserEditor = accessor.get(IEditorService).activeEditorPane): Promise<void> {
		if (browserEditor instanceof BrowserEditor) {
			await browserEditor.model?.clearStorage();
		}
	}
}

class ClearAgentBrowserStorageAction extends Action2 {
	static readonly ID = BrowserViewCommandId.ClearAgentStorage;

	constructor() {
		super({
			id: ClearAgentBrowserStorageAction.ID,
			title: localize2('browser.clearAgentStorageAction', 'Clear Storage (Agent)'),
			category: BrowserActionCategory,
			icon: Codicon.clearAll,
			f1: true,
			precondition: ContextKeyExpr.equals(CONTEXT_BROWSER_STORAGE_SCOPE.key, BrowserViewStorageScope.Agent),
			menu: {
				id: MenuId.BrowserActionsToolbar,
				group: BrowserActionGroup.Data,
				order: 20,
				when: ContextKeyExpr.equals(CONTEXT_BROWSER_STORAGE_SCOPE.key, BrowserViewStorageScope.Agent),
				isHiddenByDefault: true,
			}
		});
	}

	async run(accessor: ServicesAccessor, browserEditor = accessor.get(IEditorService).activeEditorPane): Promise<void> {
		if (browserEditor instanceof BrowserEditor) {
			await browserEditor.model?.clearStorage();
		}
	}
}

registerAction2(ClearGlobalBrowserStorageAction);
registerAction2(ClearWorkspaceBrowserStorageAction);
registerAction2(ClearEphemeralBrowserStorageAction);
registerAction2(ClearAgentBrowserStorageAction);

class ImportChromeBrowserDataAction extends Action2 {
	static readonly ID = BrowserViewCommandId.ImportChromeData;

	constructor() {
		super({
			id: ImportChromeBrowserDataAction.ID,
			title: localize2('browser.importChromeData', 'Sync Chrome Sign-in State'),
			category: BrowserActionCategory,
			icon: Codicon.globe,
			f1: true,
			menu: {
				id: MenuId.BrowserActionsToolbar,
				group: BrowserActionGroup.Data,
				order: 10,
				isHiddenByDefault: false,
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const browserViewWorkbenchService = accessor.get(IBrowserViewWorkbenchService);
		const notificationService = accessor.get(INotificationService);
		const dialogService = accessor.get(IDialogService);

		let allowElevated = false;
		if (isWindows) {
			const confirm = await dialogService.confirm({
				type: 'warning',
				message: localize('browser.importChrome.windowsTitle', "Allow administrator access to import Chrome cookies?"),
				detail: localize('browser.importChrome.windowsDetail', "Chrome may protect cookies with App-Bound encryption on Windows. This import requests elevation only for this run. Passwords are never imported."),
				primaryButton: localize('browser.importChrome.windowsContinue', "Continue"),
			});
			if (!confirm.confirmed) {
				return;
			}
			allowElevated = true;
		}

		notificationService.info(localize('browser.importChrome.pending', "Syncing Chrome sign-in state…"));
		const result = await browserViewWorkbenchService.importChromeBrowserData({ allowElevatedChromeDecryption: allowElevated });
		if (result.success) {
			notificationService.notify({
				severity: Severity.Info,
				message: localize(
					'browser.importChrome.success',
					"Imported {0} cookies and {1} LocalStorage entries from {2} sites.",
					result.cookies.imported,
					result.localStorage.entriesImported,
					result.localStorage.originsImported,
				),
			});
			return;
		}

		const error = result.error ?? result.issues?.[0] ?? 'chrome_data_import_failed';
		const message = error === 'chrome_cookie_access_denied'
			? localize('browser.importChrome.accessDenied', "Chrome cookie access was denied (Keychain / OS permission). No data was imported.")
			: error === 'chrome_profile_not_found' || error === 'chrome_executable_not_found'
				? localize('browser.importChrome.notFound', "Could not find a local Chrome profile to import from.")
				: error === 'chrome_cookie_protection_unsupported'
					? localize('browser.importChrome.protected', "Some Chrome cookies are App-Bound protected and could not be imported. LocalStorage may still have been imported.")
					: localize('browser.importChrome.failed', "Chrome data import failed ({0}).", error);
		notificationService.notify({ severity: Severity.Warning, message });
	}
}

registerAction2(ImportChromeBrowserDataAction);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...workbenchConfigurationNodeBase,
	properties: {
		'workbench.browser.dataStorage': {
			type: 'string',
			enum: [
				'default',
				BrowserViewStorageScope.Global,
				BrowserViewStorageScope.Workspace,
				BrowserViewStorageScope.Ephemeral,
				BrowserViewStorageScope.Agent
			],
			markdownEnumDescriptions: [
				localize({ comment: ['This is the description for a setting. Values surrounded by single quotes are not to be translated.'], key: 'browser.dataStorage.default' }, '`global` for local workspaces, `workspace` for remote workspaces.'),
				localize({ comment: ['This is the description for a setting. Values surrounded by single quotes are not to be translated.'], key: 'browser.dataStorage.global' }, 'All browser views share a single persistent session across all workspaces. Incompatible with remote sessions.'),
				localize({ comment: ['This is the description for a setting. Values surrounded by single quotes are not to be translated.'], key: 'browser.dataStorage.workspace' }, 'Browser views within the same workspace share a persistent session. If no workspace is opened, `ephemeral` storage is used.'),
				localize({ comment: ['This is the description for a setting. Values surrounded by single quotes are not to be translated.'], key: 'browser.dataStorage.ephemeral' }, 'Each browser view has its own session that is cleaned up when closed.'),
				localize({ comment: ['This is the description for a setting. Values surrounded by single quotes are not to be translated.'], key: 'browser.dataStorage.agent' }, 'Browser views share one in-memory session that is cleaned up when the application is closed. This session is shared with agent-opened browser pages, so **all data including local storage and cookies will be accessible by agents.** When agent network filtering is enabled, requests from this session are restricted by the configured network domain policy.')
			],
			restricted: true,
			default: 'default',
			markdownDescription: localize(
				{ comment: ['This is the description for a setting. Values surrounded by single quotes are not to be translated.'], key: 'browser.dataStorage' },
				'Controls how browser data (cookies, cache, storage) is shared between browser views.\n\n**Note**: In untrusted workspaces, this setting is ignored and `ephemeral` storage is always used.'
			),
			scope: ConfigurationScope.WINDOW,
			order: 100
		}
	}
});
