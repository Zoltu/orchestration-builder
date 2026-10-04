import { isEffortLevel, isLogLevel, isObject, isString } from './validation.js'
import { isRunIdShape } from './run-id.js'
import { questionFromParkSummary } from './park-state.js'
import type { EffortLevel, LogLevel, RunMeta } from './types.js'

// Pure queue logic and validation for the durable task queue (docs/queueing.md "The queue: storage, item model, state machine"). Every transformation is a whole-queue value: it takes a queue and returns a new one, so the scheduler's read-modify-write cycles stay free of hidden mutation. Persistence leaves live in persistence.ts; the orchestration that sequences these transformations lives in scheduler.ts.

export type QueueItemStatus = 'waiting' | 'active' | 'needs_input' | 'done' | 'error' | 'cancelled'

export interface QueueItem {
	// UUID (crypto.randomUUID), the item handle in the queue API.
	id: string
	// The operator's task text, verbatim.
	task: string
	// Optional per-item effort override for the item's run.
	effort?: EffortLevel
	// Optional logging-level override for the item's run.
	logLevel?: LogLevel
	// The run this item's dispatch continues: a parked run awaiting its answer, an errored run being retried, or a user-initiated Continue.
	continuesFrom?: string
	status: QueueItemStatus
	// Set when the scheduler dispatches the item's run.
	runId?: string
	queuedAt: string
	// Set when the item reaches done/error/cancelled.
	settledAt?: string
	// needs_input: the recorded question.
	question?: string
	// Set when the operator answers.
	answer?: string
	// done/error: the terminal meta's result.summary.
	resultSummary?: string
	// error: what the run said went wrong.
	error?: string
}

export interface TaskQueue {
	// Head first: the scheduler dispatches the first waiting item.
	items: QueueItem[]
}

const queueItemStatuses: readonly QueueItemStatus[] = ['waiting', 'active', 'needs_input', 'done', 'error', 'cancelled']

export function isQueueItem(value: unknown): value is QueueItem {
	if (!isObject(value)) return false
	if (!isString(value.id) || value.id === '') return false
	if (!isString(value.task) || value.task === '') return false
	if (value.effort !== undefined && !isEffortLevel(value.effort)) return false
	if (value.logLevel !== undefined && !isLogLevel(value.logLevel)) return false
	if (value.continuesFrom !== undefined && !isRunIdShape(value.continuesFrom)) return false
	if (!isString(value.status) || !queueItemStatuses.some((status) => status === value.status)) return false
	if (value.runId !== undefined && !isRunIdShape(value.runId)) return false
	if (!isString(value.queuedAt)) return false
	if (value.settledAt !== undefined && !isString(value.settledAt)) return false
	if (value.question !== undefined && !isString(value.question)) return false
	if (value.answer !== undefined && !isString(value.answer)) return false
	if (value.resultSummary !== undefined && !isString(value.resultSummary)) return false
	if (value.error !== undefined && !isString(value.error)) return false
	return true
}

export function isTaskQueue(value: unknown): value is TaskQueue {
	if (!isObject(value)) return false
	if (!Array.isArray(value.items) || !value.items.every(isQueueItem)) return false
	return true
}

export type NewQueueItemResult = { ok: true; item: QueueItem } | { ok: false; error: string }

// Validates an operator-supplied item body and normalizes it into a fresh waiting item. The id and timestamp are supplied by the caller (the API layer mints them), keeping this pure and deterministic.
export function normalizeNewItem(input: unknown, handles: { id: string; queuedAt: string }): NewQueueItemResult {
	if (!isObject(input)) return { ok: false, error: 'expected an object' }
	const task = input['task']
	if (typeof task !== 'string' || task === '') return { ok: false, error: 'task must be a non-empty string' }
	const effort = input['effort']
	if (effort !== undefined && !isEffortLevel(effort)) return { ok: false, error: 'effort must be one of: quick, standard, thorough' }
	const logLevel = input['logLevel']
	if (logLevel !== undefined && !isLogLevel(logLevel)) return { ok: false, error: 'logLevel must be "full" or "standard"' }
	const continuesFrom = input['continuesFrom']
	if (continuesFrom !== undefined && !isRunIdShape(continuesFrom)) return { ok: false, error: 'continuesFrom must be a run id' }
	const item: QueueItem = {
		id: handles.id,
		task,
		...(effort !== undefined ? { effort } : {}),
		...(logLevel !== undefined ? { logLevel } : {}),
		...(continuesFrom !== undefined ? { continuesFrom } : {}),
		status: 'waiting',
		queuedAt: handles.queuedAt,
	}
	return { ok: true, item }
}

