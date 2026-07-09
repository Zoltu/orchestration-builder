
import { isErrorKind, ValidationError } from './errors.js'
import { EFFORT_MAX, EFFORT_MIN } from './effort.js'
import {
	AssistantResponse,
	ContextPolicy,
	EffortLevel,
	ExecutorConfig,
	GenerationConfig,
	GuildConfig,
	HumanFacingText,
	LogEvent,
	Message,
	MessageRole,
	ModelConfig,
	OperationKind,
	ResultCard,
	RoleDefinition,
	RunMeta,
	RunOptions,
	ToolCall,
	ToolManifest,
	ToolParameter,
	ToolResult,
	VisualizationConfig,
} from './types.js'
import type { ProjectSettings } from './persistence.js'

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
	return typeof value === 'string'
}

function isNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

function isBoolean(value: unknown): value is boolean {
	return typeof value === 'boolean'
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || isString(value)
}

function isOptionalNumber(value: unknown): boolean {
	return value === undefined || isNumber(value)
}

function isOptionalBoolean(value: unknown): boolean {
	return value === undefined || isBoolean(value)
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isString)
}

function isRecordOf<T>(value: Record<string, unknown>, predicate: (entry: unknown) => entry is T): value is Record<string, T> {
	for (const key of Object.keys(value)) {
		if (!predicate(value[key])) return false
	}
	return true
}

function isOptional<T>(value: unknown, predicate: (value: unknown) => value is T): value is T | undefined {
	if (value === undefined) return true
	return predicate(value)
}

function isNonEmptyStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every(isString)
}

function isOptionalNonEmptyStringArray(value: unknown): boolean {
	return value === undefined || isNonEmptyStringArray(value)
}

function isHumanFacingText(value: unknown): value is HumanFacingText {
	if (!isObject(value)) return false
	if (!isNonEmptyStringArray(value.detailed)) return false
	if (!isOptionalNonEmptyStringArray(value.whimsical)) return false
	if (!isOptionalNonEmptyStringArray(value.friendly)) return false
	return true
}

const messageRoles: readonly MessageRole[] = ['system', 'user', 'assistant', 'tool']

const resultCardStatuses: readonly ResultCard['status'][] = ['success', 'error', 'needs_clarification']

const runMetaStatuses: readonly RunMeta['status'][] = ['running', 'success', 'error', 'needs_clarification']

const operationKinds: readonly OperationKind[] = ['call', 'return', 'observe', 'terminate']

function isRecordOfHumanFacingText(value: unknown): value is Record<string, HumanFacingText> {
	if (!isObject(value)) return false
	for (const key of Object.keys(value)) {
		if (!isHumanFacingText(value[key])) return false
	}
	return true
}

function isOperationTemplates(value: unknown): value is Record<OperationKind, Record<string, HumanFacingText>> {
	if (!isObject(value)) return false
	for (const kind of operationKinds) {
		const entry = value[kind]
		if (entry === undefined) return false
		if (!isRecordOfHumanFacingText(entry)) return false
	}
	return true
}

function isGenericOperationTemplates(value: unknown): value is Record<OperationKind, HumanFacingText> {
	if (!isObject(value)) return false
	for (const kind of operationKinds) {
		const entry = value[kind]
		if (entry === undefined) return false
		if (!isHumanFacingText(entry)) return false
	}
	return true
}

export function isVisualizationConfig(value: unknown): value is VisualizationConfig {
	if (!isObject(value)) return false
	if (!isRecordOfHumanFacingText(value.pseudoRoleLabels)) return false
	if (!isOperationTemplates(value.operationTemplates)) return false
	if (!isGenericOperationTemplates(value.genericOperationTemplates)) return false
	if (!isOptional(value.workingTemplates, isRecordOfHumanFacingText)) return false
	return true
}

export function isMessageRole(value: unknown): value is MessageRole {
	return typeof value === 'string' && messageRoles.some((r) => r === value)
}

export function isGenerationConfig(value: unknown): value is GenerationConfig {
	if (!isObject(value)) return false
	if (!isOptionalNumber(value.temperature)) return false
	if (!isOptionalNumber(value.maxTokens)) return false
	return true
}

