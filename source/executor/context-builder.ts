import type { Message, RoleDefinition } from '../shared/types.js'
import { stripReasoning } from './context-policy.js'

export function buildMessages(roleDefinition: RoleDefinition, messages: Message[]): Message[] {
	if (!roleDefinition.includeReasoning) {
		return stripReasoning(messages, 2)
	}
	return messages
}