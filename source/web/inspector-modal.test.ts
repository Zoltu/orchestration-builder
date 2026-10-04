import { describe, expect, test } from 'bun:test'
import { InspectorModal, buildTurnIndex, childInstanceFor, deriveDefaultScopeRoleId, deriveInstanceChain, deriveTranscriptTurns, instancesOf, scopeTurnEntries, tailRefreshMustResync, tailWindowOffset, olderWindowOffset, olderFetchLimit, canPageOlder, INSPECTOR_WINDOW_SIZE, INSPECTOR_PAGE_LIMIT, INSPECTOR_RETENTION_LIMIT } from './static/inspector-modal.js'
import { actionProp, defined, present } from './test-fixtures.js'

// The inspector-modal component is browser-pure JS, so its exports arrive with inferred JS types. The interfaces and fake `h`/`renderMarkdown` below carry the shape the tests assert against, mirroring question-modal.test.ts / result-modal.test.ts.

interface Vnode {
	tag: string
	props: Record<string, unknown>
	children: VnodeChild[]
}
type VnodeChild = Vnode | string
type VnodeChildInput = VnodeChild | VnodeChildInput[] | null | undefined | boolean

function fakeH(tag: string, props: Record<string, unknown>, children: VnodeChildInput): Vnode {
	return { tag, props, children: normalizeChildren(children) }
}

// hyperapp flattens nested arrays and drops null/boolean children; the fake mirrors that so the component can pass loose children the same way it does against the real renderer.
function normalizeChildren(children: VnodeChildInput): VnodeChild[] {
	const out: VnodeChild[] = []
	pushChildren(out, children)
	return out
}

function pushChildren(out: VnodeChild[], children: VnodeChildInput): void {
	if (children === null || children === undefined || typeof children === 'boolean') return
	if (Array.isArray(children)) {
		for (const child of children) pushChildren(out, child)
		return
	}
	out.push(children)
}

function isVnode(value: VnodeChild): value is Vnode {
	return typeof value !== 'string'
}

function allByTag(vnode: Vnode, tag: string): Vnode[] {
	const found: Vnode[] = []
	for (const child of vnode.children) {
		if (!isVnode(child)) continue
		if (child.tag === tag) found.push(child)
		for (const grand of allByTag(child, tag)) found.push(grand)
	}
	return found
}

function allByClass(vnode: Vnode, className: string): Vnode[] {
	const found: Vnode[] = []
	if (classOf(vnode.props).split(' ').includes(className)) found.push(vnode)
	for (const child of vnode.children) {
		if (!isVnode(child)) continue
		for (const hit of allByClass(child, className)) found.push(hit)
	}
	return found
}

// The class a vnode carries, normalizing hyperapp's two forms: a plain string and a truthy-map object (`{ 'is-selected': true }`), which the real renderer resolves to the listed names.
function classOf(props: Record<string, unknown>): string {
	const value = props.class
	if (typeof value === 'string') return value
	if (value !== null && typeof value === 'object') {
		return Object.entries(value).filter((entry) => entry[1] === true).map((entry) => entry[0]).join(' ')
	}
	return ''
}

function collectText(vnode: Vnode): string {
	let out = ''
	for (const child of vnode.children) {
		if (typeof child === 'string') out += child
		else out += collectText(child)
	}
	return out
}

// The number of times a needle occurs in a haystack (for no-repetition assertions).
function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1
}

// A fake Markdown renderer that records its argument and returns a marker vnode carrying the text, so the tests assert both that the prose flowed through the renderer and that its output reached the modal.
function fakeRenderMarkdown(text: string): Vnode {
	return { tag: 'span', props: { class: 'md-marker', 'data-text': text }, children: [text] }
}

// Reads a prop that must be a two-element hyperapp action tuple (`[Action, payload]`), failing the test with a readable message otherwise.
function actionTuple(value: unknown): [unknown, unknown] {
	if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'function') throw new Error('prop is not a two-element action tuple')
	return [value[0], value[1]]
}

// Dispatches a hyperapp action tuple the way the framework would on the event: the action receives the tuple's payload.
function dispatchActionTuple(value: unknown): unknown {
	const [action, payload] = actionTuple(value)
	if (typeof action !== 'function') throw new Error('action tuple head is not a function')
	return action(payload)
}

// Window-shaped log events (the fields the windowed endpoint ships and the derivation reads).
interface WindowEvent {
	index: number
	timestamp: string
	type: string
	payload: unknown
}

function startEvent(index: number, role: string, roleId?: string): WindowEvent {
	const payload: Record<string, unknown> = { role }
	if (roleId !== undefined) payload['roleId'] = roleId
	return { index, timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}Z`, type: 'llm_call_start', payload }
}

// A full-level llm_call payload: sent slice, received response with reasoning, usage, finish reason.
function callEvent(index: number, role: string, overrides: Record<string, unknown> = {}): WindowEvent {
	return {
		index,
		timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}Z`,
		type: 'llm_call',
		payload: {
			role,
			roleId: `${role}-1`,
			messageCount: 3,
			sentFrom: 0,
			sent: [{ role: 'user', content: 'do the thing' }],
			received: { content: 'on it', reasoning: 'thinking hard', toolCalls: [] },
			usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
			finishReason: 'tool_calls',
			...overrides,
		},
	}
}

// A standard-level llm_call payload: the kept identity/usage fields only (source/executor/log-level.ts).
function standardCallEvent(index: number, role: string): WindowEvent {
	return callEvent(index, role, { sent: undefined, received: undefined, sentFrom: undefined, roleId: undefined })
}

// A role_start event: the instance registry's identity, depth, and optional parent linkage (`parent` names the parent role, `parentRoleId` its instance).
function roleStartEvent(index: number, roleId: string, role: string, extras: Record<string, unknown> = {}): WindowEvent {
	return { index, timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}Z`, type: 'role_start', payload: { role, roleId, depth: 0, task: 't', ...extras } }
}

function roleFinishedEvent(index: number, roleId: string, role: string): WindowEvent {
	return { index, timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}Z`, type: 'role_finished', payload: { role, roleId, depth: 0, status: 'success' } }
}

// A tool call in either wire shape (a sent assistant message's `tool_calls` and a received response's `toolCalls` carry the same id/name/arguments fields).
function wireToolCall(id: string, name: string, args: string): Record<string, unknown> {
	return { id, type: 'function', function: { name, arguments: args } }
}

// A two-turn coder conversation: turn 1 opens the conversation and calls a tool; turn 2's slice carries that response's echo plus the tool result, and replies.
const stitchEvents: WindowEvent[] = [
	startEvent(0, 'coder', 'coder-1'),
	callEvent(1, 'coder', {
		roleId: 'coder-1',
		messageCount: 2,
		sentFrom: 0,
		sent: [
			{ role: 'system', content: 'system prompt text' },
			{ role: 'user', content: 'the task text' },
		],
		received: { content: 'turn one reply', reasoning: 'turn one thinking', toolCalls: [wireToolCall('c1', 'write_file', '{"path":"a.txt"}')] },
		usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
		finishReason: 'tool_calls',
	}),
	callEvent(2, 'coder', {
		roleId: 'coder-1',
		messageCount: 4,
		sentFrom: 2,
		sent: [
			{ role: 'assistant', content: 'turn one reply', tool_calls: [wireToolCall('c1', 'write_file', '{"path":"a.txt"}')] },
			{ role: 'tool', content: '{"kind":"tool_error","message":"no space"}' },
		],
		received: { content: 'turn two reply', reasoning: 'turn two thinking', toolCalls: [] },
		usage: { promptTokens: 200, completionTokens: 10, totalTokens: 210 },
		finishReason: 'stop',
	}),
]

function transcriptOf(events: WindowEvent[], roleId: string): ReturnType<typeof deriveTranscriptTurns> {
	return deriveTranscriptTurns(scopeTurnEntries(buildTurnIndex(events), roleId), events)
}

