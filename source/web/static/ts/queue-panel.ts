// Pure logic for the queue rows the merged history screen shows (docs/queueing.md "UI interaction model"): grouping the polled items into the queued groups, the display labels, the drag-reorder position arithmetic, and the shape guard the poll filters its response through. No rendering happens here — the screen component in app.js turns these derivations into vnodes — so every decision is unit-testable in memory against plain objects.

import { isObject } from './guards.js'

// The queue item statuses (the wire contract, docs/queueing.md "The queue: storage, item model, state machine").
type QueueItemStatus = 'waiting' | 'active' | 'needs_input' | 'done' | 'error' | 'cancelled'

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
	// needs_input: the recorded question.
	question?: string
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

const QUEUE_ITEM_STATUSES: readonly QueueItemStatus[] = ['waiting', 'active', 'needs_input', 'done', 'error', 'cancelled']

function isOptionalNonEmptyString(value: unknown): boolean {
	return value === undefined || (typeof value === 'string' && value !== '')
}

// The minimal shape the panel renders: any polled entry without it is dropped rather than half-rendered.
export function isQueueItemLike(value: unknown): value is QueueItemLike {
	if (!isObject(value)) return false
	if (typeof value['id'] !== 'string' || value['id'] === '') return false
	if (typeof value['task'] !== 'string' || value['task'] === '') return false
	if (!isOptionalNonEmptyString(value['runId'])) return false
	if (!isOptionalNonEmptyString(value['continuesFrom'])) return false
	if (!isOptionalNonEmptyString(value['resumesRunId'])) return false
	return QUEUE_ITEM_STATUSES.some((status) => status === value['status'])
}

export interface QueuedItems {
	waiting: QueueItemLike[]
	active: QueueItemLike[]
	needsInput: QueueItemLike[]
}

// The queued rows the merged history screen shows above the run list, in display order: the waiting items head-first (the order they will run in), then the one active item, then the items parked on a question. Settled items (done/error/cancelled) get no row here — their runs carry the outcome in the history list below.
export function deriveQueuedItems(items: unknown[]): QueuedItems {
	const queued: QueuedItems = { waiting: [], active: [], needsInput: [] }
	for (const item of items) {
		if (!isQueueItemLike(item)) continue
		if (item.status === 'waiting') queued.waiting.push(item)
		else if (item.status === 'active') queued.active.push(item)
		else if (item.status === 'needs_input') queued.needsInput.push(item)
	}
	return queued
}

// The nav button's live count: the tasks that are not running yet and not finished — the backlog the operator can still act on.
export function backlogCount(items: QueueItemLike[]): number {
	return items.filter((item) => item.status === 'waiting' || item.status === 'needs_input').length
}

const QUEUE_STATUS_LABELS: Record<string, string> = {
	waiting: 'waiting',
	active: 'running',
	needs_input: 'needs your answer',
	done: 'done',
	error: 'error',
	cancelled: 'cancelled',
}

export function queueStatusLabel(status: string): string {
	return QUEUE_STATUS_LABELS[status] ?? status
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

// Whether a parked item answers for the selected run: a modern item names it through runId, while a legacy item with no runId records the paused run in continuesFrom.
export function matchesParkedRun(item: QueueItemLike, runId: string): boolean {
	if (item.status !== 'needs_input') return false
	if (typeof item.runId === 'string' && item.runId !== '') return item.runId === runId
	return item.continuesFrom === runId
}

// The waiting-list index a drop should PATCH: the target row's index among the waiting items, excluding the dragged one (the server clamps out-of-range values). Dropping onto the dragged item itself — or onto a row that is not waiting — is no move at all, read as null.
export function deriveReorderPosition(items: QueueItemLike[], draggedId: string, targetId: string): number | null {
	if (draggedId === targetId) return null
	const waitingIds = items.filter((item) => item.status === 'waiting' && item.id !== draggedId).map((item) => item.id)
	const targetIndex = waitingIds.indexOf(targetId)
	return targetIndex === -1 ? null : targetIndex
}

// The optimistic client-side reorder, mirroring the executor's reorderWaitingItem: the waiting items re-slug into the clamped position while every other item keeps its file position.
export function reorderWaitingItems(items: QueueItemLike[], draggedId: string, position: number): QueueItemLike[] {
	const dragged = items.find((item) => item.id === draggedId)
	if (dragged === undefined || dragged.status !== 'waiting') return items
	const others = items.filter((item) => item.status === 'waiting' && item.id !== draggedId)
	const clamped = Math.max(0, Math.min(position, others.length))
	const moved = [...others.slice(0, clamped), dragged, ...others.slice(clamped)]
	const result: QueueItemLike[] = []
	let movedIndex = 0
	for (const item of items) {
		if (item.status !== 'waiting') {
			result.push(item)
			continue
		}
		const positioned = moved[movedIndex]
		if (positioned === undefined) throw new Error(`reorderWaitingItems: ran out of moved items at index ${movedIndex}`)
		result.push(positioned)
		movedIndex += 1
	}
	return result
}
