import { describe, expect, test } from 'bun:test'
import { ResultModal, deriveTerminalResult } from './static/result-modal.js'
import { actionProp, defined, present } from './test-fixtures.js'

// The result-modal component is browser-pure JS, so its exports arrive with inferred JS types. The interfaces and fake `h`/`renderMarkdown` below carry the shape the tests assert against, mirroring question-modal.test.ts.

interface Vnode {
	tag: string
	props: Record<string, unknown>
	children: VnodeChild[]
}
type VnodeChild = Vnode | string
type VnodeChildInput = VnodeChild | VnodeChildInput[] | null | undefined | boolean

function fakeH(tag: string, props: Record<string, unknown>, children: VnodeChildInput): Vnode {
	return { tag, props, children: normalizeChildren(children) }
}

// hyperapp flattens nested arrays and drops null/boolean children; the fake mirrors that so the component can pass loose children the same way it does against the real renderer.
function normalizeChildren(children: VnodeChildInput): VnodeChild[] {
	const out: VnodeChild[] = []
	pushChildren(out, children)
	return out
}

function pushChildren(out: VnodeChild[], children: VnodeChildInput): void {
	if (children === null || children === undefined || typeof children === 'boolean') return
	if (Array.isArray(children)) {
		for (const child of children) pushChildren(out, child)
		return
	}
	out.push(children)
}

function isVnode(value: VnodeChild): value is Vnode {
	return typeof value !== 'string'
}

function byTag(vnode: Vnode, tag: string): Vnode[] {
	return vnode.children.filter((child): child is Vnode => isVnode(child) && child.tag === tag)
}

// Walks a vnode tree and collects every descendant matching a tag, so the modal's nested structure (status/summary/artifacts/error inside the card) is reachable.
function allByTag(vnode: Vnode, tag: string): Vnode[] {
	const found: Vnode[] = []
	for (const child of vnode.children) {
		if (!isVnode(child)) continue
		if (child.tag === tag) found.push(child)
		for (const grand of allByTag(child, tag)) found.push(grand)
	}
	return found
}

// A fake Markdown renderer that records its argument and returns a marker vnode carrying the text, so the tests assert both that the prose flowed through the renderer and that its output reached the modal.
function fakeRenderMarkdown(text: string): Vnode {
	return { tag: 'span', props: { class: 'md-marker', 'data-text': text }, children: [text] }
}