export function isModelConfig(value: unknown): value is ModelConfig {
	if (!isObject(value)) return false
	if (!isString(value.name)) return false
	if (!isString(value.apiBase)) return false
	if (!isOptionalString(value.apiKey)) return false
	if (!isNumber(value.contextWindow)) return false
	if (!isOptionalString(value.reasoningField)) return false
	if (!isGenerationConfig(value.generation)) return false
	return true
}

export function isExecutorConfig(value: unknown): value is ExecutorConfig {
	if (!isObject(value)) return false
	if (!isNumber(value.maxAgentDepth)) return false
	if (!isNumber(value.defaultToolTimeoutSeconds)) return false
	if (!isNumber(value.maxCompactionAttempts)) return false
	return true
}

export function isContextPolicy(value: unknown): value is ContextPolicy {
	if (!isObject(value)) return false
	if (!isNumber(value.maxToolOutputChars)) return false
	return true
}

export function isRoleDefinition(value: unknown): value is RoleDefinition {
	if (!isObject(value)) return false
	if (!isString(value.systemPrompt)) return false
	if (!isStringArray(value.tools)) return false
	if (!isOptionalBoolean(value.includeReasoning)) return false
	if (!isOptional(value.label, isHumanFacingText)) return false
	if (!isOptional(value.description, isHumanFacingText)) return false
	if (!isOptional(value.workingLabel, isHumanFacingText)) return false
	return true
}

export function isGuildConfig(value: unknown): value is GuildConfig {
	if (!isObject(value)) return false
	if (!isNumber(value.schemaVersion)) return false
	if (!isModelConfig(value.model)) return false
	if (!isExecutorConfig(value.executor)) return false
	if (!isContextPolicy(value.contextPolicy)) return false
	if (!isString(value.entryRole)) return false
	if (!isObject(value.roles) || !isRecordOf(value.roles, isRoleDefinition)) return false
	if (!isStringArray(value.tools)) return false
	if (!isOptional(value.visualization, isVisualizationConfig)) return false
	return true
}

export function isToolParameter(value: unknown): value is ToolParameter {
	if (!isObject(value)) return false
	if (!isString(value.type)) return false
	if (!isOptional(value.required, isStringArray)) return false
	if (
		!isOptional(value.properties, (properties): properties is Record<string, ToolParameter> => {
			if (!isObject(properties)) return false
			return isRecordOf(properties, isToolParameter)
		})
	) {
		return false
	}
	if (!isOptionalBoolean(value.additionalProperties)) return false
	return true
}

export function isToolManifest(value: unknown): value is ToolManifest {
	if (!isObject(value)) return false
	if (!isString(value.name)) return false
	if (!isString(value.description)) return false
	if (!isToolParameter(value.parameters)) return false
	if (value.parameters.type !== 'object') return false
	if (!isOptional(value.humanLabel, isHumanFacingText)) return false
	if (!isOptional(value.humanDescription, isHumanFacingText)) return false
	if (!isOptional(value.humanCallLabel, isHumanFacingText)) return false
	if (!isOptional(value.humanWorkingLabel, isHumanFacingText)) return false
	return true
}

export function isMessage(value: unknown): value is Message {
	if (!isObject(value)) return false
	if (!isMessageRole(value.role)) return false
	if (!isString(value.content)) return false
	if (
		value.reasoning !== undefined &&
		value.reasoning !== null &&
		!isString(value.reasoning)
	) {
		return false
	}
	if (!isOptionalString(value.tool_call_id)) return false
	if (
		value.tool_calls !== undefined &&
		(!Array.isArray(value.tool_calls) || !value.tool_calls.every(isToolCall))
	) {
		return false
	}
	return true
}

export function isToolCall(value: unknown): value is ToolCall {
	if (!isObject(value)) return false
	if (!isString(value.id)) return false
	if (value.type !== 'function') return false
	if (!isObject(value.function)) return false
	if (!isString(value.function.name)) return false
	if (!isString(value.function.arguments)) return false
	return true
}

