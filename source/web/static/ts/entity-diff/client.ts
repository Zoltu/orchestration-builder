import { createEntityHasher, emptyState, reduceServerResponse } from './state.js'
import type { ClientReaction } from './state.js'
import type { CollectionDefinitions, EntitySchemaConstraint, ReadonlyReplicaState, SyncRequest, VersionToken } from './types.js'

export interface ClientReplicaDependencies {
	fetchResponse: (request: SyncRequest) => Promise<unknown>
}

export interface ClientReplicaOptions {
	verifyDeltas: boolean
}

// The state handed to callers is the client's internal state by reference, typed readonly to signal the immutability contract: replace entities and collections, never mutate them in place, or the identity hash cache returns a stale version.
export interface ClientState<Schema extends EntitySchemaConstraint<Schema>> {
	state: ReadonlyReplicaState<Schema>
	version: VersionToken | null
	outcome: 'unchanged' | 'delta' | 'snapshot' | 'invalid'
}

export interface ClientReplica<Schema extends EntitySchemaConstraint<Schema>> {
	sync(): Promise<ClientState<Schema>>
	state(): ReadonlyReplicaState<Schema>
	version(): VersionToken | null
}

function clientStateFromReaction<Schema extends EntitySchemaConstraint<Schema>>(reaction: ClientReaction<Schema>): ClientState<Schema> {
	if (reaction.kind === 'unchanged') return { state: reaction.state, version: reaction.version, outcome: 'unchanged' }
	if (reaction.kind === 'applied') return { state: reaction.state, version: reaction.version, outcome: 'delta' }
	if (reaction.kind === 'snapshot') return { state: reaction.state, version: reaction.version, outcome: 'snapshot' }
	return { state: reaction.state, version: reaction.version, outcome: 'invalid' }
}

export function createClientReplica<Schema extends EntitySchemaConstraint<Schema>>(
	definitions: CollectionDefinitions<Schema>,
	dependencies: ClientReplicaDependencies,
	options: ClientReplicaOptions,
): ClientReplica<Schema> {
	const hasher = createEntityHasher()
	let currentState = emptyState(definitions)
	let currentVersion: VersionToken | null = null
	let inFlight: Promise<ClientState<Schema>> | null = null

	async function performSync(): Promise<ClientState<Schema>> {
		const first = await dependencies.fetchResponse({ have: currentVersion })
		const firstReaction = reduceServerResponse(definitions, hasher, currentState, currentVersion, first, options.verifyDeltas)
		if (firstReaction.kind !== 'needsSnapshot' && firstReaction.kind !== 'invalid') {
			currentState = firstReaction.state
			currentVersion = firstReaction.version
			return clientStateFromReaction(firstReaction)
		}
		// A response the client cannot apply at its current version is answered with one unconditional snapshot request; if that too is unusable the client surfaces invalid rather than looping.
		const retry = await dependencies.fetchResponse({ have: null })
		const retryReaction = reduceServerResponse(definitions, hasher, currentState, currentVersion, retry, options.verifyDeltas)
		if (retryReaction.kind === 'needsSnapshot' || retryReaction.kind === 'invalid') {
			return { state: currentState, version: currentVersion, outcome: 'invalid' }
		}
		currentState = retryReaction.state
		currentVersion = retryReaction.version
		return clientStateFromReaction(retryReaction)
	}

	function sync(): Promise<ClientState<Schema>> {
		if (inFlight !== null) return inFlight
		inFlight = performSync().finally(() => {
			inFlight = null
		})
		return inFlight
	}

	return {
		sync,
		state() {
			return currentState
		},
		version() {
			return currentVersion
		},
	}
}

export function createFetchResponse(url: string): (request: SyncRequest) => Promise<unknown> {
	return async (request) => {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(request),
		})
		if (!response.ok) throw new Error(`entity-diff sync request failed with status ${response.status}`)
		return response.json()
	}
}
