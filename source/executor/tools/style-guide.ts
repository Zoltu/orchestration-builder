import * as fs from 'node:fs'
import * as path from 'node:path'
import { createToolError } from '../errors.js'
import { STYLE_GUIDE_FILE_NAME } from '../persistence.js'
import { isRunIdShape } from '../run-id.js'
import { isRunDocumentContent, MAX_RUN_DOCUMENT_CHARS, runDocumentDeliveryProblem, runDocumentWriteProblem } from './run-document.js'
import type { ToolHandler } from './tool-dispatch.js'
import { wrapIoError } from './shared.js'

export interface StyleGuideToolConfig {
	runsBaseDir: string
	runId: string
	workspaceRoot: string
	maxToolOutputChars: number
}

// The style guide location is fixed by executor-owned components (runsBaseDir, runId, a constant file name), so no caller-controlled path segment reaches the filesystem and no workspace-escape check applies.
function styleGuidePath(runsBaseDir: string, runId: string): string {
	return path.resolve(runsBaseDir, runId, STYLE_GUIDE_FILE_NAME)
}

// Module-private leaf factories: external callers wire the style guide tools only through createStyleGuideToolHandlers.
function createWriteStyleGuide(config: StyleGuideToolConfig): ToolHandler {
	const resolvedRoot = path.resolve(config.workspaceRoot)
	const targetPath = styleGuidePath(config.runsBaseDir, config.runId)
	return (args) => {
		const content = args['content']
		if (!isRunDocumentContent(content)) return createToolError('invalid_arguments', 'content must be a non-empty string')
		const problem = runDocumentWriteProblem(content, MAX_RUN_DOCUMENT_CHARS, config.maxToolOutputChars)
		if (problem !== null) return createToolError('invalid_arguments', problem)
		try {
			fs.mkdirSync(path.dirname(targetPath), { recursive: true })
			// Write-temp + rename so a reader landing mid-write sees the previous complete style guide, never a torn one (the same pattern the run checkpoint uses).
			const tempPath = `${targetPath}.${process.pid}.tmp`
			fs.writeFileSync(tempPath, content, 'utf8')
			fs.renameSync(tempPath, targetPath)
		} catch (error) {
			return wrapIoError(error, 'Cannot write style guide')
		}
		return { kind: 'success', data: { path: path.relative(resolvedRoot, targetPath), bytes: Buffer.byteLength(content, 'utf8') } }
	}
}

function createReadStyleGuide(config: StyleGuideToolConfig): ToolHandler {
	const currentRunPath = styleGuidePath(config.runsBaseDir, config.runId)
	return (args) => {
		const runIdValue = args['runId']
		let targetPath = currentRunPath
		if (runIdValue !== undefined) {
			if (!isRunIdShape(runIdValue)) return createToolError('invalid_arguments', 'runId must look like "run-YYYYMMDD-HHMMSS"')
			targetPath = styleGuidePath(config.runsBaseDir, runIdValue)
		}
		// A missing style guide is a normal state (the style lead may not have run yet), not an IO error, so it reads as "unavailable".
		if (!fs.existsSync(targetPath)) return createToolError('unavailable', 'no style guide has been written for this run')
		let content: string
		try {
			content = fs.readFileSync(targetPath, 'utf8')
		} catch (error) {
			return wrapIoError(error, 'Cannot read style guide')
		}
		const problem = runDocumentDeliveryProblem(content, config.maxToolOutputChars)
		if (problem !== null) return createToolError('unavailable', problem)
		return { kind: 'success', data: content }
	}
}

export function createStyleGuideToolHandlers(config: StyleGuideToolConfig): Record<string, ToolHandler> {
	return { read_style_guide: createReadStyleGuide(config), write_style_guide: createWriteStyleGuide(config) }
}
