// Dev-only playback harness for the flow-graph visualization.
// Loads the fixture scenarios and renders the current frame's visualization against the SVG primitives, with a slim scenario/playback bar at the top. This is throwaway iteration scaffolding, isolated behind its own entry page (playback.html) so it is removed cleanly when the visualization replaces it; it never touches the real run view in app.js. Scenario details live in the fixtures module, not on this page, so the rendered view is the only thing under analysis.
import { h, app } from './vendor/hyperapp.js'
import { fixtures } from './fixtures.js'
import { renderFlowView, deriveFlowAnimation, deriveLifecycle, deriveNowCaption, DEFAULT_MIN_COLUMNS } from './flow-view.js'
import { deriveSequenceDiagram, deriveSequenceActivity, renderSequenceDiagram, buildCallEdgeColumns, isRealDelegation, buildColumns, filterOrphanToolCalls } from './sequence-diagram.js'
import { createMarkdownRenderer } from './markdown-render.js'
import { QuestionModal, derivePendingQuestion } from './question-modal.js'
import { ResultModal, deriveTerminalResult } from './result-modal.js'
import { Tooltip, deriveTooltipForNode, deriveTooltipForEdge } from './tooltip.js'

// The question modal renders agent-authored question text/context as sanitized Markdown, so the harness shares the product client's Markdown pipeline rather than a local copy. Constructed once against this module's `h` and reused for every modal render.
const renderMarkdown = createMarkdownRenderer(h)

const PLAY_INTERVAL_MS = 1200

// The effort channel's six stops, quality-graded. Duplicated from the product client because app.js pulls in runtime dependencies the static playback harness does not serve; the harness is throwaway iteration scaffolding, so a small local copy keeps it self-contained.
const EFFORT_LABELS = ['fastest', 'quick', 'moderate', 'standard', 'thorough', 'highest quality']

function effortLabel(effort) {
	if (typeof effort !== 'number' || !Number.isInteger(effort) || effort < 0 || effort > 5) return '—'
	return EFFORT_LABELS[effort] ?? '—'
}

