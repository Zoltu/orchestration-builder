// The run-view inspector shared by the product client (app.js) and the dev harness (demo.js): the data-attribute contract the view modules stamp onto nodes and edges, the hovered-element → inspector-target resolution, the grace-period dismiss timer, and the tooltip descriptor dispatch.
//
// The attribute names are exported as constants and consumed by flow-view.js / sequence-diagram.js where they stamp them, so the contract between what the views stamp and what the resolver reads is code rather than comments — renaming an attribute breaks both sides at import time instead of silently disabling hover in two clients.

import { deriveOperationTooltip, deriveParticipantTooltip, deriveRoleTooltip } from './tooltip.js'

export const ATTR_OPERATION = 'data-operation'
export const ATTR_PARTICIPANT = 'data-participant'
export const ATTR_ROLE = 'data-role'

// The grace period that bridges the pointer's travel between a node and the card. Long enough to cross the flush edge (and any sub-pixel/shadow gap) without a premature dismiss; short enough that moving away from both reads as an immediate dismiss.
export const TOOLTIP_GRACE_MS = 150

// Snapshots an element's viewport rect as a plain object (not the live DOMRect) so a later re-render that detaches the element does not read zeros.
export function snapshotRect(element) {
	const rect = element.getBoundingClientRect()
	return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
}

// Resolves the hovered DOM element to an inspector target by walking the data attributes the view modules stamp onto nodes and edges, and snapshots the element's viewport rect so the card can be anchored to the node (not the pointer).
// Sequence messages and terminal nodes carry data-operation; flow call/return edges carry data-operation; flow main-area nodes carry data-participant; flow top-bar slots carry data-role (and lack data-participant, so the participant check does not catch them). The order matters: operation first, then participant, then role.
export function resolveTooltipTarget(event) {
	if (!(event.target instanceof Element)) return null
	const operationElement = event.target.closest(`[${ATTR_OPERATION}]`)
	if (operationElement !== null) {
		const operationId = operationElement.getAttribute(ATTR_OPERATION)
		if (operationId !== null) return { kind: 'operation', id: operationId, rect: snapshotRect(operationElement) }
	}
	const participantElement = event.target.closest(`[${ATTR_PARTICIPANT}]`)
	if (participantElement !== null) {
		const participantId = participantElement.getAttribute(ATTR_PARTICIPANT)
		if (participantId !== null) return { kind: 'participant', id: participantId, rect: snapshotRect(participantElement) }
	}
	const roleElement = event.target.closest(`.flow-small-node[${ATTR_ROLE}]`)
	if (roleElement !== null) {
		const role = roleElement.getAttribute(ATTR_ROLE)
		if (role !== null) return { kind: 'role', id: role, rect: snapshotRect(roleElement) }
	}
	return null
}

// A pending dismiss timer, shared across both clients' hover handlers. The factory closes over the timer so the mechanism (clear-then-set, grace constant) lives in one place while expiry lands in the caller's host: the product client dispatches a hyperapp action, the harness tears down DOM directly.
export function createTooltipDismiss() {
	let timer = null
	return {
		schedule(onExpire) {
			if (timer !== null) clearTimeout(timer)
			timer = setTimeout(() => {
				timer = null
				onExpire()
			}, TOOLTIP_GRACE_MS)
		},
		cancel() {
			if (timer !== null) {
				clearTimeout(timer)
				timer = null
			}
		},
	}
}

// The descriptor dispatch both clients share: resolves an inspector target against the model and label resolver through the derivations in tooltip.js. A target whose id no longer resolves (an operation from a frame the poll has since replaced, or a participant/role the model no longer carries) yields a title-less descriptor, which both clients treat as "no card" so a stale hover state dismisses rather than rendering a heading-less card.
export function deriveTooltipDescriptor(model, labels, tier, target) {
	if (target.kind === 'operation') return deriveOperationTooltip(model, labels, tier, target.id)
	if (target.kind === 'participant') return deriveParticipantTooltip(model, labels, tier, target.id)
	return deriveRoleTooltip(model, labels, tier, target.id)
}

// Whether an operation id names an in-flight ask_human call — the click-to-reopen target both clients honor, since the sequence view has no Question-button overlay and the message row itself is the re-entry affordance after a dismiss.
export function isInFlightAskHuman(model, operationId) {
	const operation = model.operations.find((op) => op.id === operationId)
	if (operation === undefined || operation.kind !== 'call' || operation.lifecycle !== 'in_flight') return false
	const destination = model.participants.find((participant) => participant.id === operation.destination)
	return destination !== undefined && destination.kind === 'human'
}
