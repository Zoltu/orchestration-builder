import { describe, expect, test } from 'bun:test'

import { createCheckpointRecorder, isRunCheckpoint, type CheckpointFrame, type CheckpointRecorder, type RunCheckpoint } from './checkpoint.ts'
import { createContextPressureTracker } from './context-pressure.ts'
import type { EngineContext, RoleState } from './engine-state.ts'
import type { LoadedGuild } from './loader.ts'
import { createRoleRegistry, type RoleRegistry, type RoleRegistryEntry } from './role-registry.ts'
import type { ToolCall } from './types.ts'

function sampleRoleState(overrides: Partial<RoleState> = {}): RoleState {
	return {
		history: [
			{ role: 'system', content: 'prompt' },
			{ role: 'user', content: 'task' },
		],
		lastPromptTokens: 10,
		recentCompactionPromptTokens: [],
		recentToolCalls: [],
		toolCallCount: 0,
		generatedTokens: 5,
		contextExceededAttempts: 0,
		loopCheckToolCallWatermark: 0,
		loopCheckTokenWatermark: 0,
		...overrides,
	}
}

function agentToolCall(id: string = 'agent_1'): ToolCall {
	return {
		id,
		type: 'function',
		function: { name: 'agent', arguments: JSON.stringify({ role: 'coder', task: 'subtask' }) },
	}
}

function sampleCheckpoint(): RunCheckpoint {
	return {
		version: 1,
		runId: 'run-1',
		startTime: '2026-01-01T00:00:00.000Z',
		registryCounter: 2,
		frames: [
			{
				roleId: 'main-0-1',
				roleName: 'main',
				depth: 0,
				task: 'do it',
				effort: 'standard',
				roleState: sampleRoleState({
					history: [
						{ role: 'system', content: 'prompt' },
						{ role: 'user', content: 'do it' },
						{ role: 'assistant', content: '', tool_calls: [agentToolCall()] },
					],
					toolCallCount: 1,
				}),
				pending: { toolCalls: [agentToolCall()], agentIndex: 0 },
			},
			{
				roleId: 'coder-1-2',
				roleName: 'coder',
				depth: 1,
				task: 'subtask',
				parent: 'main',
				parentRoleId: 'main-0-1',
				roleState: sampleRoleState({ toolCallCount: 4 }),
			},
		],
	}
}

describe('isRunCheckpoint', () => {
	test('accepts a well-formed checkpoint', () => {
		expect(isRunCheckpoint(sampleCheckpoint())).toBe(true)
	})

	test('round-trips through JSON', () => {
		const copy: unknown = JSON.parse(JSON.stringify(sampleCheckpoint()))
		expect(isRunCheckpoint(copy)).toBe(true)
	})

	test('rejects non-objects, wrong versions, and missing frames', () => {
		expect(isRunCheckpoint(null)).toBe(false)
		expect(isRunCheckpoint('checkpoint')).toBe(false)
		expect(isRunCheckpoint({ ...sampleCheckpoint(), version: 2 })).toBe(false)
		expect(isRunCheckpoint({ ...sampleCheckpoint(), frames: [] })).toBe(false)
	})

	test('rejects a malformed role state', () => {
		const withLeafToolCallCount = (toolCallCount: unknown) => {
			const checkpoint = sampleCheckpoint()
			return {
				...checkpoint,
				frames: checkpoint.frames.map((frame, index) => (index === 1 ? { ...frame, roleState: { ...frame.roleState, toolCallCount } } : frame)),
			}
		}
		expect(isRunCheckpoint(withLeafToolCallCount('four'))).toBe(false)
	})

	test('rejects malformed messages in a history', () => {
		const withLeafHistory = (history: unknown) => {
			const checkpoint = sampleCheckpoint()
			return {
				...checkpoint,
				frames: checkpoint.frames.map((frame, index) => (index === 1 ? { ...frame, roleState: { ...frame.roleState, history } } : frame)),
			}
		}
		expect(isRunCheckpoint(withLeafHistory([{ role: 'ghost', content: 'boo' }]))).toBe(false)
	})

	test('enforces the suspension invariant: non-leaf pending without a card, leaf pending only with a recorded card', () => {
		const pendingOnLeaf = sampleCheckpoint()
		const leaf = pendingOnLeaf.frames[1]
		if (leaf === undefined) throw new Error('missing leaf')
		leaf.pending = { toolCalls: [agentToolCall()], agentIndex: 0 }
		expect(isRunCheckpoint(pendingOnLeaf)).toBe(false)

		const leafWithCard = sampleCheckpoint()
		const singleFrame = leafWithCard.frames[0]
		if (singleFrame === undefined || singleFrame.pending === undefined) throw new Error('missing root')
		singleFrame.pending = { ...singleFrame.pending, childCard: { status: 'success', summary: 'child done' } }
		leafWithCard.frames = [singleFrame]
		expect(isRunCheckpoint(leafWithCard)).toBe(true)

		const cardOnNonLeaf = sampleCheckpoint()
		const root = cardOnNonLeaf.frames[0]
		if (root === undefined || root.pending === undefined) throw new Error('missing root')
		root.pending = { ...root.pending, childCard: { status: 'success', summary: 'child done' } }
		expect(isRunCheckpoint(cardOnNonLeaf)).toBe(false)

		const missingPending = sampleCheckpoint()
		const rootFrame = missingPending.frames[0]
		if (rootFrame === undefined) throw new Error('missing root')
		delete rootFrame.pending
		expect(isRunCheckpoint(missingPending)).toBe(false)
	})

	test('rejects a pending whose indexed call is not an agent call', () => {
		const checkpoint = sampleCheckpoint()
		const root = checkpoint.frames[0]
		if (root === undefined || root.pending === undefined) throw new Error('missing pending')
		root.pending = {
			toolCalls: [{ id: 'f1', type: 'function', function: { name: 'finish', arguments: '{}' } }],
			agentIndex: 0,
		}
		expect(isRunCheckpoint(checkpoint)).toBe(false)
	})

	test('rejects a stack that does not root at depth 0 or breaks the parent chain', () => {
		const wrongRootDepth = sampleCheckpoint()
		const root = wrongRootDepth.frames[0]
		if (root === undefined) throw new Error('missing root')
		root.depth = 1
		expect(isRunCheckpoint(wrongRootDepth)).toBe(false)

		const brokenChain = sampleCheckpoint()
		const leaf = brokenChain.frames[1]
		if (leaf === undefined) throw new Error('missing leaf')
		leaf.parentRoleId = 'someone-else'
		expect(isRunCheckpoint(brokenChain)).toBe(false)
	})

	test('rejects a corrupt recorded child card', () => {
		const withChildCard = (childCard: unknown) => {
			const checkpoint = sampleCheckpoint()
			return {
				...checkpoint,
				frames: checkpoint.frames.map((frame, index) => (index === 0 && frame.pending !== undefined ? { ...frame, pending: { ...frame.pending, childCard } } : frame)),
			}
		}
		expect(isRunCheckpoint(withChildCard({ status: 'exploded', summary: 'x' }))).toBe(false)
	})

	test('accepts optional accumulator fields when well-formed', () => {
		const checkpoint = sampleCheckpoint()
		checkpoint.learnedContextCeiling = 4096
		const root = checkpoint.frames[0]
		if (root === undefined) throw new Error('missing root')
		root.planAbort = true
		root.roleState = {
			...root.roleState,
			contextPressureNotice: 'sent',
			contextCompactionPending: { promptTokens: 900, contextWindow: 1000 },
		}
		expect(isRunCheckpoint(checkpoint)).toBe(true)
	})
})

