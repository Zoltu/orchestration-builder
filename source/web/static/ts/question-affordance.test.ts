import { describe, expect, test } from 'bun:test'
import { createQuestionActivationHandlers, deriveActiveQuestionControls } from './question-affordance.js'
import { scenarios } from './scenarios.js'

function scenarioFrame(scenarioId: string, frameIndex: number) {
	const scenario = scenarios.find((item) => item.id === scenarioId)
	if (scenario === undefined) throw new Error(`unknown scenario: ${scenarioId}`)
	const frame = scenario.frames[frameIndex]
	if (frame === undefined) throw new Error(`scenario ${scenarioId} has no frame ${frameIndex}`)
	return frame
}

interface EventCounters {
	prevented: number
	stopped: number
}

function testEvent(type: string, key: string | null, counters: EventCounters): Event {
	const event = new Event(type)
	if (key !== null) Object.defineProperty(event, 'key', { value: key })
	Object.defineProperty(event, 'preventDefault', { value: () => { counters.prevented += 1 } })
	Object.defineProperty(event, 'stopPropagation', { value: () => { counters.stopped += 1 } })
	return event
}

describe('shared question activation', () => {
	test('the click handler stops propagation and forwards to the unified question handler', () => {
		let clicks = 0
		const counters = { prevented: 0, stopped: 0 }
		const handlers = createQuestionActivationHandlers<{ route: string }>(() => { clicks += 1 })
		const state = { route: 'click-test' }
		handlers.onclick(state, testEvent('click', null, counters))
		expect(clicks).toBe(1)
		expect(counters.stopped).toBe(1)
	})

	test('Enter and Space activate, while every other key returns the incoming state unchanged', () => {
		let clicks = 0
		const counters = { prevented: 0, stopped: 0 }
		const handlers = createQuestionActivationHandlers<{ route: string }>(() => { clicks += 1 })
		const state = { route: 'keyboard-test' }

		expect(handlers.onkeydown(state, testEvent('keydown', 'Tab', counters))).toBe(state)
		expect(handlers.onkeydown(state, testEvent('keydown', 'a', counters))).toBe(state)
		expect(clicks).toBe(0)
		expect(counters.prevented).toBe(0)
		expect(counters.stopped).toBe(0)

		handlers.onkeydown(state, testEvent('keydown', 'Enter', counters))
		handlers.onkeydown(state, testEvent('keydown', ' ', counters))
		expect(clicks).toBe(2)
		expect(counters.prevented).toBe(2)
		expect(counters.stopped).toBe(2)
	})

	test('an event without a key is a no-op that returns the incoming state', () => {
		let clicks = 0
		const counters = { prevented: 0, stopped: 0 }
		const handlers = createQuestionActivationHandlers<{ route: string }>(() => { clicks += 1 })
		const state = { route: 'non-key-event' }
		const result = handlers.onkeydown(state, testEvent('keydown', null, counters))
		expect(result).toBe(state)
		expect(clicks).toBe(0)
	})
})

describe('demo question gating', () => {
	test('the question control exists only on a frame whose active operation is an in-flight ask_human', () => {
		const handler = () => undefined
		const pending = scenarioFrame('pending-question', 2)
		const controls = deriveActiveQuestionControls(pending, handler)
		expect(controls).toBeDefined()
		if (controls === undefined) throw new Error('expected pending question controls')
		expect(controls.onclick).toBe(handler)

		expect(deriveActiveQuestionControls(scenarioFrame('pending-question', 0), handler)).toBeUndefined()
		expect(deriveActiveQuestionControls(scenarioFrame('pending-question', 5), handler)).toBeUndefined()
	})

	test('deriving the control does not invoke the question handler', () => {
		let clicks = 0
		deriveActiveQuestionControls(scenarioFrame('pending-question', 2), () => { clicks += 1 })
		expect(clicks).toBe(0)
	})
})
