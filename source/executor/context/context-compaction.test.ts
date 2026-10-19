import { describe, expect, test } from 'bun:test'
import type { EngineContext, RoleState } from '../engine-state.js'
import type { LoadedGuild } from '../loader.js'
import type { LogEvent, Message } from '../types.js'
import { isObject } from '../validation.js'
import { createContextManager, createContextPressureTracker, type ContextDecision } from './index.js'
import { compactHistoryForContextBudget } from './context-policy.js'

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

function continuationHistory(): Message[] {
	return [
		{ role: 'system', content: pad(400) },
		{ role: 'user', content: pad(400) },
		{ role: 'assistant', content: pad(400) },
		{ role: 'user', content: pad(400) },
		...turnBlock('a'),
		...turnBlock('b'),
		...turnBlock('c'),
	]
}

describe('compactHistoryForContextBudget', () => {
	test('returns the history unchanged when it already fits', () => {
		const history: Message[] = [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'task' },
		]
		const report = compactHistoryForContextBudget(history, { contextWindow: 100000, promptTokens: 0, targetFraction: 0.7, protectedPrefixLength: 2 })
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
		const report = compactHistoryForContextBudget(history, { contextWindow: 2000, promptTokens: 0, targetFraction: 0.6, protectedPrefixLength: 2 })
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
		const report = compactHistoryForContextBudget(history, { contextWindow: 2000, promptTokens: 0, targetFraction: 0.6, protectedPrefixLength: 2 })
		expect(report.fits).toBe(false)
		expect(report.droppedMessages).toBe(0)
		expect(report.strippedReasoningMessages).toBe(0)
		expect(report.history[2]?.reasoning).toBe(pad(5000))
	})

	test('keeps reasoning on the protected prefix and the last assistant when the rest cannot shrink', () => {
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
		// Dropping the a-turn leaves the protected prefix and the last assistant; both keep their reasoning even though the estimate is still over target.
		const report = compactHistoryForContextBudget(history, { contextWindow: 2500, promptTokens: 0, targetFraction: 0.6, protectedPrefixLength: 2 })
		expect(report.fits).toBe(false)
		expect(report.droppedMessages).toBe(2)
		expect(report.strippedReasoningMessages).toBe(0)
		expect(report.history[0]?.reasoning).toBe(pad(1000))
		expect(report.history[1]?.reasoning).toBe(pad(1000))
		expect(report.history[2]?.reasoning).toBe(pad(4000))
	})

	test('strips reasoning from a surviving tool result after the protected prefix', () => {
		const history: Message[] = [
			{ role: 'system', content: pad(400) },
			{ role: 'user', content: pad(400) },
			{
				role: 'assistant',
				content: pad(200),
				tool_calls: [{ id: 'a', type: 'function', function: { name: pad(10), arguments: pad(90) } }],
			},
			{ role: 'tool', content: pad(400), tool_call_id: 'a', reasoning: pad(5000) },
		]
		const report = compactHistoryForContextBudget(history, { contextWindow: 2000, promptTokens: 0, targetFraction: 0.6, protectedPrefixLength: 2 })
		expect(report.fits).toBe(true)
		expect(report.strippedReasoningMessages).toBe(1)
		expect(report.history[2]?.content).toBe(pad(200))
		expect(report.history[3]?.reasoning).toBeNull()
	})

	test('drops oldest turns first, preserving system, task, and the most recent turn', () => {
		// 3200 chars ≈ 800 tokens vs target 500: dropping turn a (2400 chars ≈ 600) is not enough, dropping turn b too (1600 chars ≈ 400) fits.
		const report = compactHistoryForContextBudget(threeTurnHistory(), { contextWindow: 1000, promptTokens: 0, targetFraction: 0.5, protectedPrefixLength: 2 })
		expect(report.fits).toBe(true)
		expect(report.droppedMessages).toBe(4)
		expect(report.estimatedPromptTokens).toBe(400)
		expect(report.history.map((m) => m.tool_call_id ?? m.role)).toEqual(['system', 'user', 'assistant', 'c'])
	})

	test('a continuation-shaped history with an explicit prefix of two is ordinary history and may be dropped', () => {
		const original = continuationHistory()
		const report = compactHistoryForContextBudget(original, { contextWindow: 1000, promptTokens: 0, targetFraction: 0.5, protectedPrefixLength: 2 })
		expect(report.fits).toBe(true)
		expect(report.droppedMessages).toBe(6)
		expect(report.history.slice(0, 2)).toEqual(original.slice(0, 2))
		expect(report.history.map((message) => message.tool_call_id ?? message.role)).toEqual(['system', 'user', 'assistant', 'c'])
	})

	test('a continuation-shaped history keeps its four-message prefix and starts dropping at index 4', () => {
		const original = continuationHistory()
		const report = compactHistoryForContextBudget(original, { contextWindow: 1400, promptTokens: 0, targetFraction: 0.5, protectedPrefixLength: 4 })
		expect(report.fits).toBe(true)
		expect(report.droppedMessages).toBe(4)
		expect(report.history.slice(0, 4)).toEqual(original.slice(0, 4))
		expect(report.history.map((message) => message.tool_call_id ?? message.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'c'])
	})

	test('a continuation-shaped history keeps the prefix even when the remainder cannot fit', () => {
		const original = continuationHistory()
		const report = compactHistoryForContextBudget(original, { contextWindow: 100, promptTokens: 0, targetFraction: 0.5, protectedPrefixLength: 4 })
		expect(report.fits).toBe(false)
		expect(report.history.slice(0, 4)).toEqual(original.slice(0, 4))
		expect(report.history.length).toBe(6)
	})

	test('never leaves an orphan tool message or an unanswered tool call after dropping', () => {
		const report = compactHistoryForContextBudget(threeTurnHistory(), { contextWindow: 1000, promptTokens: 0, targetFraction: 0.5, protectedPrefixLength: 2 })
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
		const report = compactHistoryForContextBudget(history, { contextWindow: 2000, promptTokens: 0, targetFraction: 0.5, protectedPrefixLength: 2 })
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
		const report = compactHistoryForContextBudget(history, { contextWindow: 100, promptTokens: 0, targetFraction: 0.5, protectedPrefixLength: 2 })
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
		const report = compactHistoryForContextBudget(history, { contextWindow: 100, promptTokens: 0, targetFraction: 0.5, protectedPrefixLength: 2 })
		expect(report.fits).toBe(false)
		expect(report.droppedMessages).toBe(0)
		expect(report.truncatedToolMessages).toBe(0)
		expect(report.strippedReasoningMessages).toBe(0)
	})

	test('calibrates the token estimate from the endpoint-reported prompt tokens', () => {
		// Same history as the drop test, but the endpoint reports 3200 prompt tokens for 3200 chars (1 char/token instead of the default 4): even dropping both older turns leaves 1600 chars ≈ 1600 tokens over the 500 target.
		const report = compactHistoryForContextBudget(threeTurnHistory(), { contextWindow: 1000, promptTokens: 3200, targetFraction: 0.5, protectedPrefixLength: 2 })
		expect(report.fits).toBe(false)
		expect(report.droppedMessages).toBe(4)
		expect(report.strippedReasoningMessages).toBe(0)
	})
})

