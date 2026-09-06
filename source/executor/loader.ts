import * as fs from 'node:fs'
import * as path from 'node:path'
import { ValidationError } from './errors.js'
import type { DeploymentConfig, GuildConfig, ToolManifest } from './types.js'
import { validateDeploymentConfig, validateDeploymentRoleReferences, validateGuildConfig, validateToolManifest } from './validation.js'

export interface LoadedGuild {
	config: GuildConfig
	deployment: DeploymentConfig
	prompts: Record<string, string>
	tools: Record<string, ToolManifest>
}

export type LoadGuild = (guildDir: string) => LoadedGuild

function readRequiredFile(filePath: string, errorPath: string): string {
	if (!fs.existsSync(filePath)) {
		throw new ValidationError(errorPath, `file not found: ${filePath}`)
	}
	try {
		return fs.readFileSync(filePath, 'utf8')
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		throw new ValidationError(errorPath, `cannot read file: ${reason}`)
	}
}

function readJsonFile(filePath: string, errorPath: string): unknown {
	return JSON.parse(readRequiredFile(filePath, errorPath))
}

// The deployment file path is fixed per service (it lives beside the guild in the bundle and is not per-run), so the factory closes over it and the returned LoadGuild keeps the guild-dir-only signature the executor's dependencies are built on.
export function createGuildLoader(deploymentFilePath: string): LoadGuild {
	return (guildDir: string): LoadedGuild => {
		const config = readJsonFile(path.join(guildDir, 'guild.json'), 'guild.json')
		validateGuildConfig(config)
		const deployment = readJsonFile(deploymentFilePath, 'deployment.json')
		validateDeploymentConfig(deployment)
		const roleNames = new Set(Object.keys(config.roles))
		validateDeploymentRoleReferences(deployment, roleNames)
		const prompts: Record<string, string> = {}
		for (const [roleName, role] of Object.entries(config.roles)) {
			const promptPath = path.join(guildDir, role.systemPrompt)
			prompts[roleName] = readRequiredFile(promptPath, `roles.${roleName}.systemPrompt`)
		}
		const tools: Record<string, ToolManifest> = {}
		for (const toolPath of config.tools) {
			const manifestPath = path.join(guildDir, toolPath)
			const manifest = readJsonFile(manifestPath, `tools[${toolPath}]`)
			validateToolManifest(manifest)
			tools[manifest.name] = manifest
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
		return { config, deployment, prompts, tools }
	}
}
