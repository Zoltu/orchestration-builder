// Suite-validity guard: loads every benchmark's eval.json with parseEvalConfig and asserts each is valid and each referenced initial file (the README.md task description that is copied into the run workspace) exists and is non-empty.
// This guards the suite data without running the executor.
// It mirrors the data-validity style of source/executor/seed-guild.test.ts and source/executor/tool-manifests.test.ts, which read repo fixtures directly.

import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseEvalConfig } from './validation.ts'

const benchmarksDir = path.resolve(import.meta.dir, '..', '..', 'benchmarks')

function listBenchmarkDirectories(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(dir, entry.name))
		.sort()
}

function readJson(filePath: string): unknown {
	const raw = fs.readFileSync(filePath, 'utf8')
	return JSON.parse(raw)
}

describe('benchmark suite data', () => {
	const benchmarkDirs = listBenchmarkDirectories(benchmarksDir)

	test('the suite contains the smoke benchmark plus at least four quick-fix benchmarks', () => {
		expect(benchmarkDirs.length).toBeGreaterThanOrEqual(5)
		expect(benchmarkDirs.map((dir) => path.basename(dir))).toContain('hello_001')
	})

	test('the suite contains at least two medium benchmarks requiring multi-file decomposition', () => {
		const mediumNames = benchmarkDirs
			.filter((dir) => parseEvalConfig(readJson(path.join(dir, 'eval.json'))).taskType === 'medium')
			.map((dir) => path.basename(dir))
			.sort()
		expect(mediumNames.length).toBeGreaterThanOrEqual(2)
		for (const name of ['add_cli_flag', 'feature_add_endpoint', 'refactor_extract_module']) {
			expect(mediumNames).toContain(name)
		}
	})

	test('the suite contains at least one large benchmark requiring multi-file decomposition and the full toolchain', () => {
		const largeNames = benchmarkDirs
			.filter((dir) => parseEvalConfig(readJson(path.join(dir, 'eval.json'))).taskType === 'large')
			.map((dir) => path.basename(dir))
			.sort()
		expect(largeNames.length).toBeGreaterThanOrEqual(1)
		expect(largeNames).toContain('project_todo_cli')
	})

	for (const benchmarkDir of benchmarkDirs) {
		const name = path.basename(benchmarkDir)

		describe(name, () => {
			test('eval.json exists and parses as a valid EvalConfig', () => {
				const evalPath = path.join(benchmarkDir, 'eval.json')
				expect(fs.existsSync(evalPath)).toBe(true)
				const config = parseEvalConfig(readJson(evalPath))
				expect(config.taskType.length).toBeGreaterThan(0)
				expect(config.description.length).toBeGreaterThan(0)
				expect(config.validation.command.length).toBeGreaterThan(0)
			})

			test('README.md exists as the task description and is non-empty', () => {
				const readmePath = path.join(benchmarkDir, 'README.md')
				expect(fs.existsSync(readmePath)).toBe(true)
				const content = fs.readFileSync(readmePath, 'utf8').trim()
				expect(content.length).toBeGreaterThan(0)
			})
		})
	}
})
