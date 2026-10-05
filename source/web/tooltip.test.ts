import { describe, expect, test } from 'bun:test'
import { Tooltip, formatTooltipContent, deriveOperationTooltip, deriveParticipantTooltip, deriveRoleTooltip, isTooltipSection } from './static/ts/tooltip.js'
import { stacksOf } from './static/ts/interaction-model.js'
import { labelsModule } from './label-resolver-fixture.js'
import { defined } from './test-fixtures.js'

// The tooltip component is browser-pure JS, so its exports arrive with inferred JS types. The interfaces and fake `h`/`renderMarkdown` below carry the shape the tests assert against, mirroring result-modal.test.ts.

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

function byTag(vnode: Vnode, tag: string): Vnode[] {
	return vnode.children.filter((child): child is Vnode => isVnode(child) && child.tag === tag)
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

function textOf(vnode: Vnode): string {
	return vnode.children.filter((child): child is string => typeof child === 'string').join('')
}

// A fake Markdown renderer that records its argument and returns a marker vnode carrying the text, so the tests assert both that the prose flowed through the renderer and that its output reached the card.
function fakeRenderMarkdown(text: string): Vnode {
	return { tag: 'span', props: { class: 'md-marker', 'data-text': text }, children: [text] }
}

describe('isTooltipSection', () => {
	test('accepts an object with a string label and rejects anything else', () => {
		expect(isTooltipSection({ label: 'summary', content: 'hi' })).toBe(true)
		expect(isTooltipSection({ label: 'x' })).toBe(true)
		expect(isTooltipSection({ label: 3, content: 'hi' })).toBe(false)
		expect(isTooltipSection({ content: 'hi' })).toBe(false)
		expect(isTooltipSection(null)).toBe(false)
		expect(isTooltipSection('summary')).toBe(false)
	})
})

describe('formatTooltipContent', () => {
	test('object content renders as a <pre> text node with pretty-printed JSON (real newlines, not \\n escapes)', () => {
		const vnode: Vnode = formatTooltipContent(fakeH, fakeRenderMarkdown, { promptTokens: 4200, completionTokens: 180 })
		expect(vnode.tag).toBe('pre')
		expect(vnode.props.class).toBe('tooltip-json')
		const text = textOf(vnode)
		expect(text).toContain('"promptTokens": 4200')
		expect(text).toContain('"completionTokens": 180')
		// Pretty-printed JSON uses real newlines, so the rendered <pre> shows them as line breaks rather than literal backslash-n.
		expect(text).toContain('\n')
		expect(text).not.toContain('\\n')
	})

	test('array content renders as pretty-printed JSON', () => {
		const vnode: Vnode = formatTooltipContent(fakeH, fakeRenderMarkdown, [{ role: 'user', content: 'hi' }])
		expect(vnode.tag).toBe('pre')
		expect(vnode.props.class).toBe('tooltip-json')
		expect(textOf(vnode)).toContain('"role": "user"')
	})

	test('a JSON-encoded string (tool arguments) is probed and pretty-printed as JSON', () => {
		// The executor stores tool arguments as a JSON string; the probe makes {"path":"…"} legible rather than rendering it as a one-line Markdown paragraph.
		const vnode: Vnode = formatTooltipContent(fakeH, fakeRenderMarkdown, '{"path":"README.md","content":"# Project"}')
		expect(vnode.tag).toBe('pre')
		expect(vnode.props.class).toBe('tooltip-json')
		expect(textOf(vnode)).toContain('"path": "README.md"')
	})

	test('a prose string flows through the sanitized Markdown renderer', () => {
		const vnode: Vnode = formatTooltipContent(fakeH, fakeRenderMarkdown, 'added the export button')
		expect(vnode.tag).toBe('div')
		expect(vnode.props.class).toBe('tooltip-prose markdown')
		const marker = defined(byTag(vnode, 'span')[0], 'marker')
		expect(marker).toBeDefined()
		expect(marker.props['data-text']).toBe('added the export button')
	})

	test('a string that parses to a scalar (number/boolean) is treated as prose, not pretty JSON', () => {
		// A result string like "42" should read as text, not render as a bare number.
		const vnode: Vnode = formatTooltipContent(fakeH, fakeRenderMarkdown, '42')
		expect(vnode.tag).toBe('div')
		expect(vnode.props.class).toBe('tooltip-prose markdown')
	})

	test('number and boolean scalars render as plain text', () => {
		const numberVnode: Vnode = formatTooltipContent(fakeH, fakeRenderMarkdown, 14)
		expect(numberVnode.tag).toBe('span')
		expect(numberVnode.props.class).toBe('tooltip-scalar')
		expect(textOf(numberVnode)).toBe('14')

		const booleanVnode: Vnode = formatTooltipContent(fakeH, fakeRenderMarkdown, true)
		expect(booleanVnode.props.class).toBe('tooltip-scalar')
		expect(textOf(booleanVnode)).toBe('true')
	})

	test('a scalar flag forces a string to render as plain text rather than prose', () => {
		// A status word or formatted time is a scalar the derivation marks explicitly, so it renders as a plain span instead of flowing through the Markdown pipeline.
		const vnode: Vnode = formatTooltipContent(fakeH, fakeRenderMarkdown, 'success', true)
		expect(vnode.tag).toBe('span')
		expect(vnode.props.class).toBe('tooltip-scalar')
		expect(textOf(vnode)).toBe('success')
	})

	test('a scalar flag on a null content still renders the em-dash placeholder', () => {
		const vnode: Vnode = formatTooltipContent(fakeH, fakeRenderMarkdown, null, true)
		expect(textOf(vnode)).toBe('\u2014')
	})

	test('null and undefined render the em-dash placeholder', () => {
		for (const content of [null, undefined]) {
			const vnode: Vnode = formatTooltipContent(fakeH, fakeRenderMarkdown, content)
			expect(vnode.tag).toBe('span')
			expect(vnode.props.class).toBe('tooltip-scalar')
			expect(textOf(vnode)).toBe('\u2014')
		}
	})
})

describe('Tooltip', () => {
	const sections = [
		{ label: 'arguments', content: '{"path":"README.md"}' },
		{ label: 'result', content: 'wrote README.md' },
		{ label: 'status', content: 'success', scalar: true },
		{ label: 'usage', content: { promptTokens: 4200, completionTokens: 180 } },
	]

	test('renders a card with a heading and one labeled block per section, each formatted by kind', () => {
		const card: Vnode = Tooltip(fakeH, { title: 'write_file', sections, renderMarkdown: fakeRenderMarkdown })
		expect(card.tag).toBe('div')
		expect(card.props.class).toBe('tooltip-card')
		const heading = byTag(card, 'p').find((p) => p.props.class === 'tooltip-heading')
		expect(heading).toBeDefined()
		expect(textOf(defined(heading, 'heading'))).toBe('write_file')

		const blocks = byTag(card, 'div').filter((d) => d.props.class === 'tooltip-section')
		expect(blocks.length).toBe(4)
		// arguments → pretty JSON <pre>
		const argumentsBlock = defined(blocks[0], 'blocks[0]')
		expect(defined(byTag(argumentsBlock, 'span').find((s) => s.props.class === 'tooltip-label'), 'tooltip-label').children).toContain('arguments')
		expect(byTag(argumentsBlock, 'pre').find((p) => p.props.class === 'tooltip-json')).toBeDefined()
		// result → prose
		expect(byTag(defined(blocks[1], 'blocks[1]'), 'div').find((d) => d.props.class === 'tooltip-prose markdown')).toBeDefined()
		// status → scalar text
		expect(byTag(defined(blocks[2], 'blocks[2]'), 'span').find((s) => s.props.class === 'tooltip-scalar')).toBeDefined()
		// usage → pretty JSON
		expect(byTag(defined(blocks[3], 'blocks[3]'), 'pre').find((p) => p.props.class === 'tooltip-json')).toBeDefined()
	})

	test('renders no buttons (the card is a read-only hover inspector)', () => {
		const card: Vnode = Tooltip(fakeH, { title: 't', sections, renderMarkdown: fakeRenderMarkdown })
		expect(allByTag(card, 'button').length).toBe(0)
	})

	test('carries no onclick (dismissal is hover-driven, not click-driven)', () => {
		const card: Vnode = Tooltip(fakeH, { title: 't', sections: [], renderMarkdown: fakeRenderMarkdown })
		expect(card.props.onclick).toBeUndefined()
	})

	test('a non-array or unfiltered sections prop yields a heading-only card', () => {
		const card: Vnode = Tooltip(fakeH, { title: 't', sections: 'not an array', renderMarkdown: fakeRenderMarkdown })
		expect(byTag(card, 'div').filter((d) => d.props.class === 'tooltip-section').length).toBe(0)
		expect(byTag(card, 'p').find((p) => p.props.class === 'tooltip-heading')).toBeDefined()
	})
})

// --- Section derivation -----------------------------------------------------
// The derivations are pure functions of (InteractionModel, label resolver, id). The fixtures
// mirror the InteractionModel shape the backend adapter and the demo scenarios produce, so the
// tests pin the id → sections mapping without depending on the fixture module. The label resolver
// is the real seed-guild resolver (label-resolver-fixture.ts) so the resolved titles match what the
// live `/api/config` produces, mirroring flow-view.test.ts. The model type is pulled off the
// `stacksOf` helper's JSDoc so the inline fixtures are contextually checked against the contract.

type InteractionModel = Parameters<typeof stacksOf>[0]
type Participant = InteractionModel['participants'][number]
type Operation = InteractionModel['operations'][number]
type LabelTier = Parameters<typeof labelsModule.resolveParticipantLabel>[1]

const TIER: LabelTier = 'detailed'

function participant(id: string, role: string, kind: Participant['kind']): Participant {
	return { id, role, kind }
}

function callOperation(id: string, source: string, destination: string): Operation {
	return { id, kind: 'call', stack: 'root', source, destination, startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null }
}

function returnOperation(id: string, source: string, destination: string, outcome: Operation['outcome'], metrics: Operation['metrics']): Operation {
	return { id, kind: 'return', stack: 'root', source, destination, startedAt: 't0', settledAt: null, lifecycle: 'settled', outcome, metrics }
}

// The operation-details lookup state the derivations read (see tooltip.js "On-demand operation
// details"): the wiring's session cache answers with one of these per operation id.
type DetailsState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; details: string | null }

