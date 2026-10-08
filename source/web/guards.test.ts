import { describe, expect, test } from 'bun:test'
import { isOperationMetricsRecord } from './static/ts/guards.js'

// The shared metrics-record guard both wire ingress points run (the product client's and the dev
// harness's flow-model guards, source/web/static/ts/app.ts + demo.ts, both delegating here): a
// polled flow model whose metrics carry a malformed counter must fall to the placeholder branch
// instead of poisoning the cost strip or the top-bar totals downstream.
describe('isOperationMetricsRecord', () => {
	test('accepts a full record with every counter numeric or null', () => {
		expect(isOperationMetricsRecord({ tokens: 120, promptTokens: 100, completionTokens: 20, cachedPromptTokens: 40, lastPromptTokens: 100, elapsedSeconds: 5 })).toBe(true)
		expect(isOperationMetricsRecord({ tokens: null, promptTokens: null, completionTokens: null, cachedPromptTokens: null, lastPromptTokens: null, elapsedSeconds: null })).toBe(true)
		// A reported zero is endpoint data, not absence.
		expect(isOperationMetricsRecord({ tokens: 0, promptTokens: 0, completionTokens: 0, cachedPromptTokens: null, lastPromptTokens: 0, elapsedSeconds: 0 })).toBe(true)
	})

	test('rejects a malformed new field (lastPromptTokens) like every other counter', () => {
		const base = { tokens: 1, promptTokens: 1, completionTokens: 1, cachedPromptTokens: null, lastPromptTokens: 1, elapsedSeconds: 1 }
		expect(isOperationMetricsRecord({ ...base, lastPromptTokens: null })).toBe(true)
		expect(isOperationMetricsRecord({ ...base, lastPromptTokens: 'many' })).toBe(false)
		expect(isOperationMetricsRecord({ ...base, lastPromptTokens: NaN })).toBe(false)
		expect(isOperationMetricsRecord({ ...base, lastPromptTokens: Infinity })).toBe(false)
		expect(isOperationMetricsRecord({ ...base, lastPromptTokens: undefined })).toBe(false)
		// A record missing the field entirely is malformed: the adapter always emits every counter, so an absent field is a broken producer.
		const { lastPromptTokens: _omitted, ...missing } = base
		expect(isOperationMetricsRecord(missing)).toBe(false)
	})

	test('still rejects malformed legacy counters and non-records', () => {
		const base = { tokens: 1, promptTokens: 1, completionTokens: 1, cachedPromptTokens: null, lastPromptTokens: 1, elapsedSeconds: 1 }
		expect(isOperationMetricsRecord({ ...base, tokens: NaN })).toBe(false)
		expect(isOperationMetricsRecord({ ...base, elapsedSeconds: 'soon' })).toBe(false)
		expect(isOperationMetricsRecord(null)).toBe(false)
		expect(isOperationMetricsRecord('metrics')).toBe(false)
		expect(isOperationMetricsRecord([])).toBe(false)
	})
})
