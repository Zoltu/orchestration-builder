import { describe, expect, test } from 'bun:test'
import type { RunSnapshotRaw } from '../executor/persistence.js'
import type { PendingQuestion } from '../executor/human-backend.js'
import type { DeploymentConfig, LogEvent, RunMeta, GuildConfig } from '../executor/types.js'
import {
	deriveBudgets,
	deriveInterruptHistory,
	deriveQuestionHistory,
	deriveRoleActivity,
	deriveRoleTree,
	formatLogDetailSections,
	formatLogAsText,
	formatLogEvent,
	paginateLogEvents,
	parseLogEvents,
	parseRunMeta,
	parseRunSnapshot,
	renderConfig,
	renderProjectSettings,
	renderPendingQuestions,
	renderRunSummary,
	renderRunView,
	toRecentLogEntry,
} from './render.ts'
import { defined, present } from './test-fixtures.js'

// A fixed "now" so renderRunView's elapsed-time output is deterministic; completed runs use meta.endTime regardless, but in-progress views use this value.
const NOW = '2026-01-01T00:02:00.000Z'

function logEvent(type: string, role: string, timestamp: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ timestamp, type, payload: { role, ...extra } })
}

function askHumanEvent(id: string, question: string, timestamp: string, context?: string): string {
	const payload: Record<string, unknown> = { id, question }
	if (context !== undefined) payload['context'] = context
	return JSON.stringify({ timestamp, type: 'ask_human', payload })
}

