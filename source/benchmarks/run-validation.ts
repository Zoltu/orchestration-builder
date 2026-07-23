import * as fs from 'node:fs'
import * as path from 'node:path'
import { createBunSubprocessRunner, type SubprocessOutcome, type SubprocessRunner } from '../executor/tools/subprocess-tool.js'
import type { BenchmarkRunOutput, ValidationSpec } from './validation.js'

export type RunValidation = (workspacePath: string, spec: ValidationSpec) => Promise<BenchmarkRunOutput>

function checkExpectedFiles(workspaceRoot: string, files: string[] | undefined): Record<string, boolean> {
	const present: Record<string, boolean> = {}
	if (files === undefined) return present
	for (const file of files) {
		present[file] = fs.existsSync(path.resolve(workspaceRoot, file))
	}
	return present
}

// The shared runner drains pipes and kills on timeout; validation commands run through `sh -c` so eval.json can carry pipelines. A spawn/read failure reads as an empty outcome rather than a rejection, matching the leaf's contract of always producing a BenchmarkRunOutput.
async function spawnValidationCommand(runner: SubprocessRunner, command: string, cwd: string, timeoutSeconds: number): Promise<SubprocessOutcome> {
	try {
		return await runner({ command: ['sh', '-c', command], cwd, timeoutMs: timeoutSeconds * 1000 })
	} catch {
		return { exitCode: null, stdout: '', stderr: '', timedOut: false }
	}
}

export function createRunValidation(defaultTimeoutSeconds: number): RunValidation {
	const runner = createBunSubprocessRunner()
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
		const spawned = await spawnValidationCommand(runner, spec.command, resolvedWorkspace, timeoutSeconds)
		return {
			exitCode: spawned.exitCode,
			stdout: spawned.stdout,
			stderr: spawned.stderr,
			timedOut: spawned.timedOut,
			expectedFilesPresent,
		}
	}
}
