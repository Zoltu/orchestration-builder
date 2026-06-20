import { runCommand } from './commands.js'

const storePath = process.env.TODO_STORE ?? 'todos.json'
const args = process.argv.slice(2)
const result = runCommand(storePath, args)
process.stdout.write(`${result.stdout}\n`)
process.exit(result.exitCode)
