// The turn inspector's renderer: a browser-pure component that turns one `InspectorView` into vnodes. The session (turn-inspector/index.js) owns every log-window decision, the turn pairing, the ancestry/instance derivation, the stitched transcript, and the wire-detail cache; this file only renders the view and wires the host's actions.
//
// Each completed turn's header carries a collapsed "on the wire" expander: the FULL request conversation the model saw at that turn, fetched on demand by the host through the session's wire cache. The modal reads the cache through `view.wireDetail` and never fetches itself.
//
// The conversation opening (system prompt + task) is hoisted into one collapsed expander above the turns. Each turn then renders its new messages in order and its response — reasoning labeled 💭, all agent-authored prose through the sanitized Markdown pipeline. The `h` and `renderMarkdown` dependencies are passed in rather than imported so the component stays free of hyperapp and showdown coupling.

import { isObject } from './guards.js'
import { livePartialMatchesRole } from './turn-inspector/index.js'
import type { LooseH, Vnode, VnodeChildInput } from '../vendor/hyperapp.js'
import type {
	ChainCrumb,
	InstanceRecord,
	InspectorView,
	TranscriptMessage,
	TranscriptOutcome,
	TranscriptToolCall,
	TranscriptTurn,
	TurnUsage,
	WireDetailState,
	WireDetailSection,
} from './turn-inspector/index.js'

// Fixed trusted copy for the per-turn degraded notice (not agent prose, so it never flows through Markdown): it names the cause (the run logged at the standard level) and the fix (pick Full logging before starting a run), instead of an empty section that reads as a bug.
const DEGRADED_NOTICE = 'Message bodies were not logged for this turn: the run\u2019s logging level is Standard, which records turn metadata only (roles, usage, finish reasons). Choose Full logging on the compose screen before starting a run to capture the full request and response bodies here.'

const IN_FLIGHT_NOTE = 'This turn is in flight — its request and response appear here once the model responds.'

const OPENING_LABEL = 'system prompt \u00b7 task'

// Compact summaries cap at this length so the transcript reads inline; the full text rides the element's title.
const SUMMARY_MAX_CHARS = 240

function capSummary(text: string): string {
	if (text.length <= SUMMARY_MAX_CHARS) return text
	return `${text.slice(0, SUMMARY_MAX_CHARS)}\u2026`
}

