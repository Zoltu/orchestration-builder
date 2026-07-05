import type { EffortLevel } from './types.js'

// The effort channel's bounds and the run-level default applied when neither a per-run override nor a project setting fixes the effort.
export const EFFORT_MIN = 0
export const EFFORT_MAX = 5
export const DEFAULT_EFFORT: EffortLevel = 3

export function effortDirective(effort: EffortLevel): string {
	return `Quality level: ${effort} of ${EFFORT_MAX} (higher = more careful, slower, more thorough; lower = faster, more direct).`
}
