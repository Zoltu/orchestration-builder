import { describe, expect, test } from 'bun:test'
import type { LlmCallResult, LlmRequest, LlmUsage } from '../executor/llm.js'
import type { TaskIdentity, TaskLineage, TaskThreadEntry } from './model.js'
import { createTaskThreadSummarizer } from './summarizer.js'
import type { TaskThreadSummarizer } from './summarizer.js'
import { TASK_SUMMARY_DESCRIPTION_MAX_CHARS, TASK_SUMMARY_TITLE_MAX_CHARS, threadFingerprint } from './summary.js'

const RUN_A = 'run-20260101-000000'
const T0 = '2026-01-01T00:00:00.000Z'
const T30 = '2026-01-01T00:00:30.000Z'
const T60 = '2026-01-01T00:01:00.000Z'

function sampleLineage(): TaskLineage {
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
	}
}

function thread(task: string): { identity: TaskIdentity, entries: TaskThreadEntry[] } {
	const identity: TaskIdentity = {
		runId: RUN_A,
		status: 'running',
		title: task,
		description: task,
		currentTask: { runId: RUN_A, text: task, at: T0, source: 'meta' },
		originalTask: { runId: RUN_A, text: task, at: T0, source: 'meta' },
		lineage: sampleLineage(),
		latestHumanEvent: null,
	}
	const entry: TaskThreadEntry = {
		id: `task:${RUN_A}`,
		sequence: 0,
		runId: RUN_A,
		timestamp: T0,
		kind: 'task',
		actor: 'human',
		label: 'Initial task',
		text: task,
		context: null,
		status: null,
		systemKind: null,
		outcome: null,
		questionId: null,
		relatedEntryId: null,
		queueItemId: null,
		source: 'meta',
		textTruncated: false,
	}
	return { identity, entries: [entry] }
}

function success(content: string, usage?: LlmUsage): LlmCallResult {
	return { kind: 'success', content, toolCalls: [], ...(usage !== undefined ? { usage } : {}) }
}

function summaryJson(title: string, description: string): string {
	return JSON.stringify({ title, description })
}

interface PendingCall {
	request: LlmRequest
	resolve: (result: LlmCallResult) => void
}

interface Harness {
	summarizer: TaskThreadSummarizer
	requests: LlmRequest[]
	writes: Array<{ runId: string, text: string }>
	recordedUsage: Array<{ runId: string, usage: LlmUsage }>
	setThread: (value: { identity: TaskIdentity, entries: TaskThreadEntry[] } | null) => void
	setSummaryText: (value: string | null) => void
	setNow: (value: string) => void
	resolveNext: (result: LlmCallResult) => void
	waitForRequests: (count: number) => Promise<void>
	readThreadCalls: () => number
}

function createHarness(initialThread: { identity: TaskIdentity, entries: TaskThreadEntry[] } | null, initialSummaryText: string | null = null): Harness {
	let currentThread = initialThread
	let currentSummaryText = initialSummaryText
	let currentNow = T0
	const requests: LlmRequest[] = []
	const pending: PendingCall[] = []
	const waiters: Array<() => void> = []
	const writes: Array<{ runId: string, text: string }> = []
	const recordedUsage: Array<{ runId: string, usage: LlmUsage }> = []
	let readThreadCalls = 0
	function notifyWaiters(): void {
		for (const waiter of waiters.splice(0)) waiter()
	}
	function waitForRequests(count: number): Promise<void> {
		if (requests.length >= count) return Promise.resolve()
		return new Promise((resolve) => {
			const check = (): void => {
				if (requests.length >= count) resolve()
				else waiters.push(check)
			}
			waiters.push(check)
		})
	}
	const summarizer = createTaskThreadSummarizer({
		readThread: () => {
			readThreadCalls++
			return currentThread
		},
		readSummaryText: () => currentSummaryText,
		writeSummaryText: (runId, text) => {
			currentSummaryText = text
			writes.push({ runId, text })
		},
		callLlm: (request) => {
			requests.push(request)
			return new Promise((resolve) => {
				pending.push({ request, resolve })
				notifyWaiters()
			})
		},
		recordLlmUsage: (runId, usage) => {
			recordedUsage.push({ runId, usage })
		},
		now: () => currentNow,
	})
	return {
		summarizer,
		requests,
		writes,
		recordedUsage,
		setThread: (value) => {
			currentThread = value
		},
		setSummaryText: (value) => {
			currentSummaryText = value
		},
		setNow: (value) => {
			currentNow = value
		},
		resolveNext: (result) => {
			const call = pending.shift()
			if (call === undefined) throw new Error('no pending LLM call to resolve')
			call.resolve(result)
		},
		waitForRequests,
		readThreadCalls: () => readThreadCalls,
	}
}

