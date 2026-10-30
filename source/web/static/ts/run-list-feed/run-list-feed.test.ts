import { describe, expect, test } from 'bun:test'
import { applyRunListFrame, createRunListFeedResponder, emptyRunListFeedState, runListFeedRevision } from './index.js'
import type { RunSummary } from './index.js'

function frameKind(value: unknown): string | null {
	if (typeof value !== 'object' || value === null) return null
	if (!('kind' in value)) return null
	return typeof value.kind === 'string' ? value.kind : null
}

function summary(runId: string, overrides: Partial<RunSummary> = {}): RunSummary {
	return {
		runId,
		status: 'success',
		task: `task for ${runId}`,
		effort: 'standard',
		involvement: 'early-engagement',
		startTime: '2026-01-01T00:00:00.000Z',
		endTime: '2026-01-01T00:01:00.000Z',
		result: null,
		error: null,
		continuesFrom: null,
		suspension: null,
		pause: null,
		summary: null,
		...overrides,
	}
}

function entity(runId: string, overrides: Partial<RunSummary> = {}): Record<string, unknown> {
	return {
		id: runId,
		status: 'success',
		task: `task for ${runId}`,
		effort: 'standard',
		involvement: 'early-engagement',
		startTime: '2026-01-01T00:00:00.000Z',
		endTime: '2026-01-01T00:01:00.000Z',
		result: null,
		error: null,
		continuesFrom: null,
		suspension: null,
		pause: null,
		summary: null,
		...overrides,
	}
}

const health = {
	provider: { state: 'healthy', category: 'none', since: '2026-01-01T00:00:00.000Z', lastCheckedAt: '2026-01-01T00:00:00.000Z', consecutiveFailures: 0 },
	suspendedRunId: null,
	resumePolicy: null,
} as const

const healthEntity = { id: 'provider-health', ...health }

function snapshotFrame(runs: unknown[]): Record<string, unknown> {
	return { kind: 'snapshot', version: 'e:9', contentHash: 'not-a-real-hash', collections: { runs, health: [healthEntity] } }
}

describe('run-list feed round-trip', () => {
	test('a first snapshot orders runs newest-first, then unchanged keeps the same state and summaries references', () => {
		const responder = createRunListFeedResponder({ epoch: 'e', historyLimit: 8 })
		const summaries = [summary('run-20260101-000000'), summary('run-20260103-000000'), summary('run-20260102-000000')]
		const first = applyRunListFrame(emptyRunListFeedState(), responder(summaries, health, null))
		expect(first.outcome).toBe('snapshot')
		if (first.summaries === null) throw new Error('expected the snapshot to produce summaries')
		expect(first.summaries.map((entry) => entry.runId)).toEqual(['run-20260103-000000', 'run-20260102-000000', 'run-20260101-000000'])
		const revision = runListFeedRevision(first.state)
		if (revision === null) throw new Error('expected a revision after a snapshot')

		const unchanged = applyRunListFrame(first.state, responder(summaries, health, revision))
		expect(unchanged.outcome).toBe('unchanged')
		expect(unchanged.state).toBe(first.state)
		expect(unchanged.summaries).toBe(first.summaries)
	})

	test('a changed summary arrives as a delta and applies to the next list', () => {
		const responder = createRunListFeedResponder({ epoch: 'e', historyLimit: 8 })
		const first = applyRunListFrame(emptyRunListFeedState(), responder([summary('run-1')], health, null))
		const revision = runListFeedRevision(first.state)
		if (revision === null) throw new Error('expected a revision after a snapshot')
		const frame = responder([summary('run-2'), summary('run-1', { status: 'error' })], health, revision)
		expect(frameKind(frame)).toBe('delta')
		const applied = applyRunListFrame(first.state, frame)
		expect(applied.outcome).toBe('applied')
		expect(applied.summaries?.map((entry) => entry.runId)).toEqual(['run-2', 'run-1'])
		expect(applied.summaries?.[1]?.status).toBe('error')
		expect(runListFeedRevision(applied.state)).not.toBe(revision)
	})

	test('a fresh snapshot reconstructs the same summaries as the delta path', () => {
		const responder = createRunListFeedResponder({ epoch: 'e', historyLimit: 8 })
		const first = applyRunListFrame(emptyRunListFeedState(), responder([summary('run-1')], health, null))
		const revision = runListFeedRevision(first.state)
		if (revision === null) throw new Error('expected a revision after a snapshot')
		const next = [summary('run-2'), summary('run-1', { summary: 'a generated summary' })]
		const applied = applyRunListFrame(first.state, responder(next, health, revision))
		if (applied.summaries === null) throw new Error('expected the delta to produce summaries')
		const fresh = applyRunListFrame(emptyRunListFeedState(), responder(next, health, null))
		expect(fresh.outcome).toBe('snapshot')
		expect(fresh.summaries).toEqual(applied.summaries)
	})

	test('a stale delta base and an unchanged frame at an unknown revision both report needsSnapshot', () => {
		const responder = createRunListFeedResponder({ epoch: 'e', historyLimit: 8 })
		const first = applyRunListFrame(emptyRunListFeedState(), responder([summary('run-1')], health, null))
		const stale = applyRunListFrame(first.state, { kind: 'delta', base: 'unknown', next: 'e:2', collections: {} })
		expect(stale.outcome).toBe('needsSnapshot')
		expect(stale.state).toBe(first.state)
		expect(stale.summaries).toBeNull()
		const unknownUnchanged = applyRunListFrame(first.state, { kind: 'unchanged', version: 'unknown' })
		expect(unknownUnchanged.outcome).toBe('needsSnapshot')
		expect(unknownUnchanged.state).toBe(first.state)
		expect(unknownUnchanged.summaries).toBeNull()
	})

	test('an invalid frame leaves the held state untouched', () => {
		const responder = createRunListFeedResponder({ epoch: 'e', historyLimit: 8 })
		const first = applyRunListFrame(emptyRunListFeedState(), responder([summary('run-1')], health, null))
		const invalid = applyRunListFrame(first.state, { kind: 'nonsense' })
		expect(invalid.outcome).toBe('invalid')
		expect(invalid.state).toBe(first.state)
		expect(invalid.summaries).toBeNull()
	})

	test('an empty list round-trips to an empty list', () => {
		const responder = createRunListFeedResponder({ epoch: 'e', historyLimit: 8 })
		const result = applyRunListFrame(emptyRunListFeedState(), responder([], health, null))
		expect(result.outcome).toBe('snapshot')
		expect(result.summaries).toEqual([])
	})
})

