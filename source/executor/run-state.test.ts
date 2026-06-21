import { describe, expect, test } from 'bun:test'
import { createWebHumanBackend } from './human-backend.ts'
import { createRunState, type RunState } from './run-state.ts'

describe('createRunState', () => {
	test('pendingQuestions delegates to the web human backend', () => {
		const backend = createWebHumanBackend()
		backend.ask('hello?', 'context')

		const runState = createRunState({ humanBackend: backend })
		const pending = runState.pendingQuestions()
		expect(pending.length).toBe(1)
		expect(pending[0]!.question).toBe('hello?')
	})

	test('submitAnswer delegates to the web human backend and resolves the parked promise', async () => {
		const backend = createWebHumanBackend()
		const runState = createRunState({ humanBackend: backend })

		const promise = backend.ask('which?')
		const [question] = runState.pendingQuestions()

		const result = runState.submitAnswer(question!.id, 'this one')
		expect(result.kind).toBe('resolved')
		expect(await promise).toBe('this one')
		expect(runState.pendingQuestions().length).toBe(0)
	})

	test('submitAnswer for an unknown id surfaces not_found from the backend', () => {
		const backend = createWebHumanBackend()
		const runState = createRunState({ humanBackend: backend })

		expect(runState.submitAnswer('missing', 'nope')).toEqual({ kind: 'not_found' })
	})

	test('pendingQuestions returns isolated copies that cannot mutate backend state', () => {
		const backend = createWebHumanBackend()
		backend.ask('original?')
		const runState = createRunState({ humanBackend: backend })

		const snapshot = runState.pendingQuestions()
		snapshot[0]!.question = 'tampered'

		expect(runState.pendingQuestions()[0]!.question).toBe('original?')
	})

	test('a hand-written fake can satisfy the RunState contract', () => {
		const fake: RunState = {
			pendingQuestions: () => [],
			submitAnswer: () => ({ kind: 'not_found' }),
		}

		expect(fake.pendingQuestions()).toEqual([])
		expect(fake.submitAnswer('any', 'any')).toEqual({ kind: 'not_found' })
	})
})
