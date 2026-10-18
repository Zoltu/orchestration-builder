// Shared credential resolution across the configured channels: the environment variable first, then Docker secrets (the lowercase name, then the environment variable's name). Docker secrets are conventionally named in lowercase; the upper-snake variant covers deployments that mount the secret under the environment variable's name. An explicit environmentName renames only the environment channel (and with it the derived secret fallback) for credentials whose variable carries a prefix the secret name lacks — for example ORCHESTRATOR_KAGI_API_KEY over the secret kagi_api_key.
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface SecretChannels {
	environment: Record<string, string | undefined>
	readDockerSecret: (name: string) => string | undefined
}

function toUpperSnake(name: string): string {
	return name.replace(/-/g, '_').toUpperCase()
}

// A resolved value is returned to the caller and nothing more: no log line or error message here may embed it, so the module stays safe for credential material. Values are trimmed and an empty result is treated as unset so the lookup falls through to the next channel regardless of how a channel normalizes its raw input.
export function resolveSecret(name: string, channels: SecretChannels, environmentName?: string): string | undefined {
	const environmentVariable = environmentName ?? toUpperSnake(name)
	const fromEnvironment = channels.environment[environmentVariable]?.trim()
	if (fromEnvironment !== undefined && fromEnvironment !== '') return fromEnvironment
	const fromNamedSecret = channels.readDockerSecret(name)?.trim()
	if (fromNamedSecret !== undefined && fromNamedSecret !== '') return fromNamedSecret
	const fromEnvironmentNamedSecret = channels.readDockerSecret(environmentVariable)?.trim()
	if (fromEnvironmentNamedSecret !== undefined && fromEnvironmentNamedSecret !== '') return fromEnvironmentNamedSecret
	return undefined
}

export function createDockerSecretReader(secretsDir: string): (name: string) => string | undefined {
	return (name) => {
		const secretPath = path.join(secretsDir, name)
		if (!fs.existsSync(secretPath)) return undefined
		const contents = fs.readFileSync(secretPath, 'utf8').trim()
		if (contents === '') return undefined
		return contents
	}
}

export function resolveKagiApiKey(environment: Record<string, string | undefined>, readSecret: (name: string) => string | undefined): string | undefined {
	// The Docker-secret channel keeps the plain secret name (kagi_api_key, so /run/secrets/kagi_api_key works); only the environment variable carries the ORCHESTRATOR_ prefix.
	return resolveSecret('kagi_api_key', { environment, readDockerSecret: readSecret }, 'ORCHESTRATOR_KAGI_API_KEY')
}
