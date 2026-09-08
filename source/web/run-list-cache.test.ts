import { describe, expect, test } from 'bun:test'
import type { RunSummaryStats } from '../executor/persistence.ts'
import { createRunListCache } from './run-list-cache.ts'

// An in-memory fake behind the three leaves the run-list cache composes: meta text, summary text, and a monotonic clock so tests bump freshness explicitly (mtime) rather than sleeping. The readers count calls so a test can assert an unchanged poll re-reads nothing. Both readers mirror their filesystem leaves (absent file reads as null; a whitespace-only summary reads as absent).
function createFakeBackend() {
	const metaFiles = new Map<string, string | null>()
	const summaryFiles = new Map<string, string | null>()
	const metaMtimes = new Map<string, number>()
	const summaryMtimes = new Map<string, number>()
	let metaReads = 0
	let summaryReads = 0
	let clock = 1
	return {
		writeMeta(runId: string, metaText: string | null) {
			metaFiles.set(runId, metaText)
			metaMtimes.set(runId, clock)
			clock += 1
		},
		writeSummary(runId: string, summaryText: string | null) {
			summaryFiles.set(runId, summaryText)
			summaryMtimes.set(runId, clock)
			clock += 1
		},
		metaReads: () => metaReads,
		summaryReads: () => summaryReads,
		readRunSummaryStats(runId: string): RunSummaryStats {
			const metaText = metaFiles.get(runId)
			const summaryText = summaryFiles.get(runId)
			return {
				meta: metaText === undefined || metaText === null ? null : { size: metaText.length, mtimeMs: metaMtimes.get(runId) ?? 0 },
				summary: summaryText === undefined || summaryText === null || summaryText.trim() === '' ? null : { size: summaryText.length, mtimeMs: summaryMtimes.get(runId) ?? 0 },
			}
		},
		readRunMetaById(runId: string): string | null {
			metaReads += 1
			return metaFiles.get(runId) ?? null
		},
		readRunSummaryById(runId: string): string | null {
			summaryReads += 1
			const text = summaryFiles.get(runId)
			if (text === undefined || text === null) return null
			const trimmed = text.trim()
			return trimmed === '' ? null : trimmed
		},
	}
}

function metaFor(runId: string, task: string): string {
	return JSON.stringify({
		runId,
		guildPath: 'guild',
		benchmarkPath: 'bench',
		task,
		status: 'success',
		startTime: '2026-01-01T00:00:00.000Z',
		endTime: '2026-01-01T00:01:00.000Z',
	})
}

describe('createRunListCache', () => {
	test('renders a summary from the meta and summary text', () => {
		const backend = createFakeBackend()
		backend.writeMeta('run-1', metaFor('run-1', 'fix the login bug'))
		backend.writeSummary('run-1', 'Fixed the login redirect loop')
		const read = createRunListCache(backend, 8)
		const summary = read('run-1')
		expect(summary.runId).toBe('run-1')
		expect(summary.task).toBe('fix the login bug')
		expect(summary.summary).toBe('Fixed the login redirect loop')
	})

	test('renders a run without a summary or meta as the UI fallback shape', () => {
		const backend = createFakeBackend()
		const read = createRunListCache(backend, 8)
		const summary = read('run-1')
		expect(summary.task).toBeNull()
		expect(summary.summary).toBeNull()
		expect(summary.status).toBe('unknown')
	})

	test('unchanged files are served from the cache without re-reading', () => {
		const backend = createFakeBackend()
		backend.writeMeta('run-1', metaFor('run-1', 'fix the login bug'))
		backend.writeSummary('run-1', 'Fixed the login redirect loop')
		const read = createRunListCache(backend, 8)
		const first = read('run-1')
		const second = read('run-1')
		expect(second).toBe(first)
		expect(backend.metaReads()).toBe(1)
		expect(backend.summaryReads()).toBe(1)
	})

	test('a meta change re-reads the run and refreshes the summary', () => {
		const backend = createFakeBackend()
		backend.writeMeta('run-1', metaFor('run-1', 'fix the login bug'))
		const read = createRunListCache(backend, 8)
		read('run-1')
		backend.writeMeta('run-1', metaFor('run-1', 'fix the signup bug'))
		const summary = read('run-1')
		expect(summary.task).toBe('fix the signup bug')
		expect(backend.metaReads()).toBe(2)
	})

	test('a summary change is picked up even though meta is unchanged', () => {
		const backend = createFakeBackend()
		backend.writeMeta('run-1', metaFor('run-1', 'fix the login bug'))
		const read = createRunListCache(backend, 8)
		read('run-1')
		backend.writeSummary('run-1', 'The run fixed the login redirect loop')
		const summary = read('run-1')
		expect(summary.summary).toBe('The run fixed the login redirect loop')
		expect(backend.summaryReads()).toBe(2)
	})

	test('the cache evicts the least-recently-used entry beyond maxEntries', () => {
		const backend = createFakeBackend()
		for (const runId of ['run-a', 'run-b', 'run-c']) {
			backend.writeMeta(runId, metaFor(runId, `task for ${runId}`))
		}
		const read = createRunListCache(backend, 2)
		read('run-a')
		read('run-b')
		read('run-a') // a hit refreshes recency, so b is now the eldest
		read('run-c') // evicts b, keeps a and c
		expect(backend.metaReads()).toBe(3)
		read('run-a') // still cached
		expect(backend.metaReads()).toBe(3)
		read('run-b') // evicted, so re-read
		expect(backend.metaReads()).toBe(4)
	})
})
