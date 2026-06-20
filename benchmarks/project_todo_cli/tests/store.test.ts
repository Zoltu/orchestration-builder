import { test, expect } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Todo } from '../src/todo.js'
import { loadTodos, saveTodos } from '../src/store.js'

function tempStorePath(): string {
	return path.join(os.tmpdir(), `todo-store-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

test('loadTodos returns an empty array when the store file does not exist', () => {
	const storePath = tempStorePath()
	expect(fs.existsSync(storePath)).toBe(false)
	expect(loadTodos(storePath)).toEqual([])
})

test('saveTodos then loadTodos roundtrips the list of todos', () => {
	const storePath = tempStorePath()
	try {
		const todos: Todo[] = [
			{ id: 1, title: 'Write tests', done: false },
			{ id: 2, title: 'Ship it', done: true },
		]
		saveTodos(storePath, todos)
		expect(loadTodos(storePath)).toEqual(todos)
	} finally {
		if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
	}
})
