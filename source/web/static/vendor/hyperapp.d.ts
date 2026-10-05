// Hand-written ambient declaration for the vendored hyperapp (hyperapp.js — see hyperapp.LICENSE). The vendored file ships untyped and is served to the browser verbatim; the view modules never import it (they receive `h` injected as a parameter, so they stay free of hyperapp coupling), so this declaration's job is to type that injected parameter and to describe the module's export surface for the entry-point files that do import it.
//
// `Vnode` is the exchange shape the view layer programs against: tag/props/children — the fields every `h` implementation in the checked graph builds and every call site passes. The vendored implementation's runtime vnode carries the same payload under hyperapp-internal field names (name/node/type/key); no checked code reads those fields, so they are not part of the contract.
//
// Two hyperscript shapes are declared because the two call conventions are checked against different `h` implementations: `H` is the SVG view family's surface (every call passes a props object and a flat children array); `LooseH` is the overlay components' surface (children exactly as hyperapp accepts them — a bare string, a single vnode, a nested array, with null/undefined/boolean children dropped, or no children at all). Both type the tag as a string only: the vendored `h` also has a function-tag branch that no call site uses, so these declarations need widening if component tags are ever adopted.

export interface Vnode {
	tag: string
	props: Record<string, unknown>
	children: VnodeChild[]
}

export type VnodeChild = Vnode | string

// Children as hyperapp's `h` accepts them: nested arrays are flattened and null/undefined/boolean children are dropped.
export type VnodeChildInput = VnodeChild | VnodeChildInput[] | null | undefined | boolean

export type H = (tag: string, props: Record<string, unknown>, children: VnodeChild[]) => Vnode

export type LooseH = (tag: string, props: Record<string, unknown>, children?: VnodeChildInput) => Vnode

export interface AppProps {
	init?: unknown
	view?: (state: unknown) => unknown
	node?: unknown
	subscriptions?: (state: unknown) => unknown
	middleware?: unknown
}

export function h(tag: string, props: Record<string, unknown> | null, ...children: VnodeChildInput[]): Vnode

export function app(props: AppProps): void

// The vendored `Lazy` builds its own opaque lazy vnode ({ lazy, type }); nothing in the checked graph uses it, so the return stays opaque rather than guessing a shape.
export function Lazy(props: { view: (props: unknown) => unknown }): unknown
