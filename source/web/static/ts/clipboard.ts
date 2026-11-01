// Hands a string to the operator via the clipboard. A missing clipboard API is a no-op rather than a thrown error in a non-secure context. Shared by the product client and the dev harness so the copy leaves are wired identically in both.
export function copyTextToClipboard(text: string): void {
	if (navigator.clipboard === undefined) return
	navigator.clipboard.writeText(text)
}

// Hands a raw JSON payload to the operator (trusted operator output, never rendered as Markdown — see docs/security.md "Web client rendering pipeline"), reusing the shared clipboard leaf.
export function copyRawToClipboard(rawJson: string): void {
	copyTextToClipboard(rawJson)
}
