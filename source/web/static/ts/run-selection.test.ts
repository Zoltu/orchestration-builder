import { describe, expect, test } from 'bun:test'
import { planSameRunView } from './run-selection.js'

describe('planSameRunView', () => {
	test('reactivates a run whose summary is non-terminal', () => {
		expect(planSameRunView({ summaryStatus: 'running', currentStatus: 'success', heldViewStatus: 'success' })).toBe('reactivate')
		expect(planSameRunView({ summaryStatus: 'unknown', currentStatus: null, heldViewStatus: null })).toBe('reactivate')
	})

	test('refreshes when the held view status is stale', () => {
		expect(planSameRunView({ summaryStatus: 'success', currentStatus: 'success', heldViewStatus: 'running' })).toBe('refresh')
		expect(planSameRunView({ summaryStatus: 'error', currentStatus: 'error', heldViewStatus: 'success' })).toBe('refresh')
	})

	test('refreshes a terminal summary with no held view', () => {
		expect(planSameRunView({ summaryStatus: 'success', currentStatus: 'success', heldViewStatus: null })).toBe('refresh')
	})

	test('refreshes when the held status has not caught up with the summary', () => {
		expect(planSameRunView({ summaryStatus: 'success', currentStatus: null, heldViewStatus: 'success' })).toBe('refresh')
		expect(planSameRunView({ summaryStatus: 'success', currentStatus: 'running', heldViewStatus: 'running' })).toBe('refresh')
	})

	test('shows the held view when its status matches a terminal summary', () => {
		expect(planSameRunView({ summaryStatus: 'success', currentStatus: 'success', heldViewStatus: 'success' })).toBe('show')
		expect(planSameRunView({ summaryStatus: 'interrupted', currentStatus: 'interrupted', heldViewStatus: 'interrupted' })).toBe('show')
	})
})
