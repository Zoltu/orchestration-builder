import type { ListRunIds, ProjectSettings, ReadProjectSettings, ReadRunMetaById, ReadRunPlanById, ReadRunSnapshotStats, ReadRunSummaryStats, ReadTaskQueue, WriteProjectSettings, WriteTaskQueue } from '../executor/persistence.js'
import { isRunIdShape } from '../executor/run-id.js'
import type { DeploymentConfig, EffortLevel, GuildConfig, LogLevel, ToolManifest } from '../executor/types.js'
import { isEffortLevel, isLogLevel, isObject, isTerminalRunStatus } from '../executor/validation.js'
import { cancelWaitingItem, editWaitingItem, enqueueAtHead, enqueueAtTail, normalizeNewItem, recordAnswer, removeWaitingItem, reorderWaitingItem, requireWaitingItem, requeueErrorItem, type QueueItem, type QueueMutation } from '../executor/task-queue.js'
import type { RunState } from '../executor/run-state.js'
import type { RunSubmission } from '../executor/run-submission.js'
import { paginateLogEvents, parseRunMeta, renderConfig, renderProjectSettings, renderPendingQuestions, renderRunView, formatLogAsText, formatLogDetailSections, foldLlmCallSent } from './render.js'
import type { BuildInfo } from './build-info.js'
import type { ReadRunListSummary } from './run-list-cache.js'
import { deriveInteractionModel, deriveInteractionOperationDetail } from './interaction-model-adapter.js'
import { DEMO_SCENARIOS, deriveDemoFrameModel, deriveDemoFrameOperationDetail, findDemoScenario } from './demo-fixtures.js'
import type { ReadRunSnapshot } from './snapshot-cache.js'

const MAX_LOG_LINES = 200

// The log window endpoint's paging defaults and cap: a 1s poll that wants a compact identity view
// fetches 50 rows, and no single request may be tricked (or misconfigured) into serializing the
// whole run — the payloads alone can be multi-megabyte, which is exactly what the cap bounds.
const LOG_WINDOW_DEFAULT_LIMIT = 50
const LOG_WINDOW_MAX_LIMIT = 500

export interface RequestHandlerConfig {
	guildConfig: GuildConfig
	deployment: DeploymentConfig
	tools: Record<string, ToolManifest>
	runState: RunState
	runSubmission: RunSubmission
	readRunSnapshot: ReadRunSnapshot
	readRunMetaById: ReadRunMetaById
	readRunListSummary: ReadRunListSummary
	readRunSummaryStats: ReadRunSummaryStats
	readRunPlanById: ReadRunPlanById
	readRunSnapshotStats: ReadRunSnapshotStats
	listRunIds: ListRunIds
	readProjectSettings: ReadProjectSettings
	writeProjectSettings: WriteProjectSettings
	// The durable task queue's leaves (docs/queueing.md "The queue: storage, item model, state machine"): every /api/queue mutation is a whole-file read-modify-write through these.
	readQueue: ReadTaskQueue
	writeQueue: WriteTaskQueue
	// The scheduler's tick: queue mutations that could find the slot free (enqueue, answer, requeue) and the idle POST /api/runs path dispatch through it, so a free slot never sits idle behind a waiting item.
	tickScheduler: () => Promise<void>
	// The baked image build identifier, read once at startup (null without a baked build-info); surfaced through GET /api/config.
	build: BuildInfo | null
}

// The static-asset leaf: given a GET path that matched no API route, produce the response. Injected so the routing below is exercisable without touching the filesystem or a socket. Async because the index route reads the served body to substitute the page title (see server.ts createServeStatic).
export type ServeStatic = (requestPath: string) => Promise<Response>

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

function handleGetRunById(readRunSnapshot: ReadRunSnapshot, readRunSnapshotStats: ReadRunSnapshotStats, readRunPlanById: ReadRunPlanById, runSubmission: RunSubmission, runState: RunState, runId: string): Response {
	const view = runViewFor(readRunSnapshot, readRunSnapshotStats, readRunPlanById, runId)
	if (view === null) return json({ ok: false, error: 'not_found' }, 404)
	// interruptPending reads the shared channel's state, so it describes the active run only: a terminal run viewed while another run is active must report false rather than inherit the active run's pending interrupt.
	return json({ ...view, interruptPending: runSubmission.activeRunId() === runId && runState.interruptPending() })
}

