import type { ListRunIds, ProjectSettings, ReadProjectSettings, ReadRunMetaById, ReadRunPlanById, ReadRunSnapshotStats, ReadRunSummaryById, ReadRunSummaryStats, WriteProjectSettings } from '../executor/persistence.js'
import { isRunIdShape } from '../executor/run-id.js'
import type { DeploymentConfig, EffortLevel, GuildConfig, LogLevel, ToolManifest } from '../executor/types.js'
import { isEffortLevel, isLogLevel, isObject, isTerminalRunStatus } from '../executor/validation.js'
import type { RunState } from '../executor/run-state.js'
import type { RunSubmission } from '../executor/run-submission.js'
import { paginateLogEvents, parseRunMeta, renderConfig, renderProjectSettings, renderPendingQuestions, renderRunView, formatLogAsText, formatLogDetailSections } from './render.js'
import { createRunListCache, type ReadRunListSummary } from './run-list-cache.js'
import { deriveInteractionModel, deriveInteractionOperationDetail } from './interaction-model-adapter.js'
import { DEMO_SCENARIOS, deriveDemoFrameModel, deriveDemoFrameOperationDetail, findDemoScenario } from './demo-fixtures.js'
import type { ReadRunSnapshot } from './snapshot-cache.js'

const MAX_LOG_LINES = 200

// The log window endpoint's paging defaults and cap: a 1s poll that wants a compact identity view
// fetches 50 rows, and no single request may be tricked (or misconfigured) into serializing the
// whole run — the payloads alone can be multi-megabyte, which is exactly what the cap bounds.
const LOG_WINDOW_DEFAULT_LIMIT = 50
const LOG_WINDOW_MAX_LIMIT = 500

// The run list is polled every second alongside the selected run's endpoints; 64 cached summaries covers every history a browser realistically browses while bounding memory on a long-lived service.
const RUN_LIST_CACHE_MAX_ENTRIES = 64

export interface RequestHandlerConfig {
	guildConfig: GuildConfig
	deployment: DeploymentConfig
	tools: Record<string, ToolManifest>
	runState: RunState
	runSubmission: RunSubmission
	readRunSnapshot: ReadRunSnapshot
	readRunMetaById: ReadRunMetaById
	readRunSummaryById: ReadRunSummaryById
	readRunSummaryStats: ReadRunSummaryStats
	readRunPlanById: ReadRunPlanById
	readRunSnapshotStats: ReadRunSnapshotStats
	listRunIds: ListRunIds
	readProjectSettings: ReadProjectSettings
	writeProjectSettings: WriteProjectSettings
}

// The static-asset leaf: given a GET path that matched no API route, produce the response. Injected so the routing below is exercisable without touching the filesystem or a socket.
export type ServeStatic = (requestPath: string) => Response

export type RequestHandler = (request: Request) => Promise<Response>

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	})
}

function handleActiveRun(readRunSnapshot: ReadRunSnapshot, readRunSnapshotStats: ReadRunSnapshotStats, readRunPlanById: ReadRunPlanById, runSubmission: RunSubmission, runState: RunState): Response {
	const runId = runSubmission.lastRunId()
	if (runId === undefined) return json({ ok: false, error: 'no_run' }, 404)
	const view = runViewFor(readRunSnapshot, readRunSnapshotStats, readRunPlanById, runId)
	if (view === null) return json({ ok: false, error: 'not_found' }, 404)
	return json({ ...view, interruptPending: runState.interruptPending() })
}

function handleActiveRunFlow(readRunSnapshot: ReadRunSnapshot, readRunSnapshotStats: ReadRunSnapshotStats, runSubmission: RunSubmission, query: URLSearchParams): Response {
	const runId = runSubmission.lastRunId()
	if (runId === undefined) return json({ ok: false, error: 'no_run' }, 404)
	return runFlowPage(readRunSnapshot, readRunSnapshotStats, runId, query)
}

function handleGetRunById(readRunSnapshot: ReadRunSnapshot, readRunSnapshotStats: ReadRunSnapshotStats, readRunPlanById: ReadRunPlanById, runState: RunState, runId: string): Response {
	const view = runViewFor(readRunSnapshot, readRunSnapshotStats, readRunPlanById, runId)
	if (view === null) return json({ ok: false, error: 'not_found' }, 404)
	return json({ ...view, interruptPending: runState.interruptPending() })
}

