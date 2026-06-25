// Pure helpers that turn raw run artifacts and pending questions into the JSON shapes returned by the web API.
// All parsing, validation, truncation, and role-activity derivation lives here so it is exercisable in-memory; the server module is a thin HTTP leaf that delegates to these helpers.

import type { PendingQuestion } from '../executor/human-backend.js'
import { isRunMeta } from '../executor/validation.js'
import type { ExecutorConfig, GuildConfig, LogEvent, ResultCard, RunMeta } from '../executor/types.js'
import type { RunSnapshotRaw } from '../executor/persistence.js'

export interface RunSnapshot {
	meta: RunMeta | null
	logEvents: LogEvent[]
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Parses meta.json text into a validated RunMeta, or null when absent.
// A present but malformed meta is treated as absent: meta.json is written atomically at run completion, so a malformed read is most likely a torn read mid-write, and the UI should fall back to "in progress" rather than crash.
function parseMeta(metaText: string | null): RunMeta | null {
	if (metaText === null) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(metaText)
	} catch {
		return null
	}
	return isRunMeta(parsed) ? parsed : null
}

// Parses log.jsonl text into a list of validated log events.
// Each non-empty line is parsed independently; lines that fail to parse or do not satisfy the LogEvent shape are skipped.
// The log is append-only and read concurrently with writes, so a partial final line is the expected failure mode and must not abort the whole tail.
export function parseLogEvents(logText: string): LogEvent[] {
	const events: LogEvent[] = []
	for (const line of logText.split('\n')) {
		if (line === '') continue
		let parsed: unknown
		try {
			parsed = JSON.parse(line)
		} catch {
			continue
		}
		if (!isObject(parsed)) continue
		if (typeof parsed.timestamp !== 'string') continue
		if (typeof parsed.type !== 'string') continue
		events.push({ timestamp: parsed.timestamp, type: parsed.type, payload: parsed.payload })
	}
	return events
}

export function parseRunSnapshot(raw: RunSnapshotRaw): RunSnapshot {
	return {
		meta: parseMeta(raw.metaText),
		logEvents: parseLogEvents(raw.logText),
	}
}

function roleOf(payload: unknown): string | null {
	if (!isObject(payload)) return null
	if (typeof payload.role !== 'string') return null
	return payload.role
}

function toolOf(payload: unknown): string | null {
	if (!isObject(payload)) return null
	if (typeof payload.tool !== 'string') return null
	return payload.tool
}

function stringField(payload: unknown, field: string): string | null {
	if (!isObject(payload)) return null
	const value = payload[field]
	return typeof value === 'string' ? value : null
}

function numberField(payload: unknown, field: string): number | null {
	if (!isObject(payload)) return null
	const value = payload[field]
	return typeof value === 'number' ? value : null
}

function withRole(role: string | null, action: string): string {
	return role === null ? action : `${role} · ${action}`
}

// Turns a single log event into a one-line human-readable summary derived from its type and well-known payload fields.
// The log is append-only and read concurrently with writes, so every payload access is guarded and the function never throws on a partial or unexpected shape.
export function formatLogEvent(event: LogEvent): string {
	const payload = event.payload
	const role = roleOf(payload)

	switch (event.type) {
		case 'llm_call':
			return withRole(role, 'llm call')
		case 'tool_call':
			return withRole(role, stringField(payload, 'tool') ?? 'tool call')
		case 'tool_result': {
			const tool = stringField(payload, 'tool')
			const kind = stringField(payload, 'kind')
			return withRole(role, `${tool ?? 'tool'} result${kind !== null ? ` (${kind})` : ''}`)
		}
		case 'role_finished': {
			const status = stringField(payload, 'status')
			return withRole(role, `finished${status !== null ? ` (${status})` : ''}`)
		}
		case 'implicit_finish':
			return withRole(role, 'finished (implicit)')
		case 'llm_unavailable':
			return withRole(role, 'llm unavailable')
		case 'context_budget_exceeded':
			return withRole(role, 'context budget exceeded')
		case 'role_budget_exceeded':
			return withRole(role, 'role budget exceeded')
		case 'global_budget_exceeded':
			return withRole(role, 'global budget exceeded')
		case 'unknown_tool': {
			const tool = stringField(payload, 'tool')
			return withRole(role, `unknown tool${tool !== null ? ` (${tool})` : ''}`)
		}
		case 'invalid_tool_call': {
			const tool = stringField(payload, 'tool')
			return withRole(role, `invalid tool call${tool !== null ? ` (${tool})` : ''}`)
		}
		case 'depth_exceeded': {
			const parent = stringField(payload, 'parent')
			const child = stringField(payload, 'child')
			const depth = numberField(payload, 'depth')
			return withRole(parent, `depth exceeded (${child ?? 'child'} at depth ${depth ?? '?'})`)
		}
		case 'role_not_found': {
			const parent = stringField(payload, 'parent')
			const roleName = stringField(payload, 'roleName')
			return withRole(parent ?? role, `role not found${roleName !== null ? ` (${roleName})` : ''}`)
		}
		default:
			return role === null ? event.type : `${event.type} · ${role}`
	}
}

