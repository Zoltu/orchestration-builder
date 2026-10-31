import { createReadStream } from 'node:fs'

// A streamed view of a file's chunks. The port exists so the line splitter can be exercised against an in-memory source.
export interface FileChunks {
	readChunks(filePath: string): AsyncIterable<string>
}

export interface FileLines {
	readLines(filePath: string, maxLineChars: number): AsyncIterable<string>
}

export function createNodeFileChunks(): FileChunks {
	return {
		readChunks: async function* (filePath: string): AsyncGenerator<string, void, void> {
			const stream = createReadStream(filePath, { encoding: 'utf8' })
			try {
				for await (const chunk of stream) yield chunk
			} finally {
				// A consumer that stops at its match cap returns from the generator, so destroying here is what releases the file descriptor instead of leaving the stream running.
				stream.destroy()
			}
		},
	}
}

export function createFileLines(chunks: FileChunks): FileLines {
	return {
		readLines: async function* (filePath: string, maxLineChars: number): AsyncGenerator<string, void, void> {
			let currentLine = ''
			let lineTruncated = false
			let sawInput = false
			const appendSegment = (segment: string): void => {
				if (segment.length === 0 || lineTruncated) return
				const remaining = maxLineChars - currentLine.length
				if (remaining <= 0) {
					lineTruncated = true
					return
				}
				if (segment.length > remaining) {
					currentLine += segment.slice(0, remaining)
					lineTruncated = true
					return
				}
				currentLine += segment
			}
			for await (const chunk of chunks.readChunks(filePath)) {
				if (chunk.length === 0) continue
				sawInput = true
				let start = 0
				while (start < chunk.length) {
					const newlineIndex = chunk.indexOf('\n', start)
					if (newlineIndex === -1) {
						appendSegment(chunk.slice(start))
						break
					}
					appendSegment(chunk.slice(start, newlineIndex))
					yield lineTruncated ? `${currentLine}…` : currentLine
					currentLine = ''
					lineTruncated = false
					start = newlineIndex + 1
				}
			}
			// Preserve splitLines semantics: a trailing newline leaves an empty final line, while a truly empty file has none.
			if (currentLine.length > 0 || lineTruncated) {
				yield lineTruncated ? `${currentLine}…` : currentLine
				return
			}
			if (sawInput) yield ''
		},
	}
}
