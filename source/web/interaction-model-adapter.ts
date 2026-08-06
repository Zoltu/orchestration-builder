import type { LogEvent, RunMeta } from '../executor/types.js'
import { isObject } from '../executor/validation.js'
import type { RunSnapshot } from './render.js'

// The InteractionModel shape this adapter produces is the contract the browser view modules
// render. The canonical definition lives in `source/web/static/interaction-model.js` (JSDoc —
// the read helpers both views call) and `docs/visualization.md` "The model"; these interfaces
// mirror that shape so the server typechecks against the same contract the client consumes.

type ParticipantKind = 'human' | 'interrupt' | 'role' | 'tool'
type OperationKind = 'call' | 'return' | 'observe' | 'terminate'
type OperationLifecycle = 'in_flight' | 'settled'
type OperationOutcome = 'success' | 'error' | 'terminated'
type RunStatus = 'running' | 'success' | 'error' | 'needs_clarification' | 'interrupted' | 'unknown'

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

interface StackRecord {
	id: string
	root: string
}

export interface InteractionModel {
	participants: Participant[]
	operations: Operation[]
	status: RunStatus
	// Stack roots in push order (oldest first). A freshly preempted stack has no operations yet, so operations alone cannot name it; the records carry every stack the run has pushed, resolved or not.
	stacks: StackRecord[]
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
function stringField(payload: unknown, field: string): string | null {
	if (!isObject(payload)) return null
	const value = payload[field]
	return typeof value === 'string' ? value : null
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
	if (meta.status === 'running' || meta.status === 'success' || meta.status === 'error' || meta.status === 'needs_clarification' || meta.status === 'interrupted') {
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
	// Set when a nested call lands on the same stack (the callee delegated), which ends this call's transit phase even though the invocation is still open.
	delegatedAt: string | null
	// Set when the callee's turn began (an llm_call_start for this call's destination role), the precise transit→working boundary — the callee began working the instant the request was dispatched.
	// Precedes delegatedAt in the finalization below; null on logs predating llm_call_start, where delegatedAt carries the turn-level boundary instead.
	turnStartedAt: string | null
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

// One call stack in the run. The main run is the bottom frame (rooted at the human); each interrupt pushes a fresh frame rooted at its own root participant — a synthetic interrupt instance, or the human asker for an operator inquiry — and pauses the frame below until it resolves.
// Only the top frame is active at any time, matching the executor's sequential model: every event after an `interrupt` belongs to the top frame until its root call closes, at which point the frame is popped and control returns to the frame below.
interface StackFrame {
	stackId: string
	// The participant the stack's first call originates from — the human root for the main stack, the interrupt instance or human asker for an interrupt stack.
	rootId: string
	openCalls: OpenCallRecord[]
	lingeringReturn: ReturnRecord | null
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
	// The final returns of resolved (popped) stacks, still awaiting confirmation: each lingers until the next activity-affecting operation lands, at which point it settles.
	const pendingResolvedReturns: ReturnRecord[] = []
	// The stack of call stacks. Only the top frame is active; with a single frame (no interrupts) this behaves exactly like a single open-call chain.
	const stackStack: StackFrame[] = [{ stackId: MAIN_STACK, rootId: ROOT_HUMAN_ID, openCalls: [], lingeringReturn: null }]
	const stackRecords: StackRecord[] = [{ id: MAIN_STACK, root: ROOT_HUMAN_ID }]
	// The question text of the inquiry interrupt whose stack was just pushed, stashed so the handler's role_start shows the question as its call details rather than the generated briefing. Cleared by the next role_start or non-inquiry interrupt; null when the inquiry carried no message (the call details fall back to the task text).
	let pendingInquiryMessage: string | null = null

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

	function currentFrame(): StackFrame {
		// The stack of stacks is never empty: it starts with the main frame and is popped only while more than one frame remains.
		const frame = stackStack[stackStack.length - 1]
		if (frame === undefined) throw new Error('interaction model invariant violated: the stack of stacks is empty')
		return frame
	}

	function activeRoleParticipantId(): string {
		const frame = currentFrame()
		const top = frame.openCalls[frame.openCalls.length - 1]
		return top === undefined ? frame.rootId : top.destinationId
	}

	// Any new activity-affecting operation on the active stack settles a lingering return leg: a
	// new call, a new return, or — handled separately in the llm_call branch — an llm_call from the
	// caller. recordCall and recordReturn both call this, so a torn read that leaves a prior return
	// un-superseded cannot leak an in_flight return that is not actually the latest operation.
	function settleLingering(timestamp: string): void {
		const frame = currentFrame()
		if (frame.lingeringReturn !== null) {
			frame.lingeringReturn.supersededAt = timestamp
			frame.lingeringReturn = null
		}
	}

	// A new activity-affecting operation also confirms every resolved stack's lingering final return: the preempted stack resuming (or a fresh preemption landing) is the next action that settles them.
	function settleResolvedLingering(timestamp: string): void {
		for (const record of pendingResolvedReturns) {
			record.supersededAt = timestamp
		}
		pendingResolvedReturns.length = 0
	}

	// An llm_call settles a lingering leg only when the role that produced it is the caller the leg
	// is addressed to (the caller resumed thinking); an llm_call from a different role is not the
	// caller acting and must not settle it.
	function settleLingeringIfCaller(role: string, timestamp: string): void {
		const frame = currentFrame()
		if (frame.lingeringReturn !== null && frame.lingeringReturn.callerRole === role) {
			frame.lingeringReturn.supersededAt = timestamp
			frame.lingeringReturn = null
		}
	}

	function settlePreviousByDelegation(timestamp: string): void {
		const top = currentFrame().openCalls[currentFrame().openCalls.length - 1]
		if (top === undefined) return
		// The first delegation ends the call's transit phase; a later delegation after the child
		// returned does not move that boundary.
		if (top.returnTimestamp === null && top.delegatedAt === null) top.delegatedAt = timestamp
	}

	function recordCall(event: LogEvent, source: string, destinationId: string, destinationRole: string, destinationKind: ParticipantKind, questionId: string | null, details: string | null): void {
		settleLingering(event.timestamp)
		settleResolvedLingering(event.timestamp)
		const frame = currentFrame()
		const callOperation: Operation = {
			id: opId(),
			kind: 'call',
			stack: frame.stackId,
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
			turnStartedAt: null,
			tokens: 0,
			cachedPromptTokens: 0,
		}
		frame.openCalls.push(record)
		allCallRecords.push(record)
	}

	function recordReturn(event: LogEvent, matched: OpenCallRecord, outcome: OperationOutcome, details: string | null): void {
		settleLingering(event.timestamp)
		settleResolvedLingering(event.timestamp)
		const frame = currentFrame()
		const callerId = matched.operation.source
		const callerParticipant = registry.get(callerId)
		const callerRole = callerParticipant === undefined ? null : callerParticipant.role
		const returnOperation: Operation = {
			id: opId(),
			kind: 'return',
			stack: frame.stackId,
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
		frame.lingeringReturn = returnRecord
	}

	// Pops the open call at matchIndex plus any deeper calls left open by a torn read (a child
	// whose finish event was missed). The abandoned deeper calls close without a return operation;
	// their call operations remain but settle at this timestamp so they do not read as in flight.
	function popMatch(matchIndex: number, timestamp: string): OpenCallRecord | null {
		const frame = currentFrame()
		if (matchIndex < 0 || matchIndex >= frame.openCalls.length) return null
		const popped = frame.openCalls.splice(matchIndex)
		const matched = popped[0]
		if (matched === undefined) return null
		for (let i = 1; i < popped.length; i += 1) {
			const abandoned = popped[i]
			if (abandoned !== undefined) abandoned.returnTimestamp = timestamp
		}
		return matched
	}

	// Finds the open call whose destination role matches, searching only paused (non-active) stacks — the target of an observe or terminate, which by definition reads or reverts a node in a paused stack from the active one.
	// Returns null when no paused stack carries a matching open call (e.g. the target already returned), so the caller skips a reference to a node that no longer exists.
	function findOpenCallInPausedStack(role: string): { frame: StackFrame; record: OpenCallRecord } | null {
		for (let i = stackStack.length - 2; i >= 0; i -= 1) {
			const frame = stackStack[i]
			if (frame === undefined) continue
			for (let j = frame.openCalls.length - 1; j >= 0; j -= 1) {
				const record = frame.openCalls[j]
				if (record === undefined) continue
				if (record.destinationRole === role) return { frame, record }
			}
		}
		return null
	}

	for (const event of snapshot.logEvents) {
		switch (event.type) {
			case 'role_start': {
				const role = stringField(event.payload, 'role')
				if (role === null) break
				const task = stringField(event.payload, 'task')
				const details = pendingInquiryMessage ?? task
				pendingInquiryMessage = null
				const roleId = `role:${role}:${nextId('role:' + role)}`
				addParticipant(roleId, role, 'role')
				settlePreviousByDelegation(event.timestamp)
				// The source is the active frame's innermost open call, or the frame's root (the human for the main stack, the interrupt instance or human asker for an interrupt stack) when the stack is empty.
				recordCall(event, activeRoleParticipantId(), roleId, role, 'role', null, details)
				break
			}
			case 'interrupt': {
				// A preemption pushes a fresh stack: every subsequent event belongs to that stack until its root call closes (see role_finished), and the stack record is registered at the push so the model can show the fresh stack (and its root) before its first operation lands. An operator inquiry (trigger 'inquiry') roots its stack at a fresh human asker — instance-per-invocation, like the ask_human answerer — because the person asking is the stack's caller; any other trigger roots at a synthetic interrupt instance. Both draw the stack id from the shared interrupt counter so ids stay unique across triggers.
				const interruptNumber = nextId('interrupt')
				const stackId = `interrupt-${interruptNumber}-stack`
				const trigger = stringField(event.payload, 'trigger')
				if (trigger === 'inquiry') {
					const askerId = `human:asker:${nextId('asker')}`
					addParticipant(askerId, 'human', 'human')
					stackStack.push({ stackId, rootId: askerId, openCalls: [], lingeringReturn: null })
					stackRecords.push({ id: stackId, root: askerId })
					// The question stashes until the handler's role_start, whose call details show it rather than the generated briefing.
					pendingInquiryMessage = stringField(event.payload, 'message')
					break
				}
				pendingInquiryMessage = null
				const interruptId = `interrupt:${interruptNumber}`
				addParticipant(interruptId, 'interrupt', 'interrupt')
				stackStack.push({ stackId, rootId: interruptId, openCalls: [], lingeringReturn: null })
				stackRecords.push({ id: stackId, root: interruptId })
				break
			}
			case 'observe': {
				const role = stringField(event.payload, 'role')
				if (role === null) break
				const target = findOpenCallInPausedStack(role)
				if (target === null) break
				operations.push({
					id: opId(),
					kind: 'observe',
					stack: currentFrame().stackId,
					source: activeRoleParticipantId(),
					destination: target.record.destinationId,
					startedAt: event.timestamp,
					settledAt: event.timestamp,
					lifecycle: 'settled',
					outcome: null,
					details: stringField(event.payload, 'details'),
					metrics: null,
				})
				break
			}
			case 'terminate': {
				const role = stringField(event.payload, 'role')
				if (role === null) break
				const target = findOpenCallInPausedStack(role)
				if (target === null) break
				operations.push({
					id: opId(),
					kind: 'terminate',
					stack: currentFrame().stackId,
					source: activeRoleParticipantId(),
					destination: target.record.destinationId,
					startedAt: event.timestamp,
					settledAt: event.timestamp,
					lifecycle: 'settled',
					outcome: null,
					details: stringField(event.payload, 'details'),
					metrics: null,
				})
				// The terminate closes the targeted call immediately: it settles without a return operation and is removed from its (paused) stack's open chain, so the node is removed right away.
				target.record.returnTimestamp = event.timestamp
				const targetIndex = target.frame.openCalls.indexOf(target.record)
				if (targetIndex >= 0) target.frame.openCalls.splice(targetIndex, 1)
				break
			}
			case 'role_finished': {
				const role = stringField(event.payload, 'role')
				if (role === null) break
				const finishStatus = stringField(event.payload, 'status')
				const summary = stringField(event.payload, 'summary')
				let matchIndex = -1
				for (let i = currentFrame().openCalls.length - 1; i >= 0; i -= 1) {
					const candidate = currentFrame().openCalls[i]
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
				// A closed non-main stack resumes the stack it preempted: once its root call returns, the interrupt frame is done and popped. Its final return is not settled here — it lingers (the row keeps rendering the returner and its response leg) until the next activity-affecting operation confirms it, the same "keep the prior leg visible until the next action" rule the active stack's lingering returns follow.
				if (stackStack.length > 1 && currentFrame().openCalls.length === 0) {
					const closed = stackStack.pop()
					if (closed !== undefined && closed.lingeringReturn !== null) pendingResolvedReturns.push(closed.lingeringReturn)
				}
				break
			}
			case 'llm_call': {
				const role = stringField(event.payload, 'role')
				if (role === null) break
				const usage = usageOf(event.payload)
				// An llm_call from the caller settles a lingering return leg (the caller resumed).
				settleLingeringIfCaller(role, event.timestamp)
				if (usage === null) break
				// The call's metrics accumulate the callee's work: the innermost open call whose destination is the role that produced this llm_call.
				for (let i = currentFrame().openCalls.length - 1; i >= 0; i -= 1) {
					const candidate = currentFrame().openCalls[i]
					if (candidate === undefined) continue
					if (candidate.destinationRole === role) {
						candidate.tokens += usage.totalTokens
						candidate.cachedPromptTokens += usage.cachedPromptTokens
						break
					}
				}
				break
			}
			case 'llm_call_start': {
				const role = stringField(event.payload, 'role')
				if (role === null) break
				// llm_call_start settles the callee's call transit phase (the callee began working) but NOT the lingering return leg — the return settles only on the caller's llm_call completion, which keeps the return visible across the 1s product poll.
				// Settling the lingering return here would collapse the window between a tool_result and the caller's next dispatch to sub-second, making completed tool calls vanish from the flow view.
				for (let i = currentFrame().openCalls.length - 1; i >= 0; i -= 1) {
					const candidate = currentFrame().openCalls[i]
					if (candidate === undefined) continue
					if (candidate.destinationRole === role) {
						if (candidate.turnStartedAt === null) candidate.turnStartedAt = event.timestamp
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
				if (currentFrame().openCalls.length === 0) break
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
				for (let i = currentFrame().openCalls.length - 1; i >= 0; i -= 1) {
					const candidate = currentFrame().openCalls[i]
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
				if (currentFrame().openCalls.length === 0) break
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
				for (let i = currentFrame().openCalls.length - 1; i >= 0; i -= 1) {
					const candidate = currentFrame().openCalls[i]
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
		} else if (record.turnStartedAt !== null) {
			// The callee began its turn (llm_call_start) before delegating: that is the precise transit→working boundary.
			// When no llm_call_start was logged, delegatedAt carries the turn-level boundary instead, so pre-llm_call_start logs keep their existing behavior.
			op.settledAt = record.turnStartedAt
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
		// The per-invocation span runs to the matching return, or to `now` while the invocation is still open (the transit boundary marks the working phase, not the invocation's end).
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

	return { participants, operations, status, stacks: stackRecords }
}