// Compact elapsed/token formatters for the ambient surfaces. They mirror the product client's formatting intent (locale-independent, terse) without its Intl dependency so the harness stays browser-pure.
function formatElapsedShort(seconds) {
	if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '—'
	if (seconds < 60) return `${Math.round(seconds)}s`
	if (seconds >= 3600) {
		const hours = Math.floor(seconds / 3600)
		const remainingMinutes = Math.round((seconds % 3600) / 60)
		return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`
	}
	const minutes = Math.floor(seconds / 60)
	const remaining = Math.round(seconds % 60)
	return remaining === 0 ? `${minutes}m` : `${minutes}m ${remaining}s`
}

function formatTokensShort(tokens) {
	if (tokens === null || tokens === undefined || typeof tokens !== 'number' || !Number.isFinite(tokens)) return '—'
	if (tokens >= 1000) return `${Math.round(tokens / 100) / 10}k`
	return String(tokens)
}

// The active fixture is derived from scenarioIndex rather than stored, so the view can never drift from the selector: changing the dropdown only needs to update scenarioIndex, and every reader sees the new scenario on the next render.
function currentFixture(state) {
	return fixtures[state.scenarioIndex]
}

// hyperapp's @hyperapp/time package is not vendored; the timer subscriber is defined once here so its reference stays stable across renders (patchSubs compares subscriber references to decide whether to restart the subscription).
function onEverySubscriber(dispatch, payload) {
	const id = setInterval(() => dispatch(payload.action), payload.interval)
	return () => clearInterval(id)
}

function onEvery(action, interval) {
	return [onEverySubscriber, { action, interval }]
}

// --- Actions ---------------------------------------------------------------
// Advancing past the final frame stops playback so the harness rests on the settled view rather than looping silently.

function Tick(state) {
	if (!state.playing) return state
	const total = currentFixture(state).frames.length
	const next = state.frameIndex + 1
	if (next >= total) return { ...state, playing: false, tooltip: null }
	return { ...state, frameIndex: next, tooltip: null, resultModalOpen: computeResultModalOpen(state.scenarioIndex, state.frameIndex, next, state.resultModalOpen) }
}

function SelectScenario(state, event) {
	const index = Number(event.target.value)
	if (!Number.isInteger(index) || index < 0 || index >= fixtures.length) return state
	return { ...state, scenarioIndex: index, frameIndex: 0, playing: false, tooltip: null, resultModalOpen: computeResultModalOpen(index, -1, 0, false) }
}

function TogglePlay(state) {
	const total = currentFixture(state).frames.length
	if (!state.playing) {
		// Restart from the beginning when playback had reached the end.
		const startIndex = state.frameIndex >= total - 1 ? 0 : state.frameIndex
		return { ...state, frameIndex: startIndex, playing: true, tooltip: null, resultModalOpen: computeResultModalOpen(state.scenarioIndex, state.frameIndex, startIndex, state.resultModalOpen) }
	}
	return { ...state, playing: false }
}

function Step(state, delta) {
	const total = currentFixture(state).frames.length
	const next = Math.max(0, Math.min(total - 1, state.frameIndex + delta))
	return { ...state, frameIndex: next, playing: false, tooltip: null, resultModalOpen: computeResultModalOpen(state.scenarioIndex, state.frameIndex, next, state.resultModalOpen) }
}

function Scrub(state, event) {
	const index = Number(event.target.value)
	if (!Number.isInteger(index) || index < 0 || index >= currentFixture(state).frames.length) return state
	return { ...state, frameIndex: index, playing: false, tooltip: null, resultModalOpen: computeResultModalOpen(state.scenarioIndex, state.frameIndex, index, state.resultModalOpen) }
}

// The pending ask_human question for the current frame, or undefined when none is waiting. Derived from the frame's run-view question history (an entry without an answer is one the human has not yet answered) so the modal appears exactly on the frames that model a pending question.
function pendingQuestionOf(state) {
	return derivePendingQuestion(currentFrame(state).runView)
}

// Answering in the harness advances to the next frame, which models the answered state (the question history entry gains its answer and the flow graph shows the lingering return leg). There is no backend to POST to from the dev harness, so the frame advance IS the answer; the modal dismisses because the next frame has no pending question.
function SubmitQuestionAnswer(state, event) {
	event.preventDefault()
	const total = currentFixture(state).frames.length
	const next = Math.min(total - 1, state.frameIndex + 1)
	return { ...state, frameIndex: next, playing: false, tooltip: null, resultModalOpen: computeResultModalOpen(state.scenarioIndex, state.frameIndex, next, state.resultModalOpen) }
}

// --- Result modal ----------------------------------------------------------
// The result modal fires once when the selected run transitions to a terminal status (success/error/needs_clarification), then dismisses; a "View result" CTA in the control bar re-opens it on demand. The harness is fixture-driven, so "transition" is the frame-to-frame status change: a frame that newly reaches a terminal status opens the modal, a move back to a non-terminal frame closes it, and a move within the terminal tail leaves the current open state alone (no re-fire on every render). There is no backend to record "already shown" across runs, so the transition derivation is pure from frameIndex.

function isTerminalStatus(status) {
	return status === 'success' || status === 'error' || status === 'needs_clarification'
}

// The run-view status of a scenario's frame, or null when the frame is absent (a negative index means "no previous frame in this scenario" — a fresh scenario switch).
function frameStatusAt(scenarioIndex, frameIndex) {
	if (frameIndex < 0) return null
	const fixture = fixtures[scenarioIndex]
	if (fixture === undefined) return null
	const frame = fixture.frames[frameIndex]
	return frame === undefined ? null : frame.runView.status
}

// Whether the result modal should be open after a frame transition into `newFrameIndex` (within one scenario). A fresh arrival (oldFrameIndex < 0) opens the modal iff the new frame is terminal; a transition from non-terminal to terminal opens it; a move within the terminal tail preserves the current open state so the modal does not re-flash on every frame; a move to a non-terminal frame closes it.
function computeResultModalOpen(scenarioIndex, oldFrameIndex, newFrameIndex, currentlyOpen) {
	const newStatus = frameStatusAt(scenarioIndex, newFrameIndex)
	if (!isTerminalStatus(newStatus)) return false
	const oldStatus = frameStatusAt(scenarioIndex, oldFrameIndex)
	if (!isTerminalStatus(oldStatus)) return true
	return currentlyOpen
}

// A label naming which run a modal belongs to, mirroring the question modal's convention: the run id when present, else the task text, else null. Extracted so the question and result modals share one derivation.
function runLabelOf(runView) {
	if (typeof runView.runId === 'string' && runView.runId !== '') return runView.runId
	if (typeof runView.task === 'string' && runView.task !== '') return runView.task
	return null
}

// Copies the raw error JSON to the clipboard when the clipboard API is available. A leaf side-effect in the harness (the product client will do the same against navigator.clipboard); the component receives the handler as an injection so its wiring is exercisable in tests with a fake.
function copyRawError(rawJson) {
	const clipboard = navigator?.clipboard
	if (clipboard !== undefined && typeof clipboard.writeText === 'function') clipboard.writeText(rawJson)
}

function OpenResultModal(state) {
	return { ...state, resultModalOpen: true, tooltip: null }
}

function CloseResultModal(state) {
	return { ...state, resultModalOpen: false }
}

// --- Tooltip (node/edge inspector) ------------------------------------------
// Hovering a flow-view node or edge opens a friendly-formatted detail card; the pointer leaving the hovered element closes it. The card is an HTML overlay positioned at the pointer (the SVG cannot host the sanitized-Markdown vnodes or a wrapping <pre> the card renders), so it lives as a sibling of the flow SVG inside `.pb-flow`. The card is `pointer-events: none` (see styles.css) so it never becomes the hover target itself — leaving the node/edge geometry is what dismisses it, with no flicker and no need for a close-on-empty-click or a hover-bridge. The tooltip clears on every frame change so a card opened on a node that has since departed never lingers stale.

function OpenTooltip(state, payload) {
	return { ...state, tooltip: payload }
}

function CloseTooltip(state) {
	if (state.tooltip === null) return state
	return { ...state, tooltip: null }
}

// The pointer coordinates from a DOM event, with a 0 fallback for a synthetic event the tests/harness might pass. `clientX`/`clientY` are viewport-relative, which is what the `position: fixed` card positions against.
function pointerX(event) {
	return event !== null && event !== undefined && typeof event.clientX === 'number' ? event.clientX : 0
}
function pointerY(event) {
	return event !== null && event !== undefined && typeof event.clientY === 'number' ? event.clientY : 0
}

// Resolves the card's inline positioning so it never overflows the viewport: when the pointer is near the right or bottom edge, the card flips to anchor its right/bottom edge to the pointer instead of its left/top. The estimates are upper bounds on the card's footprint; the CSS `max-width`/`max-height` clamp the real size, so an over-estimate only flips a little early (safe) rather than letting the card clip off-screen.
function tooltipStyle(clientX, clientY) {
	const viewportWidth = window.innerWidth
	const viewportHeight = window.innerHeight
	const margin = 12
	const estimatedWidth = 380
	const estimatedHeight = 280
	const style = {}
	if (clientX + estimatedWidth + margin > viewportWidth && clientX - estimatedWidth - margin > 0) {
		style.right = `${Math.max(margin, viewportWidth - clientX)}px`
	} else {
		style.left = `${Math.max(margin, clientX + margin)}px`
	}
	if (clientY + estimatedHeight + margin > viewportHeight && clientY - estimatedHeight - margin > 0) {
		style.bottom = `${Math.max(margin, viewportHeight - clientY)}px`
	} else {
		style.top = `${Math.max(margin, clientY + margin)}px`
	}
	return style
}

// Builds the onmouseenter handler for a main-area/top-bar node: derives the friendly detail from the node and the current frame at hover time and opens the card at the pointer. Returning a function (rather than a `[Action, payload]` tuple) lets the handler read the live state's frame and the event's coordinates at hover time. The matching onmouseleave is the shared `CloseTooltip` (the pointer leaving the node dismisses the card).
function activateNodeTooltip(node) {
	return (state, event) => {
		const derived = deriveTooltipForNode(node, currentFrame(state))
		return OpenTooltip(state, { ...derived, style: tooltipStyle(pointerX(event), pointerY(event)) })
	}
}

function activateEdgeTooltip(edge) {
	return (state, event) => {
		const derived = deriveTooltipForEdge(edge, currentFrame(state))
		return OpenTooltip(state, { ...derived, style: tooltipStyle(pointerX(event), pointerY(event)) })
	}
}

const flowInteractions = { onNodeActivate: activateNodeTooltip, onEdgeActivate: activateEdgeTooltip, onLeave: CloseTooltip }

// The theme toggle pins `data-theme` on the root element so the operator can review the visual foundation in both light and dark regardless of the OS setting. `auto` clears the attribute so the browser's prefers-color-scheme drives the tokens.
function applyTheme(theme) {
	const root = document.documentElement
	if (theme === 'auto') delete root.dataset.theme
	else root.dataset.theme = theme
}

function SetTheme(state, theme) {
	applyTheme(theme)
	return { ...state, theme }
}

// The Flow/Sequence toggle switches the run-view centerpiece. Flow is the product surface (default); Sequence is the debug surface behind the toggle. The selection is plain state so the view re-renders on switch with no side effects.
function SetView(state, view) {
	if (view !== 'flow' && view !== 'sequence') return state
	return { ...state, view }
}

// --- View ------------------------------------------------------------------

function ControlButton(text, onclick, disabled) {
	return h('button', { type: 'button', class: 'pb-btn', disabled: disabled === true, onclick }, text)
}

function ThemeButton(label, theme, current) {
	return h('button', { type: 'button', class: `pb-theme-btn${theme === current ? ' is-active' : ''}`, onclick: [SetTheme, theme] }, label)
}

function ThemeToggle(state) {
	return h('div', { class: 'pb-theme-toggle' }, [
		ThemeButton('Auto', 'auto', state.theme),
		ThemeButton('Light', 'light', state.theme),
		ThemeButton('Dark', 'dark', state.theme),
	])
}

// The view toggle is a debug affordance, not the product surface: Flow stays the obvious default and Sequence reads as the secondary investigation view. It mirrors the theme toggle's segmented control so the two debug affordances sit together.
function ViewButton(label, view, current) {
	return h('button', { type: 'button', class: `pb-view-btn${view === current ? ' is-active' : ''}`, onclick: [SetView, view] }, label)
}

function ViewToggle(state) {
	return h('div', { class: 'pb-view-toggle', role: 'group', 'aria-label': 'run view' }, [
		ViewButton('Flow', 'flow', state.view),
		ViewButton('Sequence', 'sequence', state.view),
	])
}

function PlaybackControls(state) {
	const fixture = currentFixture(state)
	const total = fixture.frames.length
	const index = state.frameIndex
	const playing = state.playing
	return h('div', { class: 'pb-controls' }, [
		h('label', { class: 'pb-scenario-select' }, [
			'Scenario',
			h('select', { value: String(state.scenarioIndex), onchange: SelectScenario }, fixtures.map((scenario, index) => h('option', { value: String(index) }, scenario.label))),
		]),
		ControlButton('\u23ed', [Step, total - 1], false),
		ControlButton(playing ? 'Pause' : 'Play', [TogglePlay, null], false),
		ControlButton('\u23ed next', [Step, 1], false),
		h('input', { class: 'pb-scrub', type: 'range', min: '0', max: String(total - 1), step: '1', value: String(index), oninput: Scrub }),
		h('span', { class: 'pb-frame-counter' }, `frame ${index + 1} / ${total}`),
		ViewToggle(state),
		ThemeToggle(state),
	])
}

// --- Flow view -------------------------------------------------------------
// Renders the current frame's hand-authored FlowModel as the two-component flow view (history top bar + active-flow main area). The model is current-state, not history, so the main area stays calm as a run progresses; this is throwaway iteration scaffolding for the visualization phase, iterated against the fixtures until step 13 swaps the fixture model for the live /api/runs/:id/flow endpoint.

// The number of call-depth columns a frame's main area occupies (its deepest node's column + 1). The "You" root always sits at column 0, so this is at least 1.
function frameColumnCount(frame) {
	const nodes = frame.flowModel.mainArea.nodes
	let maxColumn = 0
	for (const node of nodes) {
		if (node.column > maxColumn) maxColumn = node.column
	}
	return maxColumn + 1
}

// The main-area canvas floor: the most columns the run has needed at any point from its start up to the current frame, never below the 5-column default. Because frameIndex only increases during forward playback, this only grows — a layer that appeared and then finished does not shrink the canvas back, so the scale factor stays stable and the last layer doesn't thrash. Selecting a different scenario recomputes from its frame 0, which resets the mark for the new run.
function flowColumnHighWater(state) {
	const fixture = currentFixture(state)
	let highWater = DEFAULT_MIN_COLUMNS
	for (let i = 0; i <= state.frameIndex; i++) {
		const count = frameColumnCount(fixture.frames[i])
		if (count > highWater) highWater = count
	}
	return highWater
}

// The lifecycle descriptor is the diff between the previous and current frames' FlowModels: which main-area nodes are newly arrived (entering) and which left the main area for a top-bar slot (departing, merging into the slot if it already existed). The harness re-derives it each render from frameIndex-1 and frameIndex, so advancing/scrubbing a frame re-runs the entering and shrink-up animations deterministically. The first frame of a scenario has no previous frame, so nothing enters or departs.
function flowLifecycle(state) {
	const fixture = currentFixture(state)
	const frames = fixture.frames
	const current = frames[state.frameIndex].flowModel
	if (state.frameIndex === 0) return deriveLifecycle(undefined, current)
	const previous = frames[state.frameIndex - 1].flowModel
	return deriveLifecycle(previous, current)
}

function FlowView(state) {
	const fixture = currentFixture(state)
	const model = fixture.frames[state.frameIndex].flowModel
	// The terminal-result CTA renders as a standard node at column 1 (to the right of You) on every terminal frame — always present, never removed. It is active (blue, with a flowing You→CTA edge) while the result modal is open, and inactive (grey edge, no pulse) when the modal is closed. Clicking it re-opens the modal. The `tone` colors the face — accent blue for success/needs-clarification, error red for a failed run.
	const terminal = deriveTerminalResult(currentFrame(state).runView)
	const cta = terminal !== undefined
		? { label: ctaLabel(terminal.status), active: state.resultModalOpen, tone: terminal.status === 'error' ? 'error' : 'accent', onclick: [OpenResultModal, null] }
		: undefined
	return renderFlowView(h, model, flowColumnHighWater(state), flowLifecycle(state), cta, flowInteractions)
}

function ctaLabel(status) {
	if (status === 'error') return 'View error'
	return 'View result'
}

// The Sequence view: the run rendered as a temporal sequence diagram (columns = Human + roles + tools; messages = horizontal lines ordered by timestamp). It is the debug/investigation surface behind the Flow/Sequence toggle, iterated against the fixtures through the playback harness. Static render this step; the hover inspector and zoom/pan are a later step.
//
// Unlike the flow view (which is current-state and consumes only the current frame), the sequence diagram is a *timeline* — it must grow as the run progresses, showing every operation from the run's start up to the current frame. A single fixture frame's `recentLog` is only a 2–3 event sliding window (the flow view needs just the current state), so deriving the diagram from it alone would collapse the timeline to the last couple of events. The harness therefore reconstructs the full log by accumulating each frame's `recentLog` window up to the current frameIndex: the windows overlap contiguously (each is the most-recent N events at that point in the run), so their union, deduplicated by timestamp+type+summary and taken in first-seen order, is the chronological full log. First-seen order is chronological because the window only slides forward — an event appearing for the first time in frame N is always newer than any event that appeared in a frame before N. When the live backend is wired in (step 13), the live run view's `recentLog` (capped server-side at a large page) is the full log already, so the accumulation is a fixture-harness concern that step 13 drops.
function accumulateRecentLog(state) {
	const fixture = currentFixture(state)
	const seen = new Set()
	const accumulated = []
	for (let i = 0; i <= state.frameIndex; i++) {
		const frameValue = fixture.frames[i]
		const runView = frameValue.runView
		const recentLog = runView !== null && runView !== undefined && Array.isArray(runView.recentLog) ? runView.recentLog : []
		// The call-edge set for THIS frame: an agent_call whose parent→child pair doesn't appear as a call edge in the frame where it first appears is an overseer spawn (e.g. a loop_detector in its own row, not a child of the caller), not a real delegation — skip it. Checking the frame where the agent_call FIRST appears (not the current frame) keeps a past delegation in the timeline even after the child departs the main area.
		const callEdgeColumns = buildCallEdgeColumns(frameValue.flowModel)
		const columnIds = new Set(buildColumns(frameValue.config).map((column) => column.id))
		for (const entry of recentLog) {
			if (entry === null || typeof entry !== 'object') continue
			const key = `${entry.timestamp}|${entry.type}|${entry.summary}`
			if (seen.has(key)) continue
			// Filter overseer agent_calls: a loop_detector spawned via agent_call but sitting in its own row (no call edge from the caller) is not a real delegation — skip it so the sequence diagram matches the flow view's structure.
			if (entry.type === 'agent_call' && !isRealDelegation(entry.payload, callEdgeColumns, columnIds)) continue
			seen.add(key)
			accumulated.push(entry)
		}
	}
	// Drop orphan tool_calls (calls without matching tool_results in the accumulated log) unless the tool is currently in-flight. The fixture's small recentLog windows don't always capture complete call+result pairs — an orphan call is half an interaction and would mislead. A tool_call whose tool is currently flowing in the flow view is kept (it's the in-flight operation whose result hasn't arrived yet).
	const frame = currentFrame(state)
	const flowAnimation = deriveFlowAnimation(frame.flowModel)
	const flowingToolNames = flowingToolNamesOf(frame.flowModel, flowAnimation)
	return filterOrphanToolCalls(accumulated, flowingToolNames)
}

// The set of tool names that are currently in-flight (the target of a flowing edge in the flow view). Used to keep an orphan tool_call whose tool is the current in-flight operation.
function flowingToolNamesOf(flowModel, flowAnimation) {
	const names = new Set()
	const nodes = flowModel !== null && flowModel !== undefined && flowModel.mainArea !== null && flowModel.mainArea !== undefined && Array.isArray(flowModel.mainArea.nodes) ? flowModel.mainArea.nodes : []
	const edges = flowModel !== null && flowModel !== undefined && flowModel.mainArea !== null && flowModel.mainArea !== undefined && Array.isArray(flowModel.mainArea.edges) ? flowModel.mainArea.edges : []
	const edgeStates = flowAnimation !== null && flowAnimation !== undefined && Array.isArray(flowAnimation.edgeStates) ? flowAnimation.edgeStates : []
	const nodeById = new Map()
	for (const node of nodes) {
		if (node !== null && typeof node === 'object' && typeof node.id === 'string') nodeById.set(node.id, node)
	}
	for (let i = 0; i < edges.length; i++) {
		if (edgeStates[i] !== 'flowing') continue
		const edge = edges[i]
		if (edge === null || typeof edge !== 'object') continue
		const target = nodeById.get(edge.to)
		if (target === undefined) continue
		if (target.kind === 'tool' && typeof target.id === 'string') names.add(target.id)
	}
	return names
}

function SequenceView(state) {
	const frame = currentFrame(state)
	const runView = { ...frame.runView, recentLog: accumulateRecentLog(state) }
	const diagram = deriveSequenceDiagram(frame.config, runView)
	const flowAnimation = deriveFlowAnimation(frame.flowModel)
	const activity = deriveSequenceActivity(frame.flowModel, flowAnimation, diagram, frame.runView.status)
	return renderSequenceDiagram(h, diagram, activity)
}

// The friendly detail card for the currently-open tooltip, or null when none is open. Positioned `fixed` at the pointer via the inline `style` resolved at hover time (flipped to stay on screen), so the card overlays the flow view without claiming layout. The card is `pointer-events: none` (styles.css) and carries no chrome — it is a read-only hover inspector that disappears when the pointer leaves the hovered node/edge.
function TooltipOverlay(state) {
	const tooltip = state.tooltip
	if (tooltip === null) return null
	return Tooltip(h, {
		title: tooltip.title,
		sections: tooltip.sections,
		renderMarkdown,
		style: tooltip.style,
	})
}

// The current frame's config + runView + flowModel, used by the product surfaces that wrap the flow view. Derived from the same frame the FlowView renders so the surfaces never drift from the graph.
function currentFrame(state) {
	return currentFixture(state).frames[state.frameIndex]
}

// A quiet, always-present strip in the page border showing elapsed · tokens · effort for the active run. It is the most subdued of the two product surfaces — ambient, not focal — so it carries a small font and the subtle text color.
function CostStrip(state) {
	const runView = currentFrame(state).runView
	const budgets = runView.budgets
	const effort = runView.effort
	const effortText = effort !== null ? `${effort} ${effortLabel(effort)}` : '—'
	return h('div', { class: 'pb-cost-strip' }, [
		h('span', { class: 'pb-cost-item' }, `elapsed ${formatElapsedShort(budgets.elapsedSeconds)}`),
		h('span', { class: 'pb-cost-sep' }, '·'),
		h('span', { class: 'pb-cost-item' }, `tokens ${formatTokensShort(budgets.tokensUsed)}`),
		h('span', { class: 'pb-cost-sep' }, '·'),
		h('span', { class: 'pb-cost-item' }, `effort ${effortText}`),
	])
}

// A single plain-language line directly under the main area, derived from the active role/tool's friendly description. It is the most prominent of the two surfaces — the one a non-developer reads to know what is happening — so it carries a larger font and the accent color.
function NowCaption(state) {
	const frame = currentFrame(state)
	const caption = deriveNowCaption(frame.config, frame.runView, frame.flowModel)
	return h('p', { class: 'pb-now-caption' }, caption)
}

function view(state) {
	const frame = currentFrame(state)
	const runView = frame.runView
	const runLabel = runLabelOf(runView)
	// The centerpiece switches on the Flow/Sequence toggle. The flow centerpiece carries its product surfaces (now caption, hover tooltip); the sequence centerpiece is the static debug diagram. The question and result modals overlay the run view regardless of which centerpiece is below, so a pending question or a terminal result is surfaced in either view.
	const centerpiece = state.view === 'sequence'
		? [SequenceView(state)]
		: [FlowView(state), NowCaption(state), TooltipOverlay(state)]
	const flowChildren = [...centerpiece]
	// The question modal overlays the run view (the flow area), not the whole page, so a future multi-run world can switch away and back. It appears only on frames that model a pending ask_human question.
	const pending = pendingQuestionOf(state)
	if (pending !== undefined) {
		flowChildren.push(QuestionModal(h, { question: pending, runLabel, renderMarkdown, onSubmit: SubmitQuestionAnswer, answerPending: false }))
	}
	// The result modal overlays the run view on terminal completion: it auto-fires once when the run transitions to a terminal status (success/error/needs_clarification). The "View result" call-to-action is a standard node in the flow SVG (rendered by FlowView at column 1) that is always present on a terminal frame — blue with a flowing You→CTA edge while the modal is open, grey with no edge when the modal is closed — so the result details are always one click away.
	const terminal = deriveTerminalResult(runView)
	if (terminal !== undefined && state.resultModalOpen) {
		flowChildren.push(ResultModal(h, { descriptor: terminal, runLabel, renderMarkdown, onCopyRaw: copyRawError, onClose: CloseResultModal }))
	}
	return h('div', { class: 'pb' }, [
		CostStrip(state),
		PlaybackControls(state),
		h('div', { class: 'pb-flow' }, flowChildren),
	])
}

app({
	init: {
		scenarioIndex: 0,
		frameIndex: 0,
		playing: false,
		theme: 'auto',
		view: 'flow',
		resultModalOpen: false,
		tooltip: null,
	},
	view,
	subscriptions: (state) => [state.playing && onEvery(Tick, PLAY_INTERVAL_MS)],
	node: document.getElementById('app'),
})

applyTheme('auto')
