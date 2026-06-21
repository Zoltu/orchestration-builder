// CLI entry point for the Adaptive Orchestrator executor.
//
// This is the integration shell: the only module that reads `process.argv` and
// `Bun.env`, and the only place that assembles real leaf factories and hands
// them to `runExecutor`. It holds no business logic of its own — argument
// parsing lives in `main-args.ts` (unit-tested), and the run itself is the
// already-tested executor orchestration. Per the testing policy this file is
// not unit-tested.

import * as path from 'node:path'

import { parseCliArgs, usage, type HumanBackendMode, type ParsedCliArgs } from './main-args.js'
import {
	createAppendLog,
	createCopyWorkspace,
	createGuildLoader,
	createHumanBackend,
	createLlmCaller,
	createRunDirectory,
	createSnapshotWorkspace,
	createToolHandlers,
	createWriteMeta,
	runExecutor,
	type ExecutorDependencies,
	type HumanBackend,
	type LoadGuild,
	type ModelConfig,
	type RunMeta,
} from './executor/index.js'

const API_KEY_ENV_VAR = 'ORCHESTRATOR_API_KEY'
const RUNS_BASE_DIR = 'data/runs'

function generateRunId(now: Date): string {
	const pad = (n: number) => n.toString().padStart(2, '0')
	const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
	const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
	return `run-${date}-${time}`
}

function buildHumanBackend(mode: HumanBackendMode | undefined): HumanBackend {
	const resolved = mode ?? 'stub'
	if (resolved === 'stub') return createHumanBackend({ mode: 'stub' })
	// 'foundry' and 'web' need infrastructure (the Foundry loop, the web UI
	// server) that the CLI entry point does not stand up; only 'stub' answers
	// without external help.
	throw new Error(`--human-backend "${resolved}" is not supported by the CLI yet; only "stub" is available.`)
}

function exitCodeForStatus(status: RunMeta['status']): number {
	if (status === 'success') return 0
	if (status === 'needs_clarification') return 2
	return 1
}

async function run(cli: ParsedCliArgs): Promise<RunMeta> {
	const runId = cli.runId ?? generateRunId(new Date())

	const loadGuild = createGuildLoader()
	const loadedGuild = loadGuild(cli.guildPath)

	const apiKey = Bun.env[API_KEY_ENV_VAR]
	const model: ModelConfig = {
		...loadedGuild.config.model,
		...(apiKey !== undefined && apiKey !== '' ? { apiKey } : {}),
	}
	const llmCaller = createLlmCaller(model)

	const workspaceRoot = path.resolve(RUNS_BASE_DIR, runId, 'workspace')
	const additionalToolHandlers = createToolHandlers({
		workspaceRoot,
		defaultToolTimeoutSeconds: loadedGuild.config.executor.defaultToolTimeoutSeconds,
	})

	// The Guild is loaded once and reused for the executor's loadGuild
	// dependency so the model config bound to the LLM caller and the config the
	// executor sees are the same object, with no second disk read.
	const cachedLoadGuild: LoadGuild = () => loadedGuild

	const dependencies: ExecutorDependencies = {
		llmCaller,
		loadGuild: cachedLoadGuild,
		appendLog: createAppendLog(runId, RUNS_BASE_DIR),
		createRunDirectory: createRunDirectory(runId, RUNS_BASE_DIR),
		copyWorkspace: createCopyWorkspace(runId, RUNS_BASE_DIR),
		snapshotWorkspace: createSnapshotWorkspace(runId, RUNS_BASE_DIR),
		writeMeta: createWriteMeta(runId, RUNS_BASE_DIR),
		additionalToolHandlers,
		humanBackend: buildHumanBackend(cli.humanBackend),
	}

	return runExecutor(dependencies, {
		runId,
		guildPath: cli.guildPath,
		benchmarkPath: cli.workspacePath,
		task: cli.task,
	})
}

async function main(): Promise<void> {
	const outcome = parseCliArgs(process.argv.slice(2))

	if (outcome.kind === 'help') {
		console.log(usage())
		process.exit(0)
	}

	if (outcome.kind === 'error') {
		console.error(`Error: ${outcome.message}`)
		console.error('')
		console.error(usage())
		process.exit(2)
	}

	let meta: RunMeta
	try {
		meta = await run(outcome.args)
	} catch (error) {
		console.error(`Run failed: ${error instanceof Error ? error.message : String(error)}`)
		process.exit(1)
	}

	console.log(`Run ${meta.runId} finished: ${meta.status}`)
	if (meta.result !== undefined) console.log(meta.result.summary)

	process.exit(exitCodeForStatus(meta.status))
}

void main()