describe('run-list feed change detection', () => {
	test('every mutable summary field changes the frame', () => {
		const responder = createRunListFeedResponder({ epoch: 'e', historyLimit: 128 })
		const base = summary('run-1', { result: { status: 'success', summary: 'done' } })
		const first = applyRunListFrame(emptyRunListFeedState(), responder([base], health, null))
		const revision = runListFeedRevision(first.state)
		if (revision === null) throw new Error('expected a revision after a snapshot')
		const variants: [string, RunSummary][] = [
			['status', { ...base, status: 'error' }],
			['task', { ...base, task: 'another task' }],
			['effort', { ...base, effort: 'quick' }],
			['involvement', { ...base, involvement: 'collaborative' }],
			['startTime', { ...base, startTime: '2026-01-01T00:00:01.000Z' }],
			['endTime', { ...base, endTime: '2026-01-01T00:02:00.000Z' }],
			['result', { ...base, result: { status: 'success', summary: 'changed' } }],
			['result to null', { ...base, result: null }],
			['error', { ...base, error: { kind: 'llm_unavailable', message: 'down' } }],
			['continuesFrom', { ...base, continuesFrom: 'run-20251231-000000' }],
			['pause', { ...base, status: 'suspended', pause: { message: 'The operator paused this run.', pausedAt: '2026-01-01T00:02:00.000Z' } }],
			['summary', { ...base, summary: 'a generated summary' }],
		]
		for (const [name, variant] of variants) {
			expect(frameKind(responder([variant], health, revision)), name).toBe('delta')
		}
	})

	test('continuesFrom round-trips through a snapshot, and changing it produces a delta', () => {
		const responder = createRunListFeedResponder({ epoch: 'e', historyLimit: 8 })
		const base = summary('run-1', { continuesFrom: 'run-20251231-000000' })
		const first = applyRunListFrame(emptyRunListFeedState(), responder([base], health, null))
		if (first.summaries === null) throw new Error('expected the snapshot to produce summaries')
		expect(first.summaries[0]?.continuesFrom).toBe('run-20251231-000000')
		const revision = runListFeedRevision(first.state)
		if (revision === null) throw new Error('expected a revision after a snapshot')

		const changed = summary('run-1', { continuesFrom: 'run-20251230-000000' })
		expect(frameKind(responder([changed], health, revision))).toBe('delta')
		const applied = applyRunListFrame(first.state, responder([changed], health, revision))
		if (applied.summaries === null) throw new Error('expected the delta to produce summaries')
		expect(applied.summaries[0]?.continuesFrom).toBe('run-20251230-000000')
	})

	test('free-text separators cannot shift field boundaries into a collision', () => {
		const responder = createRunListFeedResponder({ epoch: 'e', historyLimit: 8 })
		const first = applyRunListFrame(emptyRunListFeedState(), responder([summary('run-1', { task: 'x|quick', effort: null })], health, null))
		const revision = runListFeedRevision(first.state)
		if (revision === null) throw new Error('expected a revision after a snapshot')
		expect(frameKind(responder([summary('run-1', { task: 'x', effort: 'quick' })], health, revision))).toBe('delta')
	})

	test('a cloned identical summary stays unchanged', () => {
		const responder = createRunListFeedResponder({ epoch: 'e', historyLimit: 8 })
		const base = summary('run-1', { result: { status: 'success', summary: 'done' } })
		const first = applyRunListFrame(emptyRunListFeedState(), responder([base], health, null))
		const revision = runListFeedRevision(first.state)
		if (revision === null) throw new Error('expected a revision after a snapshot')
		const clone: RunSummary = { ...base, result: base.result === null ? null : { ...base.result } }
		const unchanged = applyRunListFrame(first.state, responder([clone], health, revision))
		expect(unchanged.outcome).toBe('unchanged')
		expect(unchanged.state).toBe(first.state)
		expect(unchanged.summaries).toBe(first.summaries)
	})
})

