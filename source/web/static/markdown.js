// Sanitization and shaping for the Markdown the web UI renders.
//
// The model is a trusted component; its prose fields (task, result summary, question text, question context, error message) are Markdown the UI renders as formatted text rather than literal punctuation. `showdown` turns the Markdown into an HTML string and `highlight.js` highlights fenced code; that HTML is parsed into a neutral tree and walked through the allowlist enforced here.
//
// The model is not an adversary, so this is not a defense against a malicious model. The residual concern is prompt injection: a malicious file in the workspace could coerce the model into emitting markup that would be dangerous if rendered raw. The primary defense is upstream (preventing injection from the workspace — see docs/security.md "Threat model"); this module is a light defense-in-depth backstop that, should an injection attempt succeed in coercing the model's output, ensures only inert tags and attributes reach the DOM.
//
// This module is the single source of truth for what the UI may render. It is plain browser JS (a sibling of `app.js`, served statically and imported by it) and is exercised in-memory by `source/web/markdown.test.ts`. It imports nothing and touches no external system: every function below is a pure transform over the neutral `HtmlNode` tree. The DOM parsing (`DOMParser` → `HtmlNode`) and the hyperapp vnode construction (`HtmlNode` → vnodes) live in `app.js`; the allowlist decisions live here.
//
// The output is a tree of `HtmlNode`s that the caller converts into hyperapp vnodes (text becomes text-node children, elements become `h(tag, props, children)`). Because content is placed into text nodes and DOM properties by hyperapp — never into markup — the rendered tree cannot break out of the DOM. The sanitizer's job is to ensure only inert tags and attributes become vnodes in the first place.

// Tags the UI may render. Everything Markdown produces for prose (headings, lists, code, emphasis, links, tables) is covered; `span` is allowed because `highlight.js` wraps syntax tokens in `<span class="hljs-…">`.
export const ALLOWED_TAGS = new Set([
	'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
	'ul', 'ol', 'li', 'pre', 'code', 'blockquote', 'em', 'strong', 'del', 's',
	'a', 'span', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
])

// Attributes each allowed tag may carry. `class` is permitted only on `code`, `pre`, and `span` so `highlight.js` token classes and `showdown`'s `language-…` code classes survive; class values are CSS-only and not executable. `a` may carry `href` and `title` only. Every other attribute on every other tag is stripped, which removes every `on*` event handler, `style`, and `srcset` by default.
export const ALLOWED_ATTRIBUTES = {
	a: new Set(['href', 'title']),
	code: new Set(['class']),
	pre: new Set(['class']),
	span: new Set(['class']),
}

// URL schemes a rendered link may target. `http`, `https`, and `mailto` are the only absolute schemes permitted; `javascript:`, `data:`, `vbscript:`, and anything else that could execute or smuggle markup are rejected. Relative URLs, anchors, and protocol-relative URLs (no scheme) pass through.
export const ALLOWED_URL_SCHEMES = new Set(['http', 'https', 'mailto'])

// Disallowed tags whose entire subtree is dropped rather than unwrapped. These are elements whose content is not human-readable prose (script bodies, style sheets, form controls, media, embedded documents) or that carry execution/loading semantics; keeping their text would surface code as visible text and keeping the node at all risks a loader. A disallowed tag NOT in this set is unwrapped: its tag is removed but its sanitized children are kept, so agent-authored `<div>text</div>` still yields the inner `text`.
export const DROP_SUBTREE_TAGS = new Set([
	'script', 'style', 'textarea', 'title', 'noscript', 'template',
	'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
	'link', 'meta', 'base', 'form', 'input', 'button', 'select', 'option',
	'optgroup', 'label', 'fieldset', 'legend', 'output', 'progress', 'meter',
	'canvas', 'svg', 'math', 'audio', 'video', 'source', 'track', 'map',
	'area', 'dialog', 'slot', 'portal', 'picture', 'param',
])

function isAllowedTag(tag) {
	return ALLOWED_TAGS.has(tag)
}

