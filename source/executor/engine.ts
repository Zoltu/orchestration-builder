import { createResultCard, createToolError } from './errors.js'
import type { ExecutorConfig, Message, ResultCard, RoleDefinition, ToolCall, ToolManifest, ToolResult } from './types.js'
import { isObject, isResultCard } from './validation.js'
import { checkGlobalBudgets, checkRoleBudgets, type GlobalBudgetState, type RoleBudgetState } from './budgets.js'
import { createBuiltInToolHandlers } from './builtin-tools.js'
import { buildInitialHistory, buildMessages } from './context-builder.js'
import { applyContextBackstop, contextExceededCard, contextManagedNotice, contextPressureNotice, currentEffectiveBudget, MAX_CONTEXT_RECOVERY_ATTEMPTS, runContextManagerHandler } from './context-handoff.js'
import { truncateToolOutput } from './context-policy.js'
import { DEFAULT_CONTEXT_PRESSURE_THRESHOLD, recordContextRejection } from './context-pressure.js'
import { logEvent, type EngineContext, type EngineDependencies, type RoleState } from './engine-state.js'
import { drainInterrupts } from './interrupt-engine.js'
import type { LlmCallResult } from './llm.js'
import { hashArguments, RECENT_TOOL_CALLS_LIMIT } from './role-inspection.js'
import type { RoleRegistryEntry } from './role-registry.js'
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

function serializeToolResult(result: ToolResult, maxChars: number): string {
	let text: string
	if (result.kind === 'success') {
		text = JSON.stringify(result.data ?? null)
	} else {
		text = JSON.stringify({ kind: result.kind, message: result.message, details: result.details })
	}
	return truncateToolOutput(text, maxChars).text
}

// Builds the role_finished payload, extending the legacy {role, status} with the instance id, depth, an optional parent, and the result-card summary/error so render.ts can build the parent→child tree and a reviewer reading only log.jsonl can see why a role finished (especially why it errored — without this, an erroring role's explanation lives only on the returned ResultCard / meta.json, never in the log stream).
// The added fields are additive: existing readers that read only role/status keep working.
function roleFinishedPayload(roleName: string, depth: number, card: ResultCard, parent: string | undefined, roleId: string): unknown {
	const payload: Record<string, unknown> = { role: roleName, roleId, depth, status: card.status }
	if (card.summary !== '') payload['summary'] = card.summary
	if (card.error !== undefined) payload['error'] = card.error
	if (parent !== undefined) payload['parent'] = parent
	return payload
}

// Shapes a sent message for the llm_call payload: role and content only. Reasoning is omitted (it is an internal field, not part of what the reviewer needs to reconstruct the request), and tool_calls on assistant messages are carried so the message-list reflects the full prior turn.
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

// Builds the llm_call payload for a successful turn, carrying the sent message list, the received assistant response, the finishReason, and the per-call usage in one event so a reviewer can reconstruct the full turn from a single log entry.
// This is emitted only on the success paths (continue/tool_calls and success-finished); the llm_unavailable and context_budget_exceeded paths log their own dedicated events and must not emit a misleading llm_call.
// promptTokens is the full prompt bill (cached + uncached); cachedPromptTokens is the subset the endpoint served from its prompt cache, so the uncached prompt bill is promptTokens - cachedPromptTokens. The two are tracked separately because they are billed at different rates.
function llmCallPayload(roleName: string, messages: Message[], llmResult: LlmCallResult): unknown {
	const messageCount = messages.length
	if (llmResult.kind === 'success') {
		const promptTokens = llmResult.usage.promptTokens
		const completionTokens = llmResult.usage.completionTokens
		const cachedPromptTokens = llmResult.usage.cachedPromptTokens
		const usage: Record<string, number> = {
			promptTokens,
			completionTokens,
			totalTokens: promptTokens + completionTokens,
		}
		if (cachedPromptTokens !== undefined) usage['cachedPromptTokens'] = cachedPromptTokens
		const payload: Record<string, unknown> = {
			role: roleName,
			messageCount,
			sent: messages.map(shapeSentMessage),
			received: shapeAssistantResponse(llmResult),
			usage,
		}
		if (llmResult.finishReason !== undefined) payload['finishReason'] = llmResult.finishReason
		return payload
	}
	return { role: roleName, messageCount }
}

