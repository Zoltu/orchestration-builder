import { describe, expect, test } from 'bun:test'

import { createContextPressureTracker, effectiveContextBudget, recordContextRejection } from './context-pressure.ts'

describe('effectiveContextBudget', () => {
	test('is the window minus the reserved completion budget when nothing has been learned', () => {
		expect(effectiveContextBudget(262144, 32768, undefined)).toBe(229376)
	})

	test('tightens to the learned ceiling when it sits below the static budget', () => {
		expect(effectiveContextBudget(262144, 32768, 200000)).toBe(200000)
	})

	test('ignores a learned ceiling above the static budget', () => {
		expect(effectiveContextBudget(262144, 32768, 250000)).toBe(229376)
	})

	test('treats a missing completion reservation as zero', () => {
		expect(effectiveContextBudget(100000, 0, undefined)).toBe(100000)
	})
})

describe('recordContextRejection', () => {
	test('sets the ceiling from the first reported rejection', () => {
		const tracker = createContextPressureTracker()
		recordContextRejection(tracker, 200000)
		expect(tracker.learnedCeiling).toBe(200000)
	})

	test('only ever tightens', () => {
		const tracker = createContextPressureTracker()
		recordContextRejection(tracker, 200000)
		recordContextRejection(tracker, 210000)
		expect(tracker.learnedCeiling).toBe(200000)
		recordContextRejection(tracker, 190000)
		expect(tracker.learnedCeiling).toBe(190000)
	})

	test('ignores rejections without a reported count', () => {
		const tracker = createContextPressureTracker()
		recordContextRejection(tracker, 0)
		expect(tracker.learnedCeiling).toBeUndefined()
		recordContextRejection(tracker, 200000)
		recordContextRejection(tracker, 0)
		expect(tracker.learnedCeiling).toBe(200000)
	})
})
