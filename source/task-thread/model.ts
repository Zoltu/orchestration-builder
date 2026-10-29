import type { RunMeta, TerminalRunStatus } from '../executor/types.js'
import { isNonNegativeInteger, isObject, TERMINAL_RUN_STATUSES } from '../executor/validation.js'
import { isTaskSummary, isTaskSummaryState } from './summary.js'
import type { TaskSummary, TaskSummaryState } from './summary.js'

export const TASK_THREAD_FORMAT_VERSION = 1

export const TASK_THREAD_MAX_LINEAGE_RUNS = 32
export const TASK_THREAD_MAX_ENTRIES = 300
export const TASK_THREAD_MAX_ENTRIES_PER_RUN = 200
export const TASK_THREAD_MAX_ENTRY_TEXT_CHARS = 4000
export const TASK_THREAD_MAX_ENTRY_CONTEXT_CHARS = 2000
export const TASK_THREAD_MAX_TEXT_CHARS = 200_000
export const TASK_THREAD_MAX_LATEST_HUMAN_CHIP_CHARS = 140
export const TASK_IDENTITY_TITLE_MAX_CHARS = 80
export const TASK_IDENTITY_DESCRIPTION_MAX_CHARS = 600

export type TaskThreadActor = 'human' | 'orchestrator' | 'system'

export type TaskThreadEntryKind =
	| 'task'
	| 'question'
	| 'answer'
	| 'resume_note'
	| 'plan_modification'
	| 'inquiry'
	| 'inquiry_answer'
	| 'result'
	| 'system'

export type TaskThreadEntrySource = 'log' | 'meta' | 'queue'

export type TaskSystemKind =
	| 'pause'
	| 'resume'
	| 'suspension'
	| 'failure'
	| 'termination'
	| 'notice'

export type TaskThreadOutcome =
	| 'answered'
	| 'waiting'
	| 'failed'
	| 'dropped'

export type TaskLineageTruncatedReason =
	| 'missing_parent'
	| 'malformed_parent'
	| 'cycle'
	| 'depth'

export interface TaskThreadEntry {
	id: string
	sequence: number
	runId: string
	timestamp: string
	kind: TaskThreadEntryKind
	actor: TaskThreadActor
	label: string
	text: string
	context: string | null
	status: TerminalRunStatus | null
	systemKind: TaskSystemKind | null
	outcome: TaskThreadOutcome | null
	questionId: string | null
	relatedEntryId: string | null
	// Set on a queue-derived question or result so the drawer can open the parked item/action that produced it.
	queueItemId: string | null
	source: TaskThreadEntrySource
	textTruncated: boolean
}

export interface TaskPrompt {
	runId: string
	text: string
	at: string
	source: 'meta' | 'log'
}

export interface TaskLineage {
	rootRunId: string
	parentRunId: string | null
	continuationCount: number
	resumeCount: number
	resumeCountComplete: boolean
	depth: number
	complete: boolean
	missingParentRunId: string | null
	truncatedReason: TaskLineageTruncatedReason | null
}

export interface TaskLatestHumanEvent {
	entryId: string
	kind: TaskThreadEntryKind
	label: string
	text: string
	timestamp: string
	runId: string
}

export interface TaskIdentity {
	runId: string
	status: RunMeta['status'] | 'unknown'
	title: string
	description: string
	currentTask: TaskPrompt | null
	originalTask: TaskPrompt | null
	lineage: TaskLineage
	latestHumanEvent: TaskLatestHumanEvent | null
}

export interface TaskThreadResponse {
	formatVersion: typeof TASK_THREAD_FORMAT_VERSION
	runId: string
	identity: TaskIdentity
	entries: TaskThreadEntry[]
	summary: TaskSummary | null
	summaryState: TaskSummaryState
	truncated: {
		entries: boolean
		text: boolean
		lineage: boolean
	}
}

export const TASK_THREAD_ENTRY_KINDS: readonly TaskThreadEntryKind[] = [
	'task',
	'question',
	'answer',
	'resume_note',
	'plan_modification',
	'inquiry',
	'inquiry_answer',
	'result',
	'system',
]

