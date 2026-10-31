import { describe, expect, test } from 'bun:test'
import { createStateInvalidationChannel, type StateInvalidationChannel } from './state-invalidation-channel.ts'

describe('createStateInvalidationChannel', () => {
	test('publish notifies every subscriber', () => {
		const channel: StateInvalidationChannel = createStateInvalidationChannel()
		let firstCount = 0
		let secondCount = 0
		channel.subscribe(() => {
			firstCount += 1
		})
		channel.subscribe(() => {
			secondCount += 1
		})

		channel.publish()

		expect(firstCount).toBe(1)
		expect(secondCount).toBe(1)
	})

	test('publishing with no subscribers is a silent no-op', () => {
		const channel = createStateInvalidationChannel()

		expect(() => channel.publish()).not.toThrow()
	})

	test('an unsubscribe callback stops that subscriber only', () => {
		const channel = createStateInvalidationChannel()
		let firstCount = 0
		let secondCount = 0
		const unsubscribeFirst = channel.subscribe(() => {
			firstCount += 1
		})
		channel.subscribe(() => {
			secondCount += 1
		})
		unsubscribeFirst()

		channel.publish()

		expect(firstCount).toBe(0)
		expect(secondCount).toBe(1)
	})

	test('a throwing subscriber neither breaks publish nor starves the others', () => {
		const channel = createStateInvalidationChannel()
		let deliveredCount = 0
		channel.subscribe(() => {
			throw new Error('subscriber exploded')
		})
		channel.subscribe(() => {
			deliveredCount += 1
		})

		expect(() => channel.publish()).not.toThrow()
		expect(deliveredCount).toBe(1)
	})
})
