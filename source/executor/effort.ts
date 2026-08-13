import type { EffortLevel } from './types.js'

// The run-level default applied when neither a per-run override nor a project setting fixes the effort.
export const DEFAULT_EFFORT: EffortLevel = 'standard'

export function effortDirective(effort: EffortLevel): string {
	return `Quality level: ${effort} (one of quick, standard, thorough — quick is fastest and most direct; thorough is slowest and most careful).`
}
