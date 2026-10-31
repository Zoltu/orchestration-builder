import { describe, expect, test } from 'bun:test'
import type { ToolResult } from '../types.js'
import type { PathFilesystem } from '../workspace-path.js'
import type { FileLines } from './file-lines.js'
import { createSearchText, type SearchDirectoryEntry, type SearchFilesystem, type SearchMatch } from './search-text.js'

const ROOT = '/workspace'

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

function fileLinesFrom(sourceFor: (filePath: string) => AsyncIterable<string>): FileLines {
	return { readLines: (filePath) => sourceFor(filePath) }
}

function finiteLineStream(lines: readonly string[]): AsyncIterable<string> {
	return {
		async *[Symbol.asyncIterator]() {
			for (const line of lines) yield line
		},
	}
}

function cappedLineStream(limit: number, onPull: () => void): AsyncIterable<string> {
	return {
		async *[Symbol.asyncIterator]() {
			for (let index = 0; ; index += 1) {
				if (index >= limit) throw new Error('line source pulled past its cap')
				onPull()
				yield `match ${index}`
			}
		},
	}
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

function searchHandler(files: string[], fileLines: FileLines, pathFilesystem: PathFilesystem) {
	return createSearchText(ROOT, { fileLines, filesystem: makeSearchFilesystem(files), pathFilesystem })
}

describe('createSearchText streaming', () => {
	test('caps matches per file and stops pulling the line source at the cap', async () => {
		let pulls = 0
		const handler = searchHandler(['large.txt'], fileLinesFrom(() => cappedLineStream(100, () => { pulls += 1 })), scriptedPaths([ROOT]))
		const matches = searchMatches(await handler({ pattern: 'match' }))
		expect(matches).toHaveLength(100)
		expect(matches[99]?.line).toBe(100)
		expect(pulls).toBe(100)
	})

	test('caps total matches and never opens files after the total cap is reached', async () => {
		const files = Array.from({ length: 15 }, (_, index) => `file-${index}.txt`)
		const opened: string[] = []
		const handler = searchHandler(files, fileLinesFrom((filePath) => {
			opened.push(filePath)
			return cappedLineStream(100, () => {})
		}), scriptedPaths([ROOT]))
		const matches = searchMatches(await handler({ pattern: 'match' }))
		expect(matches).toHaveLength(1000)
		expect(opened).toHaveLength(10)
		expect(matches[999]?.line).toBe(100)
	})

	test('uses the bounded search line cap and caps stored match text', async () => {
		const requestedCaps: number[] = []
		const longLine = `${'x'.repeat(2500)}needle`
		const fileLines: FileLines = {
			readLines: (_filePath, maxLineChars) => {
				requestedCaps.push(maxLineChars)
				return finiteLineStream([longLine])
			},
		}
		const matches = searchMatches(await searchHandler(['a.txt'], fileLines, scriptedPaths([ROOT]))({ pattern: 'needle' }))
		expect(requestedCaps).toEqual([1024 * 1024])
		expect(matches).toHaveLength(1)
		expect(matches[0]?.text.length).toBe(2001)
		expect(matches[0]?.text.endsWith('…')).toBe(true)
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
			fileLines: fileLinesFrom((filePath) => finiteLineStream(filePath.endsWith('good.txt') ? ['match'] : [])),
			filesystem,
			pathFilesystem: scriptedPaths([ROOT, `${ROOT}/bad.txt`, `${ROOT}/good.txt`]),
		})
		const matches = searchMatches(await handler({ pattern: 'match', paths: ['bad.txt', 'good.txt'] }))
		expect(matches).toEqual([{ path: 'good.txt', line: 1, text: 'match' }])
	})

	test('finds matches in a large lazy line stream without loading it into an array', async () => {
		let pulled = 0
		const source: AsyncIterable<string> = {
			async *[Symbol.asyncIterator]() {
				for (let index = 0; index < 200_000; index += 1) {
					pulled += 1
					if (index === 100_000) yield 'needle'
					else yield `haystack ${index}`
				}
			},
		}
		const matches = searchMatches(await searchHandler(['generated.txt'], fileLinesFrom(() => source), scriptedPaths([ROOT]))({ pattern: 'needle' }))
		expect(matches).toEqual([{ path: 'generated.txt', line: 100_001, text: 'needle' }])
		expect(pulled).toBe(200_000)
	})

	test('keeps the extension filter for directory walks', async () => {
		const opened: string[] = []
		const handler = searchHandler(['notes.txt', 'data.bin'], fileLinesFrom((filePath) => {
			opened.push(filePath)
			return finiteLineStream(['match'])
		}), scriptedPaths([ROOT]))
		const matches = searchMatches(await handler({ pattern: 'match' }))
		expect(opened).toEqual([`${ROOT}/notes.txt`])
		expect(matches).toEqual([{ path: 'notes.txt', line: 1, text: 'match' }])
	})

	test('skips only the top-level .orchestration directory', async () => {
		const opened: string[] = []
		const handler = searchHandler(['.orchestration/run.txt', 'project/.orchestration/notes.txt', 'src/a.txt'], fileLinesFrom((filePath) => {
			opened.push(filePath)
			return finiteLineStream(['match'])
		}), scriptedPaths([ROOT]))
		searchMatches(await handler({ pattern: 'match' }))
		expect(opened).toContain(`${ROOT}/project/.orchestration/notes.txt`)
		expect(opened).toContain(`${ROOT}/src/a.txt`)
		expect(opened).not.toContain(`${ROOT}/.orchestration/run.txt`)
	})

	test('searches an explicitly named non-searchable file', async () => {
		const handler = searchHandler(['data.bin'], fileLinesFrom(() => finiteLineStream(['needle'])), scriptedPaths([ROOT, `${ROOT}/data.bin`]))
		const matches = searchMatches(await handler({ pattern: 'needle', paths: ['data.bin'] }))
		expect(matches).toEqual([{ path: 'data.bin', line: 1, text: 'needle' }])
	})

	test('walks an explicitly named directory with the extension filter', async () => {
		const opened: string[] = []
		const handler = searchHandler(['dir/a.bin', 'dir/b.txt'], fileLinesFrom((filePath) => {
			opened.push(filePath)
			return finiteLineStream(['match'])
		}), scriptedPaths([ROOT, `${ROOT}/dir`]))
		const matches = searchMatches(await handler({ pattern: 'match', paths: ['dir'] }))
		expect(opened).toEqual([`${ROOT}/dir/b.txt`])
		expect(matches).toEqual([{ path: 'dir/b.txt', line: 1, text: 'match' }])
	})

	test('rejects an explicit path that escapes the workspace', async () => {
		const handler = searchHandler(['a.txt'], fileLinesFrom(() => finiteLineStream([])), scriptedPaths([ROOT, '/outside/a.txt']))
		const result = await handler({ pattern: 'match', paths: ['/outside/a.txt'] })
		expect(result.kind).toBe('invalid_arguments')
	})

	test('falls back to a literal regex when the pattern does not compile', async () => {
		const handler = searchHandler(['a.txt'], fileLinesFrom(() => finiteLineStream(['value a( here'])), scriptedPaths([ROOT]))
		const matches = searchMatches(await handler({ pattern: 'a(' }))
		expect(matches).toEqual([{ path: 'a.txt', line: 1, text: 'value a( here' }])
	})

	test('skips a file whose line source fails', async () => {
		const handler = searchHandler(['broken.txt', 'ok.txt'], fileLinesFrom((filePath) => {
			if (filePath.endsWith('broken.txt')) {
				return {
					async *[Symbol.asyncIterator]() {
						throw new Error('EACCES')
					},
				}
			}
			return finiteLineStream(['match'])
		}), scriptedPaths([ROOT]))
		const matches = searchMatches(await handler({ pattern: 'match' }))
		expect(matches).toEqual([{ path: 'ok.txt', line: 1, text: 'match' }])
	})
})
