import { describe, expect, test } from 'bun:test'
import { createPollGuard } from './poll-guard.js'

describe('createPollGuard', () => {
	test('allows the first poll and refuses one while in flight', () => {
		const guard = createPollGuard()
		expect(guard.tryStart(0)).toBe(true)
		expect(guard.tryStart(0)).toBe(false)
	})

	test('allows a new poll after the previous one succeeded', () => {
		const guard = createPollGuard()
		expect(guard.tryStart(0)).toBe(true)
		guard.succeeded()
		expect(guard.tryStart(0)).toBe(true)
	})

	test('refuses before the retry time and allows once it is reached', () => {
		const guard = createPollGuard()
		expect(guard.tryStart(0)).toBe(true)
		guard.failed(1000)
		expect(guard.tryStart(2999)).toBe(false)
		expect(guard.tryStart(3000)).toBe(true)
	})

	test('grows the retry window exponentially and caps it', () => {
		const guard = createPollGuard()
		expect(guard.tryStart(0)).toBe(true)
		guard.failed(1000)
		expect(guard.tryStart(2999)).toBe(false)
		expect(guard.tryStart(3000)).toBe(true)
		guard.failed(3000)
		expect(guard.tryStart(6999)).toBe(false)
		expect(guard.tryStart(7000)).toBe(true)
		guard.failed(7000)
		expect(guard.tryStart(14999)).toBe(false)
		expect(guard.tryStart(15000)).toBe(true)
		guard.failed(15000)
		expect(guard.tryStart(30999)).toBe(false)
		expect(guard.tryStart(31000)).toBe(true)
		guard.failed(31000)
		expect(guard.tryStart(60999)).toBe(false)
		expect(guard.tryStart(61000)).toBe(true)
	})

	test('success resets the failure count and retry time', () => {
		const guard = createPollGuard()
		expect(guard.tryStart(0)).toBe(true)
		guard.failed(0)
		expect(guard.tryStart(1999)).toBe(false)
		expect(guard.tryStart(2000)).toBe(true)
		guard.failed(2000)
		expect(guard.tryStart(5999)).toBe(false)
		expect(guard.tryStart(6000)).toBe(true)
		guard.succeeded()
		expect(guard.tryStart(6000)).toBe(true)
		guard.failed(6000)
		expect(guard.tryStart(7999)).toBe(false)
		expect(guard.tryStart(8000)).toBe(true)
	})
})
