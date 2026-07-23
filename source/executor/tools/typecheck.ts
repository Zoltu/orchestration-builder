import type { ToolHandler } from '../tool-dispatch.js'
import { createSubprocessTool, type SubprocessData, type SubprocessRunner } from './subprocess-tool.js'

// Naming and prompt wording stay generic ("typecheck") so the guild does not over-fit to a specific toolchain; the command itself is fixed here in the leaf.
const TYPECHECK_COMMAND: readonly string[] = ['bun', '--bun', 'tsc', '--noEmit']

export type TypecheckData = SubprocessData

export function createTypecheck(
	workspaceRoot: string,
	defaultTimeoutSeconds: number,
	runner: SubprocessRunner,
): ToolHandler {
	return createSubprocessTool({ command: TYPECHECK_COMMAND, noun: 'typecheck' }, workspaceRoot, defaultTimeoutSeconds, runner)
}
