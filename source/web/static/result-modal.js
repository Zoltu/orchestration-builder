// Per-run-view modal for a run's terminal result, and the derivation that detects one.
//
// The modal is an overlay scoped to the run view (not `document.body`-wide), mirroring the question modal: it covers the active run's flow area only, so the rest of the page stays usable while the modal is open. It renders the result summary as sanitized Markdown (via the `renderMarkdown` closure passed in, the same pipeline the product client uses), the artifacts list as plain text paths (a machine field, so they stay `textContent` and never flow through Markdown), and — on error — the raw error message as sanitized Markdown in a copyable block with honest framing. The machine error `kind` is intentionally not surfaced to the user (it is an internal taxonomy a non-developer cannot act on); the "copy raw" button copies the full error object as JSON so the operator can hand it to support. The framing copy is fixed trusted text, not agent prose. See docs/security.md "Web client rendering pipeline".
//
// `h` and `renderMarkdown` are passed in rather than imported so the component stays free of hyperapp and showdown coupling and is exercisable in tests with fakes (mirroring question-modal.js and flow-view.js). The close and copy-raw handlers are supplied by the caller: in the demo harness `onClose` clears the modal-open flag and `onCopyRaw` writes the JSON to the clipboard; in the product client `onClose` will clear the flag and `onCopyRaw` will POST or clipboard the raw object.

import { isTerminalStatus } from './interaction-model.js'
import { isObject } from './guards.js'

// The terminal-status descriptor for a run, or undefined when the run is not yet terminal. A run is terminal when its status is `success`, `error`, `needs_clarification`, or `interrupted`. The summary and artifacts come from the run's `result` card (the executor's summary of what it did and what it produced); the error block is derived on `error` and `interrupted` statuses, from the run-level `error` first (the executor's surfaced failure — for `interrupted`, the reconciliation's record of why the run could not resume) and falling back to the result card's nested error. The error `kind` is carried on the descriptor's `error.raw` for the copy-raw button but is never rendered as text — only the human `message` is shown, as sanitized Markdown.
export function deriveTerminalResult(runView) {
	if (typeof runView !== 'object' || runView === null) return undefined
	const status = runView.status
	if (typeof status !== 'string' || !isTerminalStatus(status)) return undefined

	const result = isObject(runView.result) ? runView.result : null
	const runError = isObject(runView.error) ? runView.error : null

	const summary = result !== null && typeof result.summary === 'string' && result.summary !== ''
		? result.summary
		: null

	const artifacts = Array.isArray(result?.artifacts)
		? result.artifacts.filter((path) => typeof path === 'string' && path !== '')
		: []

	// The error block is derived only on error and interrupted statuses. Built as a standalone value and assigned in the descriptor literal so the inferred property type is the union (object | null) rather than collapsing to null.
	let error = null
	if (status === 'error' || status === 'interrupted') {
		const rawError = runError ?? (isObject(result?.error) ? result.error : null)
		const message = typeof rawError?.message === 'string' && rawError.message !== ''
			? rawError.message
			: null
		error = { message, raw: rawError }
	}
	return { status, summary, artifacts, error }
}

// The honest framing line shown above the raw error message. Fixed trusted text (not agent prose, so it never flows through Markdown): it tells the operator the system reported a failure and the copy-raw button exists for sharing, without translating the failure into reassurance.
const ERROR_FRAMING = 'Something went wrong — here\u2019s what the system reported; copy this to share with support or your own assistant.'

