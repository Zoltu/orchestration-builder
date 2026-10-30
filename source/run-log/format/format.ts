import type { LogEvent } from '../../executor/types.js'
import { isObject } from '../../executor/validation.js'
import { numberField, roleOf, stringField, withRole } from '../payload.js'

function formatLogEvent(event: LogEvent): string {
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
			const statusPart = status !== null ? ` (${status})` : ''
			// Status only: the role's full summary text can be long multi-line model prose and would inflate the one-line log row. The full summary and structured error are carried as paired detail sections (see formatLogDetailSections) so a reviewer reaches them via the raw toggle, not by widening the log line.
			return withRole(role, `finished${statusPart}`)
		}
		case 'implicit_finish':
			return withRole(role, 'finished (implicit)')
		case 'run_paused':
			return withRole(role, 'run paused by the operator')
		case 'llm_unavailable':
			return withRole(role, 'llm unavailable')
		case 'provider_failure': {
			const category = stringField(payload, 'category')
			const message = stringField(payload, 'message')
			const categoryPart = category !== null ? ` (${category})` : ''
			// Only the platform-authored message may reach a row; the provider body lives in detail and stays out of every summary surface.
			return withRole(role, message !== null ? `provider failure${categoryPart}: ${message}` : `provider failure${categoryPart}`)
		}
		case 'context_budget_exceeded':
			return withRole(role, 'context budget exceeded')
		case 'context_compacted':
			return withRole(role, 'context compacted by platform')
		case 'context_pressure':
			return withRole(role, 'context pressure — handoff notice sent')
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
		case 'role_start':
			return withRole(role, 'role start')
		case 'effort_set': {
			const effort = stringField(payload, 'effort')
			return effort === null ? 'effort set' : `effort set (${effort})`
		}
		case 'involvement_set': {
			const involvement = stringField(payload, 'involvement')
			return involvement === null ? 'involvement set' : `involvement set (${involvement})`
		}
		case 'agent_call': {
			const parent = stringField(payload, 'parent')
			const child = stringField(payload, 'child')
			return withRole(parent ?? role, `agent call${child !== null ? ` → ${child}` : ''}`)
		}
		case 'interrupt': {
			const handler = stringField(payload, 'handler')
			const target = stringField(payload, 'target')
			return handler !== null && target !== null ? `interrupt (${handler} on ${target})` : 'interrupt'
		}
		case 'interrupt_resolved': {
			const action = stringField(payload, 'action')
			const target = stringField(payload, 'target')
			return action !== null && target !== null ? `interrupt resolved (${action} on ${target})` : 'interrupt resolved'
		}
		case 'observe': {
			const details = stringField(payload, 'details')
			return withRole(role, `observe${details !== null ? ` (${details})` : ''}`)
		}
		case 'operator_notice':
			return withRole(role, 'operator notice')
		case 'inquiry_dropped': {
			const reason = stringField(payload, 'reason')
			return reason !== null ? `inquiry dropped (${reason})` : 'inquiry dropped'
		}
		// The executor does not emit this event; the case exists so a run log that contains one still reads sensibly.
		case 'operator_inquiry':
			return withRole(role, 'operator inquiry')
		case 'plan_modification':
			return withRole(role, 'operator plan modification')
		default:
			return role === null ? event.type : `${event.type} · ${role}`
	}
}

export interface LogDetailSection {
	label: string
	content: unknown
}

// The poll-path log row: identities plus the one-line rendering only. The raw payload and the paired detail sections can both carry multi-megabyte llm_call bodies, and shipping them here put every body in the run-view response twice; the window endpoint (`GET /api/runs/:id/log`) serves payloads and detail sections on demand instead.
export interface RecentLogEntry {
	index: number
	timestamp: string
	type: string
	text: string
}

export function toRecentLogEntry(event: LogEvent, index: number): RecentLogEntry {
	return {
		index,
		timestamp: event.timestamp,
		type: event.type,
		text: formatLogEvent(event),
	}
}

export function formatLogDetailSections(event: LogEvent): LogDetailSection[] | null {
	const payload = event.payload
	if (!isObject(payload)) return null
	if (event.type === 'llm_call') {
		const sections: LogDetailSection[] = []
		const sent = payload['sent']
		if (Array.isArray(sent)) sections.push({ label: 'sent', content: sent })
		const received = payload['received']
		if (isObject(received)) sections.push({ label: 'received', content: received })
		const finishReason = payload['finishReason']
		if (typeof finishReason === 'string') sections.push({ label: 'finish reason', content: finishReason })
		const usage = payload['usage']
		if (isObject(usage)) sections.push({ label: 'usage', content: usage })
		return sections.length > 0 ? sections : null
	}
	if (event.type === 'tool_call' || event.type === 'tool_result') {
		const sections: LogDetailSection[] = []
		const argumentsValue = payload['arguments']
		if (typeof argumentsValue === 'string') sections.push({ label: 'arguments', content: argumentsValue })
		const result = payload['result']
		if (isObject(result)) sections.push({ label: 'result', content: result })
		return sections.length > 0 ? sections : null
	}
	if (event.type === 'role_finished') {
		const sections: LogDetailSection[] = []
		const summary = payload['summary']
		if (typeof summary === 'string') sections.push({ label: 'summary', content: summary })
		const error = payload['error']
		if (isObject(error)) sections.push({ label: 'error', content: error })
		return sections.length > 0 ? sections : null
	}
	return null
}

// Renders the full log as plain text, one event per line, for export. Each line is tab-separated: timestamp, type, then the readable summary from formatLogEvent, so the export mirrors exactly what the on-screen log shows.
export function formatLogAsText(events: LogEvent[]): string {
	return events.map((event) => `${event.timestamp}\t${event.type}\t${formatLogEvent(event)}`).join('\n')
}
