import { describe, expect, test } from 'bun:test'
import { scenarios } from './static/scenarios.js'
import { activeStack, observesOf } from './static/interaction-model.js'
import { defined } from './test-fixtures.js'

// Pull the model type off the helper signature so the validator's parameter is contextually checked against the JSDoc shape without a cast, mirroring how the model's own test derives its type.
type InteractionModel = Parameters<typeof activeStack>[0]
type Operation = InteractionModel['operations'][number]

// Validates a frame against the model contract: every source/destination references a known participant, no call/return is a self-edge, at most one operation is in_flight per stack, and returns close the call they claim to (same stack, matching source/destination, well-nested). observe is allowed to cross stacks and never enters a chain. A violation throws with enough context to locate the offending frame.
function validateFrame(model: InteractionModel): void {
	const participantIds = new Set(model.participants.map((participant) => participant.id))
	for (const operation of model.operations) {
		if (!participantIds.has(operation.source)) throw new Error(`operation ${operation.id} references unknown source "${operation.source}"`)
		if (!participantIds.has(operation.destination)) throw new Error(`operation ${operation.id} references unknown destination "${operation.destination}"`)
	}
	for (const operation of model.operations) {
		if (operation.kind === 'call' || operation.kind === 'return') {
			if (operation.source === operation.destination) throw new Error(`operation ${operation.id} has source === destination`)
		}
	}
	// The contract is "outcome is returns only": a call carries null until it settles and an observe is always null. Asserting it here keeps the model honest against any future helper that is tempted to mirror a return's outcome onto its closing call.
	for (const operation of model.operations) {
		if (operation.kind === 'call' || operation.kind === 'observe') {
			if (operation.outcome !== null) throw new Error(`operation ${operation.id} of kind "${operation.kind}" carries a non-null outcome`)
		}
	}
	const inFlightCountByStack = new Map<string, number>()
	for (const operation of model.operations) {
		if (operation.lifecycle !== 'in_flight') continue
		inFlightCountByStack.set(operation.stack, (inFlightCountByStack.get(operation.stack) ?? 0) + 1)
	}
	for (const [stackId, count] of inFlightCountByStack) {
		if (count > 1) throw new Error(`stack "${stackId}" has ${count} in_flight operations; at most one is allowed`)
	}
	const openCallsByStack = new Map<string, Operation[]>()
	for (const operation of model.operations) {
		if (operation.kind === 'call') {
			let openChain = openCallsByStack.get(operation.stack)
			if (openChain === undefined) {
				openChain = []
				openCallsByStack.set(operation.stack, openChain)
			}
			openChain.push(operation)
		} else if (operation.kind === 'return') {
			const openChain = openCallsByStack.get(operation.stack)
			if (openChain === undefined || openChain.length === 0) throw new Error(`return ${operation.id} on stack "${operation.stack}" has no open call to close`)
			const closingCall = openChain.pop()
			if (closingCall === undefined) throw new Error(`return ${operation.id} on stack "${operation.stack}" found no open call`)
			if (closingCall.source !== operation.destination || closingCall.destination !== operation.source) throw new Error(`return ${operation.id} does not match call ${closingCall.id} (stack "${operation.stack}")`)
		} else if (operation.kind === 'terminate') {
			// A terminate closes the targeted call (matching by destination across every stack) without a return carrying the killed result, so the call is removed from the open chain right away.
			let closedCall = false
			for (const openChain of openCallsByStack.values()) {
				for (let chainIndex = openChain.length - 1; chainIndex >= 0; chainIndex -= 1) {
					const call = openChain[chainIndex]
					if (call === undefined) continue
					if (call.destination === operation.destination) {
						openChain.splice(chainIndex, 1)
						closedCall = true
						break
					}
				}
				if (closedCall) break
			}
			if (!closedCall) throw new Error(`terminate ${operation.id} targets destination "${operation.destination}" but no open call matches`)
		}
	}
}

