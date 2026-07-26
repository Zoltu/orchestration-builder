import type { RunMeta, RunOptions } from './types.js'
import { runRole } from './engine.js'
import type { HumanBackend } from './human-backend.js'
import type { InterruptQueue } from './interrupts.js'
import type { LlmCaller } from './llm.js'
import type { LoadGuild } from './loader.js'
import type { AppendLog, RunDirectory, WriteMeta } from './persistence.js'
import { createRoleRegistry } from './role-registry.js'
import type { ToolHandler } from './tool-dispatch.js'

export interface ExecutorDependencies {
	llmCaller: LlmCaller
	appendLog: AppendLog
	additionalToolHandlers: Record<string, ToolHandler>
	humanBackend: HumanBackend
	loadGuild: LoadGuild
	createRunDirectory: RunDirectory
	writeMeta: WriteMeta
	// The run's interrupt queue, created by the caller so the service API can submit operator interrupts while the run is in flight; the engine drains it at turn boundaries. The role registry is run-internal and created here.
	interruptQueue: InterruptQueue
}

export async function runExecutor(deps: ExecutorDependencies, options: RunOptions): Promise<RunMeta> {
	deps.createRunDirectory()

	const loadedGuild = deps.loadGuild(options.guildPath)

	const startTime = new Date().toISOString()
	// effort_set is logged once at run start so the trace records the chosen level before the entry role begins.
	deps.appendLog({ timestamp: new Date().toISOString(), type: 'effort_set', payload: { effort: options.effort } })
	// Write a running meta before the entry role begins so the UI can show the task, run id, and start time while the run is in progress, rather than only after completion. It is overwritten with the terminal meta below.
	deps.writeMeta({
		runId: options.runId,
		guildPath: options.guildPath,
		benchmarkPath: options.benchmarkPath,
		task: options.task,
		effort: options.effort,
		status: 'running',
		startTime,
	})
	const result = await runRole(
		{
			llmCaller: deps.llmCaller,
			appendLog: deps.appendLog,
			additionalToolHandlers: deps.additionalToolHandlers,
			humanBackend: deps.humanBackend,
			roleRegistry: createRoleRegistry(),
			interruptQueue: deps.interruptQueue,
		},
		{
			loadedGuild,
			depth: 0,
			roleName: loadedGuild.config.entryRole,
			task: options.task,
			effort: options.effort,
		},
	)

	const endTime = new Date().toISOString()
	const meta: RunMeta = {
		runId: options.runId,
		guildPath: options.guildPath,
		benchmarkPath: options.benchmarkPath,
		task: options.task,
		effort: options.effort,
		status: result.status,
		startTime,
		endTime,
		result,
	}

	deps.writeMeta(meta)

	return meta
}
