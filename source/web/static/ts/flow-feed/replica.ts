import { defineCollection } from '../entity-diff/index.js'
import type { CollectionDefinitions, ReplicaState } from '../entity-diff/index.js'
import { isObject, isOperationMetricsRecord } from '../guards.js'
import type { InteractionModel, Operation, OperationKind, OperationLifecycle, OperationMetrics, OperationOutcome, Participant, ParticipantKind, RunStatus, StackRecord } from '../interaction-model.js'

// The run-status collection holds a single entity keyed by a fixed id, so the id is a constant rather than an instance key and the model's run status rides in a collection like every other field.
const RUN_STATUS_ENTITY_ID = 'run-status' as const

interface RunStatusEntity {
	id: 'run-status'
	status: RunStatus
}

export interface FlowCollections {
	participants: Participant
	operations: Operation
	stacks: StackRecord
	runStatus: RunStatusEntity
}

function isParticipantKind(value: unknown): value is ParticipantKind {
	return value === 'human' || value === 'interrupt' || value === 'role' || value === 'tool'
}

function isOperationKind(value: unknown): value is OperationKind {
	return value === 'call' || value === 'return' || value === 'observe' || value === 'terminate'
}

function isOperationLifecycle(value: unknown): value is OperationLifecycle {
	return value === 'in_flight' || value === 'settled'
}

function isOperationOutcome(value: unknown): value is OperationOutcome {
	return value === 'success' || value === 'error' || value === 'terminated'
}

function isRunStatus(value: unknown): value is RunStatus {
	return value === 'running' || value === 'success' || value === 'error' || value === 'needs_clarification' || value === 'interrupted' || value === 'unknown'
}

function isParticipant(value: unknown): value is Participant {
	if (!isObject(value)) return false
	if (typeof value['id'] !== 'string') return false
	if (typeof value['role'] !== 'string') return false
	if (!isParticipantKind(value['kind'])) return false
	const roleId = value['roleId']
	if (roleId !== undefined && typeof roleId !== 'string') return false
	return true
}

function isOperation(value: unknown): value is Operation {
	if (!isObject(value)) return false
	if (typeof value['id'] !== 'string') return false
	if (!isOperationKind(value['kind'])) return false
	if (typeof value['stack'] !== 'string') return false
	if (typeof value['source'] !== 'string') return false
	if (typeof value['destination'] !== 'string') return false
	if (typeof value['startedAt'] !== 'string') return false
	const settledAt = value['settledAt']
	if (settledAt !== null && typeof settledAt !== 'string') return false
	if (!isOperationLifecycle(value['lifecycle'])) return false
	const outcome = value['outcome']
	if (outcome !== null && !isOperationOutcome(outcome)) return false
	const metrics = value['metrics']
	if (metrics !== null && !isOperationMetricsRecord(metrics)) return false
	return true
}

function isStackRecord(value: unknown): value is StackRecord {
	if (!isObject(value)) return false
	if (typeof value['id'] !== 'string') return false
	if (typeof value['root'] !== 'string') return false
	return true
}

function isRunStatusEntity(value: unknown): value is RunStatusEntity {
	if (!isObject(value)) return false
	if (value['id'] !== RUN_STATUS_ENTITY_ID) return false
	if (!isRunStatus(value['status'])) return false
	return true
}

// Participants and stacks are immutable per id, so their version is the small identity-bearing tuple a producer would only change by minting a new id; the id itself is the map key and need not ride in the version.
function participantVersionOf(participant: Participant): string {
	return `${participant.role}|${participant.kind}|${participant.roleId ?? ''}`
}

function stackVersionOf(stack: StackRecord): string {
	return stack.root
}

function runStatusVersionOf(runStatus: RunStatusEntity): string {
	return runStatus.status
}

// An operation is the only mutable flow entity — a call's lifecycle, settle time, and metrics all change as its return folds in — so its version captures every mutable field, including all six metrics counters, in one cheap pipe-joined string. A null counter is spelled out so it cannot collide with a numeric value.
function counterVersionPart(value: number | null): string {
	return value === null ? 'null' : String(value)
}

function operationMetricsVersion(metrics: OperationMetrics | null): string {
	if (metrics === null) return 'none'
	return [
		counterVersionPart(metrics.tokens),
		counterVersionPart(metrics.promptTokens),
		counterVersionPart(metrics.completionTokens),
		counterVersionPart(metrics.cachedPromptTokens),
		counterVersionPart(metrics.lastPromptTokens),
		counterVersionPart(metrics.elapsedSeconds),
	].join(',')
}

function operationVersionOf(operation: Operation): string {
	return [
		operation.kind,
		operation.stack,
		operation.source,
		operation.destination,
		operation.startedAt,
		operation.settledAt ?? '',
		operation.lifecycle,
		operation.outcome ?? '',
		operationMetricsVersion(operation.metrics),
	].join('|')
}

export const flowDefinitions: CollectionDefinitions<FlowCollections> = {
	participants: defineCollection(isParticipant, participantVersionOf),
	operations: defineCollection(isOperation, operationVersionOf),
	stacks: defineCollection(isStackRecord, stackVersionOf),
	runStatus: defineCollection(isRunStatusEntity, runStatusVersionOf),
}

export type FlowReplicaState = ReplicaState<FlowCollections>

export function emptyFlowReplicaState(): FlowReplicaState {
	return { participants: [], operations: [], stacks: [], runStatus: [] }
}

// Rebuilds the model the views read from the replica's arrays. The arrays are returned by reference in their held order — entity-diff treats collections as unordered, so a caller that needs a stable display order must impose its own domain sort (the views' helpers already derive order from operations, not array position). The run status falls back to 'unknown' because a replica that has not yet received the singleton is indistinguishable from a run whose meta is unreadable.
export function flowModelFromReplicaState(state: FlowReplicaState): InteractionModel {
	const runStatusEntity = state.runStatus[0]
	const status: RunStatus = runStatusEntity === undefined ? 'unknown' : runStatusEntity.status
	return {
		participants: state.participants,
		operations: state.operations,
		status,
		stacks: state.stacks,
	}
}

// The server replica consumes the derived model's collections plus the run status as the singleton run-status entity. entity-diff treats collections as unordered, so a client sorts by its own domain key after applying.
export function flowReplicaStateFromModel(model: InteractionModel): FlowReplicaState {
	return {
		participants: model.participants,
		operations: model.operations,
		stacks: model.stacks ?? [],
		runStatus: [{ id: RUN_STATUS_ENTITY_ID, status: model.status }],
	}
}
