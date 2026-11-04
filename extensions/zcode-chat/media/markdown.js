/* global markdownit, hljs */
(function (global) {
	'use strict';

	function escapeHtml(text) {
		return String(text || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	function unescapeHtml(text) {
		return String(text || '')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.replace(/&amp;/g, '&');
	}

	function enhanceTaskLists(html) {
		return html.replace(
			/<li>(\s*)\[(x|X| )\](\s+)/g,
			(_, sp, mark, after) => {
				const checked = mark === 'x' || mark === 'X';
				return `<li class="task-list-item">${sp}<input type="checkbox" disabled${checked ? ' checked' : ''} class="task-list-item-checkbox">${after}`;
			},
		);
	}

	function highlightCode(lang, rawCode) {
		const code = String(rawCode || '').replace(/\n$/, '');
		if (typeof hljs === 'undefined' || !hljs || typeof hljs.highlight !== 'function') {
			return { html: escapeHtml(code), language: lang || '' };
		}
		try {
			if (lang && hljs.getLanguage(lang)) {
				return {
					html: hljs.highlight(code, { language: lang, ignoreIllegals: true }).value,
					language: lang,
				};
			}
			const auto = hljs.highlightAuto(code);
			return {
				html: auto.value,
				language: lang || auto.language || '',
			};
		} catch {
			return { html: escapeHtml(code), language: lang || '' };
		}
	}

	function enhanceCodeBlocks(html) {
		return html.replace(
			/<pre><code(?:\s+class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g,
			(_, langAttr, encoded) => {
				const raw = unescapeHtml(encoded);
				const highlighted = highlightCode(langAttr || '', raw);
				const label = highlighted.language || langAttr || '';
				const langLabel = label
					? `<span class="codeblock-lang">${escapeHtml(label)}</span>`
					: '<span class="codeblock-lang"></span>';
				const cls = highlighted.language
					? ` class="hljs language-${escapeHtml(highlighted.language)}"`
					: ' class="hljs"';
				return (
					`<div class="codeblock">` +
					`<div class="codeblock-header">` +
					langLabel +
					`<button type="button" class="codeblock-copy" title="复制" aria-label="复制代码">复制</button>` +
					`</div>` +
					`<pre><code${cls}>${highlighted.html}</code></pre>` +
					`</div>`
				);
			},
		);
	}

	function createRenderer() {
		if (typeof markdownit !== 'function') {
			return null;
		}
		const md = markdownit({
			html: false,
			linkify: true,
			breaks: false,
			typographer: false,
		});
		md.validateLink = (url) => {
			const u = String(url || '').trim().toLowerCase();
			return !u.startsWith('javascript:') && !u.startsWith('data:text/html');
		};
		const defaultLinkOpen =
			md.renderer.rules.link_open ||
			function (tokens, idx, options, _env, self) {
				return self.renderToken(tokens, idx, options);
			};
		md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
			const token = tokens[idx];
			const targetIdx = token.attrIndex('target');
			if (targetIdx < 0) {
				token.attrPush(['target', '_blank']);
			} else {
				token.attrs[targetIdx][1] = '_blank';
			}
			const relIdx = token.attrIndex('rel');
			if (relIdx < 0) {
				token.attrPush(['rel', 'noopener noreferrer']);
			} else {
				token.attrs[relIdx][1] = 'noopener noreferrer';
			}
			return defaultLinkOpen(tokens, idx, options, env, self);
		};
		return md;
	}

	let renderer;

	/**
	 * File-reference linkifier: turns tokens like `src/vs/foo.ts`, `a/b.ts:120`,
	 * `a/b.ts 行 1605–1671` into clickable anchors. Runs on TEXT NODES only —
	 * <pre> blocks and existing <a> links are stashed away first so we never
	 * touch code samples or URLs. Bare filenames (no directory part) require a
	 * line hint (行 N / :N / line N) to avoid false positives like "e.g".
	 */
	const FILE_LINK_RE = /(?<![A-Za-z0-9_.:~/!$^+=#-])((?:[\w\-.@!$^+=#~]*\/)+[\w\-.@!$^+=#~]*\.[A-Za-z][A-Za-z0-9]{1,7}|[\w\-.@!$^+=#~]*\.[A-Za-z][A-Za-z0-9]{1,7})([:：][0-9]{1,7}(?::[0-9]{1,5})?(?:\s*[–—-]\s*[0-9]{1,7})?|\s*(?:行|line|Line|L)[\s#]*[0-9]{1,7}(?:\s*[–—-]\s*[0-9]{1,7})?)?/g;

	function parseFileLinkSuffix(sfx) {
		if (!sfx) {
			return null;
		}
		const nums = sfx.match(/[0-9]+/g) || [];
		if (nums.length === 0) {
			return null;
		}
		const loc = { line: parseInt(nums[0], 10), endLine: 0, col: 0 };
		if (/^[:：]/.test(sfx) && nums.length >= 2 && !/[–—-]/.test(sfx)) {
			const colonParts = sfx.split(':').length >= 3 || sfx.split('：').length >= 3;
			if (colonParts) {
				loc.col = parseInt(nums[1], 10); // path:line:col
			} else {
				loc.endLine = parseInt(nums[1], 10); // path:start-end
			}
		} else if (nums.length >= 2) {
			loc.endLine = parseInt(nums[1], 10); // 行 1605–1671 / line 12-30
		}
		return loc;
	}

	function linkifyFileRefs(text) {
		if (!text || (text.indexOf('/') === -1 && !/行|[Ll]ine/.test(text))) {
			return text;
		}
		return text.replace(FILE_LINK_RE, (match, pathToken, suffix) => {
			const hasDir = pathToken.indexOf('/') !== -1;
			const loc = parseFileLinkSuffix(suffix);
			if (!hasDir && !loc) {
				return match;
			}
			let attrs = ` class="zcode-file-link" style="cursor:pointer" data-path="${pathToken}"`;
			if (loc) {
				attrs += ` data-line="${loc.line}"`;
				if (loc.endLine) {
					attrs += ` data-end-line="${loc.endLine}"`;
				}
				if (loc.col) {
					attrs += ` data-col="${loc.col}"`;
				}
			}
			return `<a href="#"${attrs} title="点击打开文件">${pathToken}${suffix || ''}</a>`;
		});
	}

	function enhanceFileLinks(html) {
		const vault = [];
		const stash = (m) => {
			vault.push(m);
			return `\u0001ZFL${vault.length - 1}\u0001`;
		};
		let src = html.replace(/<pre[\s\S]*?<\/pre>/g, stash);
		src = src.replace(/<a\s[^>]*>[\s\S]*?<\/a>/g, stash);
		src = src.replace(/>([^<]+)</g, (m, text) => '>' + linkifyFileRefs(text) + '<');
		return src.replace(/\u0001ZFL(\d+)\u0001/g, (_, i) => vault[Number(i)]);
	}

	function renderMarkdown(text) {
		const src = String(text || '');
		if (!src.trim()) {
			return '';
		}
		if (!renderer) {
			renderer = createRenderer();
		}
		if (!renderer) {
			return enhanceFileLinks(`<p>${escapeHtml(src).replace(/\n/g, '<br/>')}</p>`);
		}
		let html = renderer.render(src);
		html = enhanceTaskLists(html);
		html = enhanceCodeBlocks(html);
		html = enhanceFileLinks(html);
		return html;
	}

	global.ZCodeMarkdown = {
		render: renderMarkdown,
		escapeHtml,
	};
})(typeof window !== 'undefined' ? window : globalThis);
