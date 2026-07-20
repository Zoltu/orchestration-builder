import * as filesystem from 'node:fs'
import * as path from 'node:path'
import * as typescript from 'typescript'

// A symbol-level map of the repository: one line per top-level declaration, grouped by file.
// The point is answering "what already exists here?" without loading the whole tree into context — the map is roughly an order of magnitude smaller than the sources it summarizes.
// Test files are excluded (they describe behavior, not the surface area a newcomer might duplicate); vendored libraries are excluded (third-party code, not the project's own surface).
// main() at the bottom is the only place that touches the filesystem and process argv; extractSymbols is the pure, testable core.

const SOURCE_EXTENSIONS = new Set(['.ts', '.js'])
const EXCLUDED_DIR_NAMES = new Set(['vendor', 'node_modules'])

function isExcluded(relativePath: string): boolean {
	if (relativePath.endsWith('.test.ts')) return true
	return relativePath.split(path.sep).some((segment) => EXCLUDED_DIR_NAMES.has(segment))
}

function collectSourceFiles(rootDir: string): string[] {
	const results: string[] = []
	function walk(directory: string): void {
		for (const entry of filesystem.readdirSync(directory, { withFileTypes: true })) {
			const fullPath = path.join(directory, entry.name)
			if (entry.isDirectory()) {
				walk(fullPath)
				continue
			}
			if (!entry.isFile()) continue
			const relativePath = path.relative(rootDir, fullPath)
			if (isExcluded(relativePath)) continue
			if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue
			results.push(relativePath)
		}
	}
	walk(rootDir)
	return results.sort()
}

function hasKeyword(node: typescript.Node, keyword: typescript.SyntaxKind): boolean {
	if (!typescript.canHaveModifiers(node)) return false
	const modifiers = typescript.getModifiers(node)
	if (modifiers === undefined) return false
	return modifiers.some((modifier) => modifier.kind === keyword)
}

function visibilityPrefix(node: typescript.Node): string {
	let prefix = ''
	if (hasKeyword(node, typescript.SyntaxKind.ExportKeyword)) prefix += 'export '
	if (hasKeyword(node, typescript.SyntaxKind.AsyncKeyword)) prefix += 'async '
	if (hasKeyword(node, typescript.SyntaxKind.StaticKeyword)) prefix += 'static '
	return prefix
}

function typeParametersText(sourceFile: typescript.SourceFile, typeParameters: typescript.NodeArray<typescript.TypeParameterDeclaration> | undefined): string {
	if (typeParameters === undefined || typeParameters.length === 0) return ''
	return `<${typeParameters.map((parameter) => parameter.getText(sourceFile)).join(', ')}>`
}

function parametersText(sourceFile: typescript.SourceFile, parameters: typescript.NodeArray<typescript.ParameterDeclaration>): string {
	return parameters.map((parameter) => parameter.getText(sourceFile)).join(', ')
}

function returnTypeText(sourceFile: typescript.SourceFile, node: typescript.SignatureDeclaration): string {
	if (node.type === undefined) return ''
	return `: ${node.type.getText(sourceFile)}`
}

function functionLine(sourceFile: typescript.SourceFile, node: typescript.FunctionDeclaration): string {
	const name = node.name === undefined ? '(anonymous)' : node.name.getText(sourceFile)
	return `${visibilityPrefix(node)}${name}${typeParametersText(sourceFile, node.typeParameters)}(${parametersText(sourceFile, node.parameters)})${returnTypeText(sourceFile, node)}`
}

function classLines(sourceFile: typescript.SourceFile, node: typescript.ClassDeclaration): string[] {
	const name = node.name === undefined ? '(anonymous)' : node.name.getText(sourceFile)
	const lines = [`${visibilityPrefix(node)}class ${name}${typeParametersText(sourceFile, node.typeParameters)}`]
	for (const member of node.members) {
		if (!typescript.isMethodDeclaration(member)) continue
		lines.push(`\t${visibilityPrefix(member)}${member.name.getText(sourceFile)}(${parametersText(sourceFile, member.parameters)})${returnTypeText(sourceFile, member)}`)
	}
	return lines
}

function variableLines(sourceFile: typescript.SourceFile, node: typescript.VariableStatement): string[] {
	const lines: string[] = []
	for (const declaration of node.declarationList.declarations) {
		if (!typescript.isIdentifier(declaration.name)) continue
		const name = declaration.name.getText(sourceFile)
		const initializer = declaration.initializer
		if (initializer !== undefined && (typescript.isArrowFunction(initializer) || typescript.isFunctionExpression(initializer))) {
			lines.push(`${visibilityPrefix(node)}${name}(${parametersText(sourceFile, initializer.parameters)})${returnTypeText(sourceFile, initializer)}`)
			continue
		}
		lines.push(`${visibilityPrefix(node)}${name}`)
	}
	return lines
}

export function extractSymbols(fileName: string, sourceText: string, scriptKind: typescript.ScriptKind): string[] {
	const sourceFile = typescript.createSourceFile(fileName, sourceText, typescript.ScriptTarget.ESNext, true, scriptKind)
	const lines: string[] = []
	for (const statement of sourceFile.statements) {
		if (typescript.isFunctionDeclaration(statement)) {
			lines.push(functionLine(sourceFile, statement))
			continue
		}
		if (typescript.isClassDeclaration(statement)) {
			lines.push(...classLines(sourceFile, statement))
			continue
		}
		if (typescript.isVariableStatement(statement)) {
			lines.push(...variableLines(sourceFile, statement))
			continue
		}
		if (typescript.isInterfaceDeclaration(statement)) {
			lines.push(`${visibilityPrefix(statement)}interface ${statement.name.getText(sourceFile)}${typeParametersText(sourceFile, statement.typeParameters)}`)
			continue
		}
		if (typescript.isTypeAliasDeclaration(statement)) {
			lines.push(`${visibilityPrefix(statement)}type ${statement.name.getText(sourceFile)}${typeParametersText(sourceFile, statement.typeParameters)}`)
			continue
		}
		if (typescript.isEnumDeclaration(statement)) {
			lines.push(`${visibilityPrefix(statement)}enum ${statement.name.getText(sourceFile)}`)
		}
	}
	return lines
}

function main(): void {
	const rootDir = path.resolve(process.argv[2] ?? 'source')
	if (!filesystem.existsSync(rootDir) || !filesystem.statSync(rootDir).isDirectory()) {
		console.error(`not a directory: ${rootDir}`)
		process.exit(1)
	}
	for (const relativePath of collectSourceFiles(rootDir)) {
		const sourceText = filesystem.readFileSync(path.join(rootDir, relativePath), 'utf8')
		const scriptKind = relativePath.endsWith('.js') ? typescript.ScriptKind.JS : typescript.ScriptKind.TS
		const symbols = extractSymbols(relativePath, sourceText, scriptKind)
		if (symbols.length === 0) continue
		console.log(relativePath)
		for (const line of symbols) console.log(`\t${line}`)
	}
}

main()
