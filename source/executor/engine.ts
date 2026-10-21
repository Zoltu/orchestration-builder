import { createResultCard, createToolError, isErrorKind } from './errors.js'
import type { DiscardedRetrySpend, LlmUsage, LlmUsagePayload, LogEvent, Message, ResultCard, RoleDefinition, ToolCall, ToolManifest, ToolResult } from './types.js'
import { isObject, isResultCard, safeJsonParse } from './validation.js'
import { checkGlobalBudgets, checkRoleBudgets } from './budgets.js'
import { buildInitialHistory, createContextManager, DEFAULT_PROTECTED_PREFIX_LENGTH, truncateToolOutput, type ContextManager } from './context/index.js'
import { logEvent, type EngineContext, type EngineDependencies, type ResumedRole, type RoleState, type SeededRole, type SuspendedTurn } from './engine-state.js'
import { isWriteCapableRole, parkCard, type ParkedAnswer } from './park-state.js'
import { drainInterrupts } from './interrupt-engine.js'
import type { LlmCallResult } from './llm.js'
import { humanAnswerPayload, roleCallId, type ToolInvocation } from './invocation.js'
import { hashArguments, RECENT_TOOL_CALLS_LIMIT } from './role-inspection.js'
import type { RoleRegistryEntry } from './role-registry.js'
import { buildContinuationHistory, selectContinuableChild } from './role-snapshot.js'
import type { RunToolScope, ToolPlatform } from './tool-platform-port.js'
import { parseFinishArguments } from './tools/builtin-tools.js'
import type { PendingInvocation } from './checkpoint.js'

interface DispatchContext {
	toolPlatform: ToolPlatform
	roleDefinition: RoleDefinition
	scope: RunToolScope
	maxToolOutputChars: number
}

type LlmResultHandling =
	| { kind: 'continue' }
	| { kind: 'finished'; card: ResultCard }
	| { kind: 'tool_calls'; toolCalls: ToolCall[] }

type SuccessfulLlmCall = Extract<LlmCallResult, { kind: 'success' }>

// Recovers the card a fully answered finish turn already carries, so a boot or completed-checkpoint resume returns it instead of asking the LLM to repeat a decision that is already durable. The finish need not be the last call: every call in the last assistant tool-call message must have a consecutive tool result, with nothing after the results (a user note means the turn has moved on).
function completedFinishCard(history: readonly Message[]): ResultCard | null {
	let assistantIndex = -1
	for (let index = history.length - 1; index >= 0; index--) {
		const message = history[index]
		if (message === undefined || message.role !== 'assistant' || message.tool_calls === undefined || message.tool_calls.length === 0) continue
		assistantIndex = index
		break
	}
	if (assistantIndex === -1) return null
	const assistantMessage = history[assistantIndex]
	if (assistantMessage === undefined || assistantMessage.tool_calls === undefined) return null
	const results = new Map<string, Message>()
	let index = assistantIndex + 1
	while (index < history.length) {
		const message = history[index]
		if (message === undefined || message.role !== 'tool' || message.tool_call_id === undefined) break
		results.set(message.tool_call_id, message)
		index++
	}
	// Anything after the results means the turn is no longer the history's completed tail.
	if (index !== history.length) return null
	for (const call of assistantMessage.tool_calls) {
		if (!results.has(call.id)) return null
	}
	const finishCalls = assistantMessage.tool_calls.filter((call) => call.function.name === 'finish')
	for (const finishCall of finishCalls) {
		const finishMessage = results.get(finishCall.id)
		if (finishMessage === undefined) continue
		const parsed = safeJsonParse(finishMessage.content)
		if (!parsed.ok) throw new Error('resume: a completed finish turn has an unparseable tool result')
		if (isResultCard(parsed.value)) return parsed.value
		// A rejected finish (invalid arguments, unknown tool, ...) is ordinary non-terminal history; keep scanning the batch's other finish calls.
		if (isToolResultValue(parsed.value)) continue
		throw new Error('resume: a finish tool result is neither a ResultCard nor a ToolResult')
	}
	return null
}

function serializeToolResult(result: ToolResult, maxChars: number): string {
	let text: string
	if (result.kind === 'success') {
		text = JSON.stringify(result.data ?? null)
	} else {
		text = JSON.stringify({ kind: result.kind, message: result.message, details: result.details })
	}
	return truncateToolOutput(text, maxChars).text
}

// Shapes a sent message for the llm_call payload: role and content only, plus tool_calls on assistant messages so the message list reflects the full prior turn.
// Sent-side reasoning is omitted to bound log volume (the received side still carries it), so the `full`-level log under-records replayed reasoning items and cannot reconstruct the wire payload byte-for-byte.
function shapeSentMessage(message: Message): { role: string; content: string; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> } {
	const shaped: { role: string; content: string; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> } = {
		role: message.role,
		content: message.content,
	}
	if (message.tool_calls !== undefined && message.tool_calls.length > 0) {
		shaped.tool_calls = message.tool_calls.map((call) => ({
			id: call.id,
			type: call.type,
			function: { name: call.function.name, arguments: call.function.arguments },
		}))
	}
	return shaped
}

// Shapes the assistant response actually received so a reviewer can reconstruct what the model returned: content, reasoning (if any), and the parsed tool calls (each call's id, function.name, and function.arguments — the exact parameters recoverable).
function shapeAssistantResponse(llmResult: { content?: string; reasoning?: string | null; toolCalls: ToolCall[] }): { content?: string; reasoning?: string | null; toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> } {
	const shaped: { content?: string; reasoning?: string | null; toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> } = {
		toolCalls: llmResult.toolCalls.map((call) => ({
			id: call.id,
			function: { name: call.function.name, arguments: call.function.arguments },
		})),
	}
	if (llmResult.content !== undefined) shaped.content = llmResult.content
	if (llmResult.reasoning !== undefined) shaped.reasoning = llmResult.reasoning
	return shaped
}

// Builds the log-event usage shape shared by every usage-carrying event (llm_call, llm_retry, and the service's summarizer_llm_call), so the three payloads stay byte-identical for the same usage: the two reported counts plus their sum, with the cached subset carried only when the endpoint reported it. Exported because the summarizer's wiring in serve.ts appends its usage event through the executor's public surface.
export function llmUsagePayload(usage: LlmUsage): LlmUsagePayload {
	const payload: LlmUsagePayload = {
		promptTokens: usage.promptTokens,
		completionTokens: usage.completionTokens,
		totalTokens: usage.promptTokens + usage.completionTokens,
	}
	if (usage.cachedPromptTokens !== undefined) payload.cachedPromptTokens = usage.cachedPromptTokens
	return payload
}

