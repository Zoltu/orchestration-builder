import { createToolError, isErrorKind } from './errors.js'
import type { Message, ResultCard, ToolResult } from './types.js'
import { stripReasoning } from './context-policy.js'
import { indexRoleMessages, readMessageWindow, searchRoleBlocks, MAX_SEARCH_MATCHES, RECENT_TOOL_CALLS_LIMIT, type InspectionField, type RecentToolCall } from './role-inspection.js'
import type { InterruptActionKind, RoleRegistry, RoleRegistryEntry } from './role-registry.js'
import { isObject } from './validation.js'
import type { ToolHandler } from './tool-dispatch.js'
import type { HumanBackend } from './human-backend.js'
import type { RoleState } from './engine.js'

export interface BuiltInToolContext {
	spawnAgent(roleName: string, task: string): Promise<ResultCard>
	roleState: RoleState
	humanBackend: HumanBackend
	contextWindow: number
	roleRegistry: RoleRegistry
}

interface FinishValidationSuccess {
	kind: 'success'
	card: ResultCard
}

interface FinishValidationError {
	kind: 'error'
	result: ToolResult
}

function validateFinishArgs(args: Record<string, unknown>): FinishValidationSuccess | FinishValidationError {
	const statusValue = args['status']
	if (statusValue !== 'success' && statusValue !== 'error' && statusValue !== 'needs_clarification') {
		return { kind: 'error', result: createToolError('invalid_arguments', 'status must be success, error, or needs_clarification') }
	}

	const summaryValue = args['summary']
	if (typeof summaryValue !== 'string') {
		return { kind: 'error', result: createToolError('invalid_arguments', 'summary must be a string') }
	}

	let artifactsValue: string[] | undefined
	const artifactsRaw = args['artifacts']
	if (artifactsRaw !== undefined) {
		if (!Array.isArray(artifactsRaw) || !artifactsRaw.every((a): a is string => typeof a === 'string')) {
			return { kind: 'error', result: createToolError('invalid_arguments', 'artifacts must be an array of strings') }
		}
		artifactsValue = artifactsRaw
	}

	let errorValue: ResultCard['error']
	const errorRaw = args['error']
	if (statusValue === 'error' && errorRaw !== undefined) {
		if (!isObject(errorRaw)) {
			return { kind: 'error', result: createToolError('invalid_arguments', 'error must be an object') }
		}
		const errKindValue = errorRaw['kind']
		if (!isErrorKind(errKindValue)) {
			return { kind: 'error', result: createToolError('invalid_arguments', 'error.kind must be a valid ErrorKind') }
		}
		const errMessageValue = errorRaw['message']
		const errMessage = typeof errMessageValue === 'string' ? errMessageValue : undefined
		errorValue = { kind: errKindValue, message: errMessage }
	}

	const card: ResultCard = {
		status: statusValue,
		summary: summaryValue,
		...(artifactsValue !== undefined ? { artifacts: artifactsValue } : {}),
		...(errorValue !== undefined ? { error: errorValue } : {}),
	}

	return { kind: 'success', card }
}

interface AgentValidationSuccess {
	kind: 'success'
	roleName: string
	task: string
}

function validateAgentArgs(args: Record<string, unknown>): AgentValidationSuccess | FinishValidationError {
	const roleValue = args['role']
	if (typeof roleValue !== 'string') {
		return { kind: 'error', result: createToolError('invalid_arguments', 'role must be a string') }
	}

	const taskValue = args['task']
	if (typeof taskValue !== 'string') {
		return { kind: 'error', result: createToolError('invalid_arguments', 'task must be a string') }
	}

	return { kind: 'success', roleName: roleValue, task: taskValue }
}

interface ContextInfoMessage {
	index: number
	role: Message['role']
	contentChars: number
	reasoningChars: number
}

function snapshotMessages(history: Message[]): ContextInfoMessage[] {
	const out: ContextInfoMessage[] = []
	for (let i = 0; i < history.length; i++) {
		const m = history[i]
		if (m === undefined) continue
		out.push({
			index: i,
			role: m.role,
			contentChars: m.content.length,
			reasoningChars: m.reasoning === null || m.reasoning === undefined ? 0 : m.reasoning.length,
		})
	}
	return out
}

