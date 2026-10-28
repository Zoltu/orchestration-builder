import { isObject } from '../guards.js'
import { readEventIndex } from './values.js'

// The usage triple the transcript header renders, or null when the payload carries none (absent, non-object, or non-numeric fields).
export interface TurnUsage {
	promptTokens: number
	completionTokens: number
	totalTokens: number
	cachedPromptTokens?: number
}

// One LLM turn as the turn index derives it. `eventIndex` is the turn's identity in the log (a completed turn's `llm_call` event; an in-flight turn's `llm_call_start` event). `roleId` is the turn's role-instance id, read from the payload and required on current turn events.
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

// An `llm_call_start` awaiting its matching `llm_call`, held by role instance id until pairing or a role failure closes the bracket. The same start is also tracked under its role name so a failure event without a roleId (`llm_unavailable`/`context_budget_exceeded`) can close the newest open start for that role; `provider_failure` carries a roleId and closes the exact instance.
interface OpenTurnStart {
	eventIndex: number
	timestamp: string | null
	role: string
	roleId: string
}

function appendOpenStart(openStartsByRoleId: Map<string, OpenTurnStart[]>, openStartsByRole: Map<string, OpenTurnStart[]>, start: OpenTurnStart): void {
	const byId = openStartsByRoleId.get(start.roleId)
	if (byId === undefined) openStartsByRoleId.set(start.roleId, [start])
	else byId.push(start)
	const byRole = openStartsByRole.get(start.role)
	if (byRole === undefined) openStartsByRole.set(start.role, [start])
	else byRole.push(start)
}

function removeOpenStart(openStarts: OpenTurnStart[] | undefined, start: OpenTurnStart): void {
	if (openStarts === undefined) return
	const index = openStarts.indexOf(start)
	if (index >= 0) openStarts.splice(index, 1)
}

// Derives the turn index from a window of log events. An `llm_call` event becomes a completed entry; an `llm_call_start` becomes an in-flight entry unless a matching `llm_call` for the same role instance follows it, in which case they pair into one completed entry. Matching is LIFO per roleId so the same-name nesting the executor allows pairs like brackets. A `provider_failure` carries a roleId and closes that exact instance's newest open start; an `llm_unavailable` or `context_budget_exceeded` carries only the role name and closes that role's newest open start. Either way the failed turn is not left matched to nothing. Entries come back in chronological order with 1-based `turnNumber`s; turn events without a roleId are malformed and skipped.
export function buildTurnIndex(logEvents: unknown): TurnEntry[] {
	if (!Array.isArray(logEvents)) return []
	const openStartsByRoleId = new Map<string, OpenTurnStart[]>()
	const openStartsByRole = new Map<string, OpenTurnStart[]>()
	const entries: TurnEntry[] = []
	for (const event of logEvents) {
		if (!isObject(event)) continue
		const type = event['type']
		if (type !== 'llm_call' && type !== 'llm_call_start' && type !== 'llm_unavailable' && type !== 'context_budget_exceeded' && type !== 'provider_failure') continue
		const payload = event['payload']
		if (!isObject(payload)) continue
		const role = typeof payload['role'] === 'string' && payload['role'] !== '' ? payload['role'] : null
		if (role === null) continue
		if (type === 'llm_unavailable' || type === 'context_budget_exceeded' || type === 'provider_failure') {
			const failureRoleId = typeof payload['roleId'] === 'string' && payload['roleId'] !== '' ? payload['roleId'] : null
			const open = failureRoleId !== null ? openStartsByRoleId.get(failureRoleId) : openStartsByRole.get(role)
			const start = open !== undefined && open.length > 0 ? open.pop() : undefined
			if (start !== undefined) removeOpenStart(openStartsByRoleId.get(start.roleId), start)
			continue
		}
		const eventIndex = readEventIndex(event['index'])
		if (eventIndex === null) continue
		const roleId = typeof payload['roleId'] === 'string' && payload['roleId'] !== '' ? payload['roleId'] : null
		if (roleId === null) continue
		const timestamp = typeof event['timestamp'] === 'string' ? event['timestamp'] : null
		if (type === 'llm_call_start') {
			appendOpenStart(openStartsByRoleId, openStartsByRole, { eventIndex, timestamp, role, roleId })
			continue
		}
		const open = openStartsByRoleId.get(roleId)
		const start = open !== undefined && open.length > 0 ? open.pop() : undefined
		if (start !== undefined) removeOpenStart(openStartsByRole.get(start.role), start)
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
	for (const open of openStartsByRoleId.values()) {
		for (const start of open) {
			entries.push({
				kind: 'in_flight',
				eventIndex: start.eventIndex,
				startEventIndex: null,
				turnNumber: 0,
				role: start.role,
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