export function isAssistantResponse(value: unknown): value is AssistantResponse {
	if (!isObject(value)) return false
	if (!isOptionalString(value.content)) return false
	if (value.reasoning !== undefined && value.reasoning !== null && !isString(value.reasoning)) return false
	if (value.tool_calls !== undefined) {
		if (!Array.isArray(value.tool_calls) || !value.tool_calls.every(isToolCall)) return false
	}
	return true
}

export function isToolResult(value: unknown): value is ToolResult {
	if (!isObject(value)) return false
	if (value.kind === 'success') return true
	if (isErrorKind(value.kind)) return true
	return false
}

export function isResultCard(value: unknown): value is ResultCard {
	if (!isObject(value)) return false
	if (!isString(value.status) || !resultCardStatuses.some((s) => s === value.status)) return false
	if (!isString(value.summary)) return false
	if (value.artifacts !== undefined && !isStringArray(value.artifacts)) return false
	if (value.error !== undefined) {
		if (!isObject(value.error)) return false
		if (!isErrorKind(value.error.kind)) return false
		if (!isOptionalString(value.error.message)) return false
	}
	return true
}

export function isEffortLevel(value: unknown): value is EffortLevel {
	if (typeof value !== 'number') return false
	if (!Number.isInteger(value)) return false
	return value >= EFFORT_MIN && value <= EFFORT_MAX
}

export function isProjectSettings(value: unknown): value is ProjectSettings {
	if (!isObject(value)) return false
	if (value.effort !== undefined && !isEffortLevel(value.effort)) return false
	return true
}

export function isRunOptions(value: unknown): value is RunOptions {
	if (!isObject(value)) return false
	if (!isString(value.runId)) return false
	if (!isString(value.guildPath)) return false
	if (!isString(value.benchmarkPath)) return false
	if (!isString(value.task)) return false
	if (!isEffortLevel(value.effort)) return false
	return true
}

export function isRunMeta(value: unknown): value is RunMeta {
	if (!isObject(value)) return false
	if (!isString(value.runId)) return false
	if (!isString(value.guildPath)) return false
	if (!isString(value.benchmarkPath)) return false
	if (!isString(value.task)) return false
	if (value.effort !== undefined && !isEffortLevel(value.effort)) return false
	if (!isString(value.status) || !runMetaStatuses.some((s) => s === value.status)) return false
	if (!isString(value.startTime)) return false
	if (!isOptionalString(value.endTime)) return false
	if (value.result !== undefined && !isResultCard(value.result)) return false
	if (value.error !== undefined) {
		if (!isObject(value.error)) return false
		if (!isErrorKind(value.error.kind)) return false
		if (!isString(value.error.message)) return false
	}
	return true
}

export function isLogEvent(value: unknown): value is LogEvent {
	if (!isObject(value)) return false
	if (!isString(value.timestamp)) return false
	if (!isString(value.type)) return false
	return true
}

function ensure(guard: (value: unknown) => boolean, value: unknown, path: string, message: string): void {
	if (!guard(value)) throw new ValidationError(path, message)
}

function validateGenerationConfig(value: unknown, path: string): asserts value is GenerationConfig {
	if (!isObject(value)) throw new ValidationError(path, 'expected an object')
	ensure(isOptionalNumber, value.temperature, `${path}.temperature`, 'expected a number or undefined')
	ensure(isOptionalNumber, value.maxTokens, `${path}.maxTokens`, 'expected a number or undefined')
}

function validateModelConfig(value: unknown, path: string): asserts value is ModelConfig {
	if (!isObject(value)) throw new ValidationError(path, 'expected an object')
	ensure(isString, value.name, `${path}.name`, 'expected a string')
	ensure(isString, value.apiBase, `${path}.apiBase`, 'expected a string')
	ensure(isOptionalString, value.apiKey, `${path}.apiKey`, 'expected a string or undefined')
	ensure(isNumber, value.contextWindow, `${path}.contextWindow`, 'expected a number')
	ensure(isOptionalString, value.reasoningField, `${path}.reasoningField`, 'expected a string or undefined')
	validateGenerationConfig(value.generation, `${path}.generation`)
}

