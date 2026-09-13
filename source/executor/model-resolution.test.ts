import { describe, expect, test } from 'bun:test'

import { parseModelInfo, resolveDeploymentConfig, resolveModelConfig, type ModelApiInfo, type ModelApiProbe } from './model-resolution.ts'
import { ConfigurationError } from './errors.js'
import type { ModelConfig } from './types.js'

const apiBase = 'http://x/v1'

function probeWith(models: ModelApiInfo[]): ModelApiProbe {
	return { apiBase, models, failureReason: undefined }
}

function failedProbe(reason: string): ModelApiProbe {
	return { apiBase, models: undefined, failureReason: reason }
}

function notProbed(): ModelApiProbe {
	return { apiBase, models: undefined, failureReason: undefined }
}

const completeModel: ModelConfig = {
	name: 'm',
	apiBase,
	contextWindow: 32768,
	generation: { temperature: 0.2, maxTokens: 512 },
}

function expectConfigurationError(expectation: () => unknown): string {
	try {
		expectation()
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigurationError)
		return error instanceof Error ? error.message : String(error)
	}
	throw new Error('expected the call to throw a ConfigurationError')
}

describe('parseModelInfo', () => {
	test('reads the llama.cpp listing shape: id plus meta.n_ctx', () => {
		const models = parseModelInfo({ data: [{ id: 'qwen', meta: { n_ctx: 131072, n_predict: 4096 } }] })
		expect(models).toEqual([{ id: 'qwen', contextWindow: 131072 }])
	})

	test('reads the rich catalog shape: id plus top-level context_length alongside the extra fields', () => {
		const models = parseModelInfo({ data: [{ id: 'qwen', context_length: 40960, supported_parameters: ['temperature'], pricing: { prompt: '0' } }] })
		expect(models).toEqual([{ id: 'qwen', contextWindow: 40960 }])
	})

	test('a mixed listing parses llama.cpp entries, rich catalog entries, and bare ids in one body', () => {
		const models = parseModelInfo({ data: [
			{ id: 'llama-served', meta: { n_ctx: 8192 } },
			{ id: 'catalog-served', context_length: 262144 },
			{ id: 'bare' },
		] })
		expect(models).toEqual([{ id: 'llama-served', contextWindow: 8192 }, { id: 'catalog-served', contextWindow: 262144 }, { id: 'bare' }])
	})

	test('when an entry carries both context_length and meta.n_ctx, context_length wins', () => {
		const models = parseModelInfo({ data: [{ id: 'both', context_length: 4096, meta: { n_ctx: 8192 } }] })
		expect(models).toEqual([{ id: 'both', contextWindow: 4096 }])
	})

	test('reads the OpenAI listing shape: id only, no context window', () => {
		const models = parseModelInfo({ data: [{ id: 'gpt-x', owned_by: 'org' }] })
		expect(models).toEqual([{ id: 'gpt-x' }])
	})

	test('skips junk entries: wrong shapes, missing or non-string or empty ids', () => {
		const models = parseModelInfo({ data: ['junk', 42, null, { meta: { n_ctx: 5 } }, { id: 123 }, { id: '' }, { id: 'ok', meta: 'no' }, { id: 'kept' }] })
		expect(models).toEqual([{ id: 'ok' }, { id: 'kept' }])
	})

	test('a body without a data array yields no entries', () => {
		expect(parseModelInfo({})).toEqual([])
		expect(parseModelInfo({ data: 'nope' })).toEqual([])
		expect(parseModelInfo(null)).toEqual([])
		expect(parseModelInfo([1, 2, 3])).toEqual([])
		expect(parseModelInfo('an html error page')).toEqual([])
	})

	test('a non-positive, NaN, or non-number n_ctx is treated as absent', () => {
		const models = parseModelInfo({ data: [{ id: 'zero', meta: { n_ctx: 0 } }, { id: 'negative', meta: { n_ctx: -5 } }, { id: 'nan', meta: { n_ctx: Number.NaN } }, { id: 'string', meta: { n_ctx: 'big' } }] })
		expect(models).toEqual([{ id: 'zero' }, { id: 'negative' }, { id: 'nan' }, { id: 'string' }])
	})

	test('a non-positive, NaN, or non-number context_length is treated as absent', () => {
		const models = parseModelInfo({ data: [{ id: 'zero', context_length: 0 }, { id: 'negative', context_length: -5 }, { id: 'nan', context_length: Number.NaN }, { id: 'string', context_length: 'big' }] })
		expect(models).toEqual([{ id: 'zero' }, { id: 'negative' }, { id: 'nan' }, { id: 'string' }])
	})
})

