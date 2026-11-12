/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../../nls.js';
import { Action2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IOutputService } from '../../../../services/output/common/output.js';
import { IChatTokenUsageService } from '../../common/chatTokenUsageService.js';

const CHAT_TOKEN_USAGE_CATEGORY = localize2('chatTokenUsage.category', "Chat Token Usage");
const REPORT_DAYS = 14;

export class ShowChatTokenUsageReportAction extends Action2 {

	static readonly ID = 'workbench.action.chat.showTokenUsageReport';

	constructor() {
		super({
			id: ShowChatTokenUsageReportAction.ID,
			title: localize2('chatTokenUsage.showReport', "Show Token Usage Report"),
			category: CHAT_TOKEN_USAGE_CATEGORY,
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const outputService = accessor.get(IOutputService);
		const tokenUsageService = accessor.get(IChatTokenUsageService);
		const report = await tokenUsageService.renderReport(REPORT_DAYS);
		const channel = outputService.getChannel('chatTokenUsage');
		if (channel) {
			channel.clear();
			channel.append(report + '\n');
		}
		await outputService.showChannel('chatTokenUsage', true);
	}
}

export class OpenChatTokenUsageLedgerAction extends Action2 {

	static readonly ID = 'workbench.action.chat.openTokenUsageLedger';

	constructor() {
		super({
			id: OpenChatTokenUsageLedgerAction.ID,
			title: localize2('chatTokenUsage.openLedger', "Open Token Usage Ledger File"),
			category: CHAT_TOKEN_USAGE_CATEGORY,
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const tokenUsageService = accessor.get(IChatTokenUsageService);
		const editorService = accessor.get(IEditorService);
		await tokenUsageService.flush();
		await editorService.openEditor({
			resource: tokenUsageService.ledgerUri,
			options: { pinned: true }
		});
	}
}
