import { isErrorKind, ValidationError } from './errors.js'
import type {
	ContextPolicy,
	EffortLevel,
	ExecutorConfig,
	GenerationConfig,
	GuildConfig,
	HumanFacingText,
	InterruptTriggersConfig,
	ModelConfig,
	OperationKind,
	ResultCard,
	RoleDefinition,
	RunMeta,
	ToolManifest,
	ToolParameter,
	VisualizationConfig,
} from './types.js'
import type { ProjectSettings } from './persistence.js'

// The shared record guard: a plain object (not null, not an array). Exported so every module validating external input reads one definition rather than re-declaring its own copy.
export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isString(value: unknown): value is string {
	return typeof value === 'string'
}

function isNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

export function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function isNonNegativeInteger(value: unknown): value is number {
	return isNonNegativeNumber(value) && Number.isInteger(value)
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

export function isNonEmptyStringArray(value: unknown): value is string[] {
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

const resultCardStatuses: readonly ResultCard['status'][] = ['success', 'error', 'needs_clarification']

const runMetaStatuses: readonly RunMeta['status'][] = ['running', 'success', 'error', 'needs_clarification', 'interrupted']

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
	return value === 'quick' || value === 'standard' || value === 'thorough'
}

export function isProjectSettings(value: unknown): value is ProjectSettings {
	if (!isObject(value)) return false
	if (value.effort !== undefined && !isEffortLevel(value.effort)) return false
	return true
}

export function isRunMeta(value: unknown): value is RunMeta {
	if (!isObject(value)) return false
	if (!isString(value.runId)) return false
	if (!isString(value.guildPath)) return false
	if (!isOptionalString(value.benchmarkPath)) return false
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

function validateInterruptTriggersConfig(value: unknown, path: string): asserts value is InterruptTriggersConfig {
	if (!isObject(value)) throw new ValidationError(path, 'expected an object')
	if (typeof value.handlerRole !== 'string' || value.handlerRole === '') throw new ValidationError(`${path}.handlerRole`, 'expected a non-empty string')
	if (!isNumber(value.everyToolCalls) || value.everyToolCalls <= 0) throw new ValidationError(`${path}.everyToolCalls`, 'expected a positive number')
	if (!isNumber(value.everyTokens) || value.everyTokens <= 0) throw new ValidationError(`${path}.everyTokens`, 'expected a positive number')
	if (value.planOwnerRole !== undefined && (typeof value.planOwnerRole !== 'string' || value.planOwnerRole === '')) {
		throw new ValidationError(`${path}.planOwnerRole`, 'expected a non-empty string or undefined')
	}
}

function validateExecutorConfig(value: unknown, path: string): asserts value is ExecutorConfig {
	if (!isObject(value)) throw new ValidationError(path, 'expected an object')
	ensure(isNumber, value.maxAgentDepth, `${path}.maxAgentDepth`, 'expected a number')
	ensure(isNumber, value.defaultToolTimeoutSeconds, `${path}.defaultToolTimeoutSeconds`, 'expected a number')
	ensure(isNumber, value.maxCompactionAttempts, `${path}.maxCompactionAttempts`, 'expected a number')
	if (value.contextPressureThreshold !== undefined && (!isNumber(value.contextPressureThreshold) || value.contextPressureThreshold <= 0 || value.contextPressureThreshold >= 1)) {
		throw new ValidationError(`${path}.contextPressureThreshold`, 'expected a number in (0, 1)')
	}
	if (value.contextHandlerRole !== undefined && (typeof value.contextHandlerRole !== 'string' || value.contextHandlerRole === '')) {
		throw new ValidationError(`${path}.contextHandlerRole`, 'expected a non-empty string or undefined')
	}
	if (value.inquiryHandlerRole !== undefined && (typeof value.inquiryHandlerRole !== 'string' || value.inquiryHandlerRole === '')) {
		throw new ValidationError(`${path}.inquiryHandlerRole`, 'expected a non-empty string or undefined')
	}
	if (value.interruptTriggers !== undefined) validateInterruptTriggersConfig(value.interruptTriggers, `${path}.interruptTriggers`)
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

function validateVisualizationConfig(value: unknown, path: string): asserts value is VisualizationConfig {
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

function validateToolParameter(value: unknown, path: string): asserts value is ToolParameter {
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
