import { createToolError } from '../errors.js'
import type { ToolHandler } from '../tool-dispatch.js'
import { createSubprocessTool, type CommandSource, type SubprocessData, type SubprocessRunner } from './subprocess-tool.js'

export type RunShellData = SubprocessData

// run_shell exists to run a model-chosen command, so unlike the checker tools the argv is built from the validated `command` argument rather than pinned in the leaf. `sh -c` gives real shell semantics (pipes, redirects, `&&`); containment is the deployment environment's job, not an in-tool allowlist.
const commandFromArgs: CommandSource = (args) => {
	const command = args['command']
	if (typeof command !== 'string' || command.trim() === '') {
		return { ok: false, error: createToolError('invalid_arguments', 'command must be a non-empty string') }
	}
	return { ok: true, command: ['sh', '-c', command] }
}

export function createRunShell(
	workspaceRoot: string,
	defaultTimeoutSeconds: number,
	runner: SubprocessRunner,
): ToolHandler {
	return createSubprocessTool({ command: commandFromArgs, noun: 'command' }, workspaceRoot, defaultTimeoutSeconds, runner)
}
