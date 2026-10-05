import { describe, expect, test } from 'bun:test'
import { deriveFaviconState, faviconHref } from './static/ts/favicon.js'

// Pull the favicon types off helper signatures so the fixtures are contextually checked against the JSDoc shape without a cast, mirroring the sibling labels.test.ts convention.
type FaviconState = Parameters<typeof faviconHref>[0]

describe('deriveFaviconState', () => {
	test('reads complete with no runs and no questions — the initial idle and no-runs-yet state', () => {
		expect(deriveFaviconState([], [])).toBe('complete')
	})

	test('reads working while any run carries a non-terminal status', () => {
		expect(deriveFaviconState([{ status: 'running' }], [])).toBe('working')
		expect(deriveFaviconState([{ status: 'unknown' }], [])).toBe('working')
	})

	test('reads complete once every run is terminal', () => {
		expect(deriveFaviconState([{ status: 'success' }, { status: 'error' }, { status: 'needs_clarification' }, { status: 'interrupted' }], [])).toBe('complete')
	})

	test('reads pending-input when a question is pending, even while a run is in progress', () => {
		expect(deriveFaviconState([], [{ id: 'q1' }])).toBe('pending-input')
		expect(deriveFaviconState([{ status: 'running' }], [{ id: 'q1' }])).toBe('pending-input')
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
		const bodies = (['pending-input', 'working', 'complete'] as const).map((state) => decodeURIComponent(faviconHref(state).slice('data:image/svg+xml,'.length)))
		const colors = bodies.map((body) => body.match(/fill="([^"]+)"/)?.[1])
		expect(colors).toEqual(['#f6d32d', '#c01c28', '#26a269'])
		const shapes = bodies.map((body) => body.replace(/fill="[^"]+"/, 'fill="COLOR"'))
		expect(new Set(shapes).size).toBe(1)
	})

	test('escapes the fill color so the URI carries no fragment', () => {
		for (const state of ['pending-input', 'working', 'complete'] as const satisfies readonly FaviconState[]) {
			expect(faviconHref(state).includes('#')).toBe(false)
		}
	})
})