// Why a by-id transformation refused: the id matched nothing (the API maps this to 404), or the item's status forbids the operation (mapped to 409).
export type QueueMutationRejection = { ok: false; reason: 'not_found' } | { ok: false; reason: 'forbidden_status' }
export type QueueMutation = { ok: true; queue: TaskQueue; item: QueueItem } | QueueMutationRejection

function findById(queue: TaskQueue, id: string): QueueItem | undefined {
	return queue.items.find((item) => item.id === id)
}

// The operator-facing fields every lifecycle rebuild carries forward: identity, the per-run overrides, the queued-at stamp, and the recorded question and answer (a re-dispatched item's record of why it re-ran). Outcome fields (runId, resultSummary, error, settledAt) are never carried — they belong to the lifecycle stage that produced them.
function carriedFields(item: QueueItem): Pick<QueueItem, 'id' | 'task' | 'queuedAt'> & { effort?: EffortLevel; logLevel?: LogLevel; question?: string; answer?: string } {
	return {
		id: item.id,
		task: item.task,
		...(item.effort !== undefined ? { effort: item.effort } : {}),
		...(item.logLevel !== undefined ? { logLevel: item.logLevel } : {}),
		...(item.question !== undefined ? { question: item.question } : {}),
		...(item.answer !== undefined ? { answer: item.answer } : {}),
		queuedAt: item.queuedAt,
	}
}

// Returns the item rebuilt as waiting for re-dispatch, carrying its lineage: an explicit continuesFrom re-points it at the run that just settled (an interrupted run, or the run a requeue retries), while its absence keeps the item's existing lineage.
export function releaseToWaiting(item: QueueItem, rePointedContinuesFrom?: string): QueueItem {
	const continuesFrom = rePointedContinuesFrom ?? item.continuesFrom
	return {
		...carriedFields(item),
		...(continuesFrom !== undefined ? { continuesFrom } : {}),
		status: 'waiting',
	}
}

// The dispatching marker: the item written active with no runId before submitRun is called. It closes the crash window between a successful submit and the queue's runId write — a crash there leaves an active-without-id item the boot tick repairs by bind-or-release.
export function dispatchingItem(item: QueueItem): QueueItem {
	return {
		...carriedFields(item),
		...(item.continuesFrom !== undefined ? { continuesFrom: item.continuesFrom } : {}),
		status: 'active',
	}
}

export function withReplacedItem(queue: TaskQueue, item: QueueItem): TaskQueue {
	return { items: queue.items.map((existing) => (existing.id === item.id ? item : existing)) }
}

export function enqueueAtTail(queue: TaskQueue, item: QueueItem): TaskQueue {
	return { items: [...queue.items, item] }
}

export function enqueueAtHead(queue: TaskQueue, item: QueueItem): TaskQueue {
	return { items: [item, ...queue.items] }
}

export function reorderWaitingItem(queue: TaskQueue, id: string, position: number): QueueMutation {
	const target = findById(queue, id)
	if (target === undefined) return { ok: false, reason: 'not_found' }
	if (target.status !== 'waiting') return { ok: false, reason: 'forbidden_status' }
	// The position indexes the waiting sublist; out-of-range values clamp into it. Non-waiting items keep their file positions.
	const others = queue.items.filter((item) => item.status === 'waiting' && item.id !== id)
	const clamped = Math.max(0, Math.min(position, others.length))
	const movedWaiting = [...others.slice(0, clamped), target, ...others.slice(clamped)]
	const pendingWaiting = movedWaiting.slice()
	const items = queue.items.map((item) => {
		if (item.status !== 'waiting') return item
		const next = pendingWaiting.shift()
		// Unreachable by construction: movedWaiting holds exactly the waiting items the file order walks.
		if (next === undefined) throw new Error(`reorderWaitingItem: waiting-list bookkeeping lost item ${item.id}`)
		return next
	})
	return { ok: true, queue: { items }, item: target }
}

// The DELETE endpoint's behavior: a waiting item is never dropped from the file — it is marked cancelled (with settledAt) so the UI can show recent outcomes.
export function cancelWaitingItem(queue: TaskQueue, id: string, settledAt: string): QueueMutation {
	const target = findById(queue, id)
	if (target === undefined) return { ok: false, reason: 'not_found' }
	if (target.status !== 'waiting') return { ok: false, reason: 'forbidden_status' }
	const cancelled: QueueItem = {
		...carriedFields(target),
		...(target.continuesFrom !== undefined ? { continuesFrom: target.continuesFrom } : {}),
		status: 'cancelled',
		settledAt,
	}
	return { ok: true, queue: withReplacedItem(queue, cancelled), item: cancelled }
}

