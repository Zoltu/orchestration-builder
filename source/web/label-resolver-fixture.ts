import * as path from 'node:path'
import { createGuildLoader } from '../executor/loader.ts'
import { resolveDeploymentConfig, type ModelApiProbe } from '../executor/model-resolution.ts'
import { renderConfig } from './render.ts'
import { createLabelResolver } from './static/labels.js'

// Loads the real seed guild (plus its deployment file, the loader's second input) and builds the label resolver over the exact shape `GET /api/config` produces, so the view tests render against the same localization the live harness uses — not a parallel fixture that could drift from the guild. The deployment loads file-shaped, so the model is completed through the same shared resolveDeploymentConfig serve.ts uses; here without a probe (checked-in data must be complete on its own), so a missing model field fails the fixture loudly rather than rendering an incomplete view. The guild is a checked-in fixture read once at module load; the loader is the same leaf the data gate exercises, so this is a read-only integration over deterministic data, not a network or external-service call.
const repoRoot = path.resolve(import.meta.dir, '..', '..')
const guildDir = path.join(repoRoot, 'guild')
const deploymentPath = path.join(repoRoot, 'deployment', 'deployment.json')
const loaded = createGuildLoader(deploymentPath)(guildDir)
const probe: ModelApiProbe = { apiBase: loaded.deployment.model.apiBase, models: undefined, failureReason: undefined }
const { deployment } = resolveDeploymentConfig(loaded.deployment, probe)
const config = renderConfig(loaded.config, deployment, loaded.tools, null)

export const labelsModule = createLabelResolver(config)
