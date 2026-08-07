import * as fs from 'node:fs'
import * as path from 'node:path'
import { REPO_MAP_SOURCE_EXTENSIONS, extractSymbols, isRepoMapExcludedPath } from '../executor/tools/repo-map.js'

// A symbol-level map of the repository: one line per top-level declaration, grouped by file. The point is answering "what already exists here?" without loading the whole tree into context — the map is roughly an order of magnitude smaller than the sources it summarizes.
// The extraction core is shared with the executor's repo_map tool (source/executor/tools/repo-map.ts); this CLI adds only the directory walk and printing.

function collectSourceFiles(rootDir: string): string[] {
	const results: string[] = []
	function walk(directory: string): void {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const fullPath = path.join(directory, entry.name)
			if (entry.isDirectory()) {
				walk(fullPath)
				continue
			}
			if (!entry.isFile()) continue
			if (!REPO_MAP_SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue
			const relativePath = path.relative(rootDir, fullPath)
			if (isRepoMapExcludedPath(relativePath)) continue
			results.push(relativePath)
		}
	}
	walk(rootDir)
	return results.sort()
}

function main(): void {
	const rootDir = path.resolve(process.argv[2] ?? 'source')
	if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
		console.error(`not a directory: ${rootDir}`)
		process.exit(1)
	}
	for (const relativePath of collectSourceFiles(rootDir)) {
		const symbols = extractSymbols(fs.readFileSync(path.join(rootDir, relativePath), 'utf8'))
		if (symbols.length === 0) continue
		console.log(relativePath)
		for (const line of symbols) console.log(`\t${line}`)
	}
}

main()
