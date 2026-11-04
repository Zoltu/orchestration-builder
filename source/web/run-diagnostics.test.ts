import { describe, expect, test } from 'bun:test'
import { createRunDiagnostics, RUN_DIAGNOSTICS_LOG_TAIL_BYTES } from './run-diagnostics.js'
import type { ProviderProbeFailure } from '../executor/provider-recovery.js'
import type { SuspensionRecord } from '../executor/types.js'

const NOW = '2026-01-01T00:10:00.000Z'
const RUN_ID = 'run-20260101-000500'

function meta(status: string, suspension?: SuspensionRecord): string {
	return JSON.stringify({
		runId: RUN_ID,
		task: 'task for the run',
		status,
		startTime: '2026-01-01T00:00:00.000Z',
		...(suspension !== undefined ? { suspension } : {}),
	})
}

function suspension(overrides: Partial<SuspensionRecord> = {}): SuspensionRecord {
	return {
		category: 'transient',
		resumePolicy: 'auto',
		message: 'The model provider is temporarily unavailable.',
		suspendedAt: '2026-01-01T00:02:00.000Z',
		resumeAttempts: 1,
		...overrides,
	}
}

function failureLine(overrides: Record<string, unknown> = {}, timestamp = '2026-01-01T00:02:00.000Z'): string {
	return JSON.stringify({
		timestamp,
		type: 'provider_failure',
		payload: {
			role: 'coder',
			roleId: 'coder-1',
			category: 'transient',
			httpStatus: 503,
			attempts: 3,
			partialOutput: false,
			detail: 'provider body',
			...overrides,
		},
	})
}

interface DiagnosticsOptions {
	metaText?: string | null
	checkpointText?: string | null
	logTail?: string | null
	readLogTail?: (runId: string, maxBytes: number) => string | null
	logTailMaxBytes?: number
	boundRunId?: string
	probeFailure?: ProviderProbeFailure
	readRunMetaText?: (runId: string) => string | null
	readRunCheckpointText?: (runId: string) => string | null
}

function diagnosticsFor(options: DiagnosticsOptions) {
	return createRunDiagnostics({
		readRunMetaText: options.readRunMetaText ?? (() => options.metaText ?? null),
		readRunCheckpointText: options.readRunCheckpointText ?? (() => options.checkpointText ?? null),
		readLogTail: options.readLogTail ?? (() => options.logTail ?? null),
		logTailMaxBytes: options.logTailMaxBytes ?? RUN_DIAGNOSTICS_LOG_TAIL_BYTES,
		readSuspendedRunId: () => options.boundRunId,
		readLastProbeFailure: () => options.probeFailure,
		now: () => NOW,
	})
}

