import type { Sleep } from '../llm.js'
import type { ParkedAnswer, ParkedAsk } from '../park-state.js'
import type { ListRunIds, ReadRunMetaById } from '../persistence.js'
import { isRunMeta, isTerminalRunStatus, safeJsonParse } from '../validation.js'
import type { EffortLevel, InvolvementLevel, LogLevel, RunContinuation, RunMeta } from '../types.js'
import { assembleBriefingLines, cancelWaitingItem, dispatchingItem, editWaitingItem, enqueueAtHead, enqueueAtTail, normalizeNewItem, pendingAnswerUndelivered, reactivateErrorItem, recordAnswer, releaseToWaiting, removeWaitingItem, reorderWaitingItem, repairActiveItem, repairNeedsInputItem, requireWaitingItem, requeueErrorItem, settleActiveItem, terminateNeedsInputItem, toQueueItemView, toQueueView, withReplacedItem, type QueueItem, type QueueItemView, type QueueMutation, type QueueView, type RunListEntry, type TaskQueue } from './model.js'
import { readQueue, writeQueue, type QueueStore } from './persistence.js'

// The durable task queue module (docs/queueing.md "The queue: storage, item model, state machine" and "Dispatch and the scheduler"): the single public surface over the item model, the state machine, queue persistence, and the scheduler that dispatches queued tasks and settles their runs. HTTP handlers and the error-resume path call operations here rather than reading, mutating, and writing the queue file themselves, so the crash-safety ordering (dispatching marker before submit, boot repair, collision retry, settlement mapping) cannot be bypassed.

// The shaped submission the scheduler hands to the submission layer: the item's task, its effort, involvement, and logLevel overrides, and the continuation assembled from the item's lineage (the prior run's terminal meta) plus the interim briefing. Omitting any of these would silently drop lineage or an override for queue-tracked runs.
export interface QueuedRunSubmission {
	task: string
	effort?: EffortLevel
	involvement?: InvolvementLevel
	logLevel?: LogLevel
	continuation?: RunContinuation
}

export type QueuedRunSubmitResult =
	| { ok: true; runId: string }
	| { ok: false; error: 'run_in_progress' | 'run_id_collision' }

export type SubmitQueuedRun = (submission: QueuedRunSubmission) => QueuedRunSubmitResult

// The parked checkpoint reader: returns the ask a run's checkpoint is parked on, or null when the run has no parked checkpoint (delivered, missing, or corrupt).
export type ReadParkedAskById = (runId: string) => ParkedAsk | null

export type ResumeParkedRunResult =
	| { ok: true; runId: string }
	| { ok: false; error: 'run_in_progress' | 'checkpoint_missing' | 'not_parked' }

// The same-run answer resume: re-enters the parked run with the answer. The queue falls back to the legacy briefed dispatch on checkpoint_missing/not_parked.
export type QueueResumeParkedRun = (runId: string, parkedAnswer: ParkedAnswer) => ResumeParkedRunResult

export type TerminateParkedRunResult =
	| { ok: true; runId: string }
	| { ok: false; error: 'not_found' | 'not_parked' }

// The operator-termination port: the submission layer's factory satisfies this shape structurally, and the queue cancels the item even when the run is already gone.
export type TerminateParkedRun = (runId: string) => TerminateParkedRunResult

// The configured leaves the composition root supplies; the module owns all queue logic and none has a default.
export interface TaskQueueDependencies {
	// The text-only persistence port; the module owns parsing, validation, malformed/missing tolerance, and serialization, while the write side replaces the file atomically.
	queueStore: QueueStore
	// The run-meta reader leaf (the raw meta.json text): boot repair of stale active items and continuation assembly from the parked or errored run's meta both parse through it.
	readRunMetaById: ReadRunMetaById
	listRunIds: ListRunIds
	// The run-list summary reader: enumerates each run's one-line summary (null when the summarizer has produced none) alongside its task, which the briefing assembles from.
	readRunListSummary: (runId: string) => RunListEntry
	// The parked-checkpoint reader: answer uses it to learn the tool call the answer must replace, boot repair uses it to tell a delivered answer from an undelivered one, and settlement uses it to detect a re-park.
	readParkedAskById: ReadParkedAskById
	// The same-run answer resume, supplied by the submission layer: the queue decides when to re-enter a parked run and falls back to a briefed dispatch when it cannot.
	resumeParkedRun: QueueResumeParkedRun
	// The operator-termination operation for a parked run, supplied by the submission layer: it terminalizes the run and deletes its checkpoint, while the queue cancels the item even when the run is already gone.
	terminateParkedRun: TerminateParkedRun
	submitRun: SubmitQueuedRun
	// The single-run-slot peek: when a run is active (the boot-resumed case) the tick is a true no-op — no dispatching-marker write, no submitRun probe — matching the design's "finds the slot busy and no-ops". The settlement hook's tick sees the slot already cleared.
	hasActiveRun: () => boolean
	sleep: Sleep
	now: () => string
}