// Parses a JSON text, or undefined when it is not valid JSON. Tool results and tool-call arguments are serialized JSON, but the conversation-length truncation can cut one mid-string; parse failure is an expected shape, not an exceptional one.
function parseJsonOrUndefined(text: string): unknown {
	if (text === '') return undefined
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

// One-line JSON form of a parsed value, falling back to its String form when it is not serializable so the summary never throws (mirrors tooltip.js).
function compactValue(value: unknown): string {
	try {
		return capSummary(JSON.stringify(value))
	} catch {
		return capSummary(String(value))
	}
}

// One-line summary of a tool call's raw arguments: the arguments re-stringified compact when parseable, else the raw text.
function argumentsSummary(argumentsText: string): string {
	const parsed = parseJsonOrUndefined(argumentsText)
	if (parsed === undefined) return capSummary(argumentsText)
	return compactValue(parsed)
}

function usageLabel(usage: TurnUsage | null): string {
	if (usage === null || !Number.isFinite(usage.totalTokens)) return '\u2014'
	return `${usage.totalTokens} tok`
}

function labeledSection(h: LooseH, label: string, bodyNode: Vnode): Vnode {
	return h('div', { class: 'inspector-section' }, [
		h('span', { class: 'inspector-section-label' }, [label]),
		bodyNode,
	])
}

// The success/error chip a tool result or an answered tool call carries. An unknown kind (non-JSON result text) renders the neutral em dash so nothing is invented.
function outcomeChipNode(h: LooseH, outcome: TranscriptOutcome | null): Vnode | null {
	if (outcome === null || outcome.kind === null || outcome.kind === '') return null
	if (outcome.kind === 'success') return h('span', { class: 'inspector-tool-outcome inspector-tool-outcome-success' }, ['\u2713 success'])
	return h('span', { class: 'inspector-tool-outcome inspector-tool-outcome-error' }, [`\u2717 ${outcome.kind}`])
}

// The transcript's message blocks: a user or system message renders its role chip and its content through the sanitized Markdown pipeline; a tool message renders as a result row with its outcome chip and compact summary.
function messageNode(h: LooseH, renderMarkdown: RenderMarkdown, message: TranscriptMessage): Vnode {
	if (message.role === 'tool') {
		const outcome = message.outcome
		return h('div', { class: 'inspector-message inspector-tool-result' }, [
			h('span', { class: 'inspector-message-role' }, ['tool result']),
			outcomeChipNode(h, outcome),
			outcome !== null && outcome.summary !== '' ? h('pre', { class: 'inspector-tool-call-result' }, [outcome.summary]) : null,
		])
	}
	return h('div', { class: 'inspector-message' }, [
		h('span', { class: 'inspector-message-role' }, [message.role]),
		message.content !== '' ? h('div', { class: 'inspector-message-content markdown' }, renderMarkdown(message.content)) : null,
	])
}

// One inline tool call of the assistant's response: the tool name, the compact arguments summary, the outcome chip once the answering result exists in the loaded window, and the compact result summary. An `agent` call that spawned a child instance renders as the delegation affordance — `agent → <child>` with a View control that re-scopes the transcript to the child (pushing the breadcrumb; the ↑ parent affordance pops back). No identifiable child renders the call as plain text.
function toolCallNode(h: LooseH, turn: TranscriptTurn, call: TranscriptToolCall, links: TranscriptLinks): Vnode {
	const childRoleId = call.name === 'agent' ? links.childInstance(turn.eventIndex) : null
	// A null chip (an outcome with no kind) rides in the children and is dropped by the renderer, exactly as hyperapp drops null children.
	const children: VnodeChildInput[] = [h('span', { class: 'inspector-tool-call-name' }, [call.name])]
	if (childRoleId !== null) children.push(h('span', { class: 'inspector-tool-call-child-id' }, [`\u2192 ${childRoleId}`]))
	const argsSummary = argumentsSummary(call.argumentsText)
	if (argsSummary !== '') children.push(h('span', { class: 'inspector-tool-call-args', title: call.argumentsText }, [argsSummary]))
	if (call.outcome !== null) children.push(outcomeChipNode(h, call.outcome))
	if (childRoleId !== null) {
		children.push(h('button', { type: 'button', class: 'inspector-tool-call-view', title: `Scope the transcript to the child instance ${childRoleId}`, onclick: [links.onScopeInstance, childRoleId] }, ['View \u25b8']))
	}
	if (call.outcome !== null && call.outcome.summary !== '') children.push(h('pre', { class: 'inspector-tool-call-result' }, [call.outcome.summary]))
	return h('div', { class: 'inspector-tool-call' }, children)
}

// The turn's response: the reasoning (labeled 💭 — the model's prose an operator is specifically inspecting for) and the content, both through the sanitized Markdown pipeline, then the response's tool calls inline.
function responseNode(h: LooseH, renderMarkdown: RenderMarkdown, turn: TranscriptTurn, links: TranscriptLinks): Vnode | null {
	const received = turn.received
	if (received === null) return null
	const children: Vnode[] = []
	if (received.reasoning !== '') children.push(labeledSection(h, '\ud83d\udcad Reasoning', h('div', { class: 'inspector-reasoning markdown' }, renderMarkdown(received.reasoning))))
	if (received.content !== '') children.push(h('div', { class: 'inspector-prose markdown' }, renderMarkdown(received.content)))
	for (const call of received.toolCalls) children.push(toolCallNode(h, turn, call, links))
	if (children.length === 0) children.push(h('span', { class: 'inspector-empty-value' }, ['\u2014']))
	return h('div', { class: 'inspector-response' }, children)
}

// The quiet per-turn header: the turn's number within the instance, its token bill, and its finish reason. An in-flight turn has none of the latter two yet — it reads "in flight…".
function turnHeaderNode(h: LooseH, turn: TranscriptTurn): Vnode {
	if (turn.kind === 'in_flight') return h('div', { class: 'inspector-turn-header' }, [`Turn ${turn.turnNumber} \u00b7 in flight\u2026`])
	return h('div', { class: 'inspector-turn-header' }, [`Turn ${turn.turnNumber} \u00b7 ${usageLabel(turn.usage)} \u00b7 ${turn.finishReason ?? '\u2014'}`])
}

// The conversation opening (the scoped instance's first turn's leading system/user messages — the system prompt and the task), collapsed by default: it is context, not story, so one native details expander holds it above the turns.
function openingNode(h: LooseH, renderMarkdown: RenderMarkdown, opening: TranscriptMessage[]): Vnode | null {
	if (opening.length === 0) return null
	return h('details', { class: 'inspector-opening' }, [
		h('summary', { class: 'inspector-opening-summary' }, [OPENING_LABEL]),
		h('div', { class: 'inspector-opening-body' }, opening.map((message) => messageNode(h, renderMarkdown, message))),
	])
}

// --- On-the-wire expander ----------------------------------------------------
// Each completed turn's collapsed view of the FULL request the model saw at that turn (system + task + every message up to and including it). It is a different view of the same turn than the inline new-messages rendering above the response — the transcript's story vs the complete envelope — so it is labeled distinctly and its body comes from the window endpoint's `?detail=` fold through the session's bounded wire cache, which the modal reads via `view.wireDetail` and never fetches itself.

const WIRE_LABEL = 'on the wire'

// Fixed trusted copy for the expander's three non-section states (not agent prose, so none flows through Markdown). The idle state is only visible when a fetch has failed and been evicted (or the entry aged out of the cache) — an open expander never renders it otherwise, because the open marks the cache loading before the next render.
const WIRE_RETRY_NOTICE = 'The full request could not be loaded — close and reopen this expander to retry.'

const WIRE_LOADING_NOTE = 'Loading the full request\u2026'

const WIRE_EMPTY_NOTICE = 'No request or response detail was logged for this turn.'

// The expander's collapsed summary: the label plus the full request's message count when the turn's payload reports one — the count is known before any fetch, because it rides the turn's own `llm_call` payload.
function wireSummaryLabel(turn: TranscriptTurn): string {
	const count = turn.messageCount
	if (typeof count !== 'number') return WIRE_LABEL
	return `${WIRE_LABEL} \u00b7 ${count} message${count === 1 ? '' : 's'}`
}

// Pretty-prints a value as JSON, falling back to its String form when it is not serializable so the `<pre>` never throws (mirrors tooltip.js).
function toJsonText(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}

function jsonBlock(h: LooseH, content: unknown): Vnode {
	return h('pre', { class: 'inspector-json' }, [toJsonText(content)])
}

// The `sent` section: one labeled block per message of the folded request — role as a machine chip, content as sanitized Markdown, tool calls as pretty-printed JSON. A message that is neither renders as its JSON so nothing is invented or dropped.
function sentMessagesNode(h: LooseH, renderMarkdown: RenderMarkdown, messages: unknown[]): Vnode {
	const rows: Vnode[] = []
	for (const message of messages) {
		if (!isObject(message)) continue
		const children: Vnode[] = [h('span', { class: 'inspector-message-role' }, typeof message['role'] === 'string' && message['role'] !== '' ? message['role'] : 'message')]
		if (typeof message['content'] === 'string' && message['content'] !== '') {
			children.push(h('div', { class: 'inspector-message-content markdown' }, renderMarkdown(message['content'])))
		}
		const rawToolCalls = message['tool_calls']
		if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
			children.push(jsonBlock(h, rawToolCalls))
		}
		if (children.length > 1) rows.push(h('div', { class: 'inspector-message' }, children))
	}
	if (rows.length === 0) return h('span', { class: 'inspector-empty-value' }, ['\u2014'])
	return h('div', { class: 'inspector-message-list' }, rows)
}

