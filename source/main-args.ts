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
	serve?: number
}

export type ParseCliArgsOutcome =
	| { kind: 'parsed'; args: ParsedCliArgs }
	| { kind: 'help' }
	| { kind: 'error'; message: string }

const VALUE_FLAGS = ['--guild', '--workspace', '--task', '--run-id', '--human-backend', '--serve'] as const
const HELP_FLAGS = new Set(['-h', '--help'])
const HUMAN_BACKEND_MODES: readonly HumanBackendMode[] = ['stub', 'foundry', 'web']
const MIN_PORT = 1
const MAX_PORT = 65535

function isValueFlag(name: string): boolean {
	return VALUE_FLAGS.some((flag) => flag === name)
}

function isHumanBackendMode(value: string): value is HumanBackendMode {
	return HUMAN_BACKEND_MODES.some((mode) => mode === value)
}

// Accepts only plain decimal digit strings so forms like `0x1a`, `1e3`, `8080.0`, or ` 8080 ` are rejected rather than silently coerced by Number().
function parsePort(value: string): number | undefined {
	if (!/^\d+$/.test(value)) return undefined
	const port = Number(value)
	if (port < MIN_PORT || port > MAX_PORT) return undefined
	return port
}

export function usage(): string {
	return [
		'Usage: bun source/main.ts --guild <path> --workspace <path> --task <text>',
		'                       [--run-id <id>] [--human-backend <stub|foundry|web>] [--serve <port>]',
		'',
		'Required options:',
		'  --guild <path>            Path to the Guild directory (contains guild.json).',
		'  --workspace <path>        Path to the workspace copied into the run.',
		'  --task <text>             Task description handed to the entry role.',
		'',
		'Optional options:',
		'  --run-id <id>             Run id; auto-generated as a timestamp when omitted.',
		'  --human-backend <mode>    Backend for ask_human (stub|foundry|web); defaults to stub.',
		'  --serve <port>            Start the web UI on <port>; implies --human-backend web so the operator can answer ask_human questions in the browser.',
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

	const serveRaw = values['--serve']
	if (serveRaw !== undefined) {
		const port = parsePort(serveRaw)
		if (port === undefined) {
			return {
				kind: 'error',
				message: `--serve must be an integer port between ${MIN_PORT} and ${MAX_PORT} (got "${serveRaw}")`,
			}
		}
		args.serve = port
	}

	return { kind: 'parsed', args }
}
