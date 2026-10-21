import type { LogEvent, RunMeta } from '../executor/types.js'
import { isObject } from '../executor/validation.js'
import type { RunSnapshot } from '../run-log/index.js'
import { isTerminalStatus } from './static/ts/interaction-model.js'
import type { InteractionModel, Operation, OperationOutcome, Participant, ParticipantKind, RunStatus, StackRecord } from './static/ts/interaction-model.js'

// The InteractionModel shape this adapter produces is the contract the browser view modules
// render. The canonical definition lives in `source/web/static/ts/interaction-model.ts` (the
// read helpers both views call) and `docs/visualization.md` "The model"; the types are imported
// from there so the server typechecks against the same contract the client consumes.

export type { InteractionModel }

// The unformatted detail material an operation carries, recorded during the walk and formatted only when a details request names the operation (deriveInteractionOperationDetail). Tool arguments/results can be multi-megabyte, so formatting them per poll for every operation would dominate the flow endpoint's cost; the raw source is a reference the poll never serializes.
type OperationDetailSource =
	| { kind: 'text'; text: string }
	| { kind: 'arguments'; arguments: string }
	| { kind: 'result'; result: unknown }

const ROOT_HUMAN_ID = 'human:root'
const MAIN_STACK = 'main'
// The agent/continue_agent/ask_human/finish tools are control-flow primitives, not work a node
// represents: agent and continue_agent are the delegation wrappers (the role_start/role_finished
// pair of the spawned instance is the call), ask_human is the question (the ask_human/human_answer
// events are the call), and finish ends the role (the role_finished return is the close). Their
// tool_call/tool_result events are skipped so a delegation does not also spawn a redundant tool node.
const CONTROL_TOOLS = new Set(['agent', 'continue_agent', 'ask_human', 'finish'])

// Narrowing helpers mirror the run-log derivation module so the adapter reads LogEvent payloads the same way the
// run view does — every external payload is validated before use, never cast.
function stringField(payload: unknown, field: string): string | null {
	if (!isObject(payload)) return null
	const value = payload[field]
	return typeof value === 'string' ? value : null
}

// An empty identity string is absent, matching the journal's own id checks.
function idField(payload: unknown, field: string): string | null {
	const value = stringField(payload, field)
	return value === null || value === '' ? null : value
}

// The full usage breakdown one usage-carrying event reports: the two reported counts plus their sum, and the cached-prompt subset (a subset of the prompt bill, not additive). A payload with neither a reported total nor a reportable prompt+completion pair has no usage; a present-but-partial usage object degrades its missing fields to 0 (endpoint-reported data), matching the run view's reader (source/run-log/payload.ts usageOf). cachedPromptTokens is null when the usage object does not report it — the backend omits the field when unreported, and that absence must survive the fold so a null is never replaced by a fabricated zero.
type UsageBreakdown = { promptTokens: number; completionTokens: number; totalTokens: number; cachedPromptTokens: number | null }

