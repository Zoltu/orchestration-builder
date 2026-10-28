// Hyperapp client for the long-running service.
// The whole UI is one reactive view of a single state object; polling runs as subscriptions and every side effect (fetch, POST, audio, flash) runs as an effect. The model is a trusted component; its prose fields (task, result summary, question text, question context, error message) are Markdown the UI renders as formatted text via `showdown` + `highlight.js`. The residual concern is not a malicious model but prompt injection — a malicious file in the workspace coercing the model's output — so the parsed HTML is walked through the allowlist in markdown.js before reaching the DOM; this is a defense-in-depth backstop, with the primary injection defense upstream (see docs/security.md "Web client rendering pipeline"). Machine fields (tool names, operation arguments/results, timestamps, role names, run ids, the one-line current-activity summary) are interpolated only as children of h() or text-node arguments, which hyperapp places into text nodes and properties — never into markup.
import { app, h } from '../vendor/hyperapp.js'
import type { Vnode } from '../vendor/hyperapp.js'
import { createMarkdownRenderer } from './markdown-render.js'
import { createRunStage } from './run-stage/index.js'
import { createScrollFollower } from './scroll-follow.js'
import { createAnimationFrameCoalescer } from './animation-frame-coalescer.js'
import { createPollFetcher } from './poll-fetch.js'
import { createLabelResolver, isLabelTier, isRoleOrder, TIER_VALUES } from './labels.js'
import { buildInfoFromConfig, formatBuildLabel } from './build-info.js'
import { isLiveStatus, isSettledForPolling, isSuspendedStatus, isTerminalStatus, secondsBetweenIso, withLiveElapsed } from './interaction-model.js'
import { planSameRunView } from './run-selection.js'
import { deriveFaviconState, faviconHref } from './favicon.js'
import { createTooltipDismiss, deriveTooltipDescriptor, isInFlightAskHuman, resolveInspectorScope, resolveTooltipTarget } from './inspector.js'
import { operationIdsForTooltipDetails, tooltipStyle, Tooltip } from './tooltip.js'
import { copyRawToClipboard } from './clipboard.js'
import { QuestionModal } from './question-modal.js'
import { createOperationDetails } from './operation-details.js'
import { deriveTerminalResult, ResultModal, ResultPendingModal } from './result-modal.js'
import { deriveSuspendedCard, resumeFailureCopy, SuspendedCard, suspendedTerminateTarget, terminateFailureCopy } from './suspended-card.js'
import { deriveHealthBanner, HealthBanner } from './health-banner.js'
import { deriveHistoryEntries, lineageLink, queueItemLineageLink, runPrimaryLabel, runSummaryIndex } from './run-history.js'
import type { LineageLink } from './run-history.js'
import { acceptedResultView, planResultOpen, planResultRetry, planRunViewRecovery, resultOffersContinue, selectResultSource, withoutVersion } from './result-access.js'
import type { ResultLoadState } from './result-access.js'
import { ContinuationReference, selectContinuationReference } from './continuation-reference.js'
import type { ContinuationReferenceData } from './continuation-reference.js'
import { InspectorModal } from './inspector-modal.js'
import { createInspectorSession } from './turn-inspector/index.js'
import { isObject } from './guards.js'
import { applyFlowFrame, discardFlowRevision, emptyFlowFeedState, flowFeedRevision } from './flow-feed/index.js'
import { applyRunListFrame, emptyRunListFeedState, runListFeedRevision } from './run-list-feed/index.js'
import { responseBelongsToSelection } from './stale-response.js'
import { createStreamClient } from './stream-client.js'
import { nextLivePartial } from './live-partial.js'
import { LoadingIndicator } from './loading-indicator.js'
import { backlogCount, deriveReorderPosition, isQueueItemLike, matchesParkedRun, queueItemPrimaryText, queueStatusLabel, reorderWaitingItems } from './queue-panel.js'
import type { InteractionModel, Participant, RunStatus, SuspensionRecord } from './interaction-model.js'
import type { FlowFeedState } from './flow-feed/index.js'
import type { HealthView, RunListFeedState, RunResultCard, RunSummary } from './run-list-feed/index.js'
import type { LabelConfig, LabelResolver, LabelTier } from './labels.js'
import type { FetchRequest, WireFetchRequest } from './turn-inspector/index.js'
import type { LivePartial } from './live-partial.js'
import type { RunStage } from './run-stage/index.js'
import type { ElementRect, TooltipTarget } from './inspector.js'
import type { OperationDetailsState } from './operation-details.js'
import type { ScrollFollower } from './scroll-follow.js'
import type { PollKey, PollResponse } from './poll-fetch.js'
import type { QueueItemLike } from './queue-panel.js'
import type { StreamClient, StreamDeltaMessage } from './stream-client.js'
import type { BuildInfo } from './build-info.js'

// --- Application state -----------------------------------------------------
// The single state object every action threads. The wire shapes below mirror the server contracts (source/web/render.ts) but live here because the static bundle cannot import from the server modules; every field a poll fills in is re-guarded at its fetch's ingress action.

// One interrupt-history entry in a run view (`InterruptHistoryEntry` in source/run-log/derive/index.ts).
export interface InterruptInquiryEntry {
	kind: 'inquiry'
	askedAt: string
	role: string | null
	message: string
	answer: string | null
	answeredAt: string | null
	ended: boolean
}

export interface InterruptPlanModEntry {
	kind: 'plan_modification'
	askedAt: string
	message: string
	target: string | null
	targetRole: string | null
	aborted: string[]
}

export type InterruptHistoryEntry = InterruptInquiryEntry | InterruptPlanModEntry

// The full run view (GET /api/runs/:id, `renderRunView` server-side).
export interface RunView {
	status: RunStatus
	runId: string | null
	task: string | null
	// The wire carries an effort level, but the client only ever reads it through isEffort, so it stays a string here and narrows at the read sites.
	effort: string | null
	// The wire carries a human-involvement level, read through isInvolvement and narrowed at the read sites.
	involvement: string | null
	startTime: string | null
	endTime: string | null
	result: RunResultCard | null
	error?: unknown
	// Present only while the run is suspended; the pause card renders its category copy and suspendedAt, never a result card.
	suspension: SuspensionRecord | null
	// The coarse provider health snapshot carried by the run view; the banner may read it without a separate health poll.
	providerHealth: HealthView | null
	continuesFrom: string | null
	// Whether the operator can explicitly resume this errored or suspended run from its kept checkpoint (terminal error or suspended meta plus a checkpoint on disk — `resumable` in source/web/render.ts). Present on run-view endpoints only, never on run-list summaries; the modal's Resume gating consumes it through the raw-body read in deriveTerminalResult, so the typed field mirrors the contract rather than gating reads.
	resumable: boolean
	plan: string | null
	roles: RoleActivity[]
	roleTree: RoleTreeNode[] | null
	recentLog: RecentLogEntry[]
	currentActivity: CurrentActivity | null
	questionHistory: QuestionHistoryEntry[]
	interrupts: InterruptHistoryEntry[]
	// Added on top of renderRunView by the request handler (source/web/request-handler.ts): whether the run has an interrupt queued at its safe point — true only for the active run.
	interruptPending?: boolean
	budgets: RunBudgets
}

export interface RoleActivity {
	role: string
	firstSeen: string
	lastSeen: string
	eventCount: number
	llmCalls: number
	toolCalls: number
	recentTools: string[]
	lastPromptTokens: number | null
}

export interface RoleTreeNode {
	role: string
	depth: number
	parent: string | null
	status: string | null
	summary: string | null
	active: boolean
	children: RoleTreeNode[]
}

export interface RecentLogEntry {
	index: number
	timestamp: string
	type: string
	text: string
}

export interface QuestionHistoryEntry {
	id: string | null
	question: string
	context?: string
	askedAt: string
	answer?: string
	answeredAt?: string
}

export interface CurrentActivity {
	role: string | null
	summary: string
}

export interface RunBudgets {
	// The settled span the server reports for a finished run, or null while the run is still in progress; the client computes a live figure from startTime and its own clock (see resultMetaLine).
	elapsedSeconds: number | null
	toolCalls: number
	tokensUsed: number | null
	tokenBreakdown: TokenUsage | null
}

export interface TokenUsage {
	promptTokens: number
	cachedPromptTokens: number
	completionTokens: number
	totalTokens: number
}

// One pending question (GET /api/questions, `renderPendingQuestions` server-side).
export interface ApiQuestion {
	id: string
	question: string
	context?: string
	askedAt: string
}

// The one-time presentation of a newly-arrived interrupt answer.
export interface InterruptAnswerCard {
	question: string
	answer: string | null
	role: string | null
}

// The inspector card snapshot over the run view: which stamped target it anchors to and the element rect it was snapshotted at.
export interface TooltipSnapshot {
	kind: TooltipTarget['kind']
	id: string
	rect: ElementRect
}

export type EffortLevel = 'quick' | 'standard' | 'thorough'
export type InvolvementLevel = 'autonomous' | 'early-engagement' | 'collaborative'
export type LogLevel = 'full' | 'standard'
export type InterruptMode = 'inquiry' | 'plan_modification'
export type FlowViewMode = 'flow' | 'sequence'
export type Screen = 'watch' | 'history' | 'compose'

export interface ApplicationState {
	summaries: RunSummary[]
	selectedRunId: string | null
	selectedRunView: RunView | null
	selectedRunStatus: RunStatus | null
	pendingQuestions: ApiQuestion[]
	// The coarse provider health carried by the run-list feed; null until the first run-list snapshot lands. It drives the persistent banner without a second poll.
	providerHealth: HealthView | null
	// The polled task queue (docs/queueing.md "UI interaction model"), head first. The add-flow's ids: justSubmittedItemId dedups a second add once the add's response has landed, until the item shows up in the polled queue; pendingAddSelectionId is consumed once by the very next queue read to jump to the new run's watch screen when the scheduler dispatched it within the add request.
	queueItems: QueueItemLike[]
	justSubmittedItemId: string | null
	pendingAddSelectionId: string | null
	// The queue panel's row-level view state: the waiting item being inline-edited, the row being dragged, and the item whose answer or termination is posting. `openQueueQuestionId` drives the app-shell question modal a needs_input row (or the watch screen's Respond CTA) opens, so a parked run's question is answerable from the history list.
	editingItemId: string | null
	draggingItemId: string | null
	queueAnswerPendingId: string | null
	queueTerminatePendingId: string | null
	openQueueQuestionId: string | null
	// The answered item whose resume has not been dispatched yet (the answer landed while another run was active, so the item is still waiting without a runId). The periodic queue poll watches it and re-engages the watch screen once the item finally resumes.
	pendingResumeItemId: string | null
	serverAvailable: boolean
	// The ETag validators for the versioned GET endpoints, keyed by request URL. Each poll echoes the stored value as If-None-Match; a 304 leaves the already-held payload untouched. Only the run view still rides this map: the flow model and the run list are entity-diff feeds whose opaque states carry their own replica revisions.
	versions: Record<string, string>
	justSubmittedRunId: string | null
	// The create POST's in-flight flag (a plain queue add, a continuation, a new run, and a re-run each dispatch one): set synchronously when the request leaves and cleared by the create response actions on both the ok and fail paths, so a double click or a second Ctrl+Enter inside the window is a no-op instead of a duplicate. Complements the justSubmitted* ids, whose dedup starts only once a response has landed.
	createSending: boolean
	muted: boolean
	shownQuestionIds: Record<string, boolean>
	firstQuestionsPoll: boolean
	pendingAnswerId: string | null
	// null until the saved settings load; the selectors initialize from the persisted levels on first load.
	runEffort: EffortLevel | null
	savingEffort: boolean
	runInvolvement: InvolvementLevel | null
	savingInvolvement: boolean
	runLogLevel: LogLevel | null
	savingLogLevel: boolean
	// The live InteractionModel the centerpiece renders, plus its previous frame for the stage's enter/depart diff. Both null until the first readable flow frame lands. The model is reconstructed from the opaque flow feed state on every apply, which also hides the replica revision behind `flowFeedRevision`.
	flowModel: InteractionModel | null
	previousFlowModel: InteractionModel | null
	flowFeed: FlowFeedState
	// The polled run-list feed state. The summaries are reconstructed newest-first from it on every apply, which also hides the replica revision behind `runListFeedRevision`.
	runListFeed: RunListFeedState
	// Whether the first run-list and queue polls have landed; the history empty state shows a loading indicator until both have.
	runListLoaded: boolean
	queueLoaded: boolean
	// The label resolver and guild participant inventory are built once from `/api/config` (GotConfig); null/empty until that single load completes. `build` rides the same load: the image's build identifier for the top bar, and stays null when running from source without a baked build-info.json.
	labelResolver: LabelResolver | null
	guildParticipants: Participant[]
	build: BuildInfo | null
	flowTier: LabelTier
	flowViewMode: FlowViewMode
	// The sequence view's roles-only lens (see rolesOnlyModel in interaction-model.js): on by default so the sequence view opens on the delegation story, with the full traffic one toggle away.
	sequenceRolesOnly: boolean
	// The visible screen: 'watch' (the flow/sequence stage), 'history' (the merged run browser and task queue), or 'compose' (the new-task hero). A zero-state service shows compose regardless (see Main).
	screen: Screen
	// Whether the browser tab is visible; polling subscriptions are withdrawn while hidden and an immediate refresh runs on return.
	pageVisible: boolean
	// True from a visibility resume until the next flow frame lands (or the flow fetch fails): the top bar shows a refreshing pill, and the old model stays visible while the snapshot loads.
	flowRefreshPending: boolean
	// Per-row expansion for the merged history screen, keyed by run id or queue item id, so the full task/result of several rows can be open at once.
	expandedRowIds: Record<string, boolean>
	// The continuation pending on the compose screen, or null for a plain new task. Set by the History row's or result modal's Continue button; cleared by the reference block's Cancel and after a successful submit.
	continuation: ContinuationReferenceData | null
	// The errored run the compose screen is resuming, or null for a non-resume mode. Set by the result modal's Resume button (the same run restarts in place from its checkpoint, an optional note riding along); mutually exclusive with `continuation` — entering either mode clears the other. Cleared by the resume chip's Cancel and after a successful resume.
	resumingRunId: string | null
	// The resume request's in-flight flag (the submit button and the double-submit guard read it) and the one-line notice a refused or unreadable resume leaves on the compose screen. The notice clears on entry, cancel, and success.
	resumeSending: boolean
	resumeNotice: string | null
	// Per-run-view modal state. The question modal opens on a new pending question; the result modal opens on a watched run's completion. `resultShownForRun` dedups the auto-open across the polls that follow a completion. The interrupt modal opens only from the stage controls.
	questionModalOpen: boolean
	resultModalOpen: boolean
	resultShownForRun: string | null
	// The pause card is deliberately separate from the result modal: a suspended run has no terminal result. suspendedActionNotice carries the typed resume/terminate refusal for the card and the global notice strip. resumeRunPendingId is the run id whose direct (non-compose) resume is in flight, so every Resume now button disables once one is sending.
	suspendedModalOpen: boolean
	suspendedActionNotice: string | null
	resumeRunPendingId: string | null
	// The on-demand result load for the selected run: null when the modal renders a terminal descriptor, otherwise the phase of the summary fallback's full-view fetch.
	resultLoad: ResultLoadState | null
	interruptModalOpen: boolean
	// The LLM turn inspector opens only from the stage controls; its log windows and derived transcript live in the module-scope session and reset on open and on run switch.
	inspectorModalOpen: boolean
	// The plan disclosure under the stage: collapsed by default, reset with the other per-run view state on a run switch.
	planExpanded: boolean
	// The live token stream's ephemeral partial (see "Live token stream"): the in-flight reasoning/content the inspector modal renders under the matching in-flight row. Null whenever nothing is streaming or the stream is down; never an authority on run state.
	livePartial: LivePartial | null
	// The current websocket phase, so the inspector can show a reconnect indicator when live text is expected but the stream is down.
	streamConnected: boolean
	// True once any connection has succeeded; never reset on a run switch, so an endpoint that is blocked from the start never produces a permanent reconnecting spinner.
	streamWasConnectedOnce: boolean
	// The inspector descriptor over the run view: null when nothing is hovered. Cleared on `mouseleave` of the stage and on run switch; a stale id self-dismisses at render time.
	tooltip: TooltipSnapshot | null
	// Interrupt form state: the kind toggle, an in-flight send flag, and a one-line outcome notice. The answer card presents each newly-arrived interrupt answer once (keys run-scoped in shownInterruptAnswerKeys); a run's first read baselines its answered history so old runs never pop stale cards.
	interruptMode: InterruptMode
	interruptSending: boolean
	interruptNotice: string | null
	interruptAnswerCard: InterruptAnswerCard | null
	shownInterruptAnswerKeys: Record<string, boolean>
	now: number
}

// --- Action and effect contract --------------------------------------------
// hyperapp v1 actions are pure state transitions that may return effect tuples; effects are `[runner, payload]` pairs the framework invokes with a dispatch. The payload types are read off this module's own dispatch calls.

export type Action<Payload> = (state: ApplicationState, payload: Payload) => ActionReturn

// hyperapp flattens the effect list and ignores falsy entries, so actions use null effects as a no-op branch (e.g. the muted beep in GotQuestions).
export type OptionalEffect = EffectItem | null | undefined | false

export type ActionReturn = ApplicationState | [ApplicationState, ...OptionalEffect[]]

export type EffectRunner<Payload> = (dispatch: Dispatch, payload: Payload) => void

export type Dispatch = <Payload>(action: Action<Payload>, payload?: Payload) => void

// The fetch effecter's payload: the ok action receives the response envelope once the body has been parsed (or the raw text when the body is not JSON); the fail action fires only on a network error. `version` is the response's ETag (or null when the server sent none) and `url` the request URL, so the receiving action can store the validator under the exact URL it will be replayed against.
export interface FetchResultPayload {
	status: number
	ok: boolean
	body: unknown
	version: string | null
	url: string
}

export interface FetchEffectPayload {
	url: string
	init?: RequestInit
	// The stored ETag to revalidate with, sent as If-None-Match; absent or empty means an unconditional request. Only the run view still carries it — the run list and flow model now sync through entity-diff.
	ifNoneMatch?: string | null
	// Set only by periodic polls: the guard key gives that poll single-flight, a bounded request timeout, and capped retry backoff.
	pollKey?: PollKey
	ok: Action<FetchResultPayload>
	fail: Action<undefined>
}

export type FetchEffect = [EffectRunner<FetchEffectPayload>, FetchEffectPayload]
export type NullPayloadEffect = [EffectRunner<null>, null]
export type FaviconEffect = [EffectRunner<ApplicationState>, ApplicationState]

export type EffectItem = FetchEffect | NullPayloadEffect | FaviconEffect

// --- Constants and formatting helpers --------------------------------------

const POLL_INTERVAL_MS = 1000

const POLL_KEY_RUN_LIST: PollKey = 'run-list'
const POLL_KEY_QUESTIONS: PollKey = 'questions'
const POLL_KEY_QUEUE: PollKey = 'queue'
const POLL_KEY_SELECTED_RUN: PollKey = 'selected-run'
const POLL_KEY_FLOW: PollKey = 'flow'
const POLL_KEY_INSPECTOR_TAIL: PollKey = 'inspector-tail'

const STATUS_LABELS: Record<string, string> = {
	unknown: 'in progress',
	running: 'running',
	suspended: 'suspended',
	success: 'success',
	error: 'error',
	needs_clarification: 'needs clarification',
	interrupted: 'interrupted',
}

const SERVER_UNAVAILABLE_MESSAGE = 'server unavailable — it may have shut down'

// The effort channel's three levels. The wire strings are the contract (see docs/reference.md "Effort channel"): state, API bodies, and run metadata carry them verbatim, so there is no mapping table — display capitalization is a UI concern only and the executor never reads it. The per-option descriptions are the single copy of what each level means; the compose screen's selector (EffortLevelSelector) and the history badge's hover title both render from this list.
const DEFAULT_EFFORT: EffortLevel = 'standard'
const EFFORT_OPTIONS: { value: EffortLevel; description: string; recommended?: boolean }[] = [
	{ value: 'quick', description: 'The fastest, lightest pass. Good for small fixes and simple tasks.' },
	{ value: 'standard', description: 'Careful work at a reasonable pace. The right choice for most tasks.', recommended: true },
	{ value: 'thorough', description: 'The slowest, most meticulous pass. Best for large or important projects.' },
]

function isEffort(value: unknown): value is EffortLevel {
	return EFFORT_OPTIONS.some((option) => option.value === value)
}

function effortLabel(effort: unknown): string {
	if (!isEffort(effort)) return '—'
	return effort.charAt(0).toUpperCase() + effort.slice(1)
}

function effortDescription(effort: unknown): string {
	const option = EFFORT_OPTIONS.find((entry) => entry.value === effort)
	return option !== undefined ? option.description : ''
}

// The human-involvement channel's three levels (see docs/reference.md "Involvement channel"). The wire strings are the contract; the per-option descriptions are the single copy of what each level means, rendered by the compose screen's selector and the history badge's hover title.
const DEFAULT_INVOLVEMENT: InvolvementLevel = 'early-engagement'
const INVOLVEMENT_OPTIONS: { value: InvolvementLevel; description: string }[] = [
	{ value: 'autonomous', description: 'Makes reasonable choices and works without checking in.' },
	{ value: 'early-engagement', description: 'Clarifies up front, then works on its own.' },
	{ value: 'collaborative', description: 'Checks in with you as it goes.' },
]

function isInvolvement(value: unknown): value is InvolvementLevel {
	return INVOLVEMENT_OPTIONS.some((option) => option.value === value)
}

function involvementLabel(involvement: unknown): string {
	if (!isInvolvement(involvement)) return '—'
	return involvement === 'early-engagement' ? 'Early engagement' : involvement.charAt(0).toUpperCase() + involvement.slice(1)
}

function involvementDescription(involvement: unknown): string {
	const option = INVOLVEMENT_OPTIONS.find((entry) => entry.value === involvement)
	return option !== undefined ? option.description : ''
}

// The logging-level channel's two levels (see docs/reference.md "Logging level"). The wire strings are the contract — API bodies and settings carry them verbatim. Under `standard` the run log still receives every event, but the heavy bodies (each llm_call's sent conversation and received response, each tool_result's full result) are dropped, which keeps long runs' log files small at the cost of the raw-detail toggle showing fewer bodies.
const DEFAULT_LOG_LEVEL: LogLevel = 'full'
const LOG_LEVEL_OPTIONS: { value: LogLevel; label: string }[] = [
	{ value: 'full', label: 'Full logging' },
	{ value: 'standard', label: 'Standard (smaller logs)' },
]

function isLogLevel(value: unknown): value is LogLevel {
	return LOG_LEVEL_OPTIONS.some((option) => option.value === value)
}

// A polled status value is a RunStatus exactly when the status-label table knows it: the table's keys are the full RunStatus set, so membership doubles as the wire guard at every ingress that needs the type.
function isRunStatus(value: unknown): value is RunStatus {
	return typeof value === 'string' && Object.hasOwn(STATUS_LABELS, value)
}

// The label tier the flow/sequence views localize through. 'detailed' is the default so a fresh load reads precisely; the toggle in the run-view controls swaps it for a non-technical voice. The values come from labels.js (TIER_VALUES), so a swap re-renders the views through the same resolver without touching the model.
const DEFAULT_FLOW_TIER: LabelTier = 'detailed'

// Derives the guild's static role/tool inventory from the live `/api/config` so the sequence view can lay out every guild role as a column from the first frame (peeking at future participants would defeat the model's "the run reveals what happens" contract). The flow view does not need this — it projects only active participants — but passing it is harmless and keeps the two views' column sets aligned. The 'human' and 'tools' columns are added by the view itself, so this carries only the real roles and tools.
function guildParticipantsFromConfig(config: unknown): Participant[] {
	if (!isObject(config)) return []
	const participants: Participant[] = []
	const roles = config['roles']
	if (isObject(roles)) {
		for (const name of Object.keys(roles)) participants.push({ id: `guild:${name}`, role: name, kind: 'role' })
	}
	const tools = config['tools']
	if (isObject(tools)) {
		for (const name of Object.keys(tools)) participants.push({ id: `guild:${name}`, role: name, kind: 'tool' })
	}
	return participants
}

// One shared NumberFormat so every rendered count, token total, and duration in the UI shares the user's locale and grouping; re-instantiating per render is wasteful and would let a locale change between renders drift the formatting.
const numberFormatter = new Intl.NumberFormat(navigator.language)

// Formats any numeric value with locale grouping, returning '—' for null/undefined/non-numbers so callers can pass optional fields (token totals absent on a run with no usage) without a separate guard.
function formatNumber(value: unknown): string {
	if (value === null || value === undefined) return '—'
	if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
	return numberFormatter.format(value)
}

// The AudioContext is created lazily on first user interaction (browsers start it suspended until a gesture) and reused for every beep; it is module state, not app state, because it is an opaque resource with no place in the view.
let audioContext: AudioContext | null = null

// The run stage owns the flow column high-water mark, the accent assignment, participant ordering, and the stage memo. It starts empty and is reconfigured in place when `/api/config` lands, so the centerpiece's width stays stable as runs deepen and unwind for the page-load lifetime even when the config fetch resolves after the first flow frame. Held at module scope like audioContext — it is view-render memory, not app state.
let runStage: RunStage = createRunStage({ roleNames: [], roleOrder: [] })

