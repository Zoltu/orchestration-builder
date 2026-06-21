// CLI entry point for the Adaptive Orchestrator executor.
// This is the integration shell: the only module that reads `process.argv` and `Bun.env`, and the only place that assembles real leaf factories and hands them to `runExecutor`.
// It holds no business logic of its own — argument parsing lives in `main-args.ts` (unit-tested), run submission lives in `source/executor/run-submission.ts` (unit-tested), and the run itself is the already-tested executor orchestration.
// Per the testing policy this file is not unit-tested.

import * as path from 'node:path'

import { parseCliArgs, usage, type ParsedCliArgs } from './main-args.js'
import { createWebServer } from './web/server.js'
import {
	createAppendLog,
	createCopyWorkspace,
	createGuildLoader,
	createHumanBackend,
	createLlmCaller,
	createListRunIds,
	createReadRunSnapshotById,
	createRunDirectory,
	createRunState,
	createRunSubmission,
	createSnapshotWorkspace,
	createToolHandlers,
	createWebHumanBackend,
	createWriteMeta,
	runExecutor,
	type ExecutorDependencies,
	type HumanBackend,
	type LoadedGuild,
	type LlmCaller,
	type ModelConfig,
	type RunMeta,
	type StartRun,
} from './executor/index.js'

const API_KEY_ENV_VAR = 'ORCHESTRATOR_API_KEY'
const RUNS_BASE_DIR = 'data/runs'
const DEFAULT_WORKSPACE_ROOT = '/workspace'
const INTERRUPT_EXIT_CODE = 130

function generateRunId(now: Date): string {
	const pad = (n: number) => n.toString().padStart(2, '0')
	const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
	const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
	return `run-${date}-${time}`
}

function exitCodeForStatus(status: RunMeta['status']): number {
	if (status === 'success') return 0
	if (status === 'needs_clarification') return 2
	return 1
}

function buildModel(loadedGuild: LoadedGuild, apiKey: string | undefined): ModelConfig {
	return {
		...loadedGuild.config.model,
		...(apiKey !== undefined && apiKey !== '' ? { apiKey } : {}),
	}
}

// Builds the per-run leaf wrapper the submission calls for each task.
// The guild, model, and shared human backend are bound once at service startup; only the persistence leaves and tool handlers are re-derived per run id.
function createStartRun(config: {
	loadedGuild: LoadedGuild
	llmCaller: LlmCaller
	humanBackend: HumanBackend
	guildPath: string
	workspaceRootPath: string
	runsBaseDir: string
}): StartRun {
	return async (runId, task) => {
		const workspaceRoot = path.resolve(config.runsBaseDir, runId, 'workspace')
		const additionalToolHandlers = createToolHandlers({
			workspaceRoot,
			defaultToolTimeoutSeconds: config.loadedGuild.config.executor.defaultToolTimeoutSeconds,
		})
		const dependencies: ExecutorDependencies = {
			llmCaller: config.llmCaller,
			loadGuild: () => config.loadedGuild,
			appendLog: createAppendLog(runId, config.runsBaseDir),
			createRunDirectory: createRunDirectory(runId, config.runsBaseDir),
			copyWorkspace: createCopyWorkspace(runId, config.runsBaseDir),
			snapshotWorkspace: createSnapshotWorkspace(runId, config.runsBaseDir),
			writeMeta: createWriteMeta(runId, config.runsBaseDir),
			additionalToolHandlers,
			humanBackend: config.humanBackend,
		}
		return runExecutor(dependencies, {
			runId,
			guildPath: config.guildPath,
			benchmarkPath: config.workspaceRootPath,
			task,
		})
	}
}

function waitForShutdownSignal(): Promise<void> {
	return new Promise((resolve) => {
		const handler = () => resolve()
		process.on('SIGINT', handler)
		process.on('SIGTERM', handler)
	})
}