function validateExecutorConfig(value: unknown, path: string): asserts value is ExecutorConfig {
	if (!isObject(value)) throw new ValidationError(path, 'expected an object')
	ensure(isNumber, value.maxAgentDepth, `${path}.maxAgentDepth`, 'expected a number')
	ensure(isNumber, value.defaultToolTimeoutSeconds, `${path}.defaultToolTimeoutSeconds`, 'expected a number')
	ensure(isNumber, value.maxCompactionAttempts, `${path}.maxCompactionAttempts`, 'expected a number')
}

function validateContextPolicy(value: unknown, path: string): asserts value is ContextPolicy {
	if (!isObject(value)) throw new ValidationError(path, 'expected an object')
	ensure(isNumber, value.maxToolOutputChars, `${path}.maxToolOutputChars`, 'expected a number')
}

function validateRoleDefinition(value: unknown, path: string): asserts value is RoleDefinition {
	if (!isObject(value)) throw new ValidationError(path, 'expected an object')
	ensure(isString, value.systemPrompt, `${path}.systemPrompt`, 'expected a string')
	ensure(isStringArray, value.tools, `${path}.tools`, 'expected an array of strings')
	ensure(isOptionalBoolean, value.includeReasoning, `${path}.includeReasoning`, 'expected a boolean or undefined')
	if (value.label !== undefined && !isHumanFacingText(value.label)) {
		throw new ValidationError(`${path}.label`, 'expected an object with detailed (a non-empty string array), optional whimsical and friendly (non-empty string arrays)')
	}
	if (value.description !== undefined && !isHumanFacingText(value.description)) {
		throw new ValidationError(`${path}.description`, 'expected an object with detailed (a non-empty string array), optional whimsical and friendly (non-empty string arrays)')
	}
	if (value.workingLabel !== undefined && !isHumanFacingText(value.workingLabel)) {
		throw new ValidationError(`${path}.workingLabel`, 'expected an object with detailed (a non-empty string array), optional whimsical and friendly (non-empty string arrays)')
	}
}

export function validateGuildConfig(value: unknown): asserts value is GuildConfig {
	if (!isObject(value)) throw new ValidationError('', 'expected an object')
	ensure(isNumber, value.schemaVersion, 'schemaVersion', 'expected a number')
	validateModelConfig(value.model, 'model')
	validateExecutorConfig(value.executor, 'executor')
	validateContextPolicy(value.contextPolicy, 'contextPolicy')
	ensure(isString, value.entryRole, 'entryRole', 'expected a string')
	if (!isObject(value.roles)) throw new ValidationError('roles', 'expected an object')
	for (const [name, role] of Object.entries(value.roles)) {
		validateRoleDefinition(role, `roles.${name}`)
	}
	ensure(isStringArray, value.tools, 'tools', 'expected an array of strings')
	if (value.visualization !== undefined) validateVisualizationConfig(value.visualization, 'visualization')
}

export function validateVisualizationConfig(value: unknown, path: string): asserts value is VisualizationConfig {
	if (!isObject(value)) throw new ValidationError(path, 'expected an object')
	if (!isRecordOfHumanFacingText(value.pseudoRoleLabels)) {
		throw new ValidationError(`${path}.pseudoRoleLabels`, 'expected an object of HumanFacingText entries')
	}
	if (!isOperationTemplates(value.operationTemplates)) {
		throw new ValidationError(`${path}.operationTemplates`, 'expected an object keyed by call/return/observe/terminate, each a record of HumanFacingText entries')
	}
	if (!isGenericOperationTemplates(value.genericOperationTemplates)) {
		throw new ValidationError(`${path}.genericOperationTemplates`, 'expected an object keyed by call/return/observe/terminate, each a HumanFacingText entry')
	}
	if (value.workingTemplates !== undefined && !isRecordOfHumanFacingText(value.workingTemplates)) {
		throw new ValidationError(`${path}.workingTemplates`, 'expected an object of HumanFacingText entries keyed by participant kind')
	}
}

