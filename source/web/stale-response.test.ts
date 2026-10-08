import { describe, expect, test } from 'bun:test'
import { responseBelongsToSelection } from './static/ts/stale-response.js'

describe('responseBelongsToSelection', () => {
	test('accepts a response that identifies itself as the selected run', () => {
		expect(responseBelongsToSelection('run-1', 'run-1')).toBe(true)
	})

	test('drops a response for a different run (a late frame for the previously selected run)', () => {
		expect(responseBelongsToSelection('run-old', 'run-new')).toBe(false)
	})

	test('drops an unidentified response (null runId) even when a run is selected', () => {
		expect(responseBelongsToSelection(null, 'run-1')).toBe(false)
	})

	test('drops every response when nothing is selected', () => {
		expect(responseBelongsToSelection('run-1', null)).toBe(false)
		expect(responseBelongsToSelection(null, null)).toBe(false)
	})
})