function handleLlmResult(
	llmResult: LlmCallResult,
	roleState: RoleState,
	deps: EngineDependencies,
	context: EngineContext,
	config: ExecutorConfig,
): LlmResultHandling {
	if (llmResult.kind === 'llm_unavailable') {
		logEvent(deps.appendLog, 'llm_unavailable', { role: context.roleName, message: llmResult.message })
		return {
			kind: 'finished',
			card: createResultCard('error', `LLM unavailable: ${llmResult.message}`, {
				error: createToolError('llm_unavailable', llmResult.message),
			}),
		}
	}

	if (llmResult.kind === 'context_budget_exceeded') {
		recordContextRejection(deps.contextPressureTracker, llmResult.promptTokens)
		logEvent(deps.appendLog, 'context_budget_exceeded', {
			role: context.roleName,
			promptTokens: llmResult.promptTokens,
			contextWindow: llmResult.contextWindow,
		})
		roleState.contextExceededAttempts += 1
		if (roleState.contextExceededAttempts > MAX_CONTEXT_RECOVERY_ATTEMPTS) {
			return contextExceededCard(`Context window exceeded and ${MAX_CONTEXT_RECOVERY_ATTEMPTS} compaction attempts did not make the request fit`)
		}
		// With a context handler configured, the overflow is answered at the next turn boundary by suspending the role and letting the handler prune surgically — the rejection is detected mid-turn, but a handler can only run at the safe point. The naive backstop remains for handler-less configurations and as the fallback when the handler fails.
		if (config.contextHandlerRole !== undefined) {
			roleState.contextCompactionPending = { promptTokens: llmResult.promptTokens, contextWindow: llmResult.contextWindow }
			return { kind: 'continue' }
		}
		const backstopCard = applyContextBackstop(roleState, deps, context, llmResult)
		if (backstopCard !== null) return { kind: 'finished', card: backstopCard }
		return { kind: 'continue' }
	}

	roleState.contextExceededAttempts = 0
	roleState.lastPromptTokens = llmResult.usage.promptTokens
	roleState.generatedTokens += llmResult.usage.completionTokens

	// The proactive pressure check reads real reported usage only, and fires once per role instance: the flag moves pending → sent and never re-arms, so a role that keeps working after the notice is not re-noticed on every subsequent turn.
	if (roleState.contextPressureNotice === undefined) {
		const threshold = config.contextPressureThreshold ?? DEFAULT_CONTEXT_PRESSURE_THRESHOLD
		const budget = currentEffectiveBudget(context, deps)
		if (roleState.lastPromptTokens >= threshold * budget) {
			roleState.contextPressureNotice = 'pending'
			logEvent(deps.appendLog, 'context_pressure', { role: context.roleName, promptTokens: roleState.lastPromptTokens, effectiveBudget: budget })
		}
	}

	const postCallBudgetState: RoleBudgetState = {
		recentCompactionPromptTokens: roleState.recentCompactionPromptTokens,
	}
	const postCallBudgetError = checkRoleBudgets(postCallBudgetState, config)
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

// Only the read-only inspection tools count as observations for the observe event; edit_context mutates its target and never emits one.
const OBSERVATION_TOOL_NAMES: ReadonlySet<string> = new Set(['list_role_messages', 'read_message_window', 'search_role_blocks', 'recent_role_tool_calls', 'context_info'])

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

// Records a settled tool call: logs the call/result pair, appends the (truncated) tool message, and updates the counters. Shared by the live dispatch path and the resume path, which re-records a suspended agent call's result from the checkpoint without re-dispatching it — so both paths apply exactly the same bookkeeping.
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

// The turn a resumed role was suspended in: the full tool-call list, the index of the agent call it was waiting on, and a resolver for the child card. The resolver either returns the checkpoint's recorded card or re-enters the child frame's own resume — invoked from inside the parent's suspended turn so parents register root-first exactly as in live execution.
export interface SuspendedTurn {
	toolCalls: ToolCall[]
	agentIndex: number
	resolveChildCard: () => Promise<ResultCard>
}

// The checkpoint-preserved identity and state of a role being resumed. The role keeps its pre-restart instance id (and does not re-emit role_start), so the log's role_start/role_finished pairing and every id reference inside persisted histories survive the restart.
export interface ResumedRole {
	roleId: string
	roleState: RoleState
	planAbort?: boolean
	planInjection?: string
	suspendedTurn?: SuspendedTurn
}

export async function runRole(deps: EngineDependencies, context: EngineContext, resumed?: ResumedRole): Promise<ResultCard> {
	const guild = context.loadedGuild
	const roleDefinition = guild.config.roles[context.roleName]

	if (roleDefinition === undefined) {
		logEvent(deps.appendLog, 'role_not_found', { roleName: context.roleName })
		return createResultCard('error', `Unknown role: ${context.roleName}`, {
			error: createToolError('unknown_tool', `Unknown role: ${context.roleName}`),
		})
	}

	const systemPrompt = guild.prompts[context.roleName] ?? ''

	const roleState: RoleState = resumed?.roleState ?? {
		history: buildInitialHistory(systemPrompt, context),
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
		deps.checkpointRecorder.setPending(registryEntry.roleId, { toolCalls: resumed.suspendedTurn.toolCalls, agentIndex: resumed.suspendedTurn.agentIndex })
	}

	// role_start is emitted after the role definition is confirmed to exist and the instance is registered, so an unknown entry role still fires role_not_found without leaving an orphan role_start, and the event can carry the instance id the interrupt platform targets. The depth and optional parent let render.ts reconstruct the parent→child tree. A resumed role skips the event: its role_start is already in the log from before the restart.
	if (resumed === undefined) {
		const roleStartPayload: Record<string, unknown> = {
			role: context.roleName,
			roleId: registryEntry.roleId,
			depth: context.depth,
			task: context.task,
		}
		if (context.parent !== undefined) roleStartPayload['parent'] = context.parent
		logEvent(deps.appendLog, 'role_start', roleStartPayload)
	}

	const allowedToolsManifests: ToolManifest[] = []
	for (const toolName of roleDefinition.tools) {
		const manifest = guild.tools[toolName]
		if (manifest !== undefined) {
			allowedToolsManifests.push(manifest)
		}
	}

	const builtInHandlers = createBuiltInToolHandlers({
		spawnAgent: async (childRoleName, childTask) => {
			const childGlobalState: GlobalBudgetState = {
				depth: context.depth + 1,
			}
			const depthCheck = checkGlobalBudgets(childGlobalState, guild.deployment.executor)
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
			const childCard = await runRole(deps, {
				...context,
				depth: context.depth + 1,
				roleName: childRoleName,
				task: childTask,
				parent: context.roleName,
				parentRoleId: registryEntry.roleId,
			})
			// The child is done: record its card on this frame's pending suspension and checkpoint, so a restart here resumes by delivering the recorded card instead of re-running the child. The card is delivered to the conversation by recordToolResult after this handler returns.
			deps.checkpointRecorder.setPendingChildCard(registryEntry.roleId, childCard)
			deps.checkpointRecorder.write()
			return childCard
		},
		roleState,
		humanBackend: deps.humanBackend,
		contextWindow: guild.deployment.model.contextWindow,
		roleRegistry: deps.roleRegistry,
		ownRoleId: registryEntry.roleId,
	})

	const handlers: Record<string, ToolHandler> = { ...builtInHandlers, ...deps.additionalToolHandlers }
	const dispatch = createToolDispatch(handlers)
	const dispatchCtx: DispatchContext = {
		dispatch,
		allowedTools: roleDefinition.tools,
		manifestNames: Object.keys(guild.tools),
		maxToolOutputChars: guild.deployment.contextPolicy.maxToolOutputChars,
	}

	const finalCard = await executeRoleLoop(deps, context, roleDefinition, roleState, registryEntry, allowedToolsManifests, dispatchCtx, guild.deployment.executor, resumed?.suspendedTurn)
	deps.roleRegistry.unregister(registryEntry.roleId)
	deps.checkpointRecorder.unregisterFrame(registryEntry.roleId)
	logEvent(deps.appendLog, 'role_finished', roleFinishedPayload(context.roleName, context.depth, finalCard, context.parent, registryEntry.roleId))
	return finalCard
}

// Dispatches a turn's tool calls in order, tracking agent suspensions on the checkpoint recorder so a checkpoint taken while a child runs captures where this role resumes. Shared by the live turn path (starting at 0) and the resumed-suspension path (starting after the agent call, whose result the resume already recorded).
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
		// An agent dispatch suspends this role mid-turn until the child returns; record the suspension so a checkpoint taken while the child runs captures where this role resumes. Cleared once the dispatch settles.
		if (toolCall.function.name === 'agent') {
			deps.checkpointRecorder.setPending(registryEntry.roleId, { toolCalls, agentIndex: index })
		}
		const finalCard = await dispatchAndRecord({ deps, roleState, roleName: context.roleName, ownRoleId: registryEntry.roleId, dispatchCtx, toolCall })
		if (toolCall.function.name === 'agent') {
			deps.checkpointRecorder.setPending(registryEntry.roleId, undefined)
		}
		if (finalCard !== null) return finalCard
	}
	return null
}

