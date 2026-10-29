import type { QueueItemView } from '../executor/queue/model.js'
import type { RunSnapshotStats } from '../executor/persistence.js'
import { isSameFileStat } from '../executor/persistence.js'
import type { LogEvent } from '../executor/types.js'
import { isRunIdShape } from '../executor/run-id.js'
import { parseLogEventLine, parseRunMeta } from '../run-log/parse.js'
import {
	TASK_THREAD_FORMAT_VERSION,
	TASK_THREAD_MAX_ENTRIES,
	TASK_THREAD_MAX_ENTRIES_PER_RUN,
	TASK_THREAD_MAX_LATEST_HUMAN_CHIP_CHARS,
	TASK_THREAD_MAX_LINEAGE_RUNS,
	TASK_THREAD_MAX_TEXT_CHARS,
} from './model.js'
import type { TaskIdentity, TaskThreadEntry, TaskThreadResponse } from './model.js'
import { deriveRunThreadFacts } from './derive.js'
import type { RunThreadFacts } from './derive.js'
import { deriveTaskThread } from './identity.js'
import type { TaskThreadSummarySnapshot } from './summarizer.js'

export type ReadTaskThreadMetaTextById = (runId: string) => string | null
export type ReadTaskThreadLogTextFromById = (runId: string, byteOffset: number) => string
export type ReadTaskThreadQueueItems = () => readonly QueueItemView[]
export type PeekTaskThreadSummary = (runId: string, identity: TaskIdentity, entries: readonly TaskThreadEntry[]) => TaskThreadSummarySnapshot

export interface TaskThreadCore {
	runId: string
	identity: TaskIdentity
	entries: TaskThreadEntry[]
	truncated: {
		entries: boolean
		text: boolean
		lineage: boolean
	}
}

export interface TaskThreadCoreReaderDependencies {
	readRunMetaTextById: ReadTaskThreadMetaTextById
	readRunLogTextFromById: ReadTaskThreadLogTextFromById
	readRunSnapshotStats: (runId: string) => RunSnapshotStats
	readQueueItems: ReadTaskThreadQueueItems
}

export interface TaskThreadReaderDependencies {
	readTaskThreadCore: (runId: string) => TaskThreadCore | null
	peekSummary: PeekTaskThreadSummary
}

// The marker list includes every event type the derivation can consume; a payload string that contains a marker also parses and is discarded downstream, so the filter can only fail by never skipping a relevant line.
const TASK_THREAD_EVENT_MARKERS = [
	'"type":"role_start"',
	'"type":"role_finished"',
	'"type":"ask_human"',
	'"type":"human_answer"',
	'"type":"run_resumed"',
	'"type":"interrupt"',
	'"type":"interrupt_resolved"',
	'"type":"plan_modification"',
	'"type":"inquiry_dropped"',
	'"type":"operator_notice"',
	'"type":"provider_failure"',
	'"type":"run_terminated"',
] as const

const MAX_CACHED_RELEVANT_EVENTS = 200
const MAX_CACHED_RELEVANT_BYTES = 200_000
const MAX_CACHED_RUN_SOURCES = 64

interface ParsedRegion {
	events: LogEvent[]
	consumedBytes: number
}

interface RunSources {
	metaText: string | null
	events: LogEvent[]
	logAvailable: boolean
	eventsTruncated: boolean
}

interface CachedRunSources {
	freshness: RunSnapshotStats
	metaText: string | null
	events: LogEvent[]
	logOffset: number
	logAvailable: boolean
	eventsTruncated: boolean
}

function parseRelevantEventLine(line: string): LogEvent | null {
	if (!TASK_THREAD_EVENT_MARKERS.some((marker) => line.includes(marker))) return null
	return parseLogEventLine(line)
}

function parseRelevantEvents(logText: string): LogEvent[] {
	const events: LogEvent[] = []
	for (const line of logText.split('\n')) {
		const event = parseRelevantEventLine(line)
		if (event !== null) events.push(event)
	}
	return events
}

// Mirrors the snapshot cache's torn-tail rule: a complete newline-terminated region is settled, and a trailing fragment is consumed only when it already parses as a complete event.
function parseRelevantRegion(logText: string): ParsedRegion {
	const lastNewline = logText.lastIndexOf('\n')
	const completeText = lastNewline === -1 ? '' : logText.slice(0, lastNewline + 1)
	const events = parseRelevantEvents(completeText)
	const trailingLine = logText.slice(completeText.length)
	const trailingEvent = parseRelevantEventLine(trailingLine)
	if (trailingEvent !== null) {
		events.push(trailingEvent)
		return { events, consumedBytes: Buffer.byteLength(logText, 'utf8') }
	}
	return { events, consumedBytes: Buffer.byteLength(completeText, 'utf8') }
}

function eventBytes(event: LogEvent): number {
	return Buffer.byteLength(JSON.stringify(event), 'utf8')
}

function boundCachedEvents(events: readonly LogEvent[], alreadyTruncated: boolean): { events: LogEvent[], truncated: boolean } {
	let start = 0
	let bytes = 0
	for (const event of events) bytes += eventBytes(event)
	let truncated = alreadyTruncated
	while (start < events.length && (events.length - start > MAX_CACHED_RELEVANT_EVENTS || bytes > MAX_CACHED_RELEVANT_BYTES)) {
		const removed = events[start]
		if (removed !== undefined) bytes -= eventBytes(removed)
		start++
		truncated = true
	}
	return { events: start === 0 ? [...events] : events.slice(start), truncated }
}

