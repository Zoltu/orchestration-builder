import { describe, expect, test } from 'bun:test'
import type { RunSnapshotRaw, RunSnapshotStats } from '../executor/persistence.ts'
import { createSnapshotCache } from './snapshot-cache.ts'

// An in-memory fake behind the two leaves the cache composes: raw content by run id plus a monotonic clock so tests bump freshness explicitly (mtime) rather than sleeping.
function createFakeBackend() {
	const raws = new Map<string, RunSnapshotRaw>()
	const mtimes = new Map<string, number>()
	let rawReads = 0
	let clock = 1
	return {
		write(runId: string, raw: RunSnapshotRaw) {
			raws.set(runId, raw)
			mtimes.set(runId, clock)
			clock += 1
		},
		rawReads: () => rawReads,
		readStats(runId: string): RunSnapshotStats {
			const raw = raws.get(runId)
			if (raw === undefined) return { meta: null, log: null }
			const mtimeMs = mtimes.get(runId) ?? 0
			return {
				meta: raw.metaText === null ? null : { size: raw.metaText.length, mtimeMs },
				log: raw.logText === '' ? null : { size: raw.logText.length, mtimeMs },
			}
		},
		readRaw(runId: string): RunSnapshotRaw {
			rawReads += 1
			return raws.get(runId) ?? { metaText: null, logText: '' }
		},
	}
}

function rawFor(runId: string, extraLogLines: string[] = []): RunSnapshotRaw {
	return {
		metaText: JSON.stringify({
			runId,
			guildPath: 'guild',
			benchmarkPath: 'bench',
			task: `task for ${runId}`,
			status: 'success',
			startTime: '2026-01-01T00:00:00.000Z',
			endTime: '2026-01-01T00:01:00.000Z',
		}),
		logText: [
			JSON.stringify({ timestamp: 't1', type: 'role_start', payload: { role: 'planner' } }),
			...extraLogLines,
		].join('\n'),
	}
}

describe('createSnapshotCache', () => {
	test('parses the raw snapshot into meta and log events', () => {
		const backend = createFakeBackend()
		backend.write('run-1', rawFor('run-1'))
		const read = createSnapshotCache({ readStats: backend.readStats, readRaw: backend.readRaw }, 8)
		const snapshot = read('run-1')
		expect(snapshot.meta?.runId).toBe('run-1')
		expect(snapshot.logEvents).toHaveLength(1)
		expect(snapshot.logEvents[0]?.type).toBe('role_start')
	})

	test('an unchanged run is served from the cache without re-reading the raw snapshot', () => {
		const backend = createFakeBackend()
		backend.write('run-1', rawFor('run-1'))
		const read = createSnapshotCache({ readStats: backend.readStats, readRaw: backend.readRaw }, 8)
		const first = read('run-1')
		const second = read('run-1')
		expect(second).toBe(first)
		expect(backend.rawReads()).toBe(1)
	})

	test('a freshness change re-reads and re-parses the run', () => {
		const backend = createFakeBackend()
		backend.write('run-1', rawFor('run-1'))
		const read = createSnapshotCache({ readStats: backend.readStats, readRaw: backend.readRaw }, 8)
		read('run-1')
		backend.write('run-1', rawFor('run-1', [JSON.stringify({ timestamp: 't2', type: 'role_finished', payload: { role: 'planner', status: 'success' } })]))
		const snapshot = read('run-1')
		expect(snapshot.logEvents).toHaveLength(2)
		expect(backend.rawReads()).toBe(2)
	})

	test('an unknown run reads as an empty snapshot and its absence is still cached', () => {
		const backend = createFakeBackend()
		const read = createSnapshotCache({ readStats: backend.readStats, readRaw: backend.readRaw }, 8)
		const snapshot = read('never-started')
		expect(snapshot.meta).toBeNull()
		expect(snapshot.logEvents).toHaveLength(0)
		read('never-started')
		expect(backend.rawReads()).toBe(1)
	})

	test('the cache evicts the least-recently-used entry beyond maxEntries', () => {
		const backend = createFakeBackend()
		backend.write('run-a', rawFor('run-a'))
		backend.write('run-b', rawFor('run-b'))
		backend.write('run-c', rawFor('run-c'))
		const read = createSnapshotCache({ readStats: backend.readStats, readRaw: backend.readRaw }, 2)
		read('run-a')
		read('run-b')
		read('run-a') // a hit refreshes recency, so b is now the eldest
		read('run-c') // evicts b, keeps a and c
		expect(backend.rawReads()).toBe(3)
		read('run-a') // still cached
		expect(backend.rawReads()).toBe(3)
		read('run-b') // evicted, so re-read
		expect(backend.rawReads()).toBe(4)
	})
})
