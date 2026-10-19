import { describe, expect, test } from 'bun:test'
import { acceptedResultView, planResultOpen, planResultRetry, planRunViewRecovery, resultOffersContinue, selectResultSource } from './result-access.js'

interface ViewFixture {
	runId: string | null
	status: string
}

interface SummaryFixture {
	runId: string
	status: string
}

const summary = (runId: string, status = 'success'): SummaryFixture => ({ runId, status })

describe('selectResultSource', () => {
	test('prefers the held view when it belongs to the selected run', () => {
		const view: ViewFixture = { runId: 'run-1', status: 'running' }
		const source = selectResultSource('run-1', view, [])
		expect(source?.kind).toBe('view')
		expect(source?.value).toBe(view)
	})

	test('prefers a terminal summary over a matching but stale running view', () => {
		const view: ViewFixture = { runId: 'run-1', status: 'running' }
		const terminalSummary = summary('run-1', 'success')
		expect(selectResultSource('run-1', view, [terminalSummary])).toEqual({ kind: 'summary', value: terminalSummary })
	})

	test('prefers the running summary over a terminal view that disagrees with it', () => {
		const view: ViewFixture = { runId: 'run-1', status: 'success' }
		const runningSummary = summary('run-1', 'running')
		expect(selectResultSource('run-1', view, [runningSummary])).toEqual({ kind: 'summary', value: runningSummary })
	})

	test('prefers the summary when two terminal sources disagree', () => {
		const view: ViewFixture = { runId: 'run-1', status: 'success' }
		const terminalSummary = summary('run-1', 'error')
		expect(selectResultSource('run-1', view, [terminalSummary])).toEqual({ kind: 'summary', value: terminalSummary })
	})

	test('prefers the richer view when the matching sources agree', () => {
		const view: ViewFixture = { runId: 'run-1', status: 'success' }
		const agreeingSummary = summary('run-1', 'success')
		expect(selectResultSource('run-1', view, [agreeingSummary])).toEqual({ kind: 'view', value: view })
	})

	test('falls back to the matching summary when the view is missing or for another run', () => {
		const matching = summary('run-1')
		expect(selectResultSource('run-1', null, [matching])).toEqual({ kind: 'summary', value: matching })
		const otherView: ViewFixture = { runId: 'run-2', status: 'success' }
		expect(selectResultSource('run-1', otherView, [matching])).toEqual({ kind: 'summary', value: matching })
	})

	test('returns null when neither source matches', () => {
		expect(selectResultSource('run-1', null, [summary('run-2')])).toBeNull()
		expect(selectResultSource('run-1', { runId: 'run-2', status: 'success' }, [])).toBeNull()
		expect(selectResultSource(null, null, [summary('run-1')])).toBeNull()
		expect(selectResultSource('', null, [summary('')])).toBeNull()
	})
})

describe('acceptedResultView', () => {
	test('accepts a response whose request and body both identify the selected run', () => {
		expect(acceptedResultView('run-1', 'run-1', 'run-1')).toBe(true)
	})

	test('rejects a body for another run even when the request was for the selection', () => {
		expect(acceptedResultView('run-1', 'run-1', 'run-2')).toBe(false)
		expect(acceptedResultView('run-1', 'run-1', null)).toBe(false)
	})

	test('rejects a request that no longer matches the selection', () => {
		expect(acceptedResultView('run-1', 'run-2', 'run-2')).toBe(false)
		expect(acceptedResultView('run-1', null, 'run-1')).toBe(false)
	})
})

