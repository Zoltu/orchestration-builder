# AI Agent Guidelines

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

---

## Architecture

This codebase follows a three-tier architecture that maximizes testability while keeping the integration shell as thin as possible.

### Leaf Functions

Leaf functions directly touch external systems: network, filesystem, subprocess, and environment. They are **not tested** and should be the thinnest possible wrappers around those systems.

Leaf functions are exported as **factories** that return configured functions. All configuration that does not vary per call is closed over at construction time.

Examples: TBD (fill in once we have some good illustrative examples in the repository).

### Orchestration Functions

Orchestration functions sequence calls, make decisions, handle errors, and branch on conditions. They are **testable** and receive pre-configured leaf functions via a `dependencies` object.

Each orchestration function declares its own type containing **only** the configured leaf functions it **directly** uses. Do not use type unions (`&`) to compose dependency types from callees. Because TypeScript uses structural typing, a superset object is assignable to a subset type automatically.

Examples: TBD (fill in once we have some good illustrative examples in the repository).

### Pure Helper Functions

Pure helper functions contain parsing, validation, formatting, transformation, and decision-making logic. They are directly imported wherever needed and never injected.

Examples: TBD (fill in once we have some good illustrative examples in the repository).

### Important Rules

- **No default values for `dependencies` parameters.** Defaults hide external access and surprise callers. `main` is the only place that assembles and passes real dependencies.
- **Never use type unions (`&`) to compose dependency types.** List each dependency explicitly in each orchestration function's type. When a transitive dependency changes, the type checker will surface the mismatch at the call site.
- Pass the accumulated `dependencies` object down without destructuring. Because of structural typing, `main` assembles one object and passes it to each handler; handlers accept subset types, so TypeScript enforces that everything needed is provided without manual repackaging.
- **Only leaf functions go in `dependencies`.** Plain data (strings, numbers, objects), configuration values, or user input belong as regular function parameters, not inside `dependencies`. `dependencies` is exclusively for configured leaf functions that touch external systems.
- **Do not export functions solely for testing.** Functions should only be exported if they are part of the module's public API used by other modules. If a function is not reachable through the exported surface area, it should not be tested. Extract logic into the testable area (orchestration or pure helpers) only when it genuinely improves the architecture — not just to enable a test.

### Decision Tree

When adding a new function, use this to decide its pattern:

1. **Does it touch an external system** (network, filesystem, subprocess, environment)?
   - **Yes:** It is a **leaf**. Export a **factory** that accepts raw configuration and returns a configured function. Close over all configuration that does not vary per call. Do not export the raw function.
   - **No:** Go to step 2.

2. **Does it orchestrate or make decisions** (sequence calls, handle errors, branch on conditions)?
   - **Yes:** It is **testable orchestration**. Accept a `dependencies` object containing only the configured leaf functions it needs. Do not provide defaults.
   - **No:** It is a **pure helper**. Import it directly wherever needed.

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

## General Principles

1. **TypeScript should catch errors at compile time, not runtime**
2. **If you need a typecast, your types are wrong - fix them**
3. **Validate external data before use**
4. **Check preconditions before operations, don't catch expected errors**
5. **Use type guards, not typecasts, for narrowing**
6. **Fail fast on invalid input, unexpected results, or any other failure — do not suppress, compensate for, or guess around problems. Throw with useful debugging information instead.**

---

## Knowledge Freshness

**Do not rely on internal memory for version numbers, release dates, package versions, or any other time-sensitive facts that may have changed since training.** Always use available tools to look up the latest information online before making claims about:

- Software or library versions
- Release dates or version lifecycles
- Current best practices, standards, or specifications
- API behavior, endpoints, or schemas of external services
- Security advisories, CVE status, or vulnerability reports

If you are unsure whether a fact is static or time-sensitive, treat it as time-sensitive and verify it with a tool.