// Completes a resumed role's suspended turn: the child card is resolved (re-running the child frame's resume when the checkpoint has no recorded card), checkpointed onto the pending suspension exactly as the live role_finished path does, and recorded as the agent call's tool result — the agent_call event and the child's events are already in the log from the live dispatch. The turn's remaining tool calls then dispatch normally.
async function completeSuspendedTurn(deps: EngineDependencies, context: EngineContext, roleState: RoleState, registryEntry: RoleRegistryEntry, dispatchCtx: DispatchContext, suspendedTurn: SuspendedTurn): Promise<ResultCard | null> {
	const agentCall = suspendedTurn.toolCalls[suspendedTurn.agentIndex]
	if (agentCall === undefined) throw new Error(`completeSuspendedTurn: agentIndex ${suspendedTurn.agentIndex} out of range in a validated checkpoint`)
	const childCard = await suspendedTurn.resolveChildCard()
	deps.checkpointRecorder.setPendingChildCard(registryEntry.roleId, childCard)
	deps.checkpointRecorder.write()
	recordToolResult(deps, roleState, context.roleName, registryEntry.roleId, dispatchCtx.maxToolOutputChars, agentCall, { kind: 'success', data: childCard })
	deps.checkpointRecorder.setPending(registryEntry.roleId, undefined)
	return dispatchToolCallSequence(deps, context, roleState, registryEntry, dispatchCtx, suspendedTurn.toolCalls, suspendedTurn.agentIndex + 1)
}

