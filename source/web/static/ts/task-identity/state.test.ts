import { describe, expect, test } from 'bun:test'
import {
	applyTaskThreadLatestResponse,
	applyTaskThreadOlderResponse,
	applyTaskThreadSummarySnapshot,
	isCurrentTaskThreadResponse,
	isCurrentTaskThreadSummaryResponse,
	nextTaskThreadSummaryAutoRetry,
	planTaskThreadSummary,
	shouldApplyTaskThreadSummaryFailure,
	shouldRefreshTaskThread,
	shouldResetTaskThreadOlder,
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
	const base: TaskThreadResponse = {
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
		pagination: { hasMoreOlder: false, nextCursor: null },
		threadFingerprint: '',
		summary: null,
		summaryState: 'none',
		truncated: { entries: false, text: false, lineage: false },
		...overrides,
	}
	return { ...base, threadFingerprint: overrides.threadFingerprint ?? serverThreadFingerprint(base.identity, base.entries) }
}

function readySummaryFor(target: TaskThreadResponse): TaskSummary {
	return { formatVersion: 1, runId: target.runId, fingerprint: taskThreadFingerprint(target), title: 'Generated', description: 'Generated description.', generatedAt: '2026-01-01T00:00:00.000Z' }
}

describe('task-thread urls', () => {
	test('encodes the run id in both endpoints', () => {
		expect(taskThreadUrl('run/a b')).toBe('api/runs/run%2Fa%20b/thread')
		expect(taskThreadSummaryUrl('run/a b')).toBe('api/runs/run%2Fa%20b/thread/summary')
	})

	test('adds the before cursor when paging older entries', () => {
		expect(taskThreadUrl('run-1', 'entry/7')).toBe('api/runs/run-1/thread?before=entry%2F7')
		expect(taskThreadUrl('run-1')).toBe('api/runs/run-1/thread')
	})
})

describe('taskThreadFingerprint', () => {
	test('uses the server-provided fingerprint instead of recomputing it from the page', () => {
		const served = thread({ threadFingerprint: 'server-fingerprint' })
		expect(taskThreadFingerprint(served)).toBe('server-fingerprint')
	})

	test('matches the full-thread server fingerprint produced by the fixture', () => {
		const fixture = thread()
		expect(taskThreadFingerprint(fixture)).toBe(serverThreadFingerprint(fixture.identity, fixture.entries))
	})
})

