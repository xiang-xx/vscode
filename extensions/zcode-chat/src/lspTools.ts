/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * LSP navigation tools ported from dsh's `lsp` tool family onto VS Code's
 * built-in language providers. Lines and characters are 1-based in both the
 * tool arguments and the formatted output.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { ToolExecResult } from './browserTools';

const MAX_ITEMS = 50;

function positionSchema(extra: Record<string, unknown> = {}) {
	return {
		type: 'object' as const,
		properties: {
			file: { type: 'string', description: 'File path (absolute or workspace-relative).' },
			line: { type: 'number', description: '1-based line number.' },
			character: { type: 'number', description: '1-based column number.' },
			...extra,
		},
		required: ['file', 'line', 'character'],
	};
}

export const LSP_TOOL_DEFS = [
	{
		type: 'function' as const,
		function: {
			name: 'lsp_definition',
			description:
				'Go to definition: resolve where the symbol at file:line:character is defined. More precise and cheaper than grep.',
			parameters: positionSchema(),
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'lsp_type_definition',
			description: 'Resolve the type definition of the symbol at file:line:character.',
			parameters: positionSchema(),
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'lsp_implementation',
			description: 'Find implementations of the interface or class at file:line:character.',
			parameters: positionSchema(),
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'lsp_references',
			description: 'Find references (call/usage sites) of the symbol at file:line:character.',
			parameters: positionSchema({
				include_declaration: { type: 'boolean', description: 'Include the declaration itself (default true, best effort).' },
			}),
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'lsp_hover',
			description: 'Hover info (type signature + docs) for the symbol at file:line:character.',
			parameters: positionSchema(),
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'lsp_document_symbols',
			description: 'Outline of a file: symbols with kind and line numbers. Cheaper than reading the whole file.',
			parameters: {
				type: 'object' as const,
				properties: {
					file: { type: 'string', description: 'File path (absolute or workspace-relative).' },
				},
				required: ['file'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'lsp_workspace_symbols',
			description: 'Search symbol names across the workspace (fuzzy). Prefer this over grep when looking for a symbol by name.',
			parameters: {
				type: 'object' as const,
				properties: {
					query: { type: 'string', description: 'Fuzzy symbol name query.' },
				},
				required: ['query'],
			},
		},
	},
];

function resolveInsideWorkspace(input: string, root: string): string {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error('file is required');
	}
	const abs = path.isAbsolute(trimmed) ? trimmed : path.resolve(root, trimmed);
	const normRoot = path.resolve(root);
	const norm = path.resolve(abs);
	if (norm !== normRoot && !norm.startsWith(normRoot + path.sep)) {
		throw new Error(`Path escapes workspace: ${input}`);
	}
	return norm;
}

function parseSymbolLocation(
	args: Record<string, unknown>,
	root: string,
): { uri: vscode.Uri; position: vscode.Position } {
	const file = String(args.file ?? '');
	const uri = vscode.Uri.file(resolveInsideWorkspace(file, root));
	const line = Math.max(1, Math.floor(Number(args.line ?? 1)));
	const character = Math.max(1, Math.floor(Number(args.character ?? 1)));
	return { uri, position: new vscode.Position(line - 1, character - 1) };
}

interface LocationLike {
	uri?: vscode.Uri;
	range?: vscode.Range;
	targetUri?: vscode.Uri;
	targetRange?: vscode.Range;
}

function formatLocation(loc: LocationLike): string {
	const uri = loc.uri ?? loc.targetUri;
	const range = loc.range ?? loc.targetRange;
	if (!uri || !range) {
		return String(loc);
	}
	const rel = vscode.workspace.asRelativePath(uri, false);
	return `${rel}:${range.start.line + 1}:${range.start.character + 1}`;
}

const NAVIGATION_COMMANDS: Record<string, string> = {
	lsp_definition: 'vscode.executeDefinitionProvider',
	lsp_type_definition: 'vscode.executeTypeDefinitionProvider',
	lsp_implementation: 'vscode.executeImplementationProvider',
	lsp_references: 'vscode.executeReferenceProvider',
};

export async function executeLspTool(
	name: string,
	args: Record<string, unknown>,
	root: string,
): Promise<ToolExecResult | undefined> {
	const navCommand = NAVIGATION_COMMANDS[name];
	if (navCommand) {
		const { uri, position } = parseSymbolLocation(args, root);
		const results = await vscode.commands.executeCommand<(LocationLike | vscode.Location | vscode.LocationLink)[]>(
			navCommand,
			uri,
			position,
		);
		const hits = (results ?? []).slice(0, MAX_ITEMS).map(formatLocation);
		const label = name.replace('lsp_', '');
		if (!hits.length) {
			return {
				summary: `${label}: no results`,
				content: `No ${label} results at ${vscode.workspace.asRelativePath(uri, false)}:${position.line + 1}:${position.character + 1}. (No language server for this file type?)`,
			};
		}
		return {
			summary: `${label}: ${hits.length} hit(s)`,
			content: hits.join('\n'),
		};
	}

	switch (name) {
		case 'lsp_hover': {
			const { uri, position } = parseSymbolLocation(args, root);
			const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
				'vscode.executeHoverProvider',
				uri,
				position,
			);
			const parts: string[] = [];
			for (const hover of hovers ?? []) {
				for (const c of hover.contents) {
					if (typeof c === 'string') {
						parts.push(c);
					} else if (c && typeof c === 'object' && 'value' in c) {
						const md = c as vscode.MarkdownString | { language: string; value: string };
						parts.push((md as { value: string }).value);
					}
				}
			}
			const text = parts.filter(Boolean).join('\n\n').trim();
			if (!text) {
				return {
					summary: 'hover: no results',
					content: `No hover info at ${vscode.workspace.asRelativePath(uri, false)}:${position.line + 1}:${position.character + 1}.`,
				};
			}
			return {
				summary: `hover · ${text.split('\n')[0].slice(0, 60)}`,
				content: text.length > 4_000 ? `${text.slice(0, 4_000)}\n… truncated` : text,
			};
		}
		case 'lsp_document_symbols': {
			const file = String(args.file ?? '');
			const uri = vscode.Uri.file(resolveInsideWorkspace(file, root));
			const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
				'vscode.executeDocumentSymbolProvider',
				uri,
			);
			const lines: string[] = [];
			const walk = (list: vscode.DocumentSymbol[], depth: number) => {
				for (const s of list) {
					if (lines.length >= MAX_ITEMS) {
						return;
					}
					const indent = '  '.repeat(depth);
					const kind = vscode.SymbolKind[s.kind] ?? String(s.kind);
					lines.push(`${indent}${s.name} [${kind}] :${s.range.start.line + 1}`);
					if (s.children?.length) {
						walk(s.children, depth + 1);
					}
				}
			};
			walk(symbols ?? [], 0);
			const label = vscode.workspace.asRelativePath(uri, false);
			if (!lines.length) {
				return { summary: `outline: no symbols in ${label}`, content: `No symbols found in ${label}.` };
			}
			return {
				summary: `outline ${label} (${lines.length})`,
				content: lines.join('\n'),
			};
		}
		case 'lsp_workspace_symbols': {
			const query = String(args.query ?? '').trim();
			if (!query) {
				return { summary: 'symbols empty', content: 'Error: query is required' };
			}
			const infos = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
				'vscode.executeWorkspaceSymbolProvider',
				query,
			);
			const rows = (infos ?? [])
				.slice(0, MAX_ITEMS)
				.map(si => {
					const kind = vscode.SymbolKind[si.kind] ?? String(si.kind);
					const rel = vscode.workspace.asRelativePath(si.location.uri, false);
					return `${si.name} [${kind}] ${rel}:${si.location.range.start.line + 1}`;
				});
			if (!rows.length) {
				return { summary: `symbols: no match for "${query}"`, content: `No workspace symbols matching "${query}".` };
			}
			return {
				summary: `symbols "${query}": ${rows.length}`,
				content: rows.join('\n'),
			};
		}
		default:
			return undefined;
	}
}
