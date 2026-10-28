import { describe, expect, test } from 'bun:test'
import { deriveFaviconState, faviconHref } from './static/ts/favicon.js'

// Pull the favicon types off helper signatures so the fixtures are contextually checked against the JSDoc shape without a cast, mirroring the sibling labels.test.ts convention.
type FaviconState = Parameters<typeof faviconHref>[0]

// A realistic queue-item fixture. The favicon's own admitsStatus guard only requires an object with a status field, so the extra fields are present for realism rather than necessity.
function queueItem(overrides: { id?: string; task?: string; status?: string; queuedAt?: string } = {}): Record<string, string> {
	return { id: 'item-1', task: 'fix the parser bug', status: 'waiting', queuedAt: '2026-01-01T00:00:00.000Z', ...overrides }
}

describe('deriveFaviconState', () => {
	test('reads complete with no runs and no questions — the initial idle and no-runs-yet state', () => {
		expect(deriveFaviconState([], [])).toBe('complete')
	})

	test('reads working while any run carries a non-terminal status', () => {
		expect(deriveFaviconState([{ status: 'running' }], [])).toBe('working')
		expect(deriveFaviconState([{ status: 'unknown' }], [])).toBe('working')
	})

	test('reads pending-input for operator-policy suspensions and waiting for an auto pause', () => {
		expect(deriveFaviconState([{ status: 'suspended', suspension: { category: 'billing', resumePolicy: 'operator' } }], [])).toBe('pending-input')
		expect(deriveFaviconState([{ status: 'suspended', suspension: { category: 'auth', resumePolicy: 'operator' } }], [])).toBe('pending-input')
		expect(deriveFaviconState([{ status: 'suspended', suspension: { category: 'request_rejected', resumePolicy: 'operator' } }], [])).toBe('pending-input')
		expect(deriveFaviconState([{ status: 'suspended', suspension: { category: 'unknown', resumePolicy: 'operator' } }], [])).toBe('pending-input')
		expect(deriveFaviconState([{ status: 'suspended', suspension: { category: 'transient', resumePolicy: 'auto' } }], [])).toBe('waiting')
	})

	test('a transient pause downgraded to operator by the attempt cap reads as pending-input', () => {
		expect(deriveFaviconState([{ status: 'suspended', suspension: { category: 'transient', resumePolicy: 'operator' } }], [])).toBe('pending-input')
	})

	test('a suspended run is never counted as a working run', () => {
		expect(deriveFaviconState([{ status: 'suspended', suspension: { category: 'transient', resumePolicy: 'auto' } }, { status: 'success' }], [])).toBe('waiting')
		expect(deriveFaviconState([{ status: 'suspended', suspension: { category: 'billing', resumePolicy: 'operator' } }, { status: 'success' }], [])).toBe('pending-input')
	})

	test('reads complete once every run is terminal', () => {
		expect(deriveFaviconState([{ status: 'success' }, { status: 'error' }, { status: 'needs_clarification' }, { status: 'interrupted' }], [])).toBe('complete')
	})

	test('reads pending-input when a question is pending, even while a run is in progress', () => {
		expect(deriveFaviconState([], [{ id: 'q1' }])).toBe('pending-input')
		expect(deriveFaviconState([{ status: 'running' }], [{ id: 'q1' }])).toBe('pending-input')
	})

	test('reads pending-input for a parked needs_input queue item even while a run is in progress and no question is pending', () => {
		expect(deriveFaviconState([{ status: 'running' }], [], [queueItem({ status: 'needs_input' })])).toBe('pending-input')
		expect(deriveFaviconState([], [], [queueItem({ status: 'needs_input' })])).toBe('pending-input')
	})

	test('a suspended queue item is operator-needed until a run summary reveals an auto policy', () => {
		expect(deriveFaviconState([], [], [queueItem({ status: 'suspended' })])).toBe('pending-input')
		expect(deriveFaviconState([{ status: 'suspended', suspension: { category: 'transient', resumePolicy: 'auto' } }], [], [queueItem({ status: 'suspended' })])).toBe('waiting')
	})

	test('a queue item that is not needs_input does not force pending-input', () => {
		expect(deriveFaviconState([{ status: 'success' }], [], [queueItem({ status: 'waiting' })])).toBe('complete')
		expect(deriveFaviconState([{ status: 'success' }], [], [queueItem({ status: 'done' })])).toBe('complete')
		expect(deriveFaviconState([{ status: 'running' }], [], [queueItem({ status: 'waiting' })])).toBe('working')
	})

	test('reads pending-input from any queue entry that admits a needs_input status', () => {
		expect(deriveFaviconState([], [], [{ status: 'needs_input' }])).toBe('pending-input')
	})

	test('ignores queue entries that cannot admit a needs_input status', () => {
		expect(deriveFaviconState([], [], [null, 'garbage', 42, { status: 'waiting' }])).toBe('complete')
	})

	test('omitting the queue argument leaves the two-argument behavior unchanged', () => {
		expect(deriveFaviconState([{ status: 'running' }], [])).toBe('working')
		expect(deriveFaviconState([], [{ id: 'q1' }])).toBe('pending-input')
		expect(deriveFaviconState([], [])).toBe('complete')
	})

	test('counts a summary entry that cannot be proven terminal as in progress', () => {
		expect(deriveFaviconState([null, 'garbage', { status: 'running' }], [])).toBe('working')
		expect(deriveFaviconState([null, 'garbage', 42], [])).toBe('complete')
	})

	test('treats a non-array payload as absent', () => {
		expect(deriveFaviconState(undefined, undefined)).toBe('complete')
		expect(deriveFaviconState(undefined, ['q1'])).toBe('pending-input')
		expect(deriveFaviconState([{ status: 'running' }], undefined)).toBe('working')
	})
})

describe('faviconHref', () => {
	test('builds a data URI whose decoded body is the state-colored triangle', () => {
		const href = faviconHref('complete')
		expect(href.startsWith('data:image/svg+xml,')).toBe(true)
		expect(decodeURIComponent(href.slice('data:image/svg+xml,'.length))).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M8 2l6 11H2Z" fill="#26a269"/></svg>')
	})

	test('the three states share the shape and differ only in the fill color', () => {
		const bodies = (['pending-input', 'working', 'waiting', 'complete'] as const).map((state) => decodeURIComponent(faviconHref(state).slice('data:image/svg+xml,'.length)))
		const colors = bodies.map((body) => body.match(/fill="([^"]+)"/)?.[1])
		expect(colors).toEqual(['#f6d32d', '#c01c28', '#e5a50a', '#26a269'])
		const shapes = bodies.map((body) => body.replace(/fill="[^"]+"/, 'fill="COLOR"'))
		expect(new Set(shapes).size).toBe(1)
	})

	test('escapes the fill color so the URI carries no fragment', () => {
		for (const state of ['pending-input', 'working', 'waiting', 'complete'] as const satisfies readonly FaviconState[]) {
			expect(faviconHref(state).includes('#')).toBe(false)
		}
	})
})
