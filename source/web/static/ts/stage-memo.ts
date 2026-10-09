// The flow/sequence stage's memoization inputs and the manual single-position memo.
//
// The stage is the expensive O(operations) SVG, and the poll re-renders the whole view every tick. It is memoized on the stable inputs below rather than on the vendored hyperapp `Lazy`: `Lazy`'s `propsChanged` loops over `oldVNode.lazy` and `newVNode.lazy`, and when a tree position transitions from a non-Lazy vnode (the WatchScreen placeholder `<p>`) to a Lazy vnode the old side is `undefined`, so `undefined[k]` throws `TypeError: undefined is not an object`. The manual memo sidesteps that by never asking hyperapp to diff a lazy wrapper: it returns the SAME vnode object when the inputs are unchanged, and hyperapp's `patch` short-circuits on `oldVNode === newVNode` before it diffs or touches the DOM. The cached vnode is therefore reused at exactly one tree position across renders — never handed to two positions at once, which would let hyperapp's in-place `node` mutation corrupt the mounted tree (see AGENTS.md "Browser client sources are TypeScript").
//
// The module is browser-pure TypeScript: it imports only sibling types and touches no external system.

import type { InteractionModel, Participant } from './interaction-model.js'
import type { LabelResolver, LabelTier } from './labels.js'
import type { RoleAccentResolver } from './role-accents.js'

// The stage's two render modes, mirroring app.ts's FlowViewMode. Declared here so this module stays free of the app.ts import cycle; the app's state field is the same union and assigns without a cast.
export type StageViewMode = 'flow' | 'sequence'

// The stable fields the stage view renders from. Every field is either a reference that only changes when the server sends new data (or the operator changes a lens) or a primitive that does not move on a poll tick.
export interface StageMemoInputs {
	serverModel: InteractionModel
	previousModel: InteractionModel | null
	labels: LabelResolver
	tier: LabelTier
	roleAccents: RoleAccentResolver
	guildParticipants: Participant[]
	viewMode: StageViewMode
	rolesOnly: boolean
}

// Picks the memo inputs off a source object. The source may carry extra fields (the caller passes its state); they are ignored because the returned object lists every field it keeps.
export function buildStageMemoInputs(source: StageMemoInputs): StageMemoInputs {
	return {
		serverModel: source.serverModel,
		previousModel: source.previousModel,
		labels: source.labels,
		tier: source.tier,
		roleAccents: source.roleAccents,
		guildParticipants: source.guildParticipants,
		viewMode: source.viewMode,
		rolesOnly: source.rolesOnly,
	}
}

// Every field is a reference or a primitive, so identity comparison is exact: two input sets are equal exactly when nothing the stage renders from has changed.
export function stageInputsEqual(a: StageMemoInputs, b: StageMemoInputs): boolean {
	return a.serverModel === b.serverModel
		&& a.previousModel === b.previousModel
		&& a.labels === b.labels
		&& a.tier === b.tier
		&& a.roleAccents === b.roleAccents
		&& a.guildParticipants === b.guildParticipants
		&& a.viewMode === b.viewMode
		&& a.rolesOnly === b.rolesOnly
}

// A one-entry memo over the stage inputs. It caches the last built value together with the inputs it was built from, so a caller passing a fresh-but-equal input object (buildStageMemoInputs returns a new object each call) still hits the cache. The cached value is returned unchanged so hyperapp's `oldVNode === newVNode` short-circuit skips the diff entirely.
export function createStageMemo<Value>(build: (inputs: StageMemoInputs) => Value): (inputs: StageMemoInputs) => Value {
	let cached: { inputs: StageMemoInputs; value: Value } | null = null
	return (inputs) => {
		if (cached !== null && stageInputsEqual(cached.inputs, inputs)) return cached.value
		const value = build(inputs)
		cached = { inputs, value }
		return value
	}
}
