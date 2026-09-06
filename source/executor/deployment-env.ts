// Environment layer over the deployment file: the file is the base (replaced wholesale at load time), and each ORCHESTRATOR_* variable set in the environment overrides exactly one of its fields on top. Absent and empty-string variables mean "not set", so an override can only replace a field's value, never clear it. Every parse or semantic failure names the offending variable, mirroring the deployment file's strictness so a typo fails loudly at startup instead of silently keeping the file's value. Failures throw ConfigurationError so the service can present them on the bootstrap error page (see source/web/bootstrap-failure.ts).
import { ConfigurationError } from './errors.js'
import type { ContextPolicy, DeploymentFileConfig, InterruptTriggersConfig, ModelConfig } from './types.js'

export interface GenerationOverride {
	temperature?: number
	maxTokens?: number
}

export interface ModelOverride {
	name?: string
	apiBase?: string
	contextWindow?: number
	reasoningField?: string
	generation?: GenerationOverride
}

export interface InterruptTriggersOverride {
	handlerRole?: string
	everyToolCalls?: number
	everyTokens?: number
	planOwnerRole?: string
}

export interface ExecutorOverride {
	maxAgentDepth?: number
	defaultToolTimeoutSeconds?: number
	maxCompactionAttempts?: number
	contextPressureThreshold?: number
	contextHandlerRole?: string
	inquiryHandlerRole?: string
	interruptTriggers?: InterruptTriggersOverride
}

export interface ContextPolicyOverride {
	maxToolOutputChars?: number
}

export interface DeploymentOverride {
	model?: ModelOverride
	executor?: ExecutorOverride
	contextPolicy?: ContextPolicyOverride
}

// Named by the model-completion error too (see model-resolution.ts), so the variable and the file field stay one contract spelled once.
export const MODEL_ENV_VAR = 'ORCHESTRATOR_MODEL'
const API_BASE_ENV_VAR = 'ORCHESTRATOR_API_BASE'
export const MODEL_CONTEXT_WINDOW_ENV_VAR = 'ORCHESTRATOR_MODEL_CONTEXT_WINDOW'
const REASONING_FIELD_ENV_VAR = 'ORCHESTRATOR_REASONING_FIELD'
const TEMPERATURE_ENV_VAR = 'ORCHESTRATOR_TEMPERATURE'
const MAX_TOKENS_ENV_VAR = 'ORCHESTRATOR_MAX_TOKENS'
const MAX_AGENT_DEPTH_ENV_VAR = 'ORCHESTRATOR_MAX_AGENT_DEPTH'
const TOOL_TIMEOUT_SECONDS_ENV_VAR = 'ORCHESTRATOR_TOOL_TIMEOUT_SECONDS'
const MAX_COMPACTION_ATTEMPTS_ENV_VAR = 'ORCHESTRATOR_MAX_COMPACTION_ATTEMPTS'
const CONTEXT_PRESSURE_THRESHOLD_ENV_VAR = 'ORCHESTRATOR_CONTEXT_PRESSURE_THRESHOLD'
const CONTEXT_HANDLER_ROLE_ENV_VAR = 'ORCHESTRATOR_CONTEXT_HANDLER_ROLE'
const INQUIRY_HANDLER_ROLE_ENV_VAR = 'ORCHESTRATOR_INQUIRY_HANDLER_ROLE'
const INTERRUPT_HANDLER_ROLE_ENV_VAR = 'ORCHESTRATOR_INTERRUPT_HANDLER_ROLE'
const INTERRUPT_EVERY_TOOL_CALLS_ENV_VAR = 'ORCHESTRATOR_INTERRUPT_EVERY_TOOL_CALLS'
const INTERRUPT_EVERY_TOKENS_ENV_VAR = 'ORCHESTRATOR_INTERRUPT_EVERY_TOKENS'
const INTERRUPT_PLAN_OWNER_ROLE_ENV_VAR = 'ORCHESTRATOR_INTERRUPT_PLAN_OWNER_ROLE'
const MAX_TOOL_OUTPUT_CHARS_ENV_VAR = 'ORCHESTRATOR_MAX_TOOL_OUTPUT_CHARS'

function readString(value: string | undefined): string | undefined {
	if (value === undefined || value === '') return undefined
	return value
}

