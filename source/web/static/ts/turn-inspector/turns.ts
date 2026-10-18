import { isObject } from '../guards.js'
import { readEventIndex } from './values.js'

// The usage triple the transcript header renders, or null when the payload carries none (absent, non-object, or non-numeric fields).
export interface TurnUsage {
	promptTokens: number
	completionTokens: number
	totalTokens: number
	cachedPromptTokens?: number
}

// One LLM turn as the turn index derives it. `eventIndex` is the turn's identity in the log (a completed turn's `llm_call` event; an in-flight turn's `llm_call_start` event). `roleId` is the turn's role-instance id — the payload's `roleId` when present, else the role name (old logs' turn events carry no instance id), so an in-flight turn that completes keeps its instance and never jumps scope.
export interface TurnEntry {
	kind: 'completed' | 'in_flight'
	eventIndex: number
	// The paired `llm_call_start`'s index, on completed entries only.
	startEventIndex: number | null
	// 1-based, chronological over the loaded events.
	turnNumber: number
	role: string
	roleId: string
	// The full request's message count (the `llm_call` payload's `messageCount`; null when absent or malformed, and for in-flight turns).
	messageCount: number | null
	timestamp: string | null
	usage: TurnUsage | null
	finishReason: string | null
	// Body availability inferred from the payload shape.
	levelHint: 'full' | 'standard' | null
}

// The payload fields an `llm_call` keeps under the `standard` logging level: the sent and received bodies are dropped, so their presence in the payload is what distinguishes a full-detail turn from a metadata-only one.
function payloadLevelHint(payload: Record<string, unknown>): 'full' | 'standard' {
	if (Array.isArray(payload['sent'])) return 'full'
	if (isObject(payload['received'])) return 'full'
	return 'standard'
}

export function readUsage(value: unknown): TurnUsage | null {
	if (!isObject(value)) return null
	const promptTokens = value['promptTokens']
	const completionTokens = value['completionTokens']
	const totalTokens = value['totalTokens']
	if (typeof promptTokens !== 'number' || typeof completionTokens !== 'number' || typeof totalTokens !== 'number') return null
	if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens) || !Number.isFinite(totalTokens)) return null
	const usage: TurnUsage = { promptTokens, completionTokens, totalTokens }
	const cachedPromptTokens = value['cachedPromptTokens']
	if (typeof cachedPromptTokens === 'number' && Number.isFinite(cachedPromptTokens)) usage.cachedPromptTokens = cachedPromptTokens
	return usage
}

function readMessageCount(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
	return value
}

// An `llm_call_start` awaiting its matching `llm_call`, held per role name until pairing or failure closes the bracket.
interface OpenTurnStart {
	eventIndex: number
	timestamp: string | null
	roleId: string
}

