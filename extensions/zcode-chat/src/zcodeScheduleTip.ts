/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

export type ZcodeScheduleTipKind = 'peak' | 'offpeak-hint';

export interface ZcodeScheduleTip {
	kind: ZcodeScheduleTipKind;
	message: string;
}

/** Mon–Fri 14:00–18:00 local time — ZCode peak (higher token cost). */
export function isZcodePeakHours(now: Date = new Date()): boolean {
	const day = now.getDay(); // 0=Sun … 6=Sat
	if (day === 0 || day === 6) {
		return false;
	}
	const minutes = now.getHours() * 60 + now.getMinutes();
	return minutes >= 14 * 60 && minutes < 18 * 60;
}

/**
 * - Peak + on ZCode → warn about busy-hour token cost
 * - Off-peak + not on ZCode → nudge to prefer ZCode
 */
export function getZcodeScheduleTip(
	brain: 'zcode' | 'cursor',
	now: Date = new Date(),
): ZcodeScheduleTip | undefined {
	const peak = isZcodePeakHours(now);
	if (peak && brain === 'zcode') {
		return {
			kind: 'peak',
			message: '当前为 ZCode 忙时（工作日 14:00–18:00），token 消耗较高。',
		};
	}
	if (!peak && brain !== 'zcode') {
		return {
			kind: 'offpeak-hint',
			message: '当前为闲时，优先切换到 ZCode 更划算。',
		};
	}
	return undefined;
}
