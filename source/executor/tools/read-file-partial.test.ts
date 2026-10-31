import { describe, expect, test } from 'bun:test'
import type { ToolResult } from '../types.js'
import type { PathFilesystem } from '../workspace-path.js'
import { createFileLines, type FileChunks, type FileLines } from './file-lines.js'
import { createReadFilePartial } from './read-file-partial.js'

const ROOT = '/workspace'

interface PartialReadData {
	path: string
	offset: number
	limit: number
	totalLines: number
	content: string
}

function isPartialReadData(value: unknown): value is PartialReadData {
	if (typeof value !== 'object' || value === null) return false
	if (!('path' in value) || typeof value.path !== 'string') return false
	if (!('offset' in value) || typeof value.offset !== 'number') return false
	if (!('limit' in value) || typeof value.limit !== 'number') return false
	if (!('totalLines' in value) || typeof value.totalLines !== 'number') return false
	if (!('content' in value) || typeof value.content !== 'string') return false
	return true
}

function partialReadData(result: ToolResult): PartialReadData {
	if (result.kind !== 'success') throw new Error(`expected success, got ${result.kind}`)
	if (!isPartialReadData(result.data)) throw new Error('expected partial read data')
	return result.data
}

function scriptedPaths(existing: string[]): PathFilesystem {
	const known = new Set(existing)
	return {
		exists: (candidate) => known.has(candidate),
		realpath: (candidate) => candidate,
	}
}

function fileLinesFrom(lines: readonly string[], onRead?: (maxLineChars: number) => void): FileLines {
	return {
		readLines: async function* (_filePath: string, maxLineChars: number) {
			onRead?.(maxLineChars)
			for (const line of lines) yield line
		},
	}
}

function chunkSource(chunks: readonly string[]): FileChunks {
	return {
		readChunks: async function* (_filePath: string) {
			for (const chunk of chunks) yield chunk
		},
	}
}

function partialHandler(lines: readonly string[], fileLines?: FileLines) {
	return createReadFilePartial(ROOT, {
		fileLines: fileLines ?? fileLinesFrom(lines),
		pathFilesystem: scriptedPaths([ROOT, `${ROOT}/notes.txt`]),
	})
}

describe('createReadFilePartial line windows', () => {
	test('returns the requested line window and the full line count', async () => {
		const result = await partialHandler(['zero', 'one', 'two', 'three', 'four'])({ path: 'notes.txt', offset: 1, limit: 2 })
		expect(partialReadData(result)).toEqual({ path: 'notes.txt', offset: 1, limit: 2, totalLines: 5, content: 'one\ntwo' })
	})

	test('clamps the window at end of file', async () => {
		const result = await partialHandler(['zero', 'one', 'two', 'three', 'four'])({ path: 'notes.txt', offset: 2, limit: 10 })
		expect(partialReadData(result)).toEqual({ path: 'notes.txt', offset: 2, limit: 3, totalLines: 5, content: 'two\nthree\nfour' })
	})

	test('reports an offset past EOF as the line count with an empty window', async () => {
		const result = await partialHandler(['zero', 'one', 'two'])({ path: 'notes.txt', offset: 10, limit: 5 })
		expect(partialReadData(result)).toEqual({ path: 'notes.txt', offset: 3, limit: 0, totalLines: 3, content: '' })
	})

	test('counts lines past the window without retaining them', async () => {
		let pulled = 0
		const fileLines: FileLines = {
			readLines: async function* (_filePath: string, _maxLineChars: number) {
				for (let index = 0; index < 10_000; index += 1) {
					pulled += 1
					yield `line ${index}`
				}
			},
		}
		const result = await partialHandler([], fileLines)({ path: 'notes.txt', offset: 9_990, limit: 5 })
		expect(partialReadData(result)).toEqual({ path: 'notes.txt', offset: 9_990, limit: 5, totalLines: 10_000, content: 'line 9990\nline 9991\nline 9992\nline 9993\nline 9994' })
		expect(pulled).toBe(10_000)
	})

	test('passes the bounded line cap to the line source', async () => {
		let requestedCap = 0
		const fileLines = fileLinesFrom(['one'], (maxLineChars) => { requestedCap = maxLineChars })
		await partialHandler([], fileLines)({ path: 'notes.txt', offset: 0, limit: 1 })
		expect(requestedCap).toBe(200_000)
	})

	test('bounds collected content despite a huge requested limit and still counts every line', async () => {
		let pulled = 0
		const line = 'x'.repeat(1000)
		const fileLines: FileLines = {
			readLines: async function* (_filePath: string, _maxLineChars: number) {
				for (let index = 0; index < 1000; index += 1) {
					pulled += 1
					yield line
				}
			},
		}
		const data = partialReadData(await partialHandler([], fileLines)({ path: 'notes.txt', offset: 0, limit: 10_000 }))
		expect(data.totalLines).toBe(1000)
		expect(data.limit).toBe(200)
		expect(data.content.length).toBe(200_001)
		expect(data.content.endsWith('…')).toBe(true)
		expect(pulled).toBe(1000)
	})

	test('truncates a single line that exceeds the content budget', async () => {
		const data = partialReadData(await partialHandler(['x'.repeat(300_000)])({ path: 'notes.txt', offset: 0, limit: 10 }))
		expect(data.limit).toBe(1)
		expect(data.content.length).toBe(200_001)
		expect(data.content.endsWith('…')).toBe(true)
	})

	test('stops before an empty line when no separator budget remains', async () => {
		const data = partialReadData(await partialHandler(['x'.repeat(199_999), ''])({ path: 'notes.txt', offset: 0, limit: 10 }))
		expect(data.totalLines).toBe(2)
		expect(data.limit).toBe(1)
		expect(data.content.length).toBe(199_999)
	})

	test('keeps the splitter trailing-empty-line semantics in totalLines', async () => {
		const fileLines = createFileLines(chunkSource(['one\ntwo\n']))
		const data = partialReadData(await partialHandler([], fileLines)({ path: 'notes.txt', offset: 0, limit: 10 }))
		expect(data).toEqual({ path: 'notes.txt', offset: 0, limit: 3, totalLines: 3, content: 'one\ntwo\n' })
	})

	test('reports a read failure as a tool error', async () => {
		const fileLines: FileLines = {
			readLines: async function* (_filePath: string) {
				throw new Error('EACCES: permission denied')
			},
		}
		const result = await partialHandler([], fileLines)({ path: 'notes.txt', offset: 0, limit: 1 })
		expect(result).toEqual({ kind: 'invalid_arguments', message: 'EACCES: permission denied' })
	})

	test('rejects invalid offset and limit values', async () => {
		const handler = partialHandler(['one'])
		expect(await handler({ path: 'notes.txt', offset: -1, limit: 1 })).toEqual({ kind: 'invalid_arguments', message: 'offset must be a non-negative number' })
		expect(await handler({ path: 'notes.txt', offset: 0, limit: 0 })).toEqual({ kind: 'invalid_arguments', message: 'limit must be a positive number' })
	})
})
