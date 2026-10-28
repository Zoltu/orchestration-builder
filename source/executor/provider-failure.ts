import type { ProviderFailureCategory } from './types.js'
import { asRecord, safeJsonParse } from './validation.js'

export interface ProviderFailureSignal {
	status?: number
	retryAfterHeader?: string
	errorBody?: string
	transport: boolean
}

export interface ProviderFailureClassification {
	category: ProviderFailureCategory
	httpStatus?: number
	retryAfterMs?: number
	message: string
}

const BILLING_CODES: readonly string[] = [
	'insufficient_quota',
	'quota_exceeded',
	'insufficient_credit',
	'payment_required',
	'billing',
	'billing_hard_limit_reached',
	'billing_not_active',
]

// Phrases, not bare "billing": a request-rejected or server-error body may mention billing without being a quota failure.
const BILLING_PHRASES: readonly string[] = [
	'insufficient_quota',
	'insufficient quota',
	'insufficient credit',
	'quota exceeded',
	'exceeded your current quota',
	'out of credit',
	'credit balance',
	'credit exhausted',
	'no credit remaining',
	'payment required',
	'billing hard limit',
	'billing not active',
	'billing account',
	'billing details',
	'billing error',
	'billing issue',
	'billing required',
	'update your billing',
	'check your billing',
]

function hasStructuredBillingCode(errorBody: string): boolean {
	const parsed = safeJsonParse(errorBody)
	if (!parsed.ok) return false
	const root = asRecord(parsed.value)
	if (root === undefined) return false
	const errorRecord = asRecord(root['error'])
	for (const record of [root, errorRecord]) {
		if (record === undefined) continue
		for (const field of ['code', 'type']) {
			const value = record[field]
			if (typeof value === 'string' && BILLING_CODES.includes(value.toLowerCase())) return true
		}
	}
	return false
}

export function hasBillingSignature(errorBody: string | undefined): boolean {
	if (errorBody === undefined) return false
	if (hasStructuredBillingCode(errorBody)) return true
	const lowered = errorBody.toLowerCase()
	return BILLING_PHRASES.some((phrase) => lowered.includes(phrase))
}

// Retry-After is delta-seconds or a date with an explicit zone. Zone-less date-times are rejected because Date.parse reads them in the host's local time, making the wait depend on deployment geography.
function parseRetryAfterMs(value: string | undefined, nowMs: number): number | undefined {
	if (value === undefined) return undefined
	const trimmed = value.trim()
	if (trimmed === '') return undefined
	if (/^\d+$/.test(trimmed)) {
		const seconds = Number.parseInt(trimmed, 10)
		if (!Number.isSafeInteger(seconds)) return undefined
		const milliseconds = seconds * 1000
		if (!Number.isSafeInteger(milliseconds)) return undefined
		return milliseconds
	}
	if (/^[+-]?\d/.test(trimmed)) {
		// ISO-8601 is accepted only with a trailing Z or numeric offset; the Date.parse fallback is otherwise host-local.
		if (!/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) return undefined
		if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) return undefined
	} else if (!/GMT$/i.test(trimmed)) {
		// Spec HTTP-dates are GMT; rejecting other zone-less forms keeps the wait deterministic across hosts.
		return undefined
	}
	const parsed = Date.parse(trimmed)
	if (Number.isNaN(parsed)) return undefined
	const delta = parsed - nowMs
	if (delta <= 0) return undefined
	return delta
}

function failureMessage(category: ProviderFailureCategory, status: number | undefined): string {
	const suffix = status === undefined ? '' : ` (HTTP ${status})`
	if (category === 'billing') return `The model provider reports insufficient quota or credit${suffix}`
	if (category === 'auth') return `The model provider rejected the credentials or access${suffix}`
	if (category === 'request_rejected') return `The model provider rejected the request${suffix}`
	if (status !== undefined && status >= 200 && status < 300) return `The model provider returned an empty or unreadable response${suffix}`
	if (status === 429) return `The model provider is rate limiting requests${suffix}`
	if (status === 408 || status === 425) return `The model provider timed out or is temporarily unavailable${suffix}`
	if (status !== undefined && status >= 500) return `The model provider is temporarily unavailable${suffix}`
	return `The model provider could not be reached${suffix}`
}