// Builds the llm_call payload for a successful turn, carrying the sent message slice, the received assistant response, the finishReason, and the per-call usage in one event so a reviewer can reconstruct the full turn from the log.
// sentMessages is the slice of the role's conversation this request added: sentFrom is the slice's conversation index and messageCount the request's total size, so a full snapshot is sentFrom 0 with sent.length === messageCount. Logging only the slice keeps the log's growth O(turns) instead of O(turns²); docs/reference.md "Log events" documents the protocol and the fold that reconstructs a full conversation from the deltas.
// roleId is the instance id role_start already carries: a role may spawn a same-named child (the depth guard is the only limit), so identity in the log is the instance, not the name — the fold matches on it.
// promptTokens is the full prompt bill (cached + uncached); cachedPromptTokens is the subset the endpoint served from its prompt cache, so the uncached prompt bill is promptTokens - cachedPromptTokens. The two are tracked separately because they are billed at different rates.
// A successful call the endpoint answered without a usage report logs no usage field at all: absence means "the endpoint reported nothing" and must stay distinguishable from a reported zero for the log's readers.
function llmCallPayload(roleName: string, roleId: string, sentMessages: Message[], sentFrom: number, messageCount: number, llmResult: SuccessfulLlmCall): unknown {
	const payload: Record<string, unknown> = {
		role: roleName,
		roleId,
		messageCount,
		sentFrom,
		sent: sentMessages.map(shapeSentMessage),
		received: shapeAssistantResponse(llmResult),
	}
	if (llmResult.finishReason !== undefined) payload['finishReason'] = llmResult.finishReason
	if (llmResult.usage !== undefined) payload['usage'] = llmUsagePayload(llmResult.usage)
	return payload
}

// Builds the llm_retry payload: the spend of the discarded retry attempts behind one successful call (docs/reference.md "Log events"). The usage shape is the shared llmUsagePayload so the retry spend reads exactly like an llm_call's, and the usage key is omitted entirely when none of the discarded attempts reported usage — never a fabricated zero.
function llmRetryPayload(roleName: string, roleId: string, discardedRetrySpend: DiscardedRetrySpend): unknown {
	const payload: Record<string, unknown> = {
		role: roleName,
		roleId,
		discardedAttempts: discardedRetrySpend.attempts,
	}
	if (discardedRetrySpend.usage !== undefined) payload['usage'] = llmUsagePayload(discardedRetrySpend.usage)
	return payload
}

function handleLlmResult(
	llmResult: LlmCallResult,
	roleState: RoleState,
	deps: EngineDependencies,
	context: EngineContext,
	contextManager: ContextManager,
): LlmResultHandling {
	const config = context.loadedGuild.deployment.executor
	if (llmResult.kind === 'llm_unavailable') {
		logEvent(deps.appendLog, 'llm_unavailable', { role: context.roleName, message: llmResult.message })
		return {
			kind: 'finished',
			card: createResultCard('error', `LLM unavailable: ${llmResult.message}`, {
				error: createToolError('llm_unavailable', llmResult.message),
				...(llmResult.detail !== undefined ? { detail: llmResult.detail } : {}),
			}),
		}
	}

	if (llmResult.kind === 'context_budget_exceeded') {
		const decision = contextManager.observeRejection(roleState, llmResult)
		if (decision.kind === 'finished') return { kind: 'finished', card: decision.card }
		return { kind: 'continue' }
	}

	// A success the endpoint answered without a usage report updates no accumulator: lastPromptTokens keeps reflecting the last reported conversation size (an absent report must not be able to masquerade as a zero-token conversation in the pressure check or context_info), no tokens are added to the generated total, and the pressure check is skipped — it reads real reported usage only. A reported zero is endpoint data and is recorded as one.
	// The proactive pressure check reads real reported usage only, and fires once per role instance: the flag moves pending → sent and never re-arms, so a role that keeps working after the notice is not re-noticed on every subsequent turn.
	contextManager.observeSuccess(roleState, llmResult.usage)

	const postCallBudgetError = checkRoleBudgets(roleState.recentCompactionPromptTokens, config)
	if (postCallBudgetError !== null) {
		logEvent(deps.appendLog, 'role_budget_exceeded', { role: context.roleName, phase: 'post_llm', error: postCallBudgetError })
		return {
			kind: 'finished',
			card: createResultCard('error', 'Role budget exceeded', { error: postCallBudgetError }),
		}
	}

	roleState.history.push({
		role: 'assistant',
		content: llmResult.content ?? '',
		...(llmResult.reasoning !== undefined ? { reasoning: llmResult.reasoning } : {}),
		...(llmResult.toolCalls.length > 0 ? { tool_calls: llmResult.toolCalls } : {}),
	})

	if (llmResult.toolCalls.length === 0) {
		const summary = llmResult.content ?? ''
		logEvent(deps.appendLog, 'implicit_finish', { role: context.roleName, summary })
		return {
			kind: 'finished',
			card: createResultCard('success', summary),
		}
	}

	return { kind: 'tool_calls', toolCalls: llmResult.toolCalls }
}

// Emits the observe event for a successful cross-role inspection, so the interaction model can draw the reference from the inspecting role to the suspended target it read. Self-inspection (targetRole absent or the caller's own id) is not an observation, and a target that is no longer registered cannot be drawn, so both are skipped.
function maybeLogObservation(deps: EngineDependencies, toolPlatform: ToolPlatform, ownRoleId: string, toolName: string, result: ToolResult): void {
	if (result.kind !== 'success') return
	if (!toolPlatform.observesRole(toolName)) return
	if (!isObject(result.data)) return
	const targetRole = result.data['targetRole']
	if (typeof targetRole !== 'string') return
	if (targetRole === ownRoleId) return
	const target = deps.roleRegistry.lookup(targetRole)
	if (target === undefined) return
	logEvent(deps.appendLog, 'observe', { role: target.roleName, roleId: targetRole, details: toolName })
}

function isToolResultValue(value: unknown): value is ToolResult {
	if (!isObject(value)) return false
	if (value['kind'] === 'success') return true
	return isErrorKind(value['kind'])
}

function payloadRecord(event: LogEvent): Record<string, unknown> | undefined {
	return isObject(event.payload) ? event.payload : undefined
}

function findTerminalEvent(events: readonly LogEvent[], type: string, callId: string): LogEvent | undefined {
	for (const event of events) {
		if (event.type !== type) continue
		const payload = payloadRecord(event)
		if (payload !== undefined && payload['callId'] === callId) return event
	}
	return undefined
}

