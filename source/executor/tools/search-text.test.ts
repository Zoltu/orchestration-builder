import { describe, expect, test } from 'bun:test'
import type { ToolResult } from '../types.js'
import type { PathFilesystem } from '../workspace-path.js'
import type { FileChunks } from './file-lines.js'
import { createSearchText, type SearchDirectoryEntry, type SearchFilesystem, type SearchMatch, type SearchTextResult } from './search-text.js'

const ROOT = '/workspace'

const SEGMENT_CHARS = 1024 * 1024

interface ScriptedDirectory {
	directories: Map<string, ScriptedDirectory>
	files: Set<string>
}

function makeSearchFilesystem(files: string[]): SearchFilesystem {
	const root: ScriptedDirectory = { directories: new Map(), files: new Set() }
	const directoryPaths = new Set<string>([ROOT])
	const filePaths = new Set<string>()
	for (const file of files) {
		filePaths.add(`${ROOT}/${file}`)
		const segments = file.split('/')
		const name = segments[segments.length - 1]
		if (name === undefined) continue
		let directory = root
		let currentPath = ROOT
		for (const segment of segments.slice(0, -1)) {
			currentPath = `${currentPath}/${segment}`
			directoryPaths.add(currentPath)
			let child = directory.directories.get(segment)
			if (child === undefined) {
				child = { directories: new Map(), files: new Set() }
				directory.directories.set(segment, child)
			}
			directory = child
		}
		directory.files.add(name)
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
		listEntries: (directoryPath) => {
			const directory = directoryAt(directoryPath)
			const entries: SearchDirectoryEntry[] = []
			for (const name of directory.directories.keys()) entries.push({ name, isDirectory: () => true, isFile: () => false })
			for (const name of directory.files) entries.push({ name, isDirectory: () => false, isFile: () => true })
			return entries
		},
		statKind: (candidate) => {
			if (directoryPaths.has(candidate)) return 'directory'
			if (filePaths.has(candidate)) return 'file'
			return 'missing'
		},
	}
}

function scriptedPaths(existing: string[]): PathFilesystem {
	const known = new Set(existing)
	return {
		exists: (candidate) => known.has(candidate),
		realpath: (candidate) => candidate,
	}
}

function fileChunksFrom(sourceFor: (filePath: string) => AsyncIterable<string>): FileChunks {
	return { readChunks: (filePath) => sourceFor(filePath) }
}

function finiteChunkStream(chunks: readonly string[]): AsyncIterable<string> {
	return {
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) yield chunk
		},
	}
}

function cappedLineChunkStream(limit: number, onPull: () => void): AsyncIterable<string> {
	return {
		async *[Symbol.asyncIterator]() {
			for (let index = 0; ; index += 1) {
				if (index >= limit) throw new Error('chunk source pulled past its cap')
				onPull()
				yield `match ${index}\n`
			}
		},
	}
}

function cappedNeedleChunkStream(limit: number, onPull: () => void): AsyncIterable<string> {
	return {
		async *[Symbol.asyncIterator]() {
			for (let index = 0; ; index += 1) {
				if (index >= limit) throw new Error('chunk source pulled past its cap')
				onPull()
				yield 'needle'.repeat(100_000)
			}
		},
	}
}

function chunkedText(text: string, chunkSize: number): string[] {
	const chunks: string[] = []
	for (let offset = 0; offset < text.length; offset += chunkSize) chunks.push(text.slice(offset, offset + chunkSize))
	return chunks
}

function lineWithNeedles(length: number, needles: readonly { offset: number; text: string }[]): string {
	const parts: string[] = []
	let cursor = 0
	for (const needle of needles) {
		parts.push('x'.repeat(needle.offset - cursor))
		parts.push(needle.text)
		cursor = needle.offset + needle.text.length
	}
	parts.push('x'.repeat(length - cursor))
	return parts.join('')
}

function isSearchMatch(value: unknown): value is SearchMatch {
	if (typeof value !== 'object' || value === null) return false
	if (!('path' in value) || typeof value.path !== 'string') return false
	if (!('line' in value) || typeof value.line !== 'number') return false
	if (!('text' in value) || typeof value.text !== 'string') return false
	return true
}

