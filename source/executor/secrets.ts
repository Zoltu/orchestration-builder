// Shared credential resolution across the configured channels: the environment variable named after the secret first, then Docker secrets (the lowercase name, then its upper-snake form). Docker secrets are conventionally named in lowercase; the upper-snake variant covers deployments that mount the secret under the environment variable's name.
export interface SecretChannels {
	environment: Record<string, string | undefined>
	readDockerSecret: (name: string) => string | undefined
}

function toUpperSnake(name: string): string {
	return name.replace(/-/g, '_').toUpperCase()
}

// A resolved value is returned to the caller and nothing more: no log line or error message here may embed it, so the module stays safe for credential material. Values are trimmed and an empty result is treated as unset so the lookup falls through to the next channel regardless of how a channel normalizes its raw input.
export function resolveSecret(name: string, channels: SecretChannels): string | undefined {
	const environmentName = toUpperSnake(name)
	const fromEnvironment = channels.environment[environmentName]?.trim()
	if (fromEnvironment !== undefined && fromEnvironment !== '') return fromEnvironment
	const fromNamedSecret = channels.readDockerSecret(name)?.trim()
	if (fromNamedSecret !== undefined && fromNamedSecret !== '') return fromNamedSecret
	const fromUpperSnakeSecret = channels.readDockerSecret(environmentName)?.trim()
	if (fromUpperSnakeSecret !== undefined && fromUpperSnakeSecret !== '') return fromUpperSnakeSecret
	return undefined
}
