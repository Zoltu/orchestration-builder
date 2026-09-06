import { isErrorKind, ValidationError } from './errors.js'
import type {
	ContextPolicy,
	DeploymentConfig,
	DeploymentFileConfig,
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

function rejectUnknownKeys(value: Record<string, unknown>, allowedKeys: readonly string[], path: string): void {
	for (const key of Object.keys(value)) {
		if (allowedKeys.includes(key)) continue
		const keyPath = path === '' ? key : `${path}.${key}`
		throw new ValidationError(keyPath, `unknown key "${key}" (expected one of: ${allowedKeys.join(', ')})`)
	}
}

const generationKeys: readonly string[] = ['temperature', 'maxTokens']

function validateGenerationConfig(value: unknown, path: string): asserts value is GenerationConfig {
	if (!isObject(value)) throw new ValidationError(path, 'expected an object')
	rejectUnknownKeys(value, generationKeys, path)
	ensure(isOptionalNumber, value.temperature, `${path}.temperature`, 'expected a number or undefined')
	ensure(isOptionalNumber, value.maxTokens, `${path}.maxTokens`, 'expected a number or undefined')
}

const modelKeys: readonly string[] = ['name', 'apiBase', 'contextWindow', 'reasoningField', 'generation']

function validateModelConfig(value: unknown, path: string): asserts value is ModelConfig {
	if (!isObject(value)) throw new ValidationError(path, 'expected an object')
	// A deployment file carrying a credential is almost always an operator copying an old guild.json: fail with the env-var pointer instead of silently ignoring the key (the deployment file is strict, so a near-miss like this must not pass as an unknown key with a generic message).
	if ('apiKey' in value) throw new ValidationError(`${path}.apiKey`, 'model credentials are runtime configuration: set the ORCHESTRATOR_API_KEY environment variable instead of writing them into the deployment file')
	rejectUnknownKeys(value, modelKeys, path)
	if (value.name !== undefined && (typeof value.name !== 'string' || value.name === '')) throw new ValidationError(`${path}.name`, 'expected a non-empty string')
	ensure(isString, value.apiBase, `${path}.apiBase`, 'expected a string')
	if (value.contextWindow !== undefined && (!isNumber(value.contextWindow) || value.contextWindow <= 0)) throw new ValidationError(`${path}.contextWindow`, 'expected a positive number')
	ensure(isOptionalString, value.reasoningField, `${path}.reasoningField`, 'expected a string or undefined')
	validateGenerationConfig(value.generation, `${path}.generation`)
}

const interruptTriggersKeys: readonly string[] = ['handlerRole', 'everyToolCalls', 'everyTokens', 'planOwnerRole']

function validateInterruptTriggersConfig(value: unknown, path: string): asserts value is InterruptTriggersConfig {
	if (!isObject(value)) throw new ValidationError(path, 'expected an object')
	rejectUnknownKeys(value, interruptTriggersKeys, path)
	if (typeof value.handlerRole !== 'string' || value.handlerRole === '') throw new ValidationError(`${path}.handlerRole`, 'expected a non-empty string')
	if (!isNumber(value.everyToolCalls) || value.everyToolCalls <= 0) throw new ValidationError(`${path}.everyToolCalls`, 'expected a positive number')
	if (!isNumber(value.everyTokens) || value.everyTokens <= 0) throw new ValidationError(`${path}.everyTokens`, 'expected a positive number')
	if (value.planOwnerRole !== undefined && (typeof value.planOwnerRole !== 'string' || value.planOwnerRole === '')) {
		throw new ValidationError(`${path}.planOwnerRole`, 'expected a non-empty string or undefined')
	}
}

const executorKeys: readonly string[] = ['maxAgentDepth', 'defaultToolTimeoutSeconds', 'maxCompactionAttempts', 'contextPressureThreshold', 'contextHandlerRole', 'inquiryHandlerRole', 'interruptTriggers']

function validateExecutorConfig(value: unknown, path: string): asserts value is ExecutorConfig {
	if (!isObject(value)) throw new ValidationError(path, 'expected an object')
	rejectUnknownKeys(value, executorKeys, path)
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

const contextPolicyKeys: readonly string[] = ['maxToolOutputChars']

function validateContextPolicy(value: unknown, path: string): asserts value is ContextPolicy {
	if (!isObject(value)) throw new ValidationError(path, 'expected an object')
	rejectUnknownKeys(value, contextPolicyKeys, path)
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

// Keys of the old combined guild format that now live in the deployment file; their presence in a guild file means a stale or hand-merged file, so the validator names the right home instead of silently ignoring the sections.
const guildDeploymentKeys: readonly string[] = ['schemaVersion', 'model', 'executor', 'contextPolicy']

export function validateGuildConfig(value: unknown): asserts value is GuildConfig {
	if (!isObject(value)) throw new ValidationError('', 'expected an object')
	for (const key of guildDeploymentKeys) {
		if (key in value) throw new ValidationError(key, `"${key}" is deployment configuration: move it to deployment.json (the guild file describes only orchestrator behavior)`)
	}
	ensure(isString, value.entryRole, 'entryRole', 'expected a string')
	if (!isObject(value.roles)) throw new ValidationError('roles', 'expected an object')
	for (const [name, role] of Object.entries(value.roles)) {
		validateRoleDefinition(role, `roles.${name}`)
	}
	ensure(isStringArray, value.tools, 'tools', 'expected an array of strings')
	if (value.visualization !== undefined) validateVisualizationConfig(value.visualization, 'visualization')
}

const deploymentKeys: readonly string[] = ['model', 'executor', 'contextPolicy']

export function validateDeploymentFileConfig(value: unknown): asserts value is DeploymentFileConfig {
	if (!isObject(value)) throw new ValidationError('', 'expected an object')
	rejectUnknownKeys(value, deploymentKeys, '')
	validateModelConfig(value.model, 'model')
	validateExecutorConfig(value.executor, 'executor')
	validateContextPolicy(value.contextPolicy, 'contextPolicy')
}

// Cross-checks the deployment's role references against the guild's declared roles (the two files are validated independently, so this is the one place the pair is consistent). Accepts either deployment shape because only the executor section is read. The loader runs it after both files validate; each failure names the deployment path of the offending reference.
export function validateDeploymentRoleReferences(deployment: DeploymentFileConfig | DeploymentConfig, roleNames: ReadonlySet<string>): void {
	const executor = deployment.executor
	if (executor.contextHandlerRole !== undefined && !roleNames.has(executor.contextHandlerRole)) {
		throw new ValidationError('executor.contextHandlerRole', `references unknown role "${executor.contextHandlerRole}" (not declared in guild.json "roles")`)
	}
	if (executor.inquiryHandlerRole !== undefined && !roleNames.has(executor.inquiryHandlerRole)) {
		throw new ValidationError('executor.inquiryHandlerRole', `references unknown role "${executor.inquiryHandlerRole}" (not declared in guild.json "roles")`)
	}
	const triggers = executor.interruptTriggers
	if (triggers === undefined) return
	if (!roleNames.has(triggers.handlerRole)) {
		throw new ValidationError('executor.interruptTriggers.handlerRole', `references unknown role "${triggers.handlerRole}" (not declared in guild.json "roles")`)
	}
	if (triggers.planOwnerRole !== undefined && !roleNames.has(triggers.planOwnerRole)) {
		throw new ValidationError('executor.interruptTriggers.planOwnerRole', `references unknown role "${triggers.planOwnerRole}" (not declared in guild.json "roles")`)
	}
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