describe('createRunDiagnostics', () => {
	test('selects the most recent provider_failure event in the tail and keeps its bounded detail', () => {
		const read = diagnosticsFor({
			metaText: meta('suspended', suspension()),
			logTail: [failureLine({ detail: 'older body' }), JSON.stringify({ timestamp: '2026-01-01T00:03:00.000Z', type: 'role_finished', payload: { role: 'coder' } }), failureLine({ detail: 'newest body', attempts: 4 }, '2026-01-01T00:04:00.000Z')].join('\n'),
		})
		const diagnostics = read(RUN_ID)
		if (diagnostics === null) throw new Error('expected diagnostics')
		expect(diagnostics.failure?.timestamp).toBe('2026-01-01T00:04:00.000Z')
		expect(diagnostics.failure?.attempts).toBe(4)
		expect(diagnostics.failure?.detail).toBe('newest body')
	})

	test('asks the tail reader for at most the configured bound and finds the newest failure in a huge log', () => {
		let requestedRunId: string | undefined
		let requestedBytes: number | undefined
		const read = diagnosticsFor({
			metaText: meta('suspended', suspension()),
			logTailMaxBytes: 2048,
			readLogTail: (runId, maxBytes) => {
				requestedRunId = runId
				requestedBytes = maxBytes
				return [failureLine({ detail: 'still in tail' }, '2026-01-01T00:04:00.000Z')].join('\n')
			},
		})
		const diagnostics = read(RUN_ID)
		if (diagnostics === null) throw new Error('expected diagnostics')
		expect(requestedRunId).toBe(RUN_ID)
		expect(requestedBytes).toBe(2048)
		expect(diagnostics.failure?.detail).toBe('still in tail')
	})

	test('a failure older than the retained tail is not reported', () => {
		const diagnostics = diagnosticsFor({
			metaText: meta('suspended', suspension()),
			logTail: ['partial line from the cut', JSON.stringify({ timestamp: '2026-01-01T00:03:00.000Z', type: 'role_finished', payload: { role: 'coder' } })].join('\n'),
		})(RUN_ID)
		if (diagnostics === null) throw new Error('expected diagnostics')
		expect(diagnostics.failure).toBeNull()
	})

	test('a failure event without a provider body has no detail field', () => {
		const line = failureLine()
		const withoutDetail = JSON.stringify({ ...JSON.parse(line), payload: { role: 'coder', category: 'transient', attempts: 1, partialOutput: true } })
		const diagnostics = diagnosticsFor({ metaText: meta('suspended', suspension()), logTail: withoutDetail })(RUN_ID)
		if (diagnostics === null) throw new Error('expected diagnostics')
		expect(diagnostics.failure?.detail).toBeUndefined()
		expect(diagnostics.failure?.partialOutput).toBe(true)
	})

	test('ignores malformed log lines and malformed provider_failure payloads', () => {
		const malformedEvent = JSON.stringify({ timestamp: '2026-01-01T00:04:00.000Z', type: 'provider_failure', payload: { role: 'coder', category: 'bogus', attempts: 1, partialOutput: false } })
		const diagnostics = diagnosticsFor({ metaText: meta('suspended', suspension()), logTail: ['not json', '', malformedEvent, failureLine()].join('\n') })(RUN_ID)
		if (diagnostics === null) throw new Error('expected diagnostics')
		expect(diagnostics.failure?.category).toBe('transient')
	})

	test('the probe failure is included only when recovery is bound to this run and the failure is current', () => {
		const current: ProviderProbeFailure = { at: '2026-01-01T00:05:00.000Z', category: 'transient', httpStatus: 503, detail: 'probe body' }
		const bound = diagnosticsFor({ metaText: meta('suspended', suspension()), boundRunId: RUN_ID, probeFailure: current })(RUN_ID)
		if (bound === null) throw new Error('expected diagnostics')
		expect(bound.probeFailure).toEqual(current)
		const other = diagnosticsFor({ metaText: meta('suspended', suspension()), boundRunId: 'run-20260101-000600', probeFailure: current })(RUN_ID)
		if (other === null) throw new Error('expected diagnostics')
		expect(other.probeFailure).toBeNull()
		const earlierBinding: ProviderProbeFailure = { ...current, at: '2026-01-01T00:01:00.000Z' }
		const stale = diagnosticsFor({ metaText: meta('suspended', suspension()), boundRunId: RUN_ID, probeFailure: earlierBinding })(RUN_ID)
		if (stale === null) throw new Error('expected diagnostics')
		expect(stale.probeFailure).toBeNull()
		const atSuspension: ProviderProbeFailure = { ...current, at: '2026-01-01T00:02:00.000Z' }
		const boundary = diagnosticsFor({ metaText: meta('suspended', suspension()), boundRunId: RUN_ID, probeFailure: atSuspension })(RUN_ID)
		if (boundary === null) throw new Error('expected diagnostics')
		expect(boundary.probeFailure).toEqual(atSuspension)
	})

	test('derives legacy dispositions from category and effective policy from the escalation deadline', () => {
		const human = diagnosticsFor({ metaText: meta('suspended', suspension({ category: 'transient', resumePolicy: 'operator', disposition: undefined })) })(RUN_ID)
		if (human === null) throw new Error('expected diagnostics')
		expect(human.suspension?.disposition).toBe('human')
		expect(human.suspension?.resumePolicy).toBe('operator')
		const recoverable = diagnosticsFor({ metaText: meta('suspended', suspension({ category: 'transient', resumePolicy: 'auto', disposition: undefined })) })(RUN_ID)
		if (recoverable === null) throw new Error('expected diagnostics')
		expect(recoverable.suspension?.disposition).toBe('recoverable')
		expect(recoverable.suspension?.resumePolicy).toBe('auto')
		const novelEscalated = diagnosticsFor({ metaText: meta('suspended', suspension({ category: 'novel', disposition: 'novel', resumePolicy: 'auto', escalateAfter: '2026-01-01T00:05:00.000Z' })) })(RUN_ID)
		if (novelEscalated === null) throw new Error('expected diagnostics')
		expect(novelEscalated.suspension?.disposition).toBe('novel')
		expect(novelEscalated.suspension?.escalated).toBe(true)
		expect(novelEscalated.suspension?.resumePolicy).toBe('operator')
		const recoverableIncident = diagnosticsFor({ metaText: meta('suspended', suspension({ category: 'transient', disposition: 'recoverable', resumePolicy: 'auto', escalateAfter: '2026-01-01T00:05:00.000Z' })) })(RUN_ID)
		if (recoverableIncident === null) throw new Error('expected diagnostics')
		expect(recoverableIncident.suspension?.disposition).toBe('recoverable')
		expect(recoverableIncident.suspension?.escalated).toBe(true)
		expect(recoverableIncident.suspension?.resumePolicy).toBe('operator')
	})

	test('invalid run ids never reach the readers and an absent meta is an unknown run', () => {
		let reads = 0
		const read = diagnosticsFor({
			readRunMetaText: () => {
				reads += 1
				return meta('suspended', suspension())
			},
			readRunCheckpointText: () => {
				reads += 1
				return null
			},
			readLogTail: () => {
				reads += 1
				return failureLine()
			},
		})
		expect(read('../run-20260101-000500')).toBeNull()
		expect(read('run-1')).toBeNull()
		expect(read('')).toBeNull()
		expect(reads).toBe(0)
		const unknown = diagnosticsFor({ metaText: null, logTail: failureLine() })
		expect(unknown('run-20260101-999999')).toBeNull()
	})

	test('never exposes provider URLs, models, keys, headers, or unlisted fields', () => {
		const leaky = failureLine({ apiBase: 'https://private.example/v1', model: 'private-model', apiKey: 'sk-secret', headers: { authorization: 'Bearer secret' } })
		const diagnostics = diagnosticsFor({ metaText: meta('suspended', suspension()), logTail: leaky })(RUN_ID)
		if (diagnostics === null) throw new Error('expected diagnostics')
		const serialized = JSON.stringify(diagnostics)
		for (const secret of ['private.example', 'private-model', 'sk-secret', 'authorization', 'apiBase', 'apiKey']) {
			expect(serialized).not.toContain(secret)
		}
		expect(Object.keys(diagnostics).sort()).toEqual(['failure', 'probeFailure', 'runId', 'suspension'])
	})

	test('caps an oversized detail defensively with an explicit marker', () => {
		const oversized = 'x'.repeat(3000)
		const diagnostics = diagnosticsFor({ metaText: meta('suspended', suspension()), logTail: failureLine({ detail: oversized }) })(RUN_ID)
		if (diagnostics === null) throw new Error('expected diagnostics')
		expect(diagnostics.failure?.detail?.length).toBeLessThanOrEqual(2014)
		expect(diagnostics.failure?.detail?.endsWith('… [truncated]')).toBe(true)
	})
})

