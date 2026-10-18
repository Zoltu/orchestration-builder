import { createResultCard, createToolError } from './errors.js'
import type { DiscardedRetrySpend, LlmUsage, LlmUsagePayload, Message, ResultCard, ToolCall, ToolManifest, ToolResult } from './types.js'
import { isObject, isResultCard } from './validation.js'
import { checkGlobalBudgets, checkRoleBudgets } from './budgets.js'
import { createBuiltInToolHandlers, OBSERVATION_TOOL_NAMES } from './builtin-tools.js'
import { buildInitialHistory, createContextManager, truncateToolOutput, type ContextManager } from './context/index.js'
import { logEvent, SUSPENDING_CHILD_TOOLS, type EngineContext, type EngineDependencies, type ResumedRole, type RoleState, type SeededRole, type SuspendedTurn } from './engine-state.js'
import { isWriteCapableRole, parkCard } from './park-state.js'
import { drainInterrupts } from './interrupt-engine.js'
import type { LlmCallResult } from './llm.js'
import { hashArguments, RECENT_TOOL_CALLS_LIMIT } from './role-inspection.js'
import type { RoleRegistryEntry } from './role-registry.js'
import { buildContinuationHistory, selectContinuableChild } from './role-snapshot.js'
import { createToolDispatch, dispatchToolCall, type ToolDispatch, type ToolHandler } from './tool-dispatch.js'

interface DispatchContext {
	dispatch: ToolDispatch
	allowedTools: string[]
	manifestNames: string[]
	maxToolOutputChars: number
}

type LlmResultHandling =
	| { kind: 'continue' }
	| { kind: 'finished'; card: ResultCard }
	| { kind: 'tool_calls'; toolCalls: ToolCall[] }

type SuccessfulLlmCall = Extract<LlmCallResult, { kind: 'success' }>

function serializeToolResult(result: ToolResult, maxChars: number): string {
	let text: string
	if (result.kind === 'success') {
		text = JSON.stringify(result.data ?? null)
	} else {
		text = JSON.stringify({ kind: result.kind, message: result.message, details: result.details })
	}
	return truncateToolOutput(text, maxChars).text
}

