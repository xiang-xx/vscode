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
	const paceBtn = document.getElementById('paceBtn');
	const providerLabel = document.getElementById('providerLabel');
	const modelLabel = document.getElementById('modelLabel');
	const thoughtLabel = document.getElementById('thoughtLabel');
	const paceLabel = document.getElementById('paceLabel');
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
	const claimBanner = document.getElementById('claimBanner');
	const claimTitle = document.getElementById('claimTitle');
	const claimMeta = document.getElementById('claimMeta');
	const claimError = document.getElementById('claimError');
	const claimBtn = document.getElementById('claimBtn');
	const quotaChip = document.getElementById('quotaChip');
	const quotaNotice = document.getElementById('quotaNotice');
	const quotaNoticeText = document.getElementById('quotaNoticeText');
	const quotaNoticeClose = document.getElementById('quotaNoticeClose');
	const contextUsagePct = document.getElementById('contextUsagePct');
	const contextPanel = document.getElementById('contextPanel');
	const contextPanelSummary = document.getElementById('contextPanelSummary');
	const contextPanelFill = document.getElementById('contextPanelFill');
	const contextBreakdown = document.getElementById('contextBreakdown');
	const contextPanelNote = document.getElementById('contextPanelNote');

	let busy = false;
	let state = null;
	let openMenu = null;
	let skillItems = [];
	let skillIndex = 0;
	let skillRange = null;
	let slashItems = [];
	let slashIndex = 0;
	let slashRange = null;
	let mentionItems = [];
	let mentionIndex = 0;
	let mentionRange = null;
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
	/** Follow the bottom while a reply grows. An upward user scroll releases
	 *  the follow; scrolling back to the bottom grabs it again. */
	let timelineStickBottom = true;
	/** Subpixel slack. A real upward gesture releases even inside this range. */
	const TIMELINE_BOTTOM_EPSILON = 2;
	let timelineScrollProgrammatic = 0;
	let timelineStickFollowFrame = 0;
	/** 'away' | 'toward' | 'none' — set by the gesture, consumed by the scroll event. */
	let timelineUserIntent = 'none';
	let timelineUserIntentAt = 0;
	/** Ignore an at-bottom scroll that is just the tail of an upward gesture. */
	let timelineSuppressRepinUntil = 0;
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

	function iconSvg(body) {
		return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
	}

	const TOOL_ICON = {
		check: iconSvg('<path d="M20 6 9 17l-5-5"/>'),
		spin: iconSvg('<path d="M21 12a9 9 0 1 1-6.219-8.56"/>'),
		read: iconSvg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>'),
		edit: iconSvg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
		shell: iconSvg('<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>'),
		search: iconSvg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
		list: iconSvg('<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>'),
		globe: iconSvg('<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
		trash: iconSvg('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
		todo: iconSvg('<path d="M11 18H3"/><path d="m15 18 2 2 4-4"/><path d="M16 6H3"/><path d="M16 12H3"/>'),
		ask: iconSvg('<path d="M7 7h10"/><path d="M7 12h6"/><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
		default: iconSvg('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
	};

	function normalizeToolKey(name) {
		const raw = String(name || '').trim();
		const lower = raw.toLowerCase();
		if (/^called\s+mcp/.test(lower) || lower.includes('mcp tool')) return 'mcp';
		if (/^ran\s+shell|^shell$|^bash$|^terminal/.test(lower)) return 'shell';
		if (/^edited?\b|^edit\b|^wrote\b|^write\b/.test(lower)) return 'edit';
		if (/^read\b|^reading\b/.test(lower)) return 'read';
		if (/^explor|^search|^grep|^glob/.test(lower)) return 'search';
		if (/^listed?\b|^list\b/.test(lower)) return 'list';
		if (/browser|navigate|fetch|web/.test(lower)) return 'browser';
		return raw;
	}

	function toolIcon(name, status) {
		if (status === 'done') {
			return TOOL_ICON.check;
		}
		if (status === 'running') {
			return TOOL_ICON.spin;
		}
		switch (normalizeToolKey(name)) {
			case 'read_file':
			case 'Read':
			case 'read':
				return TOOL_ICON.read;
			case 'write_file':
			case 'Write':
			case 'str_replace':
			case 'Edit':
			case 'edit':
				return TOOL_ICON.edit;
			case 'mcp':
				return TOOL_ICON.default;
			case 'delete_file':
			case 'Delete':
				return TOOL_ICON.trash;
			case 'run_terminal_cmd':
			case 'Bash':
			case 'bash':
			case 'shell':
				return TOOL_ICON.shell;
			case 'grep':
			case 'Grep':
			case 'glob':
			case 'Glob':
			case 'search':
				return TOOL_ICON.search;
			case 'list_dir':
			case 'list':
				return TOOL_ICON.list;
			case 'web_fetch':
			case 'WebFetch':
			case 'open_browser_page':
			case 'browser_navigate':
			case 'browser_reload':
			case 'browser_go_back':
			case 'browser_go_forward':
			case 'browser_new_tab':
			case 'browser_list_or_open':
			case 'browser':
				return TOOL_ICON.globe;
			case 'TodoWrite':
				return TOOL_ICON.todo;
			case 'AskUserQuestion':
				return TOOL_ICON.ask;
			default:
				return TOOL_ICON.default;
		}
	}

	const REASONING_MARK = iconSvg('<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/>');

	function toolTitle(name) {
		const key = normalizeToolKey(name);
		switch (key) {
			case 'read_file':
			case 'Read':
			case 'read': return 'Read';
			case 'write_file':
			case 'Write': return 'Wrote';
			case 'str_replace':
			case 'Edit':
			case 'edit': return 'Edited';
			case 'delete_file':
			case 'Delete': return 'Deleted';
			case 'list_dir':
			case 'list': return 'Listed';
			case 'run_terminal_cmd':
			case 'Bash':
			case 'bash':
			case 'shell': return 'Run';
			case 'get_diagnostics': return 'Checked';
			case 'web_fetch':
			case 'WebFetch': return 'Fetched';
			case 'grep':
			case 'Grep':
			case 'glob':
			case 'Glob':
			case 'search': return 'Explored';
			case 'mcp': return 'Used';
			case 'open_browser_page':
			case 'browser_navigate':
			case 'browser_reload':
			case 'browser_go_back':
			case 'browser_go_forward':
			case 'browser_new_tab':
			case 'browser_list_or_open':
			case 'browser_toggle_devtools':
			case 'browser': return 'Browsed';
			case 'browser_import_chrome_data': return 'Synced';
			case 'TodoWrite': return 'Todos';
			case 'AskUserQuestion': return 'Asked';
			default: {
				const raw = String(name || '').trim();
				// Cursor ACP titles are already sentence-case verbs — keep short.
				if (/^(called|ran|edited|read|explored|searched|listed|wrote)\b/i.test(raw)) {
					return raw.replace(/\s+mcp\s+tool/i, ' MCP').split(/\s+/).slice(0, 2).join(' ');
				}
				return raw.length > 28 ? raw.slice(0, 26) + '…' : raw;
			}
		}
	}

	function isGenericToolSummary(text) {
		const t = String(text || '').trim().toLowerCase();
		return !t
			|| t === 'tool'
			|| t === 'other'
			|| t === 'mcp: tool'
			|| t === 'mcp tool'
			|| t === 'called mcp tool'
			|| t === 'pending'
			|| t === 'in_progress'
			|| t === 'completed'
			|| t === 'failed'
			|| t === 'error'
			|| t === 'done'
			|| t === 'running';
	}

	function toolSummaryText(item) {
		const path = typeof item.path === 'string' ? item.path.trim() : '';
		const summary = typeof item.summary === 'string' ? item.summary.trim() : '';
		const title = toolTitle(item.toolName);
		if (path) {
			return path;
		}
		if (!summary || isGenericToolSummary(summary) || summary === item.toolName || summary === title) {
			return '';
		}
		// Drop redundant leading verb if summary already repeats the title.
		if (summary.toLowerCase().startsWith(String(item.toolName || '').toLowerCase())) {
			const rest = summary.slice(String(item.toolName || '').length).replace(/^[:\s\-—]+/, '');
			return isGenericToolSummary(rest) ? '' : (rest || '');
		}
		return summary;
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
		if (status === 'in_progress') return '→';
		return '○';
	}

	function closeMenus() {
		openMenu = null;
		if (plusMenu) plusMenu.classList.remove('open');
		pickerMenu.classList.remove('open', 'skill-picker');
		pickerMenu.style.left = '';
		pickerMenu.style.bottom = '';
		pickerMenu.style.width = '';
		skillRange = null;
		skillItems = [];
		skillIndex = 0;
		slashRange = null;
		slashItems = [];
		slashIndex = 0;
		mentionRange = null;
		mentionItems = [];
		mentionIndex = 0;
		plusBtn.setAttribute('aria-expanded', 'false');
		providerBtn.setAttribute('aria-expanded', 'false');
		modelBtn.setAttribute('aria-expanded', 'false');
		thoughtBtn.setAttribute('aria-expanded', 'false');
		if (paceBtn) {
			paceBtn.setAttribute('aria-expanded', 'false');
		}
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
		[plusBtn, providerBtn, modelBtn, paceBtn, thoughtBtn, inputEl].forEach((el) => {
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

	function timelineIsAtBottom() {
		return timelineEl.scrollHeight - timelineEl.scrollTop - timelineEl.clientHeight <= TIMELINE_BOTTOM_EPSILON;
	}

	function writeTimelineScrollTop(top) {
		timelineScrollProgrammatic++;
		timelineEl.scrollTop = top;
		timelineScrollProgrammatic--;
	}

	function releaseTimelineStick() {
		timelineStickBottom = false;
		timelineStickFollowFrame++;
	}

	function markTimelineIntent(intent) {
		timelineUserIntent = intent;
		timelineUserIntentAt = performance.now();
		if (intent === 'away') {
			releaseTimelineStick();
			timelineSuppressRepinUntil = timelineUserIntentAt + 180;
		}
	}

	function consumeTimelineIntent() {
		if (performance.now() - timelineUserIntentAt > 250) {
			timelineUserIntent = 'none';
		}
		const intent = timelineUserIntent;
		timelineUserIntent = 'none';
		return intent;
	}

	/** Wheel/keys inside a nested scroller should not change the transcript follow. */
	function nestedScrollerConsumes(target, direction) {
		let node = target instanceof Element ? target : null;
		while (node && node !== timelineEl) {
			if (node.matches && node.matches('.reasoning-body, .tool-diff')
				&& node.scrollHeight > node.clientHeight + 1) {
				const remaining = node.scrollHeight - node.scrollTop - node.clientHeight;
				if (direction < 0 && node.scrollTop > 0) return true;
				if (direction > 0 && remaining > 1) return true;
			}
			node = node.parentElement;
		}
		return false;
	}

	function scrollTimelineToBottom() {
		if (!timelineStickBottom) {
			return;
		}
		const frame = ++timelineStickFollowFrame;
		writeTimelineScrollTop(timelineEl.scrollHeight);
		requestAnimationFrame(() => {
			if (frame !== timelineStickFollowFrame || !timelineStickBottom) {
				return;
			}
			writeTimelineScrollTop(timelineEl.scrollHeight);
		});
	}

	function pinTimelineToBottom() {
		timelineStickBottom = true;
		timelineSuppressRepinUntil = 0;
		scrollTimelineToBottom();
	}

	function bindToggle(el, message) {
		el.addEventListener('pointerdown', (event) => {
			if (event.button !== 0) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			vscode.postMessage(message);
		});
		el.addEventListener('keydown', (event) => {
			if (event.key !== 'Enter' && event.key !== ' ') {
				return;
			}
			event.preventDefault();
			vscode.postMessage(message);
		});
	}

	function lastReasoningLine(text) {
		const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			const line = (lines[index] || '').trim();
			if (line) return line;
		}
		return '';
	}

	function fillReasoningChrome(row, item) {
		const label = row.querySelector('.reasoning-header .label');
		const dur = row.querySelector('.reasoning-header .dur');
		const sep = row.querySelector('.reasoning-header .sep');
		const stream = row.querySelector('.reasoning-header .stream-line');
		if (label) label.textContent = item.streaming ? 'Thinking' : 'Thought';
		// While streaming and collapsed: one-line peek. When done: label + duration only.
		const summary = item.streaming && !item.expanded ? lastReasoningLine(item.text) : '';
		const durText = !item.streaming && item.durationLabel ? item.durationLabel : '';
		if (stream) {
			stream.textContent = summary;
			stream.hidden = !summary;
			if (summary) stream.scrollLeft = stream.scrollWidth;
		}
		if (dur) {
			dur.textContent = durText;
			dur.hidden = !durText;
		}
		if (sep) sep.hidden = !(summary || durText);
	}

	function renderReasoning(item, host) {
		const row = document.createElement('div');
		row.className = 'reasoning-row' + (item.streaming ? ' streaming' : '') + (item.expanded ? ' expanded' : ' collapsed');
		row.dataset.id = item.id;
		const header = document.createElement('button');
		header.type = 'button';
		header.className = 'reasoning-header';
		header.innerHTML = `<span class="mark" aria-hidden="true">${REASONING_MARK}</span><span class="label"></span><span class="sep" aria-hidden="true">·</span><span class="dur"></span><span class="stream-line"></span><span class="chev" aria-hidden="true"></span>`;
		bindToggle(header, { type: 'toggleReasoning', id: item.id });
		row.appendChild(header);
		fillReasoningChrome(row, item);
		if (item.expanded) {
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
		pre.dataset.raw = String(detail || '');
		container.appendChild(pre);
	}

	function renderTool(item, host) {
		const row = document.createElement('div');
		row.className = 'tool-row ' + (item.status || '')
			+ (item.expanded ? ' expanded' : ' collapsed')
			+ ' expandable';

		const header = document.createElement('button');
		header.type = 'button';
		header.className = 'tool-header';
		header.innerHTML =
			'<span class="glyph"></span>' +
			'<span class="name"></span>' +
			'<span class="summary"></span>' +
			((item.added || item.removed)
				? '<span class="tool-stats"><span class="add"></span><span class="del"></span></span>'
				: '') +
			'<span class="chev" aria-hidden="true"></span>';
		header.querySelector('.glyph').innerHTML = toolIcon(item.toolName, item.status);
		const title = toolTitle(item.toolName);
		const summaryText = toolSummaryText(item);
		// Cursor-style: one quiet line — "Edited path" / "Run cmd", not stacked cards.
		if (summaryText) {
			header.querySelector('.name').textContent = title;
			header.querySelector('.summary').textContent = summaryText;
			header.querySelector('.summary').hidden = false;
		} else {
			header.querySelector('.name').textContent = title;
			header.querySelector('.summary').textContent = '';
			header.querySelector('.summary').hidden = true;
		}
		const stats = header.querySelector('.tool-stats');
		if (stats) {
			stats.querySelector('.add').textContent = item.added ? `+${item.added}` : '';
			stats.querySelector('.del').textContent = item.removed ? `-${item.removed}` : '';
		}
		bindToggle(header, { type: 'toggleTool', id: item.id });
		row.appendChild(header);

		if (item.expanded) {
			const body = document.createElement('div');
			body.className = 'tool-detail';
			const text = item.detail || item.summary || '';
			if (text) {
				renderDiffDetail(body, text);
			} else {
				const empty = document.createElement('div');
				empty.className = 'tool-detail-empty';
				empty.textContent = item.status === 'running' ? '正在执行…' : '暂无预览内容';
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

	function expansionMatches(items) {
		for (const item of items) {
			if (item.kind !== 'reasoning' && item.kind !== 'tool') {
				continue;
			}
			const el = timelineEl.querySelector(`[data-item-id="${CSS.escape(item.id)}"]`);
			if (!el || el.classList.contains('expanded') !== !!item.expanded) {
				return false;
			}
		}
		return true;
	}

	function patchReasoningRow(item) {
		const row = timelineEl.querySelector(`.reasoning-row[data-item-id="${CSS.escape(item.id)}"], .reasoning-row[data-id="${CSS.escape(item.id)}"]`);
		if (!row) {
			return false;
		}
		row.className = 'reasoning-row'
			+ (item.streaming ? ' streaming' : '')
			+ (item.expanded ? ' expanded' : ' collapsed');
		row.dataset.id = item.id;
		fillReasoningChrome(row, item);
		let body = row.querySelector('.reasoning-body');
		if (!item.expanded) {
			if (body) {
				body.remove();
			}
			return true;
		}
		if (!body) {
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
		return true;
	}

	function patchToolRow(item) {
		const row = timelineEl.querySelector(`.tool-row[data-item-id="${CSS.escape(item.id)}"]`);
		if (!row) {
			return false;
		}
		const nextClass = 'tool-row ' + (item.status || '')
			+ (item.expanded ? ' expanded' : ' collapsed')
			+ ' expandable';
		if (row.className !== nextClass) {
			row.className = nextClass;
		}
		const glyph = row.querySelector('.tool-header .glyph');
		if (glyph) {
			glyph.innerHTML = toolIcon(item.toolName, item.status);
		}
		const name = row.querySelector('.tool-header .name');
		if (name) {
			name.textContent = toolTitle(item.toolName);
		}
		const summary = row.querySelector('.tool-header .summary');
		if (summary) {
			const summaryText = toolSummaryText(item);
			if (summary.textContent !== summaryText) {
				summary.textContent = summaryText;
			}
			summary.hidden = !summaryText;
		}
		let stats = row.querySelector('.tool-header .tool-stats');
		if (item.added || item.removed) {
			if (!stats) {
				stats = document.createElement('span');
				stats.className = 'tool-stats';
				stats.innerHTML = '<span class="add"></span><span class="del"></span>';
				const header = row.querySelector('.tool-header');
				const chevron = header?.querySelector('.chev');
				if (header && chevron) {
					header.insertBefore(stats, chevron);
				} else {
					header?.appendChild(stats);
				}
			}
			const add = stats.querySelector('.add');
			const del = stats.querySelector('.del');
			if (add) {
				add.textContent = item.added ? `+${item.added}` : '';
			}
			if (del) {
				del.textContent = item.removed ? `-${item.removed}` : '';
			}
		} else if (stats) {
			stats.remove();
		}

		let body = row.querySelector('.tool-detail');
		if (!item.expanded) {
			if (body) {
				body.remove();
			}
			return true;
		}
		const text = item.detail || item.summary || '';
		const pre = body?.querySelector('.tool-diff');
		if (body && pre && pre.dataset.raw === text) {
			return true;
		}
		if (!body) {
			body = document.createElement('div');
			body.className = 'tool-detail';
			row.appendChild(body);
		} else {
			body.innerHTML = '';
		}
		if (text) {
			renderDiffDetail(body, text);
		} else {
			const empty = document.createElement('div');
			empty.className = 'tool-detail-empty';
			empty.textContent = item.status === 'running' ? '正在执行…' : '暂无预览内容';
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
		return true;
	}

	/**
	 * In-place timeline update when item ids/order are unchanged.
	 * Avoids innerHTML rebuild so running spinners (tools / work) keep animating
	 * while reasoning / assistant / status text streams in.
	 */
	function tryPatchTimeline(items) {
		if (!items || !items.length) {
			return false;
		}
		const existingIds = [...timelineEl.querySelectorAll('[data-item-id]')].map((el) => el.getAttribute('data-item-id'));
		const nextIds = items.map((i) => i.id);
		const sameItems = existingIds.length === nextIds.length && existingIds.every((id, idx) => id === nextIds[idx]);
		// Streaming mostly appends rows (new reasoning / tool / assistant). Keep the existing
		// DOM and build only the new tail so text selections survive and cost stays O(delta).
		const appendOnly = !sameItems
			&& existingIds.length > 0
			&& nextIds.length > existingIds.length
			&& existingIds.every((id, idx) => id === nextIds[idx]);
		if (!sameItems && !appendOnly) {
			return false;
		}
		if (!expansionMatches(items)) {
			return false;
		}
		if (appendOnly && !appendTimelineItems(items, existingIds.length)) {
			return false;
		}
		const actions = turnActionIds(items);

		for (const item of items) {
			const el = timelineEl.querySelector(`[data-item-id="${CSS.escape(item.id)}"]`);
			if (!el) {
				return false;
			}
			if (item.kind === 'reasoning') {
				if (!patchReasoningRow(item)) {
					return false;
				}
				continue;
			}
			if (item.kind === 'work') {
				const nextClass = 'work-row' + (item.running ? ' running' : '');
				if (el.className !== nextClass) {
					el.className = nextClass;
				}
				const textEl = el.querySelector('.text');
				if (textEl) {
					const dur = item.durationLabel || '';
					let text;
					if (item.running) {
						text = dur ? `已运行 ${dur}` : '工作中…';
					} else if (item.label === 'Failed') {
						text = dur ? `失败 · ${dur}` : '失败';
					} else {
						text = dur ? `完成 · ${dur}` : '完成';
					}
					if (textEl.textContent !== text) {
						textEl.textContent = text;
					}
				}
				continue;
			}
			if (item.kind === 'tool') {
				if (!patchToolRow(item)) {
					return false;
				}
				continue;
			}
			if (item.kind === 'assistant') {
				const body = el.querySelector('.assistant-body');
				if (!body) {
					return false;
				}
				const nextClass = 'assistant-body rendered-markdown' + (item.streaming ? ' streaming' : '');
				if (body.className !== nextClass) {
					body.className = nextClass;
				}
				const html = renderMarkdown(item.text || '');
				if (body.innerHTML !== html) {
					body.innerHTML = html;
				}
				syncRowActions(el, actions.retry.has(item.id) ? ['retry'] : [], false);
				continue;
			}
			if (item.kind === 'status') {
				const nextClass = 'status-row' + (item.tone === 'error' ? ' error' : '');
				if (el.className !== nextClass) {
					return false;
				}
				if (item.tone === 'error') {
					if (el.textContent !== item.text) {
						el.textContent = item.text;
					}
				} else {
					const textEl = el.querySelector('.text');
					if (textEl && textEl.textContent !== item.text) {
						textEl.textContent = item.text;
					}
				}
				continue;
			}
			if (item.kind === 'user') {
				const bubble = el.querySelector('.user-bubble');
				const key = (item.text || '') + '|' + JSON.stringify(item.attachments || []);
				if (!bubble || bubble.dataset.key !== key) {
					return false;
				}
				syncRowActions(el, actions.rewind.has(item.id) ? ['rewind'] : [], true);
				continue;
			}
			if (item.kind === 'question') {
				// Questions need full rebuild for interactive controls.
				return false;
			}
			if (item.kind === 'summary') {
				continue;
			}
			return false;
		}

		scrollTimelineToBottom();
		timelineContentKey = timelineKey(items);
		return true;
	}

	/**
	 * Reconcile the conditional action buttons (rewind on user rows, retry on
	 * assistant rows) without rebuilding the row. keepEdit keeps the "修改" button.
	 */
	function syncRowActions(row, wanted, keepEdit) {
		let actions = row.querySelector(':scope > .turn-actions');
		if (!wanted.length && !keepEdit) {
			if (actions) {
				actions.remove();
			}
			return;
		}
		if (!actions) {
			actions = document.createElement('div');
			actions.className = 'turn-actions';
			actions.hidden = !!(state && state.busy);
			row.appendChild(actions);
		}
		const id = row.getAttribute('data-item-id');
		const find = (name) => actions.querySelector(`[data-turn-action="${name}"]`);
		[['rewind', '回到这里'], ['retry', '重试']].forEach(([name, label]) => {
			const has = find(name);
			const need = wanted.includes(name);
			if (need && !has) {
				actions.insertBefore(turnActionButton(label, name, id), keepEdit ? find('editUser') : null);
			} else if (!need && has) {
				has.remove();
			}
		});
		if (keepEdit && !find('editUser')) {
			actions.appendChild(turnActionButton('修改', 'editUser', id));
		}
	}

	/**
	 * Append-only streaming fast path: the existing DOM is untouched and only the
	 * new rows are built into the last turn. Falls back (returns false) for kinds
	 * that start new turns or need interactive controls — the caller then does a
	 * full rebuild.
	 */
	function appendTimelineItems(items, fromIndex) {
		const lastTurn = timelineEl.lastElementChild;
		if (!lastTurn || !lastTurn.classList.contains('turn')) {
			return false;
		}
		for (let i = fromIndex; i < items.length; i++) {
			const kind = items[i].kind;
			if (kind === 'user' || kind === 'summary' || kind === 'question' || !kind) {
				return false;
			}
		}
		const ctx = {
			turnActions: turnActionIds(items),
			ensureTurn() { return lastTurn; },
			startTurn() { return null; }
		};
		for (let i = fromIndex; i < items.length; i++) {
			renderTimelineItem(items[i], ctx);
		}
		return true;
	}

	function renderTimelineItem(item, ctx) {
		const mark = (el, id) => {
			el.setAttribute('data-item-id', id);
			return el;
		};
		if (item.kind === 'user') {
			const turn = ctx.startTurn();
			if (!turn) {
				return;
			}
			const row = mark(document.createElement('div'), item.id);
			row.className = 'user-row';
			const bubble = document.createElement('div');
			bubble.className = 'user-bubble';
			bubble.dataset.key = (item.text || '') + '|' + JSON.stringify(item.attachments || []);
			if (item.text) {
				const textEl = document.createElement('div');
				textEl.className = 'user-text';
				textEl.textContent = item.text;
				bubble.appendChild(textEl);
			}
			const atts = Array.isArray(item.attachments) ? item.attachments : [];
			if (atts.length) {
				const list = document.createElement('div');
				list.className = 'user-attachments';
				atts.forEach((a) => {
					if (a.image && a.uri) {
						const thumb = document.createElement('img');
						thumb.className = 'attach-thumb';
						thumb.src = a.uri;
						thumb.title = a.name || '图片附件';
						thumb.alt = a.name || '图片附件';
						thumb.addEventListener('click', () => {
							vscode.postMessage({ type: 'openAttachment', path: a.path });
						});
						list.appendChild(thumb);
					} else {
						const pill = document.createElement('span');
						pill.className = 'attach-pill';
						pill.textContent = (a.image ? '🖼 ' : '📄 ') + (a.name || '附件');
						if (a.path) {
							pill.title = a.path;
							pill.addEventListener('click', () => {
								vscode.postMessage({ type: 'openAttachment', path: a.path });
							});
						}
						list.appendChild(pill);
					}
				});
				bubble.appendChild(list);
			}
			row.appendChild(bubble);
			const actions = document.createElement('div');
			actions.className = 'turn-actions';
			actions.hidden = !!(state && state.busy);
			if (ctx.turnActions.rewind.has(item.id)) {
				actions.appendChild(turnActionButton('回到这里', 'rewind', item.id));
			}
			actions.appendChild(turnActionButton('修改', 'editUser', item.id));
			row.appendChild(actions);
			turn.appendChild(row);
			return;
		}
		if (item.kind === 'summary') {
			const turn = ctx.startTurn();
			if (!turn) {
				return;
			}
			const row = mark(document.createElement('div'), item.id);
			row.className = 'summary-row';
			const label = document.createElement('div');
			label.className = 'summary-label';
			label.textContent = `已压缩更早的 ${item.turnCount || 1} 轮对话`;
			const body = document.createElement('div');
			body.className = 'summary-body';
			body.textContent = item.text || '';
			row.appendChild(label);
			row.appendChild(body);
			turn.appendChild(row);
			return;
		}

		const host = ctx.ensureTurn();
		if (!host) {
			return;
		}
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
			if (ctx.turnActions.retry.has(item.id)) {
				const actions = document.createElement('div');
				actions.className = 'turn-actions';
				actions.hidden = !!(state && state.busy);
				actions.appendChild(turnActionButton('重试', 'retry', item.id));
				row.appendChild(actions);
			}
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
	}

	let timelineContentKey = '';

	function timelineKey(items) {
		return (items || []).map((item) => {
			if (item.kind === 'work') {
				return `${item.id}|w|${item.running ? 1 : 0}|${item.label || ''}`;
			}
			if (item.kind === 'reasoning') {
				return `${item.id}|r|${item.expanded ? 1 : 0}|${item.streaming ? 1 : 0}|${item.text || ''}|${item.durationLabel || ''}`;
			}
			if (item.kind === 'tool') {
				return `${item.id}|t|${item.expanded ? 1 : 0}|${item.status || ''}|${item.summary || ''}|${item.detail || ''}|${item.path || ''}|${item.uri || ''}|${item.added || ''}|${item.removed || ''}`;
			}
			if (item.kind === 'assistant') {
				return `${item.id}|a|${item.streaming ? 1 : 0}|${item.text || ''}`;
			}
			if (item.kind === 'user') {
				return `${item.id}|u|${item.text || ''}|${JSON.stringify(item.attachments || [])}`;
			}
			if (item.kind === 'question') {
				return `${item.id}|q|${item.status || ''}|${JSON.stringify(item.answers || '')}`;
			}
			if (item.kind === 'status') {
				return `${item.id}|s|${item.tone || ''}|${item.text || ''}`;
			}
			return `${item.id}|${item.kind}|${item.text || ''}|${item.status || ''}`;
		}).join('\u0001');
	}

	function patchWorkLabel(items) {
		const work = items.find((i) => i.kind === 'work' && i.running);
		if (!work) {
			return;
		}
		const workEl = timelineEl.querySelector(`.work-row[data-item-id="${CSS.escape(work.id)}"] .text`);
		if (!workEl) {
			return;
		}
		const d = work.durationLabel || '';
		workEl.textContent = d ? `已运行 ${d}` : '工作中…';
	}

	function tryPatchElapsed(items) {
		if (!items || !items.length || timelineKey(items) !== timelineContentKey) {
			return false;
		}
		const existingIds = [...timelineEl.querySelectorAll('[data-item-id]')].map((el) => el.getAttribute('data-item-id'));
		const nextIds = items.map((i) => i.id);
		if (existingIds.length !== nextIds.length || existingIds.some((id, idx) => id !== nextIds[idx])) {
			return false;
		}
		patchWorkLabel(items);
		return true;
	}

	function turnActionButton(label, action, id) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'turn-action';
		btn.dataset.turnAction = action;
		btn.dataset.itemId = id;
		btn.textContent = label;
		return btn;
	}

	function turnActionIds(items) {
		const rewind = new Set();
		const retry = new Set();
		let userId = null;
		let lastAssistant = null;
		let sawAfter = false;
		const flush = () => {
			if (userId && sawAfter) {
				rewind.add(userId);
			}
			if (userId && lastAssistant) {
				retry.add(lastAssistant);
			}
		};
		for (const item of items || []) {
			if (item.kind === 'user') {
				flush();
				userId = item.id;
				lastAssistant = null;
				sawAfter = false;
				continue;
			}
			if (!userId) {
				continue;
			}
			sawAfter = true;
			if (item.kind === 'assistant' && item.text && !item.streaming) {
				lastAssistant = item.id;
			}
		}
		flush();
		return { rewind, retry };
	}

	function syncTurnActions() {
		const locked = !!(state && state.busy);
		timelineEl.querySelectorAll('.turn-actions').forEach((el) => {
			el.hidden = locked;
		});
	}

	function renderClaim(next) {
		if (!claimBanner) {
			return;
		}
		const offer = next && next.claimOffer;
		if (!offer) {
			claimBanner.hidden = true;
			return;
		}
		claimBanner.hidden = false;
		if (claimTitle) claimTitle.textContent = offer.name || '免费额度';
		if (claimMeta) claimMeta.textContent = offer.detail || '';
		if (claimError) {
			claimError.hidden = !next.claimError;
			claimError.textContent = next.claimError || '';
		}
		if (claimBtn) {
			claimBtn.disabled = !!next.claimBusy;
			claimBtn.textContent = next.claimBusy ? '领取中…' : '领取';
			claimBtn.dataset.planId = offer.planId || '';
		}
	}

	function renderQuotaNotice(notice) {
		if (!quotaNotice) {
			return;
		}
		if (!notice || !notice.text) {
			quotaNotice.hidden = true;
			return;
		}
		quotaNotice.hidden = false;
		if (quotaNoticeText) quotaNoticeText.textContent = notice.text;
		if (quotaNoticeClose) quotaNoticeClose.dataset.noticeId = notice.id || '';
	}

	function currentSkillQuery() {
		const caret = inputEl.selectionStart ?? inputEl.value.length;
		const before = inputEl.value.slice(0, caret);
		const match = /(?:^|[\s\n])\$([A-Za-z0-9._-]*)$/.exec(before);
		if (!match) {
			return null;
		}
		return { query: match[1], start: caret - match[1].length - 1, end: caret };
	}

	function syncSkillQuery() {
		const next = currentSkillQuery();
		if (!next) {
			if (openMenu === 'skill') closeMenus();
			return;
		}
		skillRange = { start: next.start, end: next.end };
		vscode.postMessage({ type: 'querySkills', query: next.query });
	}


	function currentSlashQuery() {
		const caret = inputEl.selectionStart ?? inputEl.value.length;
		const before = inputEl.value.slice(0, caret);
		// Slash commands only count at the very start of the draft.
		const match = /^\/([A-Za-z0-9_-]*)$/.exec(before);
		if (!match) {
			return null;
		}
		return { query: match[1], start: 0, end: caret };
	}

	function currentMentionQuery() {
		const caret = inputEl.selectionStart ?? inputEl.value.length;
		const before = inputEl.value.slice(0, caret);
		const match = /(?:^|[\s\n])@([^\s\n@]*)$/.exec(before);
		if (!match) {
			return null;
		}
		return { query: match[1], start: caret - match[1].length - 1, end: caret };
	}

	function syncSlashQuery() {
		const next = currentSlashQuery();
		if (!next) {
			if (openMenu === 'slash') closeMenus();
			return;
		}
		slashRange = { start: next.start, end: next.end };
		vscode.postMessage({ type: 'querySlash', query: next.query });
	}

	function syncMentionQuery() {
		const next = currentMentionQuery();
		if (!next) {
			if (openMenu === 'mention') closeMenus();
			return;
		}
		mentionRange = { start: next.start, end: next.end };
		vscode.postMessage({ type: 'queryMentions', query: next.query });
	}
	function renderSkillMenu(skills) {
		const query = currentSkillQuery();
		if (!query || !skills.length) {
			if (openMenu === 'skill') closeMenus();
			return;
		}
		skillRange = { start: query.start, end: query.end };
		skillItems = skills;
		skillIndex = Math.max(0, Math.min(skillIndex, skills.length - 1));
		openMenu = 'skill';
		pickerMenu.innerHTML = '';
		pickerMenu.classList.add('open', 'picker', 'skill-picker');
		skills.forEach((skill, index) => {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'picker-item' + (index === skillIndex ? ' active' : '');
			btn.innerHTML = '<span class="skill-copy"><span class="title"></span><span class="desc"></span></span>';
			btn.querySelector('.title').textContent = '$' + skill.name;
			btn.querySelector('.desc').textContent = skill.description || (skill.scope === 'workspace' ? '项目技能' : '个人技能');
			btn.addEventListener('mousedown', (event) => {
				event.preventDefault();
				insertSkill(skill.name);
			});
			pickerMenu.appendChild(btn);
		});
		const rect = inputEl.getBoundingClientRect();
		pickerMenu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 240)) + 'px';
		pickerMenu.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
		pickerMenu.style.width = Math.min(380, Math.max(220, rect.width)) + 'px';
	}

	function insertSkill(name) {
		if (!skillRange) return;
		const value = inputEl.value;
		const insert = '$' + name + ' ';
		inputEl.value = value.slice(0, skillRange.start) + insert + value.slice(skillRange.end);
		const pos = skillRange.start + insert.length;
		closeMenus();
		inputEl.focus();
		inputEl.setSelectionRange(pos, pos);
		autosize();
		vscode.postMessage({ type: 'draft', draft: inputEl.value });
	}


	function renderSlashMenu(entries) {
		const query = currentSlashQuery();
		if (!query) {
			if (openMenu === 'slash') closeMenus();
			return;
		}
		const items = entries.length
			? entries
			: [{ placeholder: true, name: '无匹配命令', path: '无匹配命令', description: '', detail: '' }];
		slashRange = { start: query.start, end: query.end };
		slashItems = items;
		slashIndex = Math.max(0, Math.min(slashIndex, items.length - 1));
		openMenu = 'slash';
		pickerMenu.innerHTML = '';
		pickerMenu.classList.add('open', 'picker', 'skill-picker');
		items.forEach((entry, index) => {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'picker-item' + (index === slashIndex ? ' active' : '');
			btn.innerHTML = '<span class="skill-copy"><span class="title"></span><span class="desc"></span></span>';
			btn.querySelector('.title').textContent = entry.placeholder ? entry.name : '/' + (entry.path ?? entry.name);
			btn.querySelector('.desc').textContent = entry.description || entry.detail || '';
			if (!entry.placeholder) {
				btn.addEventListener('mousedown', (event) => {
					event.preventDefault();
					insertSlash(entry.path ?? entry.name);
				});
			}
			pickerMenu.appendChild(btn);
		});
		const rect = inputEl.getBoundingClientRect();
		pickerMenu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 240)) + 'px';
		pickerMenu.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
		pickerMenu.style.width = Math.min(380, Math.max(220, rect.width)) + 'px';
	}

	function insertSlash(value_) {
		if (!slashRange) return;
		const value = inputEl.value;
		const insert = '/' + value_ + ' ';
		inputEl.value = value.slice(0, slashRange.start) + insert + value.slice(slashRange.end);
		const pos = slashRange.start + insert.length;
		closeMenus();
		inputEl.focus();
		inputEl.setSelectionRange(pos, pos);
		autosize();
		vscode.postMessage({ type: 'draft', draft: inputEl.value });
	}

	function renderMentionMenu(entries) {
		const query = currentMentionQuery();
		if (!query) {
			if (openMenu === 'mention') closeMenus();
			return;
		}
		const items = entries.length
			? entries
			: [{ placeholder: true, name: '无匹配文件', path: '无匹配文件', description: '', detail: '' }];
		mentionRange = { start: query.start, end: query.end };
		mentionItems = items;
		mentionIndex = Math.max(0, Math.min(mentionIndex, items.length - 1));
		openMenu = 'mention';
		pickerMenu.innerHTML = '';
		pickerMenu.classList.add('open', 'picker', 'skill-picker');
		items.forEach((entry, index) => {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'picker-item' + (index === mentionIndex ? ' active' : '');
			btn.innerHTML = '<span class="skill-copy"><span class="title"></span><span class="desc"></span></span>';
			btn.querySelector('.title').textContent = entry.placeholder ? entry.name : '@' + (entry.path ?? entry.name);
			btn.querySelector('.desc').textContent = entry.description || entry.detail || '';
			if (!entry.placeholder) {
				btn.addEventListener('mousedown', (event) => {
					event.preventDefault();
					insertMention(entry.path ?? entry.name);
				});
			}
			pickerMenu.appendChild(btn);
		});
		const rect = inputEl.getBoundingClientRect();
		pickerMenu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 240)) + 'px';
		pickerMenu.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
		pickerMenu.style.width = Math.min(380, Math.max(220, rect.width)) + 'px';
	}

	function insertMention(value_) {
		if (!mentionRange) return;
		const value = inputEl.value;
		const insert = '@' + value_ + ' ';
		inputEl.value = value.slice(0, mentionRange.start) + insert + value.slice(mentionRange.end);
		const pos = mentionRange.start + insert.length;
		closeMenus();
		inputEl.focus();
		inputEl.setSelectionRange(pos, pos);
		autosize();
		vscode.postMessage({ type: 'draft', draft: inputEl.value });
	}
	function renderQuota(quota) {
		if (!quotaChip) {
			return;
		}
		const line = quota && quota.lines && quota.lines[0];
		if (!line) {
			quotaChip.hidden = true;
			quotaChip.textContent = '';
			return;
		}
		quotaChip.hidden = false;
		quotaChip.textContent = `剩余 ${line.remainingLabel}`;
		const parts = [line.name, `剩余 ${line.remainingLabel}`];
		if (line.totalLabel) parts.push(`共 ${line.totalLabel}`);
		if (line.resetLabel) parts.push(line.resetLabel);
		for (const extra of quota.lines.slice(1)) {
			parts.push(`${extra.name} 剩余 ${extra.remainingLabel}${extra.resetLabel ? `，${extra.resetLabel}` : ''}`);
		}
		quotaChip.title = parts.filter(Boolean).join(' · ');
	}

	function renderTimeline(items) {
		if (tryPatchTimeline(items)) {
			return;
		}
		if (tryPatchElapsed(items)) {
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
			timelineContentKey = '';
			return;
		}

		const frag = document.createDocumentFragment();
		let turn = null;
		const ctx = {
			turnActions: turnActionIds(items),
			ensureTurn() {
				if (!turn) {
					turn = document.createElement('div');
					turn.className = 'turn';
					frag.appendChild(turn);
				}
				return turn;
			},
			startTurn() {
				turn = document.createElement('div');
				turn.className = 'turn';
				frag.appendChild(turn);
				return turn;
			}
		};
		items.forEach((item) => renderTimelineItem(item, ctx));

		timelineEl.appendChild(frag);
		timelineContentKey = timelineKey(items);
		requestAnimationFrame(() => {
			if (timelineStickBottom) {
				scrollTimelineToBottom();
			} else {
				writeTimelineScrollTop(prevTop);
			}
		});
	}

	function onTimelineUserScroll() {
		if (timelineScrollProgrammatic > 0) {
			return;
		}
		const intent = consumeTimelineIntent();
		if (intent === 'away') {
			releaseTimelineStick();
			return;
		}
		if (!timelineIsAtBottom()) {
			releaseTimelineStick();
			return;
		}
		if (performance.now() < timelineSuppressRepinUntil && intent !== 'toward') {
			return;
		}
		const wasFollowing = timelineStickBottom;
		timelineStickBottom = true;
		timelineSuppressRepinUntil = 0;
		if (!wasFollowing) {
			scrollTimelineToBottom();
		}
	}

	timelineEl.addEventListener('wheel', (event) => {
		if (nestedScrollerConsumes(event.target, event.deltaY)) {
			return;
		}
		if (event.deltaY < 0 && timelineEl.scrollTop > 0) {
			markTimelineIntent('away');
		} else if (event.deltaY > 0) {
			markTimelineIntent('toward');
		}
	}, { passive: true, capture: true });

	let timelineTouchY = null;
	timelineEl.addEventListener('touchstart', (event) => {
		timelineTouchY = event.touches[0] ? event.touches[0].clientY : null;
	}, { passive: true, capture: true });
	timelineEl.addEventListener('touchmove', (event) => {
		const y = event.touches[0] ? event.touches[0].clientY : null;
		if (y == null || timelineTouchY == null) {
			return;
		}
		const delta = y - timelineTouchY;
		timelineTouchY = y;
		if (nestedScrollerConsumes(event.target, -delta)) {
			return;
		}
		// Finger moving down reads earlier content.
		if (delta > 2 && timelineEl.scrollTop > 0) {
			markTimelineIntent('away');
		} else if (delta < -2) {
			markTimelineIntent('toward');
		}
	}, { passive: true, capture: true });
	timelineEl.addEventListener('touchend', () => {
		timelineTouchY = null;
	}, { passive: true, capture: true });
	timelineEl.addEventListener('touchcancel', () => {
		timelineTouchY = null;
	}, { passive: true, capture: true });

	document.addEventListener('keydown', (event) => {
		const target = event.target;
		if (!target || target.closest('button, a, input, textarea, select, [contenteditable="true"]')) {
			return;
		}
		const away = event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home'
			|| (event.key === ' ' && event.shiftKey);
		const toward = event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === 'End'
			|| (event.key === ' ' && !event.shiftKey);
		if (!away && !toward) {
			return;
		}
		if (nestedScrollerConsumes(target, away ? -1 : 1)) {
			return;
		}
		if (away && timelineEl.scrollTop > 0) {
			markTimelineIntent('away');
		} else if (toward) {
			markTimelineIntent('toward');
		}
	}, true);

	timelineEl.addEventListener('scroll', onTimelineUserScroll, { passive: true });

	timelineEl.addEventListener('load', (event) => {
		const target = event.target;
		if (target && target.tagName === 'IMG' && timelineStickBottom) {
			scrollTimelineToBottom();
		}
	}, true);

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
		if (titleEl) {
			titleEl.textContent = '任务';
		}

		// Reuse existing <li> nodes so in_progress spin animation is not reset
		// on every reasoning/status pushState.
		const seen = new Set();
		todos.forEach((todo, index) => {
			const id = String(todo.id || index);
			seen.add(id);
			const status = todo.status || 'pending';
			const text = todo.content || todo.id || '';
			let li = todoList.querySelector(`:scope > [data-todo-id="${CSS.escape(id)}"]`);
			if (!li) {
				li = document.createElement('li');
				li.dataset.todoId = id;
				li.innerHTML = '<span class="glyph"></span><span class="content"></span>';
			}
			const nextClass = 'todo-item ' + status;
			if (li.className !== nextClass) {
				li.className = nextClass;
				const glyph = li.querySelector('.glyph');
				if (glyph) {
					glyph.textContent = todoGlyph(status);
				}
			}
			const content = li.querySelector('.content');
			if (content && content.textContent !== text) {
				content.textContent = text;
			}
			const ref = todoList.children[index];
			if (ref !== li) {
				todoList.insertBefore(li, ref || null);
			}
		});
		[...todoList.children].forEach((li) => {
			const id = li.getAttribute('data-todo-id');
			if (!id || !seen.has(id)) {
				li.remove();
			}
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
		pickerMenu.classList.add('open', 'picker');
		const map = {
			provider: providerBtn,
			model: modelBtn,
			pace: paceBtn,
			thought: thoughtBtn,
			cursorMode: cursorModeBtn,
			cursorModel: cursorModelBtn,
		};
		if (map[kind]) map[kind].setAttribute('aria-expanded', 'true');
		// Anchor the picker above its trigger pill (viewport-fixed, since the
		// composer sits at the bottom of the page).
		const anchor = map[kind];
		if (anchor) {
			const r = anchor.getBoundingClientRect();
			pickerMenu.style.left =
				Math.max(8, Math.min(r.left, window.innerWidth - 160)) + 'px';
			pickerMenu.style.bottom = window.innerHeight - r.top + 6 + 'px';
		}
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

	/** Chat stream line height, pushed from the `zcode.chatLineHeight` setting. */
	function applyLineHeight(lineHeight) {
		if (typeof lineHeight !== 'number' || !Number.isFinite(lineHeight) || lineHeight <= 0) {
			return;
		}
		document.documentElement.style.setProperty('--zcode-chat-line-height', String(lineHeight));
		const tight = Math.max(1.3, Math.round((lineHeight - 0.25) * 100) / 100);
		document.documentElement.style.setProperty('--zcode-chat-line-height-tight', String(tight));
	}

	function render(next) {
		const wasBusy = busy;
		state = next;
		applyFontSize(next.fontSize);
		applyLineHeight(next.lineHeight);
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
		if (paceLabel) {
			paceLabel.textContent = next.agentPaceLabel || next.agentPace || '快速';
		}
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
			brain === 'zcode'
				? [next.agentPaceLabel || next.agentPace, next.reasoningLabel || next.reasoningLevel].filter(Boolean).join(' · ')
				: (next.cursorMode || 'agent'),
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
		renderClaim(next);
		renderQuota(next.accountQuota);
		renderQuotaNotice(next.quotaNotice);
		syncTurnActions();
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
	if (paceBtn) {
		paceBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (!state) return;
			openPicker('pace', state.agentPaces || [], state.agentPace, (id) =>
				vscode.postMessage({ type: 'setAgentPace', pace: id }),
			);
		});
	}
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
	if (claimBtn) {
		claimBtn.addEventListener('click', () => {
			if (claimBtn.disabled) return;
			vscode.postMessage({ type: 'claimPlan', planId: claimBtn.dataset.planId || '' });
		});
	}
	if (quotaNoticeClose) {
		quotaNoticeClose.addEventListener('click', () => {
			vscode.postMessage({ type: 'dismissQuotaNotice', id: quotaNoticeClose.dataset.noticeId || '' });
		});
	}
	timelineEl.addEventListener('click', (e) => {
		const btn = e.target && e.target.closest ? e.target.closest('[data-turn-action]') : null;
		if (!btn || btn.closest('.turn-actions')?.hidden) return;
		e.preventDefault();
		e.stopPropagation();
		vscode.postMessage({ type: btn.dataset.turnAction, id: btn.dataset.itemId });
	});
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
		const tokenItems =
			openMenu === 'skill' ? skillItems :
			openMenu === 'slash' ? slashItems :
			openMenu === 'mention' ? mentionItems : [];
		if (tokenItems.length && !tokenItems[0].placeholder) {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				if (openMenu === 'skill') {
					skillIndex = e.key === 'ArrowDown'
						? (skillIndex + 1) % skillItems.length
						: (skillIndex + skillItems.length - 1) % skillItems.length;
					renderSkillMenu(skillItems);
				} else if (openMenu === 'slash') {
					slashIndex = e.key === 'ArrowDown'
						? (slashIndex + 1) % slashItems.length
						: (slashIndex + slashItems.length - 1) % slashItems.length;
					renderSlashMenu(slashItems);
				} else {
					mentionIndex = e.key === 'ArrowDown'
						? (mentionIndex + 1) % mentionItems.length
						: (mentionIndex + mentionItems.length - 1) % mentionItems.length;
					renderMentionMenu(mentionItems);
				}
				return;
			}
			if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
				e.preventDefault();
				if (openMenu === 'skill') {
					insertSkill(skillItems[skillIndex].name);
				} else if (openMenu === 'slash') {
					insertSlash(slashItems[slashIndex].name);
				} else {
					insertMention(mentionItems[mentionIndex].path);
				}
				return;
			}
		}
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
		syncSkillQuery();
		syncSlashQuery();
		syncMentionQuery();
	});
	inputEl.addEventListener('click', () => {
		syncSkillQuery();
		syncSlashQuery();
		syncMentionQuery();
	});
	inputEl.addEventListener('keyup', (e) => {
		if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
			syncSkillQuery();
			syncSlashQuery();
			syncMentionQuery();
		}
	});
	// Paste / drop files & images as attachments (send bytes to host, which
	// writes images to temp files and wraps text content as excerpts).
	function extOf(name) {
		const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
		return m ? m[1].toLowerCase() : '';
	}
	const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif']);
	function isImageFile(file) {
		if ((file.type || '').startsWith('image/')) return true;
		return IMAGE_EXTS.has(extOf(file.name));
	}
	function readAsText(file) {
		return new Promise((resolve) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result || ''));
			reader.onerror = () => resolve('');
			reader.readAsText(file);
		});
	}
	function readAsDataUrl(file) {
		return new Promise((resolve) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result || ''));
			reader.onerror = () => resolve('');
			reader.readAsDataURL(file);
		});
	}
	async function attachTransferFiles(files) {
		if (!files || !files.length) return;
		for (const file of Array.from(files)) {
			const name = file.name || 'pasted-file';
			if (isImageFile(file)) {
				if (file.size > 8 * 1024 * 1024) continue; // skip huge images
				const dataUrl = await readAsDataUrl(file);
				const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : '';
				if (!base64) continue;
				vscode.postMessage({
					type: 'attachTransfer',
					name,
					mime: file.type || `image/${extOf(name) || 'png'}`,
					base64,
				});
			} else {
				if (file.size > 512 * 1024) continue; // only small text files inline
				const text = await readAsText(file);
				if (!text) continue;
				// Ignore plain-text paste handled by the textarea itself: only
				// clipboard items that expose a File come through here.
				vscode.postMessage({ type: 'attachTransfer', name, text });
			}
		}
	}
	document.addEventListener('paste', (e) => {
		const items = e.clipboardData && e.clipboardData.items;
		if (!items) return;
		const files = [];
		for (const item of items) {
			if (item.kind === 'file') {
				const f = item.getAsFile();
				if (f) files.push(f);
			}
		}
		if (!files.length) return; // plain text paste → default behavior
		e.preventDefault();
		void attachTransferFiles(files);
	});
	document.addEventListener('dragover', (e) => {
		if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
			e.preventDefault();
			e.dataTransfer.dropEffect = 'copy';
		}
	});
	document.addEventListener('drop', (e) => {
		if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
		e.preventDefault();
		void attachTransferFiles(e.dataTransfer.files);
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
		// Clicking anywhere outside an open menu (including elsewhere inside
		// the composer, e.g. the textarea) dismisses it.
		else if (
			openMenu &&
			!(e.target.closest && e.target.closest('.menu'))
		) {
			closeMenus();
		}
		if (historyOpen && historyDrawer && !historyDrawer.contains(e.target)) {
			setHistoryOpen(false);
		}
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && openMenu) closeMenus();
	});
	// Any press inside the chat page dismisses the blue "done" badge on the
	// active tab (capture phase so element-level stopPropagation can't skip it).
	document.addEventListener('pointerdown', () => {
		if (!state || !state.sessionId) return;
		const active = (state.sessions || []).find((s) => s.id === state.sessionId);
		// Post when the active session carries the badge, or when the session
		// list doesn't cover it — the host no-ops cheaply if there is nothing
		// to clear.
		if (!active || active.done) {
			vscode.postMessage({ type: 'clearTabDone', sessionId: state.sessionId });
		}
	}, true);
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && historyOpen) {
			setHistoryOpen(false);
		}
	});

	// ---- Task-completion chime. Only fired by the host when a real agent turn
	// finishes successfully; no other sounds exist in this view. The visible
	// reminder is the editor's system notification, not in-page UI. ----
	function playDoneChime() {
		try {
			const Ctx = window.AudioContext || window.webkitAudioContext;
			if (!Ctx) return;
			const ctx = new Ctx();
			if (ctx.state === 'suspended' && ctx.resume) void ctx.resume();
			const now = ctx.currentTime;
			const gain = ctx.createGain();
			gain.connect(ctx.destination);
			gain.gain.setValueAtTime(0.0001, now);
			gain.gain.exponentialRampToValueAtTime(0.09, now + 0.02);
			gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
			[784, 1046.5].forEach((freq, i) => {
				const osc = ctx.createOscillator();
				osc.type = 'sine';
				osc.frequency.value = freq;
				osc.connect(gain);
				osc.start(now + i * 0.14);
				osc.stop(now + 0.55);
			});
			setTimeout(() => { ctx.close().catch(() => {}); }, 900);
		} catch { /* audio unavailable — the system notification still fires */ }
	}

	window.addEventListener('message', (event) => {
		const data = event.data;
		if (!data) return;
		if (data.type === 'state') render(data);
		if (data.type === 'contextUsage') renderContextUsage(data.contextUsage);
		if (data.type === 'turnCompleted') playDoneChime();
		if (data.type === 'skillMatches') {
			const query = currentSkillQuery();
			if (!query || query.query !== (data.query || '')) return;
			renderSkillMenu((data.skills || []).length ? data.skills : [{ placeholder: true, name: '无匹配技能', description: '', scope: '' }]);
		}
		if (data.type === 'slashMatches') {
			const query = currentSlashQuery();
			if (!query || query.query !== (data.query || '')) return;
			renderSlashMenu(data.commands || []);
		}
		if (data.type === 'mentionMatches') {
			const query = currentMentionQuery();
			if (!query || query.query !== (data.query || '')) return;
			renderMentionMenu(data.files || []);
		}
	});
	vscode.postMessage({ type: 'ready' });
})();
