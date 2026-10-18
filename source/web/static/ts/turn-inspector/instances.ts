import { isObject } from '../guards.js'
import { readEventIndex, readInstanceId } from './values.js'

// One agent instance present in the loaded event window, as the instance dropdown renders it.
export interface InstanceRecord {
	roleId: string
	role: string
	// The parent instance's id when an event names it; null when absent or unknown.
	parentRoleId: string | null
	// The parent role's name; null for the entry role or unknown.
	parentRole: string | null
	// True while no `role_finished` for the instance is in the window (a start whose finish has paged out still reads live — the window is all the modal knows).
	live: boolean
}

// One breadcrumb crumb: an instance on the delegation chain from the chain root down to the scoped instance.
export interface ChainCrumb {
	roleId: string
	role: string
}

// The distinct agent instances in a window of log events, in first-appearance order. Real instances come from `role_start` (which also carries the parent linkage) and are marked finished by `role_finished`; turn events whose payload carries no `roleId` ensure a role-name fallback instance whose live flag follows its newest turn event.
export function instancesOf(logEvents: unknown): InstanceRecord[] {
	if (!Array.isArray(logEvents)) return []
	const instances = new Map<string, InstanceRecord>()
	const realIds = new Set<string>()
	for (const event of logEvents) {
		if (!isObject(event)) continue
		const type = event['type']
		const payload = event['payload']
		if (!isObject(payload)) continue
		if (type === 'role_start' || type === 'role_finished') {
			const roleId = readInstanceId(payload['roleId'])
			const role = readInstanceId(payload['role'])
			if (roleId === null || role === null) continue
			const known = instances.get(roleId)
			if (type === 'role_start') {
				if (known === undefined) {
					instances.set(roleId, { roleId, role, parentRoleId: readInstanceId(payload['parentRoleId']), parentRole: readInstanceId(payload['parent']), live: true })
				}
			} else if (known === undefined) {
				instances.set(roleId, { roleId, role, parentRoleId: null, parentRole: readInstanceId(payload['parent']), live: false })
			} else {
				known.live = false
			}
			realIds.add(roleId)
			continue
		}
		if (type !== 'llm_call' && type !== 'llm_call_start') continue
		const role = readInstanceId(payload['role'])
		if (role === null) continue
		const payloadRoleId = readInstanceId(payload['roleId'])
		if (payloadRoleId !== null) {
			if (!realIds.has(payloadRoleId) && !instances.has(payloadRoleId)) {
				instances.set(payloadRoleId, { roleId: payloadRoleId, role, parentRoleId: null, parentRole: null, live: true })
			}
			continue
		}
		instances.set(role, { roleId: role, role, parentRoleId: null, parentRole: null, live: type === 'llm_call_start' })
	}
	return [...instances.values()]
}

// A `role_start` the chain walk can climb through: the map keys hold the instance ids, so the record carries only linkage and ordering.
interface RoleStart {
	role: string
	parentRoleId: string | null
	parentRole: string | null
	depth: number | null
	position: number
}

// The delegation chain for `roleId` as far as the loaded window allows: the instance's own `role_start` event walks up through its parent linkage — the exact `parentRoleId` when the payload names it, else (old logs) the latest earlier `role_start` of the parent role at depth − 1. An ancestor outside the window ends the walk; a roleId with no `role_start` renders as a lone crumb. Cycles in malformed logs end the walk too.
export function deriveInstanceChain(logEvents: unknown, roleId: unknown): ChainCrumb[] {
	if (typeof roleId !== 'string' || roleId === '') return []
	if (!Array.isArray(logEvents)) return [{ roleId, role: roleId }]
	const starts = new Map<string, RoleStart>()
	const turnRoles = new Map<string, string>()
	let position = 0
	for (const event of logEvents) {
		if (!isObject(event)) continue
		const payload = event['payload']
		if (!isObject(payload)) continue
		if (event['type'] === 'role_start') {
			const startRoleId = readInstanceId(payload['roleId'])
			const role = readInstanceId(payload['role'])
			if (startRoleId === null || role === null) continue
			if (!starts.has(startRoleId)) {
				const rawDepth = payload['depth']
				starts.set(startRoleId, {
					role,
					parentRoleId: readInstanceId(payload['parentRoleId']),
					parentRole: readInstanceId(payload['parent']),
					depth: typeof rawDepth === 'number' && Number.isFinite(rawDepth) ? rawDepth : null,
					position,
				})
			}
			position += 1
			continue
		}
		if (event['type'] !== 'llm_call' && event['type'] !== 'llm_call_start') continue
		const startRoleId = readInstanceId(payload['roleId'])
		const role = readInstanceId(payload['role'])
		if (startRoleId !== null && role !== null) turnRoles.set(startRoleId, role)
	}
	const own = starts.get(roleId)
	const chain: ChainCrumb[] = [{ roleId, role: own !== undefined ? own.role : turnRoles.get(roleId) ?? roleId }]
	if (own === undefined) return chain
	const visited = new Set<string>([roleId])
	let current: RoleStart & { roleId: string } = { roleId, ...own }
	while (true) {
		const parent = resolveParentStart(current, starts, visited)
		if (parent === null) break
		chain.unshift({ roleId: parent.roleId, role: parent.role })
		visited.add(parent.roleId)
		current = parent
	}
	return chain
}

// The parent's `role_start` for the walk above, or null when the chain ends: the exact parent instance when the payload names its id and the window holds its start; otherwise the name-and-depth heuristic for logs whose starts carry no `parentRoleId`.
function resolveParentStart(start: RoleStart & { roleId: string }, starts: Map<string, RoleStart>, visited: Set<string>): (RoleStart & { roleId: string }) | null {
	if (start.parentRoleId !== null) {
		if (visited.has(start.parentRoleId)) return null
		const exact = starts.get(start.parentRoleId)
		return exact !== undefined ? { roleId: start.parentRoleId, ...exact } : null
	}
	if (start.parentRole === null || start.depth === null) return null
	let best: (RoleStart & { roleId: string }) | null = null
	for (const [candidateId, candidate] of starts) {
		if (visited.has(candidateId)) continue
		if (candidate.role !== start.parentRole) continue
		if (candidate.depth === null || candidate.depth !== start.depth - 1) continue
		if (candidate.position >= start.position) continue
		if (best === null || candidate.position > best.position) best = { roleId: candidateId, ...candidate }
	}
	return best
}

// The child instance an `agent` tool call spawned, or null: the first `role_start` after the turn's event whose `parentRoleId` names the parent instance. Old logs whose `role_start` predates per-instance parent ids fall back to the parent role-name echo (`parent`).
export function childInstanceFor(logEvents: unknown, parentRoleId: unknown, afterEventIndex: unknown): string | null {
	if (!Array.isArray(logEvents)) return null
	if (typeof parentRoleId !== 'string' || parentRoleId === '') return null
	if (typeof afterEventIndex !== 'number' || !Number.isInteger(afterEventIndex) || afterEventIndex < 0) return null
	for (const event of logEvents) {
		if (!isObject(event)) continue
		if (event['type'] !== 'role_start') continue
		const index = readEventIndex(event['index'])
		if (index === null || index <= afterEventIndex) continue
		const payload = event['payload']
		if (!isObject(payload)) continue
		const roleId = readInstanceId(payload['roleId'])
		if (roleId === null) continue
		const exactParent = readInstanceId(payload['parentRoleId'])
		if (exactParent !== null) {
			if (exactParent === parentRoleId) return roleId
			continue
		}
		if (payload['parent'] === parentRoleId) return roleId
	}
	return null
}
