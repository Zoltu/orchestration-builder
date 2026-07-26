import * as fs from 'node:fs'
import * as path from 'node:path'
import { createToolError } from '../errors.js'
import type { ToolHandler } from '../tool-dispatch.js'
import { nodePathFilesystem, resolveWithinWorkspace, wrapIoError } from './shared.js'

export interface WriteFileResult {
	path: string
	bytes: number
}

export function createWriteFile(workspaceRoot: string): ToolHandler {
	const resolvedRoot = path.resolve(workspaceRoot)
	return (args) => {
		const pathValue = args['path']
		if (typeof pathValue !== 'string' || pathValue === '') {
			return createToolError('invalid_arguments', 'path must be a non-empty string')
		}
		const contentValue = args['content']
		if (typeof contentValue !== 'string') {
			return createToolError('invalid_arguments', 'content must be a string')
		}
		const resolution = resolveWithinWorkspace(pathValue, resolvedRoot, nodePathFilesystem)
		if (!resolution.ok) return resolution.error
		const targetPath = resolution.path.absolute
		const parentDir = path.dirname(targetPath)
		try {
			if (!fs.existsSync(parentDir)) {
				fs.mkdirSync(parentDir, { recursive: true })
			}
			fs.writeFileSync(targetPath, contentValue, 'utf8')
		} catch (error) {
			return wrapIoError(error, `Cannot write file: ${pathValue}`)
		}
		const result: WriteFileResult = {
			path: resolution.path.relative,
			bytes: Buffer.byteLength(contentValue, 'utf8'),
		}
		return { kind: 'success', data: result }
	}
}