describe('run-list feed validation', () => {
	test('rejects malformed entities in a snapshot', () => {
		const malformed: [string, Record<string, unknown>][] = [
			['empty id', snapshotFrame([{ ...entity('run-1'), id: '' }])],
			['status', snapshotFrame([{ ...entity('run-1'), status: 'bogus' }])],
			['task', snapshotFrame([{ ...entity('run-1'), task: 7 }])],
			['involvement', snapshotFrame([{ ...entity('run-1'), involvement: 7 }])],
			['endTime', snapshotFrame([{ ...entity('run-1'), endTime: 7 }])],
			['continuesFrom', snapshotFrame([{ ...entity('run-1'), continuesFrom: 7 }])],
			['pause message', snapshotFrame([{ ...entity('run-1'), pause: { message: 7, pausedAt: '2026-01-01T00:02:00.000Z' } }])],
			['pause timestamp', snapshotFrame([{ ...entity('run-1'), pause: { message: 'Paused.', pausedAt: 7 } }])],
			['summary', snapshotFrame([{ ...entity('run-1'), summary: 7 }])],
			['result status', snapshotFrame([{ ...entity('run-1'), result: { status: 'bogus', summary: 'x' } }])],
			['result summary', snapshotFrame([{ ...entity('run-1'), result: { status: 'success' } }])],
			['result artifacts', snapshotFrame([{ ...entity('run-1'), result: { status: 'success', summary: 'x', artifacts: [1] } }])],
			['error message', snapshotFrame([{ ...entity('run-1'), error: { kind: 'x' } }])],
			['non-object', snapshotFrame([null])],
		]
		for (const [name, frame] of malformed) {
			const result = applyRunListFrame(emptyRunListFeedState(), frame)
			expect(result.outcome, name).toBe('invalid')
			expect(result.summaries, name).toBeNull()
		}
	})

	test('accepts a well-formed entity carrying a result card and run-level error', () => {
		const responder = createRunListFeedResponder({ epoch: 'e', historyLimit: 8 })
		const valid = summary('run-1', {
			result: { status: 'error', summary: 'failed', artifacts: ['out.txt'], error: { kind: 'llm_unavailable', message: 'down', details: { code: 500 } }, detail: 'raw' },
			error: { kind: 'llm_unavailable', message: 'down' },
		})
		const result = applyRunListFrame(emptyRunListFeedState(), responder([valid], health, null))
		expect(result.outcome).toBe('snapshot')
		expect(result.summaries).toEqual([valid])
	})

	test('accepts and round-trips an operator pause record without a suspension', () => {
		const responder = createRunListFeedResponder({ epoch: 'e', historyLimit: 8 })
		const pause = { message: 'The operator paused this run.', pausedAt: '2026-01-01T00:02:00.000Z' }
		const paused = summary('run-1', { status: 'suspended', suspension: null, pause })
		const result = applyRunListFrame(emptyRunListFeedState(), responder([paused], health, null))
		expect(result.outcome).toBe('snapshot')
		expect(result.summaries?.[0]?.pause).toEqual(pause)
		expect(result.summaries?.[0]?.suspension).toBeNull()
	})

	test('rejects a snapshot whose content hash does not match its contents', () => {
		const result = applyRunListFrame(emptyRunListFeedState(), snapshotFrame([]))
		expect(result.outcome).toBe('invalid')
		expect(result.summaries).toBeNull()
	})
})