// The `received` section: the assistant response with its content and its reasoning (both rendered as Markdown — model prose an operator is specifically inspecting for) and its parsed tool calls.
function receivedNode(h: LooseH, renderMarkdown: RenderMarkdown, received: unknown): Vnode {
	if (!isObject(received)) return h('span', { class: 'inspector-empty-value' }, ['\u2014'])
	const children: Vnode[] = []
	if (typeof received['content'] === 'string' && received['content'] !== '') {
		children.push(labeledSection(h, 'Response', h('div', { class: 'inspector-prose markdown' }, renderMarkdown(received['content']))))
	}
	if (typeof received['reasoning'] === 'string' && received['reasoning'] !== '') {
		children.push(labeledSection(h, 'Reasoning', h('div', { class: 'inspector-reasoning markdown' }, renderMarkdown(received['reasoning']))))
	}
	const rawToolCalls = received['toolCalls']
	if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
		children.push(labeledSection(h, 'Tool calls', jsonBlock(h, rawToolCalls)))
	}
	if (children.length === 0) return h('span', { class: 'inspector-empty-value' }, ['\u2014'])
	return h('div', { class: 'inspector-received' }, children)
}

// Renders one wire section by its machine label. The endpoint only ever returns the four `formatLogDetailSections` labels for an `llm_call`; anything else falls back to the tooltip's by-kind formatting (JSON for objects, Markdown for prose) so a future section kind degrades readably rather than vanishing.
function wireSectionNode(h: LooseH, renderMarkdown: RenderMarkdown, section: WireDetailSection): Vnode | null {
	if (!isObject(section)) return null
	const label = typeof section['label'] === 'string' ? section['label'] : ''
	const content = section['content']
	if (label === 'sent') {
		if (!Array.isArray(content)) return null
		return labeledSection(h, 'Sent messages', sentMessagesNode(h, renderMarkdown, content))
	}
	if (label === 'received') return labeledSection(h, 'Received', receivedNode(h, renderMarkdown, content))
	if (label === 'finish reason') {
		return labeledSection(h, 'Finish reason', h('span', { class: 'inspector-scalar' }, [typeof content === 'string' && content !== '' ? content : '\u2014']))
	}
	if (label === 'usage') {
		if (!isObject(content)) return null
		return labeledSection(h, 'Usage', jsonBlock(h, content))
	}
	if (isObject(content) || Array.isArray(content)) return labeledSection(h, label, jsonBlock(h, content))
	if (typeof content === 'string' && content !== '') return labeledSection(h, label, h('div', { class: 'inspector-prose markdown' }, renderMarkdown(content)))
	return labeledSection(h, label, h('span', { class: 'inspector-scalar' }, [content === null || content === undefined ? '\u2014' : String(content)]))
}

