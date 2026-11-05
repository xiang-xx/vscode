/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Plugin market + host shared by the ZCode brain and the Cursor brain.
 *
 * The DeepSeek market index (format 1) is the catalog. A listed package runs
 * here only when it exposes an MCP server: a `.zcode-plugin` / `.claude-plugin`
 * / `.mcp.json` manifest, or a `cordis.patch.yml` row that inserts
 * `@deepseek-ai/dsh-mcp-client` with a concrete command or URL.
 * A Cordis `apply(ctx)` bundle is recorded and not started. That code needs
 * the DeepSeek host; ZCode and Cursor both speak MCP, so the MCP declaration
 * is the part that is the same plugin for either brain.
 */

import * as fsSync from 'fs';
import { promises as fs } from 'fs';
import * as path from 'path';
import { spawnCapture } from './processUtils';
import { zcodeHomeDir } from './userInstructions';
import {
	disposeMcpClients,
	mcpCallTool,
	mcpListTools,
	type McpEndpoint,
	type McpToolInfo,
} from './pluginMcp';

/** Community catalog DSH Discover documents as a format-1 index. Third-party text. */
export const DEFAULT_MARKET_INDEX = 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json';

const INDEX_MAX_BYTES = 16 * 1024 * 1024;
const TARBALL_MAX_BYTES = 48 * 1024 * 1024;
const INDEX_CACHE_MS = 10 * 60 * 1000;
const MAX_PLUGIN_TOOLS = 128;

export interface NamedMcpServer extends McpEndpoint {
	name: string;
}

export type PluginRuntime = 'mcp' | 'dsh-only' | 'unsupported';

export type MarketSource =
	| { type: 'npm'; registry?: string }
	| { type: 'git'; url: string; commit: string; path?: string }
	| { type: 'directory'; path: string };

export interface MarketPluginCard {
	name: string;
	title: string;
	description: string;
	author?: string;
	version: string;
	enginesDsh?: string;
	source: MarketSource;
	sourceLabel: string;
}

export interface MarketIndexPage {
	title: string;
	plugins: MarketPluginCard[];
	skipped: number;
}

export interface InstalledPlugin {
	id: string;
	name: string;
	title: string;
	description: string;
	version: string;
	enabled: boolean;
	runtime: PluginRuntime;
	reason?: string;
	sourceLabel: string;
	installPath?: string;
	owned: boolean;
	servers: NamedMcpServer[];
}

export interface InstalledView {
	id: string;
	title: string;
	description: string;
	runtime: PluginRuntime | 'zcode';
	enabled: boolean;
	origin: 'chat' | 'zcode';
	reason?: string;
	sourceLabel: string;
}

interface PluginState {
	indexesInitialized: boolean;
	indexes: string[];
	plugins: InstalledPlugin[];
	suppressedExternalIds: string[];
}

