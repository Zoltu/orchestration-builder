import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"

describe("hello_001 smoke benchmark", () => {
	test("output.txt exists", () => {
		expect(existsSync("output.txt")).toBe(true)
	})

	test("output.txt contains 'hello world'", () => {
		const content = readFileSync("output.txt", "utf8").trim().toLowerCase()
		expect(content).toBe("hello world")
	})
})
