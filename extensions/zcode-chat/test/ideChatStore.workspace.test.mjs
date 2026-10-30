import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { IdeChatStore } = require('../out/ideChatStore.js');

async function withStore(fn) {
	const rootDir = await mkdtemp(path.join(tmpdir(), 'ide-chat-'));
	const store = new IdeChatStore({ rootDir });
	try {
		await fn(store);
	} finally {
		await rm(rootDir, { recursive: true, force: true });
	}
}

function sessionBody(title) {
	return {
		title,
		messages: [{ role: 'user', content: title }],
		timeline: [],
		todos: [],
	};
}

test('list, tabs, and restore stay inside the opened workspace root', async () => {
	await withStore(async (store) => {
		const apps = await store.createSession({
			...sessionBody('apps task'),
			workspaceRoot: '/Users/xiang/apps',
			source: 'cursor',
		});
		const projects = await store.createSession({
			...sessionBody('projects task'),
			workspaceRoot: '/Users/xiang/projects/',
			source: 'cursor',
		});

		const appsList = await store.listSessions({ workspaceRoot: '/Users/xiang/apps' });
		const projectsList = await store.listSessions({ workspaceRoot: '/users/xiang/projects' });
		assert.deepEqual(appsList.map(s => s.id), [apps.id]);
		assert.deepEqual(projectsList.map(s => s.id), [projects.id]);
		assert.equal((await store.listSessions()).length, 2);

		assert.deepEqual(await store.getOpenTabIds({ workspaceRoot: '/Users/xiang/apps' }), [apps.id]);
		assert.deepEqual(await store.getOpenTabIds({ workspaceRoot: '/Users/xiang/projects' }), [projects.id]);

		const restoredApps = await store.getActiveSession({ workspaceRoot: '/Users/xiang/apps' });
		assert.equal(restoredApps?.id, apps.id);
		const restoredProjects = await store.getActiveSession({ workspaceRoot: '/Users/xiang/projects' });
		assert.equal(restoredProjects?.id, projects.id);

		await store.deleteSession(projects.id);
		assert.equal(await store.getActiveSessionId(), undefined);
		assert.equal(await store.getActiveSession({ workspaceRoot: '/Users/xiang/projects' }), undefined);
		const stillApps = await store.getActiveSession({ workspaceRoot: '/Users/xiang/apps' });
		assert.equal(stillApps?.id, apps.id);
		assert.deepEqual(
			(await store.listSessions({ workspaceRoot: '/Users/xiang/apps' })).map(s => s.id),
			[apps.id],
		);
	});
});

test('closing the active tab does not activate another workspace', async () => {
	await withStore(async (store) => {
		const apps = await store.createSession({
			...sessionBody('apps task'),
			workspaceRoot: '/Users/xiang/apps',
		});
		const projects = await store.createSession({
			...sessionBody('projects task'),
			workspaceRoot: '/Users/xiang/projects',
		});
		await store.closeOpenTab(projects.id);
		assert.equal(await store.getActiveSessionId(), undefined);
		assert.deepEqual(await store.getOpenTabIds({ workspaceRoot: '/Users/xiang/apps' }), [apps.id]);
		assert.deepEqual(await store.getOpenTabIds({ workspaceRoot: '/Users/xiang/projects' }), []);
		const restored = await store.getActiveSession({ workspaceRoot: '/Users/xiang/apps' });
		assert.equal(restored?.id, apps.id);
	});
});
