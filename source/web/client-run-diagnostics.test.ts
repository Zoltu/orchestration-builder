import { describe, expect, test } from 'bun:test'
import { diagnosticsCopyJson, diagnosticsResponseApplies, isRunDiagnostics, planSuspendedDiagnosticsOpen } from './static/ts/run-diagnostics.js'
import type { RunDiagnostics } from './static/ts/run-diagnostics.js'

const valid: RunDiagnostics = {
	runId: 'run-20260101-000500',
	suspension: { category: 'transient', disposition: 'recoverable', resumePolicy: 'auto', escalated: false, suspendedAt: '2026-01-01T00:02:00.000Z', resumeAttempts: 1 },
	failure: { timestamp: '2026-01-01T00:02:00.000Z', role: 'coder', roleId: 'coder-1', category: 'transient', httpStatus: 503, attempts: 3, partialOutput: false, detail: 'body' },
	probeFailure: null,
}

describe('isRunDiagnostics', () => {
	test('accepts the endpoint payload and a payload with only null sections', () => {
		expect(isRunDiagnostics(valid)).toBe(true)
		expect(isRunDiagnostics({ runId: valid.runId, suspension: null, failure: null, probeFailure: null })).toBe(true)
	})

	test('rejects malformed responses so the fetch action can render a failed state', () => {
		expect(isRunDiagnostics(null)).toBe(false)
		expect(isRunDiagnostics({ ok: false, error: 'not_found' })).toBe(false)
		expect(isRunDiagnostics({ ...valid, runId: '' })).toBe(false)
		expect(isRunDiagnostics({ ...valid, suspension: { category: 'bogus' } })).toBe(false)
		expect(isRunDiagnostics({ ...valid, failure: { ...valid.failure, attempts: -1 } })).toBe(false)
		expect(isRunDiagnostics({ ...valid, failure: { ...valid.failure, partialOutput: 'yes' } })).toBe(false)
		expect(isRunDiagnostics({ ...valid, probeFailure: { at: 'x', category: 'bogus' } })).toBe(false)
	})

	test('copies the validated payload as JSON', () => {
		expect(JSON.parse(diagnosticsCopyJson(valid))).toEqual(valid)
	})
})

describe('planSuspendedDiagnosticsOpen', () => {
	test('closing never requests and opening a fresh run requests', () => {
		expect(planSuspendedDiagnosticsOpen(null, valid.runId, false)).toEqual({ open: false, request: false })
		expect(planSuspendedDiagnosticsOpen(null, valid.runId, true)).toEqual({ open: true, request: true })
	})

	test('reopening a ready or loading record reuses it, while a failed record waits for Retry', () => {
		expect(planSuspendedDiagnosticsOpen({ runId: valid.runId, token: 1, load: { status: 'loading' } }, valid.runId, true)).toEqual({ open: true, request: false })
		expect(planSuspendedDiagnosticsOpen({ runId: valid.runId, token: 1, load: { status: 'ready', data: valid } }, valid.runId, true)).toEqual({ open: true, request: false })
		expect(planSuspendedDiagnosticsOpen({ runId: valid.runId, token: 1, load: { status: 'failed' } }, valid.runId, true)).toEqual({ open: true, request: false })
	})

	test('a record for another run is not reused', () => {
		expect(planSuspendedDiagnosticsOpen({ runId: 'run-20260101-000600', token: 1, load: { status: 'ready', data: valid } }, valid.runId, true)).toEqual({ open: true, request: true })
	})
})

describe('diagnosticsResponseApplies', () => {
	test('accepts only the current run and request token, rejecting a stale same-run response', () => {
		const record = { runId: valid.runId, token: 2, load: { status: 'loading' as const } }
		expect(diagnosticsResponseApplies(record, valid.runId, 2)).toBe(true)
		expect(diagnosticsResponseApplies(record, valid.runId, 1)).toBe(false)
		expect(diagnosticsResponseApplies(record, 'run-20260101-000600', 2)).toBe(false)
		expect(diagnosticsResponseApplies(null, valid.runId, 2)).toBe(false)
	})
})
