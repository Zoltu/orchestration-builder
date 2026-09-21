import { describe, expect, test } from 'bun:test'
import type { LogEvent } from './types.js'
import { createWebHumanBackend } from './human-backend.ts'
import { defined, flushMicrotasks } from './test-fixtures.ts'
import { isObject } from './validation.ts'

describe('createWebHumanBackend', () => {
	test('returns a backend with an ask function', () => {
		const backend = createWebHumanBackend()
		expect(typeof backend.ask).toBe('function')
	})

	test('ask registers a pending question and resolves with the answer submitted for its id', async () => {
		const backend = createWebHumanBackend()
		const promise = backend.ask('Which framework?')

		const pending = backend.pendingQuestions()
		expect(pending.length).toBe(1)
		const question = defined(pending[0], 'first pending question')

		const result = backend.submitAnswer(question.id, 'use react')
		expect(result.kind).toBe('resolved')

		const answer = await promise
		expect(answer).toBe('use react')
	})

	test('ask carries the question text and optional context into the pending list', () => {
		const backend = createWebHumanBackend()
		backend.ask('Which file?', 'src/index.ts')

		const question = defined(backend.pendingQuestions()[0], 'first pending question')
		expect(question.question).toBe('Which file?')
		expect(question.context).toBe('src/index.ts')
		expect(typeof question.id).toBe('string')
		expect(question.id).not.toBe('')
		expect(typeof question.askedAt).toBe('string')
	})

	test('ask without context omits the context field from the pending question', () => {
		const backend = createWebHumanBackend()
		backend.ask('Just a question')

		const question = defined(backend.pendingQuestions()[0], 'first pending question')
		expect(question.context).toBeUndefined()
	})

	test('an unanswered question stays pending and does not resolve on its own', async () => {
		const backend = createWebHumanBackend()
		let resolved = false
		const promise = backend.ask('Will I time out?').then(() => {
			resolved = true
		})

		// The backend arms no timer of its own — the ask promise settles only through submitAnswer — so a microtask drain is the complete opportunity for it to resolve on its own.
		await flushMicrotasks()
		expect(resolved).toBe(false)
		expect(backend.pendingQuestions().length).toBe(1)

		const question = defined(backend.pendingQuestions()[0], 'first pending question')
		backend.submitAnswer(question.id, 'no')
		await promise

		expect(resolved).toBe(true)
		expect(backend.pendingQuestions().length).toBe(0)
	})

	test('submitAnswer for an unknown id returns not_found and does not throw', () => {
		const backend = createWebHumanBackend()
		const result = backend.submitAnswer('does-not-exist', 'whatever')
		expect(result).toEqual({ kind: 'not_found' })
	})

	test('submitAnswer removes the question so a second submit for the same id is not_found', async () => {
		const backend = createWebHumanBackend()
		const promise = backend.ask('q')

		const question = defined(backend.pendingQuestions()[0], 'first pending question')
		const first = backend.submitAnswer(question.id, 'a')
		expect(first.kind).toBe('resolved')

		const second = backend.submitAnswer(question.id, 'a')
		expect(second).toEqual({ kind: 'not_found' })

		await promise
	})

	test('multiple pending questions resolve independently to their own answers', async () => {
		const backend = createWebHumanBackend()
		const firstPromise = backend.ask('first?')
		const secondPromise = backend.ask('second?')

		const pending = backend.pendingQuestions()
		expect(pending.length).toBe(2)
		const firstQuestion = defined(pending.find((q) => q.question === 'first?'), 'first? question')
		const secondQuestion = defined(pending.find((q) => q.question === 'second?'), 'second? question')

		backend.submitAnswer(secondQuestion.id, 'answer two')
		backend.submitAnswer(firstQuestion.id, 'answer one')

		expect(await firstPromise).toBe('answer one')
		expect(await secondPromise).toBe('answer two')
	})

	test('each pending question gets a unique id', () => {
		const backend = createWebHumanBackend()
		backend.ask('one?')
		backend.ask('two?')

		const pending = backend.pendingQuestions()
		const ids = pending.map((q) => q.id)
		expect(new Set(ids).size).toBe(ids.length)
	})

	test('pendingQuestions returns a fresh array reflecting current state each call', () => {
		const backend = createWebHumanBackend()
		backend.ask('q1')

		const first = backend.pendingQuestions()
		backend.ask('q2')

		const second = backend.pendingQuestions()
		expect(first.length).toBe(1)
		expect(second.length).toBe(2)
	})

	test('the resolved answer is a string, matching the result shape seen by the model', async () => {
		const backend = createWebHumanBackend()
		const promise = backend.ask('q')
		const question = defined(backend.pendingQuestions()[0], 'first pending question')
		backend.submitAnswer(question.id, 'web answer')

		const answer = await promise
		expect(typeof answer).toBe('string')
		expect(answer).toBe('web answer')
	})
})

