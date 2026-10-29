// The browser run stage: the one entrypoint for the flow and sequence renderings, their layout and memoization, and the ambient now/cost reads.
//
// The stage is browser-only. It imports the shared interaction model, label resolver, and browser-safe siblings, and it takes `h` from the caller so it stays free of hyperapp coupling. It never imports the app, the demo harness, or server code.
//
// Public contract:
// - `createRunStage({ roleNames, roleOrder })` closes over the guild's full agent-role list (for accent assignment), the guild-declared role order (for participant ordering), the flow column high-water mark, and the stage memo.
// - `configure({ roleNames, roleOrder })` applies a guild config that arrived after construction in place: the accent resolver and ordering update, the flow column high-water mark is preserved, and the stage memo is reset because its output depends on the config. The app calls this when `/api/config` lands after the first flow frame rather than recreating the stage.
// - `render(h, inputs)` returns the stage vnode for the current frame: the flow view's `<svg>` in flow mode, and the sequence stage wrapper in sequence mode. The sequence wrapper is always present; while a prompt exists it holds a compact question bar alongside the unchanged sequence surface, so toggling the bar never recreates the SVG. The surface is stable DOM: a `div` with the exported `SEQUENCE_SURFACE_CLASS`, whose keyed children are the header `<svg>` (`SEQUENCE_HEADER_CLASS`, key `header`) followed by the body `<svg>` (`SEQUENCE_BODY_CLASS`, key `body`). The host supplies the sequence scroll container; the stage owns the header/body pairing so a host cannot misalign them. When every memo-visible input is unchanged it returns the SAME vnode object by reference — for the sequence surface this covers both SVGs — and hyperapp's `oldVNode === newVNode` short-circuit then skips the DOM diff. Callers must mount that vnode at exactly ONE tree position and must not reuse it across positions, because hyperapp mutates vnode `node` in place. `h` is part of the memo key, so callers must pass the same `h` function across renders.
// - `model`, its `participants`/`operations` arrays, and `guildParticipants` are immutable and reference-stable: the memo compares them by reference, so a caller that mutates an array in place or rebuilds it with equal contents will either miss an update or replay the SVG diff. Supply a new reference only when the data actually changed.
// - `now` is an optional per-render millisecond timestamp (a number, not a clock function). Supply it from the first render onward: an open call's elapsed is hydrated only at build time, so a stage first rendered without `now` keeps its unhydrated elapsed until another memo-visible input changes. A changed `now` alone does not invalidate the memo, so a clock-only tick reuses the mounted vnode and does not replay the SVG diff.
// - `rolesOnly` is a sequence-only lens: it filters both the model and the guild participant set, removing tools and interrupt-rooted rows; flow mode ignores it.
// - `cta.onclick` is forwarded to the generic result/pause CTA's click handler and fires only when the operator activates that CTA. `question.onclick` is forwarded only while a derived prompt exists: the flow view overlays it on the answerer node when the active ask is locatable, or adds a stage bar when it is not, and the sequence view renders a compact question bar above the SVG regardless of the model ask. Any prompt suppresses the flow view's generic CTA so the question affordance is the single primary answer action; without a prompt the ask alone leaves that CTA in place. Neither handler is invoked by the stage. Handlers are hyperapp event handlers (called with the host's state and the DOM event).
// - `nowCaption(model, labels, tier)` and `cost(model)` are the ambient reads the host renders outside the memoized SVG.
// - `sequenceActiveRowScrollTop` is the sequence layout helper the demo uses for scroll-to-active; the app follows the bottom of its own HTML scroll wrapper instead.
//
// The stage hides flow layout/top bar/lifecycle animation, sequence layout/columns, SVG primitives, stage memoization, participant ordering, and role accent assignment.

