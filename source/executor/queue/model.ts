import { isEffortLevel, isInvolvementLevel, isLogLevel, isObject, isString } from '../validation.js'
import { isRunIdShape } from '../run-id.js'
import { questionFromParkSummary, type PauseState } from '../park-state.js'
import { isSupersededSuspendedRun } from '../suspension.js'
import { QUEUE_FORMAT_VERSION } from '../orchestration-version.js'
import type { EffortLevel, InvolvementLevel, LogLevel, OperatorPauseRecord, RunMeta } from '../types.js'

// Pure queue logic and validation for the durable task queue (docs/queueing.md "The queue: storage, item model, state machine"). Every transformation is a whole-queue value: it takes a queue and returns a new one, so the module's read-modify-write cycles stay free of hidden mutation. Serialization and orchestration live in persistence.ts and task-queue.ts; only the read-only DTOs cross the module boundary.

type QueueItemStatus = 'waiting' | 'active' | 'suspended' | 'needs_input' | 'done' | 'error' | 'cancelled'

export interface QueueItemView {
	// UUID (crypto.randomUUID), the item handle in the queue API.
	readonly id: string
	// The operator's task text, verbatim.
	readonly task: string
	// Optional per-item effort override for the item's run.
	readonly effort?: EffortLevel
	// Optional per-item human-involvement override for the item's run.
	readonly involvement?: InvolvementLevel
	// Optional logging-level override for the item's run.
	readonly logLevel?: LogLevel
	// The run this item's dispatch continues: a parked run awaiting its answer, an errored run being retried, or a user-initiated Continue.
	readonly continuesFrom?: string
	readonly status: QueueItemStatus
	// Set when the scheduler dispatches the item's run.
	readonly runId?: string
	// Set while the item's run is suspended: when the pause began.
	readonly suspendedAt?: string
	// Projected from the run meta at the HTTP boundary for a suspended item, so the row can name the pause kind before the run summary arrives.
	readonly pause?: OperatorPauseRecord
	// The run a waiting answered item re-enters: a parked run or a direct clarification finish. The tool-call id, when present, stays internal.
	readonly resumesRunId?: string
	readonly queuedAt: string
	// Set when the item reaches done/error/cancelled.
	readonly settledAt?: string
	// needs_input: the recorded question.
	readonly question?: string
	// Set when the operator answers.
	readonly answer?: string
	// done/error: the terminal meta's result.summary.
	readonly resultSummary?: string
	// error: what the run said went wrong.
	readonly error?: string
}

export interface QueueView {
	// Head first: the scheduler dispatches the first waiting item.
	readonly items: readonly QueueItemView[]
}

// The persisted shape stays private to the module: callers only ever see QueueItemView copies, so a mutation of a returned object cannot reach stored state.
export interface QueueItem {
	id: string
	task: string
	effort?: EffortLevel
	involvement?: InvolvementLevel
	logLevel?: LogLevel
	continuesFrom?: string
	status: QueueItemStatus
	runId?: string
	queuedAt: string
	suspendedAt?: string
	settledAt?: string
	question?: string
	answer?: string
	// The durable identity of the recorded answer. It rides the item through dispatch and is compared with the checkpoint's deliveredAnswerId; it is never projected into QueueItemView.
	answerId?: string
	resultSummary?: string
	error?: string
	// The same-run answer resume's target: the paused run. resumeToolCallId is present only for a parked ask, whose tool result the answer replaces; a clarification resume carries just the run id. The tool-call id is never projected into QueueItemView; the run id is projected as resumesRunId.
	resumeRunId?: string
	resumeToolCallId?: string
}

export interface TaskQueue {
	version: typeof QUEUE_FORMAT_VERSION
	items: QueueItem[]
}

const queueItemStatuses: readonly QueueItemStatus[] = ['waiting', 'active', 'suspended', 'needs_input', 'done', 'error', 'cancelled']