// Builds the role_finished payload: the {role, status} base plus the instance id, depth, an optional parent, and the result-card summary/error so source/run-log can build the parent→child tree and a reviewer reading only log.jsonl can see why a role finished (especially why it errored — without this, an erroring role's explanation lives only on the returned ResultCard / meta.json, never in the log stream).
// The added fields are additive: existing readers that read only role/status keep working.
function roleFinishedPayload(roleName: string, depth: number, card: ResultCard, parent: string | undefined, roleId: string): unknown {
	const payload: Record<string, unknown> = { role: roleName, roleId, depth, status: card.status }
	if (card.summary !== '') payload['summary'] = card.summary
	if (card.error !== undefined) payload['error'] = card.error
	if (parent !== undefined) payload['parent'] = parent
	return payload
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

interface DispatchAndRecordArgs {
	deps: EngineDependencies
	roleState: RoleState
	roleName: string
	ownRoleId: string
	dispatchCtx: DispatchContext
	toolCall: ToolCall
}

async function dispatchAndRecord({ deps, roleState, roleName, ownRoleId, dispatchCtx, toolCall }: DispatchAndRecordArgs): Promise<ResultCard | null> {
	const result = await dispatchToolCall(dispatchCtx, toolCall)
	return recordToolResult(deps, roleState, roleName, ownRoleId, dispatchCtx.maxToolOutputChars, toolCall, result)
}

// Emits the observe event for a successful cross-role inspection, so the interaction model can draw the reference from the inspecting role to the suspended target it read. Self-inspection (targetRole absent or the caller's own id) is not an observation, and a target that is no longer registered cannot be drawn, so both are skipped.
function maybeLogObservation(deps: EngineDependencies, ownRoleId: string, toolName: string, result: ToolResult): void {
	if (result.kind !== 'success') return
	if (!OBSERVATION_TOOL_NAMES.has(toolName)) return
	if (!isObject(result.data)) return
	const targetRole = result.data['targetRole']
	if (typeof targetRole !== 'string') return
	if (targetRole === ownRoleId) return
	const target = deps.roleRegistry.lookup(targetRole)
	if (target === undefined) return
	logEvent(deps.appendLog, 'observe', { role: target.roleName, roleId: targetRole, details: toolName })
}

// Records a settled tool call: logs the call/result pair, appends the (truncated) tool message, and updates the counters. Shared by the live dispatch path and the resume path, which re-records a suspended child-spawning call's result from the checkpoint without re-dispatching it — so both paths apply exactly the same bookkeeping.
function recordToolResult(deps: EngineDependencies, roleState: RoleState, roleName: string, ownRoleId: string, maxToolOutputChars: number, toolCall: ToolCall, result: ToolResult): ResultCard | null {
	if (result.kind === 'unknown_tool') {
		logEvent(deps.appendLog, 'unknown_tool', { role: roleName, tool: toolCall.function.name })
	} else if (result.kind === 'invalid_tool_call') {
		logEvent(deps.appendLog, 'invalid_tool_call', { role: roleName, tool: toolCall.function.name })
	} else {
		// tool_call carries the model's raw arguments string so the exact parameters are recoverable, and tool_result carries the full un-truncated ToolResult so a reviewer is not flying blind on what a tool actually returned. Truncation still applies only when the result is appended to the conversation below.
		logEvent(deps.appendLog, 'tool_call', { role: roleName, tool: toolCall.function.name, arguments: toolCall.function.arguments })
		maybeLogObservation(deps, ownRoleId, toolCall.function.name, result)
		logEvent(deps.appendLog, 'tool_result', { role: roleName, tool: toolCall.function.name, kind: result.kind, result })
	}

	roleState.history.push({
		role: 'tool',
		content: serializeToolResult(result, maxToolOutputChars),
		tool_call_id: toolCall.id,
	})

	roleState.toolCallCount += 1
	roleState.recentToolCalls.push({ tool: toolCall.function.name, argsHash: hashArguments(toolCall.function.arguments), resultKind: result.kind })
	if (roleState.recentToolCalls.length > RECENT_TOOL_CALLS_LIMIT) roleState.recentToolCalls.shift()

	if (toolCall.function.name === 'finish' && result.kind === 'success' && isResultCard(result.data)) {
		return result.data
	}
	return null
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

	const roleState: RoleState = resumed?.roleState ?? {
		history: seeded !== undefined ? seeded.history : buildInitialHistory(systemPrompt, context, deps),
		lastPromptTokens: 0,
		recentCompactionPromptTokens: [],
		recentToolCalls: [],
		toolCallCount: 0,
		generatedTokens: 0,
		contextExceededAttempts: 0,
		loopCheckToolCallWatermark: 0,
		loopCheckTokenWatermark: 0,
	}

	const registryEntry = deps.roleRegistry.register(context.roleName, context.depth, context.parentRoleId, roleState, resumed?.roleId)
	if (resumed?.planAbort === true) registryEntry.planAbort = true
	if (resumed?.planInjection !== undefined) registryEntry.planInjection = resumed.planInjection
	deps.checkpointRecorder.registerFrame(context, registryEntry)
	// A role resumed mid-suspension restores its pending marker so checkpoints taken while the resumed child runs capture the suspension exactly as the live dispatch path does.
	if (resumed?.suspendedTurn !== undefined) {
		deps.checkpointRecorder.setPending(registryEntry.roleId, { toolCalls: resumed.suspendedTurn.toolCalls, childIndex: resumed.suspendedTurn.childIndex })
	}

	// role_start is emitted after the role definition is confirmed to exist and the instance is registered, so an unknown entry role still fires role_not_found without leaving an orphan role_start, and the event can carry the instance id the interrupt platform targets. The depth and optional parent let source/run-log reconstruct the parent→child tree, and parentRoleId names the parent instance exactly so a client can walk the instance chain without guessing among same-named ancestors (the inspector's breadcrumb). A resumed role skips the event: its role_start is already in the log from before the restart.
	if (resumed === undefined) {
		const roleStartPayload: Record<string, unknown> = {
			role: context.roleName,
			roleId: registryEntry.roleId,
			depth: context.depth,
			task: context.task,
		}
		if (context.parent !== undefined) roleStartPayload['parent'] = context.parent
		if (context.parentRoleId !== undefined) roleStartPayload['parentRoleId'] = context.parentRoleId
		if (seeded !== undefined) roleStartPayload['continuedFrom'] = seeded.continuedFrom
		logEvent(deps.appendLog, 'role_start', roleStartPayload)
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
		// agent_call logs the parent→child edge with depth before the child runs, so the parent→child linkage is recoverable even from a caller that does not read role_start.
		logEvent(deps.appendLog, 'agent_call', { parent: context.roleName, child: childRoleName, depth: context.depth + 1 })
		const childCard = await runRole(
			deps,
			{
				...context,
				depth: context.depth + 1,
				roleName: childRoleName,
				task: childTask,
				parent: context.roleName,
				parentRoleId: registryEntry.roleId,
			},
			undefined,
			seed,
		)
		// The child is done: record its card on this frame's pending suspension and checkpoint, so a restart here resumes by delivering the recorded card instead of re-running the child. The card is delivered to the conversation by recordToolResult after this handler returns.
		deps.checkpointRecorder.setPendingChildCard(registryEntry.roleId, childCard)
		deps.checkpointRecorder.write()
		return childCard
	}

	const builtInHandlers = createBuiltInToolHandlers({
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
		loadedGuild: guild,
		roleRegistry: deps.roleRegistry,
		ownRoleId: registryEntry.roleId,
		appendLog: deps.appendLog,
		parkTracker: deps.parkTracker,
		handlerOf: context.handlerOf,
	})

	// Built-ins spread last: platform invariants (finish, agent, ask_human, the context tools) are not shadowable by an additional handler that happens to collide on a key.
	const handlers: Record<string, ToolHandler> = { ...deps.additionalToolHandlers, ...builtInHandlers }
	const dispatch = createToolDispatch(handlers)
	const dispatchCtx: DispatchContext = {
		dispatch,
		allowedTools: roleDefinition.tools,
		manifestNames: Object.keys(guild.tools),
		maxToolOutputChars: guild.deployment.contextPolicy.maxToolOutputChars,
	}

	const finalCard = await executeRoleLoop(deps, context, roleState, registryEntry, allowedToolsManifests, dispatchCtx, resumed?.suspendedTurn, resumed?.resumeNote)
	deps.roleRegistry.unregister(registryEntry.roleId)
	deps.checkpointRecorder.unregisterFrame(registryEntry.roleId)
	logEvent(deps.appendLog, 'role_finished', roleFinishedPayload(context.roleName, context.depth, finalCard, context.parent, registryEntry.roleId))
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
		// The park mark checked between dispatches is load-bearing (docs/queueing.md "Parking: the pre-write rule"): a batched ask_human + agent turn must not start the child after the park decision, or the run writes after the pre-write premise was decided. The mark is run-scoped, so a suspended ancestor unwinds here with the same platform-authored park card once its child's card has propagated up.
		if (deps.parkTracker.parkedQuestion !== undefined) return parkCard(deps.parkTracker.parkedQuestion)
		// A child-spawning dispatch suspends this role mid-turn until the child returns; record the suspension so a checkpoint taken while the child runs captures where this role resumes. Cleared once the dispatch settles.
		if (SUSPENDING_CHILD_TOOLS.has(toolCall.function.name)) {
			deps.checkpointRecorder.setPending(registryEntry.roleId, { toolCalls, childIndex: index })
		}
		const finalCard = await dispatchAndRecord({ deps, roleState, roleName: context.roleName, ownRoleId: registryEntry.roleId, dispatchCtx, toolCall })
		if (SUSPENDING_CHILD_TOOLS.has(toolCall.function.name)) {
			deps.checkpointRecorder.setPending(registryEntry.roleId, undefined)
		}
		if (finalCard !== null) return finalCard
	}
	return null
}