function readyDetails(map: Record<string, string | null>): (operationId: string) => DetailsState {
	return (operationId) => (operationId in map ? { status: 'ready', details: map[operationId] ?? null } : { status: 'failed' })
}

// A delegation chain model used by several derivation tests: the human delegates to the orchestrator,
// which delegates to a coder, which calls a read_file tool; the returns unwind with summaries and a
// result. The detail markdown each call/return surfaces comes from the lookup the wiring passes.
function delegationModel(): InteractionModel {
	return {
		participants: [
			participant('human:root', 'human', 'human'),
			participant('role:orchestrator:1', 'orchestrator', 'role'),
			participant('role:coder:1', 'coder', 'role'),
			participant('tool:read_file:1', 'read_file', 'tool'),
		],
		operations: [
			callOperation('op1', 'human:root', 'role:orchestrator:1'),
			callOperation('op2', 'role:orchestrator:1', 'role:coder:1'),
			callOperation('op3', 'role:coder:1', 'tool:read_file:1'),
			returnOperation('op4', 'tool:read_file:1', 'role:coder:1', 'success', { tokens: 120, cachedPromptTokens: 0, elapsedSeconds: 1 }),
			returnOperation('op5', 'role:coder:1', 'role:orchestrator:1', 'success', { tokens: 800, cachedPromptTokens: 0, elapsedSeconds: 9 }),
			returnOperation('op6', 'role:orchestrator:1', 'human:root', 'success', { tokens: 1500, cachedPromptTokens: 0, elapsedSeconds: 15 }),
		],
		status: 'success',
	}
}

