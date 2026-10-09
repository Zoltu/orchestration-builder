import { describe, expect, test } from 'bun:test'
import { createClientReplica, createServerReplica } from '../static/ts/entity-diff/index.js'
import { definitions, makeState, stateVersion } from './test-schema.js'
import type { User } from './test-schema.js'

describe('server/client loop', () => {
	test('the client tracks the server across many updates', async () => {
		const server = createServerReplica(definitions, { historyLimit: 3 })
		const client = createClientReplica(definitions, { fetchResponse: async (request) => server.respond(request.have) }, { verifyDeltas: false })
		const users: User[] = []
		for (let step = 0; step < 25; step++) {
			users.push({ id: `u${step}`, name: `name-${step}`, team: 'team-a' })
			server.update(makeState([...users], []))
			const result = await client.sync()
			expect(result.version).toBe(server.version())
			expect(stateVersion(result.state)).toBe(server.version())
		}
		expect(users).toHaveLength(25)
	})

	test('a client that skips updates still converges when it next syncs', async () => {
		const server = createServerReplica(definitions, { historyLimit: 2 })
		const client = createClientReplica(definitions, { fetchResponse: async (request) => server.respond(request.have) }, { verifyDeltas: false })
		await client.sync()
		for (let step = 0; step < 10; step++) {
			server.update(makeState([{ id: `u${step}`, name: `name-${step}`, team: 'team-a' }], []))
		}
		const result = await client.sync()
		expect(result.outcome).toBe('snapshot')
		expect(result.version).toBe(server.version())
		expect(stateVersion(result.state)).toBe(server.version())
	})
})
