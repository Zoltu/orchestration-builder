// Tooltip component for the flow-graph run view: a friendly-formatted detail card that appears when an operator hovers a node or edge, and disappears when the pointer leaves it.
//
// Each section is a labeled block whose content is rendered by kind — pretty-printed JSON for object/array content (indented, no raw `\n` escapes), sanitized Markdown for prose content (assistant summaries, error messages, task text, question text), and plain text for scalars. The card is read-only (no buttons): the formatted view is for reading while the pointer rests on the node/edge. It is the reusable inspector the future sequence diagram also uses.
//
// The card is an HTML overlay (a positioned `<div>`), not the SVG `TooltipShell` primitive: SVG cannot host the sanitized-Markdown vnodes (HTML `<p>`/`<ul>`/… produced by the `markdown-render` pipeline) or a wrapping `<pre>`, so the tooltip follows the question/result modal pattern (an HTML card scoped to the run view) rather than the SVG shell. `TooltipShell` stays on disk for any future SVG-text-only tooltip; this card is what the flow view and the sequence diagram reuse. The card is `pointer-events: auto` with `user-select: text` (styles.css) so the operator can move the pointer from the hovered node into the card to select and copy its contents; the wiring in `app.js` / `demo.js` keeps it open while the pointer is over the node or the card and dismisses it — after a short grace timer — once the pointer is over neither. See docs/security.md "Web client rendering pipeline".
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
// A section explicitly marked `scalar: true` (a status word, an invocation count, a formatted time) renders as plain text. Otherwise the kind is decided by the content's JS type: object/array content becomes a `<pre class="tooltip-json">` text node carrying `JSON.stringify(content, null, 2)`, so the JSON is indented and its newlines render as real line breaks (never literal `\n`). A string content is first probed as JSON: the executor stores tool `arguments` as a JSON string, so a string that parses to an object/array is pretty-printed as JSON (this is how `{"path":"…"}` becomes legible); any other string is agent prose and flows through the sanitized Markdown pipeline. Numbers and booleans are plain scalar text. Null/undefined yields the em-dash placeholder the rest of the UI uses, so an absent field stays readable instead of blank.
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

// The tooltip card: a heading and one labeled block per section. `style` carries the caller-chosen positioning (left/top or right/bottom near a viewport edge) applied inline so the card can be placed against the hovered node without a layout pass. The card carries no interactive chrome: it is a read-only hover inspector with no close button and no copy-raw button. Dismissal is the wiring's concern, not the component's — the card is `pointer-events: auto` with `user-select: text` (styles.css) so the operator can move the pointer into it to select text, and the wiring in `app.js` / `demo.js` dismisses it (after a short grace timer) once the pointer is over neither the node/edge nor the card.
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

// --- Inline positioning ----------------------------------------------------
// Anchors the card to the hovered node/edge's bounding rect so the card sits at a fixed position
// relative to the node (not the pointer): flush against the node's right edge by default, flipping
// to anchor its left edge when the node is near the right viewport margin, and the same vertically
// (below by default, flipping above near the bottom margin). Flush placement means the pointer can
// travel directly from the node into the card without crossing empty space, so the card stays open
// while the operator moves into it to select or copy text (the card is `pointer-events: auto`).
// Shared by the product client (`app.js`) and the dev harness (`demo.js`) so the two surfaces place
// the card identically. `rect` is a DOMRect (or a plain `{ left, top, right, bottom }` snapshot).
export function tooltipStyle(rect) {
	const viewportWidth = window.innerWidth
	const viewportHeight = window.innerHeight
	const margin = 8
	const estimatedWidth = 380
	const estimatedHeight = 280
	const style = {}
	if (rect.right + estimatedWidth + margin > viewportWidth) {
		style.right = `${Math.max(margin, viewportWidth - rect.left)}px`
	} else {
		style.left = `${rect.right}px`
	}
	if (rect.bottom + estimatedHeight + margin > viewportHeight) {
		style.bottom = `${Math.max(margin, viewportHeight - rect.top)}px`
	} else {
		style.top = `${rect.bottom}px`
	}
	return style
}

