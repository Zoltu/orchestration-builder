// On-demand operator diagnostics for a suspended run: the persisted suspension, the latest provider_failure event, and the recovery's last probe failure. The endpoint is deliberately outside every polled payload because the failure detail is raw provider text; this factory is pure over its readers so the route stays a thin 404-or-JSON branch. It scans only a bounded log tail, newest line first, so one click never reads or parses the whole ever-growing log.

import { isRunCheckpoint } from '../executor/checkpoint.js'
import type { ProviderProbeFailure } from '../executor/provider-recovery.js'
import { isRunIdShape } from '../executor/run-id.js'
import { dispositionOf, effectiveResumePolicy, isEscalationDue } from '../executor/suspension.js'
import type { FailureDisposition, LogEvent, ResumePolicy, SuspensionCategory, SuspensionRecord } from '../executor/types.js'
import { isObject, isRunMeta, isSuspensionCategory, safeJsonParse } from '../executor/validation.js'
import { parseLogEventLine } from '../run-log/parse.js'

// The producer bounds provider bodies to the same figure; the cap is a defensive backstop for a hand-edited or foreign log, never a silent re-truncation of an already bounded copy.
const MAX_DIAGNOSTIC_DETAIL_CHARS = 2000

// Diagnostics scans only this much of the log tail. The newest provider_failure is the one that caused the current suspension, so the whole ever-growing log (with full prompt/response bodies) must never be read or parsed for one operator click.
export const RUN_DIAGNOSTICS_LOG_TAIL_BYTES = 2 * 1024 * 1024

export interface RunDiagnosticsSuspension {
	category: SuspensionCategory
	disposition: FailureDisposition
	resumePolicy: ResumePolicy
	escalated: boolean
	suspendedAt: string
	autoResumeAfter?: string
	escalateAfter?: string
	resumeAttempts?: number
}

export interface RunDiagnosticsFailure {
	timestamp: string
	role: string
	roleId?: string
	category: SuspensionCategory
	httpStatus?: number
	attempts: number
	partialOutput: boolean
	detail?: string
}

export interface RunDiagnosticsProbeFailure {
	at: string
	category: SuspensionCategory
	httpStatus?: number
	detail?: string
}

export interface RunDiagnostics {
	runId: string
	suspension: RunDiagnosticsSuspension | null
	failure: RunDiagnosticsFailure | null
	probeFailure: RunDiagnosticsProbeFailure | null
}

