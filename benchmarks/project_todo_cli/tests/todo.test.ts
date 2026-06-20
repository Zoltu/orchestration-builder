import { test, expect } from 'bun:test'
import type { Todo } from '../src/todo.js'
import { formatTodo, nextTodoId, parseTodoId } from '../src/todo.js'

test('formatTodo formats an open todo with a blank status marker', () => {
	const todo: Todo = { id: 1, title: 'Buy milk', done: false }
	expect(formatTodo(todo)).toBe('1. [ ] Buy milk')
})

test('formatTodo formats a done todo with an x status marker', () => {
	const todo: Todo = { id: 2, title: 'Pay bills', done: true }
	expect(formatTodo(todo)).toBe('2. [x] Pay bills')
})

test('nextTodoId returns 1 for an empty list', () => {
	expect(nextTodoId([])).toBe(1)
})

test('nextTodoId returns one more than the largest existing id', () => {
	const todos: Todo[] = [
		{ id: 1, title: 'a', done: false },
		{ id: 3, title: 'c', done: true },
	]
	expect(nextTodoId(todos)).toBe(4)
})

test('parseTodoId parses a positive integer', () => {
	expect(parseTodoId('7')).toBe(7)
})

test('parseTodoId returns undefined when no value is given', () => {
	expect(parseTodoId(undefined)).toBe(undefined)
})

test('parseTodoId returns undefined for non-numeric input', () => {
	expect(parseTodoId('abc')).toBe(undefined)
})

test('parseTodoId returns undefined for zero and negative numbers', () => {
	expect(parseTodoId('0')).toBe(undefined)
	expect(parseTodoId('-3')).toBe(undefined)
})
