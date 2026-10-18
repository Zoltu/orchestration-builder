import { truncateToolOutput } from '../context/index.js'
import { createToolError } from '../errors.js'
import type { ToolResult } from '../types.js'
import type { SubprocessOutcome } from '../subprocess.js'

// Caps captured output so a noisy subprocess cannot blow up the tool result or the run log.
// The engine applies its own maxToolOutputChars truncation after serialization; this cap keeps the in-process string bounded before that point and reuses the same truncation helper + marker, per command and per stream.
const MAX_OUTPUT_CHARS = 8192

export interface SubprocessData {
	exitCode: number | null
	stdout: string
	stderr: string
}

export type TimeoutResolution = { ok: true; timeoutSeconds: number } | { ok: false; error: ToolResult }

// Shared timeout validation behind the subprocess tools: the caller may lower but never raise the executor cap, so a value above it clamps to the cap. Anything but a positive finite number is an invalid_arguments error.
export function resolveToolTimeoutSeconds(args: Record<string, unknown>, defaultTimeoutSeconds: number): TimeoutResolution {
	const requested = args['timeoutSeconds']
	if (requested === undefined) return { ok: true, timeoutSeconds: defaultTimeoutSeconds }
	if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
		return { ok: false, error: createToolError('invalid_arguments', 'timeoutSeconds must be a positive finite number') }
	}
	return { ok: true, timeoutSeconds: Math.min(requested, defaultTimeoutSeconds) }
}

// The uniform command discipline shared by the subprocess tools: a model-supplied command string runs through a real shell (`sh -c`), with the caller passing the workspace root as the working directory. Containment is the deployment environment's job, not an in-tool allowlist.
export function shellArgv(command: string): readonly string[] {
	return ['sh', '-c', command]
}

// Per-command, per-stream output cap shared by the subprocess tools: each command's streams are truncated before its result is serialized.
export function truncateStreams(outcome: SubprocessOutcome): { stdout: string; stderr: string } {
	return {
		stdout: truncateToolOutput(outcome.stdout, MAX_OUTPUT_CHARS).text,
		stderr: truncateToolOutput(outcome.stderr, MAX_OUTPUT_CHARS).text,
	}
}