// An ask_human model: the orchestrator asks a distinct human answerer (instance-per-invocation, like
// coder-1/coder-2), the answer is returned, and the run completes. The answerer's incoming call
// carries the question text; its return carries the answer text.
function askHumanModel(answered: boolean): InteractionModel {
	const operations: Operation[] = [
		callOperation('op1', 'human:root', 'role:orchestrator:1'),
		callOperation('op2', 'role:orchestrator:1', 'human:answerer:1'),
	]
	if (answered) {
		operations.push(returnOperation('op3', 'human:answerer:1', 'role:orchestrator:1', 'success', null))
		operations.push(returnOperation('op4', 'role:orchestrator:1', 'human:root', 'success', null))
	}
	return {
		participants: [
			participant('human:root', 'human', 'human'),
			participant('role:orchestrator:1', 'orchestrator', 'role'),
			participant('human:answerer:1', 'human', 'human'),
		],
		operations,
		status: answered ? 'success' : 'needs_clarification',
	}
}

function labelOf(model: InteractionModel, operation: Operation): string {
	return labelsModule.resolveOperationLabel(operation, model.participants, TIER, labelsModule.hashString(operation.id))
}

describe('deriveOperationTooltip', () => {
	test('an operation id resolves to its label and a single details section carrying its markdown', () => {
		const model = delegationModel()
		const result = deriveOperationTooltip(model, labelsModule, TIER, 'op2', readyDetails({ op2: 'Implement the feature.' }))
		expect(result.title).toBe(labelOf(model, defined(model.operations[1], 'model.operations[1]')))
		expect(result.sections).toEqual([{ label: 'details', content: 'Implement the feature.' }])
	})

	test('a tool call surfaces the pretty-printed arguments details', () => {
		const model = delegationModel()
		const result = deriveOperationTooltip(model, labelsModule, TIER, 'op3', readyDetails({ op3: '```json\n{"path":"README.md"}\n```' }))
		expect(result.sections).toEqual([{ label: 'details', content: '```json\n{"path":"README.md"}\n```' }])
	})

	test('a return surfaces its result/summary details', () => {
		const model = delegationModel()
		const result = deriveOperationTooltip(model, labelsModule, TIER, 'op4', readyDetails({ op4: '```json\n{"content":"# Project"}\n```' }))
		expect(result.sections).toEqual([{ label: 'details', content: '```json\n{"content":"# Project"}\n```' }])
	})

	test('a loading lookup renders a scalar placeholder section; a failed or ready-null lookup yields a title-only card', () => {
		const model = delegationModel()
		const loading = deriveOperationTooltip(model, labelsModule, TIER, 'op2', () => ({ status: 'loading' }))
		expect(loading.sections).toEqual([{ label: 'details', content: 'loading details…', scalar: true }])
		const failed = deriveOperationTooltip(model, labelsModule, TIER, 'op2', () => ({ status: 'failed' }))
		expect(failed.sections).toEqual([])
		const empty = deriveOperationTooltip(model, labelsModule, TIER, 'op2', readyDetails({ op2: null }))
		expect(empty.sections).toEqual([])
		expect(empty.title).not.toBe('')
	})

	test('an operation with no lookup at all yields a title-only card (no details wired)', () => {
		const model = delegationModel()
		const result = deriveOperationTooltip(model, labelsModule, TIER, 'op2')
		expect(result.sections).toEqual([])
		expect(result.title).not.toBe('')
	})

	test('an unknown operation id yields an empty title-only result', () => {
		const model = delegationModel()
		expect(deriveOperationTooltip(model, labelsModule, TIER, 'nope', readyDetails({ op2: 'Implement the feature.' }))).toEqual({ title: '', sections: [] })
	})
})

