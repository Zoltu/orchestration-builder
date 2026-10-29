import { describe, expect, test } from 'bun:test'
import {
	TASK_SUMMARY_DESCRIPTION_MAX_CHARS,
	TASK_SUMMARY_FORMAT_VERSION,
	TASK_SUMMARY_INPUT_MAX_CHARS,
	TASK_SUMMARY_TITLE_MAX_CHARS,
	buildTaskSummaryRequest,
	isTaskSummary,
	isTaskSummaryState,
	parseTaskSummaryOutput,
	threadFingerprint,
} from './summary.js'
import type { TaskIdentity, TaskLineage, TaskThreadEntry } from './model.js'

const RUN_A = 'run-20260101-000000'
const T0 = '2026-01-01T00:00:00.000Z'

function sampleLineage(overrides: Partial<TaskLineage> = {}): TaskLineage {
	return {
		rootRunId: RUN_A,
		parentRunId: null,
		continuationCount: 0,
		resumeCount: 0,
		resumeCountComplete: true,
		depth: 0,
		complete: true,
		missingParentRunId: null,
		truncatedReason: null,
		...overrides,
	}
}

function sampleIdentity(overrides: Partial<TaskIdentity> = {}): TaskIdentity {
	return {
		runId: RUN_A,
		status: 'running',
		title: 'Fix the parser',
		description: 'Fix the parser and keep the public API stable.',
		currentTask: { runId: RUN_A, text: 'Fix the parser', at: T0, source: 'meta' },
		originalTask: { runId: RUN_A, text: 'Fix the parser', at: T0, source: 'meta' },
		lineage: sampleLineage(),
		latestHumanEvent: null,
		...overrides,
	}
}

function sampleEntry(overrides: Partial<TaskThreadEntry> = {}): TaskThreadEntry {
	return {
		id: `task:${RUN_A}`,
		sequence: 0,
		runId: RUN_A,
		timestamp: T0,
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
		source: 'meta',
		textTruncated: false,
		...overrides,
	}
}

describe('threadFingerprint', () => {
	test('is deterministic for the same identity and entries', () => {
		const identity = sampleIdentity()
		const entries = [sampleEntry()]
		const first = threadFingerprint(identity, entries)
		const second = threadFingerprint(sampleIdentity(), [sampleEntry()])
		expect(first).toBe(second)
		expect(first.length).toBe(64)
	})

	test('changes when a human turn, task, status, or entry order changes', () => {
		const base = threadFingerprint(sampleIdentity(), [sampleEntry()])
		expect(threadFingerprint(sampleIdentity(), [sampleEntry({ text: 'Different task' })])).not.toBe(base)
		expect(threadFingerprint(sampleIdentity({ status: 'error' }), [sampleEntry()])).not.toBe(base)
		const first = sampleEntry()
		const second = sampleEntry({ id: `answer:${RUN_A}:q1`, sequence: 1, kind: 'answer', label: 'Answer', text: 'yes' })
		expect(threadFingerprint(sampleIdentity(), [first, second])).not.toBe(threadFingerprint(sampleIdentity(), [second, first]))
	})
})

