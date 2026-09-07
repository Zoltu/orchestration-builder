import * as fs from 'node:fs'
import { createToolError } from '../errors.js'
import type { ToolHandler } from '../tool-dispatch.js'
import type { ToolResult } from '../types.js'
import { isObject } from '../validation.js'
import { wrapIoError } from './shared.js'

export interface RunLogToolConfig {
	logPath: string
}

// Pagination defaults and hard caps. Both tools return whole events, and llm_call payloads carry full conversations, so the caps are what keep one call from flooding the handler's context on a long run.
export const READ_RUN_LOG_DEFAULT_LIMIT = 50
export const READ_RUN_LOG_MAX_LIMIT = 200
export const SEARCH_RUN_LOG_DEFAULT_LIMIT = 20
export const SEARCH_RUN_LOG_MAX_LIMIT = 50

// Chars of surrounding raw-line context on each side of a search match — the same excerpt shape the role-inspection search uses, widened a little because log lines are serialized JSON whose payload text is denser than conversation prose.
export const SEARCH_RUN_LOG_WINDOW_RADIUS = 200

// One parsed log event: its position in the full event sequence, the event fields, and the raw serialized line the search excerpts window into (so payload text stays searchable without re-serializing).
export interface RunLogEntry {
	index: number
	timestamp: string
	type: string
	payload: unknown
	rawLine: string
}

interface RunLogEventShape {
	timestamp: string
	type: string
	payload: unknown
}

function isRunLogEventShape(value: unknown): value is RunLogEventShape {
	if (!isObject(value)) return false
	return typeof value.timestamp === 'string' && typeof value.type === 'string'
}

// Lenient parse of the log's lines: a line that fails JSON.parse (a torn write, possible because the log is append-only and a reader can race the writer) or is not a timestamped event object is skipped, so a partially written tail never fails a read.
export function parseRunLogEntries(text: string): RunLogEntry[] {
	const entries: RunLogEntry[] = []
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue
		let parsed: unknown
		try {
			parsed = JSON.parse(line)
		} catch {
			continue
		}
		if (!isRunLogEventShape(parsed)) continue
		entries.push({ index: entries.length, timestamp: parsed.timestamp, type: parsed.type, payload: parsed.payload, rawLine: line })
	}
	return entries
}

export interface RunLogPageEvent {
	index: number
	timestamp: string
	type: string
	payload: unknown
}

export interface RunLogPage {
	events: RunLogPageEvent[]
	totalEvents: number
	hasMore: boolean
}

// Pagination is over parsed events, not bytes; the requested limit is capped so one read cannot return the log's full llm_call conversations.
export function readRunLogPage(entries: RunLogEntry[], offset: number, requestedLimit: number): RunLogPage {
	const limit = Math.min(requestedLimit, READ_RUN_LOG_MAX_LIMIT)
	const events: RunLogPageEvent[] = []
	for (const entry of entries.slice(offset, offset + limit)) {
		events.push({ index: entry.index, timestamp: entry.timestamp, type: entry.type, payload: entry.payload })
	}
	return { events, totalEvents: entries.length, hasMore: offset + events.length < entries.length }
}

export interface RunLogSearchMatch {
	index: number
	timestamp: string
	type: string
	window: string
}

export interface RunLogSearchResult {
	matches: RunLogSearchMatch[]
	totalMatches: number
}

export interface SearchRunLogOptions {
	query: string
	type?: string
	requestedLimit: number
}

function excerptWindow(line: string, offset: number, matchLength: number): string {
	const start = Math.max(0, offset - SEARCH_RUN_LOG_WINDOW_RADIUS)
	const end = Math.min(line.length, offset + matchLength + SEARCH_RUN_LOG_WINDOW_RADIUS)
	return line.slice(start, end)
}

// Plain case-insensitive substring over each event's raw serialized line (so payload text matches without re-serializing), one excerpt per matching event around its first occurrence. Returned matches are capped so a common query cannot flood the handler's context; totalMatches reports the uncapped count so the caller knows when to narrow the query or add a type filter.
export function searchRunLog(entries: RunLogEntry[], options: SearchRunLogOptions): RunLogSearchResult {
	const limit = Math.min(options.requestedLimit, SEARCH_RUN_LOG_MAX_LIMIT)
	const needle = options.query.toLowerCase()
	const matches: RunLogSearchMatch[] = []
	let totalMatches = 0
	for (const entry of entries) {
		if (options.type !== undefined && entry.type !== options.type) continue
		const offset = entry.rawLine.toLowerCase().indexOf(needle)
		if (offset === -1) continue
		totalMatches++
		if (matches.length >= limit) continue
		matches.push({ index: entry.index, timestamp: entry.timestamp, type: entry.type, window: excerptWindow(entry.rawLine, offset, options.query.length) })
	}
	return { matches, totalMatches }
}

// The log location is executor-bound (built from the runs base directory and the run id in serve.ts), so no caller-controlled path segment reaches the filesystem.
function readRunLogEntries(logPath: string): { ok: true; entries: RunLogEntry[] } | { ok: false; result: ToolResult } {
	// A missing log is a normal state (the tools can be invoked before the run's first event lands), reported as unavailable rather than an IO error.
	if (!fs.existsSync(logPath)) return { ok: false, result: createToolError('unavailable', 'this run has no log yet') }
	let text: string
	try {
		text = fs.readFileSync(logPath, 'utf8')
	} catch (error) {
		return { ok: false, result: wrapIoError(error, 'Cannot read run log') }
	}
	return { ok: true, entries: parseRunLogEntries(text) }
}

function optionalNonNegativeInt(value: unknown, fallback: number): number | null {
	if (value === undefined) return fallback
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
	return value
}

function optionalPositiveInt(value: unknown, fallback: number): number | null {
	if (value === undefined) return fallback
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null
	return value
}

function createReadRunLog(config: RunLogToolConfig): ToolHandler {
	return (args) => {
		const offset = optionalNonNegativeInt(args['offset'], 0)
		if (offset === null) return createToolError('invalid_arguments', 'offset must be a non-negative integer')
		const limit = optionalPositiveInt(args['limit'], READ_RUN_LOG_DEFAULT_LIMIT)
		if (limit === null) return createToolError('invalid_arguments', 'limit must be a positive integer')
		const read = readRunLogEntries(config.logPath)
		if (!read.ok) return read.result
		return { kind: 'success', data: readRunLogPage(read.entries, offset, limit) }
	}
}

function createSearchRunLog(config: RunLogToolConfig): ToolHandler {
	return (args) => {
		const queryValue = args['query']
		if (typeof queryValue !== 'string' || queryValue === '') {
			return createToolError('invalid_arguments', 'query must be a non-empty string')
		}
		const typeValue = args['type']
		if (typeValue !== undefined && (typeof typeValue !== 'string' || typeValue === '')) {
			return createToolError('invalid_arguments', 'type must be a non-empty string')
		}
		const limit = optionalPositiveInt(args['limit'], SEARCH_RUN_LOG_DEFAULT_LIMIT)
		if (limit === null) return createToolError('invalid_arguments', 'limit must be a positive integer')
		const read = readRunLogEntries(config.logPath)
		if (!read.ok) return read.result
		return { kind: 'success', data: searchRunLog(read.entries, { query: queryValue, ...(typeValue !== undefined ? { type: typeValue } : {}), requestedLimit: limit }) }
	}
}

export function createRunLogToolHandlers(config: RunLogToolConfig): Record<string, ToolHandler> {
	return { read_run_log: createReadRunLog(config), search_run_log: createSearchRunLog(config) }
}
