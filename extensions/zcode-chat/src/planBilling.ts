/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ZCode contributors. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getAuthService } from './authSession';
import { formatCompactTokens } from './contextUsage';

/**
 * The plan billing API gates eligibility on the ZCode client version.
 * The extension's own package version is not that string.
 */
const BILLING_APP_VERSION = '3.16.2';
const DEFAULT_API_ORIGIN = 'https://zcode.z.ai';

export interface ClaimOffer {
	planId: string;
	name: string;
	detail: string;
}

export interface QuotaLine {
	name: string;
	remainingLabel: string;
	totalLabel?: string;
	resetLabel?: string;
}

export interface QuotaBucket {
	bucketId: string;
	name: string;
	remaining: number;
	total?: number;
	periodKind: 'daily' | 'once' | 'plan';
	/** Unix milliseconds. Missing when the server omitted the field. */
	periodStart?: number;
	periodEnd?: number;
	expiresAt?: number;
	models: string[];
}

export interface AccountQuota {
	lines: QuotaLine[];
	buckets: QuotaBucket[];
	/** Snapshot clock from the balance payload, else the fetch time. */
	serverNow: number;
}

export interface QuotaNotice {
	id: string;
	text: string;
}

export const QUOTA_NOTICE_SEEN_KEY = 'zcode.quotaNotice.seen';
export const CLAIM_NOTICE_SEEN_KEY = 'zcode.claimNotice.seen';

const LOW_QUOTA_RATIO = 0.1;

interface JsonRecord {
	[key: string]: unknown;
}

function apiOrigin(): string {
	const configured = vscode.workspace.getConfiguration('zcode').get<string>('oauth.apiOrigin')?.trim();
	return (configured || DEFAULT_API_ORIGIN).replace(/\/+$/, '');
}

function jwt(): string | undefined {
	try {
		const token = getAuthService().getSession()?.zcodeJwtToken?.trim();
		return token || undefined;
	} catch {
		return undefined;
	}
}

function platformKey(): string {
	return `${process.platform}-${process.arch}`;
}

function billingUrl(path: string): string {
	const url = new URL(`${apiOrigin()}${path}`);
	url.searchParams.set('app_version', BILLING_APP_VERSION);
	url.searchParams.set('platform', platformKey());
	return url.toString();
}

function authHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		'X-ZCode-App-Version': BILLING_APP_VERSION,
		'X-Platform': platformKey(),
	};
}

async function requestJson(url: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: JsonRecord }> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 15_000);
	try {
		const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: ctrl.signal });
		const text = await res.text();
		let body: JsonRecord = {};
		if (text) {
			try {
				const parsed = JSON.parse(text) as unknown;
				if (parsed && typeof parsed === 'object') {
					body = parsed as JsonRecord;
				}
			} catch {
				body = {};
			}
		}
		return { status: res.status, body };
	} finally {
		clearTimeout(timer);
	}
}

function readCode(body: JsonRecord, httpStatus: number): number {
	if (httpStatus === 401) {
		return 401;
	}
	const raw = body.code;
	if (typeof raw === 'number' && Number.isFinite(raw)) {
		return raw;
	}
	if (typeof raw === 'string' && /^\d+$/.test(raw)) {
		return Number(raw);
	}
	return -1;
}

function asRecord(value: unknown): JsonRecord | undefined {
	return value && typeof value === 'object' ? value as JsonRecord : undefined;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
		return Number(value);
	}
	return undefined;
}

function periodLabel(period: string): string {
	const normalized = period.toLowerCase();
	if (normalized.includes('daily') || normalized === 'day') {
		return '每日额度';
	}
	if (normalized.includes('once') || normalized.includes('one_time') || normalized.includes('one-time') || normalized.includes('lifetime')) {
		return '一次性额度';
	}
	return period || '额度';
}

export function claimFailureMessage(code: number): string {
	switch (code) {
		case 401:
			return '还没登录';
		case 1003:
			return '已经领过了';
		case 1005:
			return '今天的名额已经领完';
		case 1002:
			return '活动已经结束';
		case 1001:
			return '找不到这个活动';
		case 1004:
			return '当前账号不能领取';
		case 3001:
			return '领取请求无效';
		default:
			return '领取失败，请稍后再试';
	}
}

