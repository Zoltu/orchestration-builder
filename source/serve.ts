
import * as path from 'node:path'

import { createWebServer } from './web/server.js'
import { createBootstrapFailureHandler } from './web/bootstrap-failure.js'
import { createBuildInfoReader } from './web/build-info.js'
import { createSnapshotCache } from './web/snapshot-cache.js'
import { createRunListCache } from './web/run-list-cache.js'
import { createTaskSummarizer, type TaskSummarizer } from './summarize.js'
import { applyDeploymentOverride, applyLogLevel, createAppendLog, createDeleteCheckpoint, createDockerSecretReader, createGuildLoader, createInterruptChannel, createInterruptQueue, createLlmCaller, createLlmFetch, createListRunIds, createModelInfoProbe, createPlanToolHandlers, createReadProjectSettings, createReadRunCheckpointById, createReadRunLogTextFrom, createReadRunMetaById, createReadRunPlanById, createReadRunSnapshotById, createReadRunSnapshotStats, createReadRunSummaryById, createReadRunSummaryStats, createRunDirectory, createRunDirectoryExists, createRunLogToolHandlers, createRunState, createRunSubmission, createSleep, createTimeoutScheduler, createToolHandlers, createWebHumanBackend, createWriteCheckpoint, createWriteMeta, createWriteProjectSettings, createWriteRunSummary, ensureOrchestrationGitExcluded, entryFrameLogLevel, generateRunId, LOG_FILE_NAME, MODEL_PROBE_TIMEOUT_MS, nodeGitExcludeFilesystem, parseModelInfo, reconcileRunsOnStartup, resolveDeploymentConfig, resolveDeploymentOverride, resolveKagiApiKey, resolveSecret, resumeExecutor, runExecutor, validateDeploymentFileConfig, validateDeploymentRoleReferences, ConfigurationError, ValidationError, type AppendLog, type ExecutorDependencies, type InterruptChannel, type LoadedGuild, type LlmCaller, type LogLevel, type ModelApiProbe, type ResumeRun, type RunCheckpoint, type StartRun, type WebHumanBackend } from './executor/index.js'

const DEPLOYMENT_FILE_ENV_VAR = 'ORCHESTRATOR_DEPLOYMENT_FILE'
const PORT_ENV_VAR = 'PORT'
const WORKSPACE_ROOT_ENV_VAR = 'WORKSPACE_ROOT'
const PAGE_TITLE_ENV_VAR = 'ORCHESTRATOR_TITLE'
const DEFAULT_PAGE_TITLE = 'Adaptive Orchestrator'
// Docker secrets mount at /run/secrets; the orchestrator and tool keys can also arrive as plain environment variables (see resolveSecret).
const DOCKER_SECRETS_DIR = '/run/secrets'

// The guild directory and the deployment file are bundled into the image (and live at the repo root in development); resolved relative to this module so both are found regardless of the process working directory: in the image the app lives at /app/source with the guild at /app/guild and the deployment at /app/deployment, but the container's WORKDIR is /workspace.
// The guild's location is an implementation detail. The deployment file's path alone is a deployment variable: ORCHESTRATOR_DEPLOYMENT_FILE repoints it at a mounted file, docker config, or docker secret without rebuilding the image.
const GUILD_PATH = path.resolve(import.meta.dir, '..', 'guild')
const DEPLOYMENT_PATH = path.resolve(import.meta.dir, '..', 'deployment', 'deployment.json')
// The build identifier the Dockerfile bakes next to the app (in the image, /app/build-info.json); a development checkout has no baked file and the read tolerates that.
const BUILD_INFO_PATH = path.resolve(import.meta.dir, '..', 'build-info.json')
const DEFAULT_PORT = 80
const DEFAULT_WORKSPACE_ROOT = '/workspace'
const ORCHESTRATION_DIR = '.orchestration'
const MIN_PORT = 1
const MAX_PORT = 65535
const INTERRUPT_EXIT_CODE = 130
// The snapshot cache needs to hold only the run the operator is viewing (plus the one they may switch back to); the run list bypasses it entirely.
const SNAPSHOT_CACHE_MAX_ENTRIES = 4
// The run list is polled every second alongside the selected run's endpoints; 64 cached summaries covers every history a browser realistically browses while bounding memory on a long-lived service.
const RUN_LIST_CACHE_MAX_ENTRIES = 64

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

// Best-effort visibility hygiene: keep the run-bookkeeping directory out of the workspace's git status. A failure is logged and never blocks startup or a run.
function excludeOrchestrationFromGit(workspaceRootPath: string): void {
	const result = ensureOrchestrationGitExcluded(workspaceRootPath, nodeGitExcludeFilesystem)
	if (!result.ok) console.log(`Could not exclude .orchestration from the workspace's git repository: ${result.reason}`)
}

