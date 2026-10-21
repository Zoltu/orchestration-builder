import { describe, expect, test } from 'bun:test'
import type { EngineContext, RoleState } from '../engine-state.js'
import type { LoadedGuild } from '../loader.js'
import type { RoleRegistryEntry } from '../role-registry.js'
import type { LogEvent, Message } from '../types.js'
import { createInvocationJournal } from '../invocation.js'
import { isObject } from '../validation.js'
import { createContextManager, createContextPressureTracker, type ContextManager } from './index.js'

function guildFor(contextWindow: number, maxTokens: number | undefined, contextPressureThreshold: number | undefined, contextHandlerRole: string | undefined, maxAgentDepth = 8): LoadedGuild {
	return {
		config: { entryRole: 'main', roles: {}, tools: [] },
		deployment: {
			model: { name: 'm', apiBase: 'http://x', contextWindow, generation: maxTokens !== undefined ? { maxTokens } : {} },
			executor: {
				maxAgentDepth,
				defaultToolTimeoutSeconds: 30,
				maxCompactionAttempts: 5,
				...(contextPressureThreshold !== undefined ? { contextPressureThreshold } : {}),
				...(contextHandlerRole !== undefined ? { contextHandlerRole } : {}),
			},
			contextPolicy: { maxToolOutputChars: 4000 },
		},
		prompts: {},
		tools: {},
	}
}

function contextFor(contextWindow: number, maxTokens?: number, contextPressureThreshold?: number, contextHandlerRole?: string, maxAgentDepth = 8): EngineContext {
	return {
		loadedGuild: guildFor(contextWindow, maxTokens, contextPressureThreshold, contextHandlerRole, maxAgentDepth),
		depth: 0,
		roleName: 'main',
		task: 'do it',
	}
}

function roleStateFor(): RoleState {
	return {
		history: [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'task' },
		],
		protectedPrefixLength: 2,
		lastPromptTokens: 0,
		recentCompactionPromptTokens: [],
		recentToolCalls: [],
		toolCallCount: 0,
		generatedTokens: 0,
		contextExceededAttempts: 0,
		loopCheckToolCallWatermark: 0,
		loopCheckTokenWatermark: 0,
	}
}

function entryFor(roleState: RoleState): RoleRegistryEntry {
	return { roleId: 'main-0-1', roleName: 'main', depth: 0, roleState }
}

function managerFor(context: EngineContext, tracker = createContextPressureTracker()): { manager: ContextManager; events: LogEvent[] } {
	const events: LogEvent[] = []
	const manager = createContextManager(context, {
		appendLog: (event) => events.push(event),
		contextPressureTracker: tracker,
		invocationJournal: createInvocationJournal((event) => events.push(event)),
		runRole: async () => {
			throw new Error('context handler invoked by a test that configured none')
		},
	})
	return { manager, events }
}

describe('context pressure budget', () => {
	test('is the window minus the reserved completion budget when nothing has been learned', () => {
		const { manager } = managerFor(contextFor(262144, 32768))
		const roleState = roleStateFor()
		manager.observeSuccess(roleState, { promptTokens: 183501, completionTokens: 0 })
		expect(roleState.contextPressureNotice).toBe('pending')
	})

	test('stays below the threshold until reported usage crosses the static budget share', () => {
		const { manager } = managerFor(contextFor(262144, 32768))
		const roleState = roleStateFor()
		manager.observeSuccess(roleState, { promptTokens: 183500, completionTokens: 0 })
		expect(roleState.contextPressureNotice).toBeUndefined()
	})

	test('tightens to the learned ceiling when it sits below the static budget', () => {
		const tracker = createContextPressureTracker(200000)
		const { manager } = managerFor(contextFor(262144, 32768), tracker)
		const roleState = roleStateFor()
		manager.observeSuccess(roleState, { promptTokens: 160000, completionTokens: 0 })
		expect(roleState.contextPressureNotice).toBe('pending')
	})

	test('ignores a learned ceiling above the static budget', () => {
		const tracker = createContextPressureTracker(250000)
		const { manager } = managerFor(contextFor(262144, 32768), tracker)
		const roleState = roleStateFor()
		manager.observeSuccess(roleState, { promptTokens: 183501, completionTokens: 0 })
		expect(roleState.contextPressureNotice).toBe('pending')
	})

	test('treats a missing completion reservation as zero', () => {
		const { manager } = managerFor(contextFor(100000))
		const roleState = roleStateFor()
		manager.observeSuccess(roleState, { promptTokens: 80000, completionTokens: 0 })
		expect(roleState.contextPressureNotice).toBe('pending')
	})
})

