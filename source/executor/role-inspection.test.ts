import { describe, expect, test } from 'bun:test'
import type { Message } from './types.js'
import { hashArguments, indexRoleMessages, MAX_SEARCH_MATCHES, MAX_WINDOW_CHARS, readMessageWindow, searchRoleBlocks } from './role-inspection.ts'
import { defined } from './test-fixtures.ts'

function fixtureHistory(): Message[] {
	return [
		{ role: 'system', content: 'you are the coder' },
		{ role: 'user', content: 'build the thing' },
		{ role: 'assistant', content: 'I will read the file first.', reasoning: 'planning planning planning' },
		{ role: 'tool', content: '{"kind":"success"}', tool_call_id: 't1' },
		{
			role: 'assistant',
			content: 'reading done',
			reasoning: 'the same thought the same thought the same thought',
			tool_calls: [{ id: 't2', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
		},
		{ role: 'user', content: 'needle in a haystack needle' },
	]
}

describe('indexRoleMessages', () => {
	test('reports per-message role, char counts, and tool-call count', () => {
		const index = indexRoleMessages(fixtureHistory())
		expect(index.length).toBe(6)
		expect(index[0]).toEqual({ index: 0, role: 'system', contentChars: 17, reasoningChars: 0, toolCallCount: 0 })
		expect(index[2]).toEqual({ index: 2, role: 'assistant', contentChars: 27, reasoningChars: 26, toolCallCount: 0 })
		expect(index[4]).toEqual({ index: 4, role: 'assistant', contentChars: 12, reasoningChars: 50, toolCallCount: 1 })
	})
})

describe('readMessageWindow', () => {
	test('slices a content field at the requested offsets', () => {
		const result = readMessageWindow(fixtureHistory(), 1, 'content', 0, 5)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.window).toEqual({ index: 1, field: 'content', start: 0, end: 5, totalChars: 15, text: 'build' })
	})

	test('slices a reasoning field', () => {
		const result = readMessageWindow(fixtureHistory(), 4, 'reasoning', 4, 15)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.window.text).toBe('same though')
		expect(result.window.totalChars).toBe(50)
	})

	test('treats a missing reasoning field as empty', () => {
		const result = readMessageWindow(fixtureHistory(), 0, 'reasoning', 0, 10)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.window.text).toBe('')
		expect(result.window.totalChars).toBe(0)
	})

	test('clamps the end to the field length', () => {
		const result = readMessageWindow(fixtureHistory(), 1, 'content', 6, 1000)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.window.end).toBe(15)
		expect(result.window.text).toBe('the thing')
	})

	test('caps the window at MAX_WINDOW_CHARS no matter the requested range', () => {
		const big: Message[] = [{ role: 'assistant', content: 'x'.repeat(MAX_WINDOW_CHARS + 5000) }]
		const result = readMessageWindow(big, 0, 'content', 0, MAX_WINDOW_CHARS + 5000)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.window.text.length).toBe(MAX_WINDOW_CHARS)
		expect(result.window.end).toBe(MAX_WINDOW_CHARS)
	})

	test('rejects an out-of-range index or start without returning text', () => {
		expect(readMessageWindow(fixtureHistory(), 99, 'content', 0, 10).ok).toBe(false)
		expect(readMessageWindow(fixtureHistory(), 1, 'content', 17, 20).ok).toBe(false)
	})
})

describe('searchRoleBlocks', () => {
	test('substring search returns match offsets with surrounding windows', () => {
		const result = searchRoleBlocks(fixtureHistory(), { pattern: 'needle', kind: 'substring', maxMatches: 10 })
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.matches.length).toBe(2)
		const first = defined(result.matches[0], 'first match')
		expect(first.messageIndex).toBe(5)
		expect(first.field).toBe('content')
		expect(first.offset).toBe(0)
		expect(first.window).toContain('needle in a haystack')
	})

	test('searches reasoning as well as content by default, or one field when restricted', () => {
		const both = searchRoleBlocks(fixtureHistory(), { pattern: 'same thought', kind: 'substring', maxMatches: 10 })
		expect(both.ok).toBe(true)
		if (!both.ok) return
		expect(both.matches.length).toBe(3)
		expect(both.matches.every((m) => m.field === 'reasoning')).toBe(true)

		const contentOnly = searchRoleBlocks(fixtureHistory(), { field: 'content', pattern: 'same thought', kind: 'substring', maxMatches: 10 })
		expect(contentOnly.ok).toBe(true)
		if (!contentOnly.ok) return
		expect(contentOnly.matches.length).toBe(0)
	})

	test('regex search finds pattern families', () => {
		const result = searchRoleBlocks(fixtureHistory(), { pattern: 'plan+ing', kind: 'regex', maxMatches: 10 })
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.matches.length).toBe(3)
		expect(defined(result.matches[0], 'first match').offset).toBe(0)
	})

	test('an invalid regex returns an error, not a throw', () => {
		const result = searchRoleBlocks(fixtureHistory(), { pattern: '([', kind: 'regex', maxMatches: 10 })
		expect(result.ok).toBe(false)
	})

	test('a regex with zero-width matches terminates', () => {
		const result = searchRoleBlocks(fixtureHistory(), { pattern: 'x*', kind: 'regex', maxMatches: 10 })
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.matches.length).toBeGreaterThan(0)
	})

	test('maxMatches caps the results and never exceeds the hard cap', () => {
		const repeated: Message[] = [{ role: 'assistant', content: 'ab '.repeat(100) }]
		const limited = searchRoleBlocks(repeated, { pattern: 'ab', kind: 'substring', maxMatches: 3 })
		expect(limited.ok).toBe(true)
		if (!limited.ok) return
		expect(limited.matches.length).toBe(3)

		const flooded = searchRoleBlocks(repeated, { pattern: 'ab', kind: 'substring', maxMatches: 1000 })
		expect(flooded.ok).toBe(true)
		if (!flooded.ok) return
		expect(flooded.matches.length).toBe(MAX_SEARCH_MATCHES)
	})
})

describe('hashArguments', () => {
	test('is stable for identical input and differs for different input', () => {
		expect(hashArguments('{"path":"a.txt"}')).toBe(hashArguments('{"path":"a.txt"}'))
		expect(hashArguments('{"path":"a.txt"}')).not.toBe(hashArguments('{"path":"b.txt"}'))
		expect(hashArguments('')).toBe(hashArguments(''))
	})
})
