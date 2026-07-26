import type { RoleState } from './engine.js'

export type InterruptActionKind = 'continue' | 'redirect' | 'abort'

export interface InterruptAction {
	action: InterruptActionKind
	reason: string
}

export interface RoleRegistryEntry {
	roleId: string
	roleName: string
	depth: number
	parentRoleId?: string
	roleState: RoleState
	// Set by a handler's trigger_interrupt call while the target is suspended; the target's drain applies it once the handler finishes.
	interruptAction?: InterruptAction
	// Plan-modification routing marks. planAbort unwinds the role with an interrupted card at its next safe point; planInjection is the modification text the plan owner receives at its next safe point.
	planAbort?: boolean
	planInjection?: string
}

export interface RoleRegistry {
	register(roleName: string, depth: number, parentRoleId: string | undefined, roleState: RoleState): RoleRegistryEntry
	lookup(roleId: string): RoleRegistryEntry | undefined
	unregister(roleId: string): void
}

// The per-run registry of live role instances. Instance ids distinguish multiple instances of the same role (two coders in one run) so a handler can target one exactly; parentRoleId links let the engine walk the active delegation chain (plan-modification routing). Not persisted — run-scoped in-memory state.
export function createRoleRegistry(): RoleRegistry {
	const entries = new Map<string, RoleRegistryEntry>()
	let counter = 0
	return {
		register(roleName, depth, parentRoleId, roleState) {
			counter += 1
			const entry: RoleRegistryEntry = {
				roleId: `${roleName}-${depth}-${counter}`,
				roleName,
				depth,
				...(parentRoleId !== undefined ? { parentRoleId } : {}),
				roleState,
			}
			entries.set(entry.roleId, entry)
			return entry
		},
		lookup(roleId) {
			return entries.get(roleId)
		},
		unregister(roleId) {
			entries.delete(roleId)
		},
	}
}
