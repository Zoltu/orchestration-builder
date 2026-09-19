import { describe, expect, test } from 'bun:test'
import type { Message } from './types.js'
import type { EngineContext } from './engine-state.ts'
import type { LoadedGuild } from './loader.ts'
import { buildInitialHistory } from './context-builder.ts'
import { defined } from './test-fixtures.ts'

const guild: LoadedGuild = {
	config: { entryRole: 'main', roles: {}, tools: [] },
	deployment: {
		model: { name: 'm', apiBase: 'http://x', contextWindow: 32768, generation: {} },
		executor: { maxAgentDepth: 8, defaultToolTimeoutSeconds: 30, maxCompactionAttempts: 5 },
		contextPolicy: { maxToolOutputChars: 4000 },
	},
	prompts: {},
	tools: {},
}

function contextFor(overrides: Partial<EngineContext> = {}): EngineContext {
	return { loadedGuild: guild, depth: 0, roleName: 'main', task: 'do it', ...overrides }
}

function initialMessages(systemPrompt: string, task: string): Message[] {
	return [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: task },
	]
}

describe('buildInitialHistory', () => {
	const continuation = { runId: 'run-20260101-000000', task: 'prior task', summary: 'prior summary' }

	test('without a continuation the user message is exactly the task', () => {
		const history = buildInitialHistory('sys', contextFor())
		expect(history).toEqual(initialMessages('sys', 'do it'))
	})

	test('with a continuation the briefing follows the task in the same user message', () => {
		const history = buildInitialHistory('sys', contextFor({ continuation }))
		expect(history.length).toBe(2)
		const userMessage = defined(history[1], 'initial user message')
		expect(userMessage.role).toBe('user')
		expect(userMessage.content).toBe('do it\n\n[This run continues run run-20260101-000000.] Prior task: prior task\nPrior outcome: prior summary\nThe prior run\'s plan document is available with the read_plan tool (runId: "run-20260101-000000").')
	})

	test('the briefing keeps the operator task as the message\'s first line', () => {
		const history = buildInitialHistory('sys', contextFor({ continuation }))
		const userMessage = defined(history[1], 'initial user message')
		expect(userMessage.content.split('\n', 1)[0]).toBe('do it')
	})

	test('a multi-line task is preserved in full ahead of the briefing', () => {
		const task = 'first line\nsecond line\nthird line'
		const history = buildInitialHistory('sys', contextFor({ task, continuation }))
		const userMessage = defined(history[1], 'initial user message')
		expect(userMessage.content.startsWith(`${task}\n\n`)).toBe(true)
		expect(userMessage.content.split('\n', 1)[0]).toBe('first line')
	})

	test('the briefing names the prior run, its task, its outcome, and the read_plan handle', () => {
		const history = buildInitialHistory('sys', contextFor({ continuation }))
		const userMessage = defined(history[1], 'initial user message')
		expect(userMessage.content).toContain('[This run continues run run-20260101-000000.]')
		expect(userMessage.content).toContain('Prior task: prior task')
		expect(userMessage.content).toContain('Prior outcome: prior summary')
		expect(userMessage.content).toContain('The prior run\'s plan document is available with the read_plan tool (runId: "run-20260101-000000").')
	})

	test('the history keeps a single system message even with effort and continuation set', () => {
		const history = buildInitialHistory('sys', contextFor({ effort: 'standard', continuation }))
		expect(history.length).toBe(2)
		expect(history[0]?.role).toBe('system')
		expect(history[1]?.role).toBe('user')
	})

	test('a child context with an inherited continuation does not receive the briefing', () => {
		const history = buildInitialHistory('child prompt', contextFor({ depth: 1, parent: 'main', continuation }))
		expect(history).toEqual(initialMessages('child prompt', 'do it'))
	})
})
