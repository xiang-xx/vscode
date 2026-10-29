/* global acquireVsCodeApi */
(function () {
	const vscode = acquireVsCodeApi();
	const timelineEl = document.getElementById('timeline');
	const todoPanel = document.getElementById('todoPanel');
	const todoList = document.getElementById('todoList');
	const todoCount = document.getElementById('todoCount');
	const workingSet = document.getElementById('workingSet');
	const workingSetTitle = document.getElementById('workingSetTitle');
	const workingSetList = document.getElementById('workingSetList');
	const workingSetTotals = document.getElementById('workingSetTotals');
	const workingSetCollapse = document.getElementById('workingSetCollapse');
	const keepAllBtn = document.getElementById('keepAllBtn');
	const undoAllBtn = document.getElementById('undoAllBtn');
	const viewAllBtn = document.getElementById('viewAllBtn');
	const chipsEl = document.getElementById('chips');
	const inputEl = document.getElementById('input');
	const sendBtn = document.getElementById('send');
	const accountBtn = document.getElementById('account');
	const historyBtn = document.getElementById('historyBtn');
	const newChatBtn = document.getElementById('newChatBtn');
	const historyDrawer = document.getElementById('historyDrawer');
	const historyList = document.getElementById('historyList');
	const historyClose = document.getElementById('historyClose');
	const plusBtn = document.getElementById('plus');
	const providerBtn = document.getElementById('providerBtn');
	const modelBtn = document.getElementById('modelBtn');
	const thoughtBtn = document.getElementById('thoughtBtn');
	const providerLabel = document.getElementById('providerLabel');
	const modelLabel = document.getElementById('modelLabel');
	const thoughtLabel = document.getElementById('thoughtLabel');
	const hintEl = document.getElementById('hint');
	const plusMenu = document.getElementById('plusMenu');
	const pickerMenu = document.getElementById('pickerMenu');
	const composer = document.getElementById('composer');

	let busy = false;
	let state = null;
	let openMenu = null;
	let historyOpen = false;
	/** @type {Record<string, { top: number, stickBottom: boolean }>} */
	const reasoningScroll = Object.create(null);
	/** Stick timeline to bottom unless the user scrolls up. */
	let timelineStickBottom = true;
	let workingSetCollapsed = false;

	function escapeHtml(text) {
		return String(text)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function renderMarkdown(text) {
		const escaped = escapeHtml(text || '');
		const withCode = escaped.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code}</code></pre>`);
		const withInline = withCode.replace(/`([^`]+)`/g, '<code>$1</code>');
		const withBold = withInline.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
		const lines = withBold.split('\n');
		const out = [];
		let inList = false;
		for (const line of lines) {
			if (/^###\s+/.test(line)) {
				if (inList) { out.push('</ul>'); inList = false; }
				out.push(`<h3>${line.replace(/^###\s+/, '')}</h3>`);
			} else if (/^##\s+/.test(line)) {
				if (inList) { out.push('</ul>'); inList = false; }
				out.push(`<h2>${line.replace(/^##\s+/, '')}</h2>`);
			} else if (/^#\s+/.test(line)) {
				if (inList) { out.push('</ul>'); inList = false; }
				out.push(`<h1>${line.replace(/^#\s+/, '')}</h1>`);
			} else if (/^[-*]\s+/.test(line)) {
				if (!inList) { out.push('<ul>'); inList = true; }
				out.push(`<li>${line.replace(/^[-*]\s+/, '')}</li>`);
			} else if (!line.trim()) {
				if (inList) { out.push('</ul>'); inList = false; }
				out.push('<br/>');
			} else {
				if (inList) { out.push('</ul>'); inList = false; }
				out.push(`<p>${line}</p>`);
			}
		}
		if (inList) out.push('</ul>');
		return out.join('');
	}

	function toolGlyph(status) {
		if (status === 'running') return '◐';
		if (status === 'error') return '!';
		return '✓';
	}

	function toolTitle(name) {
		switch (name) {
			case 'read_file': return 'Read';
			case 'write_file': return 'Write';
			case 'str_replace': return 'Edit';
			case 'list_dir': return 'List';
			case 'TodoWrite': return 'Todos';
			default: return name;
		}
	}

	function todoGlyph(status) {
		if (status === 'completed') return '✓';
		if (status === 'in_progress') return '◐';
		return '○';
	}

	function closeMenus() {
		openMenu = null;
		plusMenu.classList.remove('open');
		pickerMenu.classList.remove('open');
		plusBtn.setAttribute('aria-expanded', 'false');
		providerBtn.setAttribute('aria-expanded', 'false');
		modelBtn.setAttribute('aria-expanded', 'false');
		thoughtBtn.setAttribute('aria-expanded', 'false');
	}

	function setBusy(next) {
		busy = next;
		[sendBtn, plusBtn, providerBtn, modelBtn, thoughtBtn, inputEl].forEach((el) => {
			el.disabled = next;
		});
	}

	function isNearBottom(el, px) {
		return el.scrollHeight - el.scrollTop - el.clientHeight <= (px ?? 24);
	}

	function captureReasoningScrollState() {
		timelineEl.querySelectorAll('.reasoning-body[data-id]').forEach((el) => {
			const id = el.getAttribute('data-id');
			if (!id) return;
			reasoningScroll[id] = {
				top: el.scrollTop,
				stickBottom: isNearBottom(el, 24),
			};
		});
	}

	let timelineScrollQuiet = false;

	function scrollTimelineToBottom() {
		if (!timelineStickBottom) {
			return;
		}
		timelineScrollQuiet = true;
		timelineEl.scrollTop = timelineEl.scrollHeight;
		requestAnimationFrame(() => {
			if (timelineStickBottom) {
				timelineEl.scrollTop = timelineEl.scrollHeight;
			}
			timelineScrollQuiet = false;
		});
	}

	function pinTimelineToBottom() {
		timelineStickBottom = true;
		scrollTimelineToBottom();
	}

	function renderReasoning(item, host) {
		const row = document.createElement('div');
		row.className = 'reasoning-row' + (item.streaming ? ' streaming' : '') + (item.expanded ? ' expanded' : ' collapsed');
		row.dataset.id = item.id;
		const header = document.createElement('button');
		header.type = 'button';
		header.className = 'reasoning-header';
		const chev = item.expanded ? '▾' : '▸';
		const title = item.streaming ? '正在思考' : '思考';
		let dur = '';
		if (item.durationLabel) {
			dur = item.streaming ? '' : ` · 持续了 ${item.durationLabel}`;
		}
		header.innerHTML = `<span class="chev">${chev}</span><span class="label"></span><span class="dur"></span>`;
		header.querySelector('.label').textContent = title;
		header.querySelector('.dur').textContent = dur;
		header.onclick = () => vscode.postMessage({ type: 'toggleReasoning', id: item.id });
		row.appendChild(header);
		if (item.expanded || item.streaming) {
			const body = document.createElement('div');
			body.className = 'reasoning-body';
			body.dataset.id = item.id;
			body.textContent = item.text || '';
			body.addEventListener('scroll', () => {
				reasoningScroll[item.id] = {
					top: body.scrollTop,
					stickBottom: isNearBottom(body, 24),
				};
			}, { passive: true });
			row.appendChild(body);
			const saved = reasoningScroll[item.id];
			requestAnimationFrame(() => {
				if (!saved) {
					if (item.streaming) body.scrollTop = body.scrollHeight;
					return;
				}
				if (saved.stickBottom) {
					body.scrollTop = body.scrollHeight;
				} else {
					body.scrollTop = saved.top;
				}
			});
		}
		host.appendChild(row);
	}

	function renderWork(item, host) {
		const row = document.createElement('div');
		row.className = 'work-row' + (item.running ? ' running' : '');
		const dur = item.durationLabel || '';
		let text;
		if (item.running) {
			text = dur ? `已运行 ${dur}` : '工作中…';
		} else if (item.label === 'Failed') {
			text = dur ? `失败 · ${dur}` : '失败';
		} else {
			text = dur ? `完成 · ${dur}` : '完成';
		}
		row.innerHTML = '<span class="dot"></span><span class="text"></span>';
		row.querySelector('.text').textContent = text;
		host.appendChild(row);
	}

	function tryPatchStreamingReasoning(items) {
		if (!items || !items.length) {
			return false;
		}
		const streaming = items.filter((i) => i.kind === 'reasoning' && i.streaming);
		if (streaming.length !== 1) {
			return false;
		}
		const item = streaming[0];
		const row = timelineEl.querySelector(`.reasoning-row[data-id="${CSS.escape(item.id)}"]`);
		if (!row) {
			return false;
		}
		// Only patch when the timeline structure is otherwise unchanged (same item ids in order).
		const existingIds = [...timelineEl.querySelectorAll('[data-item-id]')].map((el) => el.getAttribute('data-item-id'));
		const nextIds = items.map((i) => i.id);
		if (existingIds.length !== nextIds.length || existingIds.some((id, idx) => id !== nextIds[idx])) {
			return false;
		}

		row.className = 'reasoning-row streaming' + (item.expanded ? ' expanded' : ' collapsed');
		const label = row.querySelector('.reasoning-header .label');
		if (label) label.textContent = '正在思考';
		const dur = row.querySelector('.reasoning-header .dur');
		if (dur) dur.textContent = '';
		let body = row.querySelector('.reasoning-body');
		if (!body && (item.expanded || item.streaming)) {
			body = document.createElement('div');
			body.className = 'reasoning-body';
			body.dataset.id = item.id;
			body.addEventListener('scroll', () => {
				reasoningScroll[item.id] = {
					top: body.scrollTop,
					stickBottom: isNearBottom(body, 24),
				};
			}, { passive: true });
			row.appendChild(body);
		}
		if (!body) {
			scrollTimelineToBottom();
			return true;
		}
		const saved = reasoningScroll[item.id] || {
			top: body.scrollTop,
			stickBottom: isNearBottom(body, 24),
		};
		if (body.textContent !== (item.text || '')) {
			body.textContent = item.text || '';
		}
		if (saved.stickBottom) {
			body.scrollTop = body.scrollHeight;
		} else {
			body.scrollTop = saved.top;
		}
		reasoningScroll[item.id] = {
			top: body.scrollTop,
			stickBottom: saved.stickBottom && isNearBottom(body, 32),
		};

		const work = items.find((i) => i.kind === 'work' && i.running);
		if (work) {
			const workEl = timelineEl.querySelector(`.work-row[data-item-id="${CSS.escape(work.id)}"] .text`);
			if (workEl) {
				const d = work.durationLabel || '';
				workEl.textContent = d ? `已运行 ${d}` : '工作中…';
			}
		}
		scrollTimelineToBottom();
		return true;
	}

	function renderTimeline(items) {
		if (tryPatchStreamingReasoning(items)) {
			return;
		}

		captureReasoningScrollState();
		const prevTop = timelineEl.scrollTop;
		timelineEl.innerHTML = '';
		if (!items || !items.length) {
			const empty = document.createElement('div');
			empty.className = 'empty';
			empty.textContent = 'Ask ZCode to edit, explain, or run something in this workspace.';
			timelineEl.appendChild(empty);
			return;
		}

		const frag = document.createDocumentFragment();
		let turn = null;

		function ensureTurn() {
			if (!turn) {
				turn = document.createElement('div');
				turn.className = 'turn';
				frag.appendChild(turn);
			}
			return turn;
		}

		function mark(el, id) {
			el.setAttribute('data-item-id', id);
			return el;
		}

		items.forEach((item) => {
			if (item.kind === 'user') {
				turn = document.createElement('div');
				turn.className = 'turn';
				frag.appendChild(turn);
				const row = mark(document.createElement('div'), item.id);
				row.className = 'user-row';
				const bubble = document.createElement('div');
				bubble.className = 'user-bubble';
				bubble.textContent = item.text;
				row.appendChild(bubble);
				turn.appendChild(row);
				return;
			}

			const host = ensureTurn();
			if (item.kind === 'reasoning') {
				renderReasoning(item, host);
				const last = host.lastElementChild;
				if (last) mark(last, item.id);
				return;
			}
			if (item.kind === 'work') {
				renderWork(item, host);
				const last = host.lastElementChild;
				if (last) mark(last, item.id);
				return;
			}
			if (item.kind === 'assistant') {
				const row = mark(document.createElement('div'), item.id);
				row.className = 'assistant-row';
				const body = document.createElement('div');
				body.className = 'assistant-body' + (item.streaming ? ' streaming' : '');
				body.innerHTML = renderMarkdown(item.text || '');
				row.appendChild(body);
				host.appendChild(row);
				return;
			}
			if (item.kind === 'tool') {
				const row = mark(document.createElement('div'), item.id);
				row.className = 'tool-row ' + item.status;
				row.innerHTML = `<span class="glyph"></span><div class="meta"><div class="name"></div><div class="summary"></div></div>`;
				row.querySelector('.glyph').textContent = toolGlyph(item.status);
				row.querySelector('.name').textContent = toolTitle(item.toolName);
				row.querySelector('.summary').textContent = item.summary || '';
				host.appendChild(row);
				return;
			}
			if (item.kind === 'status') {
				const row = mark(document.createElement('div'), item.id);
				row.className = 'status-row' + (item.tone === 'error' ? ' error' : '');
				if (item.tone !== 'error') {
					row.innerHTML = '<span class="dot"></span><span class="text"></span>';
					row.querySelector('.text').textContent = item.text;
				} else {
					row.textContent = item.text;
				}
				host.appendChild(row);
			}
		});

		timelineEl.appendChild(frag);
		requestAnimationFrame(() => {
			if (timelineStickBottom) {
				scrollTimelineToBottom();
			} else {
				timelineEl.scrollTop = prevTop;
			}
		});
	}

	timelineEl.addEventListener('scroll', () => {
		if (timelineScrollQuiet) {
			return;
		}
		timelineStickBottom = isNearBottom(timelineEl, 64);
	}, { passive: true });

	function renderTodos(todos) {
		if (!todos || !todos.length) {
			todoPanel.hidden = true;
			todoList.innerHTML = '';
			todoCount.textContent = '';
			return;
		}
		todoPanel.hidden = false;
		const done = todos.filter((t) => t.status === 'completed').length;
		todoCount.textContent = `${done}/${todos.length}`;
		const titleEl = todoPanel.querySelector('.todo-title');
		if (titleEl) titleEl.textContent = '任务';
		todoList.innerHTML = '';
		todos.forEach((todo) => {
			const li = document.createElement('li');
			li.className = 'todo-item ' + (todo.status || 'pending');
			li.innerHTML = '<span class="glyph"></span><span class="content"></span>';
			li.querySelector('.glyph').textContent = todoGlyph(todo.status);
			li.querySelector('.content').textContent = todo.content || todo.id;
			todoList.appendChild(li);
		});
	}

	function formatTime(ts) {
		if (!ts) return '';
		const d = new Date(ts);
		const pad = (n) => String(n).padStart(2, '0');
		return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}

	function sourceLabel(source) {
		if (source === 'deepseek') return 'DeepSeek';
		if (source === 'zcode') return 'ZCode';
		return source || 'AI';
	}

	function renderHistory(sessions) {
		if (!historyDrawer || !historyList) return;
		historyDrawer.hidden = !historyOpen;
		historyList.innerHTML = '';
		if (!sessions || !sessions.length) {
			const empty = document.createElement('div');
			empty.className = 'history-empty';
			empty.textContent = '还没有历史会话';
			historyList.appendChild(empty);
			return;
		}
		sessions.forEach((s) => {
			const li = document.createElement('li');
			const row = document.createElement('div');
			row.className = 'history-item' + (s.active ? ' active' : '');
			row.innerHTML = '<button type="button" class="meta"><span class="title"></span><span class="sub"></span></button><button type="button" class="del" title="删除">×</button>';
			row.querySelector('.title').textContent = s.title || '新对话';
			row.querySelector('.sub').textContent = `${sourceLabel(s.source)} · ${formatTime(s.updatedAt)}`;
			row.querySelector('.meta').onclick = () => {
				historyOpen = false;
				vscode.postMessage({ type: 'openSession', sessionId: s.id });
			};
			row.querySelector('.del').onclick = (e) => {
				e.stopPropagation();
				vscode.postMessage({ type: 'deleteSession', sessionId: s.id });
			};
			li.appendChild(row);
			historyList.appendChild(li);
		});
	}

	function renderWorkingSet(files) {
		if (!workingSet || !workingSetList) return;
		if (!files || !files.length) {
			workingSet.hidden = true;
			workingSetList.innerHTML = '';
			return;
		}
		workingSet.hidden = false;
		workingSet.classList.toggle('collapsed', workingSetCollapsed);
		const n = files.length;
		let added = 0;
		let removed = 0;
		files.forEach((f) => {
			added += f.added || 0;
			removed += f.removed || 0;
		});
		if (workingSetTitle) {
			workingSetTitle.textContent = n === 1 ? '1 file changed' : `${n} files changed`;
		}
		if (workingSetTotals) {
			workingSetTotals.querySelector('.insertions').textContent = `+${added}`;
			workingSetTotals.querySelector('.deletions').textContent = `-${removed}`;
		}
		if (workingSetCollapse) {
			workingSetCollapse.setAttribute('aria-expanded', String(!workingSetCollapsed));
			const chev = workingSetCollapse.querySelector('.chev');
			if (chev) chev.textContent = workingSetCollapsed ? '▸' : '▾';
		}
		workingSetList.innerHTML = '';
		files.forEach((f) => {
			const li = document.createElement('li');
			li.className = 'chat-summary-list-row';
			li.innerHTML =
				'<button type="button" class="file-label"></button>' +
				'<span class="insertions-and-deletions"><span class="insertions"></span><span class="deletions"></span></span>' +
				'<span class="chat-summary-list-icon-actions">' +
				'<button type="button" class="keep">Keep</button>' +
				'<button type="button" class="undo">Undo</button>' +
				'</span>';
			li.querySelector('.file-label').textContent = f.relativePath || f.name;
			li.querySelector('.file-label').title = f.fsPath || f.relativePath;
			li.querySelector('.insertions').textContent = `+${f.added || 0}`;
			li.querySelector('.deletions').textContent = `-${f.removed || 0}`;
			li.querySelector('.file-label').onclick = () =>
				vscode.postMessage({ type: 'openFileChange', uri: f.uri, mode: 'file' });
			li.querySelector('.keep').onclick = () =>
				vscode.postMessage({ type: 'keepFileChanges', uri: f.uri });
			li.querySelector('.undo').onclick = () =>
				vscode.postMessage({ type: 'undoFileChanges', uri: f.uri });
			workingSetList.appendChild(li);
		});
	}

	function renderChips(attachments) {
		chipsEl.innerHTML = '';
		(attachments || []).forEach((a) => {
			const chip = document.createElement('span');
			chip.className = 'chip';
			chip.innerHTML = '<span></span><button type="button" title="Remove">×</button>';
			chip.querySelector('span').textContent = a.name;
			chip.querySelector('button').onclick = () =>
				vscode.postMessage({ type: 'removeAttachment', attachmentId: a.id });
			chipsEl.appendChild(chip);
		});
	}

	function renderPlusMenu(sections) {
		plusMenu.innerHTML = '';
		(sections || []).forEach((section) => {
			const title = document.createElement('div');
			title.className = 'menu-section-title';
			title.textContent = section.title;
			plusMenu.appendChild(title);
			(section.items || []).forEach((item) => {
				const btn = document.createElement('button');
				btn.type = 'button';
				btn.className = 'menu-item';
				btn.innerHTML = '<span class="title"></span><span class="desc"></span>';
				btn.querySelector('.title').textContent = item.label;
				btn.querySelector('.desc').textContent = item.description || '';
				btn.onclick = () => {
					closeMenus();
					vscode.postMessage({ type: 'plusAction', actionId: item.id, slash: item.slash });
				};
				plusMenu.appendChild(btn);
			});
		});
		const footer = document.createElement('div');
		footer.className = 'menu-footer';
		footer.innerHTML =
			'<span><code>@</code>context</span><span><code>/</code>commands</span><span><code>$</code>skills</span>';
		plusMenu.appendChild(footer);
	}

	function openPicker(kind, items, selectedId, onPick) {
		closeMenus();
		openMenu = kind;
		pickerMenu.innerHTML = '';
		items.forEach((item) => {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'picker-item';
			btn.innerHTML = '<span></span><span class="check"></span>';
			btn.querySelector('span').textContent = item.label;
			if (item.id === selectedId) btn.querySelector('.check').textContent = '✓';
			btn.onclick = () => {
				closeMenus();
				onPick(item.id);
			};
			pickerMenu.appendChild(btn);
		});
		pickerMenu.classList.add('open');
		const map = { provider: providerBtn, model: modelBtn, thought: thoughtBtn };
		if (map[kind]) map[kind].setAttribute('aria-expanded', 'true');
	}

	function autosize() {
		inputEl.style.height = 'auto';
		inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
	}

	function render(next) {
		const wasBusy = busy;
		state = next;
		setBusy(!!next.busy);
		if (next.busy && !wasBusy) {
			pinTimelineToBottom();
		}
		if (next.clearDraft) {
			inputEl.value = '';
			inputEl.style.height = 'auto';
			vscode.postMessage({ type: 'draft', draft: '' });
		}
		if (typeof next.insertText === 'string' && next.insertText) {
			const start = inputEl.selectionStart ?? inputEl.value.length;
			const end = inputEl.selectionEnd ?? start;
			const before = inputEl.value.slice(0, start);
			const after = inputEl.value.slice(end);
			if (next.insertText.startsWith('/') && !inputEl.value.trim()) {
				inputEl.value = next.insertText;
			} else {
				inputEl.value = before + next.insertText + after;
			}
			inputEl.focus();
			const pos =
				next.insertText.startsWith('/') && !before.trim()
					? next.insertText.length
					: start + next.insertText.length;
			inputEl.setSelectionRange(pos, pos);
			vscode.postMessage({ type: 'draft', draft: inputEl.value });
			autosize();
		}

		providerLabel.textContent =
			(next.providers || []).find((p) => p.id === next.provider)?.label || next.provider;
		modelLabel.textContent = next.model || 'Model';
		thoughtLabel.textContent = next.reasoningLabel || next.reasoningLevel || 'Thinking';
		accountBtn.textContent = next.signedIn ? next.accountLabel : 'Sign in';
		hintEl.textContent =
			(next.model || '') +
			' · ' +
			(next.reasoningLabel || next.reasoningLevel || '') +
			' · ' +
			(next.bridgeMode || '');

		renderTimeline(next.items || []);
		renderTodos(next.todos || []);
		renderWorkingSet(next.fileChanges || []);
		renderHistory(next.sessions || []);
		renderChips(next.attachments);
		renderPlusMenu(next.plusSections);

		if (next.openPlus) {
			openMenu = 'plus';
			plusMenu.classList.add('open');
			plusBtn.setAttribute('aria-expanded', 'true');
		}
	}

	function send() {
		if (busy) return;
		const text = inputEl.value;
		if (!text.trim() && !(state && state.attachments && state.attachments.length)) return;
		closeMenus();
		pinTimelineToBottom();
		vscode.postMessage({ type: 'send', text });
	}

	plusBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		if (openMenu === 'plus') {
			closeMenus();
			return;
		}
		closeMenus();
		vscode.postMessage({ type: 'openPlus', draft: inputEl.value });
	});
	providerBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		if (!state) return;
		openPicker('provider', state.providers, state.provider, (id) =>
			vscode.postMessage({ type: 'setProvider', provider: id }),
		);
	});
	modelBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		if (!state) return;
		openPicker('model', state.models, state.model, (id) =>
			vscode.postMessage({ type: 'setModel', model: id }),
		);
	});
	thoughtBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		if (!state) return;
		openPicker('thought', state.reasoningLevels, state.reasoningLevel, (id) =>
			vscode.postMessage({ type: 'setReasoningLevel', reasoningLevel: id }),
		);
	});
	sendBtn.addEventListener('click', send);
	accountBtn.addEventListener('click', () => vscode.postMessage({ type: 'manageAccount' }));
	if (historyBtn) {
		historyBtn.addEventListener('click', () => {
			historyOpen = !historyOpen;
			renderHistory((state && state.sessions) || []);
		});
	}
	if (historyClose) {
		historyClose.addEventListener('click', () => {
			historyOpen = false;
			renderHistory((state && state.sessions) || []);
		});
	}
	if (newChatBtn) {
		newChatBtn.addEventListener('click', () => {
			historyOpen = false;
			vscode.postMessage({ type: 'newChat' });
		});
	}
	if (keepAllBtn) {
		keepAllBtn.addEventListener('click', () => vscode.postMessage({ type: 'keepFileChanges' }));
	}
	if (undoAllBtn) {
		undoAllBtn.addEventListener('click', () => vscode.postMessage({ type: 'undoFileChanges' }));
	}
	if (viewAllBtn) {
		viewAllBtn.addEventListener('click', () => vscode.postMessage({ type: 'viewAllFileChanges' }));
	}
	if (workingSetCollapse) {
		workingSetCollapse.addEventListener('click', () => {
			workingSetCollapsed = !workingSetCollapsed;
			if (workingSet) workingSet.classList.toggle('collapsed', workingSetCollapsed);
			workingSetCollapse.setAttribute('aria-expanded', String(!workingSetCollapsed));
			const chev = workingSetCollapse.querySelector('.chev');
			if (chev) chev.textContent = workingSetCollapsed ? '▸' : '▾';
		});
	}
	inputEl.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') {
			closeMenus();
			return;
		}
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	});
	inputEl.addEventListener('input', () => {
		autosize();
		vscode.postMessage({ type: 'draft', draft: inputEl.value });
	});
	document.addEventListener('click', (e) => {
		if (!composer.contains(e.target)) closeMenus();
	});
	window.addEventListener('message', (event) => {
		const data = event.data;
		if (data && data.type === 'state') render(data);
	});
	vscode.postMessage({ type: 'ready' });
})();
