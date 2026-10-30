/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Extra scrollable pixels below the last line when scrolling beyond the last line is enabled.
 *
 * The end of the document can rise to the vertical center of the viewport. It never
 * rises far enough to leave less than `minimumVisibleTail` pixels of content, so the
 * editor cannot scroll into an empty page.
 */
export function getScrollBeyondLastLineExtraHeight(viewportHeight: number, minimumVisibleTail: number, paddingBottom: number): number {
	const upToVerticalCenter = Math.max(0, Math.floor(viewportHeight / 2) - paddingBottom);
	const keepTailVisible = Math.max(0, viewportHeight - minimumVisibleTail - paddingBottom);
	return Math.min(upToVerticalCenter, keepTailVisible);
}

/**
 * Blank lines below the last line, including bottom padding.
 * Fractional when scrolling beyond the last line, so the minimap tracks the pixel limit.
 */
export function getLinesBeyondLastLine(viewportHeight: number, lineHeight: number, paddingBottom: number, scrollBeyondLastLine: boolean): number {
	if (!(lineHeight > 0)) {
		return 0;
	}
	if (!scrollBeyondLastLine) {
		return Math.floor(paddingBottom / lineHeight);
	}
	const extra = getScrollBeyondLastLineExtraHeight(viewportHeight, lineHeight, paddingBottom);
	return (paddingBottom + extra) / lineHeight;
}