// The inspector's operation-details controller (see operation-details.js): key `<runId>|<operationId>`, states 'loading' | 'failed' | ready. The polled flow model ships no detail bodies (they can carry multi-megabyte tool arguments/results), so opening an inspector card fetches the ids its derivation may show from `api/runs/:id/flow?operation=<id>` and caches them in a bounded LRU. Operation ids are stable within a run (events only append), so a cached entry never goes stale; the run id in the key keeps a previous run's entries from answering for another run's same-numbered operation. An evicted id reads as failed and can be fetched again if a surface asks for it later. Module scope like runStage — cache memory, not app state. This host drives the controller through `begin` + `record*` because its fetches are hyperapp effects whose ok/fail actions must return fresh state to trigger the re-render, so no `onLanded` fan-out is wired.
const operationDetails = createOperationDetails({}, { maxEntries: 512, maxCharacters: 32_000_000 })

// The LLM turn inspector's session (see turn-inspector/index.js): it owns the unscoped tail window, the per-instance scoped windows, the fetch decisions that page them, the turn/transcript derivations, and the per-turn wire-envelope cache. Module scope like operationDetails — inspection-session memory, not app state. The host only performs the requests it returns and passes the response back.
const inspectorSession = createInspectorSession()

// The live-token-stream client (see stream-client.js and docs/reference.md "Live token stream"): module scope like the other session caches, created lazily by the stream subscription on the first watch-screen mount. Leaving Watch (or the run becoming terminal) unsubscribes and closes the socket; returning reconnects rather than leaving a dormant connection open. The stream is an enhancement — the client is contained (never throws, shows no error surface), and the only state it feeds is the ephemeral `livePartial` the inspector modal's in-flight turn renders.
let streamClient: StreamClient | null = null

// ws vs wss follows the page's own protocol so a TLS deployment upgrades the stream with it.
function streamSocketUrl(): string {
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
	return `${protocol}//${window.location.host}/ws/stream`
}

function ensureAudioContext(): AudioContext | null {
	if (audioContext === null) {
		const audioConstructor = window.AudioContext !== undefined ? window.AudioContext : window.webkitAudioContext
		if (audioConstructor !== undefined) audioContext = new audioConstructor()
	}
	return audioContext
}

