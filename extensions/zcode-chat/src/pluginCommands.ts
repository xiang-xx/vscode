/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
	addMarketIndex,
	fetchMarketIndex,
	findDshCheckout,
	installDirectory,
	installMarketCard,
	listInstalled,
	listMarketIndexes,
	removeInstalled,
	removeMarketIndex,
	scanDshCheckout,
	setPluginEnabled,
	type InstalledPlugin,
	type InstalledView,
	type MarketPluginCard,
} from './chatPlugins';

export function registerPluginCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(vscode.commands.registerCommand('zcode.plugins', () => openPluginMenu()));
}

async function openPluginMenu(): Promise<void> {
	const folders = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
	const checkout = findDshCheckout(folders);
	const items: Array<vscode.QuickPickItem & { id: string }> = [
		{
			id: 'browse',
			label: '$(cloud-download) Browse the DeepSeek plugin market',
			description: 'Format-1 index',
			detail: 'Same catalog DeepSeek Discover uses. Text on the cards is written by the index, not by ZCode.',
		},
		{
			id: 'folder',
			label: '$(folder-opened) Install a plugin from a folder',
			detail: 'A folder with an MCP manifest, or a DeepSeek bundle that declares an MCP server.',
		},
		{
			id: 'installed',
			label: '$(extensions) Installed plugins',
			detail: 'Enable, hide, or remove. MCP plugins are available to both ZCode and Cursor.',
		},
		{ id: 'add', label: '$(add) Add an index source' },
		{ id: 'remove-index', label: '$(trash) Remove an index source' },
	];
	if (checkout) {
		items.splice(1, 0, {
			id: 'checkout',
			label: '$(repo) Browse plugins in the DeepSeek checkout',
			description: checkout,
		});
	}
	const pick = await vscode.window.showQuickPick(items, {
		title: 'Chat plugins',
		placeHolder: 'DeepSeek market plugins run here only when they declare an MCP server',
	});
	if (!pick) {
		return;
	}
	if (pick.id === 'browse') {
		await browseIndex();
	} else if (pick.id === 'checkout' && checkout) {
		await browseCheckout(checkout);
	} else if (pick.id === 'folder') {
		await installFromFolder();
	} else if (pick.id === 'installed') {
		await showInstalled();
	} else if (pick.id === 'add') {
		await addIndex();
	} else if (pick.id === 'remove-index') {
		await removeIndex();
	}
}

async function browseIndex(): Promise<void> {
	const indexes = await listMarketIndexes();
	let indexUrl = indexes[0];
	if (indexes.length !== 1) {
		const choice = await vscode.window.showQuickPick([
			...indexes.map(url => ({ label: url, url })),
			{ label: '$(add) Add an index source', url: '' },
		], { title: 'Plugin index', placeHolder: indexes.length ? 'Choose an index' : 'No index yet' });
		if (!choice) {
			return;
		}
		if (!choice.url) {
			await addIndex();
			return;
		}
		indexUrl = choice.url;
	}
	if (!indexUrl) {
		await addIndex();
		return;
	}
	try {
		const page = await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Reading plugin index',
		}, () => fetchMarketIndex(indexUrl, vscode.env.language));
		const picked = await pickCard(page.plugins, page.title);
		if (picked) {
			await confirmAndInstall(picked);
		}
	} catch (err) {
		void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
	}
}

async function browseCheckout(checkout: string): Promise<void> {
	try {
		const cards = await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Scanning DeepSeek checkout',
		}, () => scanDshCheckout(checkout, vscode.env.language));
		if (!cards.length) {
			void vscode.window.showInformationMessage('No DeepSeek bundles were found in that checkout.');
			return;
		}
		const picked = await pickCard(cards, 'DeepSeek checkout');
		if (picked) {
			await confirmAndInstall(picked);
		}
	} catch (err) {
		void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
	}
}

async function pickCard(cards: MarketPluginCard[], title: string): Promise<MarketPluginCard | undefined> {
	const picked = await vscode.window.showQuickPick(cards.map(card => ({
		label: card.title,
		description: card.version,
		detail: [card.author, card.description, card.enginesDsh ? `engines.dsh ${card.enginesDsh}` : '']
			.filter(Boolean)
			.join(' — ')
			.slice(0, 300),
		card,
	})), {
		title,
		placeHolder: 'Type to filter. Install checks whether the package can run outside DeepSeek.',
		matchOnDescription: true,
		matchOnDetail: true,
	});
	return picked?.card;
}

