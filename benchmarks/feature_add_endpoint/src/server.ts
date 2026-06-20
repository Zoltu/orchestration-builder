export function handleRequest(request: Request): Response {
	const url = new URL(request.url)
	if (url.pathname === '/health') {
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	}
	return new Response('Not Found', { status: 404 })
}
