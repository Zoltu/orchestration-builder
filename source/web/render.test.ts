import { describe, expect, test } from 'bun:test'
import type { RunSnapshotRaw } from '../executor/persistence.js'
import type { PendingQuestion } from '../executor/human-backend.js'
import type { LogEvent, RunMeta } from '../executor/types.js'
import {
	deriveQuestionHistory,
	deriveRoleActivity,
	formatLogEvent,
	parseLogEvents,
	parseRunSnapshot,
	renderPendingQuestions,
	renderRunSummary,
	renderRunView,
} from './render.ts'

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
		expect(events[0]!.type).toBe('llm_call')
		expect(events[1]!.type).toBe('tool_call')
		expect(events[2]!.type).toBe('role_finished')
	})

	test('skips a malformed line without aborting the rest of the tail', () => {
		const text = [
			logEvent('llm_call', 'planner', '2026-01-01T00:00:01.000Z'),
			'{ not valid json',
			logEvent('tool_call', 'planner', '2026-01-01T00:00:02.000Z', { tool: 'finish' }),
		].join('\n')

		const events = parseLogEvents(text)
		expect(events.length).toBe(2)
		expect(events[0]!.type).toBe('llm_call')
		expect(events[1]!.type).toBe('tool_call')
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

		const planner = activity[0]!
		expect(planner.role).toBe('planner')
		expect(planner.firstSeen).toBe('t1')
		expect(planner.lastSeen).toBe('t5')
		expect(planner.eventCount).toBe(3)
		expect(planner.llmCalls).toBe(1)
		expect(planner.toolCalls).toBe(1)
		expect(planner.toolsCalled).toEqual(['agent'])

		const coder = activity[1]!
		expect(coder.role).toBe('coder')
		expect(coder.llmCalls).toBe(1)
		expect(coder.toolCalls).toBe(1)
		expect(coder.toolsCalled).toEqual(['finish'])
	})

	test('records each distinct tool once, in first-use order', () => {
		const events: LogEvent[] = [
			{ timestamp: 't1', type: 'tool_call', payload: { role: 'coder', tool: 'read_file' } },
			{ timestamp: 't2', type: 'tool_call', payload: { role: 'coder', tool: 'write_file' } },
			{ timestamp: 't3', type: 'tool_call', payload: { role: 'coder', tool: 'read_file' } },
		]

		const [coder] = deriveRoleActivity(events)
		expect(coder!.toolsCalled).toEqual(['read_file', 'write_file'])
		expect(coder!.toolCalls).toBe(3)
	})

	test('ignores events whose payload has no role', () => {
		const events: LogEvent[] = [
			{ timestamp: 't1', type: 'global_budget_exceeded', payload: { error: { kind: 'timeout' } } },
			{ timestamp: 't2', type: 'llm_call', payload: { role: 'planner' } },
		]

		const activity = deriveRoleActivity(events)
		expect(activity.length).toBe(1)
		expect(activity[0]!.role).toBe('planner')
	})

	test('returns an empty list when no roles appear in the log', () => {
		expect(deriveRoleActivity([])).toEqual([])
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

	test('role_budget_exceeded → role · role budget exceeded', () => {
		expect(formatLogEvent(event('role_budget_exceeded', { role: 'coder', phase: 'post_llm', error: { kind: 'token_budget_exceeded' } }))).toBe('coder · role budget exceeded')
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

		const view = renderRunView(snapshot, { maxLogLines: 200 })
		expect(view.status).toBe('success')
		expect(view.runId).toBe('run-1')
		expect(view.task).toBe('fix the bug')
		expect(view.startTime).toBe('2026-01-01T00:00:00.000Z')
		expect(view.endTime).toBe('2026-01-01T00:01:00.000Z')
		expect(view.roles.length).toBe(1)
		expect(view.roles[0]!.role).toBe('planner')
		expect(view.recentLog.length).toBe(2)
	})

	test('reports unknown status when meta is absent (run in progress)', () => {
		const snapshot = parseRunSnapshot({ metaText: null, logText: logEvent('llm_call', 'planner', 't1') })
		const view = renderRunView(snapshot, { maxLogLines: 200 })
		expect(view.status).toBe('unknown')
		expect(view.runId).toBeNull()
		expect(view.task).toBeNull()
		expect(view.result).toBeNull()
		expect(view.roles.length).toBe(1)
	})

	test('truncates the recent log to the last maxLogLines events', () => {
		const lines: string[] = []
		for (let i = 0; i < 10; i++) {
			lines.push(logEvent('llm_call', 'planner', `t${i}`))
		}
		const snapshot = parseRunSnapshot({ metaText: null, logText: lines.join('\n') })

		const view = renderRunView(snapshot, { maxLogLines: 3 })
		expect(view.recentLog.length).toBe(3)
		expect(view.recentLog[0]!.timestamp).toBe('t7')
		expect(view.recentLog[2]!.timestamp).toBe('t9')
	})

	test('uses the full log when fewer than maxLogLines events exist', () => {
		const snapshot = parseRunSnapshot({
			metaText: null,
			logText: logEvent('llm_call', 'planner', 't1'),
		})
		const view = renderRunView(snapshot, { maxLogLines: 200 })
		expect(view.recentLog.length).toBe(1)
	})

	test('result is null when the meta has no result field', () => {
		const snapshot = parseRunSnapshot({
			metaText: JSON.stringify(sampleRunMeta({ result: undefined })),
			logText: '',
		})
		const view = renderRunView(snapshot, { maxLogLines: 200 })
		expect(view.result).toBeNull()
	})

	test('recentLog entries carry a readable summary alongside the raw payload', () => {
		const snapshot = parseRunSnapshot({
			metaText: null,
			logText: [
				logEvent('llm_call', 'planner', 't1'),
				logEvent('tool_call', 'planner', 't2', { tool: 'agent' }),
			].join('\n'),
		})

		const view = renderRunView(snapshot, { maxLogLines: 200 })
		expect(view.recentLog.length).toBe(2)
		expect(view.recentLog[0]).toEqual({
			timestamp: 't1',
			type: 'llm_call',
			summary: 'planner · llm call',
			payload: { role: 'planner' },
		})
		expect(view.recentLog[1]!.summary).toBe('planner · agent')
		expect(view.recentLog[1]!.payload).toEqual({ role: 'planner', tool: 'agent' })
	})

	test('error is null while a run is in progress', () => {
		const snapshot = parseRunSnapshot({ metaText: null, logText: '' })
		const view = renderRunView(snapshot, { maxLogLines: 200 })
		expect(view.error).toBeNull()
	})

	test('error is null when a completed run has no error', () => {
		const snapshot = parseRunSnapshot({ metaText: JSON.stringify(sampleRunMeta()), logText: '' })
		const view = renderRunView(snapshot, { maxLogLines: 200 })
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

		const view = renderRunView(snapshot, { maxLogLines: 200 })
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

		const view = renderRunView(snapshot, { maxLogLines: 200 })
		expect(view.currentActivity).toEqual({ role: 'coder', summary: 'coder · write_file' })
	})

	test('currentActivity is null for an empty log', () => {
		const snapshot = parseRunSnapshot({ metaText: null, logText: '' })
		const view = renderRunView(snapshot, { maxLogLines: 200 })
		expect(view.currentActivity).toBeNull()
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

		const view = renderRunView(snapshot, { maxLogLines: 200 })
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

		const view = renderRunView(snapshot, { maxLogLines: 200 })
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
		expect(history[0]!.answer).toBe('yes')
		expect(history[0]!.answeredAt).toBe('t3')
		expect(history[1]!.answer).toBeUndefined()
		expect(history[1]!.answeredAt).toBeUndefined()
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

describe('renderRunSummary', () => {
	test('shapes a completed run from its meta, taking runId from the directory name', () => {
		const snapshot = parseRunSnapshot({
			metaText: JSON.stringify(sampleRunMeta({ runId: 'on-disk-id' })),
			logText: '',
		})

		const summary = renderRunSummary('dir-name', snapshot)
		expect(summary).toEqual({
			runId: 'dir-name',
			status: 'success',
			task: 'fix the bug',
			startTime: '2026-01-01T00:00:00.000Z',
			endTime: '2026-01-01T00:01:00.000Z',
		})
	})

	test('reports unknown status and null fields when meta is absent (run in progress)', () => {
		const snapshot = parseRunSnapshot({ metaText: null, logText: '' })

		const summary = renderRunSummary('run-in-progress', snapshot)
		expect(summary).toEqual({
			runId: 'run-in-progress',
			status: 'unknown',
			task: null,
			startTime: null,
			endTime: null,
		})
	})

	test('endTime is null when the meta omits it', () => {
		const snapshot = parseRunSnapshot({
			metaText: JSON.stringify(sampleRunMeta({ endTime: undefined })),
			logText: '',
		})

		const summary = renderRunSummary('r', snapshot)
		expect(summary.endTime).toBeNull()
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
