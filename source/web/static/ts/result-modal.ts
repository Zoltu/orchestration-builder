// Per-run-view modal for a run's terminal result, and the derivation that detects one.
//
// The modal is an overlay scoped to the run view (not `document.body`-wide), mirroring the question modal: it covers the active run's flow area only, so the rest of the page stays usable while the modal is open. It renders the result summary as sanitized Markdown (via the `renderMarkdown` closure passed in, the same pipeline the product client uses), the artifacts list as plain text paths (a machine field, so they stay `textContent` and never flow through Markdown), and — on error — the raw error message as sanitized Markdown in a copyable block with honest framing, plus the error card's technical detail (a machine field) as collapsed preformatted text. The machine error `kind` is intentionally not surfaced to the user (it is an internal taxonomy a non-developer cannot act on); the "copy raw" button copies the full error object as JSON so the operator can hand it to support. The framing copy is fixed trusted text, not agent prose. See docs/security.md "Web client rendering pipeline".
//
// `h` and `renderMarkdown` are passed in rather than imported so the component stays free of hyperapp and showdown coupling and is exercisable in tests with fakes (mirroring question-modal.js and the run-stage views). The close and copy-raw handlers are supplied by the caller: in the demo harness `onClose` clears the modal-open flag and `onCopyRaw` writes the JSON to the clipboard; in the product client `onClose` will clear the flag and `onCopyRaw` will POST or clipboard the raw object. The optional `onContinue` and `onResume` affordances are supplied the same way; Continue applies to every terminal outcome, while Resume applies only to a resumable error. The demo harness omits both.

import { isSuspendedStatus, isTerminalStatus } from './interaction-model.js'
import { isObject } from './guards.js'
import { LoadingIndicator } from './loading-indicator.js'
import type { LooseH, Vnode, VnodeChildInput } from '../vendor/hyperapp.js'

// The sanitized-Markdown renderer the component receives: the createMarkdownRenderer product in the hosts — generic over the host's vnode product, an array of host vnodes and strings, which is children input exactly as `LooseH` accepts it wherever the host's `h` builds the exchange shape — or a single-vnode fake in the tests.
type RenderMarkdown = (text: string) => VnodeChildInput

// The terminal-status descriptor for a run: the run's terminal status, the result card's summary and artifacts, and — on error and interrupted statuses — the error block, whose human `message` is what renders and whose opaque `raw` is what the copy-raw button hands over.
export interface TerminalResultError {
	message: string | null
	raw: unknown
}

export interface TerminalResult {
	status: string
	summary: string | null
	artifacts: string[]
	error: TerminalResultError | null
	// The result card's technical detail (the raw failure payload behind the message, e.g. the LLM endpoint's error-response body), present only when the card carried one. Rendered as collapsed preformatted text and merged into the copy-raw payload.
	detail?: string
	// Whether the run can be explicitly resumed from its kept checkpoint (carried from the run view's `resumable` field, only ever true on an error outcome). The demo harness's hand-built descriptors omit it, which reads as not resumable.
	resumable?: boolean
}

// The terminal-status descriptor for a run, or undefined when the run is not yet terminal. A run is terminal when its status is `success`, `error`, `needs_clarification`, or `interrupted`. The summary and artifacts come from the run's `result` card (the executor's summary of what it did and what it produced); the error block is derived on `error` and `interrupted` statuses, from the run-level `error` first (the executor's surfaced failure — for `interrupted`, the reconciliation's record of why the run could not resume) and falling back to the result card's nested error. The error `kind` is carried on the descriptor's `error.raw` for the copy-raw button but is never rendered as text — only the human `message` is shown, as sanitized Markdown. The `resumable` flag copies the run view's field onto error outcomes only, so the modal's Resume gating reads the descriptor alone.
export function deriveTerminalResult(runView: unknown): TerminalResult | undefined {
	if (!isObject(runView)) return undefined
	const status = runView['status']
	if (typeof status !== 'string' || isSuspendedStatus(status)) return undefined
	if (!isTerminalStatus(status)) return undefined

	const result = isObject(runView['result']) ? runView['result'] : null
	const runError = isObject(runView['error']) ? runView['error'] : null

	const summary = result !== null && typeof result['summary'] === 'string' && result['summary'] !== ''
		? result['summary']
		: null

	const rawArtifacts = result !== null ? result['artifacts'] : undefined
	const artifacts = Array.isArray(rawArtifacts)
		? rawArtifacts.filter((path: unknown): path is string => typeof path === 'string' && path !== '')
		: []

	// The error block is derived only on error and interrupted statuses. Built as a standalone value and assigned in the descriptor literal so the property type is the union (object | null) rather than collapsing to null. The card's technical detail is error-surface data like the error block itself, so it is picked up under the same gate and never surfaces on a success or needs-clarification run.
	let error: TerminalResultError | null = null
	let detail: string | undefined
	if (status === 'error' || status === 'interrupted') {
		const rawError = runError ?? (isObject(result?.['error']) ? result['error'] : null)
		const message = typeof rawError?.['message'] === 'string' && rawError['message'] !== ''
			? rawError['message']
			: null
		const rawDetail = result !== null ? result['detail'] : undefined
		if (typeof rawDetail === 'string' && rawDetail !== '') detail = rawDetail
		error = { message, raw: rawError }
	}
	// The resume flag copies the run view's `resumable` (terminal error meta plus a checkpoint on disk) but only onto an error outcome, so the descriptor's own shape keeps the resume gating honest even for a malformed body that carries the flag on another status.
	return { status, summary, artifacts, error, resumable: status === 'error' && runView['resumable'] === true, ...(detail !== undefined ? { detail } : {}) }
}

