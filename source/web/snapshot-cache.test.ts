import { describe, expect, test } from 'bun:test'
import type { RunSnapshotStats } from '../executor/persistence.ts'
import { formatLogEvent } from './render.ts'
import { createSnapshotCache } from './snapshot-cache.ts'
import { defined } from './test-fixtures.js'

// An in-memory fake behind the three leaves the cache composes: meta text, an append-only log simulated as a string (ASCII-only, so string length equals byte length and stat sizes line up with offsets), and a monotonic clock so tests bump freshness explicitly (mtime) rather than sleeping. The read leaves count calls and bytes so a test can assert a poll only touched the log's tail.
function createFakeBackend() {
	const metaFiles = new Map<string, string | null>()
	const logs = new Map<string, string>()
	const metaMtimes = new Map<string, number>()
	const logMtimes = new Map<string, number>()
	let metaReads = 0
	let logReads = 0
	let logBytesRead = 0
	let clock = 1
	return {
		writeMeta(runId: string, metaText: string) {
			metaFiles.set(runId, metaText)
			metaMtimes.set(runId, clock)
			clock += 1
		},
		writeLog(runId: string, logText: string) {
			logs.set(runId, logText)
			logMtimes.set(runId, clock)
			clock += 1
		},
		appendLog(runId: string, appendedText: string) {
			logs.set(runId, (logs.get(runId) ?? '') + appendedText)
			logMtimes.set(runId, clock)
			clock += 1
		},
		metaReads: () => metaReads,
		logReads: () => logReads,
		logBytesRead: () => logBytesRead,
		readStats(runId: string): RunSnapshotStats {
			const metaText = metaFiles.get(runId)
			const logText = logs.get(runId)
			return {
				meta: metaText === undefined || metaText === null ? null : { size: metaText.length, mtimeMs: metaMtimes.get(runId) ?? 0 },
				log: logText === undefined || logText === '' ? null : { size: logText.length, mtimeMs: logMtimes.get(runId) ?? 0 },
			}
		},
		readMetaText(runId: string): string | null {
			metaReads += 1
			return metaFiles.get(runId) ?? null
		},
		readLogTextFrom(runId: string, byteOffset: number): string {
			logReads += 1
			const tail = (logs.get(runId) ?? '').slice(byteOffset)
			logBytesRead += tail.length
			return tail
		},
	}
}

function metaFor(runId: string): string {
	return JSON.stringify({
		runId,
		guildPath: 'guild',
		benchmarkPath: 'bench',
		task: `task for ${runId}`,
		status: 'success',
		startTime: '2026-01-01T00:00:00.000Z',
		endTime: '2026-01-01T00:01:00.000Z',
	})
}

function logLine(timestamp: string, type: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ timestamp, type, payload: { role: 'planner', ...extra } })
}

function readOf(backend: ReturnType<typeof createFakeBackend>) {
	return createSnapshotCache({ readStats: backend.readStats, readMetaText: backend.readMetaText, readLogTextFrom: backend.readLogTextFrom }, 8)
}

