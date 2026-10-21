import { describe, expect, test } from 'bun:test'
import { planStaleInvocationTerminals } from './stale-invocations.ts'
import type { LogEvent } from './types.ts'

function event(type: string, payload: unknown): LogEvent {
	return { timestamp: 't', type, payload }
}

describe('planStaleInvocationTerminals', () => {
	test('closes stale interrupts, handler roles, and handler tools while leaving live roles and pending calls alone', () => {
		const events: LogEvent[] = [
			event('role_start', { role: 'main', roleId: 'main-0-1', callId: 'role:main-0-1', depth: 0 }),
			event('interrupt', { trigger: 'loop_check', handler: 'detector', target: 'main-0-1', callId: 'interrupt:1', parentCallId: 'role:main-0-1' }),
			event('role_start', { role: 'detector', roleId: 'detector-1-2', callId: 'role:detector-1-2', depth: 1, parent: 'main' }),
			event('tool_call', { role: 'detector', tool: 'recent_role_tool_calls', callId: 'tool:check-1', parentCallId: 'role:detector-1-2' }),
			event('tool_call', { role: 'main', tool: 'echo', callId: 'tool:pending-1', parentCallId: 'role:main-0-1' }),
		]

		const terminals = planStaleInvocationTerminals(events, new Set(['role:main-0-1']), new Set(['tool:pending-1']))

		expect(terminals.map((terminal) => terminal.type)).toEqual(['tool_result', 'role_finished', 'interrupt_resolved'])
		expect(terminals[0]?.payload).toMatchObject({ role: 'detector', tool: 'recent_role_tool_calls', callId: 'tool:check-1', kind: 'interrupted', result: { kind: 'interrupted' } })
		expect(terminals[1]?.payload).toMatchObject({ role: 'detector', roleId: 'detector-1-2', callId: 'role:detector-1-2', status: 'error', error: { kind: 'interrupted' } })
		expect(terminals[2]?.payload).toMatchObject({ callId: 'interrupt:1', action: 'failed' })
	})

	test('closes an unanswered ask without inventing a role-history answer and skips starts without an invocation id', () => {
		const events: LogEvent[] = [
			event('ask_human', { id: 'ask-1', callId: 'tool:ask-1', parentCallId: 'role:main-0-1', question: 'which?' }),
			event('role_start', { role: 'detached', roleId: 'detached-0-1' }),
		]

		const terminals = planStaleInvocationTerminals(events, new Set(), new Set())

		expect(terminals).toHaveLength(1)
		expect(terminals[0]?.type).toBe('human_answer')
		expect(terminals[0]?.payload).toMatchObject({ id: 'ask-1', callId: 'tool:ask-1', question: 'which?', answer: 'No answer was recorded before the service restarted.' })
	})

	test('is idempotent: re-planning after the terminals are appended produces nothing', () => {
		const events: LogEvent[] = [
			event('role_start', { role: 'detector', roleId: 'detector-1-2', callId: 'role:detector-1-2', depth: 1 }),
			event('tool_call', { role: 'detector', tool: 'x', callId: 'tool:x-1', parentCallId: 'role:detector-1-2' }),
			event('interrupt', { handler: 'detector', callId: 'interrupt:1', parentCallId: 'role:main-0-1' }),
		]
		const first = planStaleInvocationTerminals(events, new Set(), new Set())
		const after = [...events, ...first.map((terminal) => event(terminal.type, terminal.payload))]
		expect(planStaleInvocationTerminals(after, new Set(), new Set())).toEqual([])
	})

	test('a paused role_finished is not mistaken for a terminal', () => {
		const events: LogEvent[] = [
			event('role_start', { role: 'main', roleId: 'main-0-1', callId: 'role:main-0-1', depth: 0 }),
			event('role_finished', { role: 'main', roleId: 'main-0-1', callId: 'role:main-0-1', depth: 0, status: 'needs_clarification', paused: true }),
		]
		expect(planStaleInvocationTerminals(events, new Set(['role:main-0-1']), new Set())).toEqual([])
		const stale = planStaleInvocationTerminals(events, new Set(), new Set())
		expect(stale.map((terminal) => terminal.type)).toEqual(['role_finished'])
	})
})