function createContextInfo(context: BuiltInToolContext): ToolHandler {
	return () => {
		const state = context.roleState
		const messages = snapshotMessages(state.history)
		const totalContentChars = messages.reduce((sum, m) => sum + m.contentChars + m.reasoningChars, 0)
		const estimatedPromptTokens = Math.ceil(totalContentChars / 4)
		const budgetRemaining = Math.max(0, context.contextWindow - estimatedPromptTokens)
		return {
			kind: 'success',
			data: {
				contextWindow: context.contextWindow,
				currentPromptTokens: estimatedPromptTokens,
				lastReportedPromptTokens: state.lastPromptTokens,
				budgetRemaining,
				messages,
				recentCompactionPromptTokens: state.recentCompactionPromptTokens.slice(),
			},
		}
	}
}

interface DropOperation {
	op: 'drop'
	range: [number, number]
}

interface StripReasoningOperation {
	op: 'strip_reasoning'
	range: [number, number]
}

interface ReplaceOperation {
	op: 'replace'
	index: number
	content: string
}

type ContextEditOperation = DropOperation | StripReasoningOperation | ReplaceOperation

function validateRange(range: unknown): [number, number] | null {
	if (!Array.isArray(range) || range.length !== 2) return null
	const startValue = range[0]
	const endValue = range[1]
	if (typeof startValue !== 'number' || typeof endValue !== 'number') return null
	if (!Number.isFinite(startValue) || !Number.isFinite(endValue)) return null
	if (startValue < 0 || endValue < 0) return null
	if (startValue > endValue) return null
	return [startValue, endValue]
}

function estimateHistoryTokens(history: Message[]): number {
	let chars = 0
	for (const m of history) {
		chars += m.content.length
		if (m.reasoning !== null && m.reasoning !== undefined) chars += m.reasoning.length
	}
	return Math.ceil(chars / 4)
}

function applyEditOperations(history: Message[], operations: ContextEditOperation[]): { ok: true; history: Message[] } | { ok: false; error: ToolResult } {
	let next: Message[] = history.slice()
	for (const op of operations) {
		if (op.op === 'drop') {
			const range = validateRange(op.range)
			if (range === null) {
				return { ok: false, error: createToolError('invalid_arguments', 'drop.range must be [start, end] with non-negative integers') }
			}
			const [start, end] = range
			if (start >= next.length) continue
			next.splice(start, Math.min(end - start, next.length - start))
		} else if (op.op === 'strip_reasoning') {
			const range = validateRange(op.range)
			if (range === null) {
				return { ok: false, error: createToolError('invalid_arguments', 'strip_reasoning.range must be [start, end] with non-negative integers') }
			}
			next = stripReasoning(next, range[0], range[1])
		} else if (op.op === 'replace') {
			if (typeof op.index !== 'number' || !Number.isFinite(op.index) || op.index < 0) {
				return { ok: false, error: createToolError('invalid_arguments', 'replace.index must be a non-negative number') }
			}
			if (typeof op.content !== 'string') {
				return { ok: false, error: createToolError('invalid_arguments', 'replace.content must be a string') }
			}
			const existing = next[op.index]
			if (existing === undefined) {
				return { ok: false, error: createToolError('invalid_arguments', `replace.index ${op.index} is out of range`) }
			}
			next[op.index] = { ...existing, content: op.content }
		}
	}
	return { ok: true, history: next }
}