// One run per process: assemble the executor dependencies for a single run, run it, and return its terminal meta.
async function run(cli: ParsedCliArgs): Promise<RunMeta> {
	if (cli.workspacePath === undefined) throw new Error('--workspace is required when not using --serve')
	if (cli.task === undefined) throw new Error('--task is required when not using --serve')
	if (cli.workspaceRoot !== undefined) throw new Error('--workspace-root is only valid with --serve')

	const runId = cli.runId ?? generateRunId(new Date())

	const loadGuild = createGuildLoader()
	const loadedGuild = loadGuild(cli.guildPath)

	const apiKey = Bun.env[API_KEY_ENV_VAR]
	const llmCaller = createLlmCaller(buildModel(loadedGuild, apiKey))

	const workspaceRoot = path.resolve(RUNS_BASE_DIR, runId, 'workspace')
	const additionalToolHandlers = createToolHandlers({
		workspaceRoot,
		defaultToolTimeoutSeconds: loadedGuild.config.executor.defaultToolTimeoutSeconds,
	})

	const resolved = cli.humanBackend ?? 'stub'
	if (resolved === 'web') throw new Error('--human-backend web requires --serve <port> so questions can be answered in the UI.')
	if (resolved === 'foundry') throw new Error('--human-backend "foundry" is not supported by the CLI; it requires the Foundry loop.')
	const humanBackend = createHumanBackend({ mode: resolved })

	const dependencies: ExecutorDependencies = {
		llmCaller,
		loadGuild: () => loadedGuild,
		appendLog: createAppendLog(runId, RUNS_BASE_DIR),
		createRunDirectory: createRunDirectory(runId, RUNS_BASE_DIR),
		copyWorkspace: createCopyWorkspace(runId, RUNS_BASE_DIR),
		snapshotWorkspace: createSnapshotWorkspace(runId, RUNS_BASE_DIR),
		writeMeta: createWriteMeta(runId, RUNS_BASE_DIR),
		additionalToolHandlers,
		humanBackend,
	}

	return runExecutor(dependencies, {
		runId,
		guildPath: cli.guildPath,
		benchmarkPath: cli.workspacePath,
		task: cli.task,
	})
}

// Long-running service: the server outlives every run, one task at a time, submitted via the JSON API (or bootstrapped by --task).
// SIGINT and SIGTERM both trigger graceful shutdown: stop accepting new tasks, await the active run, stop the server, then exit (130 if a run was interrupted mid-flight, 0 if idle).
// A fatal run error tears down the service and exits non-zero.
async function serve(cli: ParsedCliArgs): Promise<void> {
	const port = cli.serve
	if (port === undefined) throw new Error('serve mode requires --serve <port>')
	if (cli.workspacePath !== undefined) throw new Error('--workspace is not used in serve mode; the project mount is --workspace-root (defaults to /workspace).')
	if (cli.runId !== undefined) throw new Error('--run-id is not used in serve mode; run ids are auto-generated per submission.')
	if (cli.humanBackend === 'stub' || cli.humanBackend === 'foundry') {
		throw new Error(`--serve requires --human-backend web (or omit the flag); got "${cli.humanBackend}".`)
	}

	const loadGuild = createGuildLoader()
	const loadedGuild = loadGuild(cli.guildPath)
	const llmCaller = createLlmCaller(buildModel(loadedGuild, Bun.env[API_KEY_ENV_VAR]))
	const workspaceRootPath = cli.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT

	const webHumanBackend = createWebHumanBackend()
	const runState = createRunState({ humanBackend: webHumanBackend })
	const readRunSnapshotById = createReadRunSnapshotById(RUNS_BASE_DIR)
	const listRunIds = createListRunIds(RUNS_BASE_DIR)

	const startRun = createStartRun({
		loadedGuild,
		llmCaller,
		humanBackend: webHumanBackend,
		guildPath: cli.guildPath,
		workspaceRootPath,
		runsBaseDir: RUNS_BASE_DIR,
	})
	const runSubmission = createRunSubmission({ startRun, generateRunId: () => generateRunId(new Date()) })

	const webServer = createWebServer({
		port,
		runState,
		runSubmission,
		readRunSnapshotById,
		listRunIds,
	})
	console.log(`Web UI ready: http://localhost:${webServer.port}`)

	if (cli.task !== undefined) {
		const result = runSubmission.submit(cli.task)
		if (result.ok) console.log(`Bootstrap run started: ${result.runId}`)
	}

	const reason = await Promise.race([
		waitForShutdownSignal().then(() => ({ kind: 'signal' as const })),
		runSubmission.awaitFatalError().then((error) => ({ kind: 'fatal' as const, error })),
	])

	if (reason.kind === 'fatal') {
		await runSubmission.awaitActive()
		webServer.stop()
		console.error(`Fatal run error: ${reason.error.message}`)
		process.exit(1)
	}

	const interrupted = runSubmission.activeRunId() !== undefined
	await runSubmission.awaitActive()
	webServer.stop()
	process.exit(interrupted ? INTERRUPT_EXIT_CODE : 0)
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

	const cli = outcome.args
	try {
		if (cli.serve !== undefined) {
			await serve(cli)
			return
		}
		const meta = await run(cli)
		console.log(`Run ${meta.runId} finished: ${meta.status}`)
		if (meta.result !== undefined) console.log(meta.result.summary)
		process.exit(exitCodeForStatus(meta.status))
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error))
		process.exit(1)
	}
}

void main()
