/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { formatSkillCatalog, listLocalSkills } from './localSkills';
import { formatInstructionBlock } from './userInstructions';

/** Personal/project instructions plus skill names. Skill bodies stay out until activated. */
export function buildPromptPreamble(workspaceRoot?: string): string {
	return [
		formatInstructionBlock(workspaceRoot),
		formatSkillCatalog(listLocalSkills(workspaceRoot)),
	].filter(Boolean).join('\n\n');
}