function wireSectionsNode(h: LooseH, renderMarkdown: RenderMarkdown, sections: WireDetailSection[]): Vnode {
	const children: Vnode[] = []
	for (const section of sections) {
		const node = wireSectionNode(h, renderMarkdown, section)
		if (node !== null) children.push(node)
	}
	return h('div', { class: 'inspector-wire-sections' }, children)
}

// The expander's body from the cache's normalized state: the folded sections (or the honest empty notice), the loading note, or the retry notice for a state with no envelope behind it.
function wireBodyNode(h: LooseH, renderMarkdown: RenderMarkdown, state: WireDetailState): Vnode {
	if (state.status === 'ready') {
		if (state.sections === null) return h('p', { class: 'inspector-wire-note' }, [WIRE_EMPTY_NOTICE])
		return wireSectionsNode(h, renderMarkdown, state.sections)
	}
	if (state.status === 'loading') return h('p', { class: 'inspector-wire-note' }, [WIRE_LOADING_NOTE])
	return h('p', { class: 'inspector-wire-note' }, [WIRE_RETRY_NOTICE])
}

// The per-turn "on the wire" expander, rendered by every completed turn (an in-flight turn has no `llm_call` to fetch). Collapsed like the opening expander; the first open fires the app's toggle handler, which fetches the sections once into the session cache, and the body renders the cache's state. The lookup and toggle wiring are injected props — a modal mounted without them renders no expander rather than a dead one.
function wireExpanderNode(h: LooseH, renderMarkdown: RenderMarkdown, turn: TranscriptTurn, links: TranscriptLinks): Vnode | null {
	if (turn.kind !== 'completed') return null
	if (links.onToggleWire === null) return null
	const state = links.wireDetail(turn.eventIndex)
	return h('details', { class: 'inspector-wire', ontoggle: links.onToggleWire(turn.eventIndex) }, [
		h('summary', { class: 'inspector-wire-summary' }, [wireSummaryLabel(turn)]),
		h('div', { class: 'inspector-wire-body' }, [wireBodyNode(h, renderMarkdown, state)]),
	])
}