function runLogPage(readRunSnapshot: ReadRunSnapshot, readRunSnapshotStats: ReadRunSnapshotStats, runId: string, query: URLSearchParams): Response {
	if (!isKnownRun(readRunSnapshotStats, runId)) return json({ ok: false, error: 'not_found' }, 404)
	const snapshot = readRunSnapshot(runId)
	const events = snapshot.logEvents
	const offset = parseNonNegativeInt(query.get('offset'), 0)
	const limit = Math.min(parseNonNegativeInt(query.get('limit'), LOG_WINDOW_DEFAULT_LIMIT), LOG_WINDOW_MAX_LIMIT)
	// ?detail=<index> serves one event's paired detail sections (the sent/received/arguments/result bodies) on demand, so a client renders a row's raw view without the window shipping every body. The index is the event's log-wide position — the same identity the window rows and the run view's recentLog carry.
	const detailParam = query.get('detail')
	if (detailParam !== null) {
		const detailIndex = parseStrictNonNegativeInt(detailParam)
		const event = detailIndex !== undefined ? events[detailIndex] : undefined
		if (event === undefined) return json({ ok: false, error: 'not_found' }, 404)
		return json({ index: detailIndex, detailSections: formatLogDetailSections(event) })
	}
	// ?format=text renders the requested page as plain text with a download disposition, so export reuses the server-side formatter rather than duplicating it in the client.
	if (query.get('format') === 'text') {
		const page = paginateLogEvents(events, { offset, limit })
		return new Response(formatLogAsText(page.events), {
			headers: {
				'content-type': 'text/plain; charset=utf-8',
				'cache-control': 'no-store',
				'content-disposition': `attachment; filename="${runId}.log"`,
			},
		})
	}
	const page = paginateLogEvents(events, { offset, limit })
	return json({ runId, total: page.total, offset: page.offset, limit: page.limit, events: page.events.map((event, position) => ({ index: offset + position, timestamp: event.timestamp, type: event.type, payload: event.payload })) })
}

function parseNonNegativeInt(value: string | null, defaultValue: number): number {
	if (value === null) return defaultValue
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed < 0) return defaultValue
	return parsed
}

// Strict variant for identities: unlike the paging params (where a bad value falls back to the
// default page), a bad detail index names an event that cannot exist, so the caller gets a 404
// rather than a silently different event. The empty string is rejected like any other malformed
// value — Number('') is 0, which would otherwise silently address the first event.
function parseStrictNonNegativeInt(value: string): number | undefined {
	if (value === '') return undefined
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed < 0) return undefined
	return parsed
}

// Serves the structured InteractionModel derived from a run's full snapshot.
// The model is JSON (identifiers, counters, costs as values; no detail bodies); the client renders operation details only through the on-demand variant below and its sanitized Markdown pipeline, so the server does not sanitize — it must not serve pre-rendered HTML that would bypass the client's sanitization.
// ?operation=<id> serves that single operation's details markdown instead of the whole model: the derive is the same O(N) walk, but only one detail string is formatted and shipped, so a hover costs a tiny response while the polled model carries none.
function runFlowPage(readRunSnapshot: ReadRunSnapshot, readRunSnapshotStats: ReadRunSnapshotStats, runId: string, query: URLSearchParams): Response {
	if (!isKnownRun(readRunSnapshotStats, runId)) return json({ ok: false, error: 'not_found' }, 404)
	const snapshot = readRunSnapshot(runId)
	const operationId = query.get('operation')
	if (operationId !== null) {
		const detail = deriveInteractionOperationDetail(snapshot, new Date().toISOString(), operationId)
		if (detail === null) return json({ ok: false, error: 'not_found' }, 404)
		return json(detail)
	}
	return json(deriveInteractionModel(snapshot, new Date().toISOString()))
}

