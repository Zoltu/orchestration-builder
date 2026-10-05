// Markdown → sanitized hyperapp vnode pipeline, shared by the product client (`app.js`) and the demo harness.
//
// Agent-authored prose (task, result summary, ask_human question text/context, error message) is Markdown the UI renders as formatted text rather than literal punctuation. `showdown` (window.showdown) turns it into HTML, `highlight.js` (window.hljs) highlights fenced code, that HTML is parsed into a neutral tree by `DOMParser`, and walked through the allowlist in `markdown.ts`. The sanitized neutral tree is memoized by text so a per-second poll does not re-run showdown/highlight.js on unchanged content; the hyperapp vnodes are then rebuilt from it on every call — they must never be cached, because hyperapp's differ assigns each vnode's `node` property in place, so a vnode object shared across tree positions (the same text can render in several turns) would have its `node` claimed by one position and left stale at the others; the next position shift (an inspector "Older turns" page prepend, a window resync, a turn completing) then makes the differ patch through the stale reference, which throws DOMException mid-patch and leaves the mounted tree corrupted.
//
// This module is the browser-facing half of the pipeline: it touches the window globals (showdown, hljs) and the DOM (DOMParser), so it lives here rather than in `markdown.ts` (which is a pure transform over the neutral tree and imports nothing but the record guard). `h` is passed into the factory rather than imported so the pipeline is exercisable in tests with a fake `h` and so both the product client and the harness share one implementation. See docs/security.md "Web client rendering pipeline" for the threat model: the model is a trusted component and this is a defense-in-depth backstop against prompt injection, never the primary defense.

import { sanitizeNodes, htmlNodesToVnodes } from './markdown.js'
import type { HtmlNode, Hyperscript } from './markdown.js'

const MARKDOWN_CACHE_MAX = 256

// highlight.js returns already-HTML-escaped token spans (the code text is escaped inside the spans), so its output is embedded into the code block verbatim rather than escaped again. Any failure falls back to a manually escaped plain-text code block so rendering never breaks on a malformed input.
function escapeHtmlForCode(value: string): string {
	return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function highlightCode(code: string, language: string): string {
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
function highlightCodeBlocks(html: string): string {
	return html.replace(/<pre><code class="([^"]*)">([\s\S]*?)<\/code><\/pre>/g, (_match: string, cls: string, escaped: string) => {
		const langMatch = cls.match(/(?:^|\s)([a-zA-Z0-9+#-]+)/)
		const language = langMatch?.[1] ?? ''
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

// DOMParser parses the showdown HTML without executing scripts (text/html parsing never runs script), producing a neutral tree the sanitizer walks. The DOM and the hyperapp vnode layer are kept out of markdown.ts so its allowlist decisions stay pure and testable.
function parseHtmlToNodes(html: string): HtmlNode[] {
	const doc = new DOMParser().parseFromString(html, 'text/html')
	return childNodesToNodes(doc.body.childNodes)
}

// The DOM types do not discriminate parsed nodes by nodeType, so the element branch narrows through this guard — nodeType 1 is the platform's own element discriminator.
function isElementNode(node: ChildNode): node is ChildNode & Element {
	return node.nodeType === 1
}

function childNodesToNodes(childNodes: NodeListOf<ChildNode>): HtmlNode[] {
	const out: HtmlNode[] = []
	for (const node of childNodes) {
		if (node.nodeType === 3) {
			// A text node's value is typed nullable but is always a string on a text node; a null value is dropped here exactly as the sanitizer's own string check would drop it.
			const value = node.nodeValue
			if (value !== null) out.push({ type: 'text', value })
		} else if (isElementNode(node)) {
			const tag = node.tagName.toLowerCase()
			const attributes: Record<string, string> = {}
			for (const attr of node.attributes) attributes[attr.name.toLowerCase()] = attr.value
			out.push({ type: 'element', tag, attributes, children: childNodesToNodes(node.childNodes) })
		}
	}
	return out
}

// Builds a `renderMarkdown(text)` closure bound to the supplied `h`. A single showdown Converter is constructed lazily on first use and reused for every render; GFM tables and strikethrough are enabled and noHeaderId suppresses showdown's auto-generated heading ids (anchor links the UI does not need and that would only add attributes for the sanitizer to strip). Empty/absent input yields the em-dash placeholder the non-Markdown fields also use; if the vendored libraries are unavailable or showdown throws, the raw text is returned as a single text node so the field stays readable instead of blank. The memo holds the sanitized neutral tree (the expensive showdown/highlight/parse/sanitize result), never vnodes — see the module header for why shared vnode objects corrupt hyperapp's differ.
export function createMarkdownRenderer(h: Hyperscript): (text: string) => unknown[] {
	const cache = new Map<string, HtmlNode[]>()
	let converter: { makeHtml(text: string): unknown } | null = null

	function ensureConverter() {
		if (converter !== null) return converter
		const Showdown = window.showdown
		if (typeof Showdown !== 'function' && typeof Showdown !== 'object') return null
		const Converter = Showdown.Converter
		if (typeof Converter !== 'function') return null
		converter = new Converter({ tables: true, strikethrough: true, noHeaderId: true })
		return converter
	}

	function textToVnodes(text: string): unknown[] {
		const activeConverter = ensureConverter()
		if (activeConverter === null || typeof activeConverter.makeHtml !== 'function') return [text]
		let html: unknown
		try {
			html = activeConverter.makeHtml(text)
		} catch {
			return [text]
		}
		if (typeof html !== 'string') return [text]
		const highlightedHtml = highlightCodeBlocks(html)
		const cachedTree = cache.get(text)
		if (cachedTree !== undefined) {
			// Re-insert on hit so the Map's insertion order tracks recency and eviction removes the least-recently-used entry, not the least-recently-inserted one.
			cache.delete(text)
			cache.set(text, cachedTree)
			return htmlNodesToVnodes(cachedTree, h)
		}
		const sanitized = sanitizeNodes(parseHtmlToNodes(highlightedHtml))
		cache.set(text, sanitized)
		while (cache.size > MARKDOWN_CACHE_MAX) {
			const eldest = cache.keys().next()
			if (eldest.done) break
			cache.delete(eldest.value)
		}
		const vnodes = htmlNodesToVnodes(sanitized, h)
		return vnodes.length > 0 ? vnodes : [text]
	}

	return function renderMarkdown(text) {
		if (typeof text !== 'string' || text === '') return ['—']
		return textToVnodes(text)
	}
}
