import { createResultCard, createToolError } from './errors.js'
import { effortDirective } from './effort.js'
import type { EffortLevel, ExecutorConfig, LogEvent, Message, ResultCard, RoleDefinition, ToolCall, ToolManifest, ToolResult } from './types.js'
import { isResultCard } from './validation.js'
import { checkGlobalBudgets, checkRoleBudgets, type GlobalBudgetState, type RoleBudgetState } from './budgets.js'
import { createBuiltInToolHandlers } from './builtin-tools.js'
import { buildMessages } from './context-builder.js'
import { compactHistoryForContextBudget, truncateToolOutput, type ContextCompactionReport } from './context-policy.js'
import { DEFAULT_CONTEXT_PRESSURE_THRESHOLD, effectiveContextBudget, recordContextRejection, type ContextPressureTracker } from './context-pressure.js'
import type { HumanBackend } from './human-backend.js'
import type { InterruptQueue, InterruptRequest } from './interrupts.js'
import type { LlmCaller, LlmCallResult } from './llm.js'
import type { LoadedGuild } from './loader.js'
import type { AppendLog } from './persistence.js'
import { hashArguments, RECENT_TOOL_CALLS_LIMIT, type RecentToolCall } from './role-inspection.js'
import type { RoleRegistry, RoleRegistryEntry } from './role-registry.js'
import { createToolDispatch, dispatchToolCall, type ToolDispatch, type ToolHandler } from './tool-dispatch.js'

export interface RoleState {
	history: Message[]
	lastPromptTokens: number
	recentCompactionPromptTokens: Array<number>
	recentToolCalls: RecentToolCall[]
	toolCallCount: number
	generatedTokens: number
	// Consecutive endpoint rejections for context size, reset on the first successful call. Bounds the compact-and-retry loop so a role whose request cannot be made to fit finishes with an error instead of retrying forever.
	contextExceededAttempts: number
	// The counts at which the last loop check fired; the next check fires when a count passes its watermark plus the (effort-scaled) threshold.
	loopCheckToolCallWatermark: number
	loopCheckTokenWatermark: number
	// Context-pressure handoff state, one-shot per role instance: set to 'pending' when reported usage crosses the threshold, flipped to 'sent' when the notice is appended at the next turn boundary, and never re-armed after that — the notice asks the role to write its handoff brief and finish.
	contextPressureNotice?: 'pending' | 'sent'
	// Set when a context-window rejection must be answered by the context handler: the rejection is detected mid-turn (in handleLlmResult), but a handler can only run at the safe point, so the rejection details park here until the next loop top. Cleared once the handler (or the naive fallback) has run.
	contextCompactionPending?: { promptTokens: number; contextWindow: number }
}

export interface EngineContext {
	loadedGuild: LoadedGuild
	depth: number
	roleName: string
	task: string
	// The run's effort, set only on the entry-role context by runExecutor. The agent spawn spreads the context to children, but the directive is gated on depth 0 below, so children never receive a global effort directive — the parent decides how to translate effort into delegation instructions.
	effort?: EffortLevel
	// The calling role's name, omitted for the entry role at depth 0 so a reviewer can distinguish a root role from a child and render.ts can build the parent→child tree.
	parent?: string
	// The calling role's instance id, omitted for the entry role. Lets the interrupt platform walk the live delegation chain (plan-modification routing).
	parentRoleId?: string
	// Set when this invocation is an interrupt handler serving the named target instance: the drain point skips the handler so a handler can never interrupt itself or consume operator requests meant for real work roles.
	handlerOf?: string
}

export interface EngineDependencies {
	llmCaller: LlmCaller
	appendLog: AppendLog
	additionalToolHandlers: Record<string, ToolHandler>
	humanBackend: HumanBackend
	roleRegistry: RoleRegistry
	interruptQueue: InterruptQueue
	// The run's learned context ceiling, shared across roles so one role's wall-hit tightens every role's pressure threshold. Created per run by runExecutor.
	contextPressureTracker: ContextPressureTracker
}

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

