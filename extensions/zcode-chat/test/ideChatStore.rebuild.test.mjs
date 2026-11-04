import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { IdeChatStore } = await import('../out/ideChatStore.js');

async function freshRoot() {
	const root = await mkdtemp(path.join(tmpdir(), 'idechat-rebuild-'));
	await mkdir(path.join(root, 'sessions'), { recursive: true });
	return root;
}

test('worker kind is persisted on session and index meta', async () => {
	const root = await freshRoot();
	const store = new IdeChatStore({ rootDir: root });
	const worker = await store.createSession({ title: 'T', kind: 'worker', workspaceRoot: '/w' });
	assert.equal((await store.getSession(worker.id)).kind, 'worker');
	const metas = await store.listSessions({});
	assert.equal(metas.find(m => m.id === worker.id)?.kind, 'worker');
	await rm(root, { recursive: true, force: true });
});

test('upsertDispatchCards merges by id, keeps other items, is idempotent', async () => {
	const root = await freshRoot();
	const store = new IdeChatStore({ rootDir: root });
	const router = await store.createSession({ title: 'Router', kind: 'router' });
	// Simulate a Router that already has a user bubble on disk.
	const raw = JSON.parse(await readFile(path.join(root, 'sessions', `${router.id}.json`), 'utf8'));
	raw.timeline = [{ id: 'u1', kind: 'user', text: 'hi' }];
	await writeFile(path.join(root, 'sessions', `${router.id}.json`), JSON.stringify(raw));

	const card1 = { id: 'dispatch-rebuilt-w1', kind: 'dispatch', text: 'task', workerSessionId: 'w1', status: 'done' };
	await store.upsertDispatchCards(router.id, [card1]);
	await store.upsertDispatchCards(router.id, [{ ...card1, badge: 'renamed' }]); // same id → replace, not duplicate
	const after = await store.getSession(router.id);
	const dispatches = after.timeline.filter(i => i.kind === 'dispatch');
	assert.equal(dispatches.length, 1);
	assert.equal(dispatches[0].badge, 'renamed');
	assert.ok(after.timeline.some(i => i.id === 'u1' && i.kind === 'user'), 'unrelated items survive the merge');
	assert.equal(after.messages.length, 0, 'dispatch cards never leak into canonical messages');

	// Index meta updatedAt is refreshed so the Router keeps ranking in lists.
	const meta = (await store.listSessions({})).find(m => m.id === router.id);
	assert.ok(meta.updatedAt >= raw.updatedAt, 'index meta synced after card merge');
	await rm(root, { recursive: true, force: true });
});

test('upsertDispatchCards on a missing session is a no-op', async () => {
	const root = await freshRoot();
	const store = new IdeChatStore({ rootDir: root });
	await store.upsertDispatchCards('sess-does-not-exist', [{ id: 'd1', kind: 'dispatch', text: 'x' }]);
	assert.equal((await store.listSessions({})).length, 0);
	await rm(root, { recursive: true, force: true });
});

test('removed-workers registry: add/get/clear is idempotent and key-flexible', async () => {
	const root = await freshRoot();
	const store = new IdeChatStore({ rootDir: root });
	const router = await store.createSession({ title: 'Router', kind: 'router' });
	const worker = await store.createSession({ title: 'T', kind: 'worker' });

	await store.addRemovedWorkers(router.id, [worker.id, 'worker-1']);
	await store.addRemovedWorkers(router.id, ['worker-1']); // idempotent
	assert.deepEqual(new Set(await store.getRemovedWorkers(router.id)), new Set([worker.id, 'worker-1']));

	await store.clearRemovedWorkers(router.id, ['worker-1']);
	assert.deepEqual(await store.getRemovedWorkers(router.id), [worker.id]);

	// A fresh store instance (other window) sees the same durable registry.
	const other = new IdeChatStore({ rootDir: root });
	assert.deepEqual(await other.getRemovedWorkers(router.id), [worker.id]);
	await rm(root, { recursive: true, force: true });
});

test('removed-workers registry: add ignores empty/self keys; missing router reads empty', async () => {
	const root = await freshRoot();
	const store = new IdeChatStore({ rootDir: root });
	const router = await store.createSession({ title: 'Router' });
	await store.addRemovedWorkers(router.id, ['', router.id, undefined]);
	assert.deepEqual(await store.getRemovedWorkers(router.id), []);
	assert.deepEqual(await store.getRemovedWorkers('sess-unknown'), []);
	await rm(root, { recursive: true, force: true });
});

test('deleteSession prunes the removed-workers registry', async () => {
	const root = await freshRoot();
	const store = new IdeChatStore({ rootDir: root });
	const router = await store.createSession({ title: 'Router', kind: 'router' });
	const otherRouter = await store.createSession({ title: 'Router2', kind: 'router' });
	const worker = await store.createSession({ title: 'T', kind: 'worker' });

	await store.addRemovedWorkers(router.id, [worker.id, 'worker-x']);
	await store.addRemovedWorkers(otherRouter.id, [worker.id]);

	// Deleting the worker session lifts its key everywhere.
	await store.deleteSession(worker.id);
	assert.deepEqual(await store.getRemovedWorkers(router.id), ['worker-x']);
	assert.deepEqual(await store.getRemovedWorkers(otherRouter.id), []);

	// Deleting a Router drops its whole list.
	await store.deleteSession(router.id);
	assert.deepEqual(await store.getRemovedWorkers(router.id), []);
	await rm(root, { recursive: true, force: true });
});
