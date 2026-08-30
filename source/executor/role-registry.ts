import type { RoleState } from './engine-state.js'

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
	// restoredId is the resume path: the entry re-registers under its checkpoint-preserved id so histories, log events, and handler tasks that reference it stay valid across a restart. A collision with a live id is a bug (or a corrupt seed) and fails fast.
	register(roleName: string, depth: number, parentRoleId: string | undefined, roleState: RoleState, restoredId?: string): RoleRegistryEntry
	lookup(roleId: string): RoleRegistryEntry | undefined
	unregister(roleId: string): void
	// The id counter, persisted in the run checkpoint so a resumed run seeds the registry past every id minted before the restart and fresh ids can never collide with preserved ones.
	counter(): number
}

// The per-run registry of live role instances. Instance ids distinguish multiple instances of the same role (two coders in one run) so a handler can target one exactly; parentRoleId links let the engine walk the active delegation chain (plan-modification routing). Run-scoped in-memory state; a resumed run rebuilds it from the checkpoint (restored ids, seeded counter).
export function createRoleRegistry(initialCounter: number = 0): RoleRegistry {
	const entries = new Map<string, RoleRegistryEntry>()
	let counter = initialCounter
	return {
		register(roleName, depth, parentRoleId, roleState, restoredId) {
			if (restoredId !== undefined && entries.has(restoredId)) {
				throw new Error(`role registry: restored id "${restoredId}" collides with a live entry`)
			}
			// Restored registrations do not advance the counter: it was seeded past every id minted before the restart, so only freshly minted ids consume new values.
			let roleId: string
			if (restoredId !== undefined) {
				roleId = restoredId
			} else {
				counter += 1
				roleId = `${roleName}-${depth}-${counter}`
			}
			const entry: RoleRegistryEntry = {
				roleId,
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
		counter() {
			return counter
		},
	}
}
