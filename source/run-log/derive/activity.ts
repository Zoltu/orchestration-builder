import type { LogEvent } from '../../executor/types.js'
import { toRecentLogEntry } from '../format/index.js'
import { roleOf, toolOf, usageOf } from '../payload.js'

export interface RoleActivity {
	role: string
	firstSeen: string
	lastSeen: string
	eventCount: number
	llmCalls: number
	toolCalls: number
	// The last few distinct tools the role called, most-recent-last, capped at 3. Distinct because a tight loop on one tool would otherwise fill the list with repeats and hide what else the role touched.
	recentTools: string[]
	lastPromptTokens: number | null
}

export function deriveRoleActivity(logEvents: LogEvent[]): RoleActivity[] {
	// A Map preserves first-seen insertion order, so the activity list comes out in the order roles first appeared with no separate ordering bookkeeping.
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
	return Array.from(byRole.values())
}

export interface CurrentActivity {
	role: string | null
	summary: string
}

export function deriveCurrentActivity(logEvents: LogEvent[]): CurrentActivity | null {
	const lastEvent = logEvents.length > 0 ? logEvents[logEvents.length - 1] : null
	if (lastEvent === undefined || lastEvent === null) return null
	// The summary is the log row's one-line rendering, so this module delegates its formatting to the format module rather than duplicating the event-type switch.
	return { role: roleOf(lastEvent.payload), summary: toRecentLogEntry(lastEvent, 0).text }
}