// A standard-level log drops a tool_result's body but keeps its kind and identity, so a resumed call whose terminal is already durable is restored with a clearly marked placeholder. A finish result is reconstructed from the call's own arguments, because losing that card would turn a completed role into a placeholder success. Any other terminal with neither a body nor a valid kind is corrupt, not a success, so it fails fast rather than inventing an outcome.
function replayToolResult(event: LogEvent, toolCall: ToolCall): ToolResult {
	const payload = payloadRecord(event)
	const rawResult = payload?.['result']
	if (isToolResultValue(rawResult)) return rawResult
	const message = 'The tool result body was not retained at standard logging; the invocation completed before the restart.'
	const kind = payload?.['kind']
	if (toolCall.function.name === 'finish') {
		// The standard level keeps the kind but drops the body. A failed finish must stay a failure placeholder; only a successful finish is reconstructed from its arguments.
		if (kind === 'success') {
			const parsedArguments = safeJsonParse(toolCall.function.arguments)
			if (!parsedArguments.ok || !isObject(parsedArguments.value)) throw new Error(`resume: finish call ${toolCall.id} has unparseable arguments`)
			const parsedCard = parseFinishArguments(parsedArguments.value)
			if (parsedCard.kind === 'error') throw new Error(`resume: finish call ${toolCall.id} cannot be recovered: ${parsedCard.message}`)
			return { kind: 'success', data: parsedCard.card }
		}
		if (isErrorKind(kind)) return { kind, message }
		throw new Error(`resume: finish tool_result ${String(payload?.['callId'])} carries neither a result body nor a valid kind`)
	}
	if (kind === 'success') return { kind: 'success', data: { note: message } }
	if (isErrorKind(kind)) return { kind, message }
	throw new Error(`resume: tool_result ${String(payload?.['callId'])} carries neither a result body nor a valid kind`)
}

function questionFromToolCall(toolCall: ToolCall): string {
	const parsed = safeJsonParse(toolCall.function.arguments)
	if (!parsed.ok || !isObject(parsed.value)) return ''
	const question = parsed.value['question']
	return typeof question === 'string' ? question : ''
}

function replayAskResult(event: LogEvent, toolCall: ToolCall): ToolResult {
	const payload = payloadRecord(event)
	const answer = payload?.['answer']
	if (typeof answer !== 'string') throw new Error(`resume: human_answer ${String(payload?.['callId'])} carries no answer`)
	const question = typeof payload?.['question'] === 'string' ? payload['question'] : questionFromToolCall(toolCall)
	return { kind: 'success', data: { question, answer } }
}

function isParkedAskResult(result: ToolResult): boolean {
	if (result.kind !== 'success' || !isObject(result.data)) return false
	return result.data['parked'] === true
}

// Reconciles the invocation a checkpoint caught mid-dispatch. If its terminal is already in the log, the result is appended to the restored history without re-dispatching or rewriting the terminal; otherwise the call is replayed under the recorded id. A pending ask follows the same rule with human_answer as its terminal, re-asking when no answer was durable.
async function reconcilePendingInvocation(deps: EngineDependencies, context: EngineContext, roleState: RoleState, registryEntry: RoleRegistryEntry, dispatchCtx: DispatchContext, pending: PendingInvocation, resumeNote: string | undefined): Promise<ResultCard | null> {
	const index = pending.index
	const toolCall = pending.toolCalls[index]
	if (toolCall === undefined) throw new Error(`resume: pending invocation index ${index} is out of range in a validated checkpoint`)
	const invocation = deps.invocationJournal.adoptToolCall(toolCall, pending.callId, pending.parentCallId)
	const callId = pending.callId
	const isAsk = toolCall.function.name === 'ask_human'
	const events = deps.readRunLogEvents(deps.runId)
	const terminal = isAsk
		? findTerminalEvent(events, 'human_answer', callId)
		: findTerminalEvent(events, 'tool_result', callId)

	let finalCard: ResultCard | null = null
	if (terminal !== undefined) {
		const result = isAsk ? replayAskResult(terminal, toolCall) : replayToolResult(terminal, toolCall)
		finalCard = recordToolResult(deps, dispatchCtx.toolPlatform, roleState, context.roleName, registryEntry.roleId, dispatchCtx.maxToolOutputChars, toolCall, result, { invocation, replayed: true })
	} else {
		if (!isAsk) deps.invocationJournal.toolStarted(invocation, context.roleName)
		const result = await dispatchCtx.toolPlatform.dispatch(dispatchCtx.roleDefinition, dispatchCtx.scope, toolCall, invocation)
		if (isAsk) {
			if (result.kind === 'success') {
				deps.invocationJournal.markStarted(callId)
				if (!isParkedAskResult(result)) deps.invocationJournal.markTerminal(callId)
			} else if (!deps.invocationJournal.hasStarted(callId)) {
				deps.invocationJournal.toolStarted(invocation, context.roleName)
				deps.invocationJournal.toolFinished(invocation, context.roleName, result)
			} else {
				// A started ask that fails without parking (e.g. the handler rejects the replayed arguments) still needs exactly one terminal.
				deps.invocationJournal.toolFinished(invocation, context.roleName, result)
			}
		}
		finalCard = recordToolResult(deps, dispatchCtx.toolPlatform, roleState, context.roleName, registryEntry.roleId, dispatchCtx.maxToolOutputChars, toolCall, result, { invocation })
	}

	const hasRemainingCalls = index + 1 < pending.toolCalls.length
	if (finalCard !== null) {
		deps.checkpointRecorder.setPending(registryEntry.roleId, undefined)
		// The replay must leave a fully answered turn on disk, even when no note is being delivered; otherwise a later resume sees the finish and later calls unanswered.
		if (hasRemainingCalls) closeUnexecutedCalls(deps, roleState, context, registryEntry, dispatchCtx, pending.toolCalls, index + 1)
		deps.checkpointRecorder.write()
		if (resumeNote === undefined) return finalCard
		// A resume delivering an answer or operator note must proceed to a fresh LLM turn, not return the old card.
		roleState.history.push({ role: 'user', content: resumeNote })
		return null
	}

	if (!hasRemainingCalls) deps.checkpointRecorder.write()
	const remainingCard = hasRemainingCalls
		? await dispatchToolCallSequence(deps, context, roleState, registryEntry, dispatchCtx, pending.toolCalls, index + 1)
		: null
	// The note lands only after every remaining result, never between an assistant tool_calls message and its tool results. A remaining final card that is a completed finish still leaves a closed turn, so the note can follow it; any other early terminal is skipped.
	if (resumeNote !== undefined && (remainingCard === null || completedFinishCard(roleState.history) !== null)) roleState.history.push({ role: 'user', content: resumeNote })
	return remainingCard
}

interface RecordToolResultOptions {
	invocation?: ToolInvocation
	// True when replaying a terminal already present in the log: bookkeeping is applied, but no event is written a second time.
	replayed?: boolean
}

