import type { EffortLevel } from './types.js'

// The effort channel's bounds and the run-level default applied when neither a per-run override nor a project setting fixes the effort.
export const EFFORT_MIN = 0
export const EFFORT_MAX = 5
export const DEFAULT_EFFORT: EffortLevel = 3

// Builds the effort directive injected into the entry role's initial context.
// The string is a documented contract the Guild prompts branch on (see docs/reference.md "Effort channel"); changing it changes what prompts must match, so it is centralized here rather than inlined at the injection site.
// The integer is the contract; the parenthetical only describes the axis in generic terms so the executor makes no domain decision about what "fast" or "thorough" concretely means — that mapping is Guild-defined.
export function effortDirective(effort: EffortLevel): string {
	return `Quality level: ${effort} of ${EFFORT_MAX} (higher = more careful, slower, more thorough; lower = faster, more direct).`
}