import type { InteractionModel, Participant } from '../interaction-model.js'
import { rolesOnlyModel, rolesOnlyParticipants, withLiveElapsed } from '../interaction-model.js'
import type { LabelResolver, LabelTier } from '../labels.js'
import type { H, Vnode } from '../../vendor/hyperapp.js'
import { createColumnTracker, deriveCostStrip, deriveLifecycle, deriveNowCaption, renderFlowViewWithQuestionPlacement } from './flow-view.js'
import type { ClickHandler, CostStrip, QuestionControls } from './flow-view.js'
import { createQuestionActivationHandlers } from '../question-affordance.js'
import { renderSequenceView } from './sequence-diagram.js'
import { createRoleAccentResolver } from './role-accents.js'
import { createStageMemo } from './stage-memo.js'
import type { StageRenderInputs } from './stage-memo.js'

export type { StageRenderInputs, StageViewMode } from './stage-memo.js'
export type { ClickHandler, CtaControls, QuestionControls } from './flow-view.js'
export { SEQUENCE_BODY_CLASS, SEQUENCE_HEADER_CLASS, SEQUENCE_SURFACE_CLASS, sequenceActiveRowScrollTop } from './sequence-diagram.js'

// The stage-level question affordances are HTML bars rather than SVG overlays, so they keep a native hit target and keyboard behavior. The sequence wrapper is stable across bar toggles; its with-bar modifier is what reserves the header offset. The flow fallback bar stands in when a prompt exists but the flow model has no locatable active ask.
export const SEQUENCE_QUESTION_BUTTON_CLASS = 'sequence-question-button'
export const SEQUENCE_QUESTION_BAR_CLASS = 'sequence-question-bar'
export const SEQUENCE_QUESTION_STAGE_CLASS = 'sequence-question-stage'
export const SEQUENCE_QUESTION_STAGE_WITH_BAR_CLASS = 'sequence-question-stage--with-bar'
export const FLOW_QUESTION_BUTTON_CLASS = 'flow-question-bar-button'
export const FLOW_QUESTION_BAR_CLASS = 'flow-question-bar'
export const FLOW_QUESTION_STAGE_CLASS = 'flow-question-stage'

export interface RunStageConfig {
	roleNames: readonly string[]
	roleOrder: readonly string[]
}

// The stage's ambient reads are plain derivations over the model, so they carry no stage state and stay on the instance for one-call ergonomics.
export interface RunStage {
	render(h: H, inputs: StageRenderInputs): Vnode
	nowCaption(model: InteractionModel, labels: LabelResolver, tier: LabelTier): string
	cost(model: InteractionModel): CostStrip
	configure(config: RunStageConfig): void
}

// The stage-level answer affordance. It is a native HTML button so Enter/Space activation, focus, and the hit target come from the platform rather than from SVG hit-testing; the shared handlers stop its click from reaching the host's delegated inspector path and return the incoming state for every non-activation key.
function questionOnClick(question: QuestionControls | undefined): ClickHandler | null {
	if (question === undefined || question === null) return null
	if (typeof question.onclick !== 'function') return null
	return question.onclick
}

function renderQuestionButton(h: H, onclick: ClickHandler, buttonClass: string): Vnode {
	const { onclick: handleClick, onkeydown } = createQuestionActivationHandlers(onclick)
	return h('button', {
		type: 'button',
		class: buttonClass,
		title: 'Answer the run’s pending question',
		tabindex: 0,
		onclick: handleClick,
		onkeydown,
	}, ['Question for Human'])
}

// The sequence bar exists only while a derived prompt exists. The stage wrapper is always present so toggling the bar never recreates the sequence surface; the surface stays the first child and the bar is appended after it, then ordered above it by CSS. The with-bar modifier gates the reserved header offset so a question-free stage has no dead track.
function sequenceSurfaceWithQuestion(h: H, surface: Vnode, question: QuestionControls | undefined): Vnode {
	const onclick = questionOnClick(question)
	const children: Vnode[] = [surface]
	if (onclick !== null) {
		children.push(h('div', { class: SEQUENCE_QUESTION_BAR_CLASS }, [
			renderQuestionButton(h, onclick, SEQUENCE_QUESTION_BUTTON_CLASS),
		]))
	}
	const stageClass = onclick === null ? SEQUENCE_QUESTION_STAGE_CLASS : `${SEQUENCE_QUESTION_STAGE_CLASS} ${SEQUENCE_QUESTION_STAGE_WITH_BAR_CLASS}`
	return h('div', { class: stageClass }, children)
}