export const TASK_THREAD_ACTORS: readonly TaskThreadActor[] = ['human', 'orchestrator', 'system']

export const TASK_THREAD_ENTRY_SOURCES: readonly TaskThreadEntrySource[] = ['log', 'meta', 'queue']

export const TASK_SYSTEM_KINDS: readonly TaskSystemKind[] = [
	'pause',
	'resume',
	'suspension',
	'failure',
	'termination',
	'notice',
]

export const TASK_THREAD_OUTCOMES: readonly TaskThreadOutcome[] = [
	'answered',
	'waiting',
	'failed',
	'dropped',
]

export const TASK_LINEAGE_TRUNCATED_REASONS: readonly TaskLineageTruncatedReason[] = [
	'missing_parent',
	'malformed_parent',
	'cycle',
	'depth',
]

const RUN_STATUSES: readonly (RunMeta['status'] | 'unknown')[] = [
	'running',
	'suspended',
	'success',
	'error',
	'needs_clarification',
	'interrupted',
	'unknown',
]

function isStringValue(value: unknown): value is string {
	return typeof value === 'string'
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value !== ''
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === 'string'
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
	return typeof value === 'string' && values.some((candidate) => candidate === value)
}

export function isTaskThreadEntryKind(value: unknown): value is TaskThreadEntryKind {
	return isOneOf(TASK_THREAD_ENTRY_KINDS, value)
}

export function isTaskThreadActor(value: unknown): value is TaskThreadActor {
	return isOneOf(TASK_THREAD_ACTORS, value)
}

export function isTaskThreadEntrySource(value: unknown): value is TaskThreadEntrySource {
	return isOneOf(TASK_THREAD_ENTRY_SOURCES, value)
}

export function isTaskSystemKind(value: unknown): value is TaskSystemKind {
	return isOneOf(TASK_SYSTEM_KINDS, value)
}

export function isTaskThreadOutcome(value: unknown): value is TaskThreadOutcome {
	return isOneOf(TASK_THREAD_OUTCOMES, value)
}

export function isTaskLineageTruncatedReason(value: unknown): value is TaskLineageTruncatedReason {
	return isOneOf(TASK_LINEAGE_TRUNCATED_REASONS, value)
}

function isLegalThreadEntryCombination(kind: TaskThreadEntryKind, status: TerminalRunStatus | null, systemKind: TaskSystemKind | null, outcome: TaskThreadOutcome | null, questionId: string | null): boolean {
	if (kind === 'system') {
		if (systemKind === null || status !== null || outcome !== null || questionId !== null) return false
	} else if (systemKind !== null) {
		return false
	}
	if (kind === 'result') {
		if (status !== 'success' && status !== 'error') return false
		if (outcome !== null || questionId !== null) return false
	} else if (status !== null) {
		return false
	}
	if (kind === 'question') {
		if (outcome !== 'waiting' && outcome !== 'answered') return false
	} else if (kind === 'inquiry') {
		if (outcome !== 'waiting' && outcome !== 'answered' && outcome !== 'failed' && outcome !== 'dropped') return false
	} else if (kind === 'inquiry_answer') {
		if (outcome !== 'answered') return false
	} else if (outcome !== null) {
		return false
	}
	if (kind !== 'question' && kind !== 'answer' && questionId !== null) return false
	return true
}