function isAllowedAttribute(tag, name) {
	const allowed = ALLOWED_ATTRIBUTES[tag]
	if (allowed === undefined) return false
	if (name.slice(0, 2) === 'on') return false
	return allowed.has(name)
}

// A URL is safe when it has no scheme (relative, anchor, or protocol-relative) or its scheme is on the allowlist. Leading and embedded control characters (tab, newline, NUL — the bytes browsers strip before resolving a scheme) are removed before the scheme is read, so `java\tscript:` cannot smuggle past the check. The original value is what gets rendered when the URL is deemed safe; the control-stripped copy is used only to make the decision.
export function isSafeUrl(value) {
	if (typeof value !== 'string') return false
	const stripped = value.replace(/[\x00-\x20]+/g, '')
	const match = stripped.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/)
	if (match === null) return true
	return ALLOWED_URL_SCHEMES.has(match[1].toLowerCase())
}

// A neutral, parser-agnostic node tree. `DOMParser` produces this in the browser; tests build it by hand. Keeping the tree decoupled from both the DOM and hyperapp vnodes is what makes the sanitizer pure and the security decisions exercisable without a browser.
//
//   { type: 'text', value: string }
//   { type: 'element', tag: string, attributes: Record<string, string>, children: HtmlNode[] }

// Sanitizes a single node into the output list. A text node is always kept (text is inert). An allowed element is rebuilt with only its permitted attributes and recursively sanitized children. A disallowed element is either dropped wholesale (DROP_SUBTREE_TAGS) or unwrapped (its children sanitized in place), so no disallowed tag and no disallowed attribute ever reaches the output.
function sanitizeNodeInto(out, node) {
	if (node.type === 'text') {
		if (typeof node.value === 'string') out.push({ type: 'text', value: node.value })
		return
	}
	if (node.type !== 'element') return
	const tag = typeof node.tag === 'string' ? node.tag.toLowerCase() : ''
	if (DROP_SUBTREE_TAGS.has(tag)) return
	if (!isAllowedTag(tag)) {
		sanitizeNodesInto(out, Array.isArray(node.children) ? node.children : [])
		return
	}
	const attributes = {}
	const sourceAttributes = node.attributes
	if (sourceAttributes !== null && typeof sourceAttributes === 'object') {
		for (const name of Object.keys(sourceAttributes)) {
			const lowerName = name.toLowerCase()
			if (!isAllowedAttribute(tag, lowerName)) continue
			const value = sourceAttributes[name]
			if (lowerName === 'href' && !isSafeUrl(value)) continue
			attributes[lowerName] = value
		}
	}
	const children = []
	sanitizeNodesInto(children, Array.isArray(node.children) ? node.children : [])
	out.push({ type: 'element', tag, attributes, children })
}

export function sanitizeNodesInto(out, nodes) {
	for (const node of nodes) sanitizeNodeInto(out, node)
	return out
}

// Sanitizes a list of nodes into a fresh list. The list-returning form handles unwrapping (one disallowed element may contribute zero, one, or many sanitized children) without the caller flattening.
export function sanitizeNodes(nodes) {
	return sanitizeNodesInto([], Array.isArray(nodes) ? nodes : [])
}

// Converts a sanitized node tree into hyperapp vnode children using the supplied `h`. A text node becomes a bare string (hyperapp wraps strings in text nodes — never markup); an element becomes `h(tag, attributes, children)`. `h` is passed in rather than imported so the module stays free of hyperapp coupling and the conversion is exercisable in tests with a fake `h`. The input is assumed already sanitized; passing an unsanitized tree here would still drop nothing, so callers always run `sanitizeNodes` first.
export function htmlNodesToVnodes(nodes, h) {
	const out = []
	for (const node of nodes) {
		if (node.type === 'text') {
			out.push(node.value)
		} else if (node.type === 'element') {
			out.push(h(node.tag, node.attributes, htmlNodesToVnodes(node.children, h)))
		}
	}
	return out
}