export interface ChatToolDef {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

interface RoutedTool {
	exposedName: string;
	mcpName: string;
	endpoint: McpEndpoint;
	description: string;
	parameters: Record<string, unknown>;
}

interface ClassifiedPackage {
	title: string;
	description: string;
	runtime: PluginRuntime;
	reason?: string;
	servers: NamedMcpServer[];
}

let routed: RoutedTool[] = [];
let routeGeneration = '';
const indexCache = new Map<string, { at: number; page: MarketIndexPage }>();

export function chatPluginsRoot(): string {
	return path.join(zcodeHomeDir(), '.zcode', 'chat-plugins');
}

export async function listMarketIndexes(): Promise<string[]> {
	const state = await loadState();
	return [...state.indexes];
}

export async function addMarketIndex(raw: string): Promise<string> {
	const url = parseHttpUrl(raw);
	if (!url) {
		throw new Error('An index URL must be http(s), without a username, password, or #fragment.');
	}
	const state = await loadState();
	if (!state.indexes.includes(url)) {
		state.indexes.push(url);
		await saveState(state);
	}
	return url;
}

export async function removeMarketIndex(url: string): Promise<void> {
	const state = await loadState();
	state.indexes = state.indexes.filter(item => item !== url);
	await saveState(state);
	indexCache.delete(url);
}

export async function fetchMarketIndex(indexUrl: string, language: string, refresh = false): Promise<MarketIndexPage> {
	const cached = indexCache.get(indexUrl);
	if (!refresh && cached && Date.now() - cached.at < INDEX_CACHE_MS) {
		return cached.page;
	}
	const url = parseHttpUrl(indexUrl);
	if (!url) {
		throw new Error('Index URL is not usable.');
	}
	const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
	if (!response.ok) {
		throw new Error(`Index HTTP ${response.status}`);
	}
	const finalUrl = new URL(response.url);
	if (finalUrl.protocol !== 'https:' && finalUrl.protocol !== 'http:') {
		throw new Error('Index redirected to a non-http URL.');
	}
	const text = await readLimitedText(response, INDEX_MAX_BYTES);
	let value: unknown;
	try {
		value = JSON.parse(text) as unknown;
	} catch {
		throw new Error('Index is not JSON.');
	}
	const page = parseMarketIndex(value, language);
	indexCache.set(indexUrl, { at: Date.now(), page });
	return page;
}

export function findDshCheckout(folders: readonly string[]): string | undefined {
	for (const folder of folders) {
		for (const dir of [folder, path.join(folder, 'deepseek-harness')]) {
			if (fsSync.existsSync(path.join(dir, 'packages', 'boot', 'plugin-market', 'package.json'))) {
				return dir;
			}
		}
	}
	return undefined;
}

export async function scanDshCheckout(checkout: string, language: string): Promise<MarketPluginCard[]> {
	const roots = [path.join(checkout, 'packages'), path.join(checkout, 'apps')];
	const packages: string[] = [];
	for (const root of roots) {
		await collectPackageDirs(root, 0, packages);
	}
	const cards: MarketPluginCard[] = [];
	for (const dir of packages) {
		const pkg = await readJson(path.join(dir, 'package.json'));
		if (!pkg || !pkg.dsh || typeof pkg.dsh !== 'object') {
			continue;
		}
		const name = typeof pkg.name === 'string' ? pkg.name : path.basename(dir);
		const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
		const text = readPackageText(dir, pkg, language);
		cards.push({
			name,
			title: text.title,
			description: text.description,
			version,
			source: { type: 'directory', path: dir },
			sourceLabel: dir,
		});
	}
	cards.sort((a, b) => a.title.localeCompare(b.title));
	return cards;
}

export async function installMarketCard(card: MarketPluginCard, language: string): Promise<InstalledPlugin> {
	if (card.source.type === 'directory') {
		return saveClassified(card, card.source.path, false, await classifyPackage(card.source.path, language));
	}
	const staging = path.join(chatPluginsRoot(), 'tmp', `${Date.now()}-${sanitizeId(card.name)}`);
	await fs.mkdir(staging, { recursive: true });
	try {
		const packed = await stagePackage(card, staging);
		const classified = await classifyPackage(packed.root, language);
		const keepFiles = classified.servers.some(server => serverNeedsFiles(server, packed.root));
		let installPath: string | undefined;
		let owned = false;
		if (keepFiles) {
			const dest = path.join(chatPluginsRoot(), 'packages', sanitizeId(card.name), card.version);
			await fs.rm(dest, { recursive: true, force: true });
			await fs.mkdir(path.dirname(dest), { recursive: true });
			await fs.rename(packed.root, dest);
			installPath = dest;
			owned = true;
			rewritePluginRoots(classified.servers, dest);
		}
		return await saveClassified(card, installPath, owned, classified);
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
	}
}

export async function installDirectory(dir: string, language: string): Promise<InstalledPlugin> {
	const resolved = path.resolve(dir);
	const pkg = await readJson(path.join(resolved, 'package.json'));
	const name = pkg && typeof pkg.name === 'string' ? pkg.name : path.basename(resolved);
	const version = pkg && typeof pkg.version === 'string' ? pkg.version : '0.0.0';
	const text = pkg ? readPackageText(resolved, pkg, language) : { title: name, description: '' };
	const card: MarketPluginCard = {
		name,
		title: text.title,
		description: text.description,
		version,
		source: { type: 'directory', path: resolved },
		sourceLabel: resolved,
	};
	return saveClassified(card, resolved, false, await classifyPackage(resolved, language));
}

export async function listInstalled(): Promise<InstalledView[]> {
	const state = await loadState();
	const own: InstalledView[] = state.plugins.map(plugin => ({
		id: plugin.id,
		title: plugin.title,
		description: plugin.description,
		runtime: plugin.runtime,
		enabled: plugin.enabled,
		origin: 'chat',
		reason: plugin.reason,
		sourceLabel: plugin.sourceLabel,
	}));
	const external = await readZcodePlugins(state.suppressedExternalIds);
	return [...own, ...external];
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
	const state = await loadState();
	const plugin = state.plugins.find(item => item.id === id);
	if (!plugin) {
		if (enabled) {
			state.suppressedExternalIds = state.suppressedExternalIds.filter(item => item !== id);
		} else if (!state.suppressedExternalIds.includes(id)) {
			state.suppressedExternalIds.push(id);
		}
		await saveState(state);
		invalidatePluginTools();
		return;
	}
	if (enabled && plugin.runtime !== 'mcp') {
		throw new Error(plugin.reason || 'This plugin has no MCP server, so it cannot run in ZCode or Cursor.');
	}
	const missing = enabled ? missingServerEnv(plugin.servers) : undefined;
	if (missing) {
		throw new Error(`Set ${missing} in the environment, then enable the plugin again.`);
	}
	plugin.enabled = enabled;
	await saveState(state);
	invalidatePluginTools();
}

export async function removeInstalled(id: string): Promise<void> {
	const state = await loadState();
	const plugin = state.plugins.find(item => item.id === id);
	if (!plugin) {
		throw new Error('That plugin is installed by the ZCode app. Disable it there, or hide it from chat.');
	}
	state.plugins = state.plugins.filter(item => item.id !== id);
	await saveState(state);
	invalidatePluginTools();
	if (plugin.owned && plugin.installPath && isUnderPluginsRoot(plugin.installPath)) {
		await fs.rm(plugin.installPath, { recursive: true, force: true });
	}
}

export function cachedPluginToolDefs(): ChatToolDef[] {
	return routed.map(tool => ({
		type: 'function' as const,
		function: {
			name: tool.exposedName,
			description: tool.description,
			parameters: tool.parameters,
		},
	}));
}

export async function refreshPluginTools(): Promise<void> {
	const endpoints = await collectEndpoints();
	const generation = JSON.stringify(endpoints.map(item => ({
		name: item.exposedServer,
		endpoint: item.endpoint,
	})));
	if (generation === routeGeneration && (routed.length > 0 || endpoints.length === 0)) {
		return;
	}
	const next: RoutedTool[] = [];
	const used = new Set<string>();
	const errors: string[] = [];
	for (const item of endpoints) {
		if (next.length >= MAX_PLUGIN_TOOLS) {
			break;
		}
		let tools: McpToolInfo[];
		try {
			tools = await mcpListTools(item.endpoint, 20000);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`${item.label}: ${message}`);
			continue;
		}
		for (const tool of tools) {
			if (next.length >= MAX_PLUGIN_TOOLS) {
				break;
			}
			const exposedName = uniqueToolName(item.serverName, tool.name, used);
			used.add(exposedName);
			const schema = tool.inputSchema && tool.inputSchema.type === 'object'
				? tool.inputSchema
				: { type: 'object', properties: tool.inputSchema?.properties ?? {}, required: tool.inputSchema?.required };
			next.push({
				exposedName,
				mcpName: tool.name,
				endpoint: item.endpoint,
				description: `${item.label}: ${tool.description || tool.name}`.slice(0, 500),
				parameters: schema,
			});
		}
	}
	if (!next.length && errors.length) {
		throw new Error(errors[0]);
	}
	routed = next;
	routeGeneration = generation;
}

