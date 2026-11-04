// The pause card for a suspended run: a separate, non-error surface from the terminal result modal. It shows fixed category copy, the pause time, and the resume/terminate actions, plus an on-demand "Technical details" disclosure whose raw provider text is rendered only as preformatted text nodes.

import { isObject } from './guards.js'
import { isSuspendedStatus } from './interaction-model.js'
import type { SuspensionCategory, SuspensionRecord } from './interaction-model.js'
import { isSuspensionRecord } from './run-list-feed/index.js'
import { isOperatorPauseRecord } from './run-pause.js'
import { diagnosticsCopyJson } from './run-diagnostics.js'
import type { RunDiagnostics, SuspendedDiagnosticsLoad } from './run-diagnostics.js'
import type { LooseH, Vnode } from '../vendor/hyperapp.js'

export type { SuspendedDiagnosticsLoad } from './run-diagnostics.js'

export type SuspendedCardKind = 'operator' | 'provider'

export interface SuspendedCardDescriptor {
	status: 'suspended'
	kind: SuspendedCardKind
	category: SuspensionCategory | null
	resumePolicy: 'auto' | 'operator'
	suspendedAt: string
	resumable: boolean
	cause: string
}

const OPERATOR_PAUSE_COPY = 'This run is paused by the operator. The model is idle; resume when you are ready.'

const CATEGORY_COPY: Record<SuspensionCategory, string> = {
	billing: 'The model provider needs credit. Top up the account, then resume this run.',
	auth: 'The model provider rejected the deployment\u2019s credentials. Fix the deployment and restart, then resume this run.',
	transient: 'The model provider is temporarily unavailable. This run can resume when the provider is healthy again.',
	request_rejected: 'The model endpoint rejected the request. Resume after fixing the deployment.',
	novel: 'The model provider returned an unexpected failure. The run is retried briefly, then waits for an operator.',
	unknown: 'The model provider returned an unexpected failure. Resume when the provider is healthy.',
}

function suspensionCauseCopy(category: SuspensionCategory): string {
	return CATEGORY_COPY[category]
}

function categoryOf(value: unknown): SuspensionCategory {
	if (!isObject(value)) return 'unknown'
	const category = value['category']
	if (category === 'transient' || category === 'billing' || category === 'auth' || category === 'request_rejected' || category === 'novel' || category === 'unknown') return category
	return 'unknown'
}

// Builds the pause descriptor from a run view or a run summary. A non-suspended status, or a body with neither a pause nor a suspension record, yields undefined so the result-modal path keeps exclusive ownership of terminal outcomes. `resumable` defaults to true when the source cannot prove otherwise (a run-list summary carries no checkpoint probe); an explicit false from the run view disables Resume.
export function deriveSuspendedCard(runView: unknown): SuspendedCardDescriptor | undefined {
	if (!isObject(runView)) return undefined
	const status = runView['status']
	if (typeof status !== 'string' || !isSuspendedStatus(status)) return undefined
	const pause = runView['pause']
	if (isOperatorPauseRecord(pause)) {
		return {
			status: 'suspended',
			kind: 'operator',
			category: null,
			resumePolicy: 'operator',
			suspendedAt: pause.pausedAt,
			resumable: runView['resumable'] !== false,
			cause: OPERATOR_PAUSE_COPY,
		}
	}
	const suspension = runView['suspension']
	if (!isSuspensionRecord(suspension)) return undefined
	const record: SuspensionRecord = suspension
	return {
		status: 'suspended',
		kind: 'provider',
		category: record.category,
		resumePolicy: record.resumePolicy,
		suspendedAt: record.suspendedAt,
		resumable: runView['resumable'] !== false,
		cause: suspensionCauseCopy(categoryOf(record)),
	}
}

// The typed resume failure copy the run view, pause card, history row, and queue row all share. The values are the resume endpoint's rejections; anything unrecognized falls back to a plain refusal rather than inventing a cause.
export function resumeFailureCopy(body: unknown, status: number): string {
	if (status === 404) return 'The run could not be found \u2014 it may have been removed.'
	const error = isObject(body) ? body['error'] : undefined
	if (status === 500) {
		const message = isObject(body) ? body['message'] : undefined
		if (typeof message === 'string' && message !== '') return message
		if (error === 'pause_intent_clear_failed') return 'The pause request could not be cleared, so the run was not resumed.'
		return 'The resume was rejected.'
	}
	if (status !== 409) return 'The resume was rejected.'
	if (error === 'run_suspended') return 'Another run is suspended \u2014 resume or terminate it first.'
	if (error === 'run_paused') return 'Another run is paused by the operator \u2014 resume or terminate it first.'
	if (error === 'run_not_suspended') return 'This run is not suspended, so there is nothing to resume.'
	if (error === 'run_not_resumable') return 'This run is no longer in a state that can be resumed \u2014 it may already be running again.'
	if (error === 'checkpoint_missing') return 'This run has no saved checkpoint, so it was terminated. Start a new run continuing it.'
	if (error === 'provider_unavailable') return 'The model provider is unavailable \u2014 resume once it is healthy.'
	if (error === 'run_in_progress') return 'Another run is in progress \u2014 resume this one after it finishes.'
	return 'The run is no longer waiting to be resumed \u2014 it may already be running again.'
}

