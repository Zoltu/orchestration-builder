import { describe, expect, test } from 'bun:test'

import { parseCliArgs, usage, type ParseCliArgsOutcome } from './main-args.ts'

function parsed(outcome: ParseCliArgsOutcome) {
	expect(outcome.kind).toBe('parsed')
	if (outcome.kind !== 'parsed') throw new Error('expected parsed outcome')
	return outcome.args
}

describe('parseCliArgs', () => {
	test('parses a full set of flags', () => {
		const args = parsed(parseCliArgs([
			'--guild', 'guild', '--workspace', 'benchmarks/hello_001',
			'--task', 'write hello world', '--run-id', 'smoke-try', '--human-backend', 'stub',
		]))

		expect(args).toEqual({
			guildPath: 'guild',
			workspacePath: 'benchmarks/hello_001',
			task: 'write hello world',
			runId: 'smoke-try',
			humanBackend: 'stub',
		})
	})

	test('parses minimal required flags and leaves optionals undefined', () => {
		const args = parsed(parseCliArgs([
			'--guild', 'guild', '--workspace', 'benchmarks/hello_001', '--task', 'do it',
		]))

		expect(args.guildPath).toBe('guild')
		expect(args.workspacePath).toBe('benchmarks/hello_001')
		expect(args.task).toBe('do it')
		expect(args.runId).toBeUndefined()
		expect(args.humanBackend).toBeUndefined()
		expect(args.serve).toBeUndefined()
		expect(args.workspaceRoot).toBeUndefined()
	})

	test('accepts the --flag=value form', () => {
		const args = parsed(parseCliArgs([
			'--guild=guild', '--workspace=benchmarks/hello_001', '--task=do it', '--run-id=r1',
		]))

		expect(args.guildPath).toBe('guild')
		expect(args.workspacePath).toBe('benchmarks/hello_001')
		expect(args.task).toBe('do it')
		expect(args.runId).toBe('r1')
	})

	test('accepts all documented human-backend modes', () => {
		for (const mode of ['stub', 'foundry', 'web'] as const) {
			const args = parsed(parseCliArgs([
				'--guild', 'g', '--workspace', 'w', '--task', 't', '--human-backend', mode,
			]))
			expect(args.humanBackend).toBe(mode)
		}
	})

	test('returns a help request for -h and --help', () => {
		expect(parseCliArgs(['-h'])).toEqual({ kind: 'help' })
		expect(parseCliArgs(['--help'])).toEqual({ kind: 'help' })
	})

	test('reports every missing required flag', () => {
		const outcome = parseCliArgs([])
		expect(outcome.kind).toBe('error')
		if (outcome.kind === 'error') {
			expect(outcome.message).toContain('--guild')
			expect(outcome.message).toContain('--workspace')
			expect(outcome.message).toContain('--task')
		}
	})

	test('reports a subset of missing flags when some are present', () => {
		const outcome = parseCliArgs(['--guild', 'guild'])
		expect(outcome.kind).toBe('error')
		if (outcome.kind === 'error') {
			expect(outcome.message).not.toContain('--guild')
			expect(outcome.message).toContain('--workspace')
			expect(outcome.message).toContain('--task')
		}
	})

	test('rejects unknown flags', () => {
		const outcome = parseCliArgs([
			'--guild', 'g', '--workspace', 'w', '--task', 't', '--bogus', 'x',
		])
		expect(outcome.kind).toBe('error')
		if (outcome.kind === 'error') expect(outcome.message).toContain('Unknown flag')
	})

	test('rejects a value flag with no value', () => {
		const outcome = parseCliArgs(['--guild', 'g', '--workspace', 'w', '--task'])
		expect(outcome.kind).toBe('error')
		if (outcome.kind === 'error') expect(outcome.message).toContain('--task')
	})

	test('rejects an unexpected positional argument', () => {
		const outcome = parseCliArgs(['extra', '--guild', 'g', '--workspace', 'w', '--task', 't'])
		expect(outcome.kind).toBe('error')
		if (outcome.kind === 'error') expect(outcome.message).toContain('Unexpected argument')
	})

	test('rejects an invalid human-backend value', () => {
		const outcome = parseCliArgs([
			'--guild', 'g', '--workspace', 'w', '--task', 't', '--human-backend', 'carrier-pigeon',
		])
		expect(outcome.kind).toBe('error')
		if (outcome.kind === 'error') {
			expect(outcome.message).toContain('--human-backend')
			expect(outcome.message).toContain('carrier-pigeon')
		}
	})

	test('does not treat a help-like task value as a help request', () => {
		const args = parsed(parseCliArgs(['--guild', 'g', '--workspace', 'w', '--task', '--help']))
		expect(args.task).toBe('--help')
	})

	test('parses --serve <port> as an integer and keeps --human-backend web', () => {
		const args = parsed(parseCliArgs([
			'--guild', 'g', '--workspace', 'w', '--task', 't', '--serve', '8080', '--human-backend', 'web',
		]))
		expect(args.serve).toBe(8080)
		expect(args.humanBackend).toBe('web')
	})

	test('parses the --serve=<port> form', () => {
		const args = parsed(parseCliArgs(['--guild', 'g', '--workspace', 'w', '--task', 't', '--serve=3000']))
		expect(args.serve).toBe(3000)
	})

	test('leaves serve undefined when --serve is absent', () => {
		const args = parsed(parseCliArgs(['--guild', 'g', '--workspace', 'w', '--task', 't', '--human-backend', 'stub']))
		expect(args.serve).toBeUndefined()
	})

	test('rejects a non-numeric --serve value', () => {
		const outcome = parseCliArgs(['--guild', 'g', '--workspace', 'w', '--task', 't', '--serve', 'web'])
		expect(outcome.kind).toBe('error')
		if (outcome.kind === 'error') {
			expect(outcome.message).toContain('--serve')
			expect(outcome.message).toContain('web')
		}
	})

	test('rejects an out-of-range --serve value', () => {
		const outcome = parseCliArgs(['--guild', 'g', '--workspace', 'w', '--task', 't', '--serve', '70000'])
		expect(outcome.kind).toBe('error')
		if (outcome.kind === 'error') expect(outcome.message).toContain('--serve')
	})

	test('rejects --serve 0', () => {
		const outcome = parseCliArgs(['--guild', 'g', '--workspace', 'w', '--task', 't', '--serve', '0'])
		expect(outcome.kind).toBe('error')
		if (outcome.kind === 'error') expect(outcome.message).toContain('--serve')
	})

	test('in serve mode, --workspace and --task are optional', () => {
		const args = parsed(parseCliArgs(['--guild', 'guild', '--serve', '8080']))
		expect(args.guildPath).toBe('guild')
		expect(args.serve).toBe(8080)
		expect(args.workspacePath).toBeUndefined()
		expect(args.task).toBeUndefined()
	})

	test('in serve mode, --task may bootstrap the first run', () => {
		const args = parsed(parseCliArgs(['--guild', 'guild', '--serve', '8080', '--task', 'bootstrap']))
		expect(args.serve).toBe(8080)
		expect(args.task).toBe('bootstrap')
		expect(args.workspacePath).toBeUndefined()
	})

	test('parses --workspace-root in serve mode', () => {
		const args = parsed(parseCliArgs([
			'--guild', 'guild', '--serve', '8080', '--workspace-root', '/projects/my-app',
		]))
		expect(args.serve).toBe(8080)
		expect(args.workspaceRoot).toBe('/projects/my-app')
	})

	test('parses the --workspace-root=path form', () => {
		const args = parsed(parseCliArgs([
			'--guild', 'guild', '--serve', '8080', '--workspace-root=/workspace',
		]))
		expect(args.workspaceRoot).toBe('/workspace')
	})

	test('in serve mode, missing --guild reports only --guild (not --workspace/--task)', () => {
		const outcome = parseCliArgs(['--serve', '8080'])
		expect(outcome.kind).toBe('error')
		if (outcome.kind === 'error') {
			expect(outcome.message).toContain('--guild')
			expect(outcome.message).not.toContain('--workspace')
			expect(outcome.message).not.toContain('--task')
		}
	})

	test('rejects an unknown flag even in serve mode', () => {
		const outcome = parseCliArgs(['--guild', 'g', '--serve', '8080', '--bogus', 'x'])
		expect(outcome.kind).toBe('error')
		if (outcome.kind === 'error') expect(outcome.message).toContain('Unknown flag')
	})
})

describe('usage', () => {
	test('mentions every required flag, the serve-mode flags, and the API-key environment variable', () => {
		const text = usage()
		expect(text).toContain('--guild')
		expect(text).toContain('--workspace')
		expect(text).toContain('--task')
		expect(text).toContain('--run-id')
		expect(text).toContain('--human-backend')
		expect(text).toContain('--serve')
		expect(text).toContain('--workspace-root')
		expect(text).toContain('ORCHESTRATOR_API_KEY')
	})
})
