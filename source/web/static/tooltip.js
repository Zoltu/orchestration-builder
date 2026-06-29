// Tooltip component for the flow-graph run view: a friendly-formatted detail card that appears when an operator hovers a node or edge, and disappears when the pointer leaves it.
//
// Each section is a labeled block whose content is rendered by kind — pretty-printed JSON for object/array content (indented, no raw `\n` escapes), sanitized Markdown for prose content (assistant summaries, error messages, task text, question text), and plain text for scalars. The card is read-only (no buttons): the formatted view is for reading while the pointer rests on the node/edge. It is the reusable inspector the future sequence diagram also uses.
//
// The card is an HTML overlay (a positioned `<div>`), not the SVG `TooltipShell` primitive: SVG cannot host the sanitized-Markdown vnodes (HTML `<p>`/`<ul>`/… produced by the `markdown-render` pipeline) or a wrapping `<pre>`, so the tooltip follows the question/result modal pattern (an HTML card scoped to the run view) rather than the SVG shell. `TooltipShell` stays on disk for any future SVG-text-only tooltip; this card is what the flow view and the sequence diagram reuse. The card is `pointer-events: none` (see styles.css) so it never intercepts the pointer — the hover target stays the node/edge beneath it, so leaving that geometry is what dismisses the card (no flicker, no need for a hover-bridge). See docs/security.md "Web client rendering pipeline".
//
// `h` and `renderMarkdown` are passed in rather than imported so the component stays free of hyperapp and showdown coupling and is exercisable in tests with fakes (mirroring question-modal.js / result-modal.js).

// A labeled detail block, mirroring the `LogDetailSection` shape `formatLogDetailSections` (source/web/render.ts) produces: a machine label (`'arguments'`, `'result'`, `'summary'`, `'error'`, `'usage'`, …) and the raw content the tooltip then formats by kind.
export function isTooltipSection(value) {
	if (typeof value !== 'object' || value === null) return false
	if (typeof value.label !== 'string') return false
	return true
}

// Formats a single section's content into a vnode by its kind.
//
// A section explicitly marked `scalar: true` (a status word, an invocation count, a formatted time) renders as plain text — the plan's "plain text for scalars". Otherwise the kind is decided by the content's JS type: object/array content becomes a `<pre class="tooltip-json">` text node carrying `JSON.stringify(content, null, 2)`, so the JSON is indented and its newlines render as real line breaks (never literal `\n`). A string content is first probed as JSON: the executor stores tool `arguments` as a JSON string, so a string that parses to an object/array is pretty-printed as JSON (this is how `{"path":"…"}` becomes legible); any other string is agent prose and flows through the sanitized Markdown pipeline. Numbers and booleans are plain scalar text. Null/undefined yields the em-dash placeholder the rest of the UI uses, so an absent field stays readable instead of blank.
//
// Every path keeps untrusted content as a text node or sanitized vnodes, never markup: the JSON branch is a `<pre>` text child, the prose branch is the caller's `renderMarkdown` (already sanitized), and the scalar branch is a `<span>` text child.
export function formatTooltipContent(h, renderMarkdown, content, scalar) {
	if (scalar === true) {
		return h('span', { class: 'tooltip-scalar' }, [content === null || content === undefined ? '\u2014' : String(content)])
	}
	if (content === null || content === undefined) {
		return h('span', { class: 'tooltip-scalar' }, ['\u2014'])
	}
	if (typeof content === 'object') {
		return h('pre', { class: 'tooltip-json' }, [toJsonText(content)])
	}
	if (typeof content === 'string') {
		const parsed = tryParseJsonObject(content)
		if (parsed !== undefined) return h('pre', { class: 'tooltip-json' }, [toJsonText(parsed)])
		return h('div', { class: 'tooltip-prose markdown' }, renderMarkdown(content))
	}
	// number or boolean
	return h('span', { class: 'tooltip-scalar' }, [String(content)])
}

// Pretty-prints a value as JSON, falling back to its String form when it is not serializable so the `<pre>` never throws on a cyclical or otherwise non-serializable object.
function toJsonText(value) {
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}

// Returns the parsed value when the string parses to a plain object or array (the shapes worth pretty-printing), or undefined for a non-JSON string, a scalar, or a parse failure. A string that parses to a number/boolean is not "pretty-printable JSON" and is treated as prose, so a result string like `'42'` still reads as text rather than a bare number.
function tryParseJsonObject(text) {
	let value
	try {
		value = JSON.parse(text)
	} catch {
		return undefined
	}
	if (typeof value !== 'object' || value === null) return undefined
	return value
}

