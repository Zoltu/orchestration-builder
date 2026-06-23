import { describe, expect, test } from 'bun:test'
import type { LogEvent } from './types.js'
import { createWebHumanBackend } from './human-backend.ts'

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
		const question = pending[0]!

		const result = backend.submitAnswer(question.id, 'use react')
		expect(result.kind).toBe('resolved')

		const answer = await promise
		expect(answer).toBe('use react')
	})

	test('ask carries the question text and optional context into the pending list', () => {
		const backend = createWebHumanBackend()
		backend.ask('Which file?', 'src/index.ts')

		const question = backend.pendingQuestions()[0]!
		expect(question.question).toBe('Which file?')
		expect(question.context).toBe('src/index.ts')
		expect(typeof question.id).toBe('string')
		expect(question.id).not.toBe('')
		expect(typeof question.askedAt).toBe('string')
	})

	test('ask without context omits the context field from the pending question', () => {
		const backend = createWebHumanBackend()
		backend.ask('Just a question')

		const question = backend.pendingQuestions()[0]!
		expect(question.context).toBeUndefined()
	})

	test('an unanswered question stays pending and does not resolve on its own', async () => {
		const backend = createWebHumanBackend()
		let resolved = false
		const promise = backend.ask('Will I time out?').then(() => {
			resolved = true
		})

		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(resolved).toBe(false)
		expect(backend.pendingQuestions().length).toBe(1)

		const question = backend.pendingQuestions()[0]!
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

		const question = backend.pendingQuestions()[0]!
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
		const firstQuestion = pending.find((q) => q.question === 'first?')!
		const secondQuestion = pending.find((q) => q.question === 'second?')!

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
		const question = backend.pendingQuestions()[0]!
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
		expect(log.events[0]!.type).toBe('ask_human')
		expect(log.events[0]!.payload).toMatchObject({ question: 'Which file?', context: 'src/index.ts' })
		expect(typeof (log.events[0]!.payload as { id: unknown }).id).toBe('string')
		expect(typeof log.events[0]!.timestamp).toBe('string')
	})

	test('ask without context omits context from the logged payload', () => {
		const backend = createWebHumanBackend()
		const log = capturingLog()
		backend.bindRunLog(log.append)

		backend.ask('just a question')

		expect(log.events[0]!.payload).not.toHaveProperty('context')
	})

	test('submitAnswer logs a human_answer event carrying the id and answer', async () => {
		const backend = createWebHumanBackend()
		const log = capturingLog()
		backend.bindRunLog(log.append)

		const promise = backend.ask('Which framework?')
		const id = backend.pendingQuestions()[0]!.id
		backend.submitAnswer(id, 'react')
		await promise

		const answerEvent = log.events.find((event) => event.type === 'human_answer')!
		expect(answerEvent).toBeDefined()
		expect(answerEvent.payload).toEqual({ id, answer: 'react' })
	})

	test('the ask_human and human_answer events share the same id so history can pair them', async () => {
		const backend = createWebHumanBackend()
		const log = capturingLog()
		backend.bindRunLog(log.append)

		const promise = backend.ask('q?')
		const id = backend.pendingQuestions()[0]!.id
		backend.submitAnswer(id, 'a')
		await promise

		const askEvent = log.events.find((event) => event.type === 'ask_human')!
		const answerEvent = log.events.find((event) => event.type === 'human_answer')!
		expect((askEvent.payload as { id: string }).id).toBe(id)
		expect((answerEvent.payload as { id: string }).id).toBe(id)
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
		const id = backend.pendingQuestions()[0]!.id
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
