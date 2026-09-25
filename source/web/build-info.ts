// The serving image's build identifier, baked by the Dockerfile into /app/build-info.json from the BUILD_SHA build arg plus `date -u` (see the Dockerfile "BUILD_SHA" step).

import * as fs from 'node:fs'

import { isObject } from '../executor/validation.js'

export interface BuildInfo {
	// Present only when the build passed a non-empty BUILD_SHA; the Dockerfile bakes an empty string when it did not.
	sha?: string
	builtAt: string
}

// Validates and shapes a parsed build-info document: unknown sibling fields are dropped (they must not leak into the GET /api/config response) and an empty sha reads as "the build had none", exactly as the Dockerfile bakes it.
export function parseBuildInfo(value: unknown): BuildInfo | null {
	if (!isObject(value)) return null
	if (typeof value.builtAt !== 'string' || value.builtAt === '') return null
	const sha = typeof value.sha === 'string' && value.sha !== '' ? value.sha : undefined
	return sha === undefined ? { builtAt: value.builtAt } : { builtAt: value.builtAt, sha }
}

// The tolerant read leaf (same style as persistence.ts createReadProjectSettings): the file is read once at startup, and a missing file (running from a source checkout, which never has a baked build-info) or a malformed one degrades to null rather than failing startup — the identifier is display metadata, not configuration.
export function createBuildInfoReader(filePath: string): () => BuildInfo | null {
	return () => {
		if (!fs.existsSync(filePath)) return null
		let text: string
		try {
			text = fs.readFileSync(filePath, 'utf8')
		} catch {
			return null
		}
		let parsed: unknown
		try {
			parsed = JSON.parse(text)
		} catch {
			return null
		}
		return parseBuildInfo(parsed)
	}
}
