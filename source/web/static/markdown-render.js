// Markdown → sanitized hyperapp vnode pipeline, shared by the product client (`app.js`) and the demo harness.
//
// Agent-authored prose (task, result summary, ask_human question text/context, error message) is Markdown the UI renders as formatted text rather than literal punctuation. `showdown` (window.showdown) turns it into HTML, `highlight.js` (window.hljs) highlights fenced code, that HTML is parsed into a neutral tree by `DOMParser`, walked through the allowlist in `markdown.js`, and turned back into hyperapp vnodes. The result is memoized by text so a per-second poll does not re-run showdown/highlight.js on unchanged content, and the cached vnodes are reference-stable so the renderer's diff no-ops on a steady view.
//
// This module is the browser-facing half of the pipeline: it touches the window globals (showdown, hljs) and the DOM (DOMParser), so it lives here rather than in `markdown.js` (which is a pure transform over the neutral tree and imports nothing). `h` is passed into the factory rather than imported so the pipeline is exercisable in tests with a fake `h` and so both the product client and the harness share one implementation. See docs/security.md "Web client rendering pipeline" for the threat model: the model is a trusted component and this is a defense-in-depth backstop against prompt injection, never the primary defense.

import { sanitizeNodes, htmlNodesToVnodes } from './markdown.js'

const MARKDOWN_CACHE_MAX = 256

// highlight.js returns already-HTML-escaped token spans (the code text is escaped inside the spans), so its output is embedded into the code block verbatim rather than escaped again. Any failure falls back to a manually escaped plain-text code block so rendering never breaks on a malformed input.
function escapeHtmlForCode(value) {
	return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function highlightCode(code, language) {
	const hljs = window.hljs
	if (typeof hljs !== 'object' || hljs === null || typeof hljs.highlight !== 'function') return escapeHtmlForCode(code)
	try {
		if (language && typeof hljs.getLanguage === 'function' && hljs.getLanguage(language)) {
			return hljs.highlight(code, { language }).value
		}
		return hljs.highlightAuto(code).value
	} catch {
		return escapeHtmlForCode(code)
	}
}

// showdown emits fenced code as <pre><code class="ts language-ts">…escaped…</code></pre>; the code body is HTML-escaped, so it is unescaped before being fed to highlight.js (which re-escapes inside its token spans). The class is rewritten to `hljs language-X` so the vendored github theme and the sanitizer's allowlist key on it (class is permitted on pre/code/span).
function highlightCodeBlocks(html) {
	return html.replace(/<pre><code class="([^"]*)">([\s\S]*?)<\/code><\/pre>/g, (match, cls, escaped) => {
		const langMatch = cls.match(/(?:^|\s)([a-zA-Z0-9+#-]+)/)
		const language = langMatch ? langMatch[1] : ''
		const code = escaped
			.replace(/&amp;/g, '&')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.replace(/\n$/, '')
		const highlighted = highlightCode(code, language)
		const className = language !== '' ? `hljs language-${language}` : 'hljs'
		return `<pre><code class="${className}">${highlighted}</code></pre>`
	})
}

// DOMParser parses the showdown HTML without executing scripts (text/html parsing never runs script), producing a neutral tree the sanitizer walks. The DOM and the hyperapp vnode layer are kept out of markdown.js so its allowlist decisions stay pure and testable.
function parseHtmlToNodes(html) {
	const doc = new DOMParser().parseFromString(html, 'text/html')
	return childNodesToNodes(doc.body.childNodes)
}

function childNodesToNodes(childNodes) {
	const out = []
	for (const node of childNodes) {
		if (node.nodeType === 3) {
			out.push({ type: 'text', value: node.nodeValue })
		} else if (node.nodeType === 1) {
			const tag = node.tagName.toLowerCase()
			const attributes = {}
			for (const attr of node.attributes) attributes[attr.name.toLowerCase()] = attr.value
			out.push({ type: 'element', tag, attributes, children: childNodesToNodes(node.childNodes) })
		}
	}
	return out
}

// Builds a `renderMarkdown(text)` closure bound to the supplied `h`. A single showdown Converter is constructed lazily on first use and reused for every render; GFM tables and strikethrough are enabled and noHeaderId suppresses showdown's auto-generated heading ids (anchor links the UI does not need and that would only add attributes for the sanitizer to strip). Empty/absent input yields the em-dash placeholder the non-Markdown fields also use; if the vendored libraries are unavailable or showdown throws, the raw text is returned as a single text node so the field stays readable instead of blank.
export function createMarkdownRenderer(h) {
	const cache = new Map()
	let converter = null

	function ensureConverter() {
		if (converter !== null) return converter
		const Showdown = window.showdown
		if (typeof Showdown !== 'function' && typeof Showdown !== 'object') return null
		const Converter = typeof Showdown === 'function' ? Showdown.Converter : Showdown.Converter
		if (typeof Converter !== 'function') return null
		converter = new Converter({ tables: true, strikethrough: true, noHeaderId: true })
		return converter
	}

	function textToVnodes(text) {
		const activeConverter = ensureConverter()
		if (activeConverter === null || typeof activeConverter.makeHtml !== 'function') return [text]
		let html
		try {
			html = activeConverter.makeHtml(text)
		} catch {
			return [text]
		}
		if (typeof html !== 'string') return [text]
		html = highlightCodeBlocks(html)
		const sanitized = sanitizeNodes(parseHtmlToNodes(html))
		const vnodes = htmlNodesToVnodes(sanitized, h)
		return vnodes.length > 0 ? vnodes : [text]
	}

	return function renderMarkdown(text) {
		if (typeof text !== 'string' || text === '') return ['—']
		const cached = cache.get(text)
		if (cached !== undefined) {
			// Re-insert on hit so the Map's insertion order tracks recency and eviction removes the least-recently-used entry, not the least-recently-inserted one.
			cache.delete(text)
			cache.set(text, cached)
			return cached
		}
		const vnodes = textToVnodes(text)
		cache.set(text, vnodes)
		while (cache.size > MARKDOWN_CACHE_MAX) {
			const eldest = cache.keys().next()
			if (eldest.done) break
			cache.delete(eldest.value)
		}
		return vnodes
	}
}
