import { MODEL_CONTEXT_WINDOW_ENV_VAR, MODEL_ENV_VAR } from './deployment-env.js'
import { ConfigurationError } from './errors.js'
import type { DeploymentConfig, DeploymentFileConfig, GenerationConfig, ModelConfig, ResolvedModelConfig } from './types.js'
import { isObject } from './validation.js'

// One entry of the model API's OpenAI-compatible model listing: every server reports the id, and the context window arrives in whichever shape the catalog uses — llama.cpp reports the trained context size as meta.n_ctx, while rich catalog entries (PPQ) carry a top-level context_length. Entries carrying neither (OpenAI, vLLM) leave contextWindow absent.
export interface ModelApiInfo {
	id: string
	contextWindow?: number
}

// What the startup probe observed, handed to the resolver: models is the parsed listing on a successful probe (possibly empty) and undefined when the probe failed or was not attempted; failureReason explains a failed probe so an error can distinguish "unreachable" from "answered without the field".
export interface ModelApiProbe {
	apiBase: string
	models: ModelApiInfo[] | undefined
	failureReason: string | undefined
}

// Where a completed model field's value came from, for the startup log: the API's own report or the operator's configuration.
export type ModelValueSource = 'api' | 'configuration'

// The two interchangeable context-window sources: rich catalog entries report it top-level as context_length, llama.cpp nests it as meta.n_ctx. When an entry somehow carries both, context_length wins — they report the same number, so the choice only needs to be deterministic.
function apiContextWindowOf(entry: Record<string, unknown>): number | undefined {
	const contextLength = entry['context_length']
	if (typeof contextLength === 'number' && Number.isFinite(contextLength) && contextLength > 0) return contextLength
	const meta = entry['meta']
	if (!isObject(meta)) return undefined
	const nCtx = meta['n_ctx']
	if (typeof nCtx === 'number' && Number.isFinite(nCtx) && nCtx > 0) return nCtx
	return undefined
}

// Tolerant parse of a GET /models body: entries without a usable id are skipped and a body without a data array yields no entries rather than an error, because any of these means "the API reported nothing usable" — a fallback-to-configuration situation, not a crash.
export function parseModelInfo(body: unknown): ModelApiInfo[] {
	if (!isObject(body)) return []
	const data = body['data']
	if (!Array.isArray(data)) return []
	const models: ModelApiInfo[] = []
	for (const entry of data) {
		if (!isObject(entry)) continue
		const id = entry['id']
		if (typeof id !== 'string' || id === '') continue
		const model: ModelApiInfo = { id }
		const contextWindow = apiContextWindowOf(entry)
		if (contextWindow !== undefined) model.contextWindow = contextWindow
		models.push(model)
	}
	return models
}

const MISSING_NAME = `model.name is missing from the deployment configuration: set it in deployment.json ("model"."name") or via the ${MODEL_ENV_VAR} environment variable`
const MISSING_CONTEXT_WINDOW = `model.contextWindow is missing from the deployment configuration: set it in deployment.json ("model"."contextWindow") or via the ${MODEL_CONTEXT_WINDOW_ENV_VAR} environment variable`

// The trailing clause of a missing-field error: it separates "the API was unreachable (here is why)" from "the API answered but did not report the field", so the operator knows whether to fix the endpoint or set the value.
function apiOutcomeClause(probe: ModelApiProbe): string {
	if (probe.models !== undefined) return 'the model API did not report it'
	if (probe.failureReason !== undefined) return `the model API at ${probe.apiBase} could not be probed (${probe.failureReason})`
	return 'the model API was not probed'
}

function singleModel(models: ModelApiInfo[]): ModelApiInfo | undefined {
	const [first] = models
	return models.length === 1 ? first : undefined
}

function resolveName(configuredName: string | undefined, probe: ModelApiProbe): { name: string; source: ModelValueSource } {
	// A configured name is a selection, not a duplication: the operator may point at one model among several, so it always wins over discovery.
	if (configuredName !== undefined) return { name: configuredName, source: 'configuration' }
	if (probe.models === undefined) throw new ConfigurationError(`${MISSING_NAME}; ${apiOutcomeClause(probe)}`)
	const single = singleModel(probe.models)
	if (single !== undefined) return { name: single.id, source: 'api' }
	if (probe.models.length === 0) throw new ConfigurationError(`${MISSING_NAME}; ${apiOutcomeClause(probe)}`)
	throw new ConfigurationError(`${MISSING_NAME}; the model API at ${probe.apiBase} serves several models (${probe.models.map((model) => model.id).join(', ')}), so no single name can be discovered — set model.name to one of them`)
}