async function confirmAndInstall(card: MarketPluginCard): Promise<void> {
	const install = await vscode.window.showWarningMessage(
		[
			`Install “${card.title}” ${card.version}?`,
			`Source: ${card.sourceLabel}`,
			'The index text is third-party. ZCode downloads the package and does not run its install scripts.',
			'If it declares an MCP server, that server is shared by the ZCode and Cursor brains. A Cordis-only plugin is saved and not started.',
		].join('\n\n'),
		{ modal: true },
		'Install',
	);
	if (install !== 'Install') {
		return;
	}
	let plugin: InstalledPlugin;
	try {
		plugin = await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: `Installing ${card.title}`,
		}, () => installMarketCard(card, vscode.env.language));
	} catch (err) {
		void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
		return;
	}
	void vscode.window.showInformationMessage(installSummary(plugin));
}

function installSummary(plugin: InstalledPlugin): string {
	if (plugin.runtime === 'mcp' && plugin.enabled) {
		const how = plugin.servers
			.map(server => server.url || [server.command, ...(server.args ?? [])].filter(Boolean).join(' '))
			.join('; ');
		return `${plugin.title} is on for ZCode and Cursor. Starts: ${how}. It is available on the next message.`.slice(0, 500);
	}
	if (plugin.runtime === 'mcp') {
		return `${plugin.title} declares an MCP server but is not started. ${plugin.reason ?? ''}`.trim();
	}
	return `${plugin.title} was recorded and not started. ${plugin.reason ?? ''}`.trim();
}

async function installFromFolder(): Promise<void> {
	const picked = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		openLabel: 'Install plugin',
		title: 'Plugin folder',
	});
	const folder = picked?.[0]?.fsPath;
	if (!folder) {
		return;
	}
	try {
		const plugin = await installDirectory(folder, vscode.env.language);
		void vscode.window.showInformationMessage(installSummary(plugin));
	} catch (err) {
		void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
	}
}

async function showInstalled(): Promise<void> {
	const installed = await listInstalled();
	if (!installed.length) {
		void vscode.window.showInformationMessage('No chat plugins installed yet.');
		return;
	}
	const picked = await vscode.window.showQuickPick(installed.map(plugin => ({
		label: `${plugin.enabled ? '$(check)' : '$(circle-outline)'} ${plugin.title}`,
		description: plugin.origin === 'zcode' ? 'ZCode app' : plugin.runtime,
		detail: plugin.reason || plugin.description || plugin.sourceLabel,
		plugin,
	})), { title: 'Installed plugins', matchOnDescription: true, matchOnDetail: true });
	if (!picked) {
		return;
	}
	await actOnInstalled(picked.plugin);
}

async function actOnInstalled(plugin: InstalledView): Promise<void> {
	const enableLabel = plugin.enabled ? 'Disable' : 'Enable';
	const actions = plugin.origin === 'zcode'
		? [plugin.enabled ? 'Hide from chat' : 'Show in chat']
		: [enableLabel, 'Remove'];
	const action = await vscode.window.showQuickPick(actions, {
		title: plugin.title,
		placeHolder: plugin.reason || plugin.sourceLabel,
	});
	if (!action) {
		return;
	}
	try {
		if (action === 'Remove') {
			await removeInstalled(plugin.id);
			void vscode.window.showInformationMessage(`Removed ${plugin.title}.`);
			return;
		}
		const enabled = action === 'Enable' || action === 'Show in chat';
		await setPluginEnabled(plugin.id, enabled);
		void vscode.window.showInformationMessage(`${plugin.title} is ${enabled ? 'on' : 'off'} for the next message.`);
	} catch (err) {
		void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
	}
}

async function addIndex(): Promise<void> {
	const raw = await vscode.window.showInputBox({
		title: 'Add plugin index',
		prompt: 'http(s) URL of a format-1 index JSON file. The default community catalog is already included.',
		placeHolder: 'https://example.com/index.json',
		ignoreFocusOut: true,
	});
	if (!raw?.trim()) {
		return;
	}
	try {
		const url = await addMarketIndex(raw);
		void vscode.window.showInformationMessage(`Index added: ${url}`);
	} catch (err) {
		void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
	}
}

async function removeIndex(): Promise<void> {
	const indexes = await listMarketIndexes();
	if (!indexes.length) {
		void vscode.window.showInformationMessage('No index sources to remove.');
		return;
	}
	const picked = await vscode.window.showQuickPick(indexes.map(url => ({ label: url })), {
		title: 'Remove index source',
	});
	if (!picked) {
		return;
	}
	await removeMarketIndex(picked.label);
	void vscode.window.showInformationMessage(`Removed ${picked.label}`);
}
