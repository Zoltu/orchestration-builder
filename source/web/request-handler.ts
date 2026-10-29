import type { ListRunIds, ProjectSettings, ReadProjectSettings, ReadRunMetaById, ReadRunPlanById, ReadRunSnapshotStats, RunCheckpointExists, WriteProjectSettings } from '../executor/persistence.js'
import type { HealthView } from '../executor/index.js'
import { isRunIdShape } from '../executor/run-id.js'
import type { DeploymentConfig, EffortLevel, GuildConfig, InvolvementLevel, LogLevel, ToolManifest } from '../executor/types.js'
import { isEffortLevel, isInvolvementLevel, isLogLevel, isObject, isTerminalRunStatus } from '../executor/validation.js'
import type { QueueMutationOutcome, TaskQueueModule } from '../executor/queue/index.js'
import type { RunState } from '../executor/run-state.js'
import type { ResumeErroredOrSuspendedRun, RunSubmission } from '../executor/run-submission.js'
import { formatLogAsText, formatLogDetailSections } from '../run-log/format/index.js'
import { filterLogEventsForInstance, foldLlmCallSent, paginateLogEvents } from '../run-log/window/index.js'
import { parseRunMeta } from '../run-log/index.js'
import { renderConfig, renderProjectSettings, renderPendingQuestions, renderRunView } from './render.js'
import type { BuildInfo } from './build-info.js'
import type { ReadRunListSummary } from './run-list-cache.js'
import { deriveInteractionModel, deriveInteractionOperationDetail } from './interaction-model-adapter.js'
import type { FlowFeedResponder } from './static/ts/flow-feed/index.js'
import type { RunListFeedResponder } from './static/ts/run-list-feed/index.js'
import { DEMO_SCENARIOS, deriveDemoFrameModel, deriveDemoFrameOperationDetail, findDemoScenario } from './demo-fixtures.js'
import type { ReadRunSnapshot } from './snapshot-cache.js'
import { deriveVersion, type VersionToken } from './version.js'
import { buildFlowModel, buildFlowOperationDetail, buildRunView, gatherFlowInputs, gatherRunViewInputs, MAX_LOG_LINES } from './versioned-views.js'
import type { TaskThreadResponse, TaskThreadSummarySnapshot } from '../task-thread/index.js'

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
	readRunPlanById: ReadRunPlanById
	readRunSnapshotStats: ReadRunSnapshotStats
	readTaskThread: (runId: string) => TaskThreadResponse | null
	requestTaskThreadSummary: (runId: string) => TaskThreadSummarySnapshot
	listRunIds: ListRunIds
	readProjectSettings: ReadProjectSettings
	writeProjectSettings: WriteProjectSettings
	// The durable task queue module (docs/queueing.md "The queue: storage, item model, state machine"): every /api/queue mutation and the POST /api/runs dispatch go through its contract, so the scheduler's crash-safety ordering is never bypassed by a handler.
	taskQueue: TaskQueueModule
	// The explicit resume of an error-ended or suspended run (docs/queueing.md "Resume of an errored or suspended run"), composed in serve.ts over the submission layer and the run/checkpoint/queue leaves.
	resumeErroredOrSuspendedRun: ResumeErroredOrSuspendedRun
	// The bare existence check behind the run view's resumable flag: one stat per run-view request.
	runCheckpointExists: RunCheckpointExists
	// The baked image build identifier, read once at startup (null without a baked build-info); surfaced through GET /api/config.
	build: BuildInfo | null
	// The coarse provider health reader for GET /api/health. It is a plain function over the gate, never the gate itself, and carries no endpoint, credential, model, header, request, or provider body.
	readHealth: () => HealthView
	// The flow endpoint's entity-diff responder: a per-run server replica (see flow-feed) answers the base flow route with `unchanged`/`delta`/`snapshot` instead of re-sending the whole model each poll.
	flowFeedResponder: FlowFeedResponder
	// The run-list endpoint's entity-diff responder: a single server replica (see run-list-feed) answers GET /api/runs with `unchanged`/`delta`/`snapshot` instead of re-sending the whole list each poll.
	runListFeedResponder: RunListFeedResponder
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

