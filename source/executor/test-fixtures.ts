import type { HumanBackend } from './human-backend.js'
import type { LoadedGuild } from './loader.js'
import type { GuildConfig, ToolManifest } from '../shared/types.js'

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