export function validateToolParameter(value: unknown, path: string): asserts value is ToolParameter {
	if (!isObject(value)) throw new ValidationError(path, 'expected an object')
	ensure(isString, value.type, `${path}.type`, 'expected a string')
	if (value.required !== undefined) ensure(isStringArray, value.required, `${path}.required`, 'expected an array of strings or undefined')
	if (value.properties !== undefined) {
		if (!isObject(value.properties)) throw new ValidationError(`${path}.properties`, 'expected an object')
		for (const [key, prop] of Object.entries(value.properties)) {
			validateToolParameter(prop, `${path}.properties.${key}`)
		}
	}
	ensure(isOptionalBoolean, value.additionalProperties, `${path}.additionalProperties`, 'expected a boolean or undefined')
}

export function validateToolManifest(value: unknown): asserts value is ToolManifest {
	if (!isObject(value)) throw new ValidationError('', 'expected an object')
	ensure(isString, value.name, 'name', 'expected a string')
	ensure(isString, value.description, 'description', 'expected a string')
	validateToolParameter(value.parameters, 'parameters')
	if (value.parameters.type !== 'object') throw new ValidationError('parameters.type', 'expected "object"')
	if (value.humanLabel !== undefined && !isHumanFacingText(value.humanLabel)) {
		throw new ValidationError('humanLabel', 'expected an object with detailed (a non-empty string array), optional whimsical and friendly (non-empty string arrays)')
	}
	if (value.humanDescription !== undefined && !isHumanFacingText(value.humanDescription)) {
		throw new ValidationError('humanDescription', 'expected an object with detailed (a non-empty string array), optional whimsical and friendly (non-empty string arrays)')
	}
	if (value.humanCallLabel !== undefined && !isHumanFacingText(value.humanCallLabel)) {
		throw new ValidationError('humanCallLabel', 'expected an object with detailed (a non-empty string array), optional whimsical and friendly (non-empty string arrays)')
	}
	if (value.humanWorkingLabel !== undefined && !isHumanFacingText(value.humanWorkingLabel)) {
		throw new ValidationError('humanWorkingLabel', 'expected an object with detailed (a non-empty string array), optional whimsical and friendly (non-empty string arrays)')
	}
}

export function validateMessage(value: unknown): asserts value is Message {
	if (!isObject(value)) throw new ValidationError('', 'expected an object')
	ensure(isMessageRole, value.role, 'role', 'expected one of system, user, assistant, tool')
	ensure(isString, value.content, 'content', 'expected a string')
	if (value.reasoning !== undefined && value.reasoning !== null && !isString(value.reasoning)) {
		throw new ValidationError('reasoning', 'expected a string, null, or undefined')
	}
	ensure(isOptionalString, value.tool_call_id, 'tool_call_id', 'expected a string or undefined')
	if (value.tool_calls !== undefined) {
		if (!Array.isArray(value.tool_calls)) throw new ValidationError('tool_calls', 'expected an array')
		for (const [index, call] of value.tool_calls.entries()) {
			validateToolCall(call, `tool_calls[${index}]`)
		}
	}
}

export function validateToolCall(value: unknown, path = ''): asserts value is ToolCall {
	if (!isObject(value)) throw new ValidationError(path, 'expected an object')
	ensure(isString, value.id, `${path}.id`, 'expected a string')
	if (value.type !== 'function') throw new ValidationError(`${path}.type`, 'expected "function"')
	if (!isObject(value.function)) throw new ValidationError(`${path}.function`, 'expected an object')
	ensure(isString, value.function.name, `${path}.function.name`, 'expected a string')
	ensure(isString, value.function.arguments, `${path}.function.arguments`, 'expected a string')
}

export function validateResultCard(value: unknown): asserts value is ResultCard {
	if (!isObject(value)) throw new ValidationError('', 'expected an object')
	if (!isString(value.status) || !resultCardStatuses.some((s) => s === value.status)) {
		throw new ValidationError('status', 'expected one of success, error, needs_clarification')
	}
	ensure(isString, value.summary, 'summary', 'expected a string')
	if (value.artifacts !== undefined) ensure(isStringArray, value.artifacts, 'artifacts', 'expected an array of strings or undefined')
	if (value.error !== undefined) {
		if (!isObject(value.error)) throw new ValidationError('error', 'expected an object')
		ensure(isErrorKind, value.error.kind, 'error.kind', 'expected a known error kind')
		ensure(isOptionalString, value.error.message, 'error.message', 'expected a string or undefined')
	}
}
