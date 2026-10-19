import { canonicalSerialize, defineCollection } from '../entity-diff/index.js'
import type { CollectionDefinitions, ReplicaState } from '../entity-diff/index.js'
import { isObject } from '../guards.js'
import type { RunStatus } from '../interaction-model.js'

// The result card and run-level error a run summary carries, declared structurally here so this browser-pure module never imports the server render module (whose ResultCard is the same wire shape).
export interface RunResultCard {
	status: 'success' | 'error' | 'needs_clarification'
	summary: string
	artifacts?: string[]
	error?: { kind: string; message?: string; details?: unknown }
	detail?: string
}

export interface RunSummaryError {
	kind: string
	message: string
}

// The run-list entity. entity-diff keys a collection by `id`, so the entity carries the run id as its `id`; `runSummariesFromReplicaState` restores the wire's `runId` field on reconstruction. Fields below can change while a run is in flight (a status flips, an end time lands, a result or error card appears, the generated summary arrives), so the versionOf covers all of them.
export interface RunSummaryEntity {
	id: string
	status: RunStatus
	task: string | null
	effort: string | null
	involvement: string | null
	startTime: string | null
	endTime: string | null
	result: RunResultCard | null
	error: RunSummaryError | null
	continuesFrom: string | null
	summary: string | null
}

// The run-list summary as the client reads it (GET /api/runs), structurally the server's renderRunSummary output with the entity's `id` renamed back to `runId`.
export interface RunSummary {
	runId: string
	status: RunStatus
	task: string | null
	effort: string | null
	involvement: string | null
	startTime: string | null
	endTime: string | null
	result: RunResultCard | null
	error: RunSummaryError | null
	continuesFrom: string | null
	summary: string | null
}

export interface RunListCollections {
	runs: RunSummaryEntity
}

function isRunStatus(value: unknown): value is RunStatus {
	return value === 'running' || value === 'success' || value === 'error' || value === 'needs_clarification' || value === 'interrupted' || value === 'unknown'
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === 'string'
}

function isStringArray(value: unknown): value is string[] {
	if (!Array.isArray(value)) return false
	for (const item of value) {
		if (typeof item !== 'string') return false
	}
	return true
}

function isResultCardStatus(value: unknown): value is RunResultCard['status'] {
	return value === 'success' || value === 'error' || value === 'needs_clarification'
}

// The card's nested error validates its identifying fields only: `details` is an opaque machine payload the server preserves but never constrains, so the guard must not reject it.
function isResultCardError(value: unknown): value is { kind: string; message?: string; details?: unknown } {
	if (!isObject(value)) return false
	if (typeof value['kind'] !== 'string') return false
	const message = value['message']
	if (message !== undefined && typeof message !== 'string') return false
	return true
}

function isResultCard(value: unknown): value is RunResultCard {
	if (!isObject(value)) return false
	if (!isResultCardStatus(value['status'])) return false
	if (typeof value['summary'] !== 'string') return false
	const artifacts = value['artifacts']
	if (artifacts !== undefined && !isStringArray(artifacts)) return false
	const error = value['error']
	if (error !== undefined && !isResultCardError(error)) return false
	const detail = value['detail']
	if (detail !== undefined && typeof detail !== 'string') return false
	return true
}

function isRunSummaryError(value: unknown): value is RunSummaryError {
	if (!isObject(value)) return false
	if (typeof value['kind'] !== 'string') return false
	if (typeof value['message'] !== 'string') return false
	return true
}

function isRunSummaryEntity(value: unknown): value is RunSummaryEntity {
	if (!isObject(value)) return false
	if (typeof value['id'] !== 'string' || value['id'] === '') return false
	if (!isRunStatus(value['status'])) return false
	if (!isNullableString(value['task'])) return false
	if (!isNullableString(value['effort'])) return false
	if (!isNullableString(value['involvement'])) return false
	if (!isNullableString(value['startTime'])) return false
	if (!isNullableString(value['endTime'])) return false
	const result = value['result']
	if (result !== null && !isResultCard(result)) return false
	const error = value['error']
	if (error !== null && !isRunSummaryError(error)) return false
	if (!isNullableString(value['continuesFrom'])) return false
	if (!isNullableString(value['summary'])) return false
	return true
}

// A cheap change detector: it serializes the mutable fields (not the identity-bearing id) canonically, so a change to any field bumps the entity version while an unchanged entity is stable. canonicalSerialize escapes strings, so free-text task/summary content cannot shift field boundaries and collide two different summaries.
function runSummaryVersionOf(summary: RunSummaryEntity): string {
	return canonicalSerialize([summary.status, summary.task, summary.effort, summary.involvement, summary.startTime, summary.endTime, summary.result, summary.error, summary.continuesFrom, summary.summary])
}

export const runListDefinitions: CollectionDefinitions<RunListCollections> = {
	runs: defineCollection(isRunSummaryEntity, runSummaryVersionOf),
}

export type RunListReplicaState = ReplicaState<RunListCollections>

export function emptyRunListReplicaState(): RunListReplicaState {
	return { runs: [] }
}

// Rebuilds the summaries the history view reads. Unlike the flow collections the run list is NOT append-ordered — the server prepends a new run — so the client must impose its own order: run ids are timestamp-encoded and sort lexicographically newest-first, so descending by id yields the newest-first display order.
export function runSummariesFromReplicaState(state: RunListReplicaState): RunSummary[] {
	const summaries: RunSummary[] = state.runs.map((entity) => ({
		runId: entity.id,
		status: entity.status,
		task: entity.task,
		effort: entity.effort,
		involvement: entity.involvement,
		startTime: entity.startTime,
		endTime: entity.endTime,
		result: entity.result,
		error: entity.error,
		continuesFrom: entity.continuesFrom,
		summary: entity.summary,
	}))
	summaries.sort((left, right) => (left.runId < right.runId ? 1 : left.runId > right.runId ? -1 : 0))
	return summaries
}

// Converts a summary to the entity-diff entity: the run id becomes the entity's `id` (the collection key) and the wire `runId` is restored on reconstruction.
export function runSummaryEntityFor(summary: RunSummary): RunSummaryEntity {
	return {
		id: summary.runId,
		status: summary.status,
		task: summary.task,
		effort: summary.effort,
		involvement: summary.involvement,
		startTime: summary.startTime,
		endTime: summary.endTime,
		result: summary.result,
		error: summary.error,
		continuesFrom: summary.continuesFrom,
		summary: summary.summary,
	}
}

// The server replica receives the summaries in whatever order its reader produced them; this module owns the newest-first ordering, so it sorts by run id before building the entity collection.
export function runListReplicaStateFromSummaries(summaries: readonly RunSummary[]): RunListReplicaState {
	const entities = summaries.slice().sort((left, right) => (left.runId < right.runId ? 1 : left.runId > right.runId ? -1 : 0)).map(runSummaryEntityFor)
	return { runs: entities }
}