function runViewFor(readRunSnapshot: ReadRunSnapshot, readRunSnapshotStats: ReadRunSnapshotStats, readRunPlanById: ReadRunPlanById, runId: string): ReturnType<typeof renderRunView> | null {
	if (!isKnownRun(readRunSnapshotStats, runId)) return null
	const snapshot = readRunSnapshot(runId)
	// The plan is read per request rather than riding the snapshot cache: it is a separate document the run may gain mid-flight, and the file is small enough that re-reading is free.
	return renderRunView(snapshot, { maxLogLines: MAX_LOG_LINES, now: new Date().toISOString(), plan: readRunPlanById(runId) })
}

// Feeds the scenario's first `frameIndex + 1` events through the real adapter — the same derivation the product's `/api/runs/:id/flow` runs — so the demo harness exercises the product's `LogEvent → InteractionModel` path rather than authored model frames. `?operation=<id>` resolves one operation's details the same way the product's flow endpoint does, so the harness's inspector fetches on demand like the product client.
function demoFrameResponse(scenarioId: string, frameIndex: number, query: URLSearchParams): Response {
	const scenario = findDemoScenario(scenarioId)
	if (scenario === undefined) return json({ ok: false, error: 'not_found' }, 404)
	if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= scenario.events.length) {
		return json({ ok: false, error: 'not_found' }, 404)
	}
	const operationId = query.get('operation')
	if (operationId !== null) {
		const detail = deriveDemoFrameOperationDetail(scenario, frameIndex, operationId)
		if (detail === null) return json({ ok: false, error: 'not_found' }, 404)
		return json(detail)
	}
	return json(deriveDemoFrameModel(scenario, frameIndex))
}

// The manifest includes the scenario's full participant set (taken from the final frame's model) so the sequence view can lay out every column from the first frame, the same role the product's static guild participant inventory plays for a live run.
function handleDemoScenarios(): Response {
	const manifests = DEMO_SCENARIOS.map((scenario) => {
		const lastFrame = deriveDemoFrameModel(scenario, scenario.events.length - 1)
		return { id: scenario.id, label: scenario.label, frameCount: scenario.events.length, participants: lastFrame.participants }
	})
	return json(manifests)
}

function isKnownRun(readRunSnapshotStats: ReadRunSnapshotStats, runId: string): boolean {
	const stats = readRunSnapshotStats(runId)
	return stats.meta !== null || stats.log !== null
}

function handleListRuns(readRunListSummary: ReadRunListSummary, listRunIds: ListRunIds): Response {
	const summaries = listRunIds()
		.slice()
		.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
		.map((runId) => readRunListSummary(runId))
	return json(summaries)
}

function handleAnswer(runState: RunState, body: unknown): Response {
	if (!isObject(body)) return json({ ok: false, error: 'invalid_body' }, 400)
	const idValue = body['id']
	const answerValue = body['answer']
	if (typeof idValue !== 'string' || idValue === '') return json({ ok: false, error: 'invalid_body' }, 400)
	if (typeof answerValue !== 'string') return json({ ok: false, error: 'invalid_body' }, 400)
	const result = runState.submitAnswer(idValue, answerValue)
	if (result.kind === 'resolved') return json({ ok: true })
	return json({ ok: false, error: 'not_found' }, 404)
}

// The public API accepts only these two kinds; the engine's internal InterruptKind union is wider ('notice' is service-internal, e.g. the shutdown wind-down), so the guard narrows to the public subset rather than the engine's type.
function isInterruptKind(value: unknown): value is 'inquiry' | 'plan_modification' {
	return value === 'inquiry' || value === 'plan_modification'
}

// An interrupt applies to the one active run, so the :id in the route must name it exactly; anything else (a stale id, a terminal run, no run at all) is a conflict the caller can see rather than a silently dropped request.
function handleInterrupt(runState: RunState, runSubmission: RunSubmission, runId: string, body: unknown): Response {
	if (!isObject(body)) return json({ ok: false, error: 'invalid_body' }, 400)
	const kindValue = body['kind']
	if (!isInterruptKind(kindValue)) return json({ ok: false, error: 'invalid_body' }, 400)
	const messageValue = body['message']
	if (typeof messageValue !== 'string' || messageValue === '') return json({ ok: false, error: 'invalid_body' }, 400)
	if (runSubmission.activeRunId() !== runId) return json({ ok: false, error: 'run_not_active' }, 409)
	const result = runState.submitInterrupt({ kind: kindValue, message: messageValue })
	if (result === 'accepted') return json({ ok: true }, 202)
	return json({ ok: false, error: 'run_not_active' }, 409)
}

