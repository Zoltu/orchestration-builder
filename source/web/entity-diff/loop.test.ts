import { describe, expect, test } from 'bun:test'
import { createClientReplica, createServerReplica } from '../static/ts/entity-diff/index.js'
import { definitions, makeState, stateContentHash } from './test-schema.js'
import type { User } from './test-schema.js'

describe('server/client loop', () => {
	test('the client tracks the server across many updates', async () => {
		const server = createServerReplica(definitions, { historyLimit: 3, epoch: 'e' })
		const client = createClientReplica(definitions, { fetchResponse: async (request) => server.respond(request.have) })
		const users: User[] = []
		for (let step = 0; step < 25; step++) {
			users.push({ id: `u${step}`, name: `name-${step}`, team: 'team-a' })
			server.update(makeState([...users], []))
			const result = await client.sync()
			expect(result.version).toBe(server.version())
			expect(stateContentHash(definitions, result.state)).toBe(server.snapshot().contentHash)
		}
		expect(users).toHaveLength(25)
	})

	test('a client that skips updates still converges when it next syncs', async () => {
		const server = createServerReplica(definitions, { historyLimit: 2, epoch: 'e' })
		const client = createClientReplica(definitions, { fetchResponse: async (request) => server.respond(request.have) })
		await client.sync()
		for (let step = 0; step < 10; step++) {
			server.update(makeState([{ id: `u${step}`, name: `name-${step}`, team: 'team-a' }], []))
		}
		const result = await client.sync()
		expect(result.outcome).toBe('snapshot')
		expect(result.version).toBe(server.version())
		expect(stateContentHash(definitions, result.state)).toBe(server.snapshot().contentHash)
	})
})
