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
		summary: null,
		...overrides,
	}
}

function snapshotFrame(runs: unknown[]): Record<string, unknown> {
	return { kind: 'snapshot', version: 'e:9', contentHash: 'not-a-real-hash', collections: { runs } }
}

describe('run-list feed round-trip', () => {
	test('a first snapshot orders runs newest-first, then unchanged keeps the same state and summaries references', () => {
		const responder = createRunListFeedResponder({ epoch: 'e', historyLimit: 8 })
		const summaries = [summary('run-20260101-000000'), summary('run-20260103-000000'), summary('run-20260102-000000')]
		const first = applyRunListFrame(emptyRunListFeedState(), responder(summaries, null))
		expect(first.outcome).toBe('snapshot')
		if (first.summaries === null) throw new Error('expected the snapshot to produce summaries')
		expect(first.summaries.map((entry) => entry.runId)).toEqual(['run-20260103-000000', 'run-20260102-000000', 'run-20260101-000000'])
		const revision = runListFeedRevision(first.state)
		if (revision === null) throw new Error('expected a revision after a snapshot')

		const unchanged = applyRunListFrame(first.state, responder(summaries, revision))
		expect(unchanged.outcome).toBe('unchanged')
		expect(unchanged.state).toBe(first.state)
		expect(unchanged.summaries).toBe(first.summaries)
	})

	test('a changed summary arrives as a delta and applies to the next list', () => {
		const responder = createRunListFeedResponder({ epoch: 'e', historyLimit: 8 })
		const first = applyRunListFrame(emptyRunListFeedState(), responder([summary('run-1')], null))
		const revision = runListFeedRevision(first.state)
		if (revision === null) throw new Error('expected a revision after a snapshot')
		const frame = responder([summary('run-2'), summary('run-1', { status: 'error' })], revision)
		expect(frameKind(frame)).toBe('delta')
		const applied = applyRunListFrame(first.state, frame)
		expect(applied.outcome).toBe('applied')
		expect(applied.summaries?.map((entry) => entry.runId)).toEqual(['run-2', 'run-1'])
		expect(applied.summaries?.[1]?.status).toBe('error')
		expect(runListFeedRevision(applied.state)).not.toBe(revision)
	})

	test('a fresh snapshot reconstructs the same summaries as the delta path', () => {
		const responder = createRunListFeedResponder({ epoch: 'e', historyLimit: 8 })
		const first = applyRunListFrame(emptyRunListFeedState(), responder([summary('run-1')], null))
		const revision = runListFeedRevision(first.state)
		if (revision === null) throw new Error('expected a revision after a snapshot')
		const next = [summary('run-2'), summary('run-1', { summary: 'a generated summary' })]
		const applied = applyRunListFrame(first.state, responder(next, revision))
		if (applied.summaries === null) throw new Error('expected the delta to produce summaries')
		const fresh = applyRunListFrame(emptyRunListFeedState(), responder(next, null))
		expect(fresh.outcome).toBe('snapshot')
		expect(fresh.summaries).toEqual(applied.summaries)
	})

	test('a stale delta base and an unchanged frame at an unknown revision both report needsSnapshot', () => {
		const responder = createRunListFeedResponder({ epoch: 'e', historyLimit: 8 })
		const first = applyRunListFrame(emptyRunListFeedState(), responder([summary('run-1')], null))
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
		const first = applyRunListFrame(emptyRunListFeedState(), responder([summary('run-1')], null))
		const invalid = applyRunListFrame(first.state, { kind: 'nonsense' })
		expect(invalid.outcome).toBe('invalid')
		expect(invalid.state).toBe(first.state)
		expect(invalid.summaries).toBeNull()
	})

	test('an empty list round-trips to an empty list', () => {
		const responder = createRunListFeedResponder({ epoch: 'e', historyLimit: 8 })
		const result = applyRunListFrame(emptyRunListFeedState(), responder([], null))
		expect(result.outcome).toBe('snapshot')
		expect(result.summaries).toEqual([])
	})
})

describe('run-list feed change detection', () => {
	test('every mutable summary field changes the frame', () => {
		const responder = createRunListFeedResponder({ epoch: 'e', historyLimit: 128 })
		const base = summary('run-1', { result: { status: 'success', summary: 'done' } })
		const first = applyRunListFrame(emptyRunListFeedState(), responder([base], null))
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
			['summary', { ...base, summary: 'a generated summary' }],
		]
		for (const [name, variant] of variants) {
			expect(frameKind(responder([variant], revision)), name).toBe('delta')
		}
	})

	test('free-text separators cannot shift field boundaries into a collision', () => {
		const responder = createRunListFeedResponder({ epoch: 'e', historyLimit: 8 })
		const first = applyRunListFrame(emptyRunListFeedState(), responder([summary('run-1', { task: 'x|quick', effort: null })], null))
		const revision = runListFeedRevision(first.state)
		if (revision === null) throw new Error('expected a revision after a snapshot')
		expect(frameKind(responder([summary('run-1', { task: 'x', effort: 'quick' })], revision))).toBe('delta')
	})

	test('a cloned identical summary stays unchanged', () => {
		const responder = createRunListFeedResponder({ epoch: 'e', historyLimit: 8 })
		const base = summary('run-1', { result: { status: 'success', summary: 'done' } })
		const first = applyRunListFrame(emptyRunListFeedState(), responder([base], null))
		const revision = runListFeedRevision(first.state)
		if (revision === null) throw new Error('expected a revision after a snapshot')
		const clone: RunSummary = { ...base, result: base.result === null ? null : { ...base.result } }
		const unchanged = applyRunListFrame(first.state, responder([clone], revision))
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
		const result = applyRunListFrame(emptyRunListFeedState(), responder([valid], null))
		expect(result.outcome).toBe('snapshot')
		expect(result.summaries).toEqual([valid])
	})

	test('rejects a snapshot whose content hash does not match its contents', () => {
		const result = applyRunListFrame(emptyRunListFeedState(), snapshotFrame([]))
		expect(result.outcome).toBe('invalid')
		expect(result.summaries).toBeNull()
	})
})
