import type { AppendLog } from './persistence.js'
import type { LogEvent, ResultCard, ToolCall, ToolResult } from './types.js'
import { isObject } from './validation.js'

const ROLE_CALL_PREFIX = 'role:'
const TOOL_CALL_PREFIX = 'tool:'
const INTERRUPT_CALL_PREFIX = 'interrupt:'

export function roleCallId(roleId: string): string {
	return `${ROLE_CALL_PREFIX}${roleId}`
}

export function toolCallId(toolCallId: string): string {
	return `${TOOL_CALL_PREFIX}${toolCallId}`
}

export function interruptCallId(interruptId: string): string {
	return `${INTERRUPT_CALL_PREFIX}${interruptId}`
}

export interface ToolInvocation {
	toolCall: ToolCall
	// The tool-call id the invocation is keyed by today; it differs from toolCall.id only when the model supplied an empty or reused id.
	questionId: string
	callId: string
	parentCallId: string
}

export interface InterruptInvocation {
	callId: string
	parentCallId: string
}

export interface RoleStartInput {
	roleName: string
	roleId: string
	depth: number
	task: string
	parent?: string
	parentRoleId?: string
	// An interrupt handler's role_start is rooted at the interrupt invocation, not at the target role, so it supplies this explicitly.
	parentCallId?: string
	continuedFrom?: string
}

export interface RoleFinishedInput {
	roleName: string
	roleId: string
	depth: number
	card: ResultCard
	parent?: string
	// True only when this needs_clarification card pauses the whole run and the same role will resume; other needs_clarification cards are ordinary terminals.
	pausesRun: boolean
}

export function roleStartPayload(input: RoleStartInput): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		role: input.roleName,
		roleId: input.roleId,
		callId: roleCallId(input.roleId),
		depth: input.depth,
		task: input.task,
	}
	if (input.parent !== undefined) payload['parent'] = input.parent
	if (input.parentRoleId !== undefined) payload['parentRoleId'] = input.parentRoleId
	const parentCallId = input.parentCallId ?? (input.parentRoleId !== undefined ? roleCallId(input.parentRoleId) : undefined)
	if (parentCallId !== undefined) payload['parentCallId'] = parentCallId
	if (input.continuedFrom !== undefined) payload['continuedFrom'] = input.continuedFrom
	return payload
}

export function roleFinishedPayload(input: RoleFinishedInput): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		role: input.roleName,
		roleId: input.roleId,
		callId: roleCallId(input.roleId),
		depth: input.depth,
		status: input.card.status,
	}
	if (input.card.summary !== '') payload['summary'] = input.card.summary
	if (input.card.error !== undefined) payload['error'] = input.card.error
	if (input.parent !== undefined) payload['parent'] = input.parent
	// A clarification pause that actually pauses the run keeps the checkpoint and the role resumes, so it is a pause event, not the invocation's terminal.
	if (input.pausesRun) payload['paused'] = true
	return payload
}

export function toolCallPayload(invocation: ToolInvocation, roleName: string): Record<string, unknown> {
	return {
		role: roleName,
		tool: invocation.toolCall.function.name,
		arguments: invocation.toolCall.function.arguments,
		callId: invocation.callId,
		parentCallId: invocation.parentCallId,
	}
}

export function toolResultPayload(invocation: ToolInvocation, roleName: string, result: ToolResult): Record<string, unknown> {
	return {
		role: roleName,
		tool: invocation.toolCall.function.name,
		kind: result.kind,
		result,
		callId: invocation.callId,
	}
}

export interface AskHumanPayloadInput {
	questionId: string
	callId: string
	parentCallId: string
	question: string
	context?: string
	parked?: boolean
}

export function askHumanPayload(input: AskHumanPayloadInput): Record<string, unknown> {
	return {
		id: input.questionId,
		callId: input.callId,
		parentCallId: input.parentCallId,
		question: input.question,
		...(input.context !== undefined ? { context: input.context } : {}),
		...(input.parked === true ? { parked: true } : {}),
	}
}

export function humanAnswerPayload(id: string, callId: string, answer: string, question?: string): Record<string, unknown> {
	return {
		id,
		callId,
		...(question !== undefined ? { question } : {}),
		answer,
	}
}

export function interruptPayload(invocation: InterruptInvocation, details: Record<string, unknown>): Record<string, unknown> {
	return { ...details, callId: invocation.callId, parentCallId: invocation.parentCallId }
}

export function interruptResolvedPayload(callId: string, details: Record<string, unknown>): Record<string, unknown> {
	return { ...details, callId }
}

function appendEvent(appendLog: AppendLog, type: string, payload: unknown): void {
	appendLog({ timestamp: new Date().toISOString(), type, payload })
}

function eventCallId(event: LogEvent): string | undefined {
	if (!isObject(event.payload)) return undefined
	const callId = event.payload['callId']
	if (typeof callId === 'string' && callId !== '') return callId
	const id = event.payload['id']
	if (typeof id === 'string' && id !== '' && (event.type === 'ask_human' || event.type === 'human_answer')) return toolCallId(id)
	return undefined
}

const START_EVENT_TYPES: ReadonlySet<string> = new Set(['role_start', 'tool_call', 'ask_human', 'interrupt'])
const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set(['role_finished', 'tool_result', 'human_answer', 'interrupt_resolved'])

