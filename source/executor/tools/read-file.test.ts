import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createReadFile } from './read-file.ts'

let workspaceRoot: string

beforeEach(() => {
	workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-read-file-'))
	fs.writeFileSync(path.join(workspaceRoot, 'hello.txt'), 'hello world')
})

afterEach(() => {
	fs.rmSync(workspaceRoot, { recursive: true, force: true })
})

describe('createReadFile', () => {
	test('returns the full file content', async () => {
		const handler = createReadFile(workspaceRoot)
		const result = await handler({ path: 'hello.txt' })
		expect(result.kind).toBe('success')
		if (result.kind === 'success') {
			expect(result.data).toBe('hello world')
		}
	})

	test('rejects a missing path argument', async () => {
		const handler = createReadFile(workspaceRoot)
		const result = await handler({})
		expect(result.kind).toBe('invalid_arguments')
	})

	test('rejects a path that escapes the workspace', async () => {
		const handler = createReadFile(workspaceRoot)
		const result = await handler({ path: '../escape.txt' })
		expect(result.kind).toBe('invalid_arguments')
	})

	test('reports missing files inside the workspace', async () => {
		const handler = createReadFile(workspaceRoot)
		const result = await handler({ path: 'missing.txt' })
		expect(result.kind).toBe('invalid_arguments')
	})
})