function isSearchTextResult(value: unknown): value is SearchTextResult {
	if (typeof value !== 'object' || value === null) return false
	if (!('matches' in value) || !Array.isArray(value.matches) || !value.matches.every(isSearchMatch)) return false
	if (!('truncated' in value) || typeof value.truncated !== 'boolean') return false
	if (!('truncatedReason' in value)) return false
	const reason = value.truncatedReason
	return reason === null || reason === 'per-file' || reason === 'total'
}

function searchResult(result: ToolResult): SearchTextResult {
	if (result.kind !== 'success') throw new Error(`expected success, got ${result.kind}`)
	if (!isSearchTextResult(result.data)) throw new Error('expected a search text result')
	return result.data
}

function searchMatches(result: ToolResult): SearchMatch[] {
	return searchResult(result).matches
}

function searchHandler(files: string[], fileChunks: FileChunks, pathFilesystem: PathFilesystem) {
	return createSearchText(ROOT, { fileChunks, filesystem: makeSearchFilesystem(files), pathFilesystem })
}

describe('createSearchText streaming', () => {
	test('caps matches per file and stops pulling the chunk source at the cap', async () => {
		let pulls = 0
		const handler = searchHandler(['large.txt'], fileChunksFrom(() => cappedLineChunkStream(100, () => { pulls += 1 })), scriptedPaths([ROOT]))
		const result = searchResult(await handler({ pattern: 'match' }))
		expect(result.matches).toHaveLength(100)
		expect(result.matches[99]?.line).toBe(100)
		expect(result.truncated).toBe(true)
		expect(result.truncatedReason).toBe('per-file')
		expect(pulls).toBe(100)
	})

	test('caps total matches, reports total truncation, and never opens files after the cap is reached', async () => {
		const files = Array.from({ length: 15 }, (_, index) => `file-${index}.txt`)
		const opened: string[] = []
		const handler = searchHandler(files, fileChunksFrom((filePath) => {
			opened.push(filePath)
			return cappedLineChunkStream(100, () => {})
		}), scriptedPaths([ROOT]))
		const result = searchResult(await handler({ pattern: 'match' }))
		expect(result.matches).toHaveLength(1000)
		expect(result.matches[999]?.line).toBe(100)
		expect(result.truncated).toBe(true)
		expect(result.truncatedReason).toBe('total')
		expect(opened).toHaveLength(10)
	})

	test('returns bounded context containing a match on a normal line over the text cap', async () => {
		const longLine = `${'x'.repeat(5000)}needle`
		const matches = searchMatches(await searchHandler(['a.txt'], fileChunksFrom(() => finiteChunkStream([longLine])), scriptedPaths([ROOT]))({ pattern: 'needle' }))
		expect(matches).toHaveLength(1)
		const text = matches[0]?.text
		if (text === undefined) throw new Error('expected match text')
		expect(text).toContain('needle')
		expect(text.startsWith('…')).toBe(true)
		expect(text.length).toBeLessThanOrEqual(2001)
	})

	test('finds a match past the old one-megabyte line boundary in a no-newline file', async () => {
		const line = `${'x'.repeat(SEGMENT_CHARS + 100)}needle`
		const matches = searchMatches(await searchHandler(['generated.json'], fileChunksFrom(() => finiteChunkStream([line])), scriptedPaths([ROOT]))({ pattern: 'needle' }))
		expect(matches).toHaveLength(1)
		expect(matches[0]?.line).toBe(1)
		expect(matches[0]?.text).toContain('needle')
		expect(matches[0]?.text.startsWith('…')).toBe(true)
		expect(matches[0]?.text.length).toBeLessThanOrEqual(2001)
	})

	test('reports multiple long-line matches once each with line 1 and bounded context', async () => {
		const line = lineWithNeedles(SEGMENT_CHARS + 20_000, [
			{ offset: 100, text: 'firstneedle' },
			{ offset: SEGMENT_CHARS - 1000, text: 'overlapneedle' },
			{ offset: SEGMENT_CHARS + 5000, text: 'afterneedle' },
		])
		const matches = searchMatches(await searchHandler(['generated.json'], fileChunksFrom(() => finiteChunkStream([line])), scriptedPaths([ROOT]))({ pattern: 'needle' }))
		expect(matches).toHaveLength(3)
		expect(matches.every((match) => match.line === 1)).toBe(true)
		expect(matches.every((match) => match.text.length <= 2001)).toBe(true)
		const combined = matches.map((match) => match.text).join('\n')
		expect(combined.split('firstneedle')).toHaveLength(2)
		expect(combined.split('overlapneedle')).toHaveLength(2)
		expect(combined.split('afterneedle')).toHaveLength(2)
	})

	test('finds matches across multiple flushes in a very long no-newline file', async () => {
		const line = lineWithNeedles(SEGMENT_CHARS * 3, [
			{ offset: SEGMENT_CHARS + SEGMENT_CHARS / 2, text: 'midneedle' },
			{ offset: SEGMENT_CHARS * 2 + SEGMENT_CHARS / 2, text: 'lateneedle' },
		])
		const chunks = chunkedText(line, 300_000)
		const matches = searchMatches(await searchHandler(['generated.json'], fileChunksFrom(() => finiteChunkStream(chunks)), scriptedPaths([ROOT]))({ pattern: 'needle' }))
		expect(matches).toHaveLength(2)
		expect(matches.every((match) => match.line === 1)).toBe(true)
		const combined = matches.map((match) => match.text).join('\n')
		expect(combined).toContain('midneedle')
		expect(combined).toContain('lateneedle')
	})

	test('stops pulling long-line chunks at the per-file match cap', async () => {
		let pulls = 0
		const handler = searchHandler(['generated.json'], fileChunksFrom(() => cappedNeedleChunkStream(3, () => { pulls += 1 })), scriptedPaths([ROOT]))
		const result = searchResult(await handler({ pattern: 'needle' }))
		expect(result.matches).toHaveLength(100)
		expect(result.matches.every((match) => match.line === 1)).toBe(true)
		expect(result.truncatedReason).toBe('per-file')
		expect(pulls).toBe(2)
	})

	test('finds a match spanning a segment boundary', async () => {
		const needle = `span${'z'.repeat(196)}`
		const line = lineWithNeedles(SEGMENT_CHARS + 5000, [{ offset: SEGMENT_CHARS - 100, text: needle }])
		const matches = searchMatches(await searchHandler(['generated.json'], fileChunksFrom(() => finiteChunkStream([line])), scriptedPaths([ROOT]))({ pattern: needle }))
		expect(matches).toHaveLength(1)
		expect(matches[0]?.line).toBe(1)
		expect(matches[0]?.text).toContain(needle)
	})

	test('does not report zero-length anchors at segment boundaries', async () => {
		const line = 'x'.repeat(SEGMENT_CHARS + 5000)
		const handler = searchHandler(['generated.json'], fileChunksFrom(() => finiteChunkStream([line])), scriptedPaths([ROOT]))
		const startMatches = searchMatches(await handler({ pattern: '^' }))
		expect(startMatches).toHaveLength(1)
		expect(startMatches[0]?.line).toBe(1)
		const endMatches = searchMatches(await handler({ pattern: '$' }))
		expect(endMatches).toHaveLength(1)
		expect(endMatches[0]?.line).toBe(1)
	})

	test('keeps full line text and correct line numbers for normal multi-line files', async () => {
		const handler = searchHandler(['a.txt'], fileChunksFrom(() => finiteChunkStream(['first line\nsec', 'ond line\nthird line'])), scriptedPaths([ROOT]))
		const result = searchResult(await handler({ pattern: 'line' }))
		expect(result.matches).toEqual([
			{ path: 'a.txt', line: 1, text: 'first line' },
			{ path: 'a.txt', line: 2, text: 'second line' },
			{ path: 'a.txt', line: 3, text: 'third line' },
		])
		expect(result.truncated).toBe(false)
		expect(result.truncatedReason).toBeNull()
	})
})