// The If-None-Match value a client echoes back may carry the W/ weakness prefix and surrounding quotes; both are stripped and the remaining token is compared exactly (a fixed-size hex digest makes any range or prefix interpretation wrong).
function ifNoneMatchToken(request: Request): string | null {
	const header = request.headers.get('if-none-match')
	if (header === null) return null
	const trimmed = header.trim()
	const withoutWeakness = trimmed.startsWith('W/') ? trimmed.slice(2) : trimmed
	if (withoutWeakness.startsWith('"') && withoutWeakness.endsWith('"') && withoutWeakness.length >= 2) return withoutWeakness.slice(1, -1)
	return withoutWeakness
}

// A 304 carries no body; the ETag is echoed so the client can revalidate again, and no-store keeps the browser from heuristically caching the JSON it is revalidating.
function notModified(version: VersionToken): Response {
	return new Response(null, { status: 304, headers: { etag: `"${version}"`, 'cache-control': 'no-store' } })
}

function jsonVersioned(payload: unknown, version: VersionToken): Response {
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { 'content-type': 'application/json; charset=utf-8', etag: `"${version}"`, 'cache-control': 'no-store' },
	})
}

// The base flow envelope is uncacheable but unversioned: it carries no ETag (the envelope's own `unchanged` reply is the revalidation), yet the browser must not heuristically cache the polled JSON, so it sends the same no-store the versioned JSON does.
function jsonNoStore(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
	})
}

function handleActiveRun(readRunSnapshot: ReadRunSnapshot, readRunSnapshotStats: ReadRunSnapshotStats, readRunPlanById: ReadRunPlanById, runCheckpointExists: RunCheckpointExists, readHealth: () => HealthView, runSubmission: RunSubmission, runState: RunState): Response {
	const runId = runSubmission.lastRunId()
	if (runId === undefined) return json({ ok: false, error: 'no_run' }, 404)
	const view = runViewFor(readRunSnapshot, readRunSnapshotStats, readRunPlanById, runCheckpointExists, readHealth, runId)
	if (view === null) return json({ ok: false, error: 'not_found' }, 404)
	return json({ ...view, interruptPending: runState.interruptPending() })
}

function handleActiveRunFlow(readRunSnapshot: ReadRunSnapshot, readRunSnapshotStats: ReadRunSnapshotStats, flowFeedResponder: FlowFeedResponder, runSubmission: RunSubmission, query: URLSearchParams): Response {
	const runId = runSubmission.lastRunId()
	if (runId === undefined) return json({ ok: false, error: 'no_run' }, 404)
	return runFlowPage(readRunSnapshot, readRunSnapshotStats, flowFeedResponder, runId, query)
}

