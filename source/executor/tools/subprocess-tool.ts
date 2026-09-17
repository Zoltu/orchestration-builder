import { truncateToolOutput } from '../context-policy.js'
import { createToolError } from '../errors.js'
import type { ToolResult } from '../types.js'

// Caps captured output so a noisy subprocess cannot blow up the tool result or the run log.
// The engine applies its own maxToolOutputChars truncation after serialization; this cap keeps the in-process string bounded before that point and reuses the same truncation helper + marker, per command and per stream.
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

interface StreamDrain {
	promise: Promise<string>
	cancel: () => Promise<void>
}

// Drains a pipe into a string. `cancel` stops waiting for the pipe to close and settles with what arrived so far: the timeout path's group kill normally reaps the whole tree and closes the pipes, but anything that escaped the group (a grandchild that double-detached into a new session) would keep a pipe open forever, so the timeout path must not wait for stream end.
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

// SIGKILLs the child's whole process group: the negative pid targets the group the detached child leads, so a shell's backgrounded grandchildren die with it instead of holding the pipes. The kill inherently races the child's own exit and POSIX has no atomic test-then-kill, so a failure is expected and non-actionable: ESRCH means the group is already gone, and anything else (a platform refusing negative-pid signaling) falls back to the direct-child kill. Neither failure may escape the timer callback — the timeout contract is the 'timeout' result, not a throw.
function killProcessTree(subprocess: Bun.Subprocess): void {
	try {
		process.kill(-subprocess.pid, 'SIGKILL')
	} catch {
		try {
			// The timeout contract is a hard stop: the process had the full timeout to finish, so the fallback escalates straight to SIGKILL.
			subprocess.kill('SIGKILL')
		} catch {
			// Both kills failed; the process is beyond reach and the 'timeout' result is still returned.
		}
	}
}

export function createBunSubprocessRunner(): SubprocessRunner {
	return async ({ command, cwd, timeoutMs }) => {
		// `detached` gives the child its own POSIX session and process group so the timeout path can signal the entire tree; without it only the direct child dies and a shell's detached grandchildren survive.
		const subprocess = Bun.spawn({
			cmd: [...command],
			cwd,
			stdout: 'pipe',
			stderr: 'pipe',
			detached: true,
		})
		// Start draining both pipes before awaiting exit so the child never blocks on a full pipe.
		const stdoutDrain = drainStream(subprocess.stdout)
		const stderrDrain = drainStream(subprocess.stderr)
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			killProcessTree(subprocess)
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
