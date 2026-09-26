// The websocket-side fan-out for the executor's DeltaChannel (source/executor/stream-channel.ts): the hub holds the socket↔run subscription relation and registers exactly one channel subscriber that turns each RunDelta into a JSON wire message for the sockets subscribed to that delta's runId. It is written against a minimal socket interface rather than Bun's, so the routing, parsing, and containment logic is fully testable in-memory; source/web/server.ts supplies the Bun sockets and this module never imports Bun.
import type { DeltaChannel, RunDelta } from '../executor/stream-channel.js'
import { asRecord, safeJsonParse } from '../executor/validation.js'

// The minimal socket surface the hub needs, satisfied structurally by Bun's ServerWebSocket (send of a string, close) — the glue in server.ts passes sockets through without adapting them.
export type StreamSocket = {
	send(text: string): void
	close(): void
}

export interface StreamHub {
	// Registers a freshly opened socket as connected but unsubscribed.
	onOpen(socket: StreamSocket): void
	// Consumes one client message. The only recognized shape is {"type":"subscribe","runId":"..."}; every other message is ignored silently, and a valid subscribe is acknowledged on the same socket. A subscribe replaces the socket's previous subscription (docs/reference.md "Live token stream"): each socket holds at most one run.
	onMessage(socket: StreamSocket, raw: string): void
	// Removes the socket and every subscription it holds.
	onClose(socket: StreamSocket): void
}

// Tolerant parse of the one message shape the hub understands: {"type":"subscribe","runId":"..."}. Malformed JSON, a non-object, an unknown type, or a non-string run id yields undefined, because a misbehaving client must not be able to break the hub or the run streaming behind it.
function parseSubscribeRequest(raw: string): string | undefined {
	const parsed = safeJsonParse(raw)
	if (!parsed.ok) return undefined
	const record = asRecord(parsed.value)
	if (record === undefined) return undefined
	if (record.type !== 'subscribe') return undefined
	const runId = record.runId
	if (typeof runId !== 'string') return undefined
	return runId
}

// The delta wire message: {"type":"delta", runId, roleId, role, field, text} plus "reset" when the channel set it. The spread carries the channel's fields verbatim, so the client accumulation contract (a reset clears before appending) survives serialization.
function serializeDelta(delta: RunDelta): string {
	return JSON.stringify({ type: 'delta', ...delta })
}

export function createStreamHub(channel: DeltaChannel): StreamHub {
	// Both directions of the socket↔run relation, kept in step by drop() and onMessage; a socket holds at most one run subscription (a re-subscribe replaces the previous, see onMessage) and a run may fan out to several sockets.
	const runsBySocket = new Map<StreamSocket, Set<string>>()
	const socketsByRun = new Map<string, Set<StreamSocket>>()

	// Removes one socket from one run bucket, pruning the bucket when it empties. Empty run buckets are removed so the long-lived service does not accumulate an entry per run id ever subscribed.
	function removeFromRunBucket(socket: StreamSocket, runId: string): void {
		const sockets = socketsByRun.get(runId)
		if (sockets === undefined) return
		sockets.delete(socket)
		if (sockets.size === 0) socketsByRun.delete(runId)
	}

	function drop(socket: StreamSocket): void {
		const runs = runsBySocket.get(socket)
		if (runs === undefined) return
		for (const runId of runs) removeFromRunBucket(socket, runId)
		runsBySocket.delete(socket)
	}

	// Sends best-effort: a throwing send means the socket died (typically a closed tab whose close event has not arrived yet), so the failure is contained and the socket dropped from every routing table instead of propagating into the channel's fan-out or the websocket handler.
	function sendBestEffort(socket: StreamSocket, text: string): void {
		try {
			socket.send(text)
		} catch {
			drop(socket)
		}
	}

	// The single channel subscriber: the hub's whole channel relationship, registered once at construction. Deleting a dead socket during Set iteration is safe — the removed element is simply not visited again.
	channel.subscribe((delta) => {
		const recipients = socketsByRun.get(delta.runId)
		if (recipients === undefined) return
		const message = serializeDelta(delta)
		for (const socket of recipients) sendBestEffort(socket, message)
	})

	return {
		onOpen(socket) {
			runsBySocket.set(socket, new Set())
		},
		onMessage(socket, raw) {
			const runId = parseSubscribeRequest(raw)
			if (runId === undefined) return
			let runs = runsBySocket.get(socket)
			if (runs === undefined) {
				runs = new Set()
				runsBySocket.set(socket, runs)
			}
			// A re-subscribe replaces the previous subscription (docs/reference.md "Live token stream"): the socket is removed from its old run buckets and the empties pruned, so each socket holds at most one run and a flood of subscribe messages cannot grow the routing tables.
			for (const previous of runs) removeFromRunBucket(socket, previous)
			runs.clear()
			runs.add(runId)
			let sockets = socketsByRun.get(runId)
			if (sockets === undefined) {
				sockets = new Set()
				socketsByRun.set(runId, sockets)
			}
			sockets.add(socket)
			sendBestEffort(socket, JSON.stringify({ type: 'subscribed', runId }))
		},
		onClose: drop,
	}
}