function logEvent(appendLog: AppendLog, type: string, payload: unknown): void {
	const event: LogEvent = {
		timestamp: new Date().toISOString(),
		type,
		payload,
	}
	appendLog(event)
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

// The recovery loop for a context-window rejection: each rejection compacts with a fresh endpoint-reported token count, so the estimate recalibrates on every attempt. Three attempts give the estimate room to converge without letting a hopeless request spin.
const MAX_CONTEXT_RECOVERY_ATTEMPTS = 3
// Compact to this fraction of the window, leaving headroom for estimator error and the completion reservation.
const CONTEXT_RECOVERY_TARGET_FRACTION = 0.7

// The platform notice a role receives after the executor compacted its conversation following a context-window rejection. It is a user message, not a synthetic tool result: on OpenAI-compatible endpoints a tool message must answer an assistant tool_call, so an orphan tool message would make the recovery request itself a malformed 400.
function contextRecoveryNotice(llmResult: { promptTokens: number; contextWindow: number }, report: ContextCompactionReport): string {
	const sizePart = llmResult.promptTokens > 0 ? ` (~${llmResult.promptTokens} prompt tokens vs window ${llmResult.contextWindow})` : ` (window ${llmResult.contextWindow} tokens)`
	return [
		`[Platform notice — context window exceeded] Your last request to the model was rejected because this conversation had grown past the model's context window${sizePart}.`,
		`The platform compacted this conversation so work can continue: it dropped ${report.droppedMessages} older messages, truncated ${report.truncatedToolMessages} oversized tool results, and cleared reasoning on ${report.strippedReasoningMessages} messages; the estimated prompt size is now ~${report.estimatedPromptTokens} tokens.`,
		'Your system prompt, your original task, and your most recent messages are intact.',
		'Continue from your most recent state; re-read files or re-run commands if you need information that was removed.',
		'If the task cannot be completed without the removed context, call finish with status "error" and error.kind "context_budget_exceeded" so the work can be re-delegated in smaller pieces.',
	].join(' ')
}

// The notice a role receives after the context handler compacted its conversation. Unlike the naive backstop's notice there are no drop counts to report — the handler chose what to remove, and its own summary says what.
function contextManagedNotice(trigger: 'context_pressure' | 'context_budget_exceeded', summary: string): string {
	const reason = trigger === 'context_pressure'
		? 'your conversation crossed the platform\'s context-pressure threshold'
		: 'your last request to the model was rejected because this conversation had grown past the context window'
	return [
		`[Platform notice — context compacted] The platform paused you and the context manager compacted this conversation because ${reason}.`,
		`The context manager reports: ${summary}`,
		'Your system prompt, your original task, and your most recent messages should be intact.',
		'Continue from your most recent state; re-read files or re-run commands if you need information that was removed.',
	].join(' ')
}

function contextExceededCard(reason: string): { kind: 'finished'; card: ResultCard } {
	return {
		kind: 'finished',
		card: createResultCard('error', reason, { error: createToolError('context_budget_exceeded', reason) }),
	}
}

// The naive in-place backstop for a context-window rejection: strip reasoning, drop the oldest turns, truncate oversized surviving tool results, then resume with a platform notice. Returns the terminal card when even the undeletable remainder cannot fit, null when the compacted role may continue. Used directly when no context handler is configured, and as the fallback when the handler cannot do better.
function applyContextBackstop(roleState: RoleState, deps: EngineDependencies, context: EngineContext, rejection: { promptTokens: number; contextWindow: number }): ResultCard | null {
	const report = compactHistoryForContextBudget(roleState.history, {
		contextWindow: rejection.contextWindow,
		promptTokens: rejection.promptTokens,
		targetFraction: CONTEXT_RECOVERY_TARGET_FRACTION,
	})
	roleState.history = report.history
	if (!report.fits) {
		return createResultCard('error', 'Context window exceeded and the conversation cannot be compacted enough to continue', {
			error: createToolError('context_budget_exceeded', 'Context window exceeded and the conversation cannot be compacted enough to continue'),
		})
	}
	logEvent(deps.appendLog, 'context_compacted', {
		role: context.roleName,
		droppedMessages: report.droppedMessages,
		truncatedToolMessages: report.truncatedToolMessages,
		strippedReasoningMessages: report.strippedReasoningMessages,
		estimatedPromptTokens: report.estimatedPromptTokens,
		contextWindow: rejection.contextWindow,
	})
	roleState.history.push({ role: 'user', content: contextRecoveryNotice(rejection, report) })
	return null
}

// The effective budget a role's reported prompt size is measured against: the static math (window minus the reserved completion budget) tightened by whatever the run has learned from endpoint rejections.
function currentEffectiveBudget(context: EngineContext, deps: EngineDependencies): number {
	const modelConfig = context.loadedGuild.config.model
	return effectiveContextBudget(modelConfig.contextWindow, modelConfig.generation.maxTokens ?? 0, deps.contextPressureTracker.learnedCeiling)
}

// The one-shot notice a role receives when its reported prompt size crosses the pressure threshold, asking it to hand off while it still has its full context — the working agent is the best-qualified summarizer of its own work, and a fresh small conversation is the cache-cheapest continuation. The entry role's own prompt teaches it to read the notice as "wrap the run toward a resumable checkpoint" instead, since no parent can re-spawn it.
function contextPressureNotice(promptTokens: number, effectiveBudget: number): string {
	const percent = effectiveBudget > 0 ? Math.round((100 * promptTokens) / effectiveBudget) : 100
	return [
		`[Platform notice — context pressure] Your conversation has reached ${percent}% of the effective context budget (~${promptTokens} prompt tokens of ~${effectiveBudget}).`,
		'Do not start new major work.',
		'At the next safe point, call finish with status "error" and error.kind "context_handoff", and write the summary as a handoff brief for the fresh agent that will replace you: what is done, what remains, key file paths, decisions made, and the immediate next step.',
	].join(' ')
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
	dispatchCtx: DispatchContext
	toolCall: ToolCall
}

async function dispatchAndRecord({ deps, roleState, roleName, dispatchCtx, toolCall }: DispatchAndRecordArgs): Promise<ResultCard | null> {
	const result = await dispatchToolCall(dispatchCtx, toolCall)

	if (result.kind === 'unknown_tool') {
		logEvent(deps.appendLog, 'unknown_tool', { role: roleName, tool: toolCall.function.name })
	} else if (result.kind === 'invalid_tool_call') {
		logEvent(deps.appendLog, 'invalid_tool_call', { role: roleName, tool: toolCall.function.name })
	} else {
		// tool_call carries the model's raw arguments string so the exact parameters are recoverable, and tool_result carries the full un-truncated ToolResult so a reviewer is not flying blind on what a tool actually returned. Truncation still applies only when the result is appended to the conversation below.
		logEvent(deps.appendLog, 'tool_call', { role: roleName, tool: toolCall.function.name, arguments: toolCall.function.arguments })
		logEvent(deps.appendLog, 'tool_result', { role: roleName, tool: toolCall.function.name, kind: result.kind, result })
	}

	roleState.history.push({
		role: 'tool',
		content: serializeToolResult(result, dispatchCtx.maxToolOutputChars),
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

// Assembles a role's first messages: the system prompt, then the user task.
// The entry role (depth 0) additionally receives the effort directive appended to the system prompt, so prompts can branch on the run's quality level. The directive is merged into the single system message rather than emitted as a second one: many model chat templates (Gemma-family and others) reject a `system` message that is not the first message, so two consecutive system messages would break those endpoints. Child roles never receive the directive — the depth-0 gate ensures it even though the agent spawn copies the context — leaving the parent to translate effort into delegation instructions.
function buildInitialHistory(systemPrompt: string, context: EngineContext): Message[] {
	let systemContent = systemPrompt
	if (context.depth === 0 && context.effort !== undefined) {
		systemContent = `${systemPrompt}\n\n${effortDirective(context.effort)}`
	}
	const history: Message[] = [{ role: 'system', content: systemContent }]
	history.push({ role: 'user', content: context.task })
	return history
}

// The marker prefixes the orchestrator/planner prompts teach roles to recognize. An inquiry goes to the run's entry role (the chain root), which answers from its run-wide knowledge — delegating to a fresh sub-agent when the answer needs detail from in-flight work; a plan modification arrives only after active sub-work beneath the plan owner was aborted and asks the owner to re-plan around the change.
function inquiryMessage(message: string): string {
	return `[Operator inquiry — the operator is asking you a direct question about the run. Answer it promptly in plain language: if you already know, answer in your immediate next response; if the answer needs detail from a sub-agent's in-flight work, first delegate a fresh sub-agent to gather it, then give the answer. Do not skip the answer; when you have given it, continue coordinating the run.]\n\n${message}`
}

function planModificationMessage(message: string): string {
	return `[Operator plan modification — active sub-work below you was aborted; integrate this change into your plan and re-delegate, continue, or finish]\n\n${message}`
}

function interruptedCard(summary: string): ResultCard {
	return createResultCard('error', summary, { error: createToolError('interrupted', summary) })
}

// Walks the live delegation chain from the given entry up to the run's root, self first. Every ancestor is still registered because each is suspended in its `agent` tool call awaiting the descendant beneath it.
function chainFromEntry(registry: RoleRegistry, entry: RoleRegistryEntry): RoleRegistryEntry[] {
	const chain: RoleRegistryEntry[] = [entry]
	let current = entry
	while (current.parentRoleId !== undefined) {
		const parent = registry.lookup(current.parentRoleId)
		if (parent === undefined) break
		chain.push(parent)
		current = parent
	}
	return chain
}

// Applies a queued operator request. An inquiry is injected into the chain root's (the entry role's) history as a marked user message, so the answer comes from the role that owns the run-wide picture — it lands in the root's frozen history immediately but is read when control next returns to the root (the active leaf keeps working undisturbed). A plan modification marks every chain member below the plan owner (the rootmost chain instance of the configured planOwnerRole, else the chain root) for abort and the owner for injection; the marked roles then unwind one safe point at a time as the agent-call result-card propagation reaches them — the same unwind a child error card already drives, triggered here by an external request.
function routeOperatorInterrupt(
	deps: EngineDependencies,
	roleState: RoleState,
	entry: RoleRegistryEntry,
	config: ExecutorConfig,
	request: InterruptRequest,
): ResultCard | null {
	if (request.kind === 'inquiry') {
		const chain = chainFromEntry(deps.roleRegistry, entry)
		const root = chain[chain.length - 1]
		if (root === undefined) return null
		root.roleState.history.push({ role: 'user', content: inquiryMessage(request.message) })
		logEvent(deps.appendLog, 'operator_inquiry', { role: root.roleName, roleId: root.roleId, message: request.message })
		return null
	}
	const chain = chainFromEntry(deps.roleRegistry, entry)
	const planOwnerRole = config.interruptTriggers?.planOwnerRole
	let target = chain[chain.length - 1]
	if (target === undefined) return null
	if (planOwnerRole !== undefined) {
		for (const candidate of chain) {
			if (candidate.roleName === planOwnerRole) target = candidate
		}
	}
	const aborted: string[] = []
	for (const member of chain) {
		if (member.roleId === target.roleId) break
		member.planAbort = true
		aborted.push(member.roleId)
	}
	target.planInjection = request.message
	logEvent(deps.appendLog, 'plan_modification', { target: target.roleId, targetRole: target.roleName, message: request.message, aborted })
	if (entry.planAbort === true) {
		return interruptedCard('Aborted by an operator plan modification')
	}
	if (entry.planInjection !== undefined) {
		entry.planInjection = undefined
		roleState.history.push({ role: 'user', content: planModificationMessage(request.message) })
	}
	return null
}

// Suspends the active role and invokes the guild-configured handler role against its frozen (registered) state, then applies the handler's trigger_interrupt action: continue resumes unchanged, redirect resumes with the handler's message already injected (by the tool) into the target's history, abort finishes the target with a loop_detected card. The interrupt event lands immediately before the handler's role_start so the interaction model roots the handler under a fresh interrupt participant.
async function runInterruptHandler(
	deps: EngineDependencies,
	context: EngineContext,
	entry: RoleRegistryEntry,
	handlerRole: string,
	config: ExecutorConfig,
): Promise<ResultCard | null> {
	const task = [
		`The platform flagged role instance "${entry.roleId}" (role "${context.roleName}") for a loop check.`,
		`It has made ${entry.roleState.toolCallCount} tool calls and generated ${entry.roleState.generatedTokens} tokens so far.`,
		'Investigate whether it is stuck in a loop, then call trigger_interrupt with that role-instance id and your decision.',
	].join(' ')
	logEvent(deps.appendLog, 'interrupt', { trigger: 'loop_check', handler: handlerRole, target: entry.roleId })
	const handlerCard = await runRole(deps, {
		...context,
		depth: Math.min(context.depth + 1, config.maxAgentDepth),
		roleName: handlerRole,
		task,
		parent: context.roleName,
		parentRoleId: entry.roleId,
		handlerOf: entry.roleId,
	})
	const action = entry.interruptAction
	entry.interruptAction = undefined
	if (action === undefined) {
		// A handler that finishes without calling trigger_interrupt decides nothing; the target resumes unchanged. The handler's own outcome is logged for the reviewer.
		logEvent(deps.appendLog, 'interrupt_resolved', { trigger: 'loop_check', handler: handlerRole, target: entry.roleId, action: 'continue', handlerStatus: handlerCard.status })
		return null
	}
	logEvent(deps.appendLog, 'interrupt_resolved', { trigger: 'loop_check', handler: handlerRole, target: entry.roleId, action: action.action })
	if (action.action === 'abort') {
		const summary = action.reason !== '' ? action.reason : 'Aborted by the loop-check handler'
		return createResultCard('error', summary, { error: createToolError('loop_detected', action.reason) })
	}
	return null
}

// Suspends the role and invokes the configured context handler against its frozen (registered) state — the same preempt-and-resume interlude as the loop-check handler, so it logs the same interrupt/interrupt_resolved pair and the interaction model roots the handler on a fresh interrupt stack. The target always resumes afterwards: a successful handler leaves a compacted history; a failed one leaves the history untouched and the caller falls back (the handoff notice at depth 0, the naive backstop at the wall).
async function runContextManagerHandler(
	deps: EngineDependencies,
	context: EngineContext,
	entry: RoleRegistryEntry,
	config: ExecutorConfig,
	trigger: 'context_pressure' | 'context_budget_exceeded',
	reported: { promptTokens: number; budgetTokens: number },
): Promise<ResultCard> {
	const handlerRole = config.contextHandlerRole
	if (handlerRole === undefined) throw new Error('runContextManagerHandler called without executor.contextHandlerRole configured')
	const task = trigger === 'context_pressure'
		? [
			`The platform flagged role instance "${entry.roleId}" (role "${context.roleName}"): its conversation crossed the context-pressure threshold (${reported.promptTokens} reported prompt tokens against an effective budget of ${reported.budgetTokens}).`,
			`Compact its conversation now: inspect it with list_role_messages, read_message_window, and search_role_blocks, prune it with edit_context (targetRole "${entry.roleId}"), confirm the reduction with context_info (targetRole "${entry.roleId}"), then call finish.`,
			'It resumes its work when you finish, so preserve what it needs to continue.',
		].join(' ')
		: [
			`Role instance "${entry.roleId}" (role "${context.roleName}") had a request rejected by the model endpoint for exceeding the context window (${reported.promptTokens} reported prompt tokens against a window of ${reported.budgetTokens}). Its next request fails again unless the conversation shrinks decisively.`,
			`Compact its conversation now: inspect it with list_role_messages, read_message_window, and search_role_blocks, prune it with edit_context (targetRole "${entry.roleId}"), confirm the reduction with context_info (targetRole "${entry.roleId}"), then call finish.`,
			'It resumes its work when you finish, so preserve what it needs to continue.',
		].join(' ')
	logEvent(deps.appendLog, 'interrupt', { trigger, handler: handlerRole, target: entry.roleId })
	const handlerCard = await runRole(deps, {
		...context,
		depth: Math.min(context.depth + 1, config.maxAgentDepth),
		roleName: handlerRole,
		task,
		parent: context.roleName,
		parentRoleId: entry.roleId,
		handlerOf: entry.roleId,
	})
	if (handlerCard.status === 'success') {
		logEvent(deps.appendLog, 'interrupt_resolved', { trigger, handler: handlerRole, target: entry.roleId, action: 'compacted' })
	} else {
		logEvent(deps.appendLog, 'interrupt_resolved', { trigger, handler: handlerRole, target: entry.roleId, action: 'failed', handlerStatus: handlerCard.status })
	}
	return handlerCard
}

// The platform's single safe point, run at the top of every turn: no LLM call is in flight here, so suspending or unwinding the role cannot tear a turn. Returns a ResultCard when the role must finish, or null to continue the turn.
// Order: marks set by an earlier routing first, then (for non-handler roles only) the loop-check cadence, then one queued operator request.
async function drainInterrupts(
	deps: EngineDependencies,
	context: EngineContext,
	roleState: RoleState,
	entry: RoleRegistryEntry,
	config: ExecutorConfig,
): Promise<ResultCard | null> {
	if (entry.planAbort === true) {
		return interruptedCard('Aborted by an operator plan modification')
	}
	if (entry.planInjection !== undefined) {
		const message = entry.planInjection
		entry.planInjection = undefined
		roleState.history.push({ role: 'user', content: planModificationMessage(message) })
	}

	if (context.handlerOf !== undefined) return null

	const triggers = config.interruptTriggers
	if (triggers !== undefined && context.roleName !== triggers.handlerRole) {
		const scale = (context.effort ?? 0) + 1
		const toolCallThreshold = triggers.everyToolCalls * scale
		const tokenThreshold = triggers.everyTokens * scale
		const fireOnToolCalls = roleState.toolCallCount >= roleState.loopCheckToolCallWatermark + toolCallThreshold
		const fireOnTokens = roleState.generatedTokens >= roleState.loopCheckTokenWatermark + tokenThreshold
		if (fireOnToolCalls || fireOnTokens) {
			roleState.loopCheckToolCallWatermark = roleState.toolCallCount
			roleState.loopCheckTokenWatermark = roleState.generatedTokens
			const abortCard = await runInterruptHandler(deps, context, entry, triggers.handlerRole, config)
			if (abortCard !== null) return abortCard
		}
	}

	const request = deps.interruptQueue.drain()
	if (request !== undefined) {
		const routedCard = routeOperatorInterrupt(deps, roleState, entry, config, request)
		if (routedCard !== null) return routedCard
	}
	return null
}

export async function runRole(deps: EngineDependencies, context: EngineContext): Promise<ResultCard> {
	const guild = context.loadedGuild
	const roleDefinition = guild.config.roles[context.roleName]

	if (roleDefinition === undefined) {
		logEvent(deps.appendLog, 'role_not_found', { roleName: context.roleName })
		return createResultCard('error', `Unknown role: ${context.roleName}`, {
			error: createToolError('unknown_tool', `Unknown role: ${context.roleName}`),
		})
	}

	const systemPrompt = guild.prompts[context.roleName] ?? ''

	const roleState: RoleState = {
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

	const registryEntry = deps.roleRegistry.register(context.roleName, context.depth, context.parentRoleId, roleState)

	// role_start is emitted after the role definition is confirmed to exist and the instance is registered, so an unknown entry role still fires role_not_found without leaving an orphan role_start, and the event can carry the instance id the interrupt platform targets. The depth and optional parent let render.ts reconstruct the parent→child tree.
	const roleStartPayload: Record<string, unknown> = {
		role: context.roleName,
		roleId: registryEntry.roleId,
		depth: context.depth,
		task: context.task,
	}
	if (context.parent !== undefined) roleStartPayload['parent'] = context.parent
	logEvent(deps.appendLog, 'role_start', roleStartPayload)

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
			const depthCheck = checkGlobalBudgets(childGlobalState, guild.config.executor)
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
			return await runRole(deps, {
				...context,
				depth: context.depth + 1,
				roleName: childRoleName,
				task: childTask,
				parent: context.roleName,
				parentRoleId: registryEntry.roleId,
			})
		},
		roleState,
		humanBackend: deps.humanBackend,
		contextWindow: guild.config.model.contextWindow,
		roleRegistry: deps.roleRegistry,
		ownRoleId: registryEntry.roleId,
	})

	const handlers: Record<string, ToolHandler> = { ...builtInHandlers, ...deps.additionalToolHandlers }
	const dispatch = createToolDispatch(handlers)
	const dispatchCtx: DispatchContext = {
		dispatch,
		allowedTools: roleDefinition.tools,
		manifestNames: Object.keys(guild.tools),
		maxToolOutputChars: guild.config.contextPolicy.maxToolOutputChars,
	}

	const finalCard = await executeRoleLoop(deps, context, roleDefinition, roleState, registryEntry, allowedToolsManifests, dispatchCtx, guild.config.executor)
	deps.roleRegistry.unregister(registryEntry.roleId)
	logEvent(deps.appendLog, 'role_finished', roleFinishedPayload(context.roleName, context.depth, finalCard, context.parent, registryEntry.roleId))
	return finalCard
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
): Promise<ResultCard> {
	while (true) {
		const interruptCard = await drainInterrupts(deps, context, roleState, registryEntry, config)
		if (interruptCard !== null) return interruptCard

		// A queued overflow compaction runs first: the role's last request was rejected for context size and cannot succeed until the handler shrinks the history (or the naive backstop does when the handler fails).
		if (roleState.contextCompactionPending !== undefined) {
			const pending = roleState.contextCompactionPending
			roleState.contextCompactionPending = undefined
			const handlerCard = await runContextManagerHandler(deps, context, registryEntry, config, 'context_budget_exceeded', { promptTokens: pending.promptTokens, budgetTokens: pending.contextWindow })
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
				const handlerCard = await runContextManagerHandler(deps, context, registryEntry, config, 'context_pressure', { promptTokens: roleState.lastPromptTokens, budgetTokens: currentEffectiveBudget(context, deps) })
				if (handlerCard.status === 'success') {
					roleState.history.push({ role: 'user', content: contextManagedNotice('context_pressure', handlerCard.summary) })
				} else {
					roleState.history.push({ role: 'user', content: contextPressureNotice(roleState.lastPromptTokens, currentEffectiveBudget(context, deps)) })
				}
			} else {
				roleState.history.push({ role: 'user', content: contextPressureNotice(roleState.lastPromptTokens, currentEffectiveBudget(context, deps)) })
			}
		}

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

		for (const toolCall of handling.toolCalls) {
			const finalCard = await dispatchAndRecord({ deps, roleState, roleName: context.roleName, dispatchCtx, toolCall })
			if (finalCard !== null) return finalCard
		}
	}
}
