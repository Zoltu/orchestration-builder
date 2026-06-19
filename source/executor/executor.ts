import type { RunMeta, RunOptions } from '../shared/types.js'
import { runRole } from './engine.js'
import type { HumanBackend } from './human-backend.js'
import type { LlmCaller } from './llm.js'
import type { LoadGuild } from './loader.js'
import type { AppendLog, CopyWorkspace, RunDirectory, SnapshotWorkspace, WriteMeta } from './persistence.js'
import type { ToolHandler } from './tool-dispatch.js'

export interface ExecutorDependencies {
	llmCaller: LlmCaller
	appendLog: AppendLog
	additionalToolHandlers: Record<string, ToolHandler>
	humanBackend: HumanBackend
	loadGuild: LoadGuild
	createRunDirectory: RunDirectory
	copyWorkspace: CopyWorkspace
	snapshotWorkspace: SnapshotWorkspace
	writeMeta: WriteMeta
}

export async function runExecutor(deps: ExecutorDependencies, options: RunOptions): Promise<RunMeta> {
	deps.createRunDirectory()
	deps.copyWorkspace(options.benchmarkPath)

	const loadedGuild = deps.loadGuild(options.guildPath)

	const startTime = new Date().toISOString()
	const startMs = Date.now()
	const result = await runRole(
		{
			llmCaller: deps.llmCaller,
			appendLog: deps.appendLog,
			additionalToolHandlers: deps.additionalToolHandlers,
			humanBackend: deps.humanBackend,
		},
		{
			loadedGuild,
			depth: 0,
			startMs,
			roleName: loadedGuild.config.entryRole,
			task: options.task,
		},
	)

	deps.snapshotWorkspace()

	const endTime = new Date().toISOString()
	const meta: RunMeta = {
		runId: options.runId,
		guildPath: options.guildPath,
		benchmarkPath: options.benchmarkPath,
		task: options.task,
		status: result.status,
		startTime,
		endTime,
		result,
	}

	deps.writeMeta(meta)

	return meta
}