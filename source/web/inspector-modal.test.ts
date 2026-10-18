import { describe, expect, test } from 'bun:test'
import { InspectorModal } from './static/ts/inspector-modal.js'
import { createInspectorSession } from './static/ts/turn-inspector/index.js'
import type { FetchRequest, InspectorSession, InspectorView } from './static/ts/turn-inspector/index.js'
import { actionProp, defined, present } from './test-fixtures.js'

// The inspector-modal component is browser-pure, so the fake `h`/`renderMarkdown` below carry the vnode shape the tests assert against. Session-derived views come from the module's public contract; pure rendering states use a public `InspectorView` literal.

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

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1
}

function fakeRenderMarkdown(text: string): Vnode {
	return { tag: 'span', props: { class: 'md-marker', 'data-text': text }, children: [text] }
}

function actionTuple(value: unknown): [unknown, unknown] {
	if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'function') throw new Error('prop is not a two-element action tuple')
	return [value[0], value[1]]
}

function dispatchActionTuple(value: unknown): unknown {
	const [action, payload] = actionTuple(value)
	if (typeof action !== 'function') throw new Error('action tuple head is not a function')
	return action(payload)
}

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

function standardCallEvent(index: number, role: string): WindowEvent {
	return callEvent(index, role, { sent: undefined, received: undefined, sentFrom: undefined })
}

function roleStartEvent(index: number, roleId: string, role: string, extras: Record<string, unknown> = {}): WindowEvent {
	return { index, timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}Z`, type: 'role_start', payload: { role, roleId, depth: 0, task: 't', ...extras } }
}

function roleFinishedEvent(index: number, roleId: string, role: string): WindowEvent {
	return { index, timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}Z`, type: 'role_finished', payload: { role, roleId, depth: 0, status: 'success' } }
}

function wireToolCall(id: string, name: string, args: string): Record<string, unknown> {
	return { id, type: 'function', function: { name, arguments: args } }
}

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

function windowBody(events: unknown[], total = events.length, offset = 0, runId = 'run-1'): Record<string, unknown> {
	return { runId, total, offset, events }
}

function landWindow(session: InspectorSession, request: FetchRequest, body: unknown): void {
	const result = session.receive(request, body, null)
	if (result.followUp !== null) session.receive(result.followUp, body, null)
}

function sessionFor(events: unknown[], options: { scopedRoleId?: string | null; total?: number; offset?: number } = {}): InspectorSession {
	const session = createInspectorSession()
	const probe = session.start('run-1')
	if (probe === null) throw new Error('start did not return a probe')
	const body = windowBody(events, options.total ?? events.length, options.offset ?? 0)
	landWindow(session, probe, body)
	if (options.scopedRoleId !== undefined && options.scopedRoleId !== null) {
		const scoped = session.scope(options.scopedRoleId)
		if (scoped.request !== null) landWindow(session, scoped.request, body)
	}
	return session
}

function baseView(overrides: Partial<InspectorView> = {}): InspectorView {
	return {
		loadState: 'ready',
		scopedRoleId: null,
		hasOlder: false,
		olderLoading: false,
		instances: [],
		chain: [],
		transcript: [],
		wireDetail: () => ({ status: 'idle' }),
		childInstance: () => null,
		...overrides,
	}
}

function renderView(view: InspectorView, props: Record<string, unknown> = {}): Vnode {
	return InspectorModal(fakeH, {
		runLabel: 'run-2026',
		view,
		livePartial: null,
		renderMarkdown: fakeRenderMarkdown,
		onScopeInstance: () => undefined,
		onLoadOlder: () => undefined,
		onClose: () => undefined,
		...props,
	})
}

function renderModal(overrides: Partial<InspectorView> = {}, props: Record<string, unknown> = {}): Vnode {
	return renderView(baseView(overrides), props)
}

function emptyViewAfterStart(): InspectorView {
	const session = createInspectorSession()
	session.start('run-1')
	return session.view()
}

function failedView(): InspectorView {
	const session = createInspectorSession()
	const probe = session.start('run-1')
	if (probe === null) throw new Error('start did not return a probe')
	session.fail(probe)
	return session.view()
}

