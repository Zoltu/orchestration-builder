import { describe, expect, test } from 'bun:test'
import type { LogEvent, RunMeta } from '../../executor/types.js'
import {
	deriveBudgets,
	deriveCurrentActivity,
	deriveInterruptHistory,
	deriveQuestionHistory,
	deriveRoleActivity,
	deriveRoleTree,
} from './index.js'

function defined<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`${label} is undefined`)
	return value
}

function present<T>(value: T | null, label: string): T {
	if (value === null) throw new Error(`${label} is null`)
	return value
}

function sampleRunMeta(overrides: Partial<RunMeta> = {}): RunMeta {
	return {
		runId: 'run-1',
		guildPath: 'guild',
		benchmarkPath: 'bench',
		task: 'fix the bug',
		status: 'success',
		startTime: '2026-01-01T00:00:00.000Z',
		endTime: '2026-01-01T00:01:00.000Z',
		...overrides,
	}
}

describe('deriveRoleActivity', () => {
	test('summarizes per-role counts and first/last seen timestamps', () => {
		const events: LogEvent[] = [
			{ timestamp: 't1', type: 'llm_call', payload: { role: 'planner' } },
			{ timestamp: 't2', type: 'tool_call', payload: { role: 'planner', tool: 'agent' } },
			{ timestamp: 't3', type: 'llm_call', payload: { role: 'coder' } },
			{ timestamp: 't4', type: 'tool_call', payload: { role: 'coder', tool: 'finish' } },
			{ timestamp: 't5', type: 'role_finished', payload: { role: 'planner', status: 'success' } },
		]

		const activity = deriveRoleActivity(events)
		expect(activity.length).toBe(2)

		const planner = defined(activity[0], 'activity[0]')
		expect(planner.role).toBe('planner')
		expect(planner.firstSeen).toBe('t1')
		expect(planner.lastSeen).toBe('t5')
		expect(planner.eventCount).toBe(3)
		expect(planner.llmCalls).toBe(1)
		expect(planner.toolCalls).toBe(1)
		expect(planner.recentTools).toEqual(['agent'])
		expect(planner.lastPromptTokens).toBeNull()

		const coder = defined(activity[1], 'activity[1]')
		expect(coder.role).toBe('coder')
		expect(coder.llmCalls).toBe(1)
		expect(coder.toolCalls).toBe(1)
		expect(coder.recentTools).toEqual(['finish'])
		expect(coder.lastPromptTokens).toBeNull()
	})

	test('recentTools keeps the last 3 distinct tools, most-recent-last, moving a repeat to the end', () => {
		const events: LogEvent[] = [
			{ timestamp: 't1', type: 'tool_call', payload: { role: 'coder', tool: 'read_file' } },
			{ timestamp: 't2', type: 'tool_call', payload: { role: 'coder', tool: 'write_file' } },
			{ timestamp: 't3', type: 'tool_call', payload: { role: 'coder', tool: 'read_file' } },
			{ timestamp: 't4', type: 'tool_call', payload: { role: 'coder', tool: 'search_text' } },
			{ timestamp: 't5', type: 'tool_call', payload: { role: 'coder', tool: 'glob_files' } },
			{ timestamp: 't6', type: 'tool_call', payload: { role: 'coder', tool: 'write_file' } },
		]

		const [coder] = deriveRoleActivity(events)
		expect(defined(coder, 'coder').recentTools).toEqual(['search_text', 'glob_files', 'write_file'])
		expect(defined(coder, 'coder').toolCalls).toBe(6)
	})

	test('recentTools is empty when the role made no tool calls', () => {
		const events: LogEvent[] = [
			{ timestamp: 't1', type: 'llm_call', payload: { role: 'planner' } },
		]
		const [planner] = deriveRoleActivity(events)
		expect(defined(planner, 'planner').recentTools).toEqual([])
	})

	test('lastPromptTokens tracks the most recent llm_call usage promptTokens for the role', () => {
		const events: LogEvent[] = [
			{ timestamp: 't1', type: 'llm_call', payload: { role: 'planner', usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedPromptTokens: 40 } } },
			{ timestamp: 't2', type: 'tool_call', payload: { role: 'planner', tool: 'read_file' } },
			{ timestamp: 't3', type: 'llm_call', payload: { role: 'planner', usage: { promptTokens: 250, completionTokens: 30, totalTokens: 280 } } },
		]
		const [planner] = deriveRoleActivity(events)
		// The last reported context window size is the full prompt bill (cached + uncached), not the uncached share.
		expect(defined(planner, 'planner').lastPromptTokens).toBe(250)
	})

	test('lastPromptTokens stays null when an llm_call carries no usage', () => {
		const events: LogEvent[] = [
			{ timestamp: 't1', type: 'llm_call', payload: { role: 'planner' } },
		]
		const [planner] = deriveRoleActivity(events)
		expect(defined(planner, 'planner').lastPromptTokens).toBeNull()
	})

	test('ignores events whose payload has no role', () => {
		const events: LogEvent[] = [
			{ timestamp: 't1', type: 'global_budget_exceeded', payload: { error: { kind: 'timeout' } } },
			{ timestamp: 't2', type: 'llm_call', payload: { role: 'planner' } },
		]

		const activity = deriveRoleActivity(events)
		expect(activity.length).toBe(1)
		expect(defined(activity[0], 'activity[0]').role).toBe('planner')
	})

	test('returns an empty list when no roles appear in the log', () => {
		expect(deriveRoleActivity([])).toEqual([])
	})
})