describe('task-thread pagination merge', () => {
	test('merges contiguous pages by id in stable sequence order and lets the latest page win', () => {
		const held = thread({
			threadFingerprint: 'full-thread-fingerprint',
			entries: [entry({ id: 'entry-1', sequence: 0 }), entry({ id: 'entry-2', sequence: 1 })],
		})
		const latest = thread({
			threadFingerprint: 'newer-thread-fingerprint',
			entries: [entry({ id: 'entry-1', sequence: 0, text: 'initial updated' }), entry({ id: 'entry-3', sequence: 2 })],
		})
		expect(shouldResetTaskThreadOlder(held, latest, true)).toBe(false)
		const merged = applyTaskThreadLatestResponse(held, latest, true)
		expect(merged.entries.map((item) => item.id)).toEqual(['entry-1', 'entry-2', 'entry-3'])
		expect(merged.entries[0]?.text).toBe('initial updated')
	})

	test('an older page keeps the newest identity, summary, fingerprint, and the older pagination', () => {
		const held = thread({
			runId: 'run-1',
			threadFingerprint: 'full-thread-fingerprint',
			entries: [entry({ id: 'entry-1', sequence: 0 }), entry({ id: 'entry-4', sequence: 3 })],
			pagination: { hasMoreOlder: true, nextCursor: 'entry-4' },
		})
		const older = thread({
			runId: 'run-1',
			threadFingerprint: 'older-page-fingerprint',
			entries: [entry({ id: 'entry-1', sequence: 0 }), entry({ id: 'entry-2', sequence: 1 }), entry({ id: 'entry-3', sequence: 2 })],
			pagination: { hasMoreOlder: false, nextCursor: null },
			summaryState: 'pending',
		})
		const outcome = applyTaskThreadOlderResponse({ heldThread: held, body: older, runId: 'run-1', requestToken: 1, currentToken: 1, selectedRunId: 'run-1' })
		expect(outcome.kind).toBe('merge')
		if (outcome.kind !== 'merge') throw new Error('expected a merge outcome')
		const merged = outcome.thread
		expect(merged.entries.map((item) => item.sequence)).toEqual([0, 1, 2, 3])
		expect(merged.entries.filter((item) => item.id === 'entry-1').length).toBe(1)
		expect(merged.threadFingerprint).toBe('full-thread-fingerprint')
		expect(merged.summaryState).toBe(held.summaryState)
		expect(merged.pagination).toEqual({ hasMoreOlder: false, nextCursor: null })
	})

	test('a latest page preserves loaded older entries and the held older pagination when the ranges connect', () => {
		const held = thread({
			threadFingerprint: 'full-thread-fingerprint',
			entries: [entry({ id: 'entry-1', sequence: 0 }), entry({ id: 'entry-2', sequence: 1 }), entry({ id: 'entry-3', sequence: 2 })],
			pagination: { hasMoreOlder: true, nextCursor: 'entry-2' },
		})
		const latest = thread({
			threadFingerprint: 'newer-thread-fingerprint',
			entries: [entry({ id: 'entry-1', sequence: 0 }), entry({ id: 'entry-4', sequence: 3 })],
			pagination: { hasMoreOlder: true, nextCursor: 'entry-4' },
			summaryState: 'pending',
		})
		expect(shouldResetTaskThreadOlder(held, latest, true)).toBe(false)
		const merged = applyTaskThreadLatestResponse(held, latest, true)
		expect(merged.entries.map((item) => item.sequence)).toEqual([0, 1, 2, 3])
		expect(merged.threadFingerprint).toBe('newer-thread-fingerprint')
		expect(merged.summaryState).toBe('pending')
		expect(merged.pagination).toEqual(held.pagination)
	})

	test('a gap resets to the latest page when older pages were loaded but they still had more', () => {
		const held = thread({
			threadFingerprint: 'held-fingerprint',
			entries: [entry({ id: 'entry-1', sequence: 0 }), entry({ id: 'entry-2', sequence: 1 }), entry({ id: 'entry-3', sequence: 2 })],
			pagination: { hasMoreOlder: true, nextCursor: 'entry-2' },
		})
		const latest = thread({
			threadFingerprint: 'latest-fingerprint',
			entries: [entry({ id: 'entry-1', sequence: 0 }), entry({ id: 'entry-600', sequence: 599 }), entry({ id: 'entry-601', sequence: 600 })],
			pagination: { hasMoreOlder: true, nextCursor: 'entry-600' },
		})
		expect(shouldResetTaskThreadOlder(held, latest, true)).toBe(true)
		const merged = applyTaskThreadLatestResponse(held, latest, true)
		expect(merged).toBe(latest)
		expect(merged.entries.map((item) => item.sequence)).toEqual([0, 599, 600])
		expect(merged.pagination).toEqual({ hasMoreOlder: true, nextCursor: 'entry-600' })
	})

	test('a gap re-exposes the Load older control when the held range was fully loaded', () => {
		const held = thread({
			threadFingerprint: 'held-fingerprint',
			entries: [entry({ id: 'entry-1', sequence: 0 }), entry({ id: 'entry-500', sequence: 499 })],
			pagination: { hasMoreOlder: false, nextCursor: null },
		})
		const latest = thread({
			threadFingerprint: 'latest-fingerprint',
			entries: [entry({ id: 'entry-1', sequence: 0 }), entry({ id: 'entry-1000', sequence: 999 }), entry({ id: 'entry-1001', sequence: 1000 })],
			pagination: { hasMoreOlder: true, nextCursor: 'entry-1000' },
		})
		expect(shouldResetTaskThreadOlder(held, latest, true)).toBe(true)
		const merged = applyTaskThreadLatestResponse(held, latest, true)
		expect(merged).toBe(latest)
		expect(merged.pagination.hasMoreOlder).toBe(true)
		expect(merged.pagination.nextCursor).toBe('entry-1000')
	})

	test('uses the latest response unchanged when no older page was loaded', () => {
		const held = thread()
		const latest = thread({ entries: [entry({ id: 'entry-1', sequence: 0 }), entry({ id: 'entry-2', sequence: 1 })] })
		expect(applyTaskThreadLatestResponse(held, latest, false)).toBe(latest)
		expect(shouldResetTaskThreadOlder(held, latest, false)).toBe(false)
		expect(applyTaskThreadLatestResponse(null, latest, true)).toBe(latest)
		expect(shouldResetTaskThreadOlder(null, latest, true)).toBe(true)
		expect(applyTaskThreadLatestResponse(held, latest, true).entries.length).toBe(2)
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

	test('an older-page response is ignored when its token or run is stale', () => {
		const olderToken = 4
		expect(isCurrentTaskThreadResponse({ requestToken: 3, currentToken: olderToken, runId: 'run-1', selectedRunId: 'run-1' })).toBe(false)
		expect(isCurrentTaskThreadResponse({ requestToken: olderToken, currentToken: olderToken, runId: 'run-1', selectedRunId: 'run-2' })).toBe(false)
		expect(isCurrentTaskThreadResponse({ requestToken: olderToken, currentToken: olderToken, runId: 'run-1', selectedRunId: 'run-1' })).toBe(true)
	})
})

describe('older-page responses', () => {
	const held = thread({ entries: [entry({ id: 'entry-1', sequence: 0 }), entry({ id: 'entry-4', sequence: 3 })], pagination: { hasMoreOlder: true, nextCursor: 'entry-4' } })
	const older = thread({ entries: [entry({ id: 'entry-1', sequence: 0 }), entry({ id: 'entry-2', sequence: 1 })], pagination: { hasMoreOlder: false, nextCursor: null } })

	test('a stale token or changed run is ignored instead of merged', () => {
		expect(applyTaskThreadOlderResponse({ heldThread: held, body: older, runId: 'run-1', requestToken: 1, currentToken: 2, selectedRunId: 'run-1' })).toEqual({ kind: 'ignored' })
		expect(applyTaskThreadOlderResponse({ heldThread: held, body: older, runId: 'run-1', requestToken: 2, currentToken: 2, selectedRunId: 'run-2' })).toEqual({ kind: 'ignored' })
	})

	test('a rejected cursor response sets the older-load error instead of merging the newest page', () => {
		expect(applyTaskThreadOlderResponse({ heldThread: held, body: { ok: false, error: 'invalid_cursor' }, runId: 'run-1', requestToken: 2, currentToken: 2, selectedRunId: 'run-1' })).toEqual({ kind: 'error' })
		expect(applyTaskThreadOlderResponse({ heldThread: held, body: null, runId: 'run-1', requestToken: 2, currentToken: 2, selectedRunId: 'run-1' })).toEqual({ kind: 'error' })
	})

	test('a valid older page merges by id and adopts its pagination', () => {
		const outcome = applyTaskThreadOlderResponse({ heldThread: held, body: older, runId: 'run-1', requestToken: 2, currentToken: 2, selectedRunId: 'run-1' })
		expect(outcome.kind).toBe('merge')
		if (outcome.kind !== 'merge') throw new Error('expected a merge outcome')
		expect(outcome.thread.entries.map((item) => item.sequence)).toEqual([0, 1, 3])
		expect(outcome.thread.pagination).toEqual({ hasMoreOlder: false, nextCursor: null })
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
