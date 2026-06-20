# Add input validation

The `divide` function in `src/math.js` works fine for normal numbers, but it does not guard against dividing by zero.

Dividing by zero should not silently return `Infinity`. It should throw an `Error` with a clear message instead.

Your task: edit `src/math.js` so that:

- `divide(10, 2)` still returns `5` (normal division keeps working).
- `divide(1, 0)` throws an `Error`.

The tests in `tests/math.test.js` describe the expected behavior. Do not change the test file; change `src/math.js`.
