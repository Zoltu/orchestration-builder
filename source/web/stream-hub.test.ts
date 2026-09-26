import { describe, expect, test } from 'bun:test'
import { createDeltaChannel, type DeltaChannel } from '../executor/stream-channel.ts'
import { asRecord } from '../executor/validation.ts'
import { createStreamHub, type StreamHub, type StreamSocket } from './stream-hub.ts'

// A recording fake socket standing in for Bun's ServerWebSocket: sent captures the wire messages, and failSends simulates a dead connection whose send throws.
function createFakeSocket(options: { failSends?: boolean } = {}): StreamSocket & { sent: string[], closed: boolean, setFailSends(fail: boolean): void } {
	const sent: string[] = []
	const socket = {
		sent,
		closed: false,
		send(text: string): void {
			if (options.failSends === true) throw new Error('socket died')
			sent.push(text)
		},
		close(): void {
			socket.closed = true
		},
		setFailSends(fail: boolean): void {
			options.failSends = fail
		},
	}
	return socket
}

function subscribeMessage(runId: string): string {
	return JSON.stringify({ type: 'subscribe', runId })
}

// Composes the hub over a real channel (the wiring serve.ts builds): the hub is constructed on the channel, so publishing through it exercises the hub's one channel subscriber.
function createHubHarness(): { channel: DeltaChannel, hub: StreamHub } {
	const channel = createDeltaChannel()
	return { channel, hub: createStreamHub(channel) }
}

function parseWireMessage(text: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(text)
	const record = asRecord(parsed)
	if (record === undefined) throw new Error(`not an object: ${text}`)
	return record
}

