import { DEFAULT_EFFORT } from './effort.js'
import type { ResultCard, RunContinuation, RunMeta, RunOptions } from './types.js'
import { createCheckpointRecorder, entryFrameLogLevel, type RunCheckpoint } from './checkpoint.js'
import { createContextPressureTracker } from './context-pressure.js'
import { createRunParkTracker } from './park-state.js'
import { runRole } from './engine.js'
import { logEvent, type EngineDependencies } from './engine-state.js'
import type { HumanBackend } from './human-backend.js'
import type { InterruptQueue } from './interrupts.js'
import type { LlmCaller } from './llm.js'
import type { LoadedGuild } from './loader.js'
import type { AppendLog, DeleteCheckpoint, RunDirectory, WriteCheckpoint, WriteMeta } from './persistence.js'
import { resumeRoleStack } from './resume.js'
import { createRoleRegistry } from './role-registry.js'
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
}

function buildEngineDependencies(deps: ExecutorDependencies, runId: string, startTime: string, registryCounter: number, learnedContextCeiling: number | undefined, writeCapableStarted: boolean | undefined, continuesFrom: string | undefined): EngineDependencies {
	const roleRegistry = createRoleRegistry(registryCounter)
	const contextPressureTracker = createContextPressureTracker(learnedContextCeiling)
	// The resume path seeds the park tracker from the checkpoint so a restart cannot reset the write-capability flag and park a run whose writes happened before the restart (docs/queueing.md "Parking: the pre-write rule").
	const parkTracker = createRunParkTracker(writeCapableStarted)
	return {
		llmCaller: deps.llmCaller,
		appendLog: deps.appendLog,
		additionalToolHandlers: deps.additionalToolHandlers,
		humanBackend: deps.humanBackend,
		roleRegistry,
		interruptQueue: deps.interruptQueue,
		contextPressureTracker,
		publishDelta: deps.publishDelta,
		parkTracker,
		// The run's lineage rides the recorder so checkpoints written after a resume keep stamping continuesFrom onto the entry frame — the live context does not carry it on the resume path. The logging level needs no such stamp: the entry context carries it and the recorder serializes from there.
		checkpointRecorder: createCheckpointRecorder({ writeCheckpoint: deps.writeCheckpoint, runId, startTime, roleRegistry, contextPressureTracker, parkTracker, continuesFrom }),
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
	const result = await runRole(
		buildEngineDependencies(deps, options.runId, startTime, 0, undefined, undefined, options.continuation?.runId),
		{
			loadedGuild,
			depth: 0,
			roleName: loadedGuild.config.entryRole,
			task: options.task,
			effort: options.effort,
			...(options.logLevel !== undefined ? { logLevel: options.logLevel } : {}),
			...(options.continuation !== undefined ? { continuation: options.continuation } : {}),
		},
	)

	const meta = composeRunMeta(options, startTime, result.status, result)

	deps.writeMeta(meta)
	// The terminal meta is the authoritative record; the checkpoint is removed so a restart never considers resuming a finished run.
	deps.deleteCheckpoint()

	return meta
}

export interface ResumeRunOptions {
	guildPath: string
	benchmarkPath?: string
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
	// run_resumed marks the restart boundary in the log: events before it belong to the pre-restart process, events after it to the resumed run. Resumed roles do not re-emit role_start, so a reviewer can tell why.
	logEvent(deps.appendLog, 'run_resumed', { runId: checkpoint.runId, resumedFrames: checkpoint.frames.length })
	// Re-assert the running meta: the pre-restart write may never have landed, and the terminal meta overwrites it below either way.
	deps.writeMeta(composeRunMeta(runOptions, startTime, 'running'))
	const result = await resumeRoleStack(
		runRole,
		buildEngineDependencies(deps, checkpoint.runId, startTime, checkpoint.registryCounter, checkpoint.learnedContextCeiling, checkpoint.writeCapableStarted, entryFrame.continuesFrom),
		loadedGuild,
		checkpoint,
	)

	const meta = composeRunMeta(runOptions, startTime, result.status, result)

	deps.writeMeta(meta)
	deps.deleteCheckpoint()

	return meta
}
