import { describe, expect, test } from 'bun:test'
import { ContinuationReference, selectContinuationReference } from './static/ts/continuation-reference.js'
import { actionProp, defined, present } from './test-fixtures.js'

// The continuation-reference component is browser-pure TS and receives `h`/`renderMarkdown` as props, so these fakes exercise it without a DOM, mirroring result-modal.test.ts.

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

function allByTag(vnode: Vnode, tag: string): Vnode[] {
	const found: Vnode[] = []
	for (const child of vnode.children) {
		if (!isVnode(child)) continue
		if (child.tag === tag) found.push(child)
		for (const grand of allByTag(child, tag)) found.push(grand)
	}
	return found
}

function fakeRenderMarkdown(text: string): Vnode {
	return { tag: 'span', props: { class: 'md-marker', 'data-text': text }, children: [text] }
}

function collectText(vnode: Vnode): string {
	let out = ''
	for (const child of vnode.children) {
		if (typeof child === 'string') out += child
		else out += collectText(child)
	}
	return out
}

function markdownTexts(vnode: Vnode): string[] {
	const texts: string[] = []
	for (const marker of allByTag(vnode, 'span')) {
		if (marker.props.class !== 'md-marker') continue
		const text = marker.props['data-text']
		if (typeof text === 'string') texts.push(text)
	}
	return texts
}

function usesInnerHtml(vnode: Vnode): boolean {
	if (Object.prototype.hasOwnProperty.call(vnode.props, 'innerHTML')) return true
	return vnode.children.some((child) => isVnode(child) && usesInnerHtml(child))
}

const terminalContinuation = {
	runId: 'run-42',
	task: 'Add the CSV export.\nKeep the existing report format.',
	result: {
		status: 'error',
		summary: 'The run could not reach the model.',
		artifacts: ['reports/csv.ts', 'docs/export.md'],
		error: { message: 'The model endpoint refused the connection.', raw: { kind: 'llm_unavailable' } },
		detail: '{"error":"Insufficient credit"}',
	},
}

describe('selectContinuationReference', () => {
	test('returns null for malformed runs and runs without a usable id or task', () => {
		expect(selectContinuationReference('run-1', [], null)).toBeNull()
		expect(selectContinuationReference('run-1', [], undefined)).toBeNull()
		expect(selectContinuationReference('run-1', ['run-1'], null)).toBeNull()
		expect(selectContinuationReference('run-1', [{ status: 'success', task: 'done', result: { summary: 'done' } }], null)).toBeNull()
		expect(selectContinuationReference('', [{ runId: '', status: 'success', task: 'done' }], null)).toBeNull()
		expect(selectContinuationReference('run-1', [{ runId: 'run-1', status: 'success', task: null }], null)).toBeNull()
	})

	test('returns null for non-terminal and unknown runs', () => {
		expect(selectContinuationReference('run-1', [{ runId: 'run-1', status: 'running', task: 'working' }], null)).toBeNull()
		expect(selectContinuationReference('run-1', [{ runId: 'run-1', status: 'unknown', task: 'working' }], null)).toBeNull()
		expect(selectContinuationReference('run-1', [{ runId: 'run-1', task: 'working' }], null)).toBeNull()
	})

	test('derives the run id, full task, and success descriptor', () => {
		const run = {
			status: 'success',
			runId: 'run-1',
			task: 'Add the CSV export.\nKeep the report format.',
			result: { status: 'success', summary: 'Added the CSV export.', artifacts: ['reports/csv.ts'] },
		}
		const continuation = present(selectContinuationReference('run-1', [run], null), 'continuation')
		expect(continuation.runId).toBe('run-1')
		expect(continuation.task).toBe(run.task)
		expect(continuation.result.status).toBe('success')
		expect(continuation.result.summary).toBe('Added the CSV export.')
		expect(continuation.result.artifacts).toEqual(['reports/csv.ts'])
		expect(continuation.result.error).toBeNull()
	})

	test('falls back to the run-level error on an error outcome', () => {
		const run = {
			status: 'error',
			runId: 'run-2',
			task: 'Fix the exporter.',
			error: { kind: 'llm_unavailable', message: 'connection refused' },
		}
		const continuation = present(selectContinuationReference('run-2', [run], null), 'continuation')
		expect(continuation.result.status).toBe('error')
		expect(present(continuation.result.error, 'continuation.result.error').message).toBe('connection refused')
	})

	test('derives interrupted and needs_clarification outcomes', () => {
		const interrupted = present(selectContinuationReference('run-3', [{
			status: 'interrupted',
			runId: 'run-3',
			task: 'Investigate the timeout.',
			error: { kind: 'interrupted', message: 'The service restarted.' },
		}], null), 'interrupted')
		expect(interrupted.result.status).toBe('interrupted')
		expect(present(interrupted.result.error, 'interrupted.result.error').message).toBe('The service restarted.')

		const clarification = present(selectContinuationReference('run-4', [{
			status: 'needs_clarification',
			runId: 'run-4',
			task: 'Choose a format.',
			result: { status: 'needs_clarification', summary: 'Needs your input.' },
		}], null), 'clarification')
		expect(clarification.result.status).toBe('needs_clarification')
		expect(clarification.result.summary).toBe('Needs your input.')
	})

	test('prefers a terminal selected view over a stale running summary for the same run', () => {
		const summaries = [{ runId: 'run-1', status: 'running', task: 'Add the export.' }]
		const selectedView = {
			runId: 'run-1',
			status: 'success',
			task: 'Add the export.',
			result: { status: 'success', summary: 'Added the export.' },
		}
		const continuation = present(selectContinuationReference('run-1', summaries, selectedView), 'continuation')
		expect(continuation.result.status).toBe('success')
		expect(continuation.result.summary).toBe('Added the export.')
	})

	test('falls back to the clicked run summary when the selected view is terminal for a different run', () => {
		const summaries = [{
			runId: 'run-2',
			status: 'success',
			task: 'Fix the export.',
			result: { status: 'success', summary: 'Fixed the export.' },
		}]
		const selectedView = {
			runId: 'run-9',
			status: 'success',
			task: 'A different run.',
			result: { status: 'success', summary: 'Different run result.' },
		}
		const continuation = present(selectContinuationReference('run-2', summaries, selectedView), 'continuation')
		expect(continuation.runId).toBe('run-2')
		expect(continuation.result.summary).toBe('Fixed the export.')
	})

	test('uses the run-list summary when the selected view is still non-terminal for the same run', () => {
		const summaries = [{
			runId: 'run-2',
			status: 'success',
			task: 'Fix the export.',
			result: { status: 'success', summary: 'Fixed the export.' },
		}]
		const selectedView = { runId: 'run-2', status: 'running', task: 'Fix the export.' }
		const continuation = present(selectContinuationReference('run-2', summaries, selectedView), 'continuation')
		expect(continuation.result.status).toBe('success')
		expect(continuation.result.summary).toBe('Fixed the export.')
	})

	test('returns null when neither source yields a terminal descriptor', () => {
		const summaries = [{ runId: 'run-3', status: 'running', task: 'Still working.' }]
		const selectedView = { runId: 'run-3', status: 'running', task: 'Still working.' }
		expect(selectContinuationReference('run-3', summaries, selectedView)).toBeNull()
		expect(selectContinuationReference('run-4', summaries, selectedView)).toBeNull()
	})
})

