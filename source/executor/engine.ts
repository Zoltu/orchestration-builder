import { createResultCard, createToolError } from './errors.js'
import { effortDirective } from './effort.js'
import type { EffortLevel, ExecutorConfig, LogEvent, Message, ResultCard, RoleDefinition, ToolCall, ToolManifest, ToolResult } from './types.js'
import { isResultCard } from './validation.js'
import { checkGlobalBudgets, checkRoleBudgets, type GlobalBudgetState, type RoleBudgetState } from './budgets.js'
import { createBuiltInToolHandlers } from './builtin-tools.js'
import { buildMessages } from './context-builder.js'
import { truncateToolOutput } from './context-policy.js'
import type { HumanBackend } from './human-backend.js'
import type { LlmCaller, LlmCallResult } from './llm.js'
import type { LoadedGuild } from './loader.js'
import type { AppendLog } from './persistence.js'
import { createToolDispatch, dispatchToolCall, type ToolDispatch, type ToolHandler } from './tool-dispatch.js'

export interface RoleState {
	history: Message[]
	lastPromptTokens: number
	recentCompactionPromptTokens: Array<number>
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
}

export interface EngineDependencies {
	llmCaller: LlmCaller
	appendLog: AppendLog
	additionalToolHandlers: Record<string, ToolHandler>
	humanBackend: HumanBackend
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

// Builds the role_finished payload, extending the legacy {role, status} with depth, an optional parent, and the result-card summary/error so render.ts can build the parent→child tree and a reviewer reading only log.jsonl can see why a role finished (especially why it errored — without this, an erroring role's explanation lives only on the returned ResultCard / meta.json, never in the log stream).
// The added fields are additive: existing readers that read only role/status keep working.
function roleFinishedPayload(roleName: string, depth: number, card: ResultCard, parent: string | undefined): unknown {
	const payload: Record<string, unknown> = { role: roleName, depth, status: card.status }
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
		logEvent(deps.appendLog, 'context_budget_exceeded', {
			role: context.roleName,
			promptTokens: llmResult.promptTokens,
			contextWindow: llmResult.contextWindow,
		})
		roleState.history.push({
			role: 'tool',
			content: JSON.stringify({
				kind: 'context_budget_exceeded',
				promptTokens: llmResult.promptTokens,
				contextWindow: llmResult.contextWindow,
			}),
			tool_call_id: 'context_budget_exceeded',
		})
		return { kind: 'continue' }
	}

	roleState.lastPromptTokens = llmResult.usage.promptTokens

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

export async function runRole(deps: EngineDependencies, context: EngineContext): Promise<ResultCard> {
	const guild = context.loadedGuild
	const roleDefinition = guild.config.roles[context.roleName]

	if (roleDefinition === undefined) {
		logEvent(deps.appendLog, 'role_not_found', { roleName: context.roleName })
		return createResultCard('error', `Unknown role: ${context.roleName}`, {
			error: createToolError('unknown_tool', `Unknown role: ${context.roleName}`),
		})
	}

	// role_start is emitted after the role definition is confirmed to exist, so an unknown entry role still fires role_not_found without leaving an orphan role_start. The depth and optional parent let render.ts reconstruct the parent→child tree.
	const roleStartPayload: Record<string, unknown> = {
		role: context.roleName,
		depth: context.depth,
		task: context.task,
	}
	if (context.parent !== undefined) roleStartPayload['parent'] = context.parent
	logEvent(deps.appendLog, 'role_start', roleStartPayload)

	const systemPrompt = guild.prompts[context.roleName] ?? ''

	const allowedToolsManifests: ToolManifest[] = []
	for (const toolName of roleDefinition.tools) {
		const manifest = guild.tools[toolName]
		if (manifest !== undefined) {
			allowedToolsManifests.push(manifest)
		}
	}

	const roleState: RoleState = {
		history: buildInitialHistory(systemPrompt, context),
		lastPromptTokens: 0,
		recentCompactionPromptTokens: [],
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
			})
		},
		roleState,
		humanBackend: deps.humanBackend,
		contextWindow: guild.config.model.contextWindow,
	})

	const handlers: Record<string, ToolHandler> = { ...builtInHandlers, ...deps.additionalToolHandlers }
	const dispatch = createToolDispatch(handlers)
	const dispatchCtx: DispatchContext = {
		dispatch,
		allowedTools: roleDefinition.tools,
		manifestNames: Object.keys(guild.tools),
		maxToolOutputChars: guild.config.contextPolicy.maxToolOutputChars,
	}

	const finalCard = await executeRoleLoop(deps, context, roleDefinition, roleState, allowedToolsManifests, dispatchCtx, guild.config.executor)
	logEvent(deps.appendLog, 'role_finished', roleFinishedPayload(context.roleName, context.depth, finalCard, context.parent))
	return finalCard
}

// The role's turn loop, extracted from runRole so every exit emits exactly one role_finished at the runRole call site, guaranteeing the role_start/role_finished pairing regardless of which budget or finish path terminates the role.
async function executeRoleLoop(
	deps: EngineDependencies,
	context: EngineContext,
	roleDefinition: RoleDefinition,
	roleState: RoleState,
	allowedToolsManifests: ToolManifest[],
	dispatchCtx: DispatchContext,
	config: ExecutorConfig,
): Promise<ResultCard> {
	while (true) {
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
