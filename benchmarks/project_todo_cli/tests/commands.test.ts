import { test, expect } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { loadTodos, saveTodos } from '../src/store.js'
import { runCommand } from '../src/commands.js'

function tempStorePath(): string {
	return path.join(os.tmpdir(), `todo-store-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

test('add creates a todo with id 1 and the given title', () => {
	const storePath = tempStorePath()
	try {
		const result = runCommand(storePath, ['add', 'Buy milk'])
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toBe('Added: 1. [ ] Buy milk')
	} finally {
		if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
	}
})

test('add assigns increasing ids across calls', () => {
	const storePath = tempStorePath()
	try {
		runCommand(storePath, ['add', 'First'])
		const second = runCommand(storePath, ['add', 'Second'])
		expect(second.stdout).toBe('Added: 2. [ ] Second')
	} finally {
		if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
	}
})

test('add with no title fails with a usage message', () => {
	const storePath = tempStorePath()
	try {
		const result = runCommand(storePath, ['add'])
		expect(result.exitCode).toBe(1)
		expect(result.stdout).toBe('Usage: add <title>')
	} finally {
		if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
	}
})

test('list prints every todo on its own line with a status marker', () => {
	const storePath = tempStorePath()
	try {
		saveTodos(storePath, [
			{ id: 1, title: 'Open', done: false },
			{ id: 2, title: 'Done', done: true },
		])
		const result = runCommand(storePath, ['list'])
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toBe('1. [ ] Open\n2. [x] Done')
	} finally {
		if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
	}
})

test('list on an empty store reports that there are no todos', () => {
	const storePath = tempStorePath()
	try {
		const result = runCommand(storePath, ['list'])
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toBe('(no todos)')
	} finally {
		if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
	}
})

test('list --done shows only the completed todos', () => {
	const storePath = tempStorePath()
	try {
		saveTodos(storePath, [
			{ id: 1, title: 'Open', done: false },
			{ id: 2, title: 'Done', done: true },
		])
		const result = runCommand(storePath, ['list', '--done'])
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toBe('2. [x] Done')
	} finally {
		if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
	}
})

test('list --open shows only the incomplete todos', () => {
	const storePath = tempStorePath()
	try {
		saveTodos(storePath, [
			{ id: 1, title: 'Open', done: false },
			{ id: 2, title: 'Done', done: true },
		])
		const result = runCommand(storePath, ['list', '--open'])
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toBe('1. [ ] Open')
	} finally {
		if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
	}
})

test('list with an unknown option fails with a usage message', () => {
	const storePath = tempStorePath()
	try {
		const result = runCommand(storePath, ['list', '--all'])
		expect(result.exitCode).toBe(1)
		expect(result.stdout).toBe('Usage: list [--done|--open]')
	} finally {
		if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
	}
})

test('done marks the matching todo as complete', () => {
	const storePath = tempStorePath()
	try {
		saveTodos(storePath, [{ id: 1, title: 'Task', done: false }])
		const result = runCommand(storePath, ['done', '1'])
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toBe('Done: 1. [x] Task')
		const loaded = loadTodos(storePath)
		expect(loaded[0]?.done).toBe(true)
	} finally {
		if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
	}
})

test('done on a missing id fails with a clear message', () => {
	const storePath = tempStorePath()
	try {
		const result = runCommand(storePath, ['done', '99'])
		expect(result.exitCode).toBe(1)
		expect(result.stdout).toBe('Todo 99 not found')
	} finally {
		if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
	}
})

test('open marks a done todo as incomplete again', () => {
	const storePath = tempStorePath()
	try {
		saveTodos(storePath, [{ id: 1, title: 'Task', done: true }])
		const result = runCommand(storePath, ['open', '1'])
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toBe('Reopened: 1. [ ] Task')
		const loaded = loadTodos(storePath)
		expect(loaded[0]?.done).toBe(false)
	} finally {
		if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
	}
})

test('remove deletes the matching todo', () => {
	const storePath = tempStorePath()
	try {
		saveTodos(storePath, [
			{ id: 1, title: 'A', done: false },
			{ id: 2, title: 'B', done: false },
		])
		const result = runCommand(storePath, ['remove', '1'])
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toBe('Removed: 1. [ ] A')
		expect(loadTodos(storePath)).toEqual([{ id: 2, title: 'B', done: false }])
	} finally {
		if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
	}
})

test('remove on a missing id fails with a clear message', () => {
	const storePath = tempStorePath()
	try {
		const result = runCommand(storePath, ['remove', '99'])
		expect(result.exitCode).toBe(1)
		expect(result.stdout).toBe('Todo 99 not found')
	} finally {
		if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
	}
})

test('edit changes a todo title', () => {
	const storePath = tempStorePath()
	try {
		saveTodos(storePath, [{ id: 1, title: 'Old', done: false }])
		const result = runCommand(storePath, ['edit', '1', 'New', 'title'])
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toBe('Edited: 1. [ ] New title')
		expect(loadTodos(storePath)[0]?.title).toBe('New title')
	} finally {
		if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
	}
})

test('edit on a missing id fails with a clear message', () => {
	const storePath = tempStorePath()
	try {
		const result = runCommand(storePath, ['edit', '99', 'Whatever'])
		expect(result.exitCode).toBe(1)
		expect(result.stdout).toBe('Todo 99 not found')
	} finally {
		if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
	}
})

test('edit with no title fails with a usage message', () => {
	const storePath = tempStorePath()
	try {
		saveTodos(storePath, [{ id: 1, title: 'Old', done: false }])
		const result = runCommand(storePath, ['edit', '1'])
		expect(result.exitCode).toBe(1)
		expect(result.stdout).toBe('Usage: edit <id> <title>')
	} finally {
		if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
	}
})

test('clear removes every todo and reports the count', () => {
	const storePath = tempStorePath()
	try {
		saveTodos(storePath, [
			{ id: 1, title: 'A', done: false },
			{ id: 2, title: 'B', done: true },
		])
		const result = runCommand(storePath, ['clear'])
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toBe('Cleared 2 todo(s)')
		expect(loadTodos(storePath)).toEqual([])
	} finally {
		if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
	}
})

test('clear on an empty store reports zero', () => {
	const storePath = tempStorePath()
	try {
		const result = runCommand(storePath, ['clear'])
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toBe('Cleared 0 todo(s)')
	} finally {
		if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
	}
})

test('an unknown command fails with a clear message', () => {
	const storePath = tempStorePath()
	try {
		const result = runCommand(storePath, ['frobnicate'])
		expect(result.exitCode).toBe(1)
		expect(result.stdout).toBe('Unknown command: frobnicate')
	} finally {
		if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
	}
})

test('running with no command prints usage', () => {
	const storePath = tempStorePath()
	try {
		const result = runCommand(storePath, [])
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain('Usage')
	} finally {
		if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
	}
})
