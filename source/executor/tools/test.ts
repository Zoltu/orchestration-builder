import type { ToolHandler } from '../tool-dispatch.js'
import { createCheckerTool, type CheckerData } from './checker-tool.js'
import type { SubprocessRunner } from './subprocess-tool.js'

export type TestData = CheckerData

// Naming and prompt wording stay generic ("test", "the workspace test suite") so the guild does not over-fit to a specific toolchain; the commands to run are the model's survey decision at run time (see docs/architecture.md "Tool surface").
export function createTest(
	workspaceRoot: string,
	defaultTimeoutSeconds: number,
	runner: SubprocessRunner,
): ToolHandler {
	return createCheckerTool({ noun: 'test' }, workspaceRoot, defaultTimeoutSeconds, runner)
}
