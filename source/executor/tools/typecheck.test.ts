import { describe, expect, test } from 'bun:test'
import { type SubprocessRunner } from './subprocess-tool.ts'
import { createTypecheck, type TypecheckData } from './typecheck.ts'
import { toolData } from '../test-fixtures.ts'
import { isObject } from '../validation.ts'

interface RunnerCall {
	command: readonly string[]
	cwd: string
	timeoutMs: number
}

interface ScriptedOutcome {
	exitCode?: number | null
	stdout?: string
	stderr?: string
	timedOut?: boolean
	throwMessage?: string
}

function makeScriptedRunner(script: ScriptedOutcome[]): SubprocessRunner & { calls: RunnerCall[] } {
	const calls: RunnerCall[] = []
	const runner: SubprocessRunner & { calls: RunnerCall[] } = async (options) => {
		calls.push(options)
		const scripted = script[calls.length - 1] ?? {}
		if (scripted.throwMessage !== undefined) throw new Error(scripted.throwMessage)
		return {
			exitCode: scripted.exitCode !== undefined ? scripted.exitCode : 0,
			stdout: scripted.stdout ?? '',
			stderr: scripted.stderr ?? '',
			timedOut: scripted.timedOut ?? false,
		}
	}
	runner.calls = calls
	return runner
}

const WORKSPACE = '/fake/workspace'

function isTypecheckData(value: unknown): value is TypecheckData {
	return Array.isArray(value) && value.every((entry) => isObject(entry) && typeof entry['command'] === 'string' && typeof entry['stdout'] === 'string' && typeof entry['stderr'] === 'string' && (typeof entry['exitCode'] === 'number' || entry['exitCode'] === null))
}

describe('createTypecheck', () => {
	test('passes the given commands through the checker machinery and returns per-command results', async () => {
		const diagnostics = 'src/index.ts(3,7): error TS2322: Type "number" is not assignable to type "string".'
		const runner = makeScriptedRunner([{ exitCode: 1, stdout: diagnostics }, { exitCode: 0 }])
		const handler = createTypecheck(WORKSPACE, 30, runner)
		const result = await handler({ commands: ['bun --bun tsc --noEmit', 'tsc --noEmit'] })
		expect(result.kind).toBe('success')
		const data = toolData(result, isTypecheckData)
		expect(data[0]?.command).toBe('bun --bun tsc --noEmit')
		expect(data[0]?.stdout).toContain('error TS2322')
		expect(data[1]?.command).toBe('tsc --noEmit')
	})

	test('errors name the typecheck tool', async () => {
		const runner = makeScriptedRunner([{ throwMessage: 'ENOENT tsc' }])
		const handler = createTypecheck(WORKSPACE, 30, runner)
		const result = await handler({ commands: ['tsc --noEmit'] })
		expect(result.kind).toBe('unavailable')
		if (result.kind === 'unavailable' && typeof result.message === 'string') {
			expect(result.message.startsWith('typecheck failed to run "tsc --noEmit"')).toBe(true)
			expect(result.message).toContain('ENOENT tsc')
		}
	})
})