describe('buildTaskSummaryRequest', () => {
	test('builds a no-tools request containing the human/orchestrator thread and system markers', () => {
		const entries = [
			sampleEntry(),
			sampleEntry({ id: `ask:${RUN_A}:q1`, sequence: 1, timestamp: '2026-01-01T00:00:01.000Z', kind: 'question', actor: 'orchestrator', label: 'Question', text: 'Which port?', context: 'port context' }),
			sampleEntry({ id: `answer:${RUN_A}:q1`, sequence: 2, timestamp: '2026-01-01T00:00:02.000Z', kind: 'answer', actor: 'human', label: 'Answer', text: '8080' }),
			sampleEntry({ id: `suspension:${RUN_A}`, sequence: 3, timestamp: '2026-01-01T00:00:03.000Z', kind: 'system', actor: 'system', label: 'Suspended', text: 'Provider is down.', systemKind: 'suspension' }),
		]
		const request = buildTaskSummaryRequest(sampleIdentity(), entries)
		expect(request.tools).toBeUndefined()
		expect(request.messages.length).toBe(2)
		const system = request.messages[0]
		const user = request.messages[1]
		expect(system?.role).toBe('system')
		expect(user?.role).toBe('user')
		expect(system?.content).toContain('{"title":"...","description":"..."}')
		expect(user?.content).toContain('Original task: Fix the parser')
		expect(user?.content).toContain('Which port?')
		expect(user?.content).toContain('Context: port context')
		expect(user?.content).toContain('8080')
		expect(user?.content).toContain('Provider is down.')
	})

	test('bounds the user input strictly', () => {
		const long = 'x'.repeat(TASK_SUMMARY_INPUT_MAX_CHARS)
		const entries = [sampleEntry({ text: long })]
		const request = buildTaskSummaryRequest(sampleIdentity(), entries)
		const user = request.messages[1]
		expect(user?.content.length).toBeLessThanOrEqual(TASK_SUMMARY_INPUT_MAX_CHARS)
		expect(user?.content.endsWith('…')).toBe(true)
	})
})

describe('parseTaskSummaryOutput', () => {
	const context = { runId: RUN_A, fingerprint: 'fingerprint-1', generatedAt: T0 }

	test('accepts valid JSON, strips title scaffolding, and collapses the description', () => {
		const summary = parseTaskSummaryOutput(JSON.stringify({ title: '## Fix the parser', description: 'Fix the parser\n\nand keep the API stable.' }), context)
		expect(summary).not.toBeNull()
		expect(summary?.formatVersion).toBe(TASK_SUMMARY_FORMAT_VERSION)
		expect(summary?.runId).toBe(RUN_A)
		expect(summary?.fingerprint).toBe('fingerprint-1')
		expect(summary?.generatedAt).toBe(T0)
		expect(summary?.title).toBe('Fix the parser')
		expect(summary?.description).toBe('Fix the parser and keep the API stable.')
	})

	test('rejects malformed JSON and missing or empty fields', () => {
		expect(parseTaskSummaryOutput('{not json', context)).toBeNull()
		expect(parseTaskSummaryOutput('[]', context)).toBeNull()
		expect(parseTaskSummaryOutput(JSON.stringify({ title: 'only a title' }), context)).toBeNull()
		expect(parseTaskSummaryOutput(JSON.stringify({ title: '', description: 'description' }), context)).toBeNull()
		expect(parseTaskSummaryOutput(JSON.stringify({ title: 'title', description: '   ' }), context)).toBeNull()
	})

	test('strictly caps title and description', () => {
		const summary = parseTaskSummaryOutput(JSON.stringify({ title: 'word '.repeat(100), description: 'word '.repeat(500) }), context)
		expect(summary).not.toBeNull()
		expect(summary?.title.length).toBeLessThanOrEqual(TASK_SUMMARY_TITLE_MAX_CHARS)
		expect(summary?.description.length).toBeLessThanOrEqual(TASK_SUMMARY_DESCRIPTION_MAX_CHARS)
		expect(summary?.title.endsWith('…')).toBe(true)
		expect(summary?.description.endsWith('…')).toBe(true)
	})
})

describe('summary guards', () => {
	test('accepts a valid summary and valid state values', () => {
		const summary = {
			formatVersion: TASK_SUMMARY_FORMAT_VERSION,
			runId: RUN_A,
			fingerprint: 'fingerprint-1',
			title: 'Fix the parser',
			description: 'Fix the parser.',
			generatedAt: T0,
		}
		expect(isTaskSummary(summary)).toBe(true)
		expect(isTaskSummary({ ...summary, formatVersion: 2 })).toBe(false)
		expect(isTaskSummary({ ...summary, title: '' })).toBe(false)
		expect(isTaskSummaryState('none')).toBe(true)
		expect(isTaskSummaryState('pending')).toBe(true)
		expect(isTaskSummaryState('ready')).toBe(true)
		expect(isTaskSummaryState('failed')).toBe(true)
		expect(isTaskSummaryState('unknown')).toBe(false)
	})
})
