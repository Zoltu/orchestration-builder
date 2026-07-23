import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveWithinWorkspace } from './shared.ts'

let workspaceRoot: string
let outsideRoot: string

beforeEach(() => {
	workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-shared-workspace-'))
	outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-shared-outside-'))
})

afterEach(() => {
	fs.rmSync(workspaceRoot, { recursive: true, force: true })
	fs.rmSync(outsideRoot, { recursive: true, force: true })
})

describe('resolveWithinWorkspace', () => {
	test('resolves an ordinary relative path inside the workspace', () => {
		fs.writeFileSync(path.join(workspaceRoot, 'hello.txt'), 'hello')
		const resolution = resolveWithinWorkspace('hello.txt', workspaceRoot)
		expect(resolution.ok).toBe(true)
		if (resolution.ok) expect(resolution.path.relative).toBe('hello.txt')
	})

	test('resolves a not-yet-existing nested path inside the workspace', () => {
		const resolution = resolveWithinWorkspace('nested/deep/file.txt', workspaceRoot)
		expect(resolution.ok).toBe(true)
		if (resolution.ok) expect(resolution.path.relative).toBe(path.join('nested', 'deep', 'file.txt'))
	})

	test('rejects a .. escape', () => {
		const resolution = resolveWithinWorkspace('../escape.txt', workspaceRoot)
		expect(resolution.ok).toBe(false)
	})

	test('rejects an absolute path outside the workspace', () => {
		const resolution = resolveWithinWorkspace(path.join(outsideRoot, 'escape.txt'), workspaceRoot)
		expect(resolution.ok).toBe(false)
	})

	test('rejects an existing symlink that points outside the workspace', () => {
		fs.writeFileSync(path.join(outsideRoot, 'secret.txt'), 'secret')
		fs.symlinkSync(path.join(outsideRoot, 'secret.txt'), path.join(workspaceRoot, 'link.txt'))
		const resolution = resolveWithinWorkspace('link.txt', workspaceRoot)
		expect(resolution.ok).toBe(false)
	})

	test('rejects a new file under a symlinked directory that points outside the workspace', () => {
		fs.symlinkSync(outsideRoot, path.join(workspaceRoot, 'linked-dir'))
		const resolution = resolveWithinWorkspace(path.join('linked-dir', 'new-file.txt'), workspaceRoot)
		expect(resolution.ok).toBe(false)
	})

	test('allows a symlink that stays inside the workspace', () => {
		fs.mkdirSync(path.join(workspaceRoot, 'real-dir'))
		fs.writeFileSync(path.join(workspaceRoot, 'real-dir', 'file.txt'), 'inside')
		fs.symlinkSync(path.join(workspaceRoot, 'real-dir'), path.join(workspaceRoot, 'alias-dir'))
		const resolution = resolveWithinWorkspace(path.join('alias-dir', 'file.txt'), workspaceRoot)
		expect(resolution.ok).toBe(true)
	})

	test('resolves legitimate files when the workspace root is reached through a symlink', () => {
		fs.writeFileSync(path.join(workspaceRoot, 'hello.txt'), 'hello')
		const aliasRoot = path.join(os.tmpdir(), `orchestrator-shared-root-alias-${process.pid}`)
		fs.rmSync(aliasRoot, { recursive: true, force: true })
		fs.symlinkSync(workspaceRoot, aliasRoot)
		try {
			const resolution = resolveWithinWorkspace('hello.txt', aliasRoot)
			expect(resolution.ok).toBe(true)
			if (resolution.ok) expect(resolution.path.relative).toBe('hello.txt')
		} finally {
			fs.rmSync(aliasRoot, { recursive: true, force: true })
		}
	})
})