export interface RoleActivity {
	role: string
	firstSeen: string
	lastSeen: string
	eventCount: number
	llmCalls: number
	toolCalls: number
	// The last few distinct tools the role called, most-recent-last, capped at 3. Distinct because a tight loop on one tool would otherwise fill the list with repeats and hide what else the role touched.
	recentTools: string[]
	// The prompt-token count from the role's most recent llm_call that carried usage, i.e. the last context window size the endpoint billed for that role (cached + uncached prompt). Null until the role's first call reports usage.
	lastPromptTokens: number | null
}

// Derives a per-role activity summary from the log event stream.
// The executor does not persist a live role tree, so the UI renders the roles that appear in the log with their observed activity.
// A strict parent-child tree would require the executor to log agent-spawn events with parent, child, and depth.
export function deriveRoleActivity(logEvents: LogEvent[]): RoleActivity[] {
	const order: string[] = []
	const byRole = new Map<string, RoleActivity>()
	for (const event of logEvents) {
		const role = roleOf(event.payload)
		if (role === null) continue
		let entry = byRole.get(role)
		if (entry === undefined) {
			entry = {
				role,
				firstSeen: event.timestamp,
				lastSeen: event.timestamp,
				eventCount: 0,
				llmCalls: 0,
				toolCalls: 0,
				recentTools: [],
				lastPromptTokens: null,
			}
			byRole.set(role, entry)
			order.push(role)
		}
		entry.lastSeen = event.timestamp
		entry.eventCount++
		if (event.type === 'llm_call') {
			entry.llmCalls++
			// Each llm_call with usage refreshes the role's last-seen context window size, so the panel reflects the live prompt footprint rather than a run total.
			const usage = usageOf(event.payload)
			if (usage !== null) entry.lastPromptTokens = usage.promptTokens
		}
		if (event.type === 'tool_call') {
			entry.toolCalls++
			const tool = toolOf(event.payload)
			if (tool !== null) {
				// Move the tool to the most-recent position (removing any earlier occurrence) and cap at the last 3 distinct, so the list reflects recency rather than first-use order.
				const existing = entry.recentTools.indexOf(tool)
				if (existing >= 0) entry.recentTools.splice(existing, 1)
				entry.recentTools.push(tool)
				if (entry.recentTools.length > 3) entry.recentTools.shift()
			}
		}
	}
	return order.map((role) => byRole.get(role)!)
}

export interface RecentLogEntry {
	timestamp: string
	type: string
	summary: string
	payload: unknown
}

// Builds the readable-view entry for a single log event: the raw payload is carried alongside a one-line summary so the UI can render the summary by default and expose the payload on demand.
// Centralized here so both the recent-log view and the paginated log endpoint derive entries the same way.
export function toRecentLogEntry(event: LogEvent): RecentLogEntry {
	return {
		timestamp: event.timestamp,
		type: event.type,
		summary: formatLogEvent(event),
		payload: event.payload,
	}
}

export interface PaginatedLog {
	events: LogEvent[]
	total: number
	offset: number
	limit: number
}

// Returns a page of log events as a slice of the full event list, plus the paging metadata a UI needs to drive "load earlier" and report counts.
// An offset past the end yields an empty page with the correct total rather than clamping silently, so the UI can stop offering more once offset 0 is reached.
export function paginateLogEvents(events: LogEvent[], options: { offset: number, limit: number }): PaginatedLog {
	const offset = options.offset
	const limit = options.limit
	const total = events.length
	const page = offset >= total ? [] : events.slice(offset, offset + limit)
	return { events: page, total, offset, limit }
}

// Renders the full log as plain text, one event per line, for export.
// Each line is tab-separated: timestamp, type, then the readable summary from formatLogEvent, so the export mirrors exactly what the on-screen log shows.
export function formatLogAsText(events: LogEvent[]): string {
	return events.map((event) => `${event.timestamp}\t${event.type}\t${formatLogEvent(event)}`).join('\n')
}

export interface CurrentActivity {
	role: string | null
	summary: string
}

export interface TokenUsage {
	// Full prompt bill: uncached + cached prompt tokens. This is what the endpoint charged against the prompt side of any per-role token budget.
	promptTokens: number
	// Subset of promptTokens the endpoint served from its prompt cache. Tracked separately because cached tokens are billed at a different (usually much lower) rate than uncached prompt tokens.
	cachedPromptTokens: number
	completionTokens: number
	totalTokens: number
}

