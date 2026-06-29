// Sequence diagram derivation + renderer for the debug "Sequence" view.
//
// A sequence diagram is a temporal layout: one column per role plus a Human column and a "tools" column, with each inter-column log event drawn as a horizontal message (arrow) between two columns on a vertical time axis. It is the debug/investigation surface behind the Flow/Sequence toggle; the flow view is the product surface. This module produces the diagram data (`deriveSequenceDiagram`), derives the current-frame activity that mirrors the flow view (`deriveSequenceActivity`), and renders it as an SVG (`renderSequenceDiagram`); all are pure so they are exercisable in tests with a fake `h`.
//
// The diagram is derived from a run view's `recentLog` (the same window the rest of the client sees), so it stays in lockstep with the data the flow view consumes. The log is append-only and ordered oldest→newest, so the vertical axis is simply the recentLog order; ties at the same timestamp preserve the log's order, which is the order the executor emitted them.
//
// Only inter-column interactions appear as messages: a delegation (agent_call, or a role_start when no agent_call precedes it), a tool call/result, a role finish, an ask_human question/answer. A role-internal event (an llm_call "thinking", an effort_set, a context_budget_exceeded) is NOT an interaction between participants — it is the agent working on its own — so it produces no message. (The flow view conveys "thinking" via the active-node pulse; the sequence view conveys it by highlighting the recipient of the last interaction, which is the agent now processing.) Dropping self-events is also what removes the loopback notches that cluttered earlier frames. A delegated child's `role_start` that follows its `agent_call` is also dropped: the `agent_call` already drew the delegation (one row, matching the flow view's single edge), and the child "starting" is the same delegation settling — conveyed by the arrow losing its flowing highlight, not by a new row. A self-delegation (agent_call where parent === child, and the matching self-return) renders as a small rectangular loopback arrow on the role's column — the one case where a "self" arrow is appropriate, because it is a real interaction between two invocations of the same role, not an internal event.
//
// Each message terminates at a small node on the target column's lifeline (an activation marker), big enough to host a small label and the future hover inspector (step 10). The current operation — the last (bottom) message — mirrors the flow view's active/flowing state: its line carries the marching-ants animation and accent/return/error color, and its terminal node (plus, for a return, the source node) carries the active/success/error highlight, so the two views read as one.
//
// `h` is passed in rather than imported so the module stays free of hyperapp coupling, mirroring tooltip.js. Column and message labels are guild-friendly labels and machine strings placed as SVG `<text>` textContent (never markup), so the textContent security invariant holds. No agent-authored prose is rendered by the diagram itself; the message `detailSections` (carried for inspection) are shaped by the caller's tooltip, which already routes prose through the sanitized Markdown path.
//
// The module is plain browser JS (a sibling of app.js, served statically and imported by the playback harness) and is exercised in-memory by sequence-diagram.test.ts. It imports nothing and touches no external system.

// Layout constants. Columns are evenly spaced on `COLUMN_WIDTH` centers; messages stack on `ROW_HEIGHT` centers below the header. The viewBox is sized to the laid-out content so preserveAspectRatio can fit it to the page (and so the future zoom/pan step is a viewBox tweak, not a relayout).
export const COLUMN_WIDTH = 150
export const ROW_HEIGHT = 30
export const HEADER_HEIGHT = 44
export const LEFT_MARGIN = 24
export const RIGHT_MARGIN = 24
export const BOTTOM_MARGIN = 24

// Terminal-node geometry. Each message's arrow lands on a small node on the target column's lifeline — an activation marker big enough to host a small label and the future hover inspector. It is centered on the column's lifeline at the message's row.
export const NODE_WIDTH = 18
export const NODE_HEIGHT = 12

export const SEQUENCE_CONSTANTS = { COLUMN_WIDTH, ROW_HEIGHT, HEADER_HEIGHT, LEFT_MARGIN, RIGHT_MARGIN, BOTTOM_MARGIN, NODE_WIDTH, NODE_HEIGHT }

// The "side" roles — guild-internal helpers that are not part of the main work chain — are placed last among the role columns (just before the tools column) so a long run's main delegation chain reads left-to-right without them interspersed. The set is fixed by convention; a guild with a different side role simply sees it grouped with the workers, which is acceptable for a debug view.
const SIDE_ROLES = new Set(['context_manager', 'recovery', 'loop_detector'])

// The control-flow builtins: tools whose `tool_call`/`tool_result` events are the dispatch wrapper around a delegation, a role finish, a human question, or an interrupt. Each is paired with a dedicated semantic event that already represents the operation on the diagram — `agent_call`/`role_start`/`role_finished` for `agent` and `finish`, `ask_human`/`human_answer` for `ask_human` (see source/executor/engine.ts `dispatchAndRecord`), and `interrupt_triggered` for `trigger_interrupt`. Routing the wrapper to the tools column would double-count the operation and contradict the flow view, which models these as delegation/question/inspect edges rather than tool-column calls. Native tools (`write_file`, `glob_files`, …) are not in this set and still route to the tools column.
const CONTROL_FLOW_TOOLS = new Set(['agent', 'finish', 'ask_human', 'trigger_interrupt'])

function isObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function titleCase(name) {
	return String(name).split('_').map((word) => word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

// The friendly label for a role column: the guild's friendly tier, then the detailed tier, then a title-cased name. A guild author who omits a friendly tier still gets a readable column header.
function roleColumnLabel(name, roles) {
	const entry = roles[name]
	if (isObject(entry) && isObject(entry.label)) {
		const tier = entry.label.friendly ?? entry.label.detailed
		if (typeof tier === 'string' && tier !== '') return tier
	}
	return titleCase(name)
}

// Builds the column set from the guild config: Human, then the entry role, then the remaining worker roles, then the side roles, then a single "tools" column. Every role in the config gets a column so a delegation to any role has a destination, even one that has not run yet in the visible window.
export function buildColumns(config) {
	const roles = isObject(config) && isObject(config.roles) ? config.roles : {}
	const entryRole = isObject(config) && typeof config.entryRole === 'string' ? config.entryRole : null
	const columns = [{ id: 'human', label: 'You', kind: 'human' }]
	const workers = []
	const side = []
	for (const name of Object.keys(roles)) {
		if (name === entryRole) continue
		if (SIDE_ROLES.has(name)) side.push(name)
		else workers.push(name)
	}
	const ordered = entryRole !== null && roles[entryRole] !== undefined ? [entryRole, ...workers, ...side] : [...workers, ...side]
	for (const name of ordered) {
		columns.push({ id: name, label: roleColumnLabel(name, roles), kind: 'role' })
	}
	columns.push({ id: 'tools', label: 'Tools', kind: 'tools' })
	return columns
}

// The column id a role name maps to. A role that is not a configured column (a role the guild lacks) falls back to the Human column rather than rendering a message to a non-existent column, so a guild/run mismatch degrades gracefully instead of producing a dangling line.
function roleColumnId(role, columnIds) {
	if (typeof role === 'string' && columnIds.has(role)) return role
	return 'human'
}

// The parent column for a `role_start`: the payload's `parent` when present, else Human (a depth-0 / entry role is started by the system, modeled as a call from the Human column).
function parentColumnOf(payload) {
	const parent = isObject(payload) && typeof payload.parent === 'string' ? payload.parent : null
	return parent !== null ? parent : 'human'
}

// Extracts the numeric `depth` from a payload, or null when absent. Depth disambiguates a self-delegation's parent→child chain: the same role name appears at multiple depths (coder at depth 0 is the entry role whose parent is Human; coder at depth 1 is the self-delegated child whose parent is coder), so the parent-of map is keyed by (role, depth) to avoid the child's entry overwriting the parent's.
function depthOf(payload) {
	const depth = isObject(payload) ? payload.depth : undefined
	return typeof depth === 'number' ? depth : null
}

// The key under which a role's parent is stored: (role, depth) when depth is available (so a self-delegation's parent and child don't collide), else the role name alone (sufficient for non-self-delegation chains where the role name is unique per call stack).
function parentKey(role, depth) {
	if (typeof role !== 'string') return null
	if (depth !== null) return `${role}|${depth}`
	return role
}

// Looks up a role's recorded parent (from its role_start / agent_call), trying the (role, depth) composite key first, then the role-name-only fallback, then null. Used by role_finished to find where to return.
function lookupParent(parentOf, role, depth) {
	const key = parentKey(role, depth)
	if (key !== null && parentOf.has(key)) return parentOf.get(key)
	if (typeof role === 'string' && parentOf.has(role)) return parentOf.get(role)
	return null
}

// Maps a single log event to a message's column routing and direction, or returns `null` when the event should not appear on the diagram:
// - `null` for `tool_call`/`tool_result` whose tool is a control-flow builtin (agent/finish/ask_human) — the dispatch wrapper whose semantics are already carried by the paired `agent_call`/`role_finished`/`ask_human` event.
// - `null` for role-internal / system events (the `default` case: `llm_call`, `effort_set`, `context_budget_exceeded`, …) — these are an agent working on its own, not an interaction between participants, so they produce no message (and no loopback notch). The thinking state is conveyed by highlighting the recipient of the last interaction instead.
// `parentOf` carries each role's caller (recorded at its `role_start`) so a later `role_finished` can return to the right column; `currentRole` carries the role of the most recent event that had one, so `ask_human`/`human_answer` — which the executor logs without a role — route from/to the role active around the question.
function routeMessage(type, payload, role, currentRole, parentOf, columnIds) {
	switch (type) {
		case 'role_start': {
			const child = roleColumnId(role, columnIds)
			const parent = parentColumnOf(payload)
			if (typeof role === 'string' && columnIds.has(role)) recordParent(parentOf, role, depthOf(payload), parent)
			return { from: columnIds.has(parent) ? parent : 'human', to: child, direction: 'call' }
		}
		case 'agent_call': {
			const parent = isObject(payload) && typeof payload.parent === 'string' && columnIds.has(payload.parent) ? payload.parent : 'human'
			const child = isObject(payload) && typeof payload.child === 'string' && columnIds.has(payload.child) ? payload.child : 'human'
			if (isObject(payload) && typeof payload.child === 'string') recordParent(parentOf, payload.child, depthOf(payload), parent)
			return { from: parent, to: child, direction: 'call' }
		}
		case 'tool_call': {
			if (isControlFlowTool(payload)) return null
			return { from: roleColumnId(role, columnIds), to: 'tools', direction: 'call' }
		}
		case 'tool_result': {
			if (isControlFlowTool(payload)) return null
			return { from: 'tools', to: roleColumnId(role, columnIds), direction: 'return' }
		}
		case 'role_finished': {
			const from = roleColumnId(role, columnIds)
			// The payload's `parent` field, when present, is the authoritative caller; fall back to the (role, depth) parent-of map recorded at the role's start/agent_call. A depth-0 entry role with no payload parent and no recorded parent returns to Human.
			const payloadParent = isObject(payload) && typeof payload.parent === 'string' ? payload.parent : null
			const parent = payloadParent ?? lookupParent(parentOf, role, depthOf(payload)) ?? 'human'
			return { from, to: columnIds.has(parent) ? parent : 'human', direction: 'return' }
		}
		case 'ask_human': {
			const asker = roleColumnId(role ?? currentRole, columnIds)
			return { from: asker, to: 'human', direction: 'call' }
		}
		case 'human_answer': {
			const recipient = roleColumnId(role ?? currentRole, columnIds)
			return { from: 'human', to: recipient, direction: 'return' }
		}
		default: {
			// Role-internal / system events (llm_call, effort_set, context_budget_exceeded, …) are not interactions between participants and produce no message.
			return null
		}
	}
}

// Records a role's parent under both the (role, depth) composite key (precise — survives self-delegation where the same role name appears at multiple depths) and the bare role-name key (a fallback for role_finished events that omit depth, so they can still find the parent).
function recordParent(parentOf, role, depth, parent) {
	parentOf.set(parentKey(role, depth), parent)
	parentOf.set(role, parent)
}

// A tool_call/tool_result payload whose `tool` is a control-flow builtin (agent/finish/ask_human/trigger_interrupt) is skipped — its semantics are carried by the paired semantic event(s), not the dispatch wrapper.
function isControlFlowTool(payload) {
	const tool = isObject(payload) && typeof payload.tool === 'string' ? payload.tool : null
	return tool !== null && CONTROL_FLOW_TOOLS.has(tool)
}

// Filters orphan tool_calls from an accumulated log. A tool_call is an orphan when no matching tool_result appears later in the log for the same (role, tool) pair — the call's result scrolled out of the recentLog window (the fixture's windows are small and designed for the flow view's current-state needs, not a full timeline). Such orphans are dropped because they represent half an interaction: the call without its response. The one exception is a tool_call that is the LAST event in the log AND whose tool is currently in-flight (its tool name is in `flowingToolNames`): that is a genuine in-flight call whose result hasn't arrived yet, and it should be shown (flowing). tool_calls whose tool is a control-flow builtin are already dropped by `routeMessage` and are passed through here unchanged. This is a fixture-harness concern: the live backend's recentLog carries complete call+result pairs, so the filter is a no-op there.
export function filterOrphanToolCalls(events, flowingToolNames) {
	const list = Array.isArray(events) ? events : []
	// Count tool_results per (role, tool) — the supply that tool_calls match against.
	const resultCounts = new Map()
	for (const entry of list) {
		if (!isObject(entry) || entry.type !== 'tool_result') continue
		const key = toolMatchKey(entry)
		if (key === null) continue
		resultCounts.set(key, (resultCounts.get(key) ?? 0) + 1)
	}
	// Match tool_calls to results in order: the Nth tool_call for (role, tool) is satisfied by the Nth tool_result.
	const callCounts = new Map()
	const flowingSet = flowingToolNames instanceof Set ? flowingToolNames : new Set()
	const lastIndex = list.length - 1
	return list.filter((entry, index) => {
		if (!isObject(entry) || entry.type !== 'tool_call') return true
		const key = toolMatchKey(entry)
		if (key === null) return true
		const callIndex = callCounts.get(key) ?? 0
		callCounts.set(key, callIndex + 1)
		// Has a matching result? Keep it.
		if (callIndex < (resultCounts.get(key) ?? 0)) return true
		// Orphan: no matching result. Keep only if it's the last event AND the tool is currently in-flight.
		if (index === lastIndex) {
			const tool = isObject(entry.payload) && typeof entry.payload.tool === 'string' ? entry.payload.tool : null
			if (tool !== null && flowingSet.has(tool)) return true
		}
		return false
	})
}

// The match key for pairing a tool_call to its tool_result: (role, tool). The fixtures don't carry tool-call ids, so calls and results are matched by (role, tool) in order — the Nth call for a pair matches the Nth result.
function toolMatchKey(entry) {
	const payload = isObject(entry) ? entry.payload : null
	if (!isObject(payload)) return null
	const role = typeof payload.role === 'string' ? payload.role : ''
	const tool = typeof payload.tool === 'string' ? payload.tool : ''
	if (tool === '') return null
	return `${role}|${tool}`
}

// A flow-model call-edge set for filtering agent_calls that don't correspond to real delegations. An overseer role (like a loop_detector) may be spawned via an agent_call event whose parent→child pair does not appear as a call edge in the flow view (the overseer sits in its own row, not as a child of the caller). Such an agent_call is dropped so the sequence diagram matches the flow view's structure. Returns null when no flow model is available (all agent_calls are kept). Exported so the playback harness can apply the same filter at accumulation time (where each frame's flow model is available, so a past delegation is kept even after the child departs the main area).
export function buildCallEdgeColumns(flowModel) {
	if (!isObject(flowModel) || !isObject(flowModel.mainArea) || !Array.isArray(flowModel.mainArea.edges)) return null
	const nodeMap = new Map()
	for (const node of (Array.isArray(flowModel.mainArea.nodes) ? flowModel.mainArea.nodes : [])) {
		if (isObject(node) && typeof node.id === 'string') nodeMap.set(node.id, node)
	}
	const edges = new Set()
	for (const edge of flowModel.mainArea.edges) {
		if (!isObject(edge) || edge.kind !== 'call') continue
		const from = flowNodeColumn(nodeMap.get(edge.from))
		const to = flowNodeColumn(nodeMap.get(edge.to))
		if (from !== null && to !== null) edges.add(`${from}->${to}`)
	}
	return edges
}

// Checks whether an agent_call payload's parent→child pair appears as a call edge in the given call-edge set. Returns true when it matches (a real delegation) or when no call-edge set is available (keep by default). Returns false when it doesn't match (an overseer spawn).
export function isRealDelegation(payload, callEdgeColumns, columnIds) {
	if (callEdgeColumns === null) return true
	const parentCol = isObject(payload) && typeof payload.parent === 'string' && columnIds.has(payload.parent) ? payload.parent : 'human'
	const childCol = isObject(payload) && typeof payload.child === 'string' && columnIds.has(payload.child) ? payload.child : 'human'
	return callEdgeColumns.has(`${parentCol}->${childCol}`)
}

// Derives the sequence diagram (columns + messages) from a guild config and a run view. Pure: the same inputs always yield the same diagram, so it is exercisable in tests against fixtures and synthetic frames. Messages appear in recentLog order (the vertical axis); each carries its routing, the one-line summary (for the native hover title), and the event's paired `detailSections` (for the future inspector). Overseer agent_calls (e.g. a loop_detector spawned in its own row) are filtered at the accumulation step in the playback harness (where each frame's flow model is available), not here.
export function deriveSequenceDiagram(config, runView) {
	const columns = buildColumns(config)
	const columnIds = new Set(columns.map((column) => column.id))
	const recentLog = isObject(runView) && Array.isArray(runView.recentLog) ? runView.recentLog : []
	const parentOf = new Map()
	// The set of children that already have an `agent_call` row in the timeline. A delegated child's `role_start` arrives one log event after its `agent_call` (the parent delegates, then the child begins) and would draw a *second* arrow on the same parent→child lane — a phantom row with no corresponding flow-view edge (the flow view shows the delegation as a single edge that appears with the `agent_call` and settles when the child produces its first turn). Such a `role_start` is dropped so the delegation is one row, matching the flow view; the `agent_call` already recorded the parent→child link the later `role_finished` needs. A `role_start` with no preceding `agent_call` (the entry role, or a scenario that starts mid-delegation) is kept so the delegation is still represented and the return is not dangling.
	const agentCallChildren = new Set()
	const messages = []
	let currentRole = null
	for (const entry of recentLog) {
		if (!isObject(entry)) continue
		const type = typeof entry.type === 'string' ? entry.type : ''
		const payload = isObject(entry.payload) ? entry.payload : {}
		const role = typeof payload.role === 'string' ? payload.role : null
		if (role !== null) currentRole = role
		if (type === 'agent_call' && isObject(payload) && typeof payload.child === 'string') agentCallChildren.add(payload.child)
		// A delegated child's role_start whose delegation was already drawn by an agent_call is dropped (see agentCallChildren above). The entry role (no parent) and a mid-run start (no preceding agent_call) survive.
		if (type === 'role_start' && isObject(payload) && typeof payload.parent === 'string' && typeof role === 'string' && agentCallChildren.has(role)) continue
		const routed = routeMessage(type, payload, role, currentRole, parentOf, columnIds)
		// A null routing means the event is not an inter-column interaction (a control-flow dispatch wrapper or a role-internal event) and is dropped from the timeline.
		if (routed === null) continue
		messages.push({
			from: routed.from,
			to: routed.to,
			direction: routed.direction,
			label: typeof entry.summary === 'string' && entry.summary !== '' ? entry.summary : type,
			detailSections: Array.isArray(entry.detailSections) ? entry.detailSections : null,
			timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : '',
			type,
		})
	}
	return { columns, messages }
}

// --- Activity derivation (mirrors the flow view) -----------------------------

// Maps a flow-graph node to its sequence-diagram column id. A role invocation node's id may carry an invocation suffix (coder-1, coder-2) that must be stripped to get the role name (the column id); the flow view's `sublabel` is a visual distinguisher (sometimes the role name, sometimes a descriptive label like 'sub-task'), so it is not a reliable column id. A tool node collapses to the single `tools` column, and a `you` node (the root or a question respondent) collapses to the `human` column.
function flowNodeColumn(node) {
	if (!isObject(node)) return null
	if (node.kind === 'tool') return 'tools'
	if (node.kind === 'you') return 'human'
	if (node.kind === 'role') {
		const id = typeof node.id === 'string' ? node.id : null
		if (id === null) return null
		return id.replace(/-\d+$/, '')
	}
	return null
}

// Derives the activity descriptor for the sequence diagram's current operation (the last/bottom message), mirroring the flow view's active-node + flowing-edge state so the two views read as one. Pure: takes the flow model, the flow view's precomputed `{ activeIds, edgeStates }` (from `deriveFlowAnimation` in flow-view.js), and the derived diagram; returns the line + node highlight states for the last message, or `null` when there is no message or no flow model to mirror.
//
// The line state mirrors the flow view's in-flight edge — but only when that edge corresponds to the last sequence message (matching columns). A flowing edge to a control-flow tool the sequence view doesn't show (e.g. ask_human) does NOT animate the last message's line, because the hidden tool's in-flight state is not the sequence view's current operation. Instead, the caller of the hidden tool is treated as active (it is the one processing). This keeps the two views in lockstep: the flow view pulses a hidden tool, the sequence view pulses its caller.
//
// Terminal status is read from BOTH the flow view's main area AND its top bar: a role that has finished and departed to the top bar still carries its success/error color on the sequence diagram, so a completed delegation's outcome persists on its node. The active (pulsing) state is read only from the main area — a role in the top bar is done, not active.
//
// The source of the last message can also be active when the line is settled (no in-flight edge): a thinking role that was the source of the last interaction (e.g. a coder stuck mid-loop after calling read_file) pulses on its own column, not on the tool's.
//
// A terminal run (status success/error/interrupted) marks the Human column as active — the operator is the one looking at the result — and suppresses the source node (the returning role/tool has already departed; its outcome was shown when it was in flight, and at rest the terminal frame shows only the recipient). When the last message does not target Human (e.g. an interrupted run whose last interaction was a tool call), an extra active node is rendered on the Human column so "You" still reads as active.
export function deriveSequenceActivity(flowModel, flowAnimation, diagram, runStatus) {
	const messages = isObject(diagram) && Array.isArray(diagram.messages) ? diagram.messages : []
	if (messages.length === 0) return null
	if (flowModel === undefined || flowModel === null || !isObject(flowModel)) return null
	if (!isObject(flowAnimation)) return null
	const last = messages[messages.length - 1]
	const isTerminal = runStatus === 'success' || runStatus === 'error' || runStatus === 'interrupted'
	const mainNodes = isObject(flowModel.mainArea) && Array.isArray(flowModel.mainArea.nodes) ? flowModel.mainArea.nodes : []
	const topBarNodes = isObject(flowModel.topBar) && Array.isArray(flowModel.topBar.nodes) ? flowModel.topBar.nodes : []
	const edges = isObject(flowModel.mainArea) && Array.isArray(flowModel.mainArea.edges) ? flowModel.mainArea.edges : []

	const nodeById = new Map()
	for (const node of mainNodes) {
		if (isObject(node) && typeof node.id === 'string') nodeById.set(node.id, node)
	}

	// Active columns: the set of sequence columns whose flow node is pulsing in the flow view (the current-flow recipient, or a role flagged mid-thought).
	const activeColumns = new Set()
	const activeIds = flowAnimation.activeIds
	if (activeIds !== undefined && activeIds !== null) {
		for (const id of activeIds) {
			const node = nodeById.get(id)
			if (node === undefined) continue
			const col = flowNodeColumn(node)
			if (col !== null) activeColumns.add(col)
		}
	}

	// Also treat the SOURCE of a flowing edge to a control-flow tool (agent/finish/ask_human) as active: the sequence view doesn't show the tool, so the caller is the one processing. The ask_human tool's in-flight call is the caller (orchestrator) calling a hidden tool — the orchestrator pulses, not the tools column.
	const edgeStates = Array.isArray(flowAnimation.edgeStates) ? flowAnimation.edgeStates : []
	for (let i = 0; i < edges.length; i++) {
		const state = edgeStates[i]
		if (state !== 'flowing') continue
		const edge = edges[i]
		if (!isObject(edge)) continue
		const target = nodeById.get(edge.to)
		if (target === undefined) continue
		if (target.kind === 'tool' && typeof target.id === 'string' && CONTROL_FLOW_TOOLS.has(target.id)) {
			const source = nodeById.get(edge.from)
			if (source !== undefined) {
				const col = flowNodeColumn(source)
				if (col !== null) activeColumns.add(col)
			}
		}
	}

	// Terminal status per column, scanned from BOTH the main area and the top bar. A finished role that departed to the top bar still carries its outcome so its sequence node stays green/red. error dominates success.
	const statusByColumn = new Map()
	for (const node of [...mainNodes, ...topBarNodes]) {
		const col = flowNodeColumn(node)
		if (col === null) continue
		const status = isObject(node) ? node.status : undefined
		if (status === 'error') statusByColumn.set(col, 'error')
		else if (status === 'success' && statusByColumn.get(col) !== 'error') statusByColumn.set(col, 'success')
	}

	// The line state matches the flow view's in-flight edge to the last sequence message by columns. A flowing/returning/error edge whose (from, to) columns match the last message's (from, to) animates the line; an edge to a hidden control-flow tool (or any edge that doesn't correspond to the last message) does not. This prevents a flowing ask_human call edge from animating an unrelated past message.
	let lineState = null
	for (let i = 0; i < edges.length; i++) {
		const state = edgeStates[i]
		if (state !== 'flowing' && state !== 'returning' && state !== 'error') continue
		const edge = edges[i]
		if (!isObject(edge)) continue
		const fromCol = flowNodeColumn(nodeById.get(edge.from))
		const toCol = flowNodeColumn(nodeById.get(edge.to))
		if (fromCol !== last.from || toCol !== last.to) continue
		if (state === 'flowing' && last.direction === 'call') lineState = 'flowing'
		else if (state === 'error' && last.direction === 'return') lineState = 'error'
		else if (state === 'returning' && last.direction === 'return') lineState = 'returning'
		if (lineState !== null) break
	}

	// The target node is the active recipient (blue) when its column is pulsing; otherwise it carries the terminal outcome (green/red) when that column's node has finished. Active takes precedence so the in-flight recipient reads blue.
	function targetStateOf(column) {
		if (column === null || column === undefined) return null
		if (activeColumns.has(column)) return 'active'
		const status = statusByColumn.get(column)
		if (status === 'error') return 'error'
		if (status === 'success') return 'success'
		return null
	}

	// The source node carries a terminal outcome (the returning role/tool's result). When the line is settled (no in-flight edge), the source can also be active — a thinking role that was the source of the last interaction (e.g. a coder stuck mid-loop) pulses on its own column. When the line is in flight, the source carries only the outcome (the recipient, not the source, is the active one).
	function sourceStateOf(column) {
		if (column === null || column === undefined) return null
		if (lineState === null && activeColumns.has(column)) return 'active'
		const status = statusByColumn.get(column)
		if (status === 'error') return 'error'
		if (status === 'success') return 'success'
		return null
	}

	const rawTargetState = targetStateOf(last.to)
	const rawSourceState = sourceStateOf(last.from)

	// A terminal run (success/error/interrupted) marks the Human column as active — the operator is the one looking at the result — and suppresses all other node highlights (the returning role/tool has already departed; its outcome was shown when it was in flight, and at rest the terminal frame shows only the active Human). When the last message targets Human, the target node is active; otherwise the target node is neutral and an extra active node is rendered on the Human column so "You" still reads as active (returned as `extraActiveColumn`).
	if (isTerminal) {
		const targetState = last.to === 'human' ? 'active' : null
		const extraActiveColumn = last.to !== 'human' ? 'human' : null
		if (last.from === last.to) {
			return { lineState: null, targetState: 'active', sourceState: null, extraActiveColumn }
		}
		return { lineState: null, targetState, sourceState: null, extraActiveColumn }
	}

	// A self-message (from === to — a self-delegation's agent_call, or a self-return's role_finished) has its source and target on the same column, so no separate source node is rendered (it would overlap the target). For a self-return in flight, the outcome (green/red) is the informative state on the single terminal node — the user wants the result color, not the active blue — so it takes precedence over active. For a settled frame or a self-call in flight, active (the thinking/processing role) takes precedence, same as for cross-column messages.
	if (last.from === last.to) {
		let selfState = null
		if (lineState === 'returning' || lineState === 'error') {
			selfState = rawSourceState ?? rawTargetState
		} else {
			selfState = rawTargetState ?? rawSourceState
		}
		return { lineState, targetState: selfState, sourceState: null, extraActiveColumn: null }
	}

	return {
		lineState,
		targetState: rawTargetState,
		sourceState: rawSourceState,
		extraActiveColumn: null,
	}
}

// --- Renderer ---------------------------------------------------------------

// The arrowhead marker id for a given line state. Past messages use a neutral marker; the active message uses a marker whose fill matches its line color so the arrowhead reads as part of the line. A single shared marker could not be recolored per referencing line, so one marker per color is declared in `<defs>`.
function markerIdFor(lineState) {
	if (lineState === 'flowing') return 'seq-arrow-flowing'
	if (lineState === 'returning') return 'seq-arrow-returning'
	if (lineState === 'error') return 'seq-arrow-error'
	return 'seq-arrow-neutral'
}

// The class list for a message line. Past calls are solid neutral; past returns are dashed neutral; the active message carries the flowing/returning/error color and the marching-ants animation, mirroring the flow view's `graph-edge--*` classes.
function lineClasses(index, lastIndex, lineState, direction) {
	const classes = ['seq-message']
	if (index === lastIndex && lineState !== null) {
		classes.push(`seq-message--${lineState}`)
	} else if (direction === 'return') {
		classes.push('seq-message--return')
	}
	return classes.join(' ')
}

// A terminal node on a column's lifeline at a vertical row. A small rounded rect centered on the column at the message's row, carrying a native `<title>` (the message summary) for hover and a state class (active/success/error) when it is the current operation's endpoint, mirroring the flow view's `graph-node--*` so the two views' highlights read identically.
function TerminalNode(h, columnX, y, state, label) {
	const x = columnX - NODE_WIDTH / 2
	const classes = ['seq-node']
	if (state === 'active' || state === 'success' || state === 'error') classes.push(`seq-node--${state}`)
	return h('g', { class: classes.join(' ') }, [
		h('title', {}, [label]),
		h('rect', { class: 'seq-node-box', x, y: y - NODE_HEIGHT / 2, width: NODE_WIDTH, height: NODE_HEIGHT, rx: 3 }, []),
	])
}

// Renders the sequence diagram as an SVG with a `viewBox` sized to the laid-out content (so the future zoom/pan step is a viewBox tweak). Columns render as headers plus dashed vertical lifelines spanning the message area; messages render as horizontal arrows ordered by timestamp, each landing on a terminal node on the target column. The last (current) message mirrors the flow view's active/flowing state via `activity` (computed by `deriveSequenceActivity`): its line carries the marching-ants animation and accent/return/error color, and its terminal node (plus, for a return, the source node) carries the active/success/error highlight.
export function renderSequenceDiagram(h, diagram, activity) {
	const columns = isObject(diagram) && Array.isArray(diagram.columns) ? diagram.columns : []
	const messages = isObject(diagram) && Array.isArray(diagram.messages) ? diagram.messages : []
	const columnX = new Map()
	columns.forEach((column, index) => {
		columnX.set(column.id, LEFT_MARGIN + index * COLUMN_WIDTH)
	})
	const lastColumnX = columns.length > 0 ? LEFT_MARGIN + (columns.length - 1) * COLUMN_WIDTH : LEFT_MARGIN
	const width = lastColumnX + RIGHT_MARGIN
	const messageAreaHeight = messages.length * ROW_HEIGHT
	const height = HEADER_HEIGHT + messageAreaHeight + BOTTOM_MARGIN
	const lifelineBottom = HEADER_HEIGHT + messageAreaHeight
	const lastIndex = messages.length - 1
	const act = activity ?? { lineState: null, targetState: null, sourceState: null, extraActiveColumn: null }

	const defs = h('defs', {}, [
		// One arrowhead per line color so the marker fill matches its line (a single shared marker could not be recolored per referencing line). All use orient="auto" so the arrow follows whichever direction the line travels; the neutral marker serves every past message.
		h('marker', { id: 'seq-arrow-neutral', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto' }, [
			h('path', { class: 'seq-arrowhead seq-arrowhead--neutral', d: 'M 0 0 L 10 5 L 0 10 z' }, []),
		]),
		h('marker', { id: 'seq-arrow-flowing', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto' }, [
			h('path', { class: 'seq-arrowhead seq-arrowhead--flowing', d: 'M 0 0 L 10 5 L 0 10 z' }, []),
		]),
		h('marker', { id: 'seq-arrow-returning', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto' }, [
			h('path', { class: 'seq-arrowhead seq-arrowhead--returning', d: 'M 0 0 L 10 5 L 0 10 z' }, []),
		]),
		h('marker', { id: 'seq-arrow-error', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto' }, [
			h('path', { class: 'seq-arrowhead seq-arrowhead--error', d: 'M 0 0 L 10 5 L 0 10 z' }, []),
		]),
	])

	const columnGroups = columns.map((column, index) => {
		const x = LEFT_MARGIN + index * COLUMN_WIDTH
		return h('g', { class: `seq-column seq-column--${column.kind}` }, [
			h('text', { class: 'seq-column-label', x, y: HEADER_HEIGHT - 14, 'text-anchor': 'middle' }, [column.label]),
			h('line', { class: 'seq-lifeline', x1: x, y1: HEADER_HEIGHT, x2: x, y2: lifelineBottom }, []),
		])
	})

	// Arrows render before nodes so the terminal nodes paint over the arrow ends (the arrowhead tucks into the target node). A cross-column arrow travels from the source lifeline to the near edge of the target node. A self-message (from === to — a self-delegation or self-return) renders as a small rectangular loopback to the right (call) or left (return) so the self-interaction reads as a distinct arrow rather than a zero-length line; the loopback lands back on the same lifeline, with the arrowhead pointing back at it.
	const messagePaths = messages.map((message, index) => {
		const y = HEADER_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2
		const fromX = columnX.has(message.from) ? columnX.get(message.from) : LEFT_MARGIN
		const toX = columnX.has(message.to) ? columnX.get(message.to) : LEFT_MARGIN
		const isLast = index === lastIndex
		const lineState = isLast ? act.lineState : null
		let d
		if (message.from === message.to) {
			const loopW = 20
			const loopH = 14
			if (message.direction === 'return') {
				d = `M ${fromX} ${y} h -${loopW} v ${loopH} h ${loopW}`
			} else {
				d = `M ${fromX} ${y} h ${loopW} v ${loopH} h -${loopW}`
			}
		} else {
			const nodeHalf = NODE_WIDTH / 2
			const endX = fromX < toX ? toX - nodeHalf : toX + nodeHalf
			d = `M ${fromX} ${y} L ${endX} ${y}`
		}
		return h('path', {
			class: lineClasses(index, lastIndex, lineState, message.direction),
			d,
			'marker-end': `url(#${markerIdFor(lineState)})`,
		}, [
			h('title', {}, [message.label]),
		])
	})

	// Terminal nodes: one per message on its target column. The last message's node carries the active/success/error highlight (its target state); for a return, the last message's source column also gets a node carrying the returning role/tool's outcome, mirroring the flow view's two-node highlight (active recipient + returning node). Past messages' nodes are neutral.
	const nodeGroups = messages.map((message, index) => {
		const y = HEADER_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2
		const isLast = index === lastIndex
		const targetState = isLast ? act.targetState : null
		const targetX = columnX.has(message.to) ? columnX.get(message.to) : LEFT_MARGIN
		return TerminalNode(h, targetX, y, targetState, message.label)
	})
	// The source node for the last message (a return's returning role/tool), rendered so the outcome color reads on that column too. Only present when the source carries a terminal outcome AND the message is not a self-message (from === to — a self-return's source and target share a column, so a separate source node would overlap the target).
	if (act.sourceState !== null && messages.length > 0) {
		const last = messages[lastIndex]
		if (last.from !== last.to) {
			const y = HEADER_HEIGHT + lastIndex * ROW_HEIGHT + ROW_HEIGHT / 2
			const sourceX = columnX.has(last.from) ? columnX.get(last.from) : LEFT_MARGIN
			nodeGroups.push(TerminalNode(h, sourceX, y, act.sourceState, last.label))
		}
	}
	// An extra active node on a column that is active but is neither the target nor the source of the last message — used for a terminal run whose last interaction did not target Human, so "You" still reads as active on the Human column.
	if (act.extraActiveColumn !== null && act.extraActiveColumn !== undefined && messages.length > 0) {
		const y = HEADER_HEIGHT + lastIndex * ROW_HEIGHT + ROW_HEIGHT / 2
		const extraX = columnX.has(act.extraActiveColumn) ? columnX.get(act.extraActiveColumn) : LEFT_MARGIN
		nodeGroups.push(TerminalNode(h, extraX, y, 'active', 'You'))
	}

	return h('svg', { class: 'sequence-view-svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMidYMid meet', xmlns: 'http://www.w3.org/2000/svg' }, [
		defs,
		...columnGroups,
		...messagePaths,
		...nodeGroups,
	])
}
