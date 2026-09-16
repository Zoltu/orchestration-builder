# Add a --reverse flag to the task printer

The small command-line tool in `src/` prints a list of tasks. It already has one flag:

- `--count N` — print only the first `N` tasks (for example `--count 2`).

The parsing lives in `src/args.ts` (`parseArgs`), and the printing lives in `src/printer.ts` (`formatLines`). The `src/cli.ts` file wires them together.

Your task is to add a second flag:

- `--reverse` — print the tasks in reverse order.

This needs two changes:

1. In `src/args.ts`, teach `parseArgs` to recognize `--reverse`. When the flag is present, the returned options should have `reverse: true`; otherwise `reverse: false`. The flag takes no value. Unknown arguments, which `parseArgs` currently ignores, should be rejected with a descriptive error.
2. In `src/printer.ts`, teach `formatLines` to reverse the order of the lines when `options.reverse` is true.

The tests in `tests/args.test.ts` and `tests/printer.test.ts` describe the exact behavior expected; the `--reverse` and unknown-argument tests currently fail. Make them pass. The existing tests must keep passing.
