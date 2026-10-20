import { describe, expect, test } from 'bun:test'
import { createOperationDetails } from './static/ts/operation-details.js'
import { defined } from './test-fixtures.js'

// The controller is browser-pure JS, so its exports arrive with inferred JS types; the aliases
// below pull the contract off the factory's JSDoc so the fakes are checked against the real shapes,
// mirroring tooltip.test.ts.

type OperationDetailsController = ReturnType<typeof createOperationDetails>
type DetailsState = ReturnType<OperationDetailsController['lookup']>
type FetchDetail = NonNullable<Parameters<typeof createOperationDetails>[0]['fetchDetail']>
type Landing = Awaited<ReturnType<FetchDetail>>

const TEST_LIMITS = { maxEntries: 512, maxCharacters: 32_000_000 }

// A fake fetchImpl that hands each call's deferred to the test: nothing resolves until the test
// resolves or rejects it, so state transitions and landings are asserted at exact points with no
// timers beyond the microtask flush below.
function createFakeDetailFetch() {
	const calls: Array<{ context: string; operationId: string; resolve: (landing: Landing) => void; reject: (reason?: unknown) => void }> = []
	const fetchDetail: FetchDetail = (context, operationId) =>
		new Promise<Landing>((resolve, reject) => {
			calls.push({ context, operationId, resolve, reject })
		})
	return { fetchDetail, calls }
}

