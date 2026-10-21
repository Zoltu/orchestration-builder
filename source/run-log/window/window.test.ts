import { describe, expect, test } from 'bun:test'
import type { LogEvent } from '../../executor/types.js'
import { filterLogEventsForInstance, foldLlmCallSent, paginateLogEvents } from './index.js'

function defined<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`${label} is undefined`)
	return value
}

describe('foldLlmCallSent', () => {
	function event(type: string, payload: unknown): LogEvent {
		return { timestamp: 't', type, payload }
	}

	function msg(role: string, content: string): { role: string; content: string } {
		return { role, content }
	}

	// A role's logged chain: turn 1 the full request, later turns the delta slices the protocol prescribes.
	function deltaChain(): LogEvent[] {
		return [
			event('role_start', { role: 'coder', roleId: 'coder-0-1' }),
			event('llm_call', { role: 'coder', roleId: 'coder-0-1', messageCount: 2, sentFrom: 0, sent: [msg('system', 'p'), msg('user', 'task')] }),
			event('tool_call', { role: 'coder', roleId: 'coder-0-1', tool: 'write_file' }),
			event('llm_call', { role: 'coder', roleId: 'coder-0-1', messageCount: 4, sentFrom: 2, sent: [msg('assistant', 'turn one'), msg('tool', 'result one')] }),
			event('llm_call', { role: 'coder', roleId: 'coder-0-1', messageCount: 5, sentFrom: 4, sent: [msg('assistant', 'turn two')] }),
		]
	}

	test('a chain of deltas folds back into the full conversation of the turn', () => {
		const events = deltaChain()
		const folded = foldLlmCallSent(events, 4)
		expect(folded).toEqual(event('llm_call', {
			role: 'coder',
			roleId: 'coder-0-1',
			messageCount: 5,
			sentFrom: 4,
			sent: [msg('system', 'p'), msg('user', 'task'), msg('assistant', 'turn one'), msg('tool', 'result one'), msg('assistant', 'turn two')],
		}))
		// The input events are never mutated.
		expect(events[4]?.payload).toEqual({ role: 'coder', roleId: 'coder-0-1', messageCount: 5, sentFrom: 4, sent: [msg('assistant', 'turn two')] })
	})

	test('the walk matches on role instance: a same-named child’s interleaved events do not corrupt the parent’s fold', () => {
		// The depth guard is the only limit on spawning a same-named child, so the child's llm_call events (same role name, different instance) interleave between the parent's turns.
		const events = [
			event('role_start', { role: 'coder', roleId: 'coder-0-1', depth: 0 }),
			event('llm_call', { role: 'coder', roleId: 'coder-0-1', messageCount: 2, sentFrom: 0, sent: [msg('system', 'parent prompt'), msg('user', 'parent task')] }),
			event('role_start', { role: 'coder', roleId: 'coder-1-2', depth: 1, parent: 'coder' }),
			event('llm_call', { role: 'coder', roleId: 'coder-1-2', messageCount: 2, sentFrom: 0, sent: [msg('system', 'child prompt'), msg('user', 'child task')] }),
			event('llm_call', { role: 'coder', roleId: 'coder-1-2', messageCount: 4, sentFrom: 2, sent: [msg('assistant', 'child turn'), msg('tool', 'child result')] }),
			event('role_finished', { role: 'coder', roleId: 'coder-1-2', status: 'success' }),
			event('llm_call', { role: 'coder', roleId: 'coder-0-1', messageCount: 4, sentFrom: 2, sent: [msg('assistant', 'parent turn one'), msg('tool', 'parent result')] }),
		]
		expect(foldLlmCallSent(events, 6)).toEqual(event('llm_call', {
			role: 'coder',
			roleId: 'coder-0-1',
			messageCount: 4,
			sentFrom: 2,
			sent: [msg('system', 'parent prompt'), msg('user', 'parent task'), msg('assistant', 'parent turn one'), msg('tool', 'parent result')],
		}))
	})

	test('a delta target without a usable roleId is malformed and returned unchanged', () => {
		const events = [
			event('llm_call', { role: 'coder', roleId: 'coder-0-1', messageCount: 2, sent: [msg('system', 'p'), msg('user', 'task')] }),
			event('llm_call', { role: 'coder', messageCount: 4, sentFrom: 2, sent: [msg('assistant', 'turn one'), msg('tool', 'result one')] }),
		]
		const target = events[1]
		if (target === undefined) throw new Error('missing target event')
		expect(foldLlmCallSent(events, 1)).toBe(target)
	})

	test('a prior event without a usable roleId cannot participate in the fold', () => {
		const events = [
			event('llm_call', { role: 'coder', messageCount: 2, sent: [msg('system', 'p'), msg('user', 'task')] }),
			event('llm_call', { role: 'coder', roleId: 'coder-0-1', messageCount: 4, sentFrom: 2, sent: [msg('assistant', 'turn one'), msg('tool', 'result one')] }),
		]
		expect(foldLlmCallSent(events, 1)).toEqual(event('llm_call', {
			role: 'coder',
			roleId: 'coder-0-1',
			messageCount: 4,
			sentFrom: 2,
			sent: [msg('assistant', 'turn one'), msg('tool', 'result one')],
		}))
	})

	test('the fold skips other roles and event types on the way back', () => {
		const events = [
			event('llm_call', { role: 'planner', roleId: 'planner-0-1', messageCount: 3, sentFrom: 1, sent: [msg('assistant', 'planner noise'), msg('tool', 'more noise')] }),
			event('llm_call', { role: 'coder', roleId: 'coder-0-1', messageCount: 2, sentFrom: 0, sent: [msg('system', 'p'), msg('user', 'task')] }),
			event('tool_result', { role: 'coder', roleId: 'coder-0-1', tool: 'write_file' }),
			event('llm_call', { role: 'coder', roleId: 'coder-0-1', messageCount: 3, sentFrom: 2, sent: [msg('assistant', 'turn one')] }),
		]
		expect(foldLlmCallSent(events, 3)).toEqual(event('llm_call', { role: 'coder', roleId: 'coder-0-1', messageCount: 3, sentFrom: 2, sent: [msg('system', 'p'), msg('user', 'task'), msg('assistant', 'turn one')] }))
	})

	test('an event without sentFrom is a full snapshot that ends the walk', () => {
		const events = [
			event('llm_call', { role: 'coder', roleId: 'coder-0-1', messageCount: 2, sent: [msg('system', 'p'), msg('user', 'task')] }),
			event('llm_call', { role: 'coder', roleId: 'coder-0-1', messageCount: 4, sentFrom: 2, sent: [msg('assistant', 'turn one'), msg('tool', 'result one')] }),
		]
		expect(foldLlmCallSent(events, 1)).toEqual(event('llm_call', { role: 'coder', roleId: 'coder-0-1', messageCount: 4, sentFrom: 2, sent: [msg('system', 'p'), msg('user', 'task'), msg('assistant', 'turn one'), msg('tool', 'result one')] }))
	})

	test('a prune-then-grow sequence folds only the post-prune conversation', () => {
		const events = [
			event('llm_call', { role: 'coder', roleId: 'coder-0-1', messageCount: 4, sentFrom: 0, sent: [msg('system', 'p'), msg('user', 'task'), msg('assistant', 'stale'), msg('tool', 'stale')] }),
			// The context edit forced a full snapshot of the shrunken conversation; the next delta chains off it, not off the pre-prune history.
			event('llm_call', { role: 'coder', roleId: 'coder-0-1', messageCount: 3, sentFrom: 0, sent: [msg('system', 'p'), msg('user', 'task'), msg('user', '[Platform notice]')] }),
			event('llm_call', { role: 'coder', roleId: 'coder-0-1', messageCount: 5, sentFrom: 3, sent: [msg('assistant', 'fresh turn'), msg('tool', 'fresh result')] }),
		]
		expect(foldLlmCallSent(events, 2)).toEqual(event('llm_call', {
			role: 'coder',
			roleId: 'coder-0-1',
			messageCount: 5,
			sentFrom: 3,
			sent: [msg('system', 'p'), msg('user', 'task'), msg('user', '[Platform notice]'), msg('assistant', 'fresh turn'), msg('tool', 'fresh result')],
		}))
	})

	test('a replayed turn after a restart (same sentFrom) contributes nothing and the walk continues past it', () => {
		const events = [
			event('llm_call', { role: 'coder', roleId: 'coder-0-1', messageCount: 2, sentFrom: 0, sent: [msg('system', 'p'), msg('user', 'task')] }),
			// The straddling turn's first attempt, which never reached a checkpoint.
			event('llm_call', { role: 'coder', roleId: 'coder-0-1', messageCount: 3, sentFrom: 2, sent: [msg('assistant', 'crashed turn')] }),
			event('run_resumed', { runId: 'run-1', resumedFrames: 1 }),
			// The replay emits the same delta again.
			event('llm_call', { role: 'coder', roleId: 'coder-0-1', messageCount: 3, sentFrom: 2, sent: [msg('assistant', 'crashed turn')] }),
		]
		expect(foldLlmCallSent(events, 3)).toEqual(event('llm_call', { role: 'coder', roleId: 'coder-0-1', messageCount: 3, sentFrom: 2, sent: [msg('system', 'p'), msg('user', 'task'), msg('assistant', 'crashed turn')] }))
	})

	test('a full snapshot (sentFrom 0) and a non-llm_call event pass through unchanged', () => {
		const events = deltaChain()
		const full = events[1]
		if (full === undefined) throw new Error('missing full-snapshot event')
		expect(foldLlmCallSent(events, 1)).toBe(full)
		const start = events[0]
		if (start === undefined) throw new Error('missing role_start event')
		expect(foldLlmCallSent(events, 0)).toBe(start)
	})

	test('an llm_call without a sent body (the standard level) passes through unchanged', () => {
		const events = [event('llm_call', { role: 'coder', roleId: 'coder-0-1', messageCount: 4, sentFrom: 2, usage: { promptTokens: 10, completionTokens: 5 } })]
		const bodyless = events[0]
		if (bodyless === undefined) throw new Error('missing bodyless event')
		expect(foldLlmCallSent(events, 0)).toBe(bodyless)
	})

	test('throws when the index is outside the event list', () => {
		expect(() => foldLlmCallSent([], 0)).toThrow('foldLlmCallSent: no event at log index 0')
	})
})