// When the prompt exists but the flow model has no locatable in-flight ask, the orange overlay cannot render. A stage bar above the SVG keeps an answer action available while the flow view suppresses its generic CTA.
function flowSurfaceWithQuestionFallback(h: H, surface: Vnode, questionOverlayVisible: boolean, question: QuestionControls | undefined): Vnode {
	const onclick = questionOnClick(question)
	if (onclick === null || questionOverlayVisible) return surface
	return h('div', { class: FLOW_QUESTION_STAGE_CLASS }, [
		h('div', { class: FLOW_QUESTION_BAR_CLASS }, [
			renderQuestionButton(h, onclick, FLOW_QUESTION_BUTTON_CLASS),
		]),
		surface,
	])
}

// Builds one stage per host/session. `roleNames` is the guild's full agent-role list, so accent assignment is deterministic and independent of which roles have appeared; `roleOrder` is the guild-declared display order. The column tracker lives here rather than at module scope so the stage stays a pure factory over its inputs while each host still gets one high-water mark for the page-load lifetime.
export function createRunStage(config: RunStageConfig): RunStage {
	let roleAccents = createRoleAccentResolver(config.roleNames)
	let roleOrder = config.roleOrder
	const columnTracker = createColumnTracker()
	let memo = buildMemo()

	function buildMemo(): (h: H, inputs: StageRenderInputs) => Vnode {
		return createStageMemo((h, inputs) => buildStageContent(h, inputs))
	}

	function sequenceViewInputs(inputs: StageRenderInputs): { model: InteractionModel; guildParticipants: readonly Participant[] } {
		const model = inputs.now === undefined ? inputs.model : withLiveElapsed(inputs.model, inputs.now)
		if (!inputs.rolesOnly) return { model, guildParticipants: inputs.guildParticipants }
		return { model: rolesOnlyModel(model), guildParticipants: rolesOnlyParticipants(inputs.guildParticipants) }
	}

	function buildStageContent(h: H, inputs: StageRenderInputs): Vnode {
		if (inputs.viewMode === 'sequence') {
			const sequenceInputs = sequenceViewInputs(inputs)
			const surface = renderSequenceView(h, sequenceInputs.model, inputs.labels, inputs.tier, roleAccents, roleOrder, sequenceInputs.guildParticipants)
			return sequenceSurfaceWithQuestion(h, surface, inputs.question)
		}
		const model = inputs.now === undefined ? inputs.model : withLiveElapsed(inputs.model, inputs.now)
		const lifecycle = inputs.previousModel !== null ? deriveLifecycle(inputs.previousModel, model, roleOrder) : undefined
		const flow = renderFlowViewWithQuestionPlacement(h, model, inputs.labels, inputs.tier, roleAccents, roleOrder, lifecycle, inputs.cta, inputs.question, columnTracker)
		return flowSurfaceWithQuestionFallback(h, flow.view, flow.questionOverlayVisible, inputs.question)
	}

	function configure(nextConfig: RunStageConfig): void {
		roleAccents = createRoleAccentResolver(nextConfig.roleNames)
		roleOrder = nextConfig.roleOrder
		memo = buildMemo()
	}

	return {
		render: (h, inputs) => memo(h, inputs),
		nowCaption: (model, labels, tier) => deriveNowCaption(model, labels, tier),
		cost: (model) => deriveCostStrip(model),
		configure,
	}
}
