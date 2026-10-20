// A 20,000-character policy cap keeps a run document usable while preventing one read from consuming a large share of the context.
export const MAX_RUN_DOCUMENT_CHARS = 20_000

export function isRunDocumentContent(value: unknown): value is string {
	return typeof value === 'string' && value !== ''
}

// The engine delivers a successful tool result through serializeToolResult, which JSON-encodes the raw data string (source/executor/engine.ts), so the delivered size is the serialized length rather than the character count.
function serializedLength(content: string): number {
	return JSON.stringify(content).length
}

export function runDocumentWriteProblem(content: string, maxContentChars: number, maxToolOutputChars: number): string | null {
	const serializedChars = serializedLength(content)
	if (content.length <= maxContentChars && serializedChars <= maxToolOutputChars) return null
	return `the document is ${content.length} characters (${serializedChars} serialized), but the limits are ${maxContentChars} characters and ${maxToolOutputChars} serialized characters. Nothing was written, and any previous document is unchanged — condense the document and rewrite it.`
}

export function runDocumentDeliveryProblem(content: string, maxToolOutputChars: number): string | null {
	const serializedChars = serializedLength(content)
	if (serializedChars <= maxToolOutputChars) return null
	return `the stored document is ${content.length} characters (${serializedChars} serialized), which exceeds the deployment's ${maxToolOutputChars}-character tool-output budget, so it cannot be returned whole. Ask the document's owner to rewrite it within the budget, or raise the deployment's maxToolOutputChars (ORCHESTRATOR_MAX_TOOL_OUTPUT_CHARS).`
}