describe('createSearchText file selection', () => {
	test('searches every regular file regardless of extension, including dotfiles and Dockerfile', async () => {
		const files = ['a.mts', 'b.cts', 'Makefile', 'extensionless', '.env', 'Dockerfile', 'plain.txt']
		const opened: string[] = []
		const handler = searchHandler(files, fileChunksFrom((filePath) => {
			opened.push(filePath)
			return finiteChunkStream(['needle'])
		}), scriptedPaths([ROOT]))
		searchMatches(await handler({ pattern: 'needle' }))
		expect(opened.sort()).toEqual(files.map((file) => `${ROOT}/${file}`).sort())
	})

	test('searches .github because it is not a default excluded directory', async () => {
		const files = ['.github/workflows/ci.yml', '.git/config', 'src/keep.ts']
		const opened: string[] = []
		const handler = searchHandler(files, fileChunksFrom((filePath) => {
			opened.push(filePath)
			return finiteChunkStream(['match'])
		}), scriptedPaths([ROOT]))
		const matches = searchMatches(await handler({ pattern: 'match' }))
		expect(opened.sort()).toEqual([`${ROOT}/.github/workflows/ci.yml`, `${ROOT}/src/keep.ts`])
		expect(matches.map((match) => match.path).sort()).toEqual(['.github/workflows/ci.yml', 'src/keep.ts'])
	})

	test('prunes the default excluded directories at every depth', async () => {
		const files = [
			'src/keep.ts',
			'.git/config',
			'node_modules/pkg/index.js',
			'vendor/lib.js',
			'dist/bundle.js',
			'build/out.js',
			'out/x.js',
			'coverage/x.js',
			'src/node_modules/nested.js',
			'src/.orchestration/nested.txt',
		]
		const opened: string[] = []
		const handler = searchHandler(files, fileChunksFrom((filePath) => {
			opened.push(filePath)
			return finiteChunkStream(['match'])
		}), scriptedPaths([ROOT]))
		const matches = searchMatches(await handler({ pattern: 'match' }))
		expect(opened).toEqual([`${ROOT}/src/keep.ts`])
		expect(matches).toEqual([{ path: 'src/keep.ts', line: 1, text: 'match' }])
	})

	test('an explicitly named excluded directory root is searched while its descendants still prune default names', async () => {
		const files = ['node_modules/keep.js', 'node_modules/pkg/index.js', 'node_modules/vendor/skip.js']
		const opened: string[] = []
		const handler = searchHandler(files, fileChunksFrom((filePath) => {
			opened.push(filePath)
			return finiteChunkStream(['match'])
		}), scriptedPaths([ROOT, `${ROOT}/node_modules`]))
		const matches = searchMatches(await handler({ pattern: 'match', paths: ['node_modules'] }))
		expect(opened.sort()).toEqual([`${ROOT}/node_modules/keep.js`, `${ROOT}/node_modules/pkg/index.js`])
		expect(matches.map((match) => match.path).sort()).toEqual(['node_modules/keep.js', 'node_modules/pkg/index.js'])
	})

	test('include with no slash matches the basename at any depth', async () => {
		const files = ['root.mts', 'src/nested.mts', 'src/skip.ts', 'src/nested.cts']
		const opened: string[] = []
		const handler = searchHandler(files, fileChunksFrom((filePath) => {
			opened.push(filePath)
			return finiteChunkStream(['needle'])
		}), scriptedPaths([ROOT]))
		const matches = searchMatches(await handler({ pattern: 'needle', include: ['*.mts'] }))
		expect(opened.sort()).toEqual([`${ROOT}/root.mts`, `${ROOT}/src/nested.mts`])
		expect(matches.map((match) => match.path).sort()).toEqual(['root.mts', 'src/nested.mts'])
	})

	test('include with a slash matches the full workspace-relative path', async () => {
		const files = ['root.mts', 'src/a.mts', 'src/deep/b.mts', 'docs/c.mts']
		const opened: string[] = []
		const handler = searchHandler(files, fileChunksFrom((filePath) => {
			opened.push(filePath)
			return finiteChunkStream(['needle'])
		}), scriptedPaths([ROOT]))
		searchMatches(await handler({ pattern: 'needle', include: ['src/**/*.mts'] }))
		expect(opened.sort()).toEqual([`${ROOT}/src/a.mts`, `${ROOT}/src/deep/b.mts`])
	})

	test('an empty include array matches no files', async () => {
		const opened: string[] = []
		const handler = searchHandler(['a.mts'], fileChunksFrom((filePath) => {
			opened.push(filePath)
			return finiteChunkStream(['needle'])
		}), scriptedPaths([ROOT]))
		expect(searchMatches(await handler({ pattern: 'needle', include: [] }))).toEqual([])
		expect(opened).toEqual([])
	})

	test('exclude with no slash matches any path segment and prunes matching directories', async () => {
		const base = makeSearchFilesystem(['generated/x.ts', 'a/generated/b/y.ts', 'src/z.ts'])
		const listed: string[] = []
		const filesystem: SearchFilesystem = {
			listEntries: (directory) => {
				listed.push(directory)
				return base.listEntries(directory)
			},
			statKind: (candidate) => base.statKind(candidate),
		}
		const opened: string[] = []
		const handler = createSearchText(ROOT, {
			fileChunks: fileChunksFrom((filePath) => {
				opened.push(filePath)
				return finiteChunkStream(['match'])
			}),
			filesystem,
			pathFilesystem: scriptedPaths([ROOT]),
		})
		const matches = searchMatches(await handler({ pattern: 'match', exclude: ['generated'] }))
		expect(opened).toEqual([`${ROOT}/src/z.ts`])
		expect(matches).toEqual([{ path: 'src/z.ts', line: 1, text: 'match' }])
		expect(listed.some((directory) => directory.includes('generated'))).toBe(false)
	})

	test('exclude with a slash matches the full workspace-relative path', async () => {
		const files = ['src/fixtures/a.ts', 'src/a.ts', 'fixtures/b.ts']
		const opened: string[] = []
		const handler = searchHandler(files, fileChunksFrom((filePath) => {
			opened.push(filePath)
			return finiteChunkStream(['match'])
		}), scriptedPaths([ROOT]))
		searchMatches(await handler({ pattern: 'match', exclude: ['src/fixtures/**'] }))
		expect(opened.sort()).toEqual([`${ROOT}/fixtures/b.ts`, `${ROOT}/src/a.ts`])
	})

	test('explicitly named files still honor include and exclude filters', async () => {
		const opened: string[] = []
		const handler = searchHandler(['a.mts', 'b.ts'], fileChunksFrom((filePath) => {
			opened.push(filePath)
			return finiteChunkStream(['needle'])
		}), scriptedPaths([ROOT, `${ROOT}/a.mts`, `${ROOT}/b.ts`]))
		expect(searchMatches(await handler({ pattern: 'needle', paths: ['a.mts'], include: ['*.ts'] }))).toEqual([])
		expect(opened).toEqual([])
		expect(searchMatches(await handler({ pattern: 'needle', paths: ['b.ts'], exclude: ['b.ts'] }))).toEqual([])
		expect(opened).toEqual([])
	})

	test('searches an explicitly named file with a non-code extension', async () => {
		const handler = searchHandler(['data.bin'], fileChunksFrom(() => finiteChunkStream(['needle'])), scriptedPaths([ROOT, `${ROOT}/data.bin`]))
		const matches = searchMatches(await handler({ pattern: 'needle', paths: ['data.bin'] }))
		expect(matches).toEqual([{ path: 'data.bin', line: 1, text: 'needle' }])
	})

	test('searches an explicitly named extensionless file', async () => {
		const handler = searchHandler(['data'], fileChunksFrom(() => finiteChunkStream(['needle'])), scriptedPaths([ROOT, `${ROOT}/data`]))
		const matches = searchMatches(await handler({ pattern: 'needle', paths: ['data'] }))
		expect(matches).toEqual([{ path: 'data', line: 1, text: 'needle' }])
	})

	test('walks an explicitly named directory without an extension filter', async () => {
		const opened: string[] = []
		const handler = searchHandler(['dir/a.bin', 'dir/b.txt'], fileChunksFrom((filePath) => {
			opened.push(filePath)
			return finiteChunkStream(['match'])
		}), scriptedPaths([ROOT, `${ROOT}/dir`]))
		const matches = searchMatches(await handler({ pattern: 'match', paths: ['dir'] }))
		expect(opened.sort()).toEqual([`${ROOT}/dir/a.bin`, `${ROOT}/dir/b.txt`])
		expect(matches.map((match) => match.path).sort()).toEqual(['dir/a.bin', 'dir/b.txt'])
	})

	test('skips file and directory symlinks during a walk', async () => {
		const base = makeSearchFilesystem(['real.txt'])
		const filesystem: SearchFilesystem = {
			listEntries: (directory) => {
				const entries = base.listEntries(directory)
				if (directory !== ROOT) return entries
				entries.push({ name: 'linked-file.txt', isDirectory: () => false, isFile: () => false })
				entries.push({ name: 'linked-directory', isDirectory: () => false, isFile: () => false })
				return entries
			},
			statKind: (candidate) => base.statKind(candidate),
		}
		const opened: string[] = []
		const handler = createSearchText(ROOT, {
			fileChunks: fileChunksFrom((filePath) => {
				opened.push(filePath)
				return finiteChunkStream(['needle'])
			}),
			filesystem,
			pathFilesystem: scriptedPaths([ROOT]),
		})
		const matches = searchMatches(await handler({ pattern: 'needle' }))
		expect(opened).toEqual([`${ROOT}/real.txt`])
		expect(matches).toEqual([{ path: 'real.txt', line: 1, text: 'needle' }])
	})
})

