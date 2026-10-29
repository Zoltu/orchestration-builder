import { describe, expect, test } from 'bun:test'
import {
	applyTaskThreadSummarySnapshot,
	isCurrentTaskThreadResponse,
	isCurrentTaskThreadSummaryResponse,
	nextTaskThreadSummaryAutoRetry,
	planTaskThreadSummary,
	shouldApplyTaskThreadSummaryFailure,
	shouldRefreshTaskThread,
	shouldRetryTaskThread404,
	taskThreadFingerprint,
	taskThreadRefreshSignal,
	taskThreadSummaryIsForHeldThread,
	taskThreadSummaryMatches,
	TASK_THREAD_SUMMARY_MAX_REFETCHES,
	taskThreadSummaryUrl,
	taskThreadUrl,
} from './state.js'
import type { TaskSummary, TaskThreadEntry, TaskThreadResponse } from './wire.js'
import { threadFingerprint as serverThreadFingerprint } from '../../../../task-thread/summary.js'

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

function readySummaryFor(target: TaskThreadResponse): TaskSummary {
	return { formatVersion: 1, runId: target.runId, fingerprint: taskThreadFingerprint(target), title: 'Generated', description: 'Generated description.', generatedAt: '2026-01-01T00:00:00.000Z' }
}

describe('task-thread urls', () => {
	test('encodes the run id in both endpoints', () => {
		expect(taskThreadUrl('run/a b')).toBe('api/runs/run%2Fa%20b/thread')
		expect(taskThreadSummaryUrl('run/a b')).toBe('api/runs/run%2Fa%20b/thread/summary')
	})
})

describe('taskThreadFingerprint', () => {
	test('is stable for equal content and changes when the thread changes', () => {
		const original = thread()
		expect(taskThreadFingerprint(original)).toBe(taskThreadFingerprint(thread()))
		expect(taskThreadFingerprint(original)).not.toBe(taskThreadFingerprint(thread({ entries: [entry({ text: 'Fix the parser and add tests' })] })))
		expect(taskThreadFingerprint(original)).toBe(serverThreadFingerprint(original.identity, original.entries))
	})

	test('matches the server fingerprint for a fixture thread', () => {
		const fixture = thread()
		expect(taskThreadFingerprint(fixture)).toBe(serverThreadFingerprint(fixture.identity, fixture.entries))
	})
})

describe('planTaskThreadSummary', () => {
	test('a none-state snapshot always allows regeneration, even for the same fingerprint after a server restart', () => {
		const first = thread()
		const firstPlan = planTaskThreadSummary({ thread: first, failedKey: null, retryAt: null, now: 0, pendingRefetches: 0 })
		expect(firstPlan.kind).toBe('trigger')
		if (firstPlan.kind !== 'trigger') throw new Error('expected a trigger plan')
		const afterRestart = planTaskThreadSummary({ thread: first, failedKey: null, retryAt: null, now: 0, pendingRefetches: 0 })
		expect(afterRestart).toEqual({ kind: 'trigger', key: firstPlan.key })
		expect(planTaskThreadSummary({ thread: thread({ entries: [entry({ text: 'new turn' })] }), failedKey: null, retryAt: null, now: 0, pendingRefetches: 0 }).kind).toBe('trigger')
	})

	test('refetches while pending until the cap, then reports timed-out, and stops on ready or failed', () => {
		expect(planTaskThreadSummary({ thread: thread({ summaryState: 'pending' }), failedKey: null, retryAt: null, now: 0, pendingRefetches: TASK_THREAD_SUMMARY_MAX_REFETCHES - 1 }).kind).toBe('refetch')
		expect(planTaskThreadSummary({ thread: thread({ summaryState: 'pending' }), failedKey: null, retryAt: null, now: 0, pendingRefetches: TASK_THREAD_SUMMARY_MAX_REFETCHES }).kind).toBe('timed-out')
		expect(planTaskThreadSummary({ thread: thread({ summaryState: 'ready', summary: readySummaryFor(thread()) }), failedKey: null, retryAt: null, now: 0, pendingRefetches: 0 }).kind).toBe('none')
		expect(planTaskThreadSummary({ thread: thread({ summaryState: 'failed' }), failedKey: null, retryAt: null, now: 0, pendingRefetches: 0 }).kind).toBe('none')
	})

	test('a failed key retries automatically only after its cooldown, while a changed thread retries immediately', () => {
		const failedThread = thread()
		const failedKey = taskThreadFingerprint(failedThread)
		const beforeCooldown = planTaskThreadSummary({ thread: failedThread, failedKey, retryAt: 1000, now: 999, pendingRefetches: 0 })
		expect(beforeCooldown.kind).toBe('none')
		const afterCooldown = planTaskThreadSummary({ thread: failedThread, failedKey, retryAt: 1000, now: 1000, pendingRefetches: 0 })
		expect(afterCooldown.kind).toBe('trigger')
		const changedThread = thread({ entries: [entry({ text: 'a newer turn' })] })
		expect(planTaskThreadSummary({ thread: changedThread, failedKey, retryAt: 1000, now: 1, pendingRefetches: 0 }).kind).toBe('trigger')
	})
})

