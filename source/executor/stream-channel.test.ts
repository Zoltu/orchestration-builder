import { describe, expect, test } from 'bun:test'
import { createDeltaChannel, type DeltaChannel, type RunDelta } from './stream-channel.ts'

describe('createDeltaChannel', () => {
	test('publish stamps the bound run id and delivers the delta to subscribers', () => {
		const channel: DeltaChannel = createDeltaChannel()
		const seen: RunDelta[] = []
		channel.subscribe((delta) => seen.push(delta))
		channel.bindRun('run-1')

		channel.publish({ roleId: 'main-0-1', role: 'main', field: 'content', text: 'Hello' })

		expect(seen).toEqual([{ roleId: 'main-0-1', role: 'main', field: 'content', text: 'Hello', runId: 'run-1' }])
	})

	test('a reset delta carries the flag through to subscribers', () => {
		const channel = createDeltaChannel()
		const seen: RunDelta[] = []
		channel.subscribe((delta) => seen.push(delta))
		channel.bindRun('run-1')

		channel.publish({ roleId: 'main-0-1', role: 'main', field: 'content', text: '', reset: true })

		expect(seen).toEqual([{ roleId: 'main-0-1', role: 'main', field: 'content', text: '', reset: true, runId: 'run-1' }])
	})

	test('publishing while unbound is a silent no-op', () => {
		const channel = createDeltaChannel()
		const seen: RunDelta[] = []
		channel.subscribe((delta) => seen.push(delta))

		expect(() => channel.publish({ roleId: 'r', role: 'main', field: 'reasoning', text: 'thin' })).not.toThrow()
		expect(seen).toEqual([])
	})

	test('publishing with no subscribers is a silent no-op', () => {
		const channel = createDeltaChannel()
		channel.bindRun('run-1')

		expect(() => channel.publish({ roleId: 'r', role: 'main', field: 'content', text: 'hi' })).not.toThrow()
	})

	test('a rebound run restamps subsequent publishes', () => {
		const channel = createDeltaChannel()
		const seen: RunDelta[] = []
		channel.subscribe((delta) => seen.push(delta))
		channel.bindRun('run-1')
		channel.publish({ roleId: 'r', role: 'main', field: 'content', text: 'one' })
		channel.bindRun('run-2')
		channel.publish({ roleId: 'r', role: 'main', field: 'content', text: 'two' })

		expect(seen.map((delta) => delta.runId)).toEqual(['run-1', 'run-2'])
	})

	test('unbinding stops delivery without throwing', () => {
		const channel = createDeltaChannel()
		const seen: RunDelta[] = []
		channel.subscribe((delta) => seen.push(delta))
		channel.bindRun('run-1')
		channel.bindRun(null)
		channel.publish({ roleId: 'r', role: 'main', field: 'content', text: 'after' })

		expect(seen).toEqual([])
	})

	test('an unsubscribe callback stops that subscriber only', () => {
		const channel = createDeltaChannel()
		const first: RunDelta[] = []
		const second: RunDelta[] = []
		const unsubscribeFirst = channel.subscribe((delta) => first.push(delta))
		channel.subscribe((delta) => second.push(delta))
		channel.bindRun('run-1')
		unsubscribeFirst()
		channel.publish({ roleId: 'r', role: 'main', field: 'content', text: 'hi' })

		expect(first).toEqual([])
		expect(second).toEqual([{ roleId: 'r', role: 'main', field: 'content', text: 'hi', runId: 'run-1' }])
	})

	test('a throwing subscriber neither breaks publish nor starves the others', () => {
		const channel = createDeltaChannel()
		const seen: RunDelta[] = []
		channel.subscribe(() => {
			throw new Error('subscriber exploded')
		})
		channel.subscribe((delta) => seen.push(delta))
		channel.bindRun('run-1')

		expect(() => channel.publish({ roleId: 'r', role: 'main', field: 'reasoning', text: 'thin' })).not.toThrow()
		expect(seen).toEqual([{ roleId: 'r', role: 'main', field: 'reasoning', text: 'thin', runId: 'run-1' }])
	})
})