describe('buildTurnIndex', () => {
	test('returns an empty list for an empty or non-array log', () => {
		expect(buildTurnIndex([])).toEqual([])
		expect(buildTurnIndex(null)).toEqual([])
		expect(buildTurnIndex('broken')).toEqual([])
		expect(buildTurnIndex(undefined)).toEqual([])
	})

	test('pairs llm_call_start with the following same-role llm_call into one completed entry', () => {
		const entries = buildTurnIndex([startEvent(0, 'planner'), callEvent(3, 'planner')])
		expect(entries).toHaveLength(1)
		const entry = defined(entries[0], 'entries[0]')
		expect(entry.kind).toBe('completed')
		expect(entry.eventIndex).toBe(3)
		expect(entry.startEventIndex).toBe(0)
		expect(entry.role).toBe('planner')
		expect(entry.turnNumber).toBe(1)
		expect(entry.levelHint).toBe('full')
		expect(entry.finishReason).toBe('tool_calls')
		const usage = present(entry.usage, 'entry.usage')
		expect(usage).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120 })
		expect(entry.timestamp).not.toBeNull()
	})

	test('an llm_call without a start is completed with a null startEventIndex', () => {
		const entries = buildTurnIndex([callEvent(7, 'coder')])
		const entry = defined(entries[0], 'entries[0]')
		expect(entry.kind).toBe('completed')
		expect(entry.startEventIndex).toBeNull()
		expect(entry.eventIndex).toBe(7)
	})

	test('an llm_call_start without a matching llm_call is in flight', () => {
		const entries = buildTurnIndex([startEvent(4, 'coder')])
		expect(entries).toHaveLength(1)
		const entry = defined(entries[0], 'entries[0]')
		expect(entry.kind).toBe('in_flight')
		expect(entry.eventIndex).toBe(4)
		expect(entry.startEventIndex).toBeNull()
		expect(entry.usage).toBeNull()
		expect(entry.finishReason).toBeNull()
		expect(entry.levelHint).toBeNull()
	})

	test('entries carry the payload roleId, falling back to the role name when absent', () => {
		const entries = buildTurnIndex([
			startEvent(0, 'planner', 'planner-0-1'),
			callEvent(3, 'planner', { roleId: 'planner-0-1' }),
			startEvent(5, 'coder'),
			standardCallEvent(7, 'critic'),
		])
		// The paired start folds into its completed entry, which carries the llm_call payload's id.
		expect(defined(entries[0], 'entries[0]').roleId).toBe('planner-0-1')
		// A start without a roleId (old logs) falls back to the role name…
		expect(defined(entries[1], 'entries[1]').roleId).toBe('coder')
		// …and a standard-level llm_call drops the id the same way.
		expect(defined(entries[2], 'entries[2]').roleId).toBe('critic')
	})

	test('same-name nesting pairs LIFO, like brackets', () => {
		const entries = buildTurnIndex([
			startEvent(0, 'coder'),
			startEvent(1, 'coder'),
			callEvent(2, 'coder'),
			callEvent(3, 'coder'),
		])
		expect(entries.map((entry) => entry.kind)).toEqual(['completed', 'completed'])
		const first = defined(entries[0], 'entries[0]')
		const second = defined(entries[1], 'entries[1]')
		expect(first.eventIndex).toBe(2)
		expect(first.startEventIndex).toBe(1)
		expect(second.eventIndex).toBe(3)
		expect(second.startEventIndex).toBe(0)
	})

	test('entries come back chronological with sequential turn numbers regardless of kind', () => {
		const entries = buildTurnIndex([
			callEvent(1, 'planner'),
			startEvent(5, 'coder'),
			callEvent(9, 'planner'),
		])
		expect(entries.map((entry) => entry.eventIndex)).toEqual([1, 5, 9])
		expect(entries.map((entry) => entry.turnNumber)).toEqual([1, 2, 3])
		expect(entries.map((entry) => entry.kind)).toEqual(['completed', 'in_flight', 'completed'])
	})

	test('a standard-level payload hints standard; full keeps full', () => {
		const entries = buildTurnIndex([standardCallEvent(0, 'coder'), callEvent(1, 'planner')])
		const standard = defined(entries[0], 'entries[0]')
		const full = defined(entries[1], 'entries[1]')
		expect(standard.levelHint).toBe('standard')
		expect(full.levelHint).toBe('full')
	})

	test('a standard-level payload still carries usage and finish reason', () => {
		const entries = buildTurnIndex([standardCallEvent(0, 'coder')])
		const entry = defined(entries[0], 'entries[0]')
		expect(present(entry.usage, 'entry.usage').totalTokens).toBe(120)
		expect(entry.finishReason).toBe('tool_calls')
	})

	test('entries carry the payload\u0027s messageCount; absent or malformed reads as null, in-flight as null', () => {
		const entries = buildTurnIndex([callEvent(0, 'coder', { messageCount: 7 }), standardCallEvent(1, 'coder'), startEvent(2, 'coder')])
		expect(defined(entries[0], 'entries[0]').messageCount).toBe(7)
		// The standard level keeps messageCount (a kept field, source/executor/log-level.ts).
		expect(defined(entries[1], 'entries[1]').messageCount).toBe(3)
		expect(defined(entries[2], 'entries[2]').messageCount).toBeNull()
		const malformed = buildTurnIndex([callEvent(3, 'coder', { messageCount: '4' }), callEvent(4, 'coder', { messageCount: -1 }), callEvent(5, 'coder', { messageCount: 2.5 })])
		for (const entry of malformed) expect(entry.messageCount).toBeNull()
	})

	test('usage with cached tokens carries the cached share; non-numeric usage reads as none', () => {
		const cached = buildTurnIndex([callEvent(0, 'coder', { usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedPromptTokens: 8 } })])
		expect(present(defined(cached[0], 'cached[0]').usage, 'usage').cachedPromptTokens).toBe(8)
		const missing = buildTurnIndex([callEvent(1, 'coder', { usage: 'broken' })])
		expect(defined(missing[0], 'missing[0]').usage).toBeNull()
		const nan = buildTurnIndex([callEvent(2, 'coder', { usage: { promptTokens: Number.NaN, completionTokens: 5, totalTokens: 15 } })])
		expect(defined(nan[0], 'nan[0]').usage).toBeNull()
	})

	test('skips malformed rows: non-objects, other types, non-record payloads, missing role, unusable index', () => {
		const entries = buildTurnIndex([
			null,
			'broken',
			{ index: 0, timestamp: 't', type: 'tool_call', payload: { role: 'x' } },
			{ index: 1, timestamp: 't', type: 'llm_call', payload: 'not-a-record' },
			{ index: 2, timestamp: 't', type: 'llm_call', payload: { usage: {} } },
			{ timestamp: 't', type: 'llm_call', payload: { role: 'planner' } },
			{ index: '4', timestamp: 't', type: 'llm_call', payload: { role: 'planner' } },
			{ index: -1, timestamp: 't', type: 'llm_call', payload: { role: 'planner' } },
			startEvent(5, 'coder'),
		])
		expect(entries).toHaveLength(1)
		expect(defined(entries[0], 'entries[0]').kind).toBe('in_flight')
	})

	test('a structurally sound but sparse llm_call reads as a completed entry with no usage', () => {
		const entries = buildTurnIndex([{ index: 3, timestamp: 't', type: 'llm_call', payload: { role: 'planner' } }])
		expect(entries).toHaveLength(1)
		const entry = defined(entries[0], 'entries[0]')
		expect(entry.kind).toBe('completed')
		expect(entry.usage).toBeNull()
		expect(entry.finishReason).toBeNull()
		expect(entry.levelHint).toBe('standard')
	})
})