// The honest framing line shown above the raw error message. Fixed trusted text (not agent prose, so it never flows through Markdown): it tells the operator the system reported a failure and the copy-raw button exists for sharing, without translating the failure into reassurance.
const ERROR_FRAMING = 'Something went wrong — here\u2019s what the system reported; copy this to share with support or your own assistant.'

export interface ResultModalProps {
	descriptor: TerminalResult
	runLabel?: string | null
	// The run id stamped on the recovery buttons' data-run-id attribute. The product host passes the viewed run's id explicitly; when absent (the demo harness and older callers), the run label stands in.
	runId?: string | null
	renderMarkdown: RenderMarkdown
	onCopyRaw?: (rawJson: string) => void
	onClose: unknown
	// Optional Continue affordance for any terminal run: when supplied (a hyperapp click action, like onClose), the modal renders a Continue button that invokes it. A resumable error renders both Resume and Continue, with Resume first. The action reads the run id off the button's data-run-id attribute — the same contract the history row's Continue button uses — so the host can wire the very same continuation hand-off. The demo harness omits the prop, so its modals keep only Close.
	onContinue?: unknown
	// Optional Resume affordance for a resumable error: when supplied AND the descriptor is a resumable error, the modal renders a Resume button that restarts the run in place from its full checkpointed context. It is independent of Continue, which remains the briefed fallback whether or not a checkpoint exists. Same action contract as onContinue: a hyperapp click action reading the run id off the button's data-run-id attribute. The demo harness omits the prop.
	onResume?: unknown
	// When true, both recovery affordances render disabled with `recoveryDisabledReason` as their title: the host uses this while another run is genuinely active or a create/resume submission is in flight. Close stays enabled so the modal can always be dismissed.
	recoveryDisabled?: boolean
	recoveryDisabledReason?: string
	// Optional technical meta line ({ text, title }) for advanced users — the product client derives it from the run view; the demo harness passes none. Rendered as muted microcopy, all textContent.
	metaLine?: { text?: unknown; title?: unknown } | null
}

// The modal overlay: a backdrop over the run view plus a centered card carrying the status, the result summary, the artifacts, and — on error — the raw error block with a copy-raw button. The card names which run the result belongs to (`runLabel`). The status sets the card's accent border (accent for success/needs-clarification, error red for failure) so the outcome reads at a glance. The close button and the copy-raw button are caller-supplied so the component is exercisable in tests with fakes.
export function ResultModal(h: LooseH, props: ResultModalProps): Vnode {
	const descriptor = props.descriptor
	const runLabel = props.runLabel
	const runId = props.runId ?? runLabel
	const renderMarkdown = props.renderMarkdown
	const onCopyRaw = props.onCopyRaw
	const onClose = props.onClose
	const onContinue = props.onContinue
	const onResume = props.onResume
	const recoveryDisabled = props.recoveryDisabled === true
	const recoveryDisabledReason = typeof props.recoveryDisabledReason === 'string' ? props.recoveryDisabledReason : ''
	const metaLine = props.metaLine

	const status = descriptor.status
	const summary = descriptor.summary
	const artifacts = descriptor.artifacts
	const error = descriptor.error
	const detail = descriptor.detail
	const resumable = descriptor.resumable === true

	const cardClass = status === 'error' || status === 'interrupted' ? 'result-modal-card result-modal-card--error' : 'result-modal-card'

	const children: Vnode[] = [
		h('p', { class: 'result-modal-heading' }, runLabel !== null && runLabel !== undefined && runLabel !== ''
			? `Result \u00b7 ${runLabel}`
			: 'Result'),
		h('p', { class: `result-modal-status result-modal-status--${status}` }, resultStatusLabel(status)),
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
		// The error block: honest framing, the sanitized message, the collapsed technical-details block when the card carries the raw payload, and a copy-raw button that hands the full error object (including the hidden `kind`) to the caller as JSON. The `kind` is deliberately not rendered as text; it surfaces only through copy-raw so a non-developer is not asked to interpret the machine taxonomy. The copy button's onclick is a closure that invokes the injected `onCopyRaw` leaf with the precomputed JSON and returns the state unchanged — hyperapp actions must return state, and a leaf that returns `undefined` would corrupt the app state, so the component wraps the leaf rather than passing it bare.
		const errorChildren: Vnode[] = [h('p', { class: 'result-modal-error-framing' }, ERROR_FRAMING)]
		if (error.message !== null) {
			errorChildren.push(h('div', { class: 'result-modal-error-message markdown' }, renderMarkdown(error.message)))
		}
		if (typeof detail === 'string' && detail !== '') {
			// The raw failure payload behind the message (e.g. the endpoint's error-response body): collapsed by default, rendered as preformatted text. A machine field, so it stays textContent and never flows through Markdown.
			errorChildren.push(
				h('details', { class: 'result-modal-error-detail' }, [
					h('summary', { class: 'result-modal-error-detail-summary' }, 'Technical details'),
					h('pre', { class: 'result-modal-error-detail-text' }, [detail]),
				]),
			)
		}
		if (error.raw !== null && onCopyRaw !== undefined) {
			const rawJson = errorToRawJson(error.raw, typeof detail === 'string' && detail !== '' ? detail : undefined)
			errorChildren.push(
				h('div', { class: 'result-modal-error-actions' }, [
					h('button', { type: 'button', class: 'result-modal-copy', onclick: (state: unknown) => { onCopyRaw(rawJson); return state } }, 'Copy raw'),
				]),
			)
		}
		children.push(h('div', { class: 'result-modal-error' }, errorChildren))
	}

	// The action row: Resume (a resumable error with the capability), then Continue (any terminal outcome with the capability), then Close. Continue is independent of resume: a run with a checkpoint offers in-place resume first and the briefed continuation beside it. Both stamp the run id the same way the history row's Continue button does (data-run-id), so the injected actions are the very same logic reading the same attribute. The host disables both recovery buttons while another run is genuinely active or a submission is in flight, leaving Close usable.
	const actions: Vnode[] = []
	if (status === 'error' && resumable && onResume !== undefined) {
		actions.push(h('button', { type: 'button', class: 'result-modal-resume', 'data-run-id': typeof runId === 'string' ? runId : '', disabled: recoveryDisabled, title: recoveryDisabled ? recoveryDisabledReason : '', onclick: onResume }, 'Resume'))
	}
	if (onContinue !== undefined) {
		actions.push(h('button', { type: 'button', class: 'result-modal-continue', 'data-run-id': typeof runId === 'string' ? runId : '', disabled: recoveryDisabled, title: recoveryDisabled ? recoveryDisabledReason : '', onclick: onContinue }, 'Continue'))
	}
	actions.push(h('button', { type: 'button', class: 'result-modal-close', onclick: onClose }, 'Close'))
	children.push(h('div', { class: 'result-modal-actions' }, actions))

	return h('div', { class: 'result-modal-overlay' }, [
		h('div', { class: 'result-modal-backdrop', onclick: onClose }),
		h('div', { class: cardClass }, children),
	])
}

