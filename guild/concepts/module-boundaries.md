## Module boundaries

A module is a unit of information hiding: a stable, narrow contract over a hidden implementation.
It is defined by what it hides and promises, not by file layout; a folder, file, namespace, or horizontal layer is only a physical grouping.
Callers depend on one deliberate entrypoint, and the module depends on nothing above it; a folder whose files callers import directly is not yet a module.
A module may internally hold pure logic, orchestration, and integration code, while exposing only its contract.

### Why modules exist

A module earns its place only through audit leverage: a reader treats it as a tested black box, reads its contract once, trusts it, and reasons about callers without re-reading internals; the contract should be readable in one sitting, and the implementation large enough that trusting it is a real win.
The contract is the documentation unit; reuse is a side effect, not the goal.
A contract nearly as complex as its implementation hides nothing and should be inlined; module design is not reducing coupling, and a tidy dependency graph is not the goal.

### Drawing boundaries

Draw boundaries to maximize auditability, not to mirror change; a boundary is justified only when the resulting module is more auditable than the code left ungrouped.
- **Split** when each part becomes a better black box — a simpler, independently trustable contract — even when the parts change together.
- **Merge** when neither part is a good black box alone but their union is, even when they change independently.
- **Change-coupling is not a criterion.** Two things that always change together still belong in separate modules when that is more auditable, and two things that change independently still belong in one module when that is more auditable.
A split is not free: its interface is part of what an auditor must understand, and it pays only when its new surfaces, including the seam, are simpler than the complexity removed, with no duplicated hidden logic and no chatty seam.
A contract must be stable and complete; an unstable surface forces re-audit, while churning internals behind a stable surface are irrelevant.
Re-test each module after a split and keep splitting while the parts improve; a module hiding several independent capabilities is usually several modules.
Existing folders, layers, and files are not the unit of analysis; draw the boundary where the black box is strongest.
Modules compose: a sub-module is judged by the same tests in its parent's context, while the parent's public surface stays coherent; no layer count is a target.

### What a good module looks like

- **Deep, not shallow.** The public surface must be significantly simpler than the implementation.
- **One small public surface.** One entrypoint and minimal exports; no internal type, representation, or implementation detail in public signatures, so the implementation can change without a caller change.
- **A complete, stable contract.** State guarantees, invariants, preconditions, and failure behavior, not merely signatures; observable behavior a caller could rely on is part of the contract.
- **Design by contract.** Enforce preconditions, fail fast on invalid input, and preserve postconditions and invariants; turn untrusted input into a value that carries the proof it was validated, so callers never re-check it.
- **Typed, single-channel failure.** Report each class of failure one way — a typed error or a typed result — never a mix of throwing, absent values, and error objects.
- **Explicit effect boundaries.** Determinism is the default; I/O, time, randomness, and configuration enter through injected dependencies.
- **A negligible dependency footprint.** Depend on the platform and little else; a large dependency tree is neither extractable nor auditable.

### Dependencies and ports

A module does not reach for the outside world directly: I/O, the clock, randomness, and configuration arrive as caller-supplied dependencies, keeping it testable in memory and free of environment knowledge.
The module defines each dependency's shape as a port; the caller depends on the port type, and the module depends on nothing above it.
Prefer a port shaped like the platform primitive so a caller can supply the primitive itself.
Ship no default implementation: a default forwarding to a runtime global is both a shallow wrapper and a hidden global access, embedding environment knowledge that blocks extraction and audit.
Keep thin adapters for platform primitives at the composition root; such an adapter is integration glue, not a shallow wrapper.
When several modules need the same port, let each declare its own, since structurally typed ports are interchangeable; a shared ports module is a last resort for a cross-cutting abstraction with no natural owner, type-only, with no runtime code, dependencies, or logic, named for the abstraction, and with a high bar for every addition.
Inject only what the caller must control; keep the core algorithm inside the module and inject only the effectful boundary.

### What makes a bad module

- **A shallow wrapper.** An interface nearly as complex as its implementation hides nothing; inline it, unless it is a thin adapter for a platform primitive at the composition root.
- **A leaky, god-like, or speculative surface.** Callers must know internals, one surface carries too many responsibilities to trust, or options and hooks for imagined callers widen the surface beyond any real need.
- **An upward, cyclic, or global dependency.** Importing the application, a global, or a configuration singleton, or sharing mutable state, prevents extraction and isolated testing.
- **Temporal or chatty coupling.** Correct use requires an order the types cannot enforce, or many calls serve one logical operation.
- **An anemic or wrongly split boundary.** Data without behavior, drawn before need, or split by technical layer or execution order instead of by the decision each unit hides.
- **An unstable, mixed-failure, or leaky surface.** A shifting or undocumented surface is not a contract; mixed failure channels for one class of failure are not a single contract; returning internal objects by reference lets callers mutate what the module owns.

### How to judge a boundary

Judge by the black-box, split/merge, contract, illegal-state, validation, independent-testability, extraction (including type-only imports), and exposure tests: does the module earn its place, is its contract sound, and should it be exposed?
An external consumer is evidence the module is real and should be surfaced; without one, it can remain private.