describe('createWebHumanBackend run-log binding', () => {
	function capturingLog(): { events: LogEvent[]; append: (event: LogEvent) => void } {
		const events: LogEvent[] = []
		return { events, append: (event) => { events.push(event) } }
	}

	test('ask logs an ask_human event with the id, question, and context when a run log is bound', () => {
		const backend = createWebHumanBackend()
		const log = capturingLog()
		backend.bindRunLog(log.append)

		backend.ask('Which file?', 'src/index.ts')

		expect(log.events.length).toBe(1)
		const askEvent = defined(log.events[0], 'ask_human event')
		expect(askEvent.type).toBe('ask_human')
		expect(askEvent.payload).toMatchObject({ question: 'Which file?', context: 'src/index.ts' })
		const askPayload = askEvent.payload
		if (!isObject(askPayload)) throw new Error('expected the ask_human payload to be an object')
		expect(typeof askPayload['id']).toBe('string')
		expect(typeof askEvent.timestamp).toBe('string')
	})

	test('ask without context omits context from the logged payload', () => {
		const backend = createWebHumanBackend()
		const log = capturingLog()
		backend.bindRunLog(log.append)

		backend.ask('just a question')

		expect(defined(log.events[0], 'ask_human event').payload).not.toHaveProperty('context')
	})

	test('submitAnswer logs a human_answer event carrying the id and answer', async () => {
		const backend = createWebHumanBackend()
		const log = capturingLog()
		backend.bindRunLog(log.append)

		const promise = backend.ask('Which framework?')
		const id = defined(backend.pendingQuestions()[0], 'first pending question').id
		backend.submitAnswer(id, 'react')
		await promise

		const answerEvent = defined(log.events.find((event) => event.type === 'human_answer'), 'human_answer event')
		expect(answerEvent).toBeDefined()
		expect(answerEvent.payload).toEqual({ id, answer: 'react' })
	})

	test('the ask_human and human_answer events share the same id so history can pair them', async () => {
		const backend = createWebHumanBackend()
		const log = capturingLog()
		backend.bindRunLog(log.append)

		const promise = backend.ask('q?')
		const id = defined(backend.pendingQuestions()[0], 'first pending question').id
		backend.submitAnswer(id, 'a')
		await promise

		const askEvent = defined(log.events.find((event) => event.type === 'ask_human'), 'ask_human event')
		const answerEvent = defined(log.events.find((event) => event.type === 'human_answer'), 'human_answer event')
		if (!isObject(askEvent.payload) || !isObject(answerEvent.payload)) throw new Error('expected the human events to carry object payloads')
		expect(askEvent.payload['id']).toBe(id)
		expect(answerEvent.payload['id']).toBe(id)
	})

	test('submitAnswer for an unknown id does not log a human_answer event', () => {
		const backend = createWebHumanBackend()
		const log = capturingLog()
		backend.bindRunLog(log.append)

		backend.submitAnswer('does-not-exist', 'nope')

		expect(log.events).toEqual([])
	})

	test('does not log anything when no run log is bound', async () => {
		const backend = createWebHumanBackend()

		const promise = backend.ask('q?')
		const id = defined(backend.pendingQuestions()[0], 'first pending question').id
		backend.submitAnswer(id, 'a')
		await promise

		expect(backend.pendingQuestions()).toEqual([])
	})

	test('binding null after a run clears the log so a later ask logs nothing', () => {
		const backend = createWebHumanBackend()
		const log = capturingLog()
		backend.bindRunLog(log.append)
		backend.bindRunLog(null)

		backend.ask('q?')

		expect(log.events).toEqual([])
	})
})
