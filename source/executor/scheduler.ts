import type { Sleep } from './llm.js'
import type { ListRunIds, ReadRunMetaById, ReadTaskQueue, WriteTaskQueue } from './persistence.js'
import { assembleBriefingLines, dispatchingItem, releaseToWaiting, repairActiveItem, settleActiveItem, withReplacedItem, type QueueItem, type RunListEntry } from './task-queue.js'
import { isRunMeta, isTerminalRunStatus, safeJsonParse } from './validation.js'
import type { EffortLevel, LogLevel, RunContinuation, RunMeta } from './types.js'
import type { SubmitResult } from './run-submission.js'

// The platform scheduler (docs/queueing.md "Dispatch and the scheduler"): dispatches queued tasks as runs whenever the single run slot is free. Dispatch is platform code, never the LLM, and the scheduler is the only caller of submission in the dispatch path.

// The shaped submission the scheduler hands to the submission layer: the item's task, its effort and logLevel overrides, and the continuation assembled from the item's lineage (the prior run's terminal meta) plus the interim briefing. Omitting any of these would silently drop lineage or the log-level override for queue-tracked runs.
export interface QueuedRunSubmission {
	task: string
	effort?: EffortLevel
	logLevel?: LogLevel
	continuation?: RunContinuation
}

export type SubmitQueuedRun = (submission: QueuedRunSubmission) => SubmitResult

export interface TaskSchedulerDependencies {
	readQueue: ReadTaskQueue
	writeQueue: WriteTaskQueue
	// The run-meta reader leaf (the raw meta.json text): boot repair of stale active items and continuation assembly from the parked or errored run's meta both parse through it.
	readRunMetaById: ReadRunMetaById
	listRunIds: ListRunIds
	// The run-list summary reader: enumerates each run's one-line summary (null when the summarizer has produced none) alongside its task, which the briefing assembles from.
	readRunListSummary: (runId: string) => RunListEntry
	submitRun: SubmitQueuedRun
	// The single-run-slot peek: when a run is active (the boot-resumed case) the tick is a true no-op — no dispatching-marker write, no submitRun probe — matching the design's "finds the slot busy and no-ops". The settlement hook's tick sees the slot already cleared.
	hasActiveRun: () => boolean
	sleep: Sleep
	now: () => string
}

export interface TaskScheduler {
	tick(): Promise<void>
	// The settlement hook the submission layer invokes on a fulfilled run promise: maps the settled run's item from the terminal meta (the mapping write precedes the settlement tick it triggers) and then ticks.
	onRunSettled(meta: RunMeta): Promise<void>
	// Flips the shutdown gate: ticks still map settled items but start no new run, so a run finishing inside the shutdown drain cannot tick a fresh dispatch the process would abandon at exit.
	observeShutdown(): void
}

// A collision retry sleeps past the one-second run-id resolution — an immediate retry regenerates the same id — before re-reading the queue for a fresh attempt.
export const COLLISION_RETRY_DELAY_MS = 1100
// The bound on collision retries; a retry budget exhausted releases the item to waiting for the next tick.
export const MAX_COLLISION_RETRIES = 3

