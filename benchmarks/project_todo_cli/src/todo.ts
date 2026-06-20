export interface Todo {
	id: number
	title: string
	done: boolean
}

export function formatTodo(_todo: Todo): string {
	return ''
}

export function nextTodoId(_todos: Todo[]): number {
	return 1
}

export function parseTodoId(_value: string | undefined): number | undefined {
	return undefined
}
