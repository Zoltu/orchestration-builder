// Pure validation for the Foundry config and hypothesis objects.
// Mirrors the Guild validation pattern in source/shared/validation.ts: boolean guards (is*) narrow types without throwing, and parseFoundryConfig asserts the structure and throws a path-based ValidationError on malformed input.
// No typecasts are used; every check is expressed as a type predicate.

import { ValidationError } from '../shared/errors.js'
import type {
	BigModelConfig,
	FoundryBudgets,
	FoundryConfig,
	FoundryEvaluationConfig,
	FoundryMode,
	HumanSimulatorConfig,
	Hypothesis,
	HypothesisChange,
} from './types.js'

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
	return typeof value === 'string'
}

function isNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

function isOptionalNumber(value: unknown): boolean {
	return value === undefined || isNumber(value)
}

function isOptional<T>(value: unknown, predicate: (entry: unknown) => entry is T): value is T | undefined {
	if (value === undefined) return true
	return predicate(value)
}

function isHypothesisChangeArray(value: unknown): value is HypothesisChange[] {
	if (!Array.isArray(value)) return false
	return value.every(isHypothesisChange)
}

const foundryModes: readonly FoundryMode[] = ['sequential', 'parallel']

export function isFoundryMode(value: unknown): value is FoundryMode {
	return typeof value === 'string' && foundryModes.some((mode) => mode === value)
}

export function isBigModelConfig(value: unknown): value is BigModelConfig {
	if (!isObject(value)) return false
	if (!isString(value.apiBase)) return false
	if (!isString(value.apiKeyEnv)) return false
	if (!isString(value.model)) return false
	return true
}

export function isHumanSimulatorConfig(value: unknown): value is HumanSimulatorConfig {
	if (!isObject(value)) return false
	if (!isString(value.persona)) return false
	return true
}

export function isFoundryBudgets(value: unknown): value is FoundryBudgets {
	if (!isObject(value)) return false
	if (!isNumber(value.maxCycles)) return false
	if (!isOptionalNumber(value.maxBigModelTokens)) return false
	if (!isOptionalNumber(value.maxWallClockSeconds)) return false
	if (!isNumber(value.plateauPatienceCycles)) return false
	return true
}

export function isFoundryEvaluationConfig(value: unknown): value is FoundryEvaluationConfig {
	if (!isObject(value)) return false
	if (!isNumber(value.repetitionsPerBenchmark)) return false
	if (!isNumber(value.improvementMargin)) return false
	return true
}

export function isFoundryConfig(value: unknown): value is FoundryConfig {
	if (!isObject(value)) return false
	if (!isFoundryMode(value.mode)) return false
	if (!isNumber(value.maxConcurrentExecutorRuns)) return false
	if (!isNumber(value.maxConcurrentBigRequests)) return false
	if (!isBigModelConfig(value.bigModel)) return false
	if (!isOptional(value.humanSimulator, isHumanSimulatorConfig)) return false
	if (!isNumber(value.humanQuestionPenalty)) return false
	if (!isFoundryBudgets(value.budgets)) return false
	if (!isFoundryEvaluationConfig(value.evaluation)) return false
	return true
}

export function isHypothesisChange(value: unknown): value is HypothesisChange {
	if (!isObject(value)) return false
	if (!isString(value.path)) return false
	if (!isString(value.edit)) return false
	return true
}

export function isHypothesis(value: unknown): value is Hypothesis {
	if (!isObject(value)) return false
	if (!isString(value.id)) return false
	if (!isString(value.motivation)) return false
	if (!isString(value.mechanism)) return false
	if (!isString(value.predictedImpact)) return false
	if (!isHypothesisChangeArray(value.changes)) return false
	return true
}

function ensure(condition: boolean, path: string, message: string): void {
	if (!condition) throw new ValidationError(path, message)
}

function assertBigModelConfig(value: unknown, path: string): asserts value is BigModelConfig {
	if (!isObject(value)) throw new ValidationError(path, 'expected an object')
	ensure(isString(value.apiBase), `${path}.apiBase`, 'expected a string')
	ensure(isString(value.apiKeyEnv), `${path}.apiKeyEnv`, 'expected a string')
	ensure(isString(value.model), `${path}.model`, 'expected a string')
}

function assertHumanSimulatorConfig(value: unknown, path: string): asserts value is HumanSimulatorConfig {
	if (!isObject(value)) throw new ValidationError(path, 'expected an object')
	ensure(isString(value.persona), `${path}.persona`, 'expected a string')
}

function assertFoundryBudgets(value: unknown, path: string): asserts value is FoundryBudgets {
	if (!isObject(value)) throw new ValidationError(path, 'expected an object')
	ensure(isNumber(value.maxCycles), `${path}.maxCycles`, 'expected a number')
	ensure(isOptionalNumber(value.maxBigModelTokens), `${path}.maxBigModelTokens`, 'expected a number or undefined')
	ensure(isOptionalNumber(value.maxWallClockSeconds), `${path}.maxWallClockSeconds`, 'expected a number or undefined')
	ensure(isNumber(value.plateauPatienceCycles), `${path}.plateauPatienceCycles`, 'expected a number')
}

function assertFoundryEvaluationConfig(value: unknown, path: string): asserts value is FoundryEvaluationConfig {
	if (!isObject(value)) throw new ValidationError(path, 'expected an object')
	ensure(isNumber(value.repetitionsPerBenchmark), `${path}.repetitionsPerBenchmark`, 'expected a number')
	ensure(isNumber(value.improvementMargin), `${path}.improvementMargin`, 'expected a number')
}

function assertFoundryConfig(value: unknown): asserts value is FoundryConfig {
	if (!isObject(value)) throw new ValidationError('', 'expected an object')
	ensure(isFoundryMode(value.mode), 'mode', 'expected "sequential" or "parallel"')
	ensure(isNumber(value.maxConcurrentExecutorRuns), 'maxConcurrentExecutorRuns', 'expected a number')
	ensure(isNumber(value.maxConcurrentBigRequests), 'maxConcurrentBigRequests', 'expected a number')
	assertBigModelConfig(value.bigModel, 'bigModel')
	if (value.humanSimulator !== undefined) assertHumanSimulatorConfig(value.humanSimulator, 'humanSimulator')
	ensure(isNumber(value.humanQuestionPenalty), 'humanQuestionPenalty', 'expected a number')
	assertFoundryBudgets(value.budgets, 'budgets')
	assertFoundryEvaluationConfig(value.evaluation, 'evaluation')
}

// Mirrors parseEvalConfig / validateGuildConfig.
export function parseFoundryConfig(value: unknown): FoundryConfig {
	assertFoundryConfig(value)
	return value
}
