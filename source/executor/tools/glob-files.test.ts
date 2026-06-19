import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createGlobFiles } from './glob-files.ts'

let workspaceRoot: string

beforeEach(() => {
	workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-glob-'))
	fs.writeFileSync(path.join(workspaceRoot, 'a.ts'), '')
	fs.writeFileSync(path.join(workspaceRoot, 'b.ts'), '')
	fs.mkdirSync(path.join(workspaceRoot, 'sub'))
	fs.writeFileSync(path.join(workspaceRoot, 'sub', 'c.ts'), '')
	fs.writeFileSync(path.join(workspaceRoot, 'sub', 'd.md'), '')
})

afterEach(() => {
	fs.rmSync(workspaceRoot, { recursive: true, force: true })
})

describe('createGlobFiles', () => {
	test('returns matching files for a *.ts pattern (top-level only)', async () => {
		const handler = createGlobFiles(workspaceRoot)
		const result = await handler({ pattern: '*.ts' })
		expect(result.kind).toBe('success')
		if (result.kind === 'success' && Array.isArray(result.data)) {
			const sorted = (result.data as string[]).slice().sort()
			expect(sorted).toEqual(['a.ts', 'b.ts'])
		}
	})

	test('returns matching files recursively for **/*.ts', async () => {
		const handler = createGlobFiles(workspaceRoot)
		const result = await handler({ pattern: '**/*.ts' })
		expect(result.kind).toBe('success')
		if (result.kind === 'success' && Array.isArray(result.data)) {
			const sorted = (result.data as string[]).slice().sort()
			expect(sorted).toEqual(['sub/c.ts'])
		}
	})

	test('** matches all files at any depth including root', async () => {
		const handler = createGlobFiles(workspaceRoot)
		const result = await handler({ pattern: '**' })
		expect(result.kind).toBe('success')
		if (result.kind === 'success' && Array.isArray(result.data)) {
			const sorted = (result.data as string[]).slice().sort()
			expect(sorted).toEqual(['a.ts', 'b.ts', 'sub/c.ts', 'sub/d.md'])
		}
	})

	test('matches double-star with a different extension', async () => {
		const handler = createGlobFiles(workspaceRoot)
		const result = await handler({ pattern: '**/*.md' })
		expect(result.kind).toBe('success')
		if (result.kind === 'success' && Array.isArray(result.data)) {
			expect(result.data).toEqual(['sub/d.md'])
		}
	})

	test('returns an empty list when nothing matches', async () => {
		const handler = createGlobFiles(workspaceRoot)
		const result = await handler({ pattern: '*.nonexistent' })
		expect(result.kind).toBe('success')
		if (result.kind === 'success') {
			expect(result.data).toEqual([])
		}
	})

	test('rejects a missing pattern', async () => {
		const handler = createGlobFiles(workspaceRoot)
		const result = await handler({})
		expect(result.kind).toBe('invalid_arguments')
	})

	test('rejects an empty pattern', async () => {
		const handler = createGlobFiles(workspaceRoot)
		const result = await handler({ pattern: '' })
		expect(result.kind).toBe('invalid_arguments')
	})
})