import type { LlmCallResult, LlmRequest, LlmUsage } from '../executor/llm.js'
import type { TaskIdentity, TaskThreadEntry } from './model.js'
import { boundTaskSummary, buildTaskSummaryRequest, isTaskSummary, parseTaskSummaryOutput, TASK_SUMMARY_RETRY_COOLDOWN_MS, threadFingerprint } from './summary.js'
import type { TaskSummary, TaskSummaryState } from './summary.js'
import { canonicalTimestampMillis } from './time.js'

export type TaskThreadSummaryLlmCall = (request: LlmRequest) => Promise<LlmCallResult>
export type ReadTaskThread = (runId: string) => { identity: TaskIdentity, entries: TaskThreadEntry[] } | null
export type ReadTaskSummaryText = (runId: string) => string | null
export type WriteTaskSummaryText = (runId: string, text: string) => void
export type RecordTaskSummaryUsage = (runId: string, usage: LlmUsage) => void
export type TaskThreadSummaryNow = () => string

export interface TaskThreadSummarizerDependencies {
	readThread: ReadTaskThread
	readSummaryText: ReadTaskSummaryText
	writeSummaryText: WriteTaskSummaryText
	callLlm: TaskThreadSummaryLlmCall
	recordLlmUsage: RecordTaskSummaryUsage
	now: TaskThreadSummaryNow
}

export interface TaskThreadSummarySnapshot {
	state: TaskSummaryState
	summary: TaskSummary | null
}

export interface TaskThreadSummaryResult extends TaskThreadSummarySnapshot {
	done: Promise<void>
}

export interface TaskThreadSummarizer {
	request(runId: string): TaskThreadSummaryResult
	peek(runId: string, identity: TaskIdentity, entries: readonly TaskThreadEntry[]): TaskThreadSummarySnapshot
}

interface Attempt {
	fingerprint: string
	promise: Promise<void>
}

interface RunState {
	attempt: Attempt | null
	trailingFingerprint: string | null
	failedFingerprint: string | null
	failedAtMillis: number | null
	lastSeenFingerprint: string | null
}

function parseSummaryArtifact(text: string | null): TaskSummary | null {
	if (text === null) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return null
	}
	if (!isTaskSummary(parsed)) return null
	return boundTaskSummary(parsed)
}

function nowMillis(now: TaskThreadSummaryNow): number {
	const millis = canonicalTimestampMillis(now())
	if (millis === null) throw new Error('task-thread summarizer: now() must return a canonical UTC timestamp')
	return millis
}

function waitForIdle(state: RunState): Promise<void> {
	const attempt = state.attempt
	if (attempt === null) return Promise.resolve()
	return attempt.promise.then(() => waitForIdle(state))
}

function markFailed(state: RunState, fingerprint: string, now: TaskThreadSummaryNow): void {
	state.failedFingerprint = fingerprint
	state.failedAtMillis = nowMillis(now)
}

function markSucceeded(state: RunState): void {
	state.failedFingerprint = null
	state.failedAtMillis = null
}

async function performAttempt(dependencies: TaskThreadSummarizerDependencies, runId: string, state: RunState, fingerprint: string, request: LlmRequest): Promise<void> {
	let result: LlmCallResult
	try {
		result = await dependencies.callLlm(request)
	} catch {
		markFailed(state, fingerprint, dependencies.now)
		return
	}
	if (result.kind !== 'success') {
		markFailed(state, fingerprint, dependencies.now)
		return
	}
	if (result.usage !== undefined) dependencies.recordLlmUsage(runId, result.usage)
	if (result.content === undefined) {
		markFailed(state, fingerprint, dependencies.now)
		return
	}
	const summary = parseTaskSummaryOutput(result.content, { runId, fingerprint, generatedAt: dependencies.now() })
	if (summary === null) {
		markFailed(state, fingerprint, dependencies.now)
		return
	}
	const latest = dependencies.readThread(runId)
	if (latest === null) return
	const latestFingerprint = threadFingerprint(latest.identity, latest.entries)
	if (latestFingerprint !== fingerprint) return
	try {
		dependencies.writeSummaryText(runId, JSON.stringify(summary))
	} catch {
		markFailed(state, fingerprint, dependencies.now)
		return
	}
	markSucceeded(state)
}

function startTrailingAttempt(dependencies: TaskThreadSummarizerDependencies, runId: string, state: RunState, completedFingerprint: string): void {
	if (state.trailingFingerprint === null) return
	state.trailingFingerprint = null
	const latest = dependencies.readThread(runId)
	if (latest === null) return
	const latestFingerprint = threadFingerprint(latest.identity, latest.entries)
	if (latestFingerprint === completedFingerprint) return
	beginAttempt(dependencies, runId, state, latest, latestFingerprint)
}

