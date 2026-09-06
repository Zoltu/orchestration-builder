import { MODEL_CONTEXT_WINDOW_ENV_VAR, MODEL_ENV_VAR } from './deployment-env.js'
import { ConfigurationError } from './errors.js'
import type { ModelConfig, ResolvedModelConfig } from './types.js'

// Completes the deployment file's model into the resolved model the executor consumes: the engine reads name and contextWindow as required values, so their absence from configuration is a startup failure rather than a type-erased undefined deep in a run. Each error names both configuration channels (the deployment file field and its environment variable) and reports that the model API has not been probed, since nothing else can have supplied the field yet.
export function resolveModelConfig(fileModel: ModelConfig): ResolvedModelConfig {
	if (fileModel.name === undefined) {
		throw new ConfigurationError(`model.name is missing from the deployment configuration: set it in deployment.json ("model"."name") or via the ${MODEL_ENV_VAR} environment variable; the model API has not been probed, so no name has been discovered from it`)
	}
	if (fileModel.contextWindow === undefined) {
		throw new ConfigurationError(`model.contextWindow is missing from the deployment configuration: set it in deployment.json ("model"."contextWindow") or via the ${MODEL_CONTEXT_WINDOW_ENV_VAR} environment variable; the model API has not been probed, so no context window has been discovered from it`)
	}
	return {
		name: fileModel.name,
		apiBase: fileModel.apiBase,
		contextWindow: fileModel.contextWindow,
		reasoningField: fileModel.reasoningField,
		generation: fileModel.generation,
	}
}
