import { suspendsChild } from '../suspending-tools.js'
import type { RunToolScope, ToolPlatform } from '../tool-platform-port.js'
import type { RoleDefinition, ToolCall, ToolResult } from '../types.js'
import { createBuiltInToolHandlers, OBSERVATION_TOOL_NAMES } from './builtin-tools.js'
import { createNativeToolHandlers } from './native-tools.js'
import { createPlanToolHandlers } from './plan.js'
import { createRunLogToolHandlers } from './run-log.js'
import { createStyleGuideToolHandlers } from './style-guide.js'
import { createToolDispatch, dispatchToolCall, type ToolHandler } from './tool-dispatch.js'
import type { Fetcher } from './fetch-url.js'
import type { SubprocessRunner } from '../subprocess.js'

export interface ToolPlatformConfig {
	workspaceRoot: string
	defaultToolTimeoutSeconds: number
	runsBaseDir: string
	runId: string
	logPath: string
	// Must match the engine's maxToolOutputChars so a write accepted within the delivery budget reads back whole.
	maxToolOutputChars: number
	kagiApiKey?: string
}

export interface ToolPlatformDependencies {
	subprocessRunner: SubprocessRunner
	fetcher?: Fetcher
}

export function createToolPlatform(config: ToolPlatformConfig, dependencies: ToolPlatformDependencies): ToolPlatform {
	const planHandlers = createPlanToolHandlers({ runsBaseDir: config.runsBaseDir, runId: config.runId, workspaceRoot: config.workspaceRoot, maxToolOutputChars: config.maxToolOutputChars })
	const styleGuideHandlers = createStyleGuideToolHandlers({ runsBaseDir: config.runsBaseDir, runId: config.runId, workspaceRoot: config.workspaceRoot, maxToolOutputChars: config.maxToolOutputChars })
	const runLogHandlers = createRunLogToolHandlers({ logPath: config.logPath })

	function composeHandlers(runScope: RunToolScope): Record<string, ToolHandler> {
		const nativeHandlers = createNativeToolHandlers({
			workspaceRoot: config.workspaceRoot,
			defaultToolTimeoutSeconds: config.defaultToolTimeoutSeconds,
			fetcher: dependencies.fetcher,
			kagiApiKey: config.kagiApiKey,
			subprocessRunner: dependencies.subprocessRunner,
			baseTracker: runScope.baseTracker,
		})
		const builtInHandlers = createBuiltInToolHandlers({
			spawnAgent: runScope.spawnAgent,
			continueAgent: runScope.continueAgent,
			roleState: runScope.roleState,
			humanBackend: runScope.humanBackend,
			contextWindow: runScope.contextWindow,
			roleRegistry: runScope.roleRegistry,
			ownRoleId: runScope.ownRoleId,
			appendLog: runScope.appendLog,
			parkTracker: runScope.parkTracker,
			...(runScope.handlerOf !== undefined ? { handlerOf: runScope.handlerOf } : {}),
		})
		// Built-ins spread last: platform invariants (finish, agent, ask_human, the context tools) are not shadowable by a role's allowed set or by any native handler that happens to collide on a key.
		return { ...nativeHandlers, ...planHandlers, ...styleGuideHandlers, ...runLogHandlers, ...builtInHandlers }
	}

	function handlerNames(runScope: RunToolScope): readonly string[] {
		return Object.keys(composeHandlers(runScope))
	}

	async function dispatch(roleDefinition: RoleDefinition, runScope: RunToolScope, call: ToolCall): Promise<ToolResult> {
		const dispatchTool = createToolDispatch(composeHandlers(runScope))
		return dispatchToolCall(
			{
				allowedTools: roleDefinition.tools,
				manifestNames: [...runScope.manifestNames],
				dispatch: dispatchTool,
			},
			call,
		)
	}

	return {
		handlerNames,
		dispatch,
		suspendsChild,
		observesRole: (toolName) => OBSERVATION_TOOL_NAMES.has(toolName),
	}
}
