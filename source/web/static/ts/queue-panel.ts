// Pure logic for the queue rows the merged history screen shows (docs/queueing.md "UI interaction model"): grouping the polled items into the queued groups, the display labels, the drag-reorder position arithmetic, and the shape guard the poll filters its response through. No rendering happens here — the screen component in app.js turns these derivations into vnodes — so every decision is unit-testable in memory against plain objects.

import { isObject } from './guards.js'
import type { OperatorPauseRecord } from './interaction-model.js'
import { deriveRunPauseKind, deriveSuspendedStatusLabel, isOperatorPauseRecord, readOperatorPauseRecord } from './run-pause.js'
import type { RunPauseKind } from './run-pause.js'

// The queue item statuses (the wire contract, docs/queueing.md "The queue: storage, item model, state machine").
type QueueItemStatus = 'waiting' | 'active' | 'suspended' | 'needs_input' | 'done' | 'error' | 'cancelled'

// The subset of a queue item the panel reads (the wire shape, docs/queueing.md "The queue: storage, item model, state machine").
export interface QueueItemLike {
	// The item's UUID, the handle every queue action addresses.
	id: string
	// The operator's task text, verbatim.
	task: string
	status: QueueItemStatus
	queuedAt: string
	// Set when the item reaches done/error/cancelled.
	settledAt?: string
	// suspended: when the paused run entered its suspension.
	suspendedAt?: string
	// Optional operator pause record when a projection includes it; the run summary is the current source for the kind.
	pause?: OperatorPauseRecord | null
	// A yielded operator pause: the run stays suspended and resumable, but the waiting work ahead of it runs first.
	yielded?: true
	// active/suspended: the run checkpoint's write state, or null when the checkpoint is missing, corrupt, or unknown.
	writeCapableStarted?: boolean | null
	// needs_input: the recorded question.
	question?: string
	// needs_input: the operator-facing presentation recorded with the question (explicit context or the visible assistant fallback).
	context?: string
	assistantFallback?: string
	// Set when the operator answers.
	answer?: string
	// done/error: the terminal run's result summary.
	resultSummary?: string
	// error: what the run said went wrong, set when the item reaches error.
	error?: string
	// Set when the scheduler dispatches the item's run.
	runId?: string
	// The run this task continues, when it was submitted as a continuation.
	continuesFrom?: string
	// The paused run this waiting item will re-enter once its answer is processed.
	resumesRunId?: string
}

const QUEUE_ITEM_STATUSES: readonly QueueItemStatus[] = ['waiting', 'active', 'suspended', 'needs_input', 'done', 'error', 'cancelled']

function isOptionalNonEmptyString(value: unknown): boolean {
	return value === undefined || (typeof value === 'string' && value !== '')
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === 'string'
}

function isOptionalWriteState(value: unknown): boolean {
	return value === undefined || value === null || typeof value === 'boolean'
}

// The minimal shape the panel renders: any polled entry without it is dropped rather than half-rendered.
export function isQueueItemLike(value: unknown): value is QueueItemLike {
	if (!isObject(value)) return false
	if (typeof value['id'] !== 'string' || value['id'] === '') return false
	if (typeof value['task'] !== 'string' || value['task'] === '') return false
	if (!isOptionalNonEmptyString(value['runId'])) return false
	if (!isOptionalNonEmptyString(value['continuesFrom'])) return false
	if (!isOptionalNonEmptyString(value['resumesRunId'])) return false
	if (!isOptionalString(value['question'])) return false
	if (!isOptionalString(value['context'])) return false
	if (!isOptionalString(value['assistantFallback'])) return false
	const status = value['status']
	if (!QUEUE_ITEM_STATUSES.some((known) => known === status)) return false
	const yielded = value['yielded']
	if (yielded !== undefined) {
		if (yielded !== true) return false
		// The backend carries the yielded marker only on a suspended operator pause or its transient active dispatch marker.
		if (status !== 'suspended' && status !== 'active') return false
	}
	if (!isOptionalWriteState(value['writeCapableStarted'])) return false
	const pause = value['pause']
	if (pause !== undefined && pause !== null && !isOperatorPauseRecord(pause)) return false
	return true
}

