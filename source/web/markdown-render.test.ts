import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createMarkdownRenderer } from './static/ts/markdown-render.js'

// A fake hyperscript that mirrors how hyperapp's `h` is used (`h(tag, props, children)`) and produces a fresh vnode object per call, so any object identity shared across two renders can only come from the renderer caching vnodes.
interface FakeVnode {
	tag: string
	props: Record<string, string>
	children: unknown[]
}

function fakeH(tag: string, props: Record<string, string>, children: unknown[]): FakeVnode {
	return { tag, props, children }
}

function isFakeVnode(value: unknown): value is FakeVnode {
	if (typeof value !== 'object' || value === null) return false
	if (!('tag' in value) || !('children' in value)) return false
	return Array.isArray(value.children)
}

// Collects every element vnode in pre-order so identity can be compared position by position across two renders.
function collectVnodes(nodes: unknown[], into: FakeVnode[]): void {
	for (const node of nodes) {
		if (typeof node === 'string') continue
		if (!isFakeVnode(node)) throw new Error('render produced something other than text or a fake vnode')
		into.push(node)
		collectVnodes(node.children, into)
	}
}

// The renderer reads the browser globals directly (`window.showdown`, `DOMParser`) and offers no injection point for them, so the fakes ride the same global surface; Reflect.set because no static declaration of these globals exists in the test program.
const SHARED_TEXT = 'shared paragraph'
const EMPTY_TREE_TEXT = 'empty tree paragraph'
const TEST_LIMITS = { maxEntries: 256, maxCharacters: 16_000_000 }

// A fake converter that wraps arbitrary input in one paragraph, or emits nothing for the empty-tree case, so the cache tests can use several distinct texts without a fixture per text.
class FakeConverter {
	makeHtml(text: string): string {
		makeHtmlCalls += 1
		if (text === EMPTY_TREE_TEXT) return ''
		return `<p>${text}</p>`
	}
}

interface FakeDomNode {
	nodeType: number
	nodeValue: string | null
	tagName: string | null
	attributes: Array<{ name: string; value: string }>
	childNodes: FakeDomNode[]
}

let makeHtmlCalls = 0
let parseCalls = 0

class FakeDOMParser {
	parseFromString(html: string): { body: { childNodes: FakeDomNode[] } } {
		parseCalls += 1
		if (html === '') return { body: { childNodes: [] } }
		const match = /^<p>([\s\S]*)<\/p>$/.exec(html)
		if (match === null) throw new Error(`unexpected html: ${html}`)
		const text = match[1]
		if (text === undefined) throw new Error(`unexpected html: ${html}`)
		const textNode: FakeDomNode = { nodeType: 3, nodeValue: text, tagName: null, attributes: [], childNodes: [] }
		return { body: { childNodes: [{ nodeType: 1, nodeValue: null, tagName: 'p', attributes: [], childNodes: [textNode] }] } }
	}
}

describe('createMarkdownRenderer', () => {
	beforeEach(() => {
		makeHtmlCalls = 0
		parseCalls = 0
		Reflect.set(globalThis, 'window', { showdown: { Converter: FakeConverter } })
		Reflect.set(globalThis, 'DOMParser', FakeDOMParser)
	})

	afterEach(() => {
		Reflect.deleteProperty(globalThis, 'window')
		Reflect.deleteProperty(globalThis, 'DOMParser')
	})

	test('two renders of the same markdown share no vnode object at any position, while the sanitized tree is cached', () => {
		const renderMarkdown = createMarkdownRenderer(fakeH, TEST_LIMITS)
		const firstRender = renderMarkdown(SHARED_TEXT)
		const secondRender = renderMarkdown(SHARED_TEXT)
		expect(secondRender).toEqual(firstRender)
		expect(secondRender).not.toBe(firstRender)
		// The second render hit the memoized neutral tree (the parse-and-sanitize pass ran once) yet still rebuilt every vnode from it.
		expect(parseCalls).toBe(1)
		// The cache is consulted before showdown runs, so the second render must not reach makeHtml at all; counting it locks in that the lookup precedes the expensive conversion rather than merely preceding the parse.
		expect(makeHtmlCalls).toBe(1)
		const firstVnodes: FakeVnode[] = []
		const secondVnodes: FakeVnode[] = []
		collectVnodes(firstRender, firstVnodes)
		collectVnodes(secondRender, secondVnodes)
		expect(firstVnodes.length).toBeGreaterThan(0)
		expect(secondVnodes.length).toBe(firstVnodes.length)
		for (const [index, firstVnode] of firstVnodes.entries()) {
			const secondVnode = secondVnodes[index]
			if (secondVnode === undefined) throw new Error('the second render is missing a vnode position')
			expect(secondVnode).not.toBe(firstVnode)
		}
	})

	test('the entry cap evicts the least-recently-used text, and a hit marks recency', () => {
		const renderMarkdown = createMarkdownRenderer(fakeH, { maxEntries: 2, maxCharacters: 1_000_000 })
		renderMarkdown('alpha')
		renderMarkdown('beta')
		expect(makeHtmlCalls).toBe(2)
		renderMarkdown('alpha')
		expect(makeHtmlCalls).toBe(2)
		// Recency now favours alpha over beta, so gamma evicts beta.
		renderMarkdown('gamma')
		expect(makeHtmlCalls).toBe(3)
		renderMarkdown('alpha')
		expect(makeHtmlCalls).toBe(3)
		renderMarkdown('beta')
		expect(makeHtmlCalls).toBe(4)
		// Beta's insertion evicted gamma; beta itself is now cached and renders without conversion.
		renderMarkdown('gamma')
		expect(makeHtmlCalls).toBe(5)
		renderMarkdown('beta')
		expect(makeHtmlCalls).toBe(5)
	})

	test('the character budget retains entries that fit and evicts the oldest that do not', () => {
		const renderMarkdown = createMarkdownRenderer(fakeH, { maxEntries: 256, maxCharacters: 20 })
		renderMarkdown('budget-aa')
		renderMarkdown('budget-bb')
		renderMarkdown('budget-cc')
		expect(makeHtmlCalls).toBe(3)
		renderMarkdown('budget-bb')
		renderMarkdown('budget-cc')
		expect(makeHtmlCalls).toBe(3)
		renderMarkdown('budget-aa')
		expect(makeHtmlCalls).toBe(4)
	})

	test('an oversized entry is retained, evicts older entries, and is not converted on every render', () => {
		const renderMarkdown = createMarkdownRenderer(fakeH, { maxEntries: 2, maxCharacters: 5 })
		renderMarkdown('this entry is oversized')
		expect(makeHtmlCalls).toBe(1)
		renderMarkdown('this entry is oversized')
		expect(makeHtmlCalls).toBe(1)
		renderMarkdown('this other entry is also oversized')
		expect(makeHtmlCalls).toBe(2)
		renderMarkdown('this other entry is also oversized')
		expect(makeHtmlCalls).toBe(2)
		renderMarkdown('this entry is oversized')
		expect(makeHtmlCalls).toBe(3)
	})

	test('a cached empty sanitized tree still returns the raw text on every render', () => {
		const renderMarkdown = createMarkdownRenderer(fakeH, TEST_LIMITS)
		expect(renderMarkdown(EMPTY_TREE_TEXT)).toEqual([EMPTY_TREE_TEXT])
		expect(renderMarkdown(EMPTY_TREE_TEXT)).toEqual([EMPTY_TREE_TEXT])
		expect(makeHtmlCalls).toBe(1)
		expect(parseCalls).toBe(1)
	})
})