// Records a settled tool call: writes its lifecycle event, appends the (truncated) tool message, and updates the counters. The live path passes the journal invocation so only the terminal is written here (the start was already journaled before dispatch); a replayed resume passes replayed so the terminal stays exactly once. ask_human is skipped here because its ask_human/human_answer pair is its lifecycle.
function recordToolResult(deps: EngineDependencies, toolPlatform: ToolPlatform, roleState: RoleState, roleName: string, ownRoleId: string, maxToolOutputChars: number, toolCall: ToolCall, result: ToolResult, options: RecordToolResultOptions): ResultCard | null {
	if (options.replayed !== true) {
		const diagnostic = result.kind === 'unknown_tool' || result.kind === 'invalid_tool_call'
		if (result.kind === 'unknown_tool') {
			logEvent(deps.appendLog, 'unknown_tool', { role: roleName, tool: toolCall.function.name })
		} else if (result.kind === 'invalid_tool_call') {
			logEvent(deps.appendLog, 'invalid_tool_call', { role: roleName, tool: toolCall.function.name })
		} else if (toolCall.function.name === 'ask_human') {
			// The ask handler/backend already wrote ask_human and human_answer with the invocation ids; a generic tool pair here would give the ask two competing lifecycles.
		} else if (options.invocation === undefined) {
			throw new Error(`recordToolResult: no invocation for tool result "${toolCall.function.name}"`)
		} else {
			maybeLogObservation(deps, toolPlatform, ownRoleId, toolCall.function.name, result)
			deps.invocationJournal.toolFinished(options.invocation, roleName, result)
		}
		// A resumed pending call can fail validation (its tool left the Guild) after its start was already written; close that started invocation even though the failure is diagnostic-only for a fresh dispatch.
		if (diagnostic && options.invocation !== undefined && deps.invocationJournal.hasStarted(options.invocation.callId)) {
			deps.invocationJournal.toolFinished(options.invocation, roleName, result)
		}
	}

	appendToolMessage(roleState, toolCall, result, maxToolOutputChars)

	if (toolCall.function.name === 'finish' && result.kind === 'success' && isResultCard(result.data)) {
		return result.data
	}
	return null
}

function appendToolMessage(roleState: RoleState, toolCall: ToolCall, result: ToolResult, maxToolOutputChars: number): void {
	roleState.history.push({
		role: 'tool',
		content: serializeToolResult(result, maxToolOutputChars),
		tool_call_id: toolCall.id,
	})
	roleState.toolCallCount += 1
	roleState.recentToolCalls.push({ tool: toolCall.function.name, argsHash: hashArguments(toolCall.function.arguments), resultKind: result.kind })
	if (roleState.recentToolCalls.length > RECENT_TOOL_CALLS_LIMIT) roleState.recentToolCalls.shift()
}

// Closes calls an earlier final card prevented from running. Each gets its own interrupted lifecycle and tool message so the assistant turn is fully answered before the completed checkpoint is written.
function closeUnexecutedCalls(deps: EngineDependencies, roleState: RoleState, context: EngineContext, registryEntry: RoleRegistryEntry, dispatchCtx: DispatchContext, toolCalls: ToolCall[], startIndex: number): void {
	const message = 'Not executed because an earlier call in the batch ended the role.'
	const result: ToolResult = { kind: 'interrupted', message }
	const interruptedContent = serializeToolResult(result, dispatchCtx.maxToolOutputChars)
	// Reconciliation can retry after a crash that already appended some forced results. Count existing interrupted messages by id+content, not just id: two later calls may legitimately reuse one model id and each still needs its own lifecycle.
	const existing = new Map<string, number>()
	for (const historyMessage of roleState.history) {
		if (historyMessage.role !== 'tool' || historyMessage.tool_call_id === undefined) continue
		const key = `${historyMessage.tool_call_id}\u0000${historyMessage.content}`
		existing.set(key, (existing.get(key) ?? 0) + 1)
	}
	for (let index = startIndex; index < toolCalls.length; index++) {
		const toolCall = toolCalls[index]
		if (toolCall === undefined) continue
		const key = `${toolCall.id}\u0000${interruptedContent}`
		const remaining = existing.get(key) ?? 0
		if (remaining > 0) {
			existing.set(key, remaining - 1)
			continue
		}
		const invocation = deps.invocationJournal.allocateToolCall(toolCall, registryEntry.roleId)
		deps.invocationJournal.toolStarted(invocation, context.roleName)
		deps.invocationJournal.toolFinished(invocation, context.roleName, result)
		appendToolMessage(roleState, toolCall, result, dispatchCtx.maxToolOutputChars)
	}
}

// Freezes the checkpoint at the park moment, before the mark unwinds the role: the ask's tool result was recorded live but not yet checkpointed (the checkpoint is written at the loop top, before the LLM call), and ancestor unwinds would otherwise overwrite it with a state that no longer has the parked turn. Only the parked role writes; every other frame's later write is suppressed by the freeze.
function captureParkCheckpoint(deps: EngineDependencies, roleId: string): void {
	if (deps.parkTracker.parkedAsk?.roleId !== roleId) return
	// A suppressed write would leave the parked ask pointing at a non-leaf frame and freeze an unrelated checkpoint. Handler frames cannot park and the recorder is unfrozen for a re-park, so this is unreachable; fail loudly rather than persist an unresumable state.
	if (!deps.checkpointRecorder.write()) throw new Error(`captureParkCheckpoint: could not write the parked checkpoint for role ${roleId}`)
	deps.checkpointRecorder.freeze()
}

// Delivers the operator's answer into the parked ask_human tool result in place: only the last tool message changes, so the conversation prefix — and therefore the prompt cache — stays exactly as it was when the run parked.
function deliverParkedAnswer(deps: EngineDependencies, roleState: RoleState, parkedAnswer: ParkedAnswer, maxToolOutputChars: number): void {
	const history = roleState.history
	let targetIndex = -1
	for (let index = history.length - 1; index >= 0; index--) {
		const message = history[index]
		if (message === undefined) continue
		if (message.role !== 'tool' || message.tool_call_id !== parkedAnswer.toolCallId) continue
		targetIndex = index
		break
	}
	if (targetIndex === -1) throw new Error(`deliverParkedAnswer: no tool result for parked call ${parkedAnswer.toolCallId} in the resumed role's history`)
	if (targetIndex !== history.length - 1) throw new Error(`deliverParkedAnswer: the tool result for parked call ${parkedAnswer.toolCallId} is not the last message`)
	const existing = history[targetIndex]
	if (existing === undefined) throw new Error(`deliverParkedAnswer: parked call ${parkedAnswer.toolCallId} has no tool message`)
	history[targetIndex] = {
		...existing,
		content: serializeToolResult({ kind: 'success', data: { question: parkedAnswer.question, answer: parkedAnswer.answer } }, maxToolOutputChars),
	}
	const parkedAsk = deps.parkTracker.parkedAsk
	if (parkedAsk === undefined) throw new Error('deliverParkedAnswer: the resumed run has no parked ask')
	const callId = parkedAsk.callId
	const questionId = parkedAsk.questionId
	// Delivery is retried from the frozen checkpoint after a crash, so a human_answer already made durable must not be emitted again.
	const alreadyAnswered = findTerminalEvent(deps.readRunLogEvents(deps.runId), 'human_answer', callId) !== undefined
	if (!alreadyAnswered) logEvent(deps.appendLog, 'human_answer', humanAnswerPayload(questionId, callId, parkedAnswer.answer, parkedAnswer.question))
	if (!deps.invocationJournal.hasTerminal(callId)) {
		deps.invocationJournal.markStarted(callId)
		deps.invocationJournal.markTerminal(callId)
	}
	deps.parkTracker.parkedQuestion = undefined
	deps.parkTracker.parkedAsk = undefined
	// The frozen checkpoint still covers the mid-batch window; the caller writes the unparked state only once all remaining calls have results, so a crash here still retries delivery from the old parked checkpoint.
	deps.checkpointRecorder.unfreeze()
}

