import { describe, expect, test } from 'bun:test'
import { classifyProviderFailure, hasBillingSignature, type ProviderFailureSignal } from './provider-failure.ts'

const NOW = Date.parse('2026-01-01T00:00:00.000Z')

function classify(signal: Partial<ProviderFailureSignal>): ReturnType<typeof classifyProviderFailure> {
	return classifyProviderFailure({ transport: false, ...signal }, NOW)
}

describe('classifyProviderFailure status categories', () => {
	test('402 is billing', () => {
		const failure = classify({ status: 402, errorBody: 'payment required' })
		expect(failure.category).toBe('billing')
		expect(failure.httpStatus).toBe(402)
		expect(failure.retryAfterMs).toBeUndefined()
	})

	test('401 is auth', () => {
		expect(classify({ status: 401, errorBody: 'unauthorized' }).category).toBe('auth')
	})

	test('403 without a billing signature is auth', () => {
		expect(classify({ status: 403, errorBody: 'forbidden' }).category).toBe('auth')
	})

	test('403 with a quota signature is billing', () => {
		const failure = classify({ status: 403, errorBody: '{"error":{"code":"insufficient_quota"}}' })
		expect(failure.category).toBe('billing')
		expect(failure.httpStatus).toBe(403)
	})

	test('429 without a billing signature is transient', () => {
		const failure = classify({ status: 429, errorBody: 'rate limited' })
		expect(failure.category).toBe('transient')
		expect(failure.httpStatus).toBe(429)
	})

	test('429 with a quota signature is billing', () => {
		expect(classify({ status: 429, errorBody: 'insufficient_quota: please check your plan' }).category).toBe('billing')
	})

	test.each([408, 425, 500, 502, 503, 504, 599])('%i is transient', (status) => {
		const failure = classify({ status, errorBody: 'oops' })
		expect(failure.category).toBe('transient')
		expect(failure.httpStatus).toBe(status)
	})

	test.each([200, 204])('%i is transient with an unreadable-response message', (status) => {
		const failure = classify({ status, errorBody: '' })
		expect(failure.category).toBe('transient')
		expect(failure.httpStatus).toBe(status)
		expect(failure.message).toContain('empty or unreadable response')
		expect(failure.message).toContain(`HTTP ${status}`)
		expect(failure.message).not.toContain('could not be reached')
	})

	test('a transport failure is transient with no status', () => {
		const failure = classifyProviderFailure({ transport: true }, NOW)
		expect(failure.category).toBe('transient')
		expect(failure.httpStatus).toBeUndefined()
		expect(failure.message).toBe('The model provider could not be reached')
	})

	test.each([400, 404, 405, 415, 422, 409, 413])('%i is request_rejected', (status) => {
		const failure = classify({ status, errorBody: 'bad request' })
		expect(failure.category).toBe('request_rejected')
		expect(failure.httpStatus).toBe(status)
	})
})

describe('classifyProviderFailure precedence', () => {
	test('401 with a billing-looking body stays auth', () => {
		expect(classify({ status: 401, errorBody: 'insufficient_quota: billing required' }).category).toBe('auth')
	})

	test('403 with an unrelated billing mention stays auth', () => {
		expect(classify({ status: 403, errorBody: 'contact the billing department' }).category).toBe('auth')
	})

	test('429 with an unrelated billing mention stays transient', () => {
		expect(classify({ status: 429, errorBody: 'the billing service is degraded' }).category).toBe('transient')
	})

	test('400 with a billing-looking body is request_rejected, not billing', () => {
		expect(classify({ status: 400, errorBody: 'billing required: add credit balance' }).category).toBe('request_rejected')
	})

	test('413 with a billing-looking body is request_rejected, not billing', () => {
		expect(classify({ status: 413, errorBody: 'insufficient_quota: payload too large' }).category).toBe('request_rejected')
	})

	test('5xx with a billing mention stays transient', () => {
		expect(classify({ status: 503, errorBody: 'billing service unavailable' }).category).toBe('transient')
	})

	test('5xx with a genuine quota phrase still stays transient because 5xx is a transport category', () => {
		expect(classify({ status: 500, errorBody: 'insufficient_quota' }).category).toBe('transient')
	})
})

