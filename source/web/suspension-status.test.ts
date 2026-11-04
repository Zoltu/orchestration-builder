import { describe, expect, test } from 'bun:test'
import { readSuspensionStatus, suspensionNeedsAttention } from './static/ts/suspension-status.js'

const NOW = Date.parse('2026-01-01T00:10:00.000Z')

function suspension(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		category: 'transient',
		resumePolicy: 'auto',
		message: 'Temporarily unavailable.',
		suspendedAt: '2026-01-01T00:02:00.000Z',
		...overrides,
	}
}

describe('client suspension status', () => {
	test('derives legacy dispositions and the effective policy', () => {
		expect(readSuspensionStatus(suspension({ category: 'transient', resumePolicy: 'operator' }), NOW)).toEqual({ disposition: 'human', resumePolicy: 'operator', escalated: false })
		expect(readSuspensionStatus(suspension({ category: 'transient', resumePolicy: 'auto' }), NOW)).toEqual({ disposition: 'recoverable', resumePolicy: 'auto', escalated: false })
		expect(readSuspensionStatus(suspension({ category: 'billing', resumePolicy: 'operator' }), NOW)).toEqual({ disposition: 'human', resumePolicy: 'operator', escalated: false })
	})

	test('escalates a novel incident only after its deadline', () => {
		const before = suspension({ category: 'novel', disposition: 'novel', resumePolicy: 'auto', escalateAfter: '2026-01-01T00:15:00.000Z' })
		const after = suspension({ category: 'novel', disposition: 'novel', resumePolicy: 'auto', escalateAfter: '2026-01-01T00:05:00.000Z' })
		expect(readSuspensionStatus(before, NOW)).toEqual({ disposition: 'novel', resumePolicy: 'auto', escalated: false })
		expect(readSuspensionStatus(after, NOW)).toEqual({ disposition: 'novel', resumePolicy: 'operator', escalated: true })
	})

	test('a recoverable incident escalates when its inherited deadline is reached', () => {
		const before = suspension({ category: 'transient', disposition: 'recoverable', resumePolicy: 'auto', escalateAfter: '2026-01-01T00:15:00.000Z' })
		const after = suspension({ category: 'transient', disposition: 'recoverable', resumePolicy: 'auto', escalateAfter: '2026-01-01T00:05:00.000Z' })
		expect(readSuspensionStatus(before, NOW)).toEqual({ disposition: 'recoverable', resumePolicy: 'auto', escalated: false })
		expect(readSuspensionStatus(after, NOW)).toEqual({ disposition: 'recoverable', resumePolicy: 'operator', escalated: true })
	})

	test('reports attention only for a human or escalated provider suspension, never an operator pause', () => {
		expect(suspensionNeedsAttention({ status: 'suspended', suspension: suspension({ category: 'billing' }) }, NOW)).toBe(true)
		expect(suspensionNeedsAttention({ status: 'suspended', suspension: suspension({ category: 'transient' }) }, NOW)).toBe(false)
		expect(suspensionNeedsAttention({ status: 'suspended', suspension: suspension({ category: 'transient', disposition: 'recoverable', escalateAfter: '2026-01-01T00:05:00.000Z' }) }, NOW)).toBe(true)
		expect(suspensionNeedsAttention({ status: 'suspended', pause: { message: 'Paused.', pausedAt: '2026-01-01T00:02:00.000Z' }, suspension: suspension({ category: 'billing' }) }, NOW)).toBe(false)
	})

	test('readSuspensionStatus rejects malformed records rather than guessing', () => {
		expect(readSuspensionStatus(null, NOW)).toBeNull()
		expect(readSuspensionStatus({ category: 'bogus', resumePolicy: 'auto' }, NOW)).toBeNull()
		expect(readSuspensionStatus({ category: 'transient', resumePolicy: 'bogus' }, NOW)).toBeNull()
	})
})
