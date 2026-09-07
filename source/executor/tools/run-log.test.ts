import { describe, expect, test } from 'bun:test'
import { parseRunLogEntries, readRunLogPage, READ_RUN_LOG_MAX_LIMIT, SEARCH_RUN_LOG_MAX_LIMIT, searchRunLog, SEARCH_RUN_LOG_WINDOW_RADIUS } from './run-log.ts'

function eventLog(lines: string[]): string {
	return lines.join('\n') + '\n'
}

describe('parseRunLogEntries', () => {
	test('parses well-formed lines into indexed events, payloads untouched', () => {
		const entries = parseRunLogEntries(eventLog([
			'{"timestamp":"2026-09-07T10:00:00Z","type":"effort_set","payload":{"effort":"quick"}}',
			'{"timestamp":"2026-09-07T10:00:01Z","type":"role_start","payload":{"role":"main","roleId":"main-0-1"}}',
		]))
		expect(entries.length).toBe(2)
		expect(entries[0]).toMatchObject({ index: 0, timestamp: '2026-09-07T10:00:00Z', type: 'effort_set', payload: { effort: 'quick' } })
		expect(entries[1]).toMatchObject({ index: 1, type: 'role_start' })
	})

	test('skips junk lines, torn-write tails, empty lines, and lines that are not event objects', () => {
		const entries = parseRunLogEntries(eventLog([
			'{"timestamp":"2026-09-07T10:00:00Z","type":"effort_set","payload":{}}',
			'not json at all',
			'',
			'{"timestamp":"2026-09-07T10:00:01Z","type":"llm_call","payl',
			'   ',
			'"just a string"',
			'42',
			'{"type":"missing_timestamp","payload":{}}',
			'{"timestamp":"2026-09-07T10:00:02Z","type":"role_finished","payload":{"role":"main"}}',
		]))
		expect(entries.map((entry) => entry.type)).toEqual(['effort_set', 'role_finished'])
		// Indexes stay dense over the events that survived, so pagination and search references stay stable.
		expect(entries.map((entry) => entry.index)).toEqual([0, 1])
	})

	test('keeps the raw serialized line for the search layer', () => {
		const raw = '{"timestamp":"2026-09-07T10:00:00Z","type":"llm_call","payload":{"messages":[{"content":"the parser work"}]}}'
		const entries = parseRunLogEntries(raw + '\n')
		expect(entries[0]?.rawLine).toBe(raw)
	})

	test('an empty document parses to no events', () => {
		expect(parseRunLogEntries('')).toEqual([])
		expect(parseRunLogEntries('\n\n')).toEqual([])
	})
})

describe('readRunLogPage', () => {
	function entriesOf(count: number) {
		return parseRunLogEntries(eventLog(Array.from({ length: count }, (_, i) => `{"timestamp":"t${i}","type":"tick","payload":{"i":${i}}}`)))
	}

	test('returns the requested window with the total size and whether more exist', () => {
		const entries = entriesOf(5)
		const page = readRunLogPage(entries, 1, 2)
		expect(page.events.map((event) => event.index)).toEqual([1, 2])
		expect(page.events[0]).toMatchObject({ timestamp: 't1', type: 'tick', payload: { i: 1 } })
		expect(page.totalEvents).toBe(5)
		expect(page.hasMore).toBe(true)
	})

	test('the last page reports no more events', () => {
		const page = readRunLogPage(entriesOf(5), 3, 2)
		expect(page.events.map((event) => event.index)).toEqual([3, 4])
		expect(page.hasMore).toBe(false)
	})

	test('an offset past the end returns an empty window with no more events', () => {
		const page = readRunLogPage(entriesOf(5), 50, 10)
		expect(page.events).toEqual([])
		expect(page.totalEvents).toBe(5)
		expect(page.hasMore).toBe(false)
	})

	test('an empty log yields an empty page', () => {
		const page = readRunLogPage([], 0, 10)
		expect(page.events).toEqual([])
		expect(page.totalEvents).toBe(0)
		expect(page.hasMore).toBe(false)
	})

	test('the hard cap bounds the window regardless of the requested limit', () => {
		const page = readRunLogPage(entriesOf(READ_RUN_LOG_MAX_LIMIT + 25), 0, READ_RUN_LOG_MAX_LIMIT + 25)
		expect(page.events.length).toBe(READ_RUN_LOG_MAX_LIMIT)
		expect(page.hasMore).toBe(true)
	})
})