describe('billing signatures', () => {
	const phrases = [
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

	test.each(phrases)('recognizes the phrase %s case-insensitively', (phrase) => {
		expect(hasBillingSignature(`The provider said: ${phrase.toUpperCase()}`)).toBe(true)
		expect(classify({ status: 429, errorBody: `The provider said: ${phrase}` }).category).toBe('billing')
	})

	test.each([403, 429])('%i with a plain-text insufficient-credit body is billing', (status) => {
		expect(classify({ status, errorBody: 'Insufficient credit: please top up your account' }).category).toBe('billing')
	})

	test.each(['insufficient_quota', 'quota_exceeded', 'insufficient_credit', 'payment_required', 'billing', 'billing_hard_limit_reached', 'billing_not_active'])('recognizes the structured code %s', (code) => {
		expect(hasBillingSignature(JSON.stringify({ error: { code } }))).toBe(true)
		expect(classify({ status: 403, errorBody: JSON.stringify({ error: { code } }) }).category).toBe('billing')
	})

	test('a bare billing word is not a signature', () => {
		expect(hasBillingSignature('billing')).toBe(false)
	})

	test('a non-billing body has no billing signature', () => {
		expect(hasBillingSignature('rate limited; try again later')).toBe(false)
		expect(hasBillingSignature(undefined)).toBe(false)
		expect(hasBillingSignature('')).toBe(false)
	})

	test('the platform-authored message never contains the provider body', () => {
		const body = 'insufficient_quota for key sk-secret and request payload {"prompt":"private"}'
		const failure = classify({ status: 429, errorBody: body })
		expect(failure.message).not.toContain(body)
		expect(failure.message).not.toContain('sk-secret')
		expect(failure.message).not.toContain('private')
		expect(failure.message).toContain('insufficient quota or credit')
	})
})

describe('classifyProviderFailure Retry-After', () => {
	test('parses delta seconds', () => {
		expect(classify({ status: 503, errorBody: '', retryAfterHeader: '120' }).retryAfterMs).toBe(120_000)
		expect(classify({ status: 503, errorBody: '', retryAfterHeader: ' 0 ' }).retryAfterMs).toBe(0)
	})

	test('parses a future HTTP-date relative to now', () => {
		const future = new Date(NOW + 5_000).toUTCString()
		expect(classify({ status: 503, errorBody: '', retryAfterHeader: future }).retryAfterMs).toBe(5_000)
	})

	test('parses a future ISO-8601 timestamp with an explicit UTC zone', () => {
		expect(classify({ status: 503, errorBody: '', retryAfterHeader: new Date(NOW + 4_000).toISOString() }).retryAfterMs).toBe(4_000)
	})

	test('parses a future ISO-8601 timestamp with an explicit numeric offset', () => {
		const withOffset = new Date(NOW + 4_000).toISOString().replace('Z', '+00:00')
		expect(classify({ status: 503, errorBody: '', retryAfterHeader: withOffset }).retryAfterMs).toBe(4_000)
	})

	test('a past HTTP-date yields no delay', () => {
		const past = new Date(NOW - 5_000).toUTCString()
		expect(classify({ status: 503, errorBody: '', retryAfterHeader: past }).retryAfterMs).toBeUndefined()
	})

	test('an HTTP-date equal to now yields no delay', () => {
		expect(classify({ status: 503, errorBody: '', retryAfterHeader: new Date(NOW).toUTCString() }).retryAfterMs).toBeUndefined()
	})

	test('malformed and empty values yield no delay', () => {
		for (const value of ['soon', '', '   ', '1.5', '-5', '+5', '999999999999999999999']) {
			expect(classify({ status: 503, errorBody: '', retryAfterHeader: value }).retryAfterMs).toBeUndefined()
		}
	})

	test('a zone-less ISO timestamp is rejected rather than read in host-local time', () => {
		expect(classify({ status: 503, errorBody: '', retryAfterHeader: '2030-01-01T00:00:04.000' }).retryAfterMs).toBeUndefined()
	})

	test('an HTTP-date without the GMT zone is rejected', () => {
		expect(classify({ status: 503, errorBody: '', retryAfterHeader: 'Thu, 01 Jan 2026 00:00:04' }).retryAfterMs).toBeUndefined()
	})

	test('an absent header yields no delay', () => {
		expect(classify({ status: 503, errorBody: '' }).retryAfterMs).toBeUndefined()
	})

	test('a huge well-formed delta-seconds value is carried through for the caller to reject', () => {
		expect(classify({ status: 429, errorBody: 'rate limited', retryAfterHeader: '3600' }).retryAfterMs).toBe(3_600_000)
	})
})