describe('context rejection learning', () => {
	function observeRejection(context: EngineContext, tracker: ReturnType<typeof createContextPressureTracker>, promptTokens: number): void {
		const { manager } = managerFor(context, tracker)
		manager.observeRejection(roleStateFor(), { promptTokens, contextWindow: 1000000 })
	}

	test('sets the ceiling from the first reported rejection', () => {
		const tracker = createContextPressureTracker()
		observeRejection(contextFor(1000000), tracker, 200000)
		expect(tracker.learnedCeiling).toBe(200000)
	})

	test('only ever tightens', () => {
		const tracker = createContextPressureTracker()
		const context = contextFor(1000000)
		observeRejection(context, tracker, 200000)
		observeRejection(context, tracker, 210000)
		expect(tracker.learnedCeiling).toBe(200000)
		observeRejection(context, tracker, 190000)
		expect(tracker.learnedCeiling).toBe(190000)
	})

	test('ignores rejections without a reported count', () => {
		const tracker = createContextPressureTracker()
		const context = contextFor(1000000)
		observeRejection(context, tracker, 0)
		expect(tracker.learnedCeiling).toBeUndefined()
		observeRejection(context, tracker, 200000)
		observeRejection(context, tracker, 0)
		expect(tracker.learnedCeiling).toBe(200000)
	})

	test('bounds recovery at the fourth consecutive rejection', () => {
		const { manager } = managerFor(contextFor(1000000))
		const roleState = roleStateFor()
		for (let attempt = 0; attempt < 3; attempt++) {
			const decision = manager.observeRejection(roleState, { promptTokens: 0, contextWindow: 1000 })
			expect(decision.kind).toBe('continue')
		}
		const decision = manager.observeRejection(roleState, { promptTokens: 0, contextWindow: 1000 })
		expect(decision.kind).toBe('finished')
	})
})

