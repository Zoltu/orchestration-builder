import type { ReadRunSnapshotById, ReadRunSnapshotStats, RunSnapshotFileStat, RunSnapshotStats } from '../executor/persistence.js'
import { parseRunSnapshot, type RunSnapshot } from './render.js'

export type ReadRunSnapshot = (runId: string) => RunSnapshot

interface CacheEntry {
	freshness: RunSnapshotStats
	snapshot: RunSnapshot
}

export interface SnapshotCacheDependencies {
	readStats: ReadRunSnapshotStats
	readRaw: ReadRunSnapshotById
}

function sameStat(a: RunSnapshotFileStat | null, b: RunSnapshotFileStat | null): boolean {
	if (a === null || b === null) return a === b
	return a.size === b.size && a.mtimeMs === b.mtimeMs
}

function isFresh(cached: RunSnapshotStats, current: RunSnapshotStats): boolean {
	return sameStat(cached.meta, current.meta) && sameStat(cached.log, current.log)
}

// Caches parsed run snapshots keyed by run id, validating freshness by file stats (size + mtime) instead of re-reading and re-parsing the full log on every request. The client polls the run list every second and the selected run's two endpoints in lockstep, so an uncached parse per request is O(total run history) per second — and llm_call events carry full prompts, so logs grow large. With the cache, an unchanged poll costs two stat calls. The log is append-only, so every event changes its size; meta.json is rewritten wholesale, changing its mtime. A write racing the stat read resolves itself on the next poll: the stale freshness key no longer matches and the entry is rebuilt.
// Bounded with LRU eviction: runs accumulate forever on a long-lived service and a parsed snapshot is large, so the cache must not grow with run history. The per-run endpoints only ever touch the selected run, so a small bound loses nothing.
export function createSnapshotCache(dependencies: SnapshotCacheDependencies, maxEntries: number): ReadRunSnapshot {
	const entries = new Map<string, CacheEntry>()
	return (runId: string) => {
		const freshness = dependencies.readStats(runId)
		const cached = entries.get(runId)
		if (cached !== undefined && isFresh(cached.freshness, freshness)) {
			entries.delete(runId)
			entries.set(runId, cached)
			return cached.snapshot
		}
		const snapshot = parseRunSnapshot(dependencies.readRaw(runId))
		entries.set(runId, { freshness, snapshot })
		while (entries.size > maxEntries) {
			const eldest = entries.keys().next()
			if (eldest.done) break
			entries.delete(eldest.value)
		}
		return snapshot
	}
}
