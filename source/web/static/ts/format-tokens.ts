// Formats a token count compactly: counts from 1000 up render in k with one decimal (1234 → "1.2k") and there is no larger unit, so a 262144-token context reads "262.1k". Shared by the run-stage SVG and the tooltip card so every token count the UI renders abbreviates the same way.
export function formatTokens(value: unknown): string {
	if (typeof value === 'number' && value >= 1000) return `${Math.round(value / 100) / 10}k`
	return String(value)
}