describe('InspectorModal shell', () => {
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
		const modal = renderModal({}, { onClose })
		const backdrop = defined(allByClass(modal, 'inspector-modal-backdrop')[0], 'backdrop')
		actionProp(backdrop.props, 'onclick')(undefined)
		const close = defined(allByTag(modal, 'button').find((button) => button.props.class === 'inspector-modal-close'), 'close')
		actionProp(close.props, 'onclick')(undefined)
		expect(closed).toBe(2)
	})

	test('the loading, failed, and empty states read honestly, and a scope with no turns reads as wayfinding', () => {
		expect(collectText(renderView(emptyViewAfterStart()))).toContain('Loading the run log\u2026')
		expect(collectText(renderView(failedView()))).toContain('The run log could not be loaded.')
		expect(collectText(renderModal())).toContain('No LLM turns logged for this run yet.')
		const scopedEmpty = renderModal({ scopedRoleId: 'coder-1-2' })
		expect(collectText(scopedEmpty)).toContain('No turns logged for this instance in the loaded range yet.')
		expect(collectText(scopedEmpty)).not.toContain('No LLM turns logged')
	})

	test('the older-turns control appears only when older events exist and reflects the loading state', () => {
		expect(allByClass(renderModal(), 'inspector-older')).toHaveLength(0)
		const withOlder = renderModal({ hasOlder: true })
		const older = defined(allByClass(withOlder, 'inspector-older')[0], 'older button')
		expect(collectText(older)).toBe('Older turns')
		expect(older.props.disabled).toBe(false)
		const loadingOlder = renderModal({ hasOlder: true, olderLoading: true })
		const olderLoading = defined(allByClass(loadingOlder, 'inspector-older')[0], 'older loading button')
		expect(olderLoading.props.disabled).toBe(true)
		expect(collectText(olderLoading)).toContain('loading older turns\u2026')
	})
})

