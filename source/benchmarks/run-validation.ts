

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { BenchmarkRunOutput, ValidationSpec } from './validation.js'

export type RunValidation = (workspacePath: string, spec: ValidationSpec) => Promise<BenchmarkRunOutput>

interface SpawnOutcome {
	exitCode: number | null
	stdout: string
	stderr: string
	timedOut: boolean
}

function checkExpectedFiles(workspaceRoot: string, files: string[] | undefined): Record<string, boolean> {
	const present: Record<string, boolean> = {}
	if (files === undefined) return present
	for (const file of files) {
		present[file] = fs.existsSync(path.resolve(workspaceRoot, file))
	}
	return present
}

async function readStreamSafe(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
	if (stream === null || stream === undefined) return ''
	try {
		return await new Response(stream).text()
	} catch {
		return ''
	}
}

function spawnWithTimeout(command: string, cwd: string, timeoutSeconds: number): Promise<SpawnOutcome> {
	return new Promise((resolve) => {
		const subprocess = Bun.spawn({
			cmd: ['sh', '-c', command],
			cwd,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		let settled = false
		const finish = (outcome: SpawnOutcome): void => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve(outcome)
		}
		const timer = setTimeout(() => {
			subprocess.kill()
			finish({ exitCode: null, stdout: '', stderr: '', timedOut: true })
		}, timeoutSeconds * 1000)
		void (async () => {
			try {
				const exitCode = await subprocess.exited
				const stdout = await readStreamSafe(subprocess.stdout)
				const stderr = await readStreamSafe(subprocess.stderr)
				finish({ exitCode, stdout, stderr, timedOut: false })
			} catch {
				finish({ exitCode: null, stdout: '', stderr: '', timedOut: false })
			}
		})()
	})
}

export function createRunValidation(defaultTimeoutSeconds: number): RunValidation {
	return async (workspacePath, spec) => {
		const resolvedWorkspace = path.resolve(workspacePath)
		const timeoutSeconds = spec.timeoutSeconds ?? defaultTimeoutSeconds
		const expectedFilesPresent = checkExpectedFiles(resolvedWorkspace, spec.expectedFiles)
		if (!fs.existsSync(resolvedWorkspace)) {
			return {
				exitCode: null,
				stdout: '',
				stderr: '',
				timedOut: false,
				expectedFilesPresent,
			}
		}
		const spawned = await spawnWithTimeout(spec.command, resolvedWorkspace, timeoutSeconds)
		return {
			exitCode: spawned.exitCode,
			stdout: spawned.stdout,
			stderr: spawned.stderr,
			timedOut: spawned.timedOut,
			expectedFilesPresent,
		}
	}
}
