// The run-view inspector shared by the product client (app.js) and the dev harness (demo.js): the data-attribute contract the view modules stamp onto nodes and edges, the hovered-element → inspector-target resolution, the grace-period dismiss timer, and the tooltip descriptor dispatch.
//
// The attribute names are exported as constants and consumed by flow-view.js / sequence-diagram.js where they stamp them, so the contract between what the views stamp and what the resolver reads is code rather than comments — renaming an attribute breaks both sides at import time instead of silently disabling hover in two clients.

import { isObject } from './guards.js'
import type { InteractionModel } from './interaction-model.js'
import type { LabelResolver, LabelTier } from './labels.js'
import type { OperationDetailsState } from './operation-details.js'
import { deriveOperationTooltip, deriveParticipantTooltip, deriveRoleTooltip } from './tooltip.js'

export const ATTR_OPERATION = 'data-operation'
export const ATTR_PARTICIPANT = 'data-participant'
export const ATTR_ROLE = 'data-role'

// The grace period that bridges the pointer's travel between a node and the card. Long enough to cross the flush edge (and any sub-pixel/shadow gap) without a premature dismiss; short enough that moving away from both reads as an immediate dismiss.
export const TOOLTIP_GRACE_MS = 150

// The viewport rect snapshot the inspector cards anchor with.
export interface ElementRect {
	left: number
	top: number
	right: number
	bottom: number
}

// The hovered element resolved to an inspector target: which stamped attribute matched, the id it carried, and the element's viewport rect.
export interface TooltipTarget {
	kind: 'operation' | 'participant' | 'role'
	id: string
	rect: ElementRect
}

// The dismiss timer handle both clients' hover wiring holds.
export interface TooltipDismiss {
	schedule(onExpire: () => void): void
	cancel(): void
}

// Snapshots an element's viewport rect as a plain object (not the live DOMRect) so a later re-render that detaches the element does not read zeros.
export function snapshotRect(element: Element): ElementRect {
	const rect = element.getBoundingClientRect()
	return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
}

// Resolves the hovered DOM element to an inspector target by walking the data attributes the view modules stamp onto nodes and edges, and snapshots the element's viewport rect so the card can be anchored to the node (not the pointer).
// Sequence messages and terminal nodes carry data-operation; flow call/return edges carry data-operation; flow main-area nodes carry data-participant; flow top-bar slots carry data-role (and lack data-participant, so the participant check does not catch them). The order matters: operation first, then participant, then role.
export function resolveTooltipTarget(event: Event): TooltipTarget | null {
	if (!(event.target instanceof Element)) return null
	const element = event.target
	const operationElement = element.closest(`[${ATTR_OPERATION}]`)
	if (operationElement !== null) {
		const operationId = operationElement.getAttribute(ATTR_OPERATION)
		if (operationId !== null) return { kind: 'operation', id: operationId, rect: snapshotRect(operationElement) }
	}
	const participantElement = element.closest(`[${ATTR_PARTICIPANT}]`)
	if (participantElement !== null) {
		const participantId = participantElement.getAttribute(ATTR_PARTICIPANT)
		if (participantId !== null) return { kind: 'participant', id: participantId, rect: snapshotRect(participantElement) }
	}
	const roleElement = element.closest(`.flow-small-node[${ATTR_ROLE}]`)
	if (roleElement !== null) {
		const role = roleElement.getAttribute(ATTR_ROLE)
		if (role !== null) return { kind: 'role', id: role, rect: snapshotRect(roleElement) }
	}
	return null
}

// A pending dismiss timer, shared across both clients' hover handlers. The factory closes over the timer so the mechanism (clear-then-set, grace constant) lives in one place while expiry lands in the caller's host: the product client dispatches a hyperapp action, the harness tears down DOM directly.
export function createTooltipDismiss(): TooltipDismiss {
	let timer: ReturnType<typeof setTimeout> | null = null
	return {
		schedule(onExpire: () => void): void {
			if (timer !== null) clearTimeout(timer)
			timer = setTimeout(() => {
				timer = null
				onExpire()
			}, TOOLTIP_GRACE_MS)
		},
		cancel(): void {
			if (timer !== null) {
				clearTimeout(timer)
				timer = null
			}
		},
	}
}

// The descriptor dispatch both clients share: resolves an inspector target against the model and label resolver through the derivations in tooltip.js. A target whose id no longer resolves (an operation from a frame the poll has since replaced, or a participant/role the model no longer carries) yields a title-less descriptor, which both clients treat as "no card" so a stale hover state dismisses rather than rendering a heading-less card. `operationDetails` is the wiring's session lookup (see tooltip.js "On-demand operation details") the operation/participant cards read their details through; the model itself carries no detail bodies.
export function deriveTooltipDescriptor(model: InteractionModel, labels: LabelResolver, tier: LabelTier, target: TooltipTarget, operationDetails: (operationId: string) => OperationDetailsState) {
	if (target.kind === 'operation') return deriveOperationTooltip(model, labels, tier, target.id, operationDetails)
	if (target.kind === 'participant') return deriveParticipantTooltip(model, labels, tier, target.id, operationDetails)
	return deriveRoleTooltip(model, labels, tier, target.id)
}