describe('summary fingerprints', () => {
	test('only a ready summary whose fingerprint matches the held thread is applied', () => {
		const held = thread({ summaryState: 'pending' })
		const matching = readySummaryFor(held)
		expect(taskThreadSummaryMatches(held, matching)).toBe(true)
		expect(applyTaskThreadSummarySnapshot(held, { state: 'ready', summary: matching }).summaryState).toBe('ready')
		const stale = { ...matching, fingerprint: 'stale-fingerprint' }
		expect(taskThreadSummaryMatches(held, stale)).toBe(false)
		const applied = applyTaskThreadSummarySnapshot(held, { state: 'ready', summary: stale })
		expect(applied).toBe(held)
	})

	test('applies pending and failed snapshots without a summary', () => {
		const pending = applyTaskThreadSummarySnapshot(thread(), { state: 'pending', summary: null })
		expect(pending.summaryState).toBe('pending')
		const failed = applyTaskThreadSummarySnapshot(thread({ summaryState: 'pending' }), { state: 'failed', summary: null })
		expect(failed.summaryState).toBe('failed')
		expect(failed.summary).toBeNull()
	})
})

describe('stale same-run responses', () => {
	test('applies only the newest request token for the selected run', () => {
		expect(isCurrentTaskThreadResponse({ requestToken: 1, currentToken: 2, runId: 'run-1', selectedRunId: 'run-1' })).toBe(false)
		expect(isCurrentTaskThreadResponse({ requestToken: 2, currentToken: 2, runId: 'run-1', selectedRunId: 'run-1' })).toBe(true)
		expect(isCurrentTaskThreadResponse({ requestToken: 2, currentToken: 2, runId: 'run-1', selectedRunId: 'run-2' })).toBe(false)
	})
})

describe('poll-driven refresh', () => {
	test('the signal changes for status, result, interrupts, and question changes', () => {
		const base = taskThreadRefreshSignal({ runId: 'run-1', status: 'running', result: null, interrupts: [], questionKey: null })
		expect(shouldRefreshTaskThread(base, base, 'run-1')).toBe(false)
		expect(shouldRefreshTaskThread(base, taskThreadRefreshSignal({ runId: 'run-1', status: 'success', result: null, interrupts: [], questionKey: null }), 'run-1')).toBe(true)
		expect(shouldRefreshTaskThread(base, taskThreadRefreshSignal({ runId: 'run-1', status: 'running', result: { summary: 'done' }, interrupts: [], questionKey: null }), 'run-1')).toBe(true)
		expect(shouldRefreshTaskThread(base, taskThreadRefreshSignal({ runId: 'run-1', status: 'running', result: null, interrupts: [{ kind: 'inquiry' }], questionKey: null }), 'run-1')).toBe(true)
		expect(shouldRefreshTaskThread(base, taskThreadRefreshSignal({ runId: 'run-1', status: 'running', result: null, interrupts: [], questionKey: 'question-1' }), 'run-1')).toBe(true)
		expect(shouldRefreshTaskThread(base, base, null)).toBe(false)
	})
})

