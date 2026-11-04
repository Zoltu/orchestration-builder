import type { FailureDisposition, LlmCallResult, ResumePolicy, RunMeta, SuspensionCategory, SuspensionRecord } from './types.js'

type ProviderFailure = Extract<LlmCallResult, { kind: 'provider_failure' }>

// A provider can ask to retry after an unbounded delta; the auto-resume timestamp is clamped so Date cannot overflow and so a long pause is retried at a sane cadence.
const MAX_AUTO_RESUME_DELAY_MS = 24 * 60 * 60 * 1000

// A novel failure starts an incident deadline. The deadline belongs to the incident and survives every automatic re-suspension, whatever the later failure category, until a successful role call ends the incident.
const NOVEL_ESCALATION_DELAY_MS = 15 * 60 * 1000

// The one result shape for re-entering a suspended run, shared by the explicit-resume operation and the automatic-resume coordinator.
export type SuspendedRunResumeResult =
	| { ok: true; runId: string }
	| { ok: false; error: 'run_not_found' | 'run_not_resumable' | 'run_suspended' | 'run_paused' | 'checkpoint_missing' | 'run_in_progress' | 'pause_intent_clear_failed' }

// The platform-authored reason written when startup finds more than one suspended run and keeps only the newest. The queue's boot repair uses this exact mark to cancel the superseded run's item instead of re-dispatching it as a new task.
export const SUPERSEDED_SUSPENDED_RUN_MESSAGE = 'The service restarted with multiple suspended runs; only the most recent was kept, so this run was superseded.'

export function isSupersededSuspendedRun(meta: RunMeta): boolean {
	return meta.status === 'interrupted' && meta.error?.kind === 'interrupted' && meta.error.message === SUPERSEDED_SUSPENDED_RUN_MESSAGE
}

export function isSuspendedStatus(status: string): status is 'suspended' {
	return status === 'suspended'
}

// The category names the cause; the disposition names the policy. Only a transport-style failure is safe to retry without a human decision, and an unclassified failure is retried only inside its incident deadline.
export function dispositionForCategory(category: SuspensionCategory): FailureDisposition {
	if (category === 'transient') return 'recoverable'
	if (category === 'novel') return 'novel'
	return 'human'
}

// A record persisted before dispositions existed carries no disposition; deriving it from the category keeps those records readable without rewriting them. A transient record whose persisted policy is operator was downgraded by the removed attempt cap, so it remains a human decision rather than silently becoming auto.
export function deriveDisposition(category: SuspensionCategory, resumePolicy: ResumePolicy, disposition?: FailureDisposition): FailureDisposition {
	if (disposition !== undefined) return disposition
	if (category === 'transient' && resumePolicy === 'operator') return 'human'
	return dispositionForCategory(category)
}

export function dispositionOf(suspension: SuspensionRecord): FailureDisposition {
	return deriveDisposition(suspension.category, suspension.resumePolicy, suspension.disposition)
}

export function isEscalationDue(suspension: SuspensionRecord, at: string): boolean {
	if (suspension.escalateAfter === undefined) return false
	const deadlineMs = Date.parse(suspension.escalateAfter)
	const atMs = Date.parse(at)
	return !Number.isNaN(deadlineMs) && !Number.isNaN(atMs) && atMs >= deadlineMs
}

// The effective policy is derived rather than persisted: an incident silently becomes an operator decision once its deadline passes, without rewriting the durable record, even if the current failure is recoverable.
export function effectiveResumePolicy(suspension: SuspensionRecord, at: string): ResumePolicy {
	return dispositionOf(suspension) === 'human' || isEscalationDue(suspension, at) ? 'operator' : 'auto'
}

function suspensionMessageFor(category: SuspensionCategory): string {
	switch (category) {
		case 'transient':
			return 'The model provider is temporarily unavailable; the run will resume automatically when it recovers.'
		case 'billing':
			return 'The model provider reports insufficient credit; top up and resume the run.'
		case 'auth':
			return 'The model provider rejected the credentials; fix the deployment and resume the run.'
		case 'request_rejected':
			return 'The model provider rejected the request; fix the deployment and resume the run.'
		case 'novel':
			return 'The model provider returned an unexpected response; the run will resume automatically while the platform investigates.'
		case 'unknown':
			return 'The model provider failed for an unclassified reason; resume when it is healthy.'
		default: {
			const exhaustive: never = category
			return exhaustive
		}
	}
}

// The durable pause record. The provider's own message, body, URL, and request contents are deliberately dropped: the platform-authored category copy is the only text the operator surfaces ever see. resumeAttempts is diagnostic history and never a cap; an incident that began novel carries the deadline at which it becomes an operator decision.
export function suspensionFromFailure(failure: ProviderFailure, suspendedAt: string, prior?: SuspensionRecord): SuspensionRecord {
	const disposition = dispositionForCategory(failure.category)
	const priorAttempts = prior?.resumeAttempts
	if (disposition === 'human') {
		return {
			category: failure.category,
			disposition,
			resumePolicy: 'operator',
			message: suspensionMessageFor(failure.category),
			suspendedAt,
			...(priorAttempts !== undefined ? { resumeAttempts: priorAttempts } : {}),
		}
	}
	const record: SuspensionRecord = {
		category: failure.category,
		disposition,
		resumePolicy: 'auto',
		message: suspensionMessageFor(failure.category),
		suspendedAt,
		resumeAttempts: (priorAttempts ?? 0) + 1,
	}
	// The deadline belongs to the incident, not the individual suspension: any automatic re-suspension before a successful call keeps the original escalation moment, even when the new failure is recoverable. If the deadline passed during the resume, clamping it to this suspension's start keeps the record valid and escalates immediately.
	const suspendedAtMs = Date.parse(suspendedAt)
	if (!Number.isNaN(suspendedAtMs)) {
		const priorDeadlineMs = prior?.escalateAfter === undefined ? undefined : Date.parse(prior.escalateAfter)
		if (priorDeadlineMs !== undefined && !Number.isNaN(priorDeadlineMs)) {
			record.escalateAfter = new Date(Math.max(suspendedAtMs, priorDeadlineMs)).toISOString()
		} else if (disposition === 'novel') {
			record.escalateAfter = new Date(suspendedAtMs + NOVEL_ESCALATION_DELAY_MS).toISOString()
		}
	}
	if (failure.retryAfterMs !== undefined) {
		const suspendedAtMs = Date.parse(suspendedAt)
		if (!Number.isNaN(suspendedAtMs)) {
			const delayMs = Number.isFinite(failure.retryAfterMs) ? Math.max(0, Math.min(failure.retryAfterMs, MAX_AUTO_RESUME_DELAY_MS)) : MAX_AUTO_RESUME_DELAY_MS
			record.autoResumeAfter = new Date(suspendedAtMs + delayMs).toISOString()
		}
	}
	return record
}