describe('InspectorModal transcript', () => {
	test('renders one continuous document: the collapsed opening expander first, then the turns in order', () => {
		const modal = renderView(sessionFor(stitchEvents, { scopedRoleId: 'coder-1' }).view())
		const opening = defined(allByClass(modal, 'inspector-opening')[0], 'opening')
		const summary = defined(allByTag(opening, 'summary')[0], 'opening summary')
		expect(collectText(summary)).toBe('system prompt \u00b7 task')
		expect(opening.props.open).toBeUndefined()
		const sections = allByClass(modal, 'inspector-turn-section')
		expect(sections).toHaveLength(2)
		const headers = allByClass(modal, 'inspector-turn-header')
		expect(collectText(defined(headers[0], 'headers[0]'))).toBe('Turn 1 \u00b7 120 tok \u00b7 tool_calls')
		expect(collectText(defined(headers[1], 'headers[1]'))).toBe('Turn 2 \u00b7 210 tok \u00b7 stop')
	})

	test('the opening expander carries the first turn\u0027s system prompt and task through the Markdown pipeline', () => {
		const modal = renderView(sessionFor(stitchEvents, { scopedRoleId: 'coder-1' }).view())
		const opening = defined(allByClass(modal, 'inspector-opening')[0], 'opening')
		const markers = allByTag(opening, 'span').filter((node) => node.props.class === 'md-marker').map((node) => node.props['data-text'])
		expect(markers).toContain('system prompt text')
		expect(markers).toContain('the task text')
	})

	test('each turn renders its new messages and its response, with reasoning labeled through the Markdown pipeline, and nothing repeats', () => {
		const modal = renderView(sessionFor(stitchEvents, { scopedRoleId: 'coder-1' }).view())
		const text = collectText(modal)
		expect(occurrences(text, 'turn one reply')).toBe(1)
		expect(occurrences(text, 'turn two reply')).toBe(1)
		expect(occurrences(text, 'no space')).toBe(1)
		const markers = allByTag(modal, 'span').filter((node) => node.props.class === 'md-marker').map((node) => node.props['data-text'])
		expect(markers).toContain('turn one thinking')
		expect(markers).toContain('turn one reply')
		expect(markers).toContain('turn two thinking')
		expect(markers).toContain('turn two reply')
		expect(text).toContain('\ud83d\udcad Reasoning')
		expect(allByClass(modal, 'inspector-message')).toHaveLength(2)
		expect(allByClass(modal, 'inspector-response')).toHaveLength(2)
	})

	test('tool calls render inline with name, compact arguments, outcome, and result summary', () => {
		const modal = renderView(sessionFor(stitchEvents, { scopedRoleId: 'coder-1' }).view())
		const call = defined(allByClass(modal, 'inspector-tool-call')[0], 'tool call')
		const text = collectText(call)
		expect(text).toContain('write_file')
		expect(text).toContain('{"path":"a.txt"}')
		expect(text).not.toContain('turn one reply')
		const outcome = defined(allByClass(call, 'inspector-tool-outcome-error')[0], 'error chip')
		expect(collectText(outcome)).toBe('\u2717 tool_error')
		expect(collectText(call)).toContain('no space')
	})

	test('an agent call with an identifiable child renders the delegation affordance wired to the scope action', () => {
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
		const session = sessionFor(agentEvents, { scopedRoleId: 'orchestrator-0' })
		const scoped = renderView(session.view())
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
		const wired = renderView(session.view(), { onScopeInstance })
		const wiredView = defined(allByClass(defined(allByClass(wired, 'inspector-tool-call')[0], 'agent call'), 'inspector-tool-call-view')[0], 'view affordance')
		dispatchActionTuple(wiredView.props.onclick)
		expect(scopedTo).toBe('coder-1-1')
		// No child role_start after the turn: the call renders as plain text with no affordance.
		const childless = renderView(sessionFor(agentEvents.slice(0, 2), { scopedRoleId: 'orchestrator-0' }).view())
		const plainCall = defined(allByClass(childless, 'inspector-tool-call')[0], 'agent call')
		expect(collectText(plainCall)).not.toContain('\u2192')
		expect(allByClass(plainCall, 'inspector-tool-call-view')).toHaveLength(0)
		expect(collectText(plainCall)).toContain('{"role":"coder","task":"subtask"}')
	})

	test('the in-flight turn sits at the transcript bottom and hosts the matching live partial', () => {
		const flightEvents = [...stitchEvents, startEvent(3, 'coder', 'coder-1')]
		const partial = { roleId: 'coder-1', role: 'coder', reasoning: 'streamed thinking', content: 'streamed reply' }
		const modal = renderView(sessionFor(flightEvents, { scopedRoleId: 'coder-1' }).view(), { livePartial: partial })
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
		const view = sessionFor(flightEvents, { scopedRoleId: 'coder-1' }).view()
		expect(allByClass(renderView(view), 'inspector-live-partial')).toHaveLength(0)
		expect(allByClass(renderView(view, { livePartial: { roleId: 'coder-1', role: 'coder', reasoning: '', content: '' } }), 'inspector-live-partial')).toHaveLength(0)
		expect(allByClass(renderView(view, { livePartial: { roleId: 'coder-1-9', role: 'coder', reasoning: 'drifting', content: '' } }), 'inspector-live-partial')).toHaveLength(0)
		expect(allByClass(renderView(view, { livePartial: 'broken' }), 'inspector-live-partial')).toHaveLength(0)
		const fallbackEvents = [...stitchEvents, startEvent(3, 'coder')]
		const fallback = renderView(sessionFor(fallbackEvents, { scopedRoleId: 'coder' }).view(), { livePartial: { roleId: 'coder-1', role: 'coder', reasoning: 'legacy', content: '' } })
		expect(allByClass(fallback, 'inspector-live-partial')).toHaveLength(1)
	})

	test('a standard-level turn renders its header with the honest degraded notice, and the transcript stays navigable', () => {
		const standardEvents = [standardCallEvent(0, 'coder'), standardCallEvent(1, 'coder')]
		const modal = renderView(sessionFor(standardEvents, { scopedRoleId: 'coder-1' }).view())
		const sections = allByClass(modal, 'inspector-turn-section')
		expect(sections).toHaveLength(2)
		const text = collectText(modal)
		expect(text).toContain('Turn 1 \u00b7 120 tok \u00b7 tool_calls')
		expect(text).toContain('Turn 2 \u00b7 120 tok \u00b7 tool_calls')
		expect(occurrences(text, 'Standard')).toBeGreaterThanOrEqual(2)
		expect(text).toContain('compose screen')
		expect(text).not.toContain('could not be loaded')
	})

	test('a mid-conversation window renders the load-older affordance above turns built from the partial slice', () => {
		const modal = renderView(sessionFor([defined(stitchEvents[2], 'stitchEvents[2]')], { scopedRoleId: 'coder-1', total: 3, offset: 2 }).view())
		const older = defined(allByClass(modal, 'inspector-older')[0], 'older control')
		expect(collectText(older)).toBe('Older turns')
		expect(collectText(defined(allByClass(modal, 'inspector-turn-header')[0], 'header'))).toBe('Turn 1 \u00b7 210 tok \u00b7 stop')
		expect(allByClass(modal, 'inspector-opening')).toHaveLength(0)
		const text = collectText(modal)
		expect(text).toContain('no space')
		expect(text).not.toContain('turn one reply')
	})
})

