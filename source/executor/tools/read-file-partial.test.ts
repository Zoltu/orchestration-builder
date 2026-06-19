import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createReadFilePartial } from './read-file-partial.ts'

let workspaceRoot: string

beforeEach(() => {
	workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-read-partial-'))
	const content = ['line one', 'line two', 'line three', 'line four', 'line five'].join('\n') + '\n'
	fs.writeFileSync(path.join(workspaceRoot, 'lines.txt'), content)
})

afterEach(() => {
	fs.rmSync(workspaceRoot, { recursive: true, force: true })
})

describe('createReadFilePartial', () => {
	test('returns the requested slice of the file', async () => {
		const handler = createReadFilePartial(workspaceRoot)
		const result = await handler({ path: 'lines.txt', offset: 1, limit: 2 })
		expect(result.kind).toBe('success')
		if (result.kind === 'success' && typeof result.data === 'object' && result.data !== null) {
			const data = result.data as { content: string; offset: number; limit: number; totalLines: number }
			expect(data.content).toBe('line two\nline three')
			expect(data.offset).toBe(1)
			expect(data.limit).toBe(2)
			expect(data.totalLines).toBeGreaterThanOrEqual(5)
		}
	})

	test('clamps the slice to the file length', async () => {
		const handler = createReadFilePartial(workspaceRoot)
		const result = await handler({ path: 'lines.txt', offset: 0, limit: 999 })
		expect(result.kind).toBe('success')
		if (result.kind === 'success' && typeof result.data === 'object' && result.data !== null) {
			const data = result.data as { content: string; limit: number }
			expect(data.limit).toBeLessThanOrEqual(data.content.split('\n').length)
		}
	})

	test('rejects a negative offset', async () => {
		const handler = createReadFilePartial(workspaceRoot)
		const result = await handler({ path: 'lines.txt', offset: -1, limit: 1 })
		expect(result.kind).toBe('invalid_arguments')
	})

	test('rejects a non-positive limit', async () => {
		const handler = createReadFilePartial(workspaceRoot)
		const result = await handler({ path: 'lines.txt', offset: 0, limit: 0 })
		expect(result.kind).toBe('invalid_arguments')
	})

	test('rejects a path that escapes the workspace', async () => {
		const handler = createReadFilePartial(workspaceRoot)
		const result = await handler({ path: '../lines.txt', offset: 0, limit: 1 })
		expect(result.kind).toBe('invalid_arguments')
	})
})