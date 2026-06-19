import { createResultCard, createToolError } from '../shared/errors.js'
import type { ExecutorConfig, LogEvent, Message, ResultCard, RoleDefinition, ToolCall, ToolManifest, ToolResult } from '../shared/types.js'
import { isResultCard } from '../shared/validation.js'
import { checkGlobalBudgets, checkRoleBudgets, type GlobalBudgetState, type RoleBudgetState } from './budgets.js'
import { createBuiltInToolHandlers } from './builtin-tools.js'
import { buildMessages } from './context-builder.js'
import type { HumanBackend } from './human-backend.js'
import type { LlmCaller, LlmCallResult } from './llm.js'
import type { LoadedGuild } from './loader.js'
import type { AppendLog } from './persistence.js'
import { createToolDispatch, dispatchToolCall, type ToolDispatch, type ToolHandler } from './tool-dispatch.js'

export interface RoleState {
	history: Message[]
	toolCalls: number
	promptTokens: number
	completionTokens: number
	lastPromptTokens: number
	recentToolCalls: Array<{ name: string; argsHash: string }>
	recentCompactionPromptTokens: Array<number>
}

export interface EngineContext {
	loadedGuild: LoadedGuild
	depth: number
	startMs: number
	roleName: string
	task: string
	roleDefinitionOverride?: RoleDefinition
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

function hashArgs(args: string): string {
	let hash = 0
	for (let i = 0; i < args.length; i++) {
		const char = args.charCodeAt(i)
		hash = ((hash << 5) - hash + char) | 0
	}
	return hash.toString(36)
}

function serializeToolResult(result: ToolResult): string {
	if (result.kind === 'success') {
		return JSON.stringify(result.data ?? null)
	}
	return JSON.stringify({ kind: result.kind, message: result.message, details: result.details })
}

function logEvent(appendLog: AppendLog, type: string, payload: unknown): void {
	const event: LogEvent = {
		timestamp: new Date().toISOString(),
		type,
		payload,
	}
	appendLog(event)
}

function cloneRoleDefinitionWithBudget(base: RoleDefinition, override: { maxToolCalls?: number; maxTokens?: number }): RoleDefinition {
	const mergedBudget: { maxToolCalls?: number; maxTokens?: number } = {
		...(base.budget?.maxToolCalls !== undefined ? { maxToolCalls: base.budget.maxToolCalls } : {}),
		...(base.budget?.maxTokens !== undefined ? { maxTokens: base.budget.maxTokens } : {}),
		...(override.maxToolCalls !== undefined ? { maxToolCalls: override.maxToolCalls } : {}),
		...(override.maxTokens !== undefined ? { maxTokens: override.maxTokens } : {}),
	}
	const hasAnyBudget = mergedBudget.maxToolCalls !== undefined || mergedBudget.maxTokens !== undefined
	return {
		systemPrompt: base.systemPrompt,
		tools: base.tools.slice(),
		...(base.generation !== undefined ? { generation: { ...base.generation } } : {}),
		...(base.includeReasoning !== undefined ? { includeReasoning: base.includeReasoning } : {}),
		...(hasAnyBudget ? { budget: mergedBudget } : {}),
	}
}

function handleLlmResult(
	llmResult: LlmCallResult,
	roleState: RoleState,
	deps: EngineDependencies,
	roleDefinition: RoleDefinition,
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

	roleState.promptTokens += llmResult.usage.promptTokens
	roleState.completionTokens += llmResult.usage.completionTokens
	roleState.lastPromptTokens = llmResult.usage.promptTokens

	const postCallBudgetState: RoleBudgetState = {
		toolCalls: roleState.toolCalls,
		promptTokens: roleState.promptTokens,
		completionTokens: roleState.completionTokens,
		recentToolCalls: roleState.recentToolCalls,
		recentCompactionPromptTokens: roleState.recentCompactionPromptTokens,
	}
	const postCallBudgetError = checkRoleBudgets(postCallBudgetState, config, roleDefinition.budget)
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
	roleState.toolCalls++
	const argsHash = hashArgs(toolCall.function.arguments)

	const result = await dispatchToolCall(dispatchCtx, toolCall)

	if (result.kind === 'unknown_tool') {
		logEvent(deps.appendLog, 'unknown_tool', { role: roleName, tool: toolCall.function.name })
	} else if (result.kind === 'invalid_tool_call') {
		logEvent(deps.appendLog, 'invalid_tool_call', { role: roleName, tool: toolCall.function.name })
	} else {
		logEvent(deps.appendLog, 'tool_call', { role: roleName, tool: toolCall.function.name })
		logEvent(deps.appendLog, 'tool_result', { role: roleName, tool: toolCall.function.name, kind: result.kind })
		roleState.recentToolCalls.push({ name: toolCall.function.name, argsHash })
		if (roleState.recentToolCalls.length > 50) {
			roleState.recentToolCalls.shift()
		}
	}

	roleState.history.push({
		role: 'tool',
		content: serializeToolResult(result),
		tool_call_id: toolCall.id,
	})

	if (toolCall.function.name === 'finish' && result.kind === 'success' && isResultCard(result.data)) {
		return result.data
	}
	return null
}

export async function runRole(deps: EngineDependencies, context: EngineContext): Promise<ResultCard> {
	const guild = context.loadedGuild
	const roleDefinition = context.roleDefinitionOverride ?? guild.config.roles[context.roleName]

	if (roleDefinition === undefined) {
		logEvent(deps.appendLog, 'role_not_found', { roleName: context.roleName })
		return createResultCard('error', `Unknown role: ${context.roleName}`, {
			error: createToolError('unknown_tool', `Unknown role: ${context.roleName}`),
		})
	}

	const systemPrompt = guild.prompts[context.roleName] ?? ''

	const allowedToolsManifests: ToolManifest[] = []
	for (const toolName of roleDefinition.tools) {
		const manifest = guild.tools[toolName]
		if (manifest !== undefined) {
			allowedToolsManifests.push(manifest)
		}
	}

	const roleState: RoleState = {
		history: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: context.task },
		],
		toolCalls: 0,
		promptTokens: 0,
		completionTokens: 0,
		lastPromptTokens: 0,
		recentToolCalls: [],
		recentCompactionPromptTokens: [],
	}

	const builtInHandlers = createBuiltInToolHandlers({
		spawnAgent: async (childRoleName, childTask, budget) => {
			const childGlobalState: GlobalBudgetState = {
				startMs: context.startMs,
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
			const override = budget !== undefined ? cloneRoleDefinitionWithBudget(childDefinition, budget) : undefined
			return await runRole(deps, {
				...context,
				depth: context.depth + 1,
				roleName: childRoleName,
				task: childTask,
				...(override !== undefined ? { roleDefinitionOverride: override } : {}),
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

	while (true) {
		const globalState: GlobalBudgetState = {
			startMs: context.startMs,
			depth: context.depth,
		}
		const globalError = checkGlobalBudgets(globalState, guild.config.executor)
		if (globalError !== null) {
			logEvent(deps.appendLog, 'global_budget_exceeded', { role: context.roleName, error: globalError })
			return createResultCard('error', 'Global budget exceeded', { error: globalError })
		}

		const roleBudgetState: RoleBudgetState = {
			toolCalls: roleState.toolCalls,
			promptTokens: roleState.promptTokens,
			completionTokens: roleState.completionTokens,
			recentToolCalls: roleState.recentToolCalls,
			recentCompactionPromptTokens: roleState.recentCompactionPromptTokens,
		}
		const roleError = checkRoleBudgets(roleBudgetState, guild.config.executor, roleDefinition.budget)
		if (roleError !== null) {
			logEvent(deps.appendLog, 'role_budget_exceeded', { role: context.roleName, error: roleError })
			return createResultCard('error', 'Role budget exceeded', { error: roleError })
		}

		const messages = buildMessages(roleDefinition, roleState.history)

		logEvent(deps.appendLog, 'llm_call', { role: context.roleName, messageCount: messages.length })
		const llmResult = await deps.llmCaller.call({
			messages,
			tools: allowedToolsManifests,
		})

		const handling = handleLlmResult(llmResult, roleState, deps, roleDefinition, context, guild.config.executor)
		if (handling.kind === 'continue') continue
		if (handling.kind === 'finished') return handling.card

		for (const toolCall of handling.toolCalls) {
			const finalCard = await dispatchAndRecord({ deps, roleState, roleName: context.roleName, dispatchCtx, toolCall })
			if (finalCard !== null) {
				logEvent(deps.appendLog, 'role_finished', { role: context.roleName, status: finalCard.status })
				return finalCard
			}
		}
	}
}