// The tooltip card: a heading and one labeled block per section. `style` carries the caller-chosen positioning (left/top or right/bottom near a viewport edge) applied inline so the card can be placed at the pointer without a layout pass. The card carries no interactive chrome: it is a read-only hover inspector, so there is no close button and no copy-raw — the pointer leaving the hovered node/edge dismisses it (the card is `pointer-events: none`, so it never becomes the hover target itself).
export function Tooltip(h, props) {
	const title = props.title
	const sections = Array.isArray(props.sections) ? props.sections.filter(isTooltipSection) : []
	const renderMarkdown = props.renderMarkdown
	const style = props.style

	const children = [h('p', { class: 'tooltip-heading' }, [title])]

	for (const section of sections) {
		children.push(h('div', { class: 'tooltip-section' }, [
			h('span', { class: 'tooltip-label' }, [section.label]),
			formatTooltipContent(h, renderMarkdown, section.content, section.scalar === true),
		]))
	}

	return h('div', { class: 'tooltip-card', style }, children)
}

// --- Section derivation -----------------------------------------------------
// Pure mappings from a flow node or edge plus the current frame (`{ config, runView, flowModel }`) to the `{ title, sections }` a tooltip renders. The frame's `runView.recentLog` already carries each event's paired `detailSections` (the shaping `formatLogDetailSections` produces), so the derivations locate the matching log entry and reuse its sections rather than re-deriving from the payload. Returning `{ title, sections: [] }` (rather than null) lets the wiring always open a card with at least a title.

function isObject(value) {
	return typeof value === 'object' && value !== null
}

function bareRoleName(node) {
	if (typeof node?.sublabel === 'string' && node.sublabel !== '') return node.sublabel
	if (typeof node?.id === 'string') return node.id
	return ''
}

function nodeById(flowModel) {
	const map = {}
	if (!isObject(flowModel)) return map
	const mainArea = flowModel.mainArea
	if (!isObject(mainArea) || !Array.isArray(mainArea.nodes)) return map
	for (const node of mainArea.nodes) {
		if (isObject(node) && typeof node.id === 'string') map[node.id] = node
	}
	return map
}

// The last recentLog entry satisfying a predicate, or undefined. The log is append-only and ordered oldest→newest, so the last match is the most recent — the one the active flow reflects.
function findLastRecentEntry(runView, predicate) {
	if (!isObject(runView) || !Array.isArray(runView.recentLog)) return undefined
	for (let i = runView.recentLog.length - 1; i >= 0; i--) {
		const entry = runView.recentLog[i]
		if (isObject(entry) && predicate(entry)) return entry
	}
	return undefined
}

function sectionsOf(entry) {
	if (!isObject(entry)) return null
	if (Array.isArray(entry.detailSections) && entry.detailSections.length > 0) return entry.detailSections
	return null
}

function payloadOf(entry) {
	if (!isObject(entry)) return null
	return isObject(entry.payload) ? entry.payload : null
}

function scalarSection(label, content) {
	return { label, content, scalar: true }
}

// Derives the tooltip content for a flow node. A main-area node (carries `column`) gets per-invocation detail — a role's status + current activity + finish summary, a tool's most recent call/result detail, the root You's task. A top-bar node (carries `invocations`) gets its cumulative summary — invocation count, total time, total tokens, terminal status.
export function deriveTooltipForNode(node, frame) {
	if (!isObject(node) || !isObject(frame)) return { title: '', sections: [] }
	const runView = isObject(frame.runView) ? frame.runView : {}
	const flowModel = isObject(frame.flowModel) ? frame.flowModel : {}
	const label = typeof node.label === 'string' && node.label !== '' ? node.label : (typeof node.id === 'string' ? node.id : '')

	if (node.invocations !== undefined) {
		return deriveTopBarNode(node, label)
	}

	// Main-area node.
	if (node.kind === 'you') {
		const task = typeof runView.task === 'string' ? runView.task : null
		const sections = task !== null ? [{ label: 'task', content: task }] : []
		return { title: label, sections }
	}

	if (node.kind === 'role') {
		return deriveRoleNode(node, label, runView)
	}

	if (node.kind === 'tool') {
		return deriveToolNode(node, label, runView, flowModel)
	}

	return { title: label, sections: [] }
}

function deriveTopBarNode(node, label) {
	const sections = []
	sections.push(scalarSection('invocations', node.invocations))
	if (node.totalTime !== undefined) sections.push(scalarSection('total time', `${node.totalTime}s`))
	if (node.totalTokens !== undefined) sections.push(scalarSection('total tokens', node.totalTokens))
	if (typeof node.status === 'string') sections.push(scalarSection('status', node.status))
	return { title: label, sections }
}

