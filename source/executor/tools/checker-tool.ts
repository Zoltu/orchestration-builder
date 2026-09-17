import * as path from 'node:path'
import { createToolError } from '../errors.js'
import type { ToolHandler } from '../tool-dispatch.js'
import type { ToolResult } from '../types.js'
import { resolveToolTimeoutSeconds, shellArgv, truncateStreams, type SubprocessOutcome, type SubprocessRunner } from './subprocess-tool.js'

export interface CheckerCommandResult {
	command: string
	exitCode: number | null
	stdout: string
	stderr: string
	// Present only on the entry of a command that timed out: its exit code is null and its streams hold what was captured before the kill. A timed-out entry never appears in a success result — the tool answers with a 'timeout' error carrying it in the details.
	timedOut?: boolean
}

export type CheckerData = CheckerCommandResult[]

export interface CheckerToolConfig {
	// The noun used in error messages ("typecheck", "test") so the model reads which checker failed or timed out.
	noun: string
}

type CommandListResolution = { ok: true; commands: string[] } | { ok: false; error: ToolResult }

// Bounded envelope for one checker call: 16 commands under a per-command timeout clamped to the executor default means a single invocation cannot run unbounded work (see docs/reference.md "Checker tools").
const MAX_COMMANDS = 16

// Parses and validates the whole `commands` argument up front, so an invalid element anywhere in the array spawns nothing.
function parseCheckerCommands(args: Record<string, unknown>): CommandListResolution {
	const commands = args['commands']
	if (!Array.isArray(commands)) {
		return { ok: false, error: createToolError('invalid_arguments', 'commands must be a non-empty array of non-empty strings') }
	}
	if (commands.length > MAX_COMMANDS) {
		return { ok: false, error: createToolError('invalid_arguments', `commands must have at most ${MAX_COMMANDS} entries`) }
	}
	const parsed: string[] = []
	for (const entry of commands) {
		if (typeof entry !== 'string' || entry.trim() === '') {
			return { ok: false, error: createToolError('invalid_arguments', 'commands must be a non-empty array of non-empty strings') }
		}
		parsed.push(entry)
	}
	if (parsed.length === 0) {
		return { ok: false, error: createToolError('invalid_arguments', 'commands must be a non-empty array of non-empty strings') }
	}
	return { ok: true, commands: parsed }
}

// The checker tools (`typecheck`, `test`) are semantic wrappers over the shared subprocess machinery: the model chooses the commands, but each one runs under the same uniform discipline — `sh -c` in the workspace root, a per-command clamped timeout, truncated per-command streams, and a structured result per command. `run_shell` is the free-form counterpart (one raw command, one raw payload). See docs/architecture.md "Tool surface".
export function createCheckerTool(
	toolConfig: CheckerToolConfig,
	workspaceRoot: string,
	defaultTimeoutSeconds: number,
	runner: SubprocessRunner,
): ToolHandler {
	const resolvedRoot = path.resolve(workspaceRoot)
	return async (args) => {
		const commands = parseCheckerCommands(args)
		if (!commands.ok) return commands.error
		const timeout = resolveToolTimeoutSeconds(args, defaultTimeoutSeconds)
		if (!timeout.ok) return timeout.error
		const results: CheckerCommandResult[] = []
		for (const command of commands.commands) {
			let outcome: SubprocessOutcome
			try {
				outcome = await runner({ command: shellArgv(command), cwd: resolvedRoot, timeoutMs: timeout.timeoutSeconds * 1000 })
			} catch (error) {
				const message = error instanceof Error ? error.message : 'spawn failed'
				return createToolError('unavailable', `${toolConfig.noun} failed to run "${command}": ${message}`, { command, results })
			}
			const streams = truncateStreams(outcome)
			if (outcome.timedOut) {
				const timedOutEntry: CheckerCommandResult = { command, exitCode: outcome.exitCode, stdout: streams.stdout, stderr: streams.stderr, timedOut: true }
				const resultsIncludingTimedOut = [...results, timedOutEntry]
				return createToolError('timeout', `${toolConfig.noun} timed out after ${timeout.timeoutSeconds}s on "${command}"`, { command, afterSeconds: timeout.timeoutSeconds, results: resultsIncludingTimedOut })
			}
			results.push({ command, exitCode: outcome.exitCode, stdout: streams.stdout, stderr: streams.stderr })
		}
		return { kind: 'success', data: results }
	}
}
