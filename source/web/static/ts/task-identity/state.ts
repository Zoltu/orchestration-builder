// Pure task-thread fetch and summary-trigger decisions. The product client owns the actual fetches and timers; these helpers only decide what a fetched thread implies so the decisions can be exercised in memory.

import { isTaskThreadResponse } from './wire.js'
import type { TaskThreadEntry, TaskThreadResponse, TaskThreadSummarySnapshot } from './wire.js'

export const TASK_THREAD_SUMMARY_REFETCH_DELAY_MS = 1200
export const TASK_THREAD_REFRESH_DEBOUNCE_MS = 250
export const TASK_THREAD_SUMMARY_RETRY_COOLDOWN_MS = 60_000
export const TASK_THREAD_SUMMARY_MAX_REFETCHES = 130
export const TASK_THREAD_SUMMARY_MAX_AUTO_RETRIES = 2
export const TASK_THREAD_TRANSIENT_404_MAX_RETRIES = 5

export type TaskThreadLoadState = 'idle' | 'loading' | 'ready' | 'error'
export type TaskThreadOlderLoadState = 'idle' | 'loading' | 'error'

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

export function taskThreadUrl(runId: string, before?: string): string {
	const base = `api/runs/${encodeURIComponent(runId)}/thread`
	if (before === undefined || before === '') return base
	return `${base}?before=${encodeURIComponent(before)}`
}

export function taskThreadSummaryUrl(runId: string): string {
	return `api/runs/${encodeURIComponent(runId)}/thread/summary`
}

// The summary artifact is fingerprinted over the full thread, which a page cannot reconstruct; the server supplies that value on every page.
export function taskThreadFingerprint(thread: TaskThreadResponse): string {
	return thread.threadFingerprint
}

function mergeTaskThreadEntries(olderEntries: readonly TaskThreadEntry[], newerEntries: readonly TaskThreadEntry[]): TaskThreadEntry[] {
	const byId = new Map<string, TaskThreadEntry>()
	for (const entry of olderEntries) byId.set(entry.id, entry)
	for (const entry of newerEntries) byId.set(entry.id, entry)
	return [...byId.values()].sort((left, right) => left.sequence - right.sequence)
}

function maximumSequence(entries: readonly TaskThreadEntry[]): number | null {
	let maximum: number | null = null
	for (const entry of entries) {
		if (maximum === null || entry.sequence > maximum) maximum = entry.sequence
	}
	return maximum
}

function latestNonInitialMinimumSequence(latest: TaskThreadResponse): number | null {
	const initialId = latest.entries[0]?.id
	let minimum: number | null = null
	for (const entry of latest.entries) {
		if (entry.id === initialId) continue
		if (minimum === null || entry.sequence < minimum) minimum = entry.sequence
	}
	return minimum
}

function hasTaskThreadSequenceGap(held: TaskThreadResponse, latest: TaskThreadResponse): boolean {
	const heldMaximum = maximumSequence(held.entries)
	const latestMinimum = latestNonInitialMinimumSequence(latest)
	if (heldMaximum === null || latestMinimum === null) return false
	return latestMinimum > heldMaximum + 1
}

function applyTaskThreadLatestPage(held: TaskThreadResponse, latest: TaskThreadResponse): TaskThreadResponse {
	return {
		...latest,
		entries: mergeTaskThreadEntries(held.entries, latest.entries),
		pagination: held.pagination,
	}
}

function shouldResetTaskThreadOlderRange(held: TaskThreadResponse, latest: TaskThreadResponse): boolean {
	if (held.runId !== latest.runId || held.entries.length === 0) return true
	return hasTaskThreadSequenceGap(held, latest)
}

export function shouldResetTaskThreadOlder(held: TaskThreadResponse | null, latest: TaskThreadResponse, olderPagesLoaded: boolean): boolean {
	if (!olderPagesLoaded) return false
	return held === null || shouldResetTaskThreadOlderRange(held, latest)
}

export function applyTaskThreadLatestResponse(held: TaskThreadResponse | null, latest: TaskThreadResponse, olderPagesLoaded: boolean): TaskThreadResponse {
	if (!olderPagesLoaded || held === null || shouldResetTaskThreadOlderRange(held, latest)) return latest
	return applyTaskThreadLatestPage(held, latest)
}

function applyTaskThreadOlderPage(held: TaskThreadResponse, older: TaskThreadResponse): TaskThreadResponse {
	return {
		...held,
		entries: mergeTaskThreadEntries(older.entries, held.entries),
		pagination: older.pagination,
	}
}

export type TaskThreadOlderResponseOutcome =
	| { kind: 'ignored' }
	| { kind: 'error' }
	| { kind: 'merge'; thread: TaskThreadResponse }

export interface TaskThreadOlderResponseInput {
	heldThread: TaskThreadResponse | null
	body: unknown
	runId: string
	requestToken: number
	currentToken: number
	selectedRunId: string | null
}

export function applyTaskThreadOlderResponse(input: TaskThreadOlderResponseInput): TaskThreadOlderResponseOutcome {
	if (!isCurrentTaskThreadResponse(input)) return { kind: 'ignored' }
	if (input.heldThread === null || input.heldThread.runId !== input.runId) return { kind: 'error' }
	if (!isTaskThreadResponse(input.body) || input.body.runId !== input.runId) return { kind: 'error' }
	return { kind: 'merge', thread: applyTaskThreadOlderPage(input.heldThread, input.body) }
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
