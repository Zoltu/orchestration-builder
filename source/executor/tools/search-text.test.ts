import { describe, expect, test } from 'bun:test'
import type { ToolResult } from '../types.js'
import type { PathFilesystem } from '../workspace-path.js'
import type { FileChunks } from './file-lines.js'
import { createSearchText, type SearchDirectoryEntry, type SearchFilesystem, type SearchMatch } from './search-text.js'

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

function searchMatches(result: ToolResult): SearchMatch[] {
	if (result.kind !== 'success') throw new Error(`expected success, got ${result.kind}`)
	if (!Array.isArray(result.data) || !result.data.every(isSearchMatch)) throw new Error('expected an array of search matches')
	return result.data
}

function searchHandler(files: string[], fileChunks: FileChunks, pathFilesystem: PathFilesystem) {
	return createSearchText(ROOT, { fileChunks, filesystem: makeSearchFilesystem(files), pathFilesystem })
}

describe('createSearchText streaming', () => {
	test('caps matches per file and stops pulling the chunk source at the cap', async () => {
		let pulls = 0
		const handler = searchHandler(['large.txt'], fileChunksFrom(() => cappedLineChunkStream(100, () => { pulls += 1 })), scriptedPaths([ROOT]))
		const matches = searchMatches(await handler({ pattern: 'match' }))
		expect(matches).toHaveLength(100)
		expect(matches[99]?.line).toBe(100)
		expect(pulls).toBe(100)
	})

	test('caps total matches and never opens files after the total cap is reached', async () => {
		const files = Array.from({ length: 15 }, (_, index) => `file-${index}.txt`)
		const opened: string[] = []
		const handler = searchHandler(files, fileChunksFrom((filePath) => {
			opened.push(filePath)
			return cappedLineChunkStream(100, () => {})
		}), scriptedPaths([ROOT]))
		const matches = searchMatches(await handler({ pattern: 'match' }))
		expect(matches).toHaveLength(1000)
		expect(opened).toHaveLength(10)
		expect(matches[999]?.line).toBe(100)
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
		const matches = searchMatches(await handler({ pattern: 'needle' }))
		expect(matches).toHaveLength(100)
		expect(matches.every((match) => match.line === 1)).toBe(true)
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
		const matches = searchMatches(await handler({ pattern: 'line' }))
		expect(matches).toEqual([
			{ path: 'a.txt', line: 1, text: 'first line' },
			{ path: 'a.txt', line: 2, text: 'second line' },
			{ path: 'a.txt', line: 3, text: 'third line' },
		])
	})

	test('skips a binary file during a walk', async () => {
		const handler = searchHandler(['text.txt', 'binary.txt'], fileChunksFrom((filePath) => finiteChunkStream(filePath.endsWith('binary.txt') ? ['match\u0000'] : ['match'])), scriptedPaths([ROOT]))
		const matches = searchMatches(await handler({ pattern: 'match' }))
		expect(matches).toEqual([{ path: 'text.txt', line: 1, text: 'match' }])
	})

	test('rejects an explicitly named binary file with a searchable extension', async () => {
		const handler = searchHandler(['binary.txt'], fileChunksFrom(() => finiteChunkStream(['match\u0000'])), scriptedPaths([ROOT, `${ROOT}/binary.txt`]))
		const result = await handler({ pattern: 'match', paths: ['binary.txt'] })
		if (result.kind !== 'invalid_arguments') throw new Error(`expected invalid_arguments, got ${result.kind}`)
		expect(result.message).toContain('binary')
		expect(result.message).toContain('not designed for binary search')
	})

	test('skips an explicit path whose stat fails', async () => {
		const base = makeSearchFilesystem(['bad.txt', 'good.txt'])
		const filesystem: SearchFilesystem = {
			listEntries: (directory) => base.listEntries(directory),
			statKind: (candidate) => {
				if (candidate.endsWith('/bad.txt')) throw new Error('EACCES')
				return base.statKind(candidate)
			},
		}
		const handler = createSearchText(ROOT, {
			fileChunks: fileChunksFrom((filePath) => finiteChunkStream(filePath.endsWith('good.txt') ? ['match'] : [])),
			filesystem,
			pathFilesystem: scriptedPaths([ROOT, `${ROOT}/bad.txt`, `${ROOT}/good.txt`]),
		})
		const matches = searchMatches(await handler({ pattern: 'match', paths: ['bad.txt', 'good.txt'] }))
		expect(matches).toEqual([{ path: 'good.txt', line: 1, text: 'match' }])
	})

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

	test('keeps the extension filter for directory walks', async () => {
		const opened: string[] = []
		const handler = searchHandler(['notes.txt', 'data.bin'], fileChunksFrom((filePath) => {
			opened.push(filePath)
			return finiteChunkStream(['match'])
		}), scriptedPaths([ROOT]))
		const matches = searchMatches(await handler({ pattern: 'match' }))
		expect(opened).toEqual([`${ROOT}/notes.txt`])
		expect(matches).toEqual([{ path: 'notes.txt', line: 1, text: 'match' }])
	})

	test('skips only the top-level .orchestration directory', async () => {
		const opened: string[] = []
		const handler = searchHandler(['.orchestration/run.txt', 'project/.orchestration/notes.txt', 'src/a.txt'], fileChunksFrom((filePath) => {
			opened.push(filePath)
			return finiteChunkStream(['match'])
		}), scriptedPaths([ROOT]))
		searchMatches(await handler({ pattern: 'match' }))
		expect(opened).toContain(`${ROOT}/project/.orchestration/notes.txt`)
		expect(opened).toContain(`${ROOT}/src/a.txt`)
		expect(opened).not.toContain(`${ROOT}/.orchestration/run.txt`)
	})

	test('searches an explicitly named non-searchable text file', async () => {
		const handler = searchHandler(['data.bin'], fileChunksFrom(() => finiteChunkStream(['needle'])), scriptedPaths([ROOT, `${ROOT}/data.bin`]))
		const matches = searchMatches(await handler({ pattern: 'needle', paths: ['data.bin'] }))
		expect(matches).toEqual([{ path: 'data.bin', line: 1, text: 'needle' }])
	})

	test('walks an explicitly named directory with the extension filter', async () => {
		const opened: string[] = []
		const handler = searchHandler(['dir/a.bin', 'dir/b.txt'], fileChunksFrom((filePath) => {
			opened.push(filePath)
			return finiteChunkStream(['match'])
		}), scriptedPaths([ROOT, `${ROOT}/dir`]))
		const matches = searchMatches(await handler({ pattern: 'match', paths: ['dir'] }))
		expect(opened).toEqual([`${ROOT}/dir/b.txt`])
		expect(matches).toEqual([{ path: 'dir/b.txt', line: 1, text: 'match' }])
	})

	test('rejects an explicit path that escapes the workspace', async () => {
		const handler = searchHandler(['a.txt'], fileChunksFrom(() => finiteChunkStream([])), scriptedPaths([ROOT, '/outside/a.txt']))
		const result = await handler({ pattern: 'match', paths: ['/outside/a.txt'] })
		expect(result.kind).toBe('invalid_arguments')
	})

	test('falls back to a literal regex when the pattern does not compile', async () => {
		const handler = searchHandler(['a.txt'], fileChunksFrom(() => finiteChunkStream(['value a( here'])), scriptedPaths([ROOT]))
		const matches = searchMatches(await handler({ pattern: 'a(' }))
		expect(matches).toEqual([{ path: 'a.txt', line: 1, text: 'value a( here' }])
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