describe('createSearchText binary detection', () => {
	test('skips a binary file during a walk', async () => {
		const handler = searchHandler(['text.txt', 'binary.txt'], fileChunksFrom((filePath) => finiteChunkStream(filePath.endsWith('binary.txt') ? ['match\u0000'] : ['match'])), scriptedPaths([ROOT]))
		const matches = searchMatches(await handler({ pattern: 'match' }))
		expect(matches).toEqual([{ path: 'text.txt', line: 1, text: 'match' }])
	})

	test('rejects an explicitly named binary file with a text-like extension', async () => {
		const handler = searchHandler(['binary.txt'], fileChunksFrom(() => finiteChunkStream(['match\u0000'])), scriptedPaths([ROOT, `${ROOT}/binary.txt`]))
		const result = await handler({ pattern: 'match', paths: ['binary.txt'] })
		if (result.kind !== 'invalid_arguments') throw new Error(`expected invalid_arguments, got ${result.kind}`)
		expect(result.message).toContain('binary')
		expect(result.message).toContain('not designed for binary search')
	})

	test('rejects an explicitly named binary file with no extension', async () => {
		const handler = searchHandler(['binary'], fileChunksFrom(() => finiteChunkStream(['match\u0000'])), scriptedPaths([ROOT, `${ROOT}/binary`]))
		const result = await handler({ pattern: 'match', paths: ['binary'] })
		expect(result.kind).toBe('invalid_arguments')
	})
})

