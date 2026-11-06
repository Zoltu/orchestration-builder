import type { QueueItemView } from '../executor/queue/model.js'
import type { LogEvent } from '../executor/types.js'
import { isRunIdShape } from '../executor/run-id.js'
import { parseRunMeta } from '../run-log/parse.js'
import {
	TASK_THREAD_FORMAT_VERSION,
	TASK_THREAD_MAX_LATEST_HUMAN_CHIP_CHARS,
	TASK_THREAD_MAX_LINEAGE_RUNS,
} from './model.js'
import type { TaskIdentity, TaskThreadEntry, TaskThreadResponse, TaskThreadRunInfo } from './model.js'
import { deriveRunThreadFacts } from './derive.js'
import type { RunThreadFacts } from './derive.js'
import { deriveTaskThread } from './identity.js'
import type { ThreadJournalRead } from './journal-store.js'
import { paginateTaskThreadEntries } from './pagination.js'
import type { TaskThreadPageRequest } from './pagination.js'
import { threadFingerprint } from './summary.js'
import type { TaskThreadSummarySnapshot } from './summarizer.js'

export type ReadTaskThreadMetaTextById = (runId: string) => string | null
export type ReadTaskThreadJournal = (runId: string) => ThreadJournalRead | null
export type ReadTaskThreadQueueItems = () => readonly QueueItemView[]
export type PeekTaskThreadSummary = (runId: string, identity: TaskIdentity, entries: readonly TaskThreadEntry[], fingerprint: string) => TaskThreadSummarySnapshot

export interface TaskThreadCore {
	runId: string
	identity: TaskIdentity
	entries: TaskThreadEntry[]
	runs: TaskThreadRunInfo[]
	truncated: {
		entries: boolean
		text: boolean
		lineage: boolean
	}
}

export interface TaskThreadCoreReaderDependencies {
	readRunMetaTextById: ReadTaskThreadMetaTextById
	readThreadJournal: ReadTaskThreadJournal
	readQueueItems: ReadTaskThreadQueueItems
}

export interface TaskThreadReaderDependencies {
	readTaskThreadCore: (runId: string) => TaskThreadCore | null
	peekSummary: PeekTaskThreadSummary
}

interface RunSources {
	metaText: string | null
	events: LogEvent[]
	complete: boolean
}

function threadOptions(): Parameters<typeof deriveTaskThread>[2] {
	return {
		maxRuns: TASK_THREAD_MAX_LINEAGE_RUNS,
		maxLatestHumanChipChars: TASK_THREAD_MAX_LATEST_HUMAN_CHIP_CHARS,
	}
}

function taskThreadRunInfo(facts: RunThreadFacts): TaskThreadRunInfo {
	return {
		runId: facts.runId,
		effort: facts.meta?.effort ?? null,
		involvement: facts.meta?.involvement ?? null,
	}
}

export function createTaskThreadCoreReader(dependencies: TaskThreadCoreReaderDependencies): (runId: string) => TaskThreadCore | null {
	const options = threadOptions()
	function readRunSources(runId: string): RunSources | null {
		const metaText = dependencies.readRunMetaTextById(runId)
		const journal = dependencies.readThreadJournal(runId)
		if (metaText === null && journal === null) return null
		return { metaText, events: journal?.events ?? [], complete: journal?.complete ?? false }
	}
	return (runId) => {
		if (!isRunIdShape(runId)) return null
		const currentSources = readRunSources(runId)
		if (currentSources === null) return null
		let incomplete = !currentSources.complete
		const queueItems = dependencies.readQueueItems()
		const factsFor = (targetRunId: string, sources: RunSources): RunThreadFacts => deriveRunThreadFacts({
			runId: targetRunId,
			metaText: sources.metaText,
			events: sources.events,
			queueItems,
			logAvailable: sources.complete,
		})
		const current = factsFor(runId, currentSources)
		const lookupRun = (parentRunId: string): RunThreadFacts | null => {
			const parentSources = readRunSources(parentRunId)
			if (parentSources === null || parentSources.metaText === null) return null
			if (!parentSources.complete) incomplete = true
			const parentMeta = parseRunMeta(parentSources.metaText)
			if (parentMeta === null || parentMeta.runId !== parentRunId) return null
			return factsFor(parentRunId, parentSources)
		}
		const derived = deriveTaskThread(current, lookupRun, options)
		return {
			runId,
			identity: derived.identity,
			entries: derived.entries,
			runs: derived.runs.map(taskThreadRunInfo),
			truncated: { entries: derived.truncated.entries || incomplete, text: false, lineage: derived.truncated.lineage },
		}
	}
}

export const TASK_THREAD_INVALID_CURSOR = { kind: 'invalid_cursor' } as const

export type TaskThreadInvalidCursor = typeof TASK_THREAD_INVALID_CURSOR
export type TaskThreadReaderResult = TaskThreadResponse | TaskThreadInvalidCursor | null

export function createTaskThreadReader(dependencies: TaskThreadReaderDependencies): (runId: string, request?: TaskThreadPageRequest) => TaskThreadReaderResult {
	return (runId, request) => {
		const core = dependencies.readTaskThreadCore(runId)
		if (core === null) return null
		const pageResult = paginateTaskThreadEntries(core.entries, request ?? {})
		if (pageResult.kind === 'invalid_cursor') return TASK_THREAD_INVALID_CURSOR
		const fingerprint = threadFingerprint(core.identity, core.entries)
		const summary = dependencies.peekSummary(runId, core.identity, core.entries, fingerprint)
		return {
			formatVersion: TASK_THREAD_FORMAT_VERSION,
			runId,
			identity: core.identity,
			entries: pageResult.page.entries,
			pagination: pageResult.page.pagination,
			threadFingerprint: fingerprint,
			runs: core.runs,
			summary: summary.summary,
			summaryState: summary.state,
			truncated: core.truncated,
		}
	}
}