function handleCreateRun(runSubmission: RunSubmission, readRunMetaById: ReadRunMetaById, body: unknown): Response {
	if (!isObject(body)) return json({ ok: false, error: 'invalid_body' }, 400)
	const taskValue = body['task']
	if (typeof taskValue !== 'string' || taskValue === '') return json({ ok: false, error: 'invalid_body' }, 400)
	const effortValue = body['effort']
	if (effortValue !== undefined && !isEffortLevel(effortValue)) return json({ ok: false, error: 'invalid_body' }, 400)
	const effortOverride: EffortLevel | undefined = effortValue
	const logLevelValue = body['logLevel']
	if (logLevelValue !== undefined && !isLogLevel(logLevelValue)) return json({ ok: false, error: 'invalid_body' }, 400)
	const logLevelOverride: LogLevel | undefined = logLevelValue
	const continuesFromValue = body['continuesFrom']
	if (continuesFromValue !== undefined && !isRunIdShape(continuesFromValue)) return json({ ok: false, error: 'invalid_body' }, 400)
	const priorMeta = continuesFromValue === undefined ? null : parseRunMeta(readRunMetaById(continuesFromValue))
	if (continuesFromValue !== undefined && (priorMeta === null || !isTerminalRunStatus(priorMeta.status))) return json({ ok: false, error: 'invalid_body' }, 400)
	const continuation = continuesFromValue !== undefined && priorMeta !== null ? {
		runId: continuesFromValue,
		task: priorMeta.task,
		summary: priorMeta.result?.summary ?? '',
	} : undefined
	const result = runSubmission.submit(taskValue, effortOverride, logLevelOverride, continuation)
	if (result.ok) return json({ runId: result.runId }, 201)
	return json({ ok: false, error: result.error }, 409)
}

function handleGetSettings(readProjectSettings: ReadProjectSettings): Response {
	return json(renderProjectSettings(readProjectSettings()))
}

// The write replaces settings.json wholesale, so the body is the complete new settings: effort is required (the field the compose screen always has a value for), and the optional logLevel is cleared when absent — the client always sends both so saving one never clears the other.
function handlePutSettings(writeProjectSettings: WriteProjectSettings, body: unknown): Response {
	if (!isObject(body)) return json({ ok: false, error: 'invalid_body' }, 400)
	const effortValue = body['effort']
	if (!isEffortLevel(effortValue)) return json({ ok: false, error: 'invalid_body' }, 400)
	const logLevelValue = body['logLevel']
	if (logLevelValue !== undefined && !isLogLevel(logLevelValue)) return json({ ok: false, error: 'invalid_body' }, 400)
	const settings: ProjectSettings = { effort: effortValue, ...(logLevelValue !== undefined ? { logLevel: logLevelValue } : {}) }
	writeProjectSettings(settings)
	return json(renderProjectSettings(settings))
}