describe('context handler interlude', () => {
	test('suspends the entry role, runs the injected handler at the next depth, and appends the managed notice', async () => {
		const context = contextFor(1000, 0, undefined, 'context_manager')
		const events: LogEvent[] = []
		const handlerContexts: EngineContext[] = []
		const manager = createContextManager(context, {
			appendLog: (event) => events.push(event),
			contextPressureTracker: createContextPressureTracker(),
			invocationJournal: createInvocationJournal((event) => events.push(event)),
			runRole: async (handlerContext) => {
				handlerContexts.push(handlerContext)
				return { status: 'success', summary: 'trimmed the stale turn' }
			},
		})
		const roleState = roleStateFor()
		manager.observeSuccess(roleState, { promptTokens: 800, completionTokens: 0 })
		const decision = await manager.resolveSafePoint(roleState, entryFor(roleState))

		expect(decision.kind).toBe('continue')
		expect(handlerContexts.length).toBe(1)
		const handlerContext = handlerContexts[0]
		expect(handlerContext?.roleName).toBe('context_manager')
		expect(handlerContext?.depth).toBe(1)
		expect(handlerContext?.parent).toBe('main')
		expect(handlerContext?.parentRoleId).toBe('main-0-1')
		expect(handlerContext?.handlerOf).toBe('main-0-1')
		expect(roleState.contextPressureNotice).toBe('sent')
		expect(roleState.history[roleState.history.length - 1]?.content).toContain('[Platform notice — context compacted]')
		expect(roleState.history[roleState.history.length - 1]?.content).toContain('trimmed the stale turn')
		const interrupt = events.find((event) => event.type === 'interrupt')
		expect(interrupt?.payload).toMatchObject({ trigger: 'context_pressure', handler: 'context_manager', target: 'main-0-1' })
		const resolved = events.find((event) => event.type === 'interrupt_resolved')
		expect(resolved?.payload).toMatchObject({ trigger: 'context_pressure', handler: 'context_manager', target: 'main-0-1', action: 'compacted' })
	})

	test('falls back to the handoff notice when the handler fails', async () => {
		const context = contextFor(1000, 0, undefined, 'context_manager')
		const manager = createContextManager(context, {
			appendLog: () => {},
			contextPressureTracker: createContextPressureTracker(),
			invocationJournal: createInvocationJournal(() => {}),
			runRole: async () => ({ status: 'error', summary: 'cannot compact' }),
		})
		const roleState = roleStateFor()
		manager.observeSuccess(roleState, { promptTokens: 800, completionTokens: 0 })
		const decision = await manager.resolveSafePoint(roleState, entryFor(roleState))

		expect(decision.kind).toBe('continue')
		expect(roleState.history[roleState.history.length - 1]?.content).toContain('[Platform notice — context pressure]')
	})

	test('defers a rejection to the safe point and runs the handler there', async () => {
		const context = contextFor(1000, 0, undefined, 'context_manager')
		const events: LogEvent[] = []
		const handlerContexts: EngineContext[] = []
		const manager = createContextManager(context, {
			appendLog: (event) => events.push(event),
			contextPressureTracker: createContextPressureTracker(),
			invocationJournal: createInvocationJournal((event) => events.push(event)),
			runRole: async (handlerContext) => {
				handlerContexts.push(handlerContext)
				return { status: 'success', summary: 'pruned the rejected turn' }
			},
		})
		const roleState = roleStateFor()
		const rejection = manager.observeRejection(roleState, { promptTokens: 1200, contextWindow: 1000 })
		expect(rejection.kind).toBe('continue')
		expect(roleState.contextCompactionPending).toEqual({ promptTokens: 1200, contextWindow: 1000 })
		expect(handlerContexts.length).toBe(0)

		const decision = await manager.resolveSafePoint(roleState, entryFor(roleState))
		expect(decision.kind).toBe('continue')
		expect(roleState.contextCompactionPending).toBeUndefined()
		expect(handlerContexts.length).toBe(1)
		const handlerContext = handlerContexts[0]
		expect(handlerContext?.roleName).toBe('context_manager')
		expect(handlerContext?.depth).toBe(1)
		expect(handlerContext?.parentRoleId).toBe('main-0-1')
		expect(handlerContext?.handlerOf).toBe('main-0-1')
		expect(handlerContext?.task).toContain('exceeding the context window')
		expect(roleState.history[roleState.history.length - 1]?.content).toContain('[Platform notice — context compacted]')
		expect(roleState.history[roleState.history.length - 1]?.content).toContain('pruned the rejected turn')
		const interrupt = events.find((event) => event.type === 'interrupt')
		expect(interrupt?.payload).toMatchObject({ trigger: 'context_budget_exceeded', handler: 'context_manager', target: 'main-0-1' })
		const resolved = events.find((event) => event.type === 'interrupt_resolved')
		expect(resolved?.payload).toMatchObject({ trigger: 'context_budget_exceeded', handler: 'context_manager', target: 'main-0-1', action: 'compacted' })
	})

	test('runs a pending compaction before a pending pressure notice', async () => {
		const context = contextFor(1000, 0, undefined, 'context_manager')
		const events: LogEvent[] = []
		const handlerTasks: string[] = []
		const manager = createContextManager(context, {
			appendLog: (event) => events.push(event),
			contextPressureTracker: createContextPressureTracker(),
			invocationJournal: createInvocationJournal((event) => events.push(event)),
			runRole: async (handlerContext) => {
				handlerTasks.push(handlerContext.task)
				const summary = handlerContext.task.includes('exceeding the context window') ? 'compacted overflow' : 'compacted pressure'
				return { status: 'success', summary }
			},
		})
		const roleState = roleStateFor()
		manager.observeRejection(roleState, { promptTokens: 1200, contextWindow: 1000 })
		manager.observeSuccess(roleState, { promptTokens: 900, completionTokens: 0 })
		expect(roleState.contextCompactionPending).toBeDefined()
		expect(roleState.contextPressureNotice).toBe('pending')

		const decision = await manager.resolveSafePoint(roleState, entryFor(roleState))
		expect(decision.kind).toBe('continue')
		expect(handlerTasks.length).toBe(2)
		expect(handlerTasks[0]).toContain('exceeding the context window')
		expect(handlerTasks[1]).toContain('context-pressure threshold')
		const interruptTriggers = events.flatMap((event) => {
			if (event.type !== 'interrupt' || !isObject(event.payload)) return []
			return [event.payload['trigger']]
		})
		expect(interruptTriggers).toEqual(['context_budget_exceeded', 'context_pressure'])
		const notices = roleState.history.filter((message) => message.role === 'user' && message.content.includes('[Platform notice — context compacted]'))
		expect(notices.length).toBe(2)
		expect(notices[0]?.content).toContain('compacted overflow')
		expect(notices[1]?.content).toContain('compacted pressure')
	})

	test('clamps the handler depth to maxAgentDepth', async () => {
		const context = { ...contextFor(1000, 0, undefined, 'context_manager', 1), depth: 2 }
		const handlerContexts: EngineContext[] = []
		const manager = createContextManager(context, {
			appendLog: () => {},
			contextPressureTracker: createContextPressureTracker(),
			invocationJournal: createInvocationJournal(() => {}),
			runRole: async (handlerContext) => {
				handlerContexts.push(handlerContext)
				return { status: 'success', summary: 'clamped' }
			},
		})
		const roleState = roleStateFor()
		manager.observeRejection(roleState, { promptTokens: 1200, contextWindow: 1000 })
		const decision = await manager.resolveSafePoint(roleState, entryFor(roleState))

		expect(decision.kind).toBe('continue')
		expect(handlerContexts[0]?.depth).toBe(1)
	})

	test('falls back to the naive backstop when the compaction handler fails', async () => {
		const context = contextFor(1000, 0, undefined, 'context_manager')
		const events: LogEvent[] = []
		const manager = createContextManager(context, {
			appendLog: (event) => events.push(event),
			contextPressureTracker: createContextPressureTracker(),
			invocationJournal: createInvocationJournal((event) => events.push(event)),
			runRole: async () => ({ status: 'error', summary: 'cannot compact' }),
		})
		const history: Message[] = [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'task' },
			{ role: 'assistant', content: 'a'.repeat(4000) },
			{ role: 'user', content: 'b'.repeat(4000) },
			{ role: 'assistant', content: 'recent' },
		]
		const roleState = { ...roleStateFor(), history }
		manager.observeRejection(roleState, { promptTokens: 9000, contextWindow: 1000 })
		const decision = await manager.resolveSafePoint(roleState, entryFor(roleState))

		expect(decision.kind).toBe('continue')
		expect(roleState.contextCompactionPending).toBeUndefined()
		expect(roleState.history[roleState.history.length - 1]?.content).toContain('[Platform notice — context window exceeded]')
		expect(events.some((event) => event.type === 'context_compacted')).toBe(true)
		const resolved = events.find((event) => event.type === 'interrupt_resolved')
		expect(resolved?.payload).toMatchObject({ trigger: 'context_budget_exceeded', handler: 'context_manager', target: 'main-0-1', action: 'failed', handlerStatus: 'error' })
	})

	test('the naive backstop preserves a four-message continuation prefix and starts dropping at index four', async () => {
		const context = contextFor(1000, 0, undefined, 'context_manager')
		const manager = createContextManager(context, {
			appendLog: () => {},
			contextPressureTracker: createContextPressureTracker(),
			invocationJournal: createInvocationJournal(() => {}),
			runRole: async () => ({ status: 'error', summary: 'cannot compact' }),
		})
		const prefix: Message[] = [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'prior task' },
			{ role: 'assistant', content: 'prior result' },
			{ role: 'user', content: 'current task' },
		]
		const history: Message[] = [
			...prefix,
			{ role: 'assistant', content: 'a'.repeat(4000) },
			{ role: 'user', content: 'b'.repeat(4000) },
			{ role: 'assistant', content: 'recent' },
		]
		const roleState: RoleState = { ...roleStateFor(), history, protectedPrefixLength: 4 }
		manager.observeRejection(roleState, { promptTokens: 9000, contextWindow: 1000 })
		const decision = await manager.resolveSafePoint(roleState, entryFor(roleState))

		expect(decision.kind).toBe('continue')
		expect(roleState.history.slice(0, 4)).toEqual(prefix)
		// Both old post-prefix turns were dropped, so the first surviving turn is the recent assistant and the notice follows it.
		expect(roleState.history[4]?.content).toBe('recent')
		expect(roleState.history[roleState.history.length - 1]?.content).toContain('[Platform notice — context window exceeded]')
	})

	test('throws when a pending compaction has no configured context handler', async () => {
		const { manager } = managerFor(contextFor(1000))
		const roleState = roleStateFor()
		roleState.contextCompactionPending = { promptTokens: 1200, contextWindow: 1000 }

		await expect(manager.resolveSafePoint(roleState, entryFor(roleState))).rejects.toThrow('contextHandlerRole')
	})
})
