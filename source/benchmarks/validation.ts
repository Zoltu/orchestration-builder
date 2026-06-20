// Pure validation helpers for benchmark eval configs and run outputs.
// This module is the testable surface: parseEvalConfig validates an eval.json
// object with type guards (no typecasts) and evaluateValidation decides
// pass/fail from a parsed validation spec and a run output. No shell execution
// or filesystem access happens here.

import { ValidationError } from '../shared/errors.js'

export interface ValidationSpec {
	command: string
	expectedExitCode?: number
	expectedFiles?: string[]
	expectedStdoutContains?: string | string[]
	timeoutSeconds?: number
}

export interface EvalConfig {
	taskType: string
	description: string
	validation: ValidationSpec
	humanResponses?: Record<string, string>
}

export interface BenchmarkRunOutput {
	exitCode: number | null
	stdout: string
	stderr: string
	timedOut: boolean
	expectedFilesPresent: Record<string, boolean>
}

export interface ValidationResult {
	status: 'pass' | 'fail'
	reasons: string[]
}

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

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isString)
}

function isStringOrStringArray(value: unknown): value is string | string[] {
	return isString(value) || isStringArray(value)
}

function isRecordOfStrings(value: unknown): value is Record<string, string> {
	if (!isObject(value)) return false
	for (const key of Object.keys(value)) {
		if (!isString(value[key])) return false
	}
	return true
}

function ensure(condition: boolean, path: string, message: string): void {
	if (!condition) throw new ValidationError(path, message)
}

function assertValidationSpec(value: unknown, path: string): asserts value is ValidationSpec {
	if (!isObject(value)) throw new ValidationError(path, 'expected an object')
	ensure(isString(value['command']), `${path}.command`, 'expected a string')
	ensure(isOptionalNumber(value['expectedExitCode']), `${path}.expectedExitCode`, 'expected a number or undefined')
	ensure(value['expectedFiles'] === undefined || isStringArray(value['expectedFiles']), `${path}.expectedFiles`, 'expected an array of strings or undefined')
	ensure(value['expectedStdoutContains'] === undefined || isStringOrStringArray(value['expectedStdoutContains']), `${path}.expectedStdoutContains`, 'expected a string, an array of strings, or undefined')
	ensure(isOptionalNumber(value['timeoutSeconds']), `${path}.timeoutSeconds`, 'expected a number or undefined')
}

function assertEvalConfig(value: unknown): asserts value is EvalConfig {
	if (!isObject(value)) throw new ValidationError('', 'expected an object')
	ensure(isString(value['taskType']), 'taskType', 'expected a string')
	ensure(isString(value['description']), 'description', 'expected a string')
	assertValidationSpec(value['validation'], 'validation')
	ensure(value['humanResponses'] === undefined || isRecordOfStrings(value['humanResponses']), 'humanResponses', 'expected a record of strings or undefined')
}

// Validates an eval.json object and returns it typed as EvalConfig. Throws a
// ValidationError with a path-based message when the input is malformed.
export function parseEvalConfig(value: unknown): EvalConfig {
	assertEvalConfig(value)
	return value
}

function normalizeStdoutContains(value: string | string[] | undefined): string[] {
	if (value === undefined) return []
	if (typeof value === 'string') return [value]
	return value
}

// Pure decision logic: given a parsed validation spec and a run output
// (expected-file existence booleans, exit code, stdout), return pass/fail with
// a list of human-readable reasons. No shell execution or I/O happens here.
export function evaluateValidation(spec: ValidationSpec, runOutput: BenchmarkRunOutput): ValidationResult {
	const reasons: string[] = []

	for (const file of spec.expectedFiles ?? []) {
		if (!runOutput.expectedFilesPresent[file]) {
			reasons.push(`expected file missing: ${file}`)
		}
	}

	if (runOutput.timedOut) {
		reasons.push(`validation command timed out after ${spec.timeoutSeconds ?? 60}s`)
		return { status: 'fail', reasons }
	}

	const expectedExitCode = spec.expectedExitCode ?? 0
	if (runOutput.exitCode === null) {
		reasons.push('validation command did not produce an exit code')
	} else if (runOutput.exitCode !== expectedExitCode) {
		reasons.push(`expected exit code ${expectedExitCode}, got ${runOutput.exitCode}`)
	}

	for (const needle of normalizeStdoutContains(spec.expectedStdoutContains)) {
		if (!runOutput.stdout.includes(needle)) {
			reasons.push(`stdout missing expected text: ${needle}`)
		}
	}

	return reasons.length === 0 ? { status: 'pass', reasons: [] } : { status: 'fail', reasons }
}
