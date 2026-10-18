// The context module owns one role instance's context lifecycle: initial history assembly, the proactive pressure notice, rejection recovery bounds, safe-point compaction ordering, and the context-handler interludes.
// Callers observe LLM outcomes and ask for the safe-point decision; they never reimplement history surgery or the handler invocation sequence.
//
// Preconditions: resolveSafePoint is only valid at a turn boundary, after the previous turn's tool results and before the next LLM request.
// Its methods mutate the role's RoleState and history, directly or through the shared handler interlude.
//
// Failure behavior: expected context exhaustion is reported as a typed ContextDecision or ResultCard, never as an exception.
// Invariant violations throw; a handler interlude requested without executor.contextHandlerRole configured is such a violation.
// The handler interlude itself — depth clamp, handlerOf marking, and interrupt logging — is owned by handler-interlude.ts and is not reimplemented here.
export { buildInitialHistory } from './context-builder.js'
export { stripReasoning, truncateToolOutput } from './context-policy.js'
export { createContextPressureTracker, type ContextPressureTracker } from './context-pressure.js'
export { createContextManager, type ContextDecision, type ContextDependencies, type ContextManager, type ContextRejection } from './context-manager.js'
