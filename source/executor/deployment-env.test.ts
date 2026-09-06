import { describe, expect, test } from 'bun:test'

import { applyDeploymentOverride, resolveDeploymentOverride } from './deployment-env.ts'
import { validateDeploymentFileConfig } from './validation.ts'
import type { DeploymentFileConfig } from './types.ts'

function makeBase(): DeploymentFileConfig {
	return {
		model: {
			name: 'base-model',
			apiBase: 'http://base:8080/v1',
			contextWindow: 8192,
			reasoningField: 'reasoning',
			generation: { temperature: 0.2, maxTokens: 4096 },
		},
		executor: {
			maxAgentDepth: 4,
			defaultToolTimeoutSeconds: 30,
			maxCompactionAttempts: 2,
			contextPressureThreshold: 0.8,
			contextHandlerRole: 'context_manager',
			inquiryHandlerRole: 'inquiry_responder',
			interruptTriggers: { handlerRole: 'loop_detector', everyToolCalls: 12, everyTokens: 30000, planOwnerRole: 'planner' },
		},
		contextPolicy: { maxToolOutputChars: 50000 },
	}
}

const FULL_OVERRIDE_ENVIRONMENT: Record<string, string> = {
	ORCHESTRATOR_MODEL: 'override-model',
	ORCHESTRATOR_API_BASE: 'http://override:8080/v1',
	ORCHESTRATOR_MODEL_CONTEXT_WINDOW: '131072',
	ORCHESTRATOR_REASONING_FIELD: 'reasoning_content',
	ORCHESTRATOR_TEMPERATURE: '0.7',
	ORCHESTRATOR_MAX_TOKENS: '8192',
	ORCHESTRATOR_MAX_AGENT_DEPTH: '16',
	ORCHESTRATOR_TOOL_TIMEOUT_SECONDS: '120',
	ORCHESTRATOR_MAX_COMPACTION_ATTEMPTS: '9',
	ORCHESTRATOR_CONTEXT_PRESSURE_THRESHOLD: '0.95',
	ORCHESTRATOR_CONTEXT_HANDLER_ROLE: 'override_context',
	ORCHESTRATOR_INQUIRY_HANDLER_ROLE: 'override_inquiry',
	ORCHESTRATOR_INTERRUPT_HANDLER_ROLE: 'override_loop',
	ORCHESTRATOR_INTERRUPT_EVERY_TOOL_CALLS: '6',
	ORCHESTRATOR_INTERRUPT_EVERY_TOKENS: '15000',
	ORCHESTRATOR_INTERRUPT_PLAN_OWNER_ROLE: 'override_planner',
	ORCHESTRATOR_MAX_TOOL_OUTPUT_CHARS: '100000',
}

