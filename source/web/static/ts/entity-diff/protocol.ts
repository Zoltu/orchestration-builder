import { isPlainObject } from './canonical.js'
import { collectionNames, isCollectionName } from './types.js'
import type { CollectionDefinition, CollectionDefinitions, EntityBase, EntitySchemaConstraint, ServerResponse } from './types.js'

function isEntityList<Entity extends EntityBase>(definition: CollectionDefinition<Entity>, values: unknown[], seen: Set<string>): boolean {
	for (const item of values) {
		if (!definition.isEntity(item)) return false
		if (seen.has(item.id)) return false
		seen.add(item.id)
	}
	return true
}

// `seen` is shared across added/changed/removed so an id appearing in more than one list is rejected, not just an id repeated within a single list.
function isCollectionDiff<Entity extends EntityBase>(definition: CollectionDefinition<Entity>, value: unknown): boolean {
	if (!isPlainObject(value)) return false
	const added = value.added
	const changed = value.changed
	const removed = value.removed
	if (!Array.isArray(added) || !Array.isArray(changed) || !Array.isArray(removed)) return false
	const seen = new Set<string>()
	if (!isEntityList(definition, added, seen)) return false
	if (!isEntityList(definition, changed, seen)) return false
	for (const id of removed) {
		if (typeof id !== 'string') return false
		if (seen.has(id)) return false
		seen.add(id)
	}
	return true
}

function isDelta<Schema extends EntitySchemaConstraint<Schema>>(definitions: CollectionDefinitions<Schema>, value: Record<string, unknown>): boolean {
	if (typeof value.base !== 'string') return false
	if (typeof value.next !== 'string') return false
	const collections = value.collections
	if (!isPlainObject(collections)) return false
	for (const name of Object.keys(collections)) {
		if (!isCollectionName(definitions, name)) return false
		if (!isCollectionDiff(definitions[name], collections[name])) return false
	}
	return true
}

function isSnapshot<Schema extends EntitySchemaConstraint<Schema>>(definitions: CollectionDefinitions<Schema>, value: Record<string, unknown>): boolean {
	if (typeof value.version !== 'string') return false
	const collections = value.collections
	if (!isPlainObject(collections)) return false
	for (const name of collectionNames(definitions)) {
		const list = collections[name]
		if (!Array.isArray(list)) return false
		if (!isEntityList(definitions[name], list, new Set())) return false
	}
	for (const name of Object.keys(collections)) {
		if (!isCollectionName(definitions, name)) return false
	}
	return true
}

export function isServerResponse<Schema extends EntitySchemaConstraint<Schema>>(definitions: CollectionDefinitions<Schema>, value: unknown): value is ServerResponse<Schema> {
	if (!isPlainObject(value)) return false
	if (value.kind === 'unchanged') return typeof value.version === 'string'
	if (value.kind === 'delta') return isDelta(definitions, value)
	if (value.kind === 'snapshot') return isSnapshot(definitions, value)
	return false
}