export async function callPluginTool(
	name: string,
	args: Record<string, unknown>,
): Promise<{ summary: string; content: string; detail?: string } | undefined> {
	const route = routed.find(tool => tool.exposedName === name);
	if (!route) {
		return undefined;
	}
	try {
		const text = await mcpCallTool(route.endpoint, route.mcpName, args, 60000);
		const clipped = text.length > 80_000 ? `${text.slice(0, 80_000)}\n…(truncated)` : text;
		return {
			summary: name,
			content: clipped || '(empty)',
			detail: clipped.slice(0, 4000),
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { summary: `${name} failed`, content: `Error: ${message}` };
	}
}

export async function sharedMcpServers(): Promise<NamedMcpServer[]> {
	return (await collectEndpoints()).map(item => ({
		...expandEndpoint(item.endpoint),
		name: item.exposedServer,
	}));
}

export function disposePluginHosts(): void {
	invalidatePluginTools();
}

export function extractDshMcpServers(yaml: string): { servers: NamedMcpServer[]; skipped: string[] } {
	const rows: { indent: number; text: string }[] = [];
	for (const raw of yaml.split(/\r?\n/)) {
		const stripped = stripYamlComment(raw);
		if (!stripped.trim()) {
			continue;
		}
		rows.push({ indent: stripped.match(/^ */)?.[0].length ?? 0, text: stripped.trim() });
	}
	const servers: NamedMcpServer[] = [];
	const skipped: string[] = [];
	for (let i = 0; i < rows.length; i++) {
		if (!rows[i].text.startsWith('- ')) {
			continue;
		}
		const itemIndent = rows[i].indent;
		const chunk = [{ indent: itemIndent, text: rows[i].text.slice(2).trim() }];
		let j = i + 1;
		while (j < rows.length && rows[j].indent > itemIndent) {
			chunk.push(rows[j]);
			j++;
		}
		if (chunk.slice(1).some(row => row.text.startsWith('- '))) {
			continue;
		}
		if (!chunk.some(row => row.text.includes('dsh-mcp-client'))) {
			continue;
		}
		const fields = parseYamlFields(chunk);
		const built = mcpServerFromFields(fields);
		if (built.server) {
			servers.push(built.server);
		} else if (built.skip) {
			skipped.push(built.skip);
		}
	}
	return { servers, skipped };
}

function invalidatePluginTools(): void {
	routed = [];
	routeGeneration = '';
	disposeMcpClients();
}

async function saveClassified(
	card: MarketPluginCard,
	installPath: string | undefined,
	owned: boolean,
	classified: ClassifiedPackage,
): Promise<InstalledPlugin> {
	const missing = missingServerEnv(classified.servers);
	const enabled = classified.runtime === 'mcp' && !missing;
	const reason = classified.runtime === 'mcp' && missing
		? `Needs ${missing} in the environment before it can start.`
		: classified.reason;
	const plugin: InstalledPlugin = {
		id: sanitizeId(card.name),
		name: card.name,
		title: classified.title || card.title,
		description: classified.description || card.description,
		version: card.version,
		enabled,
		runtime: classified.runtime,
		reason,
		sourceLabel: card.sourceLabel,
		installPath,
		owned,
		servers: classified.servers,
	};
	const state = await loadState();
	state.plugins = state.plugins.filter(item => item.id !== plugin.id);
	state.plugins.push(plugin);
	await saveState(state);
	invalidatePluginTools();
	return plugin;
}

async function stagePackage(card: MarketPluginCard, staging: string): Promise<{ root: string }> {
	if (card.source.type === 'npm') {
		const registry = (card.source.registry ?? 'https://registry.npmjs.org').replace(/\/$/, '');
		if (!parseHttpUrl(registry)) {
			throw new Error('Package registry URL is not usable.');
		}
		const spec = `${registry}/${encodeNpmName(card.name)}/${encodeURIComponent(card.version)}`;
		const response = await fetch(spec, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
		if (!response.ok) {
			throw new Error(`Registry HTTP ${response.status} for ${card.name}@${card.version}`);
		}
		const meta = await response.json() as { dist?: { tarball?: string } };
		const tarball = meta.dist?.tarball;
		if (!tarball || !parseHttpUrl(tarball)) {
			throw new Error('Registry entry has no https tarball.');
		}
		const archive = path.join(staging, 'package.tgz');
		await downloadFile(tarball, archive, TARBALL_MAX_BYTES);
		const extracted = path.join(staging, 'extract');
		await extractArchive(archive, extracted);
		return { root: await locatePackageRoot(extracted) };
	}
	if (card.source.type === 'git') {
		const github = githubArchive(card.source.url, card.source.commit);
		if (!github) {
			throw new Error('This Git source is not a GitHub commit. Clone it, then use Install a plugin from a folder.');
		}
		const archive = path.join(staging, 'source.tar.gz');
		await downloadFile(github, archive, TARBALL_MAX_BYTES);
		const extracted = path.join(staging, 'extract');
		await extractArchive(archive, extracted);
		return { root: await locatePackageRoot(extracted, card.source.path) };
	}
	throw new Error('Nothing to download.');
}

async function classifyPackage(root: string, language: string): Promise<ClassifiedPackage> {
	const pkg = await readJson(path.join(root, 'package.json'));
	const text = pkg ? readPackageText(root, pkg, language) : { title: path.basename(root), description: '' };
	const servers: NamedMcpServer[] = [];
	const notes: string[] = [];
	for (const manifestPath of manifestFiles(root)) {
		const manifest = await readJson(manifestPath);
		if (!manifest) {
			continue;
		}
		servers.push(...serversFromManifest(manifest, root));
	}
	const patchPath = pkg && pkg.dsh && typeof pkg.dsh === 'object'
		? path.resolve(root, typeof (pkg.dsh as { bundle?: { patch?: string } }).bundle?.patch === 'string'
			? (pkg.dsh as { bundle: { patch: string } }).bundle.patch
			: 'cordis.patch.yml')
		: path.join(root, 'cordis.patch.yml');
	if (isInside(root, patchPath)) {
		try {
			const yaml = await fs.readFile(patchPath, 'utf8');
			const extracted = extractDshMcpServers(yaml);
			servers.push(...extracted.servers.map(server => bindRoot(server, root)));
			notes.push(...extracted.skipped);
		} catch {
			// no patch
		}
	}
	const unique = dedupeServers(servers);
	if (unique.length) {
		return {
			title: text.title,
			description: text.description,
			runtime: 'mcp',
			reason: notes.length ? notes.join(' ') : undefined,
			servers: unique,
		};
	}
	const dsh = Boolean(pkg && pkg.dsh && typeof pkg.dsh === 'object');
	if (dsh) {
		return {
			title: text.title,
			description: text.description,
			runtime: 'dsh-only',
			reason: 'Cordis plugin: it runs inside DeepSeek Harness. It does not declare an MCP server, so ZCode and Cursor cannot start it.',
			servers: [],
		};
	}
	return {
		title: text.title,
		description: text.description,
		runtime: 'unsupported',
		reason: 'No MCP server and no DeepSeek bundle were found.',
		servers: [],
	};
}

function manifestFiles(root: string): string[] {
	return [
		path.join(root, '.zcode-plugin', 'plugin.json'),
		path.join(root, '.claude-plugin', 'plugin.json'),
		path.join(root, '.codex-plugin', 'plugin.json'),
		path.join(root, '.mcp.json'),
		path.join(root, 'chat-plugin.json'),
	];
}

function serversFromManifest(manifest: Record<string, unknown>, root: string): NamedMcpServer[] {
	let table: unknown = manifest.mcpServers;
	if (typeof table === 'string') {
		const file = path.resolve(root, table);
		if (!isInside(root, file)) {
			return [];
		}
		const nested = readJsonSync(file);
		table = nested && nested.mcpServers ? nested.mcpServers : nested;
	}
	if (!table || typeof table !== 'object' || Array.isArray(table)) {
		return [];
	}
	const servers: NamedMcpServer[] = [];
	for (const [name, raw] of Object.entries(table as Record<string, unknown>)) {
		if (!raw || typeof raw !== 'object') {
			continue;
		}
		const rec = raw as Record<string, unknown>;
		const args = stringList(rec.args)?.map(arg => substituteRoot(arg, root));
		if (typeof rec.command === 'string' && safeCommand(rec.command)) {
			if (args?.some(arg => !safeArg(arg))) {
				continue;
			}
			const command = substituteRoot(rec.command, root);
			const needsCwd = [command, ...(args ?? [])].some(value => value.startsWith('.') || isInside(root, value));
			servers.push({
				name: sanitizeServerName(name),
				type: 'stdio',
				command,
				args,
				cwd: needsCwd ? root : undefined,
			});
			continue;
		}
		if (typeof rec.url === 'string' && safeMcpUrl(rec.url)) {
			servers.push({
				name: sanitizeServerName(name),
				type: 'http',
				url: rec.url,
			});
		}
	}
	return servers;
}

function bindRoot(server: NamedMcpServer, root: string): NamedMcpServer {
	const command = server.command ? substituteRoot(server.command, root) : undefined;
	const args = server.args?.map(arg => substituteRoot(arg, root));
	const needsCwd = [command, ...(args ?? [])].some(value => !!value && (value.startsWith('.') || isInside(root, value)));
	return {
		...server,
		command,
		args,
		cwd: needsCwd ? (server.cwd || root) : server.cwd,
	};
}

function substituteRoot(value: string, root: string): string {
	return value
		.replaceAll('${ZCODE_PLUGIN_ROOT}', root)
		.replaceAll('${CLAUDE_PLUGIN_ROOT}', root)
		.replaceAll('${PLUGIN_ROOT}', root);
}

function serverNeedsFiles(server: NamedMcpServer, root: string): boolean {
	const blobs = [server.command, ...(server.args ?? []), server.cwd].filter((value): value is string => !!value);
	return blobs.some(value => value.startsWith('.') || (path.isAbsolute(value) && isInside(root, value)));
}

function rewritePluginRoots(servers: NamedMcpServer[], root: string): void {
	for (const server of servers) {
		const bound = bindRoot(server, root);
		server.command = bound.command;
		server.args = bound.args;
		server.cwd = bound.cwd;
	}
}

async function collectEndpoints(): Promise<Array<{ exposedServer: string; serverName: string; label: string; endpoint: McpEndpoint }>> {
	const state = await loadState();
	const out: Array<{ exposedServer: string; serverName: string; label: string; endpoint: McpEndpoint }> = [];
	for (const plugin of state.plugins) {
		if (!plugin.enabled || plugin.runtime !== 'mcp') {
			continue;
		}
		for (const server of plugin.servers) {
			out.push({
				exposedServer: `plugin_${plugin.id}_${server.name}`.slice(0, 48),
				serverName: server.name,
				label: plugin.title,
				endpoint: serverEndpoint(server),
			});
		}
	}
	for (const external of await readZcodeServerRecords(state.suppressedExternalIds)) {
		out.push(external);
	}
	return out;
}

function serverEndpoint(server: NamedMcpServer): McpEndpoint {
	return {
		type: server.type,
		command: server.command,
		args: server.args,
		cwd: server.cwd,
		env: server.env,
		url: server.url,
	};
}

function expandEndpoint(endpoint: McpEndpoint): McpEndpoint {
	const expand = (value: string) => value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_all, name: string) => process.env[name] ?? '');
	const env = { ...endpoint.env };
	for (const blob of [endpoint.command, ...(endpoint.args ?? []), endpoint.url]) {
		if (!blob) {
			continue;
		}
		for (const match of blob.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
			const value = process.env[match[1]];
			if (value && !env[match[1]]) {
				env[match[1]] = value;
			}
		}
	}
	return {
		...endpoint,
		command: endpoint.command ? expand(endpoint.command) : undefined,
		args: endpoint.args?.map(expand),
		url: endpoint.url ? expand(endpoint.url) : undefined,
		env: Object.keys(env).length ? env : undefined,
	};
}