export interface Budgets {
	elapsedSeconds: number
	toolCalls: number
	// Overall token total across the run, or null when no llm_call event carries usage (a run whose calls all failed before reporting usage, or a log written before usage was logged).
	tokensUsed: number | null
	// Per-bucket breakdown backing tokensUsed, or null for the same reason. Each bucket is 0 (not null) when usage is present but a given call reported no tokens for that bucket.
	tokenBreakdown: TokenUsage | null
}

// Reads the per-call usage from an llm_call payload, or null when the payload carries no usage object.
// totalTokens is preferred (it is what the executor logs); prompt+completion is summed as a fallback for events logged before that field existed or by older log writers, so a partial log still contributes its real cost.
// cachedPromptTokens is read from usage.cachedPromptTokens when present (already counted inside promptTokens); when absent it contributes 0 to the cached bucket, since the endpoint simply did not report a cached share for that call.
function usageOf(payload: unknown): { promptTokens: number; completionTokens: number; cachedPromptTokens: number; totalTokens: number } | null {
	if (!isObject(payload)) return null
	const usage = payload['usage']
	if (!isObject(usage)) return null
	const total = usage['totalTokens']
	const prompt = usage['promptTokens']
	const completion = usage['completionTokens']
	const cached = usage['cachedPromptTokens']

	const hasTotal = typeof total === 'number'
	const hasPromptCompletion = typeof prompt === 'number' && typeof completion === 'number'
	if (!hasTotal && !hasPromptCompletion) return null

	const promptTokens = typeof prompt === 'number' ? prompt : 0
	const completionTokens = typeof completion === 'number' ? completion : 0
	const cachedPromptTokens = typeof cached === 'number' ? cached : 0
	const totalTokens = hasTotal ? total! : promptTokens + completionTokens
	return { promptTokens, completionTokens, cachedPromptTokens, totalTokens }
}

// Derives the run's progress against its hard safety budgets from the log stream and meta.
// `now` is passed in (the server supplies `new Date().toISOString()`) so elapsed-time tests are deterministic; the helper never reads the clock itself.
// Elapsed time uses meta.endTime for a completed run and `now` for an in-progress run; when meta is absent (run in progress, meta.json not yet written) the first log event's timestamp stands in for the start, so elapsed is recoverable even before meta exists.
// Clock skew that would make `now` precede the start is clamped to 0.
// Token totals are null when no llm_call event carries usage; otherwise each bucket is summed across all calls that reported usage, and tokensUsed is the sum of the per-call totals.
export function deriveBudgets(logEvents: LogEvent[], meta: RunMeta | null, now: string): Budgets {
	const startTime = meta !== null ? meta.startTime : (logEvents.length > 0 ? logEvents[0]!.timestamp : null)
	const endTime = meta !== null && meta.endTime !== undefined ? meta.endTime : now

	let elapsedSeconds = 0
	if (startTime !== null) {
		const startMs = Date.parse(startTime)
		const endMs = Date.parse(endTime)
		if (!Number.isNaN(startMs) && !Number.isNaN(endMs)) {
			elapsedSeconds = Math.max(0, Math.round((endMs - startMs) / 1000))
		}
	}

	let toolCalls = 0
	let sawUsage = false
	let promptSum = 0
	let cachedSum = 0
	let completionSum = 0
	let totalSum = 0
	for (const event of logEvents) {
		if (event.type === 'tool_call') toolCalls++
		if (event.type === 'llm_call') {
			const usage = usageOf(event.payload)
			if (usage !== null) {
				sawUsage = true
				promptSum += usage.promptTokens
				cachedSum += usage.cachedPromptTokens
				completionSum += usage.completionTokens
				totalSum += usage.totalTokens
			}
		}
	}

	return {
		elapsedSeconds,
		toolCalls,
		tokensUsed: sawUsage ? totalSum : null,
		tokenBreakdown: sawUsage ? { promptTokens: promptSum, cachedPromptTokens: cachedSum, completionTokens: completionSum, totalTokens: totalSum } : null,
	}
}

export interface QuestionHistoryEntry {
	id: string | null
	question: string
	context?: string
	askedAt: string
	answer?: string
	answeredAt?: string
}