describe('InspectorModal breadcrumb and instances', () => {
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
		}, { onScopeInstance: onChange })
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

	test('a server-filtered scoped view renders the complete ancestor chain and only the scoped turns', () => {
		const tailWindow = [
			startEvent(90, 'coder', 'coder-2'),
			callEvent(91, 'coder', { roleId: 'coder-2' }),
			roleStartEvent(92, 'coder-1-2', 'coder', { depth: 2, parent: 'coder', parentRoleId: 'coder-1' }),
		]
		const coderGrandchildWindow = [
			roleStartEvent(0, 'orchestrator-0', 'orchestrator'),
			roleStartEvent(3, 'coder-1', 'coder', { depth: 1, parent: 'orchestrator', parentRoleId: 'orchestrator-0' }),
			roleStartEvent(6, 'coder-1-2', 'coder', { depth: 2, parent: 'coder', parentRoleId: 'coder-1' }),
			startEvent(7, 'coder', 'coder-1-2'),
			callEvent(8, 'coder', { roleId: 'coder-1-2' }),
			roleFinishedEvent(9, 'coder-1-2', 'coder'),
			roleFinishedEvent(11, 'coder-1', 'coder'),
			roleFinishedEvent(16, 'orchestrator-0', 'orchestrator'),
		]
		const session = createInspectorSession()
		const probe = session.start('run-1')
		if (probe === null) throw new Error('start did not return a probe')
		landWindow(session, probe, windowBody(tailWindow, 100, 50))
		const scoped = session.scope('coder-1-2')
		landWindow(session, present(scoped.request, 'scope request'), windowBody(coderGrandchildWindow, 8, 0))
		const modal = renderView(session.view())
		const row = defined(allByClass(modal, 'inspector-breadcrumb-row')[0], 'breadcrumb row')
		expect(allByClass(row, 'inspector-crumb')).toHaveLength(3)
		const headers = allByClass(modal, 'inspector-turn-header')
		expect(headers).toHaveLength(1)
		expect(collectText(defined(headers[0], 'turn header'))).toContain('Turn 1')
		const select = defined(allByClass(modal, 'inspector-instance-select')[0], 'instance select')
		expect(allByTag(select, 'option')).toHaveLength(4)
	})
})

