// Hands a raw JSON payload to the operator via the clipboard (trusted operator output, never rendered as Markdown — see docs/security.md "Web client rendering pipeline"). A missing clipboard API is a no-op rather than a thrown error in a non-secure context. Shared by the product client and the dev harness so the copy-raw leaf is wired identically in both.
export function copyRawToClipboard(rawJson) {
	if (navigator.clipboard === undefined) return
	navigator.clipboard.writeText(rawJson)
}