// Lets a resolved/rejected deferred run its record + landing handlers before the assertions.
async function flushLandings(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('createOperationDetails', () => {
	test('a lookup miss reads as failed and the cache key is `<context>|<operationId>`', () => {
		const controller = createOperationDetails({}, TEST_LIMITS)
		expect(controller.lookup('run-1', 'op1')).toEqual({ status: 'failed' })
		controller.begin('run-1', ['op1'])
		expect(controller.lookup('run-1', 'op1')).toEqual({ status: 'loading' })
		// The context half of the key keeps one run's entries from answering for another run's same-numbered operation.
		expect(controller.lookup('run-2', 'op1')).toEqual({ status: 'failed' })
		expect(controller.lookup('run-1', 'op2')).toEqual({ status: 'failed' })
	})

	test('begin marks each uncached id loading and returns exactly the ids it started', () => {
		const controller = createOperationDetails({}, TEST_LIMITS)
		expect(controller.begin('run-1', ['op1', 'op2'])).toEqual(['op1', 'op2'])
		expect(controller.lookup('run-1', 'op1')).toEqual({ status: 'loading' })
		expect(controller.lookup('run-1', 'op2')).toEqual({ status: 'loading' })
		expect(controller.begin('run-1', ['op2', 'op3'])).toEqual(['op3'])
	})

	test('recordResponse reads an ok body carrying a string as ready and an explicit null as ready-null', () => {
		const controller = createOperationDetails({}, TEST_LIMITS)
		controller.begin('run-1', ['op1', 'op2'])
		controller.recordResponse('run-1', 'op1', true, { details: 'did the thing' })
		controller.recordResponse('run-1', 'op2', true, { details: null })
		expect(controller.lookup('run-1', 'op1')).toEqual({ status: 'ready', details: 'did the thing' })
		expect(controller.lookup('run-1', 'op2')).toEqual({ status: 'ready', details: null })
	})

	test('a not-ok response, a non-object body, and a body without a details field all read as failed', () => {
		const controller = createOperationDetails({}, TEST_LIMITS)
		controller.begin('run-1', ['op1', 'op2', 'op3', 'op4'])
		controller.recordResponse('run-1', 'op1', false, { details: 'never read' })
		controller.recordResponse('run-1', 'op2', true, 'garbage text')
		controller.recordResponse('run-1', 'op3', true, { noDetails: true })
		controller.recordResponse('run-1', 'op4', true, null)
		for (const operationId of ['op1', 'op2', 'op3', 'op4']) {
			expect(controller.lookup('run-1', operationId)).toEqual({ status: 'failed' })
		}
	})

	test('recordFailure records failed for a fetch that never produced a response', () => {
		const controller = createOperationDetails({}, TEST_LIMITS)
		controller.begin('run-1', ['op1'])
		controller.recordFailure('run-1', 'op1')
		expect(controller.lookup('run-1', 'op1')).toEqual({ status: 'failed' })
	})

	test('a cached ready or failed id is not re-fetched while it remains in the cache', async () => {
		const readyFake = createFakeDetailFetch()
		const readyController = createOperationDetails({ fetchDetail: readyFake.fetchDetail }, TEST_LIMITS)
		readyController.ensure('scenario-1', ['op1'])
		defined(readyFake.calls[0], 'first call').resolve({ ok: true, body: { details: 'did the thing' } })
		await flushLandings()
		readyController.ensure('scenario-1', ['op1'])
		expect(readyFake.calls).toHaveLength(1)
		expect(readyController.lookup('scenario-1', 'op1')).toEqual({ status: 'ready', details: 'did the thing' })

		const failedFake = createFakeDetailFetch()
		const failedController = createOperationDetails({ fetchDetail: failedFake.fetchDetail }, TEST_LIMITS)
		failedController.ensure('scenario-1', ['op1'])
		defined(failedFake.calls[0], 'first call').reject(new Error('network down'))
		await flushLandings()
		failedController.ensure('scenario-1', ['op1'])
		expect(failedFake.calls).toHaveLength(1)
		expect(failedController.lookup('scenario-1', 'op1')).toEqual({ status: 'failed' })
	})

	test('the entry bound evicts the least-recently-used id, and a lookup marks recency', () => {
		const controller = createOperationDetails({}, { maxEntries: 2, maxCharacters: 1_000_000 })
		controller.begin('run-1', ['op1', 'op2'])
		controller.recordResponse('run-1', 'op1', true, { details: 'first' })
		controller.recordResponse('run-1', 'op2', true, { details: 'second' })
		// Reading op1 makes op2 the least-recently-used entry, so op3's insertion evicts op2.
		expect(controller.lookup('run-1', 'op1')).toEqual({ status: 'ready', details: 'first' })
		controller.begin('run-1', ['op3'])
		controller.recordResponse('run-1', 'op3', true, { details: 'third' })
		expect(controller.lookup('run-1', 'op1')).toEqual({ status: 'ready', details: 'first' })
		expect(controller.lookup('run-1', 'op2')).toEqual({ status: 'failed' })
		expect(controller.lookup('run-1', 'op3')).toEqual({ status: 'ready', details: 'third' })
	})

	test('the character budget evicts least-recently-used entries until the total fits', () => {
		const controller = createOperationDetails({}, { maxEntries: 10, maxCharacters: 30 })
		const details = 'a'.repeat(15)
		controller.begin('run-1', ['op1', 'op2'])
		controller.recordResponse('run-1', 'op1', true, { details })
		// Each entry costs its 9-character key plus 15 characters of details, so only one fits.
		controller.recordResponse('run-1', 'op2', true, { details })
		expect(controller.lookup('run-1', 'op1')).toEqual({ status: 'failed' })
		expect(controller.lookup('run-1', 'op2')).toEqual({ status: 'ready', details })
	})

	test('replacing an entry subtracts its previous characters from the budget', () => {
		const controller = createOperationDetails({}, { maxEntries: 10, maxCharacters: 45 })
		controller.begin('run-1', ['op1', 'op2'])
		controller.recordResponse('run-1', 'op1', true, { details: 'a'.repeat(20) })
		controller.recordResponse('run-1', 'op1', true, { details: 'b'.repeat(5) })
		controller.recordResponse('run-1', 'op2', true, { details: 'c'.repeat(20) })
		expect(controller.lookup('run-1', 'op1')).toEqual({ status: 'ready', details: 'b'.repeat(5) })
		expect(controller.lookup('run-1', 'op2')).toEqual({ status: 'ready', details: 'c'.repeat(20) })
	})

	test('an oversized entry is retained, evicts older entries, and is not re-fetched', async () => {
		const fetchFake = createFakeDetailFetch()
		const controller = createOperationDetails({ fetchDetail: fetchFake.fetchDetail }, { maxEntries: 10, maxCharacters: 30 })
		controller.ensure('run-1', ['small'])
		defined(fetchFake.calls[0], 'small call').resolve({ ok: true, body: { details: 'ok' } })
		await flushLandings()
		const hugeDetails = 'x'.repeat(100)
		controller.ensure('run-1', ['huge'])
		defined(fetchFake.calls[1], 'huge call').resolve({ ok: true, body: { details: hugeDetails } })
		await flushLandings()
		expect(controller.lookup('run-1', 'small')).toEqual({ status: 'failed' })
		expect(controller.lookup('run-1', 'huge')).toEqual({ status: 'ready', details: hugeDetails })
		controller.ensure('run-1', ['huge'])
		expect(fetchFake.calls.map((call) => call.operationId)).toEqual(['small', 'huge'])
	})

	test('an evicted ready id is fetched again by ensure', async () => {
		const fetchFake = createFakeDetailFetch()
		const controller = createOperationDetails({ fetchDetail: fetchFake.fetchDetail }, { maxEntries: 1, maxCharacters: 1_000_000 })
		controller.ensure('run-1', ['op1'])
		defined(fetchFake.calls[0], 'op1 first').resolve({ ok: true, body: { details: 'first' } })
		await flushLandings()
		controller.ensure('run-1', ['op2'])
		defined(fetchFake.calls[1], 'op2 first').resolve({ ok: true, body: { details: 'second' } })
		await flushLandings()
		expect(controller.lookup('run-1', 'op1')).toEqual({ status: 'failed' })
		controller.ensure('run-1', ['op1'])
		expect(fetchFake.calls.map((call) => call.operationId)).toEqual(['op1', 'op2', 'op1'])
		defined(fetchFake.calls[2], 'op1 second').resolve({ ok: true, body: { details: 'first again' } })
		await flushLandings()
		expect(controller.lookup('run-1', 'op1')).toEqual({ status: 'ready', details: 'first again' })
	})

	test('ready data survives while the cache is under both bounds', () => {
		const controller = createOperationDetails({}, { maxEntries: 4, maxCharacters: 1_000_000 })
		controller.begin('run-1', ['op1', 'op2', 'op3'])
		controller.recordResponse('run-1', 'op1', true, { details: 'one' })
		controller.recordResponse('run-1', 'op2', true, { details: 'two' })
		controller.recordResponse('run-1', 'op3', true, { details: 'three' })
		expect(controller.lookup('run-1', 'op1')).toEqual({ status: 'ready', details: 'one' })
		expect(controller.lookup('run-1', 'op2')).toEqual({ status: 'ready', details: 'two' })
		expect(controller.lookup('run-1', 'op3')).toEqual({ status: 'ready', details: 'three' })
	})

	test('ensure fetches each started id through fetchDetail and lands it through onLanded with the fetch\u2019s context', async () => {
		const fetchFake = createFakeDetailFetch()
		const landed: Array<[string, string]> = []
		const controller = createOperationDetails({ fetchDetail: fetchFake.fetchDetail, onLanded: (context, operationId) => landed.push([context, operationId]) }, TEST_LIMITS)
		controller.ensure('scenario-1', ['op1', 'op2'])
		expect(fetchFake.calls.map((call) => [call.context, call.operationId])).toEqual([['scenario-1', 'op1'], ['scenario-1', 'op2']])
		expect(landed).toEqual([])
		expect(controller.lookup('scenario-1', 'op1')).toEqual({ status: 'loading' })
		defined(fetchFake.calls[0], 'first call').resolve({ ok: true, body: { details: 'A details' } })
		await flushLandings()
		expect(landed).toEqual([['scenario-1', 'op1']])
		expect(controller.lookup('scenario-1', 'op1')).toEqual({ status: 'ready', details: 'A details' })
		defined(fetchFake.calls[1], 'second call').reject(new Error('network down'))
		await flushLandings()
		expect(landed).toEqual([['scenario-1', 'op1'], ['scenario-1', 'op2']])
		expect(controller.lookup('scenario-1', 'op2')).toEqual({ status: 'failed' })
	})

	test('a deduped ensure fires no fetch and no landing — the fan-out only fires for a landing', async () => {
		const fetchFake = createFakeDetailFetch()
		const landed: Array<[string, string]> = []
		const controller = createOperationDetails({ fetchDetail: fetchFake.fetchDetail, onLanded: (context, operationId) => landed.push([context, operationId]) }, TEST_LIMITS)
		controller.ensure('scenario-1', ['op1'])
		defined(fetchFake.calls[0], 'first call').resolve({ ok: true, body: { details: 'A details' } })
		await flushLandings()
		controller.ensure('scenario-1', ['op1'])
		expect(fetchFake.calls).toHaveLength(1)
		expect(landed).toEqual([['scenario-1', 'op1']])
	})

	test('the record actions of an effect-driven host fire the landing fan-out when one is wired', () => {
		const landed: Array<[string, string]> = []
		const controller = createOperationDetails({ onLanded: (context, operationId) => landed.push([context, operationId]) }, TEST_LIMITS)
		controller.begin('run-1', ['op1', 'op2'])
		controller.recordResponse('run-1', 'op1', true, { details: 'did the thing' })
		controller.recordFailure('run-1', 'op2')
		expect(landed).toEqual([['run-1', 'op1'], ['run-1', 'op2']])
	})

	test('ensure without a fetchDetail dependency fails fast instead of silently not fetching', () => {
		const controller = createOperationDetails({}, TEST_LIMITS)
		expect(() => controller.ensure('run-1', ['op1'])).toThrow(/fetchDetail/)
	})
})

// Pins the lookup state the tooltip derivations read (tooltip.js "On-demand operation details"): a
// ready entry passes through verbatim, so the derivations see the same object the machine recorded.
describe('lookup protocol shape', () => {
	test('a ready entry is exactly the protocol object the tooltip derivations read', () => {
		const controller = createOperationDetails({}, TEST_LIMITS)
		controller.begin('run-1', ['op1'])
		controller.recordResponse('run-1', 'op1', true, { details: 'did the thing' })
		const state: DetailsState = controller.lookup('run-1', 'op1')
		expect(state.status).toBe('ready')
		if (state.status !== 'ready') return
		expect(state.details).toBe('did the thing')
	})
})