describe('context manager compaction backstop', () => {
	// The manager always compacts to this fraction of the reported window, so a test that needs a specific token target chooses the window that yields it.
	const RECOVERY_TARGET_FRACTION = 0.7

	function windowForTarget(targetTokens: number): number {
		return Math.ceil(targetTokens / RECOVERY_TARGET_FRACTION)
	}

	function guildFor(contextWindow: number): LoadedGuild {
		return {
			config: { entryRole: 'main', roles: {}, tools: [] },
			deployment: {
				model: { name: 'm', apiBase: 'http://x', contextWindow, generation: {} },
				executor: { maxAgentDepth: 8, defaultToolTimeoutSeconds: 30, maxCompactionAttempts: 5 },
				contextPolicy: { maxToolOutputChars: 4000 },
			},
			prompts: {},
			tools: {},
		}
	}

	function contextFor(contextWindow: number): EngineContext {
		return { loadedGuild: guildFor(contextWindow), depth: 0, roleName: 'main', task: 'do it' }
	}

	function roleStateFor(history: Message[]): RoleState {
		return {
			history,
			lastPromptTokens: 0,
			recentCompactionPromptTokens: [],
			recentToolCalls: [],
			toolCallCount: 0,
			generatedTokens: 0,
			contextExceededAttempts: 0,
			loopCheckToolCallWatermark: 0,
			loopCheckTokenWatermark: 0,
		}
	}

	interface CompactionObservation {
		history: Message[]
		decision: ContextDecision
		events: LogEvent[]
	}

	function compactForTest(history: Message[], targetTokens: number, promptTokens = 0): CompactionObservation {
		const contextWindow = windowForTarget(targetTokens)
		const events: LogEvent[] = []
		const manager = createContextManager(contextFor(contextWindow), {
			appendLog: (event) => events.push(event),
			contextPressureTracker: createContextPressureTracker(),
			runRole: async () => {
				throw new Error('context handler invoked without executor.contextHandlerRole configured')
			},
		})
		const roleState = roleStateFor(history)
		const decision = manager.observeRejection(roleState, { promptTokens, contextWindow })
		return { history: roleState.history, decision, events }
	}

	function compactedPayload(events: LogEvent[]): Record<string, unknown> {
		const event = events.find((candidate) => candidate.type === 'context_compacted')
		if (event === undefined) throw new Error('expected a context_compacted event')
		if (!isObject(event.payload)) throw new Error('context_compacted payload must be an object')
		return event.payload
	}

	// A continuing backstop appends its recovery notice after the compacted history; these assertions target the history the compaction produced.
	function withoutRecoveryNotice(observation: CompactionObservation): Message[] {
		return observation.history.slice(0, -1)
	}

	test('returns the history unchanged when it already fits', () => {
		const history: Message[] = [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'task' },
		]
		const observation = compactForTest(history.slice(), 70000)
		expect(observation.decision.kind).toBe('continue')
		expect(withoutRecoveryNotice(observation)).toEqual(history)
		const payload = compactedPayload(observation.events)
		expect(payload['droppedMessages']).toBe(0)
		expect(payload['truncatedToolMessages']).toBe(0)
		expect(payload['strippedReasoningMessages']).toBe(0)
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
		const observation = compactForTest(history, 1200)
		expect(observation.decision.kind).toBe('continue')
		const compacted = withoutRecoveryNotice(observation)
		expect(compacted.length).toBe(3)
		expect(compacted[2]?.reasoning).toBe(pad(300))
		const payload = compactedPayload(observation.events)
		expect(payload['droppedMessages']).toBe(2)
		expect(payload['truncatedToolMessages']).toBe(0)
		expect(payload['strippedReasoningMessages']).toBe(0)
	})

	test('never strips the last assistant message\'s reasoning, so an un-droppable reasoning-heavy turn fails to fit', () => {
		const history: Message[] = [
			{ role: 'system', content: pad(400) },
			{ role: 'user', content: pad(400) },
			{ role: 'assistant', content: pad(200), reasoning: pad(5000) },
			{ role: 'tool', content: pad(400), tool_call_id: 'a' },
		]
		// The a-turn is the protected most-recent turn and its assistant is the last one, so the only reasoning the strip pass could reach is exactly the reasoning that may not be stripped: nothing more can shrink, and the decision says so instead of quietly deleting it.
		const observation = compactForTest(history, 1200)
		expect(observation.decision.kind).toBe('finished')
		expect(observation.history.length).toBe(4)
		expect(observation.history[2]?.reasoning).toBe(pad(5000))
		expect(observation.events.some((event) => event.type === 'context_compacted')).toBe(false)
	})

	test('keeps reasoning on the protected prefix and the last assistant', () => {
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
		const observation = compactForTest(history, 1500)
		expect(observation.decision.kind).toBe('finished')
		expect(observation.history.length).toBe(3)
		expect(observation.history[0]?.reasoning).toBe(pad(1000))
		expect(observation.history[1]?.reasoning).toBe(pad(1000))
		expect(observation.history[2]?.reasoning).toBe(pad(4000))
		expect(observation.events.some((event) => event.type === 'context_compacted')).toBe(false)
	})

	test('strips reasoning from a surviving tool result after the protected prefix', () => {
		const history: Message[] = [
			{ role: 'system', content: pad(400) },
			{ role: 'user', content: pad(400) },
			{
				role: 'assistant',
				content: pad(200),
				tool_calls: [{ id: 'a', type: 'function', function: { name: pad(10), arguments: pad(90) } }],
			},
			{ role: 'tool', content: pad(400), tool_call_id: 'a', reasoning: pad(5000) },
		]
		const observation = compactForTest(history, 1200)
		expect(observation.decision.kind).toBe('continue')
		const compacted = withoutRecoveryNotice(observation)
		expect(compacted[3]?.reasoning).toBeNull()
		const payload = compactedPayload(observation.events)
		expect(payload['droppedMessages']).toBe(0)
		expect(payload['truncatedToolMessages']).toBe(0)
		expect(payload['strippedReasoningMessages']).toBe(1)
	})

	test('drops oldest turns first, preserving system, task, and the most recent turn', () => {
		// 3200 chars ≈ 800 tokens vs target 500: dropping turn a (800 chars ≈ 200) is not enough, dropping turn b too (1600 chars total ≈ 400) fits.
		const observation = compactForTest(threeTurnHistory(), 500)
		expect(observation.decision.kind).toBe('continue')
		const compacted = withoutRecoveryNotice(observation)
		expect(compacted.map((message) => message.tool_call_id ?? message.role)).toEqual(['system', 'user', 'assistant', 'c'])
		const payload = compactedPayload(observation.events)
		expect(payload['droppedMessages']).toBe(4)
		expect(payload['truncatedToolMessages']).toBe(0)
		expect(payload['strippedReasoningMessages']).toBe(0)
		expect(payload['estimatedPromptTokens']).toBe(400)
	})

	test('never leaves an orphan tool message or an unanswered tool call after dropping', () => {
		const observation = compactForTest(threeTurnHistory(), 500)
		const history = withoutRecoveryNotice(observation)
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
		const observation = compactForTest(history, 1000)
		expect(observation.decision.kind).toBe('continue')
		const compacted = withoutRecoveryNotice(observation)
		const toolMessage = compacted[3]
		expect(toolMessage?.content.length).toBeLessThan(2100)
		expect(toolMessage?.content.includes('[truncated:')).toBe(true)
		const payload = compactedPayload(observation.events)
		expect(payload['droppedMessages']).toBe(0)
		expect(payload['truncatedToolMessages']).toBe(1)
		expect(payload['strippedReasoningMessages']).toBe(0)
	})

	test('stops truncating when truncation cannot make a message shorter', () => {
		// A 2050-char tool result truncated to 2000 chars plus the marker lands just under the original once, then stops when the next pass would not shorten it further; the compactor must give up rather than loop.
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
		const observation = compactForTest(history, 50)
		expect(observation.decision.kind).toBe('finished')
		expect(observation.history[3]?.content.length).toBeLessThan(2050)
		expect(observation.history[3]?.content.includes('[truncated:')).toBe(true)
	})

	test('fails to fit when the undeletable remainder alone exceeds the target', () => {
		const history: Message[] = [
			{ role: 'system', content: pad(10000) },
			{ role: 'user', content: pad(100) },
			{ role: 'assistant', content: pad(100) },
		]
		const observation = compactForTest(history, 50)
		expect(observation.decision.kind).toBe('finished')
		expect(observation.history).toEqual(history)
		expect(observation.events.some((event) => event.type === 'context_compacted')).toBe(false)
	})

	test('calibrates the token estimate from the endpoint-reported prompt tokens', () => {
		// Same history as the drop test, but the endpoint reports 3200 prompt tokens for 3200 chars (1 char/token instead of the default 4): even dropping both older turns leaves 1600 chars ≈ 1600 tokens over the 500 target.
		const observation = compactForTest(threeTurnHistory(), 500, 3200)
		expect(observation.decision.kind).toBe('finished')
		expect(observation.history.length).toBe(4)
		expect(observation.history[0]?.role).toBe('system')
		expect(observation.history[1]?.role).toBe('user')
		expect(observation.history[2]?.tool_calls?.[0]?.id).toBe('c')
		expect(observation.history[3]?.tool_call_id).toBe('c')
	})
})