// The caller-minted identity of a new item: the UUID the queue API addresses it by, and the ISO timestamp its waiting history begins at.
export interface QueueHandles {
	id: string
	queuedAt: string
}

// Where an enqueued item enters the file order; the scheduler dispatches the first waiting item.
export type QueuePlacement = 'head' | 'tail'

// The operator-editable fields of a waiting item. Position reorders it within the waiting sublist, clamping out-of-range values; an empty patch validates the item without writing.
export interface QueuePatchInput {
	task?: string
	effort?: EffortLevel
	involvement?: InvolvementLevel
	position?: number
}

// A by-id mutation either returns the updated item or names the refusal: an unknown id, or a status that forbids the operation.
export type QueueMutationOutcome =
	| { ok: true; item: QueueItemView }
	| { ok: false; reason: 'not_found' }
	| { ok: false; reason: 'forbidden_status' }

// An invalid body writes nothing; on success the returned item is the newly created waiting item before the tick, which may already have started its run.
export type QueueEnqueueOutcome =
	| { ok: true; item: QueueItemView }
	| { ok: false; reason: 'invalid_body' }

// The submit-now result by kind: 'invalid' writes nothing; 'busy' leaves a new item queued when the slot was taken mid-dispatch; 'dispatched' carries the accepted run id; 'collision' means the retry budget was exhausted and the just-created item was removed.
export type QueueSubmitOutcome =
	| { kind: 'dispatched'; runId: string }
	| { kind: 'busy' }
	| { kind: 'collision' }
	| { kind: 'invalid' }

// The public contract. Every read returns freshly cloned read-only DTOs, never module-owned arrays or objects.
// - read(): the current file-order items, head first.
// - enqueue(input, handles, placement): validates an operator body, writes a new waiting item at the head or tail, then ticks the scheduler; a malformed body writes nothing and returns 'invalid_body'.
// - submitNow(input, handles): the POST /api/runs path; refuses while a run is active with 'busy' before enqueueing, otherwise enqueues at the head and dispatches in the same call. A collision that exhausts the retry budget removes the just-created waiting item and returns 'collision'; a slot that becomes busy after the attempt keeps the item waiting and returns 'busy'.
// - patch(id, patch): edits task/effort/involvement and/or reorders within the waiting list; unknown ids return 'not_found', non-waiting items 'forbidden_status'. An empty patch validates without writing.
// - cancel(id, at): marks a waiting item cancelled with settledAt; unknown ids 'not_found', non-waiting items 'forbidden_status'.
// - terminate(id, at): cancels a needs_input item and, when it names a parked run, terminalizes that run and deletes its checkpoint; a run already gone ('not_found'/'not_parked') still cancels the item. Unknown ids 'not_found', other statuses 'forbidden_status'.
// - answer(id, answer): records an answer on a needs_input item, moves it to the front as waiting, and ticks; when the parked checkpoint still names this question, the item also records the run and tool call so the dispatch resumes the same run, otherwise it falls back to the legacy briefed continuation. An item whose own run is already terminal but not parked (an operator termination) is cancelled, its checkpoint cleanup and audit append retried, and the answer discarded instead of dispatching. Unknown ids 'not_found', other statuses 'forbidden_status'.
// - requeue(id): returns an error item to waiting at the tail with its lineage re-pointed at the errored run, then ticks; unknown ids 'not_found', other statuses 'forbidden_status'.
// - reactivateErrorItem(runId): puts the error item for a resumed run back into the active slot under the same run id; returns 'not_found' when no error item names that run.
// - tick(): repairs stale active items from their run metas and cancels needs_input items whose run was terminated before the queue write, then dispatches the head waiting item unless a run is active or shutdown has been observed. An answered item resumes its parked run; when that run cannot be resumed the item falls back to the legacy briefed dispatch.
// - onRunSettled(meta): maps a settled run from its terminal meta, writes the mapping before ticking, and never settles an 'interrupted' meta (that item re-dispatches through boot repair). A needs_clarification settlement whose answer is still undelivered releases the item to waiting and ticks instead of settling, so the answer retries.
// - observeShutdown(): closes the dispatch gate; settlements still map but no new run starts.
export interface TaskQueueModule {
	read(): QueueView
	enqueue(input: unknown, handles: QueueHandles, placement: QueuePlacement): Promise<QueueEnqueueOutcome>
	submitNow(input: unknown, handles: QueueHandles): Promise<QueueSubmitOutcome>
	patch(id: string, patch: QueuePatchInput): QueueMutationOutcome
	cancel(id: string, at: string): QueueMutationOutcome
	terminate(id: string, at: string): QueueMutationOutcome
	answer(id: string, answer: string): Promise<QueueMutationOutcome>
	requeue(id: string): Promise<QueueMutationOutcome>
	reactivateErrorItem(runId: string): QueueMutationOutcome
	tick(): Promise<void>
	onRunSettled(meta: RunMeta): Promise<void>
	observeShutdown(): void
}

