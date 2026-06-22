import { describe, expect, test } from 'bun:test'
import type { RunSnapshotRaw } from '../executor/persistence.js'
import type { PendingQuestion } from '../executor/human-backend.js'
import type { LogEvent, RunMeta } from '../executor/types.js'
import {
	deriveRoleActivity,
	parseLogEvents,
	parseRunSnapshot,
	renderPendingQuestions,
	renderRunSummary,
	renderRunView,
} from './render.ts'

function logEvent(type: string, role: string, timestamp: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ timestamp, type, payload: { role, ...extra } })
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