describe('deriveRoleTree', () => {
	function event(type: string, payload: unknown): LogEvent {
		return { timestamp: 't', type, payload }
	}

	test('returns null when no role_start/role_finished/agent_call events are present (fallback to activity)', () => {
		const events: LogEvent[] = [
			event('llm_call', { role: 'planner' }),
			event('tool_call', { role: 'planner', tool: 'finish' }),
		]
		expect(deriveRoleTree(events)).toBeNull()
	})

	test('an entry role with no parent is a single root node', () => {
		const events: LogEvent[] = [
			event('role_start', { role: 'orchestrator', depth: 0, task: 'do it' }),
			event('role_finished', { role: 'orchestrator', depth: 0, status: 'success' }),
		]
		const tree = present(deriveRoleTree(events), 'tree')
		expect(tree).not.toBeNull()
		expect(tree.length).toBe(1)
		expect(tree[0]).toEqual({
			role: 'orchestrator',
			depth: 0,
			parent: null,
			status: 'success',
			summary: null,
			active: false,
			children: [],
		})
	})

	test('a parent with multiple children links them in spawn order', () => {
		const events: LogEvent[] = [
			event('role_start', { role: 'orchestrator', depth: 0, task: 't' }),
			event('agent_call', { parent: 'orchestrator', child: 'coder', depth: 1 }),
			event('role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'code' }),
			event('role_finished', { role: 'coder', depth: 1, status: 'success', parent: 'orchestrator' }),
			event('agent_call', { parent: 'orchestrator', child: 'critic', depth: 1 }),
			event('role_start', { role: 'critic', depth: 1, parent: 'orchestrator', task: 'review' }),
			event('role_finished', { role: 'orchestrator', depth: 0, status: 'success' }),
		]
		const tree = present(deriveRoleTree(events), 'tree')
		expect(tree).not.toBeNull()
		expect(tree.length).toBe(1)
		const root = defined(tree[0], 'tree[0]')
		expect(root.role).toBe('orchestrator')
		expect(root.children.length).toBe(2)
		expect(defined(root.children[0], 'root.children[0]').role).toBe('coder')
		expect(defined(root.children[1], 'root.children[1]').role).toBe('critic')
		expect(defined(root.children[0], 'root.children[0]').parent).toBe('orchestrator')
		expect(defined(root.children[0], 'root.children[0]').depth).toBe(1)
		expect(defined(root.children[0], 'root.children[0]').status).toBe('success')
		expect(defined(root.children[1], 'root.children[1]').status).toBeNull()
	})

	test('repeated sequential delegations to the same role are distinct nodes, each with its own status, not one merged node', () => {
		const events: LogEvent[] = [
			event('role_start', { role: 'orchestrator', depth: 0, task: 't' }),
			event('role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'first' }),
			event('role_finished', { role: 'coder', depth: 1, status: 'success', summary: 'first done', parent: 'orchestrator' }),
			event('role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'second' }),
			event('role_finished', { role: 'coder', depth: 1, status: 'error', summary: 'second failed', parent: 'orchestrator' }),
			event('role_finished', { role: 'orchestrator', depth: 0, status: 'success' }),
		]
		const tree = present(deriveRoleTree(events), 'tree')
		expect(tree).not.toBeNull()
		const root = defined(tree[0], 'tree[0]')
		expect(root.children.length).toBe(2)
		expect(defined(root.children[0], 'root.children[0]').role).toBe('coder')
		expect(defined(root.children[0], 'root.children[0]').status).toBe('success')
		expect(defined(root.children[0], 'root.children[0]').summary).toBe('first done')
		expect(defined(root.children[1], 'root.children[1]').role).toBe('coder')
		expect(defined(root.children[1], 'root.children[1]').status).toBe('error')
		expect(defined(root.children[1], 'root.children[1]').summary).toBe('second failed')
	})

	test('only the single currently-running invocation is active, even when the same role name recurs', () => {
		const events: LogEvent[] = [
			event('role_start', { role: 'orchestrator', depth: 0, task: 't' }),
			event('role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'first' }),
			event('role_finished', { role: 'coder', depth: 1, status: 'success', parent: 'orchestrator' }),
			event('role_start', { role: 'coder', depth: 1, parent: 'orchestrator', task: 'second' }),
		]
		const tree = present(deriveRoleTree(events), 'tree')
		expect(tree).not.toBeNull()
		const root = defined(tree[0], 'tree[0]')
		expect(root.active).toBe(false)
		expect(defined(root.children[0], 'root.children[0]').active).toBe(false)
		expect(defined(root.children[1], 'root.children[1]').active).toBe(true)
	})

	test('a child whose parent node never started becomes a root rather than being dropped', () => {
		const events: LogEvent[] = [
			event('role_start', { role: 'orphan', depth: 1, parent: 'missing-parent', task: 't' }),
		]
		const tree = present(deriveRoleTree(events), 'tree')
		expect(tree).not.toBeNull()
		expect(tree.length).toBe(1)
		expect(defined(tree[0], 'tree[0]').role).toBe('orphan')
		expect(defined(tree[0], 'tree[0]').active).toBe(true)
	})

	test('falls back to agent_call edges for a role_start that omitted parent (a log without parent fields)', () => {
		const events: LogEvent[] = [
			event('role_start', { role: 'orchestrator', depth: 0, task: 't' }),
			event('agent_call', { parent: 'orchestrator', child: 'coder', depth: 1 }),
			event('role_start', { role: 'coder', depth: 1, task: 'code' }),
			event('role_finished', { role: 'coder', depth: 1, status: 'success' }),
			event('role_finished', { role: 'orchestrator', depth: 0, status: 'success' }),
		]
		const tree = present(deriveRoleTree(events), 'tree')
		expect(tree).not.toBeNull()
		expect(tree.length).toBe(1)
		const root = defined(tree[0], 'tree[0]')
		expect(root.children.length).toBe(1)
		expect(defined(root.children[0], 'root.children[0]').role).toBe('coder')
		expect(defined(root.children[0], 'root.children[0]').parent).toBe('orchestrator')
	})

	test('does not throw on malformed payloads', () => {
		const events: LogEvent[] = [
			event('role_start', 'broken'),
			event('role_start', { depth: 0 }),
			event('agent_call', null),
			event('role_finished', { role: 'x' }),
		]
		expect(deriveRoleTree(events)).toEqual([])
	})
})
describe('deriveQuestionHistory', () => {
	test('pairs a single ask_human with its human_answer', () => {
		const events: LogEvent[] = [
			{ timestamp: 't1', type: 'ask_human', payload: { id: 'q1', question: 'Which file?' } },
			{ timestamp: 't2', type: 'human_answer', payload: { id: 'q1', answer: 'src/index.ts' } },
		]

		expect(deriveQuestionHistory(events)).toEqual([
			{ id: 'q1', question: 'Which file?', askedAt: 't1', answer: 'src/index.ts', answeredAt: 't2' },
		])
	})

	test('pairs multiple questions with their answers out of order', () => {
		const events: LogEvent[] = [
			{ timestamp: 't1', type: 'ask_human', payload: { id: 'q1', question: 'first?' } },
			{ timestamp: 't2', type: 'ask_human', payload: { id: 'q2', question: 'second?' } },
			{ timestamp: 't3', type: 'human_answer', payload: { id: 'q2', answer: 'second answer' } },
			{ timestamp: 't4', type: 'human_answer', payload: { id: 'q1', answer: 'first answer' } },
		]

		expect(deriveQuestionHistory(events)).toEqual([
			{ id: 'q1', question: 'first?', askedAt: 't1', answer: 'first answer', answeredAt: 't4' },
			{ id: 'q2', question: 'second?', askedAt: 't2', answer: 'second answer', answeredAt: 't3' },
		])
	})

	test('leaves an unanswered question without an answer field', () => {
		const events: LogEvent[] = [
			{ timestamp: 't1', type: 'ask_human', payload: { id: 'q1', question: 'answered?' } },
			{ timestamp: 't2', type: 'ask_human', payload: { id: 'q2', question: 'still pending?' } },
			{ timestamp: 't3', type: 'human_answer', payload: { id: 'q1', answer: 'yes' } },
		]

		const history = deriveQuestionHistory(events)
		expect(history.length).toBe(2)
		expect(defined(history[0], 'history[0]').answer).toBe('yes')
		expect(defined(history[0], 'history[0]').answeredAt).toBe('t3')
		expect(defined(history[1], 'history[1]').answer).toBeUndefined()
		expect(defined(history[1], 'history[1]').answeredAt).toBeUndefined()
	})

	test('preserves the context field when present', () => {
		const events: LogEvent[] = [
			{ timestamp: 't1', type: 'ask_human', payload: { id: 'q1', question: 'q', context: 'ctx' } },
		]

		expect(deriveQuestionHistory(events)).toEqual([
			{ id: 'q1', question: 'q', context: 'ctx', askedAt: 't1' },
		])
	})

	test('preserves ask order in the returned list', () => {
		const events: LogEvent[] = [
			{ timestamp: 't1', type: 'ask_human', payload: { id: 'q3', question: 'third?' } },
			{ timestamp: 't2', type: 'ask_human', payload: { id: 'q1', question: 'first?' } },
			{ timestamp: 't3', type: 'ask_human', payload: { id: 'q2', question: 'second?' } },
		]

		const history = deriveQuestionHistory(events)
		expect(history.map((entry) => entry.id)).toEqual(['q3', 'q1', 'q2'])
	})

	test('ignores a human_answer with no matching ask_human', () => {
		const events: LogEvent[] = [
			{ timestamp: 't1', type: 'human_answer', payload: { id: 'orphan', answer: 'no question' } },
			{ timestamp: 't2', type: 'ask_human', payload: { id: 'q1', question: 'q?' } },
		]

		expect(deriveQuestionHistory(events)).toEqual([
			{ id: 'q1', question: 'q?', askedAt: 't2' },
		])
	})

	test('does not throw on a malformed payload', () => {
		const events: LogEvent[] = [
			{ timestamp: 't1', type: 'ask_human', payload: null },
			{ timestamp: 't2', type: 'ask_human', payload: { question: 123 } },
			{ timestamp: 't3', type: 'human_answer', payload: 'broken' },
			{ timestamp: 't4', type: 'ask_human', payload: { id: 'q1', question: 'ok?' } },
		]

		expect(deriveQuestionHistory(events)).toEqual([
			{ id: 'q1', question: 'ok?', askedAt: 't4' },
		])
	})

	test('returns an empty list for an empty log', () => {
		expect(deriveQuestionHistory([])).toEqual([])
	})
})

describe('deriveInterruptHistory', () => {
	test('pairs an inquiry with the handler’s answered resolution', () => {
		const events: LogEvent[] = [
			{ timestamp: 't1', type: 'interrupt', payload: { trigger: 'inquiry', handler: 'inquiry_responder', target: 'coder-1-2', message: 'what are you doing?' } },
			{ timestamp: 't2', type: 'interrupt_resolved', payload: { trigger: 'inquiry', handler: 'inquiry_responder', target: 'coder-1-2', action: 'answered', summary: 'I am writing the parser.' } },
		]

		expect(deriveInterruptHistory(events)).toEqual([
			{ kind: 'inquiry', askedAt: 't1', role: 'inquiry_responder', message: 'what are you doing?', answer: 'I am writing the parser.', answeredAt: 't2', ended: false },
		])
	})

	test('an unanswered inquiry stays waiting', () => {
		const events: LogEvent[] = [
			{ timestamp: 't1', type: 'interrupt', payload: { trigger: 'inquiry', handler: 'inquiry_responder', target: 'coder-1-2', message: 'status?' } },
		]

		expect(deriveInterruptHistory(events)).toEqual([
			{ kind: 'inquiry', askedAt: 't1', role: 'inquiry_responder', message: 'status?', answer: null, answeredAt: null, ended: false },
		])
	})

	test('a failed resolution marks the inquiry ended', () => {
		const events: LogEvent[] = [
			{ timestamp: 't1', type: 'interrupt', payload: { trigger: 'inquiry', handler: 'inquiry_responder', target: 'coder-1-2', message: 'status?' } },
			{ timestamp: 't2', type: 'interrupt_resolved', payload: { trigger: 'inquiry', handler: 'inquiry_responder', target: 'coder-1-2', action: 'failed', handlerStatus: 'error', summary: 'the handler failed' } },
		]

		const entry = defined(deriveInterruptHistory(events)[0], 'entry')
		if (entry.kind !== 'inquiry') throw new Error('expected inquiry')
		expect(entry.answer).toBeNull()
		expect(entry.answeredAt).toBeNull()
		expect(entry.ended).toBe(true)
	})

	test('an answered action with an empty summary marks the inquiry ended rather than answered', () => {
		const events: LogEvent[] = [
			{ timestamp: 't1', type: 'interrupt', payload: { trigger: 'inquiry', handler: 'inquiry_responder', target: 'coder-1-2', message: 'status?' } },
			{ timestamp: 't2', type: 'interrupt_resolved', payload: { trigger: 'inquiry', handler: 'inquiry_responder', target: 'coder-1-2', action: 'answered', summary: '' } },
		]

		const entry = defined(deriveInterruptHistory(events)[0], 'entry')
		if (entry.kind !== 'inquiry') throw new Error('expected inquiry')
		expect(entry.answer).toBeNull()
		expect(entry.ended).toBe(true)
	})

	test('two inquiries pair with their resolutions oldest-first', () => {
		const events: LogEvent[] = [
			{ timestamp: 't1', type: 'interrupt', payload: { trigger: 'inquiry', handler: 'inquiry_responder', target: 'coder-1-2', message: 'first?' } },
			{ timestamp: 't2', type: 'interrupt', payload: { trigger: 'inquiry', handler: 'inquiry_responder', target: 'coder-1-2', message: 'second?' } },
			{ timestamp: 't3', type: 'interrupt_resolved', payload: { trigger: 'inquiry', action: 'answered', summary: 'answer one' } },
			{ timestamp: 't4', type: 'interrupt_resolved', payload: { trigger: 'inquiry', action: 'answered', summary: 'answer two' } },
		]

		const history = deriveInterruptHistory(events)
		expect(history.length).toBe(2)
		const first = defined(history[0], 'history[0]')
		const second = defined(history[1], 'history[1]')
		if (first.kind !== 'inquiry' || second.kind !== 'inquiry') throw new Error('expected inquiries')
		expect(first.answer).toBe('answer one')
		expect(second.answer).toBe('answer two')
	})

	test('records a plan modification with its target and aborted list', () => {
		const events: LogEvent[] = [
			{ timestamp: 't1', type: 'plan_modification', payload: { target: 'planner-0-1', targetRole: 'planner', message: 'use Postgres', aborted: ['coder-1-2', 'sub-coder-2-3'] } },
		]

		expect(deriveInterruptHistory(events)).toEqual([
			{ kind: 'plan_modification', askedAt: 't1', message: 'use Postgres', target: 'planner-0-1', targetRole: 'planner', aborted: ['coder-1-2', 'sub-coder-2-3'] },
		])
	})

	test('ignores operator_inquiry events, non-inquiry triggers, and malformed payloads', () => {
		const events: LogEvent[] = [
			{ timestamp: 't1', type: 'operator_inquiry', payload: { role: 'coder', message: 'status?' } },
			{ timestamp: 't2', type: 'interrupt', payload: null },
			{ timestamp: 't3', type: 'interrupt', payload: { trigger: 'loop_check', handler: 'loop_detector', target: 'coder-1-2' } },
			{ timestamp: 't4', type: 'interrupt', payload: { trigger: 'inquiry', handler: 'inquiry_responder', target: 'coder-1-2' } },
			{ timestamp: 't5', type: 'interrupt_resolved', payload: { trigger: 'inquiry', action: 'answered', summary: 'orphaned resolution' } },
			{ timestamp: 't6', type: 'plan_modification', payload: { message: 42 } },
			{ timestamp: 't7', type: 'interrupt', payload: { trigger: 'inquiry', handler: 'inquiry_responder', target: 'coder-1-2', message: 'ok?' } },
		]

		expect(deriveInterruptHistory(events)).toEqual([
			{ kind: 'inquiry', askedAt: 't7', role: 'inquiry_responder', message: 'ok?', answer: null, answeredAt: null, ended: false },
		])
	})

	test('returns an empty list for a log without interrupt events', () => {
		expect(deriveInterruptHistory([])).toEqual([])
	})
})

describe('deriveBudgets', () => {
	function llmCallEvent(role: string, timestamp: string, usage: { promptTokens: number; completionTokens: number; totalTokens: number; cachedPromptTokens?: number }): LogEvent {
		return { timestamp, type: 'llm_call', payload: { role, usage } }
	}

	function toolCallEvent(role: string, timestamp: string, tool: string): LogEvent {
		return { timestamp, type: 'tool_call', payload: { role, tool } }
	}

	test('derives elapsed time from meta.startTime to meta.endTime for a completed run', () => {
		const meta = sampleRunMeta({ startTime: '2026-01-01T00:00:00.000Z', endTime: '2026-01-01T00:01:30.000Z' })
		const budgets = deriveBudgets([], meta)
		expect(budgets.elapsedSeconds).toBe(90)
	})

	test('reports null elapsed for an in-progress run (meta null) — a live figure is the client’s to compute', () => {
		const logEvents: LogEvent[] = [
			{ timestamp: '2026-01-01T00:00:00.000Z', type: 'llm_call', payload: { role: 'planner' } },
			toolCallEvent('planner', '2026-01-01T00:00:10.000Z', 'read_file'),
		]
		const budgets = deriveBudgets(logEvents, null)
		expect(budgets.elapsedSeconds).toBeNull()
	})

	test('reports null elapsed for a run whose meta carries no stored endTime', () => {
		const meta = sampleRunMeta({ startTime: '2026-01-01T00:01:00.000Z', endTime: undefined })
		const budgets = deriveBudgets([], meta)
		expect(budgets.elapsedSeconds).toBeNull()
	})

	test('counts tool_call events across all roles', () => {
		const meta = sampleRunMeta()
		const logEvents: LogEvent[] = [
			toolCallEvent('planner', 't1', 'agent'),
			toolCallEvent('coder', 't2', 'write_file'),
			toolCallEvent('coder', 't3', 'read_file'),
			{ timestamp: 't4', type: 'tool_result', payload: { role: 'coder', tool: 'write_file', kind: 'success' } },
		]
		expect(deriveBudgets(logEvents, meta).toolCalls).toBe(3)
	})

	test('sums totalTokens from llm_call usage fields across roles', () => {
		const meta = sampleRunMeta()
		const logEvents: LogEvent[] = [
			llmCallEvent('planner', 't1', { promptTokens: 100, completionTokens: 20, totalTokens: 120 }),
			llmCallEvent('coder', 't2', { promptTokens: 200, completionTokens: 50, totalTokens: 250 }),
		]
		expect(deriveBudgets(logEvents, meta).tokensUsed).toBe(370)
	})

	test('returns null tokens when no llm_call event carries usage', () => {
		const meta = sampleRunMeta()
		const logEvents: LogEvent[] = [
			{ timestamp: 't1', type: 'llm_call', payload: { role: 'planner' } },
			toolCallEvent('planner', 't2', 'read_file'),
		]
		expect(deriveBudgets(logEvents, meta).tokensUsed).toBeNull()
		expect(deriveBudgets(logEvents, meta).tokenBreakdown).toBeNull()
	})

	test('sums usage from the events that carry it and skips those that do not', () => {
		const meta = sampleRunMeta()
		const logEvents: LogEvent[] = [
			{ timestamp: 't1', type: 'llm_call', payload: { role: 'planner' } },
			llmCallEvent('coder', 't2', { promptTokens: 40, completionTokens: 10, totalTokens: 50 }),
		]
		expect(deriveBudgets(logEvents, meta).tokensUsed).toBe(50)
	})

	test('does not throw on a malformed llm_call payload', () => {
		const meta = sampleRunMeta()
		const logEvents: LogEvent[] = [
			{ timestamp: 't1', type: 'llm_call', payload: 'broken' },
			{ timestamp: 't2', type: 'llm_call', payload: { role: 'coder', usage: 'not-an-object' } },
		]
		expect(deriveBudgets(logEvents, meta).tokensUsed).toBeNull()
	})

	test('returns null elapsed and zero tool calls for an empty log with no meta', () => {
		expect(deriveBudgets([], null)).toEqual({ elapsedSeconds: null, toolCalls: 0, tokensUsed: null, tokenBreakdown: null })
	})

	test('breaks tokens into prompt, cached prompt, and completion buckets', () => {
		const meta = sampleRunMeta()
		const logEvents: LogEvent[] = [
			llmCallEvent('planner', 't1', { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedPromptTokens: 60 }),
			llmCallEvent('coder', 't2', { promptTokens: 200, completionTokens: 50, totalTokens: 250 }),
		]
		expect(deriveBudgets(logEvents, meta).tokenBreakdown).toEqual({
			promptTokens: 300,
			cachedPromptTokens: 60,
			completionTokens: 70,
			totalTokens: 370,
		})
	})

	test('cachedPromptTokens defaults to 0 when no call reports a cached share', () => {
		const meta = sampleRunMeta()
		const logEvents: LogEvent[] = [
			llmCallEvent('planner', 't1', { promptTokens: 100, completionTokens: 20, totalTokens: 120 }),
		]
		const breakdown = present(deriveBudgets(logEvents, meta).tokenBreakdown, 'tokenBreakdown')
		expect(breakdown.cachedPromptTokens).toBe(0)
		expect(breakdown.promptTokens).toBe(100)
	})

	test('llm_retry usage is real spend and sums into the run-wide totals', () => {
		const meta = sampleRunMeta()
		const logEvents: LogEvent[] = [
			{ timestamp: 't1', type: 'llm_retry', payload: { role: 'coder', roleId: 'coder-0-1', discardedAttempts: 2, usage: { promptTokens: 90, completionTokens: 10, totalTokens: 100 } } },
			llmCallEvent('coder', 't2', { promptTokens: 100, completionTokens: 20, totalTokens: 120 }),
		]
		const budgets = deriveBudgets(logEvents, meta)
		expect(budgets.tokensUsed).toBe(220)
		const breakdown = present(budgets.tokenBreakdown, 'tokenBreakdown')
		expect(breakdown.promptTokens).toBe(190)
		expect(breakdown.completionTokens).toBe(30)
	})

	test('an llm_retry without a usage object contributes nothing', () => {
		const meta = sampleRunMeta()
		const logEvents: LogEvent[] = [
			{ timestamp: 't1', type: 'llm_retry', payload: { role: 'coder', roleId: 'coder-0-1', discardedAttempts: 1 } },
			llmCallEvent('coder', 't2', { promptTokens: 40, completionTokens: 10, totalTokens: 50 }),
		]
		expect(deriveBudgets(logEvents, meta).tokensUsed).toBe(50)
	})

	test('summarizer_llm_call usage sums into the run-wide totals without naming a role', () => {
		const meta = sampleRunMeta()
		const logEvents: LogEvent[] = [
			{ timestamp: 't1', type: 'summarizer_llm_call', payload: { usage: { promptTokens: 500, completionTokens: 30, totalTokens: 530 } } },
			llmCallEvent('coder', 't2', { promptTokens: 40, completionTokens: 10, totalTokens: 50 }),
		]
		expect(deriveBudgets(logEvents, meta).tokensUsed).toBe(580)
	})

	test('does not throw on a malformed llm_retry or summarizer_llm_call payload', () => {
		const meta = sampleRunMeta()
		const logEvents: LogEvent[] = [
			{ timestamp: 't1', type: 'llm_retry', payload: 'broken' },
			{ timestamp: 't2', type: 'summarizer_llm_call', payload: { usage: 'not-an-object' } },
		]
		expect(deriveBudgets(logEvents, meta).tokensUsed).toBeNull()
	})
})

describe('deriveCurrentActivity', () => {
	test('reports the last event role and its one-line rendering', () => {
		const events: LogEvent[] = [
			{ timestamp: 't1', type: 'llm_call', payload: { role: 'planner' } },
			{ timestamp: 't2', type: 'tool_call', payload: { role: 'coder', tool: 'write_file' } },
		]
		expect(deriveCurrentActivity(events)).toEqual({ role: 'coder', summary: 'coder · write_file' })
	})

	test('returns null for an empty log', () => {
		expect(deriveCurrentActivity([])).toBeNull()
	})

	test('renders a malformed payload without throwing', () => {
		const events: LogEvent[] = [{ timestamp: 't1', type: 'llm_call', payload: 'broken' }]
		expect(deriveCurrentActivity(events)).toEqual({ role: null, summary: 'llm call' })
	})
})
