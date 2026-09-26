import { describe, expect, test, vi } from 'bun:test'
import { createStreamClient } from './static/stream-client.js'
import { nextLivePartial, activeLivePartial } from './static/live-partial.js'
import { defined } from './test-fixtures.js'

// The stream client and the live-partial helpers are browser-pure JS, so their exports arrive with inferred JSDoc types. The interfaces below carry the shapes the tests assert against, mirroring inspector-modal.test.ts.

/** The handler set the fake records from the socket factory (stream-client.js's `StreamSocketHandlers`). */
interface StreamSocketHandlers {
	onOpen: () => void
	onMessage: (raw: string) => void
	onClose: () => void
	onError: () => void
}

/** A delta message as the wire carries it (stream-client.js's `StreamDeltaMessage`). */
interface StreamDeltaMessage {
	type: 'delta'
	runId: string
	roleId: string
	role: string
	field: 'reasoning' | 'content'
	text: string
	reset?: boolean
}

/** A fake connection: records sends, exposes the handlers as drivable events, and satisfies the factory's send/close handle. */
interface FakeSocket {
	send(text: string): void
	close(): void
	url: string
	handlers: StreamSocketHandlers
	sent: string[]
	closed: boolean
	open(): void
	message(raw: string): void
	error(): void
	shutdown(): void
	setFailSends(fail: boolean): void
}

function createFakeSocket(url: string, handlers: StreamSocketHandlers, failSends: { value: boolean }): FakeSocket {
	const sent: string[] = []
	let closed = false
	return {
		url,
		handlers,
		sent,
		get closed() {
			return closed
		},
		send(text: string) {
			if (failSends.value) throw new Error('socket died')
			sent.push(text)
		},
		close() {
			closed = true
		},
		open() {
			handlers.onOpen()
		},
		message(raw: string) {
			handlers.onMessage(raw)
		},
		error() {
			handlers.onError()
		},
		shutdown() {
			handlers.onClose()
		},
		setFailSends(fail: boolean) {
			failSends.value = fail
		},
	}
}

// The harness: a client over a fake socket factory that records every connection, plus the captured deltas and socket phases.
function createClientHarness(options: { onDelta?: (delta: StreamDeltaMessage) => void, onStateChange?: (state: 'connected' | 'disconnected') => void } = {}) {
	const deltas: StreamDeltaMessage[] = []
	const phases: Array<'connected' | 'disconnected'> = []
	const sockets: FakeSocket[] = []
	const failSends = { value: false }
	const openSocket = (url: string, handlers: StreamSocketHandlers): FakeSocket => {
		const socket = createFakeSocket(url, handlers, failSends)
		sockets.push(socket)
		return socket
	}
	const client = createStreamClient({
		url: 'ws://localhost:8080/ws/stream',
		onDelta: options.onDelta ?? ((delta) => deltas.push(delta)),
		onStateChange: options.onStateChange ?? ((phase) => phases.push(phase)),
		openSocket,
	})
	return { client, sockets, deltas, phases, setFailSends: (fail: boolean) => { failSends.value = fail } }
}

function latestSocket(sockets: FakeSocket[]): FakeSocket {
	return defined(sockets[sockets.length - 1], 'latest socket')
}