function formatReset(unixSeconds: number, now = Date.now()): string | undefined {
	if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) {
		return undefined;
	}
	const ms = unixSeconds > 10_000_000_000 ? unixSeconds : unixSeconds * 1000;
	const when = new Date(ms);
	if (Number.isNaN(when.getTime())) {
		return undefined;
	}
	const startOf = (value: number) => {
		const date = new Date(value);
		date.setHours(0, 0, 0, 0);
		return date.getTime();
	};
	const hm = `${when.getHours()}:${String(when.getMinutes()).padStart(2, '0')}`;
	const day = startOf(ms);
	const today = startOf(now);
	if (day === today) {
		return `今天 ${hm} 恢复`;
	}
	if (day === today + 86_400_000) {
		return `明天 ${hm} 恢复`;
	}
	return `${when.getMonth() + 1}月${when.getDate()}日 ${hm} 恢复`;
}

interface RemotePlan {
	planId: string;
	name: string;
	priority: number;
	entitlements: Array<{ showName: string; grantUnits: number; period: string }>;
}

function readPlans(body: JsonRecord): RemotePlan[] {
	const data = asRecord(body.data);
	return asArray(data?.plans).flatMap(raw => {
		const plan = asRecord(raw);
		if (!plan) {
			return [];
		}
		const planId = readString(plan.plan_id);
		if (!planId) {
			return [];
		}
		const entitlements = asArray(plan.entitlements).flatMap(item => {
			const entitlement = asRecord(item);
			if (!entitlement) {
				return [];
			}
			const grantUnits = readNumber(entitlement.grant_units);
			if (grantUnits === undefined) {
				return [];
			}
			return [{
				showName: readString(entitlement.show_name),
				grantUnits,
				period: readString(entitlement.period),
			}];
		});
		if (!entitlements.length) {
			return [];
		}
		return [{
			planId,
			name: readString(plan.name) || planId,
			priority: readNumber(plan.priority) ?? 0,
			entitlements,
		}];
	});
}

export async function fetchClaimOffer(): Promise<ClaimOffer | null> {
	const token = jwt();
	if (!token) {
		return null;
	}
	try {
		const { status, body } = await requestJson(billingUrl('/api/v1/zcode-plan/billing/preview'), {
			method: 'GET',
			headers: authHeaders(token),
		});
		if (readCode(body, status) !== 0) {
			return null;
		}
		const plans = readPlans(body).sort((a, b) => b.priority - a.priority);
		const plan = plans[0];
		if (!plan) {
			return null;
		}
		const detail = plan.entitlements.map(entitlement => {
			const who = entitlement.showName || plan.name;
			return `${who} ${formatCompactTokens(entitlement.grantUnits)} · ${periodLabel(entitlement.period)}`;
		}).join('，');
		return { planId: plan.planId, name: plan.name, detail };
	} catch {
		return null;
	}
}

export async function claimManualPlan(planId: string): Promise<{ ok: true } | { ok: false; message: string }> {
	const token = jwt();
	if (!token) {
		return { ok: false, message: claimFailureMessage(401) };
	}
	try {
		const { status, body } = await requestJson(billingUrl('/api/v1/zcode-plan/billing/claim'), {
			method: 'POST',
			headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ plan_id: planId }),
		});
		const code = readCode(body, status);
		const data = asRecord(body.data);
		const plan = asRecord(data?.plan);
		if (code === 0 && plan) {
			return { ok: true };
		}
		return { ok: false, message: claimFailureMessage(code) };
	} catch {
		return { ok: false, message: claimFailureMessage(-1) };
	}
}

