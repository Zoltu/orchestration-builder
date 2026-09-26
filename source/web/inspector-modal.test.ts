import { describe, expect, test } from 'bun:test'
import { InspectorModal, buildTurnIndex, deriveDetailBodyState, resolveSelection, tailWindowOffset, olderWindowOffset, olderFetchLimit, canPageOlder, INSPECTOR_WINDOW_SIZE, INSPECTOR_PAGE_LIMIT } from './static/inspector-modal.js'
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

function startEvent(index: number, role: string): WindowEvent {
	return { index, timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}Z`, type: 'llm_call_start', payload: { role } }
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
})

describe('InspectorModal', () => {
	function renderModal(overrides: Record<string, unknown> = {}): Vnode {
		return InspectorModal(fakeH, {
			runLabel: 'run-2026',
			turns: { loadState: 'ready', entries: [], total: 0, tailOffset: 0, selectedEventIndex: null, olderLoading: false },
			detailState: null,
			renderMarkdown: fakeRenderMarkdown,
			onSelectTurn: () => undefined,
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
		const failed = renderModal({ turns: { loadState: 'failed', entries: [], total: null, tailOffset: null, selectedEventIndex: null, olderLoading: false } })
		expect(collectText(failed)).toContain('could not be loaded')
	})

	test('constants match the endpoint contract sizes', () => {
		expect(INSPECTOR_WINDOW_SIZE).toBe(200)
		expect(INSPECTOR_PAGE_LIMIT).toBe(500)
	})
})
