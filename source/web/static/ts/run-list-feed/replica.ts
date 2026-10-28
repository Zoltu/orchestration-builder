import { canonicalSerialize, defineCollection } from '../entity-diff/index.js'
import type { CollectionDefinitions, ReplicaState } from '../entity-diff/index.js'
import { isObject } from '../guards.js'
import type { ResumePolicy, RunStatus, SuspensionRecord } from '../interaction-model.js'

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
	suspension: SuspensionRecord | null
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
	suspension: SuspensionRecord | null
	summary: string | null
}

// The coarse provider health carrier the run-list feed rides, so the one-per-second run list also feeds the persistent banner without a second poll. Its fields are exactly the safe health view: no endpoint, credential, model, header, request, or provider body.
export type ProviderHealthState = 'healthy' | 'degraded' | 'unavailable' | 'unknown'
export type HealthCategory = 'none' | 'transient' | 'billing' | 'auth' | 'request_rejected' | 'unknown'

export interface ProviderHealth {
	state: ProviderHealthState
	category: HealthCategory
	since: string
	lastCheckedAt: string
	lastSuccessAt?: string
	consecutiveFailures: number
	nextProbeAt?: string
}

export interface HealthView {
	provider: ProviderHealth
	suspendedRunId: string | null
	resumePolicy: ResumePolicy | null
}

const PROVIDER_HEALTH_ENTITY_ID = 'provider-health' as const

interface ProviderHealthEntity {
	id: typeof PROVIDER_HEALTH_ENTITY_ID
	provider: ProviderHealth
	suspendedRunId: string | null
	resumePolicy: ResumePolicy | null
}

export interface RunListCollections {
	runs: RunSummaryEntity
	health: ProviderHealthEntity
}

function isRunStatus(value: unknown): value is RunStatus {
	return value === 'running' || value === 'suspended' || value === 'success' || value === 'error' || value === 'needs_clarification' || value === 'interrupted' || value === 'unknown'
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

function isSuspensionCategory(value: unknown): value is SuspensionRecord['category'] {
	return value === 'transient' || value === 'billing' || value === 'auth' || value === 'request_rejected' || value === 'unknown'
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === 'string'
}

export function isSuspensionRecord(value: unknown): value is SuspensionRecord {
	if (!isObject(value)) return false
	if (!isSuspensionCategory(value['category'])) return false
	if (value['resumePolicy'] !== 'auto' && value['resumePolicy'] !== 'operator') return false
	if (typeof value['message'] !== 'string') return false
	if (typeof value['suspendedAt'] !== 'string') return false
	if (!isOptionalString(value['autoResumeAfter'])) return false
	const attempts = value['resumeAttempts']
	if (attempts !== undefined && (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0)) return false
	return true
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
	const suspension = value['suspension']
	if (suspension !== null && !isSuspensionRecord(suspension)) return false
	if (!isNullableString(value['summary'])) return false
	return true
}

function isProviderHealthState(value: unknown): value is ProviderHealthState {
	return value === 'healthy' || value === 'degraded' || value === 'unavailable' || value === 'unknown'
}

function isHealthCategory(value: unknown): value is HealthCategory {
	return value === 'none' || value === 'transient' || value === 'billing' || value === 'auth' || value === 'request_rejected' || value === 'unknown'
}

function isNullableResumePolicy(value: unknown): value is ResumePolicy | null {
	return value === null || value === 'auto' || value === 'operator'
}

function isProviderHealth(value: unknown): value is ProviderHealth {
	if (!isObject(value)) return false
	if (!isProviderHealthState(value['state'])) return false
	if (!isHealthCategory(value['category'])) return false
	if (typeof value['since'] !== 'string') return false
	if (typeof value['lastCheckedAt'] !== 'string') return false
	if (!isOptionalString(value['lastSuccessAt'])) return false
	const failures = value['consecutiveFailures']
	if (typeof failures !== 'number' || !Number.isInteger(failures) || failures < 0) return false
	if (!isOptionalString(value['nextProbeAt'])) return false
	return true
}

function isProviderHealthEntity(value: unknown): value is ProviderHealthEntity {
	if (!isObject(value)) return false
	if (value['id'] !== PROVIDER_HEALTH_ENTITY_ID) return false
	if (!isProviderHealth(value['provider'])) return false
	if (!isNullableString(value['suspendedRunId'])) return false
	return isNullableResumePolicy(value['resumePolicy'])
}

export function isHealthView(value: unknown): value is HealthView {
	if (!isObject(value)) return false
	if (!isProviderHealth(value['provider'])) return false
	if (!isNullableString(value['suspendedRunId'])) return false
	return isNullableResumePolicy(value['resumePolicy'])
}

// A cheap change detector: it serializes the mutable fields (not the identity-bearing id) canonically, so a change to any field bumps the entity version while an unchanged entity is stable. canonicalSerialize escapes strings, so free-text task/summary content cannot shift field boundaries and collide two different summaries.
function runSummaryVersionOf(summary: RunSummaryEntity): string {
	return canonicalSerialize([summary.status, summary.task, summary.effort, summary.involvement, summary.startTime, summary.endTime, summary.result, summary.error, summary.continuesFrom, summary.suspension, summary.summary])
}

function providerHealthVersionOf(health: ProviderHealthEntity): string {
	return canonicalSerialize([health.provider, health.suspendedRunId, health.resumePolicy])
}

export const runListDefinitions: CollectionDefinitions<RunListCollections> = {
	runs: defineCollection(isRunSummaryEntity, runSummaryVersionOf),
	health: defineCollection(isProviderHealthEntity, providerHealthVersionOf),
}

export type RunListReplicaState = ReplicaState<RunListCollections>

export function emptyRunListReplicaState(): RunListReplicaState {
	return { runs: [], health: [] }
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
		suspension: entity.suspension,
		summary: entity.summary,
	}))
	summaries.sort((left, right) => (left.runId < right.runId ? 1 : left.runId > right.runId ? -1 : 0))
	return summaries
}

// Rebuilds the coarse health view the persistent banner reads. The health collection is a singleton, so a missing entity reads as absent rather than an error.
export function runListHealthFromReplicaState(state: RunListReplicaState): HealthView | null {
	const entity = state.health[0]
	if (entity === undefined) return null
	return { provider: entity.provider, suspendedRunId: entity.suspendedRunId, resumePolicy: entity.resumePolicy }
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
		suspension: summary.suspension,
		summary: summary.summary,
	}
}

function providerHealthEntityFor(health: HealthView): ProviderHealthEntity {
	return { id: PROVIDER_HEALTH_ENTITY_ID, provider: health.provider, suspendedRunId: health.suspendedRunId, resumePolicy: health.resumePolicy }
}

// The server replica receives the summaries in whatever order its reader produced them; this module owns the newest-first ordering, so it sorts by run id before building the entity collection. The health singleton rides the same state so its revision participates in the same envelope.
export function runListReplicaStateFromSummaries(summaries: readonly RunSummary[], health: HealthView): RunListReplicaState {
	const entities = summaries.slice().sort((left, right) => (left.runId < right.runId ? 1 : left.runId > right.runId ? -1 : 0)).map(runSummaryEntityFor)
	return { runs: entities, health: [providerHealthEntityFor(health)] }
}
