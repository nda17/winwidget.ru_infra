import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import {
	crmBrokerContract,
	readCrmBrokerSnapshot,
	assertCrmBrokerSnapshot,
	provisionCrmBrokerTopology
} from './crm-broker-topology.mjs'

const contract = crmBrokerContract()
const resource = item => ({
	name: item.name,
	durable: true,
	auto_delete: false,
	arguments: {},
	type: item.type,
	internal: false
})
const queue = item => ({
	...item,
	type: 'classic',
	exclusive: false,
	consumers: 0,
	messages: 17,
	messages_ready: 17,
	messages_unacknowledged: 0,
	effective_policy_definition: {}
})
const initial = () => ({
	exchanges: [
		...contract.exchanges.filter(item => !item.owned).map(resource),
		resource({ name: 'winwidget.widgets.retry', type: 'direct' })
	],
	queues: [
		queue({
			name: 'winwidget.widgets.projection',
			durable: true,
			auto_delete: false,
			arguments: {}
		})
	],
	bindings: [
		{
			source: 'winwidget.events',
			destination: 'winwidget.widgets.projection',
			destination_type: 'queue',
			routing_key: 'widgets.widget.changed.v1',
			arguments: {}
		}
	]
})
const complete = () => ({
	exchanges: [
		...initial().exchanges,
		...contract.exchanges.filter(item => item.owned).map(resource)
	],
	queues: [...initial().queues, ...contract.queues.map(queue)],
	bindings: [
		...initial().bindings,
		...structuredClone(contract.bindings),
		...contract.queues.map(item => ({
			source: '',
			destination: item.name,
			destination_type: 'queue',
			routing_key: item.name,
			arguments: {}
		}))
	]
})
function harness(snapshot = initial()) {
	const calls = []
	let fences = 0
	let consumedFence = 0
	const mutation = (method, args) => {
		assert.ok(
			fences > consumedFence,
			'every mutation needs a fresh release fence'
		)
		consumedFence = fences
		calls.push({ method, args })
	}
	const channel = {
		async assertExchange(name, type, options) {
			mutation('assertExchange', [name, type, options])
			if (!snapshot.exchanges.some(item => item.name === name))
				snapshot.exchanges.push(resource({ name, type }))
		},
		async assertQueue(name, options) {
			mutation('assertQueue', [name, options])
			if (!snapshot.queues.some(item => item.name === name))
				snapshot.queues.push(
					queue({
						name,
						durable: options.durable,
						auto_delete: options.autoDelete,
						arguments: options.arguments
					})
				)
		},
		async bindQueue(destination, source, routing_key, arguments_) {
			mutation('bindQueue', [destination, source, routing_key, arguments_])
			const value = {
				source,
				destination,
				destination_type: 'queue',
				routing_key,
				arguments: arguments_
			}
			if (
				!snapshot.bindings.some(
					item => JSON.stringify(item) === JSON.stringify(value)
				)
			)
				snapshot.bindings.push(value)
		}
	}
	return {
		snapshot,
		calls,
		channel,
		readSnapshot: async () => structuredClone(snapshot),
		assertReleaseFence: async () => {
			fences++
		},
		fences: () => fences
	}
}

test('MVP topology has nine principals, seven owned exchanges, fourteen queues and eighteen exact bindings', () => {
	assert.equal(contract.version, 'mvp-v1')
	assert.equal(contract.vhost, 'winwidget')
	assert.equal(contract.principals.length, 9)
	assert.equal(contract.queues.length, 14)
	assert.equal(contract.bindings.length, 18)
	assert.equal(contract.exchanges.filter(item => item.owned).length, 7)
	assert.equal(new Set(contract.principals.map(item => item.name)).size, 9)
	const copy = crmBrokerContract()
	copy.queues[0].name = 'tampered'
	assert.deepEqual(crmBrokerContract(), contract)
	assert.ok(!contract.queues.some(item => /retry/.test(item.name)))
	assert.equal(
		contract.bindings.filter(
			item => item.routing_key === 'identity.wincrm.invitation-accepted.v1'
		).length,
		1
	)
	assert.equal(
		contract.bindings.filter(
			item =>
				item.routing_key ===
				'billing.wincrm.provider-operation.requested.v1'
		).length,
		2
	)
})

