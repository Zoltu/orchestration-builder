
import * as path from 'node:path'

import { createWebServer } from './web/server.js'
import { createSnapshotCache } from './web/snapshot-cache.js'
import { createTaskSummarizer, type TaskSummarizer } from './web/summarize.js'
import { createAppendLog, createDeleteCheckpoint, createGuildLoader, createInterruptChannel, createInterruptQueue, createLlmCaller, createLlmFetch, createListRunIds, createReadProjectSettings, createReadRunCheckpointById, createReadRunMetaById, createReadRunSnapshotById, createReadRunSnapshotStats, createReadRunSummaryById, createRunDirectory, createRunState, createRunSubmission, createSleep, createToolHandlers, createWebHumanBackend, createWriteCheckpoint, createWriteMeta, createWriteProjectSettings, createWriteRunSummary, reconcileRunsOnStartup, resumeExecutor, runExecutor, type ExecutorDependencies, type InterruptChannel, type LoadedGuild, type LlmCaller, type ModelConfig, type ResumeRun, type RunCheckpoint, type StartRun, type WebHumanBackend } from './executor/index.js'

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
// The snapshot cache needs to hold only the run the operator is viewing (plus the one they may switch back to); the run list bypasses it entirely.
const SNAPSHOT_CACHE_MAX_ENTRIES = 4

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

// Builds the per-run executor dependencies and binds the shared backends (human backend, interrupt channel) to the run's log and queue for the duration of `invoke`. The guild, model, and shared human backend are bound once at service startup; only the persistence leaves and tool handlers are re-derived per run id.
// Tools operate on the live workspace root in place — the executor modifies the mounted project directly, not a per-run copy.
async function withRunBindings<T>(config: {
	loadedGuild: LoadedGuild
	llmCaller: LlmCaller
	humanBackend: WebHumanBackend
	interruptChannel: InterruptChannel
	guildPath: string
	workspaceRootPath: string
	runsBaseDir: string
}, runId: string, invoke: (dependencies: ExecutorDependencies) => Promise<T>): Promise<T> {
	const additionalToolHandlers = createToolHandlers({
		workspaceRoot: config.workspaceRootPath,
		defaultToolTimeoutSeconds: config.loadedGuild.config.executor.defaultToolTimeoutSeconds,
	})
	const appendLog = createAppendLog(runId, config.runsBaseDir)
	// The human backend is shared with the web API; bind the active run's log so ask_human and human_answer events land in this run's log.jsonl for the question-history view.
	config.humanBackend.bindRunLog(appendLog)
	// The interrupt channel is likewise shared; bind the run's fresh queue so operator interrupts submitted mid-run reach the engine's drain.
	const interruptQueue = createInterruptQueue()
	config.interruptChannel.bindQueue(interruptQueue)
	const dependencies: ExecutorDependencies = {
		llmCaller: config.llmCaller,
		loadGuild: () => config.loadedGuild,
		appendLog,
		createRunDirectory: createRunDirectory(runId, config.runsBaseDir),
		writeMeta: createWriteMeta(runId, config.runsBaseDir),
		writeCheckpoint: createWriteCheckpoint(runId, config.runsBaseDir),
		deleteCheckpoint: createDeleteCheckpoint(runId, config.runsBaseDir),
		additionalToolHandlers,
		humanBackend: config.humanBackend,
		interruptQueue,
	}
	try {
		return await invoke(dependencies)
	} finally {
		config.humanBackend.bindRunLog(null)
		config.interruptChannel.bindQueue(null)
	}
}

// Summary generation is best-effort and always off the run's own path: a failure (the endpoint being briefly down, a disk error on the summary file) surfaces on the service log but never delays the submission response, alters the run, or crashes the service over a UI label.
function fireAndForgetSummary(promise: Promise<void>, runId: string): void {
	promise.catch((error: unknown) => {
		console.error(`Run summary generation failed for ${runId}: ${error instanceof Error ? error.message : String(error)}`)
	})
}

// The per-run leaf wrappers the submission calls for each task (a fresh run) and for startup reconciliation (a run resumed from its checkpoint under its original run id). Each also kicks the summary hooks: the task summary at start, and the richer completion summary (task + interrupts + result) when the run settles — the rejection branch is empty because the run promise's failure is owned by runSubmission's fatal-error path, not by the summary chain.
// The run log path rides in the options workspace-relative: the inquiry handler's briefing interpolates it so finished roles stay researchable from the mounted workspace.
function createStartRun(config: {
	loadedGuild: LoadedGuild
	llmCaller: LlmCaller
	humanBackend: WebHumanBackend
	interruptChannel: InterruptChannel
	summarizer: TaskSummarizer
	guildPath: string
	workspaceRootPath: string
	runsBaseDir: string
}): StartRun {
	return (runId, task, effort) => {
		const runLogPath = path.relative(config.workspaceRootPath, path.join(config.runsBaseDir, runId, 'log.jsonl'))
		const runPromise = withRunBindings(config, runId, (dependencies) => runExecutor(dependencies, {
			runId,
			guildPath: config.guildPath,
			benchmarkPath: config.workspaceRootPath,
			task,
			effort,
			runLogPath,
		}))
		fireAndForgetSummary(config.summarizer.summarizeTaskStart(runId, task), runId)
		runPromise.then(
			(meta) => fireAndForgetSummary(config.summarizer.summarizeRunCompletion(meta), runId),
			() => {},
		)
		return runPromise
	}
}

