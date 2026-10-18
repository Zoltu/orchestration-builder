// The browser run stage: the one entrypoint for the flow and sequence renderings, their layout and memoization, and the ambient now/cost reads.
//
// The stage is browser-only. It imports the shared interaction model, label resolver, and browser-safe siblings, and it takes `h` from the caller so it stays free of hyperapp coupling. It never imports the app, the demo harness, or server code.
//
// Public contract:
// - `createRunStage({ roleNames, roleOrder })` closes over the guild's full agent-role list (for accent assignment), the guild-declared role order (for participant ordering), the flow column high-water mark, and the stage memo.
// - `configure({ roleNames, roleOrder })` applies a guild config that arrived after construction in place: the accent resolver and ordering update, the flow column high-water mark is preserved, and the stage memo is reset because its output depends on the config. The app calls this when `/api/config` lands after the first flow frame rather than recreating the stage.
// - `render(h, inputs)` returns the stage vnode for the current frame: the flow view's `<svg>` in flow mode and the sequence view's `<svg>` in sequence mode. The host supplies its own sequence scroll container; the stage deliberately returns the SVG root so an SVG-namespace host such as the demo can mount it directly. When every memo-visible input is unchanged it returns the SAME vnode object by reference; hyperapp's `oldVNode === newVNode` short-circuit then skips the DOM diff. Callers must mount that vnode at exactly ONE tree position and must not reuse it across positions, because hyperapp mutates vnode `node` in place. `h` is part of the memo key, so callers must pass the same `h` function across renders.
// - `model`, its `participants`/`operations` arrays, and `guildParticipants` are immutable and reference-stable: the memo compares them by reference, so a caller that mutates an array in place or rebuilds it with equal contents will either miss an update or replay the SVG diff. Supply a new reference only when the data actually changed.
// - `now` is an optional per-render millisecond timestamp (a number, not a clock function). Supply it from the first render onward: an open call's elapsed is hydrated only at build time, so a stage first rendered without `now` keeps its unhydrated elapsed until another memo-visible input changes. A changed `now` alone does not invalidate the memo, so a clock-only tick reuses the mounted vnode and does not replay the SVG diff.
// - `rolesOnly` is a sequence-only lens: it filters both the model and the guild participant set, removing tools and interrupt-rooted rows; flow mode ignores it.
// - `cta.onclick` is forwarded to the terminal result CTA's click handler and fires only when the operator activates that CTA (it renders on terminal frames and is absent otherwise). `question.onclick` is forwarded to the pending ask_human Question overlay and fires only while that call is in flight; neither handler is invoked by the stage. Handlers are hyperapp event handlers (called with the host's state and the DOM event).
// - `nowCaption(model, labels, tier)` and `cost(model)` are the ambient reads the host renders outside the memoized SVG.
// - `sequenceActiveRowScrollTop` is the sequence layout helper the demo uses for scroll-to-active; the app follows the bottom of its own HTML scroll wrapper instead.
//
// The stage hides flow layout/top bar/lifecycle animation, sequence layout/columns, SVG primitives, stage memoization, participant ordering, and role accent assignment.

import type { InteractionModel } from '../interaction-model.js'
import { rolesOnlyModel, rolesOnlyParticipants, withLiveElapsed } from '../interaction-model.js'
import type { LabelResolver, LabelTier } from '../labels.js'
import type { H, Vnode } from '../../vendor/hyperapp.js'
import { createColumnTracker, deriveCostStrip, deriveLifecycle, deriveNowCaption, renderFlowView } from './flow-view.js'
import type { CostStrip } from './flow-view.js'
import { renderSequenceView } from './sequence-diagram.js'
import { createRoleAccentResolver } from './role-accents.js'
import { createStageMemo } from './stage-memo.js'
import type { StageRenderInputs } from './stage-memo.js'

export type { StageRenderInputs, StageViewMode } from './stage-memo.js'
export type { ClickHandler, CtaControls, QuestionControls } from './flow-view.js'
export { sequenceActiveRowScrollTop } from './sequence-diagram.js'

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

// Builds one stage per host/session. `roleNames` is the guild's full agent-role list, so accent assignment is deterministic and independent of which roles have appeared; `roleOrder` is the guild-declared display order. The column tracker lives here rather than at module scope so the stage stays a pure factory over its inputs while each host still gets one high-water mark for the page-load lifetime.
export function createRunStage(config: RunStageConfig): RunStage {
	let roleAccents = createRoleAccentResolver(config.roleNames)
	let roleOrder = config.roleOrder
	const columnTracker = createColumnTracker()
	let memo = buildMemo()

	function buildMemo(): (h: H, inputs: StageRenderInputs) => Vnode {
		return createStageMemo((h, inputs) => buildStageContent(h, inputs))
	}

	function buildStageContent(h: H, inputs: StageRenderInputs): Vnode {
		const model = inputs.now === undefined ? inputs.model : withLiveElapsed(inputs.model, inputs.now)
		const lifecycle = inputs.previousModel !== null ? deriveLifecycle(inputs.previousModel, model, roleOrder) : undefined
		if (inputs.viewMode === 'sequence') {
			const sequenceModel = inputs.rolesOnly ? rolesOnlyModel(model) : model
			const sequenceGuildParticipants = inputs.rolesOnly ? rolesOnlyParticipants(inputs.guildParticipants) : inputs.guildParticipants
			return renderSequenceView(h, sequenceModel, inputs.labels, inputs.tier, roleAccents, roleOrder, sequenceGuildParticipants)
		}
		return renderFlowView(h, model, inputs.labels, inputs.tier, roleAccents, roleOrder, lifecycle, inputs.cta, inputs.question, columnTracker)
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