// The pending card shown while the full run view is still arriving (or after it failed): the polled summary already has a result, so the CTA opens at once and this card explains the wait instead of doing nothing. Retry is offered only after a failed load.
export interface ResultPendingModalProps {
	phase: 'loading' | 'failed'
	runLabel?: string | null
	onRetry?: unknown
	onClose: unknown
}

export function ResultPendingModal(h: LooseH, props: ResultPendingModalProps): Vnode {
	const failed = props.phase === 'failed'
	const runLabel = props.runLabel
	const actions: Vnode[] = []
	if (failed && props.onRetry !== undefined) {
		actions.push(h('button', { type: 'button', class: 'result-modal-retry', onclick: props.onRetry }, 'Retry'))
	}
	actions.push(h('button', { type: 'button', class: 'result-modal-close', onclick: props.onClose }, 'Close'))
	return h('div', { class: 'result-modal-overlay' }, [
		h('div', { class: 'result-modal-backdrop', onclick: props.onClose }),
		h('div', { class: 'result-modal-card result-modal-card--pending' }, [
			h('p', { class: 'result-modal-heading' }, runLabel !== null && runLabel !== undefined && runLabel !== ''
				? `Result \u00b7 ${runLabel}`
				: 'Result'),
			failed
				? h('p', { class: 'result-modal-pending-message' }, 'The result could not be loaded.')
				: h('div', { class: 'result-modal-pending-message' }, [LoadingIndicator(h, 'Loading the result\u2026')]),
			h('div', { class: 'result-modal-pending-actions' }, actions),
		]),
	])
}

// The human status word for a terminal run, shared by the result modal and the continuation reference block so the two surfaces name an outcome identically.
export function resultStatusLabel(status: string): string {
	if (status === 'success') return 'Completed successfully'
	if (status === 'error') return 'Completed with an error'
	if (status === 'interrupted') return 'Interrupted'
	return 'Needs clarification'
}

// Serializes the full error object (kind, message, and any details) to JSON for the copy-raw button, with the descriptor's technical detail (the raw failure payload behind the message) merged in when present, so what reaches the clipboard includes the body a support reader needs. Computed once at render so the button's onclick payload is stable and the caller's handler receives the exact string that will reach the clipboard. A non-serializable object falls back to a minimal envelope so the button never throws.
function errorToRawJson(rawError: unknown, detail: string | undefined): string {
	try {
		if (detail === undefined) return JSON.stringify(rawError)
		return JSON.stringify(isObject(rawError) ? { ...rawError, detail } : { detail })
	} catch {
		return JSON.stringify({ message: isObject(rawError) && typeof rawError['message'] === 'string' ? rawError['message'] : '' })
	}
}
