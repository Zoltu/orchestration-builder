// Public surface of the executor runtime.
// External callers — the server entry point (`source/serve.ts`) and the offline Foundry — import from this module only.
// Internal helpers (the engine loop, context builder, budget checks, and the built-in tool handlers that are assembled mid-run with live role state) stay private to their own modules.
// See docs/reference.md "Executor runtime" and "Persistence".

export { runExecutor, resumeExecutor } from './executor.js'
export type { ExecutorDependencies, ResumeRunOptions } from './executor.js'

export { ConfigurationError, ValidationError } from './errors.js'

export { createCheckpointRecorder, entryFrameLogLevel, isRunCheckpoint } from './checkpoint.js'
export type { CheckpointFrame, CheckpointRecorder, CheckpointRecorderDependencies, PendingAgentSuspension, RunCheckpoint } from './checkpoint.js'

export { reconcileRunsOnStartup } from './startup-reconciliation.js'
export type { ReconciliationReport, StartupReconciliationDependencies } from './startup-reconciliation.js'

export { createLlmCaller, createLlmFetch, createSleep, createTimeoutScheduler } from './llm.js'
export type { LlmCaller, LlmCallResult, LlmCallerDependencies, LlmFetch, LlmRequest, LlmStreamDelta, ScheduleTimeout, Sleep } from './llm.js'

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

export { createDeltaChannel } from './stream-channel.js'
export type { DeltaChannel, DeltaField, DeltaSubscriber, RoleDelta, RunDelta } from './stream-channel.js'

export { createRunSubmission } from './run-submission.js'
export type { ResumeRun, RunSubmission, RunSubmissionDependencies, StartRun, SubmitResult } from './run-submission.js'

export { createTaskScheduler, COLLISION_RETRY_DELAY_MS, MAX_COLLISION_RETRIES } from './scheduler.js'
export type { QueuedRunSubmission, SubmitQueuedRun, TaskScheduler, TaskSchedulerDependencies } from './scheduler.js'

export { isQueueItem, isTaskQueue, normalizeNewItem, enqueueAtTail, enqueueAtHead, reorderWaitingItem, cancelWaitingItem, recordAnswer, requeueErrorItem, releaseToWaiting, dispatchingItem, withReplacedItem, mapSettledItemState, settleActiveItem, repairActiveItem, assembleBriefingLines, MAX_BRIEFING_RUN_LINES } from './task-queue.js'
export type { ActiveItemRepair, BriefingInput, NewQueueItemResult, QueueItem, QueueItemStatus, QueueMutation, QueueMutationRejection, RunListEntry, SettlementOutcome, TaskQueue, TerminalItemState } from './task-queue.js'

export { createRunParkTracker, isWriteCapableRole, parkCard, parkSummary, questionFromParkSummary, PARK_SUMMARY_PREFIX, WRITE_CAPABLE_TOOL_NAMES } from './park-state.js'
export type { RunParkTracker } from './park-state.js'

export { ensureOrchestrationGitExcluded, nodeGitExcludeFilesystem } from './git-exclude.js'
export type { GitExcludeFilesystem, GitExcludeResult } from './git-exclude.js'

export { DEFAULT_EFFORT, effortDirective } from './effort.js'

export { DEFAULT_LOG_LEVEL, applyLogLevel, isLogLevel } from './log-level.js'
export type { LogLevel } from './log-level.js'

export { isEffortLevel, isProjectSettings, isTerminalRunStatus, validateDeploymentFileConfig, validateDeploymentRoleReferences } from './validation.js'

export { createToolHandlers } from './tools.js'
export type { NativeToolsConfig } from './tools.js'

export { createPlanToolHandlers } from './tools/plan.js'

export { createRunLogToolHandlers } from './tools/run-log.js'

export { generateRunId } from './run-id.js'

export { createDockerSecretReader, resolveKagiApiKey } from './tools/kagi.js'

export {
	createRunDirectory,
	createRunDirectoryExists,
	createAppendLog,
	createWriteMeta,
	createWriteCheckpoint,
	createDeleteCheckpoint,
	createReadRunCheckpointById,
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
	createReadQueue,
	createWriteQueue,
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
	ReadTaskQueue,
	WriteTaskQueue,
} from './persistence.js'

export type { DeploymentConfig, DeploymentFileConfig, LoggingConfig, ModelConfig, ResolvedModelConfig, RunContinuation, RunOptions, RunMeta, ResultCard, EffortLevel } from './types.js'