function beginAttempt(dependencies: TaskThreadSummarizerDependencies, runId: string, state: RunState, thread: { identity: TaskIdentity, entries: TaskThreadEntry[] }, fingerprint: string): void {
	const request = buildTaskSummaryRequest(thread.identity, thread.entries)
	const attempt: Attempt = { fingerprint, promise: Promise.resolve() }
	state.attempt = attempt
	attempt.promise = performAttempt(dependencies, runId, state, fingerprint, request)
		.then(() => undefined)
		.catch(() => undefined)
		.finally(() => {
			if (state.attempt !== attempt) return
			state.attempt = null
			startTrailingAttempt(dependencies, runId, state, attempt.fingerprint)
		})
}

export function createTaskThreadSummarizer(dependencies: TaskThreadSummarizerDependencies): TaskThreadSummarizer {
	const states = new Map<string, RunState>()
	const MAX_SUMMARIZER_RUN_STATES = 64
	function forgetIdle(runId: string): void {
		const state = states.get(runId)
		if (state !== undefined && state.attempt === null) states.delete(runId)
	}
	function pruneIdleStatesForInsert(): void {
		if (states.size < MAX_SUMMARIZER_RUN_STATES) return
		for (const [runId, state] of states) {
			if (states.size < MAX_SUMMARIZER_RUN_STATES) break
			if (state.attempt === null) states.delete(runId)
		}
	}
	function stateFor(runId: string): RunState {
		const existing = states.get(runId)
		if (existing !== undefined) {
			states.delete(runId)
			states.set(runId, existing)
			return existing
		}
		pruneIdleStatesForInsert()
		const state: RunState = { attempt: null, trailingFingerprint: null, failedFingerprint: null, failedAtMillis: null, lastSeenFingerprint: null }
		states.set(runId, state)
		return state
	}
	function peek(runId: string, identity: TaskIdentity, entries: readonly TaskThreadEntry[]): TaskThreadSummarySnapshot {
		const fingerprint = threadFingerprint(identity, entries)
		const artifact = parseSummaryArtifact(dependencies.readSummaryText(runId))
		if (artifact !== null && artifact.runId === runId && artifact.fingerprint === fingerprint) {
			forgetIdle(runId)
			return { state: 'ready', summary: artifact }
		}
		const state = states.get(runId)
		if (state === undefined) return { state: 'none', summary: null }
		state.lastSeenFingerprint = fingerprint
		if (state.attempt !== null) {
			if (state.attempt.fingerprint === fingerprint || state.trailingFingerprint === fingerprint) return { state: 'pending', summary: null }
			return { state: 'none', summary: null }
		}
		if (state.failedFingerprint === fingerprint && state.failedAtMillis !== null) {
			const currentMillis = nowMillis(dependencies.now)
			if (currentMillis - state.failedAtMillis < TASK_SUMMARY_RETRY_COOLDOWN_MS) return { state: 'failed', summary: null }
		}
		return { state: 'none', summary: null }
	}
	return {
		peek,
		request(runId) {
			const existing = states.get(runId)
			if (existing !== undefined && existing.attempt !== null && existing.lastSeenFingerprint !== null) {
				if (existing.lastSeenFingerprint !== existing.attempt.fingerprint) existing.trailingFingerprint = existing.lastSeenFingerprint
				return { state: 'pending', summary: null, done: waitForIdle(existing) }
			}
			const thread = dependencies.readThread(runId)
			if (thread === null) {
				forgetIdle(runId)
				return { state: 'none', summary: null, done: Promise.resolve() }
			}
			const fingerprint = threadFingerprint(thread.identity, thread.entries)
			const snapshot = peek(runId, thread.identity, thread.entries)
			if (snapshot.state === 'ready') return { ...snapshot, done: Promise.resolve() }
			const state = stateFor(runId)
			state.lastSeenFingerprint = fingerprint
			if (state.attempt !== null) {
				if (state.attempt.fingerprint !== fingerprint) state.trailingFingerprint = fingerprint
				return { state: 'pending', summary: null, done: waitForIdle(state) }
			}
			if (snapshot.state === 'failed') return { ...snapshot, done: Promise.resolve() }
			state.trailingFingerprint = null
			beginAttempt(dependencies, runId, state, thread, fingerprint)
			return { state: 'pending', summary: null, done: waitForIdle(state) }
		},
	}
}
