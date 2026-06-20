# Fix the broken import

The small program in `src/index.js` is supposed to let other code use the `add` function that lives in `src/calculator.js`.

Right now `src/index.js` points at the wrong filename, so when the tests run they fail because the file cannot be found.

Your task: correct the import path in `src/index.js` so that the tests in `tests/calculator.test.js` pass.

You do not need to change `src/calculator.js` or the test file. Only the import path in `src/index.js` is wrong.
