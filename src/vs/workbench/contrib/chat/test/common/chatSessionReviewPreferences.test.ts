/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { autorun } from '../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { ChatSessionReviewPreferencesService } from '../../common/editing/chatSessionReviewPreferences.js';

suite('ChatSessionReviewPreferences', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('defaults Keep/Undo off and persists the user choice across instances', () => {
		const storage = store.add(new InMemoryStorageService());
		const preferences = store.add(new ChatSessionReviewPreferencesService(storage));
		const states: boolean[] = [];
		store.add(autorun(reader => states.push(preferences.keepUndoEnabled.read(reader))));
		preferences.setKeepUndoEnabled(true);
		preferences.dispose();

		const restored = store.add(new ChatSessionReviewPreferencesService(storage));
		const enabled = restored.keepUndoEnabled.get();
		restored.setKeepUndoEnabled(false);
		const disabled = store.add(new ChatSessionReviewPreferencesService(storage)).keepUndoEnabled.get();

		assert.deepStrictEqual({ states, enabled, disabled }, { states: [false, true], enabled: true, disabled: false });
	});
});
