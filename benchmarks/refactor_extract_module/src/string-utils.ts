export function capitalize(text: string): string {
	if (text.length === 0) return ''
	return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase()
}

export function reverse(text: string): string {
	return text.split('').reverse().join('')
}

export function vowelCount(text: string): number {
	const vowels = new Set(['a', 'e', 'i', 'o', 'u'])
	let count = 0
	for (const character of text.toLowerCase()) {
		if (vowels.has(character)) count++
	}
	return count
}

export function kebabCase(text: string): string {
	return text.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '')
}
