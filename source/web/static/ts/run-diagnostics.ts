// The on-demand diagnostics payload behind GET /api/runs/:id/diagnostics, validated at the browser boundary like every other external response. The raw provider detail stays preformatted text; nothing here ever enters the Markdown pipeline.

import { isObject } from './guards.js'
import type { FailureDisposition, ResumePolicy, SuspensionCategory } from './interaction-model.js'

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

export type SuspendedDiagnosticsLoad =
	| { status: 'loading' }
	| { status: 'ready'; data: RunDiagnostics }
	| { status: 'failed' }

export interface SuspendedDiagnosticsRecord {
	runId: string
	// The request that produced or is producing this load. A response may only replace a record carrying the same token, so a late failure or success for an older request cannot overwrite a newer one.
	token: number
	load: SuspendedDiagnosticsLoad
}

export interface SuspendedDiagnosticsOpenPlan {
	open: boolean
	request: boolean
}

// The disclosure fetches on the first open only: any record for the same run is reused, including a failed one whose own Retry affordance issues the next request.
export function planSuspendedDiagnosticsOpen(record: SuspendedDiagnosticsRecord | null, runId: string, opened: boolean): SuspendedDiagnosticsOpenPlan {
	if (!opened) return { open: false, request: false }
	if (record !== null && record.runId === runId) return { open: true, request: false }
	return { open: true, request: true }
}

export function diagnosticsResponseApplies(record: SuspendedDiagnosticsRecord | null, runId: string, token: number): boolean {
	return record !== null && record.runId === runId && record.token === token
}

function isSuspensionCategory(value: unknown): value is SuspensionCategory {
	return value === 'transient' || value === 'billing' || value === 'auth' || value === 'request_rejected' || value === 'novel' || value === 'unknown'
}

function isFailureDisposition(value: unknown): value is FailureDisposition {
	return value === 'human' || value === 'recoverable' || value === 'novel'
}

function isResumePolicy(value: unknown): value is ResumePolicy {
	return value === 'auto' || value === 'operator'
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === 'string'
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
	return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0)
}

function isRunDiagnosticsSuspension(value: unknown): value is RunDiagnosticsSuspension {
	if (!isObject(value)) return false
	if (!isSuspensionCategory(value['category'])) return false
	if (!isFailureDisposition(value['disposition'])) return false
	if (!isResumePolicy(value['resumePolicy'])) return false
	if (typeof value['escalated'] !== 'boolean') return false
	if (typeof value['suspendedAt'] !== 'string') return false
	if (!isOptionalString(value['autoResumeAfter'])) return false
	if (!isOptionalString(value['escalateAfter'])) return false
	return isOptionalNonNegativeInteger(value['resumeAttempts'])
}

function isRunDiagnosticsFailure(value: unknown): value is RunDiagnosticsFailure {
	if (!isObject(value)) return false
	if (typeof value['timestamp'] !== 'string') return false
	if (typeof value['role'] !== 'string' || value['role'] === '') return false
	if (!isOptionalString(value['roleId'])) return false
	if (!isSuspensionCategory(value['category'])) return false
	if (!isOptionalNonNegativeInteger(value['httpStatus'])) return false
	if (!isOptionalNonNegativeInteger(value['attempts']) || value['attempts'] === undefined) return false
	if (typeof value['partialOutput'] !== 'boolean') return false
	return isOptionalString(value['detail'])
}

function isRunDiagnosticsProbeFailure(value: unknown): value is RunDiagnosticsProbeFailure {
	if (!isObject(value)) return false
	if (typeof value['at'] !== 'string') return false
	if (!isSuspensionCategory(value['category'])) return false
	if (!isOptionalNonNegativeInteger(value['httpStatus'])) return false
	return isOptionalString(value['detail'])
}

export function isRunDiagnostics(value: unknown): value is RunDiagnostics {
	if (!isObject(value)) return false
	if (typeof value['runId'] !== 'string' || value['runId'] === '') return false
	const suspension = value['suspension']
	if (suspension !== null && !isRunDiagnosticsSuspension(suspension)) return false
	const failure = value['failure']
	if (failure !== null && !isRunDiagnosticsFailure(failure)) return false
	const probeFailure = value['probeFailure']
	if (probeFailure !== null && !isRunDiagnosticsProbeFailure(probeFailure)) return false
	return true
}

export function diagnosticsCopyJson(diagnostics: RunDiagnostics): string {
	return JSON.stringify(diagnostics)
}