// The live partial prop, validated: an absent or malformed prop renders nothing rather than inventing sections (the never-invent rule the transcript follows throughout). Only the fields the rendering reads are carried.
export interface LivePartial {
	roleId: string | null
	role: string
	reasoning: string
	content: string
}

function livePartialForRender(value: unknown): LivePartial | null {
	if (!isObject(value)) return null
	const role = typeof value['role'] === 'string' ? value['role'] : null
	if (role === null) return null
	const roleId = typeof value['roleId'] === 'string' && value['roleId'] !== '' ? value['roleId'] : null
	const reasoning = typeof value['reasoning'] === 'string' ? value['reasoning'] : ''
	const content = typeof value['content'] === 'string' ? value['content'] : ''
	return { roleId, role, reasoning, content }
}

// Whether the transcript turn is the in-flight turn the live partial belongs to. Matching uses the session's shared rule through the module entrypoint, so a same-named sibling instance's ghost turn (an unmatched start whose failure event has paged out of the loaded window) never hosts another instance's stream; turns whose id fell back to the role name (old logs) pair on the role name as before.
function isLiveTurn(turn: TranscriptTurn, livePartial: LivePartial | null): boolean {
	if (livePartial === null) return false
	if (turn.kind !== 'in_flight') return false
	return livePartialMatchesRole(turn.roleId, turn.role, livePartial)
}

// The live block at the in-flight turn: the streamed reasoning and response, each labeled like the transcript's response sections and rendered through the same sanitized Markdown pipeline. A field with no text yet renders nothing, and an all-empty partial renders no block at all — the app clears the partial when the socket drops, so a stale block never lingers.
function livePartialNode(h: LooseH, renderMarkdown: RenderMarkdown, livePartial: LivePartial): Vnode | null {
	const children: Vnode[] = []
	if (livePartial.reasoning !== '') children.push(labeledSection(h, '\ud83d\udcad Reasoning', h('div', { class: 'inspector-reasoning markdown' }, renderMarkdown(livePartial.reasoning))))
	if (livePartial.content !== '') children.push(labeledSection(h, 'Response', h('div', { class: 'inspector-prose markdown' }, renderMarkdown(livePartial.content))))
	if (children.length === 0) return null
	return h('div', { class: 'inspector-live-partial' }, children)
}

// The transcript links a turn's rendering reads: the derived view's lookups (wire-detail cache and child instance), the validated live partial, the scope action, and the wire-expander toggle.
interface TranscriptLinks {
	livePartial: LivePartial | null
	onScopeInstance: unknown
	wireDetail(eventIndex: number): WireDetailState
	childInstance(eventIndex: number): string | null
	onToggleWire: ((eventIndex: number) => unknown) | null
}

// One turn of the transcript: the quiet header, then the turn's new messages in order, then the response, then the collapsed "on the wire" expander (completed turns only). An in-flight turn renders its note and — when the websocket partial matches this instance — the live reasoning/content block beneath it; the poll's completed turn replaces both in sequence. A turn the standard level logged body-less renders the honest degraded notice instead.
function turnSectionNode(h: LooseH, renderMarkdown: RenderMarkdown, turn: TranscriptTurn, links: TranscriptLinks): Vnode {
	const children: Vnode[] = [turnHeaderNode(h, turn)]
	if (turn.kind === 'in_flight') {
		children.push(h('p', { class: 'inspector-transcript-note' }, [IN_FLIGHT_NOTE]))
		if (isLiveTurn(turn, links.livePartial) && links.livePartial !== null) {
			const block = livePartialNode(h, renderMarkdown, links.livePartial)
			if (block !== null) children.push(block)
		}
	} else if (turn.bodyLevel === 'standard') {
		children.push(h('p', { class: 'inspector-degraded-notice' }, [DEGRADED_NOTICE]))
	} else {
		for (const message of turn.messages) children.push(messageNode(h, renderMarkdown, message))
		const response = responseNode(h, renderMarkdown, turn, links)
		if (response !== null) children.push(response)
	}
	const wire = wireExpanderNode(h, renderMarkdown, turn, links)
	if (wire !== null) children.push(wire)
	return h('div', { class: { 'inspector-turn-section': true, 'is-in-flight': turn.kind === 'in_flight' } }, children)
}

