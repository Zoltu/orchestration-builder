// Adds a Copy Markdown button below every non-empty Markdown fragment passed through the pipeline: one button per `renderMarkdown` call, regardless of how many paragraphs or lists the fragment contains. The button copies the original source string verbatim, not the rendered HTML, so syntax highlighting and sanitization never alter what reaches the clipboard.
//
// The clipboard effect is injected rather than reached through a global: the hosts pass the shared `clipboard.js` leaf, keeping this module testable in-memory. The hosts also inject their own hyperscript function, because the product client builds hyperapp vnodes while the demo harness builds live DOM wrappers.
//
// A host's click handler signature differs: hyperapp actions receive `(state, event)`, while the demo's DOM `htmlH` calls a listener with the event as its first argument. The handler below detects either shape, stops propagation so the click does not also activate a surrounding history row or navigation target, and returns its first argument so a hyperapp action still returns the state.

export type MarkdownRenderContent<V> = V | string | MarkdownRenderContent<V>[]

export type MarkdownHyperscript<V> = (tag: string, attributes: Record<string, unknown>, children: (V | string)[]) => V

interface StopPropagationEvent {
	stopPropagation(): void
}

function isStopPropagationEvent(value: unknown): value is StopPropagationEvent {
	if (typeof value !== 'object' || value === null) return false
	return 'stopPropagation' in value && typeof value.stopPropagation === 'function'
}

function flattenContent<V>(content: MarkdownRenderContent<V>, into: (V | string)[]): void {
	if (typeof content === 'string') {
		into.push(content)
		return
	}
	if (Array.isArray(content)) {
		for (const child of content) flattenContent(child, into)
		return
	}
	into.push(content)
}

function createCopyHandler(text: string, onCopy: (text: string) => void): (first: unknown, second?: unknown) => unknown {
	return function copyMarkdown(first: unknown, second?: unknown): unknown {
		const event = isStopPropagationEvent(second) ? second : isStopPropagationEvent(first) ? first : null
		if (event !== null) event.stopPropagation()
		onCopy(text)
		return first
	}
}

export function createCopyingMarkdownRenderer<V>(
	h: MarkdownHyperscript<V>,
	renderMarkdown: (text: string) => MarkdownRenderContent<V>,
	onCopy: (text: string) => void,
): (text: string) => (V | string)[] {
	return function renderMarkdownWithCopy(text: string): (V | string)[] {
		const content: (V | string)[] = []
		flattenContent(renderMarkdown(text), content)
		if (typeof text !== 'string' || text.trim() === '') return content
		const button = h('button', {
			type: 'button',
			class: 'markdown-copy-button',
			title: 'Copy Markdown',
			'aria-label': 'Copy Markdown',
			onclick: createCopyHandler(text, onCopy),
		}, ['Copy'])
		return [...content, button]
	}
}