export function createRequestHandler(config: RequestHandlerConfig, serveStatic: ServeStatic): RequestHandler {
	const guildConfig = config.guildConfig
	const deployment = config.deployment
	const runState = config.runState
	const runSubmission = config.runSubmission
	const readRunSnapshot = config.readRunSnapshot
	const readRunMetaById = config.readRunMetaById
	const readRunSummaryById = config.readRunSummaryById
	const readRunListSummary = createRunListCache({ readRunSummaryStats: config.readRunSummaryStats, readRunMetaById, readRunSummaryById }, RUN_LIST_CACHE_MAX_ENTRIES)
	const readRunPlanById = config.readRunPlanById
	const readRunSnapshotStats = config.readRunSnapshotStats
	const listRunIds = config.listRunIds
	const readProjectSettings = config.readProjectSettings
	const writeProjectSettings = config.writeProjectSettings

	return async (request) => {
		const url = new URL(request.url)
		const { pathname } = url

		if (request.method === 'GET') {
			if (pathname === '/api/config') return json(renderConfig(guildConfig, deployment, config.tools))
			if (pathname === '/api/settings') return handleGetSettings(readProjectSettings)
			if (pathname === '/api/run/flow') return handleActiveRunFlow(readRunSnapshot, readRunSnapshotStats, runSubmission, url.searchParams)
			if (pathname === '/api/run') return handleActiveRun(readRunSnapshot, readRunSnapshotStats, readRunPlanById, runSubmission, runState)
			if (pathname === '/api/runs') return handleListRuns(readRunListSummary, listRunIds)
			if (pathname.startsWith('/api/runs/')) {
				const rest = decodeURIComponent(pathname.slice('/api/runs/'.length))
				// Match a /log or /flow suffix before the bare :id route so /api/runs/<id>/log and /api/runs/<id>/flow reach their endpoints rather than being swallowed as a run id of "<id>/log" or "<id>/flow".
				const slashIndex = rest.lastIndexOf('/')
				if (slashIndex >= 0) {
					const suffix = rest.slice(slashIndex + 1)
					const runId = rest.slice(0, slashIndex)
					if (runId !== '') {
						if (suffix === 'log') return runLogPage(readRunSnapshot, readRunSnapshotStats, runId, url.searchParams)
						if (suffix === 'flow') return runFlowPage(readRunSnapshot, readRunSnapshotStats, runId, url.searchParams)
					}
				}
				return handleGetRunById(readRunSnapshot, readRunSnapshotStats, readRunPlanById, runState, rest)
			}
			if (pathname === '/api/questions') return json(renderPendingQuestions(runState.pendingQuestions()))
			if (pathname === '/api/demo/scenarios') return handleDemoScenarios()
			if (pathname.startsWith('/api/demo/flow/')) {
				const rest = decodeURIComponent(pathname.slice('/api/demo/flow/'.length))
				const slashIndex = rest.lastIndexOf('/')
				if (slashIndex >= 0) {
					const scenarioId = rest.slice(0, slashIndex)
					const frameRaw = rest.slice(slashIndex + 1)
					const frameIndex = Number(frameRaw)
					if (scenarioId !== '' && Number.isInteger(frameIndex)) return demoFrameResponse(scenarioId, frameIndex, url.searchParams)
				}
				return json({ ok: false, error: 'not_found' }, 404)
			}
			// Browsers auto-request /favicon.ico on every page load; answer 204 so it does not pollute the console with a 404.
			if (pathname === '/favicon.ico') return new Response(null, { status: 204 })
			return serveStatic(pathname)
		}

		if (request.method === 'POST') {
			if (pathname === '/api/runs') {
				const body = await readJsonBody(request)
				if (body === undefined) return json({ ok: false, error: 'invalid_body' }, 400)
				return handleCreateRun(runSubmission, readRunMetaById, body)
			}
			if (pathname.startsWith('/api/runs/') && pathname.endsWith('/interrupt')) {
				const runId = decodeURIComponent(pathname.slice('/api/runs/'.length, pathname.length - '/interrupt'.length))
				if (runId === '' || runId.includes('/')) return json({ ok: false, error: 'not_found' }, 404)
				const body = await readJsonBody(request)
				if (body === undefined) return json({ ok: false, error: 'invalid_body' }, 400)
				return handleInterrupt(runState, runSubmission, runId, body)
			}
			if (pathname === '/api/answer') {
				const body = await readJsonBody(request)
				if (body === undefined) return json({ ok: false, error: 'invalid_body' }, 400)
				return handleAnswer(runState, body)
			}
		}

		if (request.method === 'PUT') {
			if (pathname === '/api/settings') {
				const body = await readJsonBody(request)
				if (body === undefined) return json({ ok: false, error: 'invalid_body' }, 400)
				return handlePutSettings(writeProjectSettings, body)
			}
		}

		return json({ ok: false, error: 'not_found' }, 404)
	}
}

async function readJsonBody(request: Request): Promise<unknown | undefined> {
	try {
		const text = await request.text()
		return JSON.parse(text)
	} catch {
		return undefined
	}
}
