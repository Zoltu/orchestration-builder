import type { HumanBackend } from './human-backend.js'
import type { LlmCallResult, LlmCaller, LlmRequest } from './llm.js'
import type { LoadedGuild } from './loader.js'
import type { GuildConfig, ToolCall, ToolManifest } from './types.js'

export const stubHumanBackend: HumanBackend = {
	ask: async () => 'use your best judgement',
}

export interface RecordingHumanBackend extends HumanBackend {
	questions: Array<{ question: string; context?: string }>
}

export function recordingHumanBackend(): RecordingHumanBackend {
	const questions: Array<{ question: string; context?: string }> = []
	return {
		questions,
		ask: async (question, context) => {
			questions.push({ question, context })
			return 'use your best judgement'
		},
	}
}

export function withTool(guild: LoadedGuild, manifest: ToolManifest, manifestPath?: string): LoadedGuild {
	const tools = { ...guild.tools, [manifest.name]: manifest }
	const config: GuildConfig = {
		...guild.config,
		tools: manifestPath !== undefined ? [...guild.config.tools, manifestPath] : guild.config.tools,
	}
	return { config, prompts: guild.prompts, tools }
}

// A reusable scripted LLM caller for integration tests that must drive multiple roles through a real Guild.
// Responses are keyed by role name so the caller is robust to interleaving: a parent role's calls and a child role's calls can arrive in any order, and each role's queue advances independently.
// `resolveRole` discriminates which queue to draw from; `resolveRoleBySystemPrompt` is the standard discriminator, valid because the engine seeds each role's first message with its `systemPrompt` from the Guild, so the leading system message uniquely identifies the role.
export function createScriptedLlm(
	scripts: Record<string, LlmCallResult[]>,
	resolveRole: (request: LlmRequest) => string,
): LlmCaller {
	const queues: Record<string, LlmCallResult[]> = {}
	for (const [roleName, responses] of Object.entries(scripts)) {
		queues[roleName] = responses.slice()
	}
	return {
		async call(request): Promise<LlmCallResult> {
			const roleName = resolveRole(request)
			const queue = queues[roleName]
			if (queue === undefined) {
				throw new Error(`ScriptedLlm has no script for role: ${roleName}`)
			}
			const next = queue.shift()
			if (next === undefined) {
				throw new Error(`ScriptedLlm ran out of responses for role: ${roleName}`)
			}
			return next
		},
	}
}

export function resolveRoleBySystemPrompt(loadedGuild: LoadedGuild): (request: LlmRequest) => string {
	const promptToRole = new Map<string, string>()
	for (const [roleName, prompt] of Object.entries(loadedGuild.prompts)) {
		promptToRole.set(prompt, roleName)
	}
	return (request) => {
		const firstMessage = request.messages[0]
		if (firstMessage !== undefined && firstMessage.role === 'system') {
			const content = firstMessage.content
			// Exact match first (a non-entry role's system message is the prompt verbatim); then a
			// prefix match, because the entry role's system message is the prompt with the effort
			// directive merged onto it rather than a second system message.
			const exact = promptToRole.get(content)
			if (exact !== undefined) return exact
			for (const [prompt, roleName] of promptToRole) {
				if (content.startsWith(prompt)) return roleName
			}
		}
		throw new Error('ScriptedLlm could not resolve role from the request system prompt')
	}
}

export function toolCall(id: string, name: string, args: unknown): ToolCall {
	return {
		id,
		type: 'function',
		function: { name, arguments: JSON.stringify(args) },
	}
}

export function scriptedToolCallResponse(toolCalls: ToolCall[], content = ''): LlmCallResult {
	return {
		kind: 'success',
		content,
		reasoning: null,
		toolCalls,
		usage: { promptTokens: 12, completionTokens: 6 },
	}
}