export type VersionToken = string

export interface EntityBase {
	id: string
}

export interface CollectionDefinition<Entity extends EntityBase> {
	readonly isEntity: (value: unknown) => value is Entity
}

// A convenience alias for a schema that is already a plain record of entities. It is deliberately not used as a generic constraint: an app-declared `interface` schema has no implicit index signature, so it does not satisfy `Record<string, EntityBase>`. Consumers naming the constraint should use `EntitySchemaConstraint` instead.
export type EntitySchema = { [K in string]: EntityBase }

// The generic constraint every public function uses, exported so consumers can name it when writing their own helpers. A self-referential mapped type accepts both `type` aliases and `interface` schemas, because the mapped form does not require an index signature on the schema.
export type EntitySchemaConstraint<Schema> = { [K in keyof Schema]: EntityBase }

export type ReplicaState<Schema extends EntitySchemaConstraint<Schema>> = { [K in keyof Schema]: Schema[K][] }

// The client returns its internal state by reference. This readonly view signals the contract that the caller must treat the returned object and its arrays as immutable: replace entities, never mutate them in place, because the identity hash cache keys on object identity and an in-place mutation would leave a stale version behind.
export type ReadonlyReplicaState<Schema extends EntitySchemaConstraint<Schema>> = { readonly [K in keyof Schema]: readonly Schema[K][] }

export type CollectionDefinitions<Schema extends EntitySchemaConstraint<Schema>> = { [K in keyof Schema]: CollectionDefinition<Schema[K]> }

export function defineCollection<Entity extends EntityBase>(isEntity: (value: unknown) => value is Entity): CollectionDefinition<Entity> {
	return { isEntity }
}

// Narrows the plain `string` that `Object.keys` yields to the schema's key type without a cast; the hasOwnProperty check is what a type predicate is allowed to base its claim on.
export function isCollectionName<Schema extends EntitySchemaConstraint<Schema>>(definitions: CollectionDefinitions<Schema>, key: string): key is keyof Schema & string {
	return Object.prototype.hasOwnProperty.call(definitions, key)
}

export function collectionNames<Schema extends EntitySchemaConstraint<Schema>>(definitions: CollectionDefinitions<Schema>): (keyof Schema & string)[] {
	return Object.keys(definitions).filter((key): key is keyof Schema & string => isCollectionName(definitions, key))
}

export interface CollectionDiff<Entity extends EntityBase> {
	added: Entity[]
	changed: Entity[]
	removed: string[]
}

export type CollectionDiffs<Schema extends EntitySchemaConstraint<Schema>> = { [K in keyof Schema]?: CollectionDiff<Schema[K]> }

export interface Unchanged {
	kind: 'unchanged'
	version: VersionToken
}

export interface Delta<Schema extends EntitySchemaConstraint<Schema>> {
	kind: 'delta'
	base: VersionToken
	next: VersionToken
	collections: CollectionDiffs<Schema>
}

export interface Snapshot<Schema extends EntitySchemaConstraint<Schema>> {
	kind: 'snapshot'
	version: VersionToken
	collections: ReplicaState<Schema>
}

export type ServerResponse<Schema extends EntitySchemaConstraint<Schema>> = Unchanged | Delta<Schema> | Snapshot<Schema>

export interface SyncRequest {
	have: VersionToken | null
}
