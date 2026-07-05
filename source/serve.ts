
import * as path from 'node:path'

import { createWebServer } from './web/server.js'
import { createAppendLog, createGuildLoader, createLlmCaller, createListRunIds, createReadProjectSettings, createReadRunSnapshotById, createRunDirectory, createRunState, createRunSubmission, createToolHandlers, createWebHumanBackend, createWriteMeta, createWriteProjectSettings, runExecutor, type ExecutorDependencies, type LoadedGuild, type LlmCaller, type ModelConfig, type StartRun, type WebHumanBackend } from './executor/index.js'

const API_KEY_ENV_VAR = 'ORCHESTRATOR_API_KEY'
const PORT_ENV_VAR = 'PORT'
const WORKSPACE_ROOT_ENV_VAR = 'WORKSPACE_ROOT'

// The guild directory is bundled into the image (and lives at the repo root in development); its location is an implementation detail, not a deployment variable, so it is hardcoded rather than configurable.
// Resolved relative to this module so the guild is found regardless of the process working directory: in the image the app lives at /app/source and the guild at /app/guild, but the container's WORKDIR is /workspace.
const GUILD_PATH = path.resolve(import.meta.dir, '..', 'guild')
const DEFAULT_PORT = 80
const DEFAULT_WORKSPACE_ROOT = '/workspace'
const ORCHESTRATION_DIR = '.orchestration'
const MIN_PORT = 1
const MAX_PORT = 65535
const INTERRUPT_EXIT_CODE = 130

function generateRunId(now: Date): string {
	const pad = (n: number) => n.toString().padStart(2, '0')
	const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
	const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
	return `run-${date}-${time}`
}

function buildModel(loadedGuild: LoadedGuild, apiKey: string | undefined): ModelConfig {
	return {
		...loadedGuild.config.model,
		...(apiKey !== undefined && apiKey !== '' ? { apiKey } : {}),
	}
}

// Accepts only plain decimal digit strings so forms like `0x1a`, `1e3`, `8080.0`, or ` 8080 ` are rejected rather than silently coerced by Number().
function parsePort(value: string | undefined, fallback: number): number {
	if (value === undefined || value === '') return fallback
	if (!/^\d+$/.test(value)) {
		throw new Error(`${PORT_ENV_VAR} must be an integer port between ${MIN_PORT} and ${MAX_PORT} (got "${value}")`)
	}
	const port = Number(value)
	if (port < MIN_PORT || port > MAX_PORT) {
		throw new Error(`${PORT_ENV_VAR} must be an integer port between ${MIN_PORT} and ${MAX_PORT} (got "${value}")`)
	}
	return port
}

// Builds the per-run leaf wrapper the submission calls for each task.
// The guild, model, and shared human backend are bound once at service startup; only the persistence leaves and tool handlers are re-derived per run id.
// Tools operate on the live workspace root in place — the executor modifies the mounted project directly, not a per-run copy.
function createStartRun(config: {
	loadedGuild: LoadedGuild
	llmCaller: LlmCaller
	humanBackend: WebHumanBackend
	guildPath: string
	workspaceRootPath: string
	runsBaseDir: string
}): StartRun {
	return async (runId, task, effort) => {
		const additionalToolHandlers = createToolHandlers({
			workspaceRoot: config.workspaceRootPath,
			defaultToolTimeoutSeconds: config.loadedGuild.config.executor.defaultToolTimeoutSeconds,
		})
		const appendLog = createAppendLog(runId, config.runsBaseDir)
		// The human backend is shared with the web API; bind the active run's log so ask_human and human_answer events land in this run's log.jsonl for the question-history view.
		config.humanBackend.bindRunLog(appendLog)
		const dependencies: ExecutorDependencies = {
			llmCaller: config.llmCaller,
			loadGuild: () => config.loadedGuild,
			appendLog,
			createRunDirectory: createRunDirectory(runId, config.runsBaseDir),
			writeMeta: createWriteMeta(runId, config.runsBaseDir),
			additionalToolHandlers,
			humanBackend: config.humanBackend,
		}
		try {
			return await runExecutor(dependencies, {
				runId,
				guildPath: config.guildPath,
				benchmarkPath: config.workspaceRootPath,
				task,
				effort,
			})
		} finally {
			config.humanBackend.bindRunLog(null)
		}
	}
}

function waitForShutdownSignal(): Promise<void> {
	return new Promise((resolve) => {
		const handler = () => resolve()
		process.on('SIGINT', handler)
		process.on('SIGTERM', handler)
	})
}

// Long-running service: the server outlives every run, one task at a time, submitted via the JSON API.
// SIGINT and SIGTERM both trigger shutdown: stop accepting new requests, stop the server, then exit (130 if a run was interrupted mid-flight, 0 if idle).
// An active run is abandoned where it stands rather than awaited: the run-interrupt channel that would let the service ask a run to stop at a safe point does not exist yet, so awaiting a run could block for up to the run's full budget (hours).
// The run's append-only log is already durable; the missing meta.json leaves it reading as "in progress" on restart, which is the accepted graceful-degradation.
// When the interrupt channel lands, this can switch to a bounded graceful drain.
// A fatal run error tears down the service and exits non-zero.

async function serve(): Promise<void> {
	const port = parsePort(Bun.env[PORT_ENV_VAR], DEFAULT_PORT)
	const workspaceRootPath = Bun.env[WORKSPACE_ROOT_ENV_VAR] || DEFAULT_WORKSPACE_ROOT
	const runsBaseDir = path.resolve(workspaceRootPath, ORCHESTRATION_DIR, 'runs')

	const loadGuild = createGuildLoader()
	const loadedGuild = loadGuild(GUILD_PATH)
	const llmCaller = createLlmCaller(buildModel(loadedGuild, Bun.env[API_KEY_ENV_VAR]))

	const webHumanBackend = createWebHumanBackend()
	const runState = createRunState({ humanBackend: webHumanBackend })
	const readRunSnapshotById = createReadRunSnapshotById(runsBaseDir)
	const listRunIds = createListRunIds(runsBaseDir)
	const readProjectSettings = createReadProjectSettings(workspaceRootPath)
	const writeProjectSettings = createWriteProjectSettings(workspaceRootPath)

	const startRun = createStartRun({
		loadedGuild,
		llmCaller,
		humanBackend: webHumanBackend,
		guildPath: GUILD_PATH,
		workspaceRootPath,
		runsBaseDir,
	})
	const runSubmission = createRunSubmission({ startRun, generateRunId: () => generateRunId(new Date()), readProjectSettings })

	const webServer = createWebServer({
		port,
		guildConfig: loadedGuild.config,
		runState,
		runSubmission,
		readRunSnapshotById,
		listRunIds,
		readProjectSettings,
		writeProjectSettings,
	})
	console.log(`Web UI ready: http://localhost:${webServer.port}`)

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
	webServer.stop()
	process.exit(interrupted ? INTERRUPT_EXIT_CODE : 0)
}

serve().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error))
	process.exit(1)
})
