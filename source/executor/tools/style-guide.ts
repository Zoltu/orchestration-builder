import * as fs from 'node:fs'
import * as path from 'node:path'
import { truncateToolOutput } from '../context/index.js'
import { createToolError } from '../errors.js'
import { STYLE_GUIDE_FILE_NAME } from '../persistence.js'
import { isRunIdShape } from '../run-id.js'
import type { ToolHandler } from './tool-dispatch.js'
import { wrapIoError } from './shared.js'

export interface StyleGuideToolConfig {
	runsBaseDir: string
	runId: string
	workspaceRoot: string
}

// No existing cap fits: role-inspection bounds message windows and compaction keeps only slivers, while a style guide read should still deliver a usable document. Past this cap the read returns the head plus a truncation marker and the total size, so one style guide read cannot refill the reader's context.
export const MAX_STYLE_GUIDE_CHARS = 20_000

export interface BoundedStyleGuide {
	content: string
	truncated: boolean
	totalChars: number
}

// Truncation formatting kept pure so the cap boundary is testable without a filesystem; the marker and shape follow the shared truncateToolOutput convention.
export function boundStyleGuideContent(content: string, maxChars: number): BoundedStyleGuide {
	const bounded = truncateToolOutput(content, maxChars)
	return { content: bounded.text, truncated: bounded.truncated, totalChars: content.length }
}

export function isStyleGuideContent(value: unknown): value is string {
	return typeof value === 'string' && value !== ''
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
		if (!isStyleGuideContent(content)) return createToolError('invalid_arguments', 'content must be a non-empty string')
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
		return { kind: 'success', data: boundStyleGuideContent(content, MAX_STYLE_GUIDE_CHARS) }
	}
}

export function createStyleGuideToolHandlers(config: StyleGuideToolConfig): Record<string, ToolHandler> {
	return { read_style_guide: createReadStyleGuide(config), write_style_guide: createWriteStyleGuide(config) }
}