describe('resolveDeploymentOverride', () => {
	test('maps every variable to its deployment field', () => {
		const override = resolveDeploymentOverride(FULL_OVERRIDE_ENVIRONMENT)
		expect(override).toEqual({
			model: {
				name: 'override-model',
				apiBase: 'http://override:8080/v1',
				contextWindow: 131072,
				reasoningField: 'reasoning_content',
				generation: { temperature: 0.7, maxTokens: 8192 },
			},
			executor: {
				maxAgentDepth: 16,
				defaultToolTimeoutSeconds: 120,
				maxCompactionAttempts: 9,
				contextPressureThreshold: 0.95,
				contextHandlerRole: 'override_context',
				inquiryHandlerRole: 'override_inquiry',
				interruptTriggers: {
					handlerRole: 'override_loop',
					everyToolCalls: 6,
					everyTokens: 15000,
					planOwnerRole: 'override_planner',
				},
			},
			contextPolicy: { maxToolOutputChars: 100000 },
		})
	})

	test('an empty environment yields an empty override', () => {
		expect(resolveDeploymentOverride({})).toEqual({})
	})

	test('an empty-string variable means not set', () => {
		expect(resolveDeploymentOverride({ ORCHESTRATOR_MODEL: '', ORCHESTRATOR_MAX_AGENT_DEPTH: '', ORCHESTRATOR_TEMPERATURE: '' })).toEqual({})
	})

	test('a section with only empty-string variables is not attached', () => {
		expect(resolveDeploymentOverride({ ORCHESTRATOR_INTERRUPT_EVERY_TOOL_CALLS: '' })).toEqual({})
	})

	test('string values are used as given', () => {
		const override = resolveDeploymentOverride({ ORCHESTRATOR_MODEL: '  spaced  ' })
		expect(override.model?.name).toBe('  spaced  ')
	})

	test('rejects integer values that are not plain digit strings, naming the variable', () => {
		for (const value of ['0x1a', '1e3', '8080.0', ' 8080 ', '-4']) {
			expect(() => resolveDeploymentOverride({ ORCHESTRATOR_MODEL_CONTEXT_WINDOW: value })).toThrow('ORCHESTRATOR_MODEL_CONTEXT_WINDOW')
		}
	})

	test('rejects non-numeric float values, naming the variable', () => {
		for (const value of ['abc', '  ', 'Infinity', 'NaN']) {
			expect(() => resolveDeploymentOverride({ ORCHESTRATOR_TEMPERATURE: value })).toThrow('ORCHESTRATOR_TEMPERATURE')
		}
	})

	test('rejects non-positive integers, naming the variable', () => {
		expect(() => resolveDeploymentOverride({ ORCHESTRATOR_MAX_AGENT_DEPTH: '0' })).toThrow('ORCHESTRATOR_MAX_AGENT_DEPTH')
		expect(() => resolveDeploymentOverride({ ORCHESTRATOR_TOOL_TIMEOUT_SECONDS: '0' })).toThrow('ORCHESTRATOR_TOOL_TIMEOUT_SECONDS')
		expect(() => resolveDeploymentOverride({ ORCHESTRATOR_MAX_COMPACTION_ATTEMPTS: '0' })).toThrow('ORCHESTRATOR_MAX_COMPACTION_ATTEMPTS')
		expect(() => resolveDeploymentOverride({ ORCHESTRATOR_INTERRUPT_EVERY_TOOL_CALLS: '0' })).toThrow('ORCHESTRATOR_INTERRUPT_EVERY_TOOL_CALLS')
		expect(() => resolveDeploymentOverride({ ORCHESTRATOR_INTERRUPT_EVERY_TOKENS: '0' })).toThrow('ORCHESTRATOR_INTERRUPT_EVERY_TOKENS')
		expect(() => resolveDeploymentOverride({ ORCHESTRATOR_MAX_TOOL_OUTPUT_CHARS: '0' })).toThrow('ORCHESTRATOR_MAX_TOOL_OUTPUT_CHARS')
		expect(() => resolveDeploymentOverride({ ORCHESTRATOR_MAX_TOKENS: '0' })).toThrow('ORCHESTRATOR_MAX_TOKENS')
	})

	test('rejects a context pressure threshold outside (0, 1), naming the variable', () => {
		for (const value of ['0', '1', '1.5', '-0.5']) {
			expect(() => resolveDeploymentOverride({ ORCHESTRATOR_CONTEXT_PRESSURE_THRESHOLD: value })).toThrow('ORCHESTRATOR_CONTEXT_PRESSURE_THRESHOLD')
		}
	})

	test('accepts boundary-adjacent valid values', () => {
		const override = resolveDeploymentOverride({ ORCHESTRATOR_CONTEXT_PRESSURE_THRESHOLD: '0.0001', ORCHESTRATOR_TEMPERATURE: '0' })
		expect(override.executor?.contextPressureThreshold).toBe(0.0001)
		expect(override.model?.generation?.temperature).toBe(0)
	})
})

