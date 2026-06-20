export interface FormatOptions {
	reverse?: boolean
}

export function formatLines(lines: string[], _options?: FormatOptions): string {
	return lines.join('\n')
}