export interface QueuedItems {
	// Suspended rows that take priority over the run order: a provider suspension, or an operator pause whose run has written or whose write state is unknown.
	suspended: QueueItemLike[]
	// The drag order: waiting items plus operator-paused pre-write suspended items, in file order.
	runOrder: QueueItemLike[]
	active: QueueItemLike[]
	needsInput: QueueItemLike[]
}

// A suspended row is an operator pause when its own projected pause record is present. Provider suspensions carry a suspension record instead.
export function isOperatorPausedItem(item: QueueItemLike): boolean {
	return item.status === 'suspended' && readOperatorPauseRecord(item) !== null
}

// Only an operator pause before any write can be reordered: once a write-capable role has started, moving the run would move work that already touched the workspace.
export function isPausedPreWrite(item: QueueItemLike): boolean {
	return isOperatorPausedItem(item) && item.writeCapableStarted === false
}

export function isPausedPostWrite(item: QueueItemLike): boolean {
	return isOperatorPausedItem(item) && item.writeCapableStarted === true
}

// The write-state pill for a live item. Waiting rows have no checkpoint yet, so they carry no pre/post pill; a missing, null, or unrecognized state is explicitly unknown rather than guessed.
export function writeStateLabel(item: QueueItemLike): 'Pre-write' | 'Post-write' | 'Write state unknown' | null {
	if (item.status !== 'active' && item.status !== 'suspended') return null
	if (item.writeCapableStarted === false) return 'Pre-write'
	if (item.writeCapableStarted === true) return 'Post-write'
	return 'Write state unknown'
}

// The run order the drag follows: waiting items plus operator-paused pre-write suspended items (including yielded ones), in file order. Non-orderable rows stay at their file positions around them.
export function deriveRunOrderItems(items: QueueItemLike[]): QueueItemLike[] {
	return items.filter((item) => item.status === 'waiting' || isPausedPreWrite(item))
}

// The run-order index a drop should PATCH: the target row's index among the run-order items excluding the dragged one. Dropping onto itself, or onto a row that is not orderable, is no move at all, read as null.
export function deriveRunOrderPosition(items: QueueItemLike[], draggedId: string, targetId: string): number | null {
	if (draggedId === targetId) return null
	const runOrder = deriveRunOrderItems(items)
	if (!runOrder.some((item) => item.id === draggedId)) return null
	const others = runOrder.filter((item) => item.id !== draggedId)
	const targetIndex = others.findIndex((item) => item.id === targetId)
	if (targetIndex === -1) return null
	return Math.max(0, Math.min(targetIndex, others.length))
}

// The optimistic client-side reorder, mirroring the executor's reorderRunOrderItem: the orderable items re-slot into the clamped position while every non-orderable item keeps its file position.
export function reorderRunOrderItems(items: QueueItemLike[], draggedId: string, position: number): QueueItemLike[] {
	const dragged = items.find((item) => item.id === draggedId)
	if (dragged === undefined) return items
	if (dragged.status !== 'waiting' && !isPausedPreWrite(dragged)) return items
	const others = items.filter((item) => (item.status === 'waiting' || isPausedPreWrite(item)) && item.id !== draggedId)
	const clamped = Math.max(0, Math.min(position, others.length))
	const moved = [...others.slice(0, clamped), dragged, ...others.slice(clamped)]
	const result: QueueItemLike[] = []
	let movedIndex = 0
	for (const item of items) {
		if (item.status !== 'waiting' && !isPausedPreWrite(item)) {
			result.push(item)
			continue
		}
		const positioned = moved[movedIndex]
		if (positioned === undefined) throw new Error(`reorderRunOrderItems: ran out of moved items at index ${movedIndex}`)
		result.push(positioned)
		movedIndex += 1
	}
	return result
}

// The breadcrumb above an orderable row: first in line, or how many runnable tasks it follows. A non-orderable row has no run-order position, read as null.
export function runOrderHint(item: QueueItemLike, items: QueueItemLike[]): string | null {
	const runOrder = deriveRunOrderItems(items)
	const index = runOrder.findIndex((candidate) => candidate.id === item.id)
	if (index === -1) return null
	if (index === 0) return 'First in run order'
	return index === 1 ? '1 runnable task ahead' : `${index} runnable tasks ahead`
}

