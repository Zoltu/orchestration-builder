import { DEFAULT_EFFORT } from './effort.js'
import type { ResultCard, RunContinuation, RunMeta, RunOptions } from './types.js'
import { createCheckpointRecorder, entryFrameLogLevel, type RunCheckpoint } from './checkpoint.js'
import { createContextPressureTracker } from './context-pressure.js'
import type { RunBaseTracker } from './base-state.js'
import { createRunParkTracker } from './park-state.js'
import { EMPTY_TREE_HASH } from './tools/git.js'
import { formatWorkspaceGitNotice, type ReadWorkspaceGitState } from './git-state.js'
import { runRole } from './engine.js'
import { logEvent, type EngineContext, type EngineDependencies } from './engine-state.js'
import type { HumanBackend } from './human-backend.js'
import type { InterruptQueue } from './interrupts.js'
import type { LlmCaller } from './llm.js'
import type { LoadedGuild } from './loader.js'
import type { AppendLog, DeleteCheckpoint, RunDirectory, WriteCheckpoint, WriteMeta } from './persistence.js'
import type { ReadProjectDoc } from './project-docs.js'
import { resumeRoleStack } from './resume.js'
import { createRoleRegistry } from './role-registry.js'
import type { RoleSnapshotStore } from './role-snapshot.js'
import type { ToolHandler } from './tool-dispatch.js'
import type { RoleDelta } from './stream-channel.js'

export interface ExecutorDependencies {
	llmCaller: LlmCaller
	appendLog: AppendLog
	additionalToolHandlers: Record<string, ToolHandler>
	humanBackend: HumanBackend
	// The service-bound, resolved guild (the LoadedGuild constructed at startup, deployment included); not the loader's file-shaped LoadGuild, which the startup path completes first. The name deliberately differs from LoadGuild: the loader reads files, this field carries the already-loaded guild.
	loadedGuild: LoadedGuild
	createRunDirectory: RunDirectory
	writeMeta: WriteMeta
	writeCheckpoint: WriteCheckpoint
	deleteCheckpoint: DeleteCheckpoint
	// The run's interrupt queue, created by the caller so the service API can submit operator interrupts while the run is in flight; the engine drains it at turn boundaries. The role registry is run-internal and created here.
	interruptQueue: InterruptQueue
	// The run-scoped streaming-delta publisher, provided by the caller (bound to the shared delta channel in serve.ts); the engine stamps every streamed text delta with the publishing role. Required like the rest of the run-scoped leaves.
	publishDelta: (delta: RoleDelta) => void
	// The per-run store of finished child conversations, so a parent can continue a finished child as a new seeded instance.
	roleSnapshots: RoleSnapshotStore
	// The leaf that reads a role's declared projectDocs from the workspace (project-docs.ts), closed over the workspace root by the service. Rides into EngineDependencies so buildInitialHistory can inject the entry role's project-context block at run start.
	readProjectDoc: ReadProjectDoc
	// The run-scoped base commit state, created by the caller so the service can share it with the git tool handlers; runExecutor records the starting base and resumeExecutor restores it from the checkpoint.
	baseTracker: RunBaseTracker
	// The leaf that reads the workspace's git state once at run start (git-state.ts), closed over the workspace root by the service. runExecutor uses it to record the base and build the entry role's git notice.
	readWorkspaceGitState: ReadWorkspaceGitState
}

// The per-run identity and restore state buildEngineDependencies threads into the engine. A fresh run supplies only runId/startTime/registryCounter plus its continuation and queue flags; the resume path additionally restores the checkpoint's learned ceiling, write-capability flag, and base.
interface EngineDependencyInput {
	runId: string
	startTime: string
	registryCounter: number
	learnedContextCeiling?: number
	writeCapableStarted?: boolean
	continuesFrom?: string
	queueTracked?: boolean
	baseHash?: string
}