// Builds the per-run executor dependencies and binds the shared backends (human backend, interrupt channel) to the run's log and queue for the duration of `invoke`.
// The guild, model, and shared human backend are bound once at service startup; only the persistence leaves and tool handlers are re-derived per run id.
// Tools operate on the live workspace root in place — the executor modifies the mounted project directly, not a per-run copy.
async function withRunBindings<T>(config: {
	loadedGuild: LoadedGuild
	llmCaller: LlmCaller
	humanBackend: WebHumanBackend
	interruptChannel: InterruptChannel
	kagiApiKey: string | undefined
	guildPath: string
	workspaceRootPath: string
	runsBaseDir: string
}, runId: string, logLevel: LogLevel, invoke: (dependencies: ExecutorDependencies) => Promise<T>): Promise<T> {
	const additionalToolHandlers = {
		...createToolHandlers({
			workspaceRoot: config.workspaceRootPath,
			defaultToolTimeoutSeconds: config.loadedGuild.deployment.executor.defaultToolTimeoutSeconds,
			kagiApiKey: config.kagiApiKey,
		}),
		// Plan and run-log handlers are bound per run because both live at fixed locations under this run's directory.
		...createPlanToolHandlers({ runsBaseDir: config.runsBaseDir, runId, workspaceRoot: config.workspaceRootPath }),
		...createRunLogToolHandlers({ logPath: path.join(config.runsBaseDir, runId, LOG_FILE_NAME) }),
	}
	excludeOrchestrationFromGit(config.workspaceRootPath)
	const appendLog = createAppendLog(runId, config.runsBaseDir)
	// The run's logging level applies at the single write chokepoint: every event the executor and the human backend emit funnels through this wrapper, so the heavy bodies are dropped once here and no emitter needs to know the level (see docs/reference.md "Logging level").
	const filteredAppendLog: AppendLog = (event) => appendLog(applyLogLevel(event, logLevel))
	// The human backend is shared with the web API; bind the active run's log so ask_human and human_answer events land in this run's log.jsonl for the question-history view.
	config.humanBackend.bindRunLog(filteredAppendLog)
	// The interrupt channel is likewise shared; bind the run's fresh queue so operator interrupts submitted mid-run reach the engine's drain.
	const interruptQueue = createInterruptQueue()
	config.interruptChannel.bindQueue(interruptQueue)
	const dependencies: ExecutorDependencies = {
		llmCaller: config.llmCaller,
		loadedGuild: config.loadedGuild,
		appendLog: filteredAppendLog,
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

// The per-run leaf wrappers the submission calls for each task (a fresh run) and for startup reconciliation (a run resumed from its checkpoint under its original run id).
// Each also kicks the summary hooks: the task summary at start, and the richer completion summary (task + interrupts + result) when the run settles — the rejection branch is empty because the run promise's failure is owned by runSubmission's fatal-error path, not by the summary chain.
interface RunServiceConfig {
	loadedGuild: LoadedGuild
	llmCaller: LlmCaller
	humanBackend: WebHumanBackend
	interruptChannel: InterruptChannel
	summarizer: TaskSummarizer
	kagiApiKey: string | undefined
	guildPath: string
	workspaceRootPath: string
	runsBaseDir: string
}

function createStartRun(config: RunServiceConfig): StartRun {
	return (runId, task, effort, logLevel, continuation) => {
		const runPromise = withRunBindings(config, runId, logLevel, (dependencies) => runExecutor(dependencies, {
			runId,
			guildPath: config.guildPath,
			task,
			effort,
			logLevel,
			...(continuation !== undefined ? { continuation } : {}),
		}))
		fireAndForgetSummary(config.summarizer.summarizeTaskStart(runId, task), runId)
		runPromise.then(
			(meta) => fireAndForgetSummary(config.summarizer.summarizeRunCompletion(meta), runId),
			() => {},
		)
		return runPromise
	}
}

function createResumeRun(config: RunServiceConfig): ResumeRun {
	return (checkpoint) => {
		const logLevel = entryFrameLogLevel(checkpoint.frames[0])
		const runPromise = withRunBindings(config, checkpoint.runId, logLevel, (dependencies) => resumeExecutor(dependencies, checkpoint, {
			guildPath: config.guildPath,
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

// Degraded startup for invalid configuration: the port binds anyway so the operator's browser shows what to fix, while the error still reaches stderr for docker logs.
// The service cannot accept runs in this state, so it exits non-zero once stopped; a failed bind here has nothing to fall back to and propagates to serve's catch.
async function serveBootstrapFailure(config: { port: number, error: ConfigurationError }): Promise<never> {
	console.error(config.error.message)
	const handleRequest = createBootstrapFailureHandler(config.error)
	const server = Bun.serve({ port: config.port, fetch: (request) => handleRequest(request) })
	const port = server.port
	if (port === undefined) {
		server.stop()
		throw new Error(`Failed to bind web server on port ${config.port}`)
	}
	console.log(`The service is misconfigured; open http://localhost:${port} to see what to fix`)
	await waitForShutdownSignal()
	server.stop()
	process.exit(1)
}

// Long-running service: the server outlives every run, one task at a time, submitted via the JSON API.
// SIGINT and SIGTERM both trigger shutdown: with an active run, the service submits a wind-down notice through the interrupt channel and waits for the run under a bounded drain timeout — the run can finish gracefully at a safe point.
// A run still active when the timeout elapses is NOT abandoned: the engine checkpoints the role stack at every safe point, so the next startup resumes the run from its last checkpoint (see docs/reference.md "Run persistence and resumption").
// Then stop accepting new requests, stop the server, and exit (130 if a run was still active, 0 if idle).
// A fatal run error tears down the service and exits non-zero.

const SHUTDOWN_DRAIN_MS = 30_000
const SHUTDOWN_NOTICE_MESSAGE = 'The service is shutting down. Please wind down: finish your current step, then call finish with whatever state you have.'

async function serve(): Promise<void> {
	const port = parsePort(Bun.env[PORT_ENV_VAR], DEFAULT_PORT)
	const workspaceRootPath = Bun.env[WORKSPACE_ROOT_ENV_VAR] || DEFAULT_WORKSPACE_ROOT
	// An empty variable means "not set", the same convention WORKSPACE_ROOT follows.
	const pageTitle = Bun.env[PAGE_TITLE_ENV_VAR] || DEFAULT_PAGE_TITLE
	const runsBaseDir = path.resolve(workspaceRootPath, ORCHESTRATION_DIR, 'runs')
	excludeOrchestrationFromGit(workspaceRootPath)

	// One tolerant startup read of the baked build identifier, for the startup log and GET /api/config.
	const buildInfo = createBuildInfoReader(BUILD_INFO_PATH)()
	if (buildInfo !== null) {
		console.log(`Build: ${buildInfo.sha === undefined ? 'sha unknown' : buildInfo.sha}, built at ${buildInfo.builtAt}`)
	}

	let guild: LoadedGuild
	let apiKey: string | undefined
	let kagiApiKey: string | undefined
	// The deployment file's logging default (docs/reference.md "Logging level"), captured at startup and handed to the run submission as the chain's lowest-priority input.
	let deploymentLogLevel: LogLevel | undefined
	try {
		const deploymentFilePath = Bun.env[DEPLOYMENT_FILE_ENV_VAR] || DEPLOYMENT_PATH
		const loadGuild = createGuildLoader(deploymentFilePath)
		const loadedGuildFiles = loadGuild(GUILD_PATH)
		// Environment variables override individual fields on top of the deployment file (file first, environment second).
		// The merged result is re-validated here because an override can point a handler role at a name the guild does not declare, and the failure must surface at startup before any run accepts it — role names are configuration, not credentials, so echoing them in the error is safe. The merged value is still file-shaped (the model's optional fields may be absent), so the file validator applies; the model is then completed into the resolved shape the executor consumes.
		const roleNames = new Set(Object.keys(loadedGuildFiles.config.roles))
		const mergedDeployment = applyDeploymentOverride(loadedGuildFiles.deployment, resolveDeploymentOverride(Bun.env))
		validateDeploymentFileConfig(mergedDeployment)
		validateDeploymentRoleReferences(mergedDeployment, roleNames)
		deploymentLogLevel = mergedDeployment.logging?.level

		// The orchestrator credential comes from the shared secret channels: the ORCHESTRATOR_API_KEY environment variable first, then a docker secret mounted at /run/secrets/orchestrator_api_key (or ORCHESTRATOR_API_KEY).
		// resolveSecret trims and normalizes empty values to undefined so the caller omits the Authorization header entirely.
		// Resolved before the probe so the probe can authenticate against endpoints that require a key.
		apiKey = resolveSecret('orchestrator_api_key', { environment: Bun.env, readDockerSecret: createDockerSecretReader(DOCKER_SECRETS_DIR) })
		kagiApiKey = resolveKagiApiKey(Bun.env, createDockerSecretReader(DOCKER_SECRETS_DIR))
		if (kagiApiKey === undefined) {
			console.log('KAGI_API_KEY not set: web_search and the kagi fetch backend will report themselves unavailable')
		}

		// One startup probe of the model API, before the resolved composition: the server's own values are ground truth, so an API-reported context window always replaces the configured one, and a missing name is discovered when the API serves exactly one model.
		// The probe reports failure as a value instead of throwing, and the resolver turns that into a fallback to configuration — a failed probe only fails startup when a needed field is then still missing, so a down endpoint never blocks boot with a complete configuration on file.
		const apiBase = mergedDeployment.model.apiBase
		const probeModelInfo = createModelInfoProbe(apiBase, apiKey, MODEL_PROBE_TIMEOUT_MS)
		const probe = await probeModelInfo()
		const models = probe.ok ? parseModelInfo(probe.body) : undefined
		const failureReason = probe.ok ? undefined : probe.reason
		if (!probe.ok) {
			console.log(`Model API probe failed (${probe.reason}); continuing with the configured model values`)
		}
		const apiProbe: ModelApiProbe = { apiBase, models, failureReason }
		const resolution = resolveDeploymentConfig(mergedDeployment, apiProbe)
		console.log(`Model name: ${resolution.deployment.model.name} (from ${resolution.nameSource})`)
		console.log(`Context window: ${resolution.deployment.model.contextWindow} (from ${resolution.contextWindowSource})`)
		if (resolution.apiContextWindow !== undefined && mergedDeployment.model.contextWindow !== undefined && resolution.apiContextWindow !== mergedDeployment.model.contextWindow) {
			console.log(`Context window override: the model API reports ${resolution.apiContextWindow}, replacing the configured ${mergedDeployment.model.contextWindow}`)
		}
		guild = { ...loadedGuildFiles, deployment: resolution.deployment }
	} catch (error) {
		// A ValidationError raised in this block can only come from loading or re-validating the guild and deployment data, which is by definition a configuration failure, so both classes present through the failure page (normalized to ConfigurationError, whose message is fit to show the operator).
		// Anything else is unexpected and rethrows to the plain-exit catch.
		if (error instanceof ConfigurationError || error instanceof ValidationError) {
			await serveBootstrapFailure({ port, error: new ConfigurationError(error.message) })
		}
		throw error
	}

	const llmCaller = createLlmCaller(guild.deployment.model, apiKey, { llmFetch: createLlmFetch(), sleep: createSleep(), scheduleTimeout: createTimeoutScheduler() })

	const webHumanBackend = createWebHumanBackend()
	const interruptChannel = createInterruptChannel()
	const runState = createRunState({ humanBackend: webHumanBackend, interruptChannel })
	const readRunSnapshotStats = createReadRunSnapshotStats(runsBaseDir)
	const readRunMetaById = createReadRunMetaById(runsBaseDir)
	const readRunSnapshot = createSnapshotCache({ readStats: readRunSnapshotStats, readMetaText: readRunMetaById, readLogTextFrom: createReadRunLogTextFrom(runsBaseDir) }, SNAPSHOT_CACHE_MAX_ENTRIES)
	const readRunSummaryStats = createReadRunSummaryStats(runsBaseDir)
	const readRunSummaryById = createReadRunSummaryById(runsBaseDir)
	const readRunListSummary = createRunListCache({ readRunSummaryStats, readRunMetaById, readRunSummaryById }, RUN_LIST_CACHE_MAX_ENTRIES)
	const readRunPlanById = createReadRunPlanById(runsBaseDir)
	const listRunIds = createListRunIds(runsBaseDir)
	const readProjectSettings = createReadProjectSettings(workspaceRootPath)
	const writeProjectSettings = createWriteProjectSettings(workspaceRootPath)
	// The raw whole-file reader stays outside the per-poll path: the summarizer reads a finished run's whole log once per completion, which the snapshot cache (shaped for per-second polling) does not serve.
	const readRawSnapshot = createReadRunSnapshotById(runsBaseDir)
	const summarizer = createTaskSummarizer({
		callLlm: (request) => llmCaller.call(request),
		readRunLogText: (runId) => readRawSnapshot(runId).logText,
		writeRunSummaryText: (runId, summary) => createWriteRunSummary(runId, runsBaseDir)(summary),
	})

	const runConfig = {
		loadedGuild: guild,
		llmCaller,
		humanBackend: webHumanBackend,
		interruptChannel,
		summarizer,
		kagiApiKey,
		guildPath: GUILD_PATH,
		workspaceRootPath,
		runsBaseDir,
	}
	const startRun = createStartRun(runConfig)
	const resumeRun = createResumeRun(runConfig)
	const runSubmission = createRunSubmission({ startRun, resumeRun, generateRunId: () => generateRunId(new Date()), runDirectoryExists: createRunDirectoryExists(runsBaseDir), readProjectSettings, deploymentLogLevel })

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
		pageTitle,
		guildConfig: guild.config,
		deployment: guild.deployment,
		tools: guild.tools,
		runState,
		runSubmission,
		readRunSnapshot,
		readRunMetaById,
		readRunListSummary,
		readRunSummaryStats,
		readRunPlanById,
		readRunSnapshotStats,
		listRunIds,
		readProjectSettings,
		writeProjectSettings,
		build: buildInfo,
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
