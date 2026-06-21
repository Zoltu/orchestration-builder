// Foundry branch management: a filesystem leaf that copies the baseline Guild into per-branch directories, applies a hypothesis's file edits, and archives / restores baselines through history.
// It is the only Foundry module that touches the filesystem and is therefore exported as a factory; its logic is intentionally thin (the "which files to edit" decision belongs to hypothesis generation, not here).
// Branch Guilds are validated end-to-end with the existing Guild loader so this module never re-implements Guild validation.
//
// Data layout (docs/foundry.md "Foundry data layout"), rooted at `baseDir`:
//   baseline/                 latest accepted baseline Guild copy
//   branches/<branch_id>/     a candidate branch Guild
//   history/<timestamp>/     an archived baseline, restorable on rollback
//
// All filesystem reads use existsSync-before-read; missing baseline / history entries are surfaced as plain Errors (operational preconditions), while malformed edits and invalid resulting Guilds are surfaced as ValidationError (invalid data).
// Branch writes are confined to the branch directory so a bad hypothesis cannot corrupt the baseline or other branches.

import * as fs from 'node:fs'
import * as path from 'node:path'

import { copyRecursively } from '../executor/persistence.js'
import { createGuildLoader } from '../executor/loader.js'
import type { LoadGuild } from '../executor/loader.js'
import { ValidationError } from '../shared/errors.js'
import type { Hypothesis } from './types.js'

export interface BranchManager {
	copyBaselineIntoBranch(branchId: string): string
	applyHypothesisToBranch(branchId: string, hypothesis: Hypothesis): void
	archiveBaselineIntoHistory(timestamp: string): string
	restoreHistoricalBaseline(timestamp: string): void
}

const BASELINE_DIRECTORY = 'baseline'
const BRANCHES_DIRECTORY = 'branches'
const HISTORY_DIRECTORY = 'history'

function resolveWithinBranch(branchDir: string, changePath: string, changeIndex: number): string {
	const branchRoot = path.resolve(branchDir)
	const resolved = path.resolve(branchRoot, changePath)
	if (resolved !== branchRoot && !resolved.startsWith(branchRoot + path.sep)) {
		throw new ValidationError(`changes[${changeIndex}].path`, `path escapes the branch directory: ${changePath}`)
	}
	return resolved
}

function isJsonFile(filePath: string): boolean {
	return filePath.toLowerCase().endsWith('.json')
}

// Confirms a .json edit's content parses as JSON before writing it, so an invalid JSON result is surfaced as a clear ValidationError at the offending change index rather than as a SyntaxError crash out of the Guild loader.
function ensureJsonEditParses(edit: string, changePath: string, changeIndex: number): void {
	try {
		JSON.parse(edit)
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		throw new ValidationError(`changes[${changeIndex}].edit`, `edit content for ${changePath} is not valid JSON: ${reason}`)
	}
}

function ensureParentDirectoryExists(filePath: string): void {
	const parent = path.dirname(filePath)
	if (!fs.existsSync(parent)) {
		fs.mkdirSync(parent, { recursive: true })
	}
}

export function createBranchManager(baseDir: string): BranchManager {
	const baselineDir = path.resolve(baseDir, BASELINE_DIRECTORY)
	const branchesRoot = path.resolve(baseDir, BRANCHES_DIRECTORY)
	const historyRoot = path.resolve(baseDir, HISTORY_DIRECTORY)
	const loadGuild: LoadGuild = createGuildLoader()

	function copyBaselineIntoBranch(branchId: string): string {
		if (!fs.existsSync(baselineDir)) {
			throw new Error(`Foundry baseline not found at ${baselineDir}`)
		}
		const branchDir = path.resolve(branchesRoot, branchId)
		if (fs.existsSync(branchDir)) {
			fs.rmSync(branchDir, { recursive: true, force: true })
		}
		fs.mkdirSync(branchDir, { recursive: true })
		copyRecursively(baselineDir, branchDir)
		return branchDir
	}

	function applyHypothesisToBranch(branchId: string, hypothesis: Hypothesis): void {
		const branchDir = path.resolve(branchesRoot, branchId)
		if (!fs.existsSync(branchDir)) {
			throw new Error(`Branch directory not found for branch ${branchId}; call copyBaselineIntoBranch first`)
		}

		for (let index = 0; index < hypothesis.changes.length; index++) {
			const change = hypothesis.changes[index]
			if (change === undefined) continue
			const targetPath = resolveWithinBranch(branchDir, change.path, index)
			if (isJsonFile(change.path)) {
				ensureJsonEditParses(change.edit, change.path, index)
			}
			ensureParentDirectoryExists(targetPath)
			fs.writeFileSync(targetPath, change.edit)
		}

		// Validate the resulting branch Guild end-to-end: guild.json structure, every referenced prompt file, and every referenced tool manifest.
		// A failure here is a genuine failure to produce a usable branch, so the loader's ValidationError is allowed to propagate.
		loadGuild(branchDir)
	}

	function archiveBaselineIntoHistory(timestamp: string): string {
		if (!fs.existsSync(baselineDir)) {
			throw new Error(`Foundry baseline not found at ${baselineDir}`)
		}
		const historyDir = path.resolve(historyRoot, timestamp)
		if (fs.existsSync(historyDir)) {
			fs.rmSync(historyDir, { recursive: true, force: true })
		}
		fs.mkdirSync(historyDir, { recursive: true })
		copyRecursively(baselineDir, historyDir)
		return historyDir
	}

	function restoreHistoricalBaseline(timestamp: string): void {
		const historyDir = path.resolve(historyRoot, timestamp)
		if (!fs.existsSync(historyDir)) {
			throw new Error(`Foundry history entry not found at ${historyDir}`)
		}
		if (fs.existsSync(baselineDir)) {
			fs.rmSync(baselineDir, { recursive: true, force: true })
		}
		fs.mkdirSync(baselineDir, { recursive: true })
		copyRecursively(historyDir, baselineDir)
	}

	return { copyBaselineIntoBranch, applyHypothesisToBranch, archiveBaselineIntoHistory, restoreHistoricalBaseline }
}