// The role's turn loop, extracted from runRole so every exit emits exactly one role_finished at the runRole call site, guaranteeing the role_start/role_finished pairing regardless of which budget or finish path terminates the role.
async function executeRoleLoop(
	deps: EngineDependencies,
	context: EngineContext,
	roleDefinition: RoleDefinition,
	roleState: RoleState,
	registryEntry: RoleRegistryEntry,
	allowedToolsManifests: ToolManifest[],
	dispatchCtx: DispatchContext,
	config: ExecutorConfig,
	suspendedTurn?: SuspendedTurn,
): Promise<ResultCard> {
	if (suspendedTurn !== undefined) {
		const completedCard = await completeSuspendedTurn(deps, context, roleState, registryEntry, dispatchCtx, suspendedTurn)
		if (completedCard !== null) return completedCard
	}
	while (true) {
		const interruptCard = await drainInterrupts(runRole, deps, context, roleState, registryEntry, config)
		if (interruptCard !== null) return interruptCard

		// A queued overflow compaction runs first: the role's last request was rejected for context size and cannot succeed until the handler shrinks the history (or the naive backstop does when the handler fails).
		if (roleState.contextCompactionPending !== undefined) {
			const pending = roleState.contextCompactionPending
			roleState.contextCompactionPending = undefined
			const handlerCard = await runContextManagerHandler(runRole, deps, context, registryEntry, config, 'context_budget_exceeded', { promptTokens: pending.promptTokens, budgetTokens: pending.contextWindow })
			if (handlerCard.status === 'success') {
				roleState.history.push({ role: 'user', content: contextManagedNotice('context_budget_exceeded', handlerCard.summary) })
			} else {
				const backstopCard = applyContextBackstop(roleState, deps, context, pending)
				if (backstopCard !== null) return backstopCard
			}
		}

		// The pressure response lands at a turn boundary — after the previous turn's tool results — never between an assistant tool_calls message and its tool results, which is a malformed request on strict endpoints. The entry role has no parent to hand off to, so with a context handler configured the platform compacts it instead of sending the handoff notice (falling back to the notice when the handler fails); child roles get the append-only notice, which preserves the endpoint's prefix cache.
		if (roleState.contextPressureNotice === 'pending') {
			roleState.contextPressureNotice = 'sent'
			if (context.depth === 0 && config.contextHandlerRole !== undefined) {
				const handlerCard = await runContextManagerHandler(runRole, deps, context, registryEntry, config, 'context_pressure', { promptTokens: roleState.lastPromptTokens, budgetTokens: currentEffectiveBudget(context, deps) })
				if (handlerCard.status === 'success') {
					roleState.history.push({ role: 'user', content: contextManagedNotice('context_pressure', handlerCard.summary) })
				} else {
					roleState.history.push({ role: 'user', content: contextPressureNotice(roleState.lastPromptTokens, currentEffectiveBudget(context, deps)) })
				}
			} else {
				roleState.history.push({ role: 'user', content: contextPressureNotice(roleState.lastPromptTokens, currentEffectiveBudget(context, deps)) })
			}
		}

		// The safe point: no LLM call is in flight and every queued platform mutation (drain, compaction, pressure notice) has been applied, so the checkpoint written here is the state a restart resumes from. Only the active leaf reaches this — suspended ancestors are captured through their registered frames.
		deps.checkpointRecorder.write()

		const globalState: GlobalBudgetState = {
			depth: context.depth,
		}
		const globalError = checkGlobalBudgets(globalState, config)
		if (globalError !== null) {
			logEvent(deps.appendLog, 'global_budget_exceeded', { role: context.roleName, error: globalError })
			return createResultCard('error', 'Global budget exceeded', { error: globalError })
		}

		const roleBudgetState: RoleBudgetState = {
			recentCompactionPromptTokens: roleState.recentCompactionPromptTokens,
		}
		const roleError = checkRoleBudgets(roleBudgetState, config)
		if (roleError !== null) {
			logEvent(deps.appendLog, 'role_budget_exceeded', { role: context.roleName, error: roleError })
			return createResultCard('error', 'Role budget exceeded', { error: roleError })
		}

		const messages = buildMessages(roleDefinition, roleState.history)

		// llm_call_start marks the turn in flight the moment the request is dispatched, so the flow view can end the call's transit phase (flowing edge → solid) when the callee begins working rather than when the response completes.
		// It fires on every turn, including the paths that later fail (llm_unavailable / context_budget_exceeded): the turn started even if it never completed.
		// Only the role is carried; the full turn lands in llm_call once the response arrives.
		logEvent(deps.appendLog, 'llm_call_start', { role: context.roleName })

		const llmResult = await deps.llmCaller.call({
			messages,
			tools: allowedToolsManifests,
		})

		const handling = handleLlmResult(llmResult, roleState, deps, context, config)
		// llm_call is emitted after handleLlmResult so the sent message list, the received assistant response, finishReason, and per-call usage all land in one event. It is emitted only on the success paths (continue/tool_calls and success-finished): the llm_unavailable and context_budget_exceeded paths log their own dedicated events inside handleLlmResult and must not also emit a misleading llm_call.
		if (llmResult.kind === 'success') {
			logEvent(deps.appendLog, 'llm_call', llmCallPayload(context.roleName, messages, llmResult))
		}
		if (handling.kind === 'continue') continue
		if (handling.kind === 'finished') return handling.card

		const finalCard = await dispatchToolCallSequence(deps, context, roleState, registryEntry, dispatchCtx, handling.toolCalls, 0)
		if (finalCard !== null) return finalCard
	}
}
