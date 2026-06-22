import * as path from 'node:path'
import { truncateToolOutput } from '../context-policy.js'
import { createToolError } from '../errors.js'
import type { ToolHandler } from '../tool-dispatch.js'

// The command is fixed in the leaf, not in the manifest, so the model cannot influence it.
// Naming and prompt wording stay generic ("typecheck", "the workspace typechecker") so the guild
// does not over-fit to a specific toolchain.
const TYPECHECK_COMMAND: readonly string[] = ['bun', '--bun', 'tsc', '--noEmit']

// Caps captured output so a noisy typecheck cannot blow up the tool result or the run log. The
// engine applies its own maxToolOutputChars truncation after serialization; this cap keeps the
// in-process string bounded before that point and reuses the same truncation helper + marker.
const MAX_OUTPUT_CHARS = 8192

export interface TypecheckData {
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

export function createTypecheck(
	workspaceRoot: string,
	defaultTimeoutSeconds: number,
	runner: SubprocessRunner,
): ToolHandler {
	const resolvedRoot = path.resolve(workspaceRoot)
	return async (args) => {
		const requested = args['timeoutSeconds']
		let timeoutSeconds = defaultTimeoutSeconds
		if (requested !== undefined) {
			if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
				return createToolError('invalid_arguments', 'timeoutSeconds must be a positive finite number')
			}
			// The caller may lower the timeout but cannot raise it past the executor cap.
			timeoutSeconds = Math.min(requested, defaultTimeoutSeconds)
		}
		let outcome: SubprocessOutcome
		try {
			outcome = await runner({
				command: TYPECHECK_COMMAND,
				cwd: resolvedRoot,
				timeoutMs: timeoutSeconds * 1000,
			})
		} catch (error) {
			const message = error instanceof Error ? error.message : 'spawn failed'
			return createToolError('invalid_arguments', `typecheck failed to run: ${message}`)
		}
		if (outcome.timedOut) {
			return createToolError('timeout', `typecheck timed out after ${timeoutSeconds}s`, { afterSeconds: timeoutSeconds })
		}
		// A non-zero exit is a normal result the role reads and iterates on; only spawn/IO failure
		// and timeout surface as error kinds.
		const data: TypecheckData = {
			exitCode: outcome.exitCode,
			stdout: truncateToolOutput(outcome.stdout, MAX_OUTPUT_CHARS).text,
			stderr: truncateToolOutput(outcome.stderr, MAX_OUTPUT_CHARS).text,
		}
		return { kind: 'success', data }
	}
}

async function readStream(stream: ReadableStream<Uint8Array> | undefined): Promise<string> {
	if (stream === undefined) return ''
	return await new Response(stream).text()
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
		const stdoutPromise = readStream(subprocess.stdout)
		const stderrPromise = readStream(subprocess.stderr)
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
		const stdout = await stdoutPromise
		const stderr = await stderrPromise
		return { exitCode, stdout, stderr, timedOut }
	}
}