// Accepts only plain decimal digit strings so forms like `0x1a`, `1e3`, `8080.0`, or ` 8080 ` are rejected rather than silently coerced by Number() (the same discipline as parsePort in source/serve.ts).
function readPositiveInteger(name: string, value: string | undefined): number | undefined {
	if (value === undefined || value === '') return undefined
	if (!/^\d+$/.test(value)) throw new ConfigurationError(`${name} must be a positive integer (got "${value}")`)
	const parsed = Number(value)
	if (parsed <= 0) throw new ConfigurationError(`${name} must be a positive integer (got "${value}")`)
	return parsed
}

function readFiniteNumber(name: string, value: string | undefined): number | undefined {
	if (value === undefined || value === '') return undefined
	// Number() coerces a whitespace-only string to 0, which would silently turn a mistyped value into a valid number.
	if (value.trim() === '') throw new ConfigurationError(`${name} must be a finite number (got "${value}")`)
	const parsed = Number(value)
	if (!Number.isFinite(parsed)) throw new ConfigurationError(`${name} must be a finite number (got "${value}")`)
	return parsed
}

function readPressureThreshold(name: string, value: string | undefined): number | undefined {
	const parsed = readFiniteNumber(name, value)
	if (parsed === undefined) return undefined
	if (parsed <= 0 || parsed >= 1) throw new ConfigurationError(`${name} must be a number between 0 and 1, exclusive (got "${value}")`)
	return parsed
}

// A section attaches to the override only when at least one of its fields was set, so an override with nothing set is indistinguishable from no override at all.
function hasDefinedField(value: object): boolean {
	return Object.values(value).some((field) => field !== undefined)
}

export function resolveDeploymentOverride(environment: Record<string, string | undefined>): DeploymentOverride {
	const override: DeploymentOverride = {}

	const generation: GenerationOverride = {
		temperature: readFiniteNumber(TEMPERATURE_ENV_VAR, environment[TEMPERATURE_ENV_VAR]),
		maxTokens: readPositiveInteger(MAX_TOKENS_ENV_VAR, environment[MAX_TOKENS_ENV_VAR]),
	}
	const model: ModelOverride = {
		name: readString(environment[MODEL_ENV_VAR]),
		apiBase: readString(environment[API_BASE_ENV_VAR]),
		contextWindow: readPositiveInteger(MODEL_CONTEXT_WINDOW_ENV_VAR, environment[MODEL_CONTEXT_WINDOW_ENV_VAR]),
		reasoningField: readString(environment[REASONING_FIELD_ENV_VAR]),
		generation: hasDefinedField(generation) ? generation : undefined,
	}
	if (hasDefinedField(model)) override.model = model

	const interruptTriggers: InterruptTriggersOverride = {
		handlerRole: readString(environment[INTERRUPT_HANDLER_ROLE_ENV_VAR]),
		everyToolCalls: readPositiveInteger(INTERRUPT_EVERY_TOOL_CALLS_ENV_VAR, environment[INTERRUPT_EVERY_TOOL_CALLS_ENV_VAR]),
		everyTokens: readPositiveInteger(INTERRUPT_EVERY_TOKENS_ENV_VAR, environment[INTERRUPT_EVERY_TOKENS_ENV_VAR]),
		planOwnerRole: readString(environment[INTERRUPT_PLAN_OWNER_ROLE_ENV_VAR]),
	}
	const executor: ExecutorOverride = {
		maxAgentDepth: readPositiveInteger(MAX_AGENT_DEPTH_ENV_VAR, environment[MAX_AGENT_DEPTH_ENV_VAR]),
		defaultToolTimeoutSeconds: readPositiveInteger(TOOL_TIMEOUT_SECONDS_ENV_VAR, environment[TOOL_TIMEOUT_SECONDS_ENV_VAR]),
		maxCompactionAttempts: readPositiveInteger(MAX_COMPACTION_ATTEMPTS_ENV_VAR, environment[MAX_COMPACTION_ATTEMPTS_ENV_VAR]),
		contextPressureThreshold: readPressureThreshold(CONTEXT_PRESSURE_THRESHOLD_ENV_VAR, environment[CONTEXT_PRESSURE_THRESHOLD_ENV_VAR]),
		contextHandlerRole: readString(environment[CONTEXT_HANDLER_ROLE_ENV_VAR]),
		inquiryHandlerRole: readString(environment[INQUIRY_HANDLER_ROLE_ENV_VAR]),
		interruptTriggers: hasDefinedField(interruptTriggers) ? interruptTriggers : undefined,
	}
	if (hasDefinedField(executor)) override.executor = executor

	const contextPolicy: ContextPolicyOverride = {
		maxToolOutputChars: readPositiveInteger(MAX_TOOL_OUTPUT_CHARS_ENV_VAR, environment[MAX_TOOL_OUTPUT_CHARS_ENV_VAR]),
	}
	if (hasDefinedField(contextPolicy)) override.contextPolicy = contextPolicy

	return override
}