describe('turn-list paging offset math', () => {
	test('tailWindowOffset starts the most recent window', () => {
		expect(tailWindowOffset(1000, INSPECTOR_WINDOW_SIZE)).toBe(800)
		expect(tailWindowOffset(201, 200)).toBe(1)
		expect(tailWindowOffset(200, 200)).toBe(0)
		expect(tailWindowOffset(150, 200)).toBe(0)
		expect(tailWindowOffset(0, 200)).toBe(0)
	})

	test('tailWindowOffset treats malformed totals as an empty log', () => {
		expect(tailWindowOffset(-5, 200)).toBe(0)
		expect(tailWindowOffset(12.5, 200)).toBe(0)
		expect(tailWindowOffset(null, 200)).toBe(0)
		expect(tailWindowOffset(100, 0)).toBe(0)
	})

	test('olderWindowOffset pages back one page without going negative', () => {
		expect(olderWindowOffset(800, 200)).toBe(600)
		expect(olderWindowOffset(200, 200)).toBe(0)
		expect(olderWindowOffset(50, 200)).toBe(0)
		expect(olderWindowOffset(0, 200)).toBe(0)
	})

	test('olderFetchLimit is the exact gap to fetch, zero when nothing is older', () => {
		expect(olderFetchLimit(800, 200)).toBe(200)
		expect(olderFetchLimit(250, 200)).toBe(200)
		expect(olderFetchLimit(50, 200)).toBe(50)
		expect(olderFetchLimit(0, 200)).toBe(0)
		expect(olderFetchLimit(null, 200)).toBe(0)
	})

	test('canPageOlder is true only for a positive integer offset', () => {
		expect(canPageOlder(0)).toBe(false)
		expect(canPageOlder(1)).toBe(true)
		expect(canPageOlder(500)).toBe(true)
		expect(canPageOlder(null)).toBe(false)
		expect(canPageOlder(2.5)).toBe(false)
		expect(canPageOlder(-1)).toBe(false)
	})

	test('a bridging tail-refresh page appends; a gapped or over-cap page resyncs to the fresh tail window', () => {
		// The page bridges its range (50 events cover offset 950 → total 1000): append, unless the loaded range has hit the retention cap.
		expect(tailRefreshMustResync(50, 950, 1000, 0)).toBe(false)
		expect(tailRefreshMustResync(50, 950, 1000, INSPECTOR_RETENTION_LIMIT - 1)).toBe(false)
		// A page that cannot bridge (events landed between two polls than one page carries) would leave a silent gap.
		expect(tailRefreshMustResync(30, 950, 1000, 0)).toBe(true)
		// At the cap the oldest events drop: resync to the newest window and let "Older turns" re-fetch.
		expect(tailRefreshMustResync(50, 950, 1000, INSPECTOR_RETENTION_LIMIT)).toBe(true)
	})

	test('malformed tail-refresh inputs read as no resync so a broken response never throws', () => {
		expect(tailRefreshMustResync('x', 950, 1000, 0)).toBe(false)
		expect(tailRefreshMustResync(50, 2.5, 1000, 0)).toBe(false)
		expect(tailRefreshMustResync(50, 950, null, 0)).toBe(false)
		expect(tailRefreshMustResync(50, 950, 1000, 'x')).toBe(false)
		expect(tailRefreshMustResync(-1, 950, 1000, 0)).toBe(false)
	})
})

describe('instancesOf', () => {
	test('lists real instances from role_start/role_finished with parent linkage and live/finished status', () => {
		const instances = instancesOf([
			roleStartEvent(0, 'orchestrator-0', 'orchestrator'),
			roleStartEvent(2, 'coder-1', 'coder', { depth: 1, parent: 'orchestrator', parentRoleId: 'orchestrator-0' }),
			roleFinishedEvent(9, 'coder-1', 'coder'),
		])
		expect(instances).toHaveLength(2)
		expect(defined(instances[0], 'instances[0]')).toEqual({ roleId: 'orchestrator-0', role: 'orchestrator', parentRoleId: null, parentRole: null, live: true })
		expect(defined(instances[1], 'instances[1]')).toEqual({ roleId: 'coder-1', role: 'coder', parentRoleId: 'orchestrator-0', parentRole: 'orchestrator', live: false })
	})

	test('a start without a finish in the window reads live; a finish without a start is still listed', () => {
		const instances = instancesOf([
			roleStartEvent(0, 'coder-1', 'coder'),
			roleFinishedEvent(1, 'planner-0-1', 'planner'),
		])
		expect(defined(instances[0], 'instances[0]').live).toBe(true)
		const finished = defined(instances[1], 'instances[1]')
		expect(finished.roleId).toBe('planner-0-1')
		expect(finished.live).toBe(false)
	})

	test('turn events without a roleId ensure a role-name fallback instance whose live flag follows its newest turn event', () => {
		const inFlight = instancesOf([startEvent(0, 'coder')])
		expect(inFlight).toHaveLength(1)
		expect(defined(inFlight[0], 'inFlight[0]')).toEqual({ roleId: 'coder', role: 'coder', parentRoleId: null, parentRole: null, live: true })
		const settled = instancesOf([startEvent(0, 'coder'), callEvent(1, 'coder', { roleId: undefined })])
		expect(defined(settled[0], 'settled[0]').live).toBe(false)
	})

	test('a turn event carrying a roleId ensures the real instance when its role_start paged out', () => {
		const instances = instancesOf([callEvent(0, 'coder', { roleId: 'coder-1-9' })])
		expect(instances).toHaveLength(1)
		expect(defined(instances[0], 'instances[0]')).toEqual({ roleId: 'coder-1-9', role: 'coder', parentRoleId: null, parentRole: null, live: true })
	})

	test('empty and malformed windows yield no instances, and malformed rows are skipped', () => {
		expect(instancesOf([])).toEqual([])
		expect(instancesOf(null)).toEqual([])
		expect(instancesOf('broken')).toEqual([])
		expect(instancesOf([null, 'broken', { index: 0, type: 'role_start', payload: 'not-a-record' }, { index: 1, type: 'role_start', payload: { role: 'x' } }, { index: 2, type: 'llm_call', payload: { role: '' } }])).toEqual([])
	})
})

describe('deriveInstanceChain', () => {
	// New logs: every role_start names its parent instance exactly.
	const exactEvents = [
		roleStartEvent(0, 'orchestrator-0', 'orchestrator', { depth: 0 }),
		roleStartEvent(2, 'coder-1', 'coder', { depth: 1, parent: 'orchestrator', parentRoleId: 'orchestrator-0' }),
		roleStartEvent(5, 'coder-1-2', 'coder', { depth: 2, parent: 'coder', parentRoleId: 'coder-1' }),
	]

	test('walks a deep chain root → scoped instance through the exact parentRoleId linkage', () => {
		expect(deriveInstanceChain(exactEvents, 'coder-1-2')).toEqual([
			{ roleId: 'orchestrator-0', role: 'orchestrator' },
			{ roleId: 'coder-1', role: 'coder' },
			{ roleId: 'coder-1-2', role: 'coder' },
		])
	})

	test('ancestors outside the loaded window end the walk at the root-most known start', () => {
		const partialWindow = [roleStartEvent(5, 'coder-1-2', 'coder', { depth: 2, parent: 'coder', parentRoleId: 'coder-1' })]
		expect(deriveInstanceChain(partialWindow, 'coder-1-2')).toEqual([{ roleId: 'coder-1-2', role: 'coder' }])
	})

	test('old logs without parentRoleId fall back to the latest same-named role_start at depth − 1', () => {
		const legacyEvents = [
			roleStartEvent(0, 'orchestrator-0', 'orchestrator', { depth: 0 }),
			roleStartEvent(2, 'coder-1', 'coder', { depth: 1, parent: 'orchestrator' }),
			roleStartEvent(5, 'coder-2', 'coder', { depth: 1, parent: 'orchestrator' }),
			roleStartEvent(8, 'coder-2-4', 'coder', { depth: 2, parent: 'coder' }),
		]
		// The latest depth-1 'coder' start before the child's own is the true parent (the executor's single-flight depth-first execution), not the earlier sibling.
		expect(deriveInstanceChain(legacyEvents, 'coder-2-4')).toEqual([
			{ roleId: 'orchestrator-0', role: 'orchestrator' },
			{ roleId: 'coder-2', role: 'coder' },
			{ roleId: 'coder-2-4', role: 'coder' },
		])
	})

	test('a root scopes to a single crumb', () => {
		expect(deriveInstanceChain(exactEvents, 'orchestrator-0')).toEqual([{ roleId: 'orchestrator-0', role: 'orchestrator' }])
	})

	test('an instance with no role_start in the window renders as a lone crumb, its role read from the turn payload', () => {
		const events = [...exactEvents, callEvent(9, 'coder', { roleId: 'coder-1-9' })]
		expect(deriveInstanceChain(events, 'coder-1-9')).toEqual([{ roleId: 'coder-1-9', role: 'coder' }])
		expect(deriveInstanceChain(exactEvents, 'mystery-9')).toEqual([{ roleId: 'mystery-9', role: 'mystery-9' }])
	})

	test('an empty or malformed window degrades to the lone crumb, and a malformed cycle ends the walk', () => {
		expect(deriveInstanceChain([], 'coder-1')).toEqual([{ roleId: 'coder-1', role: 'coder-1' }])
		expect(deriveInstanceChain(null, 'coder-1')).toEqual([{ roleId: 'coder-1', role: 'coder-1' }])
		expect(deriveInstanceChain('broken', 'coder-1')).toEqual([{ roleId: 'coder-1', role: 'coder-1' }])
		expect(deriveInstanceChain(exactEvents, null)).toEqual([])
		const cyclic = [
			roleStartEvent(0, 'a-0', 'a', { depth: 0, parentRoleId: 'b-0' }),
			roleStartEvent(1, 'b-0', 'b', { depth: 1, parentRoleId: 'a-0' }),
		]
		expect(deriveInstanceChain(cyclic, 'a-0')).toEqual([{ roleId: 'b-0', role: 'b' }, { roleId: 'a-0', role: 'a' }])
	})
})

