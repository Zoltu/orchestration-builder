import type { LogEvent } from '../../executor/types.js'
import { isObject } from '../../executor/validation.js'
import { payloadString } from '../payload.js'

// Folds an llm_call event's delta back into the full sent conversation (docs/reference.md "Log events" documents the wire protocol): the event's sent list starts at conversation index sentFrom, and the messages below it live on the role instance's earlier llm_call events. The walk goes backward over same-instance llm_call events matched strictly on roleId, since a role may spawn a same-named child whose interleaved events would corrupt a name-based walk; each contributes the head of its sent list down to the still-uncovered index. An event without a usable roleId cannot participate: a malformed target is returned unchanged and a malformed prior event is skipped. Absent sentFrom reads as 0, so a full-snapshot event without sentFrom both contributes and ends the walk. The walk stops once the covered range reaches index 0. Each request is its predecessor's plus appended messages, so the concatenated slices are element-identical to the request a full-snapshot event would have carried. Returns the event unchanged for anything that is not a delta-carrying llm_call (a full snapshot with sentFrom 0, or the standard level's body-less event), and never mutates the input events.
export function foldLlmCallSent(events: LogEvent[], index: number): LogEvent {
	const event = events[index]
	if (event === undefined) throw new Error(`foldLlmCallSent: no event at log index ${index}`)
	if (event.type !== 'llm_call') return event
	if (!isObject(event.payload)) return event
	const payload = event.payload
	const sent = payload['sent']
	if (!Array.isArray(sent)) return event
	const sentFromValue = payload['sentFrom']
	if (typeof sentFromValue !== 'number' || !Number.isInteger(sentFromValue) || sentFromValue <= 0) return event
	const instanceId = payloadString(payload, 'roleId')
	if (instanceId === null) return event

	// Parts are collected backward (each covering the range below the previous one) and flattened in forward order at the end.
	const parts: Array<Array<unknown>> = [sent]
	let uncoveredFrom = sentFromValue
	for (let prior = index - 1; prior >= 0 && uncoveredFrom > 0; prior--) {
		const priorEvent = events[prior]
		if (priorEvent === undefined || priorEvent.type !== 'llm_call') continue
		if (!isObject(priorEvent.payload)) continue
		const priorInstanceId = payloadString(priorEvent.payload, 'roleId')
		if (priorInstanceId !== instanceId) continue
		const priorSent = priorEvent.payload['sent']
		if (!Array.isArray(priorSent)) continue
		// A replayed turn after a restart re-emits its llm_call with the same sentFrom, so a prior event can start at or above the uncovered index; it then contributes nothing and the walk continues past it.
		const priorFromValue = priorEvent.payload['sentFrom']
		const priorFrom = typeof priorFromValue === 'number' && Number.isInteger(priorFromValue) && priorFromValue > 0 ? priorFromValue : 0
		const takeCount = Math.max(0, Math.min(uncoveredFrom - priorFrom, priorSent.length))
		if (takeCount > 0) {
			parts.push(priorSent.slice(0, takeCount))
			uncoveredFrom = priorFrom
		}
	}
	const folded: Array<unknown> = []
	for (let part = parts.length - 1; part >= 0; part--) {
		const slice = parts[part]
		if (slice === undefined) continue
		folded.push(...slice)
	}
	return { timestamp: event.timestamp, type: event.type, payload: { ...payload, sent: folded } }
}

export interface PaginatedLog {
	events: LogEvent[]
	total: number
	offset: number
	limit: number
}

// Returns a page of log events as a slice of the full event list, plus the paging metadata a UI needs to drive "load earlier" and report counts. An offset past the end yields an empty page with the correct total rather than clamping silently, so the UI can stop offering more once offset 0 is reached.
export function paginateLogEvents(events: LogEvent[], options: { offset: number, limit: number }): PaginatedLog {
	const offset = options.offset
	const limit = options.limit
	const total = events.length
	const page = offset >= total ? [] : events.slice(offset, offset + limit)
	return { events: page, total, offset, limit }
}

// --- Per-instance log filtering ----------------------------------------------

// One filtered log event paired with its log-wide index: the window endpoint's rows are addressed by the event's position in the FULL log (the identity the client's page stitching and detail links depend on), which a filtered list's array position no longer implies.
export interface IndexedLogEvent {
	event: LogEvent
	index: number
}

