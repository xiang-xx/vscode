/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../../platform/files/common/files.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IUserDataProfilesService } from '../../../../../platform/userDataProfile/common/userDataProfile.js';
import { IChatUsage } from '../../common/chatService/chatService.js';
import { ChatTokenUsageService, IChatTokenUsageTurn } from '../../common/chatTokenUsageService.js';

suite('ChatTokenUsageService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('records whole-turn model totals without double counting', async () => {
		const writes = await withService(async service => {
			service.recordTurnUsage(turn('session-1', 'Fix HLS transcode', 'resp-1', modelTotalsUsage(100, 20, 30)), true);
			// The agent host re-emits the same report once slower detail resolves — that is
			// a refinement, not another model call.
			service.recordTurnUsage(turn('session-1', 'Fix HLS transcode', 'resp-1', modelTotalsUsage(100, 20, 30)), false);
			// A later call in the same turn grows the whole-turn totals.
			service.recordTurnUsage(turn('session-1', 'Fix HLS transcode', 'resp-1', modelTotalsUsage(150, 40, 60)), true);

			const report = await service.renderReport(7);
			assert.ok(report.includes('claude-sonnet'), report);
			assert.ok(report.includes('input 150'), report);
			assert.ok(report.includes('cached 40'), report);
			assert.ok(report.includes('output 60'), report);
			assert.ok(report.includes('Fix HLS transcode'), report);
			assert.ok(report.includes('1 turn'), report);
		});

		assert.strictEqual(writes.length, 1);
		const ledger = JSON.parse(writes[0]);
		assert.strictEqual(Object.keys(ledger.days).length, 1);
	});

	test('accumulates per-call usage when no model totals are reported', async () => {
		await withService(async service => {
			service.recordTurnUsage(turn('session-2', 'Untitled task', 'resp-2', callUsage(10, 5, 'gpt-5')), true);
			// Same numbers re-emitted → refinement, not a new call.
			service.recordTurnUsage(turn('session-2', 'Untitled task', 'resp-2', callUsage(10, 5, 'gpt-5')), true);
			// A second model call on the same response accumulates.
			service.recordTurnUsage(turn('session-2', 'Untitled task', 'resp-2', callUsage(25, 8, 'gpt-5')), true);

			const report = await service.renderReport(7);
			assert.ok(report.includes('input 35'), report);
			assert.ok(report.includes('output 13'), report);
		});
	});

	test('counts one turn per response per day and updates session titles', async () => {
		await withService(async service => {
			service.recordTurnUsage(turn('session-3', 'Old title', 'resp-3', modelTotalsUsage(1, 0, 1)), true);
			service.recordTurnUsage(turn('session-3', 'New title', 'resp-4', modelTotalsUsage(1, 0, 1)), true);

			const report = await service.renderReport(7);
			assert.ok(report.includes('New title'), report);
			assert.ok(report.includes('2 turns'), report);
		});
	});
});

async function withService(fn: (service: ChatTokenUsageService) => Promise<void>): Promise<string[]> {
	const instantiationService = new TestInstantiationService();
	instantiationService.stub(ILogService, new NullLogService());
	const writes: string[] = [];
	instantiationService.stub(IFileService, {
		readFile: () => Promise.reject(new FileOperationError('not found', FileOperationResult.FILE_NOT_FOUND)),
		writeFile: (_uri: URI, content: VSBuffer) => {
			writes.push(content.toString());
			return Promise.resolve(Object.create(null));
		}
	} as unknown as IFileService);
	instantiationService.stub(IUserDataProfilesService, {
		defaultProfile: { globalStorageHome: URI.file('/test-global-storage') }
	} as unknown as IUserDataProfilesService);
	const service = instantiationService.createInstance(ChatTokenUsageService);
	try {
		await fn(service);
	} finally {
		await service.flush();
		instantiationService.dispose();
	}
	return writes;
}

function turn(sessionId: string, sessionTitle: string, responseId: string, usage: IChatUsage): IChatTokenUsageTurn {
	return { sessionId, sessionTitle, responseId, timestamp: Date.now(), usage };
}

function modelTotalsUsage(inputTokens: number, cachedTokens: number, outputTokens: number): IChatUsage {
	return {
		kind: 'usage',
		promptTokens: inputTokens,
		completionTokens: outputTokens,
		modelTotals: [{ model: 'claude-sonnet', inputTokens, cachedTokens, outputTokens }]
	};
}

function callUsage(promptTokens: number, completionTokens: number, actualModelId: string): IChatUsage {
	return { kind: 'usage', promptTokens, completionTokens, actualModelId };
}