// The queued rows the merged history screen shows above the run list, in the groups the history merge renders: priority suspended rows first, then the run order (waiting plus pre-write operator pauses), then the one active item, then the items parked on a question. Settled items (done/error/cancelled) get no row here — their runs carry the outcome in the history list below.
export function deriveQueuedItems(items: unknown[]): QueuedItems {
	const queued: QueuedItems = { suspended: [], runOrder: [], active: [], needsInput: [] }
	for (const item of items) {
		if (!isQueueItemLike(item)) continue
		if (item.status === 'suspended') {
			if (isPausedPreWrite(item)) queued.runOrder.push(item)
			else queued.suspended.push(item)
			continue
		}
		if (item.status === 'waiting') {
			queued.runOrder.push(item)
			continue
		}
		if (item.status === 'active') queued.active.push(item)
		else if (item.status === 'needs_input') queued.needsInput.push(item)
	}
	return queued
}

// The nav button's live count: the tasks that are not running yet and not finished — the backlog the operator can still act on. A suspended pause is backlog too: it blocks dispatch until resumed or terminated.
export function backlogCount(items: QueueItemLike[]): number {
	return items.filter((item) => item.status === 'waiting' || item.status === 'needs_input' || item.status === 'suspended').length
}

const QUEUE_STATUS_LABELS: Record<string, string> = {
	waiting: 'waiting',
	active: 'running',
	needs_input: 'needs your answer',
	done: 'done',
	error: 'error',
	cancelled: 'cancelled',
}

export function queueStatusLabel(status: string, pauseKind: RunPauseKind = 'none', needsAttention = false): string {
	const suspendedLabel = deriveSuspendedStatusLabel(status, pauseKind, needsAttention)
	if (suspendedLabel !== null) return suspendedLabel
	return QUEUE_STATUS_LABELS[status] ?? status
}

// The row's status text: a yielded suspended pause reads as queued before writing rather than a priority operator pause. The yielded marker survives reactivation, so it must not relabel the active run that is now executing the resume.
export function queueStatusText(item: QueueItemLike, pauseKind: RunPauseKind = 'none', needsAttention = false): string {
	if (item.status === 'suspended' && item.yielded === true) return 'queued before writing'
	return queueStatusLabel(item.status, pauseKind, needsAttention)
}

// A suspended row takes its kind from the item's own optional pause record first, then the matching run summary, so a projection that carries either identifies an operator pause.
export function queueRowPauseKind(item: QueueItemLike, summary: unknown): RunPauseKind {
	if (item.status !== 'suspended') return 'none'
	if (readOperatorPauseRecord(item) !== null) return 'operator'
	const summaryKind = deriveRunPauseKind(summary)
	if (summaryKind !== 'none') return summaryKind
	return deriveRunPauseKind(item)
}

// The truncation rule the task preview uses: an already-trimmed line shortened to `limit` characters at the last space past `floor` (or at `limit` when no such space exists), with a trailing ellipsis when shortened. The caller picks the line and the limits; only the cap-and-ellipsis rule lives here.
function capLineAtWordBoundary(line: string, limit: number, floor: number): string {
	if (line.length <= limit) return line
	const capped = line.slice(0, limit)
	const lastSpace = capped.lastIndexOf(' ')
	return `${lastSpace > floor ? capped.slice(0, lastSpace) : capped}…`
}

// The primary label for a queue item's task: the first line, capped at a word boundary the same way history rows cap theirs — a long first line must not stretch the panel.
export function taskFirstLine(task: string): string {
	return capLineAtWordBoundary((task.split('\n', 1)[0] ?? '').trim(), 100, 60)
}

// The item's primary line: the task's first line, except for a settled done/error item whose result summary says what happened. A needs_input row names the task, never the question — the question lives in the expanded details and the answer modal. The merged history screen renders the returned string as a plain text span, so it is never Markdown.
export function queueItemPrimaryText(item: QueueItemLike): string {
	if ((item.status === 'done' || item.status === 'error') && typeof item.resultSummary === 'string' && item.resultSummary !== '') return item.resultSummary
	return taskFirstLine(item.task)
}

// Whether a parked item answers for the selected run: a parked item names its paused run through runId.
export function matchesParkedRun(item: QueueItemLike, runId: string): boolean {
	if (item.status !== 'needs_input') return false
	if (typeof item.runId !== 'string' || item.runId === '') return false
	return item.runId === runId
}
