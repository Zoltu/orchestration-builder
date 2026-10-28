import type { LlmCallResult, ResumePolicy, RunMeta, SuspensionCategory, SuspensionRecord } from './types.js'

type ProviderFailure = Extract<LlmCallResult, { kind: 'provider_failure' }>

// A provider can ask to retry after an unbounded delta; the auto-resume timestamp is clamped so Date cannot overflow and so a long pause is retried at a sane cadence.
const MAX_AUTO_RESUME_DELAY_MS = 24 * 60 * 60 * 1000

// Automatic resumes are bounded so a permanently flapping provider cannot bill indefinitely (docs/reference.md "Provider failures and suspension"). Once this many transient suspensions have been auto-retried, the next one becomes an operator decision.
export const MAX_AUTO_RESUME_ATTEMPTS = 5

// The one result shape for re-entering a suspended run, shared by the explicit-resume operation and the automatic-resume coordinator.
export type SuspendedRunResumeResult =
	| { ok: true; runId: string }
	| { ok: false; error: 'run_not_found' | 'run_not_resumable' | 'run_suspended' | 'checkpoint_missing' | 'run_in_progress' }

// The platform-authored reason written when startup finds more than one suspended run and keeps only the newest. The queue's boot repair uses this exact mark to cancel the superseded run's item instead of re-dispatching it as a new task.
export const SUPERSEDED_SUSPENDED_RUN_MESSAGE = 'The service restarted with multiple suspended runs; only the most recent was kept, so this run was superseded.'

export function isSupersededSuspendedRun(meta: RunMeta): boolean {
	return meta.status === 'interrupted' && meta.error?.kind === 'interrupted' && meta.error.message === SUPERSEDED_SUSPENDED_RUN_MESSAGE
}

export function isSuspendedStatus(status: string): status is 'suspended' {
	return status === 'suspended'
}

// A transient provider failure is the only category safe to retry without a human decision; every other cause can only be cleared by the operator fixing credit, credentials, or the deployment.
function resumePolicyFor(category: SuspensionCategory): ResumePolicy {
	return category === 'transient' ? 'auto' : 'operator'
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
		case 'unknown':
			return 'The model provider failed for an unclassified reason; resume when it is healthy.'
		default: {
			const exhaustive: never = category
			return exhaustive
		}
	}
}

const AUTO_RESUME_EXHAUSTED_MESSAGE = 'The model provider did not recover after repeated automatic resume attempts; resume the run when the provider is healthy.'

// The durable pause record. The provider's own message, body, URL, and request contents are deliberately dropped: the platform-authored category copy is the only text the operator surfaces ever see. resumeAttempts is the cumulative automatic-resume count; it survives a policy downgrade into an operator decision so a later operator resume cannot grant a fresh automatic budget.
export function suspensionFromFailure(failure: ProviderFailure, suspendedAt: string, prior?: SuspensionRecord): SuspensionRecord {
	const resumePolicy = resumePolicyFor(failure.category)
	const priorAttempts = prior?.resumeAttempts
	if (resumePolicy === 'operator') {
		return {
			category: failure.category,
			resumePolicy,
			message: suspensionMessageFor(failure.category),
			suspendedAt,
			...(priorAttempts !== undefined ? { resumeAttempts: priorAttempts } : {}),
		}
	}
	const attempts = (priorAttempts ?? 0) + 1
	// Count the exhausted suspension itself as the trigger, after the configured number of automatic attempts have already run. The downgraded record keeps the count so the cap stays durable across a later operator resume.
	if (attempts > MAX_AUTO_RESUME_ATTEMPTS) {
		return {
			category: failure.category,
			resumePolicy: 'operator',
			message: AUTO_RESUME_EXHAUSTED_MESSAGE,
			suspendedAt,
			resumeAttempts: attempts,
		}
	}
	const record: SuspensionRecord = {
		category: failure.category,
		resumePolicy,
		message: suspensionMessageFor(failure.category),
		suspendedAt,
		resumeAttempts: attempts,
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
