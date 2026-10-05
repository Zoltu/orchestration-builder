// Tooltip component for the flow-graph run view: a friendly-formatted detail card that appears when an operator hovers a node or edge, and disappears when the pointer leaves it.
//
// Each section is a labeled block whose content is rendered by kind — pretty-printed JSON for object/array content (indented, no raw `\n` escapes), sanitized Markdown for prose content (assistant summaries, error messages, task text, question text), and plain text for scalars. The card is read-only (no buttons): the formatted view is for reading while the pointer rests on the node/edge. It is the reusable inspector the flow and sequence views both use.
//
// The card is an HTML overlay (a positioned `<div>`), not an SVG primitive: SVG cannot host the sanitized-Markdown vnodes (HTML `<p>`/`<ul>`/… produced by the `markdown-render` pipeline) or a wrapping `<pre>`, so the tooltip follows the question/result modal pattern (an HTML card scoped to the run view). The card is `pointer-events: auto` with `user-select: text` (stylesheets/styles.css) so the operator can move the pointer from the hovered node into the card to select and copy its contents; the wiring in `app.js` / `demo.js` keeps it open while the pointer is over the node or the card and dismisses it — after a short grace timer — once the pointer is over neither. See docs/security.md "Web client rendering pipeline".
//
// `h` and `renderMarkdown` are passed in rather than imported so the component stays free of hyperapp and showdown coupling and is exercisable in tests with fakes (mirroring question-modal.js / result-modal.js).

import { isObject } from './guards.js'
import type { InteractionModel, Operation, Participant } from './interaction-model.js'
import type { LabelResolver, LabelTier } from './labels.js'
import type { OperationDetailsState } from './operation-details.js'
import type { LooseH, Vnode, VnodeChildInput } from '../vendor/hyperapp.js'

// A labeled detail block, mirroring the `LogDetailSection` shape `formatLogDetailSections` (source/web/render.ts) produces: a machine label (`'arguments'`, `'result'`, `'summary'`, `'error'`, `'usage'`, …) and the raw content the tooltip then formats by kind.
export interface TooltipSection {
	label: string
	content?: unknown
	scalar?: unknown
}

// The descriptor a derivation returns: the card's heading and its labeled sections. An empty title with no sections is the "no card" answer the wiring dismisses on.
export interface TooltipDescriptor {
	title: string
	sections: TooltipSection[]
}

// The sanitized-Markdown renderer the components receive: the createMarkdownRenderer product in the hosts — generic over the host's vnode product, an array of host vnodes and strings, which is children input exactly as `LooseH` accepts it wherever the host's `h` builds the exchange shape — or a single-vnode fake in the tests.
type RenderMarkdown = (text: string) => VnodeChildInput

export function isTooltipSection(value: unknown): value is TooltipSection {
	if (!isObject(value)) return false
	if (typeof value['label'] !== 'string') return false
	return true
}

