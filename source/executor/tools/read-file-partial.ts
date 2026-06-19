import * as fs from 'node:fs'
import * as path from 'node:path'
import { createToolError } from '../../shared/errors.js'
import type { ToolHandler } from '../tool-dispatch.js'
import { assertWithinWorkspace, wrapToolError } from './shared.js'

function splitLines(text: string): string[] {
	const lines: string[] = []
	let start = 0
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) {
			lines.push(text.slice(start, i))
			start = i + 1
		}
	}
	if (start < text.length) lines.push(text.slice(start))
	if (text.endsWith('\n')) lines.push('')
	return lines
}

export function createReadFilePartial(workspaceRoot: string): ToolHandler {
	const resolvedRoot = path.resolve(workspaceRoot)
	return (args) => {
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
		let resolved
		try {
			resolved = assertWithinWorkspace(pathValue, resolvedRoot)
		} catch (error) {
			return wrapToolError(error, 'Invalid path')
		}
		let content: string
		try {
			content = fs.readFileSync(resolved.absolute, 'utf8')
		} catch (error) {
			const message = error instanceof Error ? error.message : 'cannot read file'
			return createToolError('invalid_arguments', `Cannot read file: ${message}`)
		}
		const lines = splitLines(content)
		const startLine = Math.min(Math.floor(offsetValue), lines.length)
		const endLine = Math.min(startLine + Math.floor(limitValue), lines.length)
		const slice = lines.slice(startLine, endLine).join('\n')
		return {
			kind: 'success',
			data: {
				path: resolved.relative,
				offset: startLine,
				limit: endLine - startLine,
				totalLines: lines.length,
				content: slice,
			},
		}
	}
}