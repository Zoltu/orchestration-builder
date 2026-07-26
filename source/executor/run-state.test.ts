import { describe, expect, test } from 'bun:test'
import { createWebHumanBackend } from './human-backend.ts'
import { createInterruptChannel, createInterruptQueue } from './interrupts.ts'
import { createRunState, type RunState } from './run-state.ts'

function makeRunState() {
	const humanBackend = createWebHumanBackend()
	const interruptChannel = createInterruptChannel()
	const runState = createRunState({ humanBackend, interruptChannel })
	return { humanBackend, interruptChannel, runState }
}

describe('createRunState', () => {
	test('pendingQuestions delegates to the web human backend', () => {
		const { humanBackend, runState } = makeRunState()
		humanBackend.ask('hello?', 'context')

		const pending = runState.pendingQuestions()
		expect(pending.length).toBe(1)
		expect(pending[0]!.question).toBe('hello?')
	})

	test('submitAnswer delegates to the web human backend and resolves the parked promise', async () => {
		const { humanBackend, runState } = makeRunState()

		const promise = humanBackend.ask('which?')
		const [question] = runState.pendingQuestions()

		const result = runState.submitAnswer(question!.id, 'this one')
		expect(result.kind).toBe('resolved')
		expect(await promise).toBe('this one')
		expect(runState.pendingQuestions().length).toBe(0)
	})

	test('submitAnswer for an unknown id surfaces not_found from the backend', () => {
		const { runState } = makeRunState()

		expect(runState.submitAnswer('missing', 'nope')).toEqual({ kind: 'not_found' })
	})

	test('pendingQuestions returns isolated copies that cannot mutate backend state', () => {
		const { humanBackend, runState } = makeRunState()
		humanBackend.ask('original?')

		const snapshot = runState.pendingQuestions()
		snapshot[0]!.question = 'tampered'

		expect(runState.pendingQuestions()[0]!.question).toBe('original?')
	})

	test('a hand-written fake can satisfy the RunState contract', () => {
		const fake: RunState = {
			pendingQuestions: () => [],
			submitAnswer: () => ({ kind: 'not_found' }),
			submitInterrupt: () => 'no_active_run',
			interruptPending: () => false,
		}

		expect(fake.pendingQuestions()).toEqual([])
		expect(fake.submitAnswer('any', 'any')).toEqual({ kind: 'not_found' })
	})
})

describe('createRunState — interrupt channel', () => {
	test('submitInterrupt reports no_active_run when no queue is bound', () => {
		const { runState } = makeRunState()

		expect(runState.submitInterrupt({ kind: 'inquiry', message: 'hello' })).toBe('no_active_run')
		expect(runState.interruptPending()).toBe(false)
	})

	test('submitInterrupt queues the request on the bound run queue and pending reflects it', () => {
		const { interruptChannel, runState } = makeRunState()
		const queue = createInterruptQueue()
		interruptChannel.bindQueue(queue)

		expect(runState.submitInterrupt({ kind: 'plan_modification', message: 'change course' })).toBe('accepted')
		expect(runState.interruptPending()).toBe(true)
		expect(queue.drain()).toEqual({ kind: 'plan_modification', message: 'change course' })
		expect(runState.interruptPending()).toBe(false)
	})

	test('unbinding the queue restores no_active_run', () => {
		const { interruptChannel, runState } = makeRunState()
		interruptChannel.bindQueue(createInterruptQueue())
		interruptChannel.bindQueue(null)

		expect(runState.submitInterrupt({ kind: 'inquiry', message: 'hello' })).toBe('no_active_run')
		expect(runState.interruptPending()).toBe(false)
	})
})
