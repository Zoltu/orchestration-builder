// The visible prior-run transcript the Compose screen shows while continuing a finished run.
//
// The server already renders the prior task as a user turn and the prior terminal result as an assistant turn in the new run's history, so this block is display-only: it never rides the submitted task text, which carries only the follow-up and `continuesFrom`. Agent and operator prose (the task, result summary, and surfaced error message) flows through the sanitized Markdown pipeline; machine fields (run id, status word, artifact paths, and the raw technical detail) stay text nodes, with the detail available only inside a collapsed technical-details disclosure. The whole card is shown without truncation — the compose screen owns the scroll — because a one-line preview would hide the context the operator is being asked to continue.

import { deriveTerminalResult, resultStatusLabel } from './result-modal.js'
import type { TerminalResult } from './result-modal.js'
import { isObject } from './guards.js'
import type { LooseH, Vnode, VnodeChildInput } from '../vendor/hyperapp.js'

type RenderMarkdown = (text: string) => VnodeChildInput

export interface ContinuationReferenceData {
	runId: string
	task: string
	result: TerminalResult
}

// Reads a prior run into the reference block's data, or null when the run cannot be shown as a continuation. A run needs its id, a recorded task field (empty is allowed and gets the fallback line), and a terminal status; a running or unknown run has no terminal result to reference. The same derivation serves both a run-list summary and a selected run view, since both carry the fields deriveTerminalResult reads.
function deriveContinuationReference(run: unknown): ContinuationReferenceData | null {
	if (!isObject(run)) return null
	const runId = run['runId']
	if (typeof runId !== 'string' || runId === '') return null
	const task = run['task']
	if (typeof task !== 'string') return null
	const result = deriveTerminalResult(run)
	if (result === undefined) return null
	return { runId, task, result }
}

// Selects the prior run to show for a clicked run id. A run-list summary can lag the per-run poll (the modal opens when the selected view is terminal while the list still says running), so a matching terminal selected view is preferred; when the view is still non-terminal or belongs to another run, the list summary stands in. Null means neither source yields a terminal descriptor and the continuation cannot start.
export function selectContinuationReference(runId: string, summaries: readonly unknown[], selectedRunView: unknown): ContinuationReferenceData | null {
	if (isObject(selectedRunView) && selectedRunView['runId'] === runId) {
		const selected = deriveContinuationReference(selectedRunView)
		if (selected !== null) return selected
	}
	for (const summary of summaries) {
		if (!isObject(summary) || summary['runId'] !== runId) continue
		return deriveContinuationReference(summary)
	}
	return null
}

interface ContinuationReferenceProps {
	continuation: ContinuationReferenceData
	renderMarkdown: RenderMarkdown
	onCancel: unknown
}

// Two visibly separated turns mirror the transcript the server injects: the prior operator task as the User turn, then the prior terminal result as the Assistant turn. The Cancel action returns the form to a plain new task.
export function ContinuationReference(h: LooseH, props: ContinuationReferenceProps): Vnode {
	const continuation = props.continuation
	const result = continuation.result
	const renderMarkdown = props.renderMarkdown

	const userTurn = h('div', { class: 'continuation-reference-turn continuation-reference-turn--user' }, [
		h('p', { class: 'continuation-reference-label' }, 'User'),
		continuation.task !== ''
			? h('div', { class: 'continuation-reference-body markdown' }, renderMarkdown(continuation.task))
			: h('p', { class: 'continuation-reference-fallback' }, '(The prior task was not recorded.)'),
	])

	const assistantChildren: Vnode[] = [
		h('p', { class: 'continuation-reference-label' }, 'Assistant'),
		h('p', { class: 'continuation-reference-status' }, resultStatusLabel(result.status)),
	]

	if (result.summary !== null) {
		assistantChildren.push(h('div', { class: 'continuation-reference-body markdown' }, renderMarkdown(result.summary)))
	}

	if (result.artifacts.length > 0) {
		assistantChildren.push(
			h('div', { class: 'continuation-reference-artifacts' }, [
				h('p', { class: 'continuation-reference-artifacts-heading' }, 'Artifacts'),
				h('ul', { class: 'continuation-reference-artifacts-list' }, result.artifacts.map((path) => h('li', { class: 'continuation-reference-artifact' }, [path]))),
			]),
		)
	}

	if (result.error !== null) {
		assistantChildren.push(h('p', { class: 'continuation-reference-label' }, 'Error'))
		assistantChildren.push(result.error.message !== null
			? h('div', { class: 'continuation-reference-body continuation-reference-error markdown' }, renderMarkdown(result.error.message))
			: h('p', { class: 'continuation-reference-fallback' }, '(No error message was recorded.)'))
	}

	if (result.detail !== undefined && result.detail !== '') {
		assistantChildren.push(
			h('details', { class: 'continuation-reference-detail' }, [
				h('summary', { class: 'continuation-reference-detail-summary' }, 'Technical details'),
				h('pre', { class: 'continuation-reference-detail-text' }, [result.detail]),
			]),
		)
	}

	if (result.summary === null && result.artifacts.length === 0 && result.error === null && (result.detail === undefined || result.detail === '')) {
		assistantChildren.push(h('p', { class: 'continuation-reference-fallback' }, 'No result summary, artifacts, or error were recorded.'))
	}

	const assistantTurn = h('div', { class: 'continuation-reference-turn continuation-reference-turn--assistant' }, assistantChildren)

	return h('section', { class: 'continuation-reference', 'aria-label': `Continuing run ${continuation.runId}` }, [
		h('div', { class: 'continuation-reference-header' }, [
			h('p', { class: 'continuation-reference-title' }, `Continuing run ${continuation.runId}`),
			h('button', { type: 'button', class: 'continuation-chip-dismiss', title: 'Discard the continuation and write a fresh task', onclick: props.onCancel }, 'Cancel'),
		]),
		h('div', { class: 'continuation-reference-turns' }, [userTurn, assistantTurn]),
	])
}
