/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { formatSkillCatalog, listLocalSkills } from './localSkills';
import { formatInstructionBlock } from './userInstructions';

/** Personal/project instructions plus skill names. Skill bodies stay out until activated. */
export function buildPromptPreamble(workspaceRoot?: string): string {
	return [
		formatWorkspaceBoundary(workspaceRoot),
		formatInstructionBlock(workspaceRoot),
		formatSkillCatalog(listLocalSkills(workspaceRoot)),
	].filter(Boolean).join('\n\n');
}

/**
 * Up-front boundary so workers never stray outside the opened project:
 * out-of-workspace access gets the run killed by the sandbox guard.
 */
function formatWorkspaceBoundary(workspaceRoot?: string): string {
	if (!workspaceRoot) {
		return [
			'Workspace boundary: no workspace folder is open.',
			'- You may only operate on paths the user explicitly pastes or attaches in this conversation.',
			'- Never read, write, search, or run commands against anything else.',
		].join('\n');
	}
	return [
		`Workspace boundary: the opened project directory is ${workspaceRoot}`,
		'- Operate ONLY inside this directory: reading files, writing files, searching, and running shell commands must all stay under it.',
		'- Do NOT access, list, or modify anything outside it — including sibling project folders, $HOME, /tmp scratch paths, or dotfiles — unless the user names that exact path in the current conversation.',
		'- The only standing exception: the personal instructions file listed below, and only when the user explicitly asks to change personal instructions.',
		'- If a task seems to require files outside the project directory, stop and ask the user instead of reaching out.',
	].join('\n');
}