// Continues the parked assistant turn after the answer: the calls after ask_human in the same batched turn dispatch exactly as the blocking path would, and a park among them re-parks normally.
async function continueParkedTurn(deps: EngineDependencies, context: EngineContext, roleState: RoleState, registryEntry: RoleRegistryEntry, dispatchCtx: DispatchContext, toolCallId: string): Promise<ResultCard | null> {
	const history = roleState.history
	for (let index = history.length - 1; index >= 0; index--) {
		const message = history[index]
		if (message === undefined) continue
		if (message.role !== 'assistant' || message.tool_calls === undefined) continue
		const callIndex = message.tool_calls.findIndex((call) => call.id === toolCallId)
		if (callIndex === -1) continue
		return await dispatchToolCallSequence(deps, context, roleState, registryEntry, dispatchCtx, message.tool_calls, callIndex + 1)
	}
	throw new Error(`continueParkedTurn: no assistant message carries parked call ${toolCallId}`)
}

export async function runRole(deps: EngineDependencies, context: EngineContext, resumed?: ResumedRole, seeded?: SeededRole): Promise<ResultCard> {
	const guild = context.loadedGuild
	const roleDefinition = guild.config.roles[context.roleName]

	if (roleDefinition === undefined) {
		logEvent(deps.appendLog, 'role_not_found', { roleName: context.roleName })
		return createResultCard('error', `Unknown role: ${context.roleName}`, {
			error: createToolError('unknown_tool', `Unknown role: ${context.roleName}`),
		})
	}

	const systemPrompt = guild.prompts[context.roleName] ?? ''

	// The pre-write rule (docs/queueing.md "Parking: the pre-write rule"): the run-scoped flag flips when a write-capable role starts and never resets. It is conservative by construction — a false positive merely degrades a later park to today's blocking behavior, while a false negative would park a run that has already written.
	if (isWriteCapableRole(roleDefinition.tools)) deps.parkTracker.writeCapableStarted = true

	let roleState: RoleState
	if (resumed !== undefined) {
		roleState = { ...resumed.roleState }
	} else {
		// A seeded child conversation is ordinary history even when its first turns happen to look like a continuation, so it always keeps the default prefix.
		const initial = seeded !== undefined
			? { history: seeded.history, protectedPrefixLength: DEFAULT_PROTECTED_PREFIX_LENGTH }
			: buildInitialHistory(systemPrompt, context, deps)
		roleState = {
			history: initial.history,
			protectedPrefixLength: initial.protectedPrefixLength,
			lastPromptTokens: 0,
			recentCompactionPromptTokens: [],
			recentToolCalls: [],
			toolCallCount: 0,
			generatedTokens: 0,
			contextExceededAttempts: 0,
			loopCheckToolCallWatermark: 0,
			loopCheckTokenWatermark: 0,
		}
	}

	const registryEntry = deps.roleRegistry.register(context.roleName, context.depth, context.parentRoleId, roleState, resumed?.roleId)
	if (resumed?.planAbort === true) registryEntry.planAbort = true
	if (resumed?.planInjection !== undefined) registryEntry.planInjection = resumed.planInjection
	deps.checkpointRecorder.registerFrame(context, registryEntry)
	// A role resumed mid-suspension restores its pending marker so checkpoints taken while the resumed child runs capture the suspension exactly as the live dispatch path does.
	if (resumed?.suspendedTurn !== undefined) {
		deps.checkpointRecorder.setPending(registryEntry.roleId, {
			toolCalls: resumed.suspendedTurn.toolCalls,
			index: resumed.suspendedTurn.childIndex,
			callId: resumed.suspendedTurn.callId,
			parentCallId: resumed.suspendedTurn.parentCallId,
		})
	}
	if (resumed?.pendingInvocation !== undefined) deps.checkpointRecorder.setPending(registryEntry.roleId, resumed.pendingInvocation)

	// role_start is emitted after the role definition is confirmed to exist and the instance is registered, so an unknown entry role still fires role_not_found without leaving an orphan role_start, and the event can carry the instance id the interrupt platform targets. The depth and optional parent let source/run-log reconstruct the parent→child tree, parentRoleId names the parent instance exactly, and parentCallId carries the invocation that caused this role (a normal caller role or an interrupt). A resumed role skips the event: its role_start is already in the log from before the restart, so its role id is seeded as started to allow the single terminal.
	if (resumed === undefined) {
		deps.invocationJournal.roleStarted({
			roleName: context.roleName,
			roleId: registryEntry.roleId,
			depth: context.depth,
			task: context.task,
			...(context.parent !== undefined ? { parent: context.parent } : {}),
			...(context.parentRoleId !== undefined ? { parentRoleId: context.parentRoleId } : {}),
			...(context.parentCallId !== undefined ? { parentCallId: context.parentCallId } : {}),
			...(seeded !== undefined ? { continuedFrom: seeded.continuedFrom } : {}),
		})
	} else {
		deps.invocationJournal.seedStartedCallIds([roleCallId(registryEntry.roleId)])
	}

	const allowedToolsManifests: ToolManifest[] = []
	for (const toolName of roleDefinition.tools) {
		const manifest = guild.tools[toolName]
		if (manifest !== undefined) {
			allowedToolsManifests.push(manifest)
		}
	}

	// The shared child-spawn body behind both agent and continue_agent: budget and role checks, the agent_call edge, the child turn, and the pending-card checkpoint. The two tools differ only in the seed the child starts from.
	const runChild = async (childRoleName: string, childTask: string, seed?: SeededRole): Promise<ResultCard> => {
		const depthCheck = checkGlobalBudgets(context.depth + 1, guild.deployment.executor)
		if (depthCheck !== null) {
			logEvent(deps.appendLog, 'depth_exceeded', { parent: context.roleName, child: childRoleName, depth: context.depth + 1, error: depthCheck })
			return createResultCard('error', 'Depth budget exceeded', { error: depthCheck })
		}
		const childDefinition = guild.config.roles[childRoleName]
		if (childDefinition === undefined) {
			logEvent(deps.appendLog, 'role_not_found', { parent: context.roleName, roleName: childRoleName })
			return createResultCard('error', `Unknown role: ${childRoleName}`, {
				error: createToolError('unknown_tool', `Unknown role: ${childRoleName}`),
			})
		}
		// agent_call is a diagnostic parent→child edge with depth, logged before the child runs; it carries no invocation ids because role_start/role_finished and the tool lifecycle are the authoritative identified events.
		logEvent(deps.appendLog, 'agent_call', { parent: context.roleName, child: childRoleName, depth: context.depth + 1 })
		// A delegated child is parented to this role instance's invocation, but it keeps the handler mark: the whole handler subtree is atomic with respect to checkpoint writes and must not park.
		const delegatedContext: EngineContext = {
			...context,
			depth: context.depth + 1,
			roleName: childRoleName,
			task: childTask,
			parent: context.roleName,
			parentRoleId: registryEntry.roleId,
			parentCallId: roleCallId(registryEntry.roleId),
		}
		const childCard = await runRole(deps, delegatedContext, undefined, seed)
		// The child is done: record its card on this frame's pending suspension and checkpoint, so a restart here resumes by delivering the recorded card instead of re-running the child. The card is delivered to the conversation by recordToolResult after this handler returns.
		deps.checkpointRecorder.setPendingChildCard(registryEntry.roleId, childCard)
		deps.checkpointRecorder.write()
		return childCard
	}

	const runScope: RunToolScope = {
		spawnAgent: async (childRoleName, childTask) => runChild(childRoleName, childTask),
		continueAgent: async (childRoleName, comment, childRoleId) => {
			const resolution = selectContinuableChild(deps.roleSnapshots.list(), {
				parentRoleId: registryEntry.roleId,
				roleName: childRoleName,
				...(childRoleId !== undefined ? { roleId: childRoleId } : {}),
			})
			if (!resolution.ok) {
				const message = resolution.reason === 'unknown_id' ? `No finished child of this role with instance id ${childRoleId}` : `No finished child named ${childRoleName} to continue`
				return createResultCard('error', message, { error: createToolError('invalid_arguments', message) })
			}
			const snapshot = deps.roleSnapshots.read(resolution.roleId)
			if (snapshot === null) {
				const message = `Finished child snapshot ${resolution.roleId} could not be read`
				return createResultCard('error', message, { error: createToolError('unavailable', message) })
			}
			const history = buildContinuationHistory(snapshot.history, comment)
			return runChild(snapshot.roleName, snapshot.task, { history, continuedFrom: snapshot.roleId })
		},
		roleState,
		humanBackend: deps.humanBackend,
		roleRegistry: deps.roleRegistry,
		ownRoleId: registryEntry.roleId,
		appendLog: deps.appendLog,
		parkTracker: deps.parkTracker,
		baseTracker: deps.baseTracker,
		...(context.handlerOf !== undefined ? { handlerOf: context.handlerOf } : {}),
		contextWindow: guild.deployment.model.contextWindow,
		manifestNames: new Set(Object.keys(guild.tools)),
	}
	const dispatchCtx: DispatchContext = {
		toolPlatform: deps.toolPlatform,
		roleDefinition,
		scope: runScope,
		maxToolOutputChars: guild.deployment.contextPolicy.maxToolOutputChars,
	}

	const finalCard = await executeRoleLoop(deps, context, roleState, registryEntry, allowedToolsManifests, dispatchCtx, resumed?.suspendedTurn, resumed?.resumeNote, resumed?.parkedAnswer, resumed?.pendingInvocation, resumed?.explicitResume)
	// A finish terminal ends the turn; its dispatch closes any later calls and persists the fully answered turn. Write once more here when the card is a durable terminal, so an error or clarification resume sees a completed conversation. The parked path is excluded: its frozen checkpoint is captured at the park moment and must not be overwritten.
	if (context.depth === 0 && (finalCard.status === 'error' || finalCard.status === 'needs_clarification') && deps.parkTracker.parkedAsk === undefined && completedFinishCard(roleState.history) !== null) deps.checkpointRecorder.write()
	deps.roleRegistry.unregister(registryEntry.roleId)
	deps.checkpointRecorder.unregisterFrame(registryEntry.roleId)
	deps.invocationJournal.roleFinished({
		roleName: context.roleName,
		roleId: registryEntry.roleId,
		depth: context.depth,
		card: finalCard,
		...(context.parent !== undefined ? { parent: context.parent } : {}),
		pausesRun: finalCard.status === 'needs_clarification' && (context.depth === 0 || deps.parkTracker.parkedAsk !== undefined),
	})
	// A finished child is persisted so its parent can later continue it as a new seeded instance, across a restart. Only children qualify (a root has no parent to continue it) and handler instances are excluded — they are platform-invoked and never a parent's delegation.
	if (context.parentRoleId !== undefined && context.handlerOf === undefined) {
		deps.roleSnapshots.write({
			roleId: registryEntry.roleId,
			roleName: context.roleName,
			depth: context.depth,
			task: context.task,
			parentRoleId: context.parentRoleId,
			finishedAt: new Date().toISOString(),
			history: roleState.history,
		})
	}
	return finalCard
}