export function isQueueItem(value: unknown): value is QueueItem {
	if (!isObject(value)) return false
	if (!isString(value.id) || value.id === '') return false
	if (!isString(value.task) || value.task === '') return false
	if (value.effort !== undefined && !isEffortLevel(value.effort)) return false
	if (value.involvement !== undefined && !isInvolvementLevel(value.involvement)) return false
	if (value.logLevel !== undefined && !isLogLevel(value.logLevel)) return false
	if (value.continuesFrom !== undefined && !isRunIdShape(value.continuesFrom)) return false
	if (!isString(value.status) || !queueItemStatuses.some((status) => status === value.status)) return false
	if (value.runId !== undefined && !isRunIdShape(value.runId)) return false
	if (!isString(value.queuedAt)) return false
	if (value.suspendedAt !== undefined && !isString(value.suspendedAt)) return false
	if (value.settledAt !== undefined && !isString(value.settledAt)) return false
	if (value.question !== undefined && !isString(value.question)) return false
	if (value.answer !== undefined && !isString(value.answer)) return false
	if (value.answerId !== undefined && (!isString(value.answerId) || value.answerId === '')) return false
	if (value.resultSummary !== undefined && !isString(value.resultSummary)) return false
	if (value.error !== undefined && !isString(value.error)) return false
	if (value.resumeRunId !== undefined) {
		if (!isRunIdShape(value.resumeRunId)) return false
		// The resume pointer exists only on an answered item that is waiting to dispatch or actively being dispatched: a settled/cancelled record cannot still be bound to a dispatch.
		if (value.answer === undefined) return false
		if (value.status !== 'waiting' && value.status !== 'active') return false
	}
	if (value.resumeToolCallId !== undefined) {
		if (!isString(value.resumeToolCallId) || value.resumeToolCallId === '') return false
		// A parked-ask pointer only ever accompanies a run target; a clarification resume has a run id but no tool call.
		if (value.resumeRunId === undefined) return false
	}
	if (value.status === 'suspended') {
		// A suspension keeps the run id and pause time and nothing from a settled or parked lifecycle: the run meta is the single source of truth for the cause.
		if (value.runId === undefined) return false
		if (value.suspendedAt === undefined) return false
		if (value.settledAt !== undefined) return false
		if (value.resultSummary !== undefined) return false
		if (value.error !== undefined) return false
		if (value.question !== undefined) return false
		if (value.answer !== undefined) return false
		if (value.resumeRunId !== undefined) return false
		if (value.resumeToolCallId !== undefined) return false
	} else if (value.suspendedAt !== undefined) {
		return false
	}
	return true
}

export function isTaskQueue(value: unknown): value is TaskQueue {
	if (!isObject(value)) return false
	if (value.version !== QUEUE_FORMAT_VERSION) return false
	if (!Array.isArray(value.items) || !value.items.every(isQueueItem)) return false
	return true
}

// Explicit projection, not a spread: the resume run id is surfaced under its read-only name so the UI can merge the paused/answered row with its run, while the tool-call id stays internal dispatch bookkeeping.
export function toQueueItemView(item: QueueItem): QueueItemView {
	return {
		id: item.id,
		task: item.task,
		...(item.effort !== undefined ? { effort: item.effort } : {}),
		...(item.involvement !== undefined ? { involvement: item.involvement } : {}),
		...(item.logLevel !== undefined ? { logLevel: item.logLevel } : {}),
		...(item.continuesFrom !== undefined ? { continuesFrom: item.continuesFrom } : {}),
		status: item.status,
		...(item.runId !== undefined ? { runId: item.runId } : {}),
		...(item.resumeRunId !== undefined ? { resumesRunId: item.resumeRunId } : {}),
		queuedAt: item.queuedAt,
		...(item.suspendedAt !== undefined ? { suspendedAt: item.suspendedAt } : {}),
		...(item.settledAt !== undefined ? { settledAt: item.settledAt } : {}),
		...(item.question !== undefined ? { question: item.question } : {}),
		...(item.answer !== undefined ? { answer: item.answer } : {}),
		...(item.resultSummary !== undefined ? { resultSummary: item.resultSummary } : {}),
		...(item.error !== undefined ? { error: item.error } : {}),
	}
}

