import { describe, expect, test } from 'bun:test'
import { createOperatorPauseChannel, createOperatorPauseQueue } from './operator-pause.ts'
import type { OperatorPauseRecord } from './types.ts'

const first: OperatorPauseRecord = { message: 'The operator paused this run.', pausedAt: '2026-01-01T00:02:00.000Z' }
const second: OperatorPauseRecord = { message: 'The operator paused this run.', pausedAt: '2026-01-01T00:03:00.000Z' }

describe('createOperatorPauseQueue', () => {
	test('queues the first request only, so a repeat cannot move the pause time', () => {
		const queue = createOperatorPauseQueue()

		queue.request(first)
		queue.request(second)

		expect(queue.consume()).toEqual(first)
		expect(queue.consume()).toBeUndefined()
	})

	test('accepts a new request after the previous one is consumed', () => {
		const queue = createOperatorPauseQueue()

		queue.request(first)
		expect(queue.consume()).toEqual(first)
		queue.request(second)

		expect(queue.consume()).toEqual(second)
	})
})

describe('createOperatorPauseChannel', () => {
	test('reports no_active_run with no bound queue and accepts once a queue is bound', () => {
		const channel = createOperatorPauseChannel()

		expect(channel.submit(first)).toBe('no_active_run')

		const queue = createOperatorPauseQueue()
		channel.bindQueue(queue)

		expect(channel.submit(first)).toBe('accepted')
		expect(queue.consume()).toEqual(first)
		expect(queue.consume()).toBeUndefined()
	})

	test('stops accepting once the queue is unbound', () => {
		const channel = createOperatorPauseChannel()
		const queue = createOperatorPauseQueue()
		channel.bindQueue(queue)
		channel.bindQueue(null)

		expect(channel.submit(first)).toBe('no_active_run')
		expect(queue.consume()).toBeUndefined()
	})
})