// Completes a resumed role's suspended turn: the child card is resolved (re-running the child frame's resume when the checkpoint has no recorded card), checkpointed onto the pending suspension exactly as the live role_finished path does, and recorded as the child-spawning call's tool result — the agent_call event and the child's events are already in the log from the live dispatch. The turn's remaining tool calls then dispatch normally.
// resumeNote is delivered at this walk's equivalent loop entry — after the recorded tool result, before the remaining calls execute — so a turn whose remaining calls include finish still carries the note in its conversation even though no further LLM request happens; the ordering rule holds (never between an assistant tool_calls message and its tool results). Undefined for boot reconciliation.
async function completeSuspendedTurn(deps: EngineDependencies, context: EngineContext, roleState: RoleState, registryEntry: RoleRegistryEntry, dispatchCtx: DispatchContext, suspendedTurn: SuspendedTurn, resumeNote?: string): Promise<ResultCard | null> {
	const childCall = suspendedTurn.toolCalls[suspendedTurn.childIndex]
	if (childCall === undefined) throw new Error(`completeSuspendedTurn: childIndex ${suspendedTurn.childIndex} out of range in a validated checkpoint`)
	const childCard = await suspendedTurn.resolveChildCard()
	deps.checkpointRecorder.setPendingChildCard(registryEntry.roleId, childCard)
	deps.checkpointRecorder.write()
	recordToolResult(deps, roleState, context.roleName, registryEntry.roleId, dispatchCtx.maxToolOutputChars, childCall, { kind: 'success', data: childCard })
	deps.checkpointRecorder.setPending(registryEntry.roleId, undefined)
	if (resumeNote !== undefined) {
		roleState.history.push({ role: 'user', content: resumeNote })
	}
	return dispatchToolCallSequence(deps, context, roleState, registryEntry, dispatchCtx, suspendedTurn.toolCalls, suspendedTurn.childIndex + 1)
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
): Promise<ResultCard> {
	const config = context.loadedGuild.deployment.executor
	const contextManager = createContextManager(context, {
		appendLog: deps.appendLog,
		contextPressureTracker: deps.contextPressureTracker,
		runRole: (handlerContext) => runRole(deps, handlerContext),
	})
	// The note is delivered exactly once, at the resumed role's equivalent loop entry: inside the suspended-turn completion when there is one (its remaining calls may include the finish that terminates the role without a further LLM request), else at the loop top. Either way it lands after the previous turn's tool results and before the role's next decision, and the loop top's checkpoint write persists it like any other history message.
	let noteToInject = resumeNote
	if (suspendedTurn !== undefined) {
		const completedCard = await completeSuspendedTurn(deps, context, roleState, registryEntry, dispatchCtx, suspendedTurn, noteToInject)
		noteToInject = undefined
		if (completedCard !== null) return completedCard
	}
	if (noteToInject !== undefined) {
		roleState.history.push({ role: 'user', content: noteToInject })
	}
	while (true) {
		// The park mark unwinds the run at the loop top — the safe point before any further LLM request — with the platform-authored park card; the LLM is never asked to finish gracefully and never gets a turn to talk itself out of parking (docs/queueing.md "Parking: the pre-write rule").
		if (deps.parkTracker.parkedQuestion !== undefined) return parkCard(deps.parkTracker.parkedQuestion)

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
