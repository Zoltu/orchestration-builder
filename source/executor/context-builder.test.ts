import { describe, expect, test } from 'bun:test'
import type { Message, RoleDefinition } from './types.js'
import type { EngineContext } from './engine-state.ts'
import type { LoadedGuild } from './loader.ts'
import { buildInitialHistory, buildMessages } from './context-builder.ts'
import { defined } from './test-fixtures.ts'

const role: RoleDefinition = { systemPrompt: 'p', tools: ['finish'] }

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

describe('buildMessages', () => {
	test('returns the messages array as-is when includeReasoning is true', () => {
		const withReasoning: RoleDefinition = { ...role, includeReasoning: true }
		const messages = initialMessages('You are helpful.', 'Do a thing.')
		const result = buildMessages(withReasoning, messages)
		expect(result).toBe(messages)
	})

	test('returns the messages array unchanged when no reasoning fields are present', () => {
		const messages = initialMessages('sys', 'task')
		const result = buildMessages(role, messages)
		expect(result.length).toBe(2)
		expect(result[0]?.role).toBe('system')
		expect(result[1]?.role).toBe('user')
	})

	test('strips reasoning from assistant messages starting at index 2 when includeReasoning is false', () => {
		const messages: Message[] = [
			...initialMessages('sys', 'task'),
			{ role: 'assistant', content: 'a1', reasoning: 'r1' },
			{ role: 'tool', content: 't1', tool_call_id: 'x' },
			{ role: 'assistant', content: 'a2', reasoning: 'r2' },
		]
		const result = buildMessages(role, messages)
		expect(result.length).toBe(5)
		expect(result[2]?.reasoning).toBeNull()
		expect(result[3]?.reasoning).toBeUndefined()
		expect(result[4]?.reasoning).toBeNull()
	})

	test('leaves reasoning on assistant messages untouched when includeReasoning is true', () => {
		const withReasoning: RoleDefinition = { systemPrompt: 'p', tools: ['finish'], includeReasoning: true }
		const messages: Message[] = [
			...initialMessages('sys', 'task'),
			{ role: 'assistant', content: 'a1', reasoning: 'r1' },
		]
		const result = buildMessages(withReasoning, messages)
		expect(result[2]?.reasoning).toBe('r1')
	})

	test('does not mutate the messages array', () => {
		const messages: Message[] = [
			...initialMessages('sys', 'task'),
			{ role: 'assistant', content: 'a1', reasoning: 'r1' },
		]
		buildMessages(role, messages)
		expect(messages[2]?.reasoning).toBe('r1')
	})

	test('returns a new array reference when reasoning is stripped', () => {
		const messages: Message[] = [
			...initialMessages('sys', 'task'),
			{ role: 'assistant', content: 'a1', reasoning: 'r1' },
		]
		const result = buildMessages(role, messages)
		expect(result).not.toBe(messages)
	})

	test('returns the same reference when includeReasoning is true and no strip is needed', () => {
		const messages = initialMessages('sys', 'task')
		const result = buildMessages({ ...role, includeReasoning: true }, messages)
		expect(result).toBe(messages)
	})

	test('keeps reasoning as null without stripping when includeReasoning is on', () => {
		const withReasoning: RoleDefinition = { systemPrompt: 'p', tools: ['finish'], includeReasoning: true }
		const messages: Message[] = [
			...initialMessages('sys', 'task'),
			{ role: 'assistant', content: 'a1', reasoning: null },
		]
		const result = buildMessages(withReasoning, messages)
		expect(result[2]?.reasoning).toBeNull()
	})
})

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
