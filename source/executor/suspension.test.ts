import { describe, expect, test } from 'bun:test'
import { isSuspendedStatus, MAX_AUTO_RESUME_ATTEMPTS, suspensionFromFailure } from './suspension.ts'
import type { LlmCallResult, SuspensionCategory, SuspensionRecord } from './types.ts'

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

	test('only transient failures auto-resume', () => {
		expect(suspensionFromFailure(failure('transient'), '2026-01-01T00:00:00.000Z').resumePolicy).toBe('auto')
		expect(suspensionFromFailure(failure('billing'), '2026-01-01T00:00:00.000Z').resumePolicy).toBe('operator')
		expect(suspensionFromFailure(failure('auth'), '2026-01-01T00:00:00.000Z').resumePolicy).toBe('operator')
		expect(suspensionFromFailure(failure('request_rejected'), '2026-01-01T00:00:00.000Z').resumePolicy).toBe('operator')
		expect(suspensionFromFailure(failure('unknown'), '2026-01-01T00:00:00.000Z').resumePolicy).toBe('operator')
	})

	test('the record carries platform copy, never the provider message', () => {
		const record = suspensionFromFailure(failure('billing'), '2026-01-01T00:00:00.000Z')
		expect(record.category).toBe('billing')
		expect(record.resumePolicy).toBe('operator')
		expect(record.message).toBe('The model provider reports insufficient credit; top up and resume the run.')
		expect(record.message).not.toContain('provider detail')
		expect(record.autoResumeAfter).toBeUndefined()
	})

	test('a transient Retry-After becomes the auto-resume timestamp', () => {
		const record = suspensionFromFailure(failure('transient', 5_000), '2026-01-01T00:00:00.000Z')
		expect(record.resumePolicy).toBe('auto')
		expect(record.autoResumeAfter).toBe('2026-01-01T00:00:05.000Z')
	})

	test('an enormous Retry-After cannot overflow the auto-resume timestamp', () => {
		const record = suspensionFromFailure(failure('transient', Number.MAX_SAFE_INTEGER), '2026-01-01T00:00:00.000Z')
		expect(record.autoResumeAfter).toBe('2026-01-02T00:00:00.000Z')
	})

	test('a re-suspension increments the prior auto-resume attempt count', () => {
		const first = suspensionFromFailure(failure('transient'), '2026-01-01T00:00:00.000Z')
		expect(first.resumeAttempts).toBe(1)
		const second = suspensionFromFailure(failure('transient'), '2026-01-01T00:00:01.000Z', first)
		expect(second.resumeAttempts).toBe(2)
	})

	test('an operator-resume cause ignores Retry-After for scheduling', () => {
		const record = suspensionFromFailure(failure('billing', 5_000), '2026-01-01T00:00:00.000Z')
		expect(record.autoResumeAfter).toBeUndefined()
	})
})

describe('automatic resume attempt cap', () => {
	test('the last allowed automatic attempt still schedules a resume', () => {
		const prior: SuspensionRecord = {
			category: 'transient',
			resumePolicy: 'auto',
			message: 'Retry later.',
			suspendedAt: '2026-01-01T00:00:00.000Z',
			resumeAttempts: MAX_AUTO_RESUME_ATTEMPTS - 1,
		}
		const record = suspensionFromFailure(failure('transient', 5_000), '2026-01-01T00:00:01.000Z', prior)
		expect(record.resumePolicy).toBe('auto')
		expect(record.resumeAttempts).toBe(MAX_AUTO_RESUME_ATTEMPTS)
		expect(record.autoResumeAfter).toBe('2026-01-01T00:00:06.000Z')
	})

	test('the suspension after the cap is downgraded to an operator decision', () => {
		const prior: SuspensionRecord = {
			category: 'transient',
			resumePolicy: 'auto',
			message: 'Retry later.',
			suspendedAt: '2026-01-01T00:00:00.000Z',
			resumeAttempts: MAX_AUTO_RESUME_ATTEMPTS,
		}
		const record = suspensionFromFailure(failure('transient', 5_000), '2026-01-01T00:00:01.000Z', prior)
		expect(record.category).toBe('transient')
		expect(record.resumePolicy).toBe('operator')
		expect(record.autoResumeAfter).toBeUndefined()
		expect(record.resumeAttempts).toBe(MAX_AUTO_RESUME_ATTEMPTS + 1)
		expect(record.message).toBe('The model provider did not recover after repeated automatic resume attempts; resume the run when the provider is healthy.')
		expect(record.message).not.toContain('provider detail')
	})

	test('an operator-resume cause is not affected by the cap', () => {
		const record = suspensionFromFailure(failure('billing'), '2026-01-01T00:00:00.000Z')
		expect(record.resumePolicy).toBe('operator')
		expect(record.resumeAttempts).toBeUndefined()
	})
})

describe('durable automatic-resume budget', () => {
	test('a downgraded operator suspension keeps the exhausted count across a later transient failure', () => {
		const capped: SuspensionRecord = {
			category: 'transient',
			resumePolicy: 'operator',
			message: 'The model provider did not recover after repeated automatic resume attempts; resume the run when the provider is healthy.',
			suspendedAt: '2026-01-01T00:00:01.000Z',
			resumeAttempts: MAX_AUTO_RESUME_ATTEMPTS + 1,
		}
		const later = suspensionFromFailure(failure('transient'), '2026-01-01T00:00:02.000Z', capped)
		expect(later.resumePolicy).toBe('operator')
		expect(later.resumeAttempts).toBe(MAX_AUTO_RESUME_ATTEMPTS + 2)
		expect(later.autoResumeAfter).toBeUndefined()
	})

	test('an operator-cause suspension carries the prior automatic count forward', () => {
		const prior: SuspensionRecord = {
			category: 'transient',
			resumePolicy: 'auto',
			message: 'Retry later.',
			suspendedAt: '2026-01-01T00:00:00.000Z',
			resumeAttempts: 2,
		}
		const billing = suspensionFromFailure(failure('billing'), '2026-01-01T00:00:01.000Z', prior)
		expect(billing.resumePolicy).toBe('operator')
		expect(billing.resumeAttempts).toBe(2)
		const later = suspensionFromFailure(failure('transient'), '2026-01-01T00:00:02.000Z', billing)
		expect(later.resumePolicy).toBe('auto')
		expect(later.resumeAttempts).toBe(3)
	})
})
