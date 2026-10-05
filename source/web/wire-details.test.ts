import { describe, expect, test } from 'bun:test'
import { createWireDetails, WIRE_DETAIL_CACHE_LIMIT } from './static/ts/wire-details.js'

// The controller is browser-pure JS, so its exports arrive with inferred JS types; the alias
// below pulls the lookup contract off the factory's JSDoc, mirroring operation-details.test.ts.

type WireDetailsController = ReturnType<typeof createWireDetails>
type WireDetailState = ReturnType<WireDetailsController['lookup']>

// The endpoint's ready body for one turn: detail sections paired under machine labels, or the
// explicit null when the event carries none (docs/reference.md "GET /api/runs/:id/log").
const SECTIONS_BODY = { index: 3, detailSections: [{ label: 'sent', content: [{ role: 'user', content: 'the task' }] }, { label: 'finish reason', content: 'stop' }] }

describe('createWireDetails', () => {
	test('a miss reads as idle and the cache key is `<runId>|<eventIndex>`', () => {
		const controller = createWireDetails({ maxEntries: 10 })
		expect(controller.lookup('run-1', 3)).toEqual({ status: 'idle' })
		controller.begin('run-1', 3)
		expect(controller.lookup('run-1', 3)).toEqual({ status: 'loading' })
		// The run-id half of the key keeps one run's entries from answering for another run's same-numbered event.
		expect(controller.lookup('run-2', 3)).toEqual({ status: 'idle' })
		expect(controller.lookup('run-1', 4)).toEqual({ status: 'idle' })
	})

	test('begin marks an uncached turn loading exactly once and reports whether it started', () => {
		const controller = createWireDetails({ maxEntries: 10 })
		expect(controller.begin('run-1', 3)).toBe(true)
		expect(controller.lookup('run-1', 3)).toEqual({ status: 'loading' })
		// The fetch is in flight: a second open (and every re-render) starts nothing.
		expect(controller.begin('run-1', 3)).toBe(false)
	})

	test('recordResponse caches an ok body\u2019s sections as ready, verbatim', () => {
		const controller = createWireDetails({ maxEntries: 10 })
		controller.begin('run-1', 3)
		controller.recordResponse('run-1', 3, true, SECTIONS_BODY)
		const state: WireDetailState = controller.lookup('run-1', 3)
		expect(state.status).toBe('ready')
		if (state.status !== 'ready') return
		// The stored sections pass through verbatim, so the modal renders exactly what the endpoint returned.
		expect(state.sections).toEqual(SECTIONS_BODY.detailSections)
		// Ready is final: reopening the expander starts no second fetch.
		expect(controller.begin('run-1', 3)).toBe(false)
	})

	test('an explicit null detailSections caches as ready-null, so a body-less turn is fetched once', () => {
		const controller = createWireDetails({ maxEntries: 10 })
		controller.begin('run-1', 3)
		controller.recordResponse('run-1', 3, true, { index: 3, detailSections: null })
		const state: WireDetailState = controller.lookup('run-1', 3)
		expect(state.status).toBe('ready')
		if (state.status !== 'ready') return
		expect(state.sections).toBeNull()
		expect(controller.begin('run-1', 3)).toBe(false)
	})

	test('a failed landing evicts so reopening retries: not-ok, non-object body, missing sections, wrong shape', () => {
		const controller = createWireDetails({ maxEntries: 10 })
		const failures: Array<[boolean, unknown]> = [
			[false, SECTIONS_BODY],
			[true, 'garbage text'],
			[true, { noSections: true }],
			[true, { detailSections: 'broken' }],
		]
		for (const [ok, body] of failures) {
			controller.begin('run-1', 3)
			controller.recordResponse('run-1', 3, ok, body)
			// The eviction is the retry contract: a miss reads idle and the next open fetches again.
			expect(controller.lookup('run-1', 3)).toEqual({ status: 'idle' })
			expect(controller.begin('run-1', 3)).toBe(true)
		}
	})

	test('recordFailure evicts so reopening retries after a fetch that never produced a response', () => {
		const controller = createWireDetails({ maxEntries: 10 })
		controller.begin('run-1', 3)
		controller.recordFailure('run-1', 3)
		expect(controller.lookup('run-1', 3)).toEqual({ status: 'idle' })
		expect(controller.begin('run-1', 3)).toBe(true)
	})

	test('the cache evicts its oldest entry past maxEntries, and an evicted turn re-fetches', () => {
		const controller = createWireDetails({ maxEntries: 2 })
		controller.begin('run-1', 1)
		controller.recordResponse('run-1', 1, true, SECTIONS_BODY)
		controller.begin('run-1', 2)
		controller.recordResponse('run-1', 2, true, SECTIONS_BODY)
		// Within the cap both stay.
		expect(controller.lookup('run-1', 1).status).toBe('ready')
		expect(controller.lookup('run-1', 2).status).toBe('ready')
		controller.begin('run-1', 3)
		// The oldest (turn 1) dropped; the newest two survive.
		expect(controller.lookup('run-1', 1)).toEqual({ status: 'idle' })
		expect(controller.lookup('run-1', 2).status).toBe('ready')
		expect(controller.lookup('run-1', 3).status).toBe('loading')
		// The evicted turn's next open starts a fresh fetch.
		expect(controller.begin('run-1', 1)).toBe(true)
		expect(controller.lookup('run-1', 1).status).toBe('loading')
		// Landing turn 1 pushes the size back over the cap, evicting the next-oldest (turn 2).
		controller.recordResponse('run-1', 1, true, SECTIONS_BODY)
		expect(controller.lookup('run-1', 2)).toEqual({ status: 'idle' })
		expect(controller.lookup('run-1', 1).status).toBe('ready')
		expect(controller.lookup('run-1', 3).status).toBe('loading')
	})

	test('a non-integer or sub-1 cap fails fast instead of bounding nothing', () => {
		expect(() => createWireDetails({ maxEntries: 0 })).toThrow(/maxEntries/)
		expect(() => createWireDetails({ maxEntries: 2.5 })).toThrow(/maxEntries/)
	})

	test('constants: the shipped cap is 100 entries', () => {
		expect(WIRE_DETAIL_CACHE_LIMIT).toBe(100)
	})
})
