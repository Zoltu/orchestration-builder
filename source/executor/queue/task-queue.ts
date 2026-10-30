import type { Sleep } from '../llm.js'
import { questionFromParkSummary, type ParkedAnswer, type PauseState } from '../park-state.js'
import type { ListRunIds, ReadRunMetaById } from '../persistence.js'
import { isRunMeta, isTerminalRunStatus, safeJsonParse } from '../validation.js'
import type { EffortLevel, InvolvementLevel, LogLevel, RunContinuation, RunMeta } from '../types.js'
import { assembleBriefingLines, cancelWaitingItem, dispatchingItem, editWaitingItem, enqueueAtHead, enqueueAtTail, normalizeNewItem, pendingAnswerUndelivered, reactivateErrorItem, reactivateSuspendedItem, recordAnswer, releaseToWaiting, removeWaitingItem, reorderWaitingItem, repairActiveItem, repairNeedsInputItem, repairSuspendedItem, requireWaitingItem, requeueErrorItem, settleActiveItem, suspendActiveItem, terminateNeedsInputItem, terminateSuspendedItem, toQueueItemView, toQueueView, withReplacedItem, type QueueItem, type QueueItemView, type QueueMutation, type QueueView, type RunListEntry, type TaskQueue } from './model.js'
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
	| { ok: false; error: 'run_in_progress' | 'run_suspended' | 'run_paused' | 'run_id_collision' }

export type SubmitQueuedRun = (submission: QueuedRunSubmission) => QueuedRunSubmitResult

// The pause-state reader: returns the pause a run's checkpoint carries (a parked ask or a direct clarification finish), or null when the run has no checkpoint (delivered, missing, or corrupt).
export type ReadPauseStateById = (runId: string) => PauseState | null

export type ResumeParkedRunResult =
	| { ok: true; runId: string }
	| { ok: false; error: 'run_in_progress' | 'run_suspended' | 'run_paused' | 'checkpoint_missing' | 'not_parked' }

// The same-run answer resume: re-enters the parked run with the answer. The queue falls back to the briefed dispatch on checkpoint_missing/not_parked.
export type QueueResumeParkedRun = (runId: string, parkedAnswer: ParkedAnswer) => ResumeParkedRunResult

export type ResumeClarificationRunResult =
	| { ok: true; runId: string }
	| { ok: false; error: 'run_in_progress' | 'run_suspended' | 'run_paused' | 'checkpoint_missing' | 'not_clarification' }

// The same-run clarification resume: re-enters a direct-finish needs_clarification run with a framed question-and-answer note. The queue falls back to the briefed dispatch on checkpoint_missing/not_clarification.
export type QueueResumeClarificationRun = (runId: string, clarificationAnswer: { id: string; question: string; answer: string }) => ResumeClarificationRunResult

export type TerminatePausedRunResult =
	| { ok: true; runId: string }
	| { ok: false; error: 'not_found' | 'not_paused' }

// The operator-termination port: the submission layer's factory satisfies this shape structurally, and the queue cancels the item even when the run is already gone.
export type TerminatePausedRun = (runId: string, reason?: string) => TerminatePausedRunResult

