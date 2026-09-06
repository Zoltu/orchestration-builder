import * as path from 'node:path'
import { createGuildLoader } from '../executor/loader.ts'
import { resolveModelConfig } from '../executor/model-resolution.ts'
import { renderConfig } from './render.ts'
import { createLabelResolver } from './static/labels.js'

// Loads the real seed guild (plus its deployment file, the loader's second input) and builds the label resolver over the exact shape `GET /api/config` produces, so the view tests render against the same localization the live harness uses — not a parallel fixture that could drift from the guild. The deployment loads file-shaped, so the model is completed the same way serve.ts completes it before rendering; a missing model field fails the fixture loudly rather than rendering an incomplete view. The guild is a checked-in fixture read once at module load; the loader is the same leaf the data gate exercises, so this is a read-only integration over deterministic data, not a network or external-service call.
const repoRoot = path.resolve(import.meta.dir, '..', '..')
const guildDir = path.join(repoRoot, 'guild')
const deploymentPath = path.join(repoRoot, 'deployment', 'deployment.json')
const loaded = createGuildLoader(deploymentPath)(guildDir)
const deployment = {
	model: resolveModelConfig(loaded.deployment.model),
	executor: loaded.deployment.executor,
	contextPolicy: loaded.deployment.contextPolicy,
}
const config = renderConfig(loaded.config, deployment, loaded.tools)

export const labelsModule = createLabelResolver(config)
