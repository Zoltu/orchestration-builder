import { describe, expect, test } from 'bun:test'
import type { Message } from '../shared/types.js'
import { stripReasoning, truncateToolOutput } from './context-policy.ts'

describe('truncateToolOutput', () => {
	test('returns the text unchanged when under the limit', () => {
		const result = truncateToolOutput('hello', 100)
		expect(result).toEqual({ text: 'hello', truncated: false, removedChars: 0 })
	})

	test('returns the text unchanged when exactly at the limit', () => {
		const result = truncateToolOutput('hello', 5)
		expect(result).toEqual({ text: 'hello', truncated: false, removedChars: 0 })
	})

	test('truncates and reports removedChars when over the limit', () => {
		const result = truncateToolOutput('hello world', 5)
		expect(result.truncated).toBe(true)
		expect(result.removedChars).toBe(6)
		expect(result.text.startsWith('hello')).toBe(true)
		expect(result.text.includes('[truncated: 6 chars removed]')).toBe(true)
	})

	test('returns empty text for empty input', () => {
		const result = truncateToolOutput('', 100)
		expect(result).toEqual({ text: '', truncated: false, removedChars: 0 })
	})

	test('treats maxChars=0 as immediate truncation', () => {
		const result = truncateToolOutput('hello', 0)
		expect(result.truncated).toBe(true)
		expect(result.removedChars).toBe(5)
		expect(result.text).toBe('')
	})

	test('treats negative maxChars as immediate truncation', () => {
		const result = truncateToolOutput('hi', -1)
		expect(result.truncated).toBe(true)
		expect(result.removedChars).toBe(2)
	})

	test('empty input with maxChars=0 is not marked as truncated', () => {
		const result = truncateToolOutput('', 0)
		expect(result.truncated).toBe(false)
		expect(result.removedChars).toBe(0)
	})
})

describe('stripReasoning', () => {
	const messages: Message[] = [
		{ role: 'system', content: 'sys', reasoning: null },
		{ role: 'user', content: 'u1' },
		{ role: 'assistant', content: 'a1', reasoning: 'r1' },
		{ role: 'tool', content: 't1', tool_call_id: 'x' },
		{ role: 'assistant', content: 'a2', reasoning: 'r2' },
		{ role: 'assistant', content: 'a3', reasoning: null },
	]

	test('strips reasoning from all messages by default', () => {
		const result = stripReasoning(messages)
		expect(result.every((m) => m.reasoning === undefined || m.reasoning === null)).toBe(true)
	})

	test('strips reasoning only within the given range', () => {
		const result = stripReasoning(messages, 2, 4)
		expect(result[0]?.reasoning).toBeNull()
		expect(result[1]?.reasoning).toBeUndefined()
		expect(result[2]?.reasoning).toBeNull()
		expect(result[3]?.reasoning).toBeUndefined()
		expect(result[4]?.reasoning).toBe('r2')
		expect(result[5]?.reasoning).toBeNull()
	})

	test('leaves the array unchanged when range excludes messages with reasoning', () => {
		const result = stripReasoning(messages, 0, 1)
		expect(result[2]?.reasoning).toBe('r1')
		expect(result[4]?.reasoning).toBe('r2')
	})

	test('does not mutate the original array', () => {
		const original: Message[] = [
			{ role: 'assistant', content: 'a1', reasoning: 'r1' },
		]
		const result = stripReasoning(original)
		expect(original[0]?.reasoning).toBe('r1')
		expect(result[0]?.reasoning).toBeNull()
	})

	test('returns a new array reference', () => {
		const result = stripReasoning(messages)
		expect(result).not.toBe(messages)
	})

	test('leaves messages without reasoning untouched', () => {
		const input: Message[] = [{ role: 'user', content: 'u' }]
		const result = stripReasoning(input)
		expect(result[0]?.reasoning).toBeUndefined()
	})
})