export function toQueueView(queue: TaskQueue): QueueView {
	return { items: queue.items.map(toQueueItemView) }
}

export type NewQueueItemResult = { ok: true; item: QueueItem } | { ok: false; error: string }

// Validates an operator-supplied item body and normalizes it into a fresh waiting item. The id and timestamp are supplied by the caller (the API layer mints them), keeping this pure and deterministic.
export function normalizeNewItem(input: unknown, handles: { id: string; queuedAt: string }): NewQueueItemResult {
	if (!isObject(input)) return { ok: false, error: 'expected an object' }
	const task = input['task']
	if (typeof task !== 'string' || task === '') return { ok: false, error: 'task must be a non-empty string' }
	const effort = input['effort']
	if (effort !== undefined && !isEffortLevel(effort)) return { ok: false, error: 'effort must be one of: quick, standard, thorough' }
	const involvement = input['involvement']
	if (involvement !== undefined && !isInvolvementLevel(involvement)) return { ok: false, error: 'involvement must be one of: autonomous, early-engagement, collaborative' }
	const logLevel = input['logLevel']
	if (logLevel !== undefined && !isLogLevel(logLevel)) return { ok: false, error: 'logLevel must be "full" or "standard"' }
	const continuesFrom = input['continuesFrom']
	if (continuesFrom !== undefined && !isRunIdShape(continuesFrom)) return { ok: false, error: 'continuesFrom must be a run id' }
	const item: QueueItem = {
		id: handles.id,
		task,
		...(effort !== undefined ? { effort } : {}),
		...(involvement !== undefined ? { involvement } : {}),
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

// The operator-facing fields every lifecycle rebuild carries forward: identity, the per-run overrides, the queued-at stamp, and the recorded question, answer, and answer id (a re-dispatched item's record of why it re-ran). Outcome fields (runId, resultSummary, error, settledAt) are never carried — they belong to the lifecycle stage that produced them.
function carriedFields(item: QueueItem): Pick<QueueItem, 'id' | 'task' | 'queuedAt'> & { effort?: EffortLevel; involvement?: InvolvementLevel; logLevel?: LogLevel; question?: string; answer?: string; answerId?: string } {
	return {
		id: item.id,
		task: item.task,
		...(item.effort !== undefined ? { effort: item.effort } : {}),
		...(item.involvement !== undefined ? { involvement: item.involvement } : {}),
		...(item.logLevel !== undefined ? { logLevel: item.logLevel } : {}),
		...(item.question !== undefined ? { question: item.question } : {}),
		...(item.answer !== undefined ? { answer: item.answer } : {}),
		...(item.answerId !== undefined ? { answerId: item.answerId } : {}),
		queuedAt: item.queuedAt,
	}
}

// Returns the item rebuilt as waiting for re-dispatch, carrying its lineage: an explicit continuesFrom re-points it at the run that just settled (an interrupted run, or the run a requeue retries), while its absence keeps the item's existing lineage.
export function releaseToWaiting(item: QueueItem, rePointedContinuesFrom?: string): QueueItem {
	const continuesFrom = rePointedContinuesFrom ?? item.continuesFrom
	return {
		...carriedFields(item),
		...(continuesFrom !== undefined ? { continuesFrom } : {}),
		...(item.resumeRunId !== undefined ? { resumeRunId: item.resumeRunId } : {}),
		...(item.resumeToolCallId !== undefined ? { resumeToolCallId: item.resumeToolCallId } : {}),
		status: 'waiting',
	}
}

// The dispatching marker: the item written active with no runId before submitRun is called. It closes the crash window between a successful submit and the queue's runId write — a crash there leaves an active-without-id item the boot tick repairs by bind-or-release. The resume pointers ride the active marker too so a parked re-park with the same question but a different tool call is still recognized after a crash.
export function dispatchingItem(item: QueueItem): QueueItem {
	return {
		...carriedFields(item),
		...(item.continuesFrom !== undefined ? { continuesFrom: item.continuesFrom } : {}),
		...(item.resumeRunId !== undefined ? { resumeRunId: item.resumeRunId } : {}),
		...(item.resumeToolCallId !== undefined ? { resumeToolCallId: item.resumeToolCallId } : {}),
		status: 'active',
	}
}

export function withReplacedItem(queue: TaskQueue, item: QueueItem): TaskQueue {
	return { version: QUEUE_FORMAT_VERSION, items: queue.items.map((existing) => (existing.id === item.id ? item : existing)) }
}

export function enqueueAtTail(queue: TaskQueue, item: QueueItem): TaskQueue {
	return { version: QUEUE_FORMAT_VERSION, items: [...queue.items, item] }
}

export function enqueueAtHead(queue: TaskQueue, item: QueueItem): TaskQueue {
	return { version: QUEUE_FORMAT_VERSION, items: [item, ...queue.items] }
}

// The by-id guard behind every operator PATCH: the item must exist (404) and be waiting (409), whether or not the patch carries a field to apply.
export function requireWaitingItem(queue: TaskQueue, id: string): QueueMutation {
	const target = findById(queue, id)
	if (target === undefined) return { ok: false, reason: 'not_found' }
	if (target.status !== 'waiting') return { ok: false, reason: 'forbidden_status' }
	return { ok: true, queue, item: target }
}

// The PATCH endpoint's text/effort/involvement edit half: only a waiting item's task, effort, and involvement are operator-editable (the dispatch may already be running otherwise). Fields absent from the edit carry forward.
export function editWaitingItem(queue: TaskQueue, id: string, edit: { task?: string; effort?: EffortLevel; involvement?: InvolvementLevel }): QueueMutation {
	const required = requireWaitingItem(queue, id)
	if (!required.ok) return required
	// A waiting answer is already bound to the parked run and the exact task/question it re-enters; editing those fields would be silently ignored by the resume, so reject it. Position-only reorder remains allowed.
	if (required.item.resumeRunId !== undefined || required.item.resumeToolCallId !== undefined) return { ok: false, reason: 'forbidden_status' }
	const edited: QueueItem = {
		...required.item,
		...(edit.task !== undefined ? { task: edit.task } : {}),
		...(edit.effort !== undefined ? { effort: edit.effort } : {}),
		...(edit.involvement !== undefined ? { involvement: edit.involvement } : {}),
	}
	return { ok: true, queue: withReplacedItem(queue, edited), item: edited }
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
	return { ok: true, queue: { version: QUEUE_FORMAT_VERSION, items }, item: target }
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

// The operator's termination of a parked item: the record becomes cancelled like any other settled item, keeping its question and answer (and lineage) for audit while dropping the run and resume pointers, so a stale dispatch can never re-enter the run.
export function terminateNeedsInputItem(queue: TaskQueue, id: string, settledAt: string): QueueMutation {
	const target = findById(queue, id)
	if (target === undefined) return { ok: false, reason: 'not_found' }
	if (target.status !== 'needs_input') return { ok: false, reason: 'forbidden_status' }
	const cancelled = cancelledItem(target, settledAt)
	return { ok: true, queue: withReplacedItem(queue, cancelled), item: cancelled }
}

// The operator's termination of a suspended item: like a parked item, the record becomes cancelled with its lineage preserved, so a stale dispatch can never re-enter the terminated run.
export function terminateSuspendedItem(queue: TaskQueue, id: string, settledAt: string): QueueMutation {
	const target = findById(queue, id)
	if (target === undefined) return { ok: false, reason: 'not_found' }
	if (target.status !== 'suspended') return { ok: false, reason: 'forbidden_status' }
	const cancelled = cancelledItem(target, settledAt)
	return { ok: true, queue: withReplacedItem(queue, cancelled), item: cancelled }
}

// The boot repair for the termination crash window: a needs_input item whose run was already terminalized interrupted but whose queue cancel never landed is cancelled on the next tick. Only a runId is consulted — continuesFrom is lineage and may name another terminal run — and every other status/meta combination is left untouched.
export function repairNeedsInputItem(item: QueueItem, meta: RunMeta | null, settledAt: string): QueueItem | null {
	if (item.status !== 'needs_input') return null
	if (item.runId === undefined) return null
	if (meta === null || meta.status !== 'interrupted') return null
	return cancelledItem(item, settledAt)
}

function cancelledItem(target: QueueItem, settledAt: string): QueueItem {
	return {
		...carriedFields(target),
		...(target.continuesFrom !== undefined ? { continuesFrom: target.continuesFrom } : {}),
		status: 'cancelled',
		settledAt,
	}
}

// The POST /api/runs path's collision rollback: a run_id_collision that exhausted the scheduler's retry budget leaves the just-created head item waiting with no run behind it, and the item is dropped outright so the caller's resubmit behaves exactly as it does today. Only a still-waiting item is ever dropped — an item the tick dispatched (or a settled one's record) is left alone.
export function removeWaitingItem(queue: TaskQueue, id: string): QueueMutation {
	const required = requireWaitingItem(queue, id)
	if (!required.ok) return required
	return { ok: true, queue: { version: QUEUE_FORMAT_VERSION, items: queue.items.filter((item) => item.id !== id) }, item: required.item }
}

export function recordAnswer(queue: TaskQueue, id: string, answer: string, answerId: string, resume?: { runId: string; toolCallId?: string }): QueueMutation {
	const target = findById(queue, id)
	if (target === undefined) return { ok: false, reason: 'not_found' }
	if (target.status !== 'needs_input') return { ok: false, reason: 'forbidden_status' }
	// The run id is dropped from runId (a waiting item showing an old run id would read as the run in flight) and carried by resumeRunId instead. A same-run resume preserves the item's lineage; a briefed fallback re-points it at the paused run so the continuation names the right attempt. Only a parked ask adds the tool call whose result the answer replaces.
	const lineage = resume === undefined
		? target.runId !== undefined
			? { continuesFrom: target.runId }
			: target.continuesFrom !== undefined ? { continuesFrom: target.continuesFrom } : {}
		: target.continuesFrom !== undefined ? { continuesFrom: target.continuesFrom } : {}
	const resumePointers = resume !== undefined
		? { resumeRunId: resume.runId, ...(resume.toolCallId !== undefined ? { resumeToolCallId: resume.toolCallId } : {}) }
		: {}
	const answered: QueueItem = {
		...carriedFields(target),
		...lineage,
		...resumePointers,
		answer,
		answerId,
		status: 'waiting',
	}
	// The answered item fronts the file so it is the next waiting item the scheduler dispatches — the queue-native resume.
	return { ok: true, queue: { version: QUEUE_FORMAT_VERSION, items: [answered, ...queue.items.filter((item) => item.id !== id)] }, item: answered }
}

// True when an answer was recorded for this item but has not been delivered into its paused run. The item's resume target must be the run that just settled, so a fallback dispatch's new run can never consume an old answer. For a parked ask a matching tool call proves the same ask; a clarification receipt with no tool call belongs to an earlier pause, so a later parked ask is new. For a clarification pause the checkpoint records the delivered answer id and whether the resumed run consumed it: an id match that was never consumed (a crash before the running meta) is still undelivered, while a consumed match is a legitimate re-pause and settles normally. A missing checkpoint means the answer was delivered, so neither kind is undelivered.
export function pendingAnswerUndelivered(item: QueueItem, pauseState: PauseState | null, runId: string): boolean {
	if (item.answer === undefined) return false
	if (item.resumeRunId !== runId) return false
	if (pauseState === null) return false
	if (pauseState.kind === 'parked_ask') {
		if (item.resumeToolCallId === undefined) return false
		return pauseState.ask.toolCallId === item.resumeToolCallId && pauseState.ask.question === item.question
	}
	// A parked tool-call pointer never belongs to a clarification resume.
	if (item.resumeToolCallId !== undefined) return false
	if (item.answerId === undefined) return false
	if (pauseState.deliveredAnswerId !== item.answerId) return true
	return pauseState.deliveredAnswerConsumed !== true
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
	return { ok: true, queue: enqueueAtTail({ version: QUEUE_FORMAT_VERSION, items: queue.items.filter((existing) => existing.id !== id) }, requeued), item: requeued }
}

// The explicit error-resume's queue counterpart: the operator resumed an errored run from its checkpoint under the same run id, so the item settled to error for that run returns to the active slot under it — the queue panel tracks the live run instead of showing a stale error, and the resumed run's own settlement maps the item exactly as any active item's would (settleActiveItem matches on the run id). Outcome fields (settledAt, resultSummary, error) belong to the settled stage and are not carried, mirroring carriedFields; an unknown or non-error item leaves the queue untouched — the resume is driven by the run's meta and checkpoint, and an item whose record was requeued or cancelled does not bind.
export function reactivateErrorItem(queue: TaskQueue, runId: string): QueueMutation {
	const target = queue.items.find((item) => item.status === 'error' && item.runId === runId)
	if (target === undefined) return { ok: false, reason: 'not_found' }
	const reactivated: QueueItem = {
		...carriedFields(target),
		...(target.continuesFrom !== undefined ? { continuesFrom: target.continuesFrom } : {}),
		status: 'active',
		runId,
	}
	return { ok: true, queue: withReplacedItem(queue, reactivated), item: reactivated }
}

// The suspended resume's queue counterpart: the item returns to the active slot under the same run id and drops its pause stamp, so the resumed run's own settlement maps it exactly as any active item's would.
export function reactivateSuspendedItem(queue: TaskQueue, runId: string): QueueMutation {
	const target = queue.items.find((item) => item.status === 'suspended' && item.runId === runId)
	if (target === undefined) return { ok: false, reason: 'not_found' }
	const reactivated: QueueItem = {
		...carriedFields(target),
		...(target.continuesFrom !== undefined ? { continuesFrom: target.continuesFrom } : {}),
		status: 'active',
		runId,
	}
	return { ok: true, queue: withReplacedItem(queue, reactivated), item: reactivated }
}

export interface TerminalItemState {
	status: 'done' | 'error' | 'needs_input'
	resultSummary?: string
	error?: string
	question?: string
}

// Maps a terminal run meta to the item state the settlement applies, exactly the live mapping (docs/queueing.md state machine): success → done, error → error, needs_clarification → needs_input. A meta that maps to no item state ('running' can never settle, and an 'interrupted' run — abandoned by reconciliation or terminated by the operator — is repaired by boot/answer handling rather than settled) returns undefined.
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
	| { kind: 'suspended'; queue: TaskQueue; item: QueueItem }
	| { kind: 'unknown_run' }
	| { kind: 'not_settleable' }

// Applies the settlement mapping to the active item a settled run belongs to (matched by runId). needs_input keeps the item unsettled (it waits for an answer) and preserves its existing continuesFrom lineage; the resume target is carried by runId and later resumeRunId, not by re-pointing lineage.
export function settleActiveItem(queue: TaskQueue, runId: string, meta: RunMeta, settledAt: string): SettlementOutcome {
	const target = queue.items.find((item) => item.status === 'active' && item.runId === runId)
	if (target === undefined) return { kind: 'unknown_run' }
	const mapped = mapSettledItemState(meta)
	if (mapped === undefined) return { kind: 'not_settleable' }
	const item = settledItem(target, mapped, settledAt, runId)
	return { kind: 'settled', queue: withReplacedItem(queue, item), item }
}

// Applies a suspension to the active item the paused run belongs to (matched by runId), preserving the run id and lineage while dropping every settled or parked field: the cause lives in the run meta, not the queue item.
export function suspendActiveItem(queue: TaskQueue, runId: string, suspendedAt: string): SettlementOutcome {
	const target = queue.items.find((item) => item.status === 'active' && item.runId === runId)
	if (target === undefined) return { kind: 'unknown_run' }
	const item = suspendedItem(target, suspendedAt, runId)
	return { kind: 'suspended', queue: withReplacedItem(queue, item), item }
}

function suspendedItem(target: QueueItem, suspendedAt: string, runId: string): QueueItem {
	return {
		id: target.id,
		task: target.task,
		...(target.effort !== undefined ? { effort: target.effort } : {}),
		...(target.involvement !== undefined ? { involvement: target.involvement } : {}),
		...(target.logLevel !== undefined ? { logLevel: target.logLevel } : {}),
		...(target.continuesFrom !== undefined ? { continuesFrom: target.continuesFrom } : {}),
		status: 'suspended',
		runId,
		queuedAt: target.queuedAt,
		suspendedAt,
	}
}

function settledItem(target: QueueItem, mapped: TerminalItemState, settledAt: string, runId: string): QueueItem {
	const base = {
		id: target.id,
		task: target.task,
		...(target.effort !== undefined ? { effort: target.effort } : {}),
		...(target.involvement !== undefined ? { involvement: target.involvement } : {}),
		...(target.logLevel !== undefined ? { logLevel: target.logLevel } : {}),
		queuedAt: target.queuedAt,
	}
	if (mapped.status === 'needs_input') {
		// The item's existing lineage is preserved; the resume target is carried by runId (and later resumeRunId). A re-park replaces the question and leaves no stale answer.
		return {
			...base,
			...(target.continuesFrom !== undefined ? { continuesFrom: target.continuesFrom } : {}),
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

// Boot repair for stale active items (docs/queueing.md state machine, the boot rows) — the terminal meta and the queue item are separate files with no cross-file atomicity, so a crash between the two writes leaves an active item needing repair:
// - with a runId whose meta is terminal: settle from that meta, exactly the live mapping (the crash landed between the meta write and the settlement write).
// - with a runId whose meta reads 'interrupted': a superseded suspended run is cancelled so it cannot re-dispatch as a new continuation; any other interrupted run was abandoned or terminated by the operator, not the task, so its item returns to waiting with the lineage re-pointed at the interrupted run. An operator termination normally lands on a needs_input item, which repairNeedsInputItem cancels instead.
// - with a runId whose meta still reads 'running': the boot-resumed run's own item — untouched; its own settlement maps it.
// - with a runId whose meta is unreadable (a phantom run directory): release to waiting rather than leave the item stuck active forever.
// - with no runId (an orphaned dispatching marker): the run may or may not have started. The scheduler passes the boot-resumed run's meta (the unique 'running' meta) or null; the item binds to it when the task matches — identical task texts are interchangeable, since only the head is ever mid-dispatch — and returns to waiting otherwise.
// - an answered item whose run settled 'needs_clarification' before the answer was delivered (the checkpoint still names the same tool call and question, or for a clarification pause the meta still names the answered question): release it to waiting so the answer retries instead of settling to needs_input and dropping it. A missing checkpoint means the answer was delivered and the run terminalized, so the normal mapping applies.
export function repairActiveItem(item: QueueItem, meta: RunMeta | null, settledAt: string, pauseState: PauseState | null): QueueItem | null {
	const runId = item.runId
	if (runId !== undefined) {
		if (meta === null) return releaseToWaiting(item)
		if (meta.status === 'running') return null
		// The suspended meta landed but the queue write did not: preserve the run binding and pause stamp instead of treating the pause as a stale work item.
		if (meta.status === 'suspended') return suspendedItem(item, meta.suspension?.suspendedAt ?? meta.pause?.pausedAt ?? settledAt, runId)
		// Only a needs_clarification terminal can mean the answer is still undelivered: success/error prove the resumed run finished, and releasing those would rerun a done task. A re-park (different call, or a clarification checkpoint that already records this answer id) is delivered and settles normally.
		if (meta.status === 'needs_clarification' && pendingAnswerUndelivered(item, pauseState, runId)) {
			return releaseToWaiting(item)
		}
		if (meta.status === 'interrupted') return isSupersededSuspendedRun(meta) ? cancelledItem(item, meta.endTime ?? settledAt) : releaseToWaiting(item, runId)
		const mapped = mapSettledItemState(meta)
		if (mapped === undefined) return null
		// The settled time is the run's own endTime — when it actually finished — not the boot that noticed.
		return settledItem(item, mapped, meta.endTime ?? settledAt, runId)
	}
	if (meta !== null && meta.status === 'running' && meta.task === item.task) {
		return { ...carriedFields(item), ...(item.continuesFrom !== undefined ? { continuesFrom: item.continuesFrom } : {}), status: 'active', runId: meta.runId }
	}
	return releaseToWaiting(item)
}

// Boot repair for suspended items (the queue rows of the suspended state machine): the meta and the item are separate files, so a crash can leave either side one step behind.
// - a suspended meta keeps the item suspended (the normal durable pause).
// - a running meta means the run was resumed just before the crash: bind the item back to the active slot so its own settlement maps it.
// - a terminal meta means the crash landed after resume and settlement: settle from the meta exactly as the live mapping would.
// - an interrupted meta, or a missing/unreadable meta, leaves no resumable run: cancel the item rather than dispatch a task whose run is gone.
export function repairSuspendedItem(item: QueueItem, meta: RunMeta | null, settledAt: string): QueueItem | null {
	if (item.status !== 'suspended') return null
	const runId = item.runId
	if (runId === undefined) return cancelledItem(item, settledAt)
	if (meta === null) return cancelledItem(item, settledAt)
	if (meta.status === 'suspended') return null
	if (meta.status === 'running') {
		return {
			...carriedFields(item),
			...(item.continuesFrom !== undefined ? { continuesFrom: item.continuesFrom } : {}),
			status: 'active',
			runId,
		}
	}
	const mapped = mapSettledItemState(meta)
	if (mapped === undefined) return cancelledItem(item, settledAt)
	return settledItem(item, mapped, meta.endTime ?? settledAt, runId)
}

// The distilled run-list entry the briefing assembles from: the module's readRunListSummary leaf returns it (the web run-list summary is structurally compatible, so serve.ts passes its reader directly).
export interface RunListEntry {
	runId: string
	task: string | null
	status: RunMeta['status'] | 'unknown'
	endTime: string | null
	// The LLM-generated one-line summary; null when the summarizer has produced none (the module composes the task-text fallback).
	summary: string | null
}

// Binds the per-run briefing lines so a long history cannot bloat the entry context; the most recent runs are kept.
export const MAX_BRIEFING_RUN_LINES = 20

export interface BriefingInput {
	queuedAt: string
	items: QueueItem[]
	runs: RunListEntry[]
	// The run this dispatch continues, when any: its outcome is already carried as the new run's reference turns, so repeating it in the completed-run list would duplicate the prior task and summary.
	excludeRunId?: string
	// Present when the item is resuming from needs_input: the recorded question and the operator's answer.
	question?: string
	answer?: string
}

// Assembles the interim briefing lines (docs/queueing.md "The interim briefing"): when the item was queued; one line per run completed since then, each carrying the full run id so the stale-task fast path can cite a real one; the queue items cancelled meanwhile; the question and answer on a needs_input resume; and the standing instruction that the workspace may have changed. The first line's bracket marks the block as platform-provided context.
export function assembleBriefingLines(input: BriefingInput): string[] {
	const lines = ['[Queued-task briefing — what happened while this task waited in the queue.]', `Queued at ${input.queuedAt}.`]
	const completed = input.runs
		.filter((run) => run.runId !== input.excludeRunId && run.status !== 'running' && run.status !== 'unknown' && run.endTime !== null && run.endTime > input.queuedAt)
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