// Dispatches a turn's tool calls in order, tracking child-spawning suspensions on the checkpoint recorder so a checkpoint taken while a child runs captures where this role resumes. Shared by the live turn path (starting at 0) and the resumed-suspension path (starting after the child-spawning call, whose result the resume already recorded).
async function dispatchToolCallSequence(
	deps: EngineDependencies,
	context: EngineContext,
	roleState: RoleState,
	registryEntry: RoleRegistryEntry,
	dispatchCtx: DispatchContext,
	toolCalls: ToolCall[],
	startIndex: number,
): Promise<ResultCard | null> {
	for (let index = startIndex; index < toolCalls.length; index++) {
		const toolCall = toolCalls[index]
		if (toolCall === undefined) continue
		// The park mark checked between dispatches is load-bearing (docs/queueing.md "Parking: the pre-write rule"): a batched ask_human + agent turn must not start the child after the park decision, or the run writes after the pre-write premise was decided. The mark is run-scoped, so a suspended ancestor unwinds here with the same platform-authored park card once its child's card has propagated up. The frozen park checkpoint is captured by the parked role before it unwinds.
		if (deps.parkTracker.parkedQuestion !== undefined) {
			// The just-finished call is already in history; the parked checkpoint is the durable boundary and must not carry a pending marker.
			deps.checkpointRecorder.setPending(registryEntry.roleId, undefined)
			captureParkCheckpoint(deps, registryEntry.roleId)
			return parkCard(deps.parkTracker.parkedQuestion)
		}
		// Unknown and not-allowed names keep today's diagnostic-only logging and are not invocations, so they are rejected before any pending record or start event exists.
		const invalid = dispatchCtx.toolPlatform.validateCall(dispatchCtx.roleDefinition, dispatchCtx.scope, toolCall)
		if (invalid !== null) {
			const finalCard = recordToolResult(deps, dispatchCtx.toolPlatform, roleState, context.roleName, registryEntry.roleId, dispatchCtx.maxToolOutputChars, toolCall, invalid, {})
			if (finalCard !== null) return finalCard
			if (index + 1 >= toolCalls.length) {
				deps.checkpointRecorder.setPending(registryEntry.roleId, undefined)
				deps.checkpointRecorder.write()
			}
			continue
		}
		const invocation = deps.invocationJournal.allocateToolCall(toolCall, registryEntry.roleId)
		const isAsk = toolCall.function.name === 'ask_human'
		// The pre-dispatch checkpoint is the durable point for every call. It is deliberately not overwritten after a non-final result: the on-disk state keeps the call pending so a crash replays it and then continues at the next call.
		const pending: PendingInvocation = { callId: invocation.callId, parentCallId: invocation.parentCallId, toolCalls, index }
		deps.checkpointRecorder.setPending(registryEntry.roleId, pending)
		deps.checkpointRecorder.write()
		if (!isAsk) deps.invocationJournal.toolStarted(invocation, context.roleName)
		const result = await dispatchCtx.toolPlatform.dispatch(dispatchCtx.roleDefinition, dispatchCtx.scope, toolCall, invocation)
		if (isAsk) {
			if (result.kind === 'success') {
				// The ask handler/backend wrote ask_human (and later human_answer); mirror the lifecycle into the journal so a later duplicate cannot re-close it.
				deps.invocationJournal.markStarted(invocation.callId)
				if (!isParkedAskResult(result)) deps.invocationJournal.markTerminal(invocation.callId)
			} else if (!deps.invocationJournal.hasStarted(invocation.callId)) {
				// The handler rejected before it emitted ask_human (e.g. malformed arguments). Give the invocation a visible, closed generic lifecycle instead of leaving nothing in the log.
				deps.invocationJournal.toolStarted(invocation, context.roleName)
				deps.invocationJournal.toolFinished(invocation, context.roleName, result)
			}
		}
		const finalCard = recordToolResult(deps, dispatchCtx.toolPlatform, roleState, context.roleName, registryEntry.roleId, dispatchCtx.maxToolOutputChars, toolCall, result, { invocation })
		const hasLaterCalls = index + 1 < toolCalls.length
		if (finalCard !== null) {
			// The role is ending, so the later calls must not run. Close them explicitly and persist the fully answered turn; a crash after this point must not resume with unanswered calls.
			if (hasLaterCalls) closeUnexecutedCalls(deps, roleState, context, registryEntry, dispatchCtx, toolCalls, index + 1)
			deps.checkpointRecorder.setPending(registryEntry.roleId, undefined)
			deps.checkpointRecorder.write()
			return finalCard
		}
		if (!hasLaterCalls) {
			deps.checkpointRecorder.setPending(registryEntry.roleId, undefined)
			deps.checkpointRecorder.write()
		}
	}
	return null
}

