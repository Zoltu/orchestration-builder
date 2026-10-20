import { describe, expect, test } from 'bun:test'
import { ResultModal, ResultPendingModal, deriveTerminalResult } from './static/ts/result-modal.js'
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

	test('a result card\u2019s technical detail rides the descriptor', () => {
		const runView = {
			status: 'error',
			result: {
				status: 'error',
				summary: 'LLM unavailable: HTTP 402',
				error: { kind: 'llm_unavailable', message: 'HTTP 402' },
				detail: '{"error":"Insufficient credit"}',
			},
		}
		const descriptor = defined(deriveTerminalResult(runView), 'descriptor')
		expect(descriptor.detail).toBe('{"error":"Insufficient credit"}')
		const error = present(descriptor.error, 'descriptor.error')
		expect(error.raw).toEqual({ kind: 'llm_unavailable', message: 'HTTP 402' })
	})

	test('an empty or non-string card detail is treated as absent', () => {
		const runView = {
			status: 'error',
			result: { status: 'error', summary: 'failed.', error: { kind: 'llm_unavailable', message: 'HTTP 500' }, detail: '' },
		}
		const descriptor = defined(deriveTerminalResult(runView), 'descriptor')
		expect(descriptor.detail).toBeUndefined()
		expect(present(descriptor.error, 'descriptor.error').raw).toEqual({ kind: 'llm_unavailable', message: 'HTTP 500' })
	})

	test('a card detail on a success run never surfaces', () => {
		const runView = { status: 'success', result: { status: 'success', summary: 'done.', detail: 'stray' } }
		const descriptor = defined(deriveTerminalResult(runView), 'descriptor')
		expect(descriptor.detail).toBeUndefined()
		expect(descriptor.error).toBeNull()
	})

	test('the resumable flag rides only an error descriptor', () => {
		expect(defined(deriveTerminalResult({ status: 'error', resumable: true }), 'descriptor').resumable).toBe(true)
		expect(defined(deriveTerminalResult({ status: 'error' }), 'descriptor').resumable).toBe(false)
		// A non-boolean flag reads as not resumable, like any other guarded wire field.
		expect(defined(deriveTerminalResult({ status: 'error', resumable: 'yes' }), 'descriptor').resumable).toBe(false)
		// A malformed body carrying the flag on a non-error status is contained: the descriptor stays consistent with its own status.
		expect(defined(deriveTerminalResult({ status: 'success', resumable: true }), 'descriptor').resumable).toBe(false)
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

	test('the card detail renders in a collapsed details block as preformatted text', () => {
		const withDetail = {
			status: 'error' as const,
			summary: 'LLM unavailable: HTTP 402',
			artifacts: [],
			error: { message: 'HTTP 402', raw: { kind: 'llm_unavailable', message: 'HTTP 402' } },
			detail: '{"error":"Insufficient credit"}',
		}
		const modal: Vnode = ResultModal(fakeH, { descriptor: withDetail, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onCopyRaw: () => undefined, onClose: () => undefined })
		const details = defined(allByTag(modal, 'details').find((d) => d.props.class === 'result-modal-error-detail'), 'details')
		expect(details).toBeDefined()
		// Collapsed by default: no open attribute.
		expect(details.props['open']).toBeUndefined()
		const summary = defined(byTag(details, 'summary')[0], 'summary')
		expect(summary.children.join('')).toBe('Technical details')
		const pre = defined(byTag(details, 'pre')[0], 'pre')
		// A machine field, so it stays textContent — never routed through the Markdown pipeline.
		expect(pre.children.join('')).toBe('{"error":"Insufficient credit"}')
	})

	test('no technical-details block when the descriptor carries no detail', () => {
		const modal: Vnode = ResultModal(fakeH, { descriptor: errorDescriptor, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onCopyRaw: () => undefined, onClose: () => undefined })
		expect(allByTag(modal, 'details')).toEqual([])
	})

	test('the copy-raw payload includes the card detail', () => {
		let captured = ''
		const withDetail = {
			status: 'error' as const,
			summary: 'LLM unavailable: HTTP 402',
			artifacts: [],
			error: { message: 'HTTP 402', raw: { kind: 'llm_unavailable', message: 'HTTP 402' } },
			detail: '{"error":"Insufficient credit"}',
		}
		const modal: Vnode = ResultModal(fakeH, { descriptor: withDetail, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onCopyRaw: (rawJson) => { captured = rawJson }, onClose: () => undefined })
		const copyButton = defined(allByTag(modal, 'button').find((b) => b.props.class === 'result-modal-copy'), 'copyButton')
		actionProp(copyButton.props, 'onclick')({ marker: 'state' })
		expect(JSON.parse(captured)).toEqual({ kind: 'llm_unavailable', message: 'HTTP 402', detail: '{"error":"Insufficient credit"}' })
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

	test('a success modal renders Continue when the host supplies the capability and none when it does not', () => {
		const withoutProp: Vnode = ResultModal(fakeH, { descriptor: successDescriptor, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onCopyRaw: () => undefined, onClose: () => undefined })
		expect(allByTag(withoutProp, 'button').some((b) => b.props.class === 'result-modal-continue')).toBe(false)

		let fired = false
		const onContinue = () => { fired = true }
		const withProp: Vnode = ResultModal(fakeH, { descriptor: successDescriptor, runLabel: 'run-42', renderMarkdown: fakeRenderMarkdown, onCopyRaw: () => undefined, onContinue, onClose: () => undefined })
		const continueButton = defined(allByTag(withProp, 'button').find((b) => b.props.class === 'result-modal-continue'), 'continueButton')
		// The run id rides the same data-run-id attribute the history row's Continue button uses, so the host wires one action for both.
		expect(continueButton.props['data-run-id']).toBe('run-42')
		expect(continueButton.props.onclick).toBe(onContinue)
		// The affordance sits beside Close, not in place of it.
		expect(allByTag(withProp, 'button').some((b) => b.props.class === 'result-modal-close')).toBe(true)
		actionProp(continueButton.props, 'onclick')(undefined)
		expect(fired).toBe(true)
	})

	test('interrupted and needs_clarification outcomes render Continue with the run id and action wired', () => {
		const interruptedDescriptor = { status: 'interrupted' as const, summary: null, artifacts: [], error: { message: null, raw: null } }
		let interruptedFired = false
		const onInterruptedContinue = () => { interruptedFired = true }
		const interrupted: Vnode = ResultModal(fakeH, { descriptor: interruptedDescriptor, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onContinue: onInterruptedContinue, onClose: () => undefined })
		const interruptedButton = defined(allByTag(interrupted, 'button').find((b) => b.props.class === 'result-modal-continue'), 'interruptedContinue')
		expect(interruptedButton.props['data-run-id']).toBe('run-1')
		expect(interruptedButton.props.onclick).toBe(onInterruptedContinue)
		actionProp(interruptedButton.props, 'onclick')(undefined)
		expect(interruptedFired).toBe(true)

		const clarificationDescriptor = { status: 'needs_clarification' as const, summary: 'Needs your input.', artifacts: [], error: null }
		let clarificationFired = false
		const onClarificationContinue = () => { clarificationFired = true }
		const clarification: Vnode = ResultModal(fakeH, { descriptor: clarificationDescriptor, runLabel: 'run-2', renderMarkdown: fakeRenderMarkdown, onContinue: onClarificationContinue, onClose: () => undefined })
		const clarificationButton = defined(allByTag(clarification, 'button').find((b) => b.props.class === 'result-modal-continue'), 'clarificationContinue')
		expect(clarificationButton.props['data-run-id']).toBe('run-2')
		expect(clarificationButton.props.onclick).toBe(onClarificationContinue)
		actionProp(clarificationButton.props, 'onclick')(undefined)
		expect(clarificationFired).toBe(true)
	})

	test('the Continue button renders only when the host supplies the capability', () => {
		// Without the prop — the demo harness's shape — the action row keeps only Close.
		const withoutProp: Vnode = ResultModal(fakeH, { descriptor: errorDescriptor, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onCopyRaw: () => undefined, onClose: () => undefined })
		expect(allByTag(withoutProp, 'button').some((b) => b.props.class === 'result-modal-continue')).toBe(false)
	})

	// The Resume affordance: the primary recovery action for an errored run whose checkpoint survives. Same action contract as Continue — a hyperapp click action reading the run id off the button's data-run-id attribute.
	const resumableErrorDescriptor = { ...errorDescriptor, resumable: true }

	test('the Resume button renders only for an error outcome that is resumable and has the capability', () => {
		// Not resumable (the error descriptor carries no flag): no Resume even with the prop.
		const notResumable: Vnode = ResultModal(fakeH, { descriptor: errorDescriptor, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onResume: () => undefined, onClose: () => undefined })
		expect(allByTag(notResumable, 'button').some((b) => b.props.class === 'result-modal-resume')).toBe(false)
		// Resumable but the host omits the prop — the demo harness's shape: no Resume.
		const withoutProp: Vnode = ResultModal(fakeH, { descriptor: resumableErrorDescriptor, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onClose: () => undefined })
		expect(allByTag(withoutProp, 'button').some((b) => b.props.class === 'result-modal-resume')).toBe(false)
		// A non-error outcome never renders it, even when resumable and the prop is present.
		const success: Vnode = ResultModal(fakeH, { descriptor: { ...successDescriptor, resumable: true }, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onResume: () => undefined, onClose: () => undefined })
		expect(allByTag(success, 'button').some((b) => b.props.class === 'result-modal-resume')).toBe(false)
	})

	test('a resumable error with both props renders Resume, Continue, Close in order and both recovery buttons fire', () => {
		let resumed = false
		let continued = false
		const onResume = () => { resumed = true }
		const onContinue = () => { continued = true }
		const modal: Vnode = ResultModal(fakeH, { descriptor: resumableErrorDescriptor, runLabel: 'run-42', renderMarkdown: fakeRenderMarkdown, onContinue, onResume, onClose: () => undefined })
		const actions = defined(allByTag(modal, 'div').find((d) => d.props.class === 'result-modal-actions'), 'actions')
		const buttons = byTag(actions, 'button')
		expect(buttons.map((button) => button.props.class)).toEqual(['result-modal-resume', 'result-modal-continue', 'result-modal-close'])
		const resumeButton = defined(buttons[0], 'resumeButton')
		const continueButton = defined(buttons[1], 'continueButton')
		// Both recovery actions stamp the same run id the history row's Continue button uses.
		expect(resumeButton.props['data-run-id']).toBe('run-42')
		expect(continueButton.props['data-run-id']).toBe('run-42')
		expect(resumeButton.props.onclick).toBe(onResume)
		expect(continueButton.props.onclick).toBe(onContinue)
		actionProp(resumeButton.props, 'onclick')(undefined)
		expect(resumed).toBe(true)
		actionProp(continueButton.props, 'onclick')(undefined)
		expect(continued).toBe(true)
	})

	test('a non-resumable error with both props renders Continue but not Resume', () => {
		const modal: Vnode = ResultModal(fakeH, { descriptor: errorDescriptor, runLabel: 'run-1', renderMarkdown: fakeRenderMarkdown, onContinue: () => undefined, onResume: () => undefined, onClose: () => undefined })
		expect(allByTag(modal, 'button').some((b) => b.props.class === 'result-modal-continue')).toBe(true)
		expect(allByTag(modal, 'button').some((b) => b.props.class === 'result-modal-resume')).toBe(false)
	})

	test('the recovery buttons render disabled with the host reason while Close stays available', () => {
		const modal: Vnode = ResultModal(fakeH, {
			descriptor: resumableErrorDescriptor,
			runLabel: 'run-1',
			renderMarkdown: fakeRenderMarkdown,
			onContinue: () => undefined,
			onResume: () => undefined,
			onClose: () => undefined,
			recoveryDisabled: true,
			recoveryDisabledReason: 'Another run is already in progress.',
		})
		const actions = defined(allByTag(modal, 'div').find((d) => d.props.class === 'result-modal-actions'), 'actions')
		const buttons = byTag(actions, 'button')
		expect(buttons.map((button) => button.props.class)).toEqual(['result-modal-resume', 'result-modal-continue', 'result-modal-close'])
		const resumeButton = defined(buttons[0], 'resumeButton')
		const continueButton = defined(buttons[1], 'continueButton')
		const closeButton = defined(buttons[2], 'closeButton')
		expect(resumeButton.props.disabled).toBe(true)
		expect(continueButton.props.disabled).toBe(true)
		expect(resumeButton.props.title).toBe('Another run is already in progress.')
		expect(continueButton.props.title).toBe('Another run is already in progress.')
		expect(closeButton.props.disabled).toBeUndefined()
	})

	test('the explicit runId prop stamps the recovery buttons independently of the heading label', () => {
		const modal: Vnode = ResultModal(fakeH, {
			descriptor: resumableErrorDescriptor,
			runLabel: 'displayed label',
			runId: 'run-9',
			renderMarkdown: fakeRenderMarkdown,
			onContinue: () => undefined,
			onResume: () => undefined,
			onClose: () => undefined,
		})
		const resumeButton = defined(allByTag(modal, 'button').find((b) => b.props.class === 'result-modal-resume'), 'resumeButton')
		const continueButton = defined(allByTag(modal, 'button').find((b) => b.props.class === 'result-modal-continue'), 'continueButton')
		expect(resumeButton.props['data-run-id']).toBe('run-9')
		expect(continueButton.props['data-run-id']).toBe('run-9')
	})

	test('demo-style usage with no recovery props is unchanged', () => {
		const modal: Vnode = ResultModal(fakeH, { descriptor: errorDescriptor, runLabel: 'demo scenario', renderMarkdown: fakeRenderMarkdown, onCopyRaw: () => undefined, onClose: () => undefined })
		expect(allByTag(modal, 'button').some((b) => b.props.class === 'result-modal-resume')).toBe(false)
		expect(allByTag(modal, 'button').some((b) => b.props.class === 'result-modal-continue')).toBe(false)
		expect(allByTag(modal, 'button').some((b) => b.props.class === 'result-modal-close')).toBe(true)
	})
})

describe('ResultPendingModal', () => {
	test('renders the shared overlay, backdrop, and card with the loading message and a close action', () => {
		let closed = false
		const onClose = () => { closed = true }
		const modal: Vnode = ResultPendingModal(fakeH, { phase: 'loading', runLabel: 'run-1', onClose })
		expect(modal.props.class).toBe('result-modal-overlay')
		expect(byTag(modal, 'div').some((d) => d.props.class === 'result-modal-backdrop')).toBe(true)
		const card = defined(byTag(modal, 'div').find((d) => d.props.class === 'result-modal-card result-modal-card--pending'), 'card')
		const message = defined(allByTag(card, 'div').find((d) => d.props.class === 'result-modal-pending-message'), 'message')
		expect(collectText(message)).toContain('Loading the result\u2026')
		const indicator = defined(allByTag(message, 'span').find((span) => span.props.class === 'loading-indicator'), 'loading indicator')
		expect(indicator.props.role).toBe('status')
		const heading = defined(allByTag(card, 'p').find((p) => p.props.class === 'result-modal-heading'), 'heading')
		expect(heading.children.join('')).toBe('Result \u00b7 run-1')
		expect(allByTag(modal, 'button').some((button) => button.props.class === 'result-modal-retry')).toBe(false)
		const close = defined(allByTag(modal, 'button').find((button) => button.props.class === 'result-modal-close'), 'close')
		actionProp(close.props, 'onclick')(undefined)
		expect(closed).toBe(true)
	})

	test('the failed phase shows the failure message and a Retry button wired to the handler', () => {
		let retried = false
		const onRetry = () => { retried = true }
		const modal: Vnode = ResultPendingModal(fakeH, { phase: 'failed', runLabel: null, onRetry, onClose: () => undefined })
		const message = defined(allByTag(modal, 'p').find((p) => p.props.class === 'result-modal-pending-message'), 'message')
		expect(message.children.join('')).toBe('The result could not be loaded.')
		const heading = defined(allByTag(modal, 'p').find((p) => p.props.class === 'result-modal-heading'), 'heading')
		expect(heading.children.join('')).toBe('Result')
		const retry = defined(allByTag(modal, 'button').find((button) => button.props.class === 'result-modal-retry'), 'retry')
		actionProp(retry.props, 'onclick')(undefined)
		expect(retried).toBe(true)
		const buttons = allByTag(modal, 'button')
		expect(buttons.map((button) => button.props.class)).toEqual(['result-modal-retry', 'result-modal-close'])
	})

	test('a failed phase without the retry capability renders only Close', () => {
		const modal: Vnode = ResultPendingModal(fakeH, { phase: 'failed', onClose: () => undefined })
		expect(allByTag(modal, 'button').some((button) => button.props.class === 'result-modal-retry')).toBe(false)
		expect(allByTag(modal, 'button').some((button) => button.props.class === 'result-modal-close')).toBe(true)
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
