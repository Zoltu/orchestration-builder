import * as path from 'node:path'
import { truncateToolOutput } from '../context-policy.js'
import { createToolError } from '../../shared/errors.js'
import type { ToolHandler } from '../tool-dispatch.js'
import type { SubprocessOutcome, SubprocessRunner } from './typecheck.js'

// The command is fixed in the leaf, not in the manifest, so the model cannot influence it.
// Naming and prompt wording stay generic ("test", "the workspace test suite") so the guild
// does not over-fit to a specific toolchain.
const TEST_COMMAND: readonly string[] = ['bun', 'test']

// Caps captured output so a noisy test run cannot blow up the tool result or the run log. The
// engine applies its own maxToolOutputChars truncation after serialization; this cap keeps the
// in-process string bounded before that point and reuses the same truncation helper + marker.
const MAX_OUTPUT_CHARS = 8192

export interface TestData {
	exitCode: number | null
	stdout: string
	stderr: string
}

export function createTest(
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
				command: TEST_COMMAND,
				cwd: resolvedRoot,
				timeoutMs: timeoutSeconds * 1000,
			})
		} catch (error) {
			const message = error instanceof Error ? error.message : 'spawn failed'
			return createToolError('invalid_arguments', `test failed to run: ${message}`)
		}
		if (outcome.timedOut) {
			return createToolError('timeout', `test timed out after ${timeoutSeconds}s`, { afterSeconds: timeoutSeconds })
		}
		// A non-zero exit (a failing test suite) is a normal result the role reads and iterates on;
		// only spawn/IO failure and timeout surface as error kinds.
		const data: TestData = {
			exitCode: outcome.exitCode,
			stdout: truncateToolOutput(outcome.stdout, MAX_OUTPUT_CHARS).text,
			stderr: truncateToolOutput(outcome.stderr, MAX_OUTPUT_CHARS).text,
		}
		return { kind: 'success', data }
	}
}