export function isTaskThreadEntry(value: unknown): value is TaskThreadEntry {
	if (!isObject(value)) return false
	if (!isNonEmptyString(value.id)) return false
	if (!isNonNegativeInteger(value.sequence)) return false
	if (!isNonEmptyString(value.runId)) return false
	if (!isStringValue(value.timestamp)) return false
	if (!isTaskThreadEntryKind(value.kind)) return false
	if (!isTaskThreadActor(value.actor)) return false
	if (!isStringValue(value.label)) return false
	if (!isStringValue(value.text)) return false
	if (!isNullableString(value.context)) return false
	if (value.status !== null && !isOneOf(TERMINAL_RUN_STATUSES, value.status)) return false
	if (value.systemKind !== null && !isTaskSystemKind(value.systemKind)) return false
	if (value.outcome !== null && !isTaskThreadOutcome(value.outcome)) return false
	if (!isNullableString(value.questionId)) return false
	if (!isNullableString(value.relatedEntryId)) return false
	if (!isNullableString(value.queueItemId)) return false
	if (!isTaskThreadEntrySource(value.source)) return false
	if (value.queueItemId !== null && value.source !== 'queue') return false
	if (typeof value.textTruncated !== 'boolean') return false
	return isLegalThreadEntryCombination(value.kind, value.status, value.systemKind, value.outcome, value.questionId)
}

export function isTaskPrompt(value: unknown): value is TaskPrompt {
	if (!isObject(value)) return false
	if (!isNonEmptyString(value.runId)) return false
	if (!isStringValue(value.text)) return false
	if (!isStringValue(value.at)) return false
	if (value.source !== 'meta' && value.source !== 'log') return false
	return true
}

export function isTaskLineage(value: unknown): value is TaskLineage {
	if (!isObject(value)) return false
	if (!isNonEmptyString(value.rootRunId)) return false
	if (!isNullableString(value.parentRunId)) return false
	if (!isNonNegativeInteger(value.continuationCount)) return false
	if (!isNonNegativeInteger(value.resumeCount)) return false
	if (typeof value.resumeCountComplete !== 'boolean') return false
	if (!isNonNegativeInteger(value.depth)) return false
	if (typeof value.complete !== 'boolean') return false
	if (!isNullableString(value.missingParentRunId)) return false
	if (value.truncatedReason !== null && !isTaskLineageTruncatedReason(value.truncatedReason)) return false
	if (value.complete && (value.truncatedReason !== null || value.missingParentRunId !== null)) return false
	return true
}

export function isTaskLatestHumanEvent(value: unknown): value is TaskLatestHumanEvent {
	if (!isObject(value)) return false
	if (!isNonEmptyString(value.entryId)) return false
	if (!isTaskThreadEntryKind(value.kind)) return false
	if (!isStringValue(value.label)) return false
	if (!isStringValue(value.text)) return false
	if (!isStringValue(value.timestamp)) return false
	if (!isNonEmptyString(value.runId)) return false
	return true
}

export function isTaskIdentity(value: unknown): value is TaskIdentity {
	if (!isObject(value)) return false
	if (!isNonEmptyString(value.runId)) return false
	if (!isOneOf(RUN_STATUSES, value.status)) return false
	if (!isStringValue(value.title)) return false
	if (!isStringValue(value.description)) return false
	if (value.currentTask !== null && !isTaskPrompt(value.currentTask)) return false
	if (value.originalTask !== null && !isTaskPrompt(value.originalTask)) return false
	if (!isTaskLineage(value.lineage)) return false
	if (value.latestHumanEvent !== null && !isTaskLatestHumanEvent(value.latestHumanEvent)) return false
	return true
}

export function isTaskThreadResponse(value: unknown): value is TaskThreadResponse {
	if (!isObject(value)) return false
	if (value.formatVersion !== TASK_THREAD_FORMAT_VERSION) return false
	if (!isNonEmptyString(value.runId)) return false
	if (!isTaskIdentity(value.identity)) return false
	if (value.identity.runId !== value.runId) return false
	if (!Array.isArray(value.entries) || !value.entries.every(isTaskThreadEntry)) return false
	if (value.summary !== null) {
		if (!isTaskSummary(value.summary)) return false
		if (value.summary.runId !== value.runId) return false
	}
	if (!isTaskSummaryState(value.summaryState)) return false
	if (value.summaryState === 'ready') {
		if (value.summary === null) return false
	} else if (value.summary !== null) {
		return false
	}
	if (!isObject(value.truncated)) return false
	if (typeof value.truncated.entries !== 'boolean') return false
	if (typeof value.truncated.text !== 'boolean') return false
	if (typeof value.truncated.lineage !== 'boolean') return false
	return true
}
