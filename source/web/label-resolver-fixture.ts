import * as path from 'node:path'
import { createGuildLoader } from '../executor/loader.ts'
import { renderConfig } from './render.ts'
import { createLabelResolver } from './static/labels.js'

// Loads the real seed guild and builds the label resolver over the exact shape `GET /api/config` produces, so the view tests render against the same localization the live harness uses — not a parallel fixture that could drift from the guild. The guild is a checked-in fixture read once at module load; the loader is the same leaf `seed-guild.test.ts` exercises, so this is a read-only integration over deterministic data, not a network or external-service call.
const guildDir = path.resolve(import.meta.dir, '..', '..', 'guild')
const loaded = createGuildLoader()(guildDir)
const config = renderConfig(loaded.config, loaded.tools)

export const labelsModule = createLabelResolver(config)