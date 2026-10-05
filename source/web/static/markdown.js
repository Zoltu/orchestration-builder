// Forwarding module for the unconverted plain-JS importers of this path: the browser loads /markdown.js through the server's TypeScript mapping (ts/markdown.ts), but Bun resolves plain-JS importers' specifiers literally, so the test suite's module graph needs a real file at this path.
export { sanitizeNodes, htmlNodesToVnodes } from './ts/markdown.ts'
