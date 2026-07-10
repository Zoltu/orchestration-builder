import type { LogEvent, RunMeta } from '../executor/types.js'
import type { RunSnapshot } from './render.js'

// The InteractionModel shape this adapter produces is the contract the browser view modules
// render. The canonical definition lives in `source/web/static/interaction-model.js` (JSDoc —
// the read helpers both views call) and `docs/visualization.md` "The model"; these interfaces
// mirror that shape so the server typechecks against the same contract the client consumes.

type ParticipantKind = 'human' | 'interrupt' | 'role' | 'tool'
type OperationKind = 'call' | 'return' | 'observe' | 'terminate'
type OperationLifecycle = 'in_flight' | 'settled'
type OperationOutcome = 'success' | 'error' | 'terminated'
type RunStatus = 'running' | 'success' | 'error' | 'needs_clarification' | 'unknown'

interface Participant {
	id: string
	role: string
	kind: ParticipantKind
}

interface OperationMetrics {
	tokens: number | null
	cachedPromptTokens: number | null
	elapsedSeconds: number | null
}

interface Operation {
	id: string
	kind: OperationKind
	stack: string
	source: string
	destination: string
	startedAt: string
	settledAt: string | null
	lifecycle: OperationLifecycle
	outcome: OperationOutcome | null
	details: string | null
	metrics: OperationMetrics | null
}

export interface InteractionModel {
	participants: Participant[]
	operations: Operation[]
	status: RunStatus
}

const ROOT_HUMAN_ID = 'human:root'
const MAIN_STACK = 'main'
// The agent/ask_human/finish tools are control-flow primitives, not work a node represents:
// agent is the delegation wrapper (the role_start/role_finished pair is the call), ask_human is
// the question (the ask_human/human_answer events are the call), and finish ends the role (the
// role_finished return is the close). Their tool_call/tool_result events are skipped so a
// delegation does not also spawn a redundant "agent" tool node.
const CONTROL_TOOLS = new Set(['agent', 'ask_human', 'finish'])

// Narrowing helpers mirror render.ts so the adapter reads LogEvent payloads the same way the
// legacy run view does — every external payload is validated before use, never cast.
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(payload: unknown, field: string): string | null {
	if (!isObject(payload)) return null
	const value = payload[field]
	return typeof value === 'string' ? value : null
}

function numberField(payload: unknown, field: string): number | null {
	if (!isObject(payload)) return null
	const value = payload[field]
	return typeof value === 'number' ? value : null
}

// Extracts only the two counters the model carries: the total token bill and the cached-prompt
// subset. The full breakdown the run view shows is a run-wide concern (render.ts deriveBudgets);
// per-invocation metrics need only the totals the flow nodes display.
function usageOf(payload: unknown): { totalTokens: number; cachedPromptTokens: number } | null {
	if (!isObject(payload)) return null
	const usage = payload['usage']
	if (!isObject(usage)) return null
	const total = usage['totalTokens']
	const prompt = usage['promptTokens']
	const completion = usage['completionTokens']
	const cached = usage['cachedPromptTokens']
	let totalTokens: number | null = null
	if (typeof total === 'number') {
		totalTokens = total
	} else if (typeof prompt === 'number' && typeof completion === 'number') {
		totalTokens = prompt + completion
	}
	if (totalTokens === null) return null
	const cachedPromptTokens = typeof cached === 'number' ? cached : 0
	return { totalTokens, cachedPromptTokens }
}

function runStatusOf(meta: RunMeta | null): RunStatus {
	if (meta === null) return 'unknown'
	if (meta.status === 'running' || meta.status === 'success' || meta.status === 'error' || meta.status === 'needs_clarification') {
		return meta.status
	}
	return 'unknown'
}

function secondsBetween(start: string, end: string): number | null {
	const startMs = Date.parse(start)
	const endMs = Date.parse(end)
	if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null
	return Math.max(0, Math.round((endMs - startMs) / 1000))
}

// Pretty-prints the model's raw arguments string as a fenced JSON block so the detail surface
// shows legible parameters rather than a one-line blob; a non-JSON arguments string falls back
// to a plain fenced block. This is data, not prose: it reaches the DOM only through the client's
// sanitized Markdown pipeline.
function formatArguments(raw: string | null): string | null {
	if (raw === null) return null
	try {
		const parsed: unknown = JSON.parse(raw)
		return '```json\n' + JSON.stringify(parsed, null, 2) + '\n```'
	} catch {
		return '```\n' + raw + '\n```'
	}
}

