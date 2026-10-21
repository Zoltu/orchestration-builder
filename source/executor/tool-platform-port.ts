import type { RunBaseTracker } from './base-state.js'
import type { HumanBackend } from './human-backend.js'
import type { AppendLog } from './persistence.js'
import type { RunParkTracker } from './park-state.js'
import type { RoleRegistry } from './role-registry.js'
import type { RoleState } from './state.js'
import type { ResultCard, RoleDefinition, ToolCall, ToolResult } from './types.js'
import type { ToolInvocation } from './invocation.js'

// The per-invocation state a role's tools need. The guild-derived values are passed per call rather than captured at construction so one platform can serve every role and guild in a run, including the offline fixture guild validate-data builds.
export interface RunToolScope {
	roleState: RoleState
	humanBackend: HumanBackend
	roleRegistry: RoleRegistry
	ownRoleId: string
	appendLog: AppendLog
	parkTracker: RunParkTracker
	baseTracker: RunBaseTracker
	handlerOf?: string
	contextWindow: number
	manifestNames: ReadonlySet<string>
	spawnAgent(roleName: string, task: string): Promise<ResultCard>
	continueAgent(roleName: string, comment: string | undefined, roleId: string | undefined): Promise<ResultCard>
}

// The tools module's public contract. dispatch reports failures in precedence order: a name not registered in the Guild is unknown_tool, a registered name outside the role's allowed set is invalid_tool_call, and malformed arguments are invalid_arguments before any handler runs. Built-ins are composed last, so their names are not shadowable by a role's allowed set or a colliding handler.
export interface ToolPlatform {
	// Returns the tool names the platform would dispatch for this scope without executing any handler; the offline data gate uses it to compare handler tables against the Guild manifests.
	handlerNames(runScope: RunToolScope): readonly string[]
	// Returns the unknown_tool / invalid_tool_call failure the dispatch would produce before any handler runs, or null when the call is dispatchable. The engine pre-checks with it so those diagnostics are not recorded as started invocations.
	validateCall(roleDefinition: RoleDefinition, runScope: RunToolScope, call: ToolCall): ToolResult | null
	dispatch(roleDefinition: RoleDefinition, runScope: RunToolScope, call: ToolCall, invocation: ToolInvocation): Promise<ToolResult>
	suspendsChild(toolName: string): boolean
	observesRole(toolName: string): boolean
}
