import { createToolError, isErrorKind } from '../shared/errors.js'
import type { Message, ResultCard, RoleBudget, ToolResult } from '../shared/types.js'
import { stripReasoning } from './context-policy.js'
import type { ToolHandler } from './tool-dispatch.js'
import type { HumanBackend } from './human-backend.js'
import type { RoleState } from './engine.js'

export interface BuiltInToolContext {
	spawnAgent(roleName: string, task: string, budget?: RoleBudget): Promise<ResultCard>
	roleState: RoleState
	humanBackend: HumanBackend
	contextWindow: number
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
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
	budget: RoleBudget | undefined
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

	let budgetValue: RoleBudget | undefined
	const budgetRaw = args['budget']
	if (budgetRaw !== undefined) {
		if (!isObject(budgetRaw)) {
			return { kind: 'error', result: createToolError('invalid_arguments', 'budget must be an object') }
		}
		const maxToolCallsValue = budgetRaw['maxToolCalls']
		const maxTokensValue = budgetRaw['maxTokens']
		const maxToolCalls = typeof maxToolCallsValue === 'number' ? maxToolCallsValue : undefined
		const maxTokens = typeof maxTokensValue === 'number' ? maxTokensValue : undefined
		budgetValue = {
			...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
			...(maxTokens !== undefined ? { maxTokens } : {}),
		}
	}

	return { kind: 'success', roleName: roleValue, task: taskValue, budget: budgetValue }
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
			if (op.index >= next.length) {
				return { ok: false, error: createToolError('invalid_arguments', `replace.index ${op.index} is out of range`) }
			}
			next[op.index] = { ...next[op.index]!, content: op.content }
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
				operations.push({ op: 'drop', range: raw['range'] as [number, number] })
			} else if (opValue === 'strip_reasoning') {
				operations.push({ op: 'strip_reasoning', range: raw['range'] as [number, number] })
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
			const card = await context.spawnAgent(validation.roleName, validation.task, validation.budget)
			return { kind: 'success', data: card }
		},
		context_info: createContextInfo(context),
		edit_context: createEditContext(context),
		ask_human: createAskHuman(context),
	}
}