describe('deriveDefaultScopeRoleId', () => {
	test('the newest in-flight turn wins; otherwise the newest turn of any kind', () => {
		const entries = buildTurnIndex([
			callEvent(1, 'planner', { roleId: 'planner-0-1' }),
			callEvent(5, 'critic', { roleId: 'critic-0-1' }),
		])
		expect(deriveDefaultScopeRoleId(entries)).toBe('critic-0-1')
		const withFlight = buildTurnIndex([
			callEvent(1, 'planner', { roleId: 'planner-0-1' }),
			startEvent(3, 'coder', 'coder-1-2'),
		])
		expect(deriveDefaultScopeRoleId(withFlight)).toBe('coder-1-2')
		// Any unmatched start outranks a newer completed call — the spec's "newest llm_call_start without matching llm_call, else the newest llm_call".
		const mixed = buildTurnIndex([
			startEvent(1, 'coder', 'coder-1-2'),
			callEvent(5, 'critic', { roleId: 'critic-0-1' }),
		])
		expect(deriveDefaultScopeRoleId(mixed)).toBe('coder-1-2')
	})

	test('an empty or malformed list reads as no default scope', () => {
		expect(deriveDefaultScopeRoleId([])).toBeNull()
		expect(deriveDefaultScopeRoleId(null)).toBeNull()
		expect(deriveDefaultScopeRoleId('broken')).toBeNull()
	})
})

describe('scopeTurnEntries', () => {
	const entries = buildTurnIndex([
		startEvent(0, 'planner', 'planner-0-1'),
		callEvent(1, 'planner', { roleId: 'planner-0-1' }),
		startEvent(2, 'planner', 'planner-0-1'),
		callEvent(3, 'planner', { roleId: 'planner-0-1' }),
		callEvent(5, 'coder', { roleId: 'coder-1-2' }),
		startEvent(7, 'coder', 'coder-1-2'),
	])

	test('keeps only the scoped instance turns, renumbered within the instance', () => {
		const scoped = scopeTurnEntries(entries, 'coder-1-2')
		expect(scoped.map((entry) => entry.eventIndex)).toEqual([5, 7])
		expect(scoped.map((entry) => entry.turnNumber)).toEqual([1, 2])
		expect(defined(scoped[0], 'scoped[0]').kind).toBe('completed')
		expect(defined(scoped[1], 'scoped[1]').kind).toBe('in_flight')
		expect(defined(scoped[1], 'scoped[1]').role).toBe('coder')
	})

	test('a completed selection keeps its identity across renumbering', () => {
		const scoped = scopeTurnEntries(entries, 'planner-0-1')
		expect(scoped.map((entry) => entry.eventIndex)).toEqual([1, 3])
		expect(scoped.map((entry) => entry.turnNumber)).toEqual([1, 2])
	})

	test('an unset or unknown scope yields an empty list, and malformed input is tolerated', () => {
		expect(scopeTurnEntries(entries, null)).toEqual([])
		expect(scopeTurnEntries(entries, '')).toEqual([])
		expect(scopeTurnEntries(entries, 'nobody-0-9')).toEqual([])
		expect(scopeTurnEntries(null, 'coder-1-2')).toEqual([])
	})
})

describe('deriveTranscriptTurns', () => {
	test('stitches each turn out of its own slice only, so no message repeats across turns', () => {
		const turns = transcriptOf(stitchEvents, 'coder-1')
		expect(turns).toHaveLength(2)
		const first = defined(turns[0], 'turns[0]')
		const second = defined(turns[1], 'turns[1]')
		// Turn 1: the slice is entirely the hoisted opening, so nothing inline remains; the response carries the call…
		expect(first.messages).toHaveLength(0)
		expect(present(first.received, 'first.received').content).toBe('turn one reply')
		// …turn 2: the echo of turn 1's response and the tool result answering its call are both consumed — only the new response remains.
		expect(second.messages).toHaveLength(0)
		expect(present(second.received, 'second.received').content).toBe('turn two reply')
		// The document states each datum once: turn 1's reply appears in no later turn's material.
		expect(JSON.stringify(turns).split('turn one reply').length - 1).toBe(1)
	})

	test('the first turn hoists its leading system/user messages as the conversation opening, stopping at the first assistant/tool message', () => {
		const turns = transcriptOf(stitchEvents, 'coder-1')
		const first = defined(turns[0], 'turns[0]')
		expect(first.opening.map((message) => message.role)).toEqual(['system', 'user'])
		expect(first.opening.map((message) => message.content)).toEqual(['system prompt text', 'the task text'])
		// Later turns never carry an opening.
		expect(defined(turns[1], 'turns[1]').opening).toHaveLength(0)
		const boundary = [
			callEvent(4, 'coder', {
				roleId: 'coder-1',
				messageCount: 3,
				sentFrom: 2,
				sent: [
					{ role: 'assistant', content: 'earlier reply', tool_calls: [wireToolCall('c9', 'read_file', '{}')] },
					{ role: 'tool', content: '{"path":"ok"}' },
				],
				received: { content: 'later reply', reasoning: '', toolCalls: [] },
			}),
		]
		// A loaded window that begins mid-instance (the first slice starts with the echo) hoists nothing.
		const boundaryTurns = transcriptOf(boundary, 'coder-1')
		expect(defined(boundaryTurns[0], 'boundaryTurns[0]').opening).toHaveLength(0)
	})

	test('a tool call\u0027s outcome joins from the tool result that answers it in the following turn\u0027s slice', () => {
		const turns = transcriptOf(stitchEvents, 'coder-1')
		const call = defined(present(defined(turns[0], 'turns[0]').received, 'turns[0].received').toolCalls[0], 'toolCalls[0]')
		expect(call.id).toBe('c1')
		expect(call.name).toBe('write_file')
		expect(call.argumentsText).toBe('{"path":"a.txt"}')
		const outcome = present(call.outcome, 'call.outcome')
		expect(outcome.kind).toBe('tool_error')
		expect(outcome.summary).toBe('no space')
	})

	test('a tool result whose call is not rendered renders standalone with its own parsed outcome', () => {
		const events = [
			callEvent(0, 'coder', {
				roleId: 'coder-1',
				sent: [{ role: 'tool', content: '{"path":"written"}' }],
				received: { content: 'done', reasoning: '', toolCalls: [] },
				finishReason: 'stop',
			}),
		]
		const turns = transcriptOf(events, 'coder-1')
		const message = defined(defined(turns[0], 'turns[0]').messages[0], 'messages[0]')
		expect(message.role).toBe('tool')
		const outcome = present(message.outcome, 'message.outcome')
		expect(outcome.kind).toBe('success')
		expect(outcome.summary).toBe('{"path":"written"}')
	})

	test('an unanswered call (the newest turn) carries no invented outcome', () => {
		const withTailCall = [
			...stitchEvents,
			callEvent(3, 'coder', {
				roleId: 'coder-1',
				messageCount: 5,
				sentFrom: 4,
				sent: [{ role: 'assistant', content: 'turn two reply', tool_calls: [wireToolCall('c2', 'read_file', '{}')] }],
				received: { content: 'final', reasoning: '', toolCalls: [wireToolCall('c2', 'read_file', '{}')] },
			}),
		]
		const tailTurns = transcriptOf(withTailCall, 'coder-1')
		const last = defined(tailTurns[2], 'tailTurns[2]')
		const call = defined(present(last.received, 'last.received').toolCalls[0], 'toolCalls[0]')
		expect(call.outcome).toBeNull()
	})

	test('a standard-level turn renders header data only — no bodies, no invention', () => {
		const turns = transcriptOf([standardCallEvent(0, 'coder')], 'coder')
		const turn = defined(turns[0], 'turns[0]')
		expect(turn.bodyLevel).toBe('standard')
		expect(turn.opening).toHaveLength(0)
		expect(turn.messages).toHaveLength(0)
		expect(turn.received).toBeNull()
		expect(turn.usage).not.toBeNull()
		expect(turn.finishReason).toBe('tool_calls')
	})

	test('an in-flight turn carries no body yet', () => {
		const turns = transcriptOf([startEvent(0, 'coder', 'coder-1')], 'coder-1')
		const turn = defined(turns[0], 'turns[0]')
		expect(turn.kind).toBe('in_flight')
		expect(turn.bodyLevel).toBeNull()
		expect(turn.messages).toHaveLength(0)
		expect(turn.received).toBeNull()
		expect(turn.usage).toBeNull()
	})

	test('turn headers carry the instance-renumbered number, usage, and finish reason', () => {
		const turns = transcriptOf(stitchEvents, 'coder-1')
		const first = defined(turns[0], 'turns[0]')
		const second = defined(turns[1], 'turns[1]')
		expect(first.turnNumber).toBe(1)
		expect(present(first.usage, 'first.usage').totalTokens).toBe(120)
		expect(first.finishReason).toBe('tool_calls')
		expect(second.turnNumber).toBe(2)
		expect(present(second.usage, 'second.usage').totalTokens).toBe(210)
		expect(second.finishReason).toBe('stop')
	})

	test('a window that starts mid-conversation renders the first turn from what is loaded: the echo is skipped and its tool result renders standalone', () => {
		// A retention resync (or an unopened "Older turns" page) leaves a window whose first slice begins with the previous turn's echo — the previous turn and its response are absent from the window.
		const midWindow = [defined(stitchEvents[2], 'stitchEvents[2]')]
		const turns = transcriptOf(midWindow, 'coder-1')
		expect(turns).toHaveLength(1)
		const first = defined(turns[0], 'turns[0]')
		// The echo assistant message renders nowhere (it is the absent previous turn's response); the tool result answering its call renders standalone with its parsed outcome, since the call's rendering paged out.
		expect(first.opening).toHaveLength(0)
		expect(first.messages).toHaveLength(1)
		const result = defined(first.messages[0], 'first.messages[0]')
		expect(result.role).toBe('tool')
		expect(present(result.outcome, 'result.outcome').summary).toBe('no space')
		expect(present(first.received, 'first.received').content).toBe('turn two reply')
		// The absent previous turn's reply is invented nowhere.
		expect(JSON.stringify(turns).split('turn one reply').length - 1).toBe(0)
	})

	test('an empty or malformed input yields an empty transcript', () => {
		expect(deriveTranscriptTurns([], [])).toEqual([])
		expect(deriveTranscriptTurns(null, [])).toEqual([])
		expect(deriveTranscriptTurns(undefined, 'broken')).toEqual([])
	})
})