describe('InspectorModal on-the-wire expander', () => {
	function renderModalWithWire(overrides: Partial<InspectorView> = {}, props: Record<string, unknown> = {}): Vnode {
		return renderModal({ wireDetail: () => ({ status: 'idle' }), ...overrides }, { onToggleWire: () => () => undefined, ...props })
	}

	test('each completed turn renders a collapsed expander labeled with the payload message count; in-flight turns render none', () => {
		const modal = renderView(sessionFor(stitchEvents, { scopedRoleId: 'coder-1' }).view(), { onToggleWire: () => () => undefined })
		const expanders = allByClass(modal, 'inspector-wire')
		expect(expanders).toHaveLength(2)
		for (const expander of expanders) expect(expander.props.open).toBeUndefined()
		const summaries = expanders.map((expander) => collectText(defined(allByTag(expander, 'summary')[0], 'summary')))
		expect(summaries).toEqual(['on the wire \u00b7 2 messages', 'on the wire \u00b7 4 messages'])
		const flightEvents = [...stitchEvents, startEvent(3, 'coder', 'coder-1')]
		expect(allByClass(renderView(sessionFor(flightEvents, { scopedRoleId: 'coder-1' }).view(), { onToggleWire: () => () => undefined }), 'inspector-wire')).toHaveLength(2)
	})

	test('a singular message count reads "1 message" and an unknown count renders the bare label', () => {
		const one = renderModalWithWire({ transcript: sessionFor([callEvent(0, 'coder', { roleId: 'coder-1', messageCount: 1 })], { scopedRoleId: 'coder-1' }).view().transcript })
		expect(collectText(defined(allByClass(one, 'inspector-wire-summary')[0], 'summary'))).toBe('on the wire \u00b7 1 message')
		const unknown = renderModalWithWire({ transcript: sessionFor([callEvent(0, 'coder', { roleId: 'coder-1', messageCount: 'broken' })], { scopedRoleId: 'coder-1' }).view().transcript })
		expect(collectText(defined(allByClass(unknown, 'inspector-wire-summary')[0], 'summary'))).toBe('on the wire')
	})

	test('a ready lookup renders the folded request sections through the Markdown pipeline, finish reason and usage included', () => {
		const lookup = (eventIndex: number) => eventIndex === 1
			? { status: 'ready' as const, sections: [
					{ label: 'sent', content: [{ role: 'system', content: 'wire system prompt' }, { role: 'user', content: 'wire task text' }] },
					{ label: 'received', content: { content: 'wire reply', reasoning: 'wire thinking', toolCalls: [] } },
					{ label: 'finish reason', content: 'stop' },
					{ label: 'usage', content: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } },
				] }
			: { status: 'loading' as const }
		const modal = renderModalWithWire({ transcript: sessionFor([callEvent(1, 'coder', { roleId: 'coder-1' })], { scopedRoleId: 'coder-1' }).view().transcript, wireDetail: lookup })
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
		const usageBlock = defined(allByClass(expander, 'inspector-json')[0], 'usage json')
		expect(collectText(usageBlock)).toContain('"totalTokens": 3')
	})

	test('loading, ready-null, and idle each render their honest fixed notice', () => {
		const transcript = sessionFor([callEvent(1, 'coder', { roleId: 'coder-1' })], { scopedRoleId: 'coder-1' }).view().transcript
		const loading = renderModalWithWire({ transcript, wireDetail: () => ({ status: 'loading' }) })
		expect(collectText(defined(allByClass(loading, 'inspector-wire-body')[0], 'loading body'))).toContain('Loading the full request')
		const empty = renderModalWithWire({ transcript, wireDetail: () => ({ status: 'ready', sections: null }) })
		expect(collectText(defined(allByClass(empty, 'inspector-wire-body')[0], 'empty body'))).toContain('No request or response detail was logged for this turn.')
		const idle = renderModalWithWire({ transcript })
		expect(collectText(defined(allByClass(idle, 'inspector-wire-body')[0], 'idle body'))).toContain('could not be loaded')
	})

	test('the expander wires the toggle handler with the turn event index, and a modal without the toggle renders none', () => {
		const toggled: number[] = []
		const modal = renderView(sessionFor(stitchEvents, { scopedRoleId: 'coder-1' }).view(), { onToggleWire: (eventIndex: number) => {
			toggled.push(eventIndex)
			return () => undefined
		} })
		for (const expander of allByClass(modal, 'inspector-wire')) {
			const ontoggle = expander.props.ontoggle
			if (typeof ontoggle !== 'function') throw new Error('ontoggle is not a function')
			ontoggle({}, { target: { open: true } })
		}
		expect(toggled).toEqual([1, 2])
		expect(allByClass(renderView(sessionFor(stitchEvents, { scopedRoleId: 'coder-1' }).view()), 'inspector-wire')).toHaveLength(0)
		expect(allByClass(renderView(sessionFor(stitchEvents, { scopedRoleId: 'coder-1' }).view(), { onToggleWire: 'broken' }), 'inspector-wire')).toHaveLength(0)
	})
})
