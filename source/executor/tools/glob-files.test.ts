import { describe, expect, test } from 'bun:test'
import { createGlobFiles, type GlobFilesystem, type WalkEntry } from './glob-files.ts'
import type { ToolResult } from '../types.ts'

const ROOT = '/fixture'

interface ScriptedDirectory {
	directories: Map<string, ScriptedDirectory>
	files: string[]
}

// A scripted filesystem built from workspace-relative file paths: every listed path is a file and its parent chain is synthesized as directories, and lookups fail fast on any path the walk could not have derived by joining under the root.
function makeFilesystem(files: string[]): GlobFilesystem {
	const root: ScriptedDirectory = { directories: new Map(), files: [] }
	for (const file of files) {
		const segments = file.split('/')
		const name = segments[segments.length - 1] ?? ''
		let directory = root
		for (const segment of segments.slice(0, -1)) {
			const child = directory.directories.get(segment)
			if (child !== undefined) {
				directory = child
				continue
			}
			const created: ScriptedDirectory = { directories: new Map(), files: [] }
			directory.directories.set(segment, created)
			directory = created
		}
		directory.files.push(name)
	}
	const directoryAt = (candidate: string): ScriptedDirectory => {
		if (candidate === ROOT) return root
		if (!candidate.startsWith(`${ROOT}/`)) throw new Error(`Unexpected lookup outside the scripted root: ${candidate}`)
		let directory = root
		for (const segment of candidate.slice(ROOT.length + 1).split('/')) {
			const child = directory.directories.get(segment)
			if (child === undefined) throw new Error(`Unexpected lookup of an unscripted directory: ${candidate}`)
			directory = child
		}
		return directory
	}
	return {
		listEntries: (directory) => {
			const scripted = directoryAt(directory)
			const entries: WalkEntry[] = []
			for (const name of scripted.directories.keys()) entries.push({ name, isDirectory: () => true, isFile: () => false })
			for (const name of scripted.files) entries.push({ name, isDirectory: () => false, isFile: () => true })
			return entries
		},
	}
}

async function runGlob(files: string[], pattern: string): Promise<ToolResult> {
	return await createGlobFiles(ROOT, makeFilesystem(files))({ pattern })
}

describe('createGlobFiles ** semantics', () => {
	test('a leading **/ matches zero segments, so root-level files are included', async () => {
		expect(await runGlob(['a.ts', 'src/a.ts', 'b.js'], '**/*.ts')).toEqual({ kind: 'success', data: ['a.ts', 'src/a.ts'] })
	})

	test('a middle **/ matches zero segments, so direct children are included', async () => {
		expect(await runGlob(['src/x.ts', 'src/a/x.ts', 'x.ts'], 'src/**/*.ts')).toEqual({ kind: 'success', data: ['src/a/x.ts', 'src/x.ts'] })
	})

	test('leading and trailing ** combine to match any depth on both sides', async () => {
		expect(await runGlob(['node_modules/x.ts', 'a/node_modules/b/x.ts', 'x.ts'], '**/node_modules/**')).toEqual({ kind: 'success', data: ['a/node_modules/b/x.ts', 'node_modules/x.ts'] })
	})

	test('a middle **/ in front of a bare literal matches zero or more segments', async () => {
		expect(await runGlob(['a/b', 'a/x/b', 'a/x/y/b', 'b'], 'a/**/b')).toEqual({ kind: 'success', data: ['a/b', 'a/x/b', 'a/x/y/b'] })
	})

	test('a trailing ** matches files below the directory at any depth, never the directory itself', async () => {
		expect(await runGlob(['src/x.ts', 'src/a/x.ts', 'src.txt'], 'src/**')).toEqual({ kind: 'success', data: ['src/a/x.ts', 'src/x.ts'] })
	})

	test('multiple ** segments each span zero or more segments independently', async () => {
		expect(await runGlob(['a/b/c.ts', 'a/x/b/y/c.ts', 'a/c.ts', 'a/b'], 'a/**/b/**/c.ts')).toEqual({ kind: 'success', data: ['a/b/c.ts', 'a/x/b/y/c.ts'] })
	})

	test('a **/ at the start reaches files nested to full depth', async () => {
		expect(await runGlob(['src/a/b/c/d/e.ts', 'src/a/b/f.ts'], '**/e.ts')).toEqual({ kind: 'success', data: ['src/a/b/c/d/e.ts'] })
	})

	test('a bare ** as the whole pattern matches every walked file at any depth', async () => {
		expect(await runGlob(['a.ts', 'a/b.ts', 'src/deep/c.js'], '**')).toEqual({ kind: 'success', data: ['a.ts', 'a/b.ts', 'src/deep/c.js'] })
	})

	// Pinned as-is: a `**` that is not a whole segment keeps the historical `.*`, which crosses separators.
	test('a ** inside a segment keeps the historical .* that crosses separators', async () => {
		expect(await runGlob(['ab', 'axb', 'a/b', 'a/x/b', 'abc'], 'a**b')).toEqual({ kind: 'success', data: ['a/b', 'a/x/b', 'ab', 'axb'] })
	})
})