test('Management metadata waits for observed counts and never substitutes unknown consumers with zero', async () => {
	let calls = 0
	const snapshot = complete()
	const request = async path => {
		const field = path.split('/')[2]
		const rows = structuredClone(snapshot[field])
		if (field === 'queues' && ++calls === 1) delete rows.at(-1).consumers
		return rows
	}
	assert.deepEqual(await readCrmBrokerSnapshot(request, 1000), snapshot)
	assert.equal(calls, 2)
	delete snapshot.queues.at(-1).consumers
	await assert.rejects(
		readCrmBrokerSnapshot(async path => snapshot[path.split('/')[2]], 2),
		/observation is incomplete/
	)
	await assert.rejects(
		readCrmBrokerSnapshot(async () => ({}), 2),
		/Invalid broker observation/
	)
})

test('topology and actual routine inventory agree on all nine new users', () => {
	const source = readFileSync(
		new URL('./deploy-services-production.sh', import.meta.url),
		'utf8'
	)
	const marker = "<<'RABBITMQ_EXPECTED_USERS'\n"
	const start = source.indexOf(marker) + marker.length
	const end = source.indexOf('\nRABBITMQ_EXPECTED_USERS\n', start)
	assert.ok(start >= marker.length && end > start)
	const run = mode => {
		let output = ''
		runInNewContext(source.slice(start, end), {
			process: {
				env: {
					RABBITMQ_ADMIN_USER: 'winwidget-admin',
					RABBITMQ_MONITOR_USER: 'winwidget-monitor',
					CRM_RABBITMQ_CONTRACT: mode
				},
				exit: () => {
					throw new Error('inventory rejected')
				},
				stdout: {
					write: value => {
						output += value
					}
				}
			}
		})
		return output.split('\n')
	}
	const legacy = run('disabled')
	assert.deepEqual(
		run('mvp-v1').filter(name => !legacy.includes(name)),
		contract.principals.map(item => item.name).sort()
	)
})

test('all workers have read only on their own main queues, publishers cannot consume or configure', () => {
	for (const item of contract.principals) {
		assert.equal(item.configure, '^$')
		const read = new RegExp(item.read)
		const write = new RegExp(item.write)
		if (item.name.endsWith('worker')) {
			assert.equal(item.write, '^$')
			const matching = contract.queues.filter(queue =>
				read.test(queue.name)
			)
			assert.equal(
				matching.length,
				item.name === 'winwidget-crm-access-worker' ? 3 : 1
			)
			assert.ok(
				matching.every(queue => !queue.name.endsWith('.dead-letter'))
			)
			for (const exchange of contract.exchanges)
				assert.equal(write.test(exchange.name), false)
		} else {
			assert.equal(item.read, '^$')
			for (const queue of contract.queues)
				assert.equal(read.test(queue.name), false)
			assert.ok(
				contract.exchanges.some(exchange => write.test(exchange.name))
			)
		}
		for (const forbidden of [
			'winwidget.widgets.projection',
			'winwidget.billing.identity.v1',
			'winwidget.operations.scheduled-job'
		])
			assert.equal(read.test(forbidden) || write.test(forbidden), false)
	}
})

test('provisioning is additive and idempotent, preserves queue messages and all foreign resources', async () => {
	const state = harness()
	const before = structuredClone(state.snapshot)
	const result = await provisionCrmBrokerTopology(state)
	assert.equal(result.topologyVerified, true)
	assert.equal(result.credentialsProvisioned, false)
	assert.equal(result.releaseApproved, false)
	assert.match(result.contractSha256, /^[a-f0-9]{64}$/)
	assert.equal(state.calls.length, 39)
	assert.equal(state.fences(), 41)
	assert.deepEqual(
		state.calls
			.filter(item => item.method === 'assertExchange')
			.map(item => item.args[0]),
		contract.exchanges.filter(item => item.owned).map(item => item.name)
	)
	assert.deepEqual(
		state.snapshot.exchanges.filter(
			item =>
				!contract.exchanges.some(
					wanted => wanted.name === item.name && wanted.owned
				)
		),
		before.exchanges
	)
	assert.deepEqual(
		state.snapshot.queues.filter(
			item => !contract.queues.some(wanted => wanted.name === item.name)
		),
		before.queues
	)
	const applied = structuredClone(state.snapshot)
	assert.deepEqual(await provisionCrmBrokerTopology(state), result)
	assert.deepEqual(state.snapshot, applied)
})