describe('searchRunLog', () => {
	const log = eventLog([
		'{"timestamp":"t0","type":"llm_call","payload":{"messages":[{"content":"REFACTOR the parser module"}]}}',
		'{"timestamp":"t1","type":"tool_result","payload":{"data":"refactor completed"}}',
		'{"timestamp":"t2","type":"role_finished","payload":{"summary":"did something else"}}',
	])
	const entries = parseRunLogEntries(log)

	test('matches case-insensitively over the raw serialized line, one excerpt per matching event', () => {
		const result = searchRunLog(entries, { query: 'refactor', requestedLimit: 10 })
		expect(result.totalMatches).toBe(2)
		expect(result.matches.map((match) => match.index)).toEqual([0, 1])
		expect(result.matches[0]?.type).toBe('llm_call')
	})

	test('the excerpt windows around the first match, at the line start and end', () => {
		const result = searchRunLog(entries, { query: '{"timestamp":"t0"', requestedLimit: 10 })
		expect(result.totalMatches).toBe(1)
		// A match at the very start of the line cannot take leading context, so the window opens with the match itself.
		expect(result.matches[0]?.window.startsWith('{"timestamp":"t0"')).toBe(true)
		const tailResult = searchRunLog(parseRunLogEntries(log), { query: 'did something else"}}', requestedLimit: 10 })
		expect(tailResult.totalMatches).toBe(1)
		// A match at the very end cannot take trailing context, so the window closes with the match itself.
		expect(tailResult.matches[0]?.window.endsWith('did something else"}}')).toBe(true)
	})

	test('the excerpt stays bounded when the match sits deep in a huge line', () => {
		const before = 'x'.repeat(SEARCH_RUN_LOG_WINDOW_RADIUS * 10)
		const after = 'y'.repeat(SEARCH_RUN_LOG_WINDOW_RADIUS * 10)
		const line = `{"timestamp":"t0","type":"llm_call","payload":{"content":"${before}needle${after}"}}`
		const huge = parseRunLogEntries(line + '\n')
		const result = searchRunLog(huge, { query: 'needle', requestedLimit: 10 })
		expect(result.totalMatches).toBe(1)
		// With more than a radius of line on each side of the match, the excerpt is exactly the match plus its surrounding window — never the whole line.
		expect(result.matches[0]?.window).toBe('x'.repeat(SEARCH_RUN_LOG_WINDOW_RADIUS) + 'needle' + 'y'.repeat(SEARCH_RUN_LOG_WINDOW_RADIUS))
		expect(result.matches[0]?.window.length).toBeLessThan(line.length)
	})

	test('the type filter applies before searching', () => {
		const result = searchRunLog(entries, { query: 'refactor', type: 'tool_result', requestedLimit: 10 })
		expect(result.totalMatches).toBe(1)
		expect(result.matches[0]?.index).toBe(1)
	})

	test('the hard cap bounds returned matches while totalMatches reports the uncapped count', () => {
		const many = parseRunLogEntries(eventLog(Array.from({ length: SEARCH_RUN_LOG_MAX_LIMIT + 7 }, (_, i) => `{"timestamp":"t${i}","type":"tick","payload":{"note":"needle ${i}"}}`)))
		const result = searchRunLog(many, { query: 'needle', requestedLimit: SEARCH_RUN_LOG_MAX_LIMIT + 7 })
		expect(result.matches.length).toBe(SEARCH_RUN_LOG_MAX_LIMIT)
		expect(result.totalMatches).toBe(SEARCH_RUN_LOG_MAX_LIMIT + 7)
	})

	test('no matches yields an empty result', () => {
		const result = searchRunLog(entries, { query: 'nonexistent', requestedLimit: 10 })
		expect(result.matches).toEqual([])
		expect(result.totalMatches).toBe(0)
	})
})
