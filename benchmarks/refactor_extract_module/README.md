# Split the string utilities into separate modules

Right now every string helper lives in one big file: `src/string-utils.ts`. That file has four functions: `capitalize`, `reverse`, `vowelCount`, and `kebabCase`.

The code works, but the file has grown too crowded. Your task is to give each function its own file:

- Put `capitalize` in `src/capitalize.ts`
- Put `reverse` in `src/reverse.ts`
- Put `vowelCount` in `src/vowel-count.ts`
- Put `kebabCase` in `src/kebab-case.ts`

Each function's body should move into its own file. Then `src/string-utils.ts` should still let other code use all four functions, by re-exporting them from their new files.

The existing tests in `tests/string-utils.test.ts` must keep passing. Do not change the test file. After the change, the four new module files must exist and the tests must still report all passing.
