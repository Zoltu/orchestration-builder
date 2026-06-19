import { describe, expect, test } from 'bun:test'
import { createHumanBackend } from './human-backend.ts'

describe('createHumanBackend (stub mode)', () => {
	test('returns the stub answer regardless of question', async () => {
		const backend = createHumanBackend({ mode: 'stub' })
		const answer = await backend.ask('What framework should I use?')
		expect(answer).toBe('use your best judgement')
	})

	test('returns the stub answer when context is provided', async () => {
		const backend = createHumanBackend({ mode: 'stub' })
		const answer = await backend.ask('Which file?', 'src/foo.ts')
		expect(answer).toBe('use your best judgement')
	})

	test('stub backend ignores context entirely', async () => {
		const backend = createHumanBackend({ mode: 'stub' })
		const a1 = await backend.ask('question one', undefined)
		const a2 = await backend.ask('question two', 'lots of context')
		expect(a1).toBe(a2)
	})
})