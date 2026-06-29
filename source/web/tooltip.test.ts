import { describe, expect, test } from 'bun:test'
import { Tooltip, formatTooltipContent, deriveTooltipForNode, deriveTooltipForEdge, isTooltipSection } from './static/tooltip.js'

// The tooltip component is browser-pure JS, so its exports arrive with inferred JS types. The interfaces and fake `h`/`renderMarkdown` below carry the shape the tests assert against, mirroring result-modal.test.ts.

interface Vnode {
	tag: string
	props: Record<string, unknown>
	children: VnodeChild[]
}
type VnodeChild = Vnode | string

// A detail section as the derivations produce it: a machine label, the raw content (formatted by kind), and an optional `scalar` flag a derivation sets when the content should render as plain text rather than prose/JSON.
interface TooltipSection {
	label: string
	content: unknown
	scalar?: boolean
}

// The derivations' return shape, narrowed through an interface so the section-element type is concrete (the JS-inferred return widens the element to `any`, which would force `any` onto every callback parameter).
interface TooltipResult {
	title: string
	sections: TooltipSection[]
}

function fakeH(tag: string, props: Record<string, unknown>, children: unknown): Vnode {
	return { tag, props, children: normalizeChildren(children) }
}

// hyperapp flattens nested arrays and drops null/boolean children; the fake mirrors that so the component can pass loose children the same way it does against the real renderer.
function normalizeChildren(children: unknown): VnodeChild[] {
	const out: VnodeChild[] = []
	pushChildren(out, children)
	return out
}