describe('childInstanceFor', () => {
	// A deep delegation chain: the orchestrator's turn delegates to coder-1, whose own turn delegates to coder-1-1.
	const chainEvents = [
		roleStartEvent(0, 'orchestrator-0', 'orchestrator', { depth: 0 }),
		callEvent(1, 'orchestrator', { roleId: 'orchestrator-0' }),
		roleStartEvent(2, 'coder-1', 'coder', { depth: 1, parent: 'orchestrator', parentRoleId: 'orchestrator-0' }),
		callEvent(3, 'coder', { roleId: 'coder-1' }),
		roleStartEvent(4, 'coder-1-1', 'coder', { depth: 2, parent: 'coder', parentRoleId: 'coder-1' }),
	]

	test('matches the first role_start after the turn whose parentRoleId names the parent, through deep chains', () => {
		expect(childInstanceFor(chainEvents, 'orchestrator-0', 1)).toBe('coder-1')
		expect(childInstanceFor(chainEvents, 'coder-1', 3)).toBe('coder-1-1')
	})

	test('ambiguous timing resolves by position: an earlier sibling start never matches a later turn', () => {
		const repeated = [
			roleStartEvent(2, 'coder-1', 'coder', { depth: 1, parent: 'orchestrator', parentRoleId: 'orchestrator-0' }),
			callEvent(5, 'orchestrator', { roleId: 'orchestrator-0' }),
			roleStartEvent(7, 'coder-2', 'coder', { depth: 1, parent: 'orchestrator', parentRoleId: 'orchestrator-0' }),
		]
		expect(childInstanceFor(repeated, 'orchestrator-0', 5)).toBe('coder-2')
		// Two candidate starts both after the turn: the first wins (the executor dispatches agent calls sequentially).
		const parallel = [
			roleStartEvent(6, 'first-1', 'coder', { parentRoleId: 'parent-0' }),
			roleStartEvent(8, 'second-1', 'writer', { parentRoleId: 'parent-0' }),
		]
		expect(childInstanceFor(parallel, 'parent-0', 5)).toBe('first-1')
	})

	test('no child identified reads as null: no start after the turn, a mismatched parent, or a refused spawn', () => {
		expect(childInstanceFor(chainEvents, 'orchestrator-0', 2)).toBeNull()
		expect(childInstanceFor(chainEvents, 'writer-0', 1)).toBeNull()
		expect(childInstanceFor([], 'orchestrator-0', 0)).toBeNull()
	})

	test('old logs whose role_start predates parentRoleId fall back to the parent role-name echo', () => {
		const legacy = [
			roleStartEvent(0, 'orchestrator-0', 'orchestrator'),
			callEvent(1, 'orchestrator', { roleId: 'orchestrator-0' }),
			roleStartEvent(2, 'coder-1', 'coder', { depth: 1, parent: 'orchestrator' }),
		]
		// The scope under the fallback world is the role name itself, so the echo compares against it.
		expect(childInstanceFor(legacy, 'orchestrator', 1)).toBe('coder-1')
		// A start that names a different parent exactly never falls through to the echo.
		const exactMismatch = [roleStartEvent(2, 'coder-1', 'coder', { depth: 1, parent: 'orchestrator', parentRoleId: 'someone-else' })]
		expect(childInstanceFor(exactMismatch, 'orchestrator', 1)).toBeNull()
	})

	test('malformed input reads as no child', () => {
		expect(childInstanceFor('broken', 'orchestrator-0', 1)).toBeNull()
		expect(childInstanceFor(chainEvents, '', 1)).toBeNull()
		expect(childInstanceFor(chainEvents, null, 1)).toBeNull()
		expect(childInstanceFor(chainEvents, 'orchestrator-0', null)).toBeNull()
		expect(childInstanceFor(chainEvents, 'orchestrator-0', 2.5)).toBeNull()
		expect(childInstanceFor([{ index: 4, type: 'role_start', payload: { role: 'coder' } }], 'orchestrator-0', 1)).toBeNull()
	})
})