describe('createStreamHub', () => {
	test('onOpen registers the socket unsubscribed', () => {
		const { hub } = createHubHarness()
		const socket = createFakeSocket()
		hub.onOpen(socket)
		expect(hub.subscribed(socket)).toBe(false)
	})

	test('an unopened socket is not subscribed', () => {
		const { hub } = createHubHarness()
		expect(hub.subscribed(createFakeSocket())).toBe(false)
	})

	test('a valid subscribe message is acknowledged and marks the socket subscribed', () => {
		const { hub } = createHubHarness()
		const socket = createFakeSocket()
		hub.onOpen(socket)
		hub.onMessage(socket, subscribeMessage('run-1'))
		expect(hub.subscribed(socket)).toBe(true)
		expect(parseWireMessage(socket.sent[0] ?? '')).toEqual({ type: 'subscribed', runId: 'run-1' })
	})

	test('subscribing the same run twice sends two acks and holds one subscription', () => {
		const { channel, hub } = createHubHarness()
		const socket = createFakeSocket()
		hub.onOpen(socket)
		hub.onMessage(socket, subscribeMessage('run-1'))
		hub.onMessage(socket, subscribeMessage('run-1'))
		expect(socket.sent.length).toBe(2)
		channel.bindRun('run-1')
		channel.publish({ roleId: 'r', role: 'main', field: 'content', text: 'once' })
		expect(parseWireMessage(socket.sent[2] ?? '')).toEqual({ type: 'delta', runId: 'run-1', roleId: 'r', role: 'main', field: 'content', text: 'once' })
	})

	test('a socket subscribed to one run receives deltas only for that run', () => {
		const { channel, hub } = createHubHarness()
		const socket = createFakeSocket()
		hub.onOpen(socket)
		hub.onMessage(socket, subscribeMessage('run-1'))
		channel.bindRun('run-2')
		channel.publish({ roleId: 'r', role: 'main', field: 'content', text: 'other run' })
		channel.bindRun('run-1')
		channel.publish({ roleId: 'r', role: 'main', field: 'reasoning', text: 'my run' })
		expect(socket.sent.length).toBe(2)
		expect(parseWireMessage(socket.sent[1] ?? '')).toEqual({ type: 'delta', runId: 'run-1', roleId: 'r', role: 'main', field: 'reasoning', text: 'my run' })
	})

	test('a delta carries the reset flag through to the wire', () => {
		const { channel, hub } = createHubHarness()
		const socket = createFakeSocket()
		hub.onOpen(socket)
		hub.onMessage(socket, subscribeMessage('run-1'))
		channel.bindRun('run-1')
		channel.publish({ roleId: 'r', role: 'main', field: 'content', text: '', reset: true })
		expect(parseWireMessage(socket.sent[1] ?? '')).toEqual({ type: 'delta', runId: 'run-1', roleId: 'r', role: 'main', field: 'content', text: '', reset: true })
	})

	test('fan-out delivers one delta to every socket subscribed to the run', () => {
		const { channel, hub } = createHubHarness()
		const first = createFakeSocket()
		const second = createFakeSocket()
		const other = createFakeSocket()
		for (const socket of [first, second]) {
			hub.onOpen(socket)
			hub.onMessage(socket, subscribeMessage('run-1'))
		}
		hub.onOpen(other)
		hub.onMessage(other, subscribeMessage('run-2'))
		channel.bindRun('run-1')
		channel.publish({ roleId: 'r', role: 'main', field: 'content', text: 'for everyone' })

		expect(first.sent.length).toBe(2)
		expect(second.sent.length).toBe(2)
		expect(other.sent.length).toBe(1)
		expect(parseWireMessage(second.sent[1] ?? '')).toEqual({ type: 'delta', runId: 'run-1', roleId: 'r', role: 'main', field: 'content', text: 'for everyone' })
	})

	test('malformed and unrecognized messages are ignored without throwing', () => {
		const { hub } = createHubHarness()
		const socket = createFakeSocket()
		hub.onOpen(socket)
		for (const raw of ['not json', '', 'null', '42', '"text"', '[1,2]', '{}', JSON.stringify({ type: 'unsubscribe', runId: 'run-1' }), JSON.stringify({ type: 'subscribe', runId: 7 }), JSON.stringify({ type: 'subscribe' }), subscribeMessage('run-1')]) {
			expect(() => hub.onMessage(socket, raw)).not.toThrow()
		}
		// Only the final, valid message had any effect.
		expect(hub.subscribed(socket)).toBe(true)
		expect(socket.sent.length).toBe(1)
	})

	test('a socket whose send throws during fan-out is unsubscribed without the throw escaping', () => {
		const { channel, hub } = createHubHarness()
		const dead = createFakeSocket()
		const survivor = createFakeSocket()
		for (const socket of [dead, survivor]) {
			hub.onOpen(socket)
			hub.onMessage(socket, subscribeMessage('run-1'))
		}
		dead.setFailSends(true)

		channel.bindRun('run-1')
		expect(() => channel.publish({ roleId: 'r', role: 'main', field: 'content', text: 'boom' })).not.toThrow()
		// The survivor still received the delta the dead socket could not take.
		expect(survivor.sent.length).toBe(2)
		expect(hub.subscribed(dead)).toBe(false)
		dead.setFailSends(false)
		channel.publish({ roleId: 'r', role: 'main', field: 'content', text: 'still out' })
		expect(survivor.sent.length).toBe(3)
		// The dropped socket was not re-added by its earlier subscription.
		expect(dead.sent.length).toBe(1)
	})

	test('a throwing ack send does not throw out of onMessage and leaves the socket dropped', () => {
		const { channel, hub } = createHubHarness()
		const socket = createFakeSocket()
		hub.onOpen(socket)
		socket.setFailSends(true)
		expect(() => hub.onMessage(socket, subscribeMessage('run-1'))).not.toThrow()
		expect(hub.subscribed(socket)).toBe(false)
		// The failed subscription stored no routing: a recovered socket receives no further deltas.
		socket.setFailSends(false)
		channel.bindRun('run-1')
		channel.publish({ roleId: 'r', role: 'main', field: 'content', text: 'gone' })
		expect(socket.sent.length).toBe(0)
	})

	test('onClose removes the socket from every run it subscribed to', () => {
		const { channel, hub } = createHubHarness()
		const socket = createFakeSocket()
		hub.onOpen(socket)
		hub.onMessage(socket, subscribeMessage('run-1'))
		hub.onMessage(socket, subscribeMessage('run-2'))
		hub.onClose(socket)
		expect(hub.subscribed(socket)).toBe(false)
		channel.bindRun('run-1')
		channel.publish({ roleId: 'r', role: 'main', field: 'content', text: 'after close' })
		channel.bindRun('run-2')
		channel.publish({ roleId: 'r', role: 'main', field: 'content', text: 'after close' })
		expect(socket.sent.length).toBe(2)
	})

	test('a socket that never subscribed receives no deltas', () => {
		const { channel, hub } = createHubHarness()
		const socket = createFakeSocket()
		hub.onOpen(socket)
		channel.bindRun('run-1')
		channel.publish({ roleId: 'r', role: 'main', field: 'content', text: 'unsolicited' })
		expect(socket.sent).toEqual([])
	})

	test('after every subscriber closes, a new socket can subscribe to the run again', () => {
		const { channel, hub } = createHubHarness()
		const first = createFakeSocket()
		hub.onOpen(first)
		hub.onMessage(first, subscribeMessage('run-1'))
		hub.onClose(first)
		const second = createFakeSocket()
		hub.onOpen(second)
		hub.onMessage(second, subscribeMessage('run-1'))
		channel.bindRun('run-1')
		channel.publish({ roleId: 'r', role: 'main', field: 'content', text: 'new viewer' })
		expect(parseWireMessage(second.sent[1] ?? '')).toEqual({ type: 'delta', runId: 'run-1', roleId: 'r', role: 'main', field: 'content', text: 'new viewer' })
	})
})