describe('deriveTerminalResult', () => {
	test('returns undefined for a non-terminal run', () => {
		expect(deriveTerminalResult({ status: 'unknown' })).toBeUndefined()
		expect(deriveTerminalResult({ status: 'running' })).toBeUndefined()
	})

	test('returns undefined for a malformed run view', () => {
		expect(deriveTerminalResult(null)).toBeUndefined()
		expect(deriveTerminalResult(undefined)).toBeUndefined()
		expect(deriveTerminalResult({})).toBeUndefined()
	})

	test('derives a success descriptor with summary and artifacts', () => {
		const runView = {
			status: 'success',
			result: { status: 'success', summary: 'Added the CSV export.', artifacts: ['reports/csv.js', 'docs/export.md'] },
		}
		const descriptor = defined(deriveTerminalResult(runView), 'descriptor')
		expect(descriptor).toBeDefined()
		expect(descriptor.status).toBe('success')
		expect(descriptor.summary).toBe('Added the CSV export.')
		expect(descriptor.artifacts).toEqual(['reports/csv.js', 'docs/export.md'])
		expect(descriptor.error).toBeNull()
	})

	test('a success descriptor with no artifacts yields an empty artifacts list', () => {
		const descriptor = defined(deriveTerminalResult({ status: 'success', result: { status: 'success', summary: 'done.' } }), 'descriptor')
		expect(descriptor.artifacts).toEqual([])
		expect(descriptor.summary).toBe('done.')
	})

	test('filters non-string and empty-string artifacts', () => {
		const runView = {
			status: 'success',
			result: { status: 'success', summary: 'done.', artifacts: ['a.js', '', 42, 'b.ts', null] },
		}
		expect(defined(deriveTerminalResult(runView), 'descriptor').artifacts).toEqual(['a.js', 'b.ts'])
	})

	test('derives an error descriptor from the run-level error', () => {
		const runView = {
			status: 'error',
			error: { kind: 'llm_unavailable', message: 'The model endpoint refused the connection.' },
		}
		const descriptor = defined(deriveTerminalResult(runView), 'descriptor')
		expect(descriptor.status).toBe('error')
		expect(descriptor.error).not.toBeNull()
		const error = present(descriptor.error, 'descriptor.error')
		expect(error.message).toBe('The model endpoint refused the connection.')
		expect(error.raw).toEqual({ kind: 'llm_unavailable', message: 'The model endpoint refused the connection.' })
	})

	test('falls back to the result card\u2019s nested error when the run-level error is absent', () => {
		const runView = {
			status: 'error',
			result: { status: 'error', summary: 'The run could not reach the model.', error: { kind: 'llm_unavailable', message: 'connection refused' } },
		}
		const descriptor = defined(deriveTerminalResult(runView), 'descriptor')
		expect(present(descriptor.error, 'descriptor.error').message).toBe('connection refused')
		expect(present(descriptor.error, 'descriptor.error').raw).toEqual({ kind: 'llm_unavailable', message: 'connection refused' })
		expect(descriptor.summary).toBe('The run could not reach the model.')
	})

	test('an error with no message yields a null message but keeps the raw object for copy-raw', () => {
		const runView = { status: 'error', error: { kind: 'loop_detected' } }
		const descriptor = defined(deriveTerminalResult(runView), 'descriptor')
		const error = present(descriptor.error, 'descriptor.error')
		expect(error.message).toBeNull()
		expect(error.raw).toEqual({ kind: 'loop_detected' })
	})

	test('an error run with neither error nor result yields a null message and null raw', () => {
		const descriptor = defined(deriveTerminalResult({ status: 'error' }), 'descriptor')
		expect(descriptor.error).not.toBeNull()
		const error = present(descriptor.error, 'descriptor.error')
		expect(error.message).toBeNull()
		expect(error.raw).toBeNull()
	})

	test('needs_clarification is terminal but carries no error block', () => {
		const descriptor = defined(deriveTerminalResult({ status: 'needs_clarification', result: { status: 'needs_clarification', summary: 'Needs your input.' } }), 'descriptor')
		expect(descriptor.status).toBe('needs_clarification')
		expect(descriptor.error).toBeNull()
	})
})