function humanAnswerEvent(id: string, answer: string, timestamp: string): string {
	return JSON.stringify({ timestamp, type: 'human_answer', payload: { id, answer } })
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

describe('parseLogEvents', () => {
	test('parses each valid jsonl line into a log event', () => {
		const text = [
			logEvent('llm_call', 'planner', '2026-01-01T00:00:01.000Z', { messageCount: 3 }),
			logEvent('tool_call', 'planner', '2026-01-01T00:00:02.000Z', { tool: 'agent' }),
			'',
			logEvent('role_finished', 'planner', '2026-01-01T00:00:03.000Z', { status: 'success' }),
		].join('\n')

		const events = parseLogEvents(text)
		expect(events.length).toBe(3)
		expect(defined(events[0], 'events[0]').type).toBe('llm_call')
		expect(defined(events[1], 'events[1]').type).toBe('tool_call')
		expect(defined(events[2], 'events[2]').type).toBe('role_finished')
	})

	test('skips a malformed line without aborting the rest of the tail', () => {
		const text = [
			logEvent('llm_call', 'planner', '2026-01-01T00:00:01.000Z'),
			'{ not valid json',
			logEvent('tool_call', 'planner', '2026-01-01T00:00:02.000Z', { tool: 'finish' }),
		].join('\n')

		const events = parseLogEvents(text)
		expect(events.length).toBe(2)
		expect(defined(events[0], 'events[0]').type).toBe('llm_call')
		expect(defined(events[1], 'events[1]').type).toBe('tool_call')
	})

	test('skips a line that is not a valid log event shape', () => {
		const text = [
			logEvent('llm_call', 'planner', '2026-01-01T00:00:01.000Z'),
			JSON.stringify({ timestamp: '2026-01-01T00:00:02.000Z' }),
		].join('\n')

		const events = parseLogEvents(text)
		expect(events.length).toBe(1)
	})

	test('returns an empty array for an empty log', () => {
		expect(parseLogEvents('')).toEqual([])
	})
})

describe('parseRunSnapshot', () => {
	test('parses a present meta and the log events together', () => {
		const raw: RunSnapshotRaw = {
			metaText: JSON.stringify(sampleRunMeta()),
			logText: logEvent('llm_call', 'planner', '2026-01-01T00:00:01.000Z'),
		}

		const snapshot = parseRunSnapshot(raw)
		expect(snapshot.meta?.runId).toBe('run-1')
		expect(snapshot.logEvents.length).toBe(1)
	})

	test('returns null meta when metaText is null (run in progress)', () => {
		const snapshot = parseRunSnapshot({ metaText: null, logText: '' })
		expect(snapshot.meta).toBeNull()
		expect(snapshot.logEvents).toEqual([])
	})

	test('returns null meta when metaText is malformed', () => {
		const snapshot = parseRunSnapshot({ metaText: '{ broken', logText: '' })
		expect(snapshot.meta).toBeNull()
	})

	test('returns null meta when metaText is not a valid RunMeta', () => {
		const snapshot = parseRunSnapshot({ metaText: JSON.stringify({ runId: 123 }), logText: '' })
		expect(snapshot.meta).toBeNull()
	})

	test('returns null meta when the effort is not a tier string', () => {
		expect(parseRunMeta(JSON.stringify({ ...sampleRunMeta(), effort: 4 }))).toBeNull()
	})
})

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

	test('falls back to agent_call edges for a role_start that omitted parent (pre-enhancement log)', () => {
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

describe('formatLogDetailSections', () => {
	function event(type: string, payload: unknown): LogEvent {
		return { timestamp: 't', type, payload }
	}

	test('an llm_call with sent/received/finishReason/usage yields four paired sections', () => {
		const sections = present(formatLogDetailSections(event('llm_call', {
			role: 'coder',
			messageCount: 2,
			sent: [{ role: 'system', content: 'p' }, { role: 'user', content: 't' }],
			received: { content: 'ok', toolCalls: [] },
			finishReason: 'stop',
			usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
		})), 'sections')
		expect(sections).not.toBeNull()
		expect(sections.map((s) => s.label)).toEqual(['sent', 'received', 'finish reason', 'usage'])
		expect(defined(sections[0], 'sections[0]').content).toEqual([{ role: 'system', content: 'p' }, { role: 'user', content: 't' }])
		expect(defined(sections[2], 'sections[2]').content).toBe('stop')
	})

	test('an llm_call omitting finishReason omits the finish reason section', () => {
		const sections = present(formatLogDetailSections(event('llm_call', {
			role: 'coder',
			sent: [{ role: 'user', content: 't' }],
			received: { toolCalls: [] },
			usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
		})), 'sections')
		expect(sections.map((s) => s.label)).toEqual(['sent', 'received', 'usage'])
	})

	test('a tool_call arguments and a tool_result full result each shape their paired fields', () => {
		const callSections = present(formatLogDetailSections(event('tool_call', { role: 'coder', tool: 'write_file', arguments: '{"path":"x"}' })), 'callSections')
		expect(callSections.map((s) => s.label)).toEqual(['arguments'])
		expect(defined(callSections[0], 'callSections[0]').content).toBe('{"path":"x"}')

		const resultSections = present(formatLogDetailSections(event('tool_result', { role: 'coder', tool: 'write_file', kind: 'success', result: { kind: 'success', data: { path: 'x', bytes: 4 } } })), 'resultSections')
		expect(resultSections.map((s) => s.label)).toEqual(['result'])
		expect(defined(resultSections[0], 'resultSections[0]').content).toEqual({ kind: 'success', data: { path: 'x', bytes: 4 } })
	})

	test('a tool_call carrying both arguments and a paired result yields both sections', () => {
		const sections = present(formatLogDetailSections(event('tool_result', { role: 'coder', tool: 'write_file', kind: 'success', arguments: '{"path":"y"}', result: { kind: 'success', data: { path: 'y' } } })), 'sections')
		expect(sections.map((s) => s.label)).toEqual(['arguments', 'result'])
	})

	test('a role_finished with summary and error yields paired sections', () => {
		const sections = present(formatLogDetailSections(event('role_finished', { role: 'coder', status: 'error', summary: 'could not parse', error: { kind: 'invalid_arguments', message: 'bad json' } })), 'sections')
		expect(sections).not.toBeNull()
		expect(sections.map((s) => s.label)).toEqual(['summary', 'error'])
		expect(defined(sections[0], 'sections[0]').content).toBe('could not parse')
		expect(defined(sections[1], 'sections[1]').content).toEqual({ kind: 'invalid_arguments', message: 'bad json' })
	})

	test('returns null for an event type with no paired detail', () => {
		// A role_finished carrying only status (no summary/error) has no paired detail.
		expect(formatLogDetailSections(event('role_finished', { role: 'x', status: 'success' }))).toBeNull()
		expect(formatLogDetailSections(event('llm_unavailable', { role: 'x', message: 'down' }))).toBeNull()
	})

	test('returns null for a malformed payload', () => {
		expect(formatLogDetailSections(event('llm_call', 'broken'))).toBeNull()
		expect(formatLogDetailSections(event('llm_call', null))).toBeNull()
	})
})

describe('formatLogEvent', () => {
	function event(type: string, payload: unknown): LogEvent {
		return { timestamp: 't', type, payload }
	}

	test('llm_call → role · llm call', () => {
		expect(formatLogEvent(event('llm_call', { role: 'coder', messageCount: 3 }))).toBe('coder · llm call')
	})

	test('tool_call → role · tool', () => {
		expect(formatLogEvent(event('tool_call', { role: 'coder', tool: 'write_file' }))).toBe('coder · write_file')
	})

	test('tool_result → role · tool result (kind)', () => {
		expect(formatLogEvent(event('tool_result', { role: 'coder', tool: 'write_file', kind: 'success' }))).toBe('coder · write_file result (success)')
	})

	test('role_finished → role · finished (status)', () => {
		expect(formatLogEvent(event('role_finished', { role: 'planner', status: 'success' }))).toBe('planner · finished (success)')
	})

	test('role_finished omits the summary from the one-line view to keep long model prose from widening the row', () => {
		expect(formatLogEvent(event('role_finished', { role: 'coder', status: 'success', summary: 'wrote output.txt' }))).toBe('coder · finished (success)')
	})

	test('role_finished shows status only on error; the summary and error reach the raw detail sections instead', () => {
		expect(formatLogEvent(event('role_finished', { role: 'coder', status: 'error', summary: 'could not parse the file', error: { kind: 'invalid_arguments', message: 'bad json' } }))).toBe('coder · finished (error)')
	})

	test('role_finished without status omits the parenthetical', () => {
		expect(formatLogEvent(event('role_finished', { role: 'planner' }))).toBe('planner · finished')
	})

	test('implicit_finish → role · finished (implicit)', () => {
		expect(formatLogEvent(event('implicit_finish', { role: 'coder', summary: 'done' }))).toBe('coder · finished (implicit)')
	})

	test('llm_unavailable → role · llm unavailable', () => {
		expect(formatLogEvent(event('llm_unavailable', { role: 'coder', message: 'down' }))).toBe('coder · llm unavailable')
	})

	test('context_budget_exceeded → role · context budget exceeded', () => {
		expect(formatLogEvent(event('context_budget_exceeded', { role: 'coder', promptTokens: 100, contextWindow: 50 }))).toBe('coder · context budget exceeded')
	})

	test('context_compacted → role · context compacted by platform', () => {
		expect(formatLogEvent(event('context_compacted', { role: 'coder', droppedMessages: 4, truncatedToolMessages: 0, strippedReasoningMessages: 1, estimatedPromptTokens: 400, contextWindow: 1000 }))).toBe('coder · context compacted by platform')
	})

	test('context_pressure → role · context pressure — handoff notice sent', () => {
		expect(formatLogEvent(event('context_pressure', { role: 'coder', promptTokens: 800, effectiveBudget: 900 }))).toBe('coder · context pressure — handoff notice sent')
	})

	test('role_budget_exceeded → role · role budget exceeded', () => {
		expect(formatLogEvent(event('role_budget_exceeded', { role: 'coder', phase: 'post_llm', error: { kind: 'compaction_failed' } }))).toBe('coder · role budget exceeded')
	})

	test('global_budget_exceeded → role · global budget exceeded', () => {
		expect(formatLogEvent(event('global_budget_exceeded', { role: 'coder', error: { kind: 'timeout' } }))).toBe('coder · global budget exceeded')
	})

	test('unknown_tool → role · unknown tool (tool)', () => {
		expect(formatLogEvent(event('unknown_tool', { role: 'coder', tool: 'frobnicate' }))).toBe('coder · unknown tool (frobnicate)')
	})

	test('invalid_tool_call → role · invalid tool call (tool)', () => {
		expect(formatLogEvent(event('invalid_tool_call', { role: 'coder', tool: 'write_file' }))).toBe('coder · invalid tool call (write_file)')
	})

	test('depth_exceeded → parent · depth exceeded (child at depth N)', () => {
		expect(formatLogEvent(event('depth_exceeded', { parent: 'orchestrator', child: 'coder', depth: 8, error: { kind: 'agent_depth_exceeded' } }))).toBe('orchestrator · depth exceeded (coder at depth 8)')
	})

	test('role_not_found uses parent as the acting role when present', () => {
		expect(formatLogEvent(event('role_not_found', { parent: 'orchestrator', roleName: 'missing' }))).toBe('orchestrator · role not found (missing)')
	})

	test('role_not_found without parent renders the bare detail', () => {
		expect(formatLogEvent(event('role_not_found', { roleName: 'missing' }))).toBe('role not found (missing)')
	})

	test('role_start → role · role start', () => {
		expect(formatLogEvent(event('role_start', { role: 'planner', depth: 0, task: 'do it' }))).toBe('planner · role start')
	})

	test('effort_set renders the chosen level', () => {
		expect(formatLogEvent(event('effort_set', { effort: 'standard' }))).toBe('effort set (standard)')
	})

	test('effort_set without an effort value renders the bare action', () => {
		expect(formatLogEvent(event('effort_set', {}))).toBe('effort set')
	})

	test('agent_call → parent · agent call → child', () => {
		expect(formatLogEvent(event('agent_call', { parent: 'orchestrator', child: 'coder', depth: 1 }))).toBe('orchestrator · agent call → coder')
	})

	test('agent_call falls back to the payload role when parent is absent', () => {
		expect(formatLogEvent(event('agent_call', { role: 'orchestrator', child: 'coder' }))).toBe('orchestrator · agent call → coder')
	})

	test('interrupt → interrupt (handler on target)', () => {
		expect(formatLogEvent(event('interrupt', { trigger: 'loop_check', handler: 'loop_detector', target: 'coder-1-2' }))).toBe('interrupt (loop_detector on coder-1-2)')
	})

	test('interrupt without handler and target renders the bare type', () => {
		expect(formatLogEvent(event('interrupt', { trigger: 'context_pressure' }))).toBe('interrupt')
	})

	test('interrupt_resolved → interrupt resolved (action on target)', () => {
		expect(formatLogEvent(event('interrupt_resolved', { trigger: 'inquiry', action: 'answered', target: 'coder-1-2' }))).toBe('interrupt resolved (answered on coder-1-2)')
	})

	test('observe → role · observe (details)', () => {
		expect(formatLogEvent(event('observe', { role: 'coder', roleId: 'coder-1-2', details: 'read_message_window' }))).toBe('coder · observe (read_message_window)')
	})

	test('observe without details renders the bare action', () => {
		expect(formatLogEvent(event('observe', { role: 'coder' }))).toBe('coder · observe')
	})

	test('operator_notice → role · operator notice', () => {
		expect(formatLogEvent(event('operator_notice', { role: 'orchestrator', roleId: 'orchestrator-0-1', message: 'winding down' }))).toBe('orchestrator · operator notice')
	})

	test('inquiry_dropped → inquiry dropped (reason)', () => {
		expect(formatLogEvent(event('inquiry_dropped', { message: 'hello?', reason: 'no handler role configured' }))).toBe('inquiry dropped (no handler role configured)')
	})

	test('inquiry_dropped without a reason renders the bare action', () => {
		expect(formatLogEvent(event('inquiry_dropped', { message: 'hello?' }))).toBe('inquiry dropped')
	})

	test('the retired operator_inquiry still reads sensibly in historical logs', () => {
		expect(formatLogEvent(event('operator_inquiry', { role: 'orchestrator', roleId: 'orchestrator-0-1', message: 'status?' }))).toBe('orchestrator · operator inquiry')
	})

	test('an unknown event type with a role falls back to type · role', () => {
		expect(formatLogEvent(event('something_new', { role: 'coder' }))).toBe('something_new · coder')
	})

	test('an unknown event type without a role renders the bare type', () => {
		expect(formatLogEvent(event('something_new', { unrelated: true }))).toBe('something_new')
	})

	test('does not throw on a non-object payload', () => {
		expect(formatLogEvent(event('llm_call', 'broken'))).toBe('llm call')
		expect(formatLogEvent(event('tool_call', null))).toBe('tool call')
	})

	test('does not throw on an undefined payload', () => {
		expect(formatLogEvent(event('role_finished', undefined))).toBe('finished')
	})
})

describe('renderRunView', () => {
	test('shapes a completed run from its meta and log', () => {
		const snapshot = parseRunSnapshot({
			metaText: JSON.stringify(sampleRunMeta()),
			logText: [
				logEvent('llm_call', 'planner', '2026-01-01T00:00:01.000Z'),
				logEvent('role_finished', 'planner', '2026-01-01T00:00:02.000Z', { status: 'success' }),
			].join('\n'),
		})

		const view = renderRunView(snapshot, { maxLogLines: 200, now: NOW })
		expect(view.status).toBe('success')
		expect(view.runId).toBe('run-1')
		expect(view.task).toBe('fix the bug')
		expect(view.startTime).toBe('2026-01-01T00:00:00.000Z')
		expect(view.endTime).toBe('2026-01-01T00:01:00.000Z')
		expect(view.roles.length).toBe(1)
		expect(defined(view.roles[0], 'view.roles[0]').role).toBe('planner')
		expect(view.recentLog.length).toBe(2)
		expect(view.budgets).toEqual({ elapsedSeconds: 60, toolCalls: 0, tokensUsed: null, tokenBreakdown: null })
	})

	test('reports unknown status when meta is absent (run in progress)', () => {
		const snapshot = parseRunSnapshot({ metaText: null, logText: logEvent('llm_call', 'planner', 't1') })
		const view = renderRunView(snapshot, { maxLogLines: 200, now: NOW })
		expect(view.status).toBe('unknown')
		expect(view.runId).toBeNull()
		expect(view.task).toBeNull()
		expect(view.result).toBeNull()
		expect(view.roles.length).toBe(1)
	})

	test('surfaces the run effort from meta.effort, or null when meta is absent or predates the channel', () => {
		const withEffort = parseRunSnapshot({
			metaText: JSON.stringify(sampleRunMeta({ effort: 'thorough' })),
			logText: '',
		})
		expect(renderRunView(withEffort, { maxLogLines: 200, now: NOW }).effort).toBe('thorough')

		const withoutEffort = parseRunSnapshot({ metaText: JSON.stringify(sampleRunMeta()), logText: '' })
		expect(renderRunView(withoutEffort, { maxLogLines: 200, now: NOW }).effort).toBeNull()

		const inProgress = parseRunSnapshot({ metaText: null, logText: '' })
		expect(renderRunView(inProgress, { maxLogLines: 200, now: NOW }).effort).toBeNull()
	})

	test('surfaces the run lineage from meta.continuesFrom, or null when absent or meta is missing', () => {
		const continuation = parseRunSnapshot({
			metaText: JSON.stringify(sampleRunMeta({ continuesFrom: 'run-20260101-000000' })),
			logText: '',
		})
		expect(renderRunView(continuation, { maxLogLines: 200, now: NOW }).continuesFrom).toBe('run-20260101-000000')

		const standalone = parseRunSnapshot({ metaText: JSON.stringify(sampleRunMeta()), logText: '' })
		expect(renderRunView(standalone, { maxLogLines: 200, now: NOW }).continuesFrom).toBeNull()

		const inProgress = parseRunSnapshot({ metaText: null, logText: '' })
		expect(renderRunView(inProgress, { maxLogLines: 200, now: NOW }).continuesFrom).toBeNull()
	})

	test('carries the raw plan markdown through to the view, or null when the caller read none', () => {
		const snapshot = parseRunSnapshot({ metaText: JSON.stringify(sampleRunMeta()), logText: '' })
		expect(renderRunView(snapshot, { maxLogLines: 200, now: NOW, plan: '# Plan\n\nstep one' }).plan).toBe('# Plan\n\nstep one')
		expect(renderRunView(snapshot, { maxLogLines: 200, now: NOW, plan: null }).plan).toBeNull()
		expect(renderRunView(snapshot, { maxLogLines: 200, now: NOW }).plan).toBeNull()
	})

	test('truncates the recent log to the last maxLogLines events', () => {
		const lines: string[] = []
		for (let i = 0; i < 10; i++) {
			lines.push(logEvent('llm_call', 'planner', `t${i}`))
		}
		const snapshot = parseRunSnapshot({ metaText: null, logText: lines.join('\n') })

		const view = renderRunView(snapshot, { maxLogLines: 3, now: NOW })
		expect(view.recentLog.length).toBe(3)
		expect(defined(view.recentLog[0], 'view.recentLog[0]').timestamp).toBe('t7')
		expect(defined(view.recentLog[2], 'view.recentLog[2]').timestamp).toBe('t9')
	})

	test('uses the full log when fewer than maxLogLines events exist', () => {
		const snapshot = parseRunSnapshot({
			metaText: null,
			logText: logEvent('llm_call', 'planner', 't1'),
		})
		const view = renderRunView(snapshot, { maxLogLines: 200, now: NOW })
		expect(view.recentLog.length).toBe(1)
	})

	test('result is null when the meta has no result field', () => {
		const snapshot = parseRunSnapshot({
			metaText: JSON.stringify(sampleRunMeta({ result: undefined })),
			logText: '',
		})
		const view = renderRunView(snapshot, { maxLogLines: 200, now: NOW })
		expect(view.result).toBeNull()
	})

	test('recentLog entries carry the log-wide index and the one-line text, with no payload or detail sections', () => {
		const snapshot = parseRunSnapshot({
			metaText: null,
			logText: [
				logEvent('llm_call', 'planner', 't1'),
				logEvent('tool_call', 'planner', 't2', { tool: 'agent' }),
			].join('\n'),
		})

		const view = renderRunView(snapshot, { maxLogLines: 200, now: NOW })
		expect(view.recentLog.length).toBe(2)
		expect(view.recentLog[0]).toEqual({
			index: 0,
			timestamp: 't1',
			type: 'llm_call',
			text: 'planner · llm call',
		})
		expect(defined(view.recentLog[1], 'view.recentLog[1]').text).toBe('planner · agent')
		expect(defined(view.recentLog[1], 'view.recentLog[1]').index).toBe(1)
	})

	test('recentLog indices are log-wide: a truncated window starts above zero', () => {
		const lines: string[] = []
		for (let i = 0; i < 10; i++) {
			lines.push(logEvent('llm_call', 'planner', `t${i}`))
		}
		const snapshot = parseRunSnapshot({ metaText: null, logText: lines.join('\n') })

		const view = renderRunView(snapshot, { maxLogLines: 3, now: NOW })
		expect(view.recentLog.map((entry) => entry.index)).toEqual([7, 8, 9])
	})

	test('error is null while a run is in progress', () => {
		const snapshot = parseRunSnapshot({ metaText: null, logText: '' })
		const view = renderRunView(snapshot, { maxLogLines: 200, now: NOW })
		expect(view.error).toBeNull()
	})

	test('error is null when a completed run has no error', () => {
		const snapshot = parseRunSnapshot({ metaText: JSON.stringify(sampleRunMeta()), logText: '' })
		const view = renderRunView(snapshot, { maxLogLines: 200, now: NOW })
		expect(view.error).toBeNull()
	})

	test('error surfaces the kind and message of a failed run', () => {
		const snapshot = parseRunSnapshot({
			metaText: JSON.stringify(sampleRunMeta({
				status: 'error',
				error: { kind: 'llm_unavailable', message: 'connection refused' },
			})),
			logText: '',
		})

		const view = renderRunView(snapshot, { maxLogLines: 200, now: NOW })
		expect(view.error).toEqual({ kind: 'llm_unavailable', message: 'connection refused' })
	})

	test('currentActivity reflects the most recent event role and summary', () => {
		const snapshot = parseRunSnapshot({
			metaText: null,
			logText: [
				logEvent('llm_call', 'planner', 't1'),
				logEvent('tool_call', 'coder', 't2', { tool: 'write_file' }),
			].join('\n'),
		})

		const view = renderRunView(snapshot, { maxLogLines: 200, now: NOW })
		expect(view.currentActivity).toEqual({ role: 'coder', summary: 'coder · write_file' })
	})

	test('currentActivity is null for an empty log', () => {
		const snapshot = parseRunSnapshot({ metaText: null, logText: '' })
		const view = renderRunView(snapshot, { maxLogLines: 200, now: NOW })
		expect(view.currentActivity).toBeNull()
	})

	test('roleTree is null when the log carries no role_start/role_finished/agent_call events', () => {
		const snapshot = parseRunSnapshot({
			metaText: null,
			logText: [
				logEvent('llm_call', 'planner', 't1'),
				logEvent('tool_call', 'planner', 't2', { tool: 'finish' }),
			].join('\n'),
		})
		const view = renderRunView(snapshot, { maxLogLines: 200, now: NOW })
		expect(view.roleTree).toBeNull()
		expect(view.roles.length).toBe(1)
	})

	test('roleTree surfaces a parent→child tree when role_start/role_finished events are present', () => {
		const snapshot = parseRunSnapshot({
			metaText: null,
			logText: [
				JSON.stringify({ timestamp: 't1', type: 'role_start', payload: { role: 'orchestrator', depth: 0, task: 't' } }),
				JSON.stringify({ timestamp: 't2', type: 'agent_call', payload: { parent: 'orchestrator', child: 'coder', depth: 1 } }),
				JSON.stringify({ timestamp: 't3', type: 'role_start', payload: { role: 'coder', depth: 1, parent: 'orchestrator', task: 'code' } }),
				JSON.stringify({ timestamp: 't4', type: 'role_finished', payload: { role: 'coder', depth: 1, status: 'success', parent: 'orchestrator' } }),
				JSON.stringify({ timestamp: 't5', type: 'role_finished', payload: { role: 'orchestrator', depth: 0, status: 'success' } }),
			].join('\n'),
		})
		const view = renderRunView(snapshot, { maxLogLines: 200, now: NOW })
		expect(view.roleTree).not.toBeNull()
		const roleTree = present(view.roleTree, 'view.roleTree')
		expect(roleTree.length).toBe(1)
		const rootNode = defined(roleTree[0], 'roleTree[0]')
		expect(rootNode.role).toBe('orchestrator')
		expect(rootNode.children.length).toBe(1)
		expect(defined(rootNode.children[0], 'rootNode.children[0]').role).toBe('coder')
	})

	test('questionHistory pairs ask_human events with their human_answer events', () => {
		const snapshot = parseRunSnapshot({
			metaText: null,
			logText: [
				askHumanEvent('q1', 'Which file?', 't1', 'src/index.ts'),
				humanAnswerEvent('q1', 'src/index.ts', 't2'),
				askHumanEvent('q2', 'What next?', 't3'),
			].join('\n'),
		})

		const view = renderRunView(snapshot, { maxLogLines: 200, now: NOW })
		expect(view.questionHistory.length).toBe(2)
		expect(view.questionHistory[0]).toEqual({
			id: 'q1',
			question: 'Which file?',
			context: 'src/index.ts',
			askedAt: 't1',
			answer: 'src/index.ts',
			answeredAt: 't2',
		})
		expect(view.questionHistory[1]).toEqual({
			id: 'q2',
			question: 'What next?',
			askedAt: 't3',
		})
	})

	test('questionHistory is empty for a log with no ask_human events', () => {
		const snapshot = parseRunSnapshot({
			metaText: null,
			logText: [
				logEvent('llm_call', 'planner', 't1'),
				logEvent('role_finished', 'planner', 't2', { status: 'success' }),
			].join('\n'),
		})

		const view = renderRunView(snapshot, { maxLogLines: 200, now: NOW })
		expect(view.questionHistory).toEqual([])
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

	test('ignores retired operator_inquiry events, non-inquiry triggers, and malformed payloads', () => {
		const events: LogEvent[] = [
			{ timestamp: 't1', type: 'operator_inquiry', payload: { role: 'coder', message: 'legacy?' } },
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
		const budgets = deriveBudgets([], meta, '2026-06-24T00:00:00.000Z')
		expect(budgets.elapsedSeconds).toBe(90)
	})

	test('derives elapsed time from the first log event to now for an in-progress run (meta null)', () => {
		const logEvents: LogEvent[] = [
			{ timestamp: '2026-01-01T00:00:00.000Z', type: 'llm_call', payload: { role: 'planner' } },
			toolCallEvent('planner', '2026-01-01T00:00:10.000Z', 'read_file'),
		]
		const budgets = deriveBudgets(logEvents, null, '2026-01-01T00:00:40.000Z')
		expect(budgets.elapsedSeconds).toBe(40)
	})

	test('clamps elapsed to 0 when now precedes the start (client/server clock skew)', () => {
		const meta = sampleRunMeta({ startTime: '2026-01-01T00:01:00.000Z' })
		const budgets = deriveBudgets([], meta, '2026-01-01T00:00:00.000Z')
		expect(budgets.elapsedSeconds).toBe(0)
	})

	test('counts tool_call events across all roles', () => {
		const meta = sampleRunMeta()
		const logEvents: LogEvent[] = [
			toolCallEvent('planner', 't1', 'agent'),
			toolCallEvent('coder', 't2', 'write_file'),
			toolCallEvent('coder', 't3', 'read_file'),
			{ timestamp: 't4', type: 'tool_result', payload: { role: 'coder', tool: 'write_file', kind: 'success' } },
		]
		expect(deriveBudgets(logEvents, meta, NOW).toolCalls).toBe(3)
	})

	test('sums totalTokens from llm_call usage fields across roles', () => {
		const meta = sampleRunMeta()
		const logEvents: LogEvent[] = [
			llmCallEvent('planner', 't1', { promptTokens: 100, completionTokens: 20, totalTokens: 120 }),
			llmCallEvent('coder', 't2', { promptTokens: 200, completionTokens: 50, totalTokens: 250 }),
		]
		expect(deriveBudgets(logEvents, meta, NOW).tokensUsed).toBe(370)
	})

	test('returns null tokens when no llm_call event carries usage', () => {
		const meta = sampleRunMeta()
		const logEvents: LogEvent[] = [
			{ timestamp: 't1', type: 'llm_call', payload: { role: 'planner' } },
			toolCallEvent('planner', 't2', 'read_file'),
		]
		expect(deriveBudgets(logEvents, meta, NOW).tokensUsed).toBeNull()
		expect(deriveBudgets(logEvents, meta, NOW).tokenBreakdown).toBeNull()
	})

	test('sums usage from the events that carry it and skips those that do not', () => {
		const meta = sampleRunMeta()
		const logEvents: LogEvent[] = [
			{ timestamp: 't1', type: 'llm_call', payload: { role: 'planner' } },
			llmCallEvent('coder', 't2', { promptTokens: 40, completionTokens: 10, totalTokens: 50 }),
		]
		expect(deriveBudgets(logEvents, meta, NOW).tokensUsed).toBe(50)
	})

	test('does not throw on a malformed llm_call payload', () => {
		const meta = sampleRunMeta()
		const logEvents: LogEvent[] = [
			{ timestamp: 't1', type: 'llm_call', payload: 'broken' },
			{ timestamp: 't2', type: 'llm_call', payload: { role: 'coder', usage: 'not-an-object' } },
		]
		expect(deriveBudgets(logEvents, meta, NOW).tokensUsed).toBeNull()
	})

	test('returns zero elapsed and zero tool calls for an empty log with no meta', () => {
		expect(deriveBudgets([], null, NOW)).toEqual({ elapsedSeconds: 0, toolCalls: 0, tokensUsed: null, tokenBreakdown: null })
	})

	test('breaks tokens into prompt, cached prompt, and completion buckets', () => {
		const meta = sampleRunMeta()
		const logEvents: LogEvent[] = [
			llmCallEvent('planner', 't1', { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedPromptTokens: 60 }),
			llmCallEvent('coder', 't2', { promptTokens: 200, completionTokens: 50, totalTokens: 250 }),
		]
		expect(deriveBudgets(logEvents, meta, NOW).tokenBreakdown).toEqual({
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
		const breakdown = present(deriveBudgets(logEvents, meta, NOW).tokenBreakdown, 'tokenBreakdown')
		expect(breakdown.cachedPromptTokens).toBe(0)
		expect(breakdown.promptTokens).toBe(100)
	})
})

describe('renderRunSummary', () => {
	test('shapes a completed run from its meta, taking runId from the directory name', () => {
		const meta = parseRunMeta(JSON.stringify(sampleRunMeta({ runId: 'on-disk-id' })))

		const summary = renderRunSummary('dir-name', meta, null)
		expect(summary).toEqual({
			runId: 'dir-name',
			status: 'success',
			task: 'fix the bug',
			effort: null,
			startTime: '2026-01-01T00:00:00.000Z',
			endTime: '2026-01-01T00:01:00.000Z',
			result: null,
			error: null,
			summary: null,
		})
	})

	test('reports unknown status and null fields when meta is absent (run in progress)', () => {
		const summary = renderRunSummary('run-in-progress', parseRunMeta(null), null)
		expect(summary).toEqual({
			runId: 'run-in-progress',
			status: 'unknown',
			task: null,
			effort: null,
			startTime: null,
			endTime: null,
			result: null,
			error: null,
			summary: null,
		})
	})

	test('endTime is null when the meta omits it', () => {
		const meta = parseRunMeta(JSON.stringify(sampleRunMeta({ endTime: undefined })))

		const summary = renderRunSummary('r', meta, null)
		expect(summary.endTime).toBeNull()
	})

	test('carries the run effort from meta.effort', () => {
		const meta = parseRunMeta(JSON.stringify(sampleRunMeta({ effort: 'thorough' })))
		expect(renderRunSummary('r', meta, null).effort).toBe('thorough')
	})

	test('passes the result card and run-level error through so the history view can browse outcomes', () => {
		const meta = parseRunMeta(JSON.stringify(sampleRunMeta({
			result: { status: 'success', summary: 'fixed it', artifacts: ['a.ts'] },
			error: { kind: 'llm_unavailable', message: 'endpoint down' },
		})))
		const summary = renderRunSummary('r', meta, null)
		expect(summary.result).toEqual({ status: 'success', summary: 'fixed it', artifacts: ['a.ts'] })
		expect(summary.error).toEqual({ kind: 'llm_unavailable', message: 'endpoint down' })
	})

	test('carries the generated one-line summary through to the client', () => {
		const meta = parseRunMeta(JSON.stringify(sampleRunMeta()))
		expect(renderRunSummary('r', meta, 'Fixed the login bug').summary).toBe('Fixed the login bug')
		expect(renderRunSummary('r', meta, null).summary).toBeNull()
	})
})

describe('renderProjectSettings', () => {
	test('returns both fields null when no default has been set', () => {
		expect(renderProjectSettings({})).toEqual({ effort: null, logLevel: null })
	})

	test('returns the stored values when set', () => {
		expect(renderProjectSettings({ effort: 'thorough', logLevel: 'standard' })).toEqual({ effort: 'thorough', logLevel: 'standard' })
	})

	test('returns exactly the effort and logLevel fields in its output shape', () => {
		expect(Object.keys(renderProjectSettings({ effort: 'quick', logLevel: 'full' }))).toEqual(['effort', 'logLevel'])
	})
})

describe('renderPendingQuestions', () => {
	test('shapes each pending question preserving order', () => {
		const questions: PendingQuestion[] = [
			{ id: 'q1', question: 'Which file?', context: 'src/index.ts', askedAt: 't1' },
			{ id: 'q2', question: 'What next?', askedAt: 't2' },
		]

		const shaped = renderPendingQuestions(questions)
		expect(shaped).toEqual([
			{ id: 'q1', question: 'Which file?', context: 'src/index.ts', askedAt: 't1' },
			{ id: 'q2', question: 'What next?', askedAt: 't2' },
		])
	})

	test('omits context when undefined', () => {
		const shaped = renderPendingQuestions([{ id: 'q1', question: 'q?', askedAt: 't1' }])
		expect(shaped[0]).not.toHaveProperty('context')
	})

	test('returns an empty array for no pending questions', () => {
		expect(renderPendingQuestions([])).toEqual([])
	})
})

describe('toRecentLogEntry', () => {
	test('pairs the log-wide index with the one-line rendering', () => {
		const event: LogEvent = { timestamp: 't1', type: 'tool_call', payload: { role: 'coder', tool: 'write_file' } }
		expect(toRecentLogEntry(event, 7)).toEqual({
			index: 7,
			timestamp: 't1',
			type: 'tool_call',
			text: 'coder · write_file',
		})
	})

	test('carries no payload or detail sections — the poll path ships identities only', () => {
		const event: LogEvent = { timestamp: 't1', type: 'tool_call', payload: { role: 'coder', tool: 'write_file', arguments: '{"path":"README.md"}' } }
		const entry = toRecentLogEntry(event, 0)
		expect(entry).not.toHaveProperty('payload')
		expect(entry).not.toHaveProperty('detailSections')
	})

	test('renders the one-line text for a malformed payload', () => {
		const event: LogEvent = { timestamp: 't1', type: 'llm_call', payload: 'broken' }
		const entry = toRecentLogEntry(event, 3)
		expect(entry.text).toBe('llm call')
	})
})

describe('paginateLogEvents', () => {
	function events(n: number): LogEvent[] {
		const list: LogEvent[] = []
		for (let i = 0; i < n; i++) list.push({ timestamp: `t${i}`, type: 'llm_call', payload: { role: 'planner' } })
		return list
	}

	test('returns the first page with the full total and applied offset/limit', () => {
		const page = paginateLogEvents(events(10), { offset: 0, limit: 3 })
		expect(page.total).toBe(10)
		expect(page.offset).toBe(0)
		expect(page.limit).toBe(3)
		expect(page.events.length).toBe(3)
		expect(defined(page.events[0], 'page.events[0]').timestamp).toBe('t0')
		expect(defined(page.events[2], 'page.events[2]').timestamp).toBe('t2')
	})

	test('returns a later page starting at offset', () => {
		const page = paginateLogEvents(events(10), { offset: 5, limit: 3 })
		expect(page.total).toBe(10)
		expect(page.offset).toBe(5)
		expect(page.events.length).toBe(3)
		expect(defined(page.events[0], 'page.events[0]').timestamp).toBe('t5')
		expect(defined(page.events[2], 'page.events[2]').timestamp).toBe('t7')
	})

	test('returns the partial final page when fewer than limit remain', () => {
		const page = paginateLogEvents(events(10), { offset: 8, limit: 5 })
		expect(page.total).toBe(10)
		expect(page.events.length).toBe(2)
		expect(defined(page.events[0], 'page.events[0]').timestamp).toBe('t8')
		expect(defined(page.events[1], 'page.events[1]').timestamp).toBe('t9')
	})

	test('returns an empty page with the correct total when offset is past the end', () => {
		const page = paginateLogEvents(events(10), { offset: 50, limit: 5 })
		expect(page.total).toBe(10)
		expect(page.offset).toBe(50)
		expect(page.events).toEqual([])
	})

	test('returns an empty page for an empty log', () => {
		const page = paginateLogEvents([], { offset: 0, limit: 5 })
		expect(page.total).toBe(0)
		expect(page.events).toEqual([])
	})

	test('returns the whole log when limit exceeds the count', () => {
		const page = paginateLogEvents(events(3), { offset: 0, limit: 100 })
		expect(page.total).toBe(3)
		expect(page.events.length).toBe(3)
	})
})

describe('formatLogAsText', () => {
	test('renders one tab-separated line per event mirroring formatLogEvent', () => {
		const events: LogEvent[] = [
			{ timestamp: 't1', type: 'llm_call', payload: { role: 'planner' } },
			{ timestamp: 't2', type: 'tool_call', payload: { role: 'planner', tool: 'agent' } },
		]
		expect(formatLogAsText(events)).toBe('t1\tllm_call\tplanner · llm call\nt2\ttool_call\tplanner · agent')
	})

	test('returns an empty string for an empty log', () => {
		expect(formatLogAsText([])).toBe('')
	})

	test('does not throw on a malformed payload', () => {
		const events: LogEvent[] = [{ timestamp: 't1', type: 'llm_call', payload: 'broken' }]
		expect(formatLogAsText(events)).toBe('t1\tllm_call\tllm call')
	})
})

function sampleGuildConfig(overrides: Partial<GuildConfig> = {}): GuildConfig {
	return {
		entryRole: 'orchestrator',
		roles: {
			orchestrator: { systemPrompt: 'prompts/orchestrator.md', tools: ['agent', 'ask_human', 'finish'] },
			coder: { systemPrompt: 'prompts/coder.md', tools: ['read_file', 'write_file', 'finish'] },
		},
		tools: ['tools/agent.json', 'tools/finish.json'],
		...overrides,
	}
}

function sampleDeployment(overrides: Partial<DeploymentConfig> = {}): DeploymentConfig {
	return {
		model: {
			name: 'qwen3.6:35b',
			apiBase: 'http://llama-server:8080/v1',
			contextWindow: 262144,
			reasoningField: 'reasoning',
			generation: { temperature: 0.2, maxTokens: 32768 },
		},
		executor: {
			maxAgentDepth: 8,
			defaultToolTimeoutSeconds: 30,
			maxCompactionAttempts: 5,
		},
		contextPolicy: { maxToolOutputChars: 8000 },
		...overrides,
	}
}

describe('renderConfig', () => {
	test('shapes the model name and context window, executor budgets, entry role, and role tool lists', () => {
		const view = renderConfig(sampleGuildConfig(), sampleDeployment(), {})
		expect(view.model).toEqual({ name: 'qwen3.6:35b', contextWindow: 262144 })
		expect(view.executor).toEqual({
			maxAgentDepth: 8,
			defaultToolTimeoutSeconds: 30,
			maxCompactionAttempts: 5,
		})
		expect(view.entryRole).toBe('orchestrator')
		expect(view.roles).toEqual({
			orchestrator: { tools: ['agent', 'ask_human', 'finish'] },
			coder: { tools: ['read_file', 'write_file', 'finish'] },
		})
	})

	test('structurally omits apiKey and apiBase from the view', () => {
		const view = renderConfig(sampleGuildConfig(), sampleDeployment(), {})
		expect(view.model).not.toHaveProperty('apiKey')
		expect(view.model).not.toHaveProperty('apiBase')
		const serialized = JSON.stringify(view)
		expect(serialized).not.toContain('secret-key')
		expect(serialized).not.toContain('llama-server')
	})

	test('omits empty roles', () => {
		const config = sampleGuildConfig({
			roles: {
				orchestrator: { systemPrompt: 'p', tools: ['finish'] },
				empty: { systemPrompt: 'p', tools: [] },
			},
		})
		const view = renderConfig(config, sampleDeployment(), {})
		expect(Object.keys(view.roles).sort()).toEqual(['empty', 'orchestrator'])
		expect(defined(view.roles.orchestrator, 'view.roles.orchestrator').tools).toEqual(['finish'])
		expect(defined(view.roles.empty, 'view.roles.empty').tools).toEqual([])
	})

	test('includes every role declared in the Guild with its full tool list', () => {
		const config = sampleGuildConfig({
			roles: {
				orchestrator: { systemPrompt: 'p', tools: ['agent', 'finish'] },
				planner: { systemPrompt: 'p', tools: ['read_file', 'glob_files', 'search_text', 'finish'] },
				empty: { systemPrompt: 'p', tools: [] },
			},
		})
		const view = renderConfig(config, sampleDeployment(), {})
		expect(Object.keys(view.roles).sort()).toEqual(['empty', 'orchestrator', 'planner'])
		expect(defined(view.roles.orchestrator, 'view.roles.orchestrator').tools).toEqual(['agent', 'finish'])
		expect(defined(view.roles.planner, 'view.roles.planner').tools).toEqual(['read_file', 'glob_files', 'search_text', 'finish'])
		expect(defined(view.roles.empty, 'view.roles.empty').tools).toEqual([])
	})

	test('drops role-only fields that are not part of the safe subset (systemPrompt, includeReasoning)', () => {
		const config = sampleGuildConfig({
			roles: {
				orchestrator: {
					systemPrompt: 'prompts/orchestrator.md',
					tools: ['finish'],
					includeReasoning: true,
				},
			},
		})
		const view = renderConfig(config, sampleDeployment(), {})
		expect(view.roles.orchestrator).toEqual({ tools: ['finish'] })
		expect(view.roles.orchestrator).not.toHaveProperty('systemPrompt')
		expect(view.roles.orchestrator).not.toHaveProperty('includeReasoning')
	})

	test('passes through the visualization section when the guild carries one', () => {
		const visualization = {
			pseudoRoleLabels: { human: { detailed: ['The human'], friendly: ['The human'], whimsical: ['The Dreamer'] } },
			operationTemplates: {
				call: { 'role->role': { detailed: ['{source} is calling {destination}'] } },
				return: { 'role->role': { detailed: ['{source} is returning to {destination}'] } },
				observe: { 'role->role': { detailed: ['{source} is observing {destination}'] } },
				terminate: { 'tool->role': { detailed: ['{source} is terminating {destination}'] } },
			},
			genericOperationTemplates: {
				call: { detailed: ['{source} is calling {destination}'] },
				return: { detailed: ['{source} is returning to {destination}'] },
				observe: { detailed: ['{source} is observing {destination}'] },
				terminate: { detailed: ['{source} is terminating {destination}'] },
			},
		}
		const config = sampleGuildConfig({ visualization })
		const view = renderConfig(config, sampleDeployment(), {})
		expect(view.visualization).toEqual(visualization)
	})

	test('omits the visualization field when the guild does not carry one', () => {
		const view = renderConfig(sampleGuildConfig(), sampleDeployment(), {})
		expect(view).not.toHaveProperty('visualization')
	})
})