// The configured leaves the composition root supplies; the module owns all queue logic and none has a default.
export interface TaskQueueDependencies {
	// The text-only persistence port; the module owns parsing, validation, malformed/missing tolerance, and serialization, while the write side replaces the file atomically.
	queueStore: QueueStore
	// The run-meta reader leaf (the raw meta.json text): boot repair of stale active items and continuation assembly from the parked or errored run's meta both parse through it.
	readRunMetaById: ReadRunMetaById
	listRunIds: ListRunIds
	// The run-list summary reader: enumerates each run's one-line summary (null when the summarizer has produced none) alongside its task, which the briefing assembles from.
	readRunListSummary: (runId: string) => RunListEntry
	// The pause-state reader: answer uses it to learn whether the answer replaces a parked tool result or re-enters as a clarification note, boot repair uses it to tell a delivered answer from an undelivered one, and settlement uses it to detect a re-park.
	readPauseStateById: ReadPauseStateById
	// The same-run parked-answer resume, supplied by the submission layer: the queue decides when to re-enter a parked run and falls back to a briefed dispatch when it cannot.
	resumeParkedRun: QueueResumeParkedRun
	// The same-run clarification-answer resume, supplied by the submission layer: it re-enters a direct-finish needs_clarification run and falls back like the parked path when it cannot.
	resumeClarificationRun: QueueResumeClarificationRun
	// The operator-termination operation for a parked run, supplied by the submission layer: it terminalizes the run and deletes its checkpoint, while the queue cancels the item even when the run is already gone.
	terminatePausedRun: TerminatePausedRun
	submitRun: SubmitQueuedRun
	// The single-run-slot peek: when a run is active (the boot-resumed case) the tick is a true no-op — no dispatching-marker write, no submitRun probe — matching the design's "finds the slot busy and no-ops". The settlement hook's tick sees the slot already cleared.
	hasActiveRun: () => boolean
	// The submission layer's general paused-run binding: a provider suspension or an operator pause has priority over every waiting item, so no tick may dispatch until it is resumed or terminated, even if the queue file lost the suspended item. The start-now refusal distinguishes them as run_suspended and run_paused through pausedRunKind.
	hasSuspendedRun: () => boolean
	// The paused run's kind: the start-now refusal names a provider suspension or an operator pause distinctly.
	pausedRunKind: () => 'provider' | 'operator' | undefined
	// The provider gate's dispatch permission. Waiting work never starts while the provider is unavailable; an inconclusive gate state still permits dispatch because it carries no evidence of failure.
	canDispatch: () => boolean
	// Starts the provider probe when blocked waiting work exists and no suspension is bound; the recovery owner owns the probe lifecycle.
	ensureProviderProbe: () => void
	sleep: Sleep
	now: () => string
	// Mints the durable identity of a recorded answer; injected so tests control it and the composition root owns the random source.
	generateAnswerId: () => string
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

// The submit-now result by kind: 'invalid' writes nothing; 'busy' leaves a new item queued when the slot was taken mid-dispatch; 'run_suspended' refuses a start while a paused run has priority; 'dispatched' carries the accepted run id; 'collision' means the retry budget was exhausted and the just-created item was removed.
export type QueueSubmitOutcome =
	| { kind: 'dispatched'; runId: string }
	| { kind: 'busy' }
	| { kind: 'run_suspended' }
	| { kind: 'run_paused' }
	| { kind: 'provider_unavailable' }
	| { kind: 'collision' }
	| { kind: 'invalid' }

// The public contract. Every read returns freshly cloned read-only DTOs, never module-owned arrays or objects.
// - read(): the current file-order items, head first.
// - enqueue(input, handles, placement): validates an operator body, writes a new waiting item at the head or tail, then ticks the scheduler; a malformed body writes nothing and returns 'invalid_body'.
// - submitNow(input, handles): the POST /api/runs path; refuses while a run is active with 'busy', while a paused run has priority with 'run_suspended' (provider) or 'run_paused' (operator), or while the provider gate blocks dispatch with 'provider_unavailable' before enqueueing; otherwise it enqueues at the head and dispatches in the same call. A collision that exhausts the retry budget removes the just-created waiting item and returns 'collision'; a slot that becomes busy after the attempt keeps the item waiting and returns 'busy'.
// - patch(id, patch): edits task/effort/involvement and/or reorders within the waiting list; unknown ids return 'not_found', non-waiting items 'forbidden_status'. An empty patch validates without writing.
// - cancel(id, at): marks a waiting item cancelled with settledAt; unknown ids 'not_found', non-waiting items 'forbidden_status'.
// - terminate(id, at): cancels a needs_input or suspended item and, when it names the corresponding run, terminalizes that run and deletes its checkpoint; a run already gone ('not_found'/'not_paused') still cancels the item. Unknown ids 'not_found', other statuses 'forbidden_status'.
// - answer(id, answer): records an answer (with a durable answer id) on a needs_input item, moves it to the front as waiting, and ticks; a parked checkpoint whose question still matches records the run and tool call, a clarification checkpoint whose meta question still matches records just the run, and either dispatch resumes the same run; an item with no matching checkpoint falls back to the briefed continuation; its lineage is re-pointed at the paused run when that run is known, otherwise the item keeps its existing lineage. An item whose own run is already terminal but not paused (an operator termination) is cancelled, its checkpoint cleanup and audit append retried, and the answer discarded instead of dispatching. Unknown ids 'not_found', other statuses 'forbidden_status'.
// - requeue(id): returns an error item to waiting at the tail with its lineage re-pointed at the errored run, then ticks; unknown ids 'not_found', other statuses 'forbidden_status'.
// - reactivateErrorItem(runId): puts the error item for a resumed run back into the active slot under the same run id; returns 'not_found' when no error item names that run.
// - reactivateSuspendedItem(runId): puts the suspended item for a resumed run back into the active slot under the same run id; returns 'not_found' when no suspended item names that run.
// - terminateSuspendedRun(runId, at): the run-level operator termination; terminalizes a suspended run, cancels any suspended item bound to it, and ticks so waiting work can dispatch once the pause is released.
// - discardSuspendedRun(runId, reason?): terminalizes the run and cancels its suspended item when resume can never succeed, then ticks dispatch.
// - tick(): repairs stale active and suspended items from their run metas and cancels needs_input items whose run was terminated before the queue write. The general paused-run binding (a provider suspension or an operator pause) blocks every waiting item; automatic resume belongs to the provider-recovery coordinator, not the queue. With no pause, the head waiting item dispatches only while the provider gate permits dispatch. An answered item resumes its paused run through the parked-answer path when it carries a tool-call pointer, or the clarification-answer path otherwise; when that run cannot be resumed the item falls back to the briefed dispatch with its lineage re-pointed at the unresumable run.
// - onRunSettled(meta): maps a settled run from its terminal meta, writes the mapping before ticking, and never settles an 'interrupted' meta (that item re-dispatches through boot repair). A suspended meta maps the active item to suspended without ticking, because the paused run retains priority. A needs_clarification settlement whose answer is still undelivered (either pause kind) releases the item to waiting and ticks instead of settling, so the answer retries.
// - observeShutdown(): closes the dispatch gate; settlements still map but no new run starts.
export interface TaskQueueModule {
	read(): QueueView
	enqueue(input: unknown, handles: QueueHandles, placement: QueuePlacement): Promise<QueueEnqueueOutcome>
	submitNow(input: unknown, handles: QueueHandles): Promise<QueueSubmitOutcome>
	patch(id: string, patch: QueuePatchInput): QueueMutationOutcome
	cancel(id: string, at: string): QueueMutationOutcome
	terminate(id: string, at: string): Promise<QueueMutationOutcome>
	answer(id: string, answer: string): Promise<QueueMutationOutcome>
	requeue(id: string): Promise<QueueMutationOutcome>
	reactivateErrorItem(runId: string): QueueMutationOutcome
	reactivateSuspendedItem(runId: string): QueueMutationOutcome
	// The run-level termination path: terminalizes the suspended run even when no queue item exists, cancels any suspended item bound to it, and ticks after the pause is released. Status gating lives in the caller; the result is the termination operation's own.
	terminateSuspendedRun(runId: string, at: string): Promise<TerminatePausedRunResult>
	// Cancels the suspended item for a run whose automatic resume can never succeed; the recovery coordinator has already released the pause and terminalizes the run through terminatePausedRun.
	discardSuspendedRun(runId: string, reason?: string): void
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

