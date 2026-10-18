import type { LogEvent, RunMeta } from '../executor/types.js'
import { isObject, isRunMeta } from '../executor/validation.js'

export interface RunSnapshot {
	meta: RunMeta | null
	logEvents: LogEvent[]
}

// Absent, malformed, or foreign meta all read as null: the run view then renders its unknown/in-progress shape rather than throwing.
export function parseRunMeta(metaText: string | null): RunMeta | null {
	if (metaText === null) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(metaText)
	} catch {
		return null
	}
	return isRunMeta(parsed) ? parsed : null
}

// The per-line log semantics shared by every reader (the full-text parse, the snapshot cache's incremental tail parse, and the summarizer's filtered scan): a line contributes an event only when it parses as JSON and carries string timestamp and type fields; anything else — an empty line, a torn write, foreign JSON — contributes nothing.
export function parseLogEventLine(line: string): LogEvent | null {
	if (line === '') return null
	let parsed: unknown
	try {
		parsed = JSON.parse(line)
	} catch {
		return null
	}
	if (!isObject(parsed)) return null
	if (typeof parsed.timestamp !== 'string') return null
	if (typeof parsed.type !== 'string') return null
	return { timestamp: parsed.timestamp, type: parsed.type, payload: parsed.payload }
}

export function parseLogEvents(logText: string): LogEvent[] {
	const events: LogEvent[] = []
	for (const line of logText.split('\n')) {
		const event = parseLogEventLine(line)
		if (event !== null) events.push(event)
	}
	return events
}