function pushChildren(out: VnodeChild[], children: unknown): void {
	if (children === null || children === undefined || typeof children === 'boolean') return
	if (Array.isArray(children)) {
		for (const child of children) pushChildren(out, child)
		return
	}
	out.push(children as VnodeChild)
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
		const marker = byTag(vnode, 'span')[0]
		expect(marker).toBeDefined()
		expect(marker!.props['data-text']).toBe('added the export button')
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
		expect(textOf(heading!)).toBe('write_file')

		const blocks = byTag(card, 'div').filter((d) => d.props.class === 'tooltip-section')
		expect(blocks.length).toBe(4)
		// arguments → pretty JSON <pre>
		const argumentsBlock = blocks[0]!
		expect(byTag(argumentsBlock, 'span').find((s) => s.props.class === 'tooltip-label')!.children).toContain('arguments')
		expect(byTag(argumentsBlock, 'pre').find((p) => p.props.class === 'tooltip-json')).toBeDefined()
		// result → prose
		expect(byTag(blocks[1]!, 'div').find((d) => d.props.class === 'tooltip-prose markdown')).toBeDefined()
		// status → scalar text
		expect(byTag(blocks[2]!, 'span').find((s) => s.props.class === 'tooltip-scalar')).toBeDefined()
		// usage → pretty JSON
		expect(byTag(blocks[3]!, 'pre').find((p) => p.props.class === 'tooltip-json')).toBeDefined()
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
// The derivations are exercised against synthetic frames that mirror the fixture/runView shape (recentLog entries carry the paired detailSections `formatLogDetailSections` produces), so the tests pin the node/edge → sections mapping without depending on the fixture module.

function frameWith(runView: Record<string, unknown>): Record<string, unknown> {
	return { config: {}, runView, flowModel: { mainArea: { nodes: [], edges: [] }, topBar: { nodes: [] } } }
}

function logEntry(p: Record<string, unknown>): Record<string, unknown> {
	return { timestamp: p.timestamp ?? 't', type: p.type, summary: p.summary ?? '', payload: p.payload, detailSections: p.detailSections ?? null }
}

describe('deriveTooltipForNode', () => {
	test('a main-area role node carries status, current activity, and the role_finished detail', () => {
		const runView = {
			task: 'Fix the failing import.',
			currentActivity: { role: 'coder', summary: 'coder · write_file' },
			recentLog: [
				logEntry({ type: 'role_start', payload: { role: 'coder', task: 'second attempt' } }),
				logEntry({ type: 'tool_call', payload: { role: 'coder', tool: 'write_file' } }),
				logEntry({ type: 'role_finished', payload: { role: 'coder', status: 'error', summary: 'file not found', error: { kind: 'invalid_arguments', message: 'no such file' } }, detailSections: [{ label: 'summary', content: 'file not found' }, { label: 'error', content: { kind: 'invalid_arguments', message: 'no such file' } }] }),
			],
		}
		const node = { id: 'coder-1', kind: 'role', label: 'The builder', sublabel: 'coder', column: 2, status: 'error' }
		const result: TooltipResult = deriveTooltipForNode(node, frameWith(runView))
		expect(result.title).toBe('The builder')
		const labels = result.sections.map((s) => s.label)
		expect(labels).toEqual(['status', 'activity', 'summary', 'error'])
	})

	test('a main-area role node with no finish event omits the summary', () => {
		const runView = {
			currentActivity: { role: 'planner', summary: 'planner · llm call' },
			recentLog: [logEntry({ type: 'llm_call', payload: { role: 'planner' } })],
		}
		const node = { id: 'planner', kind: 'role', label: 'The planner', sublabel: 'planner', column: 1, active: true }
		const result: TooltipResult = deriveTooltipForNode(node, frameWith(runView))
		expect(result.sections.map((s) => s.label)).toEqual(['activity'])
	})

	test('a main-area tool node prefers the most recent tool_result and falls back to the tool_call', () => {
		const runView = {
			recentLog: [
				logEntry({ type: 'tool_call', payload: { role: 'coder', tool: 'write_file', arguments: '{"path":"README.md"}' }, detailSections: [{ label: 'arguments', content: '{"path":"README.md"}' }] }),
				logEntry({ type: 'tool_result', payload: { role: 'coder', tool: 'write_file', result: 'wrote README.md' }, detailSections: [{ label: 'result', content: 'wrote README.md' }] }),
			],
		}
		const node = { id: 'write_file', kind: 'tool', label: 'Save a file', column: 3, status: 'success' }
		const result: TooltipResult = deriveTooltipForNode(node, frameWith(runView))
		expect(result.sections.map((s) => s.label)).toEqual(['status', 'result'])

		// No result yet: the in-flight call's arguments surface instead.
		const inFlight = deriveTooltipForNode(node, frameWith({ recentLog: [runView.recentLog[0]] }))
		expect(inFlight.sections.map((s) => s.label)).toEqual(['status', 'arguments'])
	})

	test('the root You node carries the task as prose', () => {
		const runView = { task: 'Set up a CI workflow.' }
		const node = { id: 'you', kind: 'you', label: 'You', column: 0 }
		const result: TooltipResult = deriveTooltipForNode(node, frameWith(runView))
		expect(result.title).toBe('You')
		expect(result.sections).toEqual([{ label: 'task', content: 'Set up a CI workflow.' }])
	})

	test('a top-bar node carries its cumulative summary as scalars', () => {
		const node = { id: 'coder', kind: 'role', label: 'The builder', invocations: 2, totalTime: 11, totalTokens: 2820, status: 'success' }
		const result: TooltipResult = deriveTooltipForNode(node, frameWith({}))
		expect(result.sections.map((s) => s.label)).toEqual(['invocations', 'total time', 'total tokens', 'status'])
		expect(result.sections.find((s) => s.label === 'invocations')!.content).toBe(2)
		expect(result.sections.find((s) => s.label === 'total time')!.content).toBe('11s')
	})

	test('a malformed node or frame yields a minimal title-only result', () => {
		expect(deriveTooltipForNode(null, frameWith({}))).toEqual({ title: '', sections: [] })
		expect(deriveTooltipForNode({ id: 'x' }, null)).toEqual({ title: '', sections: [] })
	})
})

describe('deriveTooltipForEdge', () => {
	// A shared flowModel whose main-area nodes carry the labels and kinds the edge derivations look up.
	function frameWithFlow(runView: Record<string, unknown>, nodes: unknown[], edges: unknown[]): Record<string, unknown> {
		return { config: {}, runView, flowModel: { mainArea: { nodes, edges }, topBar: { nodes: [] } } }
	}

	const nodes = [
		{ id: 'you', kind: 'you', label: 'You', column: 0 },
		{ id: 'orchestrator', kind: 'role', label: 'The conductor', sublabel: 'orchestrator', column: 1 },
		{ id: 'coder', kind: 'role', label: 'The builder', sublabel: 'coder', column: 2 },
		{ id: 'write_file', kind: 'tool', label: 'Save a file', column: 3 },
		{ id: 'ask_human', kind: 'tool', label: 'Check with you', column: 2 },
		{ id: 'you-ask', kind: 'you', label: 'You', column: 3 },
	]

	test('a call edge to a tool surfaces the tool_call arguments detail', () => {
		const runView = {
			recentLog: [
				logEntry({ type: 'tool_call', payload: { role: 'coder', tool: 'write_file', arguments: '{"path":"calculator.js"}' }, detailSections: [{ label: 'arguments', content: '{"path":"calculator.js"}' }] }),
			],
		}
		const edge = { from: 'coder', to: 'write_file', kind: 'call' }
		const result: TooltipResult = deriveTooltipForEdge(edge, frameWithFlow(runView, nodes, [edge]))
		expect(result.title).toBe('The builder \u2192 Save a file')
		expect(result.sections.map((s) => s.label)).toEqual(['arguments'])
	})

	test('a return edge from a tool surfaces the tool_result detail', () => {
		const runView = {
			recentLog: [
				logEntry({ type: 'tool_result', payload: { role: 'coder', tool: 'write_file', result: 'wrote calculator.js' }, detailSections: [{ label: 'result', content: 'wrote calculator.js' }] }),
			],
		}
		const edge = { from: 'write_file', to: 'coder', kind: 'return' }
		const result: TooltipResult = deriveTooltipForEdge(edge, frameWithFlow(runView, nodes, [edge]))
		expect(result.title).toBe('Save a file \u2192 The builder')
		expect(result.sections.map((s) => s.label)).toEqual(['result'])
	})

	test('a return edge from a role surfaces the role_finished summary and error detail', () => {
		const runView = {
			recentLog: [
				logEntry({ type: 'role_finished', payload: { role: 'coder', status: 'error', summary: 'file not found', error: { kind: 'invalid_arguments', message: 'no such file' } }, detailSections: [{ label: 'summary', content: 'file not found' }, { label: 'error', content: { kind: 'invalid_arguments', message: 'no such file' } }] }),
			],
		}
		const edge = { from: 'coder', to: 'orchestrator', kind: 'return' }
		const result: TooltipResult = deriveTooltipForEdge(edge, frameWithFlow(runView, nodes, [edge]))
		expect(result.title).toBe('The builder \u2192 The conductor')
		expect(result.sections.map((s) => s.label)).toEqual(['summary', 'error'])
	})

	test('a question edge surfaces the ask_human question and context', () => {
		const runView = {
			recentLog: [
				logEntry({ type: 'ask_human', payload: { id: 'q1', question: 'Which CI provider?', context: '.github/workflows/' } }),
			],
		}
		const edge = { from: 'ask_human', to: 'you-ask', kind: 'question' }
		const result: TooltipResult = deriveTooltipForEdge(edge, frameWithFlow(runView, nodes, [edge]))
		expect(result.title).toBe('Check with you \u2192 You')
		expect(result.sections.map((s) => s.label)).toEqual(['question', 'context'])
	})

	test('a call edge to a role surfaces the child role_start task', () => {
		const runView = {
			recentLog: [
				logEntry({ type: 'role_start', payload: { role: 'coder', task: 'second attempt' } }),
			],
		}
		const edge = { from: 'orchestrator', to: 'coder', kind: 'call' }
		const result: TooltipResult = deriveTooltipForEdge(edge, frameWithFlow(runView, nodes, [edge]))
		expect(result.title).toBe('The conductor \u2192 The builder')
		expect(result.sections).toEqual([{ label: 'task', content: 'second attempt' }])
	})

	test('an edge with no matching log event yields a title-only card', () => {
		const edge = { from: 'orchestrator', to: 'coder', kind: 'call' }
		const result: TooltipResult = deriveTooltipForEdge(edge, frameWithFlow({ recentLog: [] }, nodes, [edge]))
		expect(result.title).toBe('The conductor \u2192 The builder')
		expect(result.sections).toEqual([])
	})

	test('an inspect edge yields a title-only card', () => {
		const edge = { from: 'recent_role_tool_calls', to: 'coder', kind: 'inspect' }
		const result: TooltipResult = deriveTooltipForEdge(edge, frameWithFlow({ recentLog: [] }, nodes, [edge]))
		expect(result.sections).toEqual([])
	})
})
