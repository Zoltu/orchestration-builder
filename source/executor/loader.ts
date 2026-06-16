// Leaf factory for loading a Guild from disk.
// Reads guild.json, the prompt Markdown files referenced by each role, and the tool
// manifest JSON files referenced by guild.json. Validates everything using the
// shared validate* functions and returns a fully resolved Guild.

import * as fs from 'node:fs'
import * as path from 'node:path'

import type { GuildConfig, ToolManifest } from '../shared/types.js'
import { validateGuildConfig, validateToolManifest } from '../shared/validation.js'

export interface LoadedGuild {
	config: GuildConfig
	prompts: Record<string, string>
	tools: Record<string, ToolManifest>
}

export interface GuildLoader {
	load(guildDir: string): LoadedGuild
}

export function createGuildLoader(): GuildLoader {
	function load(guildDir: string): LoadedGuild {
		const guildJsonPath = path.join(guildDir, 'guild.json')
		const raw = fs.readFileSync(guildJsonPath, 'utf8')
		const parsed: unknown = JSON.parse(raw)
		validateGuildConfig(parsed)
		const config = parsed
		const prompts: Record<string, string> = {}
		for (const [roleName, role] of Object.entries(config.roles)) {
			const promptPath = path.join(guildDir, role.systemPrompt)
			prompts[roleName] = fs.readFileSync(promptPath, 'utf8')
		}
		const tools: Record<string, ToolManifest> = {}
		for (const toolPath of config.tools) {
			const manifestPath = path.join(guildDir, toolPath)
			const rawManifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
			validateToolManifest(rawManifest)
			tools[rawManifest.name] = rawManifest
		}
		return { config, prompts, tools }
	}
	return { load }
}