describe('paginateLogEvents', () => {
	function events(n: number): LogEvent[] {
		const list: LogEvent[] = []
		for (let i = 0; i < n; i++) list.push({ timestamp: `t${i}`, type: 'llm_call', payload: { role: 'planner' } })
		return list
	}

	test('returns the first page with the full total and applied offset/limit', () => {
		const page = paginateLogEvents(events(10), { offset: 0, limit: 3 })
		expect(page.total).toBe(10)
		expect(page.offset).toBe(0)
		expect(page.limit).toBe(3)
		expect(page.events.length).toBe(3)
		expect(defined(page.events[0], 'page.events[0]').timestamp).toBe('t0')
		expect(defined(page.events[2], 'page.events[2]').timestamp).toBe('t2')
	})

	test('returns a later page starting at offset', () => {
		const page = paginateLogEvents(events(10), { offset: 5, limit: 3 })
		expect(page.total).toBe(10)
		expect(page.offset).toBe(5)
		expect(page.events.length).toBe(3)
		expect(defined(page.events[0], 'page.events[0]').timestamp).toBe('t5')
		expect(defined(page.events[2], 'page.events[2]').timestamp).toBe('t7')
	})

	test('returns the partial final page when fewer than limit remain', () => {
		const page = paginateLogEvents(events(10), { offset: 8, limit: 5 })
		expect(page.total).toBe(10)
		expect(page.events.length).toBe(2)
		expect(defined(page.events[0], 'page.events[0]').timestamp).toBe('t8')
		expect(defined(page.events[1], 'page.events[1]').timestamp).toBe('t9')
	})

	test('returns an empty page with the correct total when offset is past the end', () => {
		const page = paginateLogEvents(events(10), { offset: 50, limit: 5 })
		expect(page.total).toBe(10)
		expect(page.offset).toBe(50)
		expect(page.events).toEqual([])
	})

	test('returns an empty page for an empty log', () => {
		const page = paginateLogEvents([], { offset: 0, limit: 5 })
		expect(page.total).toBe(0)
		expect(page.events).toEqual([])
	})

	test('returns the whole log when limit exceeds the count', () => {
		const page = paginateLogEvents(events(3), { offset: 0, limit: 100 })
		expect(page.total).toBe(3)
		expect(page.events.length).toBe(3)
	})
})

