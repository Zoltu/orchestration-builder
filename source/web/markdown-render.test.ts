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
const MARKDOWN_TEXT = 'shared paragraph'
const FAKE_HTML = '<p>shared body paragraph</p>'

class FakeConverter {
	makeHtml(text: string): string {
		if (text !== MARKDOWN_TEXT) throw new Error(`unexpected markdown: ${text}`)
		return FAKE_HTML
	}
}

interface FakeDomNode {
	nodeType: number
	nodeValue: string | null
	tagName: string | null
	attributes: Array<{ name: string; value: string }>
	childNodes: FakeDomNode[]
}

let parseCalls = 0

class FakeDOMParser {
	parseFromString(html: string): { body: { childNodes: FakeDomNode[] } } {
		parseCalls += 1
		if (html !== FAKE_HTML) throw new Error(`unexpected html: ${html}`)
		const textNode: FakeDomNode = { nodeType: 3, nodeValue: 'shared body paragraph', tagName: null, attributes: [], childNodes: [] }
		return { body: { childNodes: [{ nodeType: 1, nodeValue: null, tagName: 'p', attributes: [], childNodes: [textNode] }] } }
	}
}

describe('createMarkdownRenderer — fresh vnodes per render', () => {
	beforeEach(() => {
		parseCalls = 0
		Reflect.set(globalThis, 'window', { showdown: { Converter: FakeConverter } })
		Reflect.set(globalThis, 'DOMParser', FakeDOMParser)
	})

	afterEach(() => {
		Reflect.deleteProperty(globalThis, 'window')
		Reflect.deleteProperty(globalThis, 'DOMParser')
	})

	test('two renders of the same markdown share no vnode object at any position, while the sanitized tree is cached', () => {
		const renderMarkdown = createMarkdownRenderer(fakeH)
		const firstRender = renderMarkdown(MARKDOWN_TEXT)
		const secondRender = renderMarkdown(MARKDOWN_TEXT)
		expect(secondRender).toEqual(firstRender)
		expect(secondRender).not.toBe(firstRender)
		// The second render hit the memoized neutral tree (the parse-and-sanitize pass ran once) yet still rebuilt every vnode from it.
		expect(parseCalls).toBe(1)
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
})
