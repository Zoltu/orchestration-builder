// Pure CLI argument parser for the executor entry point.
// `main.ts` is the integration shell and is not unit-tested; this module holds the testable surface.
// It takes the argv slice (the tokens after the program name) and returns either parsed options, a help request, or a clear error.
// It performs no I/O and touches no globals.

export type HumanBackendMode = 'stub' | 'foundry' | 'web'

export interface ParsedCliArgs {
	guildPath: string
	workspacePath?: string
	task?: string
	runId?: string
	humanBackend?: HumanBackendMode
	serve?: number
	workspaceRoot?: string
}

export type ParseCliArgsOutcome =
	| { kind: 'parsed'; args: ParsedCliArgs }
	| { kind: 'help' }
	| { kind: 'error'; message: string }

const VALUE_FLAGS = ['--guild', '--workspace', '--task', '--run-id', '--human-backend', '--serve', '--workspace-root'] as const
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
		'Usage: bun source/main.ts --guild <path> [run mode | serve mode]',
		'',
		'Run mode (one run per process):',
		'  --workspace <path>        Path to the workspace copied into the run. (required in run mode)',
		'  --task <text>             Task description handed to the entry role. (required in run mode)',
		'',
		'Serve mode (long-running service, one task at a time, no queue):',
		'  --serve <port>            Start the web UI on <port>; implies --human-backend web so the',
		'                            operator can answer ask_human questions in the browser.',
		'  --workspace-root <path>   Project mounted into every run (defaults to /workspace).',
		'  --task <text>             Optional: bootstrap the first run at startup.',
		'',
		'Common options:',
		'  --guild <path>            Path to the Guild directory (contains guild.json). (required)',
		'  --run-id <id>             Run id; auto-generated as a timestamp when omitted. (run mode only)',
		'  --human-backend <mode>    Backend for ask_human (stub|foundry|web); defaults to stub. (run mode only)',
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
	const serveRaw = values['--serve']
	const inServeMode = serveRaw !== undefined

	if (guildPath === undefined || (!inServeMode && (workspacePath === undefined || task === undefined))) {
		const missing: string[] = []
		if (guildPath === undefined) missing.push('--guild')
		if (!inServeMode) {
			if (workspacePath === undefined) missing.push('--workspace')
			if (task === undefined) missing.push('--task')
		}
		return { kind: 'error', message: `Missing required flag(s): ${missing.join(', ')}` }
	}

	const args: ParsedCliArgs = { guildPath }
	if (workspacePath !== undefined) args.workspacePath = workspacePath
	if (task !== undefined) args.task = task

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

	const workspaceRoot = values['--workspace-root']
	if (workspaceRoot !== undefined) args.workspaceRoot = workspaceRoot

	return { kind: 'parsed', args }
}