function formatResult(payload: unknown): string | null {
	if (!isObject(payload)) return null
	const result = payload['result']
	if (result === null || result === undefined) return null
	try {
		return '```json\n' + JSON.stringify(result, null, 2) + '\n```'
	} catch {
		return null
	}
}

interface OpenCallRecord {
	operation: Operation
	destinationId: string
	destinationRole: string
	destinationKind: ParticipantKind
	// The ask_human question id, so a human_answer event can close the matching call.
	questionId: string | null
	returnTimestamp: string | null
	// Set when a nested call lands on the same stack (the callee delegated), which ends this
	// call's transit phase even though the invocation is still open.
	delegatedAt: string | null
	tokens: number
	cachedPromptTokens: number
}

interface ReturnRecord {
	operation: Operation
	// The role of the participant the return is addressed to (the caller). An llm_call from this
	// role is the caller resuming, which settles a lingering return leg.
	callerRole: string | null
	// Set when a later activity-affecting operation, or an llm_call from the caller, follows this
	// return — the response leg has been acknowledged and the return is no longer lingering.
	supersededAt: string | null
}

export function deriveInteractionModel(snapshot: RunSnapshot, now: string): InteractionModel {
	const status = runStatusOf(snapshot.meta)
	// A run that is running, waiting on a question (needs_clarification), or has no readable meta
	// (unknown) still has something in flight at `now`; a finished run (success/error) has settled.
	const runActive = status === 'running' || status === 'needs_clarification' || status === 'unknown'

	const rootParticipant: Participant = { id: ROOT_HUMAN_ID, role: 'human', kind: 'human' }
	const participants: Participant[] = [rootParticipant]
	const registry = new Map<string, Participant>([[ROOT_HUMAN_ID, rootParticipant]])
	const operations: Operation[] = []
	const allCallRecords: OpenCallRecord[] = []
	const allReturnRecords: ReturnRecord[] = []
	const openCalls: OpenCallRecord[] = []
	let lingeringReturn: ReturnRecord | null = null

	const idCounters = new Map<string, number>()
	function nextId(key: string): number {
		const n = (idCounters.get(key) ?? 0) + 1
		idCounters.set(key, n)
		return n
	}

	let opCounter = 0
	function opId(): string {
		opCounter += 1
		return `op-${opCounter}`
	}

	function addParticipant(id: string, role: string, kind: ParticipantKind): string {
		const participant: Participant = { id, role, kind }
		participants.push(participant)
		registry.set(id, participant)
		return id
	}

	function activeRoleParticipantId(): string {
		const top = openCalls[openCalls.length - 1]
		return top === undefined ? ROOT_HUMAN_ID : top.destinationId
	}

	// Any new activity-affecting operation on the active stack settles a lingering return leg: a
	// new call, a new return, or — handled separately in the llm_call branch — an llm_call from the
	// caller. recordCall and recordReturn both call this, so a torn read that leaves a prior return
	// un-superseded cannot leak an in_flight return that is not actually the latest operation.
	function settleLingering(timestamp: string): void {
		if (lingeringReturn !== null) {
			lingeringReturn.supersededAt = timestamp
			lingeringReturn = null
		}
	}

	// An llm_call settles a lingering leg only when the role that produced it is the caller the leg
	// is addressed to (the caller resumed thinking); an llm_call from a different role is not the
	// caller acting and must not settle it.
	function settleLingeringIfCaller(role: string, timestamp: string): void {
		if (lingeringReturn !== null && lingeringReturn.callerRole === role) {
			lingeringReturn.supersededAt = timestamp
			lingeringReturn = null
		}
	}

	function settlePreviousByDelegation(timestamp: string): void {
		const top = openCalls[openCalls.length - 1]
		if (top === undefined) return
		// The first delegation ends the call's transit phase; a later delegation after the child
		// returned does not move that boundary.
		if (top.returnTimestamp === null && top.delegatedAt === null) top.delegatedAt = timestamp
	}

	function recordCall(event: LogEvent, source: string, destinationId: string, destinationRole: string, destinationKind: ParticipantKind, questionId: string | null, details: string | null): void {
		settleLingering(event.timestamp)
		const callOperation: Operation = {
			id: opId(),
			kind: 'call',
			stack: MAIN_STACK,
			source,
			destination: destinationId,
			startedAt: event.timestamp,
			settledAt: null,
			lifecycle: 'in_flight',
			outcome: null,
			details,
			metrics: null,
		}
		operations.push(callOperation)
		const record: OpenCallRecord = {
			operation: callOperation,
			destinationId,
			destinationRole,
			destinationKind,
			questionId,
			returnTimestamp: null,
			delegatedAt: null,
			tokens: 0,
			cachedPromptTokens: 0,
		}
		openCalls.push(record)
		allCallRecords.push(record)
	}

	function recordReturn(event: LogEvent, matched: OpenCallRecord, outcome: OperationOutcome, details: string | null): void {
		settleLingering(event.timestamp)
		const callerId = matched.operation.source
		const callerParticipant = registry.get(callerId)
		const callerRole = callerParticipant === undefined ? null : callerParticipant.role
		const returnOperation: Operation = {
			id: opId(),
			kind: 'return',
			stack: MAIN_STACK,
			source: matched.destinationId,
			destination: callerId,
			startedAt: event.timestamp,
			settledAt: null,
			lifecycle: 'in_flight',
			outcome,
			details,
			metrics: null,
		}
		operations.push(returnOperation)
		matched.returnTimestamp = event.timestamp
		const returnRecord: ReturnRecord = { operation: returnOperation, callerRole, supersededAt: null }
		allReturnRecords.push(returnRecord)
		lingeringReturn = returnRecord
	}

	// Pops the open call at matchIndex plus any deeper calls left open by a torn read (a child
	// whose finish event was missed). The abandoned deeper calls close without a return operation;
	// their call operations remain but settle at this timestamp so they do not read as in flight.
	function popMatch(matchIndex: number, timestamp: string): OpenCallRecord | null {
		if (matchIndex < 0 || matchIndex >= openCalls.length) return null
		const popped = openCalls.splice(matchIndex)
		const matched = popped[0]
		if (matched === undefined) return null
		for (let i = 1; i < popped.length; i += 1) {
			const abandoned = popped[i]
			if (abandoned !== undefined) abandoned.returnTimestamp = timestamp
		}
		return matched
	}

	for (const event of snapshot.logEvents) {
		switch (event.type) {
			case 'role_start': {
				const role = stringField(event.payload, 'role')
				if (role === null) break
				const depth = numberField(event.payload, 'depth') ?? 0
				const task = stringField(event.payload, 'task')
				const roleId = `role:${role}:${nextId('role:' + role)}`
				addParticipant(roleId, role, 'role')
				settlePreviousByDelegation(event.timestamp)
				const source = depth === 0 ? ROOT_HUMAN_ID : activeRoleParticipantId()
				recordCall(event, source, roleId, role, 'role', null, task)
				break
			}
			case 'role_finished': {
				const role = stringField(event.payload, 'role')
				if (role === null) break
				const finishStatus = stringField(event.payload, 'status')
				const summary = stringField(event.payload, 'summary')
				let matchIndex = -1
				for (let i = openCalls.length - 1; i >= 0; i -= 1) {
					const candidate = openCalls[i]
					if (candidate === undefined) continue
					if (candidate.destinationRole === role && candidate.destinationKind === 'role') {
						matchIndex = i
						break
					}
				}
				const matched = popMatch(matchIndex, event.timestamp)
				if (matched === null) break
				// needs_clarification is a clean finish that asked; the run-level status carries it,
				// not the operation outcome.
				const outcome: OperationOutcome = finishStatus === 'error' ? 'error' : 'success'
				recordReturn(event, matched, outcome, summary)
				break
			}
			case 'llm_call': {
				const role = stringField(event.payload, 'role')
				if (role === null) break
				const usage = usageOf(event.payload)
				// An llm_call from the caller settles a lingering return leg (the caller resumed).
				settleLingeringIfCaller(role, event.timestamp)
				if (usage === null) break
				// The call's metrics accumulate the callee's work: the innermost open call whose
				// destination is the role that produced this llm_call.
				for (let i = openCalls.length - 1; i >= 0; i -= 1) {
					const candidate = openCalls[i]
					if (candidate === undefined) continue
					if (candidate.destinationRole === role) {
						candidate.tokens += usage.totalTokens
						candidate.cachedPromptTokens += usage.cachedPromptTokens
						break
					}
				}
				break
			}
			case 'tool_call': {
				const role = stringField(event.payload, 'role')
				const tool = stringField(event.payload, 'tool')
				if (role === null || tool === null) break
				if (CONTROL_TOOLS.has(tool)) break
				if (openCalls.length === 0) break
				const toolId = `tool:${tool}:${nextId('tool:' + tool)}`
				addParticipant(toolId, tool, 'tool')
				settlePreviousByDelegation(event.timestamp)
				recordCall(event, activeRoleParticipantId(), toolId, tool, 'tool', null, formatArguments(stringField(event.payload, 'arguments')))
				break
			}
			case 'tool_result': {
				const role = stringField(event.payload, 'role')
				const tool = stringField(event.payload, 'tool')
				if (role === null || tool === null) break
				if (CONTROL_TOOLS.has(tool)) break
				let matchIndex = -1
				for (let i = openCalls.length - 1; i >= 0; i -= 1) {
					const candidate = openCalls[i]
					if (candidate === undefined) continue
					if (candidate.destinationRole === tool && candidate.destinationKind === 'tool') {
						matchIndex = i
						break
					}
				}
				const matched = popMatch(matchIndex, event.timestamp)
				if (matched === null) break
				const kind = stringField(event.payload, 'kind')
				const outcome: OperationOutcome = kind === 'success' ? 'success' : 'error'
				recordReturn(event, matched, outcome, formatResult(event.payload))
				break
			}
			case 'ask_human': {
				const id = stringField(event.payload, 'id')
				const question = stringField(event.payload, 'question')
				if (id === null || question === null) break
				if (openCalls.length === 0) break
				const context = stringField(event.payload, 'context')
				const answererId = `human:answerer:${nextId('answerer')}`
				addParticipant(answererId, 'human', 'human')
				settlePreviousByDelegation(event.timestamp)
				const details = context === null ? question : `${question}\n\n*Context: ${context}*`
				recordCall(event, activeRoleParticipantId(), answererId, 'human', 'human', id, details)
				break
			}
			case 'human_answer': {
				const id = stringField(event.payload, 'id')
				const answer = stringField(event.payload, 'answer')
				if (id === null || answer === null) break
				let matchIndex = -1
				for (let i = openCalls.length - 1; i >= 0; i -= 1) {
					const candidate = openCalls[i]
					if (candidate === undefined) continue
					if (candidate.questionId === id) {
						matchIndex = i
						break
					}
				}
				const matched = popMatch(matchIndex, event.timestamp)
				if (matched === null) break
				recordReturn(event, matched, 'success', answer)
				break
			}
			default:
				break
		}
	}

	for (const record of allCallRecords) {
		const op = record.operation
		if (record.returnTimestamp !== null) {
			op.settledAt = record.returnTimestamp
			op.lifecycle = 'settled'
		} else if (record.delegatedAt !== null) {
			op.settledAt = record.delegatedAt
			op.lifecycle = 'settled'
		} else if (runActive) {
			op.settledAt = null
			op.lifecycle = 'in_flight'
		} else {
			// A terminal run should have no open calls; defensively settle one that does at `now`.
			op.settledAt = now
			op.lifecycle = 'settled'
		}
		// The per-invocation span runs to the matching return, or to `now` while the invocation is
		// still open (even when its transit phase was ended by a delegation).
		const elapsed = record.returnTimestamp !== null
			? secondsBetween(op.startedAt, record.returnTimestamp)
			: secondsBetween(op.startedAt, now)
		op.metrics = { tokens: record.tokens, cachedPromptTokens: record.cachedPromptTokens, elapsedSeconds: elapsed }
	}

	for (const record of allReturnRecords) {
		const op = record.operation
		if (record.supersededAt !== null) {
			op.settledAt = record.supersededAt
			op.lifecycle = 'settled'
		} else if (runActive) {
			// The latest activity-affecting operation on the active stack is the lingering return leg.
			op.settledAt = null
			op.lifecycle = 'in_flight'
		} else {
			// A finished run has nothing in flight; the final return settles at its own timestamp.
			op.settledAt = op.startedAt
			op.lifecycle = 'settled'
		}
	}

	return { participants, operations, status }
}
