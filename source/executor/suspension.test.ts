import { describe, expect, test } from 'bun:test'
import { dispositionForCategory, dispositionOf, effectiveResumePolicy, isEscalationDue, isSuspendedStatus, suspensionFromFailure } from './suspension.ts'
import type { LlmCallResult, SuspensionCategory, SuspensionRecord } from './types.ts'
import { isSuspensionRecord } from './validation.ts'

function failure(category: SuspensionCategory, retryAfterMs?: number): Extract<LlmCallResult, { kind: 'provider_failure' }> {
	return {
		kind: 'provider_failure',
		category,
		message: 'provider detail must not reach the record',
		attempts: 1,
		partialOutput: false,
		...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
	}
}

describe('suspension helpers', () => {
	test('suspended is a run status but distinct from the terminal statuses', () => {
		expect(isSuspendedStatus('suspended')).toBe(true)
		expect(isSuspendedStatus('error')).toBe(false)
	})

	test('the pure category-to-disposition mapping separates cause from policy', () => {
		expect(dispositionForCategory('transient')).toBe('recoverable')
		expect(dispositionForCategory('novel')).toBe('novel')
		expect(dispositionForCategory('billing')).toBe('human')
		expect(dispositionForCategory('auth')).toBe('human')
		expect(dispositionForCategory('request_rejected')).toBe('human')
		expect(dispositionForCategory('unknown')).toBe('human')
	})

	test('only recoverable and pre-deadline novel failures auto-resume', () => {
		expect(suspensionFromFailure(failure('transient'), '2026-01-01T00:00:00.000Z').resumePolicy).toBe('auto')
		expect(suspensionFromFailure(failure('novel'), '2026-01-01T00:00:00.000Z').resumePolicy).toBe('auto')
		expect(suspensionFromFailure(failure('billing'), '2026-01-01T00:00:00.000Z').resumePolicy).toBe('operator')
		expect(suspensionFromFailure(failure('auth'), '2026-01-01T00:00:00.000Z').resumePolicy).toBe('operator')
		expect(suspensionFromFailure(failure('request_rejected'), '2026-01-01T00:00:00.000Z').resumePolicy).toBe('operator')
		expect(suspensionFromFailure(failure('unknown'), '2026-01-01T00:00:00.000Z').resumePolicy).toBe('operator')
	})

	test('the record carries platform copy, never the provider message', () => {
		const record = suspensionFromFailure(failure('billing'), '2026-01-01T00:00:00.000Z')
		expect(record.category).toBe('billing')
		expect(record.disposition).toBe('human')
		expect(record.resumePolicy).toBe('operator')
		expect(record.message).toBe('The model provider reports insufficient credit; top up and resume the run.')
		expect(record.message).not.toContain('provider detail')
		expect(record.autoResumeAfter).toBeUndefined()
		expect(record.escalateAfter).toBeUndefined()
	})

	test('a recoverable Retry-After becomes the auto-resume timestamp', () => {
		const record = suspensionFromFailure(failure('transient', 5_000), '2026-01-01T00:00:00.000Z')
		expect(record.resumePolicy).toBe('auto')
		expect(record.disposition).toBe('recoverable')
		expect(record.autoResumeAfter).toBe('2026-01-01T00:00:05.000Z')
		expect(record.escalateAfter).toBeUndefined()
	})

	test('an enormous Retry-After cannot overflow the auto-resume timestamp', () => {
		const record = suspensionFromFailure(failure('transient', Number.MAX_SAFE_INTEGER), '2026-01-01T00:00:00.000Z')
		expect(record.autoResumeAfter).toBe('2026-01-02T00:00:00.000Z')
	})

	test('an operator-resume cause ignores Retry-After for scheduling', () => {
		const record = suspensionFromFailure(failure('billing', 5_000), '2026-01-01T00:00:00.000Z')
		expect(record.autoResumeAfter).toBeUndefined()
	})
})

describe('recoverable failures have no attempt cap', () => {
	test('a re-suspension increments the count for diagnostics and still auto-resumes far past the old cap', () => {
		const prior: SuspensionRecord = {
			category: 'transient',
			disposition: 'recoverable',
			resumePolicy: 'auto',
			message: 'Retry later.',
			suspendedAt: '2026-01-01T00:00:00.000Z',
			resumeAttempts: 100,
		}
		const record = suspensionFromFailure(failure('transient', 5_000), '2026-01-01T00:00:01.000Z', prior)
		expect(record.resumePolicy).toBe('auto')
		expect(record.resumeAttempts).toBe(101)
		expect(record.autoResumeAfter).toBe('2026-01-01T00:00:06.000Z')
		expect(record.message).not.toContain('did not recover')
	})

	test('a recoverable re-suspension preserves the incident deadline started by a novel failure', () => {
		const prior: SuspensionRecord = {
			category: 'novel',
			disposition: 'novel',
			resumePolicy: 'auto',
			message: 'Unexpected.',
			suspendedAt: '2026-01-01T00:00:00.000Z',
			escalateAfter: '2026-01-01T00:15:00.000Z',
			resumeAttempts: 2,
		}
		const record = suspensionFromFailure(failure('transient'), '2026-01-01T00:01:00.000Z', prior)
		expect(record.disposition).toBe('recoverable')
		expect(record.escalateAfter).toBe('2026-01-01T00:15:00.000Z')
		expect(record.resumeAttempts).toBe(3)
		expect(effectiveResumePolicy(record, '2026-01-01T00:14:59.999Z')).toBe('auto')
		expect(effectiveResumePolicy(record, '2026-01-01T00:15:00.000Z')).toBe('operator')
	})

	test('a pure recoverable incident still has no deadline', () => {
		const record = suspensionFromFailure(failure('transient'), '2026-01-01T00:00:00.000Z')
		expect(record.disposition).toBe('recoverable')
		expect(record.escalateAfter).toBeUndefined()
		expect(effectiveResumePolicy(record, '2030-01-01T00:00:00.000Z')).toBe('auto')
	})
})

