// Derivation contract: turn parsed log values into the run view's facts.
//
// Inputs are never mutated: returned activity, trees, histories, budgets, and current activity are fresh values, and the events and payloads they reference stay untouched.
// Output order follows log order: roles appear in first-seen order, question and interrupt history in ask order, and role-tree children in role_start order. An empty log yields empty activity/history lists, a null role tree when no tree event exists, and null current activity; a null or partial meta yields the documented empty budget facts.
// Derivation is tolerant of malformed payloads: events with absent or wrongly typed fields are skipped or contribute no fact, and no function throws. Current activity's summary is the same one-line rendering the log view uses.
export { deriveCurrentActivity, deriveRoleActivity } from './activity.js'
export { deriveRoleTree } from './role-tree.js'
export { deriveQuestionHistory, deriveInterruptHistory } from './history.js'
export { deriveBudgets } from './budget.js'
export type { CurrentActivity, RoleActivity } from './activity.js'
export type { RoleTreeNode } from './role-tree.js'
export type { InterruptHistoryEntry, QuestionHistoryEntry } from './history.js'
export type { Budgets, TokenUsage } from './budget.js'
