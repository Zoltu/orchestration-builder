// The stage's memoization inputs and the manual single-position memo.
//
// The stage is the expensive O(operations) SVG, and the poll re-renders the whole view every tick. It is memoized on the stable inputs below rather than on the vendored hyperapp `Lazy`: `Lazy`'s `propsChanged` loops over `oldVNode.lazy` and `newVNode.lazy`, and when a tree position transitions from a non-Lazy vnode (the WatchScreen placeholder `<p>`) to a Lazy vnode the old side is `undefined`, so `undefined[k]` throws `TypeError: undefined is not an object`. The manual memo sidesteps that by never asking hyperapp to diff a lazy wrapper: it returns the SAME vnode object when the inputs are unchanged, and hyperapp's `patch` short-circuits on `oldVNode === newVNode` before it diffs or touches the DOM. The cached vnode is therefore reused at exactly one tree position across renders — never handed to two positions at once, which would let hyperapp's in-place `node` mutation corrupt the mounted tree (see docs/architecture.md "Web client").
//
// `now` is deliberately not part of the identity check: it is the host clock used at build time to hydrate an open call's elapsed, so a clock-only tick must reuse the mounted vnode rather than replay the SVG diff. The affordance controls are compared by the fields the renderer reads, so a fresh wrapper object carrying the same handlers does not defeat the memo. `h` is part of the key as well: the cached vnode was built by that `h`, so a different host must rebuild rather than mount a vnode shaped by the previous one.
//
// The model, its participant/operation arrays, and the guild participant set are treated as immutable and reference-stable. The memo compares them by reference, so mutating an array in place is invisible to the stage and rebuilding an equal array on every poll defeats the cache.
//
// The module is browser-pure TypeScript: it imports only sibling types and touches no external system.

import type { InteractionModel, Participant } from '../interaction-model.js'
import type { LabelResolver, LabelTier } from '../labels.js'
import type { H, Vnode } from '../../vendor/hyperapp.js'
import type { CtaControls, QuestionControls } from './flow-view.js'

// The stage's two render modes, mirroring app.ts's FlowViewMode. Declared here so this module stays free of the app.ts import cycle; the app's state field is the same union and assigns without a cast.
export type StageViewMode = 'flow' | 'sequence'

// Every per-render input the stage renders from. `model` stays the unhydrated model the host received; `now` (when supplied) fills an open call's elapsed at build time so a clock-only tick does not invalidate the memo. `guildParticipants` is the guild inventory the sequence view lays out its columns from, and is per-render because the demo transports a different inventory for each scenario while the app's config inventory arrives once.
export interface StageRenderInputs {
	model: InteractionModel
	previousModel: InteractionModel | null
	labels: LabelResolver
	tier: LabelTier
	viewMode: StageViewMode
	rolesOnly: boolean
	guildParticipants: readonly Participant[]
	cta?: CtaControls
	question?: QuestionControls
	now?: number
}

// Every field is either a reference that only changes when the server sends new data (or the operator changes a lens), a primitive that does not move on a poll tick, or an affordance field compared by identity. `now` is intentionally absent so a clock-only tick keeps the cached vnode.
function stageInputsEqual(a: StageRenderInputs, b: StageRenderInputs): boolean {
	return a.model === b.model
		&& a.previousModel === b.previousModel
		&& a.labels === b.labels
		&& a.tier === b.tier
		&& a.viewMode === b.viewMode
		&& a.rolesOnly === b.rolesOnly
		&& a.guildParticipants === b.guildParticipants
		&& ctaInputsEqual(a.cta, b.cta)
		&& questionInputsEqual(a.question, b.question)
}

function ctaInputsEqual(a: CtaControls | undefined, b: CtaControls | undefined): boolean {
	return (a === undefined ? undefined : a.onclick) === (b === undefined ? undefined : b.onclick)
}

function questionInputsEqual(a: QuestionControls | undefined, b: QuestionControls | undefined): boolean {
	return (a === undefined ? undefined : a.onclick) === (b === undefined ? undefined : b.onclick)
}

// A one-entry memo over the stage inputs. It caches the last built vnode together with the h function and inputs it was built from, so a caller passing a fresh-but-equal input object still hits the cache. The cached value is returned unchanged so hyperapp's `oldVNode === newVNode` short-circuit skips the diff entirely.
export function createStageMemo(build: (h: H, inputs: StageRenderInputs) => Vnode): (h: H, inputs: StageRenderInputs) => Vnode {
	let cached: { h: H; inputs: StageRenderInputs; value: Vnode } | null = null
	return (h, inputs) => {
		if (cached !== null && cached.h === h && stageInputsEqual(cached.inputs, inputs)) {
			cached = { h, inputs, value: cached.value }
			return cached.value
		}
		const value = build(h, inputs)
		cached = { h, inputs, value }
		return value
	}
}
