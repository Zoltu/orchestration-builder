// The glob syntax shared by the file-discovery tools: * matches within one segment, ** spans segments, ? matches one non-separator character, [] passes a character class to the regex engine, and {a,b} alternates.
export function compileGlobPattern(pattern: string): RegExp {
	let regex = ''
	let i = 0
	while (i < pattern.length) {
		const char = pattern[i]
		if (char === '*' && pattern[i + 1] === '*') {
			const atSegmentStart = i === 0 || pattern[i - 1] === '/'
			if (atSegmentStart && pattern[i + 2] === '/') {
				// A whole-segment `**/` spans zero or more complete segments, so `**/*.ts` must also match a root-level `a.ts`.
				regex += '(?:[^/]+/)*'
				i += 3
				continue
			}
			// A trailing whole-segment `**` and a `**` inside a segment compile to `.*`: after the literal `dir/` prefix a zero-segment match would leave a dangling slash no walked path has, so `dir/**` cannot match `dir` itself.
			regex += '.*'
			i += 2
			continue
		}
		if (char === '*') {
			regex += '[^/]*'
			i++
			continue
		}
		if (char === '?') {
			regex += '[^/]'
			i++
			continue
		}
		if (char === '[') {
			const close = pattern.indexOf(']', i)
			if (close === -1) {
				regex += '\\['
				i++
				continue
			}
			regex += pattern.slice(i, close + 1)
			i = close + 1
			continue
		}
		if (char === '{') {
			const close = pattern.indexOf('}', i)
			if (close === -1) {
				regex += '\\{'
				i++
				continue
			}
			const inner = pattern.slice(i + 1, close)
			const alternatives = inner.split(',').map((alt) => alt.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
			regex += '(?:' + alternatives.join('|') + ')'
			i = close + 1
			continue
		}
		if (char === '.' || char === '+' || char === '(' || char === ')' || char === '|' || char === '^' || char === '$' || char === '\\') {
			regex += '\\' + char
			i++
			continue
		}
		regex += char
		i++
	}
	return new RegExp('^' + regex + '$')
}

// A matcher containing no "/" anchors to single path segments, so it can prune a walk by directory name; a matcher containing "/" anchors to the whole workspace-relative path and only filters results, because pruning happens on bare entry names before any relative path exists.
export interface GlobMatchers {
	pathMatchers: RegExp[]
	segmentMatchers: RegExp[]
}

// Fresh object per call rather than a shared constant: the returned arrays are mutable, so a module-level value would alias across calls and let one caller's patterns leak into another's.
export function compileGlobMatchers(patterns: readonly string[]): GlobMatchers {
	const matchers: GlobMatchers = { pathMatchers: [], segmentMatchers: [] }
	for (const pattern of patterns) {
		const regex = compileGlobPattern(pattern)
		if (pattern.includes('/')) matchers.pathMatchers.push(regex)
		else matchers.segmentMatchers.push(regex)
	}
	return matchers
}

export function matchesGlobPath(relativePath: string, matchers: GlobMatchers): boolean {
	for (const regex of matchers.pathMatchers) {
		if (regex.test(relativePath)) return true
	}
	for (const segment of relativePath.split('/')) {
		for (const regex of matchers.segmentMatchers) {
			if (regex.test(segment)) return true
		}
	}
	return false
}

// Only segment matchers prune a walk: a path matcher like **/*.md legitimately matches a directory name, but stopping there would also drop files below it that another pattern still wants.
export function matchesGlobSegment(segment: string, matchers: GlobMatchers): boolean {
	return matchers.segmentMatchers.some((regex) => regex.test(segment))
}