export interface RunDiagnosticsDependencies {
	readRunMetaText: (runId: string) => string | null
	readRunCheckpointText: (runId: string) => string | null
	// Reads at most logTailMaxBytes from the end of the run's log; the leaf drops a leading partial line and returns null when the log is absent.
	readLogTail: (runId: string, maxBytes: number) => string | null
	logTailMaxBytes: number
	readSuspendedRunId: () => string | undefined
	readLastProbeFailure: () => ProviderProbeFailure | undefined
	now: () => string
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function boundedDetail(value: string | undefined): string | undefined {
	if (value === undefined) return undefined
	if (value.length <= MAX_DIAGNOSTIC_DETAIL_CHARS) return value
	return `${value.slice(0, MAX_DIAGNOSTIC_DETAIL_CHARS)}… [truncated]`
}

function suspensionFromMetaText(metaText: string | null): SuspensionRecord | undefined {
	if (metaText === null) return undefined
	const parsed = safeJsonParse(metaText)
	if (!parsed.ok || !isRunMeta(parsed.value)) return undefined
	if (parsed.value.status !== 'suspended') return undefined
	return parsed.value.suspension
}

function suspensionFromCheckpointText(checkpointText: string | null): SuspensionRecord | undefined {
	if (checkpointText === null) return undefined
	const parsed = safeJsonParse(checkpointText)
	if (!parsed.ok || !isRunCheckpoint(parsed.value)) return undefined
	return parsed.value.suspension
}

function diagnosticsSuspension(record: SuspensionRecord, now: string): RunDiagnosticsSuspension {
	return {
		category: record.category,
		disposition: dispositionOf(record),
		resumePolicy: effectiveResumePolicy(record, now),
		escalated: isEscalationDue(record, now),
		suspendedAt: record.suspendedAt,
		...(record.autoResumeAfter !== undefined ? { autoResumeAfter: record.autoResumeAfter } : {}),
		...(record.escalateAfter !== undefined ? { escalateAfter: record.escalateAfter } : {}),
		...(record.resumeAttempts !== undefined ? { resumeAttempts: record.resumeAttempts } : {}),
	}
}

function failureFromEvent(event: LogEvent): RunDiagnosticsFailure | null {
	if (event.type !== 'provider_failure' || !isObject(event.payload)) return null
	const payload = event.payload
	const role = payload['role']
	if (typeof role !== 'string' || role === '') return null
	const category = payload['category']
	if (!isSuspensionCategory(category)) return null
	const attempts = payload['attempts']
	if (!isNonNegativeInteger(attempts)) return null
	const partialOutput = payload['partialOutput']
	if (typeof partialOutput !== 'boolean') return null
	const roleId = payload['roleId']
	if (roleId !== undefined && typeof roleId !== 'string') return null
	const httpStatus = payload['httpStatus']
	if (httpStatus !== undefined && !isNonNegativeInteger(httpStatus)) return null
	const detail = payload['detail']
	if (detail !== undefined && typeof detail !== 'string') return null
	return {
		timestamp: event.timestamp,
		role,
		...(roleId !== undefined ? { roleId } : {}),
		category,
		...(httpStatus !== undefined ? { httpStatus } : {}),
		attempts,
		partialOutput,
		...(detail !== undefined ? { detail: boundedDetail(detail) } : {}),
	}
}

function latestProviderFailure(logTail: string): RunDiagnosticsFailure | null {
	let lineEnd = logTail.length
	while (lineEnd > 0) {
		const previousNewline = logTail.lastIndexOf('\n', lineEnd - 1)
		const lineStart = previousNewline + 1
		const line = logTail.slice(lineStart, lineEnd)
		lineEnd = previousNewline
		if (line === '') continue
		const event = parseLogEventLine(line)
		if (event === null) continue
		const failure = failureFromEvent(event)
		if (failure !== null) return failure
	}
	return null
}

function diagnosticsProbeFailure(value: ProviderProbeFailure | undefined, suspendedAt: string): RunDiagnosticsProbeFailure | null {
	if (value === undefined) return null
	const atMs = Date.parse(value.at)
	const suspendedAtMs = Date.parse(suspendedAt)
	if (Number.isNaN(atMs) || Number.isNaN(suspendedAtMs) || atMs < suspendedAtMs) return null
	return {
		at: value.at,
		category: value.category,
		...(value.httpStatus !== undefined ? { httpStatus: value.httpStatus } : {}),
		...(value.detail !== undefined ? { detail: boundedDetail(value.detail) } : {}),
	}
}

export function createRunDiagnostics(dependencies: RunDiagnosticsDependencies): (runId: string) => RunDiagnostics | null {
	return (runId) => {
		if (!isRunIdShape(runId)) return null
		// Meta presence is the known-run check; the log tail is read only after this and only for the bounded failure scan.
		const metaText = dependencies.readRunMetaText(runId)
		if (metaText === null) return null
		const checkpointText = dependencies.readRunCheckpointText(runId)
		const now = dependencies.now()
		const suspensionRecord = suspensionFromMetaText(metaText) ?? suspensionFromCheckpointText(checkpointText)
		const boundSuspendedRunId = dependencies.readSuspendedRunId()
		const probeFailure = boundSuspendedRunId === runId && suspensionRecord !== undefined
			? diagnosticsProbeFailure(dependencies.readLastProbeFailure(), suspensionRecord.suspendedAt)
			: null
		const logTail = dependencies.readLogTail(runId, dependencies.logTailMaxBytes) ?? ''
		return {
			runId,
			suspension: suspensionRecord === undefined ? null : diagnosticsSuspension(suspensionRecord, now),
			failure: latestProviderFailure(logTail),
			probeFailure,
		}
	}
}