// Formats a single section's content into a vnode by its kind.
//
// A section explicitly marked `scalar: true` (a status word, an invocation count, a formatted time) renders as plain text. Otherwise the kind is decided by the content's JS type: object/array content becomes a `<pre class="tooltip-json">` text node carrying `JSON.stringify(content, null, 2)`, so the JSON is indented and its newlines render as real line breaks (never literal `\n`). A string content is first probed as JSON: the executor stores tool `arguments` as a JSON string, so a string that parses to an object/array is pretty-printed as JSON (this is how `{"path":"…"}` becomes legible); any other string is agent prose and flows through the sanitized Markdown pipeline. Numbers and booleans are plain scalar text. Null/undefined yields the em-dash placeholder the rest of the UI uses, so an absent field stays readable instead of blank.
//
// Every path keeps untrusted content as a text node or sanitized vnodes, never markup: the JSON branch is a `<pre>` text child, the prose branch is the caller's `renderMarkdown` (already sanitized), and the scalar branch is a `<span>` text child.
export function formatTooltipContent(h: LooseH, renderMarkdown: RenderMarkdown, content: unknown, scalar?: boolean): Vnode {
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
function toJsonText(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}

// Returns the parsed value when the string parses to a plain object or array (the shapes worth pretty-printing), or undefined for a non-JSON string, a scalar, or a parse failure. A string that parses to a number/boolean is not "pretty-printable JSON" and is treated as prose, so a result string like `'42'` still reads as text rather than a bare number.
function tryParseJsonObject(text: string): object | undefined {
	let value: unknown
	try {
		value = JSON.parse(text)
	} catch {
		return undefined
	}
	if (typeof value !== 'object' || value === null) return undefined
	return value
}

// The tooltip card: a heading and one labeled block per section. `style` carries the caller-chosen positioning (left/top or right/bottom near a viewport edge) applied inline so the card can be placed against the hovered node without a layout pass. The card carries no interactive chrome: it is a read-only hover inspector with no close button and no copy-raw button. Dismissal is the wiring's concern, not the component's — the card is `pointer-events: auto` with `user-select: text` (stylesheets/styles.css) so the operator can move the pointer into it to select text, and the wiring in `app.js` / `demo.js` dismisses it (after a short grace timer) once the pointer is over neither the node/edge nor the card. `sections` accepts anything and filters through `isTooltipSection`, so a host passing an unfiltered or malformed list yields a heading-only card rather than a crash.
export interface TooltipProps {
	title: string
	sections: unknown
	renderMarkdown: RenderMarkdown
	style?: unknown
}

export function Tooltip(h: LooseH, props: TooltipProps): Vnode {
	const title = props.title
	const sections = Array.isArray(props.sections) ? props.sections.filter(isTooltipSection) : []
	const renderMarkdown = props.renderMarkdown
	const style = props.style

	const children: Vnode[] = [h('p', { class: 'tooltip-heading' }, [title])]

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

export interface RectSnapshot {
	left: number
	top: number
	right: number
	bottom: number
}

export function tooltipStyle(rect: RectSnapshot): Record<string, string> {
	const viewportWidth = window.innerWidth
	const viewportHeight = window.innerHeight
	const margin = 8
	const estimatedWidth = 380
	const estimatedHeight = 280
	const style: Record<string, string> = {}
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
// replaced) dismisses rather than rendering a heading-less card. The model/id entry guards below
// defend the unchecked-JS callers (the hosts pass the polled model straight from state) — the
// types assume the shapes, the guards keep the boundary honest.

function scalarSection(label: string, content: unknown): TooltipSection {
	return { label, content, scalar: true }
}

// --- On-demand operation details --------------------------------------------
// The model carries no per-operation detail bodies (they can be multi-megabyte tool
// arguments/results and would ride every polled frame); the derivations receive a lookup the
// wiring provides — a function from operation id to the session cache's state for that id:
//   { status: 'loading' }                        the details fetch is in flight
//   { status: 'failed' }                         the fetch failed — the card renders section-less
//   { status: 'ready', details: string | null }  the server's answer; null when the operation
//                                                carries no detail material at all
// Any other shape (an absent lookup, an unknown id) yields no section, so a card never blocks or
// fabricates content on a cache that has not answered yet.

function detailsStateOf(operationDetails: ((operationId: string) => OperationDetailsState) | undefined, operationId: string): OperationDetailsState | undefined {
	if (typeof operationDetails !== 'function') return undefined
	const state = operationDetails(operationId)
	if (typeof state !== 'object' || state === null) return undefined
	return state
}

// The details section an operation contributes, or null when it contributes none: a pending or
// failed fetch reads as "no details" (the loading state renders a scalar placeholder so an open
// card visibly fills in rather than flickering).
function detailsSectionOf(operationDetails: ((operationId: string) => OperationDetailsState) | undefined, operationId: string): TooltipSection | null {
	const state = detailsStateOf(operationDetails, operationId)
	if (state === undefined) return null
	if (state.status === 'loading') return { label: 'details', content: 'loading details…', scalar: true }
	if (state.status !== 'ready') return null
	if (typeof state.details !== 'string' || state.details === '') return null
	return { label: 'details', content: state.details }
}

function findOperation(model: InteractionModel, operationId: string): Operation | undefined {
	for (const operation of model.operations) {
		if (operation.id === operationId) return operation
	}
	return undefined
}

function findParticipant(model: InteractionModel, participantId: string): Participant | undefined {
	for (const participant of model.participants) {
		if (participant.id === participantId) return participant
	}
	return undefined
}

// The most recent call whose destination is the participant — the request that brought the
// participant into the active path (a role delegation, a tool invocation, or an ask_human question).
function findLastCallTo(model: InteractionModel, participantId: string): Operation | undefined {
	for (let index = model.operations.length - 1; index >= 0; index -= 1) {
		const operation = model.operations[index]
		if (operation === undefined) continue
		if (operation.kind === 'call' && operation.destination === participantId) return operation
	}
	return undefined
}

// The return whose source is the participant — the participant's completing return, carrying its
// outcome and result/summary markdown. A participant with no completing return is still in flight.
function findReturnFrom(model: InteractionModel, participantId: string): Operation | undefined {
	for (const operation of model.operations) {
		if (operation.kind === 'return' && operation.source === participantId) return operation
	}
	return undefined
}

// Edge (flow or sequence, by `data-operation`): the operation's resolved label as the title and a
// single `details` section carrying its on-demand markdown — the delegation task text for a role
// call, the pretty-printed arguments/result for a tool, the question (and context) for an
// ask_human call, the summary for a return.
export function deriveOperationTooltip(model: InteractionModel, labels: LabelResolver, tier: LabelTier, operationId: string, operationDetails?: (operationId: string) => OperationDetailsState): TooltipDescriptor {
	if (!isObject(model) || typeof operationId !== 'string') return { title: '', sections: [] }
	const operation = findOperation(model, operationId)
	if (operation === undefined) return { title: '', sections: [] }
	const title = labels.resolveOperationLabel(operation, model.participants, tier, labels.hashString(operation.id))
	const section = detailsSectionOf(operationDetails, operationId)
	return { title, sections: section !== null ? [section] : [] }
}

// The label for the single details section a participant card carries. A human answerer's relevant
// detail is the question (its incoming call); a role's is its delegation task (call) or finish
// summary (return); a tool's is its arguments (call) or result (return). The label reflects which
// operation the shown details came from so the card reads accurately in both the in-flight and the
// completed phases.
function detailsLabelFor(participant: Participant, usedReturn: boolean): string {
	if (participant.kind === 'human') return 'question'
	if (participant.kind === 'tool') return usedReturn ? 'result' : 'arguments'
	return usedReturn ? 'summary' : 'task'
}

// Main-area node (flow, by `data-participant`): the participant's resolved label, its kind, the
// completing return's outcome, and the relevant call/return `details` — the delegation task text
// for a role, the arguments/result for a tool, the question for a human answerer. The completing
// return's details (the outcome) are preferred over the incoming call's (the request) so the card
// shows the result once it has arrived and the in-flight request otherwise; a return whose details
// have no content (none on the server, or the fetch failed) falls back to the call's.
export function deriveParticipantTooltip(model: InteractionModel, labels: LabelResolver, tier: LabelTier, participantId: string, operationDetails?: (operationId: string) => OperationDetailsState): TooltipDescriptor {
	if (!isObject(model) || typeof participantId !== 'string') return { title: '', sections: [] }
	const participant = findParticipant(model, participantId)
	if (participant === undefined) return { title: '', sections: [] }
	const title = labels.resolveParticipantLabel(participant, tier)
	const sections: TooltipSection[] = [scalarSection('kind', participant.kind)]
	const incomingCall = findLastCallTo(model, participantId)
	const completionReturn = findReturnFrom(model, participantId)
	if (completionReturn !== undefined && completionReturn.outcome !== null) {
		sections.push(scalarSection('status', completionReturn.outcome))
	}
	// A human answerer's relevant detail is the question (its incoming ask_human call), not the
	// answer (its return) — the operator re-reads the question on hover, and the answer is already
	// the live question history. For every other kind the completing return's details (the result
	// or summary) are preferred over the incoming call's (the request) so the card shows the
	// outcome once it has arrived and the in-flight request otherwise. A return with no content
	// (ready-null or failed) falls back to the call; a
	// return still loading keeps the card on the return rather than flashing the request first.
	let sourceId: string | null = null
	let usedReturn = false
	if (participant.kind === 'human') {
		sourceId = incomingCall !== undefined ? incomingCall.id : null
	} else if (completionReturn !== undefined) {
		const returnState = detailsStateOf(operationDetails, completionReturn.id)
		const returnHasContent = returnState !== undefined && (returnState.status === 'loading' || (returnState.status === 'ready' && typeof returnState.details === 'string' && returnState.details !== ''))
		if (returnHasContent) {
			sourceId = completionReturn.id
			usedReturn = true
		} else {
			sourceId = incomingCall !== undefined ? incomingCall.id : null
		}
	} else {
		sourceId = incomingCall !== undefined ? incomingCall.id : null
	}
	const section = sourceId !== null ? detailsSectionOf(operationDetails, sourceId) : null
	if (section !== null) {
		sections.push({ label: detailsLabelFor(participant, usedReturn), content: section.content, scalar: section.scalar === true })
	}
	return { title, sections }
}

// A representative participant of a role — the first one in chronological first-appearance order —
// so the label resolver can resolve the role's localized label against a real participant (a role
// column in the sequence view and a top-bar slot in the flow view both derive their header/label
// this way). Every role that has a top-bar slot has at least one participant, so this is defined for
// every role the wiring asks about.
function representativeParticipantOfRole(model: InteractionModel, role: string): Participant | undefined {
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
interface RoleAggregate {
	invocations: number
	totalTime: number
	totalTokens: number
	errored: boolean
	hasMetrics: boolean
}

function aggregateRole(model: InteractionModel, role: string): RoleAggregate {
	let invocations = 0
	let totalTime = 0
	let totalTokens = 0
	let errored = false
	let hasMetrics = false
	const returnsBySource = new Map<string, Operation>()
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
export function deriveRoleTooltip(model: InteractionModel, labels: LabelResolver, tier: LabelTier, role: string): TooltipDescriptor {
	if (!isObject(model) || typeof role !== 'string') return { title: '', sections: [] }
	const representative = representativeParticipantOfRole(model, role)
	if (representative === undefined) return { title: '', sections: [] }
	const title = labels.resolveParticipantLabel(representative, tier)
	const aggregate = aggregateRole(model, role)
	const sections: TooltipSection[] = [scalarSection('invocations', aggregate.invocations)]
	if (aggregate.hasMetrics) {
		sections.push(scalarSection('total time', `${aggregate.totalTime}s`))
		sections.push(scalarSection('total tokens', aggregate.totalTokens))
	}
	if (aggregate.errored) sections.push(scalarSection('status', 'errored'))
	return { title, sections }
}

// The operation ids whose details a hovered target's card may show — the ids the wiring must have
// fetched (or have in flight) before the card renders. An operation target shows its own details;
// a participant target shows its incoming call's and/or completing return's; a role card carries
// no details. The wiring calls this when the hover lands so the fetches start before the first
// render asks the lookup for those ids.
export function operationIdsForTooltipDetails(model: InteractionModel, target: unknown): string[] {
	if (!isObject(model)) return []
	if (!isObject(target) || typeof target['id'] !== 'string') return []
	if (target['kind'] === 'operation') return [target['id']]
	if (target['kind'] === 'participant') {
		const ids: string[] = []
		const incomingCall = findLastCallTo(model, target['id'])
		const completionReturn = findReturnFrom(model, target['id'])
		if (incomingCall !== undefined) ids.push(incomingCall.id)
		if (completionReturn !== undefined) ids.push(completionReturn.id)
		return ids
	}
	return []
}