describe('planResultOpen', () => {
	test('opens immediately when a terminal source exists', () => {
		expect(planResultOpen('run-1', null, [summary('run-1', 'success')], null)).toEqual({ kind: 'immediate', resultLoad: null, backgroundFetch: false })
	})

	test('a terminal view needs no background fetch', () => {
		expect(planResultOpen('run-1', { runId: 'run-1', status: 'error' }, [], null)).toEqual({ kind: 'immediate', resultLoad: null, backgroundFetch: false })
	})

	test('an immediate error summary starts a deduped background fetch for the richer view', () => {
		expect(planResultOpen('run-1', null, [summary('run-1', 'error')], null)).toEqual({ kind: 'immediate', resultLoad: { runId: 'run-1', phase: 'loading' }, backgroundFetch: true })
		const loading = { runId: 'run-1', phase: 'loading' as const }
		expect(planResultOpen('run-1', null, [summary('run-1', 'error')], loading)).toEqual({ kind: 'immediate', resultLoad: loading, backgroundFetch: false })
	})

	test('starts one fetch with a loading state when nothing terminal is available', () => {
		expect(planResultOpen('run-1', { runId: 'run-1', status: 'running' }, [], null)).toEqual({ kind: 'fetch', resultLoad: { runId: 'run-1', phase: 'loading' } })
	})

	test('does not restart a fetch already loading for the same run', () => {
		const loading = { runId: 'run-1', phase: 'loading' as const }
		expect(planResultOpen('run-1', null, [], loading)).toEqual({ kind: 'keep-loading', resultLoad: loading })
	})

	test('retries a failed load and ignores a load for another run', () => {
		expect(planResultOpen('run-1', null, [], { runId: 'run-1', phase: 'failed' })).toEqual({ kind: 'fetch', resultLoad: { runId: 'run-1', phase: 'loading' } })
		expect(planResultOpen('run-1', null, [], { runId: 'run-2', phase: 'loading' })).toEqual({ kind: 'fetch', resultLoad: { runId: 'run-1', phase: 'loading' } })
	})

	test('returns null with no selected run', () => {
		expect(planResultOpen(null, null, [], null)).toBeNull()
		expect(planResultOpen('', null, [], null)).toBeNull()
	})
})

describe('planResultRetry', () => {
	test('starts a fetch from a failed load', () => {
		expect(planResultRetry('run-1', { runId: 'run-1', phase: 'failed' })).toEqual({ kind: 'fetch', resultLoad: { runId: 'run-1', phase: 'loading' } })
	})

	test('is a no-op while the same run is already loading', () => {
		expect(planResultRetry('run-1', { runId: 'run-1', phase: 'loading' })).toEqual({ kind: 'noop' })
	})

	test('starts a fetch for the selected run when the load belongs to another run', () => {
		expect(planResultRetry('run-1', { runId: 'run-2', phase: 'loading' })).toEqual({ kind: 'fetch', resultLoad: { runId: 'run-1', phase: 'loading' } })
	})

	test('is a no-op with no selected run', () => {
		expect(planResultRetry(null, null)).toEqual({ kind: 'noop' })
		expect(planResultRetry('', null)).toEqual({ kind: 'noop' })
	})
})

describe('planRunViewRecovery', () => {
	test('drops the stale validator and requests the run view unconditionally', () => {
		const url = 'api/runs/run-1'
		const plan = planRunViewRecovery('run-1', null, url, { [url]: 'etag-1', 'api/runs/run-2': 'etag-2' })
		expect(plan).toEqual({ url, versions: { 'api/runs/run-2': 'etag-2' } })
	})

	test('recovers when the held view belongs to another run', () => {
		const url = 'api/runs/run-1'
		expect(planRunViewRecovery('run-1', 'run-2', url, { [url]: 'etag-1' })?.versions).toEqual({})
	})

	test('has nothing to do when the held view already matches the selection', () => {
		expect(planRunViewRecovery('run-1', 'run-1', 'api/runs/run-1', { 'api/runs/run-1': 'etag-1' })).toBeNull()
		expect(planRunViewRecovery(null, null, 'api/runs/run-1', {})).toBeNull()
	})
})

describe('resultOffersContinue', () => {
	test('offers Continue for finished outcomes', () => {
		expect(resultOffersContinue('success')).toBe(true)
		expect(resultOffersContinue('error')).toBe(true)
		expect(resultOffersContinue('interrupted')).toBe(true)
	})

	test('does not offer Continue for a paused or non-terminal run', () => {
		expect(resultOffersContinue('needs_clarification')).toBe(false)
		expect(resultOffersContinue('running')).toBe(false)
		expect(resultOffersContinue('unknown')).toBe(false)
	})
})