describe('createSearchText argument and path validation', () => {
	test('rejects an invalid regex instead of falling back to a literal search', async () => {
		const handler = searchHandler(['a.txt'], fileChunksFrom(() => finiteChunkStream(['value a( here'])), scriptedPaths([ROOT]))
		const result = await handler({ pattern: 'a(' })
		expect(result.kind).toBe('invalid_arguments')
		if (result.kind === 'invalid_arguments') expect(result.message).toMatch(/^Invalid pattern/)
	})

	test('rejects an empty paths array', async () => {
		const handler = searchHandler(['a.txt'], fileChunksFrom(() => finiteChunkStream(['match'])), scriptedPaths([ROOT]))
		const result = await handler({ pattern: 'match', paths: [] })
		expect(result.kind).toBe('invalid_arguments')
		if (result.kind === 'invalid_arguments') expect(result.message).toContain('non-empty')
	})

	test('rejects an empty-string path element and searches nothing', async () => {
		const opened: string[] = []
		const handler = searchHandler(['a.txt'], fileChunksFrom((filePath) => {
			opened.push(filePath)
			return finiteChunkStream(['match'])
		}), scriptedPaths([ROOT]))
		const result = await handler({ pattern: 'match', paths: [''] })
		expect(result.kind).toBe('invalid_arguments')
		if (result.kind === 'invalid_arguments') expect(result.message).toContain('empty string')
		expect(opened).toEqual([])
	})

	test('pre-validates a missing path and searches nothing', async () => {
		const opened: string[] = []
		const handler = searchHandler(['good.txt'], fileChunksFrom((filePath) => {
			opened.push(filePath)
			return finiteChunkStream(['match'])
		}), scriptedPaths([ROOT, `${ROOT}/good.txt`]))
		const result = await handler({ pattern: 'match', paths: ['good.txt', 'missing.txt'] })
		expect(result.kind).toBe('invalid_arguments')
		if (result.kind === 'invalid_arguments') expect(result.message).toContain('does not exist')
		expect(opened).toEqual([])
	})

	test('pre-validates every path before searching, so an earlier valid path yields no partial matches', async () => {
		const base = makeSearchFilesystem(['bad.txt', 'good.txt'])
		const filesystem: SearchFilesystem = {
			listEntries: (directory) => base.listEntries(directory),
			statKind: (candidate) => {
				if (candidate.endsWith('/bad.txt')) throw new Error('EACCES')
				return base.statKind(candidate)
			},
		}
		const opened: string[] = []
		const handler = createSearchText(ROOT, {
			fileChunks: fileChunksFrom((filePath) => {
				opened.push(filePath)
				return finiteChunkStream(['match'])
			}),
			filesystem,
			pathFilesystem: scriptedPaths([ROOT, `${ROOT}/bad.txt`, `${ROOT}/good.txt`]),
		})
		const result = await handler({ pattern: 'match', paths: ['good.txt', 'bad.txt'] })
		expect(result.kind).toBe('invalid_arguments')
		if (result.kind === 'invalid_arguments') expect(result.message).toContain('EACCES')
		expect(opened).toEqual([])
	})

	test('rejects a path that is not a regular file or directory and searches nothing', async () => {
		const base = makeSearchFilesystem(['good.txt', 'device'])
		const filesystem: SearchFilesystem = {
			listEntries: (directory) => base.listEntries(directory),
			statKind: (candidate) => candidate.endsWith('/device') ? 'other' : base.statKind(candidate),
		}
		const opened: string[] = []
		const handler = createSearchText(ROOT, {
			fileChunks: fileChunksFrom((filePath) => {
				opened.push(filePath)
				return finiteChunkStream(['match'])
			}),
			filesystem,
			pathFilesystem: scriptedPaths([ROOT, `${ROOT}/good.txt`, `${ROOT}/device`]),
		})
		const result = await handler({ pattern: 'match', paths: ['good.txt', 'device'] })
		expect(result.kind).toBe('invalid_arguments')
		if (result.kind === 'invalid_arguments') expect(result.message).toContain('not a regular file or directory')
		expect(opened).toEqual([])
	})

	test('rejects an explicit path that escapes the workspace', async () => {
		const handler = searchHandler(['a.txt'], fileChunksFrom(() => finiteChunkStream([])), scriptedPaths([ROOT, '/outside/a.txt']))
		const result = await handler({ pattern: 'match', paths: ['/outside/a.txt'] })
		expect(result.kind).toBe('invalid_arguments')
	})

	test('rejects a non-array include or exclude', async () => {
		const handler = searchHandler(['a.txt'], fileChunksFrom(() => finiteChunkStream(['match'])), scriptedPaths([ROOT]))
		expect((await handler({ pattern: 'match', include: '*.ts' })).kind).toBe('invalid_arguments')
		expect((await handler({ pattern: 'match', exclude: 'node_modules' })).kind).toBe('invalid_arguments')
	})

	test('rejects empty-string or non-string include and exclude entries', async () => {
		const handler = searchHandler(['a.txt'], fileChunksFrom(() => finiteChunkStream(['match'])), scriptedPaths([ROOT]))
		expect((await handler({ pattern: 'match', include: [''] })).kind).toBe('invalid_arguments')
		expect((await handler({ pattern: 'match', include: ['*.ts', 42] })).kind).toBe('invalid_arguments')
		expect((await handler({ pattern: 'match', exclude: [''] })).kind).toBe('invalid_arguments')
		expect((await handler({ pattern: 'match', exclude: ['node_modules', 42] })).kind).toBe('invalid_arguments')
	})

	test('rejects invalid include and exclude globs', async () => {
		const handler = searchHandler(['a.txt'], fileChunksFrom(() => finiteChunkStream(['match'])), scriptedPaths([ROOT]))
		const includeResult = await handler({ pattern: 'match', include: ['[z-a]'] })
		expect(includeResult.kind).toBe('invalid_arguments')
		if (includeResult.kind === 'invalid_arguments') expect(includeResult.message).toMatch(/^Invalid include pattern/)
		const excludeResult = await handler({ pattern: 'match', exclude: ['[z-a]'] })
		expect(excludeResult.kind).toBe('invalid_arguments')
		if (excludeResult.kind === 'invalid_arguments') expect(excludeResult.message).toMatch(/^Invalid exclude pattern/)
	})
})