function buildEngineDependencies(deps: ExecutorDependencies, input: EngineDependencyInput): EngineDependencies {
	const roleRegistry = createRoleRegistry(input.registryCounter)
	const contextPressureTracker = createContextPressureTracker(input.learnedContextCeiling)
	// The resume path seeds the park tracker from the checkpoint so a restart cannot reset the write-capability flag and park a run whose writes happened before the restart (docs/queueing.md "Parking: the pre-write rule"). The queue-tracking mark is NOT restored here: it is set only by the dispatch path of the process that dispatched the run, so a boot-resumed run blocks on ask_human (answerable through /api/answer) instead of parking into a question no endpoint can answer.
	const parkTracker = createRunParkTracker(input.writeCapableStarted, input.queueTracked)
	// The resume path restores the base from the checkpoint so a restart keeps diffing against the same change set; a fresh run records it after reading the workspace's git state.
	if (deps.baseTracker.baseHash === undefined && input.baseHash !== undefined) deps.baseTracker.baseHash = input.baseHash
	return {
		llmCaller: deps.llmCaller,
		appendLog: deps.appendLog,
		additionalToolHandlers: deps.additionalToolHandlers,
		humanBackend: deps.humanBackend,
		roleRegistry,
		interruptQueue: deps.interruptQueue,
		contextPressureTracker,
		publishDelta: deps.publishDelta,
		roleSnapshots: deps.roleSnapshots,
		readProjectDoc: deps.readProjectDoc,
		parkTracker,
		baseTracker: deps.baseTracker,
		// The run's lineage rides the recorder so checkpoints written after a resume keep stamping continuesFrom onto the entry frame — the live context does not carry it on the resume path. The logging level needs no such stamp: the entry context carries it and the recorder serializes from there.
		checkpointRecorder: createCheckpointRecorder({ writeCheckpoint: deps.writeCheckpoint, runId: input.runId, startTime: input.startTime, roleRegistry, contextPressureTracker, parkTracker, baseTracker: deps.baseTracker, continuesFrom: input.continuesFrom }),
	}
}

// The one composer for the executor's meta writes: identity fields map from the run's options (the optional ones spread only when present), the caller pins the status and start time, and a terminal write passes the result card, which fixes the end time at composition. The running writes and the terminal write all compose here so the optional-field mapping is spelled once.
function composeRunMeta(options: RunOptions, startTime: string, status: RunMeta['status'], result?: ResultCard): RunMeta {
	return {
		runId: options.runId,
		guildPath: options.guildPath,
		...(options.benchmarkPath !== undefined ? { benchmarkPath: options.benchmarkPath } : {}),
		task: options.task,
		effort: options.effort,
		...(options.logLevel !== undefined ? { logLevel: options.logLevel } : {}),
		// Only a genuine continuation stamps the lineage: a briefing-only continuation (a first queue dispatch) has no prior run, and meta.continuesFrom must stay honest.
		...(options.continuation?.runId !== undefined ? { continuesFrom: options.continuation.runId } : {}),
		status,
		startTime,
		...(result === undefined ? {} : { endTime: new Date().toISOString(), result }),
	}
}

export async function runExecutor(deps: ExecutorDependencies, options: RunOptions): Promise<RunMeta> {
	deps.createRunDirectory()

	const loadedGuild = deps.loadedGuild

	const startTime = new Date().toISOString()
	// effort_set is logged once at run start so the trace records the chosen level before the entry role begins.
	logEvent(deps.appendLog, 'effort_set', { effort: options.effort })
	// Write a running meta before the entry role begins so the UI can show the task, run id, and start time while the run is in progress, rather than only after completion. It is overwritten with the terminal meta below.
	deps.writeMeta(composeRunMeta(options, startTime, 'running'))
	const engineDeps = buildEngineDependencies(deps, { runId: options.runId, startTime, registryCounter: 0, continuesFrom: options.continuation?.runId, queueTracked: options.queueTracked })
	// The workspace's git state is read once, before the entry role's history is built: it records the default base (HEAD, or the empty tree when HEAD is unborn) and supplies the entry role's git notice. A workspace with no repository simply records no base and injects no notice.
	const gitState = await deps.readWorkspaceGitState()
	if (gitState.isRepository) {
		if (deps.baseTracker.baseHash === undefined) {
			const initialBase = gitState.unbornHead ? EMPTY_TREE_HASH : gitState.headHash
			if (initialBase !== undefined) deps.baseTracker.baseHash = initialBase
		}
		if (gitState.uncommittedPaths.length > 0) {
			logEvent(deps.appendLog, 'workspace_dirty_at_start', { count: gitState.uncommittedPaths.length })
		}
	}
	// The notice is undefined when there is no repository, so a non-repository workspace injects nothing rather than a "not a git repository" line.
	const workspaceGitNotice = formatWorkspaceGitNotice(gitState)
	const entryContext: EngineContext = {
		loadedGuild,
		depth: 0,
		roleName: loadedGuild.config.entryRole,
		task: options.task,
		effort: options.effort,
		...(options.logLevel !== undefined ? { logLevel: options.logLevel } : {}),
		...(options.continuation !== undefined ? { continuation: options.continuation } : {}),
		...(workspaceGitNotice !== undefined ? { workspaceGitNotice } : {}),
	}
	const result = await runRole(engineDeps, entryContext)

	const meta = composeRunMeta(options, startTime, result.status, result)

	deps.writeMeta(meta)
	// The terminal meta is the authoritative record, and the checkpoint is removed so a restart never considers resuming a finished run — except when the terminal status is 'error': an error run's checkpoint is kept so the operator can explicitly resume the run with its full context (docs/queueing.md "Resume of an errored run"). Startup reconciliation never auto-resumes one — it considers only runs whose meta reads 'running' — so a kept checkpoint makes the run resumable, not resumed.
	if (result.status !== 'error') deps.deleteCheckpoint()

	return meta
}