function handleGetRunByIdVersioned(request: Request, runId: string, dependencies: {
	readRunSnapshotStats: ReadRunSnapshotStats
	readRunPlanById: ReadRunPlanById
	runCheckpointExists: RunCheckpointExists
	runState: RunState
	activeRunId: () => string | undefined
	readRunSnapshot: ReadRunSnapshot
	readHealth: () => HealthView
}): Response {
	const inputs = gatherRunViewInputs(dependencies, runId)
	if (inputs === null) return json({ ok: false, error: 'not_found' }, 404)
	const version = deriveVersion(inputs)
	if (ifNoneMatchToken(request) === version) return notModified(version)
	return jsonVersioned(buildRunView(inputs, dependencies), version)
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
	// ?instance=<roleId> scopes the window to one agent instance (the inspector modal's per-instance transcript): the filter keeps the instance's turns, its own lifecycle, and its ancestors' lifecycle (see filterLogEventsForInstance), and the offset/limit window then pages the FILTERED sequence — so `total` is the filtered count while every row keeps its log-wide `index` (the identity the client stitches pages and addresses detail links by). An absent or empty instance serves the unfiltered window; an id that names nothing yields an empty 200 rather than a 404, so a stale client scope renders an empty transcript instead of an error. `?detail=` and `?format=text` ignore the filter on purpose: detail is addressed by log-global index (its fold needs the full log's slice chain) and the text export is run-wide.
	const instanceParam = query.get('instance')
	if (instanceParam !== null && instanceParam !== '') {
		const filtered = filterLogEventsForInstance(events, instanceParam)
		const filteredPage = offset >= filtered.length ? [] : filtered.slice(offset, offset + limit)
		return json({ runId, total: filtered.length, offset, limit, events: filteredPage.map((entry) => ({ index: entry.index, timestamp: entry.event.timestamp, type: entry.event.type, payload: entry.event.payload })) })
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

// The thread routes resolve a path id to a run directory, so they require the canonical run-id shape before any reader or writer sees it; an encoded slash or traversal decoding to a non-run-id 404s.
function isSafeThreadRunId(value: string | undefined): value is string {
	return value !== undefined && isRunIdShape(value)
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
// The base route ships an entity-diff frame (unchanged/delta/snapshot) keyed off the client's `have` revision, so a steady poll transfers only the changed entities; an absent or unknown `have` yields a snapshot. The frame replaces the base route's ETag/304.
// ?operation=<id> serves that single operation's details markdown instead of the whole model: the derive is the same O(N) walk, but only one detail string is formatted and shipped, so a hover costs a tiny response while the polled model carries none. `operation` wins over `have`; the two are mutually exclusive.
function runFlowPage(readRunSnapshot: ReadRunSnapshot, readRunSnapshotStats: ReadRunSnapshotStats, flowFeedResponder: FlowFeedResponder, runId: string, query: URLSearchParams): Response {
	if (!isKnownRun(readRunSnapshotStats, runId)) return json({ ok: false, error: 'not_found' }, 404)
	const snapshot = readRunSnapshot(runId)
	const operationId = query.get('operation')
	if (operationId !== null) {
		const detail = deriveInteractionOperationDetail(snapshot, operationId)
		if (detail === null) return json({ ok: false, error: 'not_found' }, 404)
		return json(detail)
	}
	return jsonNoStore(flowFeedResponder(runId, deriveInteractionModel(snapshot), query.get('have')))
}

function handleGetRunFlowVersioned(request: Request, runId: string, query: URLSearchParams, dependencies: {
	readRunSnapshotStats: ReadRunSnapshotStats
	readRunSnapshot: ReadRunSnapshot
	flowFeedResponder: FlowFeedResponder
}): Response {
	// The operation discriminator is folded into the version inputs, so each operation detail derives its own token and the match check below is safe before the operation is resolved: a token for a detail that was never served (a nonexistent id) is never issued.
	const operationId = query.get('operation')
	const inputs = gatherFlowInputs(dependencies, runId, operationId)
	if (inputs === null) return json({ ok: false, error: 'not_found' }, 404)
	if (inputs.operationId !== null) {
		const version = deriveVersion(inputs)
		if (ifNoneMatchToken(request) === version) return notModified(version)
		const detail = buildFlowOperationDetail(inputs, dependencies)
		if (detail === null) return json({ ok: false, error: 'not_found' }, 404)
		return jsonVersioned(detail, version)
	}
	// The base route is unconditional: the entity-diff frame's own `unchanged` response is the revalidation, so no ETag or 304 is involved, but the polled JSON still must not be heuristically cached.
	return jsonNoStore(dependencies.flowFeedResponder(runId, buildFlowModel(inputs, dependencies), query.get('have')))
}

function runViewFor(readRunSnapshot: ReadRunSnapshot, readRunSnapshotStats: ReadRunSnapshotStats, readRunPlanById: ReadRunPlanById, runCheckpointExists: RunCheckpointExists, readHealth: () => HealthView, runId: string): ReturnType<typeof renderRunView> | null {
	if (!isKnownRun(readRunSnapshotStats, runId)) return null
	const snapshot = readRunSnapshot(runId)
	// The plan is read per request rather than riding the snapshot cache: it is a separate document the run may gain mid-flight, and the file is small enough that re-reading is free.
	return renderRunView(snapshot, { maxLogLines: MAX_LOG_LINES, plan: readRunPlanById(runId), checkpointExists: runCheckpointExists(runId), providerHealth: readHealth() })
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

function handleGetTaskThread(runId: string, readTaskThread: (runId: string) => TaskThreadResponse | null): Response {
	const thread = readTaskThread(runId)
	if (thread === null) return jsonNoStore({ ok: false, error: 'not_found' }, 404)
	return jsonNoStore(thread)
}

function handleRequestTaskThreadSummary(readRunSnapshotStats: ReadRunSnapshotStats, requestTaskThreadSummary: (runId: string) => TaskThreadSummarySnapshot, runId: string): Response {
	if (!isKnownRun(readRunSnapshotStats, runId)) return jsonNoStore({ ok: false, error: 'not_found' }, 404)
	const summary = requestTaskThreadSummary(runId)
	return jsonNoStore(summary, 202)
}

// GET /api/runs ships an entity-diff frame keyed off the client's `have` revision instead of the whole list with an ETag: a steady poll transfers only the changed runs. The responder owns the newest-first collection order; entity-diff treats collections as unordered and the client sorts on apply regardless.
function handleListRuns(query: URLSearchParams, dependencies: {
	listRunIds: ListRunIds
	readRunListSummary: ReadRunListSummary
	runListFeedResponder: RunListFeedResponder
	readHealth: () => HealthView
}): Response {
	const summaries = dependencies.listRunIds().map((runId) => dependencies.readRunListSummary(runId))
	return jsonNoStore(dependencies.runListFeedResponder(summaries, dependencies.readHealth(), query.get('have')))
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

// POST /api/runs keeps today's external contract exactly (docs/queueing.md "HTTP API") while every run becomes queue-tracked: the validated task is enqueued at the head of the durable queue and the scheduler — the only caller of submission — dispatches it within the same request when the slot is free, so the response is still 201 { runId }. The request's effort, involvement, logLevel, and continuesFrom are recorded on the item and thread into the dispatched run. When a run is in flight or suspended the request is refused with nothing enqueued, exactly today's 409.
async function handleCreateRun(taskQueue: TaskQueueModule, readRunMetaById: ReadRunMetaById, body: unknown): Promise<Response> {
	if (!isObject(body)) return json({ ok: false, error: 'invalid_body' }, 400)
	const continuesFromValue = body['continuesFrom']
	if (continuesFromValue !== undefined && !isRunIdShape(continuesFromValue)) return json({ ok: false, error: 'invalid_body' }, 400)
	const priorMeta = continuesFromValue === undefined ? null : parseRunMeta(readRunMetaById(continuesFromValue))
	if (continuesFromValue !== undefined && (priorMeta === null || !isTerminalRunStatus(priorMeta.status))) return json({ ok: false, error: 'invalid_body' }, 400)
	// A continuation may omit task text — the run re-runs the prior task, so the prior run's own task text stands in as the effective task (the scheduler's continuation carries it as RunContinuation.task either way). A fresh submission still requires text.
	const taskValue = body['task']
	// A present-but-non-string task is malformed even for a continuation, which may omit the task or pass an empty one but never a non-string — silently discarding what the caller sent would dispatch a different task than the request named.
	if (taskValue !== undefined && typeof taskValue !== 'string') return json({ ok: false, error: 'invalid_body' }, 400)
	if ((taskValue === undefined || taskValue === '') && priorMeta === null) return json({ ok: false, error: 'invalid_body' }, 400)
	const task = typeof taskValue === 'string' && taskValue !== '' ? taskValue : (priorMeta?.task ?? '')
	const effortValue = body['effort']
	if (effortValue !== undefined && !isEffortLevel(effortValue)) return json({ ok: false, error: 'invalid_body' }, 400)
	const effortOverride: EffortLevel | undefined = effortValue
	const involvementValue = body['involvement']
	if (involvementValue !== undefined && !isInvolvementLevel(involvementValue)) return json({ ok: false, error: 'invalid_body' }, 400)
	const involvementOverride: InvolvementLevel | undefined = involvementValue
	const logLevelValue = body['logLevel']
	if (logLevelValue !== undefined && !isLogLevel(logLevelValue)) return json({ ok: false, error: 'invalid_body' }, 400)
	const logLevelOverride: LogLevel | undefined = logLevelValue
	const result = await taskQueue.submitNow(
		{ task, ...(effortOverride !== undefined ? { effort: effortOverride } : {}), ...(involvementOverride !== undefined ? { involvement: involvementOverride } : {}), ...(logLevelOverride !== undefined ? { logLevel: logLevelOverride } : {}), ...(continuesFromValue !== undefined ? { continuesFrom: continuesFromValue } : {}) },
		{ id: crypto.randomUUID(), queuedAt: new Date().toISOString() },
	)
	if (result.kind === 'invalid') return json({ ok: false, error: 'invalid_body' }, 400)
	if (result.kind === 'busy') return json({ ok: false, error: 'run_in_progress' }, 409)
	if (result.kind === 'run_suspended') return json({ ok: false, error: 'run_suspended' }, 409)
	if (result.kind === 'provider_unavailable') return json({ ok: false, error: 'provider_unavailable' }, 409)
	if (result.kind === 'collision') return json({ ok: false, error: 'run_id_collision' }, 409)
	return json({ runId: result.runId }, 201)
}

// POST /api/runs/:id/resume carries an optional note, so unlike the other POST bodies an absent body is valid: an empty request body (no JSON at all) means "no note", while a present but unparseable body is malformed. A JSON null body reads as absent too.
async function parseResumeBody(request: Request): Promise<{ ok: true; note?: string } | { ok: false }> {
	const text = await request.text()
	if (text.trim() === '') return { ok: true }
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return { ok: false }
	}
	if (parsed === null) return { ok: true }
	if (!isObject(parsed)) return { ok: false }
	const noteValue = parsed['note']
	if (noteValue === undefined || noteValue === null || noteValue === '') return { ok: true }
	if (typeof noteValue !== 'string') return { ok: false }
	return { ok: true, note: noteValue }
}

// The explicit resume of an error-ended or suspended run: same-run-id continuation from the kept checkpoint (docs/queueing.md "Resume of an errored or suspended run" and the suspended resume). Status codes follow the API's conventions — an unknown run is 404, a state conflict (wrong status, no checkpoint, run in flight) is 409 — and the checkpoint-missing conflict names the briefed-continuation alternative, which stays the fallback for runs without a checkpoint.
function handleResumeErroredOrSuspendedRun(resumeErroredOrSuspendedRun: ResumeErroredOrSuspendedRun, runId: string, note: string | undefined): Response {
	const result = resumeErroredOrSuspendedRun(runId, note)
	if (result.ok) return json({ runId: result.runId }, 201)
	if (result.error === 'run_not_found') return json({ ok: false, error: 'not_found' }, 404)
	if (result.error === 'run_in_progress') return json({ ok: false, error: 'run_in_progress' }, 409)
	if (result.error === 'run_suspended') return json({ ok: false, error: 'run_suspended' }, 409)
	if (result.error === 'checkpoint_missing') return json({ ok: false, error: 'checkpoint_missing', message: 'This run has no resumable checkpoint. Continue it as a new run instead: POST /api/runs with "continuesFrom" set to this run id.' }, 409)
	return json({ ok: false, error: 'run_not_resumable' }, 409)
}

// --- /api/queue (docs/queueing.md "HTTP API") --------------------------------

// Maps a by-id queue transformation's refusal to the shared error semantics: an unknown id is 404, a status-forbidden operation is 409.
function queueMutationResponse(result: QueueMutationOutcome): Response {
	if (result.ok) return json(result.item)
	if (result.reason === 'not_found') return json({ ok: false, error: 'not_found' }, 404)
	return json({ ok: false, error: 'status_forbidden' }, 409)
}

function handleGetQueue(taskQueue: TaskQueueModule): Response {
	return json(taskQueue.read().items)
}

// POST /api/queue always enqueues at the tail — never 409 — and ticks the scheduler, so an idle system dispatches the new task within the same request. Only task, effort, and involvement are read from the body: a queue-native item's logLevel resolves through the standard chain at dispatch (docs/queueing.md "The queue: storage, item model, state machine"), and other fields are lineage or outcome bookkeeping the platform owns.
async function handleEnqueueTask(taskQueue: TaskQueueModule, body: unknown): Promise<Response> {
	if (!isObject(body)) return json({ ok: false, error: 'invalid_body' }, 400)
	const result = await taskQueue.enqueue({ task: body['task'], effort: body['effort'], involvement: body['involvement'] }, { id: crypto.randomUUID(), queuedAt: new Date().toISOString() }, 'tail')
	if (!result.ok) return json({ ok: false, error: 'invalid_body' }, 400)
	return json(result.item, 201)
}

// PATCH edits task/effort/involvement and/or moves the item to a clamped 0-based position in the waiting list; waiting items only.
function handlePatchQueueItem(taskQueue: TaskQueueModule, itemId: string, body: unknown): Response {
	if (!isObject(body)) return json({ ok: false, error: 'invalid_body' }, 400)
	const taskValue = body['task']
	if (taskValue !== undefined && (typeof taskValue !== 'string' || taskValue === '')) return json({ ok: false, error: 'invalid_body' }, 400)
	const task: string | undefined = taskValue
	const effortValue = body['effort']
	if (effortValue !== undefined && !isEffortLevel(effortValue)) return json({ ok: false, error: 'invalid_body' }, 400)
	const effort: EffortLevel | undefined = effortValue
	const involvementValue = body['involvement']
	if (involvementValue !== undefined && !isInvolvementLevel(involvementValue)) return json({ ok: false, error: 'invalid_body' }, 400)
	const involvement: InvolvementLevel | undefined = involvementValue
	const positionValue = body['position']
	if (positionValue !== undefined && !isQueuePosition(positionValue)) return json({ ok: false, error: 'invalid_body' }, 400)
	const position: number | undefined = positionValue
	const result = taskQueue.patch(itemId, {
		...(task !== undefined ? { task } : {}),
		...(effort !== undefined ? { effort } : {}),
		...(involvement !== undefined ? { involvement } : {}),
		...(position !== undefined ? { position } : {}),
	})
	return queueMutationResponse(result)
}

function handleDeleteQueueItem(taskQueue: TaskQueueModule, itemId: string): Response {
	return queueMutationResponse(taskQueue.cancel(itemId, new Date().toISOString()))
}

// The operator's termination of a parked or suspended task: cancels the needs_input or suspended item and terminalizes its run with the checkpoint removed, so neither the queue nor a stale answer or resume can re-enter it. No body is read.
async function handleTerminateQueueItem(taskQueue: TaskQueueModule, itemId: string): Promise<Response> {
	return queueMutationResponse(await taskQueue.terminate(itemId, new Date().toISOString()))
}

// The run-level termination for a suspended run: addresses the run rather than a queue item, so a pause whose item was lost can still be ended. Status gating is the run meta's: unknown is 404, an active run is 409 run_in_progress, and any status other than suspended is 409 run_not_suspended. The queue half cancels a suspended item if one exists and ticks after the pause is released.
async function handleTerminateSuspendedRun(taskQueue: TaskQueueModule, runSubmission: RunSubmission, readRunMetaById: ReadRunMetaById, runId: string): Promise<Response> {
	if (runSubmission.activeRunId() !== undefined) return json({ ok: false, error: 'run_in_progress' }, 409)
	const meta = parseRunMeta(readRunMetaById(runId))
	if (meta === null) return json({ ok: false, error: 'not_found' }, 404)
	if (meta.status === 'running') return json({ ok: false, error: 'run_in_progress' }, 409)
	if (meta.status !== 'suspended') return json({ ok: false, error: 'run_not_suspended' }, 409)
	const result = await taskQueue.terminateSuspendedRun(runId, new Date().toISOString())
	if (result.ok) return json({ runId: result.runId }, 200)
	if (result.error === 'not_found') return json({ ok: false, error: 'not_found' }, 404)
	return json({ ok: false, error: 'run_not_suspended' }, 409)
}

// The queue-native resume: the answer moves the needs_input item to the front of the waiting list and the tick resumes the same parked run, delivering the answer as its ask_human tool result. When the parked checkpoint is missing, the answer falls back to the briefed continuation this route has always dispatched.
async function handleAnswerQueueItem(taskQueue: TaskQueueModule, itemId: string, body: unknown): Promise<Response> {
	if (!isObject(body)) return json({ ok: false, error: 'invalid_body' }, 400)
	const answerValue = body['answer']
	if (typeof answerValue !== 'string') return json({ ok: false, error: 'invalid_body' }, 400)
	return queueMutationResponse(await taskQueue.answer(itemId, answerValue))
}

async function handleRequeueQueueItem(taskQueue: TaskQueueModule, itemId: string): Promise<Response> {
	return queueMutationResponse(await taskQueue.requeue(itemId))
}

// The PATCH position is a 0-based index into the waiting list (out-of-range values clamp server-side), so it must be a real JSON number — a numeric string or a fraction is a malformed body, not a position.
function isQueuePosition(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value)
}

function handleGetSettings(readProjectSettings: ReadProjectSettings): Response {
	return json(renderProjectSettings(readProjectSettings()))
}

// The write replaces settings.json wholesale, so the body is the complete new settings: effort is required (the field the compose screen always has a value for), and the optional involvement and logLevel are cleared when absent — the client always sends all three so saving one never clears the others.
function handlePutSettings(writeProjectSettings: WriteProjectSettings, body: unknown): Response {
	if (!isObject(body)) return json({ ok: false, error: 'invalid_body' }, 400)
	const effortValue = body['effort']
	if (!isEffortLevel(effortValue)) return json({ ok: false, error: 'invalid_body' }, 400)
	const involvementValue = body['involvement']
	if (involvementValue !== undefined && !isInvolvementLevel(involvementValue)) return json({ ok: false, error: 'invalid_body' }, 400)
	const logLevelValue = body['logLevel']
	if (logLevelValue !== undefined && !isLogLevel(logLevelValue)) return json({ ok: false, error: 'invalid_body' }, 400)
	const settings: ProjectSettings = { effort: effortValue, ...(involvementValue !== undefined ? { involvement: involvementValue } : {}), ...(logLevelValue !== undefined ? { logLevel: logLevelValue } : {}) }
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
	const readTaskThread = config.readTaskThread
	const requestTaskThreadSummary = config.requestTaskThreadSummary
	const listRunIds = config.listRunIds
	const readProjectSettings = config.readProjectSettings
	const writeProjectSettings = config.writeProjectSettings
	const taskQueue = config.taskQueue
	const resumeErroredOrSuspendedRun = config.resumeErroredOrSuspendedRun
	const runCheckpointExists = config.runCheckpointExists
	const flowFeedResponder = config.flowFeedResponder
	const runListFeedResponder = config.runListFeedResponder
	const readHealth = config.readHealth

	// The leaf set the two versioned poll endpoints share; each named handler accepts the subset it directly uses, so the superset is assignable structurally.
	const versionedDependencies = {
		readRunSnapshot,
		readRunSnapshotStats,
		readRunPlanById,
		runCheckpointExists,
		runState,
		activeRunId: runSubmission.activeRunId,
		flowFeedResponder,
		readHealth,
	}

	// The run list's leaves: unlike the versioned endpoints it derives no version token server-side (the feed's revision is the revalidation), so it needs only the run-id listing, the summary reader, and its responder.
	const runListDependencies = {
		listRunIds,
		readRunListSummary,
		runListFeedResponder,
		readHealth,
	}

	return async (request) => {
		const url = new URL(request.url)
		const { pathname } = url

		if (request.method === 'GET') {
			if (pathname === '/api/config') return json(renderConfig(guildConfig, deployment, config.tools, config.build))
			if (pathname === '/api/health') return jsonNoStore(readHealth())
			if (pathname === '/api/queue') return handleGetQueue(taskQueue)
			if (pathname === '/api/settings') return handleGetSettings(readProjectSettings)
			if (pathname === '/api/run/flow') return handleActiveRunFlow(readRunSnapshot, readRunSnapshotStats, flowFeedResponder, runSubmission, url.searchParams)
			if (pathname === '/api/run') return handleActiveRun(readRunSnapshot, readRunSnapshotStats, readRunPlanById, runCheckpointExists, readHealth, runSubmission, runState)
			if (pathname === '/api/runs') return handleListRuns(url.searchParams, runListDependencies)
			if (pathname.startsWith('/api/runs/')) {
				const rest = decodePathSegment(pathname.slice('/api/runs/'.length))
				if (rest === undefined) {
					if (pathname.endsWith('/thread') || pathname.endsWith('/thread/summary')) return jsonNoStore({ ok: false, error: 'not_found' }, 404)
					return json({ ok: false, error: 'not_found' }, 404)
				}
				// Match /log, /flow, or /thread before the bare :id route so they reach their endpoints rather than being swallowed as a run id of "<id>/log", "<id>/flow", or "<id>/thread".
				const slashIndex = rest.lastIndexOf('/')
				if (slashIndex >= 0) {
					const suffix = rest.slice(slashIndex + 1)
					const runId = rest.slice(0, slashIndex)
					if (runId !== '') {
						if (suffix === 'log') return runLogPage(readRunSnapshot, readRunSnapshotStats, runId, url.searchParams)
						if (suffix === 'flow') return handleGetRunFlowVersioned(request, runId, url.searchParams, versionedDependencies)
						if (suffix === 'thread') {
							if (!isSafeThreadRunId(runId)) return jsonNoStore({ ok: false, error: 'not_found' }, 404)
							return handleGetTaskThread(runId, readTaskThread)
						}
					}
				}
				return handleGetRunByIdVersioned(request, rest, versionedDependencies)
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
				return handleCreateRun(taskQueue, readRunMetaById, body)
			}
			if (pathname === '/api/queue') {
				const body = await readJsonBody(request)
				if (body === undefined) return json({ ok: false, error: 'invalid_body' }, 400)
				return handleEnqueueTask(taskQueue, body)
			}
			if (pathname.startsWith('/api/queue/')) {
				const rest = decodePathSegment(pathname.slice('/api/queue/'.length))
				if (rest !== undefined && rest.endsWith('/answer')) {
					const itemId = rest.slice(0, rest.length - '/answer'.length)
					if (itemId !== '' && !itemId.includes('/')) {
						const body = await readJsonBody(request)
						if (body === undefined) return json({ ok: false, error: 'invalid_body' }, 400)
						return handleAnswerQueueItem(taskQueue, itemId, body)
					}
				}
				if (rest !== undefined && rest.endsWith('/requeue')) {
					const itemId = rest.slice(0, rest.length - '/requeue'.length)
					if (itemId !== '' && !itemId.includes('/')) return handleRequeueQueueItem(taskQueue, itemId)
				}
				if (rest !== undefined && rest.endsWith('/terminate')) {
					const itemId = rest.slice(0, rest.length - '/terminate'.length)
					if (itemId !== '' && !itemId.includes('/')) return handleTerminateQueueItem(taskQueue, itemId)
				}
			}
			if (pathname.startsWith('/api/runs/') && pathname.endsWith('/thread/summary')) {
				const runId = decodePathSegment(pathname.slice('/api/runs/'.length, pathname.length - '/thread/summary'.length))
				if (!isSafeThreadRunId(runId)) return jsonNoStore({ ok: false, error: 'not_found' }, 404)
				return handleRequestTaskThreadSummary(readRunSnapshotStats, requestTaskThreadSummary, runId)
			}
			if (pathname.startsWith('/api/runs/') && pathname.endsWith('/interrupt')) {
				const runId = decodePathSegment(pathname.slice('/api/runs/'.length, pathname.length - '/interrupt'.length))
				if (runId === undefined || runId === '' || runId.includes('/')) return json({ ok: false, error: 'not_found' }, 404)
				const body = await readJsonBody(request)
				if (body === undefined) return json({ ok: false, error: 'invalid_body' }, 400)
				return handleInterrupt(runState, runSubmission, runId, body)
			}
			if (pathname.startsWith('/api/runs/') && pathname.endsWith('/resume')) {
				const runId = decodePathSegment(pathname.slice('/api/runs/'.length, pathname.length - '/resume'.length))
				// The shape guard matches continuesFrom's validation: a malformed id names no run, so it 404s immediately instead of reaching the readers.
				if (runId === undefined || runId === '' || runId.includes('/') || !isRunIdShape(runId)) return json({ ok: false, error: 'not_found' }, 404)
				const body = await parseResumeBody(request)
				if (!body.ok) return json({ ok: false, error: 'invalid_body' }, 400)
				return handleResumeErroredOrSuspendedRun(resumeErroredOrSuspendedRun, runId, body.note)
			}
			if (pathname.startsWith('/api/runs/') && pathname.endsWith('/terminate')) {
				const runId = decodePathSegment(pathname.slice('/api/runs/'.length, pathname.length - '/terminate'.length))
				if (runId === undefined || runId === '' || runId.includes('/') || !isRunIdShape(runId)) return json({ ok: false, error: 'not_found' }, 404)
				return handleTerminateSuspendedRun(taskQueue, runSubmission, readRunMetaById, runId)
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
				return handlePatchQueueItem(taskQueue, itemId, body)
			}
		}

		if (request.method === 'DELETE') {
			if (pathname.startsWith('/api/queue/')) {
				const itemId = decodePathSegment(pathname.slice('/api/queue/'.length))
				if (itemId === undefined || itemId === '' || itemId.includes('/')) return json({ ok: false, error: 'not_found' }, 404)
				return handleDeleteQueueItem(taskQueue, itemId)
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
