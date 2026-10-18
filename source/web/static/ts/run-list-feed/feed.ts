import { createEntityHasher, reduceServerResponse } from '../entity-diff/index.js'
import { emptyRunListReplicaState, runListDefinitions, runSummariesFromReplicaState } from './replica.js'
import type { RunListReplicaState, RunSummary } from './replica.js'

// One hasher for the module's lifetime: its identity-keyed cache is safe because every state and entity handed across the contract is immutable, and it spares each apply a fresh cache.
const feedHasher = createEntityHasher()

const runListFeedStateBrand: unique symbol = Symbol('run-list-feed-state')

export interface RunListFeedState {
	readonly [runListFeedStateBrand]: typeof runListFeedStateBrand
}

interface RunListFeedStateData extends RunListFeedState {
	readonly replica: RunListReplicaState
	readonly revision: string | null
	readonly summaries: RunSummary[] | null
}

function runListFeedState(replica: RunListReplicaState, revision: string | null, summaries: RunSummary[] | null): RunListFeedStateData {
	return { [runListFeedStateBrand]: runListFeedStateBrand, replica, revision, summaries }
}

function isRunListFeedStateData(state: RunListFeedState): state is RunListFeedStateData {
	if (!('replica' in state)) return false
	if (!('revision' in state)) return false
	if (!('summaries' in state)) return false
	return true
}

function stateData(state: RunListFeedState): RunListFeedStateData {
	if (!isRunListFeedStateData(state)) throw new Error('run-list-feed: state was not created by emptyRunListFeedState')
	return state
}

export type RunListFrameResult =
	| { outcome: 'unchanged' | 'applied' | 'snapshot'; state: RunListFeedState; summaries: RunSummary[] }
	| { outcome: 'needsSnapshot' | 'invalid'; state: RunListFeedState; summaries: null }

export function emptyRunListFeedState(): RunListFeedState {
	return runListFeedState(emptyRunListReplicaState(), null, null)
}

// The revision the next poll sends as `have`. It is null until the first frame applies; the holder treats it as opaque and never derives anything from its shape.
export function runListFeedRevision(state: RunListFeedState): string | null {
	return stateData(state).revision
}

// Reduces one run-list frame against the held replica and rebuilds the newest-first summaries. An unchanged frame returns the same state and summaries references so identity-keyed history memoization survives; a needsSnapshot frame is a typed outcome rather than a throw, leaving the held state in place for the host to re-fetch without `have`; an invalid frame likewise leaves the held state untouched.
export function applyRunListFrame(state: RunListFeedState, raw: unknown): RunListFrameResult {
	const current = stateData(state)
	const reaction = reduceServerResponse(runListDefinitions, feedHasher, current.replica, current.revision, raw)
	if (reaction.kind === 'unchanged') {
		if (current.summaries === null) throw new Error('run-list-feed: an unchanged frame cannot apply before summaries exist')
		return { outcome: 'unchanged', state, summaries: current.summaries }
	}
	if (reaction.kind === 'applied' || reaction.kind === 'snapshot') {
		const summaries = runSummariesFromReplicaState(reaction.state)
		return { outcome: reaction.kind, state: runListFeedState(reaction.state, reaction.version, summaries), summaries }
	}
	return { outcome: reaction.kind, state, summaries: null }
}
