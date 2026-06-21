// Public surface of the executor runtime.
// External callers — the CLI entry point (`source/main.ts`) and the offline Foundry — import from this module only.
// Internal helpers (the engine loop, context builder, budget checks, and the built-in tool handlers that are assembled mid-run with live role state) stay private to their own modules.
// See docs/executor.md "Run lifecycle".

export { runExecutor } from './executor.js'
export type { ExecutorDependencies } from './executor.js'

export { createLlmCaller } from './llm.js'
export type { LlmCaller, LlmCallResult, LlmRequest } from './llm.js'

export { createGuildLoader } from './loader.js'
export type { LoadGuild, LoadedGuild } from './loader.js'

export { createHumanBackend, createWebHumanBackend } from './human-backend.js'
export type { HumanBackend, HumanBackendConfig, WebHumanBackend } from './human-backend.js'

export { createRunState } from './run-state.js'
export type { RunState } from './run-state.js'

export { createRunSubmission } from './run-submission.js'
export type { RunSubmission, RunSubmissionDependencies, StartRun, SubmitResult } from './run-submission.js'

export { createToolHandlers } from './tools.js'
export type { NativeToolsConfig } from './tools.js'

export {
	createRunDirectory,
	createCopyWorkspace,
	createAppendLog,
	createWriteMeta,
	createSnapshotWorkspace,
	createReadRunSnapshotById,
	createListRunIds,
} from './persistence.js'
export type {
	RunDirectory,
	CopyWorkspace,
	AppendLog,
	WriteMeta,
	SnapshotWorkspace,
	ReadRunSnapshotById,
	ListRunIds,
	RunSnapshotRaw,
} from './persistence.js'

export type { ModelConfig, RunOptions, RunMeta, ResultCard } from '../shared/types.js'