function createEditContext(context: BuiltInToolContext): ToolHandler {
	return (args) => {
		const opsValue = args['operations']
		if (!Array.isArray(opsValue)) {
			return createToolError('invalid_arguments', 'operations must be an array')
		}
		const operations: ContextEditOperation[] = []
		for (const raw of opsValue) {
			if (!isObject(raw)) {
				return createToolError('invalid_arguments', 'each operation must be an object')
			}
			const opValue = raw['op']
			if (opValue === 'drop') {
				const range = validateRange(raw['range'])
				if (range === null) {
					return createToolError('invalid_arguments', 'drop.range must be [start, end] with non-negative integers')
				}
				operations.push({ op: 'drop', range })
			} else if (opValue === 'strip_reasoning') {
				const range = validateRange(raw['range'])
				if (range === null) {
					return createToolError('invalid_arguments', 'strip_reasoning.range must be [start, end] with non-negative integers')
				}
				operations.push({ op: 'strip_reasoning', range })
			} else if (opValue === 'replace') {
				const indexValue = raw['index']
				const contentValue = raw['content']
				if (typeof indexValue !== 'number' || typeof contentValue !== 'string') {
					return createToolError('invalid_arguments', 'replace requires numeric index and string content')
				}
				operations.push({ op: 'replace', index: indexValue, content: contentValue })
			} else {
				return createToolError('invalid_arguments', `Unknown operation: ${String(opValue)}`)
			}
		}
		const applied = applyEditOperations(context.roleState.history, operations)
		if (!applied.ok) return applied.error
		context.roleState.history = applied.history
		const estimatedTokens = estimateHistoryTokens(context.roleState.history)
		context.roleState.recentCompactionPromptTokens.push(estimatedTokens)
		const messages = snapshotMessages(context.roleState.history)
		const totalContentChars = messages.reduce((sum, m) => sum + m.contentChars + m.reasoningChars, 0)
		const currentPromptTokens = Math.ceil(totalContentChars / 4)
		return {
			kind: 'success',
			data: {
				currentPromptTokens,
				messageCount: context.roleState.history.length,
				recentCompactionPromptTokens: context.roleState.recentCompactionPromptTokens.slice(),
				messages,
			},
		}
	}
}

function createAskHuman(context: BuiltInToolContext): ToolHandler {
	return async (args) => {
		const questionValue = args['question']
		if (typeof questionValue !== 'string' || questionValue === '') {
			return createToolError('invalid_arguments', 'question must be a non-empty string')
		}
		const contextValue = args['context']
		const contextString = typeof contextValue === 'string' ? contextValue : undefined
		const answer = await context.humanBackend.ask(questionValue, contextString)
		return { kind: 'success', data: { question: questionValue, answer } }
	}
}

const INTERRUPT_ACTIONS: readonly InterruptActionKind[] = ['continue', 'redirect', 'abort']

function isInterruptActionKind(value: unknown): value is InterruptActionKind {
	return typeof value === 'string' && INTERRUPT_ACTIONS.some((action) => action === value)
}

// The handler's decision lands on the target's registry entry; the target's drain applies it once the handler finishes. redirect's message is injected immediately — the target is suspended mid-drain, so its history is stable — and the drain only has to resume it.
function createTriggerInterrupt(context: BuiltInToolContext): ToolHandler {
	return (args) => {
		const target = lookupTarget(context.roleRegistry, args)
		if (!target.ok) return target.error
		const actionValue = args['action']
		if (!isInterruptActionKind(actionValue)) {
			return createToolError('invalid_arguments', 'action must be one of: continue, redirect, abort')
		}
		const reasonValue = args['reason']
		if (typeof reasonValue !== 'string') {
			return createToolError('invalid_arguments', 'reason must be a string')
		}
		if (actionValue === 'redirect') {
			target.entry.roleState.history.push({ role: 'user', content: reasonValue })
		}
		target.entry.interruptAction = { action: actionValue, reason: reasonValue }
		return { kind: 'success', data: { targetRole: target.entry.roleId, action: actionValue } }
	}
}

function lookupTarget(registry: RoleRegistry, args: Record<string, unknown>): { ok: true; entry: RoleRegistryEntry } | { ok: false; error: ToolResult } {
	const targetValue = args['targetRole']
	if (typeof targetValue !== 'string' || targetValue === '') {
		return { ok: false, error: createToolError('invalid_arguments', 'targetRole must be a non-empty string') }
	}
	const entry = registry.lookup(targetValue)
	if (entry === undefined) {
		return { ok: false, error: createToolError('invalid_arguments', `unknown role instance: ${targetValue}`) }
	}
	return { ok: true, entry }
}

function isInspectionField(value: unknown): value is InspectionField {
	return value === 'content' || value === 'reasoning'
}

function optionalPositiveInt(value: unknown, fallback: number): number | null {
	if (value === undefined) return fallback
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null
	return value
}

function createListRoleMessages(context: BuiltInToolContext): ToolHandler {
	return (args) => {
		const target = lookupTarget(context.roleRegistry, args)
		if (!target.ok) return target.error
		return { kind: 'success', data: { targetRole: target.entry.roleId, messages: indexRoleMessages(target.entry.roleState.history) } }
	}
}

