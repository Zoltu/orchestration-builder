# AI Agent Guidelines

## Project-Wide Principles

These principles apply to every change. They are the high-level rules; the sections below give the detailed mechanics.

### No dependencies

The project must not introduce any runtime or dev dependencies beyond what is already in `package.json` (Bun's built-ins, `@types/bun`, `typescript`). This keeps the codebase easy to audit, the deployment image tiny, and the supply chain minimal.

If a dependency is deemed absolutely necessary, do not add it unilaterally. First evaluate alternatives (reimplementing with built-ins, restructuring the code, splitting the work differently). If no reasonable alternative exists, ask the operator before adding anything, and explain the alternatives you considered.

### Code quality over speed

Code quality is of the utmost importance. Take the time to do things well rather than rushing a product out. Prefer clear naming, small focused functions, and obvious control flow over clever or compact code. A reviewer should be able to understand any change without further explanation. When in doubt, choose the more readable and more auditable option.

### In-memory, fast tests

Tests must run purely in-memory and must not hit the network or any external service. Every test should run in milliseconds so the full suite is never a burden to run frequently. See "Testing Policy" below for the full rules.

### Testable business logic

Business logic must be easy to test under the above constraints. Structure code so that parsing, validation, formatting, transformation, and decision-making live in pure functions or testable orchestration functions that receive their dependencies explicitly (see "Architecture" below). Keep integration glue thin so that most logic is exercisable in-memory. If a piece of logic is hard to test, that is a signal to refactor it into the testable surface area.

### Maintainable and auditable

The codebase must be easy to maintain and audit. Prefer explicit, readable data flow over implicit globals and magic. Avoid cleverness that obscures intent. Every external input is validated (see "External Data Validation"). Behavior should be discoverable from reading the code, not from tribal knowledge. A reader should be able to follow the control flow from `main` down to the leaf calls without guessing.

---

## Type Safety Rules

### No Typecasts

**Never use typecasts (`as Type`) to bypass TypeScript's type system.**

Typecasts hide real type issues and defeat the purpose of static typing. If typecheck fails, investigate why your types are wrong and fix them properly.

**Wrong:**
```typescript
const data = fetchData() as MyType // Hides type mismatches
const error = err as NodeJS.ErrnoException // Assumes type without checking
```

**Right:**
```typescript
// Use type guards to verify structure
function isValidData(data: unknown): data is MyType {
	if (typeof data !== 'object') return false
	if (data === null) return false
	if (!('requiredField' in data)) return false
	return true
}

if (isValidData(data)) {
	// data is now typed as MyType
}

// Or use proper type narrowing
if ('code' in error && error.code === 'ENOENT') {
	// error.code is accessible here
}
```

### External Data Validation

When receiving data from external sources (APIs, files, environment, etc.), always validate its structure before use:

```typescript
// Define validation function
function isValidConfiguration(maybeConfiguration: unknown): object is Configuration {
	if (typeof maybeConfiguration !== 'object') return false
	if (maybeConfiguration === null) return false
	if (!('requiredField' in maybeConfiguration)) return false
	if (typeof maybeConfiguration.requiredField !== 'string') return false
	return true
}

// Use validation
const configuration = parseEnv();
if (!isValidConfiguration(configuration)) throw new Error('Invalid configuration')
// Now configuration is properly typed
```

### Const Assertions

`as const` is acceptable and encouraged for literal values. It narrows types (makes them stricter), not looser:

```typescript
const TRIGGER_COMMAND = '/review' as const; // Type is literal '/review', not string
```

### No Non-Null Assertions

**Never use the non-null assertion operator (`value!`) to silence the type checker.** It is a typecast in disguise: it declares a value present without proving it, and when the assumption breaks it fails as an opaque `undefined is not an object` far from the cause. Treat `!` exactly like `as` — if the type says a value can be absent, handle the absent case.

**Wrong:**
```typescript
const frame = stack[stack.length - 1]! // Crashes opaquely when the stack is empty
entry.usage = byRole.get(role)!.usage // Asserts the map holds every key
```

**Right:**
```typescript
// Restructure so absence is handled explicitly
const frame = stack[stack.length - 1]
if (frame === undefined) continue

// Or iterate the container so presence holds by construction
for (const entry of byRole.values()) { ... }
```

When a value is present by an invariant the types cannot express, check it and throw with a useful message (fail fast with debugging information — see "General Principles"); do not assert silently. Optional chaining (`?.`) and nullish coalescing (`??`) are not assertions and remain fine.

---

## Error Handling Rules

### No Try/Catch for Code Flow

**Never use try/catch to control program flow or handle expected conditions.**

Try/catch should only be used for truly exceptional cases that cannot be prevented.

**Wrong:**
```typescript
// Don't use try/catch to check if something exists
try {
	const files = fs.readdirSync(path)
	// process files
} catch (error) {
	if (error.code === 'ENOENT') {
		// Directory doesn't exist - this is expected, not exceptional
		return []
	}
	throw error
}
```

**Right:**
```typescript
// Check conditions before proceeding
if (!fs.existsSync(path)) return []

const files = fs.readdirSync(path)
// Now we know the directory exists, any error is truly exceptional
```

### Expected vs Exceptional

**Expected conditions** (check before proceeding):
- File/directory existence
- User input validation
- API response status codes
- Configuration presence

**Exceptional conditions** (use try/catch):
- Network failures during operation
- Disk I/O errors after existence check
- Unexpected system errors

### Error Type Guards

When you must handle errors, use proper type guards instead of typecasts:

```typescript
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	if (typeof error !== 'object') return false
	if (error === null) return false
	if (!('code' in error)) return false
	if (typeof error.code !== 'string') return false
	return true
}

// Usage
if (isErrnoException(error) && error.code === 'ENOENT') {
  // Handle missing file
}
```

---

## Testing Policy

Code should be structured so that most business logic falls into a **testable surface area** — pure functions that accept their dependencies as parameters rather than reaching for globals. The goal is to maximize the ratio of testable logic to untested integration glue.

### Testable (write tests for)

Pure functions and logic that can be exercised by passing inputs and asserting outputs. This includes parsing, validation, formatting, transformation, and decision-making logic.

### Not testable (don't write tests for)

Thin integration layers that wire dependencies to the outside world. This includes API calls, filesystem reads, subprocess spawning, and the main orchestration that composes everything together. These are inherently coupled to external systems and should be kept as thin as possible so they contain minimal logic worth testing.

### Making dependencies injectable

Functions that touch external systems (network, filesystem, subprocess, environment) should be exported as **factories** that return configured functions. The factory closes over all configuration that does not vary per call.

Orchestration functions (functions that sequence calls, make decisions, handle errors) are **testable** and receive pre-configured leaf functions via a `dependencies` object.

**No `dependencies` parameter has a default value.** `main` is the only place that assembles and passes real dependencies.

**Wrong:**
```typescript
// Coupled to global - untestable
export function parseConfiguration(): Configuration {
	const value = Bun.env.MY_VAR
	// ... logic ...
}

// Default parameter hides external access
export function runAnalysis(environment: Record<string, string | undefined> = Bun.env): void {
	const configuration = parseConfiguration(environment)
	// ...
}
```

**Right:**
```typescript
// Leaf factory - closes over configuration at construction time
export function createParseConfiguration(environment: Record<string, string | undefined>): () => Configuration {
	return () => {
		const value = environment.MY_VAR
		// ... logic ...
	}
}

// Orchestration - receives pre-configured leaf via dependencies
export function runAnalysis(dependencies: { parseConfiguration: () => Configuration }): void {
	const configuration = dependencies.parseConfiguration()
	// ...
}
```

### In-memory tests only

Tests must run purely in-memory. Do not make network requests, hit real external endpoints, touch the filesystem (including temporary directories), spawn subprocesses, or depend on external services. Use fakes for external callers, tool handlers, and any other external dependency. The goal is fast iteration: every test should run in milliseconds.

Checks that read the repository's own data files by design live in a dedicated script run directly, not under `bun test`, because `bun test` must stay in-memory.

External callers are exercised in tests exclusively through fakes; integration against a real endpoint is a separate concern handled at deployment time, not in `bun test`.

---

## Architecture

This codebase follows a three-tier architecture that maximizes testability while keeping the integration shell as thin as possible.

### Leaf Functions

Leaf functions directly touch external systems: network, filesystem, subprocess, and environment. They are **not tested** and should be the thinnest possible wrappers around those systems.

Leaf functions are exported as **factories** that return configured functions. All configuration that does not vary per call is closed over at construction time.

Examples: a filesystem leaf that closes over a base directory; a network leaf that closes over an endpoint and a credential.

### Orchestration Functions

Orchestration functions sequence calls, make decisions, handle errors, and branch on conditions. They are **testable** and receive pre-configured leaf functions via a `dependencies` object.

Each orchestration function declares its own type containing **only** the configured leaf functions it **directly** uses. Do not use type unions (`&`) to compose dependency types from callees. Because TypeScript uses structural typing, a superset object is assignable to a subset type automatically.

Examples: a loop that sequences several calls and handles their errors; a dispatcher that branches on the kind of input it receives.

### Pure Helper Functions

Pure helper functions contain parsing, validation, formatting, transformation, and decision-making logic. They are directly imported wherever needed and never injected.

Examples: a validation guard that narrows an unknown value; a formatting function that renders a duration.

### Important Rules

- **No default values for `dependencies` parameters.** Defaults hide external access and surprise callers. `main` is the only place that assembles and passes real dependencies.
- **Never use type unions (`&`) to compose dependency types.** List each dependency explicitly in each orchestration function's type. When a transitive dependency changes, the type checker will surface the mismatch at the call site.
- Pass the accumulated `dependencies` object down without destructuring. Because of structural typing, `main` assembles one object and passes it to each handler; handlers accept subset types, so TypeScript enforces that everything needed is provided without manual repackaging.
- **Only leaf functions go in `dependencies`.** Plain data (strings, numbers, objects), configuration values, or user input belong as regular function parameters, not inside `dependencies`. `dependencies` is exclusively for configured leaf functions that touch external systems.
- **Per-invocation in-memory state carriers (a registry, queue, tracker, recorder) may ride in `dependencies`** because they are state the call chain threads explicitly, not hidden globals.
- **Do not export functions solely for testing.** Functions should only be exported if they are part of the module's public API used by other modules. If a function is not reachable through the exported surface area, it should not be tested. Extract logic into the testable area (orchestration or pure helpers) only when it genuinely improves the architecture — not just to enable a test.

### Decision Tree

When adding a new function, use this to decide its pattern:

1. **Does it touch an external system** (network, filesystem, subprocess, environment)?
   - **Yes:** It is a **leaf**. Export a **factory** that accepts raw configuration and returns a configured function. Close over all configuration that does not vary per call. Do not export the raw function.
   - **No:** Go to step 2.

2. **Does it orchestrate or make decisions** (sequence calls, handle errors, branch on conditions)?
   - **Yes:** It is **testable orchestration**. Accept a `dependencies` object containing only the configured leaf functions it needs. Do not provide defaults.
   - **No:** It is a **pure helper**. Import it directly wherever needed.

### Modules

A module is a unit of information hiding: a stable, narrow contract over a hidden implementation.
It is defined by what it hides and promises, not by where its files live; a folder, a file, a layer, or a namespace is only a physical grouping.
The defining property is dependency direction: the rest of the codebase calls into the module, and the module calls into nothing above it.
A folder is not yet a module while callers import its files directly; a module exists once callers depend on a single, deliberate entrypoint rather than its internals.
A module is a boundary, not a horizontal layer: it may internally contain leaf, orchestration, and pure-helper code, and it exposes only its contract.
Apply this doctrine when architecting a change, when a refactor does not fit the existing boundaries, and when maintaining code whose boundaries obscure the contract.
The Guild's `guild/concepts/module-boundaries.md` is the canonical operational statement for target projects; this section restates it for this repository and must stay aligned with it.

#### Why modules exist

A module earns its place only through audit leverage: a reader treats it as a tested black box, reads its contract once, trusts it, and reasons about callers without re-reading internals; the contract should be readable in one sitting, and the implementation large enough that trusting it is a real win.
The contract is the documentation unit; reuse is a side effect, not the goal.
A contract nearly as complex as its implementation hides nothing and should be inlined; module design is not reducing coupling, and a tidy dependency graph is not the goal.

#### Drawing boundaries

Draw boundaries to maximize auditability, not to mirror change; a boundary is justified only when the resulting module is more auditable than the code left ungrouped.

- **Split** when each part becomes a better black box — a simpler, independently trustable contract — even when the parts change together.
- **Merge** when neither part is a good black box alone but their union is, even when they change independently.
- **Change-coupling is not a criterion.** Two things that always change together still belong in separate modules when that is more auditable, and two things that change independently still belong in one module when that is more auditable.

A split is not free: its interface is part of what an auditor must understand, and it pays only when its new surfaces, including the seam, are simpler than the complexity removed, with no duplicated hidden logic and no chatty seam.
A contract must be stable and complete; an unstable surface forces re-audit, while churning internals behind a stable surface are irrelevant.
Re-test each module after a split and keep splitting while the parts improve; a module hiding several independent capabilities is usually several modules.
Existing folders, layers, and files are not the unit of analysis; draw the boundary where the black box is strongest.
Modules compose: a sub-module is judged by the same tests in its parent's context, while the parent's public surface stays coherent; no layer count is a target.

#### What a good module looks like

- **Deep, not shallow.** The public surface must be significantly simpler than the implementation.
- **One small public surface.** One entrypoint and minimal exports; no internal type, representation, or implementation detail in public signatures, so the implementation can change without a caller change.
- **A complete, stable contract.** State guarantees, invariants, preconditions, and failure behavior, not merely signatures; observable behavior a caller could rely on is part of the contract.
- **Design by contract.** Enforce preconditions, fail fast on invalid input, and preserve postconditions and invariants; turn untrusted input into a value that carries the proof it was validated, so callers never re-check it.
- **Typed, single-channel failure.** Report each class of failure one way: throw a typed error, or return a typed result when the contract defines one — never a mix of throwing, absent values, and error objects.
- **Explicit effect boundaries.** Determinism is the default; effects arrive from the caller rather than from a global.
- **A negligible dependency footprint.** Depend on the platform and little else; this repository allows no new dependencies beyond those in `package.json` (see "No dependencies").

#### Dependencies and ports

A module's entrypoint does not read the outside world through a global: I/O, the clock, randomness, and environment configuration arrive from the caller — through the leaf factory at construction time or as an ordinary parameter.
Leaf functions inside the module remain the thin adapters that touch external systems directly; the module's orchestration receives them through its explicit dependencies.
The module defines each dependency's shape as a port; the caller depends on the port type, and the module depends on nothing above it.
Prefer a port shaped like the platform primitive so a caller can supply the primitive itself.
Ship no default implementation: a default forwarding to a runtime global is both a shallow wrapper and a hidden global access, embedding environment knowledge that blocks extraction and audit.
Keep thin adapters for platform primitives at the composition root; such an adapter is integration glue, not a shallow wrapper.
When several modules need the same port, let each declare its own, since structurally typed ports are interchangeable; a shared ports module is a last resort for a cross-cutting abstraction with no natural owner, type-only, with no runtime code, dependencies, or logic, named for the abstraction, and with a high bar for every addition.
Inject only what the caller must control; keep the core algorithm inside the module and inject only the effectful boundary.

#### What makes a bad module

- **A shallow wrapper.** An interface nearly as complex as its implementation hides nothing; inline it, unless it is a thin adapter for a platform primitive at the composition root.
- **A leaky, god-like, or speculative surface.** Callers must know internals, one surface carries too many responsibilities to trust, or options and hooks for imagined callers widen the surface beyond any real need.
- **An upward, cyclic, or global dependency.** Importing the application, a global, or a configuration singleton, or sharing mutable state, prevents extraction and isolated testing.
- **Temporal or chatty coupling.** Correct use requires an order the types cannot enforce, or many calls serve one logical operation.
- **An anemic or wrongly split boundary.** Data without behavior, drawn before need, or split by technical layer or execution order instead of by the decision each unit hides.
- **An unstable, mixed-failure, or leaky surface.** A shifting or undocumented surface is not a contract; mixed failure channels for one class of failure are not a single contract; returning internal objects by reference lets callers mutate what the module owns.

#### How to judge a boundary

Judge by the black-box test (is the public surface far simpler than the implementation?), the split/merge test (would either change make the parts better black boxes?), the contract test (is every observable behavior documented and stable?), the illegal-state test (can a caller construct an invalid state?), the validation test (does the boundary produce a proof-carrying value?), the independent-testability test (does it run in memory with fakes?), the extraction test (can it stand alone without imports from above, including type-only imports?), and the exposure test (does anything outside depend on the contract?).
An external consumer is evidence the module is real and should be surfaced; without one, it can remain private.

### Shared modules

The module doctrine above governs every module. This section adds the constraints for a module consumed by more than one runtime (a browser client and a server, say): keep it a self-contained dependency rather than a participant in either layer.

- **It must not reference any file outside its own folder.** Its imports are its own sibling modules only; it uses no consumer module. This preserves standalone testability and lets the same source run unchanged in every runtime that consumes it.
- **It must be pure with respect to every runtime it targets.** Restrict it to the APIs all of them share (web-standard globals, for instance) rather than one runtime's exclusive built-ins, so no consumer needs a different build or a shim.
- **Domain types stay with the consumers.** The module is generic over the shapes it operates on and never names a consumer's domain types; each consumer owns its concrete types and validates its own external inputs at the boundary.
- **State the integration contracts the consumers must honor** — the invariants the module's correctness depends on but cannot enforce (immutability of the values it is handed, an ordering it does not preserve, and so on). Keep the concrete contract with the consumers, not here.

---

## Control Flow Rules

### Prefer Guard Clauses

**Keep the primary code path at the root level of functions.** When a condition should cause an early exit, use a guard clause rather than wrapping the rest of the function in a conditional block.

**Wrong:**
```typescript
function process(entries) {
	for (const entry of entries) {
		if (entry.isValid) {
			doSomething(entry)
			doMore(entry)
		}
	}
}
```

**Right:**
```typescript
function process(entries) {
	for (const entry of entries) {
		if (!entry.isValid) continue
		doSomething(entry)
		doMore(entry)
	}
}
```

One-line `return` or `continue` guards are especially encouraged when they let the main logic sit unindented at the top level of the function or loop.

---

## Naming Conventions

Prefer verbose, descriptive names. Avoid abbreviations, acronyms, and single-letter names in identifiers, folders, and files.

- `userRepository` rather than `userRepo`
- `configuration` rather than `cfg`
- `user-settings.json` rather than `u-settings.json`
- `src/persistence/user-repository.ts` rather than `src/persist/user-repo.ts`

Single-letter names are acceptable only where the language idiom requires them (e.g., a `for` loop index). Common short forms that are already part of the project's vocabulary (`id`, `url`, `json`) are fine. The goal is clarity over brevity; do not invent new abbreviations.

## Formatting

Newlines carry semantic meaning. They separate statements, definitions, and logical groups. Do not insert blank lines purely to shorten a line or for visual breathing room.

- If a line is too long, refactor the code (extract a variable, split a function, introduce a helper) rather than wrapping it with arbitrary newlines.
- Long parameter lists, long import statements, and long string literals are acceptable as single lines when wrapping would reduce clarity.
- Do not hand-wrap prose, comments, doc blocks, or string/format/error-message literals. Write each sentence on one line and let the editor soft-wrap. A newline in prose marks a sentence or paragraph boundary; a newline in a struct separates logically grouped fields; a newline in a function separates distinct phases. A break in the middle of a single sentence or expression is wrong even if the line is long.
- This project ships no code formatter (no Biome/Prettier/ESLint/etc.) by policy — the dependency surface is restricted to Bun built-ins, `@types/bun`, and `typescript`, and only `bun run typecheck` and `bun test` gate a change. Wrapping is therefore a manual judgment governed by this section, not a formatter config; do not hand-wrap to defeat an imagined width, and do not introduce a formatter dependency to "fix" it.
- Use exactly one blank line between top-level definitions and between logical groups. Never use two or more consecutive blank lines.
- Files end with a single trailing newline; do not leave trailing whitespace on any line.

## Comments

Source code must stand on its own. Transient planning artifacts must never be referenced from source files, tests, or commit messages.

- Do not write "milestone N", "the plan", or any equivalent in source comments, identifiers, error messages, or test names. A reader of the source must be able to understand every file without a plan in front of them.
- Comments that need to point to design context reference the permanent design documentation, citing its section heading rather than a transient plan.
- Comments that need to point to a sibling module reference it by module path or symbol name (e.g. "applied by the cache", "the input to validation"), not by the task or milestone that builds it. Implementation scheduling is a planning concern, not a property of the finished code.

### Comments explain why, never what

A comment earns its place only by adding something the name, signature, and type cannot: the reason for a non-obvious choice, a constraint the code assumes but does not enforce, a hazard a reader would not anticipate, or a link to the decision that motivated it. A comment that paraphrases the item's name, signature, type, or obvious behavior is noise and a future source of drift — delete it.

- Keep comments that explain an invariant, a hazard, an RAII/destructor-style contract, a deliberately-omitted API, a magic constant's meaning, or a non-obvious rationale. When in doubt whether a comment carries information the code itself does not, keep it.
- No comments addressed to a future author. Bare `TODO`, `FIXME`, `XXX`, `HACK`, "later", "placeholder", and "not yet supported" notes do not belong in source. If the underlying work is real, record it in the project's planning or issue-tracking system, and leave an inline reference only if the project convention requires one.
- One sentence per line in comments and doc blocks. Do not break a single sentence across multiple lines for width; let the reader's editor soft-wrap. (See "Formatting" below.)

**Good** — explains *why*, information the code cannot carry:

```typescript
// A malformed cached value is treated as absent: the cache file is written atomically, so a malformed read is most likely a torn read mid-write, and the caller should recompute rather than crash.
function parseCachedValue(cachedText: string | null): CachedValue | null {
```

**Bad** — restates *what* the signature says:

```typescript
// Validates a settings object and returns it typed as Settings.
// Throws an error with a path-based message when the input is malformed.
export function parseSettings(value: unknown): Settings {
```

### Comment Necessity Test

Before adding or keeping a comment, ask: **"Would a reader who has read the entire codebase (including related files and documentation) still need this information?"** If the answer is **no**, the comment is redundant and should be removed.

**Specific checks:**

1. **Is the behavior evident from the code?**
   If the comment describes what the code does (e.g., `// sets background color`), it's redundant. The code itself shows this.

2. **Is the information duplicated elsewhere?**
   If the same fact is already documented elsewhere (e.g., a comment explaining when a constant is used, but that logic is visible in the function that uses it), don't repeat it. Reference the existing documentation instead.

3. **Does it explain a non-obvious design choice?**
   Keep comments that reveal:
   - Why an approach was chosen over alternatives
   - Constraints the code must satisfy
   - Invariants that aren't enforced by types
   - Reasons for architectural decisions (e.g., why something is centralized)
   - Hazards or edge cases not obvious from the implementation

4. **Is it a design rationale or a behavior description?**
   Good: "This uses a mutex because the operation isn't atomic."
   Bad: "This increments the counter." (The `counter++` already shows this.)

**When in doubt, err on the side of fewer comments.** Code should be self-documenting through clear names and structure. Comments exist only to explain what code cannot.

### Enforcement

Comment and newline quality is a review judgment, not a build-gate failure. No automated check is wired into `bun test`: mechanically detecting "reiterative comments" or "arbitrary wraps" produces false positives that make a lint a burden rather than a safety net, and no bare-`TODO` gate is wired in because such notes are better tracked in the project's planning or issue-tracking system. Re-check comment and newline hygiene against this section and "Formatting" before declaring any change done — reiterative comments and mid-sentence wraps accumulate silently.

---

## General Principles

1. **TypeScript should catch errors at compile time, not runtime**
2. **If you need a typecast, your types are wrong - fix them**
3. **Validate external data before use**
4. **Check preconditions before operations, don't catch expected errors**
5. **Use type guards, not typecasts, for narrowing**
6. **Fail fast on invalid input, unexpected results, or any other failure — do not suppress, compensate for, or guess around problems. Throw with useful debugging information instead.**

---

## Local test model

**Agents must never start, connect to, or download a model or inference server on their own.** This includes launching or restarting a local inference server (model weights are far too large to download), connecting to whatever model endpoints happen to be reachable, or driving real runs against them. Model servers are shared host resources: the operator turns them on explicitly for smoke tests, scheduled and coordinated with other work on the host, and only the operator knows what is currently resident or in use.

- `bun test` never touches a model: behavior is exercised through in-memory fakes (see "Testing Policy"), and this is always sufficient.
- If work genuinely needs a real-model smoke test, stop and ask the operator to schedule it. Do not probe endpoints, run the program against them, or assume a server is up even if documentation or past sessions suggest it was.
- Reading public API specifications/documentation pages is fine and unrelated to this rule.

---

## Knowledge Freshness

**Do not rely on internal memory for version numbers, release dates, package versions, or any other time-sensitive facts that may have changed since training.** Always use available tools to look up the latest information online before making claims about:

- Software or library versions
- Release dates or version lifecycles
- Current best practices, standards, or specifications
- API behavior, endpoints, or schemas of external services
- Security advisories, CVE status, or vulnerability reports

If you are unsure whether a fact is static or time-sensitive, treat it as time-sensitive and verify it with a tool.