describe('ContinuationReference', () => {
	test('renders the run id as text and the full multi-line task through renderMarkdown', () => {
		const view: Vnode = ContinuationReference(fakeH, { continuation: terminalContinuation, renderMarkdown: fakeRenderMarkdown, onCancel: () => undefined })
		expect(view.tag).toBe('section')
		expect(view.props.class).toBe('continuation-reference')
		expect(view.props['aria-label']).toBe('Continuing run run-42')
		const title = defined(allByTag(view, 'p').find((p) => p.props.class === 'continuation-reference-title'), 'title')
		expect(title.children.join('')).toBe('Continuing run run-42')

		const userTurn = defined(allByTag(view, 'div').find((d) => d.props.class === 'continuation-reference-turn continuation-reference-turn--user'), 'userTurn')
		const userBody = defined(byTag(userTurn, 'div').find((d) => d.props.class === 'continuation-reference-body markdown'), 'userBody')
		const marker = defined(byTag(userBody, 'span')[0], 'userMarker')
		// The whole task reaches the Markdown pipeline; no first-line truncation or ellipsis.
		expect(marker.props['data-text']).toBe('Add the CSV export.\nKeep the existing report format.')
	})

	test('renders the assistant status, labels, summary, artifacts, error, and collapsed detail in their proper channels', () => {
		const view: Vnode = ContinuationReference(fakeH, { continuation: terminalContinuation, renderMarkdown: fakeRenderMarkdown, onCancel: () => undefined })
		const assistantTurn = defined(allByTag(view, 'div').find((d) => d.props.class === 'continuation-reference-turn continuation-reference-turn--assistant'), 'assistantTurn')
		const status = defined(byTag(assistantTurn, 'p').find((p) => p.props.class === 'continuation-reference-status'), 'status')
		expect(status.children.join('')).toBe('Completed with an error')

		// Error and Artifacts carry visible labels alongside the User/Assistant turn labels.
		const labels = byTag(assistantTurn, 'p').filter((p) => p.props.class === 'continuation-reference-label').map(collectText)
		expect(labels).toContain('Error')
		const artifactsHeading = defined(allByTag(assistantTurn, 'p').find((p) => p.props.class === 'continuation-reference-artifacts-heading'), 'artifactsHeading')
		expect(artifactsHeading.children.join('')).toBe('Artifacts')

		// Summary and error message are agent prose and flow through Markdown; artifacts and detail never do.
		expect(markdownTexts(assistantTurn)).toEqual(['The run could not reach the model.', 'The model endpoint refused the connection.'])

		const list = defined(allByTag(assistantTurn, 'ul').find((u) => u.props.class === 'continuation-reference-artifacts-list'), 'artifactList')
		const items = byTag(list, 'li')
		expect(items.length).toBe(2)
		expect(defined(items[0], 'items[0]').children.join('')).toBe('reports/csv.ts')
		expect(defined(items[1], 'items[1]').children.join('')).toBe('docs/export.md')
		expect(markdownTexts(list)).toEqual([])

		const details = defined(allByTag(assistantTurn, 'details').find((d) => d.props.class === 'continuation-reference-detail'), 'details')
		// Collapsed by default: no open attribute.
		expect(details.props['open']).toBeUndefined()
		const detailSummary = defined(byTag(details, 'summary')[0], 'detailSummary')
		expect(detailSummary.children.join('')).toBe('Technical details')
		const detailText = defined(byTag(details, 'pre')[0], 'detailText')
		expect(detailText.props.class).toBe('continuation-reference-detail-text')
		expect(detailText.children.join('')).toBe('{"error":"Insufficient credit"}')
		expect(markdownTexts(details)).toEqual([])
	})

	test('an error with no recorded message says so instead of using the generic empty-result fallback', () => {
		const noMessage = {
			runId: 'run-7',
			task: 'Try the export.',
			result: { status: 'error', summary: null, artifacts: [], error: { message: null, raw: null } },
		}
		const view: Vnode = ContinuationReference(fakeH, { continuation: noMessage, renderMarkdown: fakeRenderMarkdown, onCancel: () => undefined })
		const assistantTurn = defined(allByTag(view, 'div').find((d) => d.props.class === 'continuation-reference-turn continuation-reference-turn--assistant'), 'assistantTurn')
		expect(byTag(assistantTurn, 'p').some((p) => p.props.class === 'continuation-reference-label' && p.children.join('') === 'Error')).toBe(true)
		const fallbacks = allByTag(view, 'p').filter((p) => p.props.class === 'continuation-reference-fallback').map(collectText)
		expect(fallbacks).toEqual(['(No error message was recorded.)'])
		expect(markdownTexts(assistantTurn)).toEqual([])
	})

	test('an interrupted run with no result card still renders its status and error', () => {
		const interrupted = {
			runId: 'run-5',
			task: 'Investigate the timeout.',
			result: { status: 'interrupted', summary: null, artifacts: [], error: { message: 'The service restarted.', raw: null } },
		}
		const view: Vnode = ContinuationReference(fakeH, { continuation: interrupted, renderMarkdown: fakeRenderMarkdown, onCancel: () => undefined })
		const status = defined(allByTag(view, 'p').find((p) => p.props.class === 'continuation-reference-status'), 'status')
		expect(status.children.join('')).toBe('Interrupted')
		expect(markdownTexts(view)).toContain('The service restarted.')
		// A surfaced error means the empty-result fallback does not appear.
		expect(allByTag(view, 'p').some((p) => p.props.class === 'continuation-reference-fallback')).toBe(false)
	})

	test('an empty result renders the fallback line and an unrecovered task gets its own fallback', () => {
		const empty = {
			runId: 'run-6',
			task: '',
			result: { status: 'success', summary: null, artifacts: [], error: null },
		}
		const view: Vnode = ContinuationReference(fakeH, { continuation: empty, renderMarkdown: fakeRenderMarkdown, onCancel: () => undefined })
		const fallbacks = allByTag(view, 'p').filter((p) => p.props.class === 'continuation-reference-fallback')
		expect(fallbacks.length).toBe(2)
		expect(collectText(defined(fallbacks[0], 'fallbacks[0]'))).toBe('(The prior task was not recorded.)')
		expect(collectText(defined(fallbacks[1], 'fallbacks[1]'))).toBe('No result summary, artifacts, or error were recorded.')
		expect(markdownTexts(view)).toEqual([])
	})

	test('the Cancel button invokes the supplied action', () => {
		let cancelled = false
		const onCancel = () => { cancelled = true }
		const view: Vnode = ContinuationReference(fakeH, { continuation: terminalContinuation, renderMarkdown: fakeRenderMarkdown, onCancel })
		const header = defined(allByTag(view, 'div').find((d) => d.props.class === 'continuation-reference-header'), 'header')
		const cancel = defined(byTag(header, 'button')[0], 'cancel')
		expect(cancel.props.type).toBe('button')
		expect(cancel.props.class).toBe('continuation-chip-dismiss')
		expect(cancel.props.title).toBe('Discard the continuation and write a fresh task')
		expect(cancel.props.onclick).toBe(onCancel)
		actionProp(cancel.props, 'onclick')(undefined)
		expect(cancelled).toBe(true)
	})

	test('renders no content through raw HTML', () => {
		const view: Vnode = ContinuationReference(fakeH, { continuation: terminalContinuation, renderMarkdown: fakeRenderMarkdown, onCancel: () => undefined })
		expect(usesInnerHtml(view)).toBe(false)
	})
})
