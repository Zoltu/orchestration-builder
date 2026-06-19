import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createListDirectory } from './list-directory.ts'

let workspaceRoot: string

beforeEach(() => {
	workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-list-dir-'))
	fs.writeFileSync(path.join(workspaceRoot, 'alpha.txt'), 'a')
	fs.writeFileSync(path.join(workspaceRoot, 'beta.txt'), 'b')
	fs.mkdirSync(path.join(workspaceRoot, 'sub'))
	fs.writeFileSync(path.join(workspaceRoot, 'sub', 'gamma.txt'), 'c')
})

afterEach(() => {
	fs.rmSync(workspaceRoot, { recursive: true, force: true })
})

describe('createListDirectory', () => {
	test('lists workspace root by default with sorted directories first', async () => {
		const handler = createListDirectory(workspaceRoot)
		const result = await handler({})
		expect(result.kind).toBe('success')
		if (result.kind === 'success' && Array.isArray(result.data)) {
			const names = (result.data as Array<{ name: string; type: string }>).map((e) => `${e.type}:${e.name}`)
			expect(names).toEqual(['directory:sub', 'file:alpha.txt', 'file:beta.txt'])
		}
	})

	test('lists a subdirectory when path is given', async () => {
		const handler = createListDirectory(workspaceRoot)
		const result = await handler({ path: 'sub' })
		expect(result.kind).toBe('success')
		if (result.kind === 'success' && Array.isArray(result.data)) {
			expect((result.data as Array<{ name: string; type: string }>).map((e) => e.name)).toEqual(['gamma.txt'])
		}
	})

	test('rejects a path that escapes the workspace', async () => {
		const handler = createListDirectory(workspaceRoot)
		const result = await handler({ path: '../escape' })
		expect(result.kind).toBe('invalid_arguments')
	})

	test('rejects an absolute path outside the workspace', async () => {
		const handler = createListDirectory(workspaceRoot)
		const result = await handler({ path: '/etc' })
		expect(result.kind).toBe('invalid_arguments')
	})
})