describe('createCheckpointRecorder', () => {
	const guild: LoadedGuild = {
		config: {
			entryRole: 'main',
			roles: {},
			tools: [],
		},
		deployment: {
			model: { name: 'm', apiBase: 'http://x', contextWindow: 32768, generation: {} },
			executor: { maxAgentDepth: 8, defaultToolTimeoutSeconds: 30, maxCompactionAttempts: 5 },
			contextPolicy: { maxToolOutputChars: 4000 },
		},
		prompts: {},
		tools: {},
	}

	function frameContext(roleName: string, depth: number, overrides: Partial<EngineContext> = {}): EngineContext {
		return { loadedGuild: guild, depth, roleName, task: `task for ${roleName}`, ...overrides }
	}

	function registerRoot(recorder: CheckpointRecorder, registry: RoleRegistry): RoleRegistryEntry {
		const context = frameContext('main', 0, { effort: 'standard' })
		const entry = registry.register('main', 0, undefined, sampleRoleState())
		recorder.registerFrame(context, entry)
		return entry
	}

	test('writes a checkpoint capturing frames root-first with run identity', () => {
		const written: RunCheckpoint[] = []
		const registry = createRoleRegistry()
		const tracker = createContextPressureTracker(4096)
		const recorder = createCheckpointRecorder({ writeCheckpoint: (c) => written.push(c), runId: 'run-9', startTime: '2026-01-01T00:00:00.000Z', roleRegistry: registry, contextPressureTracker: tracker })

		registerRoot(recorder, registry)
		const childContext = frameContext('coder', 1, { parent: 'main', parentRoleId: 'main-0-1' })
		const childEntry = registry.register('coder', 1, 'main-0-1', sampleRoleState({ toolCallCount: 2 }))
		recorder.registerFrame(childContext, childEntry)
		recorder.write()

		expect(written.length).toBe(1)
		const checkpoint = written[0]
		expect(checkpoint).toBeDefined()
		if (checkpoint === undefined) return
		expect(checkpoint.runId).toBe('run-9')
		expect(checkpoint.startTime).toBe('2026-01-01T00:00:00.000Z')
		expect(checkpoint.registryCounter).toBe(2)
		expect(checkpoint.learnedContextCeiling).toBe(4096)
		expect(checkpoint.frames.map((frame: CheckpointFrame) => frame.roleName)).toEqual(['main', 'coder'])
		const leaf = checkpoint.frames[1]
		expect(leaf?.roleState.toolCallCount).toBe(2)
	})

	test('reads live role state at write time, so mutations between writes are captured', () => {
		const written: RunCheckpoint[] = []
		const registry = createRoleRegistry()
		const recorder = createCheckpointRecorder({ writeCheckpoint: (c) => written.push(c), runId: 'run-1', startTime: '2026-01-01T00:00:00.000Z', roleRegistry: registry, contextPressureTracker: createContextPressureTracker() })
		const entry = registerRoot(recorder, registry)

		entry.roleState.toolCallCount = 7
		entry.roleState.history.push({ role: 'assistant', content: 'progress' })
		recorder.write()

		const checkpoint = written[0]
		expect(checkpoint?.frames[0]?.roleState.toolCallCount).toBe(7)
		expect(checkpoint?.frames[0]?.roleState.history.length).toBe(3)
	})

	test('pending suspension and child card are recorded on the frame and cleared', () => {
		const written: RunCheckpoint[] = []
		const registry = createRoleRegistry()
		const recorder = createCheckpointRecorder({ writeCheckpoint: (c) => written.push(c), runId: 'run-1', startTime: '2026-01-01T00:00:00.000Z', roleRegistry: registry, contextPressureTracker: createContextPressureTracker() })
		const entry = registerRoot(recorder, registry)

		recorder.setPending(entry.roleId, { toolCalls: [agentToolCall()], agentIndex: 0 })
		recorder.setPendingChildCard(entry.roleId, { status: 'success', summary: 'child done' })
		recorder.write()
		expect(written[0]?.frames[0]?.pending?.childCard).toEqual({ status: 'success', summary: 'child done' })

		recorder.setPending(entry.roleId, undefined)
		recorder.write()
		expect(written[1]?.frames[0]?.pending).toBeUndefined()
	})

	test('recording a child card with no pending suspension fails fast', () => {
		const registry = createRoleRegistry()
		const recorder = createCheckpointRecorder({ writeCheckpoint: () => {}, runId: 'run-1', startTime: '2026-01-01T00:00:00.000Z', roleRegistry: registry, contextPressureTracker: createContextPressureTracker() })
		const entry = registerRoot(recorder, registry)

		expect(() => recorder.setPendingChildCard(entry.roleId, { status: 'success', summary: 'x' })).toThrow()
	})

	test('writes are suppressed while a handler frame is on the stack and resume when it unwinds', () => {
		const written: RunCheckpoint[] = []
		const registry = createRoleRegistry()
		const recorder = createCheckpointRecorder({ writeCheckpoint: (c) => written.push(c), runId: 'run-1', startTime: '2026-01-01T00:00:00.000Z', roleRegistry: registry, contextPressureTracker: createContextPressureTracker() })
		registerRoot(recorder, registry)

		const handlerContext = frameContext('loop_detector', 1, { parent: 'main', parentRoleId: 'main-0-1', handlerOf: 'main-0-1' })
		const handlerEntry = registry.register('loop_detector', 1, 'main-0-1', sampleRoleState())
		recorder.registerFrame(handlerContext, handlerEntry)
		recorder.write()
		expect(written.length).toBe(0)

		recorder.unregisterFrame(handlerEntry.roleId)
		recorder.write()
		expect(written.length).toBe(1)
		expect(written[0]?.frames.map((frame: CheckpointFrame) => frame.roleName)).toEqual(['main'])
	})

	test('unregistered frames disappear from later writes', () => {
		const written: RunCheckpoint[] = []
		const registry = createRoleRegistry()
		const recorder = createCheckpointRecorder({ writeCheckpoint: (c) => written.push(c), runId: 'run-1', startTime: '2026-01-01T00:00:00.000Z', roleRegistry: registry, contextPressureTracker: createContextPressureTracker() })
		registerRoot(recorder, registry)
		const childEntry = registry.register('coder', 1, 'main-0-1', sampleRoleState())
		recorder.registerFrame(frameContext('coder', 1, { parent: 'main', parentRoleId: 'main-0-1' }), childEntry)
		recorder.write()
		expect(written[0]?.frames.length).toBe(2)

		recorder.unregisterFrame(childEntry.roleId)
		recorder.write()
		expect(written[1]?.frames.length).toBe(1)
	})

	test('frames are ordered by depth even when registered leaf-first (the resume path)', () => {
		const written: RunCheckpoint[] = []
		const registry = createRoleRegistry(2)
		const recorder = createCheckpointRecorder({ writeCheckpoint: (c) => written.push(c), runId: 'run-1', startTime: '2026-01-01T00:00:00.000Z', roleRegistry: registry, contextPressureTracker: createContextPressureTracker() })

		const leafEntry = registry.register('coder', 1, 'main-0-1', sampleRoleState(), 'coder-1-2')
		recorder.registerFrame(frameContext('coder', 1, { parent: 'main', parentRoleId: 'main-0-1' }), leafEntry)
		const rootEntry = registry.register('main', 0, undefined, sampleRoleState(), 'main-0-1')
		recorder.registerFrame(frameContext('main', 0, { effort: 'standard' }), rootEntry)
		recorder.write()

		expect(written[0]?.frames.map((frame: CheckpointFrame) => frame.roleId)).toEqual(['main-0-1', 'coder-1-2'])
	})
})