// The breadcrumb row: one crumb per chain instance, root first, joined by '▸' separators; the last crumb is the scoped instance (disabled — it is where the transcript already is). Each earlier crumb and the '↑ parent' affordance re-scope via the hyperapp tuple `[onScopeInstance, roleId]`, so the action receives the instance id directly. A chain that renders nothing (no loaded instances) renders no row.
function breadcrumbNode(h: LooseH, chain: ChainCrumb[], onScopeInstance: unknown): Vnode | null {
	const crumbs: ChainCrumb[] = []
	for (const crumb of chain) {
		if (!isObject(crumb) || typeof crumb['roleId'] !== 'string' || crumb['roleId'] === '') return null
		crumbs.push(crumb)
	}
	if (crumbs.length === 0) return null
	const children: Vnode[] = []
	for (const [position, crumb] of crumbs.entries()) {
		if (position > 0) children.push(h('span', { class: 'inspector-crumb-sep' }, '\u25b8'))
		const isCurrent = position === crumbs.length - 1
		children.push(h('button', { type: 'button', class: { 'inspector-crumb': true, 'is-current': isCurrent }, disabled: isCurrent, title: isCurrent ? 'The instance the transcript is scoped to' : `Scope the transcript to ${crumb.roleId}`, onclick: [onScopeInstance, crumb.roleId] }, [crumb.roleId]))
	}
	// The immediate parent is the second-to-last crumb; its presence is exactly the length ≥ 2 condition the affordance requires.
	const parent = crumbs[crumbs.length - 2]
	if (parent !== undefined) {
		children.push(h('button', { type: 'button', class: 'inspector-parent-up', title: `Scope the transcript to the parent instance ${parent.roleId}`, onclick: [onScopeInstance, parent.roleId] }, '\u2191 parent'))
	}
	return h('div', { class: 'inspector-breadcrumb-row' }, children)
}

// The minimal instance dropdown above the transcript (wayfinding): one option per loaded instance, labeled with the role name, the instance id when it differs, and the live/finished status; selecting re-scopes. The change event goes to the bare `onScopeInstance` action (the app reads the selected value off the event, mirroring the flow-tier select).
function instanceSelectNode(h: LooseH, instances: InstanceRecord[], scopedRoleId: string | null, onScopeInstance: unknown): Vnode | null {
	const options: Vnode[] = []
	for (const instance of instances) {
		if (!isObject(instance) || typeof instance['roleId'] !== 'string' || instance['roleId'] === '') return null
		const role = typeof instance['role'] === 'string' && instance['role'] !== '' ? instance['role'] : instance['roleId']
		const status = instance['live'] === true ? 'live' : 'finished'
		const idSuffix = instance['roleId'] !== role ? ` (${instance['roleId']})` : ''
		options.push(h('option', { value: instance['roleId'], selected: instance['roleId'] === scopedRoleId }, [`${role}${idSuffix} \u2014 ${status}`]))
	}
	if (options.length === 0) return null
	const selectProps: { class: string; onchange: unknown; value?: string } = { class: 'inspector-instance-select', onchange: onScopeInstance }
	if (scopedRoleId !== null) selectProps.value = scopedRoleId
	return h('label', { class: 'inspector-instance-row' }, [
		h('span', { class: 'inspector-instance-label' }, 'Instance'),
		h('select', selectProps, options),
	])
}

// The sanitized-Markdown renderer the modal receives: the createMarkdownRenderer product in the hosts — generic over the host's vnode product, an array of host vnodes and strings, which is children input exactly as `LooseH` accepts it wherever the host's `h` builds the exchange shape — or a single-vnode fake in the tests.
type RenderMarkdown = (text: string) => VnodeChildInput

