import { describe, expect, test } from 'bun:test'
import type { LogEvent } from '../../executor/types.js'
import { formatLogAsText, formatLogDetailSections, toRecentLogEntry } from './index.js'

function defined<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`${label} is undefined`)
	return value
}

function present<T>(value: T | null, label: string): T {
	if (value === null) throw new Error(`${label} is null`)
	return value
}

function renderedText(event: LogEvent): string {
	return toRecentLogEntry(event, 0).text
}

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

describe('toRecentLogEntry one-line text', () => {
	function event(type: string, payload: unknown): LogEvent {
		return { timestamp: 't', type, payload }
	}

	test('llm_call → role · llm call', () => {
		expect(renderedText(event('llm_call', { role: 'coder', messageCount: 3 }))).toBe('coder · llm call')
	})

	test('tool_call → role · tool', () => {
		expect(renderedText(event('tool_call', { role: 'coder', tool: 'write_file' }))).toBe('coder · write_file')
	})

	test('tool_result → role · tool result (kind)', () => {
		expect(renderedText(event('tool_result', { role: 'coder', tool: 'write_file', kind: 'success' }))).toBe('coder · write_file result (success)')
	})

	test('role_finished → role · finished (status)', () => {
		expect(renderedText(event('role_finished', { role: 'planner', status: 'success' }))).toBe('planner · finished (success)')
	})

	test('role_finished omits the summary from the one-line view to keep long model prose from widening the row', () => {
		expect(renderedText(event('role_finished', { role: 'coder', status: 'success', summary: 'wrote output.txt' }))).toBe('coder · finished (success)')
	})

	test('role_finished shows status only on error; the summary and error reach the raw detail sections instead', () => {
		expect(renderedText(event('role_finished', { role: 'coder', status: 'error', summary: 'could not parse the file', error: { kind: 'invalid_arguments', message: 'bad json' } }))).toBe('coder · finished (error)')
	})

	test('role_finished without status omits the parenthetical', () => {
		expect(renderedText(event('role_finished', { role: 'planner' }))).toBe('planner · finished')
	})

	test('implicit_finish → role · finished (implicit)', () => {
		expect(renderedText(event('implicit_finish', { role: 'coder', summary: 'done' }))).toBe('coder · finished (implicit)')
	})

	test('llm_unavailable → role · llm unavailable', () => {
		expect(renderedText(event('llm_unavailable', { role: 'coder', message: 'down' }))).toBe('coder · llm unavailable')
	})

	test('provider_failure shows the category and platform message, never the provider detail body', () => {
		expect(renderedText(event('provider_failure', { role: 'coder', roleId: 'coder-1', category: 'billing', attempts: 1, partialOutput: false, message: 'The model provider reports insufficient quota or credit (HTTP 402)', detail: '{"error":"sk-secret request body"}' }))).toBe('coder · provider failure (billing): The model provider reports insufficient quota or credit (HTTP 402)')
		expect(renderedText(event('provider_failure', { role: 'coder', roleId: 'coder-1', category: 'transient', attempts: 3, partialOutput: true, detail: 'provider body only' }))).toBe('coder · provider failure (transient)')
	})

	test('context_budget_exceeded → role · context budget exceeded', () => {
		expect(renderedText(event('context_budget_exceeded', { role: 'coder', promptTokens: 100, contextWindow: 50 }))).toBe('coder · context budget exceeded')
	})

	test('context_compacted → role · context compacted by platform', () => {
		expect(renderedText(event('context_compacted', { role: 'coder', droppedMessages: 4, truncatedToolMessages: 0, strippedReasoningMessages: 0, estimatedPromptTokens: 400, contextWindow: 1000 }))).toBe('coder · context compacted by platform')
	})

	test('context_pressure → role · context pressure — handoff notice sent', () => {
		expect(renderedText(event('context_pressure', { role: 'coder', promptTokens: 800, effectiveBudget: 900 }))).toBe('coder · context pressure — handoff notice sent')
	})

	test('role_budget_exceeded → role · role budget exceeded', () => {
		expect(renderedText(event('role_budget_exceeded', { role: 'coder', phase: 'post_llm', error: { kind: 'compaction_failed' } }))).toBe('coder · role budget exceeded')
	})

	test('global_budget_exceeded → role · global budget exceeded', () => {
		expect(renderedText(event('global_budget_exceeded', { role: 'coder', error: { kind: 'timeout' } }))).toBe('coder · global budget exceeded')
	})

	test('unknown_tool → role · unknown tool (tool)', () => {
		expect(renderedText(event('unknown_tool', { role: 'coder', tool: 'frobnicate' }))).toBe('coder · unknown tool (frobnicate)')
	})

	test('invalid_tool_call → role · invalid tool call (tool)', () => {
		expect(renderedText(event('invalid_tool_call', { role: 'coder', tool: 'write_file' }))).toBe('coder · invalid tool call (write_file)')
	})

	test('depth_exceeded → parent · depth exceeded (child at depth N)', () => {
		expect(renderedText(event('depth_exceeded', { parent: 'orchestrator', child: 'coder', depth: 8, error: { kind: 'agent_depth_exceeded' } }))).toBe('orchestrator · depth exceeded (coder at depth 8)')
	})

	test('role_not_found uses parent as the acting role when present', () => {
		expect(renderedText(event('role_not_found', { parent: 'orchestrator', roleName: 'missing' }))).toBe('orchestrator · role not found (missing)')
	})

	test('role_not_found without parent renders the bare detail', () => {
		expect(renderedText(event('role_not_found', { roleName: 'missing' }))).toBe('role not found (missing)')
	})

	test('role_start → role · role start', () => {
		expect(renderedText(event('role_start', { role: 'planner', depth: 0, task: 'do it' }))).toBe('planner · role start')
	})

	test('effort_set renders the chosen level', () => {
		expect(renderedText(event('effort_set', { effort: 'standard' }))).toBe('effort set (standard)')
	})

	test('effort_set without an effort value renders the bare action', () => {
		expect(renderedText(event('effort_set', {}))).toBe('effort set')
	})

	test('involvement_set renders the chosen level', () => {
		expect(renderedText(event('involvement_set', { involvement: 'collaborative' }))).toBe('involvement set (collaborative)')
	})

	test('involvement_set without an involvement value renders the bare action', () => {
		expect(renderedText(event('involvement_set', {}))).toBe('involvement set')
	})

	test('agent_call → parent · agent call → child', () => {
		expect(renderedText(event('agent_call', { parent: 'orchestrator', child: 'coder', depth: 1 }))).toBe('orchestrator · agent call → coder')
	})

	test('agent_call falls back to the payload role when parent is absent', () => {
		expect(renderedText(event('agent_call', { role: 'orchestrator', child: 'coder' }))).toBe('orchestrator · agent call → coder')
	})

	test('interrupt → interrupt (handler on target)', () => {
		expect(renderedText(event('interrupt', { trigger: 'loop_check', handler: 'loop_detector', target: 'coder-1-2' }))).toBe('interrupt (loop_detector on coder-1-2)')
	})

	test('interrupt without handler and target renders the bare type', () => {
		expect(renderedText(event('interrupt', { trigger: 'context_pressure' }))).toBe('interrupt')
	})

	test('interrupt_resolved → interrupt resolved (action on target)', () => {
		expect(renderedText(event('interrupt_resolved', { trigger: 'inquiry', action: 'answered', target: 'coder-1-2' }))).toBe('interrupt resolved (answered on coder-1-2)')
	})

	test('observe → role · observe (details)', () => {
		expect(renderedText(event('observe', { role: 'coder', roleId: 'coder-1-2', details: 'read_message_window' }))).toBe('coder · observe (read_message_window)')
	})

	test('observe without details renders the bare action', () => {
		expect(renderedText(event('observe', { role: 'coder' }))).toBe('coder · observe')
	})

	test('operator_notice → role · operator notice', () => {
		expect(renderedText(event('operator_notice', { role: 'orchestrator', roleId: 'orchestrator-0-1', message: 'winding down' }))).toBe('orchestrator · operator notice')
	})

	test('inquiry_dropped → inquiry dropped (reason)', () => {
		expect(renderedText(event('inquiry_dropped', { message: 'hello?', reason: 'no handler role configured' }))).toBe('inquiry dropped (no handler role configured)')
	})

	test('inquiry_dropped without a reason renders the bare action', () => {
		expect(renderedText(event('inquiry_dropped', { message: 'hello?' }))).toBe('inquiry dropped')
	})

	test('an operator_inquiry event renders as the operator inquiry label', () => {
		expect(renderedText(event('operator_inquiry', { role: 'orchestrator', roleId: 'orchestrator-0-1', message: 'status?' }))).toBe('orchestrator · operator inquiry')
	})

	test('an unknown event type with a role falls back to type · role', () => {
		expect(renderedText(event('something_new', { role: 'coder' }))).toBe('something_new · coder')
	})

	test('an unknown event type without a role renders the bare type', () => {
		expect(renderedText(event('something_new', { unrelated: true }))).toBe('something_new')
	})

	test('does not throw on a non-object payload', () => {
		expect(renderedText(event('llm_call', 'broken'))).toBe('llm call')
		expect(renderedText(event('tool_call', null))).toBe('tool call')
	})

	test('does not throw on an undefined payload', () => {
		expect(renderedText(event('role_finished', undefined))).toBe('finished')
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

describe('formatLogAsText', () => {
	test('renders one tab-separated line per event mirroring toRecentLogEntry', () => {
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
