export interface CommandResult {
	stdout: string
	exitCode: number
}

export function runCommand(_storePath: string, _args: string[]): CommandResult {
	return { stdout: '', exitCode: 0 }
}