describe('applyDeploymentOverride', () => {
	test('an empty override leaves every base value in place', () => {
		const base = makeBase()
		const merged = applyDeploymentOverride(base, resolveDeploymentOverride({}))
		expect(merged).toEqual(base)
		validateDeploymentFileConfig(merged)
	})

	test('the full mapping replaces every field and stays a valid deployment', () => {
		const merged = applyDeploymentOverride(makeBase(), resolveDeploymentOverride(FULL_OVERRIDE_ENVIRONMENT))
		expect(merged).toEqual({
			model: {
				name: 'override-model',
				apiBase: 'http://override:8080/v1',
				contextWindow: 131072,
				reasoningField: 'reasoning_content',
				generation: { temperature: 0.7, maxTokens: 8192 },
			},
			executor: {
				maxAgentDepth: 16,
				defaultToolTimeoutSeconds: 120,
				maxCompactionAttempts: 9,
				contextPressureThreshold: 0.95,
				contextHandlerRole: 'override_context',
				inquiryHandlerRole: 'override_inquiry',
				interruptTriggers: {
					handlerRole: 'override_loop',
					everyToolCalls: 6,
					everyTokens: 15000,
					planOwnerRole: 'override_planner',
				},
			},
			contextPolicy: { maxToolOutputChars: 100000 },
		})
		validateDeploymentFileConfig(merged)
	})

	test('overrides merge nested generation fields per field', () => {
		const base = makeBase()
		const merged = applyDeploymentOverride(base, resolveDeploymentOverride({ ORCHESTRATOR_MAX_TOKENS: '8192' }))
		expect(merged.model.generation.maxTokens).toBe(8192)
		expect(merged.model.generation.temperature).toBe(0.2)
	})

	test('overrides merge nested interrupt trigger fields per field', () => {
		const base = makeBase()
		const merged = applyDeploymentOverride(base, resolveDeploymentOverride({ ORCHESTRATOR_INTERRUPT_EVERY_TOOL_CALLS: '6' }))
		expect(merged.executor.interruptTriggers).toEqual({ handlerRole: 'loop_detector', everyToolCalls: 6, everyTokens: 30000, planOwnerRole: 'planner' })
	})

	test('a field with no override for it keeps the base value', () => {
		const base = makeBase()
		const merged = applyDeploymentOverride(base, resolveDeploymentOverride({ ORCHESTRATOR_MODEL: 'override-model' }))
		expect(merged.model.name).toBe('override-model')
		expect(merged.model.apiBase).toBe(base.model.apiBase)
		expect(merged.model.contextWindow).toBe(base.model.contextWindow)
		expect(merged.model.reasoningField).toBe(base.model.reasoningField)
	})

	test('the merge operates on the file shape, so an optional model field absent from the base stays absent', () => {
		const base = makeBase()
		delete base.model.name
		delete base.model.contextWindow
		const merged = applyDeploymentOverride(base, resolveDeploymentOverride({}))
		expect(merged.model.name).toBeUndefined()
		expect(merged.model.contextWindow).toBeUndefined()
		validateDeploymentFileConfig(merged)
	})

	test('does not mutate the base deployment', () => {
		const base = makeBase()
		const snapshot = structuredClone(base)
		const merged = applyDeploymentOverride(base, resolveDeploymentOverride(FULL_OVERRIDE_ENVIRONMENT))
		merged.model.generation.temperature = 999
		const triggers = merged.executor.interruptTriggers
		expect(triggers).toBeDefined()
		if (triggers === undefined) return
		triggers.everyToolCalls = 999
		expect(base).toEqual(snapshot)
	})

	test('returns fresh data rather than base references', () => {
		const base = makeBase()
		const merged = applyDeploymentOverride(base, resolveDeploymentOverride({}))
		expect(merged).not.toBe(base)
		expect(merged.model).not.toBe(base.model)
		expect(merged.model.generation).not.toBe(base.model.generation)
		expect(merged.executor).not.toBe(base.executor)
		expect(merged.executor.interruptTriggers).not.toBe(base.executor.interruptTriggers)
		expect(merged.contextPolicy).not.toBe(base.contextPolicy)
	})

	test('introduces interruptTriggers when the base has none and the override carries every required field', () => {
		const base = makeBase()
		delete base.executor.interruptTriggers
		const merged = applyDeploymentOverride(base, resolveDeploymentOverride({
			ORCHESTRATOR_INTERRUPT_HANDLER_ROLE: 'override_loop',
			ORCHESTRATOR_INTERRUPT_EVERY_TOOL_CALLS: '6',
			ORCHESTRATOR_INTERRUPT_EVERY_TOKENS: '15000',
		}))
		expect(merged.executor.interruptTriggers).toEqual({ handlerRole: 'override_loop', everyToolCalls: 6, everyTokens: 15000 })
	})

	test('rejects a partial interruptTriggers introduction, naming the variables that must be set together', () => {
		const base = makeBase()
		delete base.executor.interruptTriggers
		const override = resolveDeploymentOverride({ ORCHESTRATOR_INTERRUPT_EVERY_TOOL_CALLS: '6' })
		expect(() => applyDeploymentOverride(base, override)).toThrow('ORCHESTRATOR_INTERRUPT_HANDLER_ROLE')
		expect(() => applyDeploymentOverride(base, override)).toThrow('ORCHESTRATOR_INTERRUPT_EVERY_TOOL_CALLS')
		expect(() => applyDeploymentOverride(base, override)).toThrow('ORCHESTRATOR_INTERRUPT_EVERY_TOKENS')
	})
})