// Completes a resumed role's suspended turn: the child card is resolved (re-running the child frame's resume when the checkpoint has no recorded card), checkpointed onto the pending suspension exactly as the live role_finished path does, and recorded as the child-spawning call's tool result — the agent_call event and the child's events are already in the log from the live dispatch. The turn's remaining tool calls then dispatch normally.
// resumeNote is delivered only after every remaining tool result of the batch, so it can never land between an assistant tool_calls message and its results. A remaining completed finish still leaves a closed turn, so the note follows it; any other early terminal is skipped. Undefined for boot reconciliation.
async function completeSuspendedTurn(deps: EngineDependencies, context: EngineContext, roleState: RoleState, registryEntry: RoleRegistryEntry, dispatchCtx: DispatchContext, suspendedTurn: SuspendedTurn, resumeNote?: string): Promise<ResultCard | null> {
	const childCall = suspendedTurn.toolCalls[suspendedTurn.childIndex]
	if (childCall === undefined) throw new Error(`completeSuspendedTurn: childIndex ${suspendedTurn.childIndex} out of range in a validated checkpoint`)
	const childCard = await suspendedTurn.resolveChildCard()
	deps.checkpointRecorder.setPendingChildCard(registryEntry.roleId, childCard)
	deps.checkpointRecorder.write()
	const invocation = deps.invocationJournal.adoptToolCall(childCall, suspendedTurn.callId, suspendedTurn.parentCallId)
	deps.invocationJournal.toolStarted(invocation, context.roleName)
	recordToolResult(deps, dispatchCtx.toolPlatform, roleState, context.roleName, registryEntry.roleId, dispatchCtx.maxToolOutputChars, childCall, { kind: 'success', data: childCard }, { invocation })
	deps.checkpointRecorder.setPending(registryEntry.roleId, undefined)
	const remainingCard = await dispatchToolCallSequence(deps, context, roleState, registryEntry, dispatchCtx, suspendedTurn.toolCalls, suspendedTurn.childIndex + 1)
	if (resumeNote !== undefined && (remainingCard === null || completedFinishCard(roleState.history) !== null)) roleState.history.push({ role: 'user', content: resumeNote })
	return remainingCard
}