export async function fetchAccountQuota(): Promise<AccountQuota | null> {
	const token = jwt();
	if (!token) {
		return null;
	}
	try {
		const { status, body } = await requestJson(billingUrl('/api/v1/zcode-plan/billing/balance'), {
			method: 'GET',
			headers: authHeaders(token),
		});
		if (readCode(body, status) !== 0) {
			return null;
		}
		const data = asRecord(body.data) ?? {};
		const buckets = asArray(data.balances).flatMap(raw => parseBucket(asRecord(raw), data));
		const lines = buckets
			.map(bucket => {
				const resetAt = bucket.expiresAt ?? bucket.periodEnd;
				const resetLabel = resetAt ? formatReset(resetAt / 1000) : undefined;
				return {
					remaining: bucket.remaining,
					name: bucket.name,
					remainingLabel: formatCompactTokens(Math.max(0, bucket.remaining)),
					...(bucket.total !== undefined ? { totalLabel: formatCompactTokens(Math.max(0, bucket.total)) } : {}),
					...(resetLabel ? { resetLabel } : {}),
				};
			})
			.sort((a, b) => b.remaining - a.remaining)
			.slice(0, 3)
			.map(({ remaining: _remaining, ...line }) => line);
		if (!lines.length) {
			return null;
		}
		return { lines, buckets, serverNow: readServerNow(data) };
	} catch {
		return null;
	}
}

export function readSeenQuotaNotices(values: readonly string[] | undefined): string[] {
	const list = Array.isArray(values) ? values : [];
	return list.filter(value => typeof value === 'string' && value.length > 0).slice(-200);
}

/**
 * One banner: total exhaustion, then the current model's exhaustion, then the
 * first bucket still above zero and at or under 10%. Sending stays allowed.
 * A dismissed id stays hidden for that bucket period.
 */
export function selectQuotaNotice(quota: AccountQuota | null, modelId: string, seen: ReadonlySet<string>): QuotaNotice | null {
	if (!quota) {
		return null;
	}
	const valid = quota.buckets.filter(bucket => bucketIsActive(bucket, quota.serverNow));
	if (!valid.length) {
		return null;
	}
	if (valid.every(bucket => bucket.remaining <= 0)) {
		const notice = {
			id: exhaustId('exhaust:all', valid),
			text: '体验套餐可用额度已用完，请切换到 Coding Plan 订阅或等待额度恢复。',
		};
		return seen.has(notice.id) ? null : notice;
	}
	const modelBuckets = valid.filter(bucket => bucketMatchesModel(bucket, modelId));
	if (modelBuckets.length && modelBuckets.every(bucket => bucket.remaining <= 0)) {
		const notice = {
			id: exhaustId(`exhaust:${modelId}`, modelBuckets),
			text: `${modelId} 可用额度已用完，可更换其他模型或切换到 Coding Plan 订阅。`,
		};
		return seen.has(notice.id) ? null : notice;
	}
	// Buckets that name this model win. If none do, still warn on the first low bucket.
	const lowBuckets = modelBuckets.length ? modelBuckets : valid;
	for (const bucket of lowBuckets) {
		if (bucket.total === undefined || bucket.total <= 0) {
			continue;
		}
		const ratio = bucket.remaining / bucket.total;
		if (!(ratio > 0 && ratio <= LOW_QUOTA_RATIO)) {
			continue;
		}
		if (!bucket.bucketId || bucket.periodStart === undefined || bucket.periodEnd === undefined) {
			continue;
		}
		const id = `low:${bucket.bucketId}:${bucket.periodStart}:${bucket.periodEnd}`;
		if (seen.has(id)) {
			continue;
		}
		return { id, text: lowQuotaText(bucket, ratio) };
	}
	return null;
}

function parseBucket(balance: JsonRecord | undefined, data: JsonRecord): QuotaBucket[] {
	if (!balance) {
		return [];
	}
	const remaining = readNumber(balance.remaining_units);
	if (remaining === undefined) {
		return [];
	}
	const total = readNumber(balance.total_units);
	const period = periodForBalance(balance, data);
	return [{
		bucketId: readString(balance.bucket_id),
		name: readString(balance.show_name) || 'Start Plan',
		remaining,
		...(total !== undefined ? { total } : {}),
		periodKind: periodKind(period),
		periodStart: unixMs(balance.period_start),
		periodEnd: unixMs(balance.period_end),
		expiresAt: unixMs(balance.expires_at),
		models: readModels(balance),
	}];
}