describe('resolveModelConfig', () => {
	test('completes from configuration: present values pass through untouched', () => {
		const resolved = resolveModelConfig(completeModel, notProbed())
		expect(resolved).toEqual({ name: 'm', apiBase: 'http://x/v1', contextWindow: 32768, generation: { temperature: 0.2, maxTokens: 512 } })
	})

	test('an API-reported context window overrides a differing configured one', () => {
		const configured: ModelConfig = { name: 'm', apiBase, contextWindow: 32768, generation: {} }
		const resolved = resolveModelConfig(configured, probeWith([{ id: 'm', contextWindow: 131072 }]))
		expect(resolved.contextWindow).toBe(131072)
	})

	test('an API-reported context window is used when the configuration has none', () => {
		const withoutWindow: ModelConfig = { name: 'm', apiBase, generation: {} }
		const resolved = resolveModelConfig(withoutWindow, probeWith([{ id: 'm', contextWindow: 4096 }]))
		expect(resolved.contextWindow).toBe(4096)
		expect(resolved.name).toBe('m')
	})

	test('a configured name is kept even when the API lists a different single model', () => {
		const configured: ModelConfig = { name: 'm', apiBase, contextWindow: 8192, generation: {} }
		const resolved = resolveModelConfig(configured, probeWith([{ id: 'other', contextWindow: 99 }]))
		expect(resolved.name).toBe('m')
		// The API entry does not match the configured name, so it reports nothing for this model and the configured window stands.
		expect(resolved.contextWindow).toBe(8192)
	})

	test('a configured name is matched by id against a multi-model listing for its context window', () => {
		const configured: ModelConfig = { name: 'alpha', apiBase, generation: {} }
		const resolved = resolveModelConfig(configured, probeWith([{ id: 'alpha', contextWindow: 123 }, { id: 'beta' }]))
		expect(resolved.name).toBe('alpha')
		expect(resolved.contextWindow).toBe(123)
	})

	test('a name is adopted from the API when it is absent and exactly one model is served', () => {
		const withoutName: ModelConfig = { apiBase, generation: {} }
		const resolved = resolveModelConfig(withoutName, probeWith([{ id: 'served', contextWindow: 77 }]))
		expect(resolved.name).toBe('served')
		expect(resolved.contextWindow).toBe(77)
	})

	test('an absent name with a multi-model listing fails listing the served ids', () => {
		const withoutName: ModelConfig = { apiBase, contextWindow: 8192, generation: {} }
		const message = expectConfigurationError(() => resolveModelConfig(withoutName, probeWith([{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }])))
		expect(message).toContain('alpha, beta, gamma')
		expect(message).toContain(apiBase)
	})

	test('a failed probe falls back to complete configuration', () => {
		const resolved = resolveModelConfig(completeModel, failedProbe('connection refused'))
		expect(resolved).toEqual({ name: 'm', apiBase: 'http://x/v1', contextWindow: 32768, generation: { temperature: 0.2, maxTokens: 512 } })
	})

	test('a missing name distinguishes an unreachable API from one that does not report it', () => {
		const withoutName: ModelConfig = { apiBase, contextWindow: 8192, generation: {} }
		const unreachable = expectConfigurationError(() => resolveModelConfig(withoutName, failedProbe('connection refused')))
		expect(unreachable).toContain('the model API at http://x/v1 could not be probed (connection refused)')
		expect(unreachable).toContain('deployment.json')
		expect(unreachable).toContain('"model"."name"')
		expect(unreachable).toContain('ORCHESTRATOR_MODEL')
		const answered = expectConfigurationError(() => resolveModelConfig(withoutName, probeWith([])))
		expect(answered).toContain('the model API did not report it')
	})

	test('a missing contextWindow distinguishes an unreachable API from one that does not report it', () => {
		const withoutWindow: ModelConfig = { name: 'm', apiBase, generation: {} }
		const unreachable = expectConfigurationError(() => resolveModelConfig(withoutWindow, failedProbe('connection refused')))
		expect(unreachable).toContain('the model API at http://x/v1 could not be probed (connection refused)')
		expect(unreachable).toContain('deployment.json')
		expect(unreachable).toContain('"model"."contextWindow"')
		expect(unreachable).toContain('ORCHESTRATOR_MODEL_CONTEXT_WINDOW')
		const answered = expectConfigurationError(() => resolveModelConfig(withoutWindow, probeWith([{ id: 'm' }])))
		expect(answered).toContain('the model API did not report it')
	})

	test('present-but-invalid configured values are treated as absent', () => {
		const invalid: ModelConfig = { name: '', apiBase, contextWindow: 0, generation: {} }
		const resolved = resolveModelConfig(invalid, probeWith([{ id: 'served', contextWindow: 4096 }]))
		expect(resolved.name).toBe('served')
		expect(resolved.contextWindow).toBe(4096)
		const negative: ModelConfig = { name: 'm', apiBase, contextWindow: -5, generation: {} }
		const resolvedNegative = resolveModelConfig(negative, probeWith([{ id: 'm', contextWindow: 4096 }]))
		expect(resolvedNegative.contextWindow).toBe(4096)
	})
})

describe('resolveDeploymentConfig', () => {
	test('composes the resolved deployment and reports where each completed field came from', () => {
		const fileDeployment = {
			model: { apiBase, contextWindow: 32768, generation: {} } satisfies ModelConfig,
			executor: { maxAgentDepth: 8, defaultToolTimeoutSeconds: 30, maxCompactionAttempts: 5 },
			contextPolicy: { maxToolOutputChars: 50000 },
		}
		const resolution = resolveDeploymentConfig(fileDeployment, probeWith([{ id: 'served', contextWindow: 131072 }]))
		expect(resolution.deployment.model).toEqual({ name: 'served', apiBase, contextWindow: 131072, generation: {} })
		expect(resolution.deployment.executor).toEqual(fileDeployment.executor)
		expect(resolution.deployment.contextPolicy).toEqual(fileDeployment.contextPolicy)
		expect(resolution.nameSource).toBe('api')
		expect(resolution.contextWindowSource).toBe('api')
		expect(resolution.apiContextWindow).toBe(131072)
	})

	test('a configuration-sourced resolution reports the configuration as the source', () => {
		const fileDeployment = {
			model: completeModel,
			executor: { maxAgentDepth: 8, defaultToolTimeoutSeconds: 30, maxCompactionAttempts: 5 },
			contextPolicy: { maxToolOutputChars: 50000 },
		}
		const resolution = resolveDeploymentConfig(fileDeployment, failedProbe('connection refused'))
		expect(resolution.nameSource).toBe('configuration')
		expect(resolution.contextWindowSource).toBe('configuration')
		expect(resolution.apiContextWindow).toBeUndefined()
	})
})
