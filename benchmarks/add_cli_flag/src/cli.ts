import { parseArgs } from './args.js'
import { formatLines } from './printer.js'

const tasks = ['water the plants', 'write the report', 'call the dentist']

function main(argv: string[]): void {
	const options = parseArgs(argv)
	const selected = options.count === null ? tasks : tasks.slice(0, options.count)
	const printed = formatLines(selected, options)
	console.log(printed)
}

main(process.argv.slice(2))
