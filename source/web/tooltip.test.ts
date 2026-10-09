import { describe, expect, test } from 'bun:test'
import type { LogEvent } from '../executor/types.js'
import { Tooltip, formatTooltipContent, deriveOperationTooltip, deriveParticipantTooltip, deriveRoleTooltip, isTooltipSection } from './static/ts/tooltip.js'
import { stacksOf } from './static/ts/interaction-model.js'
import { labelsModule } from './label-resolver-fixture.js'
import { deriveInteractionModel } from './interaction-model-adapter.js'
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

function callOperation(id: string, source: string, destination: string, metrics: Operation['metrics'] = null): Operation {
	return { id, kind: 'call', stack: 'root', source, destination, startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics }
}

function returnOperation(id: string, source: string, destination: string, outcome: Operation['outcome'], metrics: Operation['metrics']): Operation {
	return { id, kind: 'return', stack: 'root', source, destination, startedAt: 't0', settledAt: null, lifecycle: 'settled', outcome, metrics }
}

// Call metrics in the adapter's wire shape: the reported counters plus the elapsed span. The cached count is a subset of the prompt bill, and lastPromptTokens mirrors the single-turn fold these fixtures represent (the last turn's prompt size).
function callMetrics(tokens: number, promptTokens: number, completionTokens: number, cachedPromptTokens: number, elapsedSeconds: number): Operation['metrics'] {
	return { tokens, promptTokens, completionTokens, cachedPromptTokens, lastPromptTokens: promptTokens, elapsedSeconds }
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
// Metrics ride the call operations only (the adapter's contract): each instance's incoming call
// carries that instance's own spend.
function delegationModel(): InteractionModel {
	return {
		participants: [
			participant('human:root', 'human', 'human'),
			participant('role:orchestrator:1', 'orchestrator', 'role'),
			participant('role:coder:1', 'coder', 'role'),
			participant('tool:read_file:1', 'read_file', 'tool'),
		],
		operations: [
			callOperation('op1', 'human:root', 'role:orchestrator:1', callMetrics(1500, 1300, 200, 0, 15)),
			callOperation('op2', 'role:orchestrator:1', 'role:coder:1', callMetrics(800, 700, 100, 0, 9)),
			callOperation('op3', 'role:coder:1', 'tool:read_file:1', callMetrics(120, 100, 20, 0, 1)),
			returnOperation('op4', 'tool:read_file:1', 'role:coder:1', 'success', null),
			returnOperation('op5', 'role:coder:1', 'role:orchestrator:1', 'success', null),
			returnOperation('op6', 'role:orchestrator:1', 'human:root', 'success', null),
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
	const participantsById = new Map<string, Participant>()
	for (const participant of model.participants) participantsById.set(participant.id, participant)
	return labelsModule.resolveOperationLabel(operation, participantsById, TIER, labelsModule.hashString(operation.id))
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
	test('a completed role shows kind, status, the token breakdown, and the finish summary (return details preferred over the call task)', () => {
		const model = delegationModel()
		const result = deriveParticipantTooltip(model, labelsModule, TIER, 'role:coder:1', readyDetails({ op2: 'Implement the feature.', op5: 'Done implementing.' }))
		const labels = result.sections.map((s) => s.label)
		// The tokens section sits above the task/details section (the operator's placement rule), in the format the role aggregate card uses.
		expect(labels).toEqual(['kind', 'status', 'tokens', 'summary'])
		expect(defined(result.sections.find((s) => s.label === 'kind'), 'kind section').content).toBe('role')
		expect(defined(result.sections.find((s) => s.label === 'status'), 'status section').content).toBe('success')
		expect(defined(result.sections.find((s) => s.label === 'tokens'), 'tokens section').content).toBe('800 \u00b7 input 700 \u00b7 output 100')
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

	test('a completed tool shows kind, status, the token breakdown, and the result details', () => {
		const model = delegationModel()
		const result = deriveParticipantTooltip(model, labelsModule, TIER, 'tool:read_file:1', readyDetails({ op3: '```json\n{"path":"README.md"}\n```', op4: '```json\n{"content":"# Project"}\n```' }))
		expect(result.sections.map((s) => s.label)).toEqual(['kind', 'status', 'tokens', 'result'])
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
		expect(failedReturn.sections.map((s) => s.label)).toEqual(['kind', 'status', 'tokens', 'task'])
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
		expect(loading.sections.map((s) => s.label)).toEqual(['kind', 'status', 'tokens', 'summary'])
		expect(defined(loading.sections.find((s) => s.label === 'summary'), 'summary section').content).toBe('loading details…')
	})

	test('the tokens section formats the k-abbreviated total with the cached subset nested in the input', () => {
		// The operator's example shape, through the same shared formatter the role aggregate card uses: total 1200 → 1.2k, input 1100 → 1.1k with the cached 200 nested, output 120 plain.
		const model: InteractionModel = {
			participants: [participant('human:root', 'human', 'human'), participant('role:coder:1', 'coder', 'role')],
			operations: [callOperation('op1', 'human:root', 'role:coder:1', callMetrics(1200, 1100, 120, 200, 9))],
			status: 'running',
		}
		const result = deriveParticipantTooltip(model, labelsModule, TIER, 'role:coder:1')
		expect(result.sections.map((s) => s.label)).toEqual(['kind', 'tokens'])
		expect(defined(result.sections.find((s) => s.label === 'tokens'), 'tokens section').content).toBe('1.2k \u00b7 input 1.1k (cached 200) \u00b7 output 120')
	})

	test('a participant whose calls reported no usage carries no tokens section — no fabricated zero, in no position', () => {
		// The usage-silent agent call: its metrics exist (elapsed is measured) but every token counter is null, so the card skips the section.
		const silent: InteractionModel = {
			participants: [participant('human:root', 'human', 'human'), participant('role:coder:1', 'coder', 'role')],
			operations: [callOperation('op1', 'human:root', 'role:coder:1', { tokens: null, promptTokens: null, completionTokens: null, cachedPromptTokens: null, lastPromptTokens: null, elapsedSeconds: 11 })],
			status: 'running',
		}
		expect(deriveParticipantTooltip(silent, labelsModule, TIER, 'role:coder:1').sections.map((s) => s.label)).toEqual(['kind'])
		// A participant with no incoming call at all (the run's root human) has no metrics entry either.
		const model = delegationModel()
		expect(deriveParticipantTooltip(model, labelsModule, TIER, 'human:root').sections.map((s) => s.label)).toEqual(['kind'])
	})

	test('an unknown participant id yields an empty title-only result', () => {
		const model = delegationModel()
		expect(deriveParticipantTooltip(model, labelsModule, TIER, 'nope', readyDetails({ op2: 'x' }))).toEqual({ title: '', sections: [] })
	})
})

describe('deriveRoleTooltip', () => {
	test('a role aggregates invocations, the error count, total time, and the token split across every instance', () => {
		// Two coder instances: the first errored, the second succeeded. The cumulative summary counts
		// both invocations, counts the one errored completion, and sums their time and token counters.
		// The metrics ride each instance's incoming call (the adapter's contract), and the second
		// instance's call reports a cached share — a subset of its prompt bill.
		const model: InteractionModel = {
			participants: [
				participant('human:root', 'human', 'human'),
				participant('role:orchestrator:1', 'orchestrator', 'role'),
				participant('role:coder:1', 'coder', 'role'),
				participant('role:coder:2', 'coder', 'role'),
			],
			operations: [
				callOperation('op1', 'human:root', 'role:orchestrator:1', callMetrics(1000, 900, 100, 0, 12)),
				callOperation('op2', 'role:orchestrator:1', 'role:coder:1', callMetrics(300, 280, 20, 200, 4)),
				returnOperation('op3', 'role:coder:1', 'role:orchestrator:1', 'error', null),
				callOperation('op4', 'role:orchestrator:1', 'role:coder:2', callMetrics(900, 800, 100, 0, 6)),
				returnOperation('op5', 'role:coder:2', 'role:orchestrator:1', 'success', null),
				returnOperation('op6', 'role:orchestrator:1', 'human:root', 'success', null),
			],
			status: 'success',
		}
		const result = deriveRoleTooltip(model, labelsModule, TIER, 'coder')
		// The errors row sits directly beneath invocations — a rate over the same denominator.
		expect(result.sections.map((s) => s.label)).toEqual(['invocations', 'errors', 'total time', 'total tokens'])
		expect(defined(result.sections.find((s) => s.label === 'invocations'), 'invocations section').content).toBe(2)
		expect(defined(result.sections.find((s) => s.label === 'errors'), 'errors section').content).toBe('1 of 2 (50%)')
		expect(defined(result.sections.find((s) => s.label === 'total time'), 'total time section').content).toBe('10s')
		// 1200 total = 300 + 900; the cached 200 rides inside the input figure as a subset, never as an additive bucket.
		expect(defined(result.sections.find((s) => s.label === 'total tokens'), 'total tokens section').content).toBe('1.2k \u00b7 input 1.1k (cached 200) \u00b7 output 120')
	})

	test('a role whose invocations all errored counts every one (100%)', () => {
		const model: InteractionModel = {
			participants: [
				participant('human:root', 'human', 'human'),
				participant('role:coder:1', 'coder', 'role'),
				participant('role:coder:2', 'coder', 'role'),
			],
			operations: [
				callOperation('op1', 'human:root', 'role:coder:1'),
				returnOperation('op2', 'role:coder:1', 'human:root', 'error', null),
				callOperation('op3', 'human:root', 'role:coder:2'),
				returnOperation('op4', 'role:coder:2', 'human:root', 'error', null),
			],
			status: 'error',
		}
		const result = deriveRoleTooltip(model, labelsModule, TIER, 'coder')
		expect(defined(result.sections.find((s) => s.label === 'errors'), 'errors section').content).toBe('2 of 2 (100%)')
	})

	test('the error count reads the completion returns alone — metrics presence is irrelevant, and the percentage rounds to an integer', () => {
		// Three coder instances, none carrying call metrics at all: the two errored completions still count, and 2/3 renders as the rounded integer 67%, never a decimal rate.
		const model: InteractionModel = {
			participants: [
				participant('human:root', 'human', 'human'),
				participant('role:coder:1', 'coder', 'role'),
				participant('role:coder:2', 'coder', 'role'),
				participant('role:coder:3', 'coder', 'role'),
			],
			operations: [
				callOperation('op1', 'human:root', 'role:coder:1'),
				returnOperation('op2', 'role:coder:1', 'human:root', 'error', null),
				callOperation('op3', 'human:root', 'role:coder:2'),
				returnOperation('op4', 'role:coder:2', 'human:root', 'success', null),
				callOperation('op5', 'human:root', 'role:coder:3'),
				returnOperation('op6', 'role:coder:3', 'human:root', 'error', null),
			],
			status: 'error',
		}
		const result = deriveRoleTooltip(model, labelsModule, TIER, 'coder')
		expect(defined(result.sections.find((s) => s.label === 'errors'), 'errors section').content).toBe('2 of 3 (67%)')
	})

	test('a role whose instances never served from cache omits the cached note from the token split', () => {
		const model = delegationModel()
		const result = deriveRoleTooltip(model, labelsModule, TIER, 'coder')
		expect(defined(result.sections.find((s) => s.label === 'total tokens'), 'total tokens section').content).toBe('800 \u00b7 input 700 \u00b7 output 100')
	})

	test('a measured-zero token total carries no split (no zero buckets)', () => {
		const model: InteractionModel = {
			participants: [participant('human:root', 'human', 'human'), participant('tool:read_file:1', 'read_file', 'tool')],
			operations: [callOperation('op1', 'human:root', 'tool:read_file:1', callMetrics(0, 0, 0, 0, 3))],
			status: 'running',
		}
		const result = deriveRoleTooltip(model, labelsModule, TIER, 'read_file')
		expect(defined(result.sections.find((s) => s.label === 'total time'), 'total time section').content).toBe('3s')
		expect(defined(result.sections.find((s) => s.label === 'total tokens'), 'total tokens section').content).toBe('0')
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

	test('a role whose invocations all succeeded omits the errors section', () => {
		const model = delegationModel()
		const result = deriveRoleTooltip(model, labelsModule, TIER, 'coder')
		expect(result.sections.map((s) => s.label)).toEqual(['invocations', 'total time', 'total tokens'])
		expect(defined(result.sections.find((s) => s.label === 'invocations'), 'invocations section').content).toBe(1)
	})

	test('a duplicate return from one source never rewrites the completion outcome (first return wins)', () => {
		// The adapter emits one completion return per instance, so a second return from the same
		// source only arises in hand-authored models; the count must still stay stable rather than
		// let a later return flip an already-decided outcome.
		const model: InteractionModel = {
			participants: [participant('human:root', 'human', 'human'), participant('role:coder:1', 'coder', 'role')],
			operations: [
				callOperation('op1', 'human:root', 'role:coder:1'),
				returnOperation('op2', 'role:coder:1', 'human:root', 'success', null),
				returnOperation('op3', 'role:coder:1', 'human:root', 'error', null),
			],
			status: 'running',
		}
		const result = deriveRoleTooltip(model, labelsModule, TIER, 'coder')
		expect(result.sections.find((s) => s.label === 'errors')).toBeUndefined()
	})

	test('an unknown role yields an empty title-only result', () => {
		const model = delegationModel()
		expect(deriveRoleTooltip(model, labelsModule, TIER, 'nope')).toEqual({ title: '', sections: [] })
	})
})

// The metrics seam: the real adapter attaches per-invocation metrics to call operations only, so
// the role tooltip must aggregate calls by destination. Building the model through the real
// deriveInteractionModel — not hand-authored operations whose metric placement is whatever the
// fixture authored — is what pins that seam: fixtures that placed metrics on returns once hid the
// dead token displays this guards against.
describe('deriveRoleTooltip over the real adapter — the call-metrics seam', () => {
	function logEvent(offsetSeconds: number, type: string, payload: unknown): LogEvent {
		return { timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, offsetSeconds)).toISOString(), type, payload }
	}

	test('a model derived through the real adapter aggregates tokens, the cached subset, and retry spend into the role tooltip', () => {
		const events = [
			logEvent(0, 'role_start', { role: 'coder', depth: 0, task: 'work' }),
			// The discarded retry attempt's spend is real spend and must land in the aggregate alongside the final attempt's llm_call usage.
			logEvent(1, 'llm_retry', { role: 'coder', roleId: 'coder-0-1', discardedAttempts: 1, usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 } }),
			logEvent(2, 'llm_call', { role: 'coder', usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedPromptTokens: 40 } }),
			logEvent(6, 'role_finished', { role: 'coder', depth: 0, status: 'success' }),
		]
		const model = deriveInteractionModel({ meta: { runId: 'seam', guildPath: 'g', benchmarkPath: 'b', task: 'work', status: 'success', startTime: events[0]?.timestamp ?? '' }, logEvents: events }, '2026-01-01T00:01:00.000Z')
		const result = deriveRoleTooltip(model, labelsModule, TIER, 'coder')
		expect(result.sections.map((s) => s.label)).toEqual(['invocations', 'total time', 'total tokens'])
		// 180 total = the retry's 60 + the call's 120; the cached 40 rides inside the input figure.
		expect(defined(result.sections.find((s) => s.label === 'total tokens'), 'total tokens section').content).toBe('180 \u00b7 input 150 (cached 40) \u00b7 output 30')
	})
})
