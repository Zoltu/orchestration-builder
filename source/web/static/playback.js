// Dev-only playback harness for the flow-graph visualization.
// Loads the fixture scenarios and renders the current frame's visualization against the SVG primitives, with a slim scenario/playback bar at the top. This is throwaway iteration scaffolding, isolated behind its own entry page (playback.html) so it is removed cleanly when the visualization replaces it; it never touches the real run view in app.js. Scenario details live in the fixtures module, not on this page, so the rendered view is the only thing under analysis.
import { h, app } from './vendor/hyperapp.js'
import { fixtures } from './fixtures.js'
import { renderFlowView, deriveLifecycle, deriveNowCaption, DEFAULT_MIN_COLUMNS } from './flow-view.js'

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
	return renderFlowView(h, model, flowColumnHighWater(state), flowLifecycle(state))
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
	return h('div', { class: 'pb' }, [
		CostStrip(state),
		PlaybackControls(state),
		h('div', { class: 'pb-flow' }, [
			h('div', { class: 'flow-view' }, [FlowView(state)]),
			NowCaption(state),
		]),
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