describe('InspectorModal', () => {
	function renderModal(overrides: Record<string, unknown> = {}): Vnode {
		return InspectorModal(fakeH, {
			runLabel: 'run-2026',
			logEvents: [],
			turns: { loadState: 'ready', total: 0, tailOffset: 0, olderLoading: false },
			instances: [],
			chain: [],
			scopedRoleId: null,
			livePartial: null,
			renderMarkdown: fakeRenderMarkdown,
			onScopeInstance: () => undefined,
			onLoadOlder: () => undefined,
			onClose: () => undefined,
			...overrides,
		})
	}

	test('renders a backdrop and a card over the run view, with the run named in the heading', () => {
		const modal = renderModal()
		expect(modal.tag).toBe('div')
		expect(modal.props.class).toBe('inspector-modal-overlay')
		expect(allByClass(modal, 'inspector-modal-backdrop')).toHaveLength(1)
		expect(allByClass(modal, 'inspector-modal-card')).toHaveLength(1)
		const heading = defined(allByClass(modal, 'inspector-modal-heading')[0], 'heading')
		expect(collectText(heading)).toBe('LLM turns \u00b7 run-2026')
	})

	test('the backdrop click and the close button both dismiss the modal', () => {
		let closed = 0
		const onClose = () => { closed++ }
		const modal = renderModal({ onClose })
		const backdrop = defined(allByClass(modal, 'inspector-modal-backdrop')[0], 'backdrop')
		actionProp(backdrop.props, 'onclick')(undefined)
		const close = defined(allByTag(modal, 'button').find((button) => button.props.class === 'inspector-modal-close'), 'close')
		actionProp(close.props, 'onclick')(undefined)
		expect(closed).toBe(2)
	})

	test('the transcript renders one continuous document: the collapsed opening expander first, then the turns in order', () => {
		const modal = renderModal({ logEvents: stitchEvents, scopedRoleId: 'coder-1' })
		const opening = defined(allByClass(modal, 'inspector-opening')[0], 'opening')
		const summary = defined(allByTag(opening, 'summary')[0], 'opening summary')
		expect(collectText(summary)).toBe('system prompt \u00b7 task')
		// Collapsed by default: the native expander carries no `open` prop.
		expect(opening.props.open).toBeUndefined()
		const sections = allByClass(modal, 'inspector-turn-section')
		expect(sections).toHaveLength(2)
		const headers = allByClass(modal, 'inspector-turn-header')
		expect(collectText(defined(headers[0], 'headers[0]'))).toBe('Turn 1 \u00b7 120 tok \u00b7 tool_calls')
		expect(collectText(defined(headers[1], 'headers[1]'))).toBe('Turn 2 \u00b7 210 tok \u00b7 stop')
	})

	test('the opening expander carries the first turn\u0027s system prompt and task through the Markdown pipeline', () => {
		const modal = renderModal({ logEvents: stitchEvents, scopedRoleId: 'coder-1' })
		const opening = defined(allByClass(modal, 'inspector-opening')[0], 'opening')
		const markers = allByTag(opening, 'span').filter((node) => node.props.class === 'md-marker').map((node) => node.props['data-text'])
		expect(markers).toContain('system prompt text')
		expect(markers).toContain('the task text')
	})

	test('each turn renders its new messages and its response, with reasoning labeled through the Markdown pipeline, and nothing repeats', () => {
		const modal = renderModal({ logEvents: stitchEvents, scopedRoleId: 'coder-1' })
		const text = collectText(modal)
		// Each prose datum appears exactly once across the whole document.
		expect(occurrences(text, 'turn one reply')).toBe(1)
		expect(occurrences(text, 'turn two reply')).toBe(1)
		expect(occurrences(text, 'no space')).toBe(1)
		const markers = allByTag(modal, 'span').filter((node) => node.props.class === 'md-marker').map((node) => node.props['data-text'])
		expect(markers).toContain('turn one thinking')
		expect(markers).toContain('turn one reply')
		expect(markers).toContain('turn two thinking')
		expect(markers).toContain('turn two reply')
		// The reasoning is labeled 💭, the opening's messages render as their own blocks, and each turn's response renders as the response block.
		expect(text).toContain('\ud83d\udcad Reasoning')
		expect(allByClass(modal, 'inspector-message')).toHaveLength(2)
		expect(allByClass(modal, 'inspector-response')).toHaveLength(2)
	})

	test('tool calls render inline with name, compact arguments, outcome, and result summary', () => {
		const modal = renderModal({ logEvents: stitchEvents, scopedRoleId: 'coder-1' })
		const call = defined(allByClass(modal, 'inspector-tool-call')[0], 'tool call')
		const text = collectText(call)
		expect(text).toContain('write_file')
		expect(text).toContain('{"path":"a.txt"}')
		expect(text).not.toContain('turn one reply')
		const outcome = defined(allByClass(call, 'inspector-tool-outcome-error')[0], 'error chip')
		expect(collectText(outcome)).toBe('\u2717 tool_error')
		expect(collectText(call)).toContain('no space')
	})

	test('an agent call with an identifiable child renders the delegation affordance wired to the scope action; without one it stays plain text', () => {
		const agentEvents: WindowEvent[] = [
			startEvent(0, 'orchestrator', 'orchestrator-0'),
			callEvent(1, 'orchestrator', {
				roleId: 'orchestrator-0',
				sent: [{ role: 'user', content: 'the task text' }],
				received: { content: 'delegating', reasoning: '', toolCalls: [wireToolCall('a1', 'agent', '{"role":"coder","task":"subtask"}')] },
				finishReason: 'tool_calls',
			}),
			roleStartEvent(2, 'coder-1-1', 'coder', { depth: 1, parent: 'orchestrator', parentRoleId: 'orchestrator-0' }),
			roleFinishedEvent(3, 'coder-1-1', 'coder'),
			// The child returns: the next turn's slice carries the agent call's echo plus its result, so the affordance also shows the outcome.
			callEvent(4, 'orchestrator', {
				roleId: 'orchestrator-0',
				messageCount: 3,
				sentFrom: 2,
				sent: [
					{ role: 'assistant', content: 'delegating', tool_calls: [wireToolCall('a1', 'agent', '{"role":"coder","task":"subtask"}')] },
					{ role: 'tool', content: '{"status":"success","summary":"done"}' },
				],
				received: { content: 'child done', reasoning: '', toolCalls: [] },
				finishReason: 'stop',
			}),
		]
		const scoped = renderModal({ logEvents: agentEvents, scopedRoleId: 'orchestrator-0' })
		const call = defined(allByClass(scoped, 'inspector-tool-call')[0], 'agent call')
		expect(collectText(call)).toContain('agent')
		expect(collectText(call)).toContain('\u2192 coder-1-1')
		const outcome = defined(allByClass(call, 'inspector-tool-outcome-success')[0], 'success chip')
		expect(collectText(outcome)).toBe('\u2713 success')
		expect(collectText(call)).toContain('done')
		const view = defined(allByClass(call, 'inspector-tool-call-view')[0], 'view affordance')
		expect(collectText(view)).toBe('View \u25b8')
		let scopedTo = ''
		const onScopeInstance = (payload: unknown) => { scopedTo = typeof payload === 'string' ? payload : '' }
		const wired = renderModal({ logEvents: agentEvents, scopedRoleId: 'orchestrator-0', onScopeInstance })
		const wiredView = defined(allByClass(defined(allByClass(wired, 'inspector-tool-call')[0], 'agent call'), 'inspector-tool-call-view')[0], 'view affordance')
		dispatchActionTuple(wiredView.props.onclick)
		expect(scopedTo).toBe('coder-1-1')
		// No child role_start after the turn: the call renders as plain text with no affordance.
		const childless = renderModal({ logEvents: agentEvents.slice(0, 2), scopedRoleId: 'orchestrator-0' })
		const plainCall = defined(allByClass(childless, 'inspector-tool-call')[0], 'agent call')
		expect(collectText(plainCall)).not.toContain('\u2192')
		expect(allByClass(plainCall, 'inspector-tool-call-view')).toHaveLength(0)
		expect(collectText(plainCall)).toContain('{"role":"coder","task":"subtask"}')
	})

	test('the in-flight turn sits at the transcript bottom and hosts the matching live partial, clearly labeled', () => {
		const flightEvents = [...stitchEvents, startEvent(3, 'coder', 'coder-1')]
		const partial = { roleId: 'coder-1', role: 'coder', reasoning: 'streamed thinking', content: 'streamed reply' }
		const modal = renderModal({ logEvents: flightEvents, scopedRoleId: 'coder-1', livePartial: partial })
		const sections = allByClass(modal, 'inspector-turn-section')
		expect(sections).toHaveLength(3)
		const last = defined(sections[2], 'last section')
		expect(classOf(last.props)).toContain('is-in-flight')
		expect(collectText(last)).toContain('Turn 3 \u00b7 in flight\u2026')
		expect(collectText(last)).toContain('once the model responds')
		const block = defined(allByClass(last, 'inspector-live-partial')[0], 'live block')
		expect(collectText(block)).toContain('Reasoning')
		expect(collectText(block)).toContain('Response')
		const markers = allByTag(block, 'span').filter((node) => node.props.class === 'md-marker').map((node) => node.props['data-text'])
		expect(markers).toContain('streamed thinking')
		expect(markers).toContain('streamed reply')
	})

	test('an absent, empty, or mismatched live partial renders no block, and a same-named sibling never hosts another instance\u0027s stream', () => {
		const flightEvents = [...stitchEvents, startEvent(3, 'coder', 'coder-1')]
		const turns = { loadState: 'ready', total: 9, tailOffset: 0, olderLoading: false }
		expect(allByClass(renderModal({ logEvents: flightEvents, scopedRoleId: 'coder-1', turns }), 'inspector-live-partial')).toHaveLength(0)
		expect(allByClass(renderModal({ logEvents: flightEvents, scopedRoleId: 'coder-1', turns, livePartial: { roleId: 'coder-1', role: 'coder', reasoning: '', content: '' } }), 'inspector-live-partial')).toHaveLength(0)
		expect(allByClass(renderModal({ logEvents: flightEvents, scopedRoleId: 'coder-1', turns, livePartial: { roleId: 'coder-1-9', role: 'coder', reasoning: 'drifting', content: '' } }), 'inspector-live-partial')).toHaveLength(0)
		expect(allByClass(renderModal({ logEvents: flightEvents, scopedRoleId: 'coder-1', turns, livePartial: 'broken' }), 'inspector-live-partial')).toHaveLength(0)
		// A fallback turn (old logs, no roleId on the start) still pairs on the role name.
		const fallbackEvents = [...stitchEvents, startEvent(3, 'coder')]
		const fallback = renderModal({ logEvents: fallbackEvents, scopedRoleId: 'coder', livePartial: { roleId: 'coder-1', role: 'coder', reasoning: 'legacy', content: '' } })
		expect(allByClass(fallback, 'inspector-live-partial')).toHaveLength(1)
	})

	test('a standard-level turn renders its header with the honest degraded notice, and the transcript stays navigable', () => {
		const standardEvents = [standardCallEvent(0, 'coder'), standardCallEvent(1, 'coder')]
		const modal = renderModal({ logEvents: standardEvents, scopedRoleId: 'coder' })
		const sections = allByClass(modal, 'inspector-turn-section')
		expect(sections).toHaveLength(2)
		const text = collectText(modal)
		expect(text).toContain('Turn 1 \u00b7 120 tok \u00b7 tool_calls')
		expect(text).toContain('Turn 2 \u00b7 120 tok \u00b7 tool_calls')
		expect(occurrences(text, 'Standard')).toBeGreaterThanOrEqual(2)
		expect(text).toContain('compose screen')
		expect(text).not.toContain('could not be loaded')
	})

	test('the loading, failed, and empty states read honestly, and a scope with no turns reads as wayfinding', () => {
		expect(collectText(renderModal({ turns: { loadState: 'loading', total: null, tailOffset: null, olderLoading: false } }))).toContain('Loading the run log\u2026')
		expect(collectText(renderModal({ turns: { loadState: 'failed', total: null, tailOffset: null, olderLoading: false } }))).toContain('The run log could not be loaded.')
		expect(collectText(renderModal())).toContain('No LLM turns logged for this run yet.')
		const scopedEmpty = renderModal({ scopedRoleId: 'coder-1-2' })
		expect(collectText(scopedEmpty)).toContain('No turns logged for this instance in the loaded range yet.')
		expect(collectText(scopedEmpty)).not.toContain('No LLM turns logged')
	})

	test('the older-turns control appears only when older events exist and reflects the loading state', () => {
		const withoutOlder = renderModal({ logEvents: stitchEvents, scopedRoleId: 'coder-1' })
		expect(allByClass(withoutOlder, 'inspector-older')).toHaveLength(0)
		const withOlder = renderModal({ logEvents: stitchEvents, scopedRoleId: 'coder-1', turns: { loadState: 'ready', total: 400, tailOffset: 200, olderLoading: false } })
		const older = defined(allByClass(withOlder, 'inspector-older')[0], 'older button')
		expect(collectText(older)).toBe('Older turns')
		expect(older.props.disabled).toBe(false)
		const loadingOlder = renderModal({ logEvents: stitchEvents, scopedRoleId: 'coder-1', turns: { loadState: 'ready', total: 400, tailOffset: 200, olderLoading: true } })
		const olderLoading = defined(allByClass(loadingOlder, 'inspector-older')[0], 'older loading button')
		expect(olderLoading.props.disabled).toBe(true)
		expect(collectText(olderLoading)).toContain('loading older turns\u2026')
	})

	test('a mid-conversation window (a retention resync kept only the newest window) renders the load-older affordance above turns built from the partial slice', () => {
		// The loaded window begins at the echo slice: the earlier turns and the conversation opening are absent, and the control pages them back in.
		const modal = renderModal({ logEvents: [defined(stitchEvents[2], 'stitchEvents[2]')], scopedRoleId: 'coder-1', turns: { loadState: 'ready', total: 400, tailOffset: 200, olderLoading: false } })
		const older = defined(allByClass(modal, 'inspector-older')[0], 'older control')
		expect(collectText(older)).toBe('Older turns')
		// The transcript renders from what is loaded: the renumbered turn header, the standalone tool result, and no opening expander (its material paged out).
		expect(collectText(defined(allByClass(modal, 'inspector-turn-header')[0], 'header'))).toBe('Turn 1 \u00b7 210 tok \u00b7 stop')
		expect(allByClass(modal, 'inspector-opening')).toHaveLength(0)
		const text = collectText(modal)
		expect(text).toContain('no space')
		expect(text).not.toContain('turn one reply')
	})

	test('the breadcrumb renders the chain root-first with the scoped crumb current, and crumbs re-scope via the instance action', () => {
		const chain = [
			{ roleId: 'orchestrator-0', role: 'orchestrator' },
			{ roleId: 'coder-1', role: 'coder' },
			{ roleId: 'coder-1-2', role: 'coder' },
		]
		const modal = renderModal({ chain, scopedRoleId: 'coder-1-2' })
		const row = defined(allByClass(modal, 'inspector-breadcrumb-row')[0], 'breadcrumb row')
		const crumbs = allByClass(row, 'inspector-crumb')
		expect(crumbs).toHaveLength(3)
		expect(allByClass(row, 'inspector-crumb-sep')).toHaveLength(2)
		expect(collectText(defined(crumbs[0], 'crumbs[0]'))).toBe('orchestrator-0')
		expect(collectText(defined(crumbs[2], 'crumbs[2]'))).toBe('coder-1-2')
		expect(defined(crumbs[2], 'crumbs[2]').props.disabled).toBe(true)
		expect(classOf(defined(crumbs[2], 'crumbs[2]').props)).toContain('is-current')
		expect(defined(crumbs[0], 'crumbs[0]').props.disabled).toBe(false)
		// Each crumb wires the scope action with the instance id as the tuple payload.
		expect(actionTuple(defined(crumbs[0], 'crumbs[0]').props.onclick)[1]).toBe('orchestrator-0')
		expect(actionTuple(defined(crumbs[1], 'crumbs[1]').props.onclick)[1]).toBe('coder-1')
	})

	test('the parent affordance appears only on a chain deeper than one and scopes to the immediate parent', () => {
		const shallow = renderModal({ chain: [{ roleId: 'orchestrator-0', role: 'orchestrator' }] })
		expect(allByClass(shallow, 'inspector-parent-up')).toHaveLength(0)
		const deep = renderModal({
			chain: [
				{ roleId: 'orchestrator-0', role: 'orchestrator' },
				{ roleId: 'coder-1', role: 'coder' },
			],
			scopedRoleId: 'coder-1',
		})
		const up = defined(allByClass(deep, 'inspector-parent-up')[0], 'parent affordance')
		expect(collectText(up)).toBe('\u2191 parent')
		expect(actionTuple(up.props.onclick)[1]).toBe('orchestrator-0')
	})

	test('the instance dropdown lists role name plus status, marks the scoped one selected, and wires the change event bare', () => {
		const onChange = () => undefined
		const modal = renderModal({
			instances: [
				{ roleId: 'orchestrator-0', role: 'orchestrator', parentRoleId: null, parentRole: null, live: true },
				{ roleId: 'coder-1-2', role: 'coder', parentRoleId: 'orchestrator-0', parentRole: 'orchestrator', live: false },
			],
			scopedRoleId: 'coder-1-2',
			onScopeInstance: onChange,
		})
		const select = defined(allByClass(modal, 'inspector-instance-select')[0], 'instance select')
		expect(select.props.onchange).toBe(onChange)
		const options = allByTag(select, 'option')
		expect(options).toHaveLength(2)
		expect(collectText(defined(options[0], 'options[0]'))).toBe('orchestrator (orchestrator-0) \u2014 live')
		expect(collectText(defined(options[1], 'options[1]'))).toBe('coder (coder-1-2) \u2014 finished')
		expect(defined(options[1], 'options[1]').props.selected).toBe(true)
		expect(defined(options[0], 'options[0]').props.selected).toBe(false)
		expect(select.props.value).toBe('coder-1-2')
	})

	test('no loaded instances render neither the breadcrumb row nor the dropdown', () => {
		const modal = renderModal()
		expect(allByClass(modal, 'inspector-breadcrumb-row')).toHaveLength(0)
		expect(allByClass(modal, 'inspector-instance-select')).toHaveLength(0)
	})

	test('constants match the endpoint contract sizes', () => {
		expect(INSPECTOR_WINDOW_SIZE).toBe(200)
		expect(INSPECTOR_PAGE_LIMIT).toBe(500)
		expect(INSPECTOR_RETENTION_LIMIT).toBe(4000)
	})

	// --- On-the-wire expander ---------------------------------------------------

	function renderModalWithWire(overrides: Record<string, unknown> = {}): Vnode {
		return renderModal({ wireDetailLookup: () => ({ status: 'idle' }), onToggleWire: () => () => undefined, ...overrides })
	}

	test('each completed turn renders a collapsed "on the wire" expander labeled with the payload\u2019s message count; in-flight turns render none', () => {
		const modal = renderModalWithWire({ logEvents: stitchEvents, scopedRoleId: 'coder-1' })
		const expanders = allByClass(modal, 'inspector-wire')
		expect(expanders).toHaveLength(2)
		// Collapsed by default: the native expander carries no `open` prop.
		for (const expander of expanders) expect(expander.props.open).toBeUndefined()
		const summaries = expanders.map((expander) => collectText(defined(allByTag(expander, 'summary')[0], 'summary')))
		// The counts are the full request's message counts the turns' own llm_call payloads report — known before any fetch.
		expect(summaries).toEqual(['on the wire \u00b7 2 messages', 'on the wire \u00b7 4 messages'])
		const flightEvents = [...stitchEvents, startEvent(3, 'coder', 'coder-1')]
		expect(allByClass(renderModalWithWire({ logEvents: flightEvents, scopedRoleId: 'coder-1' }), 'inspector-wire')).toHaveLength(2)
	})

	test('a singular message count reads "1 message" and an unknown count renders the bare label', () => {
		const one = renderModalWithWire({ logEvents: [callEvent(0, 'coder', { roleId: 'coder-1', messageCount: 1 })], scopedRoleId: 'coder-1' })
		expect(collectText(defined(allByClass(one, 'inspector-wire-summary')[0], 'summary'))).toBe('on the wire \u00b7 1 message')
		const unknown = renderModalWithWire({ logEvents: [callEvent(0, 'coder', { roleId: 'coder-1', messageCount: 'broken' })], scopedRoleId: 'coder-1' })
		expect(collectText(defined(allByClass(unknown, 'inspector-wire-summary')[0], 'summary'))).toBe('on the wire')
	})

	test('a ready lookup renders the folded request\u2019s sections through the Markdown pipeline, finish reason and usage included', () => {
		const lookup = (eventIndex: number) => eventIndex === 1
			? { status: 'ready', sections: [
					{ label: 'sent', content: [{ role: 'system', content: 'wire system prompt' }, { role: 'user', content: 'wire task text' }] },
					{ label: 'received', content: { content: 'wire reply', reasoning: 'wire thinking', toolCalls: [] } },
					{ label: 'finish reason', content: 'stop' },
					{ label: 'usage', content: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } },
				] }
			: { status: 'loading' }
		const modal = renderModalWithWire({ logEvents: [callEvent(1, 'coder', { roleId: 'coder-1' })], scopedRoleId: 'coder-1', wireDetailLookup: lookup })
		const expander = defined(allByClass(modal, 'inspector-wire')[0], 'expander')
		const markers = allByTag(expander, 'span').filter((node) => node.props.class === 'md-marker').map((node) => node.props['data-text'])
		expect(markers).toContain('wire system prompt')
		expect(markers).toContain('wire task text')
		expect(markers).toContain('wire reply')
		expect(markers).toContain('wire thinking')
		const text = collectText(expander)
		expect(text).toContain('Sent messages')
		expect(text).toContain('Finish reason')
		expect(text).toContain('stop')
		// The usage section renders as a pretty-printed JSON block — a text node, never markup.
		const usageBlock = defined(allByClass(expander, 'inspector-json')[0], 'usage json')
		expect(collectText(usageBlock)).toContain('"totalTokens": 3')
	})

	test('loading, ready-null, and idle each render their honest fixed notice', () => {
		const events = [callEvent(1, 'coder', { roleId: 'coder-1' })]
		const loading = renderModalWithWire({ logEvents: events, scopedRoleId: 'coder-1', wireDetailLookup: () => ({ status: 'loading' }) })
		expect(collectText(defined(allByClass(loading, 'inspector-wire-body')[0], 'loading body'))).toContain('Loading the full request')
		const empty = renderModalWithWire({ logEvents: events, scopedRoleId: 'coder-1', wireDetailLookup: () => ({ status: 'ready', sections: null }) })
		expect(collectText(defined(allByClass(empty, 'inspector-wire-body')[0], 'empty body'))).toContain('No request or response detail was logged for this turn.')
		const idle = renderModalWithWire({ logEvents: events, scopedRoleId: 'coder-1' })
		expect(collectText(defined(allByClass(idle, 'inspector-wire-body')[0], 'idle body'))).toContain('could not be loaded')
	})

	test('malformed lookup states render the retry notice and never invented sections', () => {
		const modal = renderModalWithWire({ logEvents: [callEvent(1, 'coder', { roleId: 'coder-1' })], scopedRoleId: 'coder-1', wireDetailLookup: () => 'broken' })
		const body = defined(allByClass(modal, 'inspector-wire-body')[0], 'body')
		expect(collectText(body)).toContain('could not be loaded')
		expect(allByClass(body, 'inspector-section')).toHaveLength(0)
	})

	test('the expander wires the toggle handler with the turn\u2019s event index, and a modal without the wiring renders none', () => {
		const toggled: number[] = []
		const modal = renderModalWithWire({ logEvents: stitchEvents, scopedRoleId: 'coder-1', onToggleWire: (eventIndex: number) => {
			toggled.push(eventIndex)
			return () => undefined
		} })
		for (const expander of allByClass(modal, 'inspector-wire')) {
			const ontoggle = expander.props.ontoggle
			if (typeof ontoggle !== 'function') throw new Error('ontoggle is not a function')
			ontoggle({}, { target: { open: true } })
		}
		expect(toggled).toEqual([1, 2])
		// No lookup prop wired: no expander renders rather than a dead one.
		expect(allByClass(renderModal({ logEvents: stitchEvents, scopedRoleId: 'coder-1' }), 'inspector-wire')).toHaveLength(0)
		expect(allByClass(renderModalWithWire({ logEvents: stitchEvents, scopedRoleId: 'coder-1', onToggleWire: 'broken' }), 'inspector-wire')).toHaveLength(0)
	})
})
