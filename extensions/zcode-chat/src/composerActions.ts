/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Subset of ZCode composer "+" / slash capabilities for the VS Code shell panel.
 * Catalog mirrored from `@zcode/shared` `BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES`
 * and `ChatPromptActionMenu` quick commands.
 */

export interface ComposerSlashCommand {
	name: string;
	summary: string;
	/** Shown in the + menu “Add” section (empty draft only). */
	quickAdd?: boolean;
}

export const QUICK_ADD_COMMANDS: readonly ComposerSlashCommand[] = [
	{ name: 'goal', summary: 'Set or manage the session goal', quickAdd: true },
	{ name: 'workflow', summary: 'Design and launch a dynamic workflow', quickAdd: true },
];

export const CAPABILITY_COMMANDS: readonly ComposerSlashCommand[] = [
	{ name: 'help', summary: 'Show slash command help' },
	{ name: 'compact', summary: 'Compact the current conversation' },
	{ name: 'init', summary: 'Create or update workspace AGENTS.md' },
	{ name: 'effort', summary: 'Show or switch thinking intensity' },
	{ name: 'model', summary: 'Show or switch the current model' },
	{ name: 'mode', summary: 'Show or switch permission mode' },
	{ name: 'skill', summary: 'List skills, or force-load one' },
	{ name: 'mcp', summary: 'Show or manage MCP servers' },
	{ name: 'new', summary: 'Start a fresh session' },
	{ name: 'login', summary: 'Set up a Coding Plan provider' },
];

export interface PlusMenuSection {
	id: string;
	title: string;
	items: Array<{
		id: string;
		label: string;
		description?: string;
		kind: 'attach' | 'mention-file' | 'slash';
		slash?: string;
	}>;
}

export function buildPlusMenuSections(options: {
	emptyDraft: boolean;
}): PlusMenuSection[] {
	const addItems: PlusMenuSection['items'] = [
		{
			id: 'attach-files',
			label: 'Attachments',
			description: 'Add files to this message',
			kind: 'attach',
		},
		{
			id: 'mention-file',
			label: 'File reference',
			description: 'Insert @path into the prompt',
			kind: 'mention-file',
		},
	];

	if (options.emptyDraft) {
		for (const cmd of QUICK_ADD_COMMANDS) {
			addItems.push({
				id: `slash:${cmd.name}`,
				label: cmd.name === 'goal' ? 'Goal' : 'Workflow',
				description: `/${cmd.name}`,
				kind: 'slash',
				slash: cmd.name,
			});
		}
	}

	return [
		{
			id: 'add',
			title: 'Add',
			items: addItems,
		},
		{
			id: 'capabilities',
			title: 'Capabilities',
			items: CAPABILITY_COMMANDS.map(cmd => ({
				id: `slash:${cmd.name}`,
				label: `/${cmd.name}`,
				description: cmd.summary,
				kind: 'slash' as const,
				slash: cmd.name,
			})),
		},
	];
}

export function formatSlashInsert(name: string): string {
	return `/${name} `;
}