describe('deriveParticipantTooltip', () => {
	test('a completed role shows kind, status, and the finish summary (return details preferred over the call task)', () => {
		const model = delegationModel()
		const result = deriveParticipantTooltip(model, labelsModule, TIER, 'role:coder:1', readyDetails({ op2: 'Implement the feature.', op5: 'Done implementing.' }))
		const labels = result.sections.map((s) => s.label)
		expect(labels).toEqual(['kind', 'status', 'summary'])
		expect(defined(result.sections.find((s) => s.label === 'kind'), 'kind section').content).toBe('role')
		expect(defined(result.sections.find((s) => s.label === 'status'), 'status section').content).toBe('success')
		expect(defined(result.sections.find((s) => s.label === 'summary'), 'summary section').content).toBe('Done implementing.')
	})

	test('an in-flight role with no completing return shows the delegation task and no status', () => {
		const model: InteractionModel = {
			participants: [participant('human:root', 'human', 'human'), participant('role:coder:1', 'coder', 'role')],
			operations: [callOperation('op1', 'human:root', 'role:coder:1')],
			status: 'running',
		}
		const result = deriveParticipantTooltip(model, labelsModule, TIER, 'role:coder:1', readyDetails({ op1: 'Implement the feature.' }))
		expect(result.sections.map((s) => s.label)).toEqual(['kind', 'task'])
		expect(defined(result.sections.find((s) => s.label === 'task'), 'task section').content).toBe('Implement the feature.')
	})

	test('a completed tool shows kind, status, and the result details', () => {
		const model = delegationModel()
		const result = deriveParticipantTooltip(model, labelsModule, TIER, 'tool:read_file:1', readyDetails({ op3: '```json\n{"path":"README.md"}\n```', op4: '```json\n{"content":"# Project"}\n```' }))
		expect(result.sections.map((s) => s.label)).toEqual(['kind', 'status', 'result'])
		expect(defined(result.sections.find((s) => s.label === 'kind'), 'kind section').content).toBe('tool')
		expect(defined(result.sections.find((s) => s.label === 'status'), 'status section').content).toBe('success')
		expect(defined(result.sections.find((s) => s.label === 'result'), 'result section').content).toBe('```json\n{"content":"# Project"}\n```')
	})

	test('an in-flight tool with no result yet shows the arguments details', () => {
		const model: InteractionModel = {
			participants: [participant('human:root', 'human', 'human'), participant('role:coder:1', 'coder', 'role'), participant('tool:read_file:1', 'read_file', 'tool')],
			operations: [
				callOperation('op1', 'human:root', 'role:coder:1'),
				callOperation('op2', 'role:coder:1', 'tool:read_file:1'),
			],
			status: 'running',
		}
		const result = deriveParticipantTooltip(model, labelsModule, TIER, 'tool:read_file:1', readyDetails({ op2: '```json\n{"path":"README.md"}\n```' }))
		expect(result.sections.map((s) => s.label)).toEqual(['kind', 'arguments'])
	})

	test('a return whose details failed or are absent falls back to the call task', () => {
		const model = delegationModel()
		const failedReturn = deriveParticipantTooltip(model, labelsModule, TIER, 'role:coder:1', readyDetails({ op2: 'Implement the feature.', op5: null }))
		expect(failedReturn.sections.map((s) => s.label)).toEqual(['kind', 'status', 'task'])
		expect(defined(failedReturn.sections.find((s) => s.label === 'task'), 'task section').content).toBe('Implement the feature.')
	})

	test('a human answerer shows the question (its incoming call), never the answer (its return)', () => {
		const answered = askHumanModel(true)
		const result = deriveParticipantTooltip(answered, labelsModule, TIER, 'human:answerer:1', readyDetails({ op2: 'Which testing framework should I use?\n\n*Context: vitest is already installed.*', op3: 'Use vitest.' }))
		const labels = result.sections.map((s) => s.label)
		// kind + status (the answered return) + question (the call details, not the answer).
		expect(labels).toEqual(['kind', 'status', 'question'])
		expect(defined(result.sections.find((s) => s.label === 'question'), 'question section').content).toBe('Which testing framework should I use?\n\n*Context: vitest is already installed.*')
	})

	test('a pending human answerer (no answer yet) shows kind and the question, no status', () => {
		const pending = askHumanModel(false)
		const result = deriveParticipantTooltip(pending, labelsModule, TIER, 'human:answerer:1', readyDetails({ op2: 'Which testing framework should I use?' }))
		expect(result.sections.map((s) => s.label)).toEqual(['kind', 'question'])
	})

	test('a loading return keeps the card on the return rather than flashing the request first', () => {
		const model = delegationModel()
		// The return (op5) is in flight in the lookup, the call (op2) failed: the preferred return
		// source renders its loading placeholder instead of falling back to the call.
		const loading = deriveParticipantTooltip(model, labelsModule, TIER, 'role:coder:1', (operationId: string): DetailsState => operationId === 'op5' ? { status: 'loading' } : { status: 'failed' })
		expect(loading.sections.map((s) => s.label)).toEqual(['kind', 'status', 'summary'])
		expect(defined(loading.sections.find((s) => s.label === 'summary'), 'summary section').content).toBe('loading details…')
	})

	test('an unknown participant id yields an empty title-only result', () => {
		const model = delegationModel()
		expect(deriveParticipantTooltip(model, labelsModule, TIER, 'nope', readyDetails({ op2: 'x' }))).toEqual({ title: '', sections: [] })
	})
})

