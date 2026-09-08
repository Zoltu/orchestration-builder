import type { ReadRunLogTextFrom, ReadRunMetaById, ReadRunSnapshotStats, RunSnapshotStats } from '../executor/persistence.js'
import { isSameFileStat } from '../executor/persistence.js'
import type { LogEvent } from '../executor/types.js'
import { parseLogEventLine, parseLogEvents, parseRunMeta, type RunSnapshot } from './render.js'

export type ReadRunSnapshot = (runId: string) => RunSnapshot

interface CacheEntry {
	freshness: RunSnapshotStats
	snapshot: RunSnapshot
	// Byte offset of the first log byte not yet settled: everything before it is parsed into the snapshot or deliberately skipped. The log is append-only, so on a freshness change whose size only grew, the delta is exactly the bytes from here on; a trailing line that did not parse stays outside this offset and is re-read whole once its write completes.
	logOffset: number
}

export interface SnapshotCacheDependencies {
	readStats: ReadRunSnapshotStats
	readMetaText: ReadRunMetaById
	readLogTextFrom: ReadRunLogTextFrom
}

interface LogTextParse {
	events: LogEvent[]
	consumedBytes: number
}

// Splits a log region into events with the shared per-line semantics and reports how many bytes are settled. A trailing line without its newline is consumed only when it parses as a complete event — a JSON object is prefix-free, so a parseable fragment is the whole event whose newline write is still in flight, and its pending newline arrives as a skippable empty line later. Anything else stays unparsed and the byte count stops before it, so the completing write parses the line exactly once.
function parseLogText(logText: string): LogTextParse {
	const lastNewline = logText.lastIndexOf('\n')
	const completeText = lastNewline === -1 ? '' : logText.slice(0, lastNewline + 1)
	const events = parseLogEvents(completeText)
	const trailingLine = logText.slice(completeText.length)
	const trailingEvent = parseLogEventLine(trailingLine)
	if (trailingEvent !== null) {
		events.push(trailingEvent)
		return { events, consumedBytes: Buffer.byteLength(logText, 'utf8') }
	}
	return { events, consumedBytes: Buffer.byteLength(completeText, 'utf8') }
}

function isFresh(cached: RunSnapshotStats, current: RunSnapshotStats): boolean {
	return isSameFileStat(cached.meta, current.meta) && isSameFileStat(cached.log, current.log)
}

// Builds the entry for a poll whose freshness key missed. The meta is re-read only when its own stat changed, and the log contributes either nothing (meta-only change), just its appended tail (grew past the stored offset), or a full re-parse (first read, shrink, or any other anomaly).
function refreshEntry(dependencies: SnapshotCacheDependencies, runId: string, freshness: RunSnapshotStats, cached: CacheEntry | undefined): CacheEntry {
	if (cached === undefined) {
		const full = parseLogText(dependencies.readLogTextFrom(runId, 0))
		return { freshness, snapshot: { meta: parseRunMeta(dependencies.readMetaText(runId)), logEvents: full.events }, logOffset: full.consumedBytes }
	}
	const meta = isSameFileStat(cached.freshness.meta, freshness.meta) ? cached.snapshot.meta : parseRunMeta(dependencies.readMetaText(runId))
	const currentLog = freshness.log
	const cachedLog = cached.freshness.log
	if (isSameFileStat(cachedLog, currentLog)) {
		return { freshness, snapshot: { meta, logEvents: cached.snapshot.logEvents }, logOffset: cached.logOffset }
	}
	if (currentLog !== null && cachedLog !== null && currentLog.size > cachedLog.size && currentLog.size >= cached.logOffset) {
		const tail = parseLogText(dependencies.readLogTextFrom(runId, cached.logOffset))
		return { freshness, snapshot: { meta, logEvents: [...cached.snapshot.logEvents, ...tail.events] }, logOffset: cached.logOffset + tail.consumedBytes }
	}
	const full = parseLogText(dependencies.readLogTextFrom(runId, 0))
	return { freshness, snapshot: { meta, logEvents: full.events }, logOffset: full.consumedBytes }
}

// Caches parsed run snapshots keyed by run id, validating freshness by file stats (size + mtime) instead of re-reading and re-parsing the full log on every request. The client polls the run list every second and the selected run's two endpoints in lockstep, so an uncached parse per request is O(total run history) per second — and llm_call events carry full prompts, so logs grow large. An unchanged poll costs two stat calls; a changed poll re-reads meta.json only when its stat moved and, when the append-only log grew, parses only the bytes past the stored offset, so an active run costs one small tail read per poll. A shrunk or rewritten log, or any other stat anomaly, falls back to a full re-read and re-parse. A write racing a stat or tail read resolves itself on the next poll: the stale freshness key no longer matches and the delta is picked up from the offset.
// Bounded with LRU eviction: runs accumulate forever on a long-lived service and a parsed snapshot is large, so the cache must not grow with run history. The per-run endpoints only ever touch the selected run, so a small bound loses nothing.
export function createSnapshotCache(dependencies: SnapshotCacheDependencies, maxEntries: number): ReadRunSnapshot {
	const entries = new Map<string, CacheEntry>()
	return (runId) => {
		const freshness = dependencies.readStats(runId)
		const cached = entries.get(runId)
		if (cached !== undefined && isFresh(cached.freshness, freshness)) {
			entries.delete(runId)
			entries.set(runId, cached)
			return cached.snapshot
		}
		const entry = refreshEntry(dependencies, runId, freshness, cached)
		// Re-insert (not just overwrite) so a run that keeps rebuilding stays recency-fresh like a hit does; Map.set on an existing key keeps the original insertion order.
		entries.delete(runId)
		entries.set(runId, entry)
		while (entries.size > maxEntries) {
			const eldest = entries.keys().next()
			if (eldest.done) break
			entries.delete(eldest.value)
		}
		return entry.snapshot
	}
}
