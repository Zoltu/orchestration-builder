// The effective disposition and policy of a provider suspension, derived on the client from the fields the run list and run view already carry. Keeping the derivation here makes the favicon, history labels, and banner agree on when an incident's escalation deadline has passed instead of each re-implementing the deadline comparison.

import { isObject } from './guards.js'
import type { FailureDisposition, ResumePolicy, SuspensionCategory } from './interaction-model.js'

export interface SuspensionStatus {
	disposition: FailureDisposition
	resumePolicy: ResumePolicy
	escalated: boolean
}

const SUSPENSION_CATEGORIES: readonly SuspensionCategory[] = ['transient', 'billing', 'auth', 'request_rejected', 'novel', 'unknown']

function isSuspensionCategory(value: unknown): value is SuspensionCategory {
	return typeof value === 'string' && SUSPENSION_CATEGORIES.some((category) => category === value)
}

function isFailureDisposition(value: unknown): value is FailureDisposition {
	return value === 'human' || value === 'recoverable' || value === 'novel'
}

function dispositionForCategory(category: SuspensionCategory): FailureDisposition {
	if (category === 'transient') return 'recoverable'
	if (category === 'novel') return 'novel'
	return 'human'
}

// A record persisted before dispositions existed carries no disposition; deriving it from the category keeps those records readable. A transient record whose persisted policy is operator was downgraded by the removed attempt cap, so it remains a human decision rather than silently becoming auto.
function deriveDisposition(category: SuspensionCategory, resumePolicy: ResumePolicy, disposition?: FailureDisposition): FailureDisposition {
	if (disposition !== undefined) return disposition
	if (category === 'transient' && resumePolicy === 'operator') return 'human'
	return dispositionForCategory(category)
}

function escalationDue(escalateAfter: string | undefined, nowMs: number): boolean {
	if (escalateAfter === undefined) return false
	const deadlineMs = Date.parse(escalateAfter)
	return !Number.isNaN(deadlineMs) && nowMs >= deadlineMs
}

export function readSuspensionStatus(value: unknown, nowMs: number): SuspensionStatus | null {
	if (!isObject(value)) return null
	const category = value['category']
	if (!isSuspensionCategory(category)) return null
	const resumePolicy = value['resumePolicy']
	if (resumePolicy !== 'auto' && resumePolicy !== 'operator') return null
	const persistedDisposition = value['disposition']
	if (persistedDisposition !== undefined && !isFailureDisposition(persistedDisposition)) return null
	const disposition = deriveDisposition(category, resumePolicy, persistedDisposition)
	const escalateAfter = value['escalateAfter']
	const escalated = escalationDue(typeof escalateAfter === 'string' ? escalateAfter : undefined, nowMs)
	return { disposition, resumePolicy: disposition === 'human' || escalated ? 'operator' : 'auto', escalated }
}

function isOperatorPauseShape(value: unknown): boolean {
	if (!isObject(value)) return false
	return typeof value['message'] === 'string' && typeof value['pausedAt'] === 'string'
}

// True when a suspended run's provider suspension is an operator decision now: a human disposition, or any incident past its escalation deadline. Operator pauses are not provider suspensions and are handled by their own label path.
export function suspensionNeedsAttention(run: unknown, nowMs: number): boolean {
	if (!isObject(run)) return false
	if (run['status'] !== 'suspended') return false
	if (isOperatorPauseShape(run['pause'])) return false
	const status = readSuspensionStatus(run['suspension'], nowMs)
	if (status === null) return false
	return status.disposition === 'human' || status.escalated
}
