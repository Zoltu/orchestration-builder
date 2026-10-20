import { describe, expect, test } from 'bun:test'
import { createAnimationFrameCoalescer } from './animation-frame-coalescer.js'
import type { AnimationFrameCoalescer } from './animation-frame-coalescer.js'

interface FakeScheduler {
	schedule: (callback: () => void) => void
	drain(): void
	pendingCount(): number
}

function createFakeScheduler(): FakeScheduler {
	const pending: (() => void)[] = []
	return {
		schedule(callback: () => void): void {
			pending.push(callback)
		},
		drain(): void {
			const callbacks = pending.splice(0)
			for (const callback of callbacks) callback()
		},
		pendingCount(): number {
			return pending.length
		},
	}
}

describe('createAnimationFrameCoalescer', () => {
	test('many requests before a drain schedule only one callback', () => {
		const scheduler = createFakeScheduler()
		let runs = 0
		const coalescer = createAnimationFrameCoalescer(scheduler.schedule, () => {
			runs += 1
		})
		coalescer.request()
		coalescer.request()
		coalescer.request()
		expect(scheduler.pendingCount()).toBe(1)
		scheduler.drain()
		expect(runs).toBe(1)
		expect(scheduler.pendingCount()).toBe(0)
	})

	test('a request from inside the callback schedules one more frame', () => {
		const scheduler = createFakeScheduler()
		let runs = 0
		let requestedAgain = false
		const coalescer: AnimationFrameCoalescer = createAnimationFrameCoalescer(scheduler.schedule, () => {
			runs += 1
			if (requestedAgain) return
			requestedAgain = true
			coalescer.request()
		})
		coalescer.request()
		scheduler.drain()
		expect(runs).toBe(1)
		expect(scheduler.pendingCount()).toBe(1)
		scheduler.drain()
		expect(runs).toBe(2)
		expect(scheduler.pendingCount()).toBe(0)
	})

	test('after a drain a new request schedules again', () => {
		const scheduler = createFakeScheduler()
		let runs = 0
		const coalescer = createAnimationFrameCoalescer(scheduler.schedule, () => {
			runs += 1
		})
		coalescer.request()
		scheduler.drain()
		coalescer.request()
		expect(scheduler.pendingCount()).toBe(1)
		scheduler.drain()
		expect(runs).toBe(2)
	})
})