// The modal's props. `view` is the session's entire derived output, a read-only snapshot the renderer only reads (never mutates); the action props stay `unknown` and are wired as hyperapp actions, and the live partial is re-validated at read.
export interface InspectorModalProps {
	runLabel?: string | null
	view: InspectorView
	livePartial?: unknown
	renderMarkdown: RenderMarkdown
	onScopeInstance?: unknown
	onLoadOlder?: unknown
	onClose?: unknown
	onToggleWire?: ((eventIndex: number) => unknown) | null
}

// The modal overlay: a backdrop over the run view plus a wide card whose body is the scoped instance's transcript — one continuous document of the instance's turns, topped by the "older turns" window control and the collapsed conversation opening. Above the body sit the heading, the delegation-chain breadcrumb, and the instance dropdown. `onScopeInstance` is wired bare on the dropdown (it reads the change event) and per crumb/View affordance with the instance id as payload; `onLoadOlder` and `onClose` are caller-supplied actions wired bare. `view.wireDetail` reads the session's bounded cache for a turn's "on the wire" envelope and `onToggleWire` is the app's open action factory; a modal mounted without the toggle renders no expanders.
export function InspectorModal(h: LooseH, props: InspectorModalProps): Vnode {
	const renderMarkdown = props.renderMarkdown
	const view = props.view
	const runLabel = typeof props.runLabel === 'string' && props.runLabel !== '' ? props.runLabel : null
	const onScopeInstance = props.onScopeInstance
	const onLoadOlder = props.onLoadOlder
	const onClose = props.onClose
	const onToggleWire = typeof props.onToggleWire === 'function' ? props.onToggleWire : null
	const scopedRoleId = view.scopedRoleId
	const livePartial = livePartialForRender(props.livePartial)
	const links: TranscriptLinks = { livePartial, onScopeInstance, wireDetail: view.wireDetail, childInstance: view.childInstance, onToggleWire }

	const bodyChildren: Vnode[] = []
	if (view.loadState === 'loading') {
		bodyChildren.push(h('p', { class: 'inspector-transcript-note' }, ['Loading the run log\u2026']))
	} else if (view.loadState === 'failed') {
		bodyChildren.push(h('p', { class: 'inspector-transcript-note' }, ['The run log could not be loaded.']))
	} else {
		if (view.hasOlder) {
			bodyChildren.push(h('button', { type: 'button', class: 'inspector-older', disabled: view.olderLoading, onclick: onLoadOlder }, view.olderLoading ? 'loading older turns\u2026' : 'Older turns'))
		}
		if (view.transcript.length === 0) {
			// Scoped and unscoped empties read differently: a scope with no turns in the loaded range is wayfinding (older turns may page back, another instance may hold them), not an empty log.
			bodyChildren.push(h('p', { class: 'inspector-transcript-note' }, [scopedRoleId !== null ? 'No turns logged for this instance in the loaded range yet.' : 'No LLM turns logged for this run yet.']))
		} else {
			const firstTurn = view.transcript[0]
			if (firstTurn !== undefined) {
				const opening = openingNode(h, renderMarkdown, firstTurn.opening)
				if (opening !== null) bodyChildren.push(opening)
			}
			for (const turn of view.transcript) bodyChildren.push(turnSectionNode(h, renderMarkdown, turn, links))
		}
	}

	const breadcrumb = breadcrumbNode(h, view.chain, onScopeInstance)
	const instanceRow = instanceSelectNode(h, view.instances, scopedRoleId, onScopeInstance)
	return h('div', { class: 'inspector-modal-overlay' }, [
		h('div', { class: 'inspector-modal-backdrop', onclick: onClose }),
		h('div', { class: 'inspector-modal-card' }, [
			h('div', { class: 'inspector-modal-heading-row' }, [
				h('p', { class: 'inspector-modal-heading' }, runLabel !== null ? [`LLM turns \u00b7 ${runLabel}`] : ['LLM turns']),
				h('button', { type: 'button', class: 'inspector-modal-close', onclick: onClose }, 'Close'),
			]),
			breadcrumb !== null ? breadcrumb : null,
			instanceRow !== null ? instanceRow : null,
			h('div', { class: 'inspector-modal-body' }, bodyChildren),
		]),
	])
}