// A collision retry sleeps past the one-second run-id resolution — an immediate retry regenerates the same id — before re-reading the queue for a fresh attempt.
const COLLISION_RETRY_DELAY_MS = 1100
// The bound on collision retries; a retry budget exhausted releases the item to waiting for the next tick.
const MAX_COLLISION_RETRIES = 3

function toMutationOutcome(result: QueueMutation): QueueMutationOutcome {
	if (result.ok) return { ok: true, item: toQueueItemView(result.item) }
	return { ok: false, reason: result.reason }
}

export function createTaskQueue(dependencies: TaskQueueDependencies): TaskQueueModule {
	let shutdownObserved = false

	function readQueueState(): TaskQueue {
		return readQueue(dependencies.queueStore)
	}

	function writeQueueState(queue: TaskQueue): void {
		writeQueue(dependencies.queueStore, queue)
	}

	function read(): QueueView {
		return toQueueView(readQueueState())
	}

	function parseRunMetaText(runId: string): RunMeta | null {
		const text = dependencies.readRunMetaById(runId)
		if (text === null) return null
		const parsed = safeJsonParse(text)
		if (!parsed.ok) return null
		return isRunMeta(parsed.value) ? parsed.value : null
	}

	// The boot-resumed run is the unique 'running' meta after startup reconciliation has marked every other abandoned run interrupted. Zero or (never, but defensively) multiple candidates refuse to bind.
	function findUniqueRunningMeta(): RunMeta | null {
		let found: RunMeta | null = null
		for (const runId of dependencies.listRunIds()) {
			const meta = parseRunMetaText(runId)
			if (meta === null || meta.status !== 'running') continue
			if (found !== null) return null
			found = meta
		}
		return found
	}

	// Repairs every active item from its run's meta (docs/queueing.md state machine, the boot rows), and every needs_input item whose run was terminalized interrupted before its queue cancel landed, finishing that run's checkpoint/audit cleanup and writing when anything changed. Idempotent and cheap in steady state — a live run's item and a normally parked item are untouched.
	function repairPass(): void {
		const queue = readQueueState()
		let resumedMeta: RunMeta | null | undefined
		const scanResumed = (): RunMeta | null => {
			if (resumedMeta === undefined) resumedMeta = findUniqueRunningMeta()
			return resumedMeta
		}
		let changed = false
		const items = queue.items.map((item) => {
			if (item.status === 'needs_input' && item.runId !== undefined) {
				const meta = parseRunMetaText(item.runId)
				const repaired = repairNeedsInputItem(item, meta, dependencies.now())
				if (repaired === null) return item
				// The meta wrote interrupted before the checkpoint delete landed, so the retry finishes that cleanup before the queue records the cancellation.
				dependencies.terminateParkedRun(item.runId)
				changed = true
				return repaired
			}
			if (item.status !== 'active') return item
			const meta = item.runId !== undefined ? parseRunMetaText(item.runId) : scanResumed()
			const parkedAsk = item.runId !== undefined ? dependencies.readParkedAskById(item.runId) : null
			const settledAt = meta?.endTime ?? dependencies.now()
			const repair = repairActiveItem(item, meta, settledAt, parkedAsk)
			if (repair.item === item) return item
			changed = true
			return repair.item
		})
		if (changed) writeQueueState({ items })
	}

	function assembleSubmission(item: QueueItem, queueItems: QueueItem[]): QueuedRunSubmission {
		const runs = dependencies.listRunIds().map((runId) => dependencies.readRunListSummary(runId))
		const composeBriefing = (excludeRunId?: string): string[] => assembleBriefingLines({
			queuedAt: item.queuedAt,
			items: queueItems,
			runs,
			...(excludeRunId !== undefined ? { excludeRunId } : {}),
			...(item.question !== undefined ? { question: item.question } : {}),
			...(item.answer !== undefined ? { answer: item.answer } : {}),
		})
		const overrides = {
			...(item.effort !== undefined ? { effort: item.effort } : {}),
			...(item.involvement !== undefined ? { involvement: item.involvement } : {}),
			...(item.logLevel !== undefined ? { logLevel: item.logLevel } : {}),
		}
		if (item.continuesFrom !== undefined) {
			const priorMeta = parseRunMetaText(item.continuesFrom)
			// The prior run's terminal status, task, and full outcome carried from its meta. Only this branch renders reference turns, so only here is the continued run excluded from the briefing's completed-run lines. An unreadable or non-terminal prior meta degrades to a briefing-only dispatch rather than dropping the item's run.
			if (priorMeta !== null && isTerminalRunStatus(priorMeta.status)) {
				return {
					task: item.task,
					...overrides,
					continuation: {
						runId: item.continuesFrom,
						task: priorMeta.task,
						summary: priorMeta.result?.summary ?? '',
						status: priorMeta.status,
						...(priorMeta.result !== undefined ? { result: priorMeta.result } : {}),
						...(priorMeta.error !== undefined ? { error: priorMeta.error } : {}),
						briefing: composeBriefing(item.continuesFrom),
					},
				}
			}
		}
		// A first queue dispatch — or a degraded continuation whose prior meta is unreadable or non-terminal — records no lineage and carries only the briefing; without reference turns there is no reason to omit the continued run from the completed-run lines.
		return { task: item.task, ...overrides, continuation: { task: item.task, summary: '', briefing: composeBriefing() } }
	}

	// The legacy dispatch cycle shared by a first dispatch and an answer's fallback: write the dispatching marker (active, no runId), call submitRun, then fill the runId on acceptance, restore the item to waiting on run_in_progress, or sleep-and-retry on run_id_collision. Each write is a whole-file read-modify-write cycle; a collision sleep ends one cycle and the retry begins a fresh one that re-reads.
	async function submitHead(item: QueueItem, view: TaskQueue): Promise<void> {
		// The marker is written before submitRun so a crash after a successful submit leaves an active-without-id item the boot tick repairs by bind-or-release — never a stale waiting item that would re-dispatch behind its own duplicate.
		const marker = dispatchingItem(item)
		writeQueueState(withReplacedItem(view, marker))
		for (let attempt = 0; ; attempt++) {
			const result = dependencies.submitRun(assembleSubmission(marker, view.items))
			if (result.ok) {
				writeQueueState(withReplacedItem(view, { ...marker, runId: result.runId }))
				return
			}
			// The slot is taken (a run is already going): restore the item to waiting in the same synchronous cycle — the marker was already written, so leaving it as-is would orphan it as active-without-id until boot repair.
			if (result.error === 'run_in_progress' || attempt >= MAX_COLLISION_RETRIES) {
				writeQueueState(withReplacedItem(view, releaseToWaiting(marker)))
				return
			}
			await dependencies.sleep(COLLISION_RETRY_DELAY_MS)
			// The sleep let other queue mutations interleave, so the retry re-reads and continues only while the item is still this tick's unbound marker; otherwise it now belongs to another cycle.
			view = readQueueState()
			const current = view.items.find((item) => item.id === marker.id)
			if (current === undefined || current.status !== 'active' || current.runId !== undefined) return
		}
	}

	type ResumeAttempt =
		| { kind: 'done' }
		| { kind: 'released' }
		| { kind: 'fallback'; item: QueueItem; view: TaskQueue }

	// Re-enters the parked run the answered item points at, writing an active marker under that run's id first so a settlement arriving while the resume starts finds the item. When the run can no longer be resumed the marker is rewritten as waiting without the resume pointers, keeping the answer for the legacy briefed dispatch.
	async function resumeAnsweredItem(item: QueueItem, view: TaskQueue): Promise<ResumeAttempt> {
		const resumeRunId = item.resumeRunId
		const resumeToolCallId = item.resumeToolCallId
		const answer = item.answer
		if (resumeRunId === undefined || resumeToolCallId === undefined || answer === undefined) return { kind: 'fallback', item, view }
		const marker: QueueItem = { ...dispatchingItem(item), runId: resumeRunId }
		writeQueueState(withReplacedItem(view, marker))
		const result = dependencies.resumeParkedRun(resumeRunId, { question: item.question ?? '', answer, toolCallId: resumeToolCallId })
		if (result.ok) return { kind: 'done' }
		if (result.error === 'run_in_progress') {
			writeQueueState(withReplacedItem(readQueueState(), releaseToWaiting(marker)))
			return { kind: 'released' }
		}
		const current = readQueueState()
		const currentItem = current.items.find((entry) => entry.id === item.id)
		if (currentItem === undefined) return { kind: 'released' }
		const waiting = releaseToWaiting(currentItem)
		delete waiting.resumeRunId
		delete waiting.resumeToolCallId
		writeQueueState(withReplacedItem(current, waiting))
		return { kind: 'fallback', item: waiting, view: current }
	}

	async function dispatchHead(): Promise<void> {
		const view = readQueueState()
		const head = view.items.find((item) => item.status === 'waiting')
		if (head === undefined) return
		if (head.resumeRunId !== undefined && head.resumeToolCallId !== undefined && head.answer !== undefined) {
			const attempt = await resumeAnsweredItem(head, view)
			if (attempt.kind === 'done' || attempt.kind === 'released') return
			await submitHead(attempt.item, attempt.view)
			return
		}
		await submitHead(head, view)
	}

	// One dispatch attempt: repair stale active items (the boot rows of the state machine), then dispatch the head waiting item — unless the slot is busy (a true no-op) or the shutdown gate is closed. Async only on the collision-retry path, whose sleep ends one read-modify-write cycle and whose retry begins a fresh one.
	const tick = async (): Promise<void> => {
		repairPass()
		if (shutdownObserved || dependencies.hasActiveRun()) return
		await dispatchHead()
	}

	return {
		read,
		async enqueue(input, handles, placement) {
			const normalized = normalizeNewItem(input, handles)
			if (!normalized.ok) return { ok: false, reason: 'invalid_body' }
			const queue = placement === 'head' ? enqueueAtHead(readQueueState(), normalized.item) : enqueueAtTail(readQueueState(), normalized.item)
			writeQueueState(queue)
			await tick()
			return { ok: true, item: toQueueItemView(normalized.item) }
		},
		async submitNow(input, handles) {
			// Checked before enqueueing so a busy service enqueues nothing, exactly as the 409 contract promises scripts.
			if (dependencies.hasActiveRun()) return { kind: 'busy' }
			const normalized = normalizeNewItem(input, handles)
			if (!normalized.ok) return { kind: 'invalid' }
			writeQueueState(enqueueAtHead(readQueueState(), normalized.item))
			await tick()
			const dispatched = readQueueState().items.find((item) => item.id === normalized.item.id)
			if (dispatched !== undefined && dispatched.runId !== undefined) return { kind: 'dispatched', runId: dispatched.runId }
			// The dispatch did not take. A same-second collision retry that overlapped another request's dispatch can land here with the item restored waiting while a run is in flight: the loser's item stays queued at the head (the scheduler's rules dispatch it when the active run settles) and today's run_in_progress stands. A collision that exhausted the scheduler's retry budget leaves a waiting item with no run behind it — removed (only then), so the caller's resubmit behaves exactly as it does today.
			if (dependencies.hasActiveRun() || dispatched === undefined || dispatched.status !== 'waiting') return { kind: 'busy' }
			const removal = removeWaitingItem(readQueueState(), normalized.item.id)
			if (!removal.ok) return { kind: 'busy' }
			writeQueueState(removal.queue)
			return { kind: 'collision' }
		},
		patch(id, patch) {
			let queue = readQueueState()
			let item: QueueItem | undefined
			if (patch.task !== undefined || patch.effort !== undefined || patch.involvement !== undefined) {
				const edited = editWaitingItem(queue, id, {
					...(patch.task !== undefined ? { task: patch.task } : {}),
					...(patch.effort !== undefined ? { effort: patch.effort } : {}),
					...(patch.involvement !== undefined ? { involvement: patch.involvement } : {}),
				})
				if (!edited.ok) return toMutationOutcome(edited)
				queue = edited.queue
				item = edited.item
			}
			if (patch.position !== undefined) {
				const reordered = reorderWaitingItem(queue, id, patch.position)
				if (!reordered.ok) return toMutationOutcome(reordered)
				queue = reordered.queue
				item = reordered.item
			}
			if (item === undefined) {
				// An empty patch is a no-op that still addresses a real waiting item, so existence and status are validated without writing anything.
				const required = requireWaitingItem(queue, id)
				return toMutationOutcome(required)
			}
			writeQueueState(queue)
			return { ok: true, item: toQueueItemView(item) }
		},
		cancel(id, at) {
			const result = cancelWaitingItem(readQueueState(), id, at)
			if (!result.ok) return toMutationOutcome(result)
			writeQueueState(result.queue)
			return { ok: true, item: toQueueItemView(result.item) }
		},
		terminate(id, at) {
			const queue = readQueueState()
			const target = queue.items.find((item) => item.id === id)
			if (target === undefined) return { ok: false, reason: 'not_found' }
			if (target.status !== 'needs_input') return { ok: false, reason: 'forbidden_status' }
			// Only the item's own run is terminalized: continuesFrom is lineage and may name another terminal run, and with no runId there is nothing to touch.
			if (target.runId !== undefined) dependencies.terminateParkedRun(target.runId)
			const result = terminateNeedsInputItem(queue, id, at)
			if (!result.ok) return toMutationOutcome(result)
			writeQueueState(result.queue)
			return { ok: true, item: toQueueItemView(result.item) }
		},
		async answer(id, answer) {
			const queue = readQueueState()
			const target = queue.items.find((item) => item.id === id)
			if (target === undefined) return { ok: false, reason: 'not_found' }
			if (target.status !== 'needs_input') return { ok: false, reason: 'forbidden_status' }
			// A run terminated between the queue's park write and this answer is terminal but not parked: the answer is discarded and the item cancelled, never dispatched as a new briefed run. A needs_clarification meta is the live park and answers normally.
			if (target.runId !== undefined) {
				const meta = parseRunMetaText(target.runId)
				if (meta !== null && isTerminalRunStatus(meta.status) && meta.status !== 'needs_clarification') {
					// The run was terminalized before this answer arrived, so finish its checkpoint/audit cleanup and discard the answer.
					dependencies.terminateParkedRun(target.runId)
					const result = terminateNeedsInputItem(queue, id, dependencies.now())
					if (!result.ok) return toMutationOutcome(result)
					writeQueueState(result.queue)
					return { ok: true, item: toQueueItemView(result.item) }
				}
			}
			const parkedRunId = target.runId ?? target.continuesFrom
			const parkedAsk = parkedRunId !== undefined ? dependencies.readParkedAskById(parkedRunId) : null
			// A legacy needs_input (no parked checkpoint, or a question that no longer matches one) keeps the briefed-continuation path; a live parked ask records the same-run resume pointers.
			const resume = parkedRunId !== undefined && parkedAsk !== null && parkedAsk.question === target.question ? { runId: parkedRunId, toolCallId: parkedAsk.toolCallId } : undefined
			const result = recordAnswer(queue, id, answer, resume)
			if (!result.ok) return toMutationOutcome(result)
			writeQueueState(result.queue)
			await tick()
			return { ok: true, item: toQueueItemView(result.item) }
		},
		async requeue(id) {
			const result = requeueErrorItem(readQueueState(), id)
			if (!result.ok) return toMutationOutcome(result)
			writeQueueState(result.queue)
			await tick()
			return { ok: true, item: toQueueItemView(result.item) }
		},
		reactivateErrorItem(runId) {
			const result = reactivateErrorItem(readQueueState(), runId)
			if (result.ok) writeQueueState(result.queue)
			return toMutationOutcome(result)
		},
		tick,
		async onRunSettled(meta) {
			const queue = readQueueState()
			const target = queue.items.find((item) => item.status === 'active' && item.runId === meta.runId)
			// A parked settlement whose answer is still undelivered (the frozen checkpoint still names the answered call and question) returns the answered item to waiting so the next tick retries it instead of settling to needs_input and dropping the answer.
			if (target !== undefined && meta.status === 'needs_clarification' && pendingAnswerUndelivered(target, dependencies.readParkedAskById(meta.runId))) {
				writeQueueState(withReplacedItem(queue, releaseToWaiting(target)))
				await tick()
				return
			}
			const settlement = settleActiveItem(queue, meta.runId, meta, dependencies.now())
			if (settlement.kind === 'settled') writeQueueState(settlement.queue)
			await tick()
		},
		observeShutdown() {
			shutdownObserved = true
		},
	}
}
