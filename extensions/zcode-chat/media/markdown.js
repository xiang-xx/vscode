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

	function renderMarkdown(text) {
		const src = String(text || '');
		if (!src.trim()) {
			return '';
		}
		if (!renderer) {
			renderer = createRenderer();
		}
		if (!renderer) {
			return `<p>${escapeHtml(src).replace(/\n/g, '<br/>')}</p>`;
		}
		let html = renderer.render(src);
		html = enhanceTaskLists(html);
		html = enhanceCodeBlocks(html);
		return html;
	}

	global.ZCodeMarkdown = {
		render: renderMarkdown,
		escapeHtml,
	};
})(typeof window !== 'undefined' ? window : globalThis);