// Whether an operation id names an in-flight ask_human call — the click-to-reopen target both clients honor, since the sequence view has no Question-button overlay and the message row itself is the re-entry affordance after a dismiss.
export function isInFlightAskHuman(model: InteractionModel, operationId: string): boolean {
	const operation = model.operations.find((op) => op.id === operationId)
	if (operation === undefined || operation.kind !== 'call' || operation.lifecycle !== 'in_flight') return false
	const destination = model.participants.find((participant) => participant.id === operation.destination)
	return destination !== undefined && destination.kind === 'human'
}

// --- Click-through scoping ----------------------------------------------------
// A click (as opposed to a hover) on an agent's node or message is the drill-in that opens the LLM-turn inspector modal pre-scoped to that agent's instance. The mapping from inspector target to the modal's scope identity (the executor's role-instance id, the modal's `roleId`) lives here so both the target contract and the scope rule sit next to the resolution the click already routes through.

// Looks up a participant by id, or undefined when the model does not carry it (a stale target from a frame the poll has since replaced). Elements that are not records cannot carry the id.
function participantByIdIn(participants: unknown[], participantId: string): Record<string, unknown> | undefined {
	for (const participant of participants) {
		if (!isObject(participant)) continue
		if (participant['id'] === participantId) return participant
	}
	return undefined
}

// Looks up an operation by id, or undefined when the model does not carry it.
function operationByIdIn(operations: unknown[], operationId: string): Record<string, unknown> | undefined {
	for (const operation of operations) {
		if (!isObject(operation)) continue
		if (operation['id'] === operationId) return operation
	}
	return undefined
}

// The scope id a participant contributes: the executor's instance id when the participant carries one (every `role_start` in a current log does), else the role name — which is the identity the modal's turn entries fall back to on logs without per-instance ids, so a role-name scope still lands on that role's turns there. Null when neither identity is a usable string.
function instanceScopeIdOf(participant: Record<string, unknown>): string | null {
	const roleId = participant['roleId']
	if (typeof roleId === 'string' && roleId !== '') return roleId
	const role = participant['role']
	if (typeof role !== 'string' || role === '') return null
	return role
}

// Whether the participant is an agent role — the drill-in target kind. The human, interrupt, and tool participants have no LLM turns to inspect, so a click on them keeps the hover behavior.
function isAgentParticipant(participant: Record<string, unknown>): boolean {
	return participant['kind'] === 'role'
}

// Resolves the inspector modal's instance scope for a clicked inspector target, or null when the click is not a drill-in (a human/tool/interrupt target, an unknown id, or a malformed input) — the caller then keeps the hover-tooltip behavior. The parameters stay `unknown` because the consumers are plain-JS modules, so the inputs are validated here rather than trusted.
//
// A participant target (a flow main-area node) scopes to that participant's instance. A role target (a flow top-bar slot, which aggregates every instance of the role) scopes to the role's most recent instance. An operation target (a flow edge or a sequence message/terminal node) scopes to the worker the operation is about — the destination for a call/observe/terminate, the source (the returner) for a return. Only agent-'role' participants scope; the pseudo-roles and tools fall through to the hover path.
export function resolveInspectorScope(model: unknown, target: unknown): string | null {
	if (!isObject(model) || !isObject(target)) return null
	if (!Array.isArray(model['participants']) || !Array.isArray(model['operations'])) return null
	const participants = model['participants']
	const operations = model['operations']
	if (target['kind'] === 'participant') {
		if (typeof target['id'] !== 'string') return null
		const participant = participantByIdIn(participants, target['id'])
		if (participant === undefined || !isAgentParticipant(participant)) return null
		return instanceScopeIdOf(participant)
	}
	if (target['kind'] === 'role') {
		if (typeof target['id'] !== 'string') return null
		// The slot aggregates the role's instances; the most recent one (last in chronological first-appearance order) is the instance a drill-in names. A slot whose role has no agent participants (a tool slot) is not a drill-in.
		let latest: Record<string, unknown> | null = null
		for (const participant of participants) {
			if (!isObject(participant)) continue
			if (participant['role'] !== target['id']) continue
			if (!isAgentParticipant(participant)) continue
			latest = participant
		}
		return latest !== null ? instanceScopeIdOf(latest) : null
	}
	if (target['kind'] === 'operation') {
		if (typeof target['id'] !== 'string') return null
		const operation = operationByIdIn(operations, target['id'])
		if (operation === undefined) return null
		const workerId = operation['kind'] === 'return' ? operation['source'] : operation['destination']
		if (typeof workerId !== 'string') return null
		const participant = participantByIdIn(participants, workerId)
		if (participant === undefined || !isAgentParticipant(participant)) return null
		return instanceScopeIdOf(participant)
	}
	return null
}