interface InstanceStartRecord {
	roleId: string
	role: string
	parentRoleId: string | null
}

// The role_start records the ancestry walk resolves through, keyed by instance id. The first start per id wins (instance ids are unique per run; a duplicate is a malformed log), and a start without a usable roleId cannot be addressed by id and never enters the map — the client's chain walk (ts/inspector-modal.ts deriveInstanceChain) cannot see it either.
function instanceStartsOf(events: LogEvent[]): Map<string, InstanceStartRecord> {
	const starts = new Map<string, InstanceStartRecord>()
	for (const event of events) {
		if (event.type === 'role_start' && isObject(event.payload)) {
			const roleId = payloadString(event.payload, 'roleId')
			const role = payloadString(event.payload, 'role')
			if (roleId !== null && role !== null && !starts.has(roleId)) {
				starts.set(roleId, {
					roleId,
					role,
					parentRoleId: payloadString(event.payload, 'parentRoleId'),
				})
			}
		}
	}
	return starts
}

// The parent start for one walked instance, or null when the chain ends. A start names its parent instance through parentRoleId; without one the chain ends. A named parent whose start is absent from the log ends the walk: the server sees the full log, so an unresolved id is a genuinely torn or foreign log, and the chain renders as far as it is known. A cycle in a malformed log ends the walk too.
function resolveParentStart(start: InstanceStartRecord, starts: Map<string, InstanceStartRecord>, visited: Set<string>): InstanceStartRecord | null {
	if (start.parentRoleId === null) return null
	if (visited.has(start.parentRoleId)) return null
	return starts.get(start.parentRoleId) ?? null
}

// Filters the log to one agent instance's view for `GET /api/runs/:id/log?instance=<roleId>`: the instance's own turns (`llm_call`/`llm_call_start`, matched strictly on the payload's roleId; an event without one is malformed and excluded), its role-named turn-failure events (`llm_unavailable`/`context_budget_exceeded` carry no roleId; single-flight execution makes the role-name match unambiguous, and the client's turn pairing closes a failed turn's bracket on them, so omitting them would render a failed turn as eternally in flight), its own `role_start`/`role_finished` lifecycle, and the lifecycle of its ancestor chain walked through `parentRoleId` to the root — the server sees the full log, so ancestry is always resolvable from it, which is the whole point of scoping server-side. Children are deliberately not included: the scoped transcript is the instance's own story, and the client's child-instance affordances read the unscoped tail window it keeps alongside. An id that names nothing yields an empty list, which the endpoint serves as a 200 with total 0 rather than a 404 so a stale client scope renders an empty transcript instead of an error. Cost is linear in the log: one pass builds the start map, the chain walk is bounded by the chain's depth, and one pass filters.
export function filterLogEventsForInstance(events: LogEvent[], instanceId: string): IndexedLogEvent[] {
	if (instanceId === '') return []
	const starts = instanceStartsOf(events)
	const ancestorIds = new Set<string>()
	const visited = new Set<string>([instanceId])
	let current = starts.get(instanceId)
	while (current !== undefined) {
		const parent = resolveParentStart(current, starts, visited)
		if (parent === null) break
		ancestorIds.add(parent.roleId)
		visited.add(parent.roleId)
		current = parent
	}
	const own = starts.get(instanceId)
	// The role name the turn-failure events match on: the instance's own start names it; without a start the supplied id is used, which matches only a role literally named for it.
	const ownRoleName = own !== undefined ? own.role : instanceId
	const filtered: IndexedLogEvent[] = []
	let index = 0
	for (const event of events) {
		if (isObject(event.payload)) {
			const payload = event.payload
			if (event.type === 'llm_call' || event.type === 'llm_call_start') {
				const roleId = payloadString(payload, 'roleId')
				if (roleId === instanceId) filtered.push({ event, index })
			} else if (event.type === 'llm_unavailable' || event.type === 'context_budget_exceeded') {
				if (payloadString(payload, 'role') === ownRoleName) filtered.push({ event, index })
			} else if (event.type === 'role_start' || event.type === 'role_finished') {
				const roleId = payloadString(payload, 'roleId')
				if (roleId === instanceId || (roleId !== null && ancestorIds.has(roleId))) filtered.push({ event, index })
			}
		}
		index += 1
	}
	return filtered
}
