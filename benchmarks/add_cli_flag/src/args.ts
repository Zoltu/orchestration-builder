export interface CliOptions {
	count: number | null
	reverse: boolean
}

export function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = { count: null, reverse: false }
	for (let i = 0; i < argv.length; i++) {
		const argument = argv[i]
		if (argument === undefined) continue
		if (argument === '--count') {
			i++
			const next = argv[i]
			if (next === undefined) {
				throw new Error('Missing value for --count')
			}
			options.count = Number(next)
			continue
		}
		if (argument.startsWith('--count=')) {
			options.count = Number(argument.slice('--count='.length))
			continue
		}
		if (argument === '--reverse') {
			options.reverse = true
			continue
		}
		throw new Error(`Unknown argument: ${argument}`)
	}
	return options
}