async function readZcodePlugins(suppressed: readonly string[]): Promise<InstalledView[]> {
	const records = await readZcodeInstalled();
	const enabled = await readZcodeEnabled();
	const views: InstalledView[] = [];
	for (const record of records) {
		if (enabled.get(record.id) !== true) {
			continue;
		}
		const classified = await classifyQuiet(record.installPath);
		if (!classified || !classified.servers.length) {
			continue;
		}
		views.push({
			id: record.id,
			title: classified.title,
			description: classified.description,
			runtime: 'zcode',
			enabled: !suppressed.includes(record.id),
			origin: 'zcode',
			reason: 'Installed by the ZCode app. Chat uses its MCP server.',
			sourceLabel: record.installPath,
		});
	}
	return views;
}

async function readZcodeServerRecords(suppressed: readonly string[]): Promise<Array<{ exposedServer: string; serverName: string; label: string; endpoint: McpEndpoint }>> {
	const views = await readZcodePlugins(suppressed);
	const out: Array<{ exposedServer: string; serverName: string; label: string; endpoint: McpEndpoint }> = [];
	for (const view of views) {
		if (!view.enabled) {
			continue;
		}
		const classified = await classifyQuiet(view.sourceLabel);
		if (!classified) {
			continue;
		}
		for (const server of classified.servers) {
			out.push({
				exposedServer: `zcode_${sanitizeId(view.id)}_${server.name}`.slice(0, 48),
				serverName: server.name,
				label: view.title,
				endpoint: serverEndpoint(server),
			});
		}
	}
	return out;
}