describe('createTaskThreadSummarizer', () => {
	test('returns none when the run has no thread', () => {
		const harness = createHarness(null)
		const result = harness.summarizer.request(RUN_A)
		expect(result.state).toBe('none')
		expect(result.summary).toBeNull()
		expect(harness.requests.length).toBe(0)
	})

	test('returns a ready artifact for the current fingerprint without calling the model', () => {
		const current = thread('Fix the parser')
		const fingerprint = threadFingerprint(current.identity, current.entries)
		const artifact = { formatVersion: 1, runId: RUN_A, fingerprint, title: 'Cached title', description: 'Cached description.', generatedAt: T0 }
		const harness = createHarness(current, JSON.stringify(artifact))
		const result = harness.summarizer.request(RUN_A)
		expect(result.state).toBe('ready')
		expect(result.summary?.title).toBe('Cached title')
		expect(harness.requests.length).toBe(0)
	})

	test('peek reports ready, pending, and failed without starting a new call', async () => {
		const current = thread('Fix the parser')
		const fingerprint = threadFingerprint(current.identity, current.entries)
		const readyHarness = createHarness(current, JSON.stringify({ formatVersion: 1, runId: RUN_A, fingerprint, title: 'Cached title', description: 'Cached description.', generatedAt: T0 }))
		expect(readyHarness.summarizer.peek(RUN_A, current.identity, current.entries).state).toBe('ready')
		expect(readyHarness.requests.length).toBe(0)

		const pendingHarness = createHarness(thread('Fix the parser'))
		const pending = pendingHarness.summarizer.request(RUN_A)
		await pendingHarness.waitForRequests(1)
		expect(pendingHarness.summarizer.peek(RUN_A, thread('Fix the parser').identity, thread('Fix the parser').entries).state).toBe('pending')
		expect(pendingHarness.requests.length).toBe(1)
		pendingHarness.resolveNext(success(summaryJson('Fix parser', 'Fix the parser.')))
		await pending.done

		const failedHarness = createHarness(thread('Fix the parser'))
		const failed = failedHarness.summarizer.request(RUN_A)
		await failedHarness.waitForRequests(1)
		failedHarness.resolveNext({ kind: 'llm_unavailable', message: 'down' })
		await failed.done
		const failedThread = thread('Fix the parser')
		expect(failedHarness.summarizer.peek(RUN_A, failedThread.identity, failedThread.entries).state).toBe('failed')
		expect(failedHarness.requests.length).toBe(1)
	})

	test('peek reports none for a newer fingerprint with no current or trailing attempt', async () => {
		const harness = createHarness(thread('Fix the parser'))
		const first = harness.summarizer.request(RUN_A)
		await harness.waitForRequests(1)
		const newer = thread('Fix the parser and add tests')
		expect(harness.summarizer.peek(RUN_A, newer.identity, newer.entries).state).toBe('none')
		harness.setThread(newer)
		const second = harness.summarizer.request(RUN_A)
		expect(second.state).toBe('pending')
		expect(harness.requests.length).toBe(1)
		harness.resolveNext(success(summaryJson('Old title', 'Old description.')))
		await harness.waitForRequests(2)
		harness.resolveNext(success(summaryJson('New title', 'New description.')))
		await second.done
		expect(harness.summarizer.request(RUN_A).state).toBe('ready')
		expect(first.state).toBe('pending')
	})

	test('bounds an artifact title and description at read time', () => {
		const current = thread('Fix the parser')
		const fingerprint = threadFingerprint(current.identity, current.entries)
		const artifact = { formatVersion: 1, runId: RUN_A, fingerprint, title: 't '.repeat(500), description: 'd '.repeat(1000), generatedAt: T0 }
		const harness = createHarness(current, JSON.stringify(artifact))
		const result = harness.summarizer.peek(RUN_A, current.identity, current.entries)
		expect(result.state).toBe('ready')
		expect(result.summary?.title.length).toBeLessThanOrEqual(TASK_SUMMARY_TITLE_MAX_CHARS)
		expect(result.summary?.description.length).toBeLessThanOrEqual(TASK_SUMMARY_DESCRIPTION_MAX_CHARS)
	})

	test('ignores a stale or malformed artifact and starts generation', async () => {
		const current = thread('Fix the parser')
		const harness = createHarness(current, JSON.stringify({ formatVersion: 1, runId: RUN_A, fingerprint: 'old', title: 'Old', description: 'Old.', generatedAt: T0 }))
		const result = harness.summarizer.request(RUN_A)
		expect(result.state).toBe('pending')
		await harness.waitForRequests(1)
		expect(harness.requests.length).toBe(1)

		const malformed = createHarness(current, '{not json')
		expect(malformed.summarizer.request(RUN_A).state).toBe('pending')
		await malformed.waitForRequests(1)
		expect(malformed.requests.length).toBe(1)
	})

	test('shares one in-flight attempt for the same fingerprint', async () => {
		const harness = createHarness(thread('Fix the parser'))
		const first = harness.summarizer.request(RUN_A)
		const second = harness.summarizer.request(RUN_A)
		expect(first.state).toBe('pending')
		expect(second.state).toBe('pending')
		expect(harness.readThreadCalls()).toBe(1)
		await harness.waitForRequests(1)
		expect(harness.requests.length).toBe(1)
		harness.resolveNext(success(summaryJson('Fix parser', 'Fix the parser.')))
		await second.done
		const ready = harness.summarizer.request(RUN_A)
		expect(ready.state).toBe('ready')
		expect(ready.summary?.title).toBe('Fix parser')
		expect(harness.writes.length).toBe(1)
		expect(harness.requests.length).toBe(1)
	})

	test('does not re-derive on repeated triggers while the same fingerprint is in flight', async () => {
		const harness = createHarness(thread('Fix the parser'))
		const first = harness.summarizer.request(RUN_A)
		await harness.waitForRequests(1)
		const calls = harness.readThreadCalls()
		for (let index = 0; index < 5; index++) {
			const repeated = harness.summarizer.request(RUN_A)
			expect(repeated.state).toBe('pending')
		}
		expect(harness.readThreadCalls()).toBe(calls)
		expect(harness.requests.length).toBe(1)
		harness.resolveNext(success(summaryJson('Fix parser', 'Fix the parser.')))
		await first.done
	})

	test('starts at most one trailing regeneration for a newer fingerprint', async () => {
		const harness = createHarness(thread('Fix the parser'))
		const first = harness.summarizer.request(RUN_A)
		await harness.waitForRequests(1)
		harness.setThread(thread('Fix the parser and add tests'))
		const newer = thread('Fix the parser and add tests')
		const peeked = harness.summarizer.peek(RUN_A, newer.identity, newer.entries)
		expect(peeked.state).toBe('none')
		const second = harness.summarizer.request(RUN_A)
		expect(first.state).toBe('pending')
		expect(second.state).toBe('pending')
		expect(harness.requests.length).toBe(1)
		harness.resolveNext(success(summaryJson('Old title', 'Old description.')))
		await harness.waitForRequests(2)
		expect(harness.writes.length).toBe(0)
		harness.resolveNext(success(summaryJson('New title', 'New description.')))
		await second.done
		const ready = harness.summarizer.request(RUN_A)
		expect(ready.state).toBe('ready')
		expect(ready.summary?.title).toBe('New title')
		expect(harness.writes.length).toBe(1)
		expect(harness.requests.length).toBe(2)
	})

	test('skips a write when the fingerprint changed before completion', async () => {
		const harness = createHarness(thread('Fix the parser'))
		const first = harness.summarizer.request(RUN_A)
		await harness.waitForRequests(1)
		harness.setThread(thread('A newer human turn'))
		harness.resolveNext(success(summaryJson('Old title', 'Old description.')))
		await first.done
		expect(harness.writes.length).toBe(0)
		const next = harness.summarizer.request(RUN_A)
		expect(next.state).toBe('pending')
		await harness.waitForRequests(2)
		harness.resolveNext(success(summaryJson('New title', 'New description.')))
		await next.done
		expect(harness.summarizer.request(RUN_A).state).toBe('ready')
	})

	test('fails closed through a cooldown and retries after it expires', async () => {
		const harness = createHarness(thread('Fix the parser'))
		const first = harness.summarizer.request(RUN_A)
		await harness.waitForRequests(1)
		harness.resolveNext({ kind: 'llm_unavailable', message: 'down' })
		await first.done
		expect(harness.summarizer.request(RUN_A).state).toBe('failed')
		harness.setNow(T30)
		expect(harness.summarizer.request(RUN_A).state).toBe('failed')
		expect(harness.requests.length).toBe(1)
		harness.setNow(T60)
		const retry = harness.summarizer.request(RUN_A)
		expect(retry.state).toBe('pending')
		await harness.waitForRequests(2)
		harness.resolveNext(success(summaryJson('Fix parser', 'Fix the parser.')))
		await retry.done
		expect(harness.summarizer.request(RUN_A).state).toBe('ready')
	})

	test('allows a changed fingerprint to start during the failed-fingerprint cooldown', async () => {
		const harness = createHarness(thread('Fix the parser'))
		const first = harness.summarizer.request(RUN_A)
		await harness.waitForRequests(1)
		harness.resolveNext({ kind: 'llm_unavailable', message: 'down' })
		await first.done
		harness.setThread(thread('Fix the parser and add tests'))
		const changed = harness.summarizer.request(RUN_A)
		expect(changed.state).toBe('pending')
		await harness.waitForRequests(2)
		expect(harness.requests.length).toBe(2)
		harness.resolveNext(success(summaryJson('New title', 'New description.')))
		await changed.done
		expect(harness.summarizer.request(RUN_A).state).toBe('ready')
	})

	test('records usage immediately for every successful call, even malformed content', async () => {
		const harness = createHarness(thread('Fix the parser'))
		const first = harness.summarizer.request(RUN_A)
		await harness.waitForRequests(1)
		const usage: LlmUsage = { promptTokens: 10, completionTokens: 5 }
		harness.resolveNext(success(summaryJson('Fix parser', 'Fix the parser.'), usage))
		await first.done
		expect(harness.recordedUsage).toEqual([{ runId: RUN_A, usage }])

		const malformed = createHarness(thread('Fix the parser'))
		const second = malformed.summarizer.request(RUN_A)
		await malformed.waitForRequests(1)
		malformed.resolveNext(success('{not json', usage))
		await second.done
		expect(malformed.recordedUsage).toEqual([{ runId: RUN_A, usage }])
		expect(malformed.summarizer.request(RUN_A).state).toBe('failed')
	})

	test('prunes idle per-run state so the map stays bounded', async () => {
		const harness = createHarness(thread('Fix the parser'))
		for (let index = 0; index < 70; index++) {
			const runId = `run-20260101-${String(index).padStart(6, '0')}`
			const before = harness.requests.length
			const result = harness.summarizer.request(runId)
			await harness.waitForRequests(before + 1)
			harness.resolveNext({ kind: 'llm_unavailable', message: 'down' })
			await result.done
		}
		const retry = harness.summarizer.request('run-20260101-000000')
		expect(retry.state).toBe('pending')
	})

	test('sends no tools and no provider detail', async () => {
		const harness = createHarness(thread('Fix the parser'))
		const result = harness.summarizer.request(RUN_A)
		await harness.waitForRequests(1)
		const request = harness.requests[0]
		expect(request?.tools).toBeUndefined()
		expect(JSON.stringify(request)).not.toContain('detail')
		harness.resolveNext(success(summaryJson('Fix parser', 'Fix the parser.')))
		await result.done
	})
})
