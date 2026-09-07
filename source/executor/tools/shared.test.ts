import { describe, expect, test } from 'bun:test'
import * as path from 'node:path'
import { isOrchestrationPath, resolveWithinWorkspace, wrapIoError, type PathFilesystem } from './shared.ts'

const ROOT = '/workspace'

// A scripted filesystem: `existing` lists the paths that exist, `symlinks` maps a link path to its target. Existence follows links (as existsSync does), and realpath collapses link prefixes lexically, mirroring how the real realpath resolves links along the way.
function makeFilesystem(existing: string[], symlinks: Record<string, string> = {}): PathFilesystem {
	const existingSet = new Set(existing.map((entry) => path.resolve(entry)))
	const linkMap = new Map(Object.entries(symlinks).map(([link, target]) => [path.resolve(link), path.resolve(target)]))
	const realpath = (candidate: string): string => {
		let resolved = path.resolve(candidate)
		for (;;) {
			let matched: [string, string] | undefined
			for (const [link, target] of linkMap) {
				const applies = resolved === link || resolved.startsWith(link + path.sep)
				if (applies && (matched === undefined || link.length > matched[0].length)) matched = [link, target]
			}
			if (matched === undefined) return resolved
			resolved = path.join(matched[1], path.relative(matched[0], resolved))
		}
	}
	return { exists: (candidate) => existingSet.has(realpath(candidate)), realpath }
}

describe('isOrchestrationPath', () => {
	test('matches the top-level bookkeeping directory and everything under it', () => {
		expect(isOrchestrationPath('.orchestration')).toBe(true)
		expect(isOrchestrationPath('.orchestration/runs/run-19700101-000000/meta.json')).toBe(true)
	})

	test('matches path.separator-normalized forms', () => {
		expect(isOrchestrationPath(`.orchestration${path.sep}runs`)).toBe(true)
	})

	test('leaves everything else alone, including nested projects and lookalike names', () => {
		expect(isOrchestrationPath('')).toBe(false)
		expect(isOrchestrationPath('project/.orchestration')).toBe(false)
		expect(isOrchestrationPath('project/.orchestration/meta.json')).toBe(false)
		expect(isOrchestrationPath('.orchestration-notes/x')).toBe(false)
		expect(isOrchestrationPath('orchestration')).toBe(false)
		expect(isOrchestrationPath('src/main.ts')).toBe(false)
	})
})