describe('createSearchText resilience', () => {
	test('finds matches in a large lazy chunk stream without loading it into an array', async () => {
		let pulled = 0
		const source: AsyncIterable<string> = {
			async *[Symbol.asyncIterator]() {
				for (let index = 0; index < 200_000; index += 1) {
					pulled += 1
					if (index === 100_000) yield 'needle\n'
					else yield `haystack ${index}\n`
				}
			},
		}
		const matches = searchMatches(await searchHandler(['generated.txt'], fileChunksFrom(() => source), scriptedPaths([ROOT]))({ pattern: 'needle' }))
		expect(matches).toEqual([{ path: 'generated.txt', line: 100_001, text: 'needle' }])
		expect(pulled).toBe(200_000)
	})

	test('skips a file whose chunk source fails', async () => {
		const handler = searchHandler(['broken.txt', 'ok.txt'], fileChunksFrom((filePath) => {
			if (filePath.endsWith('broken.txt')) {
				return {
					async *[Symbol.asyncIterator]() {
						throw new Error('EACCES')
					},
				}
			}
			return finiteChunkStream(['match'])
		}), scriptedPaths([ROOT]))
		const matches = searchMatches(await handler({ pattern: 'match' }))
		expect(matches).toEqual([{ path: 'ok.txt', line: 1, text: 'match' }])
	})

	test('preserves carriage returns on CRLF input', async () => {
		const handler = searchHandler(['a.txt'], fileChunksFrom(() => finiteChunkStream(['one\r\ntwo\r\n'])), scriptedPaths([ROOT]))
		const matches = searchMatches(await handler({ pattern: 'two' }))
		expect(matches).toEqual([{ path: 'a.txt', line: 2, text: 'two\r' }])
	})

	test('reports the empty final line after a trailing newline', async () => {
		const withTrailing = searchHandler(['a.txt'], fileChunksFrom(() => finiteChunkStream(['a\nb\n'])), scriptedPaths([ROOT]))
		const trailingMatches = searchMatches(await withTrailing({ pattern: '^$' }))
		expect(trailingMatches).toEqual([{ path: 'a.txt', line: 3, text: '' }])
		const withoutTrailing = searchHandler(['a.txt'], fileChunksFrom(() => finiteChunkStream(['a\nb'])), scriptedPaths([ROOT]))
		expect(searchMatches(await withoutTrailing({ pattern: '^$' }))).toEqual([])
	})
})