// The modal overlay: a backdrop over the run view plus a centered card carrying the status, the result summary, the artifacts, and — on error — the raw error block with a copy-raw button. The card names which run the result belongs to (`runLabel`). The status sets the card's accent border (accent for success/needs-clarification, error red for failure) so the outcome reads at a glance. The close button and the copy-raw button are caller-supplied so the component is exercisable in tests with fakes.
export function ResultModal(h, props) {
	const descriptor = props.descriptor
	const runLabel = props.runLabel
	const renderMarkdown = props.renderMarkdown
	const onCopyRaw = props.onCopyRaw
	const onClose = props.onClose
	// Optional technical meta line ({ text, title }) for advanced users — the product client derives it from the run view; the demo harness passes none. Rendered as muted microcopy, all textContent.
	const metaLine = props.metaLine

	const status = descriptor.status
	const summary = descriptor.summary
	const artifacts = descriptor.artifacts
	const error = descriptor.error

	const cardClass = status === 'error' || status === 'interrupted' ? 'result-modal-card result-modal-card--error' : 'result-modal-card'

	const children = [
		h('p', { class: 'result-modal-heading' }, runLabel !== null && runLabel !== undefined && runLabel !== ''
			? `Result \u00b7 ${runLabel}`
			: 'Result'),
		h('p', { class: `result-modal-status result-modal-status--${status}` }, statusLabel(status)),
	]

	if (metaLine !== null && metaLine !== undefined && typeof metaLine.text === 'string') {
		children.push(h('p', { class: 'result-modal-meta', title: typeof metaLine.title === 'string' ? metaLine.title : '' }, metaLine.text))
	}

	if (summary !== null) {
		children.push(h('div', { class: 'result-modal-summary markdown' }, renderMarkdown(summary)))
	}

	if (artifacts.length > 0) {
		children.push(
			h('div', { class: 'result-modal-artifacts' }, [
				h('p', { class: 'result-modal-artifacts-heading' }, 'Artifacts'),
				h('ul', { class: 'result-modal-artifacts-list' }, artifacts.map((path) => h('li', { class: 'result-modal-artifact' }, [path]))),
			]),
		)
	}

	if (error !== null) {
		// The error block: honest framing, the sanitized message, and a copy-raw button that hands the full error object (including the hidden `kind`) to the caller as JSON. The `kind` is deliberately not rendered as text; it surfaces only through copy-raw so a non-developer is not asked to interpret the machine taxonomy. The copy button's onclick is a closure that invokes the injected `onCopyRaw` leaf with the precomputed JSON and returns the state unchanged — hyperapp actions must return state, and a leaf that returns `undefined` would corrupt the app state, so the component wraps the leaf rather than passing it bare.
		const errorChildren = [h('p', { class: 'result-modal-error-framing' }, ERROR_FRAMING)]
		if (error.message !== null) {
			errorChildren.push(h('div', { class: 'result-modal-error-message markdown' }, renderMarkdown(error.message)))
		}
		if (error.raw !== null && onCopyRaw !== undefined) {
			const rawJson = errorToRawJson(error.raw)
			errorChildren.push(
				h('div', { class: 'result-modal-error-actions' }, [
					h('button', { type: 'button', class: 'result-modal-copy', onclick: (state) => { onCopyRaw(rawJson); return state } }, 'Copy raw'),
				]),
			)
		}
		children.push(h('div', { class: 'result-modal-error' }, errorChildren))
	}

	children.push(
		h('div', { class: 'result-modal-actions' }, [
			h('button', { type: 'button', class: 'result-modal-close', onclick: onClose }, 'Close'),
		]),
	)

	return h('div', { class: 'result-modal-overlay' }, [
		h('div', { class: 'result-modal-backdrop', onclick: onClose }),
		h('div', { class: cardClass }, children),
	])
}

function statusLabel(status) {
	if (status === 'success') return 'Completed successfully'
	if (status === 'error') return 'Completed with an error'
	if (status === 'interrupted') return 'Interrupted'
	return 'Needs clarification'
}

// Serializes the full error object (kind, message, and any details) to JSON for the copy-raw button. Computed once at render so the button's onclick payload is stable and the caller's handler receives the exact string that will reach the clipboard. A non-serializable object falls back to a minimal envelope so the button never throws.
function errorToRawJson(rawError) {
	try {
		return JSON.stringify(rawError)
	} catch {
		return JSON.stringify({ message: typeof rawError?.message === 'string' ? rawError.message : '' })
	}
}
