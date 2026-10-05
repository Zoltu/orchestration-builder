// Browser-side client for the live token stream: the single websocket endpoint `GET /ws/stream` (upgraded by source/web/server.ts, fanned out by stream-hub.ts) carries the active run's ephemeral in-flight partials. The client owns the whole connection lifecycle — connect, subscribe on open, tolerant parse, reconnect with capped backoff, close — behind two calls, so its host (app.js) never touches a socket.
//
// The stream is an enhancement, so this module must never throw into its host: socket construction, socket sends, and host callbacks are all contained, and a malformed server message is dropped rather than surfaced. When the socket is absent, rejected, or dies mid-stream, the host simply sees no deltas — only live partial text is ever lost, and the polled run log stays the sole authority for run state (see docs/reference.md "Live token stream").
//
// Reconnect policy: the first retry waits 500ms and each further wait doubles up to a cap of 8s; a `subscribed` ack — proof the server is alive and the subscription landed — resets the wait to the start. A re-subscribe while connected sends the new run id immediately (the server replaces the subscription); a re-subscribe while down only updates the desired run, which the next connection sends on open.

import { isObject } from './guards.js'

// The reconnect backoff ladder's ends: start at 500ms, double per consecutive failure, cap at 8s.
const INITIAL_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 8000

// A delta message as the server ships it on the stream: the message type, the role instance and role name that produced the text, which turn-text field it extends, the text itself, and — for a retried attempt whose text re-emits from zero — the `reset` marker.
export interface StreamDeltaMessage {
	type: 'delta'
	runId: string
	roleId: string
	role: string
	field: 'reasoning' | 'content'
	text: string
	reset?: boolean
}

// The handler set a socket factory wires onto the connection's events. `onMessage` is invoked with text frames only; the protocol is JSON-only, so binary frames arrive mapped to an empty string and are dropped by the tolerant parse.
export interface StreamSocketHandlers {
	onOpen: () => void
	onMessage: (raw: string) => void
	onClose: () => void
	onError: () => void
}

// The minimal send/close handle the client drives. The native WebSocket satisfies this structurally; tests inject a fake.
export interface StreamSocket {
	send(text: string): void
	close(): void
}

// Opens a socket and wires the handlers onto it, returning the minimal send/close handle the client drives.
export type OpenSocket = (url: string, handlers: StreamSocketHandlers) => StreamSocket

// The client handle: `subscribe` asks for one run's stream (a re-subscribe replaces the previous), `close` shuts the socket down and stops reconnecting for good.
export interface StreamClient {
	subscribe(runId: string): void
	close(): void
}

export interface StreamClientOptions {
	// The websocket endpoint (`ws:`/`wss:` + the `/ws/stream` path).
	url: string
	// Called with each well-formed delta message.
	onDelta: (delta: StreamDeltaMessage) => void
	// Socket lifecycle phases: `connected` when a socket opens, `disconnected` when one closes or errors.
	onStateChange?: (state: 'connected' | 'disconnected') => void
	// The socket factory; defaults to the native WebSocket.
	openSocket?: OpenSocket
}

// The production socket factory: a native WebSocket with the handlers wired as properties. `error` is wired to the same teardown as `close` — the browser always follows an error with a close event, but a fake or exotic embedder may not, and the per-connection teardown is idempotent either way.
function defaultOpenSocket(url: string, handlers: StreamSocketHandlers): StreamSocket {
	const socket = new WebSocket(url)
	socket.onopen = () => handlers.onOpen()
	socket.onmessage = (event) => handlers.onMessage(typeof event.data === 'string' ? event.data : '')
	socket.onclose = () => handlers.onClose()
	socket.onerror = () => handlers.onError()
	return socket
}

// The delta wire-message guard: every field the accumulation reads must be present and well-typed, so a half-formed delta is dropped rather than corrupting the host's text.
function isDeltaMessage(value: unknown): value is StreamDeltaMessage {
	if (!isObject(value)) return false
	if (value['type'] !== 'delta') return false
	if (typeof value['runId'] !== 'string') return false
	if (typeof value['roleId'] !== 'string') return false
	if (typeof value['role'] !== 'string') return false
	if (value['field'] !== 'reasoning' && value['field'] !== 'content') return false
	return typeof value['text'] === 'string'
}

// The ack guard: `{"type":"subscribed","runId":"..."}`. Only the shape matters here (the ack resets the backoff ladder); the run id is the server echoing the request back.
function isSubscribedMessage(value: unknown): boolean {
	return isObject(value) && value['type'] === 'subscribed' && typeof value['runId'] === 'string'
}

