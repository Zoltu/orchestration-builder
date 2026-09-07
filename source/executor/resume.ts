import type { RunCheckpoint } from './checkpoint.js'
import type { ResumedRole, SuspendedTurn } from './engine.js'
import type { EngineContext, EngineDependencies } from './engine-state.js'
import type { LoadedGuild } from './loader.js'
import type { ResultCard } from './types.js'

// The resume driver: re-enters the checkpoint's role stack, letting the depth-first traversal continue. A frame with a pending suspension resolves its child card lazily from inside the suspended turn — either the recorded card, or the next frame's own resume — so the stack re-forms in the same root-first order the live recursion produces. The leaf frame re-enters at its loop top with its persisted state.
// runRole is threaded in by the engine so this module can drive role turns without importing the turn loop at runtime (the executor composes the two).
export async function resumeRoleStack(runRole: (deps: EngineDependencies, context: EngineContext, resumed?: ResumedRole) => Promise<ResultCard>, deps: EngineDependencies, loadedGuild: LoadedGuild, checkpoint: RunCheckpoint): Promise<ResultCard> {
	const resumeAt = async (index: number): Promise<ResultCard> => {
		const frame = checkpoint.frames[index]
		if (frame === undefined) throw new Error(`resumeRoleStack: frame ${index} missing from a checkpoint with ${checkpoint.frames.length} frames`)
		let suspendedTurn: SuspendedTurn | undefined
		if (frame.pending !== undefined) {
			const recorded = frame.pending.childCard
			suspendedTurn = {
				toolCalls: frame.pending.toolCalls,
				agentIndex: frame.pending.agentIndex,
				resolveChildCard: recorded !== undefined ? () => Promise.resolve(recorded) : () => resumeAt(index + 1),
			}
		}
		const context: EngineContext = {
			loadedGuild,
			depth: frame.depth,
			roleName: frame.roleName,
			task: frame.task,
			...(frame.parent !== undefined ? { parent: frame.parent } : {}),
			...(frame.parentRoleId !== undefined ? { parentRoleId: frame.parentRoleId } : {}),
			...(frame.effort !== undefined ? { effort: frame.effort } : {}),
		}
		return await runRole(deps, context, {
			roleId: frame.roleId,
			roleState: frame.roleState,
			...(frame.planAbort === true ? { planAbort: true } : {}),
			...(frame.planInjection !== undefined ? { planInjection: frame.planInjection } : {}),
			...(suspendedTurn !== undefined ? { suspendedTurn } : {}),
		})
	}
	return resumeAt(0)
}
