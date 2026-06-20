import { describe, expect, test } from 'bun:test'

import { ValidationError } from '../shared/errors.ts'
import {
	isBigModelConfig,
	isFoundryBudgets,
	isFoundryConfig,
	isFoundryMode,
	isHypothesis,
	isHypothesisChange,
	isHumanSimulatorConfig,
	parseFoundryConfig,
} from './config.ts'
import type { FoundryConfig, Hypothesis } from './types.ts'

const validFoundryConfig: FoundryConfig = {
	mode: 'parallel',
	maxConcurrentExecutorRuns: 1,
	maxConcurrentBigRequests: 8,
	bigModel: { apiBase: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', model: 'gpt-4o' },
	humanSimulator: { persona: 'a senior software engineer who wants the project done correctly' },
	humanQuestionPenalty: 0.05,
	budgets: { maxCycles: 20, maxBigModelTokens: 2_000_000, plateauPatienceCycles: 3 },
	evaluation: { repetitionsPerBenchmark: 3, improvementMargin: 0.05 },
}

const validHypothesis: Hypothesis = {
	id: 'h-001',
	motivation: 'The coder role often ignores failing test output.',
	mechanism: 'Increase max_tool_output_chars for the coder role.',
	predictedImpact: '+10% pass rate on medium coding tasks',
	changes: [{ path: 'prompts/coder.md', edit: 'new coder prompt' }],
}

describe('boolean guards', () => {
	test('isFoundryMode accepts the two documented modes', () => {
		expect(isFoundryMode('sequential')).toBe(true)
		expect(isFoundryMode('parallel')).toBe(true)
	})
	test('isFoundryMode rejects an unknown mode', () => {
		expect(isFoundryMode('turbo')).toBe(false)
		expect(isFoundryMode(1)).toBe(false)
	})
	test('isBigModelConfig accepts a valid big-model config', () => {
		expect(isBigModelConfig(validFoundryConfig.bigModel)).toBe(true)
	})
	test('isBigModelConfig rejects a non-string apiKeyEnv', () => {
		expect(isBigModelConfig({ apiBase: 'x', apiKeyEnv: 1, model: 'm' })).toBe(false)
	})
	test('isHumanSimulatorConfig accepts a persona string', () => {
		expect(isHumanSimulatorConfig(validFoundryConfig.humanSimulator)).toBe(true)
	})
	test('isHumanSimulatorConfig rejects a missing persona', () => {
		expect(isHumanSimulatorConfig({})).toBe(false)
	})
	test('isFoundryBudgets accepts a budget with both cost limits', () => {
		expect(isFoundryBudgets(validFoundryConfig.budgets)).toBe(true)
	})
	test('isFoundryBudgets accepts a budget with no cost limits', () => {
		expect(isFoundryBudgets({ maxCycles: 1, plateauPatienceCycles: 1 })).toBe(true)
	})
	test('isFoundryBudgets rejects a non-number maxCycles', () => {
		expect(isFoundryBudgets({ maxCycles: 'no', plateauPatienceCycles: 1 })).toBe(false)
	})
	test('isFoundryConfig accepts a complete config including optional humanSimulator', () => {
		expect(isFoundryConfig(validFoundryConfig)).toBe(true)
	})
	test('isFoundryConfig accepts a config that omits humanSimulator', () => {
		const withoutSimulator = { ...validFoundryConfig, humanSimulator: undefined }
		expect(isFoundryConfig(withoutSimulator)).toBe(true)
	})
	test('isFoundryConfig rejects a non-object root', () => {
		expect(isFoundryConfig(null)).toBe(false)
		expect(isFoundryConfig([])).toBe(false)
		expect(isFoundryConfig('nope')).toBe(false)
	})
	test('isFoundryConfig rejects an unknown mode', () => {
		expect(isFoundryConfig({ ...validFoundryConfig, mode: 'turbo' })).toBe(false)
	})
	test('isFoundryConfig rejects a malformed bigModel', () => {
		expect(isFoundryConfig({ ...validFoundryConfig, bigModel: { apiBase: 'x' } })).toBe(false)
	})
	test('isFoundryConfig rejects a non-number humanSimulator persona', () => {
		expect(isFoundryConfig({ ...validFoundryConfig, humanSimulator: { persona: 1 } })).toBe(false)
	})
	test('isFoundryConfig rejects a malformed budgets block', () => {
		expect(isFoundryConfig({ ...validFoundryConfig, budgets: { maxCycles: 1 } })).toBe(false)
	})
	test('isHypothesisChange accepts a path/edit pair', () => {
		expect(isHypothesisChange({ path: 'guild.json', edit: '{}' })).toBe(true)
	})
	test('isHypothesisChange rejects a missing edit', () => {
		expect(isHypothesisChange({ path: 'guild.json' })).toBe(false)
	})
	test('isHypothesis accepts a valid hypothesis', () => {
		expect(isHypothesis(validHypothesis)).toBe(true)
	})
	test('isHypothesis rejects a changes entry that is not a HypothesisChange', () => {
		expect(isHypothesis({ ...validHypothesis, changes: [{ path: 'x' }] })).toBe(false)
	})
	test('isHypothesis rejects a non-array changes', () => {
		expect(isHypothesis({ ...validHypothesis, changes: 'no' })).toBe(false)
	})
})

describe('parseFoundryConfig', () => {
	test('returns the config typed when it is well-formed', () => {
		const parsed = parseFoundryConfig(validFoundryConfig)
		expect(parsed.mode).toBe('parallel')
		expect(parsed.bigModel.model).toBe('gpt-4o')
		expect(parsed.evaluation.improvementMargin).toBe(0.05)
	})

	test('accepts a config that omits humanSimulator', () => {
		const withoutSimulator = { ...validFoundryConfig, humanSimulator: undefined }
		expect(() => parseFoundryConfig(withoutSimulator)).not.toThrow()
	})

	test('rejects a non-object root with a clear error', () => {
		expect(() => parseFoundryConfig('nope')).toThrow(ValidationError)
		expect(() => parseFoundryConfig(null)).toThrow(ValidationError)
	})

	test('rejects an unknown mode with a path-based message', () => {
		let caught: ValidationError | undefined
		try {
			parseFoundryConfig({ ...validFoundryConfig, mode: 'turbo' })
		} catch (error) {
			if (error instanceof ValidationError) caught = error
		}
		expect(caught).toBeDefined()
		expect(caught!.path).toBe('mode')
		expect(caught!.message).toMatch(/sequential|parallel/)
	})

	test('rejects a non-number maxConcurrentExecutorRuns', () => {
		expect(() => parseFoundryConfig({ ...validFoundryConfig, maxConcurrentExecutorRuns: '1' })).toThrow(/maxConcurrentExecutorRuns/)
	})

	test('rejects a malformed bigModel with a nested path', () => {
		let caught: ValidationError | undefined
		try {
			parseFoundryConfig({ ...validFoundryConfig, bigModel: { apiBase: 'x', apiKeyEnv: 'K', model: 1 } })
		} catch (error) {
			if (error instanceof ValidationError) caught = error
		}
		expect(caught).toBeDefined()
		expect(caught!.path).toBe('bigModel.model')
	})

	test('rejects a non-string humanSimulator persona', () => {
		expect(() => parseFoundryConfig({ ...validFoundryConfig, humanSimulator: { persona: 7 } })).toThrow(/humanSimulator\.persona/)
	})

	test('rejects a non-number humanQuestionPenalty', () => {
		expect(() => parseFoundryConfig({ ...validFoundryConfig, humanQuestionPenalty: '0.05' })).toThrow(/humanQuestionPenalty/)
	})

	test('rejects a missing maxCycles in budgets', () => {
		expect(() => parseFoundryConfig({ ...validFoundryConfig, budgets: { plateauPatienceCycles: 1 } })).toThrow(/budgets\.maxCycles/)
	})

	test('rejects a non-number plateauPatienceCycles', () => {
		expect(() => parseFoundryConfig({ ...validFoundryConfig, budgets: { maxCycles: 1, plateauPatienceCycles: 'no' } })).toThrow(/plateauPatienceCycles/)
	})

	test('rejects a missing evaluation block', () => {
		expect(() => parseFoundryConfig({ ...validFoundryConfig, evaluation: undefined })).toThrow(ValidationError)
	})

	test('rejects a non-number repetitionsPerBenchmark', () => {
		expect(() => parseFoundryConfig({ ...validFoundryConfig, evaluation: { repetitionsPerBenchmark: '3', improvementMargin: 0.05 } })).toThrow(/repetitionsPerBenchmark/)
	})

	test('rejects a non-number improvementMargin', () => {
		expect(() => parseFoundryConfig({ ...validFoundryConfig, evaluation: { repetitionsPerBenchmark: 3, improvementMargin: '0.05' } })).toThrow(/improvementMargin/)
	})
})
