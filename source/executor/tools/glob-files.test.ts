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

async function runGlob(files: string[], pattern: string, exclude?: string[]): Promise<ToolResult> {
	return await createGlobFiles(ROOT, makeFilesystem(files))({ pattern, exclude })
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

describe('createGlobFiles and the executor bookkeeping directory', () => {
	test('the walk never descends into the top-level .orchestration', async () => {
		expect(await runGlob(['.orchestration/runs/x/log.jsonl', '.orchestration/settings.json', 'src/a.ts'], '**')).toEqual({ kind: 'success', data: ['src/a.ts'] })
	})

	test('an .orchestration directory nested inside a project is ordinary project content and stays walkable', async () => {
		expect(await runGlob(['project/.orchestration/notes.txt', 'project/a.ts'], '**')).toEqual({ kind: 'success', data: ['project/.orchestration/notes.txt', 'project/a.ts'] })
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

describe('createGlobFiles exclude segment matchers', () => {
	test('a segment matcher without / excludes matching files at every depth', async () => {
		expect(await runGlob(['node_modules/x.ts', 'a/node_modules/b/y.ts', 'src/z.ts'], '**', ['node_modules'])).toEqual({ kind: 'success', data: ['src/z.ts'] })
	})

	test('a segment matcher is case-sensitive, so a differently cased directory name survives', async () => {
		expect(await runGlob(['node_modules/x.ts', 'Node_Modules/y.ts'], '**', ['node_modules'])).toEqual({ kind: 'success', data: ['Node_Modules/y.ts'] })
	})

	test('a segment matcher excludes any file whose own name matches at any depth', async () => {
		expect(await runGlob(['a.test.ts', 'src/b.test.ts', 'src/c.ts', 'src/deep/d.test.ts'], '**', ['*.test.ts'])).toEqual({ kind: 'success', data: ['src/c.ts'] })
	})

	test('an exclude with ** on both sides removes the folder at every depth', async () => {
		expect(await runGlob(['node_modules/x.ts', 'a/node_modules/b/y.ts', 'z.ts'], '**', ['**/node_modules/**'])).toEqual({ kind: 'success', data: ['z.ts'] })
	})

	test('a segment matcher prunes the walk so an excluded directory is never listed', async () => {
		const base = makeFilesystem(['node_modules/x.ts', 'src/a.ts'])
		const listed: string[] = []
		const filesystem: GlobFilesystem = {
			listEntries: (directory) => {
				listed.push(directory)
				return base.listEntries(directory)
			},
		}
		const handler = createGlobFiles(ROOT, filesystem)
		expect(await handler({ pattern: '**', exclude: ['node_modules'] })).toEqual({ kind: 'success', data: ['src/a.ts'] })
		expect(listed.some((directory) => directory.includes('node_modules'))).toBe(false)
	})

	test('a segment matcher prunes nested directories at any depth', async () => {
		expect(await runGlob(['a/node_modules/b/y.ts', 'a/keep.ts', 'node_modules/x.ts'], '**/*.ts', ['node_modules'])).toEqual({ kind: 'success', data: ['a/keep.ts'] })
	})
})

describe('createGlobFiles exclude path matchers', () => {
	test('a path matcher with / excludes the whole workspace-relative path', async () => {
		expect(await runGlob(['src/fixtures/a.ts', 'src/a.ts', 'fixtures/b.ts'], '**', ['src/fixtures/**'])).toEqual({ kind: 'success', data: ['fixtures/b.ts', 'src/a.ts'] })
	})

	test('a path matcher with ** spans zero or more segments in excludes', async () => {
		expect(await runGlob(['README.md', 'docs/x.md', 'src/a.ts'], '**', ['**/*.md'])).toEqual({ kind: 'success', data: ['src/a.ts'] })
	})

	test('a path matcher filters results only and still lists inside matching directories', async () => {
		const base = makeFilesystem(['src/fixtures/a.ts', 'src/a.ts'])
		const listed: string[] = []
		const filesystem: GlobFilesystem = {
			listEntries: (directory) => {
				listed.push(directory)
				return base.listEntries(directory)
			},
		}
		const handler = createGlobFiles(ROOT, filesystem)
		expect(await handler({ pattern: '**', exclude: ['src/fixtures/**'] })).toEqual({ kind: 'success', data: ['src/a.ts'] })
		expect(listed.some((directory) => directory.startsWith(`${ROOT}/src/fixtures`))).toBe(true)
	})

	test('a trailing ** in a path matcher never matches the directory itself', async () => {
		expect(await runGlob(['src/a.ts', 'src.txt'], '**', ['src/**'])).toEqual({ kind: 'success', data: ['src.txt'] })
	})
})

describe('createGlobFiles exclude validation and combination', () => {
	test('an absent exclude behaves like no exclusions', async () => {
		expect(await runGlob(['a.ts', 'src/b.ts'], '**/*.ts')).toEqual({ kind: 'success', data: ['a.ts', 'src/b.ts'] })
	})

	test('an empty exclude array behaves like no exclusions', async () => {
		expect(await runGlob(['a.ts', 'src/b.ts'], '**/*.ts', [])).toEqual({ kind: 'success', data: ['a.ts', 'src/b.ts'] })
	})

	test('exclude combines with the include pattern', async () => {
		expect(await runGlob(['src/a.ts', 'src/a.test.ts', 'docs/readme.md'], '**/*.ts', ['*.test.ts'])).toEqual({ kind: 'success', data: ['src/a.ts'] })
	})

	test('rejects a non-array exclude', async () => {
		const handler = createGlobFiles(ROOT, makeFilesystem(['a.ts']))
		expect(await handler({ pattern: '**', exclude: 'node_modules' })).toEqual({ kind: 'invalid_arguments', message: 'exclude must be an array of non-empty strings' })
	})

	test('rejects a non-string element in exclude', async () => {
		const handler = createGlobFiles(ROOT, makeFilesystem(['a.ts']))
		expect(await handler({ pattern: '**', exclude: ['node_modules', 42] })).toEqual({ kind: 'invalid_arguments', message: 'exclude must be an array of non-empty strings' })
	})

	test('rejects an empty string element in exclude', async () => {
		const handler = createGlobFiles(ROOT, makeFilesystem(['a.ts']))
		expect(await handler({ pattern: '**', exclude: [''] })).toEqual({ kind: 'invalid_arguments', message: 'exclude must be an array of non-empty strings' })
	})

	test('reports an invalid exclude glob as a tool error', async () => {
		const handler = createGlobFiles(ROOT, makeFilesystem(['a.ts']))
		const result = await handler({ pattern: '**', exclude: ['[z-a]'] })
		expect(result.kind).toBe('invalid_arguments')
		if (result.kind === 'invalid_arguments') {
			expect(result.message).toMatch(/^Invalid exclude pattern/)
		}
	})
})