describe('resolveWithinWorkspace', () => {
	test('resolves an ordinary relative path inside the workspace', () => {
		const filesystem = makeFilesystem([ROOT, `${ROOT}/hello.txt`])
		const resolution = resolveWithinWorkspace('hello.txt', ROOT, filesystem)
		expect(resolution).toEqual({ ok: true, path: { absolute: `${ROOT}/hello.txt`, relative: 'hello.txt' } })
	})

	test('resolves a not-yet-existing nested path inside the workspace', () => {
		const filesystem = makeFilesystem([ROOT])
		const resolution = resolveWithinWorkspace('nested/deep/file.txt', ROOT, filesystem)
		expect(resolution).toEqual({ ok: true, path: { absolute: `${ROOT}/nested/deep/file.txt`, relative: path.join('nested', 'deep', 'file.txt') } })
	})

	test('rejects a .. escape', () => {
		const filesystem = makeFilesystem([ROOT])
		const resolution = resolveWithinWorkspace('../escape.txt', ROOT, filesystem)
		expect(resolution).toEqual({ ok: false, error: { kind: 'invalid_arguments', message: 'Path escapes the workspace: ../escape.txt' } })
	})

	test('rejects an absolute path outside the workspace', () => {
		const filesystem = makeFilesystem([ROOT, '/outside', '/outside/secret.txt'])
		const resolution = resolveWithinWorkspace('/outside/secret.txt', ROOT, filesystem)
		expect(resolution.ok).toBe(false)
	})

	test('refuses the executor bookkeeping directory with permission_denied, whether or not it exists yet', () => {
		const filesystem = makeFilesystem([ROOT])
		const absent = resolveWithinWorkspace('.orchestration/runs/x/meta.json', ROOT, filesystem)
		expect(absent).toEqual({ ok: false, error: { kind: 'permission_denied', message: '.orchestration/runs/x/meta.json is inside .orchestration, the executor\'s bookkeeping directory, which cannot be accessed or modified' } })
		const filesystemWithBookkeeping = makeFilesystem([ROOT, `${ROOT}/.orchestration`, `${ROOT}/.orchestration/settings.json`])
		const existing = resolveWithinWorkspace('.orchestration/settings.json', ROOT, filesystemWithBookkeeping)
		expect(existing).toEqual({ ok: false, error: { kind: 'permission_denied', message: '.orchestration/settings.json is inside .orchestration, the executor\'s bookkeeping directory, which cannot be accessed or modified' } })
	})

	test('refuses an existing symlink that resolves into the executor bookkeeping directory', () => {
		const filesystem = makeFilesystem(
			[ROOT, `${ROOT}/.orchestration`, `${ROOT}/.orchestration/runs`, `${ROOT}/.orchestration/runs/x`, `${ROOT}/.orchestration/runs/x/meta.json`],
			{ [`${ROOT}/peek.json`]: `${ROOT}/.orchestration/runs/x/meta.json` },
		)
		const resolution = resolveWithinWorkspace('peek.json', ROOT, filesystem)
		expect(resolution.ok).toBe(false)
		expect(resolution.ok ? null : resolution.error.kind).toBe('permission_denied')
	})

	test('allows the executor bookkeeping directory nested inside a project, which is project content', () => {
		const filesystem = makeFilesystem([ROOT, `${ROOT}/project`, `${ROOT}/project/.orchestration`, `${ROOT}/project/.orchestration/settings.json`])
		const resolution = resolveWithinWorkspace('project/.orchestration/settings.json', ROOT, filesystem)
		expect(resolution).toEqual({ ok: true, path: { absolute: `${ROOT}/project/.orchestration/settings.json`, relative: 'project/.orchestration/settings.json' } })
	})

	test('rejects an existing symlink that points outside the workspace', () => {
		const filesystem = makeFilesystem([ROOT, '/outside', '/outside/secret.txt'], { [`${ROOT}/link.txt`]: '/outside/secret.txt' })
		const resolution = resolveWithinWorkspace('link.txt', ROOT, filesystem)
		expect(resolution.ok).toBe(false)
	})

	test('rejects a new file under a symlinked directory that points outside the workspace', () => {
		const filesystem = makeFilesystem([ROOT, '/outside'], { [`${ROOT}/linked-dir`]: '/outside' })
		const resolution = resolveWithinWorkspace(path.join('linked-dir', 'new-file.txt'), ROOT, filesystem)
		expect(resolution.ok).toBe(false)
	})

	test('allows a symlink that stays inside the workspace', () => {
		const filesystem = makeFilesystem([ROOT, `${ROOT}/real-dir`, `${ROOT}/real-dir/file.txt`], { [`${ROOT}/alias-dir`]: `${ROOT}/real-dir` })
		const resolution = resolveWithinWorkspace(path.join('alias-dir', 'file.txt'), ROOT, filesystem)
		expect(resolution).toEqual({ ok: true, path: { absolute: `${ROOT}/real-dir/file.txt`, relative: path.join('real-dir', 'file.txt') } })
	})

	test('resolves legitimate files when the workspace root is reached through a symlink', () => {
		const filesystem = makeFilesystem([ROOT, `${ROOT}/hello.txt`], { '/alias': ROOT })
		const resolution = resolveWithinWorkspace('hello.txt', '/alias', filesystem)
		expect(resolution).toEqual({ ok: true, path: { absolute: `${ROOT}/hello.txt`, relative: 'hello.txt' } })
	})
})

describe('wrapIoError', () => {
	test('uses the error message when given an Error', () => {
		expect(wrapIoError(new Error('ENOENT: no such file'), 'fallback')).toEqual({ kind: 'invalid_arguments', message: 'ENOENT: no such file' })
	})

	test('uses the fallback message when given a non-Error', () => {
		expect(wrapIoError('string failure', 'Cannot read file: x.txt')).toEqual({ kind: 'invalid_arguments', message: 'Cannot read file: x.txt' })
	})
})