describe('run-list feed health carrier', () => {
	test('the first snapshot carries the health singleton and reconstructs it exactly', () => {
		const responder = createRunListFeedResponder({ epoch: 'e', historyLimit: 8 })
		const unhealthy = {
			provider: { state: 'unavailable', category: 'billing', since: '2026-01-01T00:00:00.000Z', lastCheckedAt: '2026-01-01T00:01:00.000Z', consecutiveFailures: 2, nextProbeAt: '2026-01-01T00:02:00.000Z' },
			suspendedRunId: 'run-1',
			resumePolicy: 'operator',
		} as const
		const first = applyRunListFrame(emptyRunListFeedState(), responder([summary('run-1', { status: 'suspended', suspension: { category: 'billing', resumePolicy: 'operator', message: 'Top up.', suspendedAt: '2026-01-01T00:02:00.000Z', resumeAttempts: 2 } })], unhealthy, null))
		expect(first.outcome).toBe('snapshot')
		expect(first.health).toEqual(unhealthy)
		expect(first.summaries?.[0]?.suspension?.category).toBe('billing')
		expect(first.summaries?.[0]?.suspension?.resumeAttempts).toBe(2)
	})

	test('an unchanged frame keeps the same summaries and health references', () => {
		const responder = createRunListFeedResponder({ epoch: 'e', historyLimit: 8 })
		const first = applyRunListFrame(emptyRunListFeedState(), responder([summary('run-1')], health, null))
		const revision = runListFeedRevision(first.state)
		if (revision === null) throw new Error('expected a revision after a snapshot')
		const unchanged = applyRunListFrame(first.state, responder([summary('run-1')], health, revision))
		expect(unchanged.outcome).toBe('unchanged')
		expect(unchanged.health).toBe(first.health)
		expect(unchanged.summaries).toBe(first.summaries)
	})

	test('a health-only change produces a delta without replacing the run summaries', () => {
		const responder = createRunListFeedResponder({ epoch: 'e', historyLimit: 8 })
		const first = applyRunListFrame(emptyRunListFeedState(), responder([summary('run-1')], health, null))
		const revision = runListFeedRevision(first.state)
		if (revision === null) throw new Error('expected a revision after a snapshot')
		const degraded = { provider: { ...health.provider, state: 'degraded', category: 'transient', consecutiveFailures: 1 }, suspendedRunId: 'run-1', resumePolicy: 'auto' } as const
		const frame = responder([summary('run-1')], degraded, revision)
		expect(frameKind(frame)).toBe('delta')
		const applied = applyRunListFrame(first.state, frame)
		expect(applied.outcome).toBe('applied')
		expect(applied.health).toEqual(degraded)
		expect(applied.summaries?.[0]?.runId).toBe('run-1')
	})

	test('a malformed health entity invalidates the snapshot instead of rendering an unsafe banner', () => {
		const responder = createRunListFeedResponder({ epoch: 'e', historyLimit: 8 })
		const frame = responder([summary('run-1')], health, null)
		if (typeof frame !== 'object' || frame === null || !('collections' in frame)) throw new Error('expected a snapshot frame')
		const collections = frame.collections
		if (typeof collections !== 'object' || collections === null) throw new Error('expected snapshot collections')
		const broken = { ...frame, collections: { ...collections, health: [{ id: 'provider-health', provider: { state: 'bogus' }, suspendedRunId: null, resumePolicy: null }] } }
		const result = applyRunListFrame(emptyRunListFeedState(), broken)
		expect(result.outcome).toBe('invalid')
		expect(result.health).toBeNull()
	})
})
