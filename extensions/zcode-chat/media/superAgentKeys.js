/* global acquireVsCodeApi */
// Super Agent chord forwarding — ⌘]/Ctrl+] enters the pending worker detail,
// ⌘[/Ctrl+[ leaves it back to the Router main page.
//
// The workbench keybindings for these chords (superAgentCommands.ts) only see
// keydown while focus sits OUTSIDE this webview iframe. When the user is
// typing in the composer the chord lands here instead, so re-post it to the
// extension host (chatPanel.ts), which re-dispatches the very same commands
// the workbench keybindings run.
//
// NOTE: acquireVsCodeApi() may only be called once per webview. This script
// loads BEFORE chatView.js, acquires the API, and re-exposes the shared
// instance on the global so chatView.js's own acquire call keeps working
// unchanged.
(function () {
	'use strict';
	if (typeof acquireVsCodeApi !== 'function') {
		return;
	}
	var api;
	try {
		api = acquireVsCodeApi();
	} catch (err) {
		return;
	}
	window.acquireVsCodeApi = function () {
		return api;
	};

	document.addEventListener('keydown', function (e) {
		if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) {
			return;
		}
		var type = null;
		if (e.code === 'BracketRight') {
			type = 'viewPendingWorker';
		} else if (e.code === 'BracketLeft') {
			type = 'backToRouter';
		}
		if (!type) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		try {
			api.postMessage({ type: type });
		} catch (err) {
			// Webview torn down mid-keystroke — nothing to forward to.
		}
	}, true);
})();
