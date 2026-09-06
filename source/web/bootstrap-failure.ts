import { ConfigurationError } from '../executor/errors.js'

// Served when startup configuration is invalid: the port binds anyway so the operator's browser — the one channel a non-developer running the docker image reliably has — shows what to fix instead of a connection error. The page is fully self-contained (inline CSS only, no guild or static files) because the guild and its assets may be the broken thing. The content decisions live in the testable factory; the Bun.serve wiring stays a thin leaf in source/serve.ts.

const FAILURE_CODE = 'configuration'

function escapeHtml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function failureJson(message: string): Response {
	return new Response(JSON.stringify({ ok: false, error: FAILURE_CODE, message }), {
		status: 503,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	})
}

function failurePage(message: string): Response {
	const page = [
		'<!doctype html>',
		'<html lang="en">',
		'<head>',
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		'<title>The service could not start</title>',
		'<style>body { color: #1a1a1a; font-family: system-ui, sans-serif; line-height: 1.5; margin: 0 auto; max-width: 40rem; padding: 0 1rem; } h1 { font-size: 1.25rem; margin-top: 4rem; } .error { border-left: 3px solid #c23; font-family: ui-monospace, monospace; margin: 1.5rem 0; overflow-wrap: anywhere; padding: 0.75rem 1rem; white-space: pre-wrap; }</style>',
		'</head>',
		'<body>',
		'<h1>The service could not start</h1>',
		'<p>The configuration is invalid, so the service is not accepting tasks yet. The problem:</p>',
		`<p class="error">${escapeHtml(message)}</p>`,
		'<p>Check the deployment configuration file (deployment.json, or the file named by ORCHESTRATOR_DEPLOYMENT_FILE) and any ORCHESTRATOR_* environment variables, then restart the service.</p>',
		'</body>',
		'</html>',
	].join('\n')
	return new Response(page, {
		status: 503,
		headers: { 'content-type': 'text/html; charset=utf-8' },
	})
}

export function createBootstrapFailureHandler(error: ConfigurationError): (request: Request) => Response {
	return (request) => {
		const { pathname } = new URL(request.url)
		if (pathname === '/api/health' || pathname.startsWith('/api/')) return failureJson(error.message)
		return failurePage(error.message)
	}
}