export function terminateFailureCopy(body: unknown, status: number): string {
	if (status === 404) return 'The suspended run or its queue item could not be found.'
	const error = isObject(body) ? body['error'] : undefined
	if (status === 409 && error === 'run_in_progress') return 'A run is already in progress, so this suspended run cannot be terminated right now.'
	if (status === 409 && (error === 'status_forbidden' || error === 'run_not_suspended')) return 'This run is no longer suspended, so it cannot be terminated.'
	return 'The run could not be terminated.'
}

// The pause card and history row terminate by run id (so a lost queue item cannot strand the pause); a queue row keeps addressing its known item. The pending id is whichever handle the request used, so both button groups disable together.
export function suspendedTerminateTarget(runId: string, itemId: string | null): { url: string; pendingId: string } {
	if (itemId !== null) return { url: `api/queue/${encodeURIComponent(itemId)}/terminate`, pendingId: itemId }
	return { url: `api/runs/${encodeURIComponent(runId)}/terminate`, pendingId: runId }
}

export interface SuspendedCardDiagnostics {
	open: boolean
	load: SuspendedDiagnosticsLoad
	onToggle: unknown
	onRetry: unknown
}

export interface SuspendedCardProps {
	descriptor: SuspendedCardDescriptor
	runLabel?: string | null
	runId?: string | null
	notice?: string | null
	resumePending?: boolean
	terminatePending?: boolean
	onResume?: unknown
	onTerminate?: unknown
	onClose: unknown
	diagnostics?: SuspendedCardDiagnostics
	onCopyDiagnostics?: (rawJson: string) => void
}

function diagnosticsLine(h: LooseH, label: string, value: string): Vnode {
	return h('p', { class: 'suspended-card-diagnostic-line' }, `${label}: ${value}`)
}

function suspensionDiagnostics(h: LooseH, diagnostics: RunDiagnostics): Vnode[] {
	const suspension = diagnostics.suspension
	if (suspension === null) return [h('p', { class: 'suspended-card-diagnostic-empty' }, 'No suspension record was saved for this run.')]
	const children: Vnode[] = [
		h('p', { class: 'suspended-card-diagnostics-heading' }, 'Suspension'),
		diagnosticsLine(h, 'Category', suspension.category),
		diagnosticsLine(h, 'Disposition', suspension.disposition),
		diagnosticsLine(h, 'Effective policy', suspension.resumePolicy),
		diagnosticsLine(h, 'Suspended at', suspension.suspendedAt),
		diagnosticsLine(h, 'Escalated', suspension.escalated ? 'yes' : 'no'),
	]
	if (suspension.autoResumeAfter !== undefined) children.push(diagnosticsLine(h, 'Auto-resume after', suspension.autoResumeAfter))
	if (suspension.escalateAfter !== undefined) children.push(diagnosticsLine(h, 'Escalate after', suspension.escalateAfter))
	if (suspension.resumeAttempts !== undefined) children.push(diagnosticsLine(h, 'Resume attempts', String(suspension.resumeAttempts)))
	return children
}

function failureDiagnostics(h: LooseH, diagnostics: RunDiagnostics): Vnode[] {
	const failure = diagnostics.failure
	if (failure === null) return [h('p', { class: 'suspended-card-diagnostic-empty' }, 'No provider failure event was found in the run log.')]
	const role = failure.roleId === undefined ? failure.role : `${failure.role} (${failure.roleId})`
	const children: Vnode[] = [
		h('p', { class: 'suspended-card-diagnostics-heading' }, 'Last role failure'),
		diagnosticsLine(h, 'Timestamp', failure.timestamp),
		diagnosticsLine(h, 'Role', role),
		diagnosticsLine(h, 'Category', failure.category),
	]
	if (failure.httpStatus !== undefined) children.push(diagnosticsLine(h, 'HTTP status', String(failure.httpStatus)))
	children.push(diagnosticsLine(h, 'Attempts', String(failure.attempts)))
	children.push(diagnosticsLine(h, 'Partial output', failure.partialOutput ? 'yes' : 'no'))
	if (failure.detail !== undefined) children.push(h('pre', { class: 'suspended-card-diagnostic-detail' }, failure.detail))
	return children
}