function usageOf(payload: unknown): UsageBreakdown | null {
	if (!isObject(payload)) return null
	const usage = payload['usage']
	if (!isObject(usage)) return null
	const total = usage['totalTokens']
	const prompt = usage['promptTokens']
	const completion = usage['completionTokens']
	const cached = usage['cachedPromptTokens']
	const promptTokens = typeof prompt === 'number' ? prompt : 0
	const completionTokens = typeof completion === 'number' ? completion : 0
	const hasPromptCompletion = typeof prompt === 'number' && typeof completion === 'number'
	if (typeof total !== 'number' && !hasPromptCompletion) return null
	const totalTokens = typeof total === 'number' ? total : promptTokens + completionTokens
	const cachedPromptTokens = typeof cached === 'number' ? cached : null
	return { promptTokens, completionTokens, totalTokens, cachedPromptTokens }
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
function formatArguments(raw: string): string {
	try {
		const parsed: unknown = JSON.parse(raw)
		return '```json\n' + JSON.stringify(parsed, null, 2) + '\n```'
	} catch {
		return '```\n' + raw + '\n```'
	}
}

function formatResultValue(result: unknown): string {
	try {
		return '```json\n' + JSON.stringify(result, null, 2) + '\n```'
	} catch {
		return '```\n' + String(result) + '\n```'
	}
}

function formatOperationDetail(source: OperationDetailSource): string {
	if (source.kind === 'arguments') return formatArguments(source.arguments)
	if (source.kind === 'result') return formatResultValue(source.result)
	return source.text
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
	// Precedes delegatedAt in the finalization below; null on logs that carry no llm_call_start events, where delegatedAt carries the turn-level boundary instead.
	turnStartedAt: string | null
	// Token counters start null — nothing has been reported for this invocation yet — and turn numeric with the first folded usage, so a tool call, an ask_human call, or an agent call whose endpoint answered without usage stays null instead of reading as a fabricated zero (the contract the model's OperationMetrics documents). cachedPromptTokens additionally stays null until a usage that reports it folds in. lastPromptTokens is the exception to the accumulate rule: each folded usage overwrites it with that turn's promptTokens, so it carries the invocation's current context window size (the executor's per-role lastPromptTokens), not a sum.
	tokens: number | null
	promptTokens: number | null
	completionTokens: number | null
	cachedPromptTokens: number | null
	lastPromptTokens: number | null
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

// The full walk over the run's events: the poll-path model (operations carry identities, lifecycle,
// and metrics — never detail bodies) plus the raw detail sources keyed by operation id, which only
// the on-demand detail path (deriveInteractionOperationDetail) formats and serializes.
interface DerivedModel {
	model: InteractionModel
	detailSources: Map<string, OperationDetailSource>
}

// Settles the recorded calls and returns and attaches the per-invocation metrics, so a terminal run freezes an open call at the run's stored end.
function finalizeModel(snapshot: RunSnapshot, status: RunStatus, participants: Participant[], operations: Operation[], detailSources: Map<string, OperationDetailSource>, stackRecords: StackRecord[], allCallRecords: OpenCallRecord[], allReturnRecords: ReturnRecord[]): DerivedModel {
	const runActive = status === 'running' || status === 'needs_clarification' || status === 'unknown'
	// The stored end of a terminal run: meta.endTime when present, else the last log event's timestamp. Read once here so neither the defensive settle nor the elapsed fallback consults the clock, keeping the payload a pure function of stored data.
	const lastLogEvent = snapshot.logEvents.length > 0 ? snapshot.logEvents[snapshot.logEvents.length - 1] : undefined
	const lastEventTimestamp = lastLogEvent === undefined ? null : lastLogEvent.timestamp
	const terminalTime = snapshot.meta?.endTime ?? lastEventTimestamp
	// Terminal is the client's own polling set (interaction-model.ts isTerminalStatus), the one app.ts reads to stop the per-run poll. Matching that set keeps the elapsed deterministic for exactly the runs whose client clock no longer advances the view; it includes needs_clarification, a run awaiting a human answer that is likewise not polled, so its open ask_human call must freeze too. runActive above deliberately stays as it is (needs_clarification still reads as in flight for lifecycle); only the elapsed is frozen here.
	const runTerminal = isTerminalStatus(status)

	for (const record of allCallRecords) {
		const op = record.operation
		if (record.returnTimestamp !== null) {
			op.settledAt = record.returnTimestamp
			op.lifecycle = 'settled'
		} else if (record.turnStartedAt !== null) {
			// The callee began its turn (llm_call_start) before delegating: that is the precise transit→working boundary.
			// When no llm_call_start was logged, delegatedAt carries the turn-level boundary instead.
			op.settledAt = record.turnStartedAt
			op.lifecycle = 'settled'
		} else if (record.delegatedAt !== null) {
			op.settledAt = record.delegatedAt
			op.lifecycle = 'settled'
		} else if (runActive) {
			op.settledAt = null
			op.lifecycle = 'in_flight'
		} else {
			// A terminal run should have no open calls; defensively settle one that does at the run's stored end, or — when meta carries none — at the last log event, never at the wall clock, so the payload stays a pure function of stored data.
			op.settledAt = terminalTime ?? op.startedAt
			op.lifecycle = 'settled'
		}
		// The per-invocation span runs to the matching return; a call with no return on a terminal run spans to the run's stored end (terminalTime, the same value the defensive settle records), while a call still open on a non-terminal run has no stored end, so its elapsed is null and the client fills it from its own clock (withLiveElapsed).
		const elapsed = record.returnTimestamp !== null
			? secondsBetween(op.startedAt, record.returnTimestamp)
			: runTerminal
				? secondsBetween(op.startedAt, terminalTime ?? op.startedAt)
				: null
		op.metrics = { tokens: record.tokens, promptTokens: record.promptTokens, completionTokens: record.completionTokens, cachedPromptTokens: record.cachedPromptTokens, lastPromptTokens: record.lastPromptTokens, elapsedSeconds: elapsed }
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

	return { model: { participants, operations, status, stacks: stackRecords }, detailSources }
}

function deriveModel(snapshot: RunSnapshot): DerivedModel {
	return deriveIdentityModel(snapshot)
}

// The identity-keyed graph: invocations are keyed by their callId, parent links come from parentCallId, and a terminal closes exactly the invocation it names. A start without a terminal stays open; a terminal without a start materializes a complete call+return pair at the terminal timestamp from the stack root, without guessing a parent. An invocation start missing its required callId, or a nested call missing its parentCallId, is malformed and skipped.
interface IdentityInvocation {
	callId: string
	record: OpenCallRecord | null
	stackId: string
	destinationId: string
	destinationRole: string
	destinationKind: ParticipantKind
	parentCallId: string | null
	questionId: string | null
	isInterrupt: boolean
}

function deriveIdentityModel(snapshot: RunSnapshot): DerivedModel {
	const status = runStatusOf(snapshot.meta)
	const rootParticipant: Participant = { id: ROOT_HUMAN_ID, role: 'human', kind: 'human' }
	const participants: Participant[] = [rootParticipant]
	const registry = new Map<string, Participant>([[ROOT_HUMAN_ID, rootParticipant]])
	const operations: Operation[] = []
	const detailSources = new Map<string, OperationDetailSource>()
	const allCallRecords: OpenCallRecord[] = []
	const allReturnRecords: ReturnRecord[] = []
	const pendingResolvedReturns: ReturnRecord[] = []
	const stackStack: StackFrame[] = [{ stackId: MAIN_STACK, rootId: ROOT_HUMAN_ID, openCalls: [], lingeringReturn: null }]
	const stackRecords: StackRecord[] = [{ id: MAIN_STACK, root: ROOT_HUMAN_ID }]
	const invocations = new Map<string, IdentityInvocation>()
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

	function addParticipant(id: string, role: string, kind: ParticipantKind, roleId?: string): void {
		if (registry.has(id)) return
		const participant: Participant = roleId === undefined ? { id, role, kind } : { id, role, kind, roleId }
		participants.push(participant)
		registry.set(id, participant)
	}

	function currentFrame(): StackFrame {
		const frame = stackStack[stackStack.length - 1]
		if (frame === undefined) throw new Error('interaction model invariant violated: the stack of stacks is empty')
		return frame
	}

	function frameByStack(stackId: string): StackFrame | null {
		for (const frame of stackStack) {
			if (frame.stackId === stackId) return frame
		}
		return null
	}

	function settleLingering(timestamp: string): void {
		const frame = currentFrame()
		if (frame.lingeringReturn === null) return
		frame.lingeringReturn.supersededAt = timestamp
		frame.lingeringReturn = null
	}

	function settleResolvedLingering(timestamp: string): void {
		for (const record of pendingResolvedReturns) record.supersededAt = timestamp
		pendingResolvedReturns.length = 0
	}

	function settleLingeringIfCaller(role: string, timestamp: string): void {
		const frame = currentFrame()
		if (frame.lingeringReturn === null) return
		if (frame.lingeringReturn.callerRole !== role) return
		frame.lingeringReturn.supersededAt = timestamp
		frame.lingeringReturn = null
	}

	function settlePreviousByDelegation(timestamp: string): void {
		const frame = currentFrame()
		const top = frame.openCalls[frame.openCalls.length - 1]
		if (top === undefined) return
		if (top.returnTimestamp === null && top.delegatedAt === null) top.delegatedAt = timestamp
	}

	function activeOpenRecord(): OpenCallRecord | null {
		const frame = currentFrame()
		return frame.openCalls[frame.openCalls.length - 1] ?? null
	}

	function sourceForParent(parentCallId: string | null): string {
		if (parentCallId !== null) {
			const parent = invocations.get(parentCallId)
			if (parent !== undefined) return parent.destinationId
			const participant = registry.get(parentCallId)
			if (participant !== undefined) return participant.id
		}
		return currentFrame().rootId
	}

	function createCallRecord(event: LogEvent, callId: string, parentCallId: string | null, source: string, destinationId: string, destinationRole: string, destinationKind: ParticipantKind, questionId: string | null, detailSource: OperationDetailSource | null): OpenCallRecord {
		const frame = currentFrame()
		const callOperation: Operation = {
			id: opId(),
			kind: 'call',
			callId,
			stack: frame.stackId,
			source,
			destination: destinationId,
			startedAt: event.timestamp,
			settledAt: null,
			lifecycle: 'in_flight',
			outcome: null,
			metrics: null,
		}
		if (parentCallId !== null) callOperation.parentCallId = parentCallId
		operations.push(callOperation)
		if (detailSource !== null) detailSources.set(callOperation.id, detailSource)
		const record: OpenCallRecord = {
			operation: callOperation,
			destinationId,
			destinationRole,
			destinationKind,
			questionId,
			returnTimestamp: null,
			delegatedAt: null,
			turnStartedAt: null,
			tokens: null,
			promptTokens: null,
			completionTokens: null,
			cachedPromptTokens: null,
			lastPromptTokens: null,
		}
		frame.openCalls.push(record)
		allCallRecords.push(record)
		return record
	}

	function registerInvocation(callId: string, record: OpenCallRecord | null, destinationId: string, destinationRole: string, destinationKind: ParticipantKind, parentCallId: string | null, questionId: string | null, isInterrupt: boolean): IdentityInvocation {
		const invocation: IdentityInvocation = { callId, record, stackId: currentFrame().stackId, destinationId, destinationRole, destinationKind, parentCallId, questionId, isInterrupt }
		invocations.set(callId, invocation)
		return invocation
	}

	function startCall(event: LogEvent, callId: string, parentCallId: string | null, source: string, destinationId: string, destinationRole: string, destinationKind: ParticipantKind, questionId: string | null, detailSource: OperationDetailSource | null): void {
		settleLingering(event.timestamp)
		settleResolvedLingering(event.timestamp)
		settlePreviousByDelegation(event.timestamp)
		const record = createCallRecord(event, callId, parentCallId, source, destinationId, destinationRole, destinationKind, questionId, detailSource)
		registerInvocation(callId, record, destinationId, destinationRole, destinationKind, parentCallId, questionId, false)
	}

	function popEmptyFrame(frame: StackFrame): void {
		if (frame.stackId === MAIN_STACK) return
		if (frame.openCalls.length !== 0) return
		if (currentFrame() !== frame) return
		const closed = stackStack.pop()
		if (closed !== undefined && closed.lingeringReturn !== null) pendingResolvedReturns.push(closed.lingeringReturn)
		removeEmptyStackRecord(frame.stackId)
	}

	function removeEmptyStackRecord(stackId: string): void {
		// A resolved stack that never recorded an operation (an interrupt whose handler was never started) has no resolved-stack content to show; leaving its record would make the view treat it as freshly preempted forever.
		if (operations.some((operation) => operation.stack === stackId)) return
		const recordIndex = stackRecords.findIndex((record) => record.id === stackId)
		if (recordIndex >= 0) stackRecords.splice(recordIndex, 1)
	}

	function recordReturnFor(record: OpenCallRecord, event: LogEvent, outcome: OperationOutcome, detailSource: OperationDetailSource | null): void {
		settleLingering(event.timestamp)
		settleResolvedLingering(event.timestamp)
		const frame = frameByStack(record.operation.stack) ?? currentFrame()
		const callerId = record.operation.source
		const callerParticipant = registry.get(callerId)
		const callerRole = callerParticipant === undefined ? null : callerParticipant.role
		const returnOperation: Operation = {
			id: opId(),
			kind: 'return',
			callId: record.operation.callId,
			stack: record.operation.stack,
			source: record.destinationId,
			destination: callerId,
			startedAt: event.timestamp,
			settledAt: null,
			lifecycle: 'in_flight',
			outcome,
			metrics: null,
		}
		operations.push(returnOperation)
		if (detailSource !== null) detailSources.set(returnOperation.id, detailSource)
		record.returnTimestamp = event.timestamp
		const returnRecord: ReturnRecord = { operation: returnOperation, callerRole, supersededAt: null }
		allReturnRecords.push(returnRecord)
		frame.lingeringReturn = returnRecord
	}

	function closeInvocation(invocation: IdentityInvocation, event: LogEvent, outcome: OperationOutcome, detailSource: OperationDetailSource | null): void {
		const record = invocation.record
		if (record === null) return
		// The first terminal wins: a duplicate terminal, or one arriving after a terminate closed the call, is ignored.
		if (record.returnTimestamp !== null) return
		recordReturnFor(record, event, outcome, detailSource)
		const frame = frameByStack(record.operation.stack)
		if (frame === null) return
		removeOpenRecord(frame, record)
		popEmptyFrame(frame)
	}

	function removeOpenRecord(frame: StackFrame, record: OpenCallRecord): void {
		const index = frame.openCalls.indexOf(record)
		if (index >= 0) frame.openCalls.splice(index, 1)
	}

	function findOpenInCurrentFrame(predicate: (record: OpenCallRecord) => boolean): OpenCallRecord | null {
		const frame = currentFrame()
		for (let index = frame.openCalls.length - 1; index >= 0; index -= 1) {
			const record = frame.openCalls[index]
			if (record === undefined) continue
			if (predicate(record)) return record
		}
		return null
	}

	function participantHasInstance(record: OpenCallRecord, roleId: string): boolean {
		const participant = registry.get(record.destinationId)
		return participant !== undefined && participant.roleId === roleId
	}

	// An observe names its target by instance id; nothing else identifies the observed invocation.
	function findObserveTargetInPausedStack(roleId: string | null): { frame: StackFrame; record: OpenCallRecord } | null {
		if (roleId === null) return null
		return findOpenCallInPausedStack((record) => participantHasInstance(record, roleId))
	}

	// A terminate may name its target by instance id, or by role name when the event carries no roleId.
	function findTerminateTargetInPausedStack(role: string, roleId: string | null): { frame: StackFrame; record: OpenCallRecord } | null {
		if (roleId !== null) return findOpenCallInPausedStack((record) => participantHasInstance(record, roleId))
		return findOpenCallInPausedStack((record) => record.destinationRole === role)
	}

	function findOpenCallInPausedStack(predicate: (record: OpenCallRecord) => boolean): { frame: StackFrame; record: OpenCallRecord } | null {
		for (let index = stackStack.length - 2; index >= 0; index -= 1) {
			const frame = stackStack[index]
			if (frame === undefined) continue
			for (let recordIndex = frame.openCalls.length - 1; recordIndex >= 0; recordIndex -= 1) {
				const record = frame.openCalls[recordIndex]
				if (record === undefined) continue
				if (predicate(record)) return { frame, record }
			}
		}
		return null
	}

	function materializeTerminal(event: LogEvent, callId: string, role: string, kind: ParticipantKind, outcome: OperationOutcome, detailSource: OperationDetailSource | null, questionId: string | null): void {
		const destinationId = kind === 'human' ? `human:answerer:terminal:${nextId('terminal-answerer')}` : callId
		addParticipant(destinationId, role, kind)
		const record = createCallRecord(event, callId, null, currentFrame().rootId, destinationId, role, kind, questionId, null)
		const invocation = registerInvocation(callId, record, destinationId, role, kind, null, questionId, false)
		closeInvocation(invocation, event, outcome, detailSource)
	}

	function findRoleRecord(roleId: string | null): OpenCallRecord | null {
		if (roleId === null) return null
		const invocation = invocations.get(`role:${roleId}`)
		if (invocation === undefined || invocation.record === null) return null
		// Usage belongs only to an invocation still open in the current frame; a closed role's late llm_call must not mutate its history.
		return findOpenInCurrentFrame((record) => record === invocation.record)
	}

	function foldUsage(record: OpenCallRecord, usage: UsageBreakdown): void {
		record.tokens = (record.tokens ?? 0) + usage.totalTokens
		record.promptTokens = (record.promptTokens ?? 0) + usage.promptTokens
		record.completionTokens = (record.completionTokens ?? 0) + usage.completionTokens
		record.lastPromptTokens = usage.promptTokens
		if (usage.cachedPromptTokens !== null) record.cachedPromptTokens = (record.cachedPromptTokens ?? 0) + usage.cachedPromptTokens
	}

	for (const event of snapshot.logEvents) {
		switch (event.type) {
			case 'role_start': {
				const role = stringField(event.payload, 'role')
				if (role === null) break
				const rawRoleId = idField(event.payload, 'roleId')
				if (rawRoleId === null) break
				const callId = idField(event.payload, 'callId')
				if (callId === null) break
				if (invocations.has(callId)) break
				const depthValue = isObject(event.payload) ? event.payload['depth'] : undefined
				const depth = typeof depthValue === 'number' && Number.isFinite(depthValue) ? depthValue : null
				const parentCallId = idField(event.payload, 'parentCallId')
				if (depth !== null && depth > 0 && parentCallId === null) break
				const task = stringField(event.payload, 'task')
				const detailText = pendingInquiryMessage ?? task
				pendingInquiryMessage = null
				addParticipant(callId, role, 'role', rawRoleId)
				startCall(event, callId, parentCallId, sourceForParent(parentCallId), callId, role, 'role', null, detailText === null ? null : { kind: 'text', text: detailText })
				break
			}
			case 'interrupt': {
				const callId = idField(event.payload, 'callId')
				const parentCallId = idField(event.payload, 'parentCallId')
				if (callId === null || parentCallId === null) break
				if (invocations.has(callId)) break
				const interruptNumber = nextId('interrupt')
				const stackId = `interrupt-${interruptNumber}-stack`
				const trigger = stringField(event.payload, 'trigger')
				let destinationId: string
				if (trigger === 'inquiry') {
					const askerId = `human:asker:${nextId('asker')}`
					addParticipant(askerId, 'human', 'human')
					destinationId = askerId
					pendingInquiryMessage = stringField(event.payload, 'message')
				} else {
					addParticipant(callId, 'interrupt', 'interrupt')
					destinationId = callId
					pendingInquiryMessage = null
				}
				stackStack.push({ stackId, rootId: destinationId, openCalls: [], lingeringReturn: null })
				stackRecords.push({ id: stackId, root: destinationId })
				// The interrupt invocation is represented by the fresh stack root; the handler's role_start is its child. No call operation is emitted here, matching the visual contract that the handler call is the row's first edge.
				registerInvocation(callId, null, destinationId, trigger === 'inquiry' ? 'human' : 'interrupt', trigger === 'inquiry' ? 'human' : 'interrupt', parentCallId, null, true)
				break
			}
			case 'interrupt_resolved': {
				const callId = idField(event.payload, 'callId')
				if (callId === null) break
				const invocation = invocations.get(callId)
				if (invocation === undefined || !invocation.isInterrupt) break
				const frame = frameByStack(invocation.stackId)
				invocation.isInterrupt = false
				if (frame !== null) {
					if (currentFrame() === frame) popEmptyFrame(frame)
					else removeEmptyStackRecord(frame.stackId)
				}
				break
			}
			case 'observe': {
				const roleId = idField(event.payload, 'roleId')
				const target = findObserveTargetInPausedStack(roleId)
				if (target === null) break
				const active = activeOpenRecord()
				const observeDetails = stringField(event.payload, 'details')
				const operationId = opId()
				const observeOperation: Operation = {
					id: operationId,
					kind: 'observe',
					callId: operationId,
					stack: currentFrame().stackId,
					source: active === null ? currentFrame().rootId : active.destinationId,
					destination: target.record.destinationId,
					startedAt: event.timestamp,
					settledAt: event.timestamp,
					lifecycle: 'settled',
					outcome: null,
					metrics: null,
				}
				operations.push(observeOperation)
				if (observeDetails !== null) detailSources.set(observeOperation.id, { kind: 'text', text: observeDetails })
				break
			}
			case 'terminate': {
				const role = stringField(event.payload, 'role')
				if (role === null) break
				const roleId = idField(event.payload, 'roleId')
				const target = findTerminateTargetInPausedStack(role, roleId)
				if (target === null) break
				const active = activeOpenRecord()
				const terminateDetails = stringField(event.payload, 'details')
				const operationId = opId()
				const terminateOperation: Operation = {
					id: operationId,
					kind: 'terminate',
					callId: operationId,
					stack: currentFrame().stackId,
					source: active === null ? currentFrame().rootId : active.destinationId,
					destination: target.record.destinationId,
					startedAt: event.timestamp,
					settledAt: event.timestamp,
					lifecycle: 'settled',
					outcome: null,
					metrics: null,
				}
				operations.push(terminateOperation)
				if (terminateDetails !== null) detailSources.set(terminateOperation.id, { kind: 'text', text: terminateDetails })
				target.record.returnTimestamp = event.timestamp
				removeOpenRecord(target.frame, target.record)
				break
			}
			case 'role_finished': {
				const role = stringField(event.payload, 'role')
				if (role === null) break
				// A paused finish (parked ask or direct clarification) is a pause marker, not the role invocation's terminal.
				if (isObject(event.payload) && event.payload['paused'] === true) break
				const finishStatus = stringField(event.payload, 'status')
				const summary = stringField(event.payload, 'summary')
				const outcome: OperationOutcome = finishStatus === 'error' ? 'error' : 'success'
				const detailSource = summary === null ? null : { kind: 'text' as const, text: summary }
				const callId = idField(event.payload, 'callId')
				if (callId === null) break
				const invocation = invocations.get(callId)
				if (invocation !== undefined) {
					closeInvocation(invocation, event, outcome, detailSource)
					break
				}
				materializeTerminal(event, callId, role, 'role', outcome, detailSource, null)
				break
			}
			case 'llm_call': {
				const role = stringField(event.payload, 'role')
				if (role === null) break
				settleLingeringIfCaller(role, event.timestamp)
				const usage = usageOf(event.payload)
				if (usage === null) break
				const record = findRoleRecord(stringField(event.payload, 'roleId'))
				if (record !== null) foldUsage(record, usage)
				break
			}
			case 'llm_retry': {
				const role = stringField(event.payload, 'role')
				if (role === null) break
				const usage = usageOf(event.payload)
				if (usage === null) break
				const record = findRoleRecord(stringField(event.payload, 'roleId'))
				if (record !== null) foldUsage(record, usage)
				break
			}
			case 'summarizer_llm_call':
				break
			case 'llm_call_start': {
				const role = stringField(event.payload, 'role')
				if (role === null) break
				const record = findRoleRecord(stringField(event.payload, 'roleId'))
				if (record !== null && record.turnStartedAt === null) record.turnStartedAt = event.timestamp
				break
			}
			case 'tool_call': {
				const role = stringField(event.payload, 'role')
				const tool = stringField(event.payload, 'tool')
				if (role === null || tool === null) break
				if (CONTROL_TOOLS.has(tool)) break
				const callId = idField(event.payload, 'callId')
				const parentCallId = idField(event.payload, 'parentCallId')
				if (callId === null || parentCallId === null) break
				if (invocations.has(callId)) break
				if (currentFrame().openCalls.length === 0) break
				addParticipant(callId, tool, 'tool')
				const argumentsValue = stringField(event.payload, 'arguments')
				startCall(event, callId, parentCallId, sourceForParent(parentCallId), callId, tool, 'tool', null, argumentsValue === null ? null : { kind: 'arguments', arguments: argumentsValue })
				break
			}
			case 'tool_result': {
				const role = stringField(event.payload, 'role')
				const tool = stringField(event.payload, 'tool')
				if (role === null || tool === null) break
				if (CONTROL_TOOLS.has(tool)) break
				const kind = stringField(event.payload, 'kind')
				const outcome: OperationOutcome = kind === 'success' ? 'success' : 'error'
				const resultValue = isObject(event.payload) ? event.payload['result'] : undefined
				const detailSource = resultValue === null || resultValue === undefined ? null : { kind: 'result' as const, result: resultValue }
				const callId = idField(event.payload, 'callId')
				if (callId === null) break
				const invocation = invocations.get(callId)
				if (invocation !== undefined) {
					closeInvocation(invocation, event, outcome, detailSource)
					break
				}
				materializeTerminal(event, callId, tool, 'tool', outcome, detailSource, null)
				break
			}
			case 'ask_human': {
				const id = stringField(event.payload, 'id')
				const question = stringField(event.payload, 'question')
				if (id === null || question === null) break
				if (currentFrame().openCalls.length === 0) break
				const callId = idField(event.payload, 'callId')
				const parentCallId = idField(event.payload, 'parentCallId')
				if (callId === null || parentCallId === null) break
				if (invocations.has(callId)) break
				const context = stringField(event.payload, 'context')
				const answererId = `human:answerer:${nextId('answerer')}`
				addParticipant(answererId, 'human', 'human')
				const detailText = context === null ? question : `${question}\n\n*Context: ${context}*`
				startCall(event, callId, parentCallId, sourceForParent(parentCallId), answererId, 'human', 'human', id, { kind: 'text', text: detailText })
				break
			}
			case 'human_answer': {
				const id = stringField(event.payload, 'id')
				const answer = stringField(event.payload, 'answer')
				if (id === null || answer === null) break
				const callId = idField(event.payload, 'callId')
				if (callId === null) break
				const invocation = invocations.get(callId)
				if (invocation !== undefined) {
					closeInvocation(invocation, event, 'success', { kind: 'text', text: answer })
					break
				}
				materializeTerminal(event, callId, 'human', 'human', 'success', { kind: 'text', text: answer }, id)
				break
			}
			default:
				break
		}
	}

	return finalizeModel(snapshot, status, participants, operations, detailSources, stackRecords, allCallRecords, allReturnRecords)
}

export function deriveInteractionModel(snapshot: RunSnapshot): InteractionModel {
	return deriveModel(snapshot).model
}

export interface InteractionOperationDetail {
	operationId: string
	details: string | null
}

// Resolves one operation's details markdown on demand: the walk is re-run (the same O(N) derive the
// flow endpoint performs) but only the named operation's detail source is formatted, so the response
// carries one string instead of every operation's bodies. Returns null when the id names no
// operation in the model — a stale id from a frame the poll has since replaced — which the endpoint
// surfaces as a 404; an operation that exists but carries no detail material resolves to
// `details: null`.
export function deriveInteractionOperationDetail(snapshot: RunSnapshot, operationId: string): InteractionOperationDetail | null {
	const { model, detailSources } = deriveModel(snapshot)
	const operation = model.operations.find((candidate) => candidate.id === operationId)
	if (operation === undefined) return null
	const source = detailSources.get(operationId)
	return { operationId, details: source === undefined ? null : formatOperationDetail(source) }
}