// The API entry matching the resolved model, whose meta.n_ctx is the server's ground truth for its context window: by configured name when one is set, otherwise the only served model (the name-discovery case). A configured name that no server lists simply never matches — some servers ignore the model field — and the stale name surfaces at request time if the endpoint cares.
function matchApiModel(probe: ModelApiProbe, configuredName: string | undefined): ModelApiInfo | undefined {
	if (probe.models === undefined) return undefined
	if (configuredName !== undefined) return probe.models.find((model) => model.id === configuredName)
	return singleModel(probe.models)
}

function resolveContextWindow(configuredContextWindow: number | undefined, probe: ModelApiProbe, configuredName: string | undefined): { contextWindow: number; source: ModelValueSource; apiContextWindow: number | undefined } {
	// The API's report of the model's context window is ground truth and always wins: the configured value is at best a duplicate of what the server trains to, and a stale duplicate is the misconfiguration this resolution exists to eliminate.
	const apiContextWindow = matchApiModel(probe, configuredName)?.contextWindow
	if (apiContextWindow !== undefined) return { contextWindow: apiContextWindow, source: 'api', apiContextWindow }
	if (configuredContextWindow !== undefined) return { contextWindow: configuredContextWindow, source: 'configuration', apiContextWindow: undefined }
	throw new ConfigurationError(`${MISSING_CONTEXT_WINDOW}; ${apiOutcomeClause(probe)}`)
}

interface ModelResolutionDetails {
	model: ResolvedModelConfig
	nameSource: ModelValueSource
	contextWindowSource: ModelValueSource
	apiContextWindow: number | undefined
}

// Present-but-invalid configured values are treated as absent so the helpful missing-field error fires instead of a silently garbage resolution: the file validator and the env parser already reject them, this is defense in depth for values that reach the resolver by other paths.
function configuredNameOf(fileModel: ModelConfig): string | undefined {
	if (fileModel.name === undefined || fileModel.name === '') return undefined
	return fileModel.name
}

function configuredContextWindowOf(fileModel: ModelConfig): number | undefined {
	if (fileModel.contextWindow === undefined || !Number.isFinite(fileModel.contextWindow) || fileModel.contextWindow <= 0) return undefined
	return fileModel.contextWindow
}

// A completion budget at or above the context window can never produce a valid request (the prompt shares the same window, so the server would reject every call), so it is a misconfiguration to fail fast on. It lives here — where the final window (API-reported or configured) is known — so both the startup probe and offline resolution catch it.
function assertMaxTokensBelowContextWindow(generation: GenerationConfig, contextWindow: number): void {
	const maxTokens = generation.maxTokens
	if (maxTokens === undefined || maxTokens < contextWindow) return
	throw new ConfigurationError(`model.generation.maxTokens (${maxTokens}) must be smaller than the model's context window (${contextWindow}): lower it ("model"."generation"."maxTokens" in deployment.json) or raise the model's context window`)
}

function resolveModelDetails(fileModel: ModelConfig, probe: ModelApiProbe): ModelResolutionDetails {
	const configuredName = configuredNameOf(fileModel)
	const configuredContextWindow = configuredContextWindowOf(fileModel)
	const name = resolveName(configuredName, probe)
	const context = resolveContextWindow(configuredContextWindow, probe, configuredName)
	assertMaxTokensBelowContextWindow(fileModel.generation, context.contextWindow)
	return {
		model: { name: name.name, apiBase: fileModel.apiBase, contextWindow: context.contextWindow, generation: fileModel.generation },
		nameSource: name.source,
		contextWindowSource: context.source,
		apiContextWindow: context.apiContextWindow,
	}
}

// Completes the deployment file's model into the resolved model the executor consumes: the engine reads name and contextWindow as required values, so absence from both configuration and the model API is a startup failure naming both configuration channels and what the probe observed.
export function resolveModelConfig(fileModel: ModelConfig, probe: ModelApiProbe): ResolvedModelConfig {
	return resolveModelDetails(fileModel, probe).model
}

// The resolved deployment plus what the startup log needs to make the resolution visible: where each completed model field came from, and the API-reported context window (when the API reported one) so an API-over-configuration override can be called out explicitly.
export interface DeploymentResolution {
	deployment: DeploymentConfig
	nameSource: ModelValueSource
	contextWindowSource: ModelValueSource
	apiContextWindow: number | undefined
}

// Shared completion of the file-shaped deployment into the resolved shape the executor consumes, used by the service startup (which probes the API first) and by offline consumers over checked-in data (which pass a not-attempted probe and so require complete configuration).
export function resolveDeploymentConfig(fileDeployment: DeploymentFileConfig, probe: ModelApiProbe): DeploymentResolution {
	const details = resolveModelDetails(fileDeployment.model, probe)
	return {
		deployment: { model: details.model, executor: fileDeployment.executor, contextPolicy: fileDeployment.contextPolicy },
		nameSource: details.nameSource,
		contextWindowSource: details.contextWindowSource,
		apiContextWindow: details.apiContextWindow,
	}
}
