import type { ToolHandler } from '../tool-dispatch.js'
import { createSubprocessTool, type SubprocessData, type SubprocessRunner } from './subprocess-tool.js'

// The command is fixed in the leaf, not in the manifest, so the model cannot influence it.
// Naming and prompt wording stay generic ("test", "the workspace test suite") so the guild does not over-fit to a specific toolchain.
const TEST_COMMAND: readonly string[] = ['bun', 'test']

export type TestData = SubprocessData

export function createTest(
	workspaceRoot: string,
	defaultTimeoutSeconds: number,
	runner: SubprocessRunner,
): ToolHandler {
	return createSubprocessTool({ command: TEST_COMMAND, noun: 'test' }, workspaceRoot, defaultTimeoutSeconds, runner)
}