function runLogPage(readRunSnapshot: ReadRunSnapshot, readRunSnapshotStats: ReadRunSnapshotStats, runId: string, query: URLSearchParams): Response {
	if (!isKnownRun(readRunSnapshotStats, runId)) return json({ ok: false, error: 'not_found' }, 404)
	const snapshot = readRunSnapshot(runId)
	const events = snapshot.logEvents
	const offset = parseNonNegativeInt(query.get('offset'), 0)
	const limit = Math.min(parseNonNegativeInt(query.get('limit'), LOG_WINDOW_DEFAULT_LIMIT), LOG_WINDOW_MAX_LIMIT)
	// ?detail=<index> serves one event's paired detail sections (the sent/received/arguments/result bodies) on demand, so a client renders a row's raw view without the window shipping every body. The index is the event's log-wide position — the same identity the window rows and the run view's recentLog carry. An llm_call event carries only its conversation slice (the delta protocol), so the fold reconstructs the full conversation server-side and the raw-detail view is identical for delta and full-snapshot logs.
	const detailParam = query.get('detail')
	if (detailParam !== null) {
		const detailIndex = parseStrictNonNegativeInt(detailParam)
		if (detailIndex === undefined) return json({ ok: false, error: 'not_found' }, 404)
		const event = events[detailIndex]
		if (event === undefined) return json({ ok: false, error: 'not_found' }, 404)
		return json({ index: detailIndex, detailSections: formatLogDetailSections(foldLlmCallSent(events, detailIndex)) })
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

// Strict variant for path identities: a segment that does not decode (a stray '%', a truncated escape, a lone surrogate) names a path that cannot exist, so the caller gets the same 404 as any other unknown id rather than a URIError escaping the fetch handler. decodeURIComponent signals malformed input only by throwing, so catching here is the check, not flow control.
function decodePathSegment(segment: string): string | undefined {
	try {
		return decodeURIComponent(segment)
	} catch {
		return undefined
	}
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

// POST /api/runs keeps today's external contract exactly (docs/queueing.md "HTTP API") while every run becomes queue-tracked: the validated task is enqueued at the head of the durable queue and the scheduler — the only caller of submission — dispatches it within the same request when the slot is free, so the response is still 201 { runId }. The request's effort, logLevel, and continuesFrom are recorded on the item and thread into the dispatched run. When a run is in flight the request is refused with nothing enqueued, exactly today's 409.
async function handleCreateRun(runSubmission: RunSubmission, readRunMetaById: ReadRunMetaById, readQueue: ReadTaskQueue, writeQueue: WriteTaskQueue, tickScheduler: () => Promise<void>, body: unknown): Promise<Response> {
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
	// Checked before enqueueing so a busy service enqueues nothing, exactly as the 409 contract promises scripts.
	if (runSubmission.activeRunId() !== undefined) return json({ ok: false, error: 'run_in_progress' }, 409)
	const normalized = normalizeNewItem(
		{ task: taskValue, ...(effortOverride !== undefined ? { effort: effortOverride } : {}), ...(logLevelOverride !== undefined ? { logLevel: logLevelOverride } : {}), ...(continuesFromValue !== undefined ? { continuesFrom: continuesFromValue } : {}) },
		{ id: crypto.randomUUID(), queuedAt: new Date().toISOString() },
	)
	// Unreachable: every field was validated above, so the normalization cannot refuse.
	if (!normalized.ok) return json({ ok: false, error: 'invalid_body' }, 400)
	writeQueue(enqueueAtHead(readQueue(), normalized.item))
	await tickScheduler()
	const dispatched = readQueue().items.find((item) => item.id === normalized.item.id)
	if (dispatched !== undefined && dispatched.runId !== undefined) return json({ runId: dispatched.runId }, 201)
	// The dispatch did not take. A same-second collision retry that overlapped another request's dispatch can land here with the item restored waiting while a run is in flight: the loser's item stays queued at the head (the scheduler's rules dispatch it when the active run settles) and today's run_in_progress stands. A collision that exhausted the scheduler's retry budget leaves a waiting item with no run behind it — removed (only then), so the caller's resubmit behaves exactly as it does today.
	if (runSubmission.activeRunId() !== undefined || dispatched === undefined || dispatched.status !== 'waiting') return json({ ok: false, error: 'run_in_progress' }, 409)
	const removal = removeWaitingItem(readQueue(), normalized.item.id)
	if (!removal.ok) return json({ ok: false, error: 'run_in_progress' }, 409)
	writeQueue(removal.queue)
	return json({ ok: false, error: 'run_id_collision' }, 409)
}

// --- /api/queue (docs/queueing.md "HTTP API") --------------------------------

// Maps a by-id queue transformation's refusal to the shared error semantics: an unknown id is 404, a status-forbidden operation is 409.
function queueMutationResponse(result: QueueMutation): Response {
	if (result.ok) return json(result.item)
	if (result.reason === 'not_found') return json({ ok: false, error: 'not_found' }, 404)
	return json({ ok: false, error: 'status_forbidden' }, 409)
}

function handleGetQueue(readQueue: ReadTaskQueue): Response {
	return json(readQueue().items)
}

// POST /api/queue always enqueues at the tail — never 409 — and ticks the scheduler, so an idle system dispatches the new task within the same request. Only task and effort are read from the body: a queue-native item's logLevel resolves through the standard chain at dispatch (docs/queueing.md "The queue: storage, item model, state machine"), and other fields are lineage or outcome bookkeeping the platform owns.
async function handleEnqueueTask(readQueue: ReadTaskQueue, writeQueue: WriteTaskQueue, tickScheduler: () => Promise<void>, body: unknown): Promise<Response> {
	if (!isObject(body)) return json({ ok: false, error: 'invalid_body' }, 400)
	const normalized = normalizeNewItem({ task: body['task'], effort: body['effort'] }, { id: crypto.randomUUID(), queuedAt: new Date().toISOString() })
	if (!normalized.ok) return json({ ok: false, error: 'invalid_body' }, 400)
	writeQueue(enqueueAtTail(readQueue(), normalized.item))
	await tickScheduler()
	return json(normalized.item, 201)
}

// PATCH edits task/effort and/or moves the item to a clamped 0-based position in the waiting list; waiting items only.
function handlePatchQueueItem(readQueue: ReadTaskQueue, writeQueue: WriteTaskQueue, itemId: string, body: unknown): Response {
	if (!isObject(body)) return json({ ok: false, error: 'invalid_body' }, 400)
	const taskValue = body['task']
	if (taskValue !== undefined && (typeof taskValue !== 'string' || taskValue === '')) return json({ ok: false, error: 'invalid_body' }, 400)
	const task: string | undefined = taskValue
	const effortValue = body['effort']
	if (effortValue !== undefined && !isEffortLevel(effortValue)) return json({ ok: false, error: 'invalid_body' }, 400)
	const effort: EffortLevel | undefined = effortValue
	const positionValue = body['position']
	if (positionValue !== undefined && !isQueuePosition(positionValue)) return json({ ok: false, error: 'invalid_body' }, 400)
	const position: number | undefined = positionValue
	let queue = readQueue()
	let item: QueueItem | undefined
	if (task !== undefined || effort !== undefined) {
		const edited = editWaitingItem(queue, itemId, { ...(task !== undefined ? { task } : {}), ...(effort !== undefined ? { effort } : {}) })
		if (!edited.ok) return queueMutationResponse(edited)
		queue = edited.queue
		item = edited.item
	}
	if (position !== undefined) {
		const reordered = reorderWaitingItem(queue, itemId, position)
		if (!reordered.ok) return queueMutationResponse(reordered)
		queue = reordered.queue
		item = reordered.item
	}
	if (item === undefined) {
		// An empty patch is a no-op that still addresses a real waiting item, so existence and status are validated without writing anything.
		const required = requireWaitingItem(queue, itemId)
		if (!required.ok) return queueMutationResponse(required)
		return json(required.item)
	}
	writeQueue(queue)
	return json(item)
}

function handleDeleteQueueItem(readQueue: ReadTaskQueue, writeQueue: WriteTaskQueue, itemId: string): Response {
	const result = cancelWaitingItem(readQueue(), itemId, new Date().toISOString())
	if (!result.ok) return queueMutationResponse(result)
	writeQueue(result.queue)
	return json(result.item)
}

// The queue-native resume: the answer moves the needs_input item to the front of the waiting list and the tick dispatches it as a continuation of the parked run.
async function handleAnswerQueueItem(readQueue: ReadTaskQueue, writeQueue: WriteTaskQueue, tickScheduler: () => Promise<void>, itemId: string, body: unknown): Promise<Response> {
	if (!isObject(body)) return json({ ok: false, error: 'invalid_body' }, 400)
	const answerValue = body['answer']
	if (typeof answerValue !== 'string') return json({ ok: false, error: 'invalid_body' }, 400)
	const result = recordAnswer(readQueue(), itemId, answerValue)
	if (!result.ok) return queueMutationResponse(result)
	writeQueue(result.queue)
	await tickScheduler()
	return json(result.item)
}

async function handleRequeueQueueItem(readQueue: ReadTaskQueue, writeQueue: WriteTaskQueue, tickScheduler: () => Promise<void>, itemId: string): Promise<Response> {
	const result = requeueErrorItem(readQueue(), itemId)
	if (!result.ok) return queueMutationResponse(result)
	writeQueue(result.queue)
	await tickScheduler()
	return json(result.item)
}

// The PATCH position is a 0-based index into the waiting list (out-of-range values clamp server-side), so it must be a real JSON number — a numeric string or a fraction is a malformed body, not a position.
function isQueuePosition(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value)
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
	const readRunListSummary = config.readRunListSummary
	const readRunPlanById = config.readRunPlanById
	const readRunSnapshotStats = config.readRunSnapshotStats
	const listRunIds = config.listRunIds
	const readProjectSettings = config.readProjectSettings
	const writeProjectSettings = config.writeProjectSettings
	const readQueue = config.readQueue
	const writeQueue = config.writeQueue
	const tickScheduler = config.tickScheduler

	return async (request) => {
		const url = new URL(request.url)
		const { pathname } = url

		if (request.method === 'GET') {
			if (pathname === '/api/config') return json(renderConfig(guildConfig, deployment, config.tools, config.build))
			if (pathname === '/api/queue') return handleGetQueue(readQueue)
			if (pathname === '/api/settings') return handleGetSettings(readProjectSettings)
			if (pathname === '/api/run/flow') return handleActiveRunFlow(readRunSnapshot, readRunSnapshotStats, runSubmission, url.searchParams)
			if (pathname === '/api/run') return handleActiveRun(readRunSnapshot, readRunSnapshotStats, readRunPlanById, runSubmission, runState)
			if (pathname === '/api/runs') return handleListRuns(readRunListSummary, listRunIds)
			if (pathname.startsWith('/api/runs/')) {
				const rest = decodePathSegment(pathname.slice('/api/runs/'.length))
				if (rest === undefined) return json({ ok: false, error: 'not_found' }, 404)
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
				return handleGetRunById(readRunSnapshot, readRunSnapshotStats, readRunPlanById, runSubmission, runState, rest)
			}
			if (pathname === '/api/questions') return json(renderPendingQuestions(runState.pendingQuestions()))
			if (pathname === '/api/demo/scenarios') return handleDemoScenarios()
			if (pathname.startsWith('/api/demo/flow/')) {
				const rest = decodePathSegment(pathname.slice('/api/demo/flow/'.length))
				if (rest === undefined) return json({ ok: false, error: 'not_found' }, 404)
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
				return handleCreateRun(runSubmission, readRunMetaById, readQueue, writeQueue, tickScheduler, body)
			}
			if (pathname === '/api/queue') {
				const body = await readJsonBody(request)
				if (body === undefined) return json({ ok: false, error: 'invalid_body' }, 400)
				return handleEnqueueTask(readQueue, writeQueue, tickScheduler, body)
			}
			if (pathname.startsWith('/api/queue/')) {
				const rest = decodePathSegment(pathname.slice('/api/queue/'.length))
				if (rest !== undefined && rest.endsWith('/answer')) {
					const itemId = rest.slice(0, rest.length - '/answer'.length)
					if (itemId !== '' && !itemId.includes('/')) {
						const body = await readJsonBody(request)
						if (body === undefined) return json({ ok: false, error: 'invalid_body' }, 400)
						return handleAnswerQueueItem(readQueue, writeQueue, tickScheduler, itemId, body)
					}
				}
				if (rest !== undefined && rest.endsWith('/requeue')) {
					const itemId = rest.slice(0, rest.length - '/requeue'.length)
					if (itemId !== '' && !itemId.includes('/')) return handleRequeueQueueItem(readQueue, writeQueue, tickScheduler, itemId)
				}
			}
			if (pathname.startsWith('/api/runs/') && pathname.endsWith('/interrupt')) {
				const runId = decodePathSegment(pathname.slice('/api/runs/'.length, pathname.length - '/interrupt'.length))
				if (runId === undefined || runId === '' || runId.includes('/')) return json({ ok: false, error: 'not_found' }, 404)
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

		if (request.method === 'PATCH') {
			if (pathname.startsWith('/api/queue/')) {
				const itemId = decodePathSegment(pathname.slice('/api/queue/'.length))
				if (itemId === undefined || itemId === '' || itemId.includes('/')) return json({ ok: false, error: 'not_found' }, 404)
				const body = await readJsonBody(request)
				if (body === undefined) return json({ ok: false, error: 'invalid_body' }, 400)
				return handlePatchQueueItem(readQueue, writeQueue, itemId, body)
			}
		}

		if (request.method === 'DELETE') {
			if (pathname.startsWith('/api/queue/')) {
				const itemId = decodePathSegment(pathname.slice('/api/queue/'.length))
				if (itemId === undefined || itemId === '' || itemId.includes('/')) return json({ ok: false, error: 'not_found' }, 404)
				return handleDeleteQueueItem(readQueue, writeQueue, itemId)
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
