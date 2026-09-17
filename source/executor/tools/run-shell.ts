import * as path from 'node:path'
import { createToolError } from '../errors.js'
import type { ToolHandler } from '../tool-dispatch.js'
import { resolveToolTimeoutSeconds, shellArgv, truncateStreams, type SubprocessData, type SubprocessOutcome, type SubprocessRunner } from './subprocess-tool.js'

export type RunShellData = SubprocessData

// run_shell is the free-form end of the tool surface: one model-chosen command, run as-is and returned as one raw payload. The checker tools are the semantic-wrapper end — the model still chooses the commands, but they run under a uniform discipline with structured per-command results (see docs/architecture.md "Tool surface").
export function createRunShell(
	workspaceRoot: string,
	defaultTimeoutSeconds: number,
	runner: SubprocessRunner,
): ToolHandler {
	const resolvedRoot = path.resolve(workspaceRoot)
	return async (args) => {
		const command = args['command']
		if (typeof command !== 'string' || command.trim() === '') {
			return createToolError('invalid_arguments', 'command must be a non-empty string')
		}
		const timeout = resolveToolTimeoutSeconds(args, defaultTimeoutSeconds)
		if (!timeout.ok) return timeout.error
		let outcome: SubprocessOutcome
		try {
			outcome = await runner({ command: shellArgv(command), cwd: resolvedRoot, timeoutMs: timeout.timeoutSeconds * 1000 })
		} catch (error) {
			const message = error instanceof Error ? error.message : 'spawn failed'
			return createToolError('unavailable', `command failed to run: ${message}`)
		}
		if (outcome.timedOut) {
			return createToolError('timeout', `command timed out after ${timeout.timeoutSeconds}s`, { afterSeconds: timeout.timeoutSeconds })
		}
		const streams = truncateStreams(outcome)
		const data: RunShellData = { exitCode: outcome.exitCode, stdout: streams.stdout, stderr: streams.stderr }
		return { kind: 'success', data }
	}
}
