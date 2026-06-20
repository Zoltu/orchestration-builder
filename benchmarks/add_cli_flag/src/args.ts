export interface CliOptions {
	count: number | null
	reverse: boolean
}

export function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = { count: null, reverse: false }
	for (const [index, argument] of argv.entries()) {
		if (argument === '--count') {
			options.count = Number(argv[index + 1])
			continue
		}
		if (argument.startsWith('--count=')) {
			options.count = Number(argument.slice('--count='.length))
			continue
		}
		// unknown arguments are ignored in v1; --reverse is not yet supported
	}
	return options
}
