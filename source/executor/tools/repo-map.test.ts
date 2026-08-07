import { describe, expect, test } from 'bun:test'
import { extractSymbols, isRepoMapExcludedPath } from './repo-map.ts'

describe('extractSymbols', () => {
	test('extracts function declarations with signatures, export, and async markers', () => {
		const lines = extractSymbols(`
			export function createToolDispatch(handlers: Record<string, ToolHandler>): ToolDispatch { return { dispatch: async () => ({ kind: 'success' }) } }
			async function helper(value: string, limit?: number): Promise<number> { return 1 }
		`)
		expect(lines).toEqual([
			'export createToolDispatch(handlers: Record<string, ToolHandler>): ToolDispatch',
			'async helper(value: string, limit?: number): Promise<number>',
		])
	})

	test('extracts arrow-function factories as functions and plain constants as names', () => {
		const lines = extractSymbols(`
			export const createReadFile = (workspaceRoot: string): ToolHandler => { return () => ({ kind: 'success' }) }
			const ERROR_KINDS: readonly string[] = ['timeout']
			const min = 1, max = 10
			const identity = value => value
			const load = async (id: string): Promise<string> => Promise.resolve(id)
		`)
		expect(lines).toEqual([
			'export createReadFile(workspaceRoot: string): ToolHandler',
			'ERROR_KINDS',
			'min',
			'max',
			'identity(value)',
			'load(id: string): Promise<string>',
		])
	})

	test('extracts classes with their method signatures, marking static members', () => {
		const lines = extractSymbols(`
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
		const lines = extractSymbols(`
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

	test('parses plain JavaScript modules with no type annotations', () => {
		const lines = extractSymbols(`
			export function activeStack(model) { return null }
			export function buildScenario(raw) { return { id: raw.id, frames: [] } }
		`)
		expect(lines).toEqual([
			'export activeStack(model)',
			'export buildScenario(raw)',
		])
	})

	test('joins multi-line signatures and generic lists onto one line', () => {
		const lines = extractSymbols(`
			export function createThing(
				handlers: Record<string, ToolHandler>,
				options: { retries?: number },
			): ToolDispatch {
				return { dispatch: async () => ({ kind: 'success' }) }
			}
			export function merge<
				T extends Record<string, unknown>,
				U extends Record<string, unknown>
			>(left: T, right: U): T & U {
				return { ...left, ...right }
			}
		`)
		expect(lines).toEqual([
			'export createThing(handlers: Record<string, ToolHandler>, options: { retries?: number }): ToolDispatch',
			'export merge<T extends Record<string, unknown>, U extends Record<string, unknown>>(left: T, right: U): T & U',
		])
	})

	test('ignores commented-out declarations', () => {
		const lines = extractSymbols(`
			// export function commentedOut(): void {}
			/*
			export class AlsoGone {
				method(): void {}
			}
			*/
			export function real(): void {}
		`)
		expect(lines).toEqual(['export real(): void'])
	})

	test('ignores declarations nested inside a function body', () => {
		const lines = extractSymbols(`
			export function outer(): void {
				function inner(): void {}
				const local = () => 1
			}
		`)
		expect(lines).toEqual(['export outer(): void'])
	})

	test('handles default parameter values containing commas and arrow functions', () => {
		const lines = extractSymbols(`
			export function configure(options: { retries: number, label: string } = { retries: 2, label: 'x' }, callback: () => void = () => {}): void {}
		`)
		expect(lines).toEqual([
			"export configure(options: { retries: number, label: string } = { retries: 2, label: 'x' }, callback: () => void = () => {}): void",
		])
	})

	test('skips class constructors and properties, keeping only methods', () => {
		const lines = extractSymbols(`
			export class Service {
				private readonly name: string = 'svc'
				constructor(name: string) { this.name = name }
				start(): void {}
			}
		`)
		expect(lines).toEqual(['export class Service', '\tstart(): void'])
	})

	test('renders interfaces with an extends clause as name plus type parameters only', () => {
		const lines = extractSymbols(`
			export interface Repository<T extends Entity> extends Readable<T>, Writable<T> {
				readonly size: number
			}
		`)
		expect(lines).toEqual(['export interface Repository<T extends Entity>'])
	})

	test('is not confused by strings containing declaration keywords', () => {
		const lines = extractSymbols(`
			const message = 'function fake(): void {}'
			export function real(): void {}
		`)
		expect(lines).toEqual(['message', 'export real(): void'])
	})

	test('is not confused by template literals containing code', () => {
		const lines = extractSymbols('const snippet = `export function fake(): void { return ${1 + 2} }`\nexport function real(): void {}')
		expect(lines).toEqual(['snippet', 'export real(): void'])
	})

	test('a literal initializer does not adopt the following declaration', () => {
		const lines = extractSymbols(`
			const NOTICE = 'shutting down'
			const LIMIT = 30_000
			async function serve(): Promise<void> {}
		`)
		expect(lines).toEqual(['NOTICE', 'LIMIT', 'async serve(): Promise<void>'])
	})

	test('includes object literals in type predicates', () => {
		const lines = extractSymbols(`
			function isKagiSearchItem(value: unknown): value is { url: string; title: string; snippet?: string; time?: string } {
				return typeof value === 'object'
			}
		`)
		expect(lines).toEqual([
			'isKagiSearchItem(value: unknown): value is { url: string; title: string; snippet?: string; time?: string }',
		])
	})

	test('includes a bare object literal as a return type', () => {
		const lines = extractSymbols(`
			export function defaults(): { retries: number; label: string } {
				return { retries: 1, label: 'x' }
			}
		`)
		expect(lines).toEqual(['export defaults(): { retries: number; label: string }'])
	})

	test('includes object literals as union members in a return type', () => {
		const lines = extractSymbols(`
			export function describe(run: Run): { id: string; status: string } | null {
				return null
			}
		`)
		expect(lines).toEqual(['export describe(run: Run): { id: string; status: string } | null'])
	})
})

describe('isRepoMapExcludedPath', () => {
	test('excludes declaration and test files', () => {
		expect(isRepoMapExcludedPath('source/executor/types.d.ts')).toBe(true)
		expect(isRepoMapExcludedPath('source/executor/engine.test.ts')).toBe(true)
		expect(isRepoMapExcludedPath('web/view.test.jsx')).toBe(true)
		expect(isRepoMapExcludedPath('source/executor/engine.ts')).toBe(false)
	})

	test('excludes dot-directories and dependency/build directories', () => {
		expect(isRepoMapExcludedPath('.git/hooks/check.ts')).toBe(true)
		expect(isRepoMapExcludedPath('source/.orchestration/state.ts')).toBe(true)
		expect(isRepoMapExcludedPath('node_modules/pkg/index.ts')).toBe(true)
		expect(isRepoMapExcludedPath('dist/bundle.js')).toBe(true)
		expect(isRepoMapExcludedPath('vendor/lib/help.ts')).toBe(true)
		expect(isRepoMapExcludedPath('build/output.js')).toBe(true)
		expect(isRepoMapExcludedPath('source/executor/engine.ts')).toBe(false)
	})
})
