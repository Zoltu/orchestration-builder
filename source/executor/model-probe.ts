// Startup-only probe of the model API's model list (GET {apiBase}/models, the OpenAI-compatible listing). Runs once per boot before the deployment is resolved; it never runs per-run.
// The probe reports outcomes as values instead of throwing: an unreachable endpoint, an HTTP error, a timeout, or an unparseable body are all expected conditions the resolver answers by falling back to configuration (the endpoint being down is a runtime concern that runs surface as llm_unavailable on their own), so it must never block boot.

// Bound for the whole probe round-trip: startup must not hang on an endpoint that accepts connections but never answers.
export const MODEL_PROBE_TIMEOUT_MS = 5_000

export type ModelProbeResult =
	| { ok: true; body: unknown }
	| { ok: false; reason: string }

// Reasons land in the startup log and on the bootstrap error page, so they carry only the URL and status: the API key rides in a request header and is never echoed into an error.
export function createModelInfoProbe(apiBase: string, apiKey: string | undefined, timeoutMs: number): () => Promise<ModelProbeResult> {
	const probeUrl = `${apiBase}/models`
	return async () => {
		const headers: Record<string, string> = {}
		if (apiKey !== undefined && apiKey !== '') headers['Authorization'] = `Bearer ${apiKey}`
		let response: Response
		try {
			response = await fetch(probeUrl, { headers, signal: AbortSignal.timeout(timeoutMs) })
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : String(error) }
		}
		if (response.status < 200 || response.status >= 300) {
			return { ok: false, reason: `HTTP ${response.status}` }
		}
		try {
			return { ok: true, body: await response.json() }
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : String(error) }
		}
	}
}
