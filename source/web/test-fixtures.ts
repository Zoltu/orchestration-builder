// Test-only guards that replace non-null assertions and typecasts in the web tests: each throws
// naming its label, so a failed lookup fails the test with a readable message.

export function defined<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`${label} is undefined`)
	return value
}

export function present<T>(value: T | null, label: string): T {
	if (value === null) throw new Error(`${label} is null`)
	return value
}

export function actionProp(props: Record<string, unknown>, key: string): (state: unknown) => unknown {
	const value = props[key]
	if (typeof value !== 'function') throw new Error(`prop "${key}" is not a function`)
	return (...args: unknown[]) => value(...args)
}
