import { describe, expect, test } from 'bun:test'
import { isRunDocumentContent, MAX_RUN_DOCUMENT_CHARS, runDocumentDeliveryProblem, runDocumentWriteProblem } from './run-document.ts'

describe('isRunDocumentContent', () => {
	test('accepts non-empty strings and rejects empty or non-string values', () => {
		expect(isRunDocumentContent('# Plan')).toBe(true)
		expect(isRunDocumentContent('')).toBe(false)
		expect(isRunDocumentContent(undefined)).toBe(false)
		expect(isRunDocumentContent(42)).toBe(false)
	})
})

describe('runDocumentWriteProblem', () => {
	test('accepts content at both the content and serialized limits', () => {
		const content = 'a'.repeat(100)
		expect(runDocumentWriteProblem(content, 100, 102)).toBeNull()
	})

	test('rejects content over the content cap', () => {
		const content = 'a'.repeat(MAX_RUN_DOCUMENT_CHARS + 1)
		const problem = runDocumentWriteProblem(content, MAX_RUN_DOCUMENT_CHARS, 1_000_000)
		expect(problem).not.toBeNull()
		expect(problem).toContain(`${MAX_RUN_DOCUMENT_CHARS + 1}`)
	})

	test('rejects escaping content over the serialized cap even under the content cap', () => {
		const content = '"'.repeat(100)
		const problem = runDocumentWriteProblem(content, MAX_RUN_DOCUMENT_CHARS, 201)
		expect(content.length).toBeLessThan(MAX_RUN_DOCUMENT_CHARS)
		expect(JSON.stringify(content).length).toBe(202)
		expect(problem).not.toBeNull()
		expect(problem).toContain('100')
		expect(problem).toContain('202')
		expect(problem).toContain('201')
		expect(problem).toContain('Nothing was written')
		expect(problem).toContain('unchanged')
		expect(problem).toContain('condense')
	})

	test('rejects content one character over the content cap', () => {
		expect(runDocumentWriteProblem('a'.repeat(101), 100, 102)).not.toBeNull()
	})

	test('accepts content whose serialized length equals the delivery cap', () => {
		const content = 'a'.repeat(100)
		expect(JSON.stringify(content).length).toBe(102)
		expect(runDocumentWriteProblem(content, MAX_RUN_DOCUMENT_CHARS, 102)).toBeNull()
	})

	test('rejects content whose serialized length is one over the delivery cap', () => {
		expect(runDocumentWriteProblem('a'.repeat(100), MAX_RUN_DOCUMENT_CHARS, 101)).not.toBeNull()
	})
})

describe('runDocumentDeliveryProblem', () => {
	test('accepts a payload at the limit', () => {
		const content = 'a'.repeat(100)
		expect(JSON.stringify(content).length).toBe(102)
		expect(runDocumentDeliveryProblem(content, 102)).toBeNull()
	})

	test('rejects a payload over the limit with the resolution paths', () => {
		const content = 'a'.repeat(100)
		const problem = runDocumentDeliveryProblem(content, 101)
		expect(problem).not.toBeNull()
		expect(problem).toContain('cannot be returned whole')
		expect(problem).toContain("document's owner")
		expect(problem).toContain('maxToolOutputChars')
		expect(problem).toContain('ORCHESTRATOR_MAX_TOOL_OUTPUT_CHARS')
	})
})
