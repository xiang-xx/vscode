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
	const queuePanel = document.getElementById('queuePanel');
	const queueList = document.getElementById('queueList');
	const queuePausedBanner = document.getElementById('queuePausedBanner');
	const queuePausedText = document.getElementById('queuePausedText');
	const queueResume = document.getElementById('queueResume');
	const inputEl = document.getElementById('input');
	const sendBtn = document.getElementById('send');
	const accountBtn = document.getElementById('account');
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
	const zcodePills = document.getElementById('zcodePills');
	const cursorPills = document.getElementById('cursorPills');
	const cursorModeBtn = document.getElementById('cursorModeBtn');
	const cursorModelBtn = document.getElementById('cursorModelBtn');
	const cursorModeLabel = document.getElementById('cursorModeLabel');
	const cursorModelLabel = document.getElementById('cursorModelLabel');
	const brainZcode = document.getElementById('brainZcode');
	const brainCursor = document.getElementById('brainCursor');
	const hintEl = document.getElementById('hint');
	const scheduleTipEl = document.getElementById('scheduleTip');
	const plusMenu = document.getElementById('plusMenu');
	const pickerMenu = document.getElementById('pickerMenu');
	const composer = document.getElementById('composer');
	const timelineRoot = document.getElementById('timeline');
	const contextUsageBtn = document.getElementById('contextUsageBtn');
	const contextUsagePct = document.getElementById('contextUsagePct');
	const contextPanel = document.getElementById('contextPanel');
	const contextPanelSummary = document.getElementById('contextPanelSummary');
	const contextPanelFill = document.getElementById('contextPanelFill');
	const contextBreakdown = document.getElementById('contextBreakdown');
	const contextPanelNote = document.getElementById('contextPanelNote');

	let busy = false;
	let state = null;
	let openMenu = null;
	let historyOpen = false;
	let contextPanelOpen = false;
	const CONTEXT_RING_R = 10;
	const CONTEXT_RING_C = 2 * Math.PI * CONTEXT_RING_R;
	const BREAKDOWN_LABELS = {
		messages: '消息',
		reasoning: '思考',
		tools: '工具',
		draft: '输入草稿',
		system: '系统提示',
	};
	const BREAKDOWN_COLORS = [
		'var(--vscode-charts-blue, #3794ff)',
		'color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 72%, #fff)',
		'color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 52%, #fff)',
		'color-mix(in srgb, var(--vscode-charts-purple, #b180d7) 70%, transparent)',
		'color-mix(in srgb, var(--vscode-descriptionForeground) 55%, transparent)',
	];
	/** @type {Record<string, { top: number, stickBottom: boolean }>} */
	const reasoningScroll = Object.create(null);
	/** Stick timeline to bottom unless the user scrolls up. */
	let timelineStickBottom = true;
	let workingSetCollapsed = false;
	/** Local draft selections for pending question cards: askId -> { [qId]: { selected: string[], freeText: string } } */
	const questionDrafts = Object.create(null);

	function escapeHtml(text) {
		if (window.ZCodeMarkdown && window.ZCodeMarkdown.escapeHtml) {
			return window.ZCodeMarkdown.escapeHtml(text);
		}
		return String(text || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	function renderMarkdown(text) {
		if (window.ZCodeMarkdown && typeof window.ZCodeMarkdown.render === 'function') {
			return window.ZCodeMarkdown.render(text);
		}
		return `<p>${escapeHtml(text).replace(/\n/g, '<br/>')}</p>`;
	}

	function toolGlyph(status) {
		if (status === 'running') return '◐';
		if (status === 'error') return '!';
		return '✓';
	}

	function toolTitle(name) {
		switch (name) {
			case 'read_file':
			case 'Read': return 'Read';
			case 'write_file':
			case 'Write': return 'Write';
			case 'str_replace':
			case 'Edit': return 'Edit';
			case 'delete_file':
			case 'Delete': return 'Delete';
			case 'list_dir': return 'List';
			case 'run_terminal_cmd':
			case 'Bash':
			case 'bash': return 'Bash';
			case 'get_diagnostics': return 'Diagnostics';
			case 'web_fetch':
			case 'WebFetch': return 'Fetch';
			case 'grep':
			case 'Grep': return 'Grep';
			case 'glob':
			case 'Glob': return 'Glob';
			case 'TodoWrite': return 'Todos';
			case 'AskUserQuestion': return 'Question';
			default: return name;
		}
	}

	function ensureQuestionDraft(item) {
		if (!questionDrafts[item.id]) {
			questionDrafts[item.id] = Object.create(null);
		}
		const draft = questionDrafts[item.id];
		(item.questions || []).forEach((q) => {
			if (!draft[q.id]) {
				draft[q.id] = { selected: [], freeText: '' };
			}
		});
		return draft;
	}

	function renderQuestion(item, host) {
		const card = document.createElement('div');
		card.className = 'question-card' + (item.status === 'pending' ? ' pending' : ' settled');
		card.setAttribute('data-ask-id', item.id);

		const title = document.createElement('div');
		title.className = 'question-card-title';
		title.textContent = item.title || (item.status === 'pending' ? '需要你的选择' : '已回答');
		card.appendChild(title);

		if (item.status !== 'pending') {
			(item.questions || []).forEach((q) => {
				const block = document.createElement('div');
				block.className = 'question-block settled';
				const prompt = document.createElement('div');
				prompt.className = 'question-prompt';
				prompt.textContent = q.header ? `${q.header} · ${q.prompt}` : q.prompt;
				block.appendChild(prompt);
				const answer = (item.answers || []).find((a) => a.questionId === q.id);
				const summary = document.createElement('div');
				summary.className = 'question-answer-summary';
				if (!answer) {
					summary.textContent = item.status === 'skipped' ? '已跳过' : '—';
				} else {
					const labels = (answer.selectedOptionIds || [])
						.map((id) => (q.options || []).find((o) => o.id === id)?.label || id)
						.filter(Boolean);
					const free = (answer.freeText || '').trim();
					summary.textContent = free
						? (labels.length ? `${labels.join('、')}；其他：${free}` : free)
						: (labels.join('、') || '—');
				}
				block.appendChild(summary);
				card.appendChild(block);
			});
			host.appendChild(card);
			delete questionDrafts[item.id];
			return;
		}

		const draft = ensureQuestionDraft(item);
		(item.questions || []).forEach((q) => {
			const block = document.createElement('div');
			block.className = 'question-block';
			const prompt = document.createElement('div');
			prompt.className = 'question-prompt';
			prompt.textContent = q.header ? `${q.header} · ${q.prompt}` : q.prompt;
			block.appendChild(prompt);

			const opts = document.createElement('div');
			opts.className = 'question-options';
			const qDraft = draft[q.id];
			(q.options || []).forEach((opt) => {
				const btn = document.createElement('button');
				btn.type = 'button';
				btn.className = 'question-option' + (qDraft.selected.includes(opt.id) ? ' selected' : '');
				const label = document.createElement('span');
				label.className = 'option-label';
				label.textContent = opt.label;
				btn.appendChild(label);
				if (opt.description) {
					const desc = document.createElement('span');
					desc.className = 'option-desc';
					desc.textContent = opt.description;
					btn.appendChild(desc);
				}
				btn.onclick = () => {
					if (q.allowMultiple) {
						const idx = qDraft.selected.indexOf(opt.id);
						if (idx >= 0) {
							qDraft.selected.splice(idx, 1);
						} else {
							qDraft.selected.push(opt.id);
						}
					} else {
						qDraft.selected = [opt.id];
					}
					syncQuestionCard(card, item);
				};
				opts.appendChild(btn);
			});
			block.appendChild(opts);

			if (q.allowFreeform) {
				const free = document.createElement('input');
				free.type = 'text';
				free.className = 'question-free';
				free.placeholder = '其他（可选）';
				free.value = qDraft.freeText || '';
				free.addEventListener('input', () => {
					qDraft.freeText = free.value;
					syncQuestionCard(card, item);
				});
				block.appendChild(free);
			}
			card.appendChild(block);
		});

		const actions = document.createElement('div');
		actions.className = 'question-actions';
		const submit = document.createElement('button');
		submit.type = 'button';
		submit.className = 'question-submit';
		submit.textContent = '提交';
		submit.onclick = () => {
			const answers = collectQuestionAnswers(item);
			if (!answers) {
				return;
			}
			vscode.postMessage({ type: 'answerQuestion', id: item.id, answers });
		};
		const skip = document.createElement('button');
		skip.type = 'button';
		skip.className = 'question-skip';
		skip.textContent = '跳过';
		skip.onclick = () => {
			vscode.postMessage({ type: 'skipQuestion', id: item.id });
		};
		actions.appendChild(submit);
		actions.appendChild(skip);
		card.appendChild(actions);
		syncQuestionCard(card, item);
		host.appendChild(card);
	}

	function collectQuestionAnswers(item) {
		const draft = ensureQuestionDraft(item);
		const answers = [];
		for (const q of item.questions || []) {
			const qDraft = draft[q.id] || { selected: [], freeText: '' };
			const free = (qDraft.freeText || '').trim();
			if (!qDraft.selected.length && !free) {
				return null;
			}
			answers.push({
				questionId: q.id,
				selectedOptionIds: [...qDraft.selected],
				freeText: free || undefined,
			});
		}
		return answers;
	}

	function syncQuestionCard(card, item) {
		const draft = ensureQuestionDraft(item);
		(item.questions || []).forEach((q) => {
			const qDraft = draft[q.id];
			const block = [...card.querySelectorAll('.question-block')].find((el) => {
				const prompt = el.querySelector('.question-prompt');
				const expected = q.header ? `${q.header} · ${q.prompt}` : q.prompt;
				return prompt && prompt.textContent === expected;
			});
			if (!block) {
				return;
			}
			block.querySelectorAll('.question-option').forEach((btn, idx) => {
				const opt = (q.options || [])[idx];
				if (!opt) {
					return;
				}
				btn.classList.toggle('selected', qDraft.selected.includes(opt.id));
			});
		});
		const submit = card.querySelector('.question-submit');
		if (submit) {
			submit.disabled = !collectQuestionAnswers(item);
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
		setContextPanelOpen(false);
	}

	function formatCompactTokens(value) {
		if (!Number.isFinite(value) || value < 0) return '0';
		if (value < 1000) return String(Math.round(value));
		if (value < 1000000) {
			const k = value / 1000;
			return (k >= 100 ? Math.round(k) : Number(k.toFixed(k >= 10 ? 0 : 1))) + 'K';
		}
		const m = value / 1000000;
		return (m >= 10 ? Math.round(m) : Number(m.toFixed(1))) + 'M';
	}

	function setContextPanelOpen(open) {
		contextPanelOpen = !!open;
		if (contextPanel) contextPanel.hidden = !contextPanelOpen;
		if (contextUsageBtn) {
			contextUsageBtn.classList.toggle('open', contextPanelOpen);
			contextUsageBtn.setAttribute('aria-expanded', contextPanelOpen ? 'true' : 'false');
		}
	}

	function renderContextUsage(usage) {
		if (!contextUsageBtn) return;
		if (!usage || !usage.size || usage.used <= 0) {
			contextUsageBtn.hidden = true;
			setContextPanelOpen(false);
			return;
		}
		contextUsageBtn.hidden = false;
		const percent = Math.min(1, Math.max(0, usage.percent ?? (usage.used / usage.size)));
		const pctLabel = (percent * 100).toFixed(percent >= 0.1 ? 0 : 1) + '%';
		const tone = percent >= 0.9 ? 'danger' : percent >= 0.75 ? 'warning' : '';
		contextUsageBtn.classList.toggle('warning', tone === 'warning');
		contextUsageBtn.classList.toggle('danger', tone === 'danger');
		contextUsageBtn.title = `上下文容量 ${formatCompactTokens(usage.used)} / ${formatCompactTokens(usage.size)} (${pctLabel})`;
		if (contextUsagePct) contextUsagePct.textContent = pctLabel;
		const arc = contextUsageBtn.querySelector('.ring-arc');
		if (arc) {
			arc.setAttribute('stroke-dasharray', String(CONTEXT_RING_C));
			arc.setAttribute('stroke-dashoffset', String(CONTEXT_RING_C * (1 - percent)));
		}
		if (contextPanelSummary) {
			contextPanelSummary.textContent =
				`${formatCompactTokens(usage.used)} / ${formatCompactTokens(usage.size)} (${pctLabel})`;
		}
		if (contextPanelFill) {
			contextPanelFill.style.width = `${Math.max(2, percent * 100)}%`;
			contextPanelFill.classList.toggle('warning', tone === 'warning');
			contextPanelFill.classList.toggle('danger', tone === 'danger');
		}
		if (contextBreakdown) {
			contextBreakdown.innerHTML = '';
			(usage.breakdown || []).forEach((row, index) => {
				const li = document.createElement('li');
				li.innerHTML = '<span class="swatch"></span><span class="label"></span><span class="value"></span>';
				li.querySelector('.swatch').style.background =
					BREAKDOWN_COLORS[Math.min(index, BREAKDOWN_COLORS.length - 1)];
				li.querySelector('.label').textContent = BREAKDOWN_LABELS[row.source] || row.source;
				const share = usage.used > 0 ? row.tokens / usage.used : 0;
				li.querySelector('.value').textContent = `${(share * 100).toFixed(0)}%`;
				contextBreakdown.appendChild(li);
			});
		}
		if (contextPanelNote) {
			contextPanelNote.textContent = usage.estimated
				? '当前为估算值（按会话内容估算 token）。'
				: '来自模型返回的用量。';
		}
	}

	function hasComposerPayload() {
		return !!(inputEl.value.trim() || (state && state.attachments && state.attachments.length));
	}

	function updateSendButton() {
		sendBtn.disabled = false;
		const queueing = busy && hasComposerPayload();
		if (queueing) {
			sendBtn.textContent = '↑';
			sendBtn.title = '加入队列 (Enter)';
			sendBtn.setAttribute('aria-label', '加入队列');
			sendBtn.classList.remove('stopping');
			sendBtn.classList.add('queueing');
		} else if (busy) {
			sendBtn.textContent = '■';
			sendBtn.title = 'Stop';
			sendBtn.setAttribute('aria-label', 'Stop');
			sendBtn.classList.add('stopping');
			sendBtn.classList.remove('queueing');
		} else {
			sendBtn.textContent = '↑';
			sendBtn.title = 'Send (Enter)';
			sendBtn.setAttribute('aria-label', 'Send');
			sendBtn.classList.remove('stopping', 'queueing');
		}
		[plusBtn, providerBtn, modelBtn, thoughtBtn, inputEl].forEach((el) => {
			if (el) el.disabled = false;
		});
	}

	function setBusy(next) {
		busy = next;
		updateSendButton();
	}

	function previewQueueText(text) {
		const line = String(text || '').replace(/\s+/g, ' ').trim();
		if (line.length <= 80) return line;
		return line.slice(0, 80) + '…';
	}

	function renderQueue(queue, paused) {
		const items = Array.isArray(queue) ? queue : [];
		if (!queuePanel || !queueList) return;
		queuePanel.hidden = items.length === 0;
		if (queuePausedBanner) {
			queuePausedBanner.hidden = !paused || items.length === 0;
		}
		if (queuePausedText) {
			queuePausedText.textContent = '队列已暂停 — 停止或出错后不会自动发送';
		}
		queueList.innerHTML = '';
		items.forEach((item) => {
			const li = document.createElement('li');
			li.className = 'queue-item';
			li.dataset.id = item.id;

			const textBtn = document.createElement('button');
			textBtn.type = 'button';
			textBtn.className = 'queue-item-text';
			textBtn.title = item.text;
			textBtn.textContent = previewQueueText(item.text);
			textBtn.addEventListener('click', () => {
				vscode.postMessage({ type: 'editQueueItem', id: item.id });
			});

			const actions = document.createElement('div');
			actions.className = 'queue-item-actions';

			const sendNow = document.createElement('button');
			sendNow.type = 'button';
			sendNow.className = 'queue-item-btn';
			sendNow.title = '立即发送';
			sendNow.setAttribute('aria-label', '立即发送');
			sendNow.textContent = '↑';
			sendNow.addEventListener('click', (e) => {
				e.stopPropagation();
				vscode.postMessage({ type: 'runQueueItem', id: item.id });
			});

			const edit = document.createElement('button');
			edit.type = 'button';
			edit.className = 'queue-item-btn';
			edit.title = '编辑';
			edit.setAttribute('aria-label', '编辑');
			edit.textContent = '✎';
			edit.addEventListener('click', (e) => {
				e.stopPropagation();
				vscode.postMessage({ type: 'editQueueItem', id: item.id });
			});

			const remove = document.createElement('button');
			remove.type = 'button';
			remove.className = 'queue-item-btn';
			remove.title = '移除';
			remove.setAttribute('aria-label', '移除');
			remove.textContent = '×';
			remove.addEventListener('click', (e) => {
				e.stopPropagation();
				vscode.postMessage({ type: 'removeQueueItem', id: item.id });
			});

			actions.appendChild(sendNow);
			actions.appendChild(edit);
			actions.appendChild(remove);
			li.appendChild(textBtn);
			li.appendChild(actions);
			queueList.appendChild(li);
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

	function renderDiffDetail(container, detail) {
		const pre = document.createElement('pre');
		pre.className = 'tool-diff';
		String(detail || '').split('\n').forEach((line) => {
			const span = document.createElement('div');
			span.className = 'diff-line';
			if (line.startsWith('+') && !line.startsWith('+++')) {
				span.classList.add('add');
			} else if (line.startsWith('-') && !line.startsWith('---')) {
				span.classList.add('del');
			} else if (line.startsWith('  ')) {
				span.classList.add('ctx');
			}
			span.textContent = line;
			pre.appendChild(span);
		});
		container.appendChild(pre);
	}

	function renderTool(item, host) {
		const expandable = !!(item.detail || item.uri);
		const row = document.createElement('div');
		row.className = 'tool-row ' + (item.status || '')
			+ (item.expanded ? ' expanded' : ' collapsed')
			+ (expandable ? ' expandable' : '');

		const header = document.createElement(expandable ? 'button' : 'div');
		if (expandable) header.type = 'button';
		header.className = 'tool-header';
		const chev = expandable ? (item.expanded ? '▾' : '▸') : '';
		header.innerHTML =
			(expandable ? `<span class="chev">${chev}</span>` : '') +
			'<span class="glyph"></span>' +
			'<div class="meta"><div class="name"></div><div class="summary"></div></div>' +
			((item.added || item.removed)
				? '<span class="tool-stats"><span class="add"></span><span class="del"></span></span>'
				: '');
		header.querySelector('.glyph').textContent = toolGlyph(item.status);
		header.querySelector('.name').textContent = toolTitle(item.toolName);
		let summaryText = item.summary || '';
		if (item.path) {
			summaryText = (item.status === 'done' ? 'completed · ' : '') + item.path;
		} else if (item.status === 'done' && summaryText) {
			summaryText = summaryText;
		}
		header.querySelector('.summary').textContent = summaryText;
		const stats = header.querySelector('.tool-stats');
		if (stats) {
			stats.querySelector('.add').textContent = item.added ? `+${item.added}` : '';
			stats.querySelector('.del').textContent = item.removed ? `-${item.removed}` : '';
		}
		if (expandable) {
			header.onclick = () => vscode.postMessage({ type: 'toggleTool', id: item.id });
		}
		row.appendChild(header);

		if (item.expanded && (item.detail || item.uri)) {
			const body = document.createElement('div');
			body.className = 'tool-detail';
			if (item.detail) {
				renderDiffDetail(body, item.detail);
			} else {
				const empty = document.createElement('div');
				empty.className = 'tool-detail-empty';
				empty.textContent = '暂无预览内容';
				body.appendChild(empty);
			}
			if (item.uri) {
				const actions = document.createElement('div');
				actions.className = 'tool-detail-actions';
				const openDiff = document.createElement('button');
				openDiff.type = 'button';
				openDiff.textContent = '打开 Diff';
				openDiff.onclick = (e) => {
					e.stopPropagation();
					vscode.postMessage({ type: 'openFileChange', uri: item.uri, mode: 'diff' });
				};
				const openFile = document.createElement('button');
				openFile.type = 'button';
				openFile.textContent = '打开文件';
				openFile.onclick = (e) => {
					e.stopPropagation();
					vscode.postMessage({ type: 'openFileChange', uri: item.uri, mode: 'file' });
				};
				actions.appendChild(openDiff);
				actions.appendChild(openFile);
				body.appendChild(actions);
			}
			row.appendChild(body);
		}
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
				body.className = 'assistant-body rendered-markdown' + (item.streaming ? ' streaming' : '');
				body.innerHTML = renderMarkdown(item.text || '');
				row.appendChild(body);
				host.appendChild(row);
				return;
			}
			if (item.kind === 'tool') {
				renderTool(item, host);
				const last = host.lastElementChild;
				if (last) mark(last, item.id);
				return;
			}
			if (item.kind === 'question') {
				renderQuestion(item, host);
				const last = host.lastElementChild;
				if (last) mark(last, item.id);
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
		if (source === 'cursor') return 'Cursor';
		if (source === 'zcode') return 'ZCode';
		return source || 'AI';
	}

	function historyGroupKey(ts) {
		if (!ts) return '更早';
		const d = new Date(ts);
		const now = new Date();
		const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		const startYesterday = startToday - 86400000;
		if (ts >= startToday) return '今天';
		if (ts >= startYesterday) return '昨天';
		if (ts >= startToday - 6 * 86400000) return '近 7 天';
		return '更早';
	}

	function setHistoryOpen(open, notifyHost) {
		historyOpen = !!open;
		renderHistory((state && state.sessions) || []);
		if (notifyHost !== false) {
			vscode.postMessage({ type: 'setHistoryOpen', open: historyOpen });
		}
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

		let lastGroup = '';
		sessions.forEach((s) => {
			const group = historyGroupKey(s.updatedAt);
			if (group !== lastGroup) {
				lastGroup = group;
				const label = document.createElement('li');
				label.className = 'history-group-label';
				label.textContent = group;
				historyList.appendChild(label);
			}

			const li = document.createElement('li');
			const row = document.createElement('div');
			row.className = 'history-item' + (s.active ? ' active' : '');
			row.innerHTML =
				'<button type="button" class="meta">' +
				'<span class="title-row"><span class="title"></span><span class="source-pill"></span></span>' +
				'<span class="sub"></span>' +
				'</button>' +
				'<span class="row-mark" hidden></span>' +
				'<button type="button" class="del" title="删除">×</button>';
			row.querySelector('.title').textContent = s.title || '新对话';
			row.querySelector('.source-pill').textContent = sourceLabel(s.source);
			row.querySelector('.sub').textContent = formatTime(s.updatedAt);
			const mark = row.querySelector('.row-mark');
			if (s.running || s.done) {
				mark.hidden = false;
				mark.className = 'row-mark ' + (s.running ? 'running' : 'done');
			}
			row.querySelector('.meta').onclick = () => {
				setHistoryOpen(false);
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
				'<button type="button" class="undo" title="撤销此文件（需确认）">Undo</button>' +
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
			chip.title = a.title || a.name;
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
		const map = {
			provider: providerBtn,
			model: modelBtn,
			thought: thoughtBtn,
			cursorMode: cursorModeBtn,
			cursorModel: cursorModelBtn,
		};
		if (map[kind]) map[kind].setAttribute('aria-expanded', 'true');
	}

	function autosize() {
		inputEl.style.height = 'auto';
		inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
	}

	/** Chat stream text size, pushed from the `zcode.chatFontSize` setting. */
	function applyFontSize(fontSize) {
		if (typeof fontSize !== 'number' || !Number.isFinite(fontSize) || fontSize <= 0) {
			return;
		}
		document.documentElement.style.setProperty('--zcode-chat-font-size', `${fontSize}px`);
	}

	function render(next) {
		const wasBusy = busy;
		state = next;
		applyFontSize(next.fontSize);
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
		if (next.focusInput) {
			inputEl.focus();
		}

		const brain = next.brain || 'zcode';
		document.body.dataset.brain = brain;
		if (timelineRoot) timelineRoot.dataset.brain = brain;
		if (brainZcode) brainZcode.classList.toggle('active', brain === 'zcode');
		if (brainCursor) brainCursor.classList.toggle('active', brain === 'cursor');
		if (zcodePills) zcodePills.hidden = brain !== 'zcode';
		if (cursorPills) cursorPills.hidden = brain !== 'cursor';

		providerLabel.textContent =
			(next.providers || []).find((p) => p.id === next.provider)?.label || next.provider;
		modelLabel.textContent = next.model || 'Model';
		thoughtLabel.textContent = next.reasoningLabel || next.reasoningLevel || 'Thinking';
		if (cursorModeLabel) {
			cursorModeLabel.textContent =
				(next.cursorModes || []).find((m) => m.id === next.cursorMode)?.label || next.cursorMode || 'Agent';
		}
		if (cursorModelLabel) {
			cursorModelLabel.textContent = next.model || 'Default';
		}
		if (accountBtn) {
			accountBtn.textContent = next.signedIn ? next.accountLabel : (brain === 'cursor' ? 'Cursor login' : 'Sign in');
		}
		const rootLabel = next.workspaceRoot
			? String(next.workspaceRoot).split(/[/\\]/).filter(Boolean).slice(-2).join('/')
			: 'no folder';
		hintEl.textContent = [
			brain === 'cursor' ? 'Cursor' : 'ZCode',
			rootLabel,
			next.model || (brain === 'cursor' ? 'default model' : ''),
			brain === 'zcode' ? (next.reasoningLabel || next.reasoningLevel || '') : (next.cursorMode || 'agent'),
		].filter(Boolean).join(' · ');

		if (scheduleTipEl) {
			const tip = next.scheduleTip;
			if (tip && tip.message) {
				scheduleTipEl.hidden = false;
				scheduleTipEl.dataset.kind = tip.kind || '';
				scheduleTipEl.textContent = tip.message;
			} else {
				scheduleTipEl.hidden = true;
				scheduleTipEl.textContent = '';
				scheduleTipEl.removeAttribute('data-kind');
			}
		}

		historyOpen = !!next.historyOpen;
		renderTimeline(next.items || []);
		renderTodos(next.todos || []);
		renderWorkingSet(next.fileChanges || []);
		renderHistory(next.sessions || []);
		renderChips(next.attachments);
		renderQueue(next.queue, !!next.queuePaused);
		renderPlusMenu(next.plusSections);
		renderContextUsage(next.contextUsage);
		updateSendButton();

		if (next.openPlus) {
			openMenu = 'plus';
			plusMenu.classList.add('open');
			plusBtn.setAttribute('aria-expanded', 'true');
		}
	}

	function send() {
		const text = inputEl.value;
		if (busy && !hasComposerPayload()) {
			vscode.postMessage({ type: 'stop' });
			return;
		}
		if (!hasComposerPayload()) return;
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
	if (cursorModeBtn) {
		cursorModeBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (!state) return;
			openPicker('cursorMode', state.cursorModes || [], state.cursorMode, (id) =>
				vscode.postMessage({ type: 'setCursorMode', mode: id }),
			);
		});
	}
	if (cursorModelBtn) {
		cursorModelBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (!state) return;
			const models = (state.models && state.models.length)
				? state.models
				: [{ id: '', label: 'CLI default' }];
			openPicker('cursorModel', models, state.model || '', (id) =>
				vscode.postMessage({ type: 'setCursorModel', model: id }),
			);
		});
	}
	if (brainZcode) {
		brainZcode.addEventListener('click', () => vscode.postMessage({ type: 'setBrain', brain: 'zcode' }));
	}
	if (brainCursor) {
		brainCursor.addEventListener('click', () => vscode.postMessage({ type: 'setBrain', brain: 'cursor' }));
	}
	sendBtn.addEventListener('click', send);
	if (queueResume) {
		queueResume.addEventListener('click', () => vscode.postMessage({ type: 'resumeQueue' }));
	}
	if (accountBtn) {
		accountBtn.addEventListener('click', () => vscode.postMessage({ type: 'manageAccount' }));
	}
	if (historyClose) {
		historyClose.addEventListener('click', () => {
			setHistoryOpen(false);
		});
	}
	if (contextUsageBtn) {
		contextUsageBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			setContextPanelOpen(!contextPanelOpen);
		});
	}
	if (contextPanel) {
		contextPanel.addEventListener('click', (e) => e.stopPropagation());
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
			if (historyOpen) setHistoryOpen(false);
			return;
		}
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	});
	inputEl.addEventListener('input', () => {
		autosize();
		updateSendButton();
		vscode.postMessage({ type: 'draft', draft: inputEl.value });
	});
	async function copyCodeBlock(btn) {
		const block = btn.closest('.codeblock');
		const codeEl = block && block.querySelector('pre code');
		if (!codeEl) return;
		const text = codeEl.innerText.replace(/\n$/, '');
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			const ta = document.createElement('textarea');
			ta.value = text;
			ta.style.position = 'fixed';
			ta.style.left = '-9999px';
			document.body.appendChild(ta);
			ta.select();
			document.execCommand('copy');
			ta.remove();
		}
		btn.classList.add('copied');
		const prev = btn.textContent;
		btn.textContent = '已复制';
		setTimeout(() => {
			btn.classList.remove('copied');
			btn.textContent = prev || '复制';
		}, 1400);
	}

	document.addEventListener('click', (e) => {
		const copyBtn = e.target && e.target.closest && e.target.closest('.codeblock-copy');
		if (copyBtn) {
			e.preventDefault();
			e.stopPropagation();
			void copyCodeBlock(copyBtn);
			return;
		}
		if (!composer.contains(e.target)) closeMenus();
		if (historyOpen && historyDrawer && !historyDrawer.contains(e.target)) {
			setHistoryOpen(false);
		}
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && historyOpen) {
			setHistoryOpen(false);
		}
	});
	window.addEventListener('message', (event) => {
		const data = event.data;
		if (!data) return;
		if (data.type === 'state') render(data);
		if (data.type === 'contextUsage') renderContextUsage(data.contextUsage);
	});
	vscode.postMessage({ type: 'ready' });
})();