async function classifyQuiet(dir: string): Promise<ClassifiedPackage | undefined> {
	try {
		await fs.access(path.join(dir, 'package.json'));
	} catch {
		try {
			await fs.access(dir);
		} catch {
			return undefined;
		}
	}
	try {
		return await classifyPackage(dir, 'en');
	} catch {
		return undefined;
	}
}

interface ZcodeInstallRecord {
	id: string;
	installPath: string;
}

async function readZcodeInstalled(): Promise<ZcodeInstallRecord[]> {
	const file = path.join(zcodeHomeDir(), '.zcode', 'cli', 'plugins', 'installed_plugins.json');
	const json = await readJson(file);
	const plugins = json?.plugins;
	if (!Array.isArray(plugins)) {
		return [];
	}
	const out: ZcodeInstallRecord[] = [];
	for (const item of plugins) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const rec = item as { id?: unknown; installPath?: unknown };
		if (typeof rec.id === 'string' && typeof rec.installPath === 'string') {
			out.push({ id: rec.id, installPath: rec.installPath });
		}
	}
	return out;
}

async function readZcodeEnabled(): Promise<Map<string, boolean>> {
	const file = path.join(zcodeHomeDir(), '.zcode', 'cli', 'config.json');
	const json = await readJson(file);
	const enabled = (json?.plugins as { enabledPlugins?: unknown } | undefined)?.enabledPlugins;
	const map = new Map<string, boolean>();
	if (!enabled || typeof enabled !== 'object') {
		return map;
	}
	for (const [id, value] of Object.entries(enabled as Record<string, unknown>)) {
		if (typeof value === 'boolean') {
			map.set(id, value);
		}
	}
	return map;
}

function parseMarketIndex(value: unknown, language: string): MarketIndexPage {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Index must be a JSON object.');
	}
	const doc = value as { format?: unknown; title?: unknown; plugins?: unknown };
	if (doc.format !== 1) {
		throw new Error('Index format must be 1.');
	}
	if (!Array.isArray(doc.plugins)) {
		throw new Error('Index is missing plugins.');
	}
	const title = localized(doc.title, language) || 'Plugin index';
	const plugins: MarketPluginCard[] = [];
	let skipped = 0;
	for (const entry of doc.plugins) {
		const card = parseMarketPlugin(entry, language);
		if (card) {
			plugins.push(card);
		} else {
			skipped++;
		}
	}
	if (!plugins.length) {
		throw new Error('Index has no installable plugins.');
	}
	return { title, plugins, skipped };
}

