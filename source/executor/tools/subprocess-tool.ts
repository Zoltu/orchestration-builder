import * as path from 'node:path'
import { truncateToolOutput } from '../context-policy.js'
import { createToolError } from '../errors.js'
import type { ToolHandler } from '../tool-dispatch.js'
import type { ToolResult } from '../types.js'

// Caps captured output so a noisy subprocess cannot blow up the tool result or the run log.
// The engine applies its own maxToolOutputChars truncation after serialization; this cap keeps the in-process string bounded before that point and reuses the same truncation helper + marker.
const MAX_OUTPUT_CHARS = 8192

export interface SubprocessData {
	exitCode: number | null
	stdout: string
	stderr: string
}

export interface SubprocessOutcome {
	exitCode: number | null
	stdout: string
	stderr: string
	timedOut: boolean
}

export type SubprocessRunner = (options: {
	command: readonly string[]
	cwd: string
	timeoutMs: number
}) => Promise<SubprocessOutcome>

export type CommandResolution =
	| { ok: true; command: readonly string[] }
	| { ok: false; error: ToolResult }

// A fixed argv for tools the model must not influence (the checkers: the command is pinned in the leaf, not the manifest); a resolver for the tool whose whole purpose is running a model-chosen command (run_shell) — the resolver validates the arguments and builds the argv, returning an error result rather than throwing.
export type CommandSource = readonly string[] | ((args: Record<string, unknown>) => CommandResolution)

export interface SubprocessToolConfig {
	command: CommandSource
	// The noun used in error messages ("typecheck", "test", "command") so the model reads which invocation failed or timed out.
	noun: string
}

// The shared machinery behind the subprocess tools: timeout validation (the caller may lower but never raise the executor cap), spawn, and output capture. A non-zero exit is a normal result the role reads and iterates on; only spawn/IO failure and timeout surface as error kinds.
export function createSubprocessTool(
	toolConfig: SubprocessToolConfig,
	workspaceRoot: string,
	defaultTimeoutSeconds: number,
	runner: SubprocessRunner,
): ToolHandler {
	const resolvedRoot = path.resolve(workspaceRoot)
	return async (args) => {
		const source = toolConfig.command
		const resolved: CommandResolution = typeof source === 'function' ? source(args) : { ok: true, command: source }
		if (!resolved.ok) return resolved.error
		const requested = args['timeoutSeconds']
		let timeoutSeconds = defaultTimeoutSeconds
		if (requested !== undefined) {
			if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
				return createToolError('invalid_arguments', 'timeoutSeconds must be a positive finite number')
			}
			timeoutSeconds = Math.min(requested, defaultTimeoutSeconds)
		}
		let outcome: SubprocessOutcome
		try {
			outcome = await runner({
				command: resolved.command,
				cwd: resolvedRoot,
				timeoutMs: timeoutSeconds * 1000,
			})
		} catch (error) {
			const message = error instanceof Error ? error.message : 'spawn failed'
			return createToolError('invalid_arguments', `${toolConfig.noun} failed to run: ${message}`)
		}
		if (outcome.timedOut) {
			return createToolError('timeout', `${toolConfig.noun} timed out after ${timeoutSeconds}s`, { afterSeconds: timeoutSeconds })
		}
		const data: SubprocessData = {
			exitCode: outcome.exitCode,
			stdout: truncateToolOutput(outcome.stdout, MAX_OUTPUT_CHARS).text,
			stderr: truncateToolOutput(outcome.stderr, MAX_OUTPUT_CHARS).text,
		}
		return { kind: 'success', data }
	}
}

interface StreamDrain {
	promise: Promise<string>
	cancel: () => Promise<void>
}

// Drains a pipe into a string. `cancel` stops waiting for the pipe to close and settles with what arrived so far: a killed child's own children keep the pipes open (a shell's grandchildren outlive it), so the timeout path must not wait for stream end.
function drainStream(stream: ReadableStream<Uint8Array> | undefined): StreamDrain {
	if (stream === undefined) return { promise: Promise.resolve(''), cancel: () => Promise.resolve() }
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	let text = ''
	const promise = (async () => {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			text += decoder.decode(value, { stream: true })
		}
		return text + decoder.decode()
	})()
	return { promise, cancel: () => reader.cancel() }
}

export function createBunSubprocessRunner(): SubprocessRunner {
	return async ({ command, cwd, timeoutMs }) => {
		const subprocess = Bun.spawn({
			cmd: [...command],
			cwd,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		// Start draining both pipes before awaiting exit so the child never blocks on a full pipe.
		const stdoutDrain = drainStream(subprocess.stdout)
		const stderrDrain = drainStream(subprocess.stderr)
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			subprocess.kill()
		}, timeoutMs)
		let exitCode: number | null
		try {
			exitCode = await subprocess.exited
		} finally {
			clearTimeout(timer)
		}
		if (timedOut) {
			await stdoutDrain.cancel()
			await stderrDrain.cancel()
		}
		const stdout = await stdoutDrain.promise
		const stderr = await stderrDrain.promise
		return { exitCode, stdout, stderr, timedOut }
	}
}