// Creates the stream client. All failures — socket construction, sends, host callbacks, malformed messages — are contained; the client degrades to silence and keeps its retry loop alive instead of throwing into the host.
export function createStreamClient(options: StreamClientOptions): StreamClient {
	const url = options.url
	const onDelta = options.onDelta
	const onStateChange = options.onStateChange
	const openSocket = options.openSocket ?? defaultOpenSocket

	let socket: StreamSocket | null = null
	let desiredRunId: string | null = null
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null
	let backoffMs = INITIAL_BACKOFF_MS
	let closedByHost = false

	// Containment for the two ways the outside world can throw through this module: a host callback with a bug, and a socket call on a connection that died without its close event arriving. Both are swallowed by design — the stream is best-effort in both directions (mirroring the hub's sendBestEffort) and must never break its host.
	function contain(sideEffect: () => void): void {
		try {
			sideEffect()
		} catch {
			// Contained: the stream is an enhancement.
		}
	}

	function emitState(state: 'connected' | 'disconnected'): void {
		if (onStateChange === undefined) return
		contain(() => onStateChange(state))
	}

	function cancelReconnect(): void {
		if (reconnectTimer === null) return
		clearTimeout(reconnectTimer)
		reconnectTimer = null
	}

	function scheduleReconnect(): void {
		if (closedByHost) return
		cancelReconnect()
		const delay = backoffMs
		backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
		reconnectTimer = setTimeout(connect, delay)
	}

	function handleServerMessage(raw: string): void {
		let parsed: unknown
		try {
			parsed = JSON.parse(raw)
		} catch {
			// Tolerant parse: a malformed frame is dropped, not surfaced.
			return
		}
		if (isSubscribedMessage(parsed)) {
			// The subscription landed: the server is alive and speaking the protocol, so the ladder starts over.
			backoffMs = INITIAL_BACKOFF_MS
			return
		}
		if (isDeltaMessage(parsed)) contain(() => onDelta(parsed))
	}

	// Best-effort send (mirroring the hub's sendBestEffort): a throwing send means the socket died, so it is closed to let the close event tear the connection down and hand control to the retry loop.
	function sendSubscribe(runId: string): void {
		const target = socket
		if (target === null) return
		try {
			target.send(JSON.stringify({ type: 'subscribe', runId }))
		} catch {
			contain(() => target.close())
		}
	}

	function connect(): void {
		if (closedByHost) return
		reconnectTimer = null
		// Per-connection bookkeeping: `tornDown` folds close and error into one teardown (browsers fire an error before every close, so whichever arrives second is a no-op), and `handle` is captured before the factory returns so a synchronously-firing handler still reaches it.
		const connection: { handle: StreamSocket | null; tornDown: boolean } = { handle: null, tornDown: false }
		const markDown = (): void => {
			if (connection.tornDown) return
			connection.tornDown = true
			if (socket === connection.handle) socket = null
			emitState('disconnected')
			scheduleReconnect()
		}
		const handlers: StreamSocketHandlers = {
			onOpen: () => {
				if (connection.tornDown) return
				socket = connection.handle
				emitState('connected')
				if (desiredRunId !== null) sendSubscribe(desiredRunId)
			},
			onMessage: (raw) => {
				if (typeof raw === 'string') handleServerMessage(raw)
			},
			onClose: markDown,
			onError: markDown,
		}
		try {
			connection.handle = openSocket(url, handlers)
		} catch {
			// The socket could not even be constructed (invalid url, blocked scheme): degrade to the retry loop instead of throwing into the host.
			markDown()
			return
		}
		if (!connection.tornDown && socket === null) socket = connection.handle
	}

	return {
		subscribe(runId: string): void {
			if (closedByHost) return
			// The run id arrives from plain-JS hosts, so the well-formedness check stays a runtime guard rather than a type-only promise.
			if (typeof runId !== 'string' || runId === '') return
			desiredRunId = runId
			const target = socket
			if (target === null) {
				// Not connected: the armed retry delivers the subscription on its next open, and the very first subscribe connects immediately.
				if (reconnectTimer === null) connect()
				return
			}
			sendSubscribe(runId)
		},
		close(): void {
			closedByHost = true
			cancelReconnect()
			desiredRunId = null
			const target = socket
			socket = null
			if (target !== null) contain(() => target.close())
		},
	}
}
