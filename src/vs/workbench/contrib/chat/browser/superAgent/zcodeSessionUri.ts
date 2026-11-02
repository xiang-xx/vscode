/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { openSessionByResource, ISessionOpenOptions } from '../agentSessions/agentSessionsOpener.js';
import { IChatWidget } from '../chat.js';

/** Synthetic scheme binding a Super Agent worker/Router to a zcode-chat session id. */
export const ZCODE_SESSION_SCHEME = 'zcode-session';

export function zcodeSessionResource(sessionId: string): URI {
	return URI.from({ scheme: ZCODE_SESSION_SCHEME, path: '/' + encodeURIComponent(sessionId) });
}

export function parseZcodeSessionId(resource: URI): string | undefined {
	if (resource.scheme !== ZCODE_SESSION_SCHEME) {
		return undefined;
	}
	const raw = resource.path.replace(/^\//, '');
	if (!raw) {
		return undefined;
	}
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

/**
 * Opens a Super Agent session on the surface the user actually sees.
 * ZCode sessions go through the webview; everything else uses the native opener.
 */
export async function openSuperAgentSession(accessor: ServicesAccessor, resource: URI, openOptions?: ISessionOpenOptions): Promise<IChatWidget | undefined> {
	const zcodeId = parseZcodeSessionId(resource);
	if (zcodeId) {
		await accessor.get(ICommandService).executeCommand('zcode.openSession', zcodeId);
		return undefined;
	}
	return openSessionByResource(accessor, resource, openOptions);
}