describe('createGlobFiles without **', () => {
	test('a single * stays inside one segment and stops at directory boundaries', async () => {
		expect(await runGlob(['a.ts', 'b.js', 'src/a.ts', 'src/deep/b.ts'], '*.ts')).toEqual({ kind: 'success', data: ['a.ts'] })
		expect(await runGlob(['a.ts', 'b.js', 'src/a.ts', 'src/deep/b.ts'], 'src/*.ts')).toEqual({ kind: 'success', data: ['src/a.ts'] })
	})

	test('? matches exactly one non-separator character', async () => {
		expect(await runGlob(['a.ts', 'ab.ts'], '?.ts')).toEqual({ kind: 'success', data: ['a.ts'] })
	})

	test('a character class passes through to the regex engine', async () => {
		expect(await runGlob(['a1.ts', 'ab.ts'], 'a[0-9].ts')).toEqual({ kind: 'success', data: ['a1.ts'] })
	})

	test('brace alternation matches one of the listed alternatives in a single segment', async () => {
		expect(await runGlob(['src/a.ts', 'docs/a.ts', 'web/a.ts'], '{src,docs}/a.ts')).toEqual({ kind: 'success', data: ['docs/a.ts', 'src/a.ts'] })
	})

	test('a literal pattern without wildcards matches only that exact path', async () => {
		expect(await runGlob(['a.ts', 'src/a.ts'], 'a.ts')).toEqual({ kind: 'success', data: ['a.ts'] })
	})

	test('matches come back sorted alphabetically', async () => {
		expect(await runGlob(['z.ts', 'a.ts', 'm.ts'], '*.ts')).toEqual({ kind: 'success', data: ['a.ts', 'm.ts', 'z.ts'] })
	})
})

describe('createGlobFiles pinned edge cases', () => {
	test('regex metacharacters in a pattern match literally', async () => {
		expect(await runGlob(['a(1).txt', 'a1.txt', 'ab.txt'], 'a(1).txt')).toEqual({ kind: 'success', data: ['a(1).txt'] })
	})

	test('a dot between literals does not act as a wildcard', async () => {
		expect(await runGlob(['a.b', 'axb'], 'a.b')).toEqual({ kind: 'success', data: ['a.b'] })
	})

	// Pinned as-is: matching is purely lexical with no shell-style dotfile exclusion, so `*` also matches a leading dot.
	test('a single * also matches a leading dot', async () => {
		expect(await runGlob(['.hidden.ts', 'a.ts'], '*.ts')).toEqual({ kind: 'success', data: ['.hidden.ts', 'a.ts'] })
	})
})

describe('createGlobFiles argument validation', () => {
	test('rejects a missing or non-string pattern', async () => {
		const handler = createGlobFiles(ROOT, makeFilesystem(['a.ts']))
		expect(await handler({})).toEqual({ kind: 'invalid_arguments', message: 'pattern must be a non-empty string' })
		expect(await handler({ pattern: 42 })).toEqual({ kind: 'invalid_arguments', message: 'pattern must be a non-empty string' })
	})

	test('rejects an empty pattern', async () => {
		expect(await runGlob(['a.ts'], '')).toEqual({ kind: 'invalid_arguments', message: 'pattern must be a non-empty string' })
	})

	test('reports walk failures as a tool error', async () => {
		const handler = createGlobFiles(ROOT, { listEntries: () => { throw new Error('EACCES: permission denied') } })
		expect(await handler({ pattern: '*.ts' })).toEqual({ kind: 'invalid_arguments', message: 'Cannot glob files: EACCES: permission denied' })
	})
})
