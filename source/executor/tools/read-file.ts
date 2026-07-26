import * as fs from 'node:fs'
import * as path from 'node:path'
import { createToolError } from '../errors.js'
import type { ToolHandler } from '../tool-dispatch.js'
import { nodePathFilesystem, resolveWithinWorkspace, wrapIoError } from './shared.js'

export function createReadFile(workspaceRoot: string): ToolHandler {
	const resolvedRoot = path.resolve(workspaceRoot)
	return (args) => {
		const pathValue = args['path']
		if (typeof pathValue !== 'string' || pathValue === '') {
			return createToolError('invalid_arguments', 'path must be a non-empty string')
		}
		const resolution = resolveWithinWorkspace(pathValue, resolvedRoot, nodePathFilesystem)
		if (!resolution.ok) return resolution.error
		try {
			const content = fs.readFileSync(resolution.path.absolute, 'utf8')
			return { kind: 'success', data: content }
		} catch (error) {
			return wrapIoError(error, `Cannot read file: ${pathValue}`)
		}
	}
}
