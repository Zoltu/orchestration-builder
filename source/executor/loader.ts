import * as fs from 'node:fs'
import * as path from 'node:path'
import { ValidationError } from '../shared/errors.js'
import type { GuildConfig, ToolManifest } from '../shared/types.js'
import { validateGuildConfig, validateToolManifest } from '../shared/validation.js'

export interface LoadedGuild {
	config: GuildConfig
	prompts: Record<string, string>
	tools: Record<string, ToolManifest>
}

export type LoadGuild = (guildDir: string) => LoadedGuild

function readRequiredFile(filePath: string, errorPath: string): string {
	try {
		return fs.readFileSync(filePath, 'utf8')
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		throw new ValidationError(errorPath, `cannot read file: ${reason}`)
	}
}

export function createGuildLoader(): LoadGuild {
	return (guildDir: string): LoadedGuild => {
		const guildJsonPath = path.join(guildDir, 'guild.json')
		const raw = readRequiredFile(guildJsonPath, 'guild.json')
		const parsed: unknown = JSON.parse(raw)
		validateGuildConfig(parsed)
		const config = parsed
		const prompts: Record<string, string> = {}
		for (const [roleName, role] of Object.entries(config.roles)) {
			const promptPath = path.join(guildDir, role.systemPrompt)
			prompts[roleName] = readRequiredFile(promptPath, `roles.${roleName}.systemPrompt`)
		}
		const tools: Record<string, ToolManifest> = {}
		for (const toolPath of config.tools) {
			const manifestPath = path.join(guildDir, toolPath)
			const rawManifest = readRequiredFile(manifestPath, `tools[${toolPath}]`)
			const parsedManifest: unknown = JSON.parse(rawManifest)
			validateToolManifest(parsedManifest)
			tools[parsedManifest.name] = parsedManifest
		}
		for (const [roleName, role] of Object.entries(config.roles)) {
			for (let i = 0; i < role.tools.length; i++) {
				const toolName = role.tools[i]
				if (toolName === undefined) continue
				if (tools[toolName] === undefined) {
					throw new ValidationError(
						`roles.${roleName}.tools[${i}]`,
						`references unknown tool "${toolName}" (not declared in guild.json "tools" list)`,
					)
				}
			}
		}
		return { config, prompts, tools }
	}
}