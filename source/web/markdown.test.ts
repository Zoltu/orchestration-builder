import { describe, expect, test } from 'bun:test'
import {
	ALLOWED_ATTRIBUTES,
	ALLOWED_TAGS,
	ALLOWED_URL_SCHEMES,
	DROP_SUBTREE_TAGS,
	htmlNodesToVnodes,
	isSafeUrl,
	sanitizeNodes,
} from './static/markdown.js'

// A plain-text node and a tag/attributes/children element are the two shapes the sanitizer operates on; tests build them by hand so the suite needs no DOM.
interface HtmlNode {
	type: 'text' | 'element'
	value?: string
	tag?: string
	attributes?: Record<string, string>
	children?: HtmlNode[]
}
function text(value: string): HtmlNode {
	return { type: 'text', value }
}
function element(tag: string, attributes: Record<string, string> = {}, children: HtmlNode[] = []): HtmlNode {
	return { type: 'element', tag, attributes, children }
}

// A fake hyperscript that records the call as a serializable object so the vnode conversion is assertable without hyperapp. It mirrors how hyperapp's `h` is used: `h(tag, props, children)`.
function fakeH(tag: string, props: Record<string, string>, children: unknown[]) {
	return { tag, props, children }
}

describe('isSafeUrl', () => {
	test('allows http, https, and mailto absolute URLs', () => {
		expect(isSafeUrl('http://example.com')).toBe(true)
		expect(isSafeUrl('https://example.com/path?q=1')).toBe(true)
		expect(isSafeUrl('mailto:user@example.com')).toBe(true)
	})

	test('allows relative, anchor, and protocol-relative URLs', () => {
		expect(isSafeUrl('/path/to/file')).toBe(true)
		expect(isSafeUrl('./relative')).toBe(true)
		expect(isSafeUrl('#anchor')).toBe(true)
		expect(isSafeUrl('//cdn.example.com/lib.js')).toBe(true)
	})

	test('rejects javascript:, data:, and vbscript: schemes', () => {
		expect(isSafeUrl('javascript:alert(1)')).toBe(false)
		expect(isSafeUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
		expect(isSafeUrl('vbscript:msgbox(1)')).toBe(false)
	})

	test('is case-insensitive for the scheme', () => {
		expect(isSafeUrl('JaVaScRiPt:alert(1)')).toBe(false)
		expect(isSafeUrl('HTTPS://example.com')).toBe(true)
	})

	test('rejects a scheme smuggled past leading or embedded control characters', () => {
		// Browsers strip tab/newline/NUL before resolving the scheme, so the sanitizer must read the scheme after stripping them too.
		expect(isSafeUrl('  javascript:alert(1)')).toBe(false)
		expect(isSafeUrl('java\tscript:alert(1)')).toBe(false)
		expect(isSafeUrl('java\nscript:alert(1)')).toBe(false)
		expect(isSafeUrl('\x00javascript:alert(1)')).toBe(false)
	})

	test('rejects non-string input', () => {
		expect(isSafeUrl(undefined)).toBe(false)
		expect(isSafeUrl(123)).toBe(false)
		expect(isSafeUrl(null)).toBe(false)
	})
})

describe('allowlist shape', () => {
	test('covers the prose tags Markdown produces plus highlight.js spans', () => {
		for (const tag of ['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'pre', 'code', 'blockquote', 'em', 'strong', 'del', 'a', 'span', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'br', 'hr']) {
			expect(ALLOWED_TAGS.has(tag)).toBe(true)
		}
	})

	test('does not allow executable or loading tags', () => {
		for (const tag of ['script', 'style', 'iframe', 'object', 'embed', 'img', 'form', 'input', 'button', 'link', 'meta', 'svg', 'math']) {
			expect(ALLOWED_TAGS.has(tag)).toBe(false)
		}
	})

	test('permits class only on code, pre, and span; href+title only on a', () => {
		expect(ALLOWED_ATTRIBUTES.a.has('href')).toBe(true)
		expect(ALLOWED_ATTRIBUTES.a.has('title')).toBe(true)
		expect(ALLOWED_ATTRIBUTES.code.has('class')).toBe(true)
		expect(ALLOWED_ATTRIBUTES.pre.has('class')).toBe(true)
		expect(ALLOWED_ATTRIBUTES.span.has('class')).toBe(true)
	})

	test('does not permit any on* handler, style, or src on any tag', () => {
		for (const attrs of Object.values(ALLOWED_ATTRIBUTES)) {
			for (const name of ['onclick', 'onerror', 'onload', 'onmouseover', 'style', 'src', 'srcset', 'href']) {
				if (attrs === ALLOWED_ATTRIBUTES.a && (name === 'href' || name === 'title')) continue
				expect(attrs.has(name)).toBe(false)
			}
		}
	})

	test('URL allowlist is exactly http, https, mailto', () => {
		expect([...ALLOWED_URL_SCHEMES].sort()).toEqual(['http', 'https', 'mailto'])
	})

	test('script and style are dropped wholesale, not unwrapped', () => {
		expect(DROP_SUBTREE_TAGS.has('script')).toBe(true)
		expect(DROP_SUBTREE_TAGS.has('style')).toBe(true)
	})
})

describe('sanitizeNodes', () => {
	test('keeps a plain paragraph with inline emphasis', () => {
		const nodes = [element('p', {}, [text('hello '), element('em', {}, [text('world')])])]
		expect(sanitizeNodes(nodes)).toEqual(nodes)
	})

	test('keeps highlight.js token spans with their class', () => {
		const nodes = [element('span', { class: 'hljs-keyword' }, [text('const')])]
		expect(sanitizeNodes(nodes)).toEqual(nodes)
	})

	test('keeps a fenced code block with language and hljs classes', () => {
		const nodes = [element('pre', {}, [element('code', { class: 'hljs language-ts' }, [text('const x = 1')])])]
		expect(sanitizeNodes(nodes)).toEqual(nodes)
	})

	test('drops a <script> element and its text content entirely', () => {
		const nodes = [element('p', {}, [text('before')]), element('script', {}, [text('alert(1)')]), element('p', {}, [text('after')])]
		expect(sanitizeNodes(nodes)).toEqual([element('p', {}, [text('before')]), element('p', {}, [text('after')])])
	})

	test('drops <style>, <iframe>, <object>, and <svg> wholesale', () => {
		const nodes = [
			element('style', {}, [text('body{color:red}')]),
			element('iframe', { src: 'https://evil.com' }, []),
			element('object', { data: 'https://evil.com' }, []),
			element('svg', { onload: 'alert(1)' }, [text('x')]),
		]
		expect(sanitizeNodes(nodes)).toEqual([])
	})

	test('unwraps an unknown formatting tag but keeps its sanitized text', () => {
		const nodes = [element('div', {}, [text('kept')])]
		expect(sanitizeNodes(nodes)).toEqual([text('kept')])
	})

	test('unwraps nested unknown tags down to allowed content', () => {
		const nodes = [element('div', {}, [element('section', {}, [element('p', {}, [text('inner')])])])]
		expect(sanitizeNodes(nodes)).toEqual([element('p', {}, [text('inner')])])
	})

	test('strips every on* event handler from an allowed tag', () => {
		const nodes = [element('p', { onclick: 'alert(1)', onmouseover: 'x' }, [text('hi')])]
		expect(sanitizeNodes(nodes)).toEqual([element('p', {}, [text('hi')])])
	})

	test('strips a style attribute and any attribute not on the tag allowlist', () => {
		const nodes = [element('p', { style: 'color:red', foo: 'bar', class: 'x' }, [text('hi')])]
		// p has no permitted attributes at all, so every attribute is stripped.
		expect(sanitizeNodes(nodes)).toEqual([element('p', {}, [text('hi')])])
	})

	test('strips disallowed attributes from a but keeps href and title', () => {
		const nodes = [element('a', { href: 'https://example.com', title: 'example', target: '_blank', rel: 'noopener' }, [text('link')])]
		expect(sanitizeNodes(nodes)).toEqual([element('a', { href: 'https://example.com', title: 'example' }, [text('link')])])
	})

	test('drops an unsafe href from a but keeps the link text', () => {
		const nodes = [element('a', { href: 'javascript:alert(1)' }, [text('click')])]
		expect(sanitizeNodes(nodes)).toEqual([element('a', {}, [text('click')])])
	})

	test('drops a javascript: href smuggled with casing and control characters', () => {
		const nodes = [element('a', { href: '  JaVa\tScript:alert(1)' }, [text('click')])]
		expect(sanitizeNodes(nodes)).toEqual([element('a', {}, [text('click')])])
	})

	test('lowercases tag and attribute names', () => {
		const nodes = [element('P', { CLASS: 'x' }, [text('hi')])]
		// p permits no attributes, so the class is stripped regardless; the tag is normalized to lowercase.
		expect(sanitizeNodes(nodes)).toEqual([element('p', {}, [text('hi')])])
	})

	test('lowercases a permitted class attribute name on a span', () => {
		const nodes = [element('SPAN', { CLASS: 'hljs-keyword' }, [text('const')])]
		expect(sanitizeNodes(nodes)).toEqual([element('span', { class: 'hljs-keyword' }, [text('const')])])
	})

	test('keeps table structure', () => {
		const nodes = [
			element('table', {}, [
				element('thead', {}, [element('tr', {}, [element('th', {}, [text('A')])])]),
				element('tbody', {}, [element('tr', {}, [element('td', {}, [text('1')])])]),
			]),
		]
		expect(sanitizeNodes(nodes)).toEqual(nodes)
	})

	test('strips attributes from table cells', () => {
		const nodes = [element('td', { colspan: '2', style: 'x' }, [text('1')])]
		expect(sanitizeNodes(nodes)).toEqual([element('td', {}, [text('1')])])
	})

	test('does not throw on malformed nodes', () => {
		expect(sanitizeNodes([])).toEqual([])
		expect(sanitizeNodes([{ type: 'text', value: 123 }])).toEqual([])
		expect(sanitizeNodes([{ type: 'element' }])).toEqual([])
		expect(sanitizeNodes([{ type: 'element', tag: 'p', attributes: null, children: 'nope' }])).toEqual([{ type: 'element', tag: 'p', attributes: {}, children: [] }])
	})

	test('text is always kept and never treated as markup', () => {
		const nodes = [text('<script>alert(1)</script>')]
		expect(sanitizeNodes(nodes)).toEqual([text('<script>alert(1)</script>')])
	})
})

describe('htmlNodesToVnodes', () => {
	test('a text node becomes a bare string child, never markup', () => {
		expect(htmlNodesToVnodes([text('hi')], fakeH)).toEqual(['hi'])
	})

	test('an element becomes h(tag, attributes, children)', () => {
		const tree = [element('p', {}, [text('hi')])]
		expect(htmlNodesToVnodes(tree, fakeH)).toEqual([{ tag: 'p', props: {}, children: ['hi'] }])
	})

	test('passes attributes through as the vnode props', () => {
		const tree = [element('a', { href: 'https://example.com', title: 't' }, [text('link')])]
		expect(htmlNodesToVnodes(tree, fakeH)).toEqual([{ tag: 'a', props: { href: 'https://example.com', title: 't' }, children: ['link'] }])
	})

	test('renders a highlighted code block as nested vnodes with classes', () => {
		const tree = [element('pre', {}, [element('code', { class: 'hljs language-ts' }, [element('span', { class: 'hljs-keyword' }, [text('const')]), text(' x = 1')])])]
		expect(htmlNodesToVnodes(tree, fakeH)).toEqual([
			{ tag: 'pre', props: {}, children: [{ tag: 'code', props: { class: 'hljs language-ts' }, children: [{ tag: 'span', props: { class: 'hljs-keyword' }, children: ['const'] }, ' x = 1'] }] },
		])
	})

	test('a sanitized-away script never reaches the vnode layer', () => {
		const sanitized = sanitizeNodes([element('script', {}, [text('alert(1)')]), element('p', {}, [text('ok')])])
		expect(htmlNodesToVnodes(sanitized, fakeH)).toEqual([{ tag: 'p', props: {}, children: ['ok'] }])
	})

	test('untrusted text inside a code fence stays a text vnode (no execution)', () => {
		const sanitized = sanitizeNodes([element('pre', {}, [element('code', { class: 'hljs' }, [text('<script>alert(1)</script>')])])])
		expect(htmlNodesToVnodes(sanitized, fakeH)).toEqual([
			{ tag: 'pre', props: {}, children: [{ tag: 'code', props: { class: 'hljs' }, children: ['<script>alert(1)</script>'] }] },
		])
	})
})