describe('createStreamClient', () => {
	test('subscribe connects immediately and sends the subscribe message on open', () => {
		const { client, sockets } = createClientHarness()
		client.subscribe('run-1')
		expect(sockets).toHaveLength(1)
		expect(latestSocket(sockets).url).toBe('ws://localhost:8080/ws/stream')
		expect(latestSocket(sockets).sent).toEqual([])
		latestSocket(sockets).open()
		expect(latestSocket(sockets).sent).toEqual([JSON.stringify({ type: 'subscribe', runId: 'run-1' })])
	})

	test('a re-subscribe while connected sends the new run id (the server replaces the subscription)', () => {
		const { client, sockets } = createClientHarness()
		client.subscribe('run-1')
		latestSocket(sockets).open()
		client.subscribe('run-2')
		expect(latestSocket(sockets).sent).toEqual([
			JSON.stringify({ type: 'subscribe', runId: 'run-1' }),
			JSON.stringify({ type: 'subscribe', runId: 'run-2' }),
		])
	})

	test('a re-subscribe while the socket is down is delivered by the next connection', () => {
		vi.useFakeTimers()
		try {
			const { client, sockets } = createClientHarness()
			client.subscribe('run-1')
			latestSocket(sockets).shutdown()
			client.subscribe('run-2')
			vi.advanceTimersByTime(500)
			expect(sockets).toHaveLength(2)
			latestSocket(sockets).open()
			expect(latestSocket(sockets).sent).toEqual([JSON.stringify({ type: 'subscribe', runId: 'run-2' })])
		} finally {
			vi.useRealTimers()
		}
	})

	test('delta messages reach onDelta parsed', () => {
		const { client, sockets, deltas } = createClientHarness()
		client.subscribe('run-1')
		const socket = latestSocket(sockets)
		socket.open()
		socket.message(JSON.stringify({ type: 'delta', runId: 'run-1', roleId: 'main-1', role: 'main', field: 'reasoning', text: 'th' }))
		socket.message(JSON.stringify({ type: 'delta', runId: 'run-1', roleId: 'main-1', role: 'main', field: 'content', text: ' answer', reset: true }))
		expect(deltas).toEqual([
			{ type: 'delta', runId: 'run-1', roleId: 'main-1', role: 'main', field: 'reasoning', text: 'th' },
			{ type: 'delta', runId: 'run-1', roleId: 'main-1', role: 'main', field: 'content', text: ' answer', reset: true },
		])
	})

	test('malformed server messages are ignored without throwing', () => {
		const { client, sockets, deltas } = createClientHarness()
		client.subscribe('run-1')
		const socket = latestSocket(sockets)
		socket.open()
		const wellFormed = JSON.stringify({ type: 'delta', runId: 'run-1', roleId: 'r', role: 'main', field: 'content', text: 'kept' })
		for (const raw of [
			'not json',
			'',
			'null',
			'42',
			'"text"',
			'[1,2]',
			'{}',
			JSON.stringify({ type: 'delta' }),
			JSON.stringify({ type: 'delta', runId: 'run-1', roleId: 'r', role: 'main', field: 'other', text: 'x' }),
			JSON.stringify({ type: 'delta', runId: 'run-1', roleId: 'r', role: 'main', field: 'content', text: 7 }),
			JSON.stringify({ type: 'delta', runId: 5, roleId: 'r', role: 'main', field: 'content', text: 'x' }),
			JSON.stringify({ type: 'subscribed' }),
			JSON.stringify({ type: 'subscribed', runId: 5 }),
			JSON.stringify({ type: 'unknown', runId: 'run-1' }),
			wellFormed,
		]) {
			expect(() => socket.message(raw)).not.toThrow()
		}
		// Only the final, well-formed delta was delivered.
		expect(deltas).toEqual([{ type: 'delta', runId: 'run-1', roleId: 'r', role: 'main', field: 'content', text: 'kept' }])
	})

	test('reconnect backs off 500ms, 1s, 2s, 4s, 8s, then caps at 8s', () => {
		vi.useFakeTimers()
		try {
			const { client, sockets } = createClientHarness()
			client.subscribe('run-1')
			for (const wait of [500, 1000, 2000, 4000, 8000, 8000]) {
				const before = sockets.length
				latestSocket(sockets).shutdown()
				vi.advanceTimersByTime(wait - 1)
				expect(sockets.length).toBe(before)
				vi.advanceTimersByTime(1)
				expect(sockets.length).toBe(before + 1)
			}
		} finally {
			vi.useRealTimers()
		}
	})

	test('a subscribed ack resets the backoff ladder', () => {
		vi.useFakeTimers()
		try {
			const { client, sockets } = createClientHarness()
			client.subscribe('run-1')
			// Two failed retries move the ladder to a 2s wait…
			latestSocket(sockets).shutdown()
			vi.advanceTimersByTime(500)
			latestSocket(sockets).shutdown()
			vi.advanceTimersByTime(1000)
			// …but the third connection opens, subscribes, and is acked…
			const recovered = latestSocket(sockets)
			recovered.open()
			recovered.message(JSON.stringify({ type: 'subscribed', runId: 'run-1' }))
			recovered.shutdown()
			// …so the next retry waits 500ms again, not 2000ms.
			vi.advanceTimersByTime(500)
			expect(sockets).toHaveLength(4)
		} finally {
			vi.useRealTimers()
		}
	})

	test('an ack and an unknown message never reach onDelta', () => {
		const { client, sockets, deltas } = createClientHarness()
		client.subscribe('run-1')
		const socket = latestSocket(sockets)
		socket.open()
		socket.message(JSON.stringify({ type: 'subscribed', runId: 'run-1' }))
		socket.message(JSON.stringify({ type: 'subscribed', runId: 'run-other' }))
		expect(deltas).toEqual([])
	})

	test('close() stops the retry loop and closes a live socket', () => {
		vi.useFakeTimers()
		try {
			const { client, sockets } = createClientHarness()
			client.subscribe('run-1')
			latestSocket(sockets).open()
			client.close()
			expect(latestSocket(sockets).closed).toBe(true)
			// The close event the dying socket fires reconnects nothing after close().
			latestSocket(sockets).shutdown()
			vi.runAllTimers()
			expect(sockets).toHaveLength(1)
			// And a subscribe after close() is a no-op, not a resurrection.
			client.subscribe('run-2')
			vi.runAllTimers()
			expect(sockets).toHaveLength(1)
		} finally {
			vi.useRealTimers()
		}
	})

	test('socket errors tear the connection down and reconnect like closes', () => {
		vi.useFakeTimers()
		try {
			const { client, sockets, phases } = createClientHarness()
			client.subscribe('run-1')
			const socket = latestSocket(sockets)
			socket.open()
			expect(phases).toEqual(['connected'])
			socket.error()
			expect(phases).toEqual(['connected', 'disconnected'])
			// A late close event on the same connection is a no-op (one teardown per connection).
			socket.shutdown()
			expect(phases).toEqual(['connected', 'disconnected'])
			vi.advanceTimersByTime(500)
			expect(sockets).toHaveLength(2)
		} finally {
			vi.useRealTimers()
		}
	})

	test('a throwing host callback never escapes the client', () => {
		const { client, sockets } = createClientHarness({
			onDelta: () => { throw new Error('host bug') },
			onStateChange: () => { throw new Error('host bug') },
		})
		client.subscribe('run-1')
		const socket = latestSocket(sockets)
		expect(() => socket.open()).not.toThrow()
		expect(() => socket.message(JSON.stringify({ type: 'delta', runId: 'run-1', roleId: 'r', role: 'main', field: 'content', text: 'x' }))).not.toThrow()
		expect(() => socket.shutdown()).not.toThrow()
	})

	test('a socket factory that throws degrades to the retry loop instead of throwing', () => {
		vi.useFakeTimers()
		try {
			let attempts = 0
			const client = createStreamClient({
				url: 'ws://localhost:8080/ws/stream',
				onDelta: () => undefined,
				openSocket: () => {
					attempts++
					throw new Error('no sockets here')
				},
			})
			client.subscribe('run-1')
			expect(attempts).toBe(1)
			vi.advanceTimersByTime(500)
			expect(attempts).toBe(2)
			client.close()
			vi.runAllTimers()
			expect(attempts).toBe(2)
		} finally {
			vi.useRealTimers()
		}
	})

	test('a throwing send is contained: the dying socket is closed and the retry re-subscribes', () => {
		vi.useFakeTimers()
		try {
			const { client, sockets, setFailSends } = createClientHarness()
			client.subscribe('run-1')
			setFailSends(true)
			const dead = latestSocket(sockets)
			expect(() => dead.open()).not.toThrow()
			expect(dead.closed).toBe(true)
			expect(dead.sent).toEqual([])
			// The close event of the dying socket hands control to the retry loop, which re-subscribes the same run on the next connection.
			setFailSends(false)
			dead.shutdown()
			vi.advanceTimersByTime(500)
			expect(sockets).toHaveLength(2)
			latestSocket(sockets).open()
			expect(latestSocket(sockets).sent).toEqual([JSON.stringify({ type: 'subscribe', runId: 'run-1' })])
		} finally {
			vi.useRealTimers()
		}
	})

	test('the socket reports connected on open and disconnected on close', () => {
		const { client, sockets, phases } = createClientHarness()
		client.subscribe('run-1')
		latestSocket(sockets).open()
		latestSocket(sockets).shutdown()
		expect(phases).toEqual(['connected', 'disconnected'])
	})
})