function parseMarketPlugin(entry: unknown, language: string): MarketPluginCard | undefined {
	if (!entry || typeof entry !== 'object') {
		return undefined;
	}
	const plugin = entry as {
		name?: unknown;
		title?: unknown;
		description?: unknown;
		author?: unknown;
		versions?: unknown;
	};
	if (typeof plugin.name !== 'string' || !plugin.name.trim()) {
		return undefined;
	}
	if (!Array.isArray(plugin.versions) || !plugin.versions.length) {
		return undefined;
	}
	const versions = plugin.versions
		.map(parseMarketVersion)
		.filter((item): item is ParsedVersion => !!item);
	if (!versions.length) {
		return undefined;
	}
	versions.sort((a, b) => compareSemver(b.version, a.version));
	const chosen = versions.find(item => !item.pre) ?? versions[0];
	const sourceLabel = chosen.source.type === 'npm'
		? `npm ${plugin.name}@${chosen.version}${chosen.source.registry ? ` (${chosen.source.registry})` : ''}`
		: `git ${chosen.source.url} @ ${chosen.source.commit.slice(0, 12)}${chosen.source.path ? ` ${chosen.source.path}` : ''}`;
	return {
		name: plugin.name,
		title: localized(plugin.title, language) || plugin.name,
		description: localized(plugin.description, language),
		author: typeof plugin.author === 'string' ? plugin.author : undefined,
		version: chosen.version,
		enginesDsh: chosen.enginesDsh,
		source: chosen.source,
		sourceLabel,
	};
}

interface ParsedVersion {
	version: string;
	pre: boolean;
	source: Exclude<MarketSource, { type: 'directory' }>;
	enginesDsh?: string;
}

function parseMarketVersion(entry: unknown): ParsedVersion | undefined {
	if (!entry || typeof entry !== 'object') {
		return undefined;
	}
	const version = entry as { version?: unknown; source?: unknown; engines?: unknown };
	if (typeof version.version !== 'string') {
		return undefined;
	}
	const semver = semverOf(version.version);
	if (!semver) {
		return undefined;
	}
	const source = parseMarketSource(version.source);
	if (!source) {
		return undefined;
	}
	const engines = version.engines && typeof version.engines === 'object'
		? (version.engines as { dsh?: unknown }).dsh
		: undefined;
	return {
		version: version.version,
		pre: semver.pre,
		source,
		enginesDsh: typeof engines === 'string' ? engines : undefined,
	};
}

function parseMarketSource(source: unknown): Exclude<MarketSource, { type: 'directory' }> | undefined {
	if (!source || typeof source !== 'object') {
		return undefined;
	}
	const rec = source as { type?: unknown; registry?: unknown; url?: unknown; commit?: unknown; path?: unknown };
	if (rec.type === 'npm') {
		if (rec.registry !== undefined && (typeof rec.registry !== 'string' || !parseHttpUrl(rec.registry))) {
			return undefined;
		}
		return { type: 'npm', registry: typeof rec.registry === 'string' ? rec.registry : undefined };
	}
	if (rec.type === 'git') {
		if (typeof rec.url !== 'string' || !parseHttpUrl(rec.url)) {
			return undefined;
		}
		if (typeof rec.commit !== 'string' || !/^[0-9a-f]{40}$/.test(rec.commit)) {
			return undefined;
		}
		if (rec.path !== undefined && (typeof rec.path !== 'string' || rec.path.split('/').includes('..'))) {
			return undefined;
		}
		return { type: 'git', url: rec.url, commit: rec.commit, path: typeof rec.path === 'string' ? rec.path : undefined };
	}
	return undefined;
}

function mcpServerFromFields(fields: Map<string, string | string[]>): { server?: NamedMcpServer; skip?: string } {
	const transport = scalar(fields.get('transport'));
	const serverName = sanitizeServerName(scalar(fields.get('serverName')) || 'mcp');
	const command = scalar(fields.get('command'));
	const url = scalar(fields.get('url'));
	const argsField = fields.get('args');
	const args = Array.isArray(argsField) ? argsField : undefined;
	const wantsStdio = transport === 'stdio' || (!transport && !!command && !url);
	if (wantsStdio) {
		if (!command || !safeCommand(command)) {
			return { skip: `${serverName}: command is missing` };
		}
		if (args?.some(arg => !safeArg(arg) || looksPlaceholder(arg))) {
			return { skip: `${serverName}: arguments still look like a placeholder` };
		}
		return { server: { name: serverName, type: 'stdio', command, args } };
	}
	const wantsHttp = transport === 'streamable-http' || transport === 'http' || transport === 'sse' || (!transport && !!url);
	if (wantsHttp) {
		if (!url || !safeMcpUrl(url)) {
			return { skip: `${serverName}: URL is missing or not https` };
		}
		return { server: { name: serverName, type: 'http', url } };
	}
	return { skip: `${serverName}: transport is not stdio or http` };
}

function parseYamlFields(rows: { indent: number; text: string }[]): Map<string, string | string[]> {
	const out = new Map<string, string | string[]>();
	for (let i = 0; i < rows.length; i++) {
		const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(rows[i].text);
		if (!match) {
			continue;
		}
		const key = match[1];
		const rest = match[2].trim();
		if (rest.startsWith('!!') || rest.startsWith('{')) {
			continue;
		}
		if (!rest) {
			const items: string[] = [];
			const base = rows[i].indent;
			while (i + 1 < rows.length && rows[i + 1].indent > base && rows[i + 1].text.startsWith('- ')) {
				const item = unquote(rows[i + 1].text.slice(2).trim());
				if (item && !item.startsWith('!!')) {
					items.push(item);
				}
				i++;
			}
			if (items.length) {
				out.set(key, items);
			}
			continue;
		}
		if (rest.startsWith('[')) {
			const seq = parseFlowSequence(rest);
			if (seq) {
				out.set(key, seq);
			}
			continue;
		}
		out.set(key, unquote(rest));
	}
	return out;
}