// Derives the turn index from a window of log events. An `llm_call` event becomes a completed entry; an `llm_call_start` becomes an in-flight entry unless a matching `llm_call` for the same role follows it, in which case they pair into one completed entry. Matching is LIFO per role name so the same-name nesting the executor allows pairs like brackets. An `llm_unavailable` or `context_budget_exceeded` event closes the same role's newest open start instead of leaving it matched to nothing. Entries come back in chronological order with 1-based `turnNumber`s; malformed rows are skipped.
export function buildTurnIndex(logEvents: unknown): TurnEntry[] {
	if (!Array.isArray(logEvents)) return []
	const openStarts = new Map<string, OpenTurnStart[]>()
	const entries: TurnEntry[] = []
	for (const event of logEvents) {
		if (!isObject(event)) continue
		const type = event['type']
		if (type !== 'llm_call' && type !== 'llm_call_start' && type !== 'llm_unavailable' && type !== 'context_budget_exceeded') continue
		const payload = event['payload']
		if (!isObject(payload)) continue
		const role = typeof payload['role'] === 'string' && payload['role'] !== '' ? payload['role'] : null
		if (role === null) continue
		if (type === 'llm_unavailable' || type === 'context_budget_exceeded') {
			const failed = openStarts.get(role)
			if (failed !== undefined && failed.length > 0) failed.pop()
			continue
		}
		const eventIndex = readEventIndex(event['index'])
		if (eventIndex === null) continue
		const timestamp = typeof event['timestamp'] === 'string' ? event['timestamp'] : null
		const roleId = typeof payload['roleId'] === 'string' && payload['roleId'] !== '' ? payload['roleId'] : role
		if (type === 'llm_call_start') {
			const open = openStarts.get(role)
			if (open === undefined) {
				openStarts.set(role, [{ eventIndex, timestamp, roleId }])
			} else {
				open.push({ eventIndex, timestamp, roleId })
			}
			continue
		}
		const open = openStarts.get(role)
		const start = open !== undefined && open.length > 0 ? open.pop() : undefined
		entries.push({
			kind: 'completed',
			eventIndex,
			startEventIndex: start !== undefined ? start.eventIndex : null,
			turnNumber: 0,
			role,
			roleId,
			messageCount: readMessageCount(payload['messageCount']),
			timestamp,
			usage: readUsage(payload['usage']),
			finishReason: typeof payload['finishReason'] === 'string' && payload['finishReason'] !== '' ? payload['finishReason'] : null,
			levelHint: payloadLevelHint(payload),
		})
	}
	for (const [role, open] of openStarts) {
		for (const start of open) {
			entries.push({
				kind: 'in_flight',
				eventIndex: start.eventIndex,
				startEventIndex: null,
				turnNumber: 0,
				role,
				roleId: start.roleId,
				messageCount: null,
				timestamp: start.timestamp,
				usage: null,
				finishReason: null,
				levelHint: null,
			})
		}
	}
	entries.sort((a, b) => a.eventIndex - b.eventIndex)
	return entries.map((entry, position) => ({ ...entry, turnNumber: position + 1 }))
}

// The instance id the modal scopes to when the operator has not picked one: the most recently active instance in the freshly derived list — the newest turn still in flight (an unmatched `llm_call_start`), else the newest turn of any kind. Null when the list holds no usable entries.
export function deriveDefaultScopeRoleId(entries: unknown): string | null {
	if (!Array.isArray(entries)) return null
	let newest: string | null = null
	let newestInFlight: string | null = null
	for (const entry of entries) {
		if (!isObject(entry)) continue
		if (typeof entry['roleId'] !== 'string' || entry['roleId'] === '') continue
		newest = entry['roleId']
		if (entry['kind'] === 'in_flight') newestInFlight = entry['roleId']
	}
	return newestInFlight ?? newest
}

// The turn entries of one instance, renumbered 1-based within the instance. An unset or empty scope yields an empty list. Entries are copied so the renumbering never mutates the full list.
export function scopeTurnEntries(entries: unknown, scopedRoleId: unknown): TurnEntry[] {
	if (!Array.isArray(entries)) return []
	if (typeof scopedRoleId !== 'string' || scopedRoleId === '') return []
	const scoped: TurnEntry[] = []
	for (const entry of entries) {
		if (!isObject(entry)) continue
		if (entry['roleId'] !== scopedRoleId) continue
		scoped.push({
			kind: entry['kind'] === 'in_flight' ? 'in_flight' : 'completed',
			eventIndex: typeof entry['eventIndex'] === 'number' ? entry['eventIndex'] : 0,
			startEventIndex: typeof entry['startEventIndex'] === 'number' ? entry['startEventIndex'] : null,
			turnNumber: typeof entry['turnNumber'] === 'number' ? entry['turnNumber'] : 0,
			role: typeof entry['role'] === 'string' ? entry['role'] : '',
			roleId: typeof entry['roleId'] === 'string' ? entry['roleId'] : '',
			messageCount: readMessageCount(entry['messageCount']),
			timestamp: typeof entry['timestamp'] === 'string' ? entry['timestamp'] : null,
			usage: readUsage(entry['usage']),
			finishReason: typeof entry['finishReason'] === 'string' && entry['finishReason'] !== '' ? entry['finishReason'] : null,
			levelHint: entry['levelHint'] === 'full' || entry['levelHint'] === 'standard' ? entry['levelHint'] : null,
		})
	}
	return scoped.map((entry, position) => ({ ...entry, turnNumber: position + 1 }))
}