export interface InvocationJournal {
	allocateToolCall(toolCall: ToolCall, parentRoleId: string): ToolInvocation
	adoptToolCall(toolCall: ToolCall, callId: string, parentCallId: string): ToolInvocation
	roleStarted(input: RoleStartInput): string
	roleFinished(input: RoleFinishedInput): boolean
	toolStarted(invocation: ToolInvocation, roleName: string): boolean
	toolFinished(invocation: ToolInvocation, roleName: string, result: ToolResult): boolean
	interruptStarted(targetRoleId: string, details: Record<string, unknown>): InterruptInvocation
	interruptFinished(callId: string, details: Record<string, unknown>): boolean
	markStarted(callId: string): void
	markTerminal(callId: string): void
	hasStarted(callId: string): boolean
	hasTerminal(callId: string): boolean
	seedEvents(events: readonly LogEvent[]): void
	seedStartedCallIds(callIds: readonly string[]): void
}

// One journal per run. It is the single writer of invocation lifecycle events, so a start can never be emitted twice and a terminal can never close a call that never started. A resumed run seeds it from the checkpoint's role ids and the existing log before the role loop re-enters.
export function createInvocationJournal(appendLog: AppendLog): InvocationJournal {
	const started = new Set<string>()
	const terminated = new Set<string>()
	const usedToolIds = new Set<string>()
	let generatedToolIdCounter = 0

	function markStarted(callId: string): void {
		if (terminated.has(callId)) return
		started.add(callId)
	}

	function markTerminal(callId: string): void {
		if (terminated.has(callId)) return
		if (!started.has(callId)) throw new Error(`invocation journal: terminal event for unstarted invocation "${callId}"`)
		terminated.add(callId)
	}

	function allocateToolCall(toolCall: ToolCall, parentRoleId: string): ToolInvocation {
		let questionId = toolCall.id
		if (questionId === '' || usedToolIds.has(questionId)) {
			do {
				generatedToolIdCounter += 1
				questionId = `generated-${generatedToolIdCounter}`
			} while (usedToolIds.has(questionId))
		}
		usedToolIds.add(questionId)
		return {
			toolCall,
			questionId,
			callId: toolCallId(questionId),
			parentCallId: roleCallId(parentRoleId),
		}
	}

	function adoptToolCall(toolCall: ToolCall, callId: string, parentCallId: string): ToolInvocation {
		const questionId = callId.startsWith(TOOL_CALL_PREFIX) ? callId.slice(TOOL_CALL_PREFIX.length) : callId
		usedToolIds.add(questionId)
		return { toolCall, questionId, callId, parentCallId }
	}

	return {
		allocateToolCall,
		adoptToolCall,
		roleStarted(input) {
			const callId = roleCallId(input.roleId)
			if (started.has(callId) || terminated.has(callId)) return callId
			markStarted(callId)
			appendEvent(appendLog, 'role_start', roleStartPayload(input))
			return callId
		},
		roleFinished(input) {
			const callId = roleCallId(input.roleId)
			if (terminated.has(callId)) return false
			// A run-pausing needs_clarification role_finished is a pause: log it, but keep the role invocation open so the answer resume can emit the true terminal later.
			if (!input.pausesRun) markTerminal(callId)
			else markStarted(callId)
			appendEvent(appendLog, 'role_finished', roleFinishedPayload(input))
			return true
		},
		toolStarted(invocation, roleName) {
			if (terminated.has(invocation.callId)) return false
			if (started.has(invocation.callId)) return false
			markStarted(invocation.callId)
			appendEvent(appendLog, 'tool_call', toolCallPayload(invocation, roleName))
			return true
		},
		toolFinished(invocation, roleName, result) {
			if (terminated.has(invocation.callId)) return false
			markTerminal(invocation.callId)
			appendEvent(appendLog, 'tool_result', toolResultPayload(invocation, roleName, result))
			return true
		},
		interruptStarted(targetRoleId, details) {
			const callId = interruptCallId(crypto.randomUUID())
			const invocation = { callId, parentCallId: roleCallId(targetRoleId) }
			markStarted(callId)
			appendEvent(appendLog, 'interrupt', interruptPayload(invocation, details))
			return invocation
		},
		interruptFinished(callId, details) {
			if (terminated.has(callId)) return false
			markTerminal(callId)
			appendEvent(appendLog, 'interrupt_resolved', interruptResolvedPayload(callId, details))
			return true
		},
		markStarted,
		markTerminal,
		hasStarted(callId) {
			return started.has(callId)
		},
		hasTerminal(callId) {
			return terminated.has(callId)
		},
		seedEvents(events) {
			for (const event of events) {
				const callId = eventCallId(event)
				if (callId === undefined) continue
				// Reusing a pre-restart tool id must generate a fresh id too, so the allocator's used-id set is rebuilt from the journal.
				if (callId.startsWith(TOOL_CALL_PREFIX)) usedToolIds.add(callId.slice(TOOL_CALL_PREFIX.length))
				if (START_EVENT_TYPES.has(event.type)) markStarted(callId)
				if (event.type === 'role_finished' && isObject(event.payload) && event.payload['paused'] === true) {
					markStarted(callId)
					continue
				}
				if (TERMINAL_EVENT_TYPES.has(event.type)) {
					started.add(callId)
					terminated.add(callId)
				}
			}
		},
		seedStartedCallIds(callIds) {
			for (const callId of callIds) markStarted(callId)
		},
	}
}