export function classifyProviderFailure(signal: ProviderFailureSignal, nowMs: number): ProviderFailureClassification {
	const status = signal.status
	const billingSignature = hasBillingSignature(signal.errorBody)
	let category: ProviderFailureCategory
	if (signal.transport) category = 'transient'
	else if (status === 402) category = 'billing'
	else if (status === 401) category = 'auth'
	else if (status === 403) category = billingSignature ? 'billing' : 'auth'
	else if (status === 429) category = billingSignature ? 'billing' : 'transient'
	else if (status !== undefined && status >= 200 && status < 300) category = 'transient'
	else if (status === 408 || status === 425) category = 'transient'
	else if (status !== undefined && status >= 500 && status <= 599) category = 'transient'
	else if (status === 400 || status === 404 || status === 405 || status === 415 || status === 422) category = 'request_rejected'
	else if (status !== undefined && status >= 400 && status < 500) category = 'request_rejected'
	else category = 'transient'

	const classification: ProviderFailureClassification = {
		category,
		message: failureMessage(category, status),
	}
	if (status !== undefined) classification.httpStatus = status
	const retryAfterMs = parseRetryAfterMs(signal.retryAfterHeader, nowMs)
	if (retryAfterMs !== undefined) classification.retryAfterMs = retryAfterMs
	return classification
}

// An in-band SSE error payload can carry the provider's numeric status, textual error type, or billing signature. Classify it like an HTTP error so a mid-stream 402/auth/request-rejection does not become a retryable transport failure.
export function classifyStreamProviderFailure(payload: Record<string, unknown>): ProviderFailureClassification {
	const body = JSON.stringify(payload)
	const errorRecord = asRecord(payload['error'])
	for (const candidate of [payload, errorRecord]) {
		if (candidate === undefined) continue
		for (const field of ['status', 'status_code', 'code']) {
			const value = candidate[field]
			if (typeof value === 'number' && Number.isInteger(value)) return classifyProviderFailure({ status: value, errorBody: body, transport: false }, 0)
			if (typeof value === 'string' && /^\d{3}$/.test(value)) return classifyProviderFailure({ status: Number(value), errorBody: body, transport: false }, 0)
		}
	}
	const textualCode = streamErrorCode(payload)
	if (textualCode !== undefined) {
		if (textualCode === 'authentication_error' || textualCode === 'invalid_api_key' || textualCode === 'unauthorized') return classifyProviderFailure({ status: 401, errorBody: body, transport: false }, 0)
		if (textualCode === 'permission_error' || textualCode === 'forbidden') return classifyProviderFailure({ status: 403, errorBody: body, transport: false }, 0)
		if (textualCode === 'invalid_request_error' || textualCode === 'bad_request') return classifyProviderFailure({ status: 400, errorBody: body, transport: false }, 0)
		if (textualCode === 'not_found_error') return classifyProviderFailure({ status: 404, errorBody: body, transport: false }, 0)
	}
	if (hasBillingSignature(body)) return classifyProviderFailure({ status: 402, errorBody: body, transport: false }, 0)
	if (textualCode === 'rate_limit_error') return classifyProviderFailure({ status: 429, errorBody: body, transport: false }, 0)
	if (textualCode === 'server_error') return classifyProviderFailure({ status: 500, errorBody: body, transport: false }, 0)
	return classifyProviderFailure({ transport: true }, 0)
}

function streamErrorCode(payload: Record<string, unknown>): string | undefined {
	const errorRecord = asRecord(payload['error'])
	for (const candidate of [payload, errorRecord]) {
		if (candidate === undefined) continue
		for (const field of ['type', 'code']) {
			const value = candidate[field]
			if (typeof value === 'string' && value.toLowerCase() !== 'error') return value.toLowerCase()
		}
	}
	return undefined
}