export function createTaskScheduler(dependencies: TaskSchedulerDependencies): TaskScheduler {
	let shutdownObserved = false

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

	// Repairs every active item from its run's meta (docs/queueing.md state machine, the boot rows) and writes the queue when anything changed. Idempotent and cheap in steady state — a live run's item is untouched and no other item is ever active.
	function repairPass(): void {
		const queue = dependencies.readQueue()
		if (!queue.items.some((item) => item.status === 'active')) return
		let resumedMeta: RunMeta | null | undefined
		const scanResumed = (): RunMeta | null => {
			if (resumedMeta === undefined) resumedMeta = findUniqueRunningMeta()
			return resumedMeta
		}
		let changed = false
		const items = queue.items.map((item) => {
			if (item.status !== 'active') return item
			const meta = item.runId !== undefined ? parseRunMetaText(item.runId) : scanResumed()
			const settledAt = meta?.endTime ?? dependencies.now()
			const repair = repairActiveItem(item, meta, settledAt)
			if (repair.item === item) return item
			changed = true
			return repair.item
		})
		if (changed) dependencies.writeQueue({ items })
	}

	function assembleSubmission(item: QueueItem, queueItems: QueueItem[]): QueuedRunSubmission {
		const runs = dependencies.listRunIds().map((runId) => dependencies.readRunListSummary(runId))
		const briefing = assembleBriefingLines({
			queuedAt: item.queuedAt,
			items: queueItems,
			runs,
			...(item.question !== undefined ? { question: item.question } : {}),
			...(item.answer !== undefined ? { answer: item.answer } : {}),
		})
		const overrides = {
			...(item.effort !== undefined ? { effort: item.effort } : {}),
			...(item.logLevel !== undefined ? { logLevel: item.logLevel } : {}),
		}
		if (item.continuesFrom !== undefined) {
			const priorMeta = parseRunMetaText(item.continuesFrom)
			// Exactly the continuation assembly handleCreateRun does today: the prior run's task and result summary from its terminal meta. An unreadable or non-terminal prior meta degrades to a briefing-only dispatch rather than dropping the item's run.
			if (priorMeta !== null && isTerminalRunStatus(priorMeta.status)) {
				return {
					task: item.task,
					...overrides,
					continuation: {
						runId: item.continuesFrom,
						task: priorMeta.task,
						summary: priorMeta.result?.summary ?? '',
						briefing,
					},
				}
			}
		}
		// A first queue dispatch records no lineage because there is none — the continuation carries only the briefing, and runId stays unset so meta.continuesFrom stays honest.
		return { task: item.task, ...overrides, continuation: { task: item.task, summary: '', briefing } }
	}

	// The dispatch cycles: write the dispatching marker (active, no runId), call submitRun, then fill the runId on acceptance, restore the item to waiting on run_in_progress, or sleep-and-retry on run_id_collision. Each write is a whole-file read-modify-write cycle; a collision sleep ends one cycle and the retry begins a fresh one that re-reads.
	async function dispatchHead(): Promise<void> {
		let view = dependencies.readQueue()
		const head = view.items.find((item) => item.status === 'waiting')
		if (head === undefined) return
		// The marker is written before submitRun so a crash after a successful submit leaves an active-without-id item the boot tick repairs by bind-or-release — never a stale waiting item that would re-dispatch behind its own duplicate.
		const marker = dispatchingItem(head)
		dependencies.writeQueue(withReplacedItem(view, marker))
		for (let attempt = 0; ; attempt++) {
			const result = dependencies.submitRun(assembleSubmission(marker, view.items))
			if (result.ok) {
				dependencies.writeQueue(withReplacedItem(view, { ...marker, runId: result.runId }))
				return
			}
			// The slot is taken (a run is already going): restore the item to waiting in the same synchronous cycle — the marker was already written, so leaving it as-is would orphan it as active-without-id until boot repair.
			if (result.error === 'run_in_progress' || attempt >= MAX_COLLISION_RETRIES) {
				dependencies.writeQueue(withReplacedItem(view, releaseToWaiting(marker)))
				return
			}
			await dependencies.sleep(COLLISION_RETRY_DELAY_MS)
			// The sleep let other queue mutations interleave, so the retry re-reads and continues only while the item is still this tick's unbound marker; otherwise it now belongs to another cycle.
			view = dependencies.readQueue()
			const current = view.items.find((item) => item.id === marker.id)
			if (current === undefined || current.status !== 'active' || current.runId !== undefined) return
		}
	}

	// One dispatch attempt: repair stale active items (the boot rows of the state machine), then dispatch the head waiting item — unless the slot is busy (a true no-op) or the shutdown gate is closed. Async only on the collision-retry path, whose sleep ends one read-modify-write cycle and whose retry begins a fresh one.
	const tick = async (): Promise<void> => {
		repairPass()
		if (shutdownObserved || dependencies.hasActiveRun()) return
		await dispatchHead()
	}

	return {
		tick,
		async onRunSettled(meta) {
			const queue = dependencies.readQueue()
			const settlement = settleActiveItem(queue, meta.runId, meta, dependencies.now())
			if (settlement.kind === 'settled') dependencies.writeQueue(settlement.queue)
			await tick()
		},
		observeShutdown() {
			shutdownObserved = true
		},
	}
}
