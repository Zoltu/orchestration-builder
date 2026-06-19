import * as fs from 'node:fs'
import * as path from 'node:path'
import { createToolError } from '../../shared/errors.js'
import type { ToolHandler } from '../tool-dispatch.js'
import { assertWithinWorkspace, wrapToolError } from './shared.js'

export function createReadFile(workspaceRoot: string): ToolHandler {
	const resolvedRoot = path.resolve(workspaceRoot)
	return (args) => {
		const pathValue = args['path']
		if (typeof pathValue !== 'string' || pathValue === '') {
			return createToolError('invalid_arguments', 'path must be a non-empty string')
		}
		let resolved
		try {
			resolved = assertWithinWorkspace(pathValue, resolvedRoot)
		} catch (error) {
			return wrapToolError(error, 'Invalid path')
		}
		try {
			const content = fs.readFileSync(resolved.absolute, 'utf8')
			return { kind: 'success', data: content }
		} catch (error) {
			const message = error instanceof Error ? error.message : 'cannot read file'
			return createToolError('invalid_arguments', `Cannot read file: ${message}`)
		}
	}
}