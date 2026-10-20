import * as fs from 'node:fs'
import * as path from 'node:path'
import { createToolError } from '../errors.js'
import { PLAN_FILE_NAME } from '../persistence.js'
import { isRunIdShape } from '../run-id.js'
import { isRunDocumentContent, MAX_RUN_DOCUMENT_CHARS, runDocumentDeliveryProblem, runDocumentWriteProblem } from './run-document.js'
import type { ToolHandler } from './tool-dispatch.js'
import { wrapIoError } from './shared.js'

export interface PlanToolConfig {
	runsBaseDir: string
	runId: string
	workspaceRoot: string
	maxToolOutputChars: number
}

// The plan location is fixed by executor-owned components (runsBaseDir, runId, a constant file name), so no caller-controlled path segment reaches the filesystem and no workspace-escape check applies.
function planPath(runsBaseDir: string, runId: string): string {
	return path.resolve(runsBaseDir, runId, PLAN_FILE_NAME)
}

// Module-private leaf factories: external callers wire the plan tools only through createPlanToolHandlers.
function createWritePlan(config: PlanToolConfig): ToolHandler {
	const resolvedRoot = path.resolve(config.workspaceRoot)
	const targetPath = planPath(config.runsBaseDir, config.runId)
	return (args) => {
		const content = args['content']
		if (!isRunDocumentContent(content)) return createToolError('invalid_arguments', 'content must be a non-empty string')
		const problem = runDocumentWriteProblem(content, MAX_RUN_DOCUMENT_CHARS, config.maxToolOutputChars)
		if (problem !== null) return createToolError('invalid_arguments', problem)
		try {
			fs.mkdirSync(path.dirname(targetPath), { recursive: true })
			// Write-temp + rename so a reader landing mid-write sees the previous complete plan, never a torn one (the same pattern the run checkpoint uses).
			const tempPath = `${targetPath}.${process.pid}.tmp`
			fs.writeFileSync(tempPath, content, 'utf8')
			fs.renameSync(tempPath, targetPath)
		} catch (error) {
			return wrapIoError(error, 'Cannot write plan')
		}
		return { kind: 'success', data: { path: path.relative(resolvedRoot, targetPath), bytes: Buffer.byteLength(content, 'utf8') } }
	}
}

function createReadPlan(config: PlanToolConfig): ToolHandler {
	const currentRunPath = planPath(config.runsBaseDir, config.runId)
	return (args) => {
		const runIdValue = args['runId']
		let targetPath = currentRunPath
		if (runIdValue !== undefined) {
			if (!isRunIdShape(runIdValue)) return createToolError('invalid_arguments', 'runId must look like "run-YYYYMMDD-HHMMSS"')
			targetPath = planPath(config.runsBaseDir, runIdValue)
		}
		// A missing plan is a normal state (the planner may not have run yet), not an IO error, so it reads as "unavailable".
		if (!fs.existsSync(targetPath)) return createToolError('unavailable', 'no plan has been written for this run')
		let content: string
		try {
			content = fs.readFileSync(targetPath, 'utf8')
		} catch (error) {
			return wrapIoError(error, 'Cannot read plan')
		}
		const problem = runDocumentDeliveryProblem(content, config.maxToolOutputChars)
		if (problem !== null) return createToolError('unavailable', problem)
		return { kind: 'success', data: content }
	}
}

export function createPlanToolHandlers(config: PlanToolConfig): Record<string, ToolHandler> {
	return { read_plan: createReadPlan(config), write_plan: createWritePlan(config) }
}
