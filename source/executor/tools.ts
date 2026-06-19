import type { ToolHandler } from './tool-dispatch.js'
import { createFetchUrl, type Fetcher } from './tools/fetch-url.js'
import { createGlobFiles } from './tools/glob-files.js'
import { createListDirectory } from './tools/list-directory.js'
import { createReadFile } from './tools/read-file.js'
import { createReadFilePartial } from './tools/read-file-partial.js'
import { createSearchText } from './tools/search-text.js'

export interface NativeToolsConfig {
	workspaceRoot: string
	defaultToolTimeoutSeconds: number
	fetcher?: Fetcher
}

export function createToolHandlers(config: NativeToolsConfig): Record<string, ToolHandler> {
	const list = createListDirectory(config.workspaceRoot)
	const glob = createGlobFiles(config.workspaceRoot)
	const read = createReadFile(config.workspaceRoot)
	const readPartial = createReadFilePartial(config.workspaceRoot)
	const search = createSearchText(config.workspaceRoot)
	const fetch = createFetchUrl(config.defaultToolTimeoutSeconds * 1000, config.fetcher)
	return {
		list_directory: list,
		glob_files: glob,
		read_file: read,
		read_file_partial: readPartial,
		search_text: search,
		fetch_url: fetch,
	}
}