import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createToolHandlers } from './tools.ts'

let workspaceRoot: string

beforeEach(() => {
	workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-tools-'))
	fs.writeFileSync(path.join(workspaceRoot, 'a.txt'), 'hello a')
	fs.writeFileSync(path.join(workspaceRoot, 'b.txt'), 'hello b')
	fs.mkdirSync(path.join(workspaceRoot, 'sub'))
	fs.writeFileSync(path.join(workspaceRoot, 'sub', 'c.txt'), 'hello c')
})

afterEach(() => {
	fs.rmSync(workspaceRoot, { recursive: true, force: true })
})

describe('createToolHandlers', () => {
	test('returns a handler map containing all six native tools', () => {
		const handlers = createToolHandlers({ workspaceRoot, defaultToolTimeoutSeconds: 30 })
		expect(Object.keys(handlers).sort()).toEqual([
			'fetch_url',
			'glob_files',
			'list_directory',
			'read_file',
			'read_file_partial',
			'search_text',
		])
	})

	test('all handlers are callable and return success for valid inputs', async () => {
		const handlers = createToolHandlers({ workspaceRoot, defaultToolTimeoutSeconds: 30 })
		const listResult = await handlers.list_directory!({ path: '.' })
		expect(listResult.kind).toBe('success')

		const readResult = await handlers.read_file!({ path: 'a.txt' })
		expect(readResult.kind).toBe('success')
		if (readResult.kind === 'success') {
			expect(readResult.data).toBe('hello a')
		}
	})

	test('fetch_url is callable with an injected fetcher', async () => {
		const handlers = createToolHandlers({
			workspaceRoot,
			defaultToolTimeoutSeconds: 30,
			fetcher: async () => 'fake body',
		})
		const result = await handlers.fetch_url!({ url: 'https://example.com' })
		expect(result.kind).toBe('success')
		if (result.kind === 'success') {
			expect(result.data).toBe('fake body')
		}
	})
})