function deriveRoleNode(node, label, runView) {
	const sections = []
	const role = bareRoleName(node)
	if (typeof node.status === 'string') sections.push(scalarSection('status', node.status))
	const activity = isObject(runView.currentActivity) && runView.currentActivity.role === role && typeof runView.currentActivity.summary === 'string'
		? runView.currentActivity.summary
		: null
	if (activity !== null) sections.push({ label: 'activity', content: activity })
	const finished = findLastRecentEntry(runView, (entry) => entry.type === 'role_finished' && payloadOf(entry)?.role === role)
	if (finished !== undefined) {
		const detail = sectionsOf(finished)
		if (detail !== null) {
			for (const section of detail) sections.push(section)
		}
	}
	return { title: label, sections }
}

function deriveToolNode(node, label, runView, flowModel) {
	const tool = typeof node.id === 'string' ? node.id : ''
	const sections = []
	if (typeof node.status === 'string') sections.push(scalarSection('status', node.status))
	// A tool node in the main area is either in flight (a call edge points at it) or lingering on its result (a return edge leaves it). Prefer the most recent result, then the most recent call, so the card shows the outcome when one has arrived and the in-flight arguments otherwise.
	const result = findLastRecentEntry(runView, (entry) => entry.type === 'tool_result' && payloadOf(entry)?.tool === tool)
	const call = findLastRecentEntry(runView, (entry) => entry.type === 'tool_call' && payloadOf(entry)?.tool === tool)
	const source = result !== undefined ? result : call
	if (source !== undefined) {
		const detail = sectionsOf(source)
		if (detail !== null) {
			for (const section of detail) sections.push(section)
		}
	}
	return { title: label, sections }
}

// Derives the tooltip content for a flow edge by mapping its kind to the matching log event: a call to a tool → the tool_call arguments; a return from a tool → the tool_result; a return from a role → the role_finished summary/error; a question → the ask_human question + context; a call to a role → the child's role_start task. Inspect edges carry no in-flight detail and yield a title-only card.
export function deriveTooltipForEdge(edge, frame) {
	if (!isObject(edge) || !isObject(frame)) return { title: '', sections: [] }
	const runView = isObject(frame.runView) ? frame.runView : {}
	const flowModel = isObject(frame.flowModel) ? frame.flowModel : {}
	const byId = nodeById(flowModel)
	const fromNode = byId[edge.from]
	const toNode = byId[edge.to]
	const fromLabel = typeof fromNode?.label === 'string' ? fromNode.label : edge.from
	const toLabel = typeof toNode?.label === 'string' ? toNode.label : edge.to

	if (edge.kind === 'question') {
		const asked = findLastRecentEntry(runView, (entry) => entry.type === 'ask_human')
		const sections = []
		if (asked !== undefined) {
			const payload = payloadOf(asked) ?? {}
			if (typeof payload.question === 'string') sections.push({ label: 'question', content: payload.question })
			if (typeof payload.context === 'string') sections.push({ label: 'context', content: payload.context })
		}
		return { title: `${fromLabel} \u2192 ${toLabel}`, sections }
	}

	if (edge.kind === 'return') {
		// A return edge leaves a node that has finished. A tool return carries the tool_result; a role return carries the role_finished summary/error.
		if (fromNode?.kind === 'tool') {
			const tool = typeof fromNode.id === 'string' ? fromNode.id : ''
			const result = findLastRecentEntry(runView, (entry) => entry.type === 'tool_result' && payloadOf(entry)?.tool === tool)
			return edgeSectionsFromEntry(result, `${fromLabel} \u2192 ${toLabel}`)
		}
		const role = bareRoleName(fromNode)
		const finished = findLastRecentEntry(runView, (entry) => entry.type === 'role_finished' && payloadOf(entry)?.role === role)
		return edgeSectionsFromEntry(finished, `${fromLabel} \u2192 ${toLabel}`)
	}

	if (edge.kind === 'call') {
		// A call edge points at a tool (in-flight tool_call arguments) or a role/you (the delegation's role_start task).
		if (toNode?.kind === 'tool') {
			const tool = typeof toNode.id === 'string' ? toNode.id : ''
			const call = findLastRecentEntry(runView, (entry) => entry.type === 'tool_call' && payloadOf(entry)?.tool === tool)
			return edgeSectionsFromEntry(call, `${fromLabel} \u2192 ${toLabel}`)
		}
		const role = bareRoleName(toNode)
		const start = findLastRecentEntry(runView, (entry) => entry.type === 'role_start' && payloadOf(entry)?.role === role)
		const sections = []
		if (start !== undefined) {
			const payload = payloadOf(start) ?? {}
			if (typeof payload.task === 'string') sections.push({ label: 'task', content: payload.task })
		}
		return { title: `${fromLabel} \u2192 ${toLabel}`, sections }
	}

	// inspect, or an unknown kind: no in-flight detail to show.
	return { title: `${fromLabel} \u2192 ${toLabel}`, sections: [] }
}

function edgeSectionsFromEntry(entry, title) {
	if (entry === undefined) return { title, sections: [] }
	const detail = sectionsOf(entry)
	const sections = detail !== null ? detail : []
	return { title, sections }
}