function periodForBalance(balance: JsonRecord, data: JsonRecord): string {
	const direct = readString(balance.period);
	if (direct) {
		return direct;
	}
	const entitlementId = readString(balance.entitlement_id);
	const planId = readString(balance.plan_id);
	const userPlanId = readString(balance.user_plan_id);
	for (const raw of asArray(data.plans)) {
		const plan = asRecord(raw);
		if (!plan) {
			continue;
		}
		const sameUserPlan = !!userPlanId && readString(plan.user_plan_id) === userPlanId;
		const samePlan = !!planId && readString(plan.plan_id) === planId;
		if (!sameUserPlan && !samePlan) {
			continue;
		}
		for (const item of asArray(plan.entitlements)) {
			const entitlement = asRecord(item);
			if (!entitlement) {
				continue;
			}
			if (entitlementId && readString(entitlement.entitlement_id) !== entitlementId) {
				continue;
			}
			const period = readString(entitlement.period);
			if (period) {
				return period;
			}
		}
	}
	return '';
}

function periodKind(period: string): QuotaBucket['periodKind'] {
	const normalized = period.toLowerCase();
	if (normalized.includes('daily') || normalized === 'day') {
		return 'daily';
	}
	if (normalized.includes('once') || normalized.includes('one_time') || normalized.includes('one-time') || normalized.includes('lifetime')) {
		return 'once';
	}
	return 'plan';
}

function readModels(balance: JsonRecord): string[] {
	return asArray(balance.capabilities).flatMap(item => {
		const text = readString(item);
		if (!text) {
			return [];
		}
		const model = text.toLowerCase().startsWith('model:') ? text.slice('model:'.length) : text;
		const id = model.trim().toLowerCase();
		return id ? [id] : [];
	});
}

function unixMs(value: unknown): number | undefined {
	const n = readNumber(value);
	if (n === undefined || n <= 0) {
		return undefined;
	}
	return n > 10_000_000_000 ? n : n * 1000;
}

function readServerNow(data: JsonRecord): number {
	const raw = readNumber(data.server_time)
		?? readNumber(data.serverTime)
		?? readNumber(data.generated_at)
		?? readNumber(data.generatedAt);
	if (raw === undefined || raw <= 0) {
		return Date.now();
	}
	return raw > 10_000_000_000 ? raw : raw * 1000;
}

function bucketIsActive(bucket: QuotaBucket, now: number): boolean {
	if (bucket.periodStart !== undefined && bucket.periodStart > now) {
		return false;
	}
	if (bucket.periodEnd !== undefined && bucket.periodEnd <= now) {
		return false;
	}
	if (bucket.expiresAt !== undefined && bucket.expiresAt <= now) {
		return false;
	}
	return true;
}

function bucketMatchesModel(bucket: QuotaBucket, modelId: string): boolean {
	const id = modelId.trim().toLowerCase();
	if (!id) {
		return false;
	}
	if (bucket.models.length) {
		return bucket.models.some(model => model === id);
	}
	const name = bucket.name.trim().toLowerCase();
	if (!name || name === 'start plan') {
		return true;
	}
	return name.includes(id);
}

function lowQuotaText(bucket: QuotaBucket, ratio: number): string {
	const pct = percentLabel(ratio);
	const remaining = formatCompactTokens(Math.max(0, bucket.remaining));
	const label = bucket.name || '当前模型';
	if (bucket.periodKind === 'daily') {
		return `${label} 今日额度剩余 ${pct}（${remaining} tokens）。`;
	}
	if (bucket.periodKind === 'once') {
		return `${label} 活动额度剩余 ${pct}（${remaining} tokens）。`;
	}
	return `${label} 套餐额度剩余 ${pct}（${remaining} tokens）。`;
}

function percentLabel(ratio: number): string {
	const pct = Math.round(ratio * 1000) / 10;
	return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`;
}

function exhaustId(prefix: string, buckets: QuotaBucket[]): string {
	return `${prefix}:${buckets.map(bucket => `${bucket.bucketId || bucket.name}:${bucket.periodStart ?? ''}:${bucket.periodEnd ?? ''}`).join('|')}`;
}
