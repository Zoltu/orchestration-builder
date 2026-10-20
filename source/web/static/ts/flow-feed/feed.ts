import { createEntityHasher, reduceServerResponse } from '../entity-diff/index.js'
import type { InteractionModel } from '../interaction-model.js'
import { emptyFlowReplicaState, flowDefinitions, flowModelFromReplicaState } from './replica.js'
import type { FlowReplicaState } from './replica.js'

// One hasher for the module's lifetime: its identity-keyed cache is safe because every state and entity handed across the contract is immutable, and it spares each apply a fresh cache.
const feedHasher = createEntityHasher()

const flowFeedStateBrand: unique symbol = Symbol('flow-feed-state')

export interface FlowFeedState {
	readonly [flowFeedStateBrand]: typeof flowFeedStateBrand
}

interface FlowFeedStateData extends FlowFeedState {
	readonly replica: FlowReplicaState
	readonly revision: string | null
	readonly model: InteractionModel | null
}

function flowFeedState(replica: FlowReplicaState, revision: string | null, model: InteractionModel | null): FlowFeedStateData {
	return { [flowFeedStateBrand]: flowFeedStateBrand, replica, revision, model }
}

function isFlowFeedStateData(state: FlowFeedState): state is FlowFeedStateData {
	if (!('replica' in state)) return false
	if (!('revision' in state)) return false
	if (!('model' in state)) return false
	return true
}

function stateData(state: FlowFeedState): FlowFeedStateData {
	if (!isFlowFeedStateData(state)) throw new Error('flow-feed: state was not created by emptyFlowFeedState')
	return state
}

export type FlowFrameResult =
	| { outcome: 'unchanged' | 'applied' | 'snapshot'; state: FlowFeedState; model: InteractionModel }
	| { outcome: 'needsSnapshot' | 'invalid'; state: FlowFeedState; model: null }

export function emptyFlowFeedState(): FlowFeedState {
	return flowFeedState(emptyFlowReplicaState(), null, null)
}

// The revision the next poll sends as `have`. It is null until the first frame applies; the holder treats it as opaque and never derives anything from its shape.
export function flowFeedRevision(state: FlowFeedState): string | null {
	return stateData(state).revision
}

// Drops the held revision while keeping the replica and model, so the next poll asks for a snapshot without blanking the visible stage. This is how a resumed tab reconciles anything it missed while hidden.
export function discardFlowRevision(state: FlowFeedState): FlowFeedState {
	const current = stateData(state)
	return flowFeedState(current.replica, null, current.model)
}

// Reduces one flow frame against the held replica and rebuilds the model the views read. An unchanged frame returns the same state and model references so the identity-keyed view memoization survives; a needsSnapshot frame is a typed outcome rather than a throw, leaving the held state in place for the host to re-fetch without `have`; an invalid frame likewise leaves the held state untouched.
export function applyFlowFrame(state: FlowFeedState, raw: unknown): FlowFrameResult {
	const current = stateData(state)
	const reaction = reduceServerResponse(flowDefinitions, feedHasher, current.replica, current.revision, raw)
	if (reaction.kind === 'unchanged') {
		if (current.model === null) throw new Error('flow-feed: an unchanged frame cannot apply before a model exists')
		return { outcome: 'unchanged', state, model: current.model }
	}
	if (reaction.kind === 'applied' || reaction.kind === 'snapshot') {
		const model = flowModelFromReplicaState(reaction.state)
		return { outcome: reaction.kind, state: flowFeedState(reaction.state, reaction.version, model), model }
	}
	return { outcome: reaction.kind, state, model: null }
}