	// Cancels the suspended item bound to a run, if the queue still has one. The run-level termination path and the automatic-resume discard both need this queue-side half; a lost item is not an error, because the run meta is the source of truth for the pause.
	function cancelSuspendedItemForRun(runId: string, at: string): void {
		const queue = readQueueState()
		const target = queue.items.find((item) => item.status === 'suspended' && item.runId === runId)
		if (target === undefined) return
		const result = terminateSuspendedItem(queue, target.id, at)
		if (result.ok) writeQueueState(result.queue)
	}

	// Repairs every active and suspended item from its run's meta (docs/queueing.md state machine, the boot rows), and every needs_input item whose run was terminalized interrupted before its queue cancel landed, finishing that run's checkpoint/audit cleanup and writing when anything changed. Idempotent and cheap in steady state — a live or normally suspended run's item and a normally parked item are untouched.
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
				dependencies.terminatePausedRun(item.runId)
				changed = true
				return repaired
			}
			if (item.status === 'suspended') {
				const meta = item.runId !== undefined ? parseRunMetaText(item.runId) : null
				const settledAt = meta?.endTime ?? dependencies.now()
				const repaired = repairSuspendedItem(item, meta, settledAt)
				if (repaired === null) return item
				changed = true
				return repaired
			}
			if (item.status !== 'active') return item
			const meta = item.runId !== undefined ? parseRunMetaText(item.runId) : scanResumed()
			const pauseState = item.runId !== undefined ? dependencies.readPauseStateById(item.runId) : null
			const settledAt = meta?.endTime ?? dependencies.now()
			const repair = repairActiveItem(item, meta, settledAt, pauseState)
			if (repair === null) return item
			changed = true
			return repair
		})
		if (changed) writeQueueState({ ...queue, items })
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

	// The dispatch cycle shared by a first dispatch and an answer's fallback: write the dispatching marker (active, no runId), call submitRun, then fill the runId on acceptance, restore the item to waiting on run_in_progress, or sleep-and-retry on run_id_collision. Each write is a whole-file read-modify-write cycle; a collision sleep ends one cycle and the retry begins a fresh one that re-reads.
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
			// The slot is taken (a run is already going or a suspended run has priority): restore the item to waiting in the same synchronous cycle — the marker was already written, so leaving it as-is would orphan it as active-without-id until boot repair.
			if (result.error === 'run_in_progress' || result.error === 'run_suspended' || result.error === 'run_paused' || attempt >= MAX_COLLISION_RETRIES) {
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

	// Rewrites an answered item as waiting for the briefed dispatch: the resume pointers are dropped and the lineage is re-pointed at the run that could not be resumed, while the answer (and its id) stays for the briefing.
	function fallbackFromAnsweredItem(item: QueueItem, resumeRunId: string): ResumeAttempt {
		const current = readQueueState()
		const currentItem = current.items.find((entry) => entry.id === item.id)
		if (currentItem === undefined) return { kind: 'released' }
		const waiting = releaseToWaiting(currentItem, resumeRunId)
		delete waiting.resumeRunId
		delete waiting.resumeToolCallId
		writeQueueState(withReplacedItem(current, waiting))
		return { kind: 'fallback', item: waiting, view: current }
	}

	// Re-enters the paused run the answered item points at, writing an active marker under that run's id first so a settlement arriving while the resume starts finds the item. The tool-call pointer selects the parked-answer path; its absence selects the clarification-answer path. When the run can no longer be resumed the marker is rewritten as waiting without the resume pointers but with its lineage re-pointed at that run, keeping the answer for the briefed dispatch.
	async function resumeAnsweredItem(item: QueueItem, view: TaskQueue): Promise<ResumeAttempt> {
		const resumeRunId = item.resumeRunId
		const resumeToolCallId = item.resumeToolCallId
		const answer = item.answer
		const answerId = item.answerId
		const question = item.question
		if (resumeRunId === undefined || answer === undefined) return { kind: 'fallback', item, view }
		// A clarification resume cannot invent a blank question or answer id: release it to the briefed fallback instead.
		if (resumeToolCallId === undefined && (answerId === undefined || question === undefined)) return fallbackFromAnsweredItem(item, resumeRunId)
		const marker: QueueItem = { ...dispatchingItem(item), runId: resumeRunId }
		writeQueueState(withReplacedItem(view, marker))
		let result: ResumeParkedRunResult | ResumeClarificationRunResult
		if (resumeToolCallId !== undefined) {
			result = dependencies.resumeParkedRun(resumeRunId, { question: question ?? '', answer, toolCallId: resumeToolCallId })
		} else {
			if (answerId === undefined || question === undefined) return fallbackFromAnsweredItem(item, resumeRunId)
			result = dependencies.resumeClarificationRun(resumeRunId, { id: answerId, question, answer })
		}
		if (result.ok) return { kind: 'done' }
		if (result.error === 'run_in_progress' || result.error === 'run_suspended' || result.error === 'run_paused') {
			writeQueueState(withReplacedItem(readQueueState(), releaseToWaiting(marker)))
			return { kind: 'released' }
		}
		return fallbackFromAnsweredItem(item, resumeRunId)
	}

	async function dispatchHead(): Promise<void> {
		const view = readQueueState()
		const head = view.items.find((item) => item.status === 'waiting')
		if (head === undefined) return
		if (head.resumeRunId !== undefined && head.answer !== undefined) {
			const attempt = await resumeAnsweredItem(head, view)
			if (attempt.kind === 'done' || attempt.kind === 'released') return
			await submitHead(attempt.item, attempt.view)
			return
		}
		await submitHead(head, view)
	}

	// One dispatch attempt: repair stale active and suspended items (the boot rows of the state machine). The general paused-run binding (provider suspension or operator pause) keeps every waiting item blocked; the recovery coordinator owns automatic resume and reports health changes that call this tick. With no pause, waiting work dispatches only while the provider gate permits. Async only on the collision-retry path, whose sleep ends one read-modify-write cycle and whose retry begins a fresh one.
	const tick = async (): Promise<void> => {
		repairPass()
		if (shutdownObserved || dependencies.hasActiveRun() || dependencies.hasSuspendedRun()) return
		if (!dependencies.canDispatch()) {
			if (readQueueState().items.some((item) => item.status === 'waiting')) dependencies.ensureProviderProbe()
			return
		}
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
			// Checked before enqueueing so a busy service enqueues nothing, exactly as the 409 contract promises scripts. A paused run outranks waiting work, so a start-now request is refused until it is resumed or terminated.
			if (dependencies.hasActiveRun()) return { kind: 'busy' }
			if (dependencies.hasSuspendedRun()) return dependencies.pausedRunKind() === 'operator' ? { kind: 'run_paused' } : { kind: 'run_suspended' }
			if (!dependencies.canDispatch()) return { kind: 'provider_unavailable' }
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
		async terminate(id, at) {
			const queue = readQueueState()
			const target = queue.items.find((item) => item.id === id)
			if (target === undefined) return { ok: false, reason: 'not_found' }
			if (target.status !== 'needs_input' && target.status !== 'suspended') return { ok: false, reason: 'forbidden_status' }
			// Only the item's own run is terminalized: continuesFrom is lineage and may name another terminal run, and with no runId there is nothing to touch.
			if (target.runId !== undefined) dependencies.terminatePausedRun(target.runId)
			const result = target.status === 'suspended' ? terminateSuspendedItem(queue, id, at) : terminateNeedsInputItem(queue, id, at)
			if (!result.ok) return toMutationOutcome(result)
			writeQueueState(result.queue)
			await tick()
			return { ok: true, item: toQueueItemView(result.item) }
		},
		async answer(id, answer) {
			const queue = readQueueState()
			const target = queue.items.find((item) => item.id === id)
			if (target === undefined) return { ok: false, reason: 'not_found' }
			if (target.status !== 'needs_input') return { ok: false, reason: 'forbidden_status' }
			// A run terminated between the queue's park write and this answer is terminal but not parked: the answer is discarded and the item cancelled, never dispatched as a new briefed run. A needs_clarification meta is the live park and answers normally.
			const runMeta = target.runId !== undefined ? parseRunMetaText(target.runId) : null
			if (target.runId !== undefined && runMeta !== null && isTerminalRunStatus(runMeta.status) && runMeta.status !== 'needs_clarification') {
				// The run was terminalized before this answer arrived, so finish its checkpoint/audit cleanup and discard the answer.
				dependencies.terminatePausedRun(target.runId)
				const result = terminateNeedsInputItem(queue, id, dependencies.now())
				if (!result.ok) return toMutationOutcome(result)
				writeQueueState(result.queue)
				return { ok: true, item: toQueueItemView(result.item) }
			}
			const pausedRunId = target.runId
			const pausedMeta = runMeta
			const pauseState = pausedRunId !== undefined ? dependencies.readPauseStateById(pausedRunId) : null
			// A needs_input with no matching checkpoint keeps the briefed-continuation path. A parked ask whose question still matches records run id plus tool-call id; a clarification pause records just the run id when the meta still names this item's question.
			let resume: { runId: string; toolCallId?: string } | undefined
			if (pausedRunId !== undefined && pauseState !== null) {
				if (pauseState.kind === 'parked_ask' && pauseState.ask.question === target.question) resume = { runId: pausedRunId, toolCallId: pauseState.ask.toolCallId }
				if (pauseState.kind === 'clarification') {
					const metaQuestion = pausedMeta !== null && pausedMeta.status === 'needs_clarification' && pausedMeta.result?.summary !== undefined ? questionFromParkSummary(pausedMeta.result.summary) : undefined
					if (metaQuestion !== undefined && metaQuestion === target.question) resume = { runId: pausedRunId }
				}
			}
			const result = recordAnswer(queue, id, answer, dependencies.generateAnswerId(), resume)
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
		reactivateSuspendedItem(runId) {
			const result = reactivateSuspendedItem(readQueueState(), runId)
			if (result.ok) writeQueueState(result.queue)
			return toMutationOutcome(result)
		},
		async terminateSuspendedRun(runId, at) {
			const result = dependencies.terminatePausedRun(runId)
			cancelSuspendedItemForRun(runId, at)
			await tick()
			return result
		},
		discardSuspendedRun(runId, reason) {
			dependencies.terminatePausedRun(runId, reason)
			cancelSuspendedItemForRun(runId, dependencies.now())
			void tick()
		},
		tick,
		async onRunSettled(meta) {
			const queue = readQueueState()
			// A suspension (provider or operator) is a pause, not a task outcome: map the active item to suspended and stop. The tick is deliberately skipped — the paused run has priority and nothing may dispatch until it is resumed or terminated.
			if (meta.status === 'suspended') {
				const suspendedAt = meta.suspension?.suspendedAt ?? meta.pause?.pausedAt ?? dependencies.now()
				const suspension = suspendActiveItem(queue, meta.runId, suspendedAt)
				if (suspension.kind === 'suspended') writeQueueState(suspension.queue)
				return
			}
			const target = queue.items.find((item) => item.status === 'active' && item.runId === meta.runId)
			// A paused settlement whose answer is still undelivered for this exact run (the checkpoint still names the answered call, or has not yet recorded/consumed the clarification answer id) returns the answered item to waiting so the next tick retries it instead of settling to needs_input and dropping the answer.
			const pauseState = target !== undefined ? dependencies.readPauseStateById(meta.runId) : null
			if (target !== undefined && meta.status === 'needs_clarification' && pendingAnswerUndelivered(target, pauseState, meta.runId)) {
				const waiting = releaseToWaiting(target)
				writeQueueState(withReplacedItem(queue, waiting))
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
