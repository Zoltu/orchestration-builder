import * as fs from 'node:fs'
import * as path from 'node:path'
import { createToolError } from '../errors.js'
import type { ToolHandler } from './tool-dispatch.js'
import { wrapIoError } from './shared.js'
import { nodePathFilesystem, resolveWithinWorkspace } from '../workspace-path.js'

const MAX_READ_FILE_BYTES = 4 * 1024 * 1024

function tooLargeError(byteCount: number) {
	return createToolError('invalid_arguments', `File is ${byteCount} bytes, larger than the ${MAX_READ_FILE_BYTES}-byte read_file limit; use read_file_partial to read it in line windows`)
}

export function createReadFile(workspaceRoot: string): ToolHandler {
	const resolvedRoot = path.resolve(workspaceRoot)
	return (args) => {
		const pathValue = args['path']
		if (typeof pathValue !== 'string' || pathValue === '') {
			return createToolError('invalid_arguments', 'path must be a non-empty string')
		}
		const resolution = resolveWithinWorkspace(pathValue, resolvedRoot, nodePathFilesystem)
		if (!resolution.ok) return resolution.error
		let fileDescriptor: number
		try {
			fileDescriptor = fs.openSync(resolution.path.absolute, 'r')
		} catch (error) {
			return wrapIoError(error, `Cannot read file: ${pathValue}`)
		}
		try {
			const stats = fs.fstatSync(fileDescriptor)
			if (stats.size > MAX_READ_FILE_BYTES) return tooLargeError(stats.size)
			const buffer = Buffer.allocUnsafe(MAX_READ_FILE_BYTES + 1)
			let bytesRead = 0
			while (bytesRead < buffer.length) {
				const bytesThisRead = fs.readSync(fileDescriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead)
				if (bytesThisRead === 0) break
				bytesRead += bytesThisRead
			}
			// The open file can grow or be replaced after fstat, so the read itself must prove the size before anything is decoded.
			if (bytesRead > MAX_READ_FILE_BYTES) return tooLargeError(bytesRead)
			return { kind: 'success', data: buffer.subarray(0, bytesRead).toString('utf8') }
		} catch (error) {
			return wrapIoError(error, `Cannot read file: ${pathValue}`)
		} finally {
			fs.closeSync(fileDescriptor)
		}
	}
}
