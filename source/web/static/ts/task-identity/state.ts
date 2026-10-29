// Pure task-thread fetch and summary-trigger decisions. The product client owns the actual fetches and timers; these helpers only decide what a fetched thread implies so the decisions can be exercised in memory.

import { sha256Hex } from '../entity-diff/sha256.js'
import { TASK_SUMMARY_FORMAT_VERSION } from './wire.js'
import type { TaskThreadResponse, TaskThreadSummarySnapshot } from './wire.js'

export const TASK_THREAD_SUMMARY_REFETCH_DELAY_MS = 1200
export const TASK_THREAD_REFRESH_DEBOUNCE_MS = 250
export const TASK_THREAD_SUMMARY_RETRY_COOLDOWN_MS = 60_000
export const TASK_THREAD_SUMMARY_MAX_REFETCHES = 130
export const TASK_THREAD_SUMMARY_MAX_AUTO_RETRIES = 2
export const TASK_THREAD_TRANSIENT_404_MAX_RETRIES = 5

export type TaskThreadLoadState = 'idle' | 'loading' | 'ready' | 'error'

export type TaskThreadSummaryPlan =
	| { kind: 'trigger'; key: string }
	| { kind: 'refetch' }
	| { kind: 'timed-out' }
	| { kind: 'none' }

export interface TaskThreadSummaryMatch {
	runId: string
	fingerprint: string
}

export function taskThreadSummaryMatches(thread: TaskThreadResponse, summary: TaskThreadSummaryMatch): boolean {
	return summary.runId === thread.runId && summary.fingerprint === taskThreadFingerprint(thread)
}

export interface TaskThreadSummaryPlanInput {
	thread: TaskThreadResponse
	failedKey: string | null
	retryAt: number | null
	now: number
	pendingRefetches: number
}

export interface TaskThreadRefreshInput {
	runId: string | null
	status: string | null
	result: unknown
	interrupts: unknown
	questionKey: string | null
}

export function taskThreadUrl(runId: string): string {
	return `api/runs/${encodeURIComponent(runId)}/thread`
}

export function taskThreadSummaryUrl(runId: string): string {
	return `api/runs/${encodeURIComponent(runId)}/thread/summary`
}

// Mirrors the server's threadFingerprint exactly: the same ordered inputs, JSON encoding, and SHA-256. A client-computed fingerprint can therefore validate a ready summary before applying it.
export function taskThreadFingerprint(thread: TaskThreadResponse): string {
	const identity = thread.identity
	const input = [
		TASK_SUMMARY_FORMAT_VERSION,
		identity.runId,
		identity.status,
		identity.title,
		identity.description,
		identity.currentTask === null ? null : [identity.currentTask.runId, identity.currentTask.text, identity.currentTask.at, identity.currentTask.source],
		identity.originalTask === null ? null : [identity.originalTask.runId, identity.originalTask.text, identity.originalTask.at, identity.originalTask.source],
		[
			identity.lineage.rootRunId,
			identity.lineage.parentRunId,
			identity.lineage.continuationCount,
			identity.lineage.resumeCount,
			identity.lineage.resumeCountComplete,
			identity.lineage.depth,
			identity.lineage.complete,
			identity.lineage.missingParentRunId,
			identity.lineage.truncatedReason,
		],
		thread.entries.map((entry) => [
			entry.id,
			entry.runId,
			entry.timestamp,
			entry.kind,
			entry.actor,
			entry.label,
			entry.text,
			entry.context,
			entry.status,
			entry.systemKind,
			entry.outcome,
			entry.questionId,
			entry.relatedEntryId,
			entry.queueItemId,
			entry.source,
			entry.textTruncated,
		]),
	]
	return sha256Hex(JSON.stringify(input))
}