function parseFlowSequence(value: string): string[] | undefined {
	if (!value.endsWith(']')) {
		return undefined;
	}
	const inner = value.slice(1, -1).trim();
	if (!inner) {
		return [];
	}
	return inner.split(',').map(part => unquote(part.trim())).filter(Boolean);
}

function stripYamlComment(line: string): string {
	let quote: string | undefined;
	let out = '';
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quote) {
			out += ch;
			if (ch === quote && line[i - 1] !== '\\') {
				quote = undefined;
			}
			continue;
		}
		if (ch === '"' || ch === '\'') {
			quote = ch;
			out += ch;
			continue;
		}
		if (ch === '#') {
			break;
		}
		out += ch;
	}
	return out;
}

function unquote(value: string): string {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
		return value.slice(1, -1);
	}
	return value;
}

function scalar(value: string | string[] | undefined): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
		return undefined;
	}
	return value as string[];
}

function safeCommand(command: string): boolean {
	return /^[A-Za-z0-9._+:@/\\-]+$/.test(command) && !command.includes('..');
}

function safeArg(arg: string): boolean {
	return arg.length > 0 && arg.length <= 400 && !/[\0\r\n]/.test(arg);
}

function looksPlaceholder(arg: string): boolean {
	return /path\/to|YOUR_|<[^>]+>|change-me|C:\\path/i.test(arg);
}

function safeMcpUrl(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol === 'https:') {
		return true;
	}
	if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
		return true;
	}
	return false;
}

function missingServerEnv(servers: readonly NamedMcpServer[]): string | undefined {
	for (const server of servers) {
		for (const blob of [server.command, ...(server.args ?? []), server.url]) {
			if (!blob) {
				continue;
			}
			for (const match of blob.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
				if (!process.env[match[1]]) {
					return match[1];
				}
			}
		}
	}
	return undefined;
}

function dedupeServers(servers: NamedMcpServer[]): NamedMcpServer[] {
	const seen = new Set<string>();
	const out: NamedMcpServer[] = [];
	for (const server of servers) {
		const key = `${server.type}:${server.name}:${server.command ?? ''}:${server.url ?? ''}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		out.push(server);
	}
	return out;
}

function uniqueToolName(server: string, tool: string, used: Set<string>): string {
	const base = `mcp_${sanitizeId(server)}__${sanitizeId(tool)}`.slice(0, 64);
	let name = base || 'mcp_tool';
	let n = 2;
	while (used.has(name)) {
		name = `${base.slice(0, 58)}_${n++}`;
	}
	return name;
}

function readPackageText(root: string, pkg: Record<string, unknown>, language: string): { title: string; description: string } {
	const name = typeof pkg.name === 'string' ? pkg.name : path.basename(root);
	const localeFile = language.toLowerCase().startsWith('zh') ? 'zh.json' : 'en.json';
	const locale = readJsonSync(path.join(root, 'locale', localeFile))
		?? readJsonSync(path.join(root, 'locale', 'en.json'));
	const meta = locale?.meta && typeof locale.meta === 'object' ? locale.meta as { title?: unknown; description?: unknown } : undefined;
	const title = typeof meta?.title === 'string' && meta.title.trim() ? meta.title.trim() : name;
	const description = typeof meta?.description === 'string' && meta.description.trim()
		? meta.description.trim()
		: (typeof pkg.description === 'string' ? pkg.description : '');
	return { title, description };
}

async function collectPackageDirs(dir: string, depth: number, out: string[]): Promise<void> {
	if (depth > 5) {
		return;
	}
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) {
			continue;
		}
		const child = path.join(dir, entry.name);
		try {
			await fs.access(path.join(child, 'package.json'));
			out.push(child);
		} catch {
			await collectPackageDirs(child, depth + 1, out);
		}
	}
}

async function extractArchive(archive: string, dest: string): Promise<void> {
	await fs.mkdir(dest, { recursive: true });
	const listed = await spawnCapture('tar', ['-tzf', archive], dest, 20000);
	if (listed.code !== 0) {
		throw new Error(listed.stderr.trim() || 'Could not read the package archive.');
	}
	for (const line of listed.stdout.split('\n')) {
		if (line && tarEntryUnsafe(line)) {
			throw new Error(`Archive path refused: ${line}`);
		}
	}
	const extracted = await spawnCapture('tar', ['-xzf', archive, '-C', dest, '--strip-components=1'], dest, 60000);
	if (extracted.code !== 0) {
		throw new Error(extracted.stderr.trim() || 'Could not extract the package archive.');
	}
}

function tarEntryUnsafe(entry: string): boolean {
	const normalized = entry.replace(/\\/g, '/');
	if (normalized.startsWith('/') || normalized.includes('\0')) {
		return true;
	}
	return normalized.split('/').some(part => part === '..');
}

async function locatePackageRoot(dest: string, subpath?: string): Promise<string> {
	const base = subpath ? path.resolve(dest, subpath) : dest;
	if (!isInside(dest, base) && path.resolve(base) !== path.resolve(dest)) {
		throw new Error('Package path escapes the archive.');
	}
	try {
		await fs.access(path.join(base, 'package.json'));
		return base;
	} catch {
		// A single top-level directory remains when strip did not apply.
	}
	const entries = await fs.readdir(dest, { withFileTypes: true });
	const dirs = entries.filter(entry => entry.isDirectory());
	if (dirs.length === 1) {
		const nested = path.resolve(dest, dirs[0].name, subpath ?? '');
		if (!isInside(dest, nested)) {
			throw new Error('Package path escapes the archive.');
		}
		await fs.access(path.join(nested, 'package.json'));
		return nested;
	}
	throw new Error('Archive has no package.json.');
}

async function downloadFile(url: string, dest: string, maxBytes: number): Promise<void> {
	const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
	if (!response.ok || !response.body) {
		throw new Error(`Download HTTP ${response.status}`);
	}
	const reader = response.body.getReader();
	const handle = await fs.open(dest, 'w');
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			total += value.byteLength;
			if (total > maxBytes) {
				throw new Error('Package is larger than 48MB.');
			}
			await handle.write(value);
		}
	} finally {
		await handle.close();
	}
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) {
		const text = await response.text();
		if (Buffer.byteLength(text) > maxBytes) {
			throw new Error('Index is too large.');
		}
		return text;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new Error('Index is too large.');
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString('utf8');
}

function githubArchive(repoUrl: string, commit: string): string | undefined {
	let url: URL;
	try {
		url = new URL(repoUrl);
	} catch {
		return undefined;
	}
	if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
		return undefined;
	}
	const parts = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
	if (parts.length < 2) {
		return undefined;
	}
	return `https://codeload.github.com/${parts[0]}/${parts[1]}/tar.gz/${commit}`;
}

function encodeNpmName(name: string): string {
	return name.startsWith('@') ? `@${name.slice(1).replace('/', '%2f')}` : encodeURIComponent(name);
}

function parseHttpUrl(raw: string): string | undefined {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return undefined;
	}
	if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.hash) {
		return undefined;
	}
	return url.toString();
}

