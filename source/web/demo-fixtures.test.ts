import { describe, expect, test } from 'bun:test'
import type { RunSnapshot } from './render.js'
import { deriveInteractionModel } from './interaction-model-adapter.js'
import { DEMO_SCENARIOS, demoScenarioMeta, findDemoScenario } from './demo-fixtures.js'

function frameModel(scenarioId: string, frameIndex: number): ReturnType<typeof deriveInteractionModel> {
	const scenario = findDemoScenario(scenarioId)!
	const events = scenario.events.slice(0, frameIndex + 1)
	const meta = demoScenarioMeta(scenario, frameIndex)
	const now = scenario.events[frameIndex]!.timestamp
	const snapshot: RunSnapshot = { meta, logEvents: events }
	return deriveInteractionModel(snapshot, now)
}

describe('demo fixtures — adapter behavior over event streams', () => {
	test('every fixture is well-formed (statuses length matches events, non-empty, parseable)', () => {
		for (const scenario of DEMO_SCENARIOS) {
			expect(scenario.events.length).toBeGreaterThan(0)
			expect(scenario.statuses.length).toBe(scenario.events.length)
			expect(scenario.statuses[scenario.statuses.length - 1]).not.toBe('running')
			const lastModel = frameModel(scenario.id, scenario.events.length - 1)
			expect(Array.isArray(lastModel.participants)).toBe(true)
			expect(lastModel.participants[0]).toEqual({ id: 'human:root', role: 'human', kind: 'human' })
		}
	})

	test('delegation-chain: the read_file return lingers at the tool_result frame', () => {
		const scenario = findDemoScenario('delegation-chain')!
		const toolResultIndex = scenario.events.findIndex((e) => e.type === 'tool_result')
		const model = frameModel(scenario.id, toolResultIndex)
		const inFlightReturns = model.operations.filter((o) => o.kind === 'return' && o.lifecycle === 'in_flight')
		expect(inFlightReturns.length).toBe(1)
		const readFile = model.participants.find((p) => p.role === 'read_file')
		expect(readFile).toBeDefined()
		expect(inFlightReturns[0]!.source).toBe(readFile!.id)
	})

	test('delegation-chain: the caller resuming settles the lingering tool return', () => {
		const scenario = findDemoScenario('delegation-chain')!
		const toolResultIndex = scenario.events.findIndex((e) => e.type === 'tool_result')
		// The frame after tool_result is llm_call completion — the caller resumed, settling the return.
		const afterCall = frameModel(scenario.id, toolResultIndex + 1)
		expect(afterCall.operations.filter((o) => o.kind === 'return' && o.lifecycle === 'in_flight').length).toBe(0)
	})

	test('delegation-chain: the terminal frame has nothing in flight', () => {
		const scenario = findDemoScenario('delegation-chain')!
		const last = frameModel(scenario.id, scenario.events.length - 1)
		expect(last.status).toBe('success')
		expect(last.operations.every((o) => o.lifecycle === 'settled')).toBe(true)
	})

	test('retry-with-fresh-instance: two distinct coder participants share the role name', () => {
		const scenario = findDemoScenario('retry-with-fresh-instance')!
		const last = frameModel(scenario.id, scenario.events.length - 1)
		const coders = last.participants.filter((p) => p.role === 'coder')
		expect(coders.length).toBe(2)
		expect(coders[0]!.id).not.toBe(coders[1]!.id)
		const coderReturns = last.operations.filter((o) => o.kind === 'return' && o.source.startsWith('role:coder:'))
		expect(coderReturns.length).toBe(2)
		expect(coderReturns[0]!.outcome).toBe('error')
		expect(coderReturns[1]!.outcome).toBe('success')
	})

	test('pending-question: the final frame is needs_clarification with the ask_human call in flight', () => {
		const scenario = findDemoScenario('pending-question')!
		const last = frameModel(scenario.id, scenario.events.length - 1)
		expect(last.status).toBe('needs_clarification')
		const askCall = last.operations.find((o) => o.kind === 'call' && o.destination.startsWith('human:answerer'))
		expect(askCall).toBeDefined()
		expect(askCall!.lifecycle).toBe('in_flight')
	})

	test('error-return: the terminal frame carries the error status and an error return', () => {
		const scenario = findDemoScenario('error-return')!
		const last = frameModel(scenario.id, scenario.events.length - 1)
		expect(last.status).toBe('error')
		const errorReturn = last.operations.find((o) => o.kind === 'return')
		expect(errorReturn!.outcome).toBe('error')
	})

	test('single-role-completion: the call is in transit at role_start and settles at llm_call_start', () => {
		const scenario = findDemoScenario('single-role-completion')!
		const roleStartIndex = scenario.events.findIndex((e) => e.type === 'role_start')
		const llmCallStartIndex = scenario.events.findIndex((e) => e.type === 'llm_call_start')
		const transitFrame = frameModel(scenario.id, roleStartIndex)
		const workingFrame = frameModel(scenario.id, llmCallStartIndex)
		const transitCall = transitFrame.operations.find((o) => o.kind === 'call')
		const workingCall = workingFrame.operations.find((o) => o.kind === 'call')
		// At role_start: the request is in transit — the call edge flows.
		expect(transitCall!.lifecycle).toBe('in_flight')
		// At llm_call_start: the callee began working — the edge goes solid while the node stays highlighted.
		expect(workingCall!.lifecycle).toBe('settled')
	})

	test('detected-loop-interrupt: the observe references the paused main stack from the interrupt tool', () => {
		const scenario = findDemoScenario('detected-loop-interrupt')!
		const observeIndex = scenario.events.findIndex((e) => e.type === 'observe')
		const model = frameModel(scenario.id, observeIndex)
		const observe = model.operations.find((o) => o.kind === 'observe')
		expect(observe).toBeDefined()
		const readTool = model.participants.find((p) => p.role === 'read_message_window')
		const coder = model.participants.find((p) => p.role === 'coder')
		expect(observe!.source).toBe(readTool!.id)
		expect(observe!.destination).toBe(coder!.id)
		expect(observe!.stack).not.toBe('main')
	})

	test('nested-interrupt: three stacks coexist while both interrupts are open', () => {
		const scenario = findDemoScenario('nested-interrupt')!
		const interruptIndices = scenario.events.map((e, i) => (e.type === 'interrupt' ? i : -1)).filter((i) => i >= 0)
		const innerInterruptIndex = interruptIndices[interruptIndices.length - 1]!
		// Frame after the inner interrupt's loop_detector starts: main + interrupt-1 + interrupt-2.
		const model = frameModel(scenario.id, innerInterruptIndex + 2)
		const interrupts = model.participants.filter((p) => p.kind === 'interrupt')
		expect(interrupts.length).toBe(2)
		const detectors = model.participants.filter((p) => p.role === 'loop_detector')
		expect(detectors.length).toBe(2)
	})

	test('rewind-fate: the terminate closes the looping coder call and the ancestor retries with a fresh coder', () => {
		const scenario = findDemoScenario('rewind-fate')!
		const last = frameModel(scenario.id, scenario.events.length - 1)
		const terminates = last.operations.filter((o) => o.kind === 'terminate')
		expect(terminates.length).toBe(1)
		const coders = last.participants.filter((p) => p.role === 'coder')
		expect(coders.length).toBe(2)
	})

	test('nested-interrupt-deep: the inner observe reaches across the middle stack to the outermost coder', () => {
		const scenario = findDemoScenario('nested-interrupt-deep')!
		const observeIndex = scenario.events.findIndex((e) => e.type === 'observe')
		const model = frameModel(scenario.id, observeIndex)
		const observe = model.operations.find((o) => o.kind === 'observe')
		expect(observe).toBeDefined()
		const readTool = model.participants.filter((p) => p.role === 'read_message_window')[1]
		const coder = model.participants.find((p) => p.role === 'coder')
		expect(observe!.source).toBe(readTool!.id)
		expect(observe!.destination).toBe(coder!.id)
	})

	test('rewind-multi-terminate: three interrupts and two terminates', () => {
		const scenario = findDemoScenario('rewind-multi-terminate')!
		const last = frameModel(scenario.id, scenario.events.length - 1)
		expect(last.participants.filter((p) => p.kind === 'interrupt').length).toBe(3)
		expect(last.operations.filter((o) => o.kind === 'terminate').length).toBe(2)
		expect(last.participants.filter((p) => p.role === 'coder').length).toBe(2)
		expect(last.participants.filter((p) => p.role === 'planner').length).toBe(1)
	})

	test('terminate-fate: the terminates discard the whole main stack, leaving only the interrupt work', () => {
		const scenario = findDemoScenario('terminate-fate')!
		const last = frameModel(scenario.id, scenario.events.length - 1)
		expect(last.operations.filter((o) => o.kind === 'terminate').length).toBe(2)
		// Both main-stack calls (orchestrator and coder) are closed by the terminates.
		const coderCall = last.operations.find((o) => o.kind === 'call' && o.destination === last.participants.find((p) => p.role === 'coder')!.id)
		const orchestratorCall = last.operations.find((o) => o.kind === 'call' && o.destination === last.participants.find((p) => p.role === 'orchestrator')!.id)
		expect(coderCall!.lifecycle).toBe('settled')
		expect(orchestratorCall!.lifecycle).toBe('settled')
	})
})
