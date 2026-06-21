// Pure CLI argument parser for the executor entry point.
// `main.ts` is the integration shell and is not unit-tested; this module holds the testable surface.
// It takes the argv slice (the tokens after the program name) and returns either parsed options, a help request, or a clear error.
// It performs no I/O and touches no globals.

export type HumanBackendMode = 'stub' | 'foundry' | 'web'

export interface ParsedCliArgs {
	guildPath: string
	workspacePath: string
	task: string
	runId?: string
	humanBackend?: HumanBackendMode
}

export type ParseCliArgsOutcome =
	| { kind: 'parsed'; args: ParsedCliArgs }
	| { kind: 'help' }
	| { kind: 'error'; message: string }

const VALUE_FLAGS = ['--guild', '--workspace', '--task', '--run-id', '--human-backend'] as const
const HELP_FLAGS = new Set(['-h', '--help'])
const HUMAN_BACKEND_MODES: readonly HumanBackendMode[] = ['stub', 'foundry', 'web']

function isValueFlag(name: string): boolean {
	return VALUE_FLAGS.some((flag) => flag === name)
}

function isHumanBackendMode(value: string): value is HumanBackendMode {
	return HUMAN_BACKEND_MODES.some((mode) => mode === value)
}

export function usage(): string {
	return [
		'Usage: bun source/main.ts --guild <path> --workspace <path> --task <text>',
		'                       [--run-id <id>] [--human-backend <stub|foundry|web>]',
		'',
		'Required options:',
		'  --guild <path>            Path to the Guild directory (contains guild.json).',
		'  --workspace <path>        Path to the workspace copied into the run.',
		'  --task <text>             Task description handed to the entry role.',
		'',
		'Optional options:',
		'  --run-id <id>             Run id; auto-generated as a timestamp when omitted.',
		'  --human-backend <mode>    Backend for ask_human (stub|foundry|web); defaults to stub.',
		'  -h, --help                Show this help message.',
		'',
		'The model API key is read from the ORCHESTRATOR_API_KEY environment variable',
		'and is never stored in the Guild.',
	].join('\n')
}

export function parseCliArgs(argv: string[]): ParseCliArgsOutcome {
	const values: Record<string, string> = {}

	let i = 0
	while (i < argv.length) {
		const token = argv[i]
		if (token === undefined) break

		if (HELP_FLAGS.has(token)) return { kind: 'help' }

		if (!token.startsWith('--')) {
			return { kind: 'error', message: `Unexpected argument: ${token}` }
		}

		const equalsIndex = token.indexOf('=')
		let name: string
		let inlineValue: string | undefined
		if (equalsIndex !== -1) {
			name = token.slice(0, equalsIndex)
			inlineValue = token.slice(equalsIndex + 1)
		} else {
			name = token
		}

		if (!isValueFlag(name)) {
			return { kind: 'error', message: `Unknown flag: ${name}` }
		}

		if (inlineValue === undefined) {
			const next = argv[i + 1]
			if (next === undefined) {
				return { kind: 'error', message: `Flag ${name} requires a value` }
			}
			values[name] = next
			i += 2
		} else {
			values[name] = inlineValue
			i++
		}
	}

	const guildPath = values['--guild']
	const workspacePath = values['--workspace']
	const task = values['--task']

	if (guildPath === undefined || workspacePath === undefined || task === undefined) {
		const missing: string[] = []
		if (guildPath === undefined) missing.push('--guild')
		if (workspacePath === undefined) missing.push('--workspace')
		if (task === undefined) missing.push('--task')
		return { kind: 'error', message: `Missing required flag(s): ${missing.join(', ')}` }
	}

	const args: ParsedCliArgs = {
		guildPath,
		workspacePath,
		task,
	}

	const runId = values['--run-id']
	if (runId !== undefined) args.runId = runId

	const humanBackendRaw = values['--human-backend']
	if (humanBackendRaw !== undefined) {
		if (!isHumanBackendMode(humanBackendRaw)) {
			return {
				kind: 'error',
				message: `--human-backend must be one of ${HUMAN_BACKEND_MODES.join(', ')} (got "${humanBackendRaw}")`,
			}
		}
		args.humanBackend = humanBackendRaw
	}

	return { kind: 'parsed', args }
}
