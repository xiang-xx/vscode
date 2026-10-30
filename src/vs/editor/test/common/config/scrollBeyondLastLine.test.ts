/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { getLinesBeyondLastLine, getScrollBeyondLastLineExtraHeight } from '../../../common/config/scrollBeyondLastLine.js';

suite('Editor Scroll Beyond Last Line', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('stops at the vertical center instead of a blank page', () => {
		const viewportHeight = 800;
		const lineHeight = 20;
		const extra = getScrollBeyondLastLineExtraHeight(viewportHeight, lineHeight, 0);

		assert.strictEqual(extra, 400);
		// End of the document sits at the center: viewportHeight - extra.
		assert.ok(viewportHeight - extra >= viewportHeight / 2);
		assert.ok(extra < viewportHeight - lineHeight);
	});

	test('bottom padding counts toward the centered limit', () => {
		assert.strictEqual(getScrollBeyondLastLineExtraHeight(800, 20, 100), 300);
		assert.strictEqual(getScrollBeyondLastLineExtraHeight(800, 20, 500), 0);
	});

	test('keeps a short viewport from scrolling the last line away', () => {
		assert.strictEqual(getScrollBeyondLastLineExtraHeight(30, 20, 0), 10);
	});

	test('line count matches the pixel limit', () => {
		assert.strictEqual(getLinesBeyondLastLine(800, 20, 0, true), 20);
		assert.strictEqual(getLinesBeyondLastLine(800, 20, 30, false), 1);
		assert.strictEqual(getLinesBeyondLastLine(800, 0, 0, true), 0);
	});
});