function createReadMessageWindow(context: BuiltInToolContext): ToolHandler {
	return (args) => {
		const target = lookupTarget(context.roleRegistry, args)
		if (!target.ok) return target.error
		const indexValue = args['index']
		if (typeof indexValue !== 'number' || !Number.isInteger(indexValue) || indexValue < 0) {
			return createToolError('invalid_arguments', 'index must be a non-negative integer')
		}
		const fieldValue = args['field']
		if (!isInspectionField(fieldValue)) {
			return createToolError('invalid_arguments', 'field must be one of: content, reasoning')
		}
		const startValue = args['start']
		const endValue = args['end']
		if (typeof startValue !== 'number' || !Number.isInteger(startValue) || startValue < 0) {
			return createToolError('invalid_arguments', 'start must be a non-negative integer')
		}
		if (typeof endValue !== 'number' || !Number.isInteger(endValue) || endValue <= startValue) {
			return createToolError('invalid_arguments', 'end must be an integer greater than start')
		}
		const result = readMessageWindow(target.entry.roleState.history, indexValue, fieldValue, startValue, endValue)
		if (!result.ok) return createToolError('invalid_arguments', result.error)
		return { kind: 'success', data: result.window }
	}
}

function createSearchRoleBlocks(context: BuiltInToolContext): ToolHandler {
	return (args) => {
		const target = lookupTarget(context.roleRegistry, args)
		if (!target.ok) return target.error
		const patternValue = args['pattern']
		if (typeof patternValue !== 'string' || patternValue === '') {
			return createToolError('invalid_arguments', 'pattern must be a non-empty string')
		}
		const kindValue = args['kind']
		if (kindValue !== undefined && kindValue !== 'substring' && kindValue !== 'regex') {
			return createToolError('invalid_arguments', 'kind must be one of: substring, regex')
		}
		const fieldValue = args['field']
		if (fieldValue !== undefined && !isInspectionField(fieldValue)) {
			return createToolError('invalid_arguments', 'field must be one of: content, reasoning')
		}
		const maxMatches = optionalPositiveInt(args['maxMatches'], 10)
		if (maxMatches === null) {
			return createToolError('invalid_arguments', 'maxMatches must be a positive integer')
		}
		const result = searchRoleBlocks(target.entry.roleState.history, {
			...(fieldValue !== undefined ? { field: fieldValue } : {}),
			pattern: patternValue,
			kind: kindValue ?? 'substring',
			maxMatches,
		})
		if (!result.ok) return createToolError('invalid_arguments', result.error)
		return { kind: 'success', data: { targetRole: target.entry.roleId, matches: result.matches, matchesCappedAt: MAX_SEARCH_MATCHES } }
	}
}

function createRecentRoleToolCalls(context: BuiltInToolContext): ToolHandler {
	return (args) => {
		const target = lookupTarget(context.roleRegistry, args)
		if (!target.ok) return target.error
		const limit = optionalPositiveInt(args['limit'], 20)
		if (limit === null) {
			return createToolError('invalid_arguments', 'limit must be a positive integer')
		}
		const trace: RecentToolCall[] = target.entry.roleState.recentToolCalls
		return {
			kind: 'success',
			data: {
				targetRole: target.entry.roleId,
				toolCalls: trace.slice(-Math.min(limit, RECENT_TOOL_CALLS_LIMIT)),
				totalToolCalls: target.entry.roleState.toolCallCount,
				traceCappedAt: RECENT_TOOL_CALLS_LIMIT,
			},
		}
	}
}

export function createBuiltInToolHandlers(context: BuiltInToolContext): Record<string, ToolHandler> {
	return {
		finish: (args) => {
			const validation = validateFinishArgs(args)
			if (validation.kind === 'error') return validation.result
			return { kind: 'success', data: validation.card }
		},
		agent: async (args) => {
			const validation = validateAgentArgs(args)
			if (validation.kind === 'error') return validation.result
			const card = await context.spawnAgent(validation.roleName, validation.task)
			return { kind: 'success', data: card }
		},
		context_info: createContextInfo(context),
		edit_context: createEditContext(context),
		ask_human: createAskHuman(context),
		trigger_interrupt: createTriggerInterrupt(context),
		list_role_messages: createListRoleMessages(context),
		read_message_window: createReadMessageWindow(context),
		search_role_blocks: createSearchRoleBlocks(context),
		recent_role_tool_calls: createRecentRoleToolCalls(context),
	}
}