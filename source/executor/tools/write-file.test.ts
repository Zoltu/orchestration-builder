import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createWriteFile } from './write-file.ts'

let workspaceRoot: string

beforeEach(() => {
	workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-write-file-'))
})

afterEach(() => {
	fs.rmSync(workspaceRoot, { recursive: true, force: true })
})

describe('createWriteFile', () => {
	test('writes a new file and reports the relative path and byte count', async () => {
		const handler = createWriteFile(workspaceRoot)
		const result = await handler({ path: 'hello.txt', content: 'hello world' })
		expect(result.kind).toBe('success')
		if (result.kind === 'success') {
			const data = result.data as { path: string; bytes: number }
			expect(data.path).toBe('hello.txt')
			expect(data.bytes).toBe(11)
		}
		expect(fs.readFileSync(path.join(workspaceRoot, 'hello.txt'), 'utf8')).toBe('hello world')
	})

	test('overwrites an existing file', async () => {
		fs.writeFileSync(path.join(workspaceRoot, 'hello.txt'), 'old contents')
		const handler = createWriteFile(workspaceRoot)
		const result = await handler({ path: 'hello.txt', content: 'new contents' })
		expect(result.kind).toBe('success')
		expect(fs.readFileSync(path.join(workspaceRoot, 'hello.txt'), 'utf8')).toBe('new contents')
	})

	test('creates nested parent directories as needed', async () => {
		const handler = createWriteFile(workspaceRoot)
		const result = await handler({ path: 'nested/deep/file.txt', content: 'nested' })
		expect(result.kind).toBe('success')
		expect(fs.readFileSync(path.join(workspaceRoot, 'nested', 'deep', 'file.txt'), 'utf8')).toBe('nested')
	})

	test('rejects a path that escapes the workspace', async () => {
		const handler = createWriteFile(workspaceRoot)
		const result = await handler({ path: '../escape.txt', content: 'escape' })
		expect(result.kind).toBe('invalid_arguments')
		expect(fs.existsSync(path.join(workspaceRoot, '..', 'escape.txt'))).toBe(false)
	})

	test('rejects a missing or empty path argument', async () => {
		const handler = createWriteFile(workspaceRoot)
		const missing = await handler({ content: 'no path' })
		expect(missing.kind).toBe('invalid_arguments')
		const empty = await handler({ path: '', content: 'empty path' })
		expect(empty.kind).toBe('invalid_arguments')
	})

	test('rejects a missing content argument', async () => {
		const handler = createWriteFile(workspaceRoot)
		const result = await handler({ path: 'hello.txt' })
		expect(result.kind).toBe('invalid_arguments')
		expect(fs.existsSync(path.join(workspaceRoot, 'hello.txt'))).toBe(false)
	})

	test('counts bytes correctly for multibyte content', async () => {
		const handler = createWriteFile(workspaceRoot)
		const content = 'héllo 世界'
		const result = await handler({ path: 'unicode.txt', content })
		expect(result.kind).toBe('success')
		if (result.kind === 'success') {
			const data = result.data as { path: string; bytes: number }
			expect(data.bytes).toBe(Buffer.byteLength(content, 'utf8'))
		}
	})
})