function probeFailureDiagnostics(h: LooseH, diagnostics: RunDiagnostics): Vnode[] {
	const probe = diagnostics.probeFailure
	if (probe === null) return []
	const children: Vnode[] = [
		h('p', { class: 'suspended-card-diagnostics-heading' }, 'Health probe failure'),
		diagnosticsLine(h, 'At', probe.at),
		diagnosticsLine(h, 'Category', probe.category),
	]
	if (probe.httpStatus !== undefined) children.push(diagnosticsLine(h, 'HTTP status', String(probe.httpStatus)))
	if (probe.detail !== undefined) children.push(h('pre', { class: 'suspended-card-diagnostic-detail' }, probe.detail))
	return children
}

function diagnosticsBody(h: LooseH, diagnostics: SuspendedCardDiagnostics, onCopyDiagnostics: ((rawJson: string) => void) | undefined): Vnode[] {
	if (diagnostics.load.status === 'loading') return [h('p', { class: 'suspended-card-diagnostics-loading' }, 'Loading technical details…')]
	if (diagnostics.load.status === 'failed') {
		return [
			h('p', { class: 'suspended-card-diagnostics-failed', role: 'alert' }, 'Technical details could not be loaded.'),
			h('button', { type: 'button', class: 'suspended-card-diagnostics-retry', onclick: diagnostics.onRetry }, 'Retry'),
		]
	}
	const data = diagnostics.load.data
	const children: Vnode[] = [
		...suspensionDiagnostics(h, data),
		...failureDiagnostics(h, data),
		...probeFailureDiagnostics(h, data),
	]
	if (onCopyDiagnostics !== undefined) {
		children.push(h('button', { type: 'button', class: 'suspended-card-copy-diagnostics', onclick: (state: unknown) => { onCopyDiagnostics(diagnosticsCopyJson(data)); return state } }, 'Copy diagnostics'))
	}
	return children
}

// The pause card overlay. Its actions carry the run id on data-run-id, the same contract the result modal's recovery buttons use, and Terminate is a destructive action the host confirms before posting.
export function SuspendedCard(h: LooseH, props: SuspendedCardProps): Vnode {
	const descriptor = props.descriptor
	const runLabel = props.runLabel
	const runId = typeof props.runId === 'string' ? props.runId : typeof runLabel === 'string' ? runLabel : ''
	const resumePending = props.resumePending === true
	const terminatePending = props.terminatePending === true
	const resumeDisabled = resumePending || terminatePending || !descriptor.resumable
	const terminateDisabled = terminatePending || resumePending
	const operatorPaused = descriptor.kind === 'operator'
	const heading = operatorPaused ? 'Run paused' : 'Run suspended'
	const statusText = operatorPaused ? 'Paused' : 'Suspended'
	const children: Vnode[] = [
		h('p', { class: 'suspended-card-heading' }, runLabel !== null && runLabel !== undefined && runLabel !== ''
			? `${heading} \u00b7 ${runLabel}`
			: heading),
		h('p', { class: 'suspended-card-status' }, statusText),
		h('p', { class: 'suspended-card-cause' }, descriptor.cause),
		h('p', { class: 'suspended-card-since' }, `${statusText} since ${descriptor.suspendedAt}`),
	]
	if (!descriptor.resumable) {
		children.push(h('p', { class: 'suspended-card-note' }, 'This run has no saved checkpoint to resume from.'))
	}
	if (typeof props.notice === 'string' && props.notice !== '') {
		children.push(h('p', { class: 'suspended-card-notice', role: 'alert' }, props.notice))
	}
	if (props.diagnostics !== undefined) {
		const detailsChildren: Vnode[] = [h('summary', { class: 'suspended-card-details-summary' }, 'Technical details')]
		if (props.diagnostics.open) detailsChildren.push(...diagnosticsBody(h, props.diagnostics, props.onCopyDiagnostics))
		children.push(h('details', { class: 'suspended-card-details', open: props.diagnostics.open, ontoggle: props.diagnostics.onToggle }, detailsChildren))
	}
	const actions: Vnode[] = []
	if (props.onResume !== undefined) {
		actions.push(h('button', { type: 'button', class: 'suspended-card-resume', 'data-run-id': runId, disabled: resumeDisabled, title: !descriptor.resumable ? 'This run has no saved checkpoint to resume from.' : '', onclick: props.onResume }, resumePending ? 'Resuming\u2026' : 'Resume now'))
	}
	if (props.onTerminate !== undefined) {
		actions.push(h('button', { type: 'button', class: 'suspended-card-terminate', 'data-run-id': runId, disabled: terminateDisabled, onclick: props.onTerminate }, terminatePending ? 'Terminating\u2026' : 'Terminate run'))
	}
	actions.push(h('button', { type: 'button', class: 'suspended-card-close', onclick: props.onClose }, 'Close'))
	children.push(h('div', { class: 'suspended-card-actions' }, actions))
	return h('div', { class: 'suspended-card-overlay' }, [
		h('div', { class: 'suspended-card-backdrop', onclick: props.onClose }),
		h('div', { class: 'suspended-card' }, children),
	])
}
