import { describe, expect, test } from 'bun:test'
import { createFileLines, type FileChunks } from './file-lines.js'

function chunkSource(chunks: readonly string[], onCleanup?: () => void): FileChunks {
	return {
		readChunks: async function* (_filePath: string) {
			try {
				for (const chunk of chunks) yield chunk
			} finally {
				onCleanup?.()
			}
		},
	}
}

async function readAll(chunks: FileChunks, maxLineChars: number): Promise<string[]> {
	const lines: string[] = []
	for await (const line of createFileLines(chunks).readLines('/fixture/file.txt', maxLineChars)) lines.push(line)
	return lines
}

describe('createFileLines', () => {
	test('splits lines across arbitrary chunk boundaries', async () => {
		expect(await readAll(chunkSource(['one\ntwo', '\nthree']), 100)).toEqual(['one', 'two', 'three'])
	})

	test('preserves the empty final line after a trailing newline', async () => {
		expect(await readAll(chunkSource(['one\ntwo\n']), 100)).toEqual(['one', 'two', ''])
	})

	test('retains carriage returns on CRLF input', async () => {
		expect(await readAll(chunkSource(['one\r\ntwo\r\n']), 100)).toEqual(['one\r', 'two\r', ''])
	})

	test('truncates a line past the cap and discards its remainder', async () => {
		expect(await readAll(chunkSource(['abc', 'defghij', '\nne', 'xt\n']), 5)).toEqual(['abcde…', 'next', ''])
	})

	test('does not mark a line that exactly reaches the cap', async () => {
		expect(await readAll(chunkSource(['abcde\nfghij\n']), 5)).toEqual(['abcde', 'fghij', ''])
	})

	test('returns no lines for an empty file', async () => {
		expect(await readAll(chunkSource([]), 100)).toEqual([])
		expect(await readAll(chunkSource(['']), 100)).toEqual([])
	})

	test('closes the chunk source when the consumer stops early', async () => {
		let cleaned = false
		const lines = createFileLines(chunkSource(['a\nb\nc\n'], () => { cleaned = true })).readLines('/fixture/file.txt', 100)
		for await (const line of lines) {
			expect(line).toBe('a')
			break
		}
		expect(cleaned).toBe(true)
	})
})