test('partially declared compatible topology can be resumed without deleting existing data', async () => {
	const state = harness(complete())
	state.snapshot.bindings = state.snapshot.bindings.filter(
		item =>
			!contract.bindings
				.slice(0, 3)
				.some(wanted => JSON.stringify(wanted) === JSON.stringify(item))
	)
	state.snapshot.exchanges = state.snapshot.exchanges.filter(
		item => item.name !== 'winwidget.crm-intake.widget-control.events'
	)
	await provisionCrmBrokerTopology(state)
	assertCrmBrokerSnapshot(state.snapshot, true)
	assert.ok(state.snapshot.queues.every(item => item.messages === 17))
})

test('preflight refuses incompatible or active CRM resources before any declaration', async () => {
	const mutations = [
		value => {
			value.exchanges = value.exchanges.filter(
				item => item.name !== 'winwidget.events'
			)
		},
		value => {
			value.exchanges.find(item => item.name === 'winwidget.events').type =
				'direct'
		},
		value => {
			value.exchanges.at(-1).internal = true
		},
		value => {
			value.exchanges.at(-1).arguments = {
				'alternate-exchange': 'elsewhere'
			}
		},
		value => {
			value.exchanges.push(
				resource({ name: 'winwidget.crm-intake', type: 'topic' })
			)
		},
		value => {
			value.queues.at(-1).durable = false
		},
		value => {
			value.queues.at(-1).auto_delete = true
		},
		value => {
			value.queues.at(-1).exclusive = true
		},
		value => {
			value.queues.at(-1).consumers = 1
		},
		value => {
			value.queues.at(-1).arguments = { 'x-message-ttl': 30000 }
		},
		value => {
			value.queues.at(-1).effective_policy_definition = {
				'max-length': 1
			}
		},
		value => {
			value.queues.push(
				queue({ name: 'winwidget.crm-access.team.provision.retry.1' })
			)
		},
		value => {
			value.queues.push(structuredClone(value.queues.at(-1)))
		},
		value => {
			value.bindings.push({ ...contract.bindings[0], routing_key: '#' })
		},
		value => {
			value.bindings.push({
				...contract.bindings[0],
				destination: 'winwidget.crm-access.unknown'
			})
		},
		value => {
			value.bindings.push({
				...contract.bindings[0],
				source: 'winwidget.crm-intake.events',
				destination: 'foreign.exchange',
				destination_type: 'exchange'
			})
		},
		value => {
			value.bindings.push(structuredClone(contract.bindings[0]))
		}
	]
	for (const mutate of mutations) {
		const state = harness(complete())
		mutate(state.snapshot)
		await assert.rejects(
			provisionCrmBrokerTopology(state),
			/^Error: CRM topology provisioning failed at preflight$/
		)
		assert.equal(state.calls.length, 0)
	}
})

test('loss of the release fence stops at every possible boundary with no further mutation', async () => {
	for (let stopAt = 1; stopAt <= 41; stopAt++) {
		const state = harness()
		const fence = state.assertReleaseFence
		state.assertReleaseFence = async () => {
			await fence()
			if (state.fences() === stopAt)
				throw new Error('private env identity drift')
		}
		await assert.rejects(
			provisionCrmBrokerTopology(state),
			/CRM topology provisioning failed at/
		)
		assert.equal(state.calls.length, Math.min(Math.max(stopAt - 2, 0), 39))
	}
})

test('an incomplete final observation or raw broker failure never becomes a successful or credential-bearing report', async () => {
	const state = harness()
	let reads = 0
	state.readSnapshot = async () => {
		const snapshot = structuredClone(state.snapshot)
		if (++reads === 2) snapshot.bindings.pop()
		return snapshot
	}
	await assert.rejects(
		provisionCrmBrokerTopology(state),
		/^Error: CRM topology provisioning failed at verify$/
	)
	const errorState = harness()
	errorState.channel.assertExchange = async () => {
		throw new Error('amqp://private:synthetic-secret@host data')
	}
	await assert.rejects(
		provisionCrmBrokerTopology(errorState),
		error =>
			error.message ===
			'CRM topology provisioning failed at declare-exchanges'
	)
	const missingFence = harness()
	delete missingFence.assertReleaseFence
	await assert.rejects(
		provisionCrmBrokerTopology(missingFence),
		/^Error: CRM topology provisioning failed at preflight$/
	)
	assert.equal(missingFence.calls.length, 0)
})
