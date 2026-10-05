// Pure logic for the queue panel (docs/queueing.md "UI interaction model"): grouping the polled items into the panel's four sections, the display labels, the drag-reorder position arithmetic, and the shape guard the poll filters its response through. No rendering happens here — the panel component in app.js turns these derivations into vnodes — so every decision is unit-testable in memory against plain objects.

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
	// Set when the scheduler dispatches the item's run.
	runId?: string
}

const QUEUE_ITEM_STATUSES: readonly QueueItemStatus[] = ['waiting', 'active', 'needs_input', 'done', 'error', 'cancelled']

// How many settled items (done / error / cancelled) the "recently finished" bucket keeps: the panel is a triage view of what just happened, not a second history screen — the full run browser has that job — so older settled items simply age out of the panel while staying in queue.json.
export const RECENT_QUEUE_LIMIT = 8

// The minimal shape the panel renders: any polled entry without it is dropped rather than half-rendered.
export function isQueueItemLike(value: unknown): value is QueueItemLike {
	if (!isObject(value)) return false
	if (typeof value['id'] !== 'string' || value['id'] === '') return false
	if (typeof value['task'] !== 'string' || value['task'] === '') return false
	return QUEUE_ITEM_STATUSES.some((status) => status === value['status'])
}

export interface QueueSections {
	waiting: QueueItemLike[]
	active: QueueItemLike[]
	needsInput: QueueItemLike[]
	recent: QueueItemLike[]
}

// The panel's four sections, in display order. `waiting` keeps the polled order (head first, the order items will run in); `recent` is the settled items newest-first so the latest outcome is on top. Cancelled items have no section of their own — they join the recent bucket.
export function deriveQueueSections(items: unknown[]): QueueSections {
	const sections: QueueSections = { waiting: [], active: [], needsInput: [], recent: [] }
	for (const item of items) {
		if (!isQueueItemLike(item)) continue
		if (item.status === 'waiting') sections.waiting.push(item)
		else if (item.status === 'active') sections.active.push(item)
		else if (item.status === 'needs_input') sections.needsInput.push(item)
		else sections.recent.push(item)
	}
	sections.recent.sort((a, b) => (b.settledAt ?? '').localeCompare(a.settledAt ?? ''))
	if (sections.recent.length > RECENT_QUEUE_LIMIT) sections.recent.length = RECENT_QUEUE_LIMIT
	return sections
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

// The primary label for a queue item's task: the first line, capped at a word boundary the same way history rows cap theirs — a long first line must not stretch the panel.
export function taskFirstLine(task: string): string {
	const firstLine = (task.split('\n', 1)[0] ?? '').trim()
	if (firstLine.length <= 100) return firstLine
	const capped = firstLine.slice(0, 100)
	const lastSpace = capped.lastIndexOf(' ')
	return `${lastSpace > 60 ? capped.slice(0, lastSpace) : capped}…`
}

// The item's primary line: the task's first line, except for a settled item with a result summary (what happened) or a needs_input item (what the run asked). Callers render the returned string as text or route it through the sanitized Markdown pipeline — it is agent/operator prose either way.
export function queueItemPrimaryText(item: QueueItemLike): string {
	if (item.status === 'needs_input' && typeof item.question === 'string' && item.question !== '') return item.question
	if ((item.status === 'done' || item.status === 'error') && typeof item.resultSummary === 'string' && item.resultSummary !== '') return item.resultSummary
	return item.task
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
