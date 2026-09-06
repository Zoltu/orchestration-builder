import { describe, expect, test } from 'bun:test'

import { resolveModelConfig } from './model-resolution.ts'
import { ConfigurationError } from './errors.js'
import type { ModelConfig } from './types.js'

const completeModel: ModelConfig = {
	name: 'm',
	apiBase: 'http://x/v1',
	contextWindow: 32768,
	reasoningField: 'reasoning',
	generation: { temperature: 0.2, maxTokens: 512 },
}

describe('resolveModelConfig', () => {
	test('completes from configuration: present values pass through untouched', () => {
		const resolved = resolveModelConfig(completeModel)
		expect(resolved).toEqual({ name: 'm', apiBase: 'http://x/v1', contextWindow: 32768, reasoningField: 'reasoning', generation: { temperature: 0.2, maxTokens: 512 } })
	})

	test('a model without the optional reasoningField resolves without one', () => {
		const minimal: ModelConfig = { name: 'm', apiBase: 'http://x/v1', contextWindow: 32768, generation: {} }
		const resolved = resolveModelConfig(minimal)
		expect(resolved.reasoningField).toBeUndefined()
		expect(resolved.name).toBe('m')
		expect(resolved.contextWindow).toBe(32768)
	})

	test('a missing name fails with both configuration channels and the not-yet-probed model API', () => {
		const withoutName: ModelConfig = { apiBase: 'http://x/v1', contextWindow: 32768, generation: {} }
		try {
			resolveModelConfig(withoutName)
			throw new Error('expected resolveModelConfig to throw')
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigurationError)
			const message = error instanceof Error ? error.message : String(error)
			expect(message).toContain('missing from the deployment configuration')
			expect(message).toContain('deployment.json')
			expect(message).toContain('"model"."name"')
			expect(message).toContain('ORCHESTRATOR_MODEL')
			expect(message).toContain('model API has not been probed')
		}
	})

	test('a missing contextWindow fails with both configuration channels and the not-yet-probed model API', () => {
		const withoutWindow: ModelConfig = { name: 'm', apiBase: 'http://x/v1', generation: {} }
		try {
			resolveModelConfig(withoutWindow)
			throw new Error('expected resolveModelConfig to throw')
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigurationError)
			const message = error instanceof Error ? error.message : String(error)
			expect(message).toContain('missing from the deployment configuration')
			expect(message).toContain('deployment.json')
			expect(message).toContain('"model"."contextWindow"')
			expect(message).toContain('ORCHESTRATOR_MODEL_CONTEXT_WINDOW')
			expect(message).toContain('model API has not been probed')
		}
	})
})