function createResumeRun(config: {
	loadedGuild: LoadedGuild
	llmCaller: LlmCaller
	humanBackend: WebHumanBackend
	interruptChannel: InterruptChannel
	summarizer: TaskSummarizer
	guildPath: string
	workspaceRootPath: string
	runsBaseDir: string
}): ResumeRun {
	return (checkpoint) => {
		const runLogPath = path.relative(config.workspaceRootPath, path.join(config.runsBaseDir, checkpoint.runId, 'log.jsonl'))
		const runPromise = withRunBindings(config, checkpoint.runId, (dependencies) => resumeExecutor(dependencies, checkpoint, {
			guildPath: config.guildPath,
			benchmarkPath: config.workspaceRootPath,
			runLogPath,
		}))
		runPromise.then(
			(meta) => fireAndForgetSummary(config.summarizer.summarizeRunCompletion(meta), checkpoint.runId),
			() => {},
		)
		return runPromise
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
// SIGINT and SIGTERM both trigger shutdown: with an active run, the service submits a wind-down notice through the interrupt channel and waits for the run under a bounded drain timeout — the run can finish gracefully at a safe point. A run still active when the timeout elapses is NOT abandoned: the engine checkpoints the role stack at every safe point, so the next startup resumes the run from its last checkpoint (see docs/reference.md "Run persistence and resumption").
// Then stop accepting new requests, stop the server, and exit (130 if a run was still active, 0 if idle).
// A fatal run error tears down the service and exits non-zero.

const SHUTDOWN_DRAIN_MS = 30_000
const SHUTDOWN_NOTICE_MESSAGE = 'The service is shutting down. Please wind down: finish your current step, then call finish with whatever state you have.'

async function serve(): Promise<void> {
	const port = parsePort(Bun.env[PORT_ENV_VAR], DEFAULT_PORT)
	const workspaceRootPath = Bun.env[WORKSPACE_ROOT_ENV_VAR] || DEFAULT_WORKSPACE_ROOT
	const runsBaseDir = path.resolve(workspaceRootPath, ORCHESTRATION_DIR, 'runs')

	const loadGuild = createGuildLoader()
	const loadedGuild = loadGuild(GUILD_PATH)
	const llmCaller = createLlmCaller(buildModel(loadedGuild, Bun.env[API_KEY_ENV_VAR]), { llmFetch: createLlmFetch(), sleep: createSleep() })

	const webHumanBackend = createWebHumanBackend()
	const interruptChannel = createInterruptChannel()
	const runState = createRunState({ humanBackend: webHumanBackend, interruptChannel })
	const readRunSnapshotStats = createReadRunSnapshotStats(runsBaseDir)
	const readRawSnapshot = createReadRunSnapshotById(runsBaseDir)
	const readRunSnapshot = createSnapshotCache({ readStats: readRunSnapshotStats, readRaw: readRawSnapshot }, SNAPSHOT_CACHE_MAX_ENTRIES)
	const readRunMetaById = createReadRunMetaById(runsBaseDir)
	const readRunSummaryById = createReadRunSummaryById(runsBaseDir)
	const listRunIds = createListRunIds(runsBaseDir)
	const readProjectSettings = createReadProjectSettings(workspaceRootPath)
	const writeProjectSettings = createWriteProjectSettings(workspaceRootPath)
	const summarizer = createTaskSummarizer({
		callLlm: (request) => llmCaller.call(request),
		readRunLogText: (runId) => readRawSnapshot(runId).logText,
		writeRunSummaryText: (runId, summary) => createWriteRunSummary(runId, runsBaseDir)(summary),
	})

	const runConfig = {
		loadedGuild,
		llmCaller,
		humanBackend: webHumanBackend,
		interruptChannel,
		summarizer,
		guildPath: GUILD_PATH,
		workspaceRootPath,
		runsBaseDir,
	}
	const startRun = createStartRun(runConfig)
	const resumeRun = createResumeRun(runConfig)
	const runSubmission = createRunSubmission({ startRun, resumeRun, generateRunId: () => generateRunId(new Date()), readProjectSettings })

	// Startup reconciliation runs before the server accepts submissions: a run left mid-flight by the previous process resumes from its checkpoint (under its original run id, through the same single-active-run slot), and every run that cannot be resumed is marked interrupted so the UI shows it as terminal rather than perpetually "in progress".
	const reconciliation = reconcileRunsOnStartup({
		listRunIds,
		readRunMetaById,
		readCheckpointById: createReadRunCheckpointById(runsBaseDir),
		writeMetaFor: (runId) => createWriteMeta(runId, runsBaseDir),
		resume: (checkpoint: RunCheckpoint) => runSubmission.resume(checkpoint),
	})
	if (reconciliation.resumedRunId !== undefined) {
		console.log(`Resumed run ${reconciliation.resumedRunId} from its checkpoint`)
	}
	for (const runId of reconciliation.interruptedRunIds) {
		console.log(`Marked run ${runId} as interrupted (could not be resumed)`)
	}

	const webServer = createWebServer({
		port,
		guildConfig: loadedGuild.config,
		tools: loadedGuild.tools,
		runState,
		runSubmission,
		readRunSnapshot,
		readRunMetaById,
		readRunSummaryById,
		readRunSnapshotStats,
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

	if (runSubmission.activeRunId() !== undefined) {
		runState.submitInterrupt({ kind: 'notice', message: SHUTDOWN_NOTICE_MESSAGE })
		const sleep = createSleep()
		await Promise.race([runSubmission.awaitActive(), sleep(SHUTDOWN_DRAIN_MS)])
	}

	const interrupted = runSubmission.activeRunId() !== undefined
	webServer.stop()
	process.exit(interrupted ? INTERRUPT_EXIT_CODE : 0)
}

serve().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error))
	process.exit(1)
})
