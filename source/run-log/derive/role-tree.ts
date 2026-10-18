import type { LogEvent } from '../../executor/types.js'
import { isObject } from '../../executor/validation.js'
import { topOf } from '../payload.js'

export interface RoleTreeNode {
	role: string
	depth: number
	parent: string | null
	// Terminal status from the matching role_finished event, or null when the role is still in progress or its finish event is absent.
	status: string | null
	summary: string | null
	active: boolean
	children: RoleTreeNode[]
}

export function deriveRoleTree(logEvents: LogEvent[]): RoleTreeNode[] | null {
	let sawTreeEvent = false
	for (const event of logEvents) {
		if (event.type === 'role_start' || event.type === 'role_finished' || event.type === 'agent_call') {
			sawTreeEvent = true
			break
		}
	}
	if (!sawTreeEvent) return null

	const roots: RoleTreeNode[] = []
	// The active path: top is the deepest in-flight role. A role_start pushes; a role_finished pops the matching entry and records its status.
	const stack: RoleTreeNode[] = []

	for (const event of logEvents) {
		if (event.type === 'role_start') {
			const payload = event.payload
			if (!isObject(payload)) continue
			const roleValue = payload['role']
			if (typeof roleValue !== 'string') continue
			const depthValue = payload['depth']
			const depth = typeof depthValue === 'number' ? depthValue : 0
			const parentRole = topOf(stack)?.role ?? null
			const node: RoleTreeNode = {
				role: roleValue,
				depth,
				parent: parentRole,
				status: null,
				summary: null,
				active: false,
				children: [],
			}
			const parentNode = topOf(stack)
			if (parentNode !== undefined) {
				parentNode.children.push(node)
			} else {
				roots.push(node)
			}
			stack.push(node)
		} else if (event.type === 'role_finished') {
			const payload = event.payload
			if (!isObject(payload)) continue
			const roleValue = payload['role']
			if (typeof roleValue !== 'string') continue
			const statusValue = payload['status']
			const status = typeof statusValue === 'string' ? statusValue : null
			const summaryValue = payload['summary']
			const summary = typeof summaryValue === 'string' ? summaryValue : null
			// Find the topmost in-flight entry for this role. In a well-formed depth-first log the top of the stack matches; a partial log (torn read mid-write) may have skipped a child's finish, so we search down and pop the abandoned children too rather than crash.
			let matchIndex = -1
			for (let i = stack.length - 1; i >= 0; i--) {
				if (stack[i]?.role === roleValue) {
					matchIndex = i
					break
				}
			}
			const matched = matchIndex >= 0 ? stack[matchIndex] : undefined
			if (matched === undefined) continue
			matched.status = status
			matched.summary = summary
			stack.length = matchIndex
		}
	}

	// The active invocation is the deepest in-flight role (the stack top): the one currently executing. A waiting parent is in-flight but suspended, so it must not pulse.
	const activeNode = topOf(stack)
	if (activeNode !== undefined) activeNode.active = true
	return roots
}
