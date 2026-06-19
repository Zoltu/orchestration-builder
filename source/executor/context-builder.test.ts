import { describe, expect, test } from 'bun:test'
import type { Message, RoleDefinition } from '../shared/types.js'
import { buildMessages } from './context-builder.ts'

const role: RoleDefinition = { systemPrompt: 'p', tools: ['finish'] }

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