export function planTaskThreadSummary(input: TaskThreadSummaryPlanInput): TaskThreadSummaryPlan {
	const thread = input.thread
	if (thread.summaryState === 'pending') {
		if (input.pendingRefetches >= TASK_THREAD_SUMMARY_MAX_REFETCHES) return { kind: 'timed-out' }
		return { kind: 'refetch' }
	}
	if (thread.summaryState !== 'none') return { kind: 'none' }
	const key = taskThreadFingerprint(thread)
	if (key === input.failedKey && input.retryAt !== null && input.now < input.retryAt) return { kind: 'none' }
	return { kind: 'trigger', key }
}

export function applyTaskThreadSummarySnapshot(thread: TaskThreadResponse, snapshot: TaskThreadSummarySnapshot): TaskThreadResponse {
	if (snapshot.state === 'ready') {
		const summary = snapshot.summary
		if (summary === null || summary.runId !== thread.runId) return thread
		if (summary.fingerprint !== taskThreadFingerprint(thread)) return thread
		return { ...thread, summary, summaryState: 'ready' }
	}
	return { ...thread, summary: null, summaryState: snapshot.state }
}

export function taskThreadRefreshSignal(input: TaskThreadRefreshInput): string {
	return JSON.stringify([input.runId, input.status, input.result, input.interrupts, input.questionKey])
}

export function shouldRefreshTaskThread(previousSignal: string | null, nextSignal: string, runId: string | null): boolean {
	if (runId === null || runId === '') return false
	return previousSignal !== nextSignal
}

export function shouldRetryTaskThread404(status: number, retries: number): boolean {
	return status === 404 && retries < TASK_THREAD_TRANSIENT_404_MAX_RETRIES
}

export interface TaskThreadResponseGuardInput {
	requestToken: number
	currentToken: number
	runId: string
	selectedRunId: string | null
}

export function isCurrentTaskThreadResponse(input: TaskThreadResponseGuardInput): boolean {
	return input.requestToken === input.currentToken && input.runId === input.selectedRunId
}

export interface TaskThreadSummaryResponseGuardInput {
	requestToken: number
	currentToken: number
	triggerKey: string | null
	currentTriggerKey: string | null
	runId: string
	selectedRunId: string | null
}

export function isCurrentTaskThreadSummaryResponse(input: TaskThreadSummaryResponseGuardInput): boolean {
	return input.runId === input.selectedRunId && input.requestToken === input.currentToken && input.triggerKey !== null && input.triggerKey === input.currentTriggerKey
}

export interface TaskThreadSummaryFailureGuardInput extends TaskThreadSummaryResponseGuardInput {
	heldThread: TaskThreadResponse | null
}

export function shouldApplyTaskThreadSummaryFailure(input: TaskThreadSummaryFailureGuardInput): boolean {
	if (!isCurrentTaskThreadSummaryResponse(input)) return false
	if (input.heldThread === null) return false
	if (input.heldThread.summaryState === 'ready') return false
	return taskThreadSummaryIsForHeldThread(input.triggerKey, input.heldThread)
}

export function taskThreadSummaryIsForHeldThread(triggerKey: string | null, heldThread: TaskThreadResponse | null): boolean {
	if (triggerKey === null || heldThread === null) return false
	return triggerKey === taskThreadFingerprint(heldThread)
}

export interface TaskThreadSummaryAutoRetryInput {
	failedKey: string | null
	previousKey: string | null
	previousCount: number
}

export interface TaskThreadSummaryAutoRetry {
	key: string | null
	count: number
	shouldSchedule: boolean
}

export function nextTaskThreadSummaryAutoRetry(input: TaskThreadSummaryAutoRetryInput): TaskThreadSummaryAutoRetry {
	if (input.failedKey === null) return { key: null, count: 0, shouldSchedule: false }
	const count = input.previousKey === input.failedKey ? input.previousCount + 1 : 1
	return { key: input.failedKey, count, shouldSchedule: count <= TASK_THREAD_SUMMARY_MAX_AUTO_RETRIES }
}