describe('deriveRoleTooltip', () => {
	test('a role aggregates invocations, total time, total tokens across every instance, and surfaces an error', () => {
		// Two coder instances: the first errored, the second succeeded. The cumulative summary counts
		// both invocations, sums their time and tokens, and flags errored because one errored.
		const model: InteractionModel = {
			participants: [
				participant('human:root', 'human', 'human'),
				participant('role:orchestrator:1', 'orchestrator', 'role'),
				participant('role:coder:1', 'coder', 'role'),
				participant('role:coder:2', 'coder', 'role'),
			],
			operations: [
				callOperation('op1', 'human:root', 'role:orchestrator:1'),
				callOperation('op2', 'role:orchestrator:1', 'role:coder:1'),
				returnOperation('op3', 'role:coder:1', 'role:orchestrator:1', 'error', { tokens: 300, cachedPromptTokens: 0, elapsedSeconds: 4 }),
				callOperation('op4', 'role:orchestrator:1', 'role:coder:2'),
				returnOperation('op5', 'role:coder:2', 'role:orchestrator:1', 'success', { tokens: 900, cachedPromptTokens: 0, elapsedSeconds: 6 }),
				returnOperation('op6', 'role:orchestrator:1', 'human:root', 'success', { tokens: 1000, cachedPromptTokens: 0, elapsedSeconds: 12 }),
			],
			status: 'success',
		}
		const result = deriveRoleTooltip(model, labelsModule, TIER, 'coder')
		expect(result.sections.map((s) => s.label)).toEqual(['invocations', 'total time', 'total tokens', 'status'])
		expect(defined(result.sections.find((s) => s.label === 'invocations'), 'invocations section').content).toBe(2)
		expect(defined(result.sections.find((s) => s.label === 'total time'), 'total time section').content).toBe('10s')
		expect(defined(result.sections.find((s) => s.label === 'total tokens'), 'total tokens section').content).toBe(1200)
		expect(defined(result.sections.find((s) => s.label === 'status'), 'status section').content).toBe('errored')
	})

	test('a role still in flight (no completing returns) shows invocations only — no measured-zero time/tokens', () => {
		const model: InteractionModel = {
			participants: [participant('human:root', 'human', 'human'), participant('role:coder:1', 'coder', 'role')],
			operations: [callOperation('op1', 'human:root', 'role:coder:1')],
			status: 'running',
		}
		const result = deriveRoleTooltip(model, labelsModule, TIER, 'coder')
		expect(result.sections).toEqual([{ label: 'invocations', content: 1, scalar: true }])
	})

	test('a role whose invocations all succeeded omits the errored status', () => {
		const model = delegationModel()
		const result = deriveRoleTooltip(model, labelsModule, TIER, 'coder')
		expect(result.sections.map((s) => s.label)).toEqual(['invocations', 'total time', 'total tokens'])
		expect(defined(result.sections.find((s) => s.label === 'invocations'), 'invocations section').content).toBe(1)
	})

	test('an unknown role yields an empty title-only result', () => {
		const model = delegationModel()
		expect(deriveRoleTooltip(model, labelsModule, TIER, 'nope')).toEqual({ title: '', sections: [] })
	})
})