function threadOptions(): Parameters<typeof deriveTaskThread>[2] {
	return {
		maxRuns: TASK_THREAD_MAX_LINEAGE_RUNS,
		maxEntries: TASK_THREAD_MAX_ENTRIES,
		maxEntriesPerRun: TASK_THREAD_MAX_ENTRIES_PER_RUN,
		maxTextChars: TASK_THREAD_MAX_TEXT_CHARS,
		maxLatestHumanChipChars: TASK_THREAD_MAX_LATEST_HUMAN_CHIP_CHARS,
	}
}

export function createTaskThreadCoreReader(dependencies: TaskThreadCoreReaderDependencies): (runId: string) => TaskThreadCore | null {
	const options = threadOptions()
	const cache = new Map<string, CachedRunSources>()
	function remember(runId: string, entry: CachedRunSources): void {
		cache.delete(runId)
		cache.set(runId, entry)
		if (cache.size > MAX_CACHED_RUN_SOURCES) {
			const oldest = cache.keys().next().value
			if (oldest !== undefined) cache.delete(oldest)
		}
	}
	function readRunSources(runId: string): RunSources | null {
		const freshness = dependencies.readRunSnapshotStats(runId)
		if (freshness.meta === null && freshness.log === null) return null
		const cached = cache.get(runId)
		let metaText: string | null
		let events: LogEvent[]
		let logOffset: number
		let logAvailable: boolean
		let eventsTruncated: boolean
		if (cached === undefined) {
			metaText = dependencies.readRunMetaTextById(runId)
			const full = parseRelevantRegion(dependencies.readRunLogTextFromById(runId, 0))
			const bounded = boundCachedEvents(full.events, false)
			events = bounded.events
			logOffset = full.consumedBytes
			logAvailable = full.consumedBytes > 0
			eventsTruncated = bounded.truncated
		} else {
			metaText = isSameFileStat(cached.freshness.meta, freshness.meta) ? cached.metaText : dependencies.readRunMetaTextById(runId)
			if (isSameFileStat(cached.freshness.log, freshness.log)) {
				events = cached.events
				logOffset = cached.logOffset
				logAvailable = cached.logAvailable
				eventsTruncated = cached.eventsTruncated
			} else if (freshness.log !== null && cached.freshness.log !== null && freshness.log.size > cached.freshness.log.size && freshness.log.size >= cached.logOffset) {
				// The run log is append-only by contract; growth is therefore a true tail. A larger rewrite would be indistinguishable from an append here, so callers must preserve the append-only invariant.
				const tail = parseRelevantRegion(dependencies.readRunLogTextFromById(runId, cached.logOffset))
				const bounded = boundCachedEvents([...cached.events, ...tail.events], cached.eventsTruncated)
				events = bounded.events
				logOffset = cached.logOffset + tail.consumedBytes
				logAvailable = true
				eventsTruncated = bounded.truncated
			} else {
				const full = parseRelevantRegion(dependencies.readRunLogTextFromById(runId, 0))
				const bounded = boundCachedEvents(full.events, false)
				events = bounded.events
				logOffset = full.consumedBytes
				logAvailable = full.consumedBytes > 0
				eventsTruncated = bounded.truncated
			}
		}
		remember(runId, { freshness, metaText, events, logOffset, logAvailable, eventsTruncated })
		return { metaText, events, logAvailable, eventsTruncated }
	}
	return (runId) => {
		if (!isRunIdShape(runId)) return null
		const currentSources = readRunSources(runId)
		if (currentSources === null) return null
		const queueItems = dependencies.readQueueItems()
		let eventsTruncated = currentSources.eventsTruncated
		const factsFor = (targetRunId: string, sources: RunSources): RunThreadFacts => deriveRunThreadFacts({
			runId: targetRunId,
			metaText: sources.metaText,
			events: sources.events,
			queueItems,
			logAvailable: sources.logAvailable,
		})
		const current = factsFor(runId, currentSources)
		const lookupRun = (parentRunId: string): RunThreadFacts | null => {
			const parentSources = readRunSources(parentRunId)
			if (parentSources === null || parentSources.metaText === null) return null
			if (parentSources.eventsTruncated) eventsTruncated = true
			const parentMeta = parseRunMeta(parentSources.metaText)
			if (parentMeta === null || parentMeta.runId !== parentRunId) return null
			return factsFor(parentRunId, parentSources)
		}
		const derived = deriveTaskThread(current, lookupRun, { ...options, sourcesTruncated: eventsTruncated })
		return {
			runId,
			identity: derived.identity,
			entries: derived.entries,
			truncated: { ...derived.truncated, entries: derived.truncated.entries || eventsTruncated },
		}
	}
}

export function createTaskThreadReader(dependencies: TaskThreadReaderDependencies): (runId: string) => TaskThreadResponse | null {
	return (runId) => {
		const core = dependencies.readTaskThreadCore(runId)
		if (core === null) return null
		const summary = dependencies.peekSummary(runId, core.identity, core.entries)
		return {
			formatVersion: TASK_THREAD_FORMAT_VERSION,
			runId,
			identity: core.identity,
			entries: core.entries,
			summary: summary.summary,
			summaryState: summary.state,
			truncated: core.truncated,
		}
	}
}
