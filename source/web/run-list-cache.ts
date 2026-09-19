import type { ReadRunMetaById, ReadRunSummaryById, ReadRunSummaryStats, RunSummaryStats } from '../executor/persistence.js'
import { isSameFileStat } from '../executor/persistence.js'
import { createLruReadCache } from './lru-cache.js'
import { parseRunMeta, renderRunSummary, type RunSummary } from './render.js'

export type ReadRunListSummary = (runId: string) => RunSummary

interface RunListCacheEntry {
	freshness: RunSummaryStats
	summary: RunSummary
}

export interface RunListCacheDependencies {
	readRunSummaryStats: ReadRunSummaryStats
	readRunMetaById: ReadRunMetaById
	readRunSummaryById: ReadRunSummaryById
}

// Caches rendered run-list summaries keyed by the stats of the two files a summary derives from (meta.json and summary.txt — the completion summary replaces the start one at a moment when meta.json does not change, so both files must be in the freshness key). The client polls the run list every second and the list touches every run directory per poll, so an unchanged run costs two stat calls instead of two file reads plus a meta JSON parse, and only runs whose files changed are re-read.
// Bounded with LRU eviction: runs accumulate forever on a long-lived service, so the cache must not grow with run history; beyond the cap the least-recently-touched entries re-read, the same trade the snapshot cache makes with a smaller bound.
export function createRunListCache(dependencies: RunListCacheDependencies, maxEntries: number): ReadRunListSummary {
	const readEntry = createLruReadCache<RunListCacheEntry>(maxEntries)
	return (runId) => {
		const freshness = dependencies.readRunSummaryStats(runId)
		return readEntry(
			runId,
			(cached) => isSameFileStat(cached.freshness.meta, freshness.meta) && isSameFileStat(cached.freshness.summary, freshness.summary),
			() => ({ freshness, summary: renderRunSummary(runId, parseRunMeta(dependencies.readRunMetaById(runId)), dependencies.readRunSummaryById(runId)) }),
		).summary
	}
}
