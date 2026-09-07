// Public surface of the executor runtime.
// External callers — the server entry point (`source/serve.ts`) and the offline Foundry — import from this module only.
// Internal helpers (the engine loop, context builder, budget checks, and the built-in tool handlers that are assembled mid-run with live role state) stay private to their own modules.
// See docs/reference.md "Executor runtime" and "Persistence".

export { runExecutor, resumeExecutor } from './executor.js'
export type { ExecutorDependencies, ResumeRunOptions } from './executor.js'

export { ConfigurationError, ValidationError } from './errors.js'

export { createCheckpointRecorder, isRunCheckpoint } from './checkpoint.js'
export type { CheckpointFrame, CheckpointRecorder, CheckpointRecorderDependencies, PendingAgentSuspension, RunCheckpoint } from './checkpoint.js'

export { reconcileRunsOnStartup } from './startup-reconciliation.js'
export type { ReconciliationReport, StartupReconciliationDependencies } from './startup-reconciliation.js'

export { createLlmCaller, createLlmFetch, createSleep } from './llm.js'
export type { LlmCaller, LlmCallResult, LlmCallerDependencies, LlmFetch, LlmRequest, Sleep } from './llm.js'

export { createGuildLoader } from './loader.js'
export type { LoadGuild, LoadedGuild, LoadedGuildFiles } from './loader.js'

export { createModelInfoProbe, MODEL_PROBE_TIMEOUT_MS } from './model-probe.js'
export type { ModelProbeResult } from './model-probe.js'

// resolveModelConfig is deliberately not re-exported here: its callers all go through resolveDeploymentConfig, and the model-level entry point is exercised directly against model-resolution.ts by its tests.
export { parseModelInfo, resolveDeploymentConfig } from './model-resolution.js'
export type { DeploymentResolution, ModelApiInfo, ModelApiProbe, ModelValueSource } from './model-resolution.js'

export { applyDeploymentOverride, resolveDeploymentOverride } from './deployment-env.js'
export type { ContextPolicyOverride, DeploymentOverride, ExecutorOverride, GenerationOverride, InterruptTriggersOverride, ModelOverride } from './deployment-env.js'

export { resolveSecret } from './secrets.js'
export type { SecretChannels } from './secrets.js'

export { createWebHumanBackend } from './human-backend.js'
export type { HumanBackend, WebHumanBackend } from './human-backend.js'

export { createRunState } from './run-state.js'
export type { RunState } from './run-state.js'

export { createInterruptChannel, createInterruptQueue } from './interrupts.js'
export type { InterruptChannel, InterruptQueue, InterruptRequest, InterruptSubmitResult } from './interrupts.js'

export { createRunSubmission } from './run-submission.js'
export type { ResumeRun, RunSubmission, RunSubmissionDependencies, StartRun, SubmitResult } from './run-submission.js'

export { DEFAULT_EFFORT, effortDirective } from './effort.js'

export { isEffortLevel, isProjectSettings, validateDeploymentFileConfig, validateDeploymentRoleReferences } from './validation.js'

export { createToolHandlers } from './tools.js'
export type { NativeToolsConfig } from './tools.js'

export { createPlanToolHandlers } from './tools/plan.js'

export { generateRunId } from './run-id.js'

export { createDockerSecretReader, resolveKagiApiKey } from './tools/kagi.js'

export {
	createRunDirectory,
	createAppendLog,
	createWriteMeta,
	createWriteCheckpoint,
	createDeleteCheckpoint,
	createReadRunCheckpointById,
	createReadRunSnapshotById,
	createReadRunMetaById,
	createWriteRunSummary,
	createReadRunSummaryById,
	createReadRunSnapshotStats,
	createListRunIds,
	createReadProjectSettings,
	createWriteProjectSettings,
} from './persistence.js'
export type {
	RunDirectory,
	AppendLog,
	WriteMeta,
	WriteCheckpoint,
	DeleteCheckpoint,
	ReadRunCheckpointById,
	ReadRunSnapshotById,
	ReadRunMetaById,
	WriteRunSummary,
	ReadRunSummaryById,
	ReadRunSnapshotStats,
	RunSnapshotStats,
	RunSnapshotFileStat,
	ListRunIds,
	RunSnapshotRaw,
	ProjectSettings,
	ReadProjectSettings,
	WriteProjectSettings,
} from './persistence.js'

export type { DeploymentConfig, DeploymentFileConfig, ModelConfig, ResolvedModelConfig, RunOptions, RunMeta, ResultCard, EffortLevel } from './types.js'