export interface ResumeRunOptions {
	guildPath: string
	benchmarkPath?: string
	// The framed operator note on an explicit resume of an errored run; the resumed leaf role's loop entry appends it to the restored history (see resumeRoleStack). Absent for boot reconciliation, which injects nothing.
	operatorNote?: string
}

// Resumes a run from its checkpoint after a service restart. The run's identity (run id, task, effort, start time) comes from the checkpoint — the meta keeps the original startTime so elapsed-time accounting survives the restart. The stack is reconstructed by resumeRoleStack and the run continues from the suspended leaf.
export async function resumeExecutor(deps: ExecutorDependencies, checkpoint: RunCheckpoint, options: ResumeRunOptions): Promise<RunMeta> {
	const entryFrame = checkpoint.frames[0]
	if (entryFrame === undefined) throw new Error(`resumeExecutor: checkpoint for run ${checkpoint.runId} has no frames`)
	const task = entryFrame.task
	const effort = entryFrame.effort ?? DEFAULT_EFFORT
	const logLevel = entryFrameLogLevel(entryFrame)
	// The checkpoint carries the lineage id only (not the prior task/summary): on resume the entry role's history — the briefing included — is restored from the checkpoint verbatim, so the full continuation object is never recomposed and the empty task/summary here exist only so the metas keep the continuesFrom field.
	const continuation: RunContinuation | undefined = entryFrame.continuesFrom !== undefined ? { runId: entryFrame.continuesFrom, task: '', summary: '' } : undefined
	const runOptions: RunOptions = {
		runId: checkpoint.runId,
		guildPath: options.guildPath,
		...(options.benchmarkPath !== undefined ? { benchmarkPath: options.benchmarkPath } : {}),
		task,
		effort,
		logLevel,
		...(continuation !== undefined ? { continuation } : {}),
	}

	// No createRunDirectory here: a resume re-enters the run directory the checkpoint was read from, which therefore exists — and createRunDirectory refuses existing directories because a fresh run must never share one.

	const loadedGuild = deps.loadedGuild

	const startTime = checkpoint.startTime
	// run_resumed marks the restart boundary in the log: events before it belong to the pre-restart process, events after it to the resumed run. Resumed roles do not re-emit role_start, so a reviewer can tell why. An explicit error-resume stamps the operator's note on the boundary so the log shows the human intervention as well.
	logEvent(deps.appendLog, 'run_resumed', { runId: checkpoint.runId, resumedFrames: checkpoint.frames.length, ...(options.operatorNote !== undefined ? { operatorNote: options.operatorNote } : {}) })
	// Re-assert the running meta: the pre-restart write may never have landed, and the terminal meta overwrites it below either way. On an explicit error-resume this same write flips the run's terminal error meta back to running — the old error card belongs to the log, not the live meta.
	deps.writeMeta(composeRunMeta(runOptions, startTime, 'running'))
	const result = await resumeRoleStack(
		runRole,
		buildEngineDependencies(deps, { runId: checkpoint.runId, startTime, registryCounter: checkpoint.registryCounter, learnedContextCeiling: checkpoint.learnedContextCeiling, writeCapableStarted: checkpoint.writeCapableStarted, continuesFrom: entryFrame.continuesFrom, baseHash: checkpoint.baseHash }),
		loadedGuild,
		checkpoint,
		options.operatorNote,
	)

	const meta = composeRunMeta(runOptions, startTime, result.status, result)

	deps.writeMeta(meta)
	// Same checkpoint rule as the fresh-run path: an error run stays resumable from its checkpoint, every other terminal status cleans up.
	if (result.status !== 'error') deps.deleteCheckpoint()

	return meta
}