describe('createRunDiagnostics checkpoint fallback', () => {
	test('reads the suspension from a checkpoint when the meta has no suspension', () => {
		const checkpoint = JSON.stringify({
			version: 2,
			runId: RUN_ID,
			startTime: '2026-01-01T00:00:00.000Z',
			registryCounter: 1,
			suspension: suspension({ category: 'billing', resumePolicy: 'operator', disposition: 'human' }),
			frames: [{
				roleId: 'orchestrator-0-1',
				roleName: 'orchestrator',
				depth: 0,
				task: 'task for the run',
				roleState: {
					history: [{ role: 'system', content: 'prompt' }, { role: 'user', content: 'task' }],
					protectedPrefixLength: 2,
					lastPromptTokens: 10,
					recentCompactionPromptTokens: [],
					recentToolCalls: [],
					toolCallCount: 0,
					generatedTokens: 0,
					contextExceededAttempts: 0,
					loopCheckToolCallWatermark: 0,
					loopCheckTokenWatermark: 0,
				},
			}],
		})
		const diagnostics = diagnosticsFor({
			metaText: meta('running'),
			checkpointText: checkpoint,
		})(RUN_ID)
		if (diagnostics === null) throw new Error('expected diagnostics')
		expect(diagnostics.suspension?.category).toBe('billing')
		expect(diagnostics.suspension?.disposition).toBe('human')
		expect(diagnostics.suspension?.resumePolicy).toBe('operator')
	})
})