describe('filterLogEventsForInstance', () => {
	function event(type: string, payload: unknown): LogEvent {
		return { timestamp: 't', type, payload }
	}

	function ancestryLog(): LogEvent[] {
		return [
			event('role_start', { role: 'orchestrator', roleId: 'orchestrator-0', depth: 0 }),
			event('role_start', { role: 'coder', roleId: 'coder-1', depth: 1, parentRoleId: 'orchestrator-0' }),
			event('role_start', { role: 'subcoder', roleId: 'subcoder-2', depth: 2, parentRoleId: 'coder-1' }),
			event('llm_call', { role: 'orchestrator', roleId: 'orchestrator-0' }),
			event('llm_call', { role: 'coder', roleId: 'coder-1' }),
			event('llm_call', { role: 'subcoder', roleId: 'subcoder-2' }),
			event('role_finished', { role: 'coder', roleId: 'coder-1', status: 'success' }),
			event('llm_call', { role: 'planner', roleId: 'planner-0' }),
		]
	}

	test('keeps the instance turns, its lifecycle, and its ancestor lifecycle, with log-wide indices', () => {
		const filtered = filterLogEventsForInstance(ancestryLog(), 'coder-1')
		expect(filtered.map((entry) => entry.index)).toEqual([0, 1, 4, 6])
		expect(filtered.map((entry) => entry.event.type)).toEqual(['role_start', 'role_start', 'llm_call', 'role_finished'])
	})

	test('does not include a child instance', () => {
		const filtered = filterLogEventsForInstance(ancestryLog(), 'coder-1')
		expect(filtered.some((entry) => entry.event.payload && typeof entry.event.payload === 'object' && 'roleId' in entry.event.payload && entry.event.payload.roleId === 'subcoder-2')).toBe(false)
	})

	test('excludes turn events that carry no usable roleId', () => {
		const events: LogEvent[] = [
			event('llm_call', { role: 'coder' }),
			event('llm_call_start', { role: 'coder' }),
			event('llm_call', { role: 'planner' }),
		]
		expect(filterLogEventsForInstance(events, 'coder')).toEqual([])
	})

	test('matches the current instance roleId for turns and still matches turn failures by role name', () => {
		const events: LogEvent[] = [
			event('role_start', { role: 'coder', roleId: 'coder-1', depth: 1, parentRoleId: 'orchestrator-0' }),
			event('llm_call', { role: 'coder', roleId: 'coder-1' }),
			event('llm_unavailable', { role: 'coder', message: 'down' }),
			event('llm_call', { role: 'coder', roleId: 'coder-2' }),
		]
		expect(filterLogEventsForInstance(events, 'coder-1').map((entry) => entry.index)).toEqual([0, 1, 2])
	})

	test('returns an empty list for an empty or unknown instance id', () => {
		expect(filterLogEventsForInstance(ancestryLog(), '')).toEqual([])
		expect(filterLogEventsForInstance(ancestryLog(), 'missing-9')).toEqual([])
	})
})
