// Public surface of the executor runtime.
// External callers — the server entry point (`source/serve.ts`) and the offline Foundry — import from this module only.
// Internal helpers (the engine loop, context builder, budget checks, and the built-in tool handlers that are assembled mid-run with live role state) stay private to their own modules.
// See docs/reference.md "Executor runtime" and "Persistence".

export { runExecutor, resumeExecutor } from './executor.js'
export type { ExecutorDependencies, ResumeRunOptions } from './executor.js'

// llmUsagePayload is a public surface because the service's summarizer wiring (serve.ts) appends its summarizer_llm_call usage event through it, keeping the payload shape identical to the engine's usage events.
export { llmUsagePayload } from './engine.js'
export type { LlmUsagePayload, DiscardedRetrySpend } from './types.js'

export { ConfigurationError, ValidationError } from './errors.js'

export { createCheckpointRecorder, entryFrameLogLevel, isRunCheckpoint } from './checkpoint.js'
export type { CheckpointFrame, CheckpointRecorder, CheckpointRecorderDependencies, PendingChildSuspension, RunCheckpoint } from './checkpoint.js'

export type { RoleSnapshotStore } from './role-snapshot.js'

export { reconcileRunsOnStartup } from './startup-reconciliation.js'
export type { ReconciliationReport, StartupReconciliationDependencies } from './startup-reconciliation.js'

export { createLlmCaller, createLlmFetch, createSleep, createTimeoutScheduler } from './llm.js'
export type { LlmCaller, LlmCallResult, LlmCallerDependencies, LlmFetch, LlmRequest, LlmStreamDelta, ScheduleTimeout, Sleep } from './llm.js'

export { createGuildLoader } from './loader.js'
export type { LoadGuild, LoadedGuild, LoadedGuildFiles } from './loader.js'

export { createReadProjectDoc } from './project-docs.js'
export type { ReadProjectDoc, ReadProjectDocResult } from './project-docs.js'

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

export { createDeltaChannel } from './stream-channel.js'
export type { DeltaChannel, DeltaField, DeltaSubscriber, RoleDelta, RunDelta } from './stream-channel.js'

export { createRunSubmission, createResumeErroredRun, createReadParkedAskById, createResumeParkedRun } from './run-submission.js'
export type { ReadParkedAskById, ResumeErroredRun, ResumeErroredRunDependencies, ResumeErroredRunRejection, ResumeErroredRunResult, ResumeParkedRun, ResumeParkedRunDependencies, ResumeParkedRunRejection, ResumeParkedRunResult, ResumeRun, ResumeRunInvocation, RunSubmission, RunSubmissionDependencies, StartRun, SubmitResult } from './run-submission.js'

export { createTaskQueue } from './queue/index.js'
export type {
	QueueEnqueueOutcome,
	QueueHandles,
	QueueItemView,
	QueueMutationOutcome,
	QueuePatchInput,
	QueuePlacement,
	QueueSubmitOutcome,
	QueueStore,
	QueueView,
	QueuedRunSubmission,
	QueuedRunSubmitResult,
	RunListEntry,
	SubmitQueuedRun,
	TaskQueueDependencies,
	TaskQueueModule,
} from './queue/index.js'

export { createRunParkTracker, isWriteCapableRole, parkCard, parkSummary, questionFromParkSummary, PARK_SUMMARY_PREFIX, WRITE_CAPABLE_TOOL_NAMES } from './park-state.js'
export type { ParkedAnswer, ParkedAsk, RunParkTracker } from './park-state.js'

export { createRunBaseTracker } from './base-state.js'
export type { RunBaseTracker } from './base-state.js'

export { createReadWorkspaceGitState, formatWorkspaceGitNotice } from './git-state.js'
export type { ReadWorkspaceGitState, ReadWorkspaceGitStateConfig, WorkspaceGitState } from './git-state.js'

export { EMPTY_TREE_HASH } from './git-primitives.js'

export { createBunSubprocessRunner } from './subprocess.js'
export type { SubprocessRunner } from './subprocess.js'

export { ensureOrchestrationGitExcluded, nodeGitExcludeFilesystem } from './git-exclude.js'
export type { GitExcludeFilesystem, GitExcludeResult } from './git-exclude.js'

export { DEFAULT_EFFORT, effortDirective } from './effort.js'

export { DEFAULT_INVOLVEMENT, involvementDirective } from './involvement.js'

export { DEFAULT_LOG_LEVEL, applyLogLevel, isLogLevel } from './log-level.js'
export type { LogLevel } from './log-level.js'

export { isEffortLevel, isInvolvementLevel, isProjectSettings, isTerminalRunStatus, validateDeploymentFileConfig, validateDeploymentRoleReferences } from './validation.js'

export { createToolPlatform } from './tools/index.js'
export type { RunToolScope, ToolPlatform, ToolPlatformConfig, ToolPlatformDependencies } from './tools/index.js'

export { generateRunId } from './run-id.js'

export { createDockerSecretReader, resolveKagiApiKey } from './secrets.js'

export {
	createRunDirectory,
	createRunDirectoryExists,
	createAppendLog,
	createWriteMeta,
	createWriteCheckpoint,
	createDeleteCheckpoint,
	createRoleSnapshotStore,
	createReadRunCheckpointById,
	createRunCheckpointExists,
	createReadRunSnapshotById,
	createReadRunMetaById,
	createWriteRunSummary,
	createReadRunSummaryById,
	createReadRunPlanById,
	createReadRunSnapshotStats,
	createReadRunLogTextFrom,
	createReadRunSummaryStats,
	createListRunIds,
	createReadProjectSettings,
	createWriteProjectSettings,
	createReadQueueText,
	createWriteQueueText,
	LOG_FILE_NAME,
} from './persistence.js'
export type {
	RunDirectory,
	RunDirectoryExists,
	AppendLog,
	WriteMeta,
	WriteCheckpoint,
	DeleteCheckpoint,
	ReadRunCheckpointById,
	RunCheckpointExists,
	ReadRunSnapshotById,
	ReadRunMetaById,
	WriteRunSummary,
	ReadRunSummaryById,
	ReadRunPlanById,
	ReadRunSnapshotStats,
	ReadRunLogTextFrom,
	RunSummaryStats,
	ReadRunSummaryStats,
	RunSnapshotStats,
	RunSnapshotFileStat,
	ListRunIds,
	RunSnapshotRaw,
	ProjectSettings,
	ReadProjectSettings,
	WriteProjectSettings,
} from './persistence.js'

export type { DeploymentConfig, DeploymentFileConfig, LoggingConfig, ModelConfig, ResolvedModelConfig, RunContinuation, RunOptions, RunMeta, ResultCard, EffortLevel, InvolvementLevel } from './types.js'
