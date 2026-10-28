import { describe, expect, test } from 'bun:test'
import { isLiveStatus, isSettledForPolling, isSuspendedStatus, isTerminalStatus } from './interaction-model.js'

describe('suspended status vocabulary', () => {
	test('suspended is its own status, never terminal and never live', () => {
		expect(isSuspendedStatus('suspended')).toBe(true)
		expect(isTerminalStatus('suspended')).toBe(false)
		expect(isLiveStatus('suspended')).toBe(false)
	})

	test('only running is live', () => {
		expect(isLiveStatus('running')).toBe(true)
		for (const status of ['suspended', 'success', 'error', 'needs_clarification', 'interrupted', 'unknown', '']) {
			expect(isLiveStatus(status)).toBe(false)
		}
	})

	test('terminal outcomes and suspended are settled for per-run polling; running and unknown are not', () => {
		for (const status of ['success', 'error', 'needs_clarification', 'interrupted', 'suspended']) {
			expect(isSettledForPolling(status)).toBe(true)
		}
		for (const status of ['running', 'unknown', '']) {
			expect(isSettledForPolling(status)).toBe(false)
		}
	})
})
