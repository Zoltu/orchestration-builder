// Dev-only playback harness for the flow-graph visualization.
// Loads the fixture scenarios and renders the current frame's visualization against the step-02 SVG primitives, with a slim scenario/playback bar at the top. This is throwaway iteration scaffolding, isolated behind its own entry page (playback.html) so it is removed cleanly when the visualization replaces it; it never touches the real run view in app.js. Scenario details live in the fixtures module and the plan, not on this page, so the rendered view is the only thing under analysis.
import { h, app } from './vendor/hyperapp.js'
import { fixtures } from './fixtures.js'
import { GraphEdge, GraphNode, nodeAnchor } from './svg-primitives.js'

const PLAY_INTERVAL_MS = 1200

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
	if (next >= total) return { ...state, playing: false }
	return { ...state, frameIndex: next }
}

function SelectScenario(state, event) {
	const index = Number(event.target.value)
	if (!Number.isInteger(index) || index < 0 || index >= fixtures.length) return state
	return { ...state, scenarioIndex: index, frameIndex: 0, playing: false }
}

function TogglePlay(state) {
	const total = currentFixture(state).frames.length
	if (!state.playing) {
		// Restart from the beginning when playback had reached the end.
		const startIndex = state.frameIndex >= total - 1 ? 0 : state.frameIndex
		return { ...state, frameIndex: startIndex, playing: true }
	}
	return { ...state, playing: false }
}

function Step(state, delta) {
	const total = currentFixture(state).frames.length
	const next = Math.max(0, Math.min(total - 1, state.frameIndex + delta))
	return { ...state, frameIndex: next, playing: false }
}

function Scrub(state, event) {
	const index = Number(event.target.value)
	if (!Number.isInteger(index) || index < 0 || index >= currentFixture(state).frames.length) return state
	return { ...state, frameIndex: index, playing: false }
}

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
		ThemeToggle(state),
	])
}

// --- Primitives demo --------------------------------------------------------
// Composes the SVG primitives at fixed coordinates using the current fixture's friendly labels, so the operator can review the visual foundation (tokens + nodes + edges + tooltip shell) in both light and dark. This is throwaway iteration scaffolding for the visualization phase; the real flow graph arrives in a later step.

function friendlyRoleLabel(config, role) {
	const entry = config.roles[role]
	if (entry === undefined) return role
	const label = entry.label
	if (label === undefined) return role
	return label.friendly ?? label.detailed ?? role
}

function translate(x, y) {
	return `translate(${x},${y})`
}

function PrimitivesDemo(state) {
	const fixture = currentFixture(state)
	const config = fixture.frames[0].config
	// Nodes are rooted at the viewBox edges (0-based coordinates); the inset that keeps them off the screen lives as HTML padding on the container (.pb-demo-svg in styles.css), not hardcoded into each child's position. This keeps moving a node a one-number translate change and lets the graph code stay free of layout chrome.
	const positions = {
		you: { x: 0, y: 0 },
		orchestrator: { x: 220, y: 0 },
		planner: { x: 440, y: 0 },
		coder: { x: 220, y: 130 },
		errorCoder: { x: 440, y: 130 },
	}
	return h('svg', { class: 'pb-demo-svg', viewBox: '0 0 600 194', preserveAspectRatio: 'xMidYMid meet', xmlns: 'http://www.w3.org/2000/svg' }, [
		GraphEdge(h, { fromAnchor: nodeAnchor(positions.you.x, positions.you.y, 'right'), toAnchor: nodeAnchor(positions.orchestrator.x, positions.orchestrator.y, 'left'), state: 'flowing' }),
		GraphEdge(h, { fromAnchor: nodeAnchor(positions.orchestrator.x, positions.orchestrator.y, 'right'), toAnchor: nodeAnchor(positions.planner.x, positions.planner.y, 'left'), state: 'returning' }),
		GraphEdge(h, { fromAnchor: nodeAnchor(positions.orchestrator.x, positions.orchestrator.y, 'bottom'), toAnchor: nodeAnchor(positions.coder.x, positions.coder.y, 'top'), state: 'static' }),
		GraphEdge(h, { fromAnchor: nodeAnchor(positions.coder.x, positions.coder.y, 'right'), toAnchor: nodeAnchor(positions.errorCoder.x, positions.errorCoder.y, 'left'), state: 'error' }),
		h('g', { transform: translate(positions.you.x, positions.you.y) }, [GraphNode(h, { label: 'You', sublabel: 'Human', active: true })]),
		h('g', { transform: translate(positions.orchestrator.x, positions.orchestrator.y) }, [GraphNode(h, { label: friendlyRoleLabel(config, 'orchestrator'), sublabel: 'orchestrator', counter: 3, costTime: 12, costTokens: 5400 })]),
		h('g', { transform: translate(positions.planner.x, positions.planner.y) }, [GraphNode(h, { label: friendlyRoleLabel(config, 'planner'), sublabel: 'planner', status: 'success' })]),
		h('g', { transform: translate(positions.coder.x, positions.coder.y) }, [GraphNode(h, { label: friendlyRoleLabel(config, 'coder'), sublabel: 'coder', active: true, costTime: 8, costTokens: 640 })]),
		h('g', { transform: translate(positions.errorCoder.x, positions.errorCoder.y) }, [GraphNode(h, { label: friendlyRoleLabel(config, 'coder'), sublabel: 'attempt 1', status: 'error', counter: 1 })]),
	])
}

function view(state) {
	return h('div', { class: 'pb' }, [
		PlaybackControls(state),
		PrimitivesDemo(state),
	])
}

app({
	init: {
		scenarioIndex: 0,
		frameIndex: 0,
		playing: false,
		theme: 'auto',
	},
	view,
	subscriptions: (state) => [state.playing && onEvery(Tick, PLAY_INTERVAL_MS)],
	node: document.getElementById('app'),
})

applyTheme('auto')