// Pairs ask_human log events with their resolved human_answer events to reconstruct a run's Q&A history in log order.
// Pairing is by question id (both events carry it); an ask_human whose id never receives a human_answer stays unanswered.
// The log is append-only and read concurrently with writes, so every payload access is guarded and the function never throws on a partial or unexpected shape.
export function deriveQuestionHistory(logEvents: LogEvent[]): QuestionHistoryEntry[] {
	const entries: QuestionHistoryEntry[] = []
	const indexById = new Map<string, number>()

	for (const event of logEvents) {
		const payload = event.payload
		if (!isObject(payload)) continue

		if (event.type === 'ask_human') {
			const question = stringField(payload, 'question')
			if (question === null) continue
			const id = stringField(payload, 'id')
			const context = stringField(payload, 'context')
			const entry: QuestionHistoryEntry = {
				id,
				question,
				askedAt: event.timestamp,
				...(context !== null ? { context } : {}),
			}
			const index = entries.length
			entries.push(entry)
			if (id !== null && !indexById.has(id)) indexById.set(id, index)
		} else if (event.type === 'human_answer') {
			const id = stringField(payload, 'id')
			if (id === null) continue
			const answer = stringField(payload, 'answer')
			if (answer === null) continue
			const index = indexById.get(id)
			if (index === undefined) continue
			const entry = entries[index]!
			entry.answer = answer
			entry.answeredAt = event.timestamp
		}
	}
	return entries
}

export interface RunView {
	status: RunMeta['status'] | 'unknown'
	runId: string | null
	task: string | null
	startTime: string | null
	endTime: string | null
	result: ResultCard | null
	error: NonNullable<RunMeta['error']> | null
	roles: RoleActivity[]
	recentLog: RecentLogEntry[]
	currentActivity: CurrentActivity | null
	questionHistory: QuestionHistoryEntry[]
	budgets: Budgets
}

export interface RenderRunViewOptions {
	maxLogLines: number
	now: string
}

export function renderRunView(snapshot: RunSnapshot, options: RenderRunViewOptions): RunView {
	const meta = snapshot.meta
	const recentEvents = snapshot.logEvents.slice(-options.maxLogLines)
	const recentLog: RecentLogEntry[] = recentEvents.map(toRecentLogEntry)
	const lastEvent = snapshot.logEvents.length > 0 ? snapshot.logEvents[snapshot.logEvents.length - 1] : null
	const currentActivity: CurrentActivity | null = lastEvent === null || lastEvent === undefined
		? null
		: { role: roleOf(lastEvent.payload), summary: formatLogEvent(lastEvent) }
	return {
		status: meta === null ? 'unknown' : meta.status,
		runId: meta === null ? null : meta.runId,
		task: meta === null ? null : meta.task,
		startTime: meta === null ? null : meta.startTime,
		endTime: meta === null ? null : (meta.endTime ?? null),
		result: meta === null ? null : (meta.result ?? null),
		error: meta === null ? null : (meta.error ?? null),
		roles: deriveRoleActivity(snapshot.logEvents),
		recentLog,
		currentActivity,
		questionHistory: deriveQuestionHistory(snapshot.logEvents),
		budgets: deriveBudgets(snapshot.logEvents, meta, options.now),
	}
}

export interface RunSummary {
	runId: string
	status: RunMeta['status'] | 'unknown'
	task: string | null
	startTime: string | null
	endTime: string | null
}

// A lightweight per-run summary for the run-list endpoint: it carries the identity and lifecycle fields a listing needs without the role activity or recent log a per-run view carries.
// `runId` comes from the directory name rather than the meta because meta is null while a run is in progress.
export function renderRunSummary(runId: string, snapshot: RunSnapshot): RunSummary {
	const meta = snapshot.meta
	return {
		runId,
		status: meta === null ? 'unknown' : meta.status,
		task: meta === null ? null : meta.task,
		startTime: meta === null ? null : meta.startTime,
		endTime: meta === null ? null : (meta.endTime ?? null),
	}
}

export interface ApiQuestion {
	id: string
	question: string
	context?: string
	askedAt: string
}

// Shapes pending questions into the stable API form.
// `context` is included only when defined so the JSON omits it for contextless questions; order is preserved.
export function renderPendingQuestions(questions: PendingQuestion[]): ApiQuestion[] {
	return questions.map((question) => {
		const shaped: ApiQuestion = {
			id: question.id,
			question: question.question,
			askedAt: question.askedAt,
		}
		if (question.context !== undefined) shaped.context = question.context
		return shaped
	})
}

export interface GuildConfigView {
	model: { name: string; contextWindow: number }
	executor: ExecutorConfig
	entryRole: string
	roles: Record<string, { tools: string[] }>
}

// Shapes a read-only, key-safe view of the loaded Guild for the /api/config endpoint.
// Only the model's name and context window are carried; apiKey and apiBase are structurally omitted, so the endpoint can never leak the injected key or the endpoint URL regardless of what the loaded Guild contains.
// The executor budgets are passed through verbatim because they are operator-facing limits, not secrets; every role contributes its tool list so the panel can show the full role/tool matrix.
export function renderConfig(config: GuildConfig): GuildConfigView {
	const roles: Record<string, { tools: string[] }> = {}
	for (const [name, role] of Object.entries(config.roles)) {
		roles[name] = { tools: role.tools }
	}
	return {
		model: { name: config.model.name, contextWindow: config.model.contextWindow },
		executor: config.executor,
		entryRole: config.entryRole,
		roles,
	}
}