describe('transient post-create retries', () => {
	test('retries a 404 a bounded number of times and never retries other failures', () => {
		expect(shouldRetryTaskThread404(404, 0)).toBe(true)
		expect(shouldRetryTaskThread404(404, 4)).toBe(true)
		expect(shouldRetryTaskThread404(404, 5)).toBe(false)
		expect(shouldRetryTaskThread404(500, 0)).toBe(false)
	})
})

describe('summary response correlation', () => {
	const baseGuard = { requestToken: 2, currentToken: 2, triggerKey: 'key-1', currentTriggerKey: 'key-1', runId: 'run-1', selectedRunId: 'run-1' }

	test('a stale summary token or trigger key is ignored', () => {
		expect(isCurrentTaskThreadSummaryResponse(baseGuard)).toBe(true)
		expect(isCurrentTaskThreadSummaryResponse({ ...baseGuard, requestToken: 1 })).toBe(false)
		expect(isCurrentTaskThreadSummaryResponse({ ...baseGuard, triggerKey: 'old-key' })).toBe(false)
		expect(isCurrentTaskThreadSummaryResponse({ ...baseGuard, triggerKey: null })).toBe(false)
		expect(isCurrentTaskThreadSummaryResponse({ ...baseGuard, selectedRunId: 'run-2' })).toBe(false)
	})

	test('a stale failure cannot overwrite a ready thread or a changed thread', () => {
		const readyThread = thread({ summaryState: 'ready', summary: readySummaryFor(thread()) })
		expect(shouldApplyTaskThreadSummaryFailure({ ...baseGuard, heldThread: readyThread })).toBe(false)
		const changedThread = thread({ entries: [entry({ text: 'a newer turn' })] })
		expect(shouldApplyTaskThreadSummaryFailure({ ...baseGuard, heldThread: changedThread })).toBe(false)
		const sameThread = thread()
		const sameKey = taskThreadFingerprint(sameThread)
		expect(shouldApplyTaskThreadSummaryFailure({ ...baseGuard, triggerKey: sameKey, currentTriggerKey: sameKey, heldThread: sameThread })).toBe(true)
	})
})

describe('summary responses for the held thread', () => {
	test('a pending or none response is stale when the held thread changed under the trigger key', () => {
		const held = thread()
		const key = taskThreadFingerprint(held)
		expect(taskThreadSummaryIsForHeldThread(key, held)).toBe(true)
		expect(taskThreadSummaryIsForHeldThread(key, thread({ entries: [entry({ text: 'newer' })] }))).toBe(false)
		expect(taskThreadSummaryIsForHeldThread(null, held)).toBe(false)
	})
})

describe('automatic summary retry budget', () => {
	test('caps automatic retries across persistent failure cycles and resets for a new fingerprint', () => {
		const first = nextTaskThreadSummaryAutoRetry({ failedKey: 'key-1', previousKey: null, previousCount: 0 })
		expect(first).toEqual({ key: 'key-1', count: 1, shouldSchedule: true })
		const second = nextTaskThreadSummaryAutoRetry({ failedKey: 'key-1', previousKey: first.key, previousCount: first.count })
		expect(second).toEqual({ key: 'key-1', count: 2, shouldSchedule: true })
		const third = nextTaskThreadSummaryAutoRetry({ failedKey: 'key-1', previousKey: second.key, previousCount: second.count })
		expect(third).toEqual({ key: 'key-1', count: 3, shouldSchedule: false })
		const changed = nextTaskThreadSummaryAutoRetry({ failedKey: 'key-2', previousKey: third.key, previousCount: third.count })
		expect(changed).toEqual({ key: 'key-2', count: 1, shouldSchedule: true })
	})

	test('manual retry reset is represented by starting a fresh previous count', () => {
		expect(nextTaskThreadSummaryAutoRetry({ failedKey: 'key-1', previousKey: null, previousCount: 0 }).count).toBe(1)
	})
})
