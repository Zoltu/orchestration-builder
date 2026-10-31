import * as path from 'node:path'
import { createToolError } from '../errors.js'
import type { ToolHandler } from './tool-dispatch.js'
import type { FileLines } from './file-lines.js'
import { wrapIoError } from './shared.js'
import { type PathFilesystem, resolveWithinWorkspace } from '../workspace-path.js'

const MAX_PARTIAL_LINE_CHARS = 200_000

const MAX_PARTIAL_CONTENT_CHARS = 200_000

export interface ReadFilePartialDependencies {
	fileLines: FileLines
	pathFilesystem: PathFilesystem
}

interface LineWindow {
	offset: number
	limit: number
	totalLines: number
	content: string
}

async function collectLineWindow(lines: AsyncIterable<string>, offset: number, limit: number): Promise<LineWindow> {
	const startLine = Math.floor(offset)
	const lineLimit = Math.floor(limit)
	const collected: string[] = []
	let contentChars = 0
	let totalLines = 0
	let collecting = true
	for await (const line of lines) {
		const lineIndex = totalLines
		totalLines += 1
		if (!collecting) continue
		if (lineIndex < startLine) continue
		if (collected.length >= lineLimit) {
			collecting = false
			continue
		}
		const separatorChars = collected.length === 0 ? 0 : 1
		const remainingChars = MAX_PARTIAL_CONTENT_CHARS - contentChars - separatorChars
		// A zero or negative remaining budget cannot fit even an empty line, so stop before it adds a separator past the cap.
		if (remainingChars <= 0) {
			collecting = false
			continue
		}
		if (line.length > remainingChars) {
			collected.push(`${line.slice(0, remainingChars)}…`)
			contentChars += separatorChars + remainingChars + 1
			collecting = false
			continue
		}
		collected.push(line)
		contentChars += separatorChars + line.length
	}
	return {
		offset: Math.min(startLine, totalLines),
		limit: collected.length,
		totalLines,
		content: collected.join('\n'),
	}
}

export function createReadFilePartial(workspaceRoot: string, dependencies: ReadFilePartialDependencies): ToolHandler {
	const resolvedRoot = path.resolve(workspaceRoot)
	return async (args) => {
		const pathValue = args['path']
		if (typeof pathValue !== 'string' || pathValue === '') {
			return createToolError('invalid_arguments', 'path must be a non-empty string')
		}
		const offsetValue = args['offset']
		const limitValue = args['limit']
		if (typeof offsetValue !== 'number' || !Number.isFinite(offsetValue) || offsetValue < 0) {
			return createToolError('invalid_arguments', 'offset must be a non-negative number')
		}
		if (typeof limitValue !== 'number' || !Number.isFinite(limitValue) || limitValue <= 0) {
			return createToolError('invalid_arguments', 'limit must be a positive number')
		}
		const resolution = resolveWithinWorkspace(pathValue, resolvedRoot, dependencies.pathFilesystem)
		if (!resolution.ok) return resolution.error
		let window: LineWindow
		try {
			window = await collectLineWindow(dependencies.fileLines.readLines(resolution.path.absolute, MAX_PARTIAL_LINE_CHARS), offsetValue, limitValue)
		} catch (error) {
			return wrapIoError(error, `Cannot read file: ${pathValue}`)
		}
		return {
			kind: 'success',
			data: {
				path: resolution.path.relative,
				offset: window.offset,
				limit: window.limit,
				totalLines: window.totalLines,
				content: window.content,
			},
		}
	}
}