describe('createSnapshotCache', () => {
	test('parses the raw files into meta and log events', () => {
		const backend = createFakeBackend()
		backend.writeMeta('run-1', metaFor('run-1'))
		backend.writeLog('run-1', `${logLine('t1', 'role_start')}\n`)
		const read = readOf(backend)
		const snapshot = read('run-1')
		expect(snapshot.meta?.runId).toBe('run-1')
		expect(snapshot.logEvents).toHaveLength(1)
		expect(snapshot.logEvents[0]?.type).toBe('role_start')
	})

	test('an unchanged run is served from the cache without re-reading any file', () => {
		const backend = createFakeBackend()
		backend.writeMeta('run-1', metaFor('run-1'))
		backend.writeLog('run-1', `${logLine('t1', 'role_start')}\n`)
		const read = readOf(backend)
		const first = read('run-1')
		const second = read('run-1')
		expect(second).toBe(first)
		expect(backend.metaReads()).toBe(1)
		expect(backend.logReads()).toBe(1)
	})

	test('a growing log is parsed only from the appended tail and returns every event in order', () => {
		const backend = createFakeBackend()
		backend.writeMeta('run-1', metaFor('run-1'))
		backend.writeLog('run-1', [logLine('t1', 'role_start'), logLine('t2', 'llm_call')].join('\n') + '\n')
		const read = readOf(backend)
		read('run-1')
		const bytesBefore = backend.logBytesRead()
		const appended = [logLine('t3', 'tool_call', { tool: 'agent' }), logLine('t4', 'role_finished', { status: 'success' })].map((line) => line + '\n').join('')
		backend.appendLog('run-1', appended)
		const snapshot = read('run-1')
		expect(snapshot.logEvents.map((event) => event.type)).toEqual(['role_start', 'llm_call', 'tool_call', 'role_finished'])
		expect(backend.logReads()).toBe(2)
		expect(backend.logBytesRead() - bytesBefore).toBe(appended.length)
		expect(backend.metaReads()).toBe(1)
	})

	test('a torn final line is left unparsed and parses exactly once once the append completes it', () => {
		const backend = createFakeBackend()
		backend.writeMeta('run-1', metaFor('run-1'))
		const tornLine = logLine('t2', 'role_finished', { status: 'success' })
		const splitIndex = Math.floor(tornLine.length / 2)
		backend.writeLog('run-1', `${logLine('t1', 'role_start')}\n${tornLine.slice(0, splitIndex)}`)
		const read = readOf(backend)
		const first = read('run-1')
		expect(first.logEvents.map((event) => event.timestamp)).toEqual(['t1'])
		backend.appendLog('run-1', `${tornLine.slice(splitIndex)}\n`)
		const second = read('run-1')
		expect(second.logEvents.map((event) => event.timestamp)).toEqual(['t1', 't2'])
	})

	test('a trailing fragment that is already a complete event is consumed immediately and its later newline arrives as a skipped empty line', () => {
		const backend = createFakeBackend()
		backend.writeMeta('run-1', metaFor('run-1'))
		const fragmentLine = logLine('t2', 'role_finished', { status: 'success' })
		const initialLog = `${logLine('t1', 'role_start')}\n${fragmentLine}`
		backend.writeLog('run-1', initialLog)
		const read = readOf(backend)
		const first = read('run-1')
		expect(first.logEvents.map((event) => event.timestamp)).toEqual(['t1', 't2'])
		expect(backend.logBytesRead()).toBe(initialLog.length)
		backend.appendLog('run-1', `\n${logLine('t3', 'llm_call')}\n`)
		const second = read('run-1')
		expect(second.logEvents.map((event) => event.timestamp)).toEqual(['t1', 't2', 't3'])
	})

	test('a meta-only change re-reads the meta without touching the log', () => {
		const backend = createFakeBackend()
		backend.writeMeta('run-1', metaFor('run-1'))
		backend.writeLog('run-1', `${logLine('t1', 'role_start')}\n`)
		const read = readOf(backend)
		read('run-1')
		backend.writeMeta('run-1', metaFor('run-1').replace('success', 'running'))
		const snapshot = read('run-1')
		expect(snapshot.meta?.status).toBe('running')
		expect(backend.metaReads()).toBe(2)
		expect(backend.logReads()).toBe(1)
	})

	test('a shrunk log falls back to a full re-read and re-parse', () => {
		const backend = createFakeBackend()
		backend.writeMeta('run-1', metaFor('run-1'))
		backend.writeLog('run-1', [logLine('t1', 'role_start'), logLine('t2', 'llm_call'), logLine('t3', 'tool_call')].join('\n') + '\n')
		const read = readOf(backend)
		read('run-1')
		const rewritten = `${logLine('x1', 'role_start')}\n`
		backend.writeLog('run-1', rewritten)
		const bytesBefore = backend.logBytesRead()
		const snapshot = read('run-1')
		expect(snapshot.logEvents.map((event) => event.timestamp)).toEqual(['x1'])
		expect(backend.logReads()).toBe(2)
		expect(backend.logBytesRead() - bytesBefore).toBe(rewritten.length)
	})

	test('a same-size rewrite with a changed mtime falls back to a full re-read, not a tail parse', () => {
		const backend = createFakeBackend()
		backend.writeMeta('run-1', metaFor('run-1'))
		// The rewrite has exactly the same byte length as the original (only the payload role differs), so size alone cannot reveal it — the mtime change must.
		const original = `${logLine('t1', 'role_start')}\n`
		const rewritten = `${logLine('t1', 'role_start', { role: 'painter' })}\n`
		expect(rewritten.length).toBe(original.length)
		backend.writeLog('run-1', original)
		const read = readOf(backend)
		read('run-1')
		backend.writeLog('run-1', rewritten)
		const bytesBefore = backend.logBytesRead()
		const snapshot = read('run-1')
		const event = defined(snapshot.logEvents[0], 'snapshot.logEvents[0]')
		expect(formatLogEvent(event)).toBe('painter · role start')
		expect(backend.logReads()).toBe(2)
		expect(backend.logBytesRead() - bytesBefore).toBe(rewritten.length)
	})

	test('an unknown run reads as an empty snapshot and its absence is still cached', () => {
		const backend = createFakeBackend()
		const read = readOf(backend)
		const snapshot = read('never-started')
		expect(snapshot.meta).toBeNull()
		expect(snapshot.logEvents).toHaveLength(0)
		read('never-started')
		expect(backend.metaReads()).toBe(1)
		expect(backend.logReads()).toBe(1)
	})

	test('the cache evicts the least-recently-used entry beyond maxEntries', () => {
		const backend = createFakeBackend()
		for (const runId of ['run-a', 'run-b', 'run-c']) {
			backend.writeMeta(runId, metaFor(runId))
			backend.writeLog(runId, `${logLine('t1', 'role_start')}\n`)
		}
		const read = createSnapshotCache({ readStats: backend.readStats, readMetaText: backend.readMetaText, readLogTextFrom: backend.readLogTextFrom }, 2)
		read('run-a')
		read('run-b')
		read('run-a') // a hit refreshes recency, so b is now the eldest
		read('run-c') // evicts b, keeps a and c
		expect(backend.logReads()).toBe(3)
		read('run-a') // still cached
		expect(backend.logReads()).toBe(3)
		read('run-b') // evicted, so re-read
		expect(backend.logReads()).toBe(4)
	})
})