// The interrupt cadence's handlerRole/everyToolCalls/everyTokens are required fields, so when the base has no interruptTriggers section an override can only introduce it by carrying all three at once; a partial introduction would leave the merged deployment missing required values and fails here with the variables that must be set together.
function mergeInterruptTriggers(baseTriggers: InterruptTriggersConfig | undefined, overrideTriggers: InterruptTriggersOverride | undefined): InterruptTriggersConfig | undefined {
	if (baseTriggers === undefined && overrideTriggers === undefined) return undefined
	if (baseTriggers === undefined) {
		if (overrideTriggers === undefined || overrideTriggers.handlerRole === undefined || overrideTriggers.everyToolCalls === undefined || overrideTriggers.everyTokens === undefined) {
			throw new ConfigurationError(`${INTERRUPT_HANDLER_ROLE_ENV_VAR}, ${INTERRUPT_EVERY_TOOL_CALLS_ENV_VAR}, and ${INTERRUPT_EVERY_TOKENS_ENV_VAR} must all be set to introduce executor.interruptTriggers when the deployment file has no interruptTriggers section`)
		}
		return {
			handlerRole: overrideTriggers.handlerRole,
			everyToolCalls: overrideTriggers.everyToolCalls,
			everyTokens: overrideTriggers.everyTokens,
			planOwnerRole: overrideTriggers.planOwnerRole,
		}
	}
	return {
		handlerRole: overrideTriggers?.handlerRole ?? baseTriggers.handlerRole,
		everyToolCalls: overrideTriggers?.everyToolCalls ?? baseTriggers.everyToolCalls,
		everyTokens: overrideTriggers?.everyTokens ?? baseTriggers.everyTokens,
		planOwnerRole: overrideTriggers?.planOwnerRole ?? baseTriggers.planOwnerRole,
	}
}

// Pure per-field merge over the file-shaped deployment: a present override field replaces the base field, an absent one keeps the base value, and the nested generation and interruptTriggers objects merge per-field rather than wholesale. The result stays file-shaped (name and contextWindow may be absent); completing the model is resolveModelConfig's job. The result is fresh data — the base (the loader's cached deployment) is never handed out or mutated.
export function applyDeploymentOverride(base: DeploymentFileConfig, override: DeploymentOverride): DeploymentFileConfig {
	const model: ModelConfig = {
		name: override.model?.name ?? base.model.name,
		apiBase: override.model?.apiBase ?? base.model.apiBase,
		contextWindow: override.model?.contextWindow ?? base.model.contextWindow,
		reasoningField: override.model?.reasoningField ?? base.model.reasoningField,
		generation: {
			temperature: override.model?.generation?.temperature ?? base.model.generation.temperature,
			maxTokens: override.model?.generation?.maxTokens ?? base.model.generation.maxTokens,
		},
	}
	const interruptTriggers = mergeInterruptTriggers(base.executor.interruptTriggers, override.executor?.interruptTriggers)
	const executor = {
		maxAgentDepth: override.executor?.maxAgentDepth ?? base.executor.maxAgentDepth,
		defaultToolTimeoutSeconds: override.executor?.defaultToolTimeoutSeconds ?? base.executor.defaultToolTimeoutSeconds,
		maxCompactionAttempts: override.executor?.maxCompactionAttempts ?? base.executor.maxCompactionAttempts,
		contextPressureThreshold: override.executor?.contextPressureThreshold ?? base.executor.contextPressureThreshold,
		contextHandlerRole: override.executor?.contextHandlerRole ?? base.executor.contextHandlerRole,
		inquiryHandlerRole: override.executor?.inquiryHandlerRole ?? base.executor.inquiryHandlerRole,
		interruptTriggers,
	}
	const contextPolicy: ContextPolicy = {
		maxToolOutputChars: override.contextPolicy?.maxToolOutputChars ?? base.contextPolicy.maxToolOutputChars,
	}
	return { model, executor, contextPolicy }
}