// --- Section derivation -----------------------------------------------------
// Pure mappings from a hovered element's identifier (an operation id, a participant id, or a role
// name) plus the live InteractionModel and the label resolver to the `{ title, sections }` a
// tooltip renders. The derivations read the same model the flow and sequence views render, so the
// inspector never drifts from the graph and never invents content the model does not carry: the
// title is a resolved label (a `textContent`-bound string the card places as a heading), and the
// only prose a section carries is an operation's `details` markdown, which `formatTooltipContent`
// routes through the sanitized Markdown pipeline. Counts, statuses, and timings are scalars. A
// derivation returns `{ title: '', sections: [] }` when its id does not resolve, which the wiring
// treats as "no card" so a stale hover state (e.g. an operation id from a frame the poll has since
// replaced) dismisses rather than rendering a heading-less card.

function isObject(value) {
	return typeof value === 'object' && value !== null
}

function scalarSection(label, content) {
	return { label, content, scalar: true }
}

// The operation's `details` markdown when it is a non-empty string, else null. `null` means "no
// details section" — an operation whose adapter produced no markdown (e.g. a call whose task text
// was absent) yields a title-only card rather than a section with an em-dash placeholder.
function detailsOf(operation) {
	if (!isObject(operation)) return null
	if (typeof operation.details !== 'string' || operation.details === '') return null
	return operation.details
}

function findOperation(model, operationId) {
	for (const operation of model.operations) {
		if (operation.id === operationId) return operation
	}
	return undefined
}

function findParticipant(model, participantId) {
	for (const participant of model.participants) {
		if (participant.id === participantId) return participant
	}
	return undefined
}

// The most recent call whose destination is the participant — the request that brought the
// participant into the active path (a role delegation, a tool invocation, or an ask_human question).
function findLastCallTo(model, participantId) {
	for (let index = model.operations.length - 1; index >= 0; index -= 1) {
		const operation = model.operations[index]
		if (operation.kind === 'call' && operation.destination === participantId) return operation
	}
	return undefined
}

// The return whose source is the participant — the participant's completing return, carrying its
// outcome and result/summary markdown. A participant with no completing return is still in flight.
function findReturnFrom(model, participantId) {
	for (const operation of model.operations) {
		if (operation.kind === 'return' && operation.source === participantId) return operation
	}
	return undefined
}

// Edge (flow or sequence, by `data-operation`): the operation's resolved label as the title and a
// single `details` section carrying the operation's adapter-formatted markdown — the delegation
// task text for a role call, the pretty-printed arguments/result for a tool, the question (and
// context) for an ask_human call, the summary for a return. This generalizes the dev harness's
// `openOperationTooltip` path so the product client and the harness consume one derivation.
export function deriveOperationTooltip(model, labels, tier, operationId) {
	if (!isObject(model) || typeof operationId !== 'string') return { title: '', sections: [] }
	const operation = findOperation(model, operationId)
	if (operation === undefined) return { title: '', sections: [] }
	const title = labels.resolveOperationLabel(operation, model.participants, tier, labels.hashString(operation.id))
	const details = detailsOf(operation)
	const sections = details !== null ? [{ label: 'details', content: details }] : []
	return { title, sections }
}

// The label for the single details section a participant card carries. A human answerer's relevant
// detail is the question (its incoming call); a role's is its delegation task (call) or finish
// summary (return); a tool's is its arguments (call) or result (return). The label reflects which
// operation the shown details came from so the card reads accurately in both the in-flight and the
// completed phases.
function detailsLabelFor(participant, usedReturn) {
	if (participant.kind === 'human') return 'question'
	if (participant.kind === 'tool') return usedReturn ? 'result' : 'arguments'
	return usedReturn ? 'summary' : 'task'
}