function formatRelative(iso: string | null | undefined, now: number): string {
	if (iso === null || iso === undefined || iso === '') return '—'
	const then = Date.parse(iso)
	if (Number.isNaN(then)) return iso
	const seconds = Math.round((now - then) / 1000)
	if (seconds < 1) return 'just now'
	if (seconds < 60) return `${formatNumber(seconds)}s ago`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${formatNumber(minutes)}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${formatNumber(hours)}h ago`
	const days = Math.floor(hours / 24)
	return `${formatNumber(days)}d ago`
}

function statusLabel(status: string | null | undefined): string {
	if (status === null || status === undefined) return '—'
	return STATUS_LABELS[status] ?? status
}

function formatElapsed(seconds: unknown): string {
	if (typeof seconds !== 'number' || seconds < 0 || !Number.isFinite(seconds)) return '—'
	const minutes = Math.floor(seconds / 60)
	const remaining = seconds % 60
	if (minutes === 0) return `${formatNumber(remaining)}s`
	return `${formatNumber(minutes)}m ${formatNumber(remaining)}s`
}

function formatTokens(tokens: unknown): string {
	return formatNumber(tokens)
}

// --- Markdown rendering ----------------------------------------------------
// Agent-authored prose is Markdown rendered as formatted text via the shared pipeline in `markdown-render.js` (showdown → highlight.js → sanitized vnodes). The renderer is constructed once against this module's `h` and reused everywhere prose appears; the implementation and its memoization live in the shared module so the demo harness renders Markdown through the identical sanitized path.

const renderMarkdown = createMarkdownRenderer(h, { maxEntries: 256, maxCharacters: 16_000_000 })

// The live run is the first summary that is not settled for polling: running or unknown. A suspended pause, like a terminal outcome, is excluded, so the UI never says a suspended run is in progress. Derived in the view rather than stored, so it can never drift from the run list.
function deriveActiveRunId(summaries: RunSummary[]): string | null {
	const active = summaries.find((summary) => isLiveStatus(summary.status) || summary.status === 'unknown')
	return active === undefined ? null : active.runId
}

// --- Custom subscriptions --------------------------------------------------
// hyperapp's @hyperapp/time package would provide onEvery, but vendoring a second file for ~5 lines is not worth the supply-chain cost; the subscriber is defined once here so its reference is stable across renders (patchSubs compares subscriber references to decide whether to restart a subscription).

function onEverySubscriber(dispatch: Dispatch, payload: { action: Action<undefined>; interval: number }): () => void {
	const id = setInterval(() => dispatch(payload.action), payload.interval)
	return () => clearInterval(id)
}

function onEvery(action: Action<undefined>, interval: number): [typeof onEverySubscriber, { action: Action<undefined>; interval: number }] {
	return [onEverySubscriber, { action, interval }]
}

function onFirstInteractionSubscriber(dispatch: Dispatch, payload: { action: Action<undefined> }): () => void {
	const handler = () => dispatch(payload.action)
	window.addEventListener('pointerdown', handler, { once: true })
	window.addEventListener('keydown', handler, { once: true })
	return () => {
		window.removeEventListener('pointerdown', handler)
		window.removeEventListener('keydown', handler)
	}
}

function onFirstInteraction(action: Action<undefined>): [typeof onFirstInteractionSubscriber, { action: Action<undefined> }] {
	return [onFirstInteractionSubscriber, { action }]
}

// The Escape key dismisses the inspector modal while it is open; the subscription is present only then (the subscriptions array carries it as a stable position whose value is falsy while the modal is closed, which hyperapp ignores), so no key listener exists otherwise.
function onEscapeKeySubscriber(dispatch: Dispatch, payload: { action: Action<undefined> }): () => void {
	const handler = (event: KeyboardEvent): void => {
		if (event.key === 'Escape') dispatch(payload.action)
	}
	window.addEventListener('keydown', handler)
	return () => window.removeEventListener('keydown', handler)
}

function onEscapeKey(action: Action<undefined>): [typeof onEscapeKeySubscriber, { action: Action<undefined> }] {
	return [onEscapeKeySubscriber, { action }]
}

// The visibility subscription stays mounted for the page's lifetime: it withdraws the polling subscriptions while the tab is hidden and tells the app to refresh when the tab returns.
function onVisibilityChangeSubscriber(dispatch: Dispatch, payload: { action: Action<boolean> }): () => void {
	const handler = (): void => {
		dispatch(payload.action, document.visibilityState === 'visible')
	}
	document.addEventListener('visibilitychange', handler)
	return () => document.removeEventListener('visibilitychange', handler)
}

function onVisibilityChange(action: Action<boolean>): [typeof onVisibilityChangeSubscriber, { action: Action<boolean> }] {
	return [onVisibilityChangeSubscriber, { action }]
}

// --- Custom effects --------------------------------------------------------
// @hyperapp/http is still "planned", so the fetch effecter is hand-written. It parses the body and dispatches straight from the promise callbacks: hyperapp coalesces renders itself behind its own render lock (../vendor/hyperapp.js), so a microtask dispatch cannot interleave with a render, while a requestAnimationFrame hop would delay every state update a frame and — in a hidden tab, where requestAnimationFrame never fires — strand every completed poll's parsed body in a pending callback until the tab resurfaced. The fail action fires on any network failure, including a dropped connection mid-body (the body read rejects, not the fetch itself); any HTTP response — even a 4xx/5xx — resolves the ok branch with its status. Poll fetches delegate their timeout, cancellation, and retry bookkeeping to pollFetcher, which settles only after the body read and dispatches nothing for an intentional cancellation.

// Merges an If-None-Match validator into a request's headers without clobbering any header the caller set. A Headers instance normalizes the caller's headers (object, array, or Headers), and an absent or empty validator returns the init unchanged so unconditional requests keep their exact shape.
function withIfNoneMatch(init: RequestInit | undefined, ifNoneMatch: string | null | undefined): RequestInit | undefined {
	if (typeof ifNoneMatch !== 'string' || ifNoneMatch === '') return init
	const headers = new Headers(init?.headers)
	headers.set('If-None-Match', ifNoneMatch)
	return { ...init, headers, cache: 'no-store' }
}

// Merges the poll timeout's abort signal with any caller-supplied one so neither cancels the other.
function withAbortSignal(init: RequestInit | undefined, signal: AbortSignal): RequestInit {
	const existingSignal = init?.signal
	if (existingSignal === undefined || existingSignal === null) return { ...init, signal }
	return { ...init, signal: AbortSignal.any([existingSignal, signal]) }
}

function parseFetchBody(text: string): unknown {
	if (text.length === 0) return null
	try {
		return JSON.parse(text)
	} catch {
		return text
	}
}

function fetchPollResponse(url: string, init: RequestInit | undefined, signal: AbortSignal): Promise<PollResponse> {
	return fetch(url, withAbortSignal(init, signal)).then((response) => ({
		status: response.status,
		ok: response.ok,
		version: response.headers.get('etag'),
		text: () => response.text(),
	}))
}

// The guard arithmetic uses the monotonic clock so wall-clock adjustments cannot distort retry windows; Date.now() remains the display clock in Tick.
const pollFetcher = createPollFetcher({
	request: fetchPollResponse,
	now: () => performance.now(),
	createAbortController: () => new AbortController(),
	scheduleTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	cancelTimeout: (handle) => clearTimeout(handle),
})

function cancelRunScopedPolls(): void {
	pollFetcher.cancel(POLL_KEY_SELECTED_RUN)
	pollFetcher.cancel(POLL_KEY_FLOW)
	pollFetcher.cancel(POLL_KEY_INSPECTOR_TAIL)
}

function runFetch(dispatch: Dispatch, payload: FetchEffectPayload): void {
	const requestInit = withIfNoneMatch(payload.init, payload.ifNoneMatch)
	const pollKey = payload.pollKey
	if (pollKey === undefined) {
		fetch(payload.url, requestInit).then(
			(response) => {
				const status = response.status
				const ok = response.ok
				const version = response.headers.get('etag')
				response.text().then(
					(text) => dispatch(payload.ok, { status, ok, body: parseFetchBody(text), version, url: payload.url }),
					() => dispatch(payload.fail),
				)
			},
			() => dispatch(payload.fail),
		)
		return
	}
	pollFetcher.start(pollKey, { url: payload.url, init: requestInit }).then((outcome) => {
		if (outcome.kind === 'failed') {
			dispatch(payload.fail)
			return
		}
		if (outcome.kind !== 'response') return
		dispatch(payload.ok, { status: outcome.status, ok: outcome.ok, body: parseFetchBody(outcome.bodyText), version: outcome.version, url: payload.url })
	})
}

// Records a response's ETag under its request URL, returning a fresh map so the poll keys validators per URL. A response without an ETag (an unversioned endpoint, or a 304 whose validator the server omitted) leaves the map unchanged, so a previously stored token survives.
function recordVersion(versions: Record<string, string>, payload: FetchResultPayload): Record<string, string> {
	if (typeof payload.version !== 'string' || payload.version === '') return versions
	return { ...versions, [payload.url]: payload.version }
}

function storedVersionFor(versions: Record<string, string>, url: string): string | null {
	return versions[url] ?? null
}

function runViewUrl(runId: string): string {
	return `api/runs/${encodeURIComponent(runId)}`
}

function Fetch(payload: FetchEffectPayload): FetchEffect {
	return [runFetch, payload]
}

function runBeep(_dispatch: Dispatch, _payload: null): void {
	const ctx = audioContext
	if (ctx === null || ctx.state !== 'running') return
	const oscillator = ctx.createOscillator()
	const gain = ctx.createGain()
	oscillator.type = 'sine'
	oscillator.frequency.value = 880
	gain.gain.value = 0.08
	oscillator.connect(gain)
	gain.connect(ctx.destination)
	const now = ctx.currentTime
	oscillator.start(now)
	oscillator.stop(now + 0.18)
}

function PlayBeep(): NullPayloadEffect {
	return [runBeep, null]
}

function runPrimeAudio(_dispatch: Dispatch, _payload: null): void {
	const ctx = ensureAudioContext()
	if (ctx !== null && ctx.state === 'suspended') ctx.resume()
}

function PrimeAudioFx(): NullPayloadEffect {
	return [runPrimeAudio, null]
}

// The favicon effect: derives the three-state favicon from the polled run list, pending questions, and task queue, and swaps the `<link rel="icon">` href only when the derived state's href changes, so an identical poll tick never touches the DOM.
function runUpdateFavicon(_dispatch: Dispatch, state: ApplicationState): void {
	const link = document.querySelector('link[rel="icon"]')
	if (link === null) return
	const href = faviconHref(deriveFaviconState(state.summaries, state.pendingQuestions, state.queueItems))
	if (link.getAttribute('href') === href) return
	link.setAttribute('href', href)
}

function UpdateFavicon(state: ApplicationState): FaviconEffect {
	return [runUpdateFavicon, state]
}

// Appends a favicon repaint for the resulting state to an action's return, so a handler whose branches delegate to another action (SelectRun, SetScreen) still repaints the icon from the queue read it just applied.
function withFavicon(result: ActionReturn): ActionReturn {
	if (Array.isArray(result)) {
		const [nextState, ...effects] = result
		return [nextState, ...effects, UpdateFavicon(nextState)]
	}
	return [result, UpdateFavicon(result)]
}

// --- Actions ---------------------------------------------------------------
// Actions are pure state transitions; side effects are returned as effect tuples alongside the next state. The polling action returns a fresh now so relative timestamps refresh every tick even when the server returns identical data.

function hasPollableSelectedRun(state: ApplicationState): state is ApplicationState & { selectedRunId: string } {
	return typeof state.selectedRunId === 'string' && state.selectedRunId !== '' && (state.selectedRunStatus === null || !isSettledForPolling(state.selectedRunStatus))
}

function Tick(state: ApplicationState): ActionReturn {
	if (!state.pageVisible) return state
	const runListRevision = runListFeedRevision(state.runListFeed)
	return [
		{ ...state, now: Date.now() },
		// The run list is an entity-diff feed: the held revision rides as `have` (omitted on the first poll, which asks for a snapshot) and the response's own `unchanged` reply is the revalidation, so the fetch is uncacheable rather than ETag-versioned.
		Fetch({ url: runListRevision === null ? 'api/runs' : `api/runs?have=${encodeURIComponent(runListRevision)}`, init: { cache: 'no-store' }, ok: GotRunList, fail: FetchFailed, pollKey: POLL_KEY_RUN_LIST }),
		// `api/questions` and `api/queue` carry no ETag, so their polls stay unconditional rather than replaying a validator the server never issued.
		Fetch({ url: 'api/questions', ok: GotQuestions, fail: FetchFailed, pollKey: POLL_KEY_QUESTIONS }),
		Fetch({ url: 'api/queue', ok: GotQueue, fail: FetchFailed, pollKey: POLL_KEY_QUEUE }),
	]
}

function PollSelectedRun(state: ApplicationState): ActionReturn {
	if (!state.pageVisible) return state
	// Bail on a non-string id rather than fetching `/api/runs/undefined`; `selectedRunId` is null until a run is selected and can briefly be undefined across a state transition, so the guard keeps the poll from firing on an invalid id.
	if (typeof state.selectedRunId !== 'string' || state.selectedRunId === '') return state
	const runId = encodeURIComponent(state.selectedRunId)
	const runUrl = runViewUrl(state.selectedRunId)
	const flowUrl = `api/runs/${runId}/flow`
	// The client's current flow revision rides as `have`; omitting it (no revision held yet) asks the server for a snapshot. The flow model is derived server-side from the full log (the truncated recentLog the run view carries is not enough to reconstruct the active path, lingering legs, or per-invocation costs), and entity-diff sends only the delta since that revision.
	const flowRevision = flowFeedRevision(state.flowFeed)
	const flowRequestUrl = flowRevision === null ? flowUrl : `${flowUrl}?have=${encodeURIComponent(flowRevision)}`
	return [
		state,
		Fetch({ url: runUrl, ifNoneMatch: storedVersionFor(state.versions, runUrl), ok: GotSelectedRun(state.selectedRunId), fail: FetchFailed, pollKey: POLL_KEY_SELECTED_RUN }),
		// The flow fetch is uncacheable but carries no ETag: its entity-diff `have` revision is the revalidation, so it sets no-store directly rather than through withIfNoneMatch.
		Fetch({ url: flowRequestUrl, init: { cache: 'no-store' }, ok: GotFlowModel(state.selectedRunId), fail: FlowFetchFailed, pollKey: POLL_KEY_FLOW }),
		// While the inspector modal is open, the same poll also refreshes the log-window tail so in-flight turns appear when they complete (a null effect when closed — hyperapp ignores falsy effects).
		InspectorTailRefresh(state),
	]
}

function splitActionResult(result: ActionReturn): [ApplicationState, OptionalEffect[]] {
	if (Array.isArray(result)) {
		const [nextState, ...effects] = result
		return [nextState, effects]
	}
	return [result, []]
}

function PageVisibilityChanged(state: ApplicationState, visible: boolean): ActionReturn {
	if (visible === state.pageVisible) return state
	if (!visible) {
		pollFetcher.cancelAll()
		return { ...state, pageVisible: false, flowRefreshPending: false }
	}
	pollFetcher.cancelAll()
	// A hidden tab misses every flow delta. Drop the held revision (keeping the replica and model) so the resumed poll asks for a snapshot, and show the refreshing pill until that snapshot lands; the old stage stays visible meanwhile. A non-resuming tab — including one whose selected run has gone terminal — never leaves the resume flag up.
	const resumingWatch = state.screen === 'watch' && hasPollableSelectedRun(state)
	const resumedState = {
		...state,
		pageVisible: true,
		flowFeed: resumingWatch ? discardFlowRevision(state.flowFeed) : state.flowFeed,
		flowRefreshPending: resumingWatch,
	}
	const [tickState, effects] = splitActionResult(Tick(resumedState))
	if (tickState.screen === 'watch' && hasPollableSelectedRun(tickState)) {
		const [, pollEffects] = splitActionResult(PollSelectedRun(tickState))
		effects.push(...pollEffects)
	}
	return [tickState, ...effects]
}

// The live InteractionModel the flow/sequence views render, scoped to the run the poll fetched it for: the flow payload carries no run id of its own, so the selected run id is curried in when the effect is built (PollSelectedRun) and the response is dropped when it no longer matches the selection at application time — a late frame for run A must not render over run B's stage. The body is an entity-diff frame, so it is reduced against the opaque feed state the client holds and the model is reconstructed from the resulting state. The previous frame is kept so the stage can diff entering/departing nodes; a 404 (the run directory exists but is not yet readable in the instant after submit) clears the feed and model only when nothing is rendered yet, so a transient unreadable poll never blanks an already-visible stage. Every path that changes the model also syncs the scroll followers: the model update grows (or clears) the sequence content after the view patch, and an open inspector modal's body element is replaced where the placeholder transitions to the model (the poll-time sync re-attaches its follower before the next content update can rely on it).
function GotFlowModel(runId: string) {
	return function GotFlowModelForRun(state: ApplicationState, payload: FetchResultPayload): ActionReturn {
		if (!responseBelongsToSelection(runId, state.selectedRunId)) return state
		if (payload.status === 404) {
			if (state.flowModel !== null) return { ...state, serverAvailable: payload.ok, flowRefreshPending: false }
			return [{ ...state, flowModel: null, previousFlowModel: null, flowFeed: emptyFlowFeedState(), serverAvailable: payload.ok, flowRefreshPending: false }, SyncSequenceFollower(), SyncInspectorFollower()]
		}
		const result = applyFlowFrame(state.flowFeed, payload.body)
		// An unchanged frame keeps the model and feed BY REFERENCE — reassigning them would break the WeakMap-keyed memoization in interaction-model.ts and the run-stage renderers — so only server availability is refreshed and no follower sync is needed (nothing mounted changed).
		if (result.outcome === 'unchanged') return { ...state, serverAvailable: true, flowRefreshPending: false }
		if (result.outcome === 'applied' || result.outcome === 'snapshot') {
			return [{ ...state, flowFeed: result.state, previousFlowModel: state.flowModel, flowModel: result.model, serverAvailable: true, flowRefreshPending: false }, SyncSequenceFollower(), SyncInspectorFollower()]
		}
		// A delta whose base the client no longer holds cannot be applied; re-fetching with no `have` asks the server for a full snapshot. The held feed and model stand until it lands.
		if (result.outcome === 'needsSnapshot') {
			return [{ ...state, serverAvailable: payload.ok }, Fetch({ url: `api/runs/${encodeURIComponent(runId)}/flow`, init: { cache: 'no-store' }, ok: GotFlowModel(runId), fail: FlowFetchFailed, pollKey: POLL_KEY_FLOW })]
		}
		// invalid: the frame failed validation, so the held feed and model stand, but the fetch result still updates server availability.
		return { ...state, serverAvailable: payload.ok, flowRefreshPending: false }
	}
}

// The flow fetch's failure path (both the poll and the snapshot retry): clearing the resume indicator here means a network failure or timeout cannot leave the top bar spinning forever.
function FlowFetchFailed(state: ApplicationState): ApplicationState {
	return { ...state, serverAvailable: false, flowRefreshPending: false }
}

// The run list arrives as an entity-diff frame, so it is reduced against the opaque feed state the client holds and the newest-first summaries are reconstructed from the resulting state. An unchanged frame keeps the summaries and feed BY REFERENCE (the history view's identity-keyed memoization relies on it); applied/snapshot store the new feed and the reconstructed summaries; a delta whose base the client no longer holds re-fetches with no `have` for a full snapshot; an invalid frame leaves the held state untouched but marks the server unavailable.
function GotRunList(state: ApplicationState, payload: FetchResultPayload): ActionReturn {
	const result = applyRunListFrame(state.runListFeed, payload.body)
	if (result.outcome === 'unchanged') {
		if (!payload.ok) return { ...state, serverAvailable: false }
		return { ...state, providerHealth: result.health, serverAvailable: true, runListLoaded: true }
	}
	if (result.outcome === 'applied' || result.outcome === 'snapshot') {
		if (!payload.ok) return { ...state, serverAvailable: false }
		const nextState = { ...state, runListFeed: result.state, summaries: result.summaries, providerHealth: result.health, serverAvailable: true, runListLoaded: true }
		if (nextState.justSubmittedRunId !== null && result.summaries.some((summary) => summary.runId === nextState.justSubmittedRunId)) {
			nextState.justSubmittedRunId = null
		}
		// Auto-select the newest run when nothing is selected so the user lands on live activity.
		if (nextState.selectedRunId === null && result.summaries.length > 0) {
			const newest = result.summaries[0]
			if (newest !== undefined) {
				nextState.selectedRunId = newest.runId
				nextState.selectedRunView = null
				nextState.selectedRunStatus = null
			}
		}
		// The per-run poll is off-duty off the watch screen, so the run list is the only status source there.
		const selectedRunId = nextState.selectedRunId
		if (nextState.screen !== 'watch' && selectedRunId !== null) {
			const selectedSummary = result.summaries.find((summary) => summary.runId === selectedRunId)
			if (selectedSummary !== undefined) {
				nextState.selectedRunStatus = selectedSummary.status
				// A pause or terminal outcome ends the in-flight turn the stream was showing; the server's log remains authoritative.
				if (isSettledForPolling(selectedSummary.status)) nextState.livePartial = null
			}
		}
		return [nextState, UpdateFavicon(nextState)]
	}
	// A delta whose base the client no longer holds cannot be applied; re-fetching with no `have` asks the server for a full snapshot. The held replica and summaries stand until it lands.
	if (result.outcome === 'needsSnapshot') {
		if (!payload.ok) return { ...state, serverAvailable: false }
		return [{ ...state, serverAvailable: true }, Fetch({ url: 'api/runs', init: { cache: 'no-store' }, ok: GotRunList, fail: FetchFailed, pollKey: POLL_KEY_RUN_LIST })]
	}
	// invalid: the envelope failed validation, so the held replica, summaries, and loaded flag stand, but the response is unusable and must not leave the history screen claiming a live server with nothing loaded.
	return { ...state, serverAvailable: false }
}

// The newest interrupt-question answer the operator has not been shown yet, or null. Keys are run-scoped (`runId|askedAt`) so one map serves every run without per-run resets; a run's first read baselines its already-answered inquiries so opening an old run never pops stale answers.
function latestUnshownAnswer(interrupts: InterruptHistoryEntry[], runId: string | null, shownInterruptAnswerKeys: Record<string, boolean>): InterruptInquiryEntry | null {
	let latest: InterruptInquiryEntry | null = null
	for (const entry of interrupts) {
		if (entry.kind !== 'inquiry' || entry.answer === null) continue
		if (shownInterruptAnswerKeys[`${runId}|${entry.askedAt}`] === true) continue
		latest = entry
	}
	return latest
}

function answeredInquiryKeys(interrupts: InterruptHistoryEntry[], runId: string | null): string[] {
	const keys: string[] = []
	for (const entry of interrupts) {
		if (entry.kind !== 'inquiry' || entry.answer === null) continue
		keys.push(`${runId}|${entry.askedAt}`)
	}
	return keys
}

// The run view's ingress guard: the fields this action reads (plus run id, which the wire may legitimately carry as null). The remaining RunView fields ride the server's typed contract and are re-guarded where the view reads them.
function isReadableRunView(value: unknown): value is RunView {
	if (!isObject(value)) return false
	if (!isRunStatus(value['status'])) return false
	const runId = value['runId']
	if (runId !== null && typeof runId !== 'string') return false
	return Array.isArray(value['interrupts'])
}

function GotSelectedRun(curriedRunId: string) {
	return function GotSelectedRunForRun(state: ApplicationState, payload: FetchResultPayload): ActionReturn {
		// A response that does not belong to the currently selected run is dropped wholesale: a late poll frame for the previously selected run would otherwise overwrite this run's view and status — a stale 404 would set 'unknown' so this run's first terminal frame computes a false completion transition and pops the result modal, and a stale terminal status would deactivate the per-run poll and stream subscriptions and freeze the watch screen.
		// The curried run id is the only identity the 404 body carries, so it guards every branch; on the readable path the body's own runId re-checks the server's answer against the same selection.
		if (!responseBelongsToSelection(curriedRunId, state.selectedRunId)) return state
		const status = payload.status
		const ok = payload.ok
		const body = payload.body
		// A 304 carries no body and has ok === false, so it must be handled before the 404/`!ok` checks below: the view and status are unchanged, so keep both exactly and skip the completion transition, the interrupt/answer bookkeeping, and the follower sync. When the held view was cleared (or belongs to another run), the validator outlived its payload, so drop it and refetch unconditionally instead of leaving the screen blank.
		if (status === 304) {
			const recovery = planRunViewRecovery(state.selectedRunId, state.selectedRunView?.runId, runViewUrl(curriedRunId), state.versions)
			if (recovery === null) return { ...state, serverAvailable: true }
			return [
				{ ...state, serverAvailable: true, versions: recovery.versions },
				Fetch({ url: recovery.url, init: { cache: 'no-store' }, ok: GotSelectedRun(curriedRunId), fail: FetchFailed }),
			]
		}
		if (status === 404) {
			// The run directory is created early in execution but may not be readable in the instant after submit; the per-run subscription keeps polling until the view appears.
			return [{ ...state, selectedRunStatus: 'unknown', serverAvailable: ok }, SyncSequenceFollower()]
		}
		if (!ok || body === null || !isReadableRunView(body)) return state
		if (!responseBelongsToSelection(body.runId, state.selectedRunId)) return state
		// The result modal fires once when a run the operator is watching completes (a transition out of a non-terminal status into success/error). Selecting an already-terminal historical run does not auto-open it — the flow view's CTA re-opens it on demand — so `previousStatus === null` (the first read of a selected run) is excluded along with the terminal statuses. A terminal status also clears the live partial: the in-flight turn it streamed is over (see "Live token stream").
		const previousStatus = state.selectedRunStatus
		const completedStatus = body.status === 'success' || body.status === 'error' ? body.status : null
		const isCompletionTransition = completedStatus !== null && previousStatus !== null && previousStatus !== 'success' && previousStatus !== 'error' && previousStatus !== 'needs_clarification'
		const runId = typeof body.runId === 'string' ? body.runId : state.selectedRunId
		const resultModalOpen = isCompletionTransition && state.resultShownForRun !== runId ? true : state.resultModalOpen
		const resultShownForRun = isCompletionTransition ? runId : state.resultShownForRun
		const interrupts = Array.isArray(body.interrupts) ? body.interrupts : []
		const shownInterruptAnswerKeys = { ...state.shownInterruptAnswerKeys }
		let interruptAnswerCard = state.interruptAnswerCard
		if (previousStatus === null) {
			for (const key of answeredInquiryKeys(interrupts, runId)) shownInterruptAnswerKeys[key] = true
		} else {
			const newAnswer = latestUnshownAnswer(interrupts, runId, shownInterruptAnswerKeys)
			if (newAnswer !== null) {
				for (const key of answeredInquiryKeys(interrupts, runId)) shownInterruptAnswerKeys[key] = true
				interruptAnswerCard = { question: newAnswer.message, answer: newAnswer.answer, role: newAnswer.role }
			}
		}
		// A completion transition resets the inspector's scope to auto, so the next open lands on the most recently active instance (here, the finishing one) instead of whatever the operator had scoped to during the run.
		if (isCompletionTransition) inspectorSession.scope(null)
		return [{ ...state, selectedRunView: body, selectedRunStatus: body.status, resultModalOpen, resultShownForRun, interruptAnswerCard, shownInterruptAnswerKeys, serverAvailable: true, providerHealth: body.providerHealth ?? state.providerHealth, livePartial: isSettledForPolling(body.status) ? null : state.livePartial, versions: recordVersion(state.versions, payload) }, SyncSequenceFollower()]
	}
}

function GotQuestions(state: ApplicationState, payload: FetchResultPayload): ActionReturn {
	const ok = payload.ok
	const body = payload.body
	const questions: ApiQuestion[] = ok && Array.isArray(body) ? body : []
	const currentIds: Record<string, boolean> = {}
	for (const question of questions) currentIds[question.id] = true
	let hasNew = false
	if (!state.firstQuestionsPoll) {
		for (const id of Object.keys(currentIds)) {
			if (!state.shownQuestionIds[id]) {
				hasNew = true
				break
			}
		}
	}
	const nextState = {
		...state,
		pendingQuestions: questions,
		shownQuestionIds: currentIds,
		firstQuestionsPoll: false,
		serverAvailable: ok,
		// A genuinely new question opens the per-run-view modal so it is unmissable; dismissing it leaves the flow view's Question affordance on the answerer node for re-entry. The modal is view-side state, not model state: the live model's ask_human call is what the flow view renders, this only gates the overlay.
		questionModalOpen: hasNew ? true : state.questionModalOpen,
	}
	// Beep on a genuinely new question unless muted; the modal itself opens via questionModalOpen above. Falsy effects are ignored by hyperapp, so the conditional inlines cleanly.
	if (hasNew) {
		return [nextState, UpdateFavicon(nextState), state.muted ? null : PlayBeep()]
	}
	return [nextState, UpdateFavicon(nextState)]
}

function FetchFailed(state: ApplicationState): ApplicationState {
	return { ...state, serverAvailable: false }
}

// --- Queue panel actions -----------------------------------------------------
// The polled queue feeds the queue screen; the mutations post to the /api/queue surface (docs/queueing.md "HTTP API") and every confirm path refetches the queue, since the server's tick may already have dispatched the item the mutation touched.

function reduceQueue(state: ApplicationState, payload: FetchResultPayload): ApplicationState {
	const ok = payload.ok
	if (!ok) return { ...state, serverAvailable: false }
	const body = payload.body
	// A 2xx response whose body is not the queue array is unusable: keep the held items and loaded flag rather than presenting a malformed answer as an empty queue.
	if (!Array.isArray(body)) return { ...state, serverAvailable: false }
	const items: QueueItemLike[] = body.filter(isQueueItemLike)
	// The add's post-response guard releases once the created item shows up in the polled queue — the same release GotRunList applies to justSubmittedRunId; a response that fails or omits the item keeps the guard up.
	const justSubmittedItemId = state.justSubmittedItemId !== null && items.some((item) => item.id === state.justSubmittedItemId)
		? null
		: state.justSubmittedItemId
	return { ...state, queueItems: items, serverAvailable: true, justSubmittedItemId, queueLoaded: true }
}

// The queue poll's ingress: reduce the payload, then repaint the favicon, so a poll that parks an item on a question (or clears one) turns the icon yellow (or back) without waiting for the run-list poll. A deferred answer resume is watched here: once its item carries a run id — even when it was dispatched and finished between polls, since done/error items keep the run id — the watch screen re-engages on that run. Only a vanished or cancelled item, or a finished item with no recorded run, clears the field without selection.
function GotQueue(state: ApplicationState, payload: FetchResultPayload): ActionReturn {
	const nextState = reduceQueue(state, payload)
	const pendingResumeItemId = nextState.pendingResumeItemId
	if (pendingResumeItemId === null) return [nextState, UpdateFavicon(nextState)]
	const item = nextState.queueItems.find((entry) => entry.id === pendingResumeItemId)
	if (item === undefined || item.status === 'cancelled') {
		const cleared = { ...nextState, pendingResumeItemId: null }
		return [cleared, UpdateFavicon(cleared)]
	}
	if (typeof item.runId === 'string' && item.runId !== '') {
		const cleared = { ...nextState, pendingResumeItemId: null }
		return withFavicon(ReactivateRunForAnswer(cleared, item.runId))
	}
	if (item.status === 'done' || item.status === 'error') {
		const cleared = { ...nextState, pendingResumeItemId: null }
		return [cleared, UpdateFavicon(cleared)]
	}
	return [nextState, UpdateFavicon(nextState)]
}

// The queue add resolved: the created item's id is remembered so the follow-up queue read can see whether the scheduler dispatched it within the same request (the idle case) — the operator then lands on the new run's watch screen exactly as a start-now submit always has. The poll's own queue reads deliberately do not consume this selection: a task added while a run is in flight dispatches much later, and jumping then would yank the operator off whatever they are reading.
function GotQueuedTask(state: ApplicationState, payload: FetchResultPayload): ActionReturn {
	const ok = payload.ok
	const body = payload.body
	// A refused or unreadable add still ends the in-flight window: the guard releases so the operator can retry.
	if (!ok || !isObject(body) || typeof body['id'] !== 'string' || body['id'] === '') return { ...state, createSending: false, serverAvailable: ok }
	return [
		{ ...state, justSubmittedItemId: body['id'], pendingAddSelectionId: body['id'], createSending: false, serverAvailable: true },
		Fetch({ url: 'api/queue', ok: GotQueueAfterAdd, fail: FetchFailed }),
	]
}

function GotQueueAfterAdd(state: ApplicationState, payload: FetchResultPayload): ActionReturn {
	const addedId = state.pendingAddSelectionId
	const queued = reduceQueue(state, payload)
	if (typeof addedId !== 'string') return [queued, UpdateFavicon(queued)]
	const cleared = { ...queued, pendingAddSelectionId: null }
	const added = queued.queueItems.find((item) => item.id === addedId)
	// Repaint the favicon in every branch: the read weighs the whole queue, so another item in the same response may have become needs_input even though the just-added one did not.
	if (added !== undefined && typeof added.runId === 'string' && added.runId !== '') return withFavicon(SelectRun(cleared, added.runId))
	// The task is still waiting its turn (a run was in flight) — the history screen's queued rows are where the operator sees where it sits in line.
	return withFavicon(SetScreen(cleared, 'history'))
}

function StartItemEdit(state: ApplicationState, itemId: unknown): ApplicationState {
	if (typeof itemId !== 'string' || itemId === '') return state
	// The edit form lives in the row's expanded details, so starting an edit also opens the row it edits.
	return { ...state, editingItemId: itemId, expandedRowIds: { ...state.expandedRowIds, [itemId]: true } }
}

function CancelItemEdit(state: ApplicationState): ApplicationState {
	return { ...state, editingItemId: null }
}

function SaveItemEdit(state: ApplicationState, event: Event): ActionReturn {
	event.preventDefault()
	const itemId = state.editingItemId
	if (typeof itemId !== 'string' || itemId === '') return state
	const target = event.target
	if (!(target instanceof HTMLFormElement)) return state
	const textarea = target.querySelector('textarea')
	if (!(textarea instanceof HTMLTextAreaElement)) return state
	const task = textarea.value.trim()
	if (task === '') return state
	return [
		{ ...state, editingItemId: null },
		Fetch({
			url: `api/queue/${encodeURIComponent(itemId)}`,
			init: { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task }) },
			ok: QueueMutated,
			fail: QueueMutationFailed,
		}),
	]
}

function RemoveQueueItem(state: ApplicationState, itemId: unknown): ActionReturn {
	if (typeof itemId !== 'string' || itemId === '') return state
	return [
		state,
		Fetch({
			url: `api/queue/${encodeURIComponent(itemId)}`,
			init: { method: 'DELETE' },
			ok: QueueMutated,
			fail: QueueMutationFailed,
		}),
	]
}

function SubmitQueueAnswer(itemId: string) {
	return function SubmitAnswerForQueueItem(state: ApplicationState, event: Event): ActionReturn {
		event.preventDefault()
		const target = event.target
		if (!(target instanceof HTMLFormElement)) return state
		const textarea = target.querySelector('textarea')
		if (!(textarea instanceof HTMLTextAreaElement)) return state
		const answer = textarea.value
		if (answer === '') return state
		return [
			{ ...state, queueAnswerPendingId: itemId },
			Fetch({
				url: `api/queue/${encodeURIComponent(itemId)}/answer`,
				init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer }) },
				// The answer handler is bound to this item's id at request time, so the mutation kind is fixed when the request leaves rather than inferred from shared state when the response lands (a concurrent edit or a dismissed modal must not reroute it).
				ok: GotQueueAfterAnswer(itemId),
				fail: QueueMutationFailed,
			}),
		]
	}
}

// The edit/remove/reorder mutation's confirm path: the response body is the mutated item, so the client refetches the queue for the authoritative list, and that refetch's GotQueue reduces it and repaints the favicon. Answers do not route here — SubmitQueueAnswer binds its own curried handler.
function QueueMutated(state: ApplicationState, payload: FetchResultPayload): ActionReturn {
	if (!payload.ok) return { ...state, serverAvailable: true }
	return [
		{ ...state, serverAvailable: true },
		Fetch({ url: 'api/queue', ok: GotQueue, fail: FetchFailed }),
	]
}

// The answer POST's response handler, curried with the answered item's id at request time: a refused answer still ends the in-flight window, and an accepted one clears the app-shell question modal's id and refetches the queue so ApplyAnsweredQueue can select the run the answer dispatched.
function GotQueueAfterAnswer(answeredItemId: string) {
	return function GotQueueAfterAnswerForItem(state: ApplicationState, payload: FetchResultPayload): ActionReturn {
		if (!payload.ok) return { ...state, queueAnswerPendingId: null, serverAvailable: true }
		const nextState = { ...state, queueAnswerPendingId: null, openQueueQuestionId: null, serverAvailable: true }
		return [nextState, Fetch({ url: 'api/queue', ok: ApplyAnsweredQueue(answeredItemId), fail: FetchFailed })]
	}
}

// The answer's follow-up queue read, curried with the answered item's id. When the parked checkpoint still matches, the scheduler re-enters the SAME run id and the item's runId is already present in this read, so the watch screen is reactivated immediately (including when it is already the selected run: its terminal needs_clarification status is reset so the per-run poll and stream restart). The no-checkpoint fallback submits a new briefed continuation with a fresh runId, which this same selection path handles. When the slot was busy the item is still waiting with no runId: the client records it in pendingResumeItemId and stays put, and GotQueue re-engages the watch screen when that item finally resumes.
function ApplyAnsweredQueue(answeredItemId: string) {
	return function ApplyAnsweredQueueForItem(state: ApplicationState, payload: FetchResultPayload): ActionReturn {
		const queued = reduceQueue(state, payload)
		const item = queued.queueItems.find((entry) => entry.id === answeredItemId)
		if (item !== undefined && typeof item.runId === 'string' && item.runId !== '') {
			const cleared = { ...queued, pendingResumeItemId: null }
			return withFavicon(ReactivateRunForAnswer(cleared, item.runId))
		}
		const deferred = { ...queued, pendingResumeItemId: answeredItemId }
		return [deferred, UpdateFavicon(deferred)]
	}
}

// A refused or failed mutation refetches too, so an optimistic update (a drag) reconciles with the server's order.
function QueueMutationFailed(state: ApplicationState): ActionReturn {
	return [
		{ ...state, queueAnswerPendingId: null, queueTerminatePendingId: null, serverAvailable: false },
		Fetch({ url: 'api/queue', ok: GotQueue, fail: FetchFailed }),
	]
}

// The parked row's and the parked-question modal's termination action. It stops propagation because the row's main area opens the question modal on click, then confirms before discarding the waiting run and its saved context. Only the item's own runId refreshes a selected run; continuesFrom is lineage, not the parked run.
function TerminateQueueItem(itemId: string) {
	return function TerminateQueueItemAction(state: ApplicationState, event: Event): ActionReturn {
		event.stopPropagation()
		if (state.queueTerminatePendingId !== null) return state
		const item = state.queueItems.find((entry) => entry.id === itemId)
		const runId = item !== undefined ? item.runId ?? null : null
		if (!window.confirm('Terminate this task? The waiting run and its saved context will be discarded.')) return state
		return [
			{ ...state, queueTerminatePendingId: itemId, openQueueQuestionId: null },
			Fetch({
				url: `api/queue/${encodeURIComponent(itemId)}/terminate`,
				init: { method: 'POST' },
				ok: GotQueueAfterTerminate(runId),
				fail: QueueMutationFailed,
			}),
		]
	}
}

// The terminate POST resolved: the queue refetch drives the row and panel on both success and an HTTP refusal, so a race or an already-gone run reconciles instead of leaving a stale row. When the terminated run is the selected one, its view is reset to non-terminal so the per-run poll refetches the now-interrupted meta instead of staying parked; another run's selection is left alone.
function GotQueueAfterTerminate(runId: string | null) {
	return function GotQueueAfterTerminateForRun(state: ApplicationState, payload: FetchResultPayload): ActionReturn {
		const cleared: ApplicationState = { ...state, queueTerminatePendingId: null, serverAvailable: true }
		const effects: OptionalEffect[] = [
			Fetch({ url: 'api/queue', ok: GotQueue, fail: FetchFailed }),
			Fetch({ url: 'api/runs', ok: GotRunList, fail: FetchFailed }),
		]
		if (!payload.ok) return [cleared, ...effects]
		const nextState = runId !== null && runId === state.selectedRunId
			? { ...cleared, openQueueQuestionId: null, suspendedModalOpen: false, selectedRunStatus: 'unknown' as const, selectedRunView: null, resultModalOpen: false, resultShownForRun: null, resultLoad: null }
			: { ...cleared, openQueueQuestionId: null, suspendedModalOpen: false }
		return [nextState, ...effects]
	}
}

// The pause card's and history row's Terminate run action addresses the run itself, so it still works when the suspended item was lost; a queue row passes its item id and keeps the queue-native path. The host confirms because termination discards the saved checkpoint. A typed refusal lands in suspendedActionNotice and both polls refresh the stale state.
function TerminateSuspendedRun(runId: string, itemId: string | null = null) {
	return function TerminateSuspendedRunAction(state: ApplicationState, event: Event): ActionReturn {
		event.stopPropagation()
		if (state.queueTerminatePendingId !== null || state.resumeRunPendingId !== null) return state
		if (!window.confirm('Terminate this suspended run? Its saved context will be discarded.')) return state
		const target = suspendedTerminateTarget(runId, itemId)
		return [
			{ ...state, queueTerminatePendingId: target.pendingId, suspendedActionNotice: null },
			Fetch({
				url: target.url,
				init: { method: 'POST' },
				ok: GotSuspendedTerminate(runId),
				fail: SuspendedTerminateFailed,
			}),
		]
	}
}

function GotSuspendedTerminate(runId: string) {
	return function GotSuspendedTerminateForRun(state: ApplicationState, payload: FetchResultPayload): ActionReturn {
		const cleared: ApplicationState = { ...state, queueTerminatePendingId: null, serverAvailable: true }
		const effects: OptionalEffect[] = [
			Fetch({ url: 'api/queue', ok: GotQueue, fail: FetchFailed }),
			Fetch({ url: 'api/runs', ok: GotRunList, fail: FetchFailed }),
		]
		if (!payload.ok) {
			return [{ ...cleared, suspendedActionNotice: terminateFailureCopy(payload.body, payload.status) }, ...effects]
		}
		if (runId === state.selectedRunId) {
			const nextState: ApplicationState = { ...cleared, suspendedModalOpen: false, suspendedActionNotice: null, openQueueQuestionId: null, selectedRunStatus: 'unknown', selectedRunView: null, resultModalOpen: false, resultShownForRun: null, resultLoad: null }
			return [nextState, ...effects]
		}
		return [{ ...cleared, suspendedModalOpen: false, suspendedActionNotice: null, openQueueQuestionId: null }, ...effects]
	}
}

function SuspendedTerminateFailed(state: ApplicationState): ActionReturn {
	return [
		{ ...state, queueTerminatePendingId: null, suspendedActionNotice: 'The server could not be reached.', serverAvailable: false },
		Fetch({ url: 'api/queue', ok: GotQueue, fail: FetchFailed }),
		Fetch({ url: 'api/runs', ok: GotRunList, fail: FetchFailed }),
	]
}

// --- Queue drag-to-reorder ---------------------------------------------------
// Waiting rows are HTML5 drag sources and drop targets: dragstart records the dragged item's id (and sets the transfer data, without which Firefox refuses to start the drag), the drop computes the PATCH position from the target row's waiting index, and the reorder applies optimistically before the PATCH confirms. dragend clears the marker whatever happened — including a drop outside any row.

// The event target's data-attribute value, or null — the DOM read every queue row action shares.
function dataAttributeOf(event: Event, attribute: string): string | null {
	const target = event.currentTarget
	if (!(target instanceof Element)) return null
	const value = target.getAttribute(attribute)
	return typeof value === 'string' && value !== '' ? value : null
}

function DragQueueItem(state: ApplicationState, event: DragEvent): ApplicationState {
	const itemId = dataAttributeOf(event, 'data-item-id')
	if (itemId === null) return state
	if (event.dataTransfer !== null && event.dataTransfer !== undefined) {
		event.dataTransfer.setData('text/plain', itemId)
		event.dataTransfer.effectAllowed = 'move'
	}
	return { ...state, draggingItemId: itemId }
}

function DragOverQueueItem(state: ApplicationState, event: DragEvent): ApplicationState {
	event.preventDefault()
	if (event.dataTransfer !== null && event.dataTransfer !== undefined) event.dataTransfer.dropEffect = 'move'
	return state
}

function DropQueueItem(state: ApplicationState, event: DragEvent): ActionReturn {
	event.preventDefault()
	const targetId = dataAttributeOf(event, 'data-item-id')
	const draggedId = state.draggingItemId
	if (targetId === null || typeof draggedId !== 'string' || draggedId === targetId) return { ...state, draggingItemId: null }
	const position = deriveReorderPosition(state.queueItems, draggedId, targetId)
	if (position === null) return { ...state, draggingItemId: null }
	return [
		{ ...state, queueItems: reorderWaitingItems(state.queueItems, draggedId, position), draggingItemId: null },
		Fetch({
			url: `api/queue/${encodeURIComponent(draggedId)}`,
			init: { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ position }) },
			ok: QueueMutated,
			fail: QueueMutationFailed,
		}),
	]
}

function DragEndQueueItem(state: ApplicationState): ApplicationState {
	return state.draggingItemId === null ? state : { ...state, draggingItemId: null }
}

// The guild config is fetched exactly once on load and never polled, so this action runs a single time. The body is not retained in state; only the derived values the views need are kept — the label resolver the flow/sequence views localize through, the guild participant inventory the sequence view lays out columns from, the per-role accent resolver built over that same parse's agent roles (so a role's color is fixed for the page load), the guild-declared role order the views sort participants by, and the build identifier the top bar stamps (null when the response carries none, e.g. running from source).
function GotConfig(state: ApplicationState, payload: FetchResultPayload): ActionReturn {
	const ok = payload.ok
	const body = payload.body
	// A failed or malformed one-shot config load leaves any already-loaded config intact, but marks the server unavailable so the placeholder and warning reflect the real state.
	if (!ok || !isLabelConfig(body)) return { ...state, serverAvailable: false }
	const participants = guildParticipantsFromConfig(body)
	const roleNames = participants.filter((participant) => participant.kind === 'role').map((participant) => participant.role)
	// Apply the config in place so the flow column high-water mark survives; the config fetch and the run poll are independent, so a first flow frame can land before this action.
	runStage.configure({ roleNames, roleOrder: body.visualization?.roleOrder ?? [] })
	return {
		...state,
		labelResolver: createLabelResolver(body),
		guildParticipants: participants,
		build: buildInfoFromConfig(body),
	}
}

// The config's ingress guard, at the depth createLabelResolver consumes: the three label tables are objects when present, and the resolver itself tolerates their contents. The visualization section's roleOrder is display data the views sort by, so it is shape-checked here via the shared isRoleOrder guard (an array of non-empty, duplicate-free strings when present) even though createLabelResolver ignores it; GotConfig then reads it straight off the narrowed type. A malformed roleOrder fails the whole config load, which is deliberate: the server validates the guild, so a bad list here means a broken deployment, not a value to paper over.
function isLabelConfig(value: unknown): value is LabelConfig {
	if (!isObject(value)) return false
	if (value['roles'] !== undefined && !isObject(value['roles'])) return false
	if (value['tools'] !== undefined && !isObject(value['tools'])) return false
	if (value['visualization'] !== undefined) {
		const visualization = value['visualization']
		if (!isObject(visualization)) return false
		const roleOrder = visualization['roleOrder']
		if (roleOrder !== undefined && !isRoleOrder(roleOrder)) return false
	}
	return true
}

// The saved settings are fetched once on load so the selectors start where the operator last left them; later settings fetches (none today) would not override levels the operator has since picked.
function GotSettings(state: ApplicationState, payload: FetchResultPayload): ActionReturn {
	const ok = payload.ok
	const body = payload.body
	if (state.runEffort !== null && state.runInvolvement !== null && state.runLogLevel !== null) return { ...state, serverAvailable: ok }
	const record = ok && isObject(body) ? body : null
	const effort = record !== null && isEffort(record['effort']) ? record['effort'] : null
	const involvement = record !== null && isInvolvement(record['involvement']) ? record['involvement'] : null
	const logLevel = record !== null && isLogLevel(record['logLevel']) ? record['logLevel'] : null
	return {
		...state,
		runEffort: state.runEffort !== null ? state.runEffort : (effort !== null ? effort : DEFAULT_EFFORT),
		runInvolvement: state.runInvolvement !== null ? state.runInvolvement : (involvement !== null ? involvement : DEFAULT_INVOLVEMENT),
		runLogLevel: state.runLogLevel !== null ? state.runLogLevel : (logLevel !== null ? logLevel : DEFAULT_LOG_LEVEL),
		serverAvailable: ok,
	}
}

function SettingsFetchFailed(state: ApplicationState): ApplicationState {
	// The selectors still need concrete values to render, so fall back to the defaults rather than sitting at null forever.
	return { ...state, runEffort: state.runEffort ?? DEFAULT_EFFORT, runInvolvement: state.runInvolvement ?? DEFAULT_INVOLVEMENT, runLogLevel: state.runLogLevel ?? DEFAULT_LOG_LEVEL, serverAvailable: false }
}

// The settings write replaces the file wholesale, so a save carries all three persisted fields. The selectors' values are null until the initial GET /api/settings resolves — before that they would only contribute the defaults the selectors show, silently clobbering the operator's persisted choices, so buildSettingsBody refuses to build a body (and the save actions skip the PUT) until all are initialized; the pick still applies locally and persists on the next save.
function buildSettingsBody(runEffort: EffortLevel | null, runInvolvement: InvolvementLevel | null, runLogLevel: LogLevel | null): { effort: EffortLevel; involvement: InvolvementLevel; logLevel: LogLevel } | null {
	if (!isEffort(runEffort) || !isInvolvement(runInvolvement) || !isLogLevel(runLogLevel)) return null
	return { effort: runEffort, involvement: runInvolvement, logLevel: runLogLevel }
}

// A radio pick is one deliberate gesture (unlike a slider drag), so a single change handler both updates state and persists the level as the default for the next run — the selector stays where the operator last left it across page reloads and restarts, with one PUT per pick.
function SaveRunEffort(state: ApplicationState, event: Event): ActionReturn {
	const target = event.target
	if (!(target instanceof HTMLInputElement)) return state
	const value = target.value
	if (!isEffort(value)) return state
	const body = buildSettingsBody(value, state.runInvolvement, state.runLogLevel)
	if (body === null) return { ...state, runEffort: value }
	return [
		{ ...state, runEffort: value, savingEffort: true },
		Fetch({
			url: 'api/settings',
			init: { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
			ok: EffortSaved,
			fail: EffortSaveFailed,
		}),
	]
}

function EffortSaved(state: ApplicationState, payload: FetchResultPayload): ApplicationState {
	const ok = payload.ok
	const body = payload.body
	if (!ok || !isObject(body)) return { ...state, savingEffort: false, serverAvailable: true }
	const effort = body['effort']
	const involvement = body['involvement']
	const logLevel = body['logLevel']
	if (!isEffort(effort)) return { ...state, savingEffort: false, serverAvailable: true }
	return { ...state, savingEffort: false, runEffort: effort, runInvolvement: isInvolvement(involvement) ? involvement : state.runInvolvement, runLogLevel: isLogLevel(logLevel) ? logLevel : state.runLogLevel, serverAvailable: true }
}

function EffortSaveFailed(state: ApplicationState): ApplicationState {
	return { ...state, savingEffort: false, serverAvailable: false }
}

// The human-involvement picker follows the effort picker exactly: one change both updates state and persists the choice as the project default for the next run.
function SaveRunInvolvement(state: ApplicationState, event: Event): ActionReturn {
	const target = event.target
	if (!(target instanceof HTMLInputElement)) return state
	const value = target.value
	if (!isInvolvement(value)) return state
	const body = buildSettingsBody(state.runEffort, value, state.runLogLevel)
	if (body === null) return { ...state, runInvolvement: value }
	return [
		{ ...state, runInvolvement: value, savingInvolvement: true },
		Fetch({
			url: 'api/settings',
			init: { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
			ok: InvolvementSaved,
			fail: InvolvementSaveFailed,
		}),
	]
}

function InvolvementSaved(state: ApplicationState, payload: FetchResultPayload): ApplicationState {
	const ok = payload.ok
	const body = payload.body
	if (!ok || !isObject(body)) return { ...state, savingInvolvement: false, serverAvailable: true }
	const effort = body['effort']
	const involvement = body['involvement']
	const logLevel = body['logLevel']
	if (!isInvolvement(involvement)) return { ...state, savingInvolvement: false, serverAvailable: true }
	return { ...state, savingInvolvement: false, runInvolvement: involvement, runEffort: isEffort(effort) ? effort : state.runEffort, runLogLevel: isLogLevel(logLevel) ? logLevel : state.runLogLevel, serverAvailable: true }
}

function InvolvementSaveFailed(state: ApplicationState): ApplicationState {
	return { ...state, savingInvolvement: false, serverAvailable: false }
}

// The logging-level picker follows the effort picker exactly: one change both updates state and persists the choice as the project default for the next run.
function SaveRunLogLevel(state: ApplicationState, event: Event): ActionReturn {
	const target = event.target
	if (!(target instanceof HTMLInputElement)) return state
	const value = target.value
	if (!isLogLevel(value)) return state
	const body = buildSettingsBody(state.runEffort, state.runInvolvement, value)
	if (body === null) return { ...state, runLogLevel: value }
	return [
		{ ...state, runLogLevel: value, savingLogLevel: true },
		Fetch({
			url: 'api/settings',
			init: { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
			ok: LogLevelSaved,
			fail: LogLevelSaveFailed,
		}),
	]
}

function LogLevelSaved(state: ApplicationState, payload: FetchResultPayload): ApplicationState {
	const ok = payload.ok
	const body = payload.body
	if (!ok || !isObject(body)) return { ...state, savingLogLevel: false, serverAvailable: true }
	const effort = body['effort']
	const involvement = body['involvement']
	const logLevel = body['logLevel']
	if (!isLogLevel(logLevel)) return { ...state, savingLogLevel: false, serverAvailable: true }
	return { ...state, savingLogLevel: false, runLogLevel: logLevel, runEffort: isEffort(effort) ? effort : state.runEffort, runInvolvement: isInvolvement(involvement) ? involvement : state.runInvolvement, serverAvailable: true }
}

function LogLevelSaveFailed(state: ApplicationState): ApplicationState {
	return { ...state, savingLogLevel: false, serverAvailable: false }
}

// The per-run view state a switch resets: the flow model, its replica, its previous-frame diff, and the per-run modal/floating state all belong to the previously-selected run. Clearing the model unmounts the sequence container and the cleared inspector unmounts its modal body, so callers pair this with the two follower syncs; the live partial belongs to the previous run too (the stream subscription restarts onto the new selection).
function resetRunView(state: ApplicationState, runId: string, status: RunStatus | null): ApplicationState {
	return {
		...state,
		screen: 'watch',
		selectedRunId: runId,
		selectedRunView: null,
		selectedRunStatus: status,
		flowModel: null,
		previousFlowModel: null,
		flowFeed: emptyFlowFeedState(),
		flowRefreshPending: false,
		questionModalOpen: false,
		resultModalOpen: false,
		resultShownForRun: null,
		suspendedModalOpen: false,
		suspendedActionNotice: null,
		resumeRunPendingId: null,
		resultLoad: null,
		versions: withoutVersion(state.versions, runViewUrl(runId)),
		tooltip: null,
		interruptNotice: null,
		interruptModalOpen: false,
		interruptAnswerCard: null,
		planExpanded: false,
		inspectorModalOpen: false,
		livePartial: null,
	}
}

// A run switch cancels the old run's in-flight polls so a hung request cannot block the new selection's first poll behind its guard.
function switchRunView(state: ApplicationState, runId: string, status: RunStatus | null): ApplicationState {
	cancelRunScopedPolls()
	return resetRunView(state, runId, status)
}

function SelectRun(state: ApplicationState, runId: string): ActionReturn {
	if (runId === state.selectedRunId) {
		// A run can resume in place without this tab answering the question (another tab, the API, or an error-or-suspended resume). The run list then reports it non-terminal while the selected view still holds the old terminal status, which keeps the per-run poll and stream disabled; re-arm the same-id view so the operator can recover without switching runs or reloading.
		const summary = state.summaries.find((entry) => entry.runId === runId)
		if (summary !== undefined) {
			const plan = planSameRunView({
				summaryStatus: summary.status,
				currentStatus: state.selectedRunStatus,
				heldViewStatus: state.selectedRunView === null ? null : state.selectedRunView.status,
			})
			if (plan === 'reactivate') return ReactivateRunForAnswer(state, runId)
			// The per-run poll is off-duty off the watch screen, so a terminal summary can arrive while the held view or status is stale or absent. The first-read status is both pollable and unable to fabricate a completion transition, and the immediate poll avoids leaving the placeholder up for a full interval.
			if (plan === 'refresh') {
				inspectorSession.close()
				const [pollState, effects] = splitActionResult(PollSelectedRun(switchRunView(state, runId, null)))
				return [pollState, ...effects, SyncSequenceFollower(), SyncInspectorFollower()]
			}
		}
		return [{ ...state, screen: 'watch' }, SyncSequenceFollower(), SyncInspectorFollower()]
	}
	// Selecting a run always lands on the watch screen (history rows and the in-progress pill both go through here).
	inspectorSession.close()
	return [switchRunView(state, runId, null), SyncSequenceFollower(), SyncInspectorFollower()]
}

// Answering a parked question resumes the same run id rather than starting a new one. A different run goes through the normal switch; the same run must stay selected while its terminal needs_clarification status is reset to the non-terminal 'unknown', because the per-run poll and stream subscriptions are disabled on a terminal status. The status reset also clears resultShownForRun (through resetRunView), so the resumed run's eventual outcome opens the result modal again; the next poll's still-parked needs_clarification meta is not a completion transition from unknown, so it cannot reopen the old card.
function ReactivateRunForAnswer(state: ApplicationState, runId: string): ActionReturn {
	if (runId !== state.selectedRunId) return SelectRun(state, runId)
	inspectorSession.close()
	return [switchRunView(state, runId, 'unknown'), SyncSequenceFollower(), SyncInspectorFollower()]
}

function ToggleMute(state: ApplicationState, event: Event): ApplicationState {
	const target = event.target
	if (!(target instanceof HTMLInputElement)) return state
	return { ...state, muted: target.checked }
}

// The task editor is a multiline textarea, not a single-line input: a task is free-form Markdown a user may draft at length. Enter inserts a newline (the browser default for a textarea) and Tab inserts a real tab character at the caret (handled below), so neither key submits; submission is the submit button, with Ctrl/Cmd+Enter as a keyboard shortcut that re-enters the form's submit path.
function TaskTextareaKeydown(state: ApplicationState, event: KeyboardEvent): ApplicationState {
	if (event.key === 'Tab') {
		event.preventDefault()
		const target = event.target
		if (!(target instanceof HTMLTextAreaElement)) return state
		const start = target.selectionStart
		const end = target.selectionEnd
		if (start === null || end === null) return state
		target.value = target.value.slice(0, start) + '\t' + target.value.slice(end)
		target.selectionStart = start + 1
		target.selectionEnd = start + 1
		return state
	}
	if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
		event.preventDefault()
		const target = event.target
		if (!(target instanceof HTMLTextAreaElement)) return state
		const form = target.form
		if (form !== null && typeof form.requestSubmit === 'function') form.requestSubmit()
		return state
	}
	return state
}

function SubmitRun(state: ApplicationState, event: Event): ActionReturn {
	event.preventDefault()
	if (state.createSending || state.justSubmittedItemId !== null || state.justSubmittedRunId !== null || state.resumeSending) return state
	const target = event.target
	if (!(target instanceof HTMLFormElement)) return state
	const textarea = target.querySelector('textarea')
	if (!(textarea instanceof HTMLTextAreaElement)) return state
	const task = textarea.value.trim()
	// A resume posts to the errored run's own endpoint, and the note is optional either way (the run restarts with or without one), so neither the empty-text guard nor the textarea clear applies — the note stays in the box until the landing, because a refused resume must not lose it.
	const resumingRunId = state.resumingRunId
	if (resumingRunId !== null) {
		return [
			{ ...state, resumeSending: true, resumeNotice: null },
			Fetch({
				url: `api/runs/${encodeURIComponent(resumingRunId)}/resume`,
				init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildResumeBody(task)) },
				ok: GotResumedRun,
				fail: ResumeFailed,
			}),
		]
	}
	// A continuation may submit with no note: the run re-runs the prior task (the server stands the prior run's task text in when the body's task is empty). A fresh task still requires text.
	if (task === '' && state.continuation === null) return state
	textarea.value = ''
	// The compose box is the queue's front door (docs/queueing.md "UI interaction model"): a plain add posts to the universal queue and the scheduler dispatches it at once when idle. Only a continuation still needs the run-submission endpoint, whose body is the only one that can carry continuesFrom — so while a run is in flight a continuation stays disabled rather than queueing without its lineage.
	if (state.continuation === null) {
		return [
			{ ...state, createSending: true },
			Fetch({
				url: 'api/queue',
				init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildQueueTaskBody(task, state.runEffort, state.runInvolvement)) },
				ok: GotQueuedTask,
				fail: CreateFailed,
			}),
		]
	}
	return [
		{ ...state, createSending: true },
		Fetch({
			url: 'api/runs',
			init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildRunBody(task, state.runEffort, state.runInvolvement, state.runLogLevel, state.continuation)) },
			ok: GotCreatedRun,
			fail: CreateFailed,
		}),
	]
}

// The queue task body carries the effort and involvement picks; logLevel is deliberately absent — a queue-native item resolves the level through the standard chain at dispatch (docs/queueing.md "The queue: storage, item model, state machine").
function buildQueueTaskBody(task: string, runEffort: EffortLevel | null, runInvolvement: InvolvementLevel | null): { task: string; effort?: EffortLevel; involvement?: InvolvementLevel } {
	const body: { task: string; effort?: EffortLevel; involvement?: InvolvementLevel } = { task }
	if (isEffort(runEffort)) body.effort = runEffort
	if (isInvolvement(runInvolvement)) body.involvement = runInvolvement
	return body
}

// effort, involvement, and logLevel are omitted when their selectors have not yet initialized (settings still loading), so the server applies its resolution chain rather than receiving a null. continuesFrom rides only when the compose screen is in continuation mode; a re-run passes null and submits a plain task.
function buildRunBody(task: string, runEffort: EffortLevel | null, runInvolvement: InvolvementLevel | null, runLogLevel: LogLevel | null, continuation: ContinuationReferenceData | null): { task: string; effort?: EffortLevel; involvement?: InvolvementLevel; logLevel?: LogLevel; continuesFrom?: string } {
	const body: { task: string; effort?: EffortLevel; involvement?: InvolvementLevel; logLevel?: LogLevel; continuesFrom?: string } = { task }
	if (isEffort(runEffort)) body.effort = runEffort
	if (isInvolvement(runInvolvement)) body.involvement = runInvolvement
	if (isLogLevel(runLogLevel)) body.logLevel = runLogLevel
	if (continuation !== null && typeof continuation.runId === 'string' && continuation.runId !== '') body.continuesFrom = continuation.runId
	return body
}

// The resume body carries only the operator's note, and the key is omitted entirely when the note is empty: the server reads an absent, null, or empty note as "no note" (source/web/request-handler.ts parseResumeBody), so an empty object is the cleanest "no note" a JSON body can be.
function buildResumeBody(note: string): { note?: string } {
	return note === '' ? {} : { note }
}

// A re-run is a one-click resubmit of a past run's task; it reuses the create path (POST /api/runs → GotCreatedRun) so the new run is selected and the active-run guard applies identically.
// stopPropagation keeps the click from also triggering the enclosing list entry's select handler; the task is read from the button's data-task attribute so the action stays a stable top-level function (hyperapp passes the DOM event as the payload to a bare-function handler).
function RerunTask(state: ApplicationState, event: MouseEvent): ActionReturn {
	event.stopPropagation()
	if (state.createSending || state.justSubmittedRunId !== null || deriveActiveRunId(state.summaries) !== null) return state
	const target = event.currentTarget
	if (!(target instanceof Element)) return state
	const task = target.getAttribute('data-task')
	if (typeof task !== 'string' || task === '') return state
	return [
		{ ...state, createSending: true },
		Fetch({
			url: 'api/runs',
			init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildRunBody(task, state.runEffort, state.runInvolvement, state.runLogLevel, null)) },
			ok: GotCreatedRun,
			fail: CreateFailed,
		}),
	]
}

// Continue switches the compose screen into continuation mode: a new run will anchor to the finished run's outcome via continuesFrom. Like RerunTask it reads the run id off the button (stopPropagation keeps the row's select handler out of the way), and it shares the re-run button's disabled condition so the one-task-at-a-time contract holds for continuations too. The prior task and terminal result for the reference block are read by selectContinuationReference, which prefers a terminal selected view over a lagging run-list summary for the same id.
function ContinueRun(state: ApplicationState, event: MouseEvent): ApplicationState {
	event.stopPropagation()
	if (state.justSubmittedRunId !== null || state.createSending || state.resumeSending) return state
	const target = event.currentTarget
	if (!(target instanceof Element)) return state
	const runId = target.getAttribute('data-run-id')
	if (typeof runId !== 'string' || runId === '') return state
	const selectedView = state.selectedRunView
	const selectedViewTerminal = selectedView !== null && selectedView.runId === runId && deriveTerminalResult(selectedView) !== undefined
	const activeRunId = deriveActiveRunId(state.summaries)
	// A stale list entry for the just-completed viewed run is not a genuine active run; the selected view's terminal status is the fresher evidence. Any other active id still refuses the continuation.
	if (activeRunId !== null && activeRunId !== runId) return state
	if (activeRunId === runId && !selectedViewTerminal) return state
	const continuation = selectContinuationReference(runId, state.summaries, selectedView)
	if (continuation === null) return state
	return {
		...state,
		screen: 'compose',
		continuation,
		// Continuation and resume are mutually exclusive compose modes: entering one leaves the other.
		resumingRunId: null,
		resumeNotice: null,
		resumeSending: false,
	}
}

function CancelContinuation(state: ApplicationState): ApplicationState {
	return { ...state, continuation: null }
}

// The result modal's Continue affordance: the same continuation hand-off the history row's Continue button drives (ContinueRun reads the run id off the button's data-run-id), plus closing the modal so the compose screen takes over cleanly. When the continuation cannot start (a run in flight, an unknown run) the state is unchanged and the modal stays open.
function ContinueFromResultModal(state: ApplicationState, event: MouseEvent): ApplicationState {
	const next = ContinueRun(state, event)
	if (next === state) return state
	return { ...next, resultModalOpen: false }
}

// The result modal's Resume affordance: closes the modal and switches the compose screen into resume mode for the errored run, where the operator drafts an optional note and submits (the endpoint restarts the same run from its kept checkpoint). Unlike the continuation hand-off it does not consult the one-run-at-a-time guard here — the compose screen disables the form while a run is active, and a 409 that slips through surfaces as the compose notice. stopPropagation keeps the stage's click handler out of the way, mirroring the history row's buttons.
function ResumeFromResultModal(state: ApplicationState, event: MouseEvent): ApplicationState {
	event.stopPropagation()
	const runId = dataAttributeOf(event, 'data-run-id')
	if (runId === null) return state
	return { ...state, screen: 'compose', resultModalOpen: false, resumingRunId: runId, resumeNotice: null, resumeSending: false, continuation: null }
}

// Cancels resume mode. The in-flight flag clears with the mode: a response landing after the cancel finds no resume mode (GotResumedRun bails) and must not leave the form stuck disabled.
function CancelResume(state: ApplicationState): ApplicationState {
	return { ...state, resumingRunId: null, resumeNotice: null, resumeSending: false }
}

function GotCreatedRun(state: ApplicationState, payload: FetchResultPayload): ActionReturn {
	const ok = payload.ok
	const body = payload.body
	// A refused or unreadable create still ends the in-flight window: the guard releases so the operator can retry.
	if (!ok || !isObject(body) || typeof body['runId'] !== 'string') return { ...state, createSending: false }
	const createdRunId = body['runId']
	// Selecting the new run activates its per-run subscription; an immediate run-list fetch clears justSubmittedRunId as soon as the run appears. The continuation and the per-run modal/flow state are reset for the same reason SelectRun resets it — the composed run is on the server now, and a leftover chip would brief a stale lineage into the next task. The live partial clears with the rest (the stream subscription follows the new selection).
	inspectorSession.close()
	const reset = switchRunView(state, createdRunId, null)
	return [
		{ ...reset, continuation: null, justSubmittedRunId: createdRunId, createSending: false, serverAvailable: true },
		Fetch({ url: 'api/runs', ok: GotRunList, fail: FetchFailed }),
	]
}

// A fail action of the create POST's own rather than the shared FetchFailed: only the create's failure may release the in-flight guard — a poll or config fetch failing must not.
function CreateFailed(state: ApplicationState): ApplicationState {
	return { ...state, createSending: false, serverAvailable: false }
}

// The resume landing: a 201 whose body confirms the SAME run id (the endpoint restarts the errored run in place) hands off exactly like GotCreatedRun — the compose screen's resume mode clears, the resumed run is selected onto the watch screen with the per-run view state reset for the switch, and an immediate run-list fetch shows it as the active run.
function GotResumedRun(state: ApplicationState, payload: FetchResultPayload): ActionReturn {
	const resumedRunId = state.resumingRunId
	// The response belongs to the resume mode it was sent from; a cancel mid-flight drops it — the polled run list shows whatever the server actually did.
	if (resumedRunId === null) return state
	if (payload.status === 201) {
		const body = payload.body
		if (isObject(body) && typeof body['runId'] === 'string' && body['runId'] === resumedRunId) {
			inspectorSession.close()
			const reset = switchRunView(state, resumedRunId, null)
			return [
				{ ...reset, resumingRunId: null, resumeSending: false, resumeNotice: null, continuation: null, justSubmittedRunId: resumedRunId, serverAvailable: true },
				Fetch({ url: 'api/runs', ok: GotRunList, fail: FetchFailed }),
			]
		}
		// A 201 that does not confirm the same run id is not a landing to act on: keep the mode (and the note) so the operator can retry, with the oddity said plainly.
		return { ...state, resumeSending: false, resumeNotice: 'The server confirmed the resume but the response could not be read — check History before resuming again.' }
	}
	return { ...state, resumeSending: false, resumeNotice: resumeFailureNotice(payload) }
}

// The compose-screen notice for a refused resume, keyed off the resume endpoint's statuses (source/web/request-handler.ts handleResumeErroredOrSuspendedRun). Network failures never reach here — the fail action (ResumeFailed) covers them.
function resumeFailureNotice(payload: FetchResultPayload): string {
	return resumeFailureCopy(payload.body, payload.status)
}

function ResumeFailed(state: ApplicationState): ApplicationState {
	return { ...state, resumeSending: false, resumeNotice: 'The server could not be reached.', serverAvailable: false }
}

// The direct Resume now path used by the pause card, history rows, and queue rows: no compose note, just the same-run resume POST. A success switches to the resumed run and refreshes both the run list and queue; a typed refusal lands in suspendedActionNotice while both polls refresh the stale state.
function ResumeSuspendedRunNow(runId: string) {
	return function ResumeSuspendedRunNowAction(state: ApplicationState, event: Event): ActionReturn {
		event.stopPropagation()
		if (state.resumeRunPendingId !== null || state.resumeSending || state.createSending) return state
		return [
			{ ...state, resumeRunPendingId: runId, suspendedActionNotice: null },
			Fetch({
				url: `api/runs/${encodeURIComponent(runId)}/resume`,
				init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) },
				ok: GotSuspendedResume(runId),
				fail: SuspendedResumeFailed,
			}),
		]
	}
}

function GotSuspendedResume(runId: string) {
	return function GotSuspendedResumeForRun(state: ApplicationState, payload: FetchResultPayload): ActionReturn {
		const cleared: ApplicationState = { ...state, resumeRunPendingId: null, serverAvailable: true }
		const body = payload.body
		if (payload.status === 201 && isObject(body) && typeof body['runId'] === 'string' && body['runId'] === runId) {
			inspectorSession.close()
			const reset = switchRunView(cleared, runId, null)
			return [
				{ ...reset, suspendedModalOpen: false, suspendedActionNotice: null, continuation: null, resumingRunId: null, resumeSending: false, resumeNotice: null, justSubmittedRunId: runId },
				Fetch({ url: 'api/runs', ok: GotRunList, fail: FetchFailed }),
				Fetch({ url: 'api/queue', ok: GotQueue, fail: FetchFailed }),
			]
		}
		return [
			{ ...cleared, suspendedActionNotice: resumeFailureCopy(payload.body, payload.status) },
			Fetch({ url: 'api/runs', ok: GotRunList, fail: FetchFailed }),
			Fetch({ url: 'api/queue', ok: GotQueue, fail: FetchFailed }),
		]
	}
}

function SuspendedResumeFailed(state: ApplicationState): ActionReturn {
	return [
		{ ...state, resumeRunPendingId: null, suspendedActionNotice: 'The server could not be reached.', serverAvailable: false },
		Fetch({ url: 'api/runs', ok: GotRunList, fail: FetchFailed }),
		Fetch({ url: 'api/queue', ok: GotQueue, fail: FetchFailed }),
	]
}

function DismissSuspendedActionNotice(state: ApplicationState): ApplicationState {
	return { ...state, suspendedActionNotice: null }
}

function SubmitAnswer(questionId: string) {
	return function SubmitAnswerForQuestion(state: ApplicationState, event: Event): ActionReturn {
		event.preventDefault()
		const target = event.target
		if (!(target instanceof HTMLFormElement)) return state
		const textarea = target.querySelector('textarea')
		if (!(textarea instanceof HTMLTextAreaElement)) return state
		const answer = textarea.value
		if (answer === '') return state
		return [
			{ ...state, pendingAnswerId: questionId },
			Fetch({
				url: 'api/answer',
				init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: questionId, answer }) },
				ok: AnswerSent,
				fail: AnswerFailed,
			}),
		]
	}
}

function AnswerSent(state: ApplicationState): ActionReturn {
	// Refresh the pending list immediately so the answered question disappears without waiting for the next tick. An answered question ends a `needs_clarification` wait, which is a terminal status that deactivated the per-run poll; resetting the status to the non-terminal 'unknown' reactivates that poll so the run view and flow model resume as the run continues, and completion can later fire the result modal. The next poll repopulates the real status from the run's meta.
	const reactivated: ApplicationState = { ...state, pendingAnswerId: null, selectedRunStatus: 'unknown', serverAvailable: true }
	return [reactivated, Fetch({ url: 'api/questions', ok: GotQuestions, fail: FetchFailed })]
}

function AnswerFailed(state: ApplicationState): ApplicationState {
	return { ...state, pendingAnswerId: null, serverAvailable: false }
}

// --- Interrupt form ----------------------------------------------------------
// The operator can speak into the active run at its next safe point: an inquiry asks the run a direct question; a plan modification aborts the active sub-work and re-plans from the top-level planner. The form targets the selected run only while it is the active one, mirroring the server-side 409 contract.

function SetInterruptMode(state: ApplicationState, mode: unknown): ApplicationState {
	if (mode !== 'inquiry' && mode !== 'plan_modification') return state
	return { ...state, interruptMode: mode }
}

function SubmitInterrupt(state: ApplicationState, event: Event): ActionReturn {
	event.preventDefault()
	const runId = state.selectedRunId
	if (typeof runId !== 'string' || runId === '') return state
	const target = event.target
	if (!(target instanceof HTMLFormElement)) return state
	const textarea = target.querySelector('textarea')
	if (!(textarea instanceof HTMLTextAreaElement)) return state
	const message = textarea.value.trim()
	if (message === '') return state
	textarea.value = ''
	return [
		{ ...state, interruptSending: true, interruptNotice: null },
		Fetch({
			url: `api/runs/${encodeURIComponent(runId)}/interrupt`,
			init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: state.interruptMode, message }) },
			ok: InterruptResponded,
			fail: InterruptFailed,
		}),
	]
}

function InterruptResponded(state: ApplicationState, payload: FetchResultPayload): ApplicationState {
	if (payload.status === 202) {
		return { ...state, interruptSending: false, interruptNotice: 'Interrupt sent — it lands at the run\u2019s next safe point; the response appears in the Interrupts list.' }
	}
	if (payload.status === 409) {
		return { ...state, interruptSending: false, interruptNotice: 'The run is no longer active — the interrupt was not sent.' }
	}
	return { ...state, interruptSending: false, interruptNotice: 'The interrupt was rejected.' }
}

function InterruptFailed(state: ApplicationState): ApplicationState {
	return { ...state, interruptSending: false, interruptNotice: 'The server could not be reached.', serverAvailable: false }
}

function PrimeAudio(state: ApplicationState): ActionReturn {
	return [state, PrimeAudioFx()]
}

// --- Flow / Sequence view controls ----------------------------------------
// The centerpiece's view-mode (Flow vs Sequence) and label tier are pure view state; a swap re-renders the views through the same resolver and model without fetching. The modals are view-side state layered on the live model: the result modal opens on completion (GotSelectedRun) or the flow view's CTA, the question modal opens on a new pending question (GotQuestions) or the flow view's Question affordance.

function SetFlowViewMode(state: ApplicationState, mode: unknown): ActionReturn {
	if (mode !== 'flow' && mode !== 'sequence') return state
	// Switching modes mounts or unmounts the sequence container, so the swap also syncs its scroll follower (attaching fresh, pinned to the bottom).
	return [{ ...state, flowViewMode: mode }, SyncSequenceFollower()]
}

function ChangeFlowTier(state: ApplicationState, event: Event): ApplicationState {
	const target = event.target
	if (!(target instanceof HTMLSelectElement) && !(target instanceof HTMLInputElement)) return state
	const value = target.value
	if (!isLabelTier(value)) return state
	return { ...state, flowTier: value }
}

// The sequence view's roles-only lens (see interaction-model.js rolesOnlyModel): a checkbox next to the flow/sequence controls that filters the sequence render down to the agent roles plus the human. Pure view state — the full model stays the single source the other surfaces (now caption, cost strip, flow view) read, so toggling only re-renders the sequence view.
function SetSequenceRolesOnly(state: ApplicationState, event: Event): ApplicationState {
	const target = event.target
	if (!(target instanceof HTMLInputElement)) return state
	return { ...state, sequenceRolesOnly: target.checked }
}

// --- Screen navigation ------------------------------------------------------
// The page is a single-screen console: one of three screens (watch / history / compose) fills the viewport below the top bar. The screen is stored view state; nothing here fetches.

function SetScreen(state: ApplicationState, screen: unknown): ActionReturn {
	if (screen !== 'watch' && screen !== 'history' && screen !== 'compose') return state
	// Leaving the watch screen unmounts the sequence container (the follower must detach) and returning to it remounts a fresh one; the swap syncs the follower either way.
	// Modal state is deliberately kept alive across the swap: returning to watch restores the session's modal state (an open inspector, its loaded window and scope) instead of a fresh view. The unmounted inspector body detaches its follower the same way, and returning to watch re-attaches it pinned.
	return [{ ...state, screen }, SyncSequenceFollower(), SyncInspectorFollower()]
}

// The merged history screen keys one expansion map for both row kinds: a run id or a queue item id.
function ToggleRowExpanded(state: ApplicationState, rowId: unknown): ApplicationState {
	if (typeof rowId !== 'string' || rowId === '') return state
	return { ...state, expandedRowIds: { ...state.expandedRowIds, [rowId]: state.expandedRowIds[rowId] !== true } }
}

// The plan disclosure is per-view state (only the selected run's plan is rendered), so a single boolean reset on run switch is enough; the poll replacing the run view must not collapse it.
function TogglePlanExpanded(state: ApplicationState): ApplicationState {
	return { ...state, planExpanded: state.planExpanded !== true }
}

function OpenInterruptModal(state: ApplicationState): ActionReturn {
	return [{ ...state, interruptModalOpen: true, tooltip: null }, CancelTooltipDismiss()]
}

function CloseInterruptModal(state: ApplicationState): ApplicationState {
	return { ...state, interruptModalOpen: false }
}

function DismissInterruptAnswer(state: ApplicationState): ApplicationState {
	return { ...state, interruptAnswerCard: null }
}

function OpenResultModal(state: ApplicationState): ActionReturn {
	// The modal already presents this selection's result (or its loading state); a repeated CTA click must not stack another fetch.
	if (state.resultModalOpen) return state
	const current: ApplicationState = state.suspendedModalOpen ? { ...state, suspendedModalOpen: false } : state
	const plan = planResultOpen(current.selectedRunId, current.selectedRunView, current.summaries, current.resultLoad)
	if (plan === null) return current
	if (plan.kind === 'immediate') {
		const effects: EffectItem[] = [CancelTooltipDismiss()]
		if (plan.backgroundFetch && plan.resultLoad !== null) effects.push(Fetch({ url: runViewUrl(plan.resultLoad.runId), init: { cache: 'no-store' }, ok: GotResultView(plan.resultLoad.runId), fail: ResultViewFailed(plan.resultLoad.runId) }))
		// A modal opening covers the run view; clear the inspector so the card does not linger beneath it.
		return [{ ...current, resultModalOpen: true, resultLoad: plan.resultLoad, tooltip: null }, ...effects]
	}
	const effects: EffectItem[] = [CancelTooltipDismiss()]
	if (plan.kind === 'fetch') effects.push(Fetch({ url: runViewUrl(plan.resultLoad.runId), init: { cache: 'no-store' }, ok: GotResultView(plan.resultLoad.runId), fail: ResultViewFailed(plan.resultLoad.runId) }))
	return [{ ...current, resultModalOpen: true, resultLoad: plan.resultLoad, tooltip: null }, ...effects]
}

// The on-demand full-view fetch behind the pending result modal: an unreadable or failed response parks the modal in its retryable failed phase, and a readable one fills the view state the terminal descriptor is derived from. A non-terminal body keeps the modal waiting, because the summary that opened it was terminal but the view has not caught up yet.
function GotResultView(runId: string) {
	return function GotResultViewForRun(state: ApplicationState, payload: FetchResultPayload): ActionReturn {
		if (!responseBelongsToSelection(runId, state.selectedRunId)) return state
		const body = payload.body
		if (!payload.ok || body === null || !isReadableRunView(body)) {
			return { ...state, serverAvailable: payload.ok, resultLoad: { runId, phase: 'failed' } }
		}
		if (!acceptedResultView(runId, state.selectedRunId, body.runId)) return state
		const terminal = deriveTerminalResult(body) !== undefined
		return { ...state, selectedRunView: body, selectedRunStatus: body.status, serverAvailable: true, versions: recordVersion(state.versions, payload), resultLoad: terminal ? null : state.resultLoad }
	}
}

function ResultViewFailed(runId: string) {
	return function ResultViewFailedForRun(state: ApplicationState): ApplicationState {
		if (!responseBelongsToSelection(runId, state.selectedRunId)) return state
		return { ...state, serverAvailable: false, resultLoad: { runId, phase: 'failed' } }
	}
}

// Retry from the failed pending modal: the same unconditional fetch, skipped while the same run is already loading so repeated clicks collapse into one request.
function RetryResultLoad(state: ApplicationState): ActionReturn {
	const plan = planResultRetry(state.selectedRunId, state.resultLoad)
	if (plan.kind === 'noop') return state
	return [
		{ ...state, resultLoad: plan.resultLoad },
		Fetch({ url: runViewUrl(plan.resultLoad.runId), init: { cache: 'no-store' }, ok: GotResultView(plan.resultLoad.runId), fail: ResultViewFailed(plan.resultLoad.runId) }),
	]
}

function CloseResultModal(state: ApplicationState): ApplicationState {
	return { ...state, resultModalOpen: false, resultLoad: null }
}

// The pause card is a separate surface from the result modal: a suspended run has no result descriptor, so its CTA opens this card instead. Opening it covers the run view and clears the inspector like the other overlays.
function OpenSuspendedModal(state: ApplicationState): ActionReturn {
	return [{ ...state, suspendedModalOpen: true, resultModalOpen: false, resultLoad: null, suspendedActionNotice: null, tooltip: null }, CancelTooltipDismiss()]
}

function CloseSuspendedModal(state: ApplicationState): ApplicationState {
	return { ...state, suspendedModalOpen: false }
}

function OpenQuestionModal(state: ApplicationState): ActionReturn {
	return [{ ...state, questionModalOpen: true, tooltip: null }, CancelTooltipDismiss()]
}

function CloseQuestionModal(state: ApplicationState): ApplicationState {
	return { ...state, questionModalOpen: false }
}

// Opens the app-shell question modal for a parked queue item. The id is stored unvalidated; the render finds the item and gates on its needs_input status, so a stale id renders nothing rather than a modal for a settled item.
function OpenQueueQuestion(state: ApplicationState, itemId: unknown): ApplicationState {
	if (typeof itemId !== 'string' || itemId === '') return state
	return { ...state, openQueueQuestionId: itemId }
}

function CloseQueueQuestion(state: ApplicationState): ApplicationState {
	return { ...state, openQueueQuestionId: null }
}

// The watch screen's terminal CTA for a parked run: a needs_clarification run's question is its result summary and lives on the queue item, so the Respond button opens that item's answer modal when one matches the selected run. A run with no matching queue item (or a different terminal status) falls back to the result modal, which is where the CTA historically led.
function OpenParkedQuestion(state: ApplicationState): ActionReturn {
	const runId = state.selectedRunId
	if (typeof runId === 'string' && runId !== '') {
		const parked = state.queueItems.find((item) => matchesParkedRun(item, runId))
		if (parked !== undefined) return [{ ...state, openQueueQuestionId: parked.id, tooltip: null }, CancelTooltipDismiss()]
	}
	return OpenResultModal(state)
}

// --- Run-view inspector (hover) --------------------------------------------
// The inspector card over the flow and sequence SVGs is a hyperapp-managed overlay (the same pattern the question/result modals follow), not an imperative DOM append: hovering a node or edge stores a tooltip descriptor in state (the target kind+id plus a snapshot of the node's viewport rect), the watch stage renders the `Tooltip` card vnode anchored to that rect by `tooltipStyle`, and dismissal runs on a short grace timer so the operator can move the pointer from the node into the card to select or copy its contents (the card is `pointer-events: auto`, `user-select: text`). The card stays open while the pointer is over the node or the card; it dismisses once the pointer is over neither. The handlers read the hovered element's `data-operation` / `data-participant` / `data-role` off the live `state.flowModel` and `state.labelResolver` (resolved at render time), so the inspector never re-fetches and never invents content the model does not carry.

// The grace-period dismiss timer, shared with the dev harness via inspector.js. Expiry dispatches the ClearTooltip action; the factory closes over the raw timer, which is an opaque resource with no place in the view state.
const tooltipDismiss = createTooltipDismiss()

function runScheduleTooltipDismiss(dispatch: Dispatch): void {
	tooltipDismiss.schedule(() => dispatch(ClearTooltip))
}

function ScheduleTooltipDismiss(): NullPayloadEffect {
	return [runScheduleTooltipDismiss, null]
}

function runCancelTooltipDismiss(): void {
	tooltipDismiss.cancel()
}

function CancelTooltipDismiss(): NullPayloadEffect {
	return [runCancelTooltipDismiss, null]
}

// Dispatched by the grace timer. A no-op when the tooltip is already cleared (e.g. the pointer moved to another node and switched, or a modal open cleared it) so a stale timer firing causes no harm.
function ClearTooltip(state: ApplicationState): ApplicationState {
	return state.tooltip === null ? state : { ...state, tooltip: null }
}

// The details fetches a hovered target's card may show: the controller marks each uncached id 'loading' synchronously so the first render reads a defined state, and each id it began becomes one fetch effect (empty when every id is already cached or there is no selected run to fetch against).
function fetchOperationDetails(state: ApplicationState, target: TooltipTarget): FetchEffect[] {
	const runId = state.selectedRunId
	if (typeof runId !== 'string' || runId === '' || state.flowModel === null) return []
	const effects: FetchEffect[] = []
	for (const operationId of operationDetails.begin(runId, operationIdsForTooltipDetails(state.flowModel, target))) {
		effects.push(Fetch({ url: `api/runs/${encodeURIComponent(runId)}/flow?operation=${encodeURIComponent(operationId)}`, ok: GotOperationDetails(runId, operationId), fail: OperationDetailsFailed(runId, operationId) }))
	}
	return effects
}

// The details fetch for one operation resolved: the controller records the server's answer and the fresh state is returned so an open card fills in. A ready body caches the details string (or null when the operation carries none); anything else — a 404 for an id the model no longer resolves, a malformed body, a network failure — caches 'failed', which renders the card section-less.
function GotOperationDetails(runId: string, operationId: string) {
	return function GotOperationDetailsForOperation(state: ApplicationState, payload: FetchResultPayload): ApplicationState {
		operationDetails.recordResponse(runId, operationId, payload.ok, payload.body)
		return { ...state }
	}
}

function OperationDetailsFailed(runId: string, operationId: string) {
	return function OperationDetailsFailedForRun(state: ApplicationState): ApplicationState {
		operationDetails.recordFailure(runId, operationId)
		return { ...state }
	}
}

// `mouseover` bubbles from every SVG child the pointer enters, so this fires on each element crossing. Three cases:
//  - over the card itself: keep it open and cancel any pending dismiss (the pointer entered the card to select/copy).
//  - over a node/edge target: switch the card to it (canceling any pending dismiss), snapshotting its rect so the card anchors to the node. Returning the same state when the target is unchanged lets hyperapp bail without a re-render. The target's details are fetched here if not cached (the derivation reads them through the session cache once they land).
//  - over empty run-view area: schedule a grace-period dismiss — if the pointer reaches the card (or a new node) before it fires, the dismiss is canceled; otherwise the card dismisses once the pointer is over neither.
function HoverRunView(state: ApplicationState, event: MouseEvent): ActionReturn {
	if (event.target instanceof Element && event.target.closest('.tooltip-card') !== null) {
		return [state, CancelTooltipDismiss()]
	}
	const target = resolveTooltipTarget(event)
	if (target === null) {
		if (state.tooltip === null) return [state, CancelTooltipDismiss()]
		return [state, ScheduleTooltipDismiss()]
	}
	const current = state.tooltip
	if (current !== null && current.kind === target.kind && current.id === target.id) {
		return [state, CancelTooltipDismiss()]
	}
	return [{ ...state, tooltip: { kind: target.kind, id: target.id, rect: target.rect } }, CancelTooltipDismiss(), ...fetchOperationDetails(state, target)]
}

// `mouseleave` on the run-view stage fires when the pointer leaves the stage entirely (the SVG and the card are both descendants of the stage, so moving between them does not fire it). A grace period lets the pointer re-enter quickly without a dismiss+reopen flicker; otherwise it clears the card.
function LeaveRunView(state: ApplicationState): ActionReturn {
	if (state.tooltip === null) return [state, CancelTooltipDismiss()]
	return [state, ScheduleTooltipDismiss()]
}

// Clicking an in-flight `ask_human` row re-opens the question modal: the sequence view has no Question-button overlay like the flow view, so the message row itself is the re-entry affordance after a dismiss. A click on an agent's node/slot/message is the drill-in: it opens the inspector modal pre-scoped to that instance (resolveInspectorScope maps the clicked target to the instance id the modal scopes to), and the modal open clears the tooltip so the card does not linger over it.
// Every other click — human/tool/interrupt targets, unknown ids — falls through to the hover path so the click still opens the inspector card at the clicked node, mirroring the dev harness. Hover keeps showing the card exactly as before; the drill-in is the click's job.
// Clicking inside the card (to select text or press a copy affordance) falls through to the hover path's "over the card" branch, which keeps the card open.
function ClickRunView(state: ApplicationState, event: MouseEvent): ActionReturn {
	if (event.target instanceof Element && event.target.closest('.tooltip-card') !== null) {
		return HoverRunView(state, event)
	}
	const target = resolveTooltipTarget(event)
	if (target !== null && target.kind === 'operation' && state.flowModel !== null && isInFlightAskHuman(state.flowModel, target.id)) {
		// Open the modal and dismiss the inspector so the card does not linger over the modal.
		return [{ ...state, questionModalOpen: true, tooltip: null }, CancelTooltipDismiss()]
	}
	if (target !== null && state.flowModel !== null) {
		const scopeId = resolveInspectorScope(state.flowModel, target)
		if (scopeId !== null) return OpenInspectorModal(state, scopeId)
	}
	return HoverRunView(state, event)
}

// --- LLM turn inspector (modal) ---------------------------------------------
// The stage-controls "Inspect" button opens a modal over the run view that renders one agent instance's LLM turns as a continuous transcript (the per-instance-scoped transcript), derived straight from the windowed log endpoint's `llm_call` payloads — the story needs no per-turn detail fetches; each completed turn's collapsed "on the wire" expander separately fetches the turn's full folded request from the same endpoint's `?detail=` variant, once per session into the session's bounded wire cache. The session owns the explicit scope (null = auto — the most recently active instance in the loaded window), and the breadcrumb, instance dropdown, and each `agent` call's View affordance re-scope it. The data flow is plain effects and state: the log loads with a single cheap probe (`?limit=1`) that learns the log's `total`, then fetches the most recent window; "older turns" pages back; while the modal is open on an active run the 1s poll appends the log's tail so in-flight turns appear when they complete and the live partial swaps for the completed turn. A scope change fetches that instance's server-filtered window (`?instance=<roleId>`) into a per-scope window keyed by the scoped role id — the server sees the whole log, so the scope's own turns and its complete ancestor chain (the breadcrumb) load without paging back through the unscoped tail — while the unscoped tail window stays for the instance dropdown's wayfinding and the default scope.

// One windowed-log landing: the session updates its window and returns any follow-up request (probe → window, gapped tail → resync) plus the live partial as the pairing leaves it. Every accepted landing also re-pins the transcript follower, so the initial window, an older splice, and a tail append all follow their new content in addition to the live-delta, wire-detail, open, and close syncs. A stale or ignored response leaves the app state untouched.
function InspectorFetch(request: FetchRequest, pollKey?: PollKey): FetchEffect {
	return Fetch({ url: request.url, ok: InspectorLanded(request), fail: InspectorFetchFailed(request), pollKey })
}

function InspectorLanded(request: FetchRequest) {
	return function InspectorLandedForRequest(state: ApplicationState, payload: FetchResultPayload): ActionReturn {
		if (request.kind === 'tail' && !state.inspectorModalOpen) return state
		const result = inspectorSession.receive(request, payload.ok ? payload.body : null, state.livePartial)
		const effects: OptionalEffect[] = []
		if (result.followUp !== null) effects.push(InspectorFetch(result.followUp))
		if (result.status === 'ignored') return effects.length > 0 ? [state, ...effects] : state
		let serverAvailable = state.serverAvailable
		if (result.status === 'accepted') {
			serverAvailable = true
			effects.push(SyncInspectorFollower())
		} else if (request.kind === 'probe' || request.kind === 'window') {
			serverAvailable = payload.ok
		}
		const nextState = { ...state, livePartial: result.livePartial, serverAvailable }
		return effects.length > 0 ? [nextState, ...effects] : nextState
	}
}

function InspectorFetchFailed(request: FetchRequest) {
	return function InspectorFetchFailedForRequest(state: ApplicationState): ApplicationState {
		inspectorSession.fail(request)
		return { ...state, serverAvailable: false }
	}
}

// Opens the inspector modal over the run view. `payload` pre-scopes the transcript to an instance id (the view click-through's drill-in; a plain string) or is absent/event-shaped (the stage-controls button), which leaves the scope unset so the modal opens on the most recently active instance. A pre-scoped open loads both windows in parallel: the scoped instance's server-filtered window (the probe learns the FILTERED total so the transcript opens on the most recent window of the instance's own sequence — an old agent's turns load without paging back through the whole log) and the unscoped tail (the instance dropdown's wayfinding). Opening mounts the modal's transcript body, so the open also syncs its scroll follower (attaching fresh, pinned to the bottom).
function OpenInspectorModal(state: ApplicationState, payload: unknown): ActionReturn {
	if (typeof state.selectedRunId !== 'string' || state.selectedRunId === '') return state
	const scopedRoleId = typeof payload === 'string' && payload !== '' ? payload : null
	const effects: OptionalEffect[] = [CancelTooltipDismiss(), SyncInspectorFollower()]
	const unscopedProbe = inspectorSession.start(state.selectedRunId)
	if (unscopedProbe !== null) effects.push(InspectorFetch(unscopedProbe))
	if (scopedRoleId !== null) {
		const scoped = inspectorSession.scope(scopedRoleId)
		if (scoped.request !== null) effects.push(InspectorFetch(scoped.request))
	}
	return [{ ...state, inspectorModalOpen: true, tooltip: null }, ...effects]
}

function CloseInspectorModal(state: ApplicationState): ActionReturn {
	// Closing ends the inspection session (scope, per-scope windows, and loaded windows with it): reopening refetches from scratch, so no stale scope survives the close. A hung tail request is cancelled with it so its guard cannot skip the next session's first refresh; the sync detaches the transcript follower the unmounted body leaves behind.
	pollFetcher.cancel(POLL_KEY_INSPECTOR_TAIL)
	inspectorSession.close()
	return [{ ...state, inspectorModalOpen: false }, SyncInspectorFollower()]
}

function LoadOlderTurns(state: ApplicationState): ActionReturn {
	const request = inspectorSession.olderRequest()
	if (request === null) return state
	return [{ ...state }, InspectorFetch(request)]
}

// The poll piggyback: one windowed fetch from the ACTIVE scope's loaded window's end (the scoped instance's filtered sequence when explicitly scoped, else the unscoped tail). A null effect while the modal is closed, the active window has not loaded, or no run is selected — hyperapp ignores falsy effects.
function InspectorTailRefresh(state: ApplicationState): OptionalEffect {
	if (!state.inspectorModalOpen) return null
	const request = inspectorSession.tailRequest()
	if (request === null) return null
	return InspectorFetch(request, POLL_KEY_INSPECTOR_TAIL)
}

// Re-scopes the transcript to an instance. A first scope to an instance fetches its server-filtered window (the probe learns the filtered total, then the most recent window of the instance's own sequence loads), so the breadcrumb chain derives from the full log's ancestry and an old agent's turns load without paging back; an already-loaded scope is reused as-is (the poll's scoped tail refresh keeps a live run's window current) and a failed scope retries after leaving and returning. Setting the scope pushes the crumb on, and the ↑ parent affordance pops back.
function scopeInspectorTo(state: ApplicationState, roleId: string): ActionReturn {
	const result = inspectorSession.scope(roleId)
	if (!result.changed) return state
	if (result.request === null) return { ...state }
	return [{ ...state }, InspectorFetch(result.request)]
}

// The selected value off a change event, or null when it does not carry a usable one. The event arrives untyped through the modal's wiring, so the target and its value are read behind record guards.
function eventTargetValue(event: unknown): string | null {
	if (!isObject(event)) return null
	const target = event['target']
	if (!isObject(target)) return null
	const value = target['value']
	return typeof value === 'string' && value !== '' ? value : null
}

// The breadcrumb crumbs, the parent affordance, and an agent call's View control pass the instance id directly; the instance dropdown passes the change event. All re-scope the transcript.
function ScopeInspectorInstance(state: ApplicationState, payload: unknown): ActionReturn {
	if (state.inspectorModalOpen !== true) return state
	const roleId = typeof payload === 'string' && payload !== '' ? payload : eventTargetValue(payload)
	if (roleId === null) return state
	return scopeInspectorTo(state, roleId)
}

// Whether a `<details>` toggle event reports the expander opening (vs collapsing) — the wire expander fetches on open only. The event arrives untyped through the modal's wiring, so the target is read behind record guards.
function toggleOpened(event: unknown): boolean {
	if (!isObject(event)) return false
	const target = event['target']
	if (!isObject(target)) return false
	return target['open'] === true
}

// A turn's "on the wire" expander opened: fetch its folded request sections once into the session cache (a cached turn — loading or ready — fetches nothing). The modal wires the action curried with the turn's event index, because the toggle event cannot carry it. Closing touches nothing; re-opening after a failed fetch (the cache evicted it) re-fetches.
function ToggleWireDetail(eventIndex: number) {
	return function ToggleWireDetailForTurn(state: ApplicationState, event: unknown): ActionReturn {
		if (state.inspectorModalOpen !== true) return state
		if (!toggleOpened(event)) return state
		const request = inspectorSession.wireRequest(eventIndex)
		if (request === null) return state
		return [{ ...state }, Fetch({ url: request.url, ok: WireDetailLoaded(request), fail: WireDetailFailed(request) })]
	}
}

// The wire fetch resolved: a body carrying `detailSections` (array or explicit null) caches ready; anything else evicts so re-opening retries. Fresh state re-renders the open expander in place (its fetched sections grow the transcript, so the sync keeps a pinned view at the bottom); a response landing after the modal closed only updates the cache.
function WireDetailLoaded(request: WireFetchRequest) {
	return function WireDetailLoadedForTurn(state: ApplicationState, payload: FetchResultPayload): ActionReturn {
		inspectorSession.receiveWire(request, payload.ok, payload.body)
		return state.inspectorModalOpen === true ? [{ ...state }, SyncInspectorFollower()] : state
	}
}

function WireDetailFailed(request: WireFetchRequest) {
	return function WireDetailFailedForTurn(state: ApplicationState): ApplicationState {
		inspectorSession.failWire(request)
		return state.inspectorModalOpen === true ? { ...state } : state
	}
}

// The inspector modal as the watch screen mounts it: the session derives the entire view (transcript, wayfinding instances, breadcrumb chain, paging flags, wire cache lookups) from the active scope's window, and the renderer builds vnodes from it. The turns prop the old host assembled is gone: the module hides the raw windows and their offsets.
function InspectorModalForRun(state: ApplicationState): Vnode | null {
	if (!state.inspectorModalOpen) return null
	const runId = state.selectedRunId
	const liveStreamDisconnected = hasPollableSelectedRun(state) && state.streamWasConnectedOnce && !state.streamConnected
	return InspectorModal(h, {
		runLabel: typeof runId === 'string' ? runId : null,
		view: inspectorSession.view(),
		livePartial: state.livePartial,
		liveStreamDisconnected,
		renderMarkdown,
		onToggleWire: ToggleWireDetail,
		onScopeInstance: ScopeInspectorInstance,
		onLoadOlder: LoadOlderTurns,
		onClose: CloseInspectorModal,
	})
}

// --- Live token stream (enhancement) ----------------------------------------
// The websocket deltas fold into `livePartial` — the ephemeral in-flight partial the inspector modal renders under the matching in-flight row. The polled run log stays the sole authority for turn history and run state; this only feeds live text, and every path that could leave the partial stale clears it.

function GotLiveDelta(state: ApplicationState, delta: StreamDeltaMessage): ActionReturn {
	// Deltas flow only for the active run; a historical selection (or no selection) ignores them. Each delta grows the modal's in-flight section, so the transcript follower syncs with the partial too (a no-op while the modal is closed — the sync finds no body element).
	if (state.selectedRunId === null || delta.runId !== state.selectedRunId) return state
	return [{ ...state, livePartial: nextLivePartial(state.livePartial, delta) }, SyncInspectorFollower()]
}

// Socket phase changes clear the partial. On a disconnect the text is stale (and would otherwise linger under the in-flight row); on a fresh connect the accumulation starts empty because deltas resume mid-turn with the middle lost, and showing a gapped text as if continuous would be wrong. Only live partial text is ever lost — the polled log is untouched, and no error surface exists anywhere. The phase also drives the inspector's reconnect indicator.
function GotStreamState(state: ApplicationState, phase: 'connected' | 'disconnected'): ApplicationState {
	if (phase !== 'connected' && phase !== 'disconnected') return state
	const streamConnected = phase === 'connected'
	const streamWasConnectedOnce = state.streamWasConnectedOnce || streamConnected
	if (state.livePartial === null && state.streamConnected === streamConnected && state.streamWasConnectedOnce === streamWasConnectedOnce) return state
	return { ...state, livePartial: null, streamConnected, streamWasConnectedOnce }
}

// Hyperapp starts a replacement subscriber before calling the previous teardown. The generation token keeps that teardown from unsubscribing the connection the new subscriber just opened; only the current generation's teardown (leaving Watch, a terminal run, or an unmount) closes the socket.
let streamSubscriptionGeneration = 0

// The stream subscription is mounted only while the watch screen shows a selected, non-terminal run (the same non-terminal guard the polling subscription uses). The payload's runId is the only field that changes, so hyperapp restarts the subscription exactly when the selected run changes, and each start re-subscribes (the server replaces the previous subscription). Teardown unsubscribes only when it is still the newest subscription: leaving Watch or the run becoming terminal closes the socket, and returning reconnects through a fresh subscribe, so a background connection is never kept open for a screen that cannot show live text.
function streamSubscriber(dispatch: Dispatch, payload: { runId: string }): () => void {
	const generation = ++streamSubscriptionGeneration
	if (streamClient === null) {
		streamClient = createStreamClient({
			url: streamSocketUrl(),
			onDelta: (delta) => dispatch(GotLiveDelta, delta),
			onStateChange: (phase) => dispatch(GotStreamState, phase),
		})
	}
	streamClient.subscribe(payload.runId)
	// hyperapp's patchSubs calls the old subscriber's return value on every restart, so a teardown function must always be returned.
	return () => {
		if (generation !== streamSubscriptionGeneration) return
		if (streamClient !== null) streamClient.unsubscribe()
	}
}

function StreamSubscription(runId: string): [typeof streamSubscriber, { runId: string }] {
	return [streamSubscriber, { runId }]
}

// --- View ------------------------------------------------------------------

// The top bar's live status read: a server-unavailable warning, a clickable "a run is in progress" jump when nothing is selected, the viewed run's status, and a secondary jump pill when the user is browsing a historical run while another is live.
function StatusPills(state: ApplicationState): Vnode[] {
	const activeRunId = deriveActiveRunId(state.summaries)
	if (!state.serverAvailable) {
		return [h('span', { class: 'status-pill status-pill-warn' }, SERVER_UNAVAILABLE_MESSAGE)]
	}
	if (state.selectedRunId === null) {
		if (activeRunId !== null) {
			return [h('span', { class: 'status-pill status-pill-live status-pill-clickable', onclick: [SelectRun, activeRunId] }, 'a run is in progress — view')]
		}
		const message = state.summaries.length === 0 ? 'idle' : 'no run selected'
		return [h('span', { class: 'status-pill' }, message)]
	}
	const pills = [h('span', { class: `status-pill status-pill-${state.selectedRunStatus ?? 'unknown'}` }, statusLabel(state.selectedRunStatus))]
	if (activeRunId !== null && activeRunId !== state.selectedRunId) {
		pills.push(h('span', { class: 'status-pill status-pill-live status-pill-clickable', onclick: [SelectRun, activeRunId] }, 'a run is in progress — view'))
	}
	return pills
}

// The viewed run's identity in the top bar: its task's first line as the primary read, with the run id, effort, involvement, and relative start as microcopy. Everything here is a machine field or the operator's own task text rendered as textContent.
function ViewedRunLabel(state: ApplicationState): Vnode | null {
	const summary = state.summaries.find((entry) => entry.runId === state.selectedRunId)
	if (summary === undefined) return null
	const metaParts = [summary.runId]
	if (isEffort(summary.effort)) metaParts.push(`effort ${effortLabel(summary.effort)}`)
	if (isInvolvement(summary.involvement)) metaParts.push(`involvement ${involvementLabel(summary.involvement)}`)
	metaParts.push(`started ${formatRelative(summary.startTime, state.now)}`)
	return h('span', { class: 'topbar-run' }, [
		h('span', { class: 'topbar-run-primary' }, runPrimaryLabel(summary)),
		h('span', { class: 'topbar-run-meta' }, metaParts.join(' · ')),
	])
}

// The serving image's build identifier, the least urgent thing in the bar: a faint version stamp (short sha + built date) after the nav. Nothing renders when build info is absent or formats to an empty label — running from source without a baked build-info.json has nothing to stamp.
function BuildLabel(build: BuildInfo | null): Vnode | null {
	if (build === null) return null
	const label = formatBuildLabel(build)
	if (label === '') return null
	return h('span', { class: 'topbar-build', title: `Built ${build.builtAt}` }, label)
}

function TopBar(state: ApplicationState): Vnode {
	const backlog = backlogCount(state.queueItems)
	return h('header', { class: 'topbar' }, [
		h('span', { class: 'topbar-wordmark' }, 'Adaptive Orchestrator'),
		...StatusPills(state),
		state.flowRefreshPending && state.screen === 'watch'
			? h('span', { class: 'status-pill status-pill-refreshing' }, [LoadingIndicator(h, 'Refreshing run view…')])
			: null,
		ViewedRunLabel(state),
		h('nav', { class: 'topbar-nav' }, [
			// The compose screen is always reachable: with the queue universal, adding a task while a run is in flight queues it for its turn instead of being refused (docs/queueing.md "UI interaction model").
			h('button', { type: 'button', class: { 'nav-button': true, 'is-active': state.screen === 'compose' }, title: 'Add a task to the queue', onclick: [SetScreen, 'compose'] }, 'Add task'),
			h('button', { type: 'button', class: { 'nav-button': true, 'is-active': state.screen === 'history' }, title: 'Browse past runs and the task queue', onclick: [SetScreen, 'history'] }, [
				`History (${state.summaries.length})`,
				backlog > 0 ? h('span', { class: 'nav-badge', title: `${backlog} task${backlog === 1 ? '' : 's'} queued` }, String(backlog)) : null,
			]),
			h('label', { class: 'mute-toggle', title: 'Mute the alert sound for incoming questions' }, [
				h('input', { type: 'checkbox', checked: state.muted, onchange: ToggleMute }),
				'mute',
			]),
		]),
		BuildLabel(state.build),
	])
}

// The persistent provider-health banner rides the run-list feed's health singleton, so it appears above every screen without a second poll. The derivation renders fixed copy only; no provider endpoint, credential, model, header, request, or body reaches the DOM.
function ProviderHealthBannerForState(state: ApplicationState): Vnode | null {
	const health = state.providerHealth ?? (state.selectedRunView === null ? null : state.selectedRunView.providerHealth)
	const descriptor = deriveHealthBanner(health)
	if (descriptor === null) return null
	return HealthBanner(h, { descriptor })
}

// The typed resume/terminate refusal surface. It sits above the content so a failure from the pause card, a history row, or a queue row is visible wherever the operator acted; Dismiss clears it.
function SuspendedActionNoticeForState(state: ApplicationState): Vnode | null {
	const notice = state.suspendedActionNotice
	if (typeof notice !== 'string' || notice === '') return null
	return h('div', { class: 'suspended-action-notice', role: 'alert' }, [
		h('span', { class: 'suspended-action-notice-text' }, notice),
		h('button', { type: 'button', class: 'suspended-action-notice-dismiss', title: 'Dismiss this notice', onclick: DismissSuspendedActionNotice }, 'Dismiss'),
	])
}

// The compact lineage badge in a row's title line, and the fuller line in its expanded details. Both select the parent run without also triggering the row's own select/open handler.
function lineageTitle(link: LineageLink): string {
	return `Continues run ${link.runId} — ${link.label}`
}

function LineageBadge(link: LineageLink): Vnode {
	if (!link.available) return h('span', { class: 'history-lineage history-lineage-missing', title: lineageTitle(link) }, `↳ ${link.label}`)
	return h('button', { type: 'button', class: 'history-lineage', title: lineageTitle(link), onclick: SelectLineage(link.runId) }, `↳ ${link.label}`)
}

function LineageDetailsLine(link: LineageLink): Vnode {
	const parentId = link.available
		? h('button', { type: 'button', class: 'history-lineage history-lineage-link', title: lineageTitle(link), onclick: SelectLineage(link.runId) }, link.runId)
		: h('span', { class: 'history-lineage history-lineage-missing', title: lineageTitle(link) }, link.runId)
	const children: (Vnode | string)[] = ['Continues run ', parentId]
	if (link.available) children.push(` — ${link.label}`)
	return h('p', { class: 'history-details-lineage' }, children)
}

function SelectLineage(runId: string) {
	return function SelectLineageForRun(state: ApplicationState, event: MouseEvent): ActionReturn {
		event.stopPropagation()
		return SelectRun(state, runId)
	}
}

// The History screen is the full-screen run browser: compact one-line rows that stay legible no matter how large the underlying prompts and results are, with the full content one expand away. A running or paused run is labelled by its task, while a finished run prefers its generated summary; the expanded details carry the full task and, for terminal runs, the result summary or error — all agent prose through the sanitized Markdown pipeline except the primary line, which is textContent.
function HistoryRow(state: ApplicationState, summary: RunSummary, rerunDisabled: boolean, summariesById: Map<string, RunSummary>): Vnode {
	const expanded = state.expandedRowIds[summary.runId] === true
	const link = lineageLink(summary.continuesFrom, summariesById)
	const canContinue = resultOffersContinue(summary.status)
	const suspended = isSuspendedStatus(summary.status)
	const resumePending = state.resumeRunPendingId !== null
	const terminatePending = state.queueTerminatePendingId !== null
	const rowChildren: (Vnode | null)[] = [
		h('span', { class: `run-status run-status-${summary.status ?? 'unknown'}` }, statusLabel(summary.status)),
		h('span', { class: 'history-primary' }, runPrimaryLabel(summary)),
		link === null ? null : LineageBadge(link),
		isEffort(summary.effort)
			? h('span', { class: 'run-effort-badge', title: effortDescription(summary.effort) }, `effort ${effortLabel(summary.effort)}`)
			: null,
		isInvolvement(summary.involvement)
			? h('span', { class: 'run-involvement-badge', title: involvementDescription(summary.involvement) }, `involvement ${involvementLabel(summary.involvement)}`)
			: null,
		h('time', { class: 'history-when', title: summary.startTime ?? '' }, formatRelative(summary.startTime, state.now)),
	]
	if (suspended) {
		// A suspended row has a resume/terminate path, not a re-run or continuation path. Terminate is confirmed by its action because it discards the checkpoint.
		rowChildren.push(h('button', { type: 'button', class: 'suspended-resume-button', 'data-run-id': summary.runId, disabled: resumePending || terminatePending, title: 'Resume this suspended run from its saved checkpoint', onclick: ResumeSuspendedRunNow(summary.runId) }, resumePending ? 'Resuming…' : 'Resume'))
		rowChildren.push(h('button', { type: 'button', class: 'suspended-terminate-button', 'data-run-id': summary.runId, disabled: terminatePending || resumePending, title: 'Terminate this run and discard its saved context', onclick: TerminateSuspendedRun(summary.runId) }, 'Terminate'))
	} else {
		// The re-run button shares the create form's disabled condition (a run is active or a submission is in flight) so the one-task-at-a-time contract holds identically for re-runs.
		rowChildren.push(h('button', { type: 'button', class: 'rerun-button', 'data-task': summary.task ?? '', disabled: rerunDisabled || typeof summary.task !== 'string' || summary.task === '', onclick: RerunTask }, 're-run'))
		// Continue is for a finished outcome only; a needs_clarification run is paused and awaits an answer rather than being continued as a new task.
		if (canContinue) rowChildren.push(h('button', { type: 'button', class: 'continue-button', 'data-run-id': summary.runId, disabled: rerunDisabled, title: 'Start a new run continuing this one', onclick: ContinueRun }, 'Continue'))
	}
	return h('li', { key: summary.runId, class: { 'history-row': true, 'is-expanded': expanded, 'is-selected': summary.runId === state.selectedRunId, 'is-suspended': suspended } }, [
		h('div', { class: 'history-row-title' }, [
			h('div', { class: 'history-row-main', onclick: [SelectRun, summary.runId], title: 'Watch this run' }, rowChildren),
			h('button', { type: 'button', class: 'history-expand', 'aria-expanded': expanded, title: expanded ? 'Hide details' : 'Show the full task and result', onclick: [ToggleRowExpanded, summary.runId] }, expanded ? 'less ▴' : 'details ▾'),
		]),
		expanded ? HistoryRowDetails(summary, summariesById) : null,
	])
}

// The expanded details are where large prompts and results get their room: the exact run meta, the lineage, the full task, and the terminal result or error, all rendered at full length inside the scrollable history view.
function HistoryRowDetails(summary: RunSummary, summariesById: Map<string, RunSummary>): Vnode {
	const metaParts = [summary.runId]
	if (isEffort(summary.effort)) metaParts.push(`effort ${effortLabel(summary.effort)}`)
	if (isInvolvement(summary.involvement)) metaParts.push(`involvement ${involvementLabel(summary.involvement)}`)
	if (typeof summary.startTime === 'string') metaParts.push(`started ${summary.startTime}`)
	if (typeof summary.endTime === 'string') metaParts.push(`ended ${summary.endTime}`)
	const children = [h('p', { class: 'history-details-meta' }, metaParts.join(' · '))]
	const link = lineageLink(summary.continuesFrom, summariesById)
	if (link !== null) children.push(LineageDetailsLine(link))
	if (typeof summary.task === 'string' && summary.task !== '') {
		children.push(h('p', { class: 'history-details-heading' }, 'Task'))
		children.push(h('div', { class: 'markdown history-details-text' }, renderMarkdown(summary.task)))
	}
	const suspension = deriveSuspendedCard(summary)
	if (suspension !== undefined) {
		children.push(h('p', { class: 'history-details-heading' }, 'Suspended'))
		children.push(h('p', { class: 'history-details-suspension' }, suspension.cause))
		children.push(h('p', { class: 'history-details-suspension-time' }, `Suspended since ${suspension.suspendedAt}`))
	}
	const resultSummary = summary.result !== null && summary.result !== undefined && typeof summary.result.summary === 'string' && summary.result.summary !== '' ? summary.result.summary : null
	if (resultSummary !== null) {
		children.push(h('p', { class: 'history-details-heading' }, 'Result'))
		children.push(h('div', { class: 'markdown history-details-text' }, renderMarkdown(resultSummary)))
	}
	// The error rides the wire untyped (`error?: unknown`), so the message is read behind the record guard instead of the null checks a typed shape would allow.
	const errorMessage = isObject(summary.error) && typeof summary.error['message'] === 'string' && summary.error['message'] !== '' ? summary.error['message'] : null
	if (errorMessage !== null) {
		children.push(h('p', { class: 'history-details-heading' }, 'Error'))
		children.push(h('div', { class: 'markdown history-details-error' }, renderMarkdown(errorMessage)))
	}
	return h('div', { class: 'history-details' }, children)
}

// The merged history screen: one row per task. Queued rows (waiting, active, needs_input) come first in queue order, and a run whose id a queued row already represents is suppressed, so a task stays a single entry through question and answer. Every row shares the same compact one-line UX — status, primary line, when, and a details expander — so a queued row and a finished run read as one list. The empty state appears only when there is nothing to show.
function HistoryScreen(state: ApplicationState): Vnode {
	const rerunDisabled = state.createSending || state.resumeSending || state.justSubmittedRunId !== null || deriveActiveRunId(state.summaries) !== null
	const summariesById = runSummaryIndex(state.summaries)
	const entries = deriveHistoryEntries(state.queueItems, state.summaries)
	if (entries.length === 0) {
		const loaded = state.runListLoaded && state.queueLoaded
		let empty: Vnode
		if (loaded) empty = h('p', { class: 'history-empty' }, 'No runs yet — start a new task and it will appear here.')
		else if (!state.serverAvailable) empty = h('p', { class: 'history-empty' }, 'Tasks could not be loaded.')
		else empty = h('div', { class: 'history-empty' }, [LoadingIndicator(h, 'Loading tasks…')])
		return h('section', { id: 'history-screen' }, [
			h('div', { class: 'history-scroll' }, [empty]),
		])
	}
	const rows = entries.map((entry) => entry.kind === 'queued' ? QueueItemRow(state, entry.item, summariesById) : HistoryRow(state, entry.summary, rerunDisabled, summariesById))
	return h('section', { id: 'history-screen' }, [
		h('div', { class: 'history-scroll' }, [
			h('ul', { id: 'history-list' }, rows),
		]),
	])
}

// --- Queued rows -------------------------------------------------------------
// The queued rows sit at the top of the merged history screen (docs/queueing.md "UI interaction model"): waiting rows (draggable, editable, removable), the one active row (read-only), and the items waiting for an answer (their question and answer live in the answer modal). Each row reuses the history row's compact markup and expander, so a queued task and a finished run read as one list. The expanded task and error render through the sanitized Markdown pipeline (docs/security.md "Web client rendering pipeline"); the primary line, ids, statuses, and timestamps stay textContent.

// The queue item's meta line in the expanded details: its run id once the scheduler has dispatched it. The queued time is already on the row's main line, so it is not repeated here.
function QueueItemMeta(item: QueueItemLike): Vnode | null {
	if (typeof item.runId !== 'string' || item.runId === '') return null
	return h('p', { class: 'history-details-meta' }, item.runId)
}

// The waiting row's inline edit form, shown in the row's expanded details while this item is being edited. The textarea is prefilled with the item's current task; saving PATCHes the trimmed text.
function QueueItemEditForm(_state: ApplicationState, item: QueueItemLike): Vnode {
	return h('form', { class: 'queue-edit-form', onsubmit: SaveItemEdit }, [
		h('textarea', { value: item.task, rows: '3', onkeydown: TaskTextareaKeydown }),
		h('div', { class: 'queue-edit-actions' }, [
			h('button', { type: 'submit' }, 'Save'),
			h('button', { type: 'button', onclick: CancelItemEdit }, 'Cancel'),
		]),
	])
}

// The expanded details of a queued row: the queue meta, its lineage, the full task (or the inline edit form while editing), the parked question, the operator's earlier answer on a re-dispatched waiting item, and the run's error when the item failed. The task, question, and error render through the sanitized Markdown pipeline. The needs_input answer box is not here — clicking the row's main area opens the question modal, so answering a blocking run needs no expansion.
function QueueItemRowDetails(state: ApplicationState, item: QueueItemLike, summariesById: Map<string, RunSummary>): Vnode {
	const meta = QueueItemMeta(item)
	const children: Vnode[] = meta === null ? [] : [meta]
	const link = queueItemLineageLink(item, summariesById)
	if (link !== null) children.push(LineageDetailsLine(link))
	if (state.editingItemId === item.id) {
		children.push(QueueItemEditForm(state, item))
	} else {
		children.push(h('p', { class: 'history-details-heading' }, 'Task'))
		children.push(h('div', { class: 'markdown history-details-text' }, renderMarkdown(item.task)))
	}
	if (item.status === 'needs_input' && typeof item.question === 'string' && item.question !== '') {
		children.push(h('p', { class: 'history-details-heading' }, 'Question'))
		children.push(h('div', { class: 'markdown history-details-text' }, renderMarkdown(item.question)))
	}
	// A re-dispatched waiting item's record of why it ran again (the operator's previous answer) — operator input, rendered as text.
	if (item.status === 'waiting' && typeof item.answer === 'string' && item.answer !== '') {
		children.push(h('p', { class: 'queue-item-answer' }, `Your earlier answer: ${item.answer}`))
	}
	if (item.status === 'suspended' && typeof item.suspendedAt === 'string' && item.suspendedAt !== '') {
		children.push(h('p', { class: 'history-details-heading' }, 'Suspended'))
		children.push(h('p', { class: 'history-details-suspension-time' }, `Suspended since ${item.suspendedAt}`))
	}
	if (typeof item.error === 'string' && item.error !== '') {
		children.push(h('p', { class: 'history-details-heading' }, 'Error'))
		children.push(h('div', { class: 'markdown history-details-error' }, renderMarkdown(item.error)))
	}
	return h('div', { class: 'history-details' }, children)
}

// A queued row in the merged list: history-style markup with the queue status tone in place of the run status. A needs_input row's main area opens the question modal (its question is the parked run's, and the modal is the only place to answer it); an active or suspended row selects its run, whose own history row is suppressed; a waiting row does not navigate. Only waiting rows are editable/removable/draggable; a suspended row offers Resume and Terminate instead.
function QueueItemRow(state: ApplicationState, item: QueueItemLike, summariesById: Map<string, RunSummary>): Vnode {
	const waiting = item.status === 'waiting'
	const active = item.status === 'active'
	const suspended = item.status === 'suspended'
	const needsInput = item.status === 'needs_input'
	const editing = waiting && state.editingItemId === item.id
	const expanded = state.expandedRowIds[item.id] === true
	const link = queueItemLineageLink(item, summariesById)
	const runId = typeof item.runId === 'string' && item.runId !== '' ? item.runId : null
	const mainOnclick = needsInput ? [OpenQueueQuestion, item.id] : (active || suspended) && runId !== null ? [SelectRun, runId] : undefined
	const mainChildren: (Vnode | null)[] = [
		h('span', { class: `run-status queue-status-${item.status}` }, queueStatusLabel(item.status)),
		h('span', { class: 'history-primary' }, queueItemPrimaryText(item)),
		link === null ? null : LineageBadge(link),
		h('time', { class: 'history-when', title: item.queuedAt }, `queued ${formatRelative(item.queuedAt, state.now)}`),
	]
	if (waiting && !editing) {
		mainChildren.push(h('button', { type: 'button', class: 'rerun-button', title: 'Edit the task text', onclick: [StartItemEdit, item.id] }, 'Edit'))
		mainChildren.push(h('button', { type: 'button', class: 'rerun-button', title: 'Remove the task from the queue', onclick: [RemoveQueueItem, item.id] }, 'Remove'))
	}
	if (needsInput) {
		mainChildren.push(h('button', { type: 'button', class: 'rerun-button terminate-button', disabled: state.queueTerminatePendingId !== null, title: 'Terminate the waiting task and discard its saved context', onclick: TerminateQueueItem(item.id) }, 'Terminate'))
	}
	if (suspended && runId !== null) {
		const resumePending = state.resumeRunPendingId !== null
		const terminatePending = state.queueTerminatePendingId !== null
		mainChildren.push(h('button', { type: 'button', class: 'suspended-resume-button', 'data-run-id': runId, disabled: resumePending || terminatePending, title: 'Resume this suspended run from its saved checkpoint', onclick: ResumeSuspendedRunNow(runId) }, resumePending ? 'Resuming…' : 'Resume'))
		mainChildren.push(h('button', { type: 'button', class: 'suspended-terminate-button', 'data-run-id': runId, disabled: terminatePending || resumePending, title: 'Terminate this run and discard its saved context', onclick: TerminateSuspendedRun(runId, item.id) }, 'Terminate'))
	}
	const children: Vnode[] = [
		h('div', { class: 'history-row-title' }, [
			h('div', { class: 'history-row-main', onclick: mainOnclick }, mainChildren),
			h('button', { type: 'button', class: 'history-expand', 'aria-expanded': expanded, title: expanded ? 'Hide details' : 'Show the full task and details', onclick: [ToggleRowExpanded, item.id] }, expanded ? 'less ▴' : 'details ▾'),
		]),
	]
	if (expanded) children.push(QueueItemRowDetails(state, item, summariesById))
	return h('li', {
		key: item.id,
		class: { 'history-row': true, 'queue-row': true, 'is-waiting': waiting, 'is-active': active, 'is-suspended': suspended, 'is-needs-input': needsInput, 'is-dragging': state.draggingItemId === item.id },
		// Only waiting rows drag: a drag is a reorder, and the reorder endpoint takes waiting items only.
		draggable: waiting && !editing,
		'data-item-id': item.id,
		ondragstart: DragQueueItem,
		ondragover: DragOverQueueItem,
		ondrop: DropQueueItem,
		ondragend: DragEndQueueItem,
	}, children)
}

// The effort selector is one radio group (shared `name`, real inputs) so arrow keys and screen readers work natively, with each whole card clickable via its wrapping label. The option values are the wire strings verbatim — picking a card fires SaveRunEffort, so the choice applies to the next run and persists as the project default at once. The names, descriptions, and recommended badge all render from EFFORT_OPTIONS, the single home of the per-level copy.
function EffortLevelSelector(value: EffortLevel, disabled: boolean, saving: boolean): Vnode {
	return h('fieldset', { class: 'effort-control', disabled }, [
		h('legend', { class: 'effort-label' }, 'Effort level'),
		h('div', { class: 'effort-options' }, EFFORT_OPTIONS.map((option) =>
			h('label', { class: { 'effort-option': true, 'is-selected': option.value === value } }, [
				h('input', { type: 'radio', name: 'run-effort', value: option.value, checked: option.value === value, onchange: SaveRunEffort }),
				h('span', { class: 'effort-option-name' }, [
					effortLabel(option.value),
					option.recommended === true ? h('span', { class: 'effort-recommended' }, 'Recommended') : null,
				]),
				h('span', { class: 'effort-option-description' }, option.description),
			]),
		)),
		h('p', { class: 'effort-tip' }, 'Not sure? Leave it on Standard — it fits most tasks. You can always run the task again with a different level.'),
		h('p', { class: 'effort-note' }, saving ? 'saving…' : ''),
	])
}

// The human-involvement selector mirrors the effort selector's radio group: the option values are the wire strings verbatim, and picking a card fires SaveRunInvolvement, so the choice applies to the next run and persists as the project default at once. The names and descriptions render from INVOLVEMENT_OPTIONS, the single home of the per-level copy.
function InvolvementLevelSelector(value: InvolvementLevel, disabled: boolean, saving: boolean): Vnode {
	return h('fieldset', { class: 'involvement-control', disabled }, [
		h('legend', { class: 'involvement-label' }, 'Human involvement'),
		h('div', { class: 'involvement-options' }, INVOLVEMENT_OPTIONS.map((option) =>
			h('label', { class: { 'involvement-option': true, 'is-selected': option.value === value } }, [
				h('input', { type: 'radio', name: 'run-involvement', value: option.value, checked: option.value === value, onchange: SaveRunInvolvement }),
				h('span', { class: 'involvement-option-name' }, involvementLabel(option.value)),
				h('span', { class: 'involvement-option-description' }, option.description),
			]),
		)),
		h('p', { class: 'involvement-note' }, saving ? 'saving…' : ''),
	])
}

// The logging-level selector mirrors the effort selector's radio group at a smaller size — two options whose labels come from LOG_LEVEL_OPTIONS, the single home of the copy. Picking one fires SaveRunLogLevel, so the choice applies to the next run and persists as the project default at once.
function LoggingLevelSelector(value: LogLevel, disabled: boolean, saving: boolean): Vnode {
	return h('fieldset', { class: 'logging-level-control', disabled }, [
		h('legend', { class: 'logging-level-label' }, 'Logging level'),
		h('div', { class: 'logging-level-options' }, LOG_LEVEL_OPTIONS.map((option) =>
			h('label', { class: { 'logging-level-option': true, 'is-selected': option.value === value } }, [
				h('input', { type: 'radio', name: 'run-log-level', value: option.value, checked: option.value === value, onchange: SaveRunLogLevel }),
				h('span', { class: 'logging-level-option-name' }, option.label),
			]),
		)),
		h('p', { class: 'logging-level-note' }, saving ? 'saving…' : ''),
	])
}

// The continuation reference above the compose textarea: the prior run's full task and terminal result as the labeled User/Assistant turns the server will inject. It is display-only — the textarea holds the follow-up and the submitted body carries only continuesFrom — and dismissing returns the form to a plain new task.
function ContinuationReferenceBlock(state: ApplicationState): Vnode | null {
	const continuation = state.continuation
	if (continuation === null) return null
	return ContinuationReference(h, { continuation, renderMarkdown, onCancel: CancelContinuation })
}

// The resume banner above the compose textarea while the operator is resuming an errored run from its result modal: it names the run being restarted and says the note is optional — the run restarts from its checkpointed context either way. It reuses the continuation chip's styling (the same attached-context chrome for the compose form's two anchored modes) and the Cancel button returns the form to a plain new task.
function ResumeChip(state: ApplicationState): Vnode | null {
	const resumingRunId = state.resumingRunId
	if (resumingRunId === null) return null
	return h('div', { class: 'continuation-chip', 'aria-label': `Resuming run ${resumingRunId}` }, [
		h('div', { class: 'continuation-chip-text' }, [
			h('p', { class: 'continuation-chip-title' }, `Resuming run ${resumingRunId}`),
			h('p', { class: 'continuation-chip-outcome' }, 'The run restarts from its checkpoint with its full context; the note below is optional.'),
		]),
		h('button', { type: 'button', class: 'continuation-chip-dismiss', title: 'Discard the resume and write a fresh task', onclick: CancelResume }, 'Cancel'),
	])
}

// The compose textarea's placeholder announces the form's mode: a resume note is optional (the run restarts with or without one), a continuation asks for the follow-up to the prior task, a plain task is required, and a blocked form says why it is waiting.
function composePlaceholder(resuming: boolean, continuing: boolean, blocked: boolean): string {
	if (blocked) return resuming ? 'a run is already in progress — the resume starts when it finishes' : 'a run is already in progress — a continuation starts when it finishes'
	if (resuming) return 'add an optional note for the resumed run (Markdown supported)'
	if (continuing) return 'add your follow-up to the continued task (Markdown supported)'
	return 'describe a task (Markdown supported)'
}

// The submit button's label tracks the same mode, with an in-flight resume or create named so the wait reads as progress rather than a dead button.
function composeSubmitLabel(resuming: boolean, sending: boolean, blocked: boolean): string {
	if (sending) return resuming ? 'Resuming…' : 'Adding…'
	if (blocked) return 'Run in progress…'
	return resuming ? 'Resume run' : 'Add task'
}

// The compose screen is the hero when the service is idle — drafting a task is the primary activity when nothing is running, so the editor gets the whole stage. The submit path is the queue's universal add (the scheduler dispatches it at once when the system is idle, so the user-visible behavior of today's "start now" is preserved); in continuation mode the reference block rides above the task field and the submit body carries continuesFrom — the only body that can — so a continuation stays disabled while a run is in flight rather than queueing without its lineage. In resume mode the chip names the errored run being restarted and the submit body is the optional note.
function ComposeScreen(state: ApplicationState): Vnode {
	const resuming = state.resumingRunId !== null
	// A continuation and a resume both submit to run-submission endpoints that hold the one-run-at-a-time slot, so either mode disables while a run is in flight (a plain task queues instead); a resume or a create already in flight disables until it lands. A stale list entry for the very run being continued or resumed is not a genuine active run when the selected view is already terminal.
	const activeRunId = deriveActiveRunId(state.summaries)
	const targetRunId = state.continuation !== null ? state.continuation.runId : state.resumingRunId
	const selectedView = state.selectedRunView
	const activeRunIsViewedTerminal = activeRunId !== null && activeRunId === targetRunId && selectedView !== null && selectedView.runId === activeRunId && deriveTerminalResult(selectedView) !== undefined
	const blocked = (state.continuation !== null || resuming) && activeRunId !== null && !activeRunIsViewedTerminal
	const disabled = blocked || state.resumeSending || state.createSending
	const runEffort = isEffort(state.runEffort) ? state.runEffort : DEFAULT_EFFORT
	const runInvolvement = isInvolvement(state.runInvolvement) ? state.runInvolvement : DEFAULT_INVOLVEMENT
	const runLogLevel = isLogLevel(state.runLogLevel) ? state.runLogLevel : DEFAULT_LOG_LEVEL
	return h('section', { id: 'compose-screen' }, [
		h('div', { class: 'compose-hero' }, [
			h('h1', { class: 'compose-heading' }, state.summaries.length === 0 ? 'What should the orchestrator do?' : 'Add task'),
			h('p', { class: 'compose-sub' }, 'Describe the task in plain language — Markdown works too. Tasks run one at a time; a task added while a run is in progress waits in the queue and starts when it finishes.'),
			h('form', { class: { 'create-run-form': true, 'is-busy': disabled }, onsubmit: SubmitRun }, [
				ContinuationReferenceBlock(state),
				ResumeChip(state),
				h('textarea', { name: 'task', placeholder: composePlaceholder(resuming, state.continuation !== null, blocked), autocomplete: 'off', disabled: blocked, onkeydown: TaskTextareaKeydown }),
				EffortLevelSelector(runEffort, disabled, state.savingEffort === true),
				InvolvementLevelSelector(runInvolvement, disabled, state.savingInvolvement === true),
				LoggingLevelSelector(runLogLevel, disabled, state.savingLogLevel === true),
				h('div', { class: 'submit-controls' }, [
					h('button', { type: 'submit', disabled }, composeSubmitLabel(resuming, state.resumeSending || state.createSending, blocked)),
				]),
				// A refused resume's notice, under the submit button so the reason sits where the click landed. Gated on resume mode: a response landing after a cancel must not address a plain new-task form.
				resuming && state.resumeNotice !== null ? h('p', { class: 'resume-notice' }, state.resumeNotice) : null,
			]),
		]),
	])
}

// The interrupt history is the visible record of what the operator sent and what the run did with it: each inquiry pairs with the role's answer (or a waiting/ended note), each plan modification lists its delivery target and abort count. The question/outcome lines are machine fields or the operator's own text (textContent); the answer is agent prose and renders only through the sanitized Markdown pipeline.
function InterruptHistory(state: ApplicationState): Vnode | null {
	const view = state.selectedRunView
	if (view === null || !Array.isArray(view.interrupts) || view.interrupts.length === 0) return null
	return h('div', { class: 'interrupt-history' }, [
		h('h3', {}, 'Earlier interrupts'),
		h('ul', {}, view.interrupts.map((entry, index) => {
			if (entry.kind === 'inquiry') {
				const answerState = entry.answer !== null
					? h('div', { class: 'interrupt-answer markdown' }, renderMarkdown(entry.answer))
					: h('p', { class: 'interrupt-waiting' }, entry.ended ? 'The role finished without answering.' : 'Waiting for the run to answer…')
				return h('li', { key: `interrupt-${index}` }, [
					h('div', { class: 'interrupt-meta-row' }, [
						h('span', { class: 'interrupt-kind' }, 'Question'),
						entry.role !== null ? h('span', { class: 'interrupt-target' }, `to ${entry.role}`) : null,
						h('time', { title: entry.askedAt }, formatRelative(entry.askedAt, state.now)),
					]),
					h('p', { class: 'interrupt-text' }, entry.message),
					answerState,
				])
			}
			return h('li', { key: `interrupt-${index}` }, [
				h('div', { class: 'interrupt-meta-row' }, [
					h('span', { class: 'interrupt-kind interrupt-kind-plan' }, 'Plan change'),
					h('time', { title: entry.askedAt }, formatRelative(entry.askedAt, state.now)),
				]),
				h('p', { class: 'interrupt-text' }, entry.message),
				h('p', { class: 'interrupt-outcome' }, `Delivered to ${entry.targetRole ?? entry.target ?? 'the run'}${entry.aborted.length > 0 ? ` — ${entry.aborted.length} role${entry.aborted.length === 1 ? '' : 's'} aborted` : ''}.`),
			])
		})),
	])
}

// The interrupt form addresses the selected run only while it is the one in flight; a historical selection or an idle service renders nothing. The plan-modification mode carries an upfront warning because it aborts the work currently happening. Every string here is trusted UI copy or the operator's own input (posted, never rendered back), so the form introduces no untrusted-content path.
function InterruptForm(state: ApplicationState): Vnode | null {
	const activeRunId = deriveActiveRunId(state.summaries)
	if (activeRunId === null || state.selectedRunId !== activeRunId) return null
	const mode = state.interruptMode
	const queued = state.selectedRunView !== null && state.selectedRunView.interruptPending === true
	return h('div', { class: 'interrupt-form-wrap' }, [
		h('div', { class: 'interrupt-mode', role: 'group', 'aria-label': 'interrupt kind' }, [
			h('label', { class: mode === 'inquiry' ? 'is-active' : '' }, [
				h('input', { type: 'radio', name: 'interrupt-kind', checked: mode === 'inquiry', onchange: [SetInterruptMode, 'inquiry'] }),
				'Ask a question',
			]),
			h('label', { class: mode === 'plan_modification' ? 'is-active' : '' }, [
				h('input', { type: 'radio', name: 'interrupt-kind', checked: mode === 'plan_modification', onchange: [SetInterruptMode, 'plan_modification'] }),
				'Change the plan',
			]),
		]),
		mode === 'plan_modification'
			? h('p', { class: 'interrupt-warning' }, 'Changing the plan aborts the work happening right now and re-plans from the top-level planner.')
			: null,
		h('form', { class: 'interrupt-form', onsubmit: SubmitInterrupt }, [
			h('textarea', {
				name: 'interrupt-message',
				rows: '3',
				placeholder: mode === 'inquiry' ? 'ask the run something (e.g. “what are you working on?”)' : 'describe the change to make (e.g. “use Postgres instead of SQLite”)',
			}),
			h('button', { type: 'submit', disabled: state.interruptSending }, state.interruptSending ? 'Sending…' : 'Send interrupt'),
		]),
		queued ? h('p', { class: 'interrupt-note' }, 'An interrupt is queued and will land at the run\u2019s next safe point.') : null,
		state.interruptNotice !== null ? h('p', { class: 'interrupt-note' }, state.interruptNotice) : null,
	])
}

// The stage-scoped interrupt modal pairs the history of what the operator already sent with the form to send more, so an answer appears in the same place the question was asked. It is reachable only while viewing the active run (the controls-row button is the single entry point and renders only then); the form itself re-checks the condition in case the run completes while the modal is open.
function InterruptModalForRun(state: ApplicationState): Vnode | null {
	if (!state.interruptModalOpen) return null
	return h('div', { class: 'interrupt-modal-overlay' }, [
		h('div', { class: 'interrupt-modal-backdrop', onclick: CloseInterruptModal }),
		h('div', { class: 'interrupt-modal-card' }, [
			h('p', { class: 'interrupt-modal-heading' }, 'Interrupt this run'),
			InterruptHistory(state),
			InterruptForm(state),
			h('div', { class: 'interrupt-modal-actions' }, [
				h('button', { type: 'button', class: 'interrupt-modal-close', onclick: CloseInterruptModal }, 'Close'),
			]),
		]),
	])
}

// A newly-arrived answer to the operator's interrupt question, presented as a dismissible card pinned over the stage's corner: unmissable on arrival but never blocking the run view the way a modal would. The question and the answering role's name are textContent (the operator's own words and a machine field); the answer is agent prose through the sanitized Markdown pipeline. The full exchange also lives in the interrupt modal's history.
function InterruptAnswerCardForRun(state: ApplicationState): Vnode | null {
	const card = state.interruptAnswerCard
	if (card === null) return null
	// The card is only created for an answered inquiry (latestUnshownAnswer skips unanswered entries), and the renderer maps an empty or absent text to the same em-dash placeholder either way, so the null arm of the wire type is unreachable here.
	return h('div', { class: 'interrupt-answer-card' }, [
		h('p', { class: 'interrupt-answer-card-heading' }, card.role !== null && typeof card.role === 'string' ? `Answer from ${card.role}` : 'The run answered'),
		h('p', { class: 'interrupt-answer-card-question' }, card.question),
		h('div', { class: 'interrupt-answer-card-answer markdown' }, renderMarkdown(card.answer ?? '')),
		h('button', { type: 'button', class: 'interrupt-answer-card-close', onclick: DismissInterruptAnswer }, 'Dismiss'),
	])
}

function CostStrip(model: InteractionModel): Vnode {
	const cost = runStage.cost(model)
	return h('div', { class: 'pb-cost-strip' }, [
		h('span', { class: 'pb-cost-item' }, `elapsed ${formatElapsed(cost.elapsedSeconds)}`),
		h('span', { class: 'pb-cost-sep' }, '·'),
		h('span', { class: 'pb-cost-item' }, `${formatTokens(cost.tokens)} tokens`),
	])
}

// The interrupt modal's single entry point, visible only while the viewed run is the one in flight; a historical selection or an idle service renders nothing, mirroring the server-side 409 contract.
function InterruptButton(state: ApplicationState): Vnode | null {
	const activeRunId = deriveActiveRunId(state.summaries)
	if (activeRunId === null || state.selectedRunId !== activeRunId) return null
	return h('button', { type: 'button', class: 'interrupt-open-button', title: 'Ask the run a question or change its plan', onclick: OpenInterruptModal }, 'Interrupt')
}

function StageControls(state: ApplicationState, model: InteractionModel | null): Vnode {
	return h('div', { class: 'stage-controls' }, [
		h('div', { class: 'pb-view-toggle', role: 'group', 'aria-label': 'run view' }, [
			h('button', { type: 'button', class: state.flowViewMode === 'flow' ? 'is-active' : '', onclick: [SetFlowViewMode, 'flow'] }, 'Flow'),
			h('button', { type: 'button', class: state.flowViewMode === 'sequence' ? 'is-active' : '', onclick: [SetFlowViewMode, 'sequence'] }, 'Sequence'),
		]),
		// The roles-only filter is a sequence-view lens, so the toggle shows only while that view is active (the same show-with-the-sequence rule the harness's jump-to-active button follows).
		state.flowViewMode === 'sequence' ? SequenceRolesOnlyToggle(state) : null,
		h('label', { class: 'flow-tier-control' }, [
			h('span', {}, 'Label tier'),
			h('select', { value: state.flowTier, onchange: ChangeFlowTier }, TIER_VALUES.map((value) => h('option', { value, selected: value === state.flowTier }, value))),
		]),
		model !== null ? CostStrip(model) : null,
		InterruptButton(state),
		h('button', { type: 'button', class: 'inspector-open-button', title: 'Inspect this run\u2019s LLM requests and responses, turn by turn', onclick: OpenInspectorModal }, 'Inspect'),
	])
}

// The roles-only checkbox (see SetSequenceRolesOnly). Mirrors the mute toggle's checkbox look so the two filter-ish controls read alike.
function SequenceRolesOnlyToggle(state: ApplicationState): Vnode {
	return h('label', { class: 'sequence-roles-control', title: 'Hide tool and interrupt columns — show only the agent roles and the human' }, [
		h('input', { type: 'checkbox', checked: state.sequenceRolesOnly === true, onchange: SetSequenceRolesOnly }),
		'roles only',
	])
}

// The run's plan document (the Markdown the planner writes through write_plan), shown as a collapsed disclosure between the stage and the now-caption so the plan is one click away without competing with the live graph. The plan is agent-authored prose like any other the run produces, so its body renders only through the shared sanitized Markdown pipeline; a run without a plan renders nothing at all.
function PlanSection(state: ApplicationState): Vnode | null {
	const view = state.selectedRunView
	const plan = view !== null && typeof view.plan === 'string' ? view.plan : ''
	if (plan === '') return null
	const expanded = state.planExpanded === true
	return h('div', { class: 'run-plan' }, [
		h('button', { type: 'button', class: 'run-plan-toggle', 'aria-expanded': expanded, title: expanded ? 'Hide the plan' : 'Show the plan the run is following', onclick: TogglePlanExpanded }, expanded ? 'Plan ▴' : 'Plan ▾'),
		expanded ? h('div', { class: 'run-plan-body markdown' }, renderMarkdown(plan)) : null,
	])
}

// The run's lineage: a run that continued a prior finished run names it here, and clicking jumps to the prior run's view through the same SelectRun path the history rows and status pills use. The id is a machine field rendered as text; a run without lineage renders nothing.
function LineageLine(state: ApplicationState): Vnode | null {
	const view = state.selectedRunView
	if (view === null) return null
	if (typeof view.continuesFrom !== 'string' || view.continuesFrom === '') return null
	return h('button', { type: 'button', class: 'run-lineage', title: 'View the run this run continues', onclick: [SelectRun, view.continuesFrom] }, `Continues run ${view.continuesFrom}`)
}

// --- Sequence-view scroll following ----------------------------------------
// The sequence container follows new content while the operator sits at its bottom and browses freely otherwise (see scroll-follow.js). hyperapp has no mounted-element hook, so the follower is synced against the rendered DOM: the effect defers to its own requestAnimationFrame, which hyperapp's render — queued first, at setState — precedes in the same frame, so the patch has landed before the sync runs. The sync attaches a fresh follower when the container element was replaced (mode/screen switches and the placeholder-to-model transition remount it), detaches when the container is gone, and pins to the bottom on every model update while still attached.

let sequenceFollower: ScrollFollower | null = null

const sequenceFollowerCoalescer = createAnimationFrameCoalescer(
	(callback) => requestAnimationFrame(callback),
	() => {
		const container = document.querySelector('.pb-sequence-scroll')
		if (!(container instanceof HTMLElement)) {
			if (sequenceFollower !== null) {
				sequenceFollower.destroy()
				sequenceFollower = null
			}
			return
		}
		if (sequenceFollower === null || sequenceFollower.element !== container) {
			if (sequenceFollower !== null) sequenceFollower.destroy()
			sequenceFollower = createScrollFollower(container)
		}
		sequenceFollower.follow()
	},
)

function runSyncSequenceFollower(_dispatch: Dispatch, _payload: null): void {
	sequenceFollowerCoalescer.request()
}

function SyncSequenceFollower(): NullPayloadEffect {
	return [runSyncSequenceFollower, null]
}

// The inspector modal's transcript body follows new content while the operator sits at its bottom — live partials, newly completed turns, tail refreshes, and wire expanders all grow it — the same follow-with-free-scroll contract the sequence container gets, through the same shared follower (see scroll-follow.js and runSyncSequenceFollower). The sync defers to its own requestAnimationFrame so the modal's patch has landed before it runs, attaches a fresh follower whenever the body element was replaced (modal open/close, screen swaps, the placeholder-to-model transition all remount it), detaches when the element is gone, and pins to the bottom on every wired update while still attached.
let inspectorFollower: ScrollFollower | null = null

const inspectorFollowerCoalescer = createAnimationFrameCoalescer(
	(callback) => requestAnimationFrame(callback),
	() => {
		const container = document.querySelector('.inspector-modal-body')
		if (!(container instanceof HTMLElement)) {
			if (inspectorFollower !== null) {
				inspectorFollower.destroy()
				inspectorFollower = null
			}
			return
		}
		if (inspectorFollower === null || inspectorFollower.element !== container) {
			if (inspectorFollower !== null) inspectorFollower.destroy()
			inspectorFollower = createScrollFollower(container)
		}
		inspectorFollower.follow()
	},
)

function runSyncInspectorFollower(_dispatch: Dispatch, _payload: null): void {
	inspectorFollowerCoalescer.request()
}

function SyncInspectorFollower(): NullPayloadEffect {
	return [runSyncInspectorFollower, null]
}

// The watch screen fills the viewport below the top bar: a controls row, the flex-filling stage, and the now-caption. The Flow view (product surface) and the Sequence view (debug surface) are independent leaves over the same model; the toggle swaps which renders without a fetch. The sequence view mounts inside a vertical scroll container because its timeline grows long, while the flow view scales to the stage.
function WatchScreen(state: ApplicationState): Vnode {
	const labels = state.labelResolver
	const serverModel = state.flowModel
	// Before the guild config or the first readable flow frame lands, the stage shows a placeholder rather than a half-built graph; both arrive within the first poll, so the placeholder is transient.
	if (labels === null || serverModel === null) {
		if (state.selectedRunId === null) {
			return h('section', { id: 'watch-screen' }, [
				LineageLine(state),
				StageControls(state, null),
				h('div', { key: 'watch-flow', class: 'pb-flow flow-stage' }, [h('p', { class: 'flow-empty' }, 'Select a run to see its flow.'), InspectorModalForRun(state)]),
			])
		}
		if (!state.serverAvailable) {
			const unavailable = labels === null ? 'Unable to load the run view.' : 'Run view unavailable.'
			return h('section', { id: 'watch-screen' }, [
				LineageLine(state),
				StageControls(state, null),
				h('div', { key: 'watch-flow', class: 'pb-flow flow-stage' }, [h('p', { class: 'flow-empty' }, unavailable), InspectorModalForRun(state)]),
			])
		}
		const selectedStatus = state.selectedRunStatus
		if (selectedStatus !== null && isSuspendedStatus(selectedStatus)) {
			return h('section', { id: 'watch-screen' }, [
				LineageLine(state),
				StageControls(state, null),
				h('div', { key: 'watch-flow', class: 'pb-flow flow-stage' }, [
					h('div', { class: 'flow-empty' }, [
						h('p', {}, 'This run is suspended.'),
						h('button', { type: 'button', class: 'suspended-open-button', onclick: OpenSuspendedModal }, 'View suspension'),
					]),
					SuspendedCardForRun(state),
					InspectorModalForRun(state),
				]),
			])
		}
		if (selectedStatus !== null && isTerminalStatus(selectedStatus)) {
			return h('section', { id: 'watch-screen' }, [
				LineageLine(state),
				StageControls(state, null),
				h('div', { key: 'watch-flow', class: 'pb-flow flow-stage' }, [h('p', { class: 'flow-empty' }, 'No flow activity is available for this run.'), InspectorModalForRun(state)]),
			])
		}
		const loadingLabel = labels === null ? 'Loading run view…' : 'Waiting for run activity…'
		return h('section', { id: 'watch-screen' }, [
			LineageLine(state),
			StageControls(state, null),
			h('div', { key: 'watch-flow', class: 'pb-flow flow-stage' }, [h('div', { class: 'flow-empty' }, [LoadingIndicator(h, loadingLabel)]), InspectorModalForRun(state)]),
		])
	}

	// The polled flow payload is a pure function of stored data, so an open call's elapsedSeconds is null; fill it from this client's clock once here so StageControls and the now-caption read a live span through the same helpers. The stage below hydrates its own elapsed at build time and is memoized on the stable inputs only, so a `now`-only tick never rebuilds it.
	const model = withLiveElapsed(serverModel, state.now)
	const tier = state.flowTier
	// The stage memo returns the cached vnode while the stable inputs are unchanged; it is mounted at exactly one keyed position — child 0 of the `.pb-flow` container keyed 'watch-flow', or child 0 of the sequence scroll wrapper in sequence mode — and that key keeps the position stable while the container's unkeyed siblings (LineageLine, PlanSection) toggle in and out, so the cached vnode is only ever diffed against its own previous self. The reuse is safe because it never lands at two positions or after a position shift (see run-stage/index.ts and docs/architecture.md "Web client").
	// A needs_clarification run's question lives on its parked queue item, so its Respond CTA opens that item's answer modal; a suspended run opens the pause card; every other terminal status keeps the result modal. The status rides the model input, so a status change already rebuilds the stage.
	const cta = { onclick: model.status === 'needs_clarification' ? OpenParkedQuestion : isSuspendedStatus(model.status) ? OpenSuspendedModal : OpenResultModal }
	const question = { onclick: OpenQuestionModal }
	const stageInputs = {
		model: serverModel,
		previousModel: state.previousFlowModel,
		labels,
		tier,
		viewMode: state.flowViewMode,
		rolesOnly: state.sequenceRolesOnly,
		guildParticipants: state.guildParticipants,
		cta,
		question,
		now: state.now,
	}
	const stageContent = runStage.render(h, stageInputs)
	// The sequence timeline mounts in a vertical scroll container because it grows long, while the flow view scales to the stage. The stage owns the sequence surface's header/body pairing; this host is HTML, so it supplies only the scroll wrapper.
	const stageView = state.flowViewMode === 'sequence'
		? h('div', { class: 'pb-sequence-scroll' }, [stageContent])
		: stageContent

	const nowCaption = runStage.nowCaption(model, labels, tier)

	return h('section', { id: 'watch-screen' }, [
		LineageLine(state),
		StageControls(state, model),
		// `.pb-flow` is the positioning context for the per-run-view modals (the question, result, and interrupt overlays are absolute inset 0 within it), so the modals cover the run view rather than the whole page. It is also the hover stage for the inspector: `mouseover`/`mouseleave`/`click` bubble here from every SVG child, so the inspector is wired once for both the flow and sequence views.
		h('div', { key: 'watch-flow', class: 'pb-flow flow-stage', onmouseover: HoverRunView, onmouseleave: LeaveRunView, onclick: ClickRunView }, [
			stageView,
			QuestionModalForRun(state),
			ResultModalForRun(state),
			SuspendedCardForRun(state),
			InterruptModalForRun(state),
			InspectorModalForRun(state),
			InterruptAnswerCardForRun(state),
			TooltipCardForRun(state),
		]),
		PlanSection(state),
		h('p', { class: 'pb-now-caption' }, nowCaption),
	])
}

// The inspector card over the run view. The descriptor in state is resolved against the live model
// and label resolver at render time, so the card reads the same model the SVG renders and never
// re-derives its labels. A descriptor whose id no longer resolves (an operation from a frame the
// poll has since replaced, or a participant/role the model no longer carries) yields an empty title
// and is treated as "no card" so a stale hover state dismisses rather than rendering a heading-less
// card. The card is `position: fixed` (stylesheets/styles.css), anchored to the snapshot rect taken at hover
// time, so it sits at a fixed position relative to the node (not the pointer) and stays put while
// the pointer is over it; its only prose-carrying section is the operation details markdown, which
// the hover wiring fetches on demand and which `formatTooltipContent` routes through the sanitized
// pipeline.
function TooltipCardForRun(state: ApplicationState): Vnode | null {
	const tooltip = state.tooltip
	if (tooltip === null) return null
	const serverModel = state.flowModel
	const labels = state.labelResolver
	if (serverModel === null || labels === null) return null
	// The tooltip's cumulative time reads the same live-filled elapsed the flow view does; the tooltip only opens over the current frame, so filling from the current clock is exact.
	const model = withLiveElapsed(serverModel, state.now)
	const descriptor = deriveTooltipDescriptor(model, labels, state.flowTier, tooltip, operationDetailsLookup(state.selectedRunId))
	if (descriptor.title === '') return null
	return Tooltip(h, { title: descriptor.title, sections: descriptor.sections, renderMarkdown, style: tooltipStyle(tooltip.rect, { width: window.innerWidth, height: window.innerHeight }) })
}

// The lookup the tooltip derivations read: the session cache's state for one operation id (a miss
// reads as failed, which the derivations render as "no details section" — never as invented
// content).
function operationDetailsLookup(runId: string | null): (operationId: string) => OperationDetailsState {
	// A null context keys a cache namespace nothing begins under (the fetch path guards the run id first), so the empty string reads as failed exactly as the untyped null key did.
	return (operationId) => operationDetails.lookup(runId ?? '', operationId)
}

// The pending question the modal renders. The live `/api/questions` poll is the source, so the modal is driven by live data, and the answer form posts to `/api/answer` via the existing SubmitAnswer path. The first pending question is the active one; the modal opens when one arrives (GotQuestions) and re-opens via the flow view's Question affordance.
function QuestionModalForRun(state: ApplicationState): Vnode | null {
	if (!state.questionModalOpen) return null
	const question = state.pendingQuestions[0]
	if (question === undefined) return null
	const runLabel = state.selectedRunView !== null && typeof state.selectedRunView.runId === 'string' ? state.selectedRunView.runId : null
	return QuestionModal(h, {
		question: { question: question.question, context: question.context },
		runLabel,
		renderMarkdown,
		onSubmit: SubmitAnswer(question.id),
		onClose: CloseQuestionModal,
		answerPending: state.pendingAnswerId === question.id,
	})
}

// The app-shell question modal for a parked queue item, driven by `openQueueQuestionId`. It renders nothing unless the id resolves to a current needs_input item, so an answered (or removed) item closes the modal the moment the queue poll updates. It is the `fixed` overlay variant because the history screen has no run-view container to scope it to. The item's own status gates it, so no explicit close is needed on answer success beyond the id clear in GotQueueAfterAnswer.
function QueueQuestionModalForApp(state: ApplicationState): Vnode | null {
	const itemId = state.openQueueQuestionId
	if (itemId === null) return null
	const item = state.queueItems.find((entry) => entry.id === itemId)
	if (item === undefined || item.status !== 'needs_input') return null
	return QuestionModal(h, {
		question: { question: typeof item.question === 'string' ? item.question : '' },
		runLabel: item.runId ?? null,
		renderMarkdown,
		onSubmit: SubmitQueueAnswer(item.id),
		onClose: CloseQueueQuestion,
		onTerminate: TerminateQueueItem(item.id),
		answerPending: state.queueAnswerPendingId === item.id,
		terminatePending: state.queueTerminatePendingId !== null,
		fixed: true,
	})
}

// The pause card for the selected run. It is driven by the same result-source selector as the result modal, so a suspended summary opens even before the richer run view lands; the card's own derivation refuses any non-suspended status, which keeps terminal outcomes on the result path.
function SuspendedCardForRun(state: ApplicationState): Vnode | null {
	if (!state.suspendedModalOpen) return null
	const selectedRunId = state.selectedRunId
	if (selectedRunId === null || selectedRunId === '') return null
	const source = selectResultSource(selectedRunId, state.selectedRunView, state.summaries)
	if (source === null) return null
	const descriptor = deriveSuspendedCard(source.value)
	if (descriptor === undefined) return null
	return SuspendedCard(h, {
		descriptor,
		runLabel: selectedRunId,
		runId: selectedRunId,
		notice: state.suspendedActionNotice,
		resumePending: state.resumeRunPendingId !== null,
		terminatePending: state.queueTerminatePendingId !== null,
		onResume: ResumeSuspendedRunNow(selectedRunId),
		onTerminate: TerminateSuspendedRun(selectedRunId),
		onClose: CloseSuspendedModal,
	})
}

// The technical meta line the result modal carries for advanced users: run id, effort, involvement, duration, tool-call count, and the token bill with its input/output split in the text, with the exact start/end timestamps on the hover title. Derived from the run view the per-run poll already fetches, so the modal re-opens with no extra request.
function resultMetaLine(view: RunView, nowMs: number): { text: string; title: string } | null {
	if (typeof view.runId !== 'string') return null
	// The ingress guard does not validate budgets, so a malformed body can reach this function with the field absent — the widened annotation keeps that defensive check honest instead of trusting the declared type.
	const budgets: RunBudgets | null | undefined = view.budgets
	if (budgets === null || budgets === undefined) return null
	const parts = [view.runId]
	if (isEffort(view.effort)) parts.push(`effort ${effortLabel(view.effort)}`)
	if (isInvolvement(view.involvement)) parts.push(`involvement ${involvementLabel(view.involvement)}`)
	// A run without a stored endTime is still in progress, so its elapsed is computed live from startTime and this client's clock; a finished run uses the server's settled span, which is the same stored-timestamp arithmetic without the clock.
	const elapsed = view.endTime === null
		? (typeof view.startTime === 'string' ? secondsBetweenIso(view.startTime, nowMs) : null)
		: budgets.elapsedSeconds
	parts.push(formatElapsed(elapsed))
	parts.push(`${formatNumber(budgets.toolCalls)} tool calls`)
	const breakdown: TokenUsage | null | undefined = budgets.tokenBreakdown
	if (isTokenUsage(breakdown)) parts.push(tokensMetaPart(breakdown))
	const title = `started ${view.startTime ?? '—'} → ended ${view.endTime ?? '—'}`
	return { text: parts.join(' · '), title }
}

// The meta line's tokens figure: the total bill, then the input/output split with the cached share nested inside the input in parentheses — cached tokens are part of the prompt bill, a subset rather than an additive bucket (source/executor/types.ts LlmUsagePayload).
function tokensMetaPart(breakdown: TokenUsage): string {
	const cached = breakdown.cachedPromptTokens > 0 ? ` (cached ${formatTokens(breakdown.cachedPromptTokens)})` : ''
	return `${formatTokens(breakdown.totalTokens)} tokens (input ${formatTokens(breakdown.promptTokens)}${cached}, output ${formatTokens(breakdown.completionTokens)})`
}

function isTokenUsage(value: unknown): value is TokenUsage {
	if (!isObject(value)) return false
	return typeof value['promptTokens'] === 'number' && typeof value['completionTokens'] === 'number' && typeof value['totalTokens'] === 'number' && typeof value['cachedPromptTokens'] === 'number'
}

// The result modal for the selected run: the live run view when it belongs to that run, otherwise the polled summary fallback. A terminal descriptor renders the result card at once; when neither source is terminal yet, the pending card reports the on-demand load and offers a retry after failure.
function ResultModalForRun(state: ApplicationState): Vnode | null {
	if (!state.resultModalOpen) return null
	const selectedRunId = state.selectedRunId
	if (selectedRunId === null || selectedRunId === '') return null
	const source = selectResultSource(selectedRunId, state.selectedRunView, state.summaries)
	const descriptor = source === null ? undefined : deriveTerminalResult(source.value)
	if (source !== null && descriptor !== undefined) {
		const metaLine = source.kind === 'view' ? resultMetaLine(source.value, state.now) : null
		// The run list can lag the viewed run's completion, so a list entry naming the viewed run is not a genuine second active run. Any other active id, or an in-flight or just-landed submission, disables both recovery actions while leaving Close available.
		const activeRunId = deriveActiveRunId(state.summaries)
		const anotherRunActive = activeRunId !== null && activeRunId !== selectedRunId
		const submissionInFlight = state.createSending || state.resumeSending || state.justSubmittedRunId !== null
		const recoveryDisabled = anotherRunActive || submissionInFlight
		const recoveryDisabledReason = anotherRunActive ? 'Another run is already in progress.' : submissionInFlight ? 'A submission is already in flight.' : ''
		return ResultModal(h, {
			descriptor,
			runLabel: selectedRunId,
			runId: selectedRunId,
			metaLine,
			renderMarkdown,
			onCopyRaw: copyRawToClipboard,
			onContinue: resultOffersContinue(descriptor.status) ? ContinueFromResultModal : undefined,
			onResume: ResumeFromResultModal,
			onClose: CloseResultModal,
			recoveryDisabled,
			recoveryDisabledReason,
		})
	}
	const phase = state.resultLoad !== null && state.resultLoad.runId === selectedRunId ? state.resultLoad.phase : 'loading'
	return ResultPendingModal(h, { phase, runLabel: selectedRunId, onRetry: RetryResultLoad, onClose: CloseResultModal })
}

// The screen switch. A zero-state service (no runs, nothing selected) shows the compose hero regardless of the stored screen — drafting the first task is the only meaningful activity then.
function Main(state: ApplicationState): Vnode {
	if (state.screen === 'history') return h('main', {}, [HistoryScreen(state)])
	if (state.screen === 'compose') return h('main', {}, [ComposeScreen(state)])
	if (state.summaries.length === 0 && state.selectedRunId === null) return h('main', {}, [ComposeScreen(state)])
	return h('main', {}, [WatchScreen(state)])
}

function view(state: ApplicationState): Vnode {
	return h('div', { class: 'app-shell' }, [TopBar(state), ProviderHealthBannerForState(state), SuspendedActionNoticeForState(state), Main(state), QueueQuestionModalForApp(state)])
}

// --- App -------------------------------------------------------------------
// The subscriptions array is fixed-size with stable positions: [0] always polls the run list (which now also carries provider health), the pending questions, and the task queue every second while the page is visible; [1] polls the selected run's run view and flow model every second but only on the watch screen, while the page is visible, and while the run is selected and not settled for polling (terminal or suspended stop it); [2] primes the AudioContext on the first user interaction; [3] dismisses the inspector modal on Escape while it is open; [4] subscribes the live token stream to the selected run under the same settled-for-polling guard [1] uses, so a suspended run keeps no stream open; [5] tracks page visibility and refreshes immediately when the tab returns.

// hyperapp re-enters `view` and `subscriptions` with the state it holds, but the vendored declaration types that re-entry as `unknown` (it is app-agnostic). The state provably stays an ApplicationState — init plants a checked literal and every action returns a checked transition — so this guard confirms the wiring rather than re-validating data, and a mismatch fails the mount instead of rendering garbage.
function isApplicationState(value: unknown): value is ApplicationState {
	if (!isObject(value)) return false
	const stateKeys: (keyof ApplicationState)[] = [
		'summaries', 'selectedRunId', 'selectedRunView', 'selectedRunStatus', 'pendingQuestions', 'providerHealth',
		'queueItems', 'justSubmittedItemId', 'pendingAddSelectionId', 'editingItemId', 'draggingItemId', 'queueAnswerPendingId', 'queueTerminatePendingId', 'openQueueQuestionId', 'pendingResumeItemId',
		'serverAvailable', 'versions', 'justSubmittedRunId', 'createSending', 'muted', 'shownQuestionIds', 'firstQuestionsPoll', 'pendingAnswerId',
		'runEffort', 'savingEffort', 'runInvolvement', 'savingInvolvement', 'runLogLevel', 'savingLogLevel',
		'flowModel', 'previousFlowModel', 'flowFeed', 'runListFeed', 'runListLoaded', 'queueLoaded', 'labelResolver', 'guildParticipants', 'build',
		'flowTier', 'flowViewMode', 'sequenceRolesOnly', 'screen', 'pageVisible', 'flowRefreshPending', 'expandedRowIds', 'continuation',
		'resumingRunId', 'resumeSending', 'resumeNotice',
		'questionModalOpen', 'resultModalOpen', 'resultShownForRun', 'suspendedModalOpen', 'suspendedActionNotice', 'resumeRunPendingId', 'resultLoad', 'interruptModalOpen',
		'inspectorModalOpen', 'planExpanded', 'livePartial', 'streamConnected', 'streamWasConnectedOnce', 'tooltip',
		'interruptMode', 'interruptSending', 'interruptNotice', 'interruptAnswerCard', 'shownInterruptAnswerKeys', 'now',
	]
	return stateKeys.every((key) => key in value)
}

// A missing mount element is a broken page, so the lookup throws with the id rather than handing null into hyperapp's mount.
function requireMountNode(id: string): HTMLElement {
	const node = document.getElementById(id)
	if (node === null) throw new Error(`the app mount point is missing element "${id}"`)
	return node
}

app({
	init: [
		{
			summaries: [],
			selectedRunId: null,
			selectedRunView: null,
			selectedRunStatus: null,
			pendingQuestions: [],
			providerHealth: null,
			queueItems: [],
			justSubmittedItemId: null,
			pendingAddSelectionId: null,
			editingItemId: null,
			draggingItemId: null,
			queueAnswerPendingId: null,
			queueTerminatePendingId: null,
			openQueueQuestionId: null,
			pendingResumeItemId: null,
			serverAvailable: true,
			versions: {},
			justSubmittedRunId: null,
			createSending: false,
			muted: false,
			shownQuestionIds: {},
			firstQuestionsPoll: true,
			pendingAnswerId: null,
			runEffort: null,
			savingEffort: false,
			runInvolvement: null,
			savingInvolvement: false,
			runLogLevel: null,
			savingLogLevel: false,
			flowModel: null,
			previousFlowModel: null,
			flowFeed: emptyFlowFeedState(),
			runListFeed: emptyRunListFeedState(),
			runListLoaded: false,
			queueLoaded: false,
			labelResolver: null,
			guildParticipants: [],
			build: null,
			flowTier: DEFAULT_FLOW_TIER,
			flowViewMode: 'flow',
			sequenceRolesOnly: true,
			screen: 'watch',
			pageVisible: document.visibilityState === 'visible',
			flowRefreshPending: false,
			expandedRowIds: {},
			continuation: null,
			resumingRunId: null,
			resumeSending: false,
			resumeNotice: null,
			questionModalOpen: false,
			resultModalOpen: false,
			resultShownForRun: null,
			suspendedModalOpen: false,
			suspendedActionNotice: null,
			resumeRunPendingId: null,
			resultLoad: null,
			interruptModalOpen: false,
			inspectorModalOpen: false,
			planExpanded: false,
			livePartial: null,
			streamConnected: false,
			streamWasConnectedOnce: false,
			tooltip: null,
			interruptMode: 'inquiry',
			interruptSending: false,
			interruptNotice: null,
			interruptAnswerCard: null,
			shownInterruptAnswerKeys: {},
			now: Date.now(),
		},
		// The guild config and the saved settings (effort, involvement, and logging level) are each loaded once on load and never polled, so their fetches are init effects rather than subscriptions.
		Fetch({ url: 'api/config', ok: GotConfig, fail: FetchFailed }),
		Fetch({ url: 'api/settings', ok: GotSettings, fail: SettingsFetchFailed }),
	],
	view: (state) => {
		if (!isApplicationState(state)) throw new Error('hyperapp re-entered with a state that is not an ApplicationState')
		return view(state)
	},
	subscriptions: (state) => {
		if (!isApplicationState(state)) throw new Error('hyperapp re-entered with a state that is not an ApplicationState')
		return [
			state.pageVisible && onEvery(Tick, POLL_INTERVAL_MS),
			// A null selectedRunStatus (a just-selected run whose first per-run poll has not landed) reads as non-terminal — the dynamic set lookup missed null — so the per-run poll and the stream stay live across a run switch until the first frame arrives.
			state.pageVisible && state.screen === 'watch' && hasPollableSelectedRun(state) && onEvery(PollSelectedRun, POLL_INTERVAL_MS),
			onFirstInteraction(PrimeAudio),
			state.inspectorModalOpen === true && onEscapeKey(CloseInspectorModal),
			state.screen === 'watch' && hasPollableSelectedRun(state) && StreamSubscription(state.selectedRunId),
			onVisibilityChange(PageVisibilityChanged),
		]
	},
	node: requireMountNode('app'),
})
