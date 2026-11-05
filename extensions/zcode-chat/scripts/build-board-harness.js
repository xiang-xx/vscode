#!/usr/bin/env node
/**
 * Builds a standalone harness page for the Router board webview so the exact
 * "Enter → pushState with a brand-new pending dispatch card" scenario can be
 * exercised in a plain browser (no VS Code needed).
 *
 * Usage: node scripts/build-board-harness.js  → writes scripts/board-harness.html
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'chatPanel.ts'), 'utf8');
const start = src.indexOf('<!DOCTYPE html>');
const end = src.indexOf('</html>', start);
if (start < 0 || end < 0) {
	throw new Error('webview HTML template not found in chatPanel.ts');
}
let html = src.slice(start, end + '</html>'.length);

// Swap webview URIs for relative media paths and drop the CSP meta.
html = html
	.replace(/\$\{styleUri\}/g, '../media/chatView.css')
	.replace(/\$\{sceneUri\}/g, '../media/pastoral-scene.jpg')
	.replace(/\$\{highlightStyleUri\}/g, '../media/highlight-vscode.css')
	.replace(/\$\{markdownItUri\}/g, '../media/markdown-it.min.js')
	.replace(/\$\{highlightUri\}/g, '../media/highlight.min.js')
	.replace(/\$\{markdownUri\}/g, '../media/markdown.js')
	.replace(/\$\{superAgentKeysUri\}/g, '../media/superAgentKeys.js')
	.replace(/\$\{scriptUri\}/g, '../media/chatView.js')
	.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');

const leftovers = html.match(/\$\{[^}]+\}/g);
if (leftovers && leftovers.length) {
	console.warn('WARN unresolved template placeholders:', leftovers);
}

const stub = `<script>window.acquireVsCodeApi = function () { return { postMessage: function (m) { console.log('postMessage', m && m.type); }, getState: function () { return {}; }, setState: function () {} }; };</script>`;
html = html.replace('</head>', `${stub}\n</head>`);

// Driver: simulate the panel pushState right after Enter on the Router page —
// one finished card for an existing worker + one brand-new pending card that
// has NO worker identity yet (exactly the reported bug scenario).
const driver = `
<script>
window.addEventListener('load', function () {
	setTimeout(function () {
		window.dispatchEvent(new MessageEvent('message', { data: {
			type: 'state',
			isRouter: true,
			busy: false,
			items: [
				{ id: 'd-old', kind: 'dispatch', text: '旧任务：修复登录页样式', workerId: 'w1', workerSessionId: 's1', badge: '登录页修复', accent: 'charts.green', status: 'done', receipt: '已完成', startedAt: Date.now() - 60000, durationMs: 5000, resultText: '已完成，改了两个文件。' },
				{ id: 'd-new', kind: 'dispatch', text: '新任务：全新 Worker 冒烟测试', receipt: '处理中', status: 'pending', startedAt: Date.now() }
			]
		} }));
		setTimeout(function () {
			var cards = document.querySelectorAll('.worker-card');
			console.log('HARNESS worker-card count =', cards.length);
			for (var i = 0; i < cards.length; i++) {
				console.log('HARNESS card', i, cards[i].getAttribute('data-worker-key'), '|', cards[i].querySelector('.worker-card-title') && cards[i].querySelector('.worker-card-title').textContent);
			}
		}, 100);
	}, 50);
});
</script>`;
html = html.replace('</body>', `${driver}\n</body>`);

fs.writeFileSync(path.join(__dirname, 'board-harness.html'), html, 'utf8');
console.log('wrote scripts/board-harness.html');
