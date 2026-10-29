import { describe, expect, test } from 'bun:test'
import { isTaskThreadResponse, isTaskThreadSummarySnapshot } from './wire.js'
import type { TaskSummary, TaskThreadEntry, TaskThreadResponse } from './wire.js'

function entry(overrides: Partial<TaskThreadEntry> = {}): TaskThreadEntry {
	return {
		id: 'entry-1',
		sequence: 0,
		runId: 'run-1',
		timestamp: '2026-01-01T00:00:00.000Z',
		kind: 'task',
		actor: 'human',
		label: 'Initial task',
		text: 'Fix the parser',
		context: null,
		status: null,
		systemKind: null,
		outcome: null,
		questionId: null,
		relatedEntryId: null,
		queueItemId: null,
		source: 'log',
		textTruncated: false,
		...overrides,
	}
}

function thread(overrides: Partial<TaskThreadResponse> = {}): TaskThreadResponse {
	return {
		formatVersion: 1,
		runId: 'run-1',
		identity: {
			runId: 'run-1',
			status: 'success',
			title: 'Fix the parser',
			description: 'Fix the parser.',
			currentTask: null,
			originalTask: null,
			lineage: {
				rootRunId: 'run-1',
				parentRunId: null,
				continuationCount: 0,
				resumeCount: 0,
				resumeCountComplete: true,
				depth: 0,
				complete: true,
				missingParentRunId: null,
				truncatedReason: null,
			},
			latestHumanEvent: null,
		},
		entries: [entry()],
		summary: null,
		summaryState: 'none',
		truncated: { entries: false, text: false, lineage: false },
		...overrides,
	}
}

describe('task-thread wire guards', () => {
	test('accepts a complete response', () => {
		expect(isTaskThreadResponse(thread())).toBe(true)
	})

	test('rejects an unknown format version, run id mismatch, or malformed summary state', () => {
		expect(isTaskThreadResponse({ ...thread(), formatVersion: 2 })).toBe(false)
		const mismatch = thread()
		expect(isTaskThreadResponse({ ...mismatch, identity: { ...mismatch.identity, runId: 'run-other' } })).toBe(false)
		expect(isTaskThreadResponse({ ...thread(), summaryState: 'stale' })).toBe(false)
	})

	test('rejects a ready summary for a different run', () => {
		const ready = thread({
			summaryState: 'ready',
			summary: { formatVersion: 1, runId: 'run-other', fingerprint: 'fp', title: 'Title', description: 'Description.', generatedAt: '2026-01-01T00:00:00.000Z' },
		})
		expect(isTaskThreadResponse(ready)).toBe(false)
	})

	test('rejects illegal entry combinations: system markers, result status, outcomes, and queue-only ids', () => {
		expect(isTaskThreadResponse(thread({ entries: [entry({ kind: 'system', systemKind: null })] }))).toBe(false)
		expect(isTaskThreadResponse(thread({ entries: [entry({ kind: 'result', status: 'success', outcome: 'answered' })] }))).toBe(false)
		expect(isTaskThreadResponse(thread({ entries: [entry({ kind: 'question', outcome: null })] }))).toBe(false)
		expect(isTaskThreadResponse(thread({ entries: [entry({ kind: 'question', outcome: 'waiting', queueItemId: 'item-1', source: 'log' })] }))).toBe(false)
	})

	test('accepts a queue-derived question and a system marker with its system kind', () => {
		expect(isTaskThreadResponse(thread({ entries: [entry({ kind: 'question', outcome: 'waiting', queueItemId: 'item-1', source: 'queue' })] }))).toBe(true)
		expect(isTaskThreadResponse(thread({ entries: [entry({ kind: 'system', actor: 'system', systemKind: 'failure' })] }))).toBe(true)
	})

	test('summary snapshots require a summary only in the ready state', () => {
		const summary: TaskSummary = { formatVersion: 1, runId: 'run-1', fingerprint: 'fp', title: 'Title', description: 'Description.', generatedAt: '2026-01-01T00:00:00.000Z' }
		expect(isTaskThreadSummarySnapshot({ state: 'pending', summary: null })).toBe(true)
		expect(isTaskThreadSummarySnapshot({ state: 'failed', summary: null })).toBe(true)
		expect(isTaskThreadSummarySnapshot({ state: 'ready', summary: null })).toBe(false)
		expect(isTaskThreadSummarySnapshot({ state: 'ready', summary })).toBe(true)
		expect(isTaskThreadSummarySnapshot({ state: 'pending', summary })).toBe(false)
		expect(isTaskThreadSummarySnapshot({ state: 'failed', summary })).toBe(false)
	})

	test('thread responses enforce summary and state correlation', () => {
		const summary: TaskSummary = { formatVersion: 1, runId: 'run-1', fingerprint: 'fp', title: 'Title', description: 'Description.', generatedAt: '2026-01-01T00:00:00.000Z' }
		expect(isTaskThreadResponse(thread({ summaryState: 'ready', summary }))).toBe(true)
		expect(isTaskThreadResponse(thread({ summaryState: 'ready', summary: null }))).toBe(false)
		expect(isTaskThreadResponse(thread({ summaryState: 'pending', summary }))).toBe(false)
		expect(isTaskThreadResponse(thread({ summaryState: 'none', summary }))).toBe(false)
	})
})
