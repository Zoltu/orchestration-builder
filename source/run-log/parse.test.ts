import { describe, expect, test } from 'bun:test'
import type { RunMeta } from '../executor/types.js'
import { parseLogEvents, parseRunMeta } from './index.js'

function defined<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`${label} is undefined`)
	return value
}

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

describe('parseRunMeta', () => {
	test('returns null meta when the effort is not a tier string', () => {
		expect(parseRunMeta(JSON.stringify({ ...sampleRunMeta(), effort: 4 }))).toBeNull()
	})
})