export function recordAnswer(queue: TaskQueue, id: string, answer: string): QueueMutation {
	const target = findById(queue, id)
	if (target === undefined) return { ok: false, reason: 'not_found' }
	if (target.status !== 'needs_input') return { ok: false, reason: 'forbidden_status' }
	const answered: QueueItem = {
		...carriedFields(target),
		...(target.continuesFrom !== undefined ? { continuesFrom: target.continuesFrom } : {}),
		...(target.runId !== undefined ? { runId: target.runId } : {}),
		answer,
		status: 'waiting',
	}
	// The answered item fronts the file so it is the next waiting item the scheduler dispatches — the queue-native resume.
	return { ok: true, queue: { items: [answered, ...queue.items.filter((item) => item.id !== id)] }, item: answered }
}

// The re-queue action behind the UI's error triage: an error item returns to waiting at the tail with its lineage re-pointed at the errored run, so the retry's continuation briefing carries the failure's outcome summary.
export function requeueErrorItem(queue: TaskQueue, id: string): QueueMutation {
	const target = findById(queue, id)
	if (target === undefined) return { ok: false, reason: 'not_found' }
	if (target.status !== 'error') return { ok: false, reason: 'forbidden_status' }
	const continuesFrom = target.runId ?? target.continuesFrom
	const requeued: QueueItem = {
		...carriedFields(target),
		...(continuesFrom !== undefined ? { continuesFrom } : {}),
		status: 'waiting',
	}
	// The errored entry is replaced by the requeued one at the tail, not duplicated.
	return { ok: true, queue: enqueueAtTail({ items: queue.items.filter((existing) => existing.id !== id) }, requeued), item: requeued }
}

export interface TerminalItemState {
	status: 'done' | 'error' | 'needs_input'
	resultSummary?: string
	error?: string
	question?: string
}

// Maps a terminal run meta to the item state the settlement applies, exactly the live mapping (docs/queueing.md state machine): success → done, error → error, needs_clarification → needs_input. A meta that maps to no item state ('running' can never settle, and an 'interrupted' run means the service died — its item re-dispatches rather than settles) returns undefined.
export function mapSettledItemState(meta: RunMeta): TerminalItemState | undefined {
	if (meta.status === 'success') {
		return { status: 'done', ...(meta.result?.summary !== undefined ? { resultSummary: meta.result.summary } : {}) }
	}
	if (meta.status === 'error') {
		const errorMessage = meta.result?.error?.message ?? meta.error?.message
		return {
			status: 'error',
			...(meta.result?.summary !== undefined ? { resultSummary: meta.result.summary } : {}),
			...(errorMessage !== undefined ? { error: errorMessage } : {}),
		}
	}
	if (meta.status === 'needs_clarification') {
		const summary = meta.result?.summary
		return { status: 'needs_input', ...(summary !== undefined ? { question: questionFromParkSummary(summary) } : {}) }
	}
	return undefined
}

export type SettlementOutcome =
	| { kind: 'settled'; queue: TaskQueue; item: QueueItem }
	| { kind: 'unknown_run' }
	| { kind: 'not_settleable' }

// Applies the settlement mapping to the active item a settled run belongs to (matched by runId). needs_input keeps the item unsettled (it waits for an answer) and re-points its lineage at the just-settled run, so the answered resume continues the most recent attempt.
export function settleActiveItem(queue: TaskQueue, runId: string, meta: RunMeta, settledAt: string): SettlementOutcome {
	const target = queue.items.find((item) => item.status === 'active' && item.runId === runId)
	if (target === undefined) return { kind: 'unknown_run' }
	const mapped = mapSettledItemState(meta)
	if (mapped === undefined) return { kind: 'not_settleable' }
	const item = settledItem(target, mapped, settledAt, runId)
	return { kind: 'settled', queue: withReplacedItem(queue, item), item }
}

function settledItem(target: QueueItem, mapped: TerminalItemState, settledAt: string, runId: string): QueueItem {
	const base = {
		id: target.id,
		task: target.task,
		...(target.effort !== undefined ? { effort: target.effort } : {}),
		...(target.logLevel !== undefined ? { logLevel: target.logLevel } : {}),
		queuedAt: target.queuedAt,
	}
	if (mapped.status === 'needs_input') {
		// The lineage re-points at the just-settled run, so an answered resume continues the most recent attempt; a re-park replaces the question and leaves no stale answer.
		return {
			...base,
			continuesFrom: runId,
			status: 'needs_input',
			runId,
			...(mapped.question !== undefined ? { question: mapped.question } : {}),
		}
	}
	return {
		...base,
		...(target.continuesFrom !== undefined ? { continuesFrom: target.continuesFrom } : {}),
		status: mapped.status,
		runId,
		settledAt,
		...(mapped.resultSummary !== undefined ? { resultSummary: mapped.resultSummary } : {}),
		...(mapped.error !== undefined ? { error: mapped.error } : {}),
	}
}

