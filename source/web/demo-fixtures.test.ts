import { describe, expect, test } from 'bun:test'
import type { LogEvent } from '../executor/types.js'
import { activeParticipant, activeStack, stacksOf } from './static/ts/interaction-model.js'
import { deriveDemoFrameModel, DEMO_SCENARIOS, findDemoScenario } from './demo-fixtures.js'
import { defined } from './test-fixtures.js'

function frameModel(scenarioId: string, frameIndex: number): ReturnType<typeof deriveDemoFrameModel> {
	return deriveDemoFrameModel(defined(findDemoScenario(scenarioId), 'scenario'), frameIndex)
}

function payloadRole(event: LogEvent): string | null {
	const payload = event.payload
	if (typeof payload !== 'object' || payload === null) return null
	if (!('role' in payload)) return null
	return typeof payload.role === 'string' ? payload.role : null
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
		const scenario = defined(findDemoScenario('delegation-chain'), 'scenario')
		const toolResultIndex = scenario.events.findIndex((e) => e.type === 'tool_result')
		const model = frameModel(scenario.id, toolResultIndex)
		const inFlightReturns = model.operations.filter((o) => o.kind === 'return' && o.lifecycle === 'in_flight')
		expect(inFlightReturns.length).toBe(1)
		const readFile = model.participants.find((p) => p.role === 'read_file')
		expect(readFile).toBeDefined()
		expect(defined(inFlightReturns[0], 'inFlightReturns[0]').source).toBe(defined(readFile, 'readFile').id)
	})

	test('delegation-chain: the caller resuming settles the lingering tool return', () => {
		const scenario = defined(findDemoScenario('delegation-chain'), 'scenario')
		const toolResultIndex = scenario.events.findIndex((e) => e.type === 'tool_result')
		// The frame after tool_result is llm_call completion — the caller resumed, settling the return.
		const afterCall = frameModel(scenario.id, toolResultIndex + 1)
		expect(afterCall.operations.filter((o) => o.kind === 'return' && o.lifecycle === 'in_flight').length).toBe(0)
	})

	test('delegation-chain: the terminal frame keeps only the final return in flight under the terminal status', () => {
		const scenario = defined(findDemoScenario('delegation-chain'), 'scenario')
		const last = frameModel(scenario.id, scenario.events.length - 1)
		expect(last.status).toBe('success')
		// A finished run's last observable state carries the final return still in flight: the lingering leg to You renders until the See Result click settles it. Everything earlier has settled.
		const inFlight = last.operations.filter((o) => o.lifecycle === 'in_flight')
		expect(inFlight.length).toBe(1)
		expect(defined(inFlight[0], 'inFlight[0]').kind).toBe('return')
		expect(defined(inFlight[0], 'inFlight[0]').destination).toBe('human:root')
	})

	test('deep-call-tree: the unwind closes one role per step — planner, then the orchestrator thinks, then the terminal leg to You', () => {
		const scenario = defined(findDemoScenario('deep-call-tree'), 'scenario')
		const orchestrator = defined(frameModel(scenario.id, scenario.events.length - 1).participants.find((p) => p.role === 'orchestrator'), 'orchestrator participant')
		const plannerFinishIndex = scenario.events.findIndex((event) => event.type === 'role_finished' && payloadRole(event) === 'planner')
		// The planner's close-out lands its return leg to the orchestrator and nothing else: the orchestrator has not acted yet, so only that leg is in flight.
		const plannerFinish = frameModel(scenario.id, plannerFinishIndex)
		const plannerLeg = plannerFinish.operations.filter((o) => o.lifecycle === 'in_flight')
		expect(plannerLeg.length).toBe(1)
		expect(defined(plannerLeg[0], 'plannerLeg[0]').kind).toBe('return')
		expect(defined(plannerLeg[0], 'plannerLeg[0]').destination).toBe(orchestrator.id)
		// The orchestrator resuming (its llm_call) settles the planner's leg, so the planner closes out alone and the orchestrator becomes the active thinker with nothing in flight.
		const orchestratorThinking = frameModel(scenario.id, plannerFinishIndex + 1)
		expect(orchestratorThinking.operations.filter((o) => o.lifecycle === 'in_flight').length).toBe(0)
		const activeOperation = defined(orchestratorThinking.operations[orchestratorThinking.operations.length - 1], 'activeOperation')
		expect(activeOperation.destination).toBe(orchestrator.id)
		// The terminal step keeps only the orchestrator's return to You in flight (the green return line) under the terminal status, so the CTA and result pop-up render while the leg lingers.
		const last = frameModel(scenario.id, scenario.events.length - 1)
		expect(last.status).toBe('success')
		const finalLeg = last.operations.filter((o) => o.lifecycle === 'in_flight')
		expect(finalLeg.length).toBe(1)
		expect(defined(finalLeg[0], 'finalLeg[0]').kind).toBe('return')
		expect(defined(finalLeg[0], 'finalLeg[0]').destination).toBe('human:root')
		expect(defined(finalLeg[0], 'finalLeg[0]').source).toBe(orchestrator.id)
	})

	test('retry-with-fresh-instance: two distinct coder participants share the role name', () => {
		const scenario = defined(findDemoScenario('retry-with-fresh-instance'), 'scenario')
		const last = frameModel(scenario.id, scenario.events.length - 1)
		const coders = last.participants.filter((p) => p.role === 'coder')
		expect(coders.length).toBe(2)
		expect(defined(coders[0], 'coders[0]').id).not.toBe(defined(coders[1], 'coders[1]').id)
		const coderReturns = last.operations.filter((o) => o.kind === 'return' && o.source.startsWith('role:coder:'))
		expect(coderReturns.length).toBe(2)
		expect(defined(coderReturns[0], 'coderReturns[0]').outcome).toBe('error')
		expect(defined(coderReturns[1], 'coderReturns[1]').outcome).toBe('success')
	})

	test('pending-question: the needs_clarification frame holds the ask_human call in flight, and the answer returns to the orchestrator', () => {
		const scenario = defined(findDemoScenario('pending-question'), 'scenario')
		const askIndex = scenario.events.findIndex((event) => event.type === 'ask_human')
		const asked = frameModel(scenario.id, askIndex)
		expect(asked.status).toBe('needs_clarification')
		const askCall = defined(asked.operations.find((o) => o.kind === 'call' && o.destination.startsWith('human:answerer')), 'askCall')
		expect(askCall).toBeDefined()
		expect(askCall.lifecycle).toBe('in_flight')
		// The answer's frame: a green return leg from the answerer back to the orchestrator, with the orchestrator active.
		const answered = frameModel(scenario.id, askIndex + 1)
		expect(answered.status).toBe('running')
		const leg = answered.operations.filter((o) => o.lifecycle === 'in_flight' && o.kind === 'return')
		expect(leg.length).toBe(1)
		expect(defined(leg[0], 'leg[0]').source).toBe(askCall.destination)
		expect(activeParticipant(answered)).toBe(defined(answered.participants.find((p) => p.role === 'orchestrator'), 'orchestrator participant').id)
		// The orchestrator's next llm_call settles the leg: the answerer closes out.
		const resumed = frameModel(scenario.id, askIndex + 2)
		expect(resumed.operations.filter((o) => o.lifecycle === 'in_flight' && o.kind === 'return').length).toBe(0)
	})

	test('error-return: the terminal frame carries the error status and an error return', () => {
		const scenario = defined(findDemoScenario('error-return'), 'scenario')
		const last = frameModel(scenario.id, scenario.events.length - 1)
		expect(last.status).toBe('error')
		const errorReturn = defined(last.operations.find((o) => o.kind === 'return'), 'errorReturn')
		expect(errorReturn.outcome).toBe('error')
	})

	test('single-role-completion: the call is in transit at role_start and settles at llm_call_start', () => {
		const scenario = defined(findDemoScenario('single-role-completion'), 'scenario')
		const roleStartIndex = scenario.events.findIndex((e) => e.type === 'role_start')
		const llmCallStartIndex = scenario.events.findIndex((e) => e.type === 'llm_call_start')
		const transitFrame = frameModel(scenario.id, roleStartIndex)
		const workingFrame = frameModel(scenario.id, llmCallStartIndex)
		const transitCall = transitFrame.operations.find((o) => o.kind === 'call')
		const workingCall = workingFrame.operations.find((o) => o.kind === 'call')
		// At role_start: the request is in transit — the call edge flows.
		expect(defined(transitCall, 'transitCall').lifecycle).toBe('in_flight')
		// At llm_call_start: the callee began working — the edge goes solid while the node stays highlighted.
		expect(defined(workingCall, 'workingCall').lifecycle).toBe('settled')
	})

	test('detected-loop-interrupt: the interrupt node is active from its preemption frame', () => {
		const scenario = defined(findDemoScenario('detected-loop-interrupt'), 'scenario')
		// The interrupt event's own frame: the interrupt instance shows in the view (not just the history strip) as the active worker, before its first call lands on the next frame.
		const preempted = frameModel(scenario.id, 4)
		expect(activeStack(preempted)).toBe('interrupt-1-stack')
		expect(activeParticipant(preempted)).toBe('interrupt:1')
		expect(stacksOf(preempted)).toEqual(['main', 'interrupt-1-stack'])
		// The loop detector's call lands on the next frame: the interrupt's child appears, active.
		const called = frameModel(scenario.id, 5)
		const loopDetector = defined(called.participants.find((p) => p.role === 'loop_detector'), 'loop_detector participant')
		expect(activeParticipant(called)).toBe(loopDetector.id)
	})

	test('detected-loop-interrupt: resolution keeps the return leg visible with the coder active, and the next action closes the interrupt out', () => {
		const scenario = defined(findDemoScenario('detected-loop-interrupt'), 'scenario')
		// The loop detector's role_finished frame: the coder is the current worker again, and the loop detector → interrupt return leg stays visible (in flight) rather than vanishing at once.
		const resolved = frameModel(scenario.id, 11)
		const coder = defined(resolved.participants.find((p) => p.role === 'coder'), 'coder participant')
		expect(activeStack(resolved)).toBe('main')
		expect(activeParticipant(resolved)).toBe(coder.id)
		const leg = resolved.operations.filter((o) => o.lifecycle === 'in_flight')
		expect(leg.length).toBe(1)
		expect(defined(leg[0], 'leg[0]').kind).toBe('return')
		expect(defined(leg[0], 'leg[0]').destination).toBe('interrupt:1')
		expect(stacksOf(resolved)).toEqual(['main', 'interrupt-1-stack'])
		// The coder's tool call on the next frame confirms the leg: the interrupt and the loop detector close out, and the new call is in flight.
		const resumed = frameModel(scenario.id, 12)
		expect(resumed.operations.filter((o) => o.lifecycle === 'in_flight' && o.kind === 'return').length).toBe(0)
		expect(stacksOf(resumed)).toEqual(['main'])
		const toolCall = defined(resumed.operations[resumed.operations.length - 1], 'toolCall')
		expect(toolCall.kind).toBe('call')
		expect(toolCall.lifecycle).toBe('in_flight')
	})

	test('detected-loop-interrupt: the observe references the paused main stack from the interrupt tool', () => {
		const scenario = defined(findDemoScenario('detected-loop-interrupt'), 'scenario')
		const observeIndex = scenario.events.findIndex((e) => e.type === 'observe')
		const model = frameModel(scenario.id, observeIndex)
		const observe = defined(model.operations.find((o) => o.kind === 'observe'), 'observe')
		expect(observe).toBeDefined()
		const readTool = defined(model.participants.find((p) => p.role === 'read_message_window'), 'read_message_window participant')
		const coder = defined(model.participants.find((p) => p.role === 'coder'), 'coder participant')
		expect(observe.source).toBe(readTool.id)
		expect(observe.destination).toBe(coder.id)
		expect(observe.stack).not.toBe('main')
	})

	test('nested-interrupt: three stacks coexist while both interrupts are open', () => {
		const scenario = defined(findDemoScenario('nested-interrupt'), 'scenario')
		const interruptIndices = scenario.events.map((e, i) => (e.type === 'interrupt' ? i : -1)).filter((i) => i >= 0)
		const innerInterruptIndex = defined(interruptIndices[interruptIndices.length - 1], 'interruptIndices[last]')
		// Frame after the inner interrupt's loop_detector starts: main + interrupt-1 + interrupt-2.
		const model = frameModel(scenario.id, innerInterruptIndex + 2)
		const interrupts = model.participants.filter((p) => p.kind === 'interrupt')
		expect(interrupts.length).toBe(2)
		const detectors = model.participants.filter((p) => p.role === 'loop_detector')
		expect(detectors.length).toBe(2)
	})

	test('rewind-fate: the terminate closes the looping coder call and the ancestor retries with a fresh coder', () => {
		const scenario = defined(findDemoScenario('rewind-fate'), 'scenario')
		const last = frameModel(scenario.id, scenario.events.length - 1)
		const terminates = last.operations.filter((o) => o.kind === 'terminate')
		expect(terminates.length).toBe(1)
		const coders = last.participants.filter((p) => p.role === 'coder')
		expect(coders.length).toBe(2)
	})

	test('nested-interrupt-deep: the inner observe reaches across the middle stack to the outermost coder', () => {
		const scenario = defined(findDemoScenario('nested-interrupt-deep'), 'scenario')
		const observeIndex = scenario.events.findIndex((e) => e.type === 'observe')
		const model = frameModel(scenario.id, observeIndex)
		const observe = defined(model.operations.find((o) => o.kind === 'observe'), 'observe')
		expect(observe).toBeDefined()
		const readTool = defined(model.participants.filter((p) => p.role === 'read_message_window')[1], 'read_message_window[1]')
		const coder = defined(model.participants.find((p) => p.role === 'coder'), 'coder participant')
		expect(observe.source).toBe(readTool.id)
		expect(observe.destination).toBe(coder.id)
	})

	test('rewind-multi-terminate: three interrupts and two terminates', () => {
		const scenario = defined(findDemoScenario('rewind-multi-terminate'), 'scenario')
		const last = frameModel(scenario.id, scenario.events.length - 1)
		expect(last.participants.filter((p) => p.kind === 'interrupt').length).toBe(3)
		expect(last.operations.filter((o) => o.kind === 'terminate').length).toBe(2)
		expect(last.participants.filter((p) => p.role === 'coder').length).toBe(2)
		expect(last.participants.filter((p) => p.role === 'planner').length).toBe(1)
	})

	test('terminate-fate: the terminates discard the whole main stack, leaving only the interrupt work', () => {
		const scenario = defined(findDemoScenario('terminate-fate'), 'scenario')
		const last = frameModel(scenario.id, scenario.events.length - 1)
		expect(last.operations.filter((o) => o.kind === 'terminate').length).toBe(2)
		// Both main-stack calls (orchestrator and coder) are closed by the terminates.
		const coderCall = last.operations.find((o) => o.kind === 'call' && o.destination === defined(last.participants.find((p) => p.role === 'coder'), 'coder participant').id)
		const orchestratorCall = last.operations.find((o) => o.kind === 'call' && o.destination === defined(last.participants.find((p) => p.role === 'orchestrator'), 'orchestrator participant').id)
		expect(defined(coderCall, 'coderCall').lifecycle).toBe('settled')
		expect(defined(orchestratorCall, 'orchestratorCall').lifecycle).toBe('settled')
	})
})