// Main-area node (flow, by `data-participant`): the participant's resolved label, its kind, the
// completing return's outcome, and the relevant call/return `details` — the delegation task text
// for a role, the arguments/result for a tool, the question for a human answerer. The completing
// return's details (the outcome) are preferred over the incoming call's (the request) so the card
// shows the result once it has arrived and the in-flight request otherwise.
export function deriveParticipantTooltip(model, labels, tier, participantId) {
	if (!isObject(model) || typeof participantId !== 'string') return { title: '', sections: [] }
	const participant = findParticipant(model, participantId)
	if (participant === undefined) return { title: '', sections: [] }
	const title = labels.resolveParticipantLabel(participant, tier)
	const sections = [scalarSection('kind', participant.kind)]
	const incomingCall = findLastCallTo(model, participantId)
	const completionReturn = findReturnFrom(model, participantId)
	if (completionReturn !== undefined && completionReturn.outcome !== null) {
		sections.push(scalarSection('status', completionReturn.outcome))
	}
	const returnDetails = completionReturn !== undefined ? detailsOf(completionReturn) : null
	const callDetails = incomingCall !== undefined ? detailsOf(incomingCall) : null
	// A human answerer's relevant detail is the question (its incoming ask_human call), not the
	// answer (its return) — the operator re-reads the question on hover, and the answer is already
	// the live question history. For every other kind the completing return's details (the result
	// or summary) are preferred over the incoming call's (the request) so the card shows the
	// outcome once it has arrived and the in-flight request otherwise.
	let sourceDetails = null
	let usedReturn = false
	if (participant.kind === 'human') {
		sourceDetails = callDetails
	} else if (returnDetails !== null) {
		sourceDetails = returnDetails
		usedReturn = true
	} else {
		sourceDetails = callDetails
	}
	if (sourceDetails !== null) {
		sections.push({ label: detailsLabelFor(participant, usedReturn), content: sourceDetails })
	}
	return { title, sections }
}

// A representative participant of a role — the first one in chronological first-appearance order —
// so the label resolver can resolve the role's localized label against a real participant (a role
// column in the sequence view and a top-bar slot in the flow view both derive their header/label
// this way). Every role that has a top-bar slot has at least one participant, so this is defined for
// every role the wiring asks about.
function representativeParticipantOfRole(model, role) {
	for (const participant of model.participants) {
		if (participant.role === role) return participant
	}
	return undefined
}

// Aggregates every participant instance of a role into a cumulative summary, mirroring the
// `projectTopBar` aggregation the flow view's top-bar strip already computes: the invocation count
// (every participant instance of the role, current and departed), the total time and total tokens
// drawn from the returns whose source is a participant of the role, and whether any invocation
// errored. `hasMetrics` distinguishes "no metrics yet" from "zero metrics" so the card omits the
// time/tokens rows while a role is still in flight rather than reading as a measured zero.
function aggregateRole(model, role) {
	let invocations = 0
	let totalTime = 0
	let totalTokens = 0
	let errored = false
	let hasMetrics = false
	const returnsBySource = new Map()
	for (const operation of model.operations) {
		if (operation.kind === 'return') returnsBySource.set(operation.source, operation)
	}
	for (const participant of model.participants) {
		if (participant.role !== role) continue
		invocations += 1
		const completion = returnsBySource.get(participant.id)
		if (completion === undefined) continue
		if (completion.outcome === 'error') errored = true
		if (completion.metrics === null) continue
		if (completion.metrics.elapsedSeconds !== null) {
			totalTime += completion.metrics.elapsedSeconds
			hasMetrics = true
		}
		if (completion.metrics.tokens !== null) {
			totalTokens += completion.metrics.tokens
			hasMetrics = true
		}
	}
	return { invocations, totalTime, totalTokens, errored, hasMetrics }
}

// Top-bar node (flow, by `data-role`): the role's cumulative summary across every participant
// instance of that role — invocation count, total time, total tokens, and whether any invocation
// errored. The figures match the count the top-bar slot displays and the <title> the strip carries,
// so hovering a slot reads the same aggregation the strip renders.
export function deriveRoleTooltip(model, labels, tier, role) {
	if (!isObject(model) || typeof role !== 'string') return { title: '', sections: [] }
	const representative = representativeParticipantOfRole(model, role)
	if (representative === undefined) return { title: '', sections: [] }
	const title = labels.resolveParticipantLabel(representative, tier)
	const aggregate = aggregateRole(model, role)
	const sections = [scalarSection('invocations', aggregate.invocations)]
	if (aggregate.hasMetrics) {
		sections.push(scalarSection('total time', `${aggregate.totalTime}s`))
		sections.push(scalarSection('total tokens', aggregate.totalTokens))
	}
	if (aggregate.errored) sections.push(scalarSection('status', 'errored'))
	return { title, sections }
}
