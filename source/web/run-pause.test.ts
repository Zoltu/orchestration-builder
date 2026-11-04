import { describe, expect, test } from 'bun:test'
import { derivePauseTargetRunId, deriveRunPauseKind, deriveRunSuspendedStatusLabel, deriveSuspendedStatusLabel, hasOperatorPausedRun, isOperatorPaused, pauseFailureCopy, readOperatorPauseRecord, resolvePausePendingRunId } from './static/ts/run-pause.js'

const pause = { message: 'The operator paused this run.', pausedAt: '2026-01-01T00:02:00.000Z' }
const suspension = { category: 'billing', resumePolicy: 'operator', message: 'Top up.', suspendedAt: '2026-01-01T00:02:00.000Z' }

describe('deriveRunPauseKind', () => {
	test('distinguishes an operator pause from a provider suspension and ignores every non-suspended status', () => {
		expect(deriveRunPauseKind({ status: 'suspended', pause })).toBe('operator')
		expect(deriveRunPauseKind({ status: 'suspended', suspension })).toBe('provider')
		expect(deriveRunPauseKind({ status: 'suspended' })).toBe('provider')
		expect(deriveRunPauseKind({ status: 'running', pause })).toBe('none')
		expect(deriveRunPauseKind(null)).toBe('none')
		expect(deriveRunPauseKind('suspended')).toBe('none')
	})

	test('the operator predicate and record reader reject malformed pause shapes', () => {
		expect(isOperatorPaused({ status: 'suspended', pause })).toBe(true)
		expect(readOperatorPauseRecord({ pause })).toEqual(pause)
		expect(readOperatorPauseRecord({ pause: { message: 'Paused.' } })).toBeNull()
		expect(isOperatorPaused({ status: 'suspended', pause: { message: 7, pausedAt: 'x' } })).toBe(false)
		expect(hasOperatorPausedRun([{ status: 'suspended', suspension }, { status: 'suspended', pause }])).toBe(true)
	})
})

describe('pause labels', () => {
	test('a suspended run reads Paused only for an operator pause', () => {
		expect(deriveSuspendedStatusLabel('suspended', 'operator')).toBe('paused')
		expect(deriveSuspendedStatusLabel('suspended', 'provider')).toBe('suspended')
		expect(deriveSuspendedStatusLabel('suspended', 'none')).toBe('suspended')
		expect(deriveSuspendedStatusLabel('running', 'operator')).toBeNull()
	})

	test('a provider suspension reads needs attention for a human or escalated deadline, while an operator pause stays paused', () => {
		const now = Date.parse('2026-01-01T00:10:00.000Z')
		const human = { status: 'suspended', suspension: { category: 'billing', resumePolicy: 'operator', message: 'Top up.', suspendedAt: '2026-01-01T00:02:00.000Z' } }
		const escalated = { status: 'suspended', suspension: { category: 'novel', disposition: 'novel', resumePolicy: 'auto', message: 'Unexpected.', suspendedAt: '2026-01-01T00:02:00.000Z', escalateAfter: '2026-01-01T00:05:00.000Z' } }
		const waiting = { status: 'suspended', suspension: { category: 'transient', resumePolicy: 'auto', message: 'Retrying.', suspendedAt: '2026-01-01T00:02:00.000Z' } }
		const recoverableEscalated = { status: 'suspended', suspension: { category: 'transient', disposition: 'recoverable', resumePolicy: 'auto', message: 'Retrying.', suspendedAt: '2026-01-01T00:02:00.000Z', escalateAfter: '2026-01-01T00:05:00.000Z' } }
		expect(deriveRunSuspendedStatusLabel(human, 'provider', now)).toBe('needs attention')
		expect(deriveRunSuspendedStatusLabel(escalated, 'provider', now)).toBe('needs attention')
		expect(deriveRunSuspendedStatusLabel(recoverableEscalated, 'provider', now)).toBe('needs attention')
		expect(deriveRunSuspendedStatusLabel(waiting, 'provider', now)).toBe('suspended')
		expect(deriveRunSuspendedStatusLabel(human, 'operator', now)).toBe('paused')
	})
})

describe('pause request decisions', () => {
	test('the target is the one genuinely running run and never an unknown or suspended run', () => {
		expect(derivePauseTargetRunId([{ runId: 'run-1', status: 'suspended', pause }], null)).toBeNull()
		expect(derivePauseTargetRunId([{ runId: 'run-1', status: 'unknown' }], null)).toBeNull()
		expect(derivePauseTargetRunId([{ runId: 'run-1', status: 'running' }], null)).toBe('run-1')
		expect(derivePauseTargetRunId([{ runId: 'run-1', status: 'running' }], 'run-1')).toBeNull()
	})

	test('a pending pause clears once the run is suspended or terminal, and stays while it is still running or unknown', () => {
		expect(resolvePausePendingRunId('run-1', [{ runId: 'run-1', status: 'running' }])).toBe('run-1')
		expect(resolvePausePendingRunId('run-1', [{ runId: 'run-1', status: 'unknown' }])).toBe('run-1')
		expect(resolvePausePendingRunId('run-1', [{ runId: 'run-1', status: 'suspended', pause }])).toBeNull()
		expect(resolvePausePendingRunId('run-1', [{ runId: 'run-1', status: 'success' }])).toBeNull()
		expect(resolvePausePendingRunId('run-1', [{ runId: 'run-2', status: 'running' }])).toBeNull()
		expect(resolvePausePendingRunId(null, [{ runId: 'run-1', status: 'running' }])).toBeNull()
	})

	test('pause refusals map every endpoint shape to useful compact copy', () => {
		expect(pauseFailureCopy({ error: 'not_found' }, 404)).toContain('could not be found')
		expect(pauseFailureCopy({ error: 'run_not_active' }, 409)).toContain('no longer active')
		expect(pauseFailureCopy({ error: 'run_paused' }, 409)).toContain('already paused')
		expect(pauseFailureCopy({ error: 'pause_write_failed', message: 'Disk is full.' }, 500)).toBe('Disk is full.')
		expect(pauseFailureCopy({}, 500)).toContain('could not be saved')
		expect(pauseFailureCopy({}, 400)).toContain('rejected')
	})
})