describe('demo scenarios', () => {
	test('every scenario exposes an id, label, and at least one frame', () => {
		for (const scenario of scenarios) {
			expect(typeof scenario.id).toBe('string')
			expect(scenario.id.length).toBeGreaterThan(0)
			expect(typeof scenario.label).toBe('string')
			expect(scenario.label.length).toBeGreaterThan(0)
			expect(scenario.frames.length).toBeGreaterThan(0)
		}
	})

	test('scenario ids are unique', () => {
		const ids = scenarios.map((scenario) => scenario.id)
		expect(new Set(ids).size).toBe(ids.length)
	})

	test('every frame of every scenario satisfies the model contract', () => {
		for (const scenario of scenarios) {
			scenario.frames.forEach((frame, index) => {
				try {
					validateFrame(frame)
				} catch (error) {
					throw new Error(`${scenario.id} frame ${index} failed validation: ${error instanceof Error ? error.message : String(error)}`)
				}
			})
		}
	})

	test('each frame carries a non-decreasing operation count that steps up by at most one and holds on the working frame of a call/return', () => {
		// A call/return spec expands to two frames (transit then working) that both carry the same operation count, and an observe spec expands to a single frame; the operation count therefore steps up by one exactly when a new spec's first frame arrives and holds steady on the second frame of a call/return. The count never decreases and never jumps by more than one, and at least one scenario carries consecutive equal-count frames (the transit/working pair) since every scenario has at least one call/return op.
		let anyConsecutiveEqual = false
		for (const scenario of scenarios) {
			let previousCount = 0
			scenario.frames.forEach((frame, index) => {
				const count = frame.operations.length
				if (index === 0) expect(count).toBe(1)
				if (count < previousCount) throw new Error(`${scenario.id} frame ${index}: operation count decreased from ${previousCount} to ${count}`)
				if (count > previousCount + 1) throw new Error(`${scenario.id} frame ${index}: operation count jumped from ${previousCount} to ${count}`)
				if (index > 0 && count === previousCount) anyConsecutiveEqual = true
				previousCount = count
			})
		}
		expect(anyConsecutiveEqual).toBe(true)
	})

	test('the expected scenario set is present', () => {
		const ids = new Set(scenarios.map((scenario) => scenario.id))
		const expected = [
			'single-role-completion',
			'delegation-chain',
			'retry-with-fresh-instance',
			'deep-call-tree',
			'pending-question',
			'detected-loop-interrupt',
			'nested-interrupt',
			'nested-interrupt-deep',
			'rewind-fate',
			'rewind-multi-terminate',
			'terminate-fate',
			'error-return',
		]
		for (const id of expected) expect(ids.has(id)).toBe(true)
	})

	test('retry exposes two distinct coder participant instances with the same role', () => {
		const retry = defined(scenarios.find((scenario) => scenario.id === 'retry-with-fresh-instance'), 'retry')
		expect(retry).toBeDefined()
		const finalFrame = defined(retry.frames[retry.frames.length - 1], 'finalFrame')
		expect(finalFrame).toBeDefined()
		const coders = finalFrame.participants.filter((participant) => participant.role === 'coder')
		expect(coders.length).toBe(2)
		expect(coders[0]?.id).not.toBe(coders[1]?.id)
	})

	test('the detected-loop interrupt carries an observe whose source and destination sit in different stacks', () => {
		const interrupt = defined(scenarios.find((scenario) => scenario.id === 'detected-loop-interrupt'), 'interrupt')
		expect(interrupt).toBeDefined()
		const framesWithObserve = interrupt.frames.filter((frame) => observesOf(frame).length > 0)
		expect(framesWithObserve.length).toBeGreaterThan(0)
		const frame = defined(framesWithObserve[0], 'framesWithObserve[0]')
		const observe = defined(observesOf(frame)[0], 'observe')
		const sourceStack = frame.operations.find((operation) => operation.destination === observe.source || operation.source === observe.source)?.stack
		const destinationStack = frame.operations.find((operation) => operation.destination === observe.destination || operation.source === observe.destination)?.stack
		expect(sourceStack).toBe(observe.stack)
		expect(destinationStack).not.toBe(observe.stack)
	})

	test('a frame with an unknown participant id fails validation', () => {
		const malformed: InteractionModel = {
			participants: [{ id: 'you', role: 'human', kind: 'human' }],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'ghost', startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, details: null, metrics: null },
			],
			status: 'running',
		}
		expect(() => validateFrame(malformed)).toThrow()
	})

	test('a frame with a self-call fails validation', () => {
		const malformed: InteractionModel = {
			participants: [{ id: 'you', role: 'human', kind: 'human' }],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'you', startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, details: null, metrics: null },
			],
			status: 'running',
		}
		expect(() => validateFrame(malformed)).toThrow()
	})

	test('a frame with two in_flight operations on one stack fails validation', () => {
		const malformed: InteractionModel = {
			participants: [
				{ id: 'you', role: 'human', kind: 'human' },
				{ id: 'orch', role: 'orchestrator', kind: 'role' },
				{ id: 'coder', role: 'coder', kind: 'role' },
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orch', startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, details: null, metrics: null },
				{ id: 'op2', kind: 'call', stack: 'root', source: 'orch', destination: 'coder', startedAt: 't1', settledAt: null, lifecycle: 'in_flight', outcome: null, details: null, metrics: null },
			],
			status: 'running',
		}
		expect(() => validateFrame(malformed)).toThrow()
	})

	test('a frame whose return does not match its call fails validation', () => {
		const malformed: InteractionModel = {
			participants: [
				{ id: 'you', role: 'human', kind: 'human' },
				{ id: 'orch', role: 'orchestrator', kind: 'role' },
				{ id: 'coder', role: 'coder', kind: 'role' },
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orch', startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, details: null, metrics: null },
				// The return claims to come from coder, but the open call was to orch — a stack-id or endpoint mismatch.
				{ id: 'op2', kind: 'return', stack: 'root', source: 'coder', destination: 'orch', startedAt: 't1', settledAt: 't2', lifecycle: 'settled', outcome: 'success', details: null, metrics: null },
			],
			status: 'running',
		}
		expect(() => validateFrame(malformed)).toThrow()
	})
})
