import type { LogEvent } from './types.js'
import { isObject } from './validation.js'

export interface StaleTerminal {
	type: string
	payload: Record<string, unknown>
}

const STALE_MESSAGE = 'The service restarted while this invocation was in flight; no terminal was recorded.'

function payloadOf(event: LogEvent): Record<string, unknown> | undefined {
	return isObject(event.payload) ? event.payload : undefined
}

function stringField(payload: Record<string, unknown>, field: string): string | undefined {
	const value = payload[field]
	return typeof value === 'string' ? value : undefined
}

function numberField(payload: Record<string, unknown>, field: string): number | undefined {
	const value = payload[field]
	return typeof value === 'number' ? value : undefined
}

const TERMINAL_BY_START: Readonly<Record<string, string>> = {
	role_start: 'role_finished',
	tool_call: 'tool_result',
	ask_human: 'human_answer',
	interrupt: 'interrupt_resolved',
}

function terminalPayload(startType: string, payload: Record<string, unknown>, callId: string): Record<string, unknown> | undefined {
	if (startType === 'role_start') {
		const role = stringField(payload, 'role')
		const roleId = stringField(payload, 'roleId')
		if (role === undefined || roleId === undefined) return undefined
		const terminal: Record<string, unknown> = {
			role,
			roleId,
			callId,
			status: 'error',
			error: { kind: 'interrupted', message: STALE_MESSAGE },
			summary: STALE_MESSAGE,
		}
		const depth = numberField(payload, 'depth')
		if (depth !== undefined) terminal['depth'] = depth
		const parent = stringField(payload, 'parent')
		if (parent !== undefined) terminal['parent'] = parent
		return terminal
	}
	if (startType === 'tool_call') {
		const role = stringField(payload, 'role')
		const tool = stringField(payload, 'tool')
		if (role === undefined || tool === undefined) return undefined
		return { role, tool, kind: 'interrupted', result: { kind: 'interrupted', message: STALE_MESSAGE }, callId }
	}
	if (startType === 'ask_human') {
		const id = stringField(payload, 'id')
		if (id === undefined) return undefined
		const answer = 'No answer was recorded before the service restarted.'
		const terminal: Record<string, unknown> = { id, callId, answer }
		const question = stringField(payload, 'question')
		if (question !== undefined) terminal['question'] = question
		return terminal
	}
	if (startType === 'interrupt') {
		const terminal: Record<string, unknown> = { action: 'failed', summary: STALE_MESSAGE, callId }
		const trigger = stringField(payload, 'trigger')
		const handler = stringField(payload, 'handler')
		const target = stringField(payload, 'target')
		if (trigger !== undefined) terminal['trigger'] = trigger
		if (handler !== undefined) terminal['handler'] = handler
		if (target !== undefined) terminal['target'] = target
		return terminal
	}
	return undefined
}

// Plans one interrupted terminal for every identified start that has no matching terminal, is not a live checkpoint role, and is not a pending invocation (which resume reconciles separately). Pure and idempotent: the caller appends the returned terminals and a second planning pass over the updated log finds nothing.
export function planStaleInvocationTerminals(events: readonly LogEvent[], liveRoleCallIds: ReadonlySet<string>, exemptCallIds: ReadonlySet<string>): StaleTerminal[] {
	const terminated = new Set<string>()
	for (const event of events) {
		if (event.type !== 'role_finished' && event.type !== 'tool_result' && event.type !== 'human_answer' && event.type !== 'interrupt_resolved') continue
		const payload = payloadOf(event)
		// A paused finish keeps the role invocation open; it is not a terminal for stale-invocation planning.
		if (event.type === 'role_finished' && payload?.['paused'] === true) continue
		const callId = payload === undefined ? undefined : stringField(payload, 'callId')
		if (callId !== undefined) terminated.add(`${event.type}\u0000${callId}`)
	}
	const planned: StaleTerminal[] = []
	const seen = new Set<string>()
	// Walk starts newest-first so a child or tool start is closed before its parent role; otherwise a parent terminal could be written while its child is still open.
	for (const event of [...events].reverse()) {
		const terminalType = TERMINAL_BY_START[event.type]
		if (terminalType === undefined) continue
		const payload = payloadOf(event)
		if (payload === undefined) continue
		const callId = stringField(payload, 'callId')
		if (callId === undefined) continue
		if (exemptCallIds.has(callId)) continue
		if (event.type === 'role_start' && liveRoleCallIds.has(callId)) continue
		if (terminated.has(`${terminalType}\u0000${callId}`)) continue
		if (seen.has(callId)) continue
		const terminal = terminalPayload(event.type, payload, callId)
		if (terminal === undefined) continue
		seen.add(callId)
		planned.push({ type: terminalType, payload: terminal })
	}
	return planned
}