// The role's turn loop, extracted from runRole so every exit emits exactly one role_finished at the runRole call site, guaranteeing the role_start/role_finished pairing regardless of which budget or finish path terminates the role.
async function executeRoleLoop(
	deps: EngineDependencies,
	context: EngineContext,
	roleState: RoleState,
	registryEntry: RoleRegistryEntry,
	allowedToolsManifests: ToolManifest[],
	dispatchCtx: DispatchContext,
	suspendedTurn?: SuspendedTurn,
	resumeNote?: string,
	parkedAnswer?: ParkedAnswer,
	pendingInvocation?: PendingInvocation,
	explicitResume?: boolean,
): Promise<ResultCard> {
	const config = context.loadedGuild.deployment.executor
	const contextManager = createContextManager(context, {
		appendLog: deps.appendLog,
		contextPressureTracker: deps.contextPressureTracker,
		invocationJournal: deps.invocationJournal,
		runRole: (handlerContext) => runRole(deps, handlerContext),
	})
	// A fully answered finish turn is already the role's outcome. A boot resume returns it without another LLM call; a resume carrying a note or answer must continue instead, because that note is appended to history before this point (or injected by the reconciliation below).
	if (pendingInvocation === undefined && suspendedTurn === undefined && parkedAnswer === undefined && resumeNote === undefined && explicitResume !== true) {
		const completedCard = completedFinishCard(roleState.history)
		if (completedCard !== null) return completedCard
	}
	// The answer is delivered before any note or suspended-turn completion: it replaces the existing ask_human result in place and then continues that same assistant turn, so the conversation is exactly the blocking path's.
	if (parkedAnswer !== undefined) {
		deliverParkedAnswer(deps, roleState, parkedAnswer, dispatchCtx.maxToolOutputChars)
		const continuedCard = await continueParkedTurn(deps, context, roleState, registryEntry, dispatchCtx, parkedAnswer.toolCallId)
		// Only a completed turn boundary is safe to checkpoint: write when the continued turn has no finish card, or when its finish is the turn's last call and therefore has a recorded result. A later batched call after finish would be left unanswered, and a remaining call that parked again has frozen the recorder, so in both cases the existing checkpoint survives.
		if (continuedCard === null || completedFinishCard(roleState.history) !== null) deps.checkpointRecorder.write()
		if (continuedCard !== null) return continuedCard
	}
	// The note is delivered exactly once, at the resumed role's equivalent loop entry: inside pending/suspended-turn completion when there is one (its remaining calls may include the finish that terminates the role without a further LLM request), else at the loop top. Either way it lands after the previous turn's tool results and before the role's next decision, and the loop top's checkpoint write persists it like any other history message.
	let noteToInject = resumeNote
	if (pendingInvocation !== undefined) {
		const reconciledCard = await reconcilePendingInvocation(deps, context, roleState, registryEntry, dispatchCtx, pendingInvocation, noteToInject)
		noteToInject = undefined
		if (reconciledCard !== null) return reconciledCard
	}
	if (suspendedTurn !== undefined) {
		const completedCard = await completeSuspendedTurn(deps, context, roleState, registryEntry, dispatchCtx, suspendedTurn, noteToInject)
		noteToInject = undefined
		if (completedCard !== null) return completedCard
	}
	if (noteToInject !== undefined) {
		roleState.history.push({ role: 'user', content: noteToInject })
	}
	while (true) {
		// The park mark unwinds the run at the loop top — the safe point before any further LLM request — with the platform-authored park card; the LLM is never asked to finish gracefully and never gets a turn to talk itself out of parking (docs/queueing.md "Parking: the pre-write rule"). The frozen park checkpoint is captured here first so the answer can resume this exact turn.
		if (deps.parkTracker.parkedQuestion !== undefined) {
			captureParkCheckpoint(deps, registryEntry.roleId)
			return parkCard(deps.parkTracker.parkedQuestion)
		}

		const interruptCard = await drainInterrupts(runRole, deps, context, roleState, registryEntry)
		if (interruptCard !== null) return interruptCard

		const contextDecision = await contextManager.resolveSafePoint(roleState, registryEntry)
		if (contextDecision.kind === 'finished') return contextDecision.card

		// The safe point: no LLM call is in flight and every queued platform mutation (drain, compaction, pressure notice) has been applied, so the checkpoint written here is the state a restart resumes from. Only the active leaf reaches this — suspended ancestors are captured through their registered frames.
		deps.checkpointRecorder.write()

		const globalError = checkGlobalBudgets(context.depth, config)
		if (globalError !== null) {
			logEvent(deps.appendLog, 'global_budget_exceeded', { role: context.roleName, error: globalError })
			return createResultCard('error', 'Global budget exceeded', { error: globalError })
		}

		const roleError = checkRoleBudgets(roleState.recentCompactionPromptTokens, config)
		if (roleError !== null) {
			logEvent(deps.appendLog, 'role_budget_exceeded', { role: context.roleName, error: roleError })
			return createResultCard('error', 'Role budget exceeded', { error: roleError })
		}

		// The request snapshots the history (shallow copy — the engine never mutates message objects in place): the caller and its transport must observe exactly the messages sent, even though the history array keeps growing as turns append.
		const messages = [...roleState.history]

		// llm_call_start marks the turn in flight the moment the request is dispatched, so the flow view can end the call's transit phase (flowing edge → solid) when the callee begins working rather than when the response completes.
		// It fires on every turn, including the paths that later fail (llm_unavailable / context_budget_exceeded): the turn started even if it never completed.
		// roleId rides along so a client can attribute the in-flight turn to the role instance (the inspector's per-instance turn list); the full turn lands in llm_call once the response arrives.
		logEvent(deps.appendLog, 'llm_call_start', { role: context.roleName, roleId: registryEntry.roleId })

		// The streaming tap fans each payload-text delta out through the run-scoped publisher, stamped with this role instance's identity so a client can attribute streamed text to the right role.
		const llmResult = await deps.llmCaller.call({
			messages,
			tools: allowedToolsManifests,
			onDelta: (delta) => deps.publishDelta({ roleId: registryEntry.roleId, role: context.roleName, ...delta }),
		})

		const handling = handleLlmResult(llmResult, roleState, deps, context, contextManager)
		// llm_call is emitted after handleLlmResult so the received assistant response, finishReason, and per-call usage all land in one event. It is emitted only on the success paths (continue/tool_calls and success-finished): the llm_unavailable and context_budget_exceeded paths log their own dedicated events inside handleLlmResult and must not also emit a misleading llm_call.
		if (llmResult.kind === 'success') {
			// The discarded retry attempts' spend is logged ahead of the llm_call it belongs to: those attempts ran and were billed before the final one, and the llm_call's own usage stays the final attempt's so pressure/context semantics keep reflecting the live conversation size rather than a retry-inflated total.
			if (llmResult.discardedRetrySpend !== undefined) {
				logEvent(deps.appendLog, 'llm_retry', llmRetryPayload(context.roleName, registryEntry.roleId, llmResult.discardedRetrySpend))
			}
			// Delta protocol: a valid baseline (the request count of the role's last logged llm_call) slices the sent list down to the messages added since that call; an absent or out-of-range baseline — first turn, or a context edit or compaction that rewrote the history — falls back to the full snapshot. The baseline then advances to this request's size so the next event slices from here. The baseline indexes the request, which is the role's history itself.
			const baseline = roleState.logSentBaseline
			const sentFrom = baseline !== undefined && baseline <= messages.length ? baseline : 0
			logEvent(deps.appendLog, 'llm_call', llmCallPayload(context.roleName, registryEntry.roleId, messages.slice(sentFrom), sentFrom, messages.length, llmResult))
			roleState.logSentBaseline = messages.length
		}
		if (handling.kind === 'continue') continue
		if (handling.kind === 'finished') return handling.card

		const finalCard = await dispatchToolCallSequence(deps, context, roleState, registryEntry, dispatchCtx, handling.toolCalls, 0)
		if (finalCard !== null) return finalCard
	}
}