describe('nextLivePartial', () => {
	function delta(overrides: Partial<Omit<StreamDeltaMessage, 'type'>> = {}): StreamDeltaMessage {
		return { type: 'delta', runId: 'run-1', roleId: 'main-1', role: 'main', field: 'reasoning', text: 'x', ...overrides }
	}

	test('a first delta starts a fresh accumulation and appends its text', () => {
		const next = nextLivePartial(null, delta({ text: 'Hello' }))
		expect(next).toEqual({ roleId: 'main-1', role: 'main', reasoning: 'Hello', content: '' })
	})

	test('deltas append per field independently', () => {
		let partial = nextLivePartial(null, delta({ field: 'reasoning', text: 'think' }))
		partial = nextLivePartial(partial, delta({ field: 'content', text: 'say' }))
		partial = nextLivePartial(partial, delta({ field: 'reasoning', text: ' more' }))
		expect(partial).toEqual({ roleId: 'main-1', role: 'main', reasoning: 'think more', content: 'say' })
	})

	test('a delta from another role instance starts fresh (single-role accumulation)', () => {
		const partial = nextLivePartial({ roleId: 'main-1', role: 'main', reasoning: 'old turn', content: 'old text' }, delta({ roleId: 'coder-2', role: 'coder', text: 'new' }))
		expect(partial).toEqual({ roleId: 'coder-2', role: 'coder', reasoning: 'new', content: '' })
	})

	test('a reset delta clears the accumulation before appending', () => {
		let partial = nextLivePartial(null, delta({ field: 'content', text: 'wrong start' }))
		partial = nextLivePartial(partial, delta({ field: 'content', text: 'retry', reset: true }))
		expect(partial).toEqual({ roleId: 'main-1', role: 'main', reasoning: '', content: 'retry' })
	})

	test('a malformed delta leaves the accumulation untouched', () => {
		const current = { roleId: 'main-1', role: 'main', reasoning: 'kept', content: '' }
		expect(nextLivePartial(current, null)).toBe(current)
		expect(nextLivePartial(current, 'broken')).toBe(current)
		expect(nextLivePartial(current, { roleId: 'main-1', role: 'main', field: 'other', text: 'x' })).toBe(current)
		expect(nextLivePartial(current, { roleId: 'main-1', role: 'main', field: 'content', text: 7 })).toBe(current)
		expect(nextLivePartial(current, { role: 'main', field: 'content', text: 'x' })).toBe(current)
	})
})

describe('activeLivePartial', () => {
	const partial = { roleId: 'coder-2', role: 'coder', reasoning: 'in progress', content: '' }

	test('kept while the role still holds an in-flight turn', () => {
		const entries = [{ kind: 'completed', role: 'planner' }, { kind: 'in_flight', role: 'coder' }]
		expect(activeLivePartial(partial, entries)).toBe(partial)
	})

	test('cleared once the pairing shows the turn completed (no in-flight entry for the role)', () => {
		const entries = [{ kind: 'completed', role: 'planner' }, { kind: 'completed', role: 'coder' }]
		expect(activeLivePartial(partial, entries)).toBeNull()
	})

	test('a partial whose role never appears in the list clears', () => {
		expect(activeLivePartial(partial, [{ kind: 'in_flight', role: 'planner' }])).toBeNull()
	})

	test('null stays null and malformed inputs clear rather than throw', () => {
		expect(activeLivePartial(null, [{ kind: 'in_flight', role: 'coder' }])).toBeNull()
		expect(activeLivePartial(partial, 'broken')).toBeNull()
		expect(activeLivePartial(partial, [null, 42, { kind: 'in_flight' }])).toBeNull()
	})
})
