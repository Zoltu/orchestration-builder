import { describe, expect, test } from 'bun:test'
import * as ts from 'typescript'
import { extractSymbols } from './repo-map.ts'

function extract(source: string): string[] {
	return extractSymbols('sample.ts', source, ts.ScriptKind.TS)
}

describe('extractSymbols', () => {
	test('extracts function declarations with signatures, export, and async markers', () => {
		const lines = extract(`
			export function createToolDispatch(handlers: Record<string, ToolHandler>): ToolDispatch { return { dispatch: async () => ({ kind: 'success' }) } }
			async function helper(value: string, limit?: number): Promise<number> { return 1 }
		`)
		expect(lines).toEqual([
			'export createToolDispatch(handlers: Record<string, ToolHandler>): ToolDispatch',
			'async helper(value: string, limit?: number): Promise<number>',
		])
	})

	test('extracts arrow-function factories as functions and plain constants as names', () => {
		const lines = extract(`
			export const createReadFile = (workspaceRoot: string): ToolHandler => { return () => ({ kind: 'success' }) }
			const ERROR_KINDS: readonly string[] = ['timeout']
		`)
		expect(lines).toEqual([
			'export createReadFile(workspaceRoot: string): ToolHandler',
			'ERROR_KINDS',
		])
	})

	test('extracts classes with their method signatures, marking static members', () => {
		const lines = extract(`
			export class FakeLlm implements LlmCaller {
				async call(request: LlmRequest): Promise<LlmCallResult> { return { kind: 'success', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } } }
				static create(): FakeLlm { return new FakeLlm() }
			}
		`)
		expect(lines).toEqual([
			'export class FakeLlm',
			'\tasync call(request: LlmRequest): Promise<LlmCallResult>',
			'\tstatic create(): FakeLlm',
		])
	})

	test('extracts interfaces (with type parameters), type aliases, and enums as names only', () => {
		const lines = extract(`
			export interface InteractionModel<T> { operations: T[] }
			export type RunStatus = 'running' | 'success'
			export enum Direction { Up, Down }
		`)
		expect(lines).toEqual([
			'export interface InteractionModel<T>',
			'export type RunStatus',
			'export enum Direction',
		])
	})

	test('parses browser JavaScript modules (JSDoc-typed, no type annotations)', () => {
		const lines = extractSymbols('view.js', `
			export function activeStack(model) { return null }
			export function buildScenario(raw) { return { id: raw.id, frames: [] } }
		`, ts.ScriptKind.JS)
		expect(lines).toEqual([
			'export activeStack(model)',
			'export buildScenario(raw)',
		])
	})
})