describe('novel incident deadline', () => {
	test('a new novel suspension escalates fifteen minutes after it starts', () => {
		const record = suspensionFromFailure(failure('novel'), '2026-01-01T00:00:00.000Z')
		expect(record.disposition).toBe('novel')
		expect(record.resumePolicy).toBe('auto')
		expect(record.escalateAfter).toBe('2026-01-01T00:15:00.000Z')
		expect(record.resumeAttempts).toBe(1)
		expect(isEscalationDue(record, '2026-01-01T00:14:59.999Z')).toBe(false)
		expect(isEscalationDue(record, '2026-01-01T00:15:00.000Z')).toBe(true)
		expect(effectiveResumePolicy(record, '2026-01-01T00:14:59.999Z')).toBe('auto')
		expect(effectiveResumePolicy(record, '2026-01-01T00:15:00.000Z')).toBe('operator')
	})

	test('a re-suspension preserves the original deadline while incrementing the diagnostic count', () => {
		const first = suspensionFromFailure(failure('novel'), '2026-01-01T00:00:00.000Z')
		const second = suspensionFromFailure(failure('novel'), '2026-01-01T00:05:00.000Z', first)
		expect(second.escalateAfter).toBe('2026-01-01T00:15:00.000Z')
		expect(second.resumeAttempts).toBe(2)
	})

	test('a prior deadline that passed during resume is clamped to the new suspendedAt', () => {
		const first: SuspensionRecord = {
			category: 'novel',
			disposition: 'novel',
			resumePolicy: 'auto',
			message: 'Unexpected.',
			suspendedAt: '2026-01-01T00:00:00.000Z',
			escalateAfter: '2026-01-01T00:05:00.000Z',
			resumeAttempts: 2,
		}
		const second = suspensionFromFailure(failure('novel'), '2026-01-01T00:10:00.000Z', first)
		expect(second.escalateAfter).toBe('2026-01-01T00:10:00.000Z')
		expect(isSuspensionRecord(second)).toBe(true)
		expect(effectiveResumePolicy(second, '2026-01-01T00:10:00.000Z')).toBe('operator')
		expect(second.resumeAttempts).toBe(3)
	})

	test('a novel Retry-After sets the auto-resume time without changing the deadline', () => {
		const record = suspensionFromFailure(failure('novel', 5_000), '2026-01-01T00:00:00.000Z')
		expect(record.autoResumeAfter).toBe('2026-01-01T00:00:05.000Z')
		expect(record.escalateAfter).toBe('2026-01-01T00:15:00.000Z')
	})

	test('a human failure preserves the prior diagnostic count but carries no deadline', () => {
		const prior: SuspensionRecord = {
			category: 'novel',
			disposition: 'novel',
			resumePolicy: 'auto',
			message: 'Unexpected.',
			suspendedAt: '2026-01-01T00:00:00.000Z',
			escalateAfter: '2026-01-01T00:15:00.000Z',
			resumeAttempts: 4,
		}
		const record = suspensionFromFailure(failure('billing', 5_000), '2026-01-01T00:01:00.000Z', prior)
		expect(record.resumePolicy).toBe('operator')
		expect(record.resumeAttempts).toBe(4)
		expect(record.escalateAfter).toBeUndefined()
		expect(record.autoResumeAfter).toBeUndefined()
	})
})

describe('legacy record derivation', () => {
	test('a record persisted without a disposition reads through its category', () => {
		const legacy: SuspensionRecord = { category: 'transient', resumePolicy: 'auto', message: 'Retry later.', suspendedAt: '2026-01-01T00:00:00.000Z' }
		expect(dispositionOf(legacy)).toBe('recoverable')
		expect(effectiveResumePolicy(legacy, '2026-01-01T00:00:00.000Z')).toBe('auto')
		const legacyBilling: SuspensionRecord = { category: 'billing', resumePolicy: 'operator', message: 'Top up.', suspendedAt: '2026-01-01T00:00:00.000Z' }
		expect(dispositionOf(legacyBilling)).toBe('human')
		expect(effectiveResumePolicy(legacyBilling, '2026-01-01T00:00:00.000Z')).toBe('operator')
		const legacyCapped: SuspensionRecord = { category: 'transient', resumePolicy: 'operator', message: 'Capped.', suspendedAt: '2026-01-01T00:00:00.000Z', resumeAttempts: 6 }
		expect(dispositionOf(legacyCapped)).toBe('human')
		expect(effectiveResumePolicy(legacyCapped, '2026-01-01T00:00:00.000Z')).toBe('operator')
		expect(isEscalationDue(legacyCapped, '2026-01-01T00:00:00.000Z')).toBe(false)
	})
})