describe('ResultModal', () => {
	const successDescriptor = {
		status: 'success' as const,
		summary: 'Added the CSV export to the reports module.',
		artifacts: ['reports/csv.js'],
		error: null,
	}

	const errorDescriptor = {
		status: 'error' as const,
		summary: 'The run could not reach the model.',
		artifacts: [],
		error: { message: 'The model endpoint refused the connection.', raw: { kind: 'llm_unavailable', message: 'The model endpoint refused the connection.' } },
	}

	test('renders a backdrop and a centered card over the run view', () => {
		const modal: Vnode = ResultModal(fakeH, { descriptor: successDescriptor, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onCopyRaw: () => undefined, onClose: () => undefined })
		expect(modal.tag).toBe('div')
		expect(modal.props.class).toBe('result-modal-overlay')
		expect(byTag(modal, 'div').some((d) => d.props.class === 'result-modal-backdrop')).toBe(true)
		const card = byTag(modal, 'div').find((d) => d.props.class === 'result-modal-card')
		expect(card).toBeDefined()
	})

	test('the card carries the error variant class on an error descriptor', () => {
		const modal: Vnode = ResultModal(fakeH, { descriptor: errorDescriptor, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onCopyRaw: () => undefined, onClose: () => undefined })
		const card = byTag(modal, 'div').find((d) => d.props.class === 'result-modal-card result-modal-card--error')
		expect(card).toBeDefined()
	})

	test('the heading names which run the result belongs to', () => {
		const modal: Vnode = ResultModal(fakeH, { descriptor: successDescriptor, runLabel: 'run-2026-1', renderMarkdown: fakeRenderMarkdown, onCopyRaw: () => undefined, onClose: () => undefined })
		const heading = defined(allByTag(modal, 'p').find((p) => p.props.class === 'result-modal-heading'), 'heading')
		expect(heading).toBeDefined()
		expect(heading.children.join('')).toBe('Result \u00b7 run-2026-1')
	})

	test('the heading falls back to "Result" when no run label is supplied', () => {
		const modal: Vnode = ResultModal(fakeH, { descriptor: successDescriptor, runLabel: null, renderMarkdown: fakeRenderMarkdown, onCopyRaw: () => undefined, onClose: () => undefined })
		const heading = defined(allByTag(modal, 'p').find((p) => p.props.class === 'result-modal-heading'), 'heading')
		expect(heading.children.join('')).toBe('Result')
	})

	test('the status line carries the status-modifier class', () => {
		const modal: Vnode = ResultModal(fakeH, { descriptor: successDescriptor, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onCopyRaw: () => undefined, onClose: () => undefined })
		const status = defined(allByTag(modal, 'p').find((p) => p.props.class === 'result-modal-status result-modal-status--success'), 'status')
		expect(status).toBeDefined()
		expect(status.children.join('')).toBe('Completed successfully')
	})

	test('renders the result summary through the sanitized Markdown pipeline', () => {
		const modal: Vnode = ResultModal(fakeH, { descriptor: successDescriptor, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onCopyRaw: () => undefined, onClose: () => undefined })
		const summaryDiv = defined(allByTag(modal, 'div').find((d) => d.props.class === 'result-modal-summary markdown'), 'summaryDiv')
		expect(summaryDiv).toBeDefined()
		const marker = defined(byTag(summaryDiv, 'span')[0], 'marker')
		expect(marker).toBeDefined()
		expect(marker.props['data-text']).toBe(successDescriptor.summary)
	})

	test('renders artifacts as plain text paths (not Markdown)', () => {
		const modal: Vnode = ResultModal(fakeH, { descriptor: successDescriptor, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onCopyRaw: () => undefined, onClose: () => undefined })
		const list = defined(allByTag(modal, 'ul').find((u) => u.props.class === 'result-modal-artifacts-list'), 'list')
		expect(list).toBeDefined()
		const items = byTag(list, 'li')
		expect(items.length).toBe(1)
		const item = defined(items[0], 'items[0]')
		expect(item.props.class).toBe('result-modal-artifact')
		// Artifacts are plain text children, never routed through renderMarkdown.
		expect(item.children.join('')).toBe('reports/csv.js')
	})

	test('omits the artifacts block when there are none', () => {
		const noArtifacts = { status: 'success' as const, summary: 'done.', artifacts: [], error: null }
		const modal: Vnode = ResultModal(fakeH, { descriptor: noArtifacts, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onCopyRaw: () => undefined, onClose: () => undefined })
		expect(allByTag(modal, 'ul').some((u) => u.props.class === 'result-modal-artifacts-list')).toBe(false)
	})

	test('omits the summary block when the result has no summary', () => {
		const noSummary = { status: 'success' as const, summary: null, artifacts: [], error: null }
		const modal: Vnode = ResultModal(fakeH, { descriptor: noSummary, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onCopyRaw: () => undefined, onClose: () => undefined })
		expect(allByTag(modal, 'div').some((d) => d.props.class === 'result-modal-summary markdown')).toBe(false)
	})

	test('renders the error message through the Markdown pipeline and hides the machine kind', () => {
		const modal: Vnode = ResultModal(fakeH, { descriptor: errorDescriptor, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onCopyRaw: () => undefined, onClose: () => undefined })
		const messageDiv = defined(allByTag(modal, 'div').find((d) => d.props.class === 'result-modal-error-message markdown'), 'messageDiv')
		expect(messageDiv).toBeDefined()
		const marker = defined(byTag(messageDiv, 'span')[0], 'marker')
		expect(marker.props['data-text']).toBe(errorDescriptor.error.message)
		// The machine kind never appears as rendered text anywhere in the modal.
		const allText = collectText(modal)
		expect(allText).not.toContain('llm_unavailable')
		expect(allText).not.toContain('kind')
	})

	test('the error block carries the honest framing line as fixed text', () => {
		const modal: Vnode = ResultModal(fakeH, { descriptor: errorDescriptor, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onCopyRaw: () => undefined, onClose: () => undefined })
		const framing = defined(allByTag(modal, 'p').find((p) => p.props.class === 'result-modal-error-framing'), 'framing')
		expect(framing).toBeDefined()
		expect(framing.children.join('')).toContain('Something went wrong')
		expect(framing.children.join('')).toContain('copy this to share')
	})

	test('the copy-raw button invokes onCopyRaw with the error JSON and returns state unchanged', () => {
		let captured = ''
		const onCopyRaw = (rawJson: string) => { captured = rawJson }
		const modal: Vnode = ResultModal(fakeH, { descriptor: errorDescriptor, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onCopyRaw, onClose: () => undefined })
		const copyButton = defined(allByTag(modal, 'button').find((b) => b.props.class === 'result-modal-copy'), 'copyButton')
		expect(copyButton).toBeDefined()
		// The onclick is a closure that wraps the injected leaf: hyperapp calls it as an action (state, event) => state, so it must return state unchanged (a leaf returning undefined would corrupt the app state). Invoking it with a dummy state verifies the leaf receives the precomputed JSON and the state passes through.
		const handler = actionProp(copyButton.props, 'onclick')
		expect(typeof handler).toBe('function')
		const dummyState = { marker: 'state' }
		const returned = handler(dummyState)
		expect(captured).toBe(JSON.stringify(errorDescriptor.error.raw))
		expect(returned).toBe(dummyState)
		// The machine kind never appears as rendered text anywhere in the modal.
		const allText = collectText(modal)
		expect(allText).not.toContain('llm_unavailable')
		expect(allText).not.toContain('kind')
	})

	test('omits the copy-raw button when the error has no raw object', () => {
		const noRaw = { status: 'error' as const, summary: null, artifacts: [], error: { message: null, raw: null } }
		const modal: Vnode = ResultModal(fakeH, { descriptor: noRaw, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onCopyRaw: () => undefined, onClose: () => undefined })
		expect(allByTag(modal, 'button').some((b) => b.props.class === 'result-modal-copy')).toBe(false)
	})

	test('the close button wires the onClose handler', () => {
		let closed = false
		const onClose = () => { closed = true }
		const modal: Vnode = ResultModal(fakeH, { descriptor: successDescriptor, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onCopyRaw: () => undefined, onClose })
		const close = defined(allByTag(modal, 'button').find((b) => b.props.class === 'result-modal-close'), 'close')
		expect(close).toBeDefined()
		expect(close.props.onclick).toBe(onClose)
		const handler = actionProp(close.props, 'onclick')
		handler(undefined)
		expect(closed).toBe(true)
	})

	test('the backdrop click also dismisses the modal', () => {
		let closed = false
		const onClose = () => { closed = true }
		const modal: Vnode = ResultModal(fakeH, { descriptor: successDescriptor, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onCopyRaw: () => undefined, onClose })
		const backdrop = defined(byTag(modal, 'div').find((d) => d.props.class === 'result-modal-backdrop'), 'backdrop')
		expect(backdrop).toBeDefined()
		expect(backdrop.props.onclick).toBe(onClose)
		actionProp(backdrop.props, 'onclick')(undefined)
		expect(closed).toBe(true)
	})
})

function collectText(vnode: Vnode): string {
	let out = ''
	for (const child of vnode.children) {
		if (typeof child === 'string') out += child
		else out += collectText(child)
	}
	return out
}
