import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { validateToolManifest } from './validation.ts'
import type { ToolManifest } from './types.js'
import { createToolHandlers } from './tools.ts'
import { createBuiltInToolHandlers } from './builtin-tools.ts'
import { stubHumanBackend } from './test-fixtures.ts'

const manifestDir = path.resolve(import.meta.dir, '..', '..', 'guild', 'tools')

interface ExpectedSignature {
	file: string
	required: string[]
	properties: string[]
}

const expectedSignatures: ExpectedSignature[] = [
	{ file: 'list_directory.json', required: [], properties: ['path'] },
	{ file: 'glob_files.json', required: ['pattern'], properties: ['pattern'] },
	{ file: 'read_file.json', required: ['path'], properties: ['path'] },
	{ file: 'read_file_partial.json', required: ['path', 'offset', 'limit'], properties: ['path', 'offset', 'limit'] },
	{ file: 'search_text.json', required: ['pattern'], properties: ['pattern', 'paths'] },
	{ file: 'write_file.json', required: ['path', 'content'], properties: ['path', 'content'] },
	{ file: 'fetch_url.json', required: ['url'], properties: ['url'] },
	{ file: 'typecheck.json', required: [], properties: ['timeoutSeconds'] },
	{ file: 'test.json', required: [], properties: ['timeoutSeconds'] },
	{ file: 'agent.json', required: ['role', 'task'], properties: ['role', 'task', 'budget'] },
	{ file: 'finish.json', required: ['status', 'summary'], properties: ['status', 'summary', 'artifacts', 'error'] },
	{ file: 'context_info.json', required: [], properties: [] },
	{ file: 'edit_context.json', required: ['operations'], properties: ['operations'] },
	{ file: 'ask_human.json', required: ['question'], properties: ['question', 'context'] },
]

function loadManifest(file: string): ToolManifest {
	const raw = fs.readFileSync(path.join(manifestDir, file), 'utf8')
	const parsed: unknown = JSON.parse(raw)
	validateToolManifest(parsed)
	return parsed
}

describe('canonical tool manifests', () => {
	test('the guild/tools directory contains exactly the expected manifest files', () => {
		const actual = fs.readdirSync(manifestDir).sort()
		const expected = expectedSignatures.map((s) => s.file).sort()
		expect(actual).toEqual(expected)
	})

	for (const signature of expectedSignatures) {
		test(`${signature.file} validates as a ToolManifest with the expected parameter signature`, () => {
			const manifest = loadManifest(signature.file)
			expect(manifest.parameters.type).toBe('object')
			expect(manifest.parameters.required ?? []).toEqual(signature.required)
			const declared = Object.keys(manifest.parameters.properties ?? {}).sort()
			expect(declared).toEqual([...signature.properties].sort())
		})
	}

	test('every manifest name is unique', () => {
		const names = expectedSignatures.map((s) => loadManifest(s.file).name)
		expect(new Set(names).size).toBe(names.length)
	})

	test('native tool manifest names match the native handler table from createToolHandlers', () => {
		const nativeNames = new Set(['list_directory', 'glob_files', 'read_file', 'read_file_partial', 'search_text', 'write_file', 'fetch_url', 'typecheck', 'test'])
		const handlers = createToolHandlers({ workspaceRoot: manifestDir, defaultToolTimeoutSeconds: 30 })
		expect(new Set(Object.keys(handlers))).toEqual(nativeNames)
		for (const file of expectedSignatures) {
			const manifest = loadManifest(file.file)
			if (nativeNames.has(manifest.name)) {
				expect(handlers).toHaveProperty(manifest.name)
			}
		}
	})

	test('built-in tool manifest names match the built-in handler table from createBuiltInToolHandlers', () => {
		const builtInNames = new Set(['agent', 'finish', 'context_info', 'edit_context', 'ask_human'])
		const handlers = createBuiltInToolHandlers({
			spawnAgent: async () => ({ status: 'success', summary: '' }),
			roleState: {
				history: [],
				toolCalls: 0,
				promptTokens: 0,
				completionTokens: 0,
				cachedPromptTokens: 0,
				lastPromptTokens: 0,
				recentToolCalls: [],
				recentCompactionPromptTokens: [],
			},
			humanBackend: stubHumanBackend,
			contextWindow: 1000,
		})
		expect(new Set(Object.keys(handlers))).toEqual(builtInNames)
		for (const file of expectedSignatures) {
			const manifest = loadManifest(file.file)
			if (builtInNames.has(manifest.name)) {
				expect(handlers).toHaveProperty(manifest.name)
			}
		}
	})
})
