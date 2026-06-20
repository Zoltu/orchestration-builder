# Build a todo app

This project is a small command-line todo app, but the important parts have not been written yet. Your job is to fill them in.

A todo is a single task with a number, a title, and a done/not-done status. The app keeps a list of todos in a JSON file so they survive between runs.

The app understands these commands:

- `add <title>` — add a new todo. The first todo is number 1, the next is 2, and so on. New todos start out not done.
- `list` — show every todo.
- `list --done` — show only the todos that are finished.
- `list --open` — show only the todos that are not finished.
- `done <number>` — mark a todo as finished.
- `open <number>` — mark a finished todo as not finished again.
- `remove <number>` — delete a todo.
- `edit <number> <new title>` — change a todo's title.
- `clear` — delete every todo.

The code is split into four files:

- `src/todo.ts` — the Todo type and a few small helpers (`formatTodo`, `nextTodoId`, `parseTodoId`).
- `src/store.ts` — reads and writes the JSON file that holds the todos.
- `src/commands.ts` — turns a command like `add Buy milk` into the right action and output.
- `src/cli.ts` — the entry point that reads command-line arguments. It is already wired up.

Each of `src/todo.ts`, `src/store.ts`, and `src/commands.ts` currently contains only a stub: a placeholder that compiles but does not do the real work. (`src/cli.ts` is already complete.) The tests in `tests/` describe exactly how each command should behave and what it should print. They fail right now because the real logic is missing.

Fill in the real logic so that every test passes. Check your work by running `bun run typecheck` (it must report no errors) and `bun test tests/` (every test must pass).
