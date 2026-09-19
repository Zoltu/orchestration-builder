import { describe, expect, test } from 'bun:test'
import type { Message } from './types.js'
import { compactHistoryForContextBudget, stripReasoning, truncateToolOutput } from './context-policy.ts'

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

describe('compactHistoryForContextBudget', () => {
	const pad = (size: number): string => 'x'.repeat(size)

	// A turn of 800 chars: an assistant tool call (content 200 + name 10 + arguments 90) answered by a 500-char tool result.
	function turnBlock(id: string): Message[] {
		return [
			{
				role: 'assistant',
				content: pad(200),
				tool_calls: [{ id, type: 'function', function: { name: pad(10), arguments: pad(90) } }],
			},
			{ role: 'tool', content: pad(500), tool_call_id: id },
		]
	}

	function threeTurnHistory(): Message[] {
		return [
			{ role: 'system', content: pad(400) },
			{ role: 'user', content: pad(400) },
			...turnBlock('a'),
			...turnBlock('b'),
			...turnBlock('c'),
		]
	}

	test('returns the history unchanged when it already fits', () => {
		const history: Message[] = [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'task' },
		]
		const report = compactHistoryForContextBudget(history, { contextWindow: 100000, promptTokens: 0, targetFraction: 0.7 })
		expect(report.fits).toBe(true)
		expect(report.droppedMessages).toBe(0)
		expect(report.truncatedToolMessages).toBe(0)
		expect(report.strippedReasoningMessages).toBe(0)
		expect(report.history).toEqual(history)
	})

	test('no strip when the earlier steps suffice: reasoning on the survivors is intact', () => {
		const history: Message[] = [
			{ role: 'system', content: pad(400) },
			{ role: 'user', content: pad(400) },
			{ role: 'assistant', content: pad(200), reasoning: pad(5000) },
			{ role: 'tool', content: pad(400), tool_call_id: 'a' },
			{ role: 'assistant', content: pad(100), reasoning: pad(300) },
		]
		// Reasoning is a last resort, so the reasoning-heavy a-turn can only lose its 5600 chars by being dropped whole: 6800 chars ≈ 1700 tokens over the 1200 target; after the drop, 1200 chars ≈ 300 tokens fits, and nothing else runs.
		const report = compactHistoryForContextBudget(history, { contextWindow: 2000, promptTokens: 0, targetFraction: 0.6 })
		expect(report.fits).toBe(true)
		expect(report.droppedMessages).toBe(2)
		expect(report.strippedReasoningMessages).toBe(0)
		expect(report.history.length).toBe(3)
		expect(report.history[2]?.reasoning).toBe(pad(300))
	})

	test('never strips the last assistant message\'s reasoning, so an un-droppable reasoning-heavy turn fails to fit', () => {
		const history: Message[] = [
			{ role: 'system', content: pad(400) },
			{ role: 'user', content: pad(400) },
			{ role: 'assistant', content: pad(200), reasoning: pad(5000) },
			{ role: 'tool', content: pad(400), tool_call_id: 'a' },
		]
		// The a-turn is the protected most-recent turn and its assistant is the last one, so the only reasoning the strip pass could reach is exactly the reasoning that may not be stripped: nothing more can shrink, and the report says so instead of quietly deleting it.
		const report = compactHistoryForContextBudget(history, { contextWindow: 2000, promptTokens: 0, targetFraction: 0.6 })
		expect(report.fits).toBe(false)
		expect(report.droppedMessages).toBe(0)
		expect(report.strippedReasoningMessages).toBe(0)
		expect(report.history[2]?.reasoning).toBe(pad(5000))
	})

	test('strips reasoning oldest-first and stops once the estimate fits', () => {
		const history: Message[] = [
			{ role: 'system', content: pad(400), reasoning: pad(1000) },
			{ role: 'user', content: pad(400), reasoning: pad(1000) },
			{
				role: 'assistant',
				content: pad(200),
				tool_calls: [{ id: 'a', type: 'function', function: { name: pad(10), arguments: pad(90) } }],
			},
			{ role: 'tool', content: pad(500), tool_call_id: 'a' },
			{ role: 'assistant', content: pad(100), reasoning: pad(4000) },
		]
		// After the drop pass exhausts the droppable turns, the only surviving assistant is the protected last one, so the strip pass can only ever reach reasoning on the messages it cannot drop — here the system prompt and the user task (Message carries reasoning on any role, and the estimate counts it on every message). Full history 7700 chars ≈ 1925 tokens over the 1500 target; dropping the a-turn leaves 6900 ≈ 1725, still over, and truncation has nothing to shrink. The pass takes the oldest reasoning first — the system message's — and 5900 chars ≈ 1475 fits, so the user task's and the last assistant's reasoning survive.
		const report = compactHistoryForContextBudget(history, { contextWindow: 2500, promptTokens: 0, targetFraction: 0.6 })
		expect(report.fits).toBe(true)
		expect(report.droppedMessages).toBe(2)
		expect(report.truncatedToolMessages).toBe(0)
		expect(report.strippedReasoningMessages).toBe(1)
		expect(report.history[0]?.reasoning).toBeNull()
		expect(report.history[1]?.reasoning).toBe(pad(1000))
		expect(report.history[2]?.reasoning).toBe(pad(4000))
	})

	test('strips reasoning from every older message until the estimate fits', () => {
		const history: Message[] = [
			{ role: 'system', content: pad(400), reasoning: pad(1000) },
			{ role: 'user', content: pad(400), reasoning: pad(1000) },
			{
				role: 'assistant',
				content: pad(200),
				tool_calls: [{ id: 'a', type: 'function', function: { name: pad(10), arguments: pad(90) } }],
			},
			{ role: 'tool', content: pad(500), tool_call_id: 'a' },
			{ role: 'assistant', content: pad(100), reasoning: pad(4000) },
		]
		// A tighter 1320-token target needs both older reasonings: 6900 chars ≈ 1725 over, one strip leaves 5900 ≈ 1475 still over, two leave 4900 ≈ 1225 which fits. The last assistant message's reasoning is never reached.
		const report = compactHistoryForContextBudget(history, { contextWindow: 2200, promptTokens: 0, targetFraction: 0.6 })
		expect(report.fits).toBe(true)
		expect(report.strippedReasoningMessages).toBe(2)
		expect(report.history[0]?.reasoning).toBeNull()
		expect(report.history[1]?.reasoning).toBeNull()
		expect(report.history[2]?.reasoning).toBe(pad(4000))
	})

	test('reasoning exhausted before the estimate fits still reports fits false', () => {
		const history: Message[] = [
			{ role: 'system', content: pad(400), reasoning: pad(1000) },
			{ role: 'user', content: pad(400), reasoning: pad(1000) },
			{
				role: 'assistant',
				content: pad(200),
				tool_calls: [{ id: 'a', type: 'function', function: { name: pad(10), arguments: pad(90) } }],
			},
			{ role: 'tool', content: pad(500), tool_call_id: 'a' },
			{ role: 'assistant', content: pad(100), reasoning: pad(4000) },
		]
		// A 1200-token target is past everything the strip pass can reach: stripping both older reasonings leaves 4900 chars ≈ 1225, still over, with only the protected last assistant's reasoning left. The pass reports what it did and gives up.
		const report = compactHistoryForContextBudget(history, { contextWindow: 2000, promptTokens: 0, targetFraction: 0.6 })
		expect(report.fits).toBe(false)
		expect(report.strippedReasoningMessages).toBe(2)
		expect(report.history[2]?.reasoning).toBe(pad(4000))
	})

	test('drops oldest turns first, preserving system, task, and the most recent turn', () => {
		// 3200 chars ≈ 800 tokens vs target 500: dropping turn a (2400 chars ≈ 600) is not enough, dropping turn b too (1600 chars ≈ 400) fits.
		const report = compactHistoryForContextBudget(threeTurnHistory(), { contextWindow: 1000, promptTokens: 0, targetFraction: 0.5 })
		expect(report.fits).toBe(true)
		expect(report.droppedMessages).toBe(4)
		expect(report.estimatedPromptTokens).toBe(400)
		expect(report.history.map((m) => m.tool_call_id ?? m.role)).toEqual(['system', 'user', 'assistant', 'c'])
	})

	test('never leaves an orphan tool message or an unanswered tool call after dropping', () => {
		const report = compactHistoryForContextBudget(threeTurnHistory(), { contextWindow: 1000, promptTokens: 0, targetFraction: 0.5 })
		const history = report.history
		for (let i = 0; i < history.length; i++) {
			const message = history[i]
			if (message === undefined) continue
			if (message.role === 'tool') {
				const previous = history[i - 1]
				expect(previous !== undefined && (previous.role === 'tool' || previous.tool_calls !== undefined)).toBe(true)
			}
			if (message.tool_calls !== undefined) {
				for (let callIndex = 0; callIndex < message.tool_calls.length; callIndex++) {
					expect(history[i + 1 + callIndex]?.role).toBe('tool')
				}
			}
		}
	})

	test('truncates oversized tool results in the protected most-recent turn when dropping cannot help', () => {
		const history: Message[] = [
			{ role: 'system', content: pad(400) },
			{ role: 'user', content: pad(400) },
			{
				role: 'assistant',
				content: pad(200),
				tool_calls: [{ id: 'a', type: 'function', function: { name: pad(10), arguments: pad(90) } }],
			},
			{ role: 'tool', content: pad(10000), tool_call_id: 'a' },
		]
		// A single turn is never dropped; the 10000-char tool result must shrink for the 1000-token target.
		const report = compactHistoryForContextBudget(history, { contextWindow: 2000, promptTokens: 0, targetFraction: 0.5 })
		expect(report.fits).toBe(true)
		expect(report.droppedMessages).toBe(0)
		expect(report.truncatedToolMessages).toBe(1)
		expect(report.strippedReasoningMessages).toBe(0)
		const toolMessage = report.history[3]
		expect(toolMessage?.content.length).toBeLessThan(2100)
		expect(toolMessage?.content.includes('[truncated:')).toBe(true)
	})

	test('stops truncating when truncation cannot make a message shorter', () => {
		// A 2050-char tool result truncated to 2000 chars plus the marker comes out longer than it went in; the compactor must give up rather than loop.
		const history: Message[] = [
			{ role: 'system', content: pad(400) },
			{ role: 'user', content: pad(400) },
			{
				role: 'assistant',
				content: pad(200),
				tool_calls: [{ id: 'a', type: 'function', function: { name: pad(10), arguments: pad(90) } }],
			},
			{ role: 'tool', content: pad(2050), tool_call_id: 'a' },
		]
		const report = compactHistoryForContextBudget(history, { contextWindow: 100, promptTokens: 0, targetFraction: 0.5 })
		expect(report.fits).toBe(false)
		expect(report.truncatedToolMessages).toBe(1)
		expect(report.strippedReasoningMessages).toBe(0)
		expect(report.history[3]?.content.length).toBeLessThan(2050)
	})

	test('reports fits false when the undeletable remainder alone exceeds the target', () => {
		const history: Message[] = [
			{ role: 'system', content: pad(10000) },
			{ role: 'user', content: pad(100) },
			{ role: 'assistant', content: pad(100) },
		]
		const report = compactHistoryForContextBudget(history, { contextWindow: 100, promptTokens: 0, targetFraction: 0.5 })
		expect(report.fits).toBe(false)
		expect(report.droppedMessages).toBe(0)
		expect(report.truncatedToolMessages).toBe(0)
		expect(report.strippedReasoningMessages).toBe(0)
	})

	test('calibrates the token estimate from the endpoint-reported prompt tokens', () => {
		// Same history as the drop test, but the endpoint reports 3200 prompt tokens for 3200 chars (1 char/token instead of the default 4): even dropping both older turns leaves 1600 chars ≈ 1600 tokens over the 500 target.
		const report = compactHistoryForContextBudget(threeTurnHistory(), { contextWindow: 1000, promptTokens: 3200, targetFraction: 0.5 })
		expect(report.fits).toBe(false)
		expect(report.droppedMessages).toBe(4)
		expect(report.strippedReasoningMessages).toBe(0)
	})
})
