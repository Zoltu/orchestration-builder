import { describe, expect, test } from 'bun:test'
import { createCopyingMarkdownRenderer } from './markdown-copy.js'
import type { MarkdownRenderContent } from './markdown-copy.js'

interface FakeVnode {
	tag: string
	props: Record<string, unknown>
	children: (FakeVnode | string)[]
}

function fakeH(tag: string, props: Record<string, unknown>, children: (FakeVnode | string)[]): FakeVnode {
	return { tag, props, children }
}

function paragraph(text: string): FakeVnode {
	return { tag: 'p', props: {}, children: [text] }
}

function buttonOf(nodes: (FakeVnode | string)[]): FakeVnode {
	for (const node of nodes) {
		if (typeof node === 'string') continue
		if (node.tag === 'button') return node
	}
	throw new Error('the renderer produced no button')
}

function buttonOfOrUndefined(nodes: (FakeVnode | string)[]): FakeVnode | undefined {
	for (const node of nodes) {
		if (typeof node === 'string') continue
		if (node.tag === 'button') return node
	}
	return undefined
}

function invokeClick(vnode: FakeVnode, first: unknown, second?: unknown): unknown {
	const handler = vnode.props['onclick']
	if (typeof handler !== 'function') throw new Error('the button carries no click handler')
	return handler(first, second)
}

interface FakeEvent {
	stopCount: number
	stopPropagation(): void
}

function createFakeEvent(): FakeEvent {
	return {
		stopCount: 0,
		stopPropagation() {
			this.stopCount += 1
		},
	}
}

function createRecorder(): { copied: string[]; onCopy: (text: string) => void } {
	const copied: string[] = []
	return { copied, onCopy: (text: string) => { copied.push(text) } }
}

describe('createCopyingMarkdownRenderer', () => {
	test('preserves the base content before appending the copy button', () => {
		const baseVnode = paragraph('rendered')
		const renderMarkdown = createCopyingMarkdownRenderer(fakeH, () => [baseVnode, 'tail'], () => undefined)
		const result = renderMarkdown('## Heading')
		expect(result).toHaveLength(3)
		expect(result[0]).toBe(baseVnode)
		expect(result[1]).toBe('tail')
		const button = buttonOf(result)
		expect(result[2]).toBe(button)
		expect(button.tag).toBe('button')
	})

	test('renders a button for non-empty Markdown', () => {
		const renderMarkdown = createCopyingMarkdownRenderer(fakeH, (text) => [paragraph(text)], () => undefined)
		const result = renderMarkdown('# A heading')
		expect(buttonOfOrUndefined(result)).toBeDefined()
	})

	test('renders no button for empty or whitespace-only Markdown', () => {
		const renderMarkdown = createCopyingMarkdownRenderer(fakeH, (text) => [paragraph(text)], () => undefined)
		for (const text of ['', ' ', '\n\t  \n']) {
			const result = renderMarkdown(text)
			expect(buttonOfOrUndefined(result)).toBeUndefined()
		}
	})

	test('copies the original Markdown source verbatim, including its syntax', () => {
		const source = '## Heading\n\n- **bold** item\n- `code` item\n\n```ts\nconst value = 1\n```\n'
		const recorder = createRecorder()
		const renderMarkdown = createCopyingMarkdownRenderer(fakeH, (text) => [paragraph(text)], recorder.onCopy)
		const button = buttonOf(renderMarkdown(source))
		invokeClick(button, undefined, createFakeEvent())
		expect(recorder.copied).toEqual([source])
	})

	test('labels the button as a Copy Markdown action', () => {
		const renderMarkdown = createCopyingMarkdownRenderer(fakeH, (text) => [paragraph(text)], () => undefined)
		const button = buttonOf(renderMarkdown('some prose'))
		expect(button.props['type']).toBe('button')
		expect(button.props['class']).toBe('markdown-copy-button')
		expect(button.props['title']).toBe('Copy Markdown')
		expect(button.props['aria-label']).toBe('Copy Markdown')
		expect(button.children).toEqual(['Copy'])
	})

	test('a hyperapp-style click returns the state and stops propagation', () => {
		const source = 'agent **prose**'
		const recorder = createRecorder()
		const renderMarkdown = createCopyingMarkdownRenderer(fakeH, (text) => [paragraph(text)], recorder.onCopy)
		const button = buttonOf(renderMarkdown(source))
		const state = { selectedRunId: 'run-1' }
		const event = createFakeEvent()
		const returned = invokeClick(button, state, event)
		expect(returned).toBe(state)
		expect(event.stopCount).toBe(1)
		expect(recorder.copied).toEqual([source])
	})

	test('a demo-style click receives the DOM event first, stops propagation, and copies', () => {
		const source = 'prose from the demo'
		const recorder = createRecorder()
		const renderMarkdown = createCopyingMarkdownRenderer(fakeH, (text) => [paragraph(text)], recorder.onCopy)
		const button = buttonOf(renderMarkdown(source))
		const event = createFakeEvent()
		invokeClick(button, event)
		expect(event.stopCount).toBe(1)
		expect(recorder.copied).toEqual([source])
	})

	test('flattens a nested-array base result before appending the button', () => {
		const nested: MarkdownRenderContent<FakeVnode> = [[paragraph('first'), ['second']], 'third']
		const renderMarkdown = createCopyingMarkdownRenderer(fakeH, () => nested, () => undefined)
		const result = renderMarkdown('nested content')
		expect(result).toHaveLength(4)
		expect(result[0]).toEqual(paragraph('first'))
		expect(result[1]).toBe('second')
		expect(result[2]).toBe('third')
		const appended = result[3]
		if (appended === undefined || typeof appended === 'string') throw new Error('the final entry is not a button vnode')
		expect(appended.tag).toBe('button')
		expect(appended.props['class']).toBe('markdown-copy-button')
		expect(appended.children).toEqual(['Copy'])
	})
})
