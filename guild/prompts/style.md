## Style standard

This standard governs every file you write, edit, or review. Where it is silent, follow the conventions the project itself evidences (configuration files, neighboring code). Where it speaks, it wins.

## Formatting

Newlines carry semantic meaning. They separate statements, definitions, and logical groups. Do not insert blank lines purely to shorten a line or for visual breathing room.

- If a line is too long, refactor the code (extract a variable, split a function, introduce a helper) rather than wrapping it with arbitrary newlines.
- Long parameter lists, long import statements, and long string literals are acceptable as single lines when wrapping would reduce clarity.
- Do not hand-wrap prose, comments, doc blocks, or string/format/error-message literals. Write each sentence on one line and let the editor soft-wrap. A newline in prose marks a sentence or paragraph boundary; a newline in a struct separates logically grouped fields; a newline in a function separates distinct phases. A break in the middle of a single sentence or expression is wrong even if the line is long.
- Ship no code formatter and no linter: style compliance comes from these guidelines and from review, not from tooling. Do not introduce a formatter or linter dependency, and do not hand-wrap to defeat an imagined width.
- Use exactly one blank line between top-level definitions and between logical groups. Never use two or more consecutive blank lines.
- Files end with a single trailing newline; do not leave trailing whitespace on any line.

## Comments

A comment earns its place only by adding something the name, signature, and type cannot: the reason for a non-obvious choice, a constraint the code assumes but does not enforce, a hazard a reader would not anticipate, or a link to the decision that motivated it. A comment that paraphrases the name, signature, type, or obvious behavior is noise — delete it.

- Keep comments that explain an invariant, a hazard, a contract, a deliberately-omitted API, a magic constant's meaning, or a non-obvious rationale. When in doubt, leave it out.
- No comments addressed to a future author. Bare `TODO`, `FIXME`, `XXX`, `HACK`, "later", "placeholder", and "not yet supported" notes do not belong in source. If the underlying work is real, record it in whatever planning artifact the project uses, not in the code.
- One sentence per line in comments and doc blocks; do not break a single sentence across multiple lines.
- Never reference plans, milestones, or step numbers in source, identifiers, error messages, or test names. Source must stand alone for a reader with no context beyond the repository.

### Necessity test

Before adding or keeping a comment, ask: "Would a reader who has read the entire codebase (including related files and documentation) still need this information?" If no, remove it. If the behavior is evident from the code, it is redundant. If the same fact is documented elsewhere, reference it instead of repeating it. Keep only what explains why, never what.

When in doubt, err on the side of fewer comments. Code should be self-documenting through clear names and structure.
