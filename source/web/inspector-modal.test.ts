import { describe, expect, test } from 'bun:test'
import { InspectorModal, buildTurnIndex, deriveDetailBodyState, deriveDefaultScopeRoleId, deriveInstanceChain, instancesOf, resolveSelection, scopeTurnEntries, tailWindowOffset, olderWindowOffset, olderFetchLimit, canPageOlder, INSPECTOR_WINDOW_SIZE, INSPECTOR_PAGE_LIMIT } from './static/inspector-modal.js'
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

// A fake Markdown renderer that records its argument and returns a marker vnode carrying the text, so the tests assert both that the prose flowed through the renderer and that its output reached the modal.
function fakeRenderMarkdown(text: string): Vnode {
	return { tag: 'span', props: { class: 'md-marker', 'data-text': text }, children: [text] }
}

// Reads a prop that must be a two-element hyperapp action tuple (`[Action, payload]`), failing the test with a readable message otherwise.
function actionTuple(value: unknown): [unknown, unknown] {
	if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'function') throw new Error('prop is not a two-element action tuple')
	return [value[0], value[1]]
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

describe('deriveDetailBodyState', () => {
	test('full when a sent or received section is present', () => {
		expect(deriveDetailBodyState([{ label: 'sent', content: [] }, { label: 'received', content: {} }])).toBe('full')
		expect(deriveDetailBodyState([{ label: 'received', content: {} }])).toBe('full')
		expect(deriveDetailBodyState([{ label: 'sent', content: [] }])).toBe('full')
	})

	test('degraded when sections carry only metadata', () => {
		expect(deriveDetailBodyState([{ label: 'usage', content: {} }, { label: 'finish reason', content: 'stop' }])).toBe('degraded')
		expect(deriveDetailBodyState([])).toBe('degraded')
	})

	test('degraded for a null or malformed response — an honest notice, not an error', () => {
		expect(deriveDetailBodyState(null)).toBe('degraded')
		expect(deriveDetailBodyState(undefined)).toBe('degraded')
		expect(deriveDetailBodyState('broken')).toBe('degraded')
		expect(deriveDetailBodyState([null, 42])).toBe('degraded')
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

describe('resolveSelection', () => {
	const entries = buildTurnIndex([
		callEvent(1, 'planner'),
		startEvent(5, 'coder'),
	])

	test('keeps a selection the new list still carries', () => {
		expect(resolveSelection(1, entries)).toBe(1)
		expect(resolveSelection(5, entries)).toBe(5)
	})

	test('maps a completed in-flight selection to its paired completed entry', () => {
		const grown = buildTurnIndex([callEvent(1, 'planner'), startEvent(5, 'coder'), callEvent(6, 'coder')])
		expect(resolveSelection(5, grown)).toBe(6)
	})

	test('deselects when the index no longer resolves', () => {
		expect(resolveSelection(99, entries)).toBeNull()
		expect(resolveSelection(null, entries)).toBeNull()
		expect(resolveSelection(2.5, entries)).toBeNull()
		expect(resolveSelection(1, [])).toBeNull()
	})

	test('operates within the scoped instance turns: another instance scope deselects, the same scope keeps and maps', () => {
		const grown = buildTurnIndex([
			startEvent(0, 'planner', 'planner-0-1'),
			callEvent(1, 'planner', { roleId: 'planner-0-1' }),
			startEvent(3, 'coder', 'coder-1-2'),
			callEvent(4, 'coder', { roleId: 'coder-1-2' }),
		])
		const plannerScope = scopeTurnEntries(grown, 'planner-0-1')
		const coderScope = scopeTurnEntries(grown, 'coder-1-2')
		// A selection made on the planner's turn survives within the planner scope and maps when its in-flight start completes…
		expect(resolveSelection(0, plannerScope)).toBe(1)
		// …and reads as deselected once the operator re-scopes to the coder.
		expect(resolveSelection(0, coderScope)).toBeNull()
		// The coder's own in-flight selection maps to its completed entry within its scope.
		expect(resolveSelection(3, coderScope)).toBe(4)
	})
})

describe('InspectorModal', () => {
	function renderModal(overrides: Record<string, unknown> = {}): Vnode {
		return InspectorModal(fakeH, {
			runLabel: 'run-2026',
			turns: { loadState: 'ready', entries: [], total: 0, tailOffset: 0, selectedEventIndex: null, scopedRoleId: null, olderLoading: false },
			instances: [],
			chain: [],
			scopedRoleId: null,
			detailState: null,
			renderMarkdown: fakeRenderMarkdown,
			onSelectTurn: () => undefined,
			onScopeInstance: () => undefined,
			onLoadOlder: () => undefined,
			onClose: () => undefined,
			...overrides,
		})
	}

	const completedEntries = buildTurnIndex([startEvent(0, 'planner'), callEvent(3, 'planner'), startEvent(5, 'coder')])
	const inFlightEntry = defined(completedEntries[1], 'completedEntries[1]')

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

	test('turn rows render newest first and wire the select action with the entry as payload', () => {
		const modal = renderModal({ turns: { loadState: 'ready', entries: completedEntries, total: 9, tailOffset: 0, selectedEventIndex: null, olderLoading: false } })
		const rows = allByClass(modal, 'inspector-turn')
		expect(rows).toHaveLength(2)
		expect(collectText(defined(rows[0], 'rows[0]'))).toContain('#2')
		expect(collectText(defined(rows[1], 'rows[1]'))).toContain('#1')
		const tuple = actionTuple(defined(rows[0], 'rows[0]').props.onclick)
		expect(tuple[1]).toBe(inFlightEntry)
	})

	test('an in-flight turn row shows the in-flight marker and the detail pane explains the contract', () => {
		const modal = renderModal({ turns: { loadState: 'ready', entries: completedEntries, total: 9, tailOffset: 0, selectedEventIndex: inFlightEntry.eventIndex, olderLoading: false } })
		expect(collectText(modal)).toContain('in flight…')
		const pane = defined(allByClass(modal, 'inspector-detail-pane')[0], 'detail pane')
		expect(collectText(pane)).toContain('once the model responds')
	})

	test('the live partial renders labeled reasoning and response under the matching in-flight row', () => {
		const modal = renderModal({
			turns: { loadState: 'ready', entries: completedEntries, total: 9, tailOffset: 0, selectedEventIndex: null, olderLoading: false },
			livePartial: { roleId: 'coder-1', role: 'coder', reasoning: 'thinking hard', content: 'partial ans' },
		})
		const blocks = allByClass(modal, 'inspector-live-partial')
		expect(blocks).toHaveLength(1)
		const block = defined(blocks[0], 'live block')
		expect(collectText(block)).toContain('Reasoning')
		expect(collectText(block)).toContain('Response')
		const markedTexts = allByTag(modal, 'span').filter((node) => node.props.class === 'md-marker').map((node) => node.props['data-text'])
		expect(markedTexts).toContain('thinking hard')
		expect(markedTexts).toContain('partial ans')
		// The block sits with its row: the in-flight row is wrapped together with the live block, not detached elsewhere.
		const wrapper = defined(allByClass(modal, 'inspector-turn-live')[0], 'live wrapper')
		expect(allByClass(wrapper, 'inspector-turn')).toHaveLength(1)
		expect(allByClass(wrapper, 'inspector-live-partial')).toHaveLength(1)
	})

	test('an empty or absent live partial renders no block, and neither does a mismatched role or a completed-only list', () => {
		const turns = { loadState: 'ready', entries: completedEntries, total: 9, tailOffset: 0, selectedEventIndex: null, olderLoading: false }
		expect(allByClass(renderModal({ turns }), 'inspector-live-partial')).toHaveLength(0)
		expect(allByClass(renderModal({ turns, livePartial: null }), 'inspector-live-partial')).toHaveLength(0)
		expect(allByClass(renderModal({ turns, livePartial: { roleId: 'coder-1', role: 'coder', reasoning: '', content: '' } }), 'inspector-live-partial')).toHaveLength(0)
		expect(allByClass(renderModal({ turns, livePartial: { roleId: 'planner-1', role: 'planner', reasoning: 'drifting', content: '' } }), 'inspector-live-partial')).toHaveLength(0)
		expect(allByClass(renderModal({ turns, livePartial: 'broken' }), 'inspector-live-partial')).toHaveLength(0)
		const completedOnly = buildTurnIndex([startEvent(0, 'planner'), callEvent(3, 'planner')])
		expect(allByClass(renderModal({ turns: { ...turns, entries: completedOnly }, livePartial: { roleId: 'planner-1', role: 'planner', reasoning: 'done', content: '' } }), 'inspector-live-partial')).toHaveLength(0)
	})

	test('a selected completed turn renders its sections, with reasoning clearly labeled through the Markdown pipeline', () => {
		const detailState = {
			sections: [
				{ label: 'sent', content: [{ role: 'user', content: 'do the thing' }] },
				{ label: 'received', content: { content: 'on it', reasoning: 'step by step…', toolCalls: [] } },
				{ label: 'finish reason', content: 'tool_calls' },
				{ label: 'usage', content: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } },
			],
		}
		const modal = renderModal({
			turns: { loadState: 'ready', entries: completedEntries, total: 9, tailOffset: 0, selectedEventIndex: 3, olderLoading: false },
			detailState,
		})
		const text = collectText(modal)
		expect(text).toContain('Sent messages')
		expect(text).toContain('Reasoning')
		expect(text).toContain('Finish reason')
		expect(text).toContain('tool_calls')
		const markers = allByTag(modal, 'span').filter((node) => node.props.class === 'md-marker')
		const markedTexts = markers.map((node) => node.props['data-text'])
		expect(markedTexts).toContain('do the thing')
		expect(markedTexts).toContain('on it')
		expect(markedTexts).toContain('step by step…')
	})

	test('degraded detail sections render the honest notice pointing at the logging level, not an error', () => {
		const modal = renderModal({
			turns: { loadState: 'ready', entries: completedEntries, total: 9, tailOffset: 0, selectedEventIndex: 3, olderLoading: false },
			detailState: { sections: [{ label: 'usage', content: { totalTokens: 120 } }] },
		})
		const text = collectText(modal)
		expect(text).toContain('Standard')
		expect(text).toContain('compose screen')
		expect(text).not.toContain('could not be loaded')
	})

	test('a failed detail fetch and a loading one each read honestly', () => {
		const failed = renderModal({
			turns: { loadState: 'ready', entries: completedEntries, total: 9, tailOffset: 0, selectedEventIndex: 3, olderLoading: false },
			detailState: 'failed',
		})
		expect(collectText(failed)).toContain('could not be loaded')
		const loading = renderModal({
			turns: { loadState: 'ready', entries: completedEntries, total: 9, tailOffset: 0, selectedEventIndex: 3, olderLoading: false },
			detailState: 'loading',
		})
		expect(collectText(loading)).toContain('Loading the turn detail…')
	})

	test('with no selection the detail pane invites a selection', () => {
		const modal = renderModal({ turns: { loadState: 'ready', entries: completedEntries, total: 9, tailOffset: 0, selectedEventIndex: null, olderLoading: false } })
		expect(collectText(modal)).toContain('Select a turn')
	})

	test('the older-turns control appears only when older events exist and reflects the loading state', () => {
		const withoutOlder = renderModal({ turns: { loadState: 'ready', entries: completedEntries, total: 9, tailOffset: 0, selectedEventIndex: null, olderLoading: false } })
		expect(allByClass(withoutOlder, 'inspector-older')).toHaveLength(0)
		const withOlder = renderModal({ turns: { loadState: 'ready', entries: completedEntries, total: 400, tailOffset: 200, selectedEventIndex: null, olderLoading: false } })
		const older = defined(allByClass(withOlder, 'inspector-older')[0], 'older button')
		expect(collectText(older)).toBe('Older turns')
		expect(older.props.disabled).toBe(false)
		const loadingOlder = renderModal({ turns: { loadState: 'ready', entries: completedEntries, total: 400, tailOffset: 200, selectedEventIndex: null, olderLoading: true } })
		const olderLoading = defined(allByClass(loadingOlder, 'inspector-older')[0], 'older loading button')
		expect(olderLoading.props.disabled).toBe(true)
		expect(collectText(olderLoading)).toContain('loading older turns…')
	})

	test('the empty and failed turn lists read honestly', () => {
		const empty = renderModal()
		expect(collectText(empty)).toContain('No LLM turns logged')
		const failed = renderModal({ turns: { loadState: 'failed', entries: [], total: null, tailOffset: null, selectedEventIndex: null, scopedRoleId: null, olderLoading: false } })
		expect(collectText(failed)).toContain('could not be loaded')
	})

	test('a scope with no turns in the loaded range reads as wayfinding, not an empty log', () => {
		const scopedEmpty = renderModal({ turns: { loadState: 'ready', entries: [], total: 0, tailOffset: 0, selectedEventIndex: null, scopedRoleId: null, olderLoading: false }, scopedRoleId: 'coder-1-2' })
		expect(collectText(scopedEmpty)).toContain('No turns logged for this instance in the loaded range yet.')
		expect(collectText(scopedEmpty)).not.toContain('No LLM turns logged')
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
		expect(collectText(up)).toBe('↑ parent')
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
		expect(collectText(defined(options[0], 'options[0]'))).toBe('orchestrator (orchestrator-0) — live')
		expect(collectText(defined(options[1], 'options[1]'))).toBe('coder (coder-1-2) — finished')
		expect(defined(options[1], 'options[1]').props.selected).toBe(true)
		expect(defined(options[0], 'options[0]').props.selected).toBe(false)
		expect(select.props.value).toBe('coder-1-2')
	})

	test('no loaded instances render neither the breadcrumb row nor the dropdown', () => {
		const modal = renderModal()
		expect(allByClass(modal, 'inspector-breadcrumb-row')).toHaveLength(0)
		expect(allByClass(modal, 'inspector-instance-select')).toHaveLength(0)
	})

	test('the live partial pairs on the instance id first so a same-named sibling ghost never hosts another instance stream', () => {
		const flightEntries = buildTurnIndex([startEvent(2, 'coder', 'coder-1-1')])
		const matching = renderModal({
			turns: { loadState: 'ready', entries: flightEntries, total: 9, tailOffset: 0, selectedEventIndex: null, scopedRoleId: 'coder-1-1', olderLoading: false },
			scopedRoleId: 'coder-1-1',
			livePartial: { roleId: 'coder-1-1', role: 'coder', reasoning: 'thinking', content: '' },
		})
		expect(allByClass(matching, 'inspector-live-partial')).toHaveLength(1)
		// Same role name, different instance: no block.
		const mismatched = renderModal({
			turns: { loadState: 'ready', entries: flightEntries, total: 9, tailOffset: 0, selectedEventIndex: null, scopedRoleId: 'coder-1-1', olderLoading: false },
			scopedRoleId: 'coder-1-1',
			livePartial: { roleId: 'coder-1-2', role: 'coder', reasoning: 'drifting', content: '' },
		})
		expect(allByClass(mismatched, 'inspector-live-partial')).toHaveLength(0)
		// A fallback entry (old log, no roleId on the start) still pairs on the role name.
		const fallbackEntries = buildTurnIndex([startEvent(2, 'coder')])
		const fallback = renderModal({
			turns: { loadState: 'ready', entries: fallbackEntries, total: 9, tailOffset: 0, selectedEventIndex: null, scopedRoleId: 'coder', olderLoading: false },
			scopedRoleId: 'coder',
			livePartial: { roleId: 'coder-1-1', role: 'coder', reasoning: 'legacy', content: '' },
		})
		expect(allByClass(fallback, 'inspector-live-partial')).toHaveLength(1)
	})

	test('constants match the endpoint contract sizes', () => {
		expect(INSPECTOR_WINDOW_SIZE).toBe(200)
		expect(INSPECTOR_PAGE_LIMIT).toBe(500)
	})
})
