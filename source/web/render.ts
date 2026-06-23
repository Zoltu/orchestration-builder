// Pure helpers that turn raw run artifacts and pending questions into the JSON shapes returned by the web API.
// All parsing, validation, truncation, and role-activity derivation lives here so it is exercisable in-memory; the server module is a thin HTTP leaf that delegates to these helpers.

import type { PendingQuestion } from '../executor/human-backend.js'
import { isRunMeta } from '../executor/validation.js'
import type { LogEvent, ResultCard, RunMeta } from '../executor/types.js'
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
	toolsCalled: string[]
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
				toolsCalled: [],
			}
			byRole.set(role, entry)
			order.push(role)
		}
		entry.lastSeen = event.timestamp
		entry.eventCount++
		if (event.type === 'llm_call') entry.llmCalls++
		if (event.type === 'tool_call') {
			entry.toolCalls++
			const tool = toolOf(event.payload)
			if (tool !== null && !entry.toolsCalled.includes(tool)) {
				entry.toolsCalled.push(tool)
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

export interface CurrentActivity {
	role: string | null
	summary: string
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
}

export interface RenderRunViewOptions {
	maxLogLines: number
}

export function renderRunView(snapshot: RunSnapshot, options: RenderRunViewOptions): RunView {
	const meta = snapshot.meta
	const recentEvents = snapshot.logEvents.slice(-options.maxLogLines)
	const recentLog: RecentLogEntry[] = recentEvents.map((event) => ({
		timestamp: event.timestamp,
		type: event.type,
		summary: formatLogEvent(event),
		payload: event.payload,
	}))
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