function localized(value: unknown, language: string): string {
	if (typeof value === 'string') {
		return value.trim();
	}
	if (!value || typeof value !== 'object') {
		return '';
	}
	const rec = value as Record<string, unknown>;
	const prefer = language.toLowerCase().startsWith('zh')
		? ['zh', 'zh-cn', 'zh-CN', 'en']
		: ['en', 'zh'];
	for (const key of prefer) {
		const text = rec[key];
		if (typeof text === 'string' && text.trim()) {
			return text.trim();
		}
	}
	for (const text of Object.values(rec)) {
		if (typeof text === 'string' && text.trim()) {
			return text.trim();
		}
	}
	return '';
}

interface SemverParts {
	nums: [number, number, number];
	pre: boolean;
	preId: string;
}

function semverOf(version: string): SemverParts | undefined {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version);
	if (!match) {
		return undefined;
	}
	return {
		nums: [Number(match[1]), Number(match[2]), Number(match[3])],
		pre: Boolean(match[4]),
		preId: match[4] ?? '',
	};
}

function compareSemver(a: string, b: string): number {
	const left = semverOf(a);
	const right = semverOf(b);
	if (!left || !right) {
		return a.localeCompare(b);
	}
	for (let i = 0; i < 3; i++) {
		if (left.nums[i] !== right.nums[i]) {
			return left.nums[i] - right.nums[i];
		}
	}
	if (left.pre !== right.pre) {
		return left.pre ? -1 : 1;
	}
	return left.preId.localeCompare(right.preId);
}

function sanitizeId(value: string): string {
	const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
	return cleaned.slice(0, 48) || 'plugin';
}

function sanitizeServerName(value: string): string {
	const cleaned = value.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
	return cleaned.slice(0, 32) || 'mcp';
}

function isInside(root: string, target: string): boolean {
	const base = path.resolve(root);
	const resolved = path.resolve(target);
	return resolved === base || resolved.startsWith(base + path.sep);
}

function isUnderPluginsRoot(target: string): boolean {
	return isInside(chatPluginsRoot(), target);
}

async function loadState(): Promise<PluginState> {
	const file = path.join(chatPluginsRoot(), 'state.json');
	try {
		const raw = await fs.readFile(file, 'utf8');
		const parsed = JSON.parse(raw) as Partial<PluginState>;
		return {
			indexesInitialized: parsed.indexesInitialized === true,
			indexes: Array.isArray(parsed.indexes) ? parsed.indexes.filter((item): item is string => typeof item === 'string') : [],
			plugins: Array.isArray(parsed.plugins) ? parsed.plugins.filter(isInstalledPlugin) : [],
			suppressedExternalIds: Array.isArray(parsed.suppressedExternalIds)
				? parsed.suppressedExternalIds.filter((item): item is string => typeof item === 'string')
				: [],
		};
	} catch {
		const initial: PluginState = {
			indexesInitialized: true,
			indexes: [DEFAULT_MARKET_INDEX],
			plugins: [],
			suppressedExternalIds: [],
		};
		await saveState(initial);
		return initial;
	}
}

async function saveState(state: PluginState): Promise<void> {
	const root = chatPluginsRoot();
	await fs.mkdir(root, { recursive: true });
	const tmp = path.join(root, `.state.${process.pid}.json`);
	await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
	await fs.rename(tmp, path.join(root, 'state.json'));
}

function isInstalledPlugin(value: unknown): value is InstalledPlugin {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const plugin = value as InstalledPlugin;
	return typeof plugin.id === 'string'
		&& typeof plugin.name === 'string'
		&& (plugin.runtime === 'mcp' || plugin.runtime === 'dsh-only' || plugin.runtime === 'unsupported')
		&& Array.isArray(plugin.servers);
}

function readJsonSync(file: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(fsSync.readFileSync(file, 'utf8')) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
	try {
		return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}
