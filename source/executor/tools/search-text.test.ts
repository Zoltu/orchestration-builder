import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createSearchText } from './search-text.ts'

let workspaceRoot: string

beforeEach(() => {
	workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-search-'))
	fs.writeFileSync(path.join(workspaceRoot, 'a.txt'), 'first line\nsecond line with foo\nthird line')
	fs.writeFileSync(path.join(workspaceRoot, 'b.txt'), 'no match here\nfoo is on this line\nlast line')
	fs.mkdirSync(path.join(workspaceRoot, 'sub'))
	fs.writeFileSync(path.join(workspaceRoot, 'sub', 'c.txt'), 'deep file with foo too')
})

afterEach(() => {
	fs.rmSync(workspaceRoot, { recursive: true, force: true })
})

describe('createSearchText', () => {
	test('returns matches with line numbers across the workspace', async () => {
		const handler = createSearchText(workspaceRoot)
		const result = await handler({ pattern: 'foo' })
		expect(result.kind).toBe('success')
		if (result.kind === 'success' && Array.isArray(result.data)) {
			const matches = result.data as Array<{ path: string; line: number; text: string }>
			expect(matches.length).toBe(3)
			const paths = matches.map((m) => m.path).sort()
			expect(paths).toEqual(['a.txt', 'b.txt', path.join('sub', 'c.txt')])
			for (const m of matches) {
				expect(m.text).toContain('foo')
				expect(m.line).toBeGreaterThan(0)
			}
		}
	})

	test('returns empty matches when nothing matches', async () => {
		const handler = createSearchText(workspaceRoot)
		const result = await handler({ pattern: 'definitely-not-present' })
		expect(result.kind).toBe('success')
		if (result.kind === 'success') {
			expect(result.data).toEqual([])
		}
	})

	test('respects paths argument restricting to specific files', async () => {
		const handler = createSearchText(workspaceRoot)
		const result = await handler({ pattern: 'foo', paths: ['a.txt'] })
		expect(result.kind).toBe('success')
		if (result.kind === 'success' && Array.isArray(result.data)) {
			const matches = result.data as Array<{ path: string }>
			expect(matches.length).toBe(1)
			expect(matches[0]?.path).toBe('a.txt')
		}
	})

	test('rejects a missing pattern', async () => {
		const handler = createSearchText(workspaceRoot)
		const result = await handler({})
		expect(result.kind).toBe('invalid_arguments')
	})

	test('rejects a path that escapes the workspace', async () => {
		const handler = createSearchText(workspaceRoot)
		const result = await handler({ pattern: 'foo', paths: ['../escape.txt'] })
		expect(result.kind).toBe('invalid_arguments')
	})
})