export type ActiveItemRepair =
	| { kind: 'settled'; item: QueueItem }
	| { kind: 'released'; item: QueueItem }
	| { kind: 'bound'; item: QueueItem }
	| { kind: 'untouched'; item: QueueItem }

// Boot repair for stale active items (docs/queueing.md state machine, the boot rows) — the terminal meta and the queue item are separate files with no cross-file atomicity, so a crash between the two writes leaves an active item needing repair:
// - with a runId whose meta is terminal: settle from that meta, exactly the live mapping (the crash landed between the meta write and the settlement write).
// - with a runId whose meta reads 'interrupted': the service died, not the task — release to waiting with the lineage re-pointed at the interrupted run for re-dispatch.
// - with a runId whose meta still reads 'running': the boot-resumed run's own item — untouched; its own settlement maps it.
// - with a runId whose meta is unreadable (a phantom run directory): release to waiting rather than leave the item stuck active forever.
// - with no runId (an orphaned dispatching marker): the run may or may not have started. The scheduler passes the boot-resumed run's meta (the unique 'running' meta) or null; the item binds to it when the task matches — identical task texts are interchangeable, since only the head is ever mid-dispatch — and returns to waiting otherwise.
export function repairActiveItem(item: QueueItem, meta: RunMeta | null, settledAt: string): ActiveItemRepair {
	const runId = item.runId
	if (runId !== undefined) {
		if (meta === null) return { kind: 'released', item: releaseToWaiting(item) }
		if (meta.status === 'running') return { kind: 'untouched', item }
		if (meta.status === 'interrupted') return { kind: 'released', item: releaseToWaiting(item, runId) }
		const mapped = mapSettledItemState(meta)
		if (mapped === undefined) return { kind: 'untouched', item }
		// The settled time is the run's own endTime — when it actually finished — not the boot that noticed.
		return { kind: 'settled', item: settledItem(item, mapped, meta.endTime ?? settledAt, runId) }
	}
	if (meta !== null && meta.status === 'running' && meta.task === item.task) {
		return { kind: 'bound', item: { ...carriedFields(item), ...(item.continuesFrom !== undefined ? { continuesFrom: item.continuesFrom } : {}), status: 'active', runId: meta.runId } }
	}
	return { kind: 'released', item: releaseToWaiting(item) }
}

// The distilled run-list entry the briefing assembles from: the scheduler's readRunListSummary leaf returns it (the web run-list summary is structurally compatible, so serve.ts passes its reader directly).
export interface RunListEntry {
	runId: string
	task: string | null
	status: RunMeta['status'] | 'unknown'
	endTime: string | null
	// The LLM-generated one-line summary; null when the summarizer has produced none (the scheduler composes the task-text fallback).
	summary: string | null
}

// Binds the per-run briefing lines so a long history cannot bloat the entry context; the most recent runs are kept.
export const MAX_BRIEFING_RUN_LINES = 20

export interface BriefingInput {
	queuedAt: string
	items: QueueItem[]
	runs: RunListEntry[]
	// Present when the item is resuming from needs_input: the recorded question and the operator's answer.
	question?: string
	answer?: string
}

// Assembles the interim briefing lines (docs/queueing.md "The interim briefing"): when the item was queued; one line per run completed since then, each carrying the full run id so the stale-task fast path can cite a real one; the queue items cancelled meanwhile; the question and answer on a needs_input resume; and the standing instruction that the workspace may have changed. The first line's bracket marks the block as platform-provided context.
export function assembleBriefingLines(input: BriefingInput): string[] {
	const lines = ['[Queued-task briefing — what happened while this task waited in the queue.]', `Queued at ${input.queuedAt}.`]
	const completed = input.runs
		.filter((run) => run.status !== 'running' && run.status !== 'unknown' && run.endTime !== null && run.endTime > input.queuedAt)
		.slice()
		.sort((a, b) => (a.endTime ?? '').localeCompare(b.endTime ?? ''))
	const summarized = completed.slice(-MAX_BRIEFING_RUN_LINES)
	if (summarized.length > 0) {
		lines.push('Runs completed meanwhile:')
		for (const run of summarized) {
			lines.push(`- ${run.runId}: ${run.summary ?? run.task ?? '(no summary)'}`)
		}
	}
	const cancelled = input.items.filter((item) => item.status === 'cancelled' && item.settledAt !== undefined && item.settledAt > input.queuedAt)
	if (cancelled.length > 0) {
		lines.push('Queue items cancelled meanwhile:')
		for (const item of cancelled) {
			lines.push(`- ${item.task}`)
		}
	}
	if (input.question !== undefined) lines.push(`Resuming from your question: ${input.question}`)
	if (input.answer !== undefined) lines.push(`The operator answered: ${input.answer}`)
	lines.push('The workspace may have changed since this task was queued; re-verify the premise before relying on earlier findings.')
	return lines
}
