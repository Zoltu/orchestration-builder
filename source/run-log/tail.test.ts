import { describe, expect, test } from 'bun:test'
import { planTailRead, trimTailText } from './tail.js'

describe('planTailRead', () => {
	test('a file that fits entirely is read from offset 0 with no dropped line', () => {
		expect(planTailRead(100, 100)).toEqual({ start: 0, length: 100, dropLeadingPartialLine: false })
		expect(planTailRead(40, 100)).toEqual({ start: 0, length: 40, dropLeadingPartialLine: false })
	})

	test('a file one byte over the cap still starts at 0 because the one-byte prefix is whole-file context', () => {
		expect(planTailRead(101, 100)).toEqual({ start: 0, length: 101, dropLeadingPartialLine: false })
	})

	test('a larger file reads at most maxBytes + 1 from one byte before the window', () => {
		expect(planTailRead(1000, 100)).toEqual({ start: 899, length: 101, dropLeadingPartialLine: true })
	})
})

describe('trimTailText', () => {
	test('keeps the whole text when no partial line was read', () => {
		expect(trimTailText('first\nsecond', false)).toBe('first\nsecond')
	})

	test('a captured text beginning with the boundary newline keeps the following complete line', () => {
		expect(trimTailText('\nfirst complete\nsecond complete', true)).toBe('first complete\nsecond complete')
	})

	test('drops only the leading partial line when the read started mid-line', () => {
		expect(trimTailText('partial line\nfirst complete\nsecond complete', true)).toBe('first complete\nsecond complete')
	})

	test('a tail with no newline is entirely a partial line', () => {
		expect(trimTailText('partial only', true)).toBe('')
	})
})

describe('exact line boundary', () => {
	test('a window starting just after a newline keeps the first complete line instead of dropping it', () => {
		const text = 'old line\nnewer a\nnewest b\n'
		const plan = planTailRead(text.length, 17)
		expect(plan).toEqual({ start: 8, length: 18, dropLeadingPartialLine: true })
		const captured = text.slice(plan.start, plan.start + plan.length)
		expect(captured.startsWith('\n')).toBe(true)
		expect(trimTailText(captured, plan.dropLeadingPartialLine)).toBe('newer a\nnewest b\n')
	})
})
