import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	CRM_REMINDERS_PRINCIPAL as name,
	assertCrmRemindersBrokerSnapshot,
	assertReminderNotificationTopology,
	crmReminderBrokerInputs,
	crmReminderExactPattern,
	crmReminderNotificationTopology,
	crmRemindersBrokerContract,
	crmRemindersContractEnabled,
	provisionCrmRemindersBroker,
	readCrmRemindersBrokerSnapshot
} from './crm-reminders-broker-topology.mjs'
import { bootstrapCrmReminders } from './crm-broker-bootstrap.mjs'
import {
	crmIntakeSlaBrokerInputs,
	crmIntakeSlaBrokerContract,
	crmIntakeSlaNotificationTopology,
	assertCrmIntakeSlaBrokerSnapshot
} from './crm-intake-sla-broker-topology.mjs'

const contract = crmRemindersBrokerContract()
const secret = 'f'.repeat(64)
const canonical = {
	CRM_RABBITMQ_CONTRACT: 'mvp-v1',
	CRM_REMINDERS_RABBITMQ_CONTRACT: 'disabled',
	RABBITMQ_ADMIN_USER: 'winwidget-admin',
	RABBITMQ_ADMIN_PASSWORD: 'a'.repeat(64),
	RABBITMQ_MONITOR_USER: 'winwidget-monitor',
	RABBITMQ_VHOST: 'winwidget',
	RABBITMQ_MANAGEMENT_URL: 'http://127.0.0.1:15672',
	NOTIFICATION_DELIVERY_KINDS: [
		'email',
		'telegram',
		'payment-email',
		'payment-telegram',
		'limit-email',
		'limit-telegram',
		'campaign-email',
		'campaign-telegram',
		'daily-summary-delivery-telegram',
		'subscription-expiry-email',
		'subscription-expiry-telegram',
		'wincrm-invitation-email'
	].join(',')
}
const crm = {
	CRM_SALES_REMINDERS_RABBITMQ_URL: `amqp://${name}:${secret}@127.0.0.1:5672/winwidget`
}
const inputs = () =>
	crmReminderBrokerInputs(
		canonical,
		crm,
		crmReminderNotificationTopology()
	)
function slaInputs() {
	const contract = crmIntakeSlaBrokerContract()
	return crmIntakeSlaBrokerInputs(
		{
			...canonical,
			CRM_REMINDERS_RABBITMQ_CONTRACT: 'task-reminders-v1',
			CRM_INTAKE_SLA_RABBITMQ_CONTRACT: 'intake-sla-v1',
			NOTIFICATION_DELIVERY_KINDS: crmIntakeSlaNotificationTopology()
				.deadLetterRoutingKeys.map(key =>
					key.replace(/\.dead-letter$/, '')
				)
				.join(',')
		},
		{
			...crm,
			CRM_INTAKE_SLA_WORKER_RABBITMQ_URL: `amqp://${contract.principals[0].name}:${'b'.repeat(64)}@127.0.0.1:5672/winwidget`,
			CRM_INTAKE_SLA_PUBLISHER_RABBITMQ_URL: `amqp://${contract.principals[1].name}:${'c'.repeat(64)}@127.0.0.1:5672/winwidget`
		},
		crmIntakeSlaNotificationTopology()
	)
}
const resource = (user, acl) => ({
	user,
	vhost: 'winwidget',
	configure: acl.configure,
	read: acl.read,
	write: acl.write
})
const topic = (user, rows) =>
	rows.map(row => ({ user, vhost: 'winwidget', ...row }))
const snapshot = () => ({
	exchanges: ['events', 'dead-letter', 'retry', 'manual-retry'].map(
		kind => ({
			name: 'winwidget.' + kind,
			type: ['events', 'dead-letter'].includes(kind) ? 'topic' : 'direct',
			durable: true,
			auto_delete: false,
			internal: false,
			arguments: {}
		})
	),
	queues: [
		{
			name: 'winwidget.crm.access.events',
			type: 'classic',
			durable: true,
			exclusive: false,
			auto_delete: false,
			consumers: 1,
			arguments: {},
			messages: 4
		}
	],
	bindings: []
})
const queueRow = queue => ({
	...structuredClone(queue),
	type: 'classic',
	exclusive: false,
	consumers: 0,
	messages: 0
})
function harness(sla = false) {
	const contract = sla
		? crmIntakeSlaBrokerContract()
		: crmRemindersBrokerContract()
	const parsed = sla ? slaInputs() : inputs(),
		topology = snapshot()
	const nd = 'winwidget-notification-delivery'
	const state = {
		users: parsed.legacyPrincipals.map(user => ({
			name: user,
			tags:
				user === canonical.RABBITMQ_ADMIN_USER ? ['administrator'] : [],
			password_hash: 'unchanged-' + user
		})),
		permissions: [
			resource(nd, contract.notificationBefore),
			resource('winwidget-campaigns', {
				configure: '^existing$',
				read: '^existing$',
				write: '^existing$'
			})
		],
		topics: topic(nd, contract.notificationBefore.topics)
	}
	const actions = [],
		putStates = [],
		passwords = new Map()
	let fenceCount = 0,
		failFence = Infinity,
		failAfterPut = Infinity,
		failRequest
	const fence = async () => {
		if (++fenceCount === failFence) throw Error('synthetic-fence-lost')
	}
	const request = async (path, method = 'GET', body) => {
		const key = path.split('/')[2],
			bucket = key === 'topic-permissions' ? 'topics' : key
		if (method === 'GET') return structuredClone(state[bucket])
		assert.equal(method, 'PUT')
		if (failRequest?.(path, body))
			throw Error('synthetic-sensitive-transport')
		actions.push([path, method])
		const user = path.split('/').at(-1)
		if (key === 'users') {
			assert.equal(
				state.users.some(row => row.name === user),
				false
			)
			passwords.set(user, body.password)
			state.users.push({
				name: user,
				tags: [],
				password_hash: 'new-synthetic-hash'
			})
		} else {
			state[bucket] = state[bucket].filter(
				row =>
					row.user !== user ||
					(bucket === 'topics' && row.exchange !== body.exchange)
			)
			state[bucket].push({ user, vhost: 'winwidget', ...body })
		}
		putStates.push(structuredClone(state))
		if (putStates.length === failAfterPut)
			throw Error('synthetic-response-lost-after-PUT')
	}
	const channel = {
		assertExchange: async (name, type, options) => {
			actions.push(['exchange', name])
			const expected = contract.exchanges.find(row => row.name === name)
			assert.equal(type, expected.type)
			assert.deepEqual(options, {
				durable: true,
				autoDelete: false,
				internal: false,
				arguments: {}
			})
			if (!topology.exchanges.some(row => row.name === name))
				topology.exchanges.push(structuredClone(expected))
		},
		assertQueue: async (queue, options) => {
			actions.push(['queue', queue])
			const expected = contract.queues.find(row => row.name === queue)
			assert.deepEqual(options, {
				durable: true,
				exclusive: false,
				autoDelete: false,
				arguments: expected.arguments
			})
			if (!topology.queues.some(row => row.name === queue))
				topology.queues.push(queueRow(expected))
		},
		bindQueue: async (destination, source, routing_key, args) => {
			actions.push(['binding', destination])
			const row = {
				destination,
				source,
				routing_key,
				destination_type: 'queue',
				arguments: args
			}
			if (
				!topology.bindings.some(
					old => JSON.stringify(old) === JSON.stringify(row)
				)
			)
				topology.bindings.push(row)
		}
	}
	const connect = async (user, password) => {
		assert.ok(Object.hasOwn(parsed.credentials, user))
		assert.equal(passwords.get(user), password)
		return {
			createChannel: async () => ({ close: async () => {} }),
			close: async () => {}
		}
	}
	return {
		state,
		topology,
		actions,
		putStates,
		passwords,
		get fenceCount() {
			return fenceCount
		},
		set failFence(value) {
			failFence = value
		},
		set failRequest(value) {
			failRequest = value
		},
		set failAfterPut(value) {
			failAfterPut = value
		},
		run: (overrides = {}) =>
			provisionCrmRemindersBroker({
				channel,
				request,
				connect,
				credentials: parsed.credentials,
				legacyPrincipals: parsed.legacyPrincipals,
				readSnapshot: async () => structuredClone(topology),
				assertReleaseFence: fence,
				activation: sla ? 'intake-sla' : 'reminders',
				...overrides
			})
	}
}

for (const sla of [false, true]) {
	const scope = sla ? 'Intake SLA' : 'Sales reminders'
	const selected = sla
		? crmIntakeSlaBrokerContract()
		: crmRemindersBrokerContract()
	const validate = sla
		? assertCrmIntakeSlaBrokerSnapshot
		: assertCrmRemindersBrokerSnapshot
	const expectedHash = sla
		? '4a442f4e14e81d272410268059f27484c17076264480ac7c25e4b5b57f2eee71'
		: '5108568519ff40f5206e99bea4b6baf110ae504d320d31b2df460b095684d8dd'
	const materialize = topology => {
		const result = structuredClone(topology)
		for (const row of result.queues)
			if (selected.queues.some(queue => queue.name === row.name))
				row.arguments['x-queue-type'] = 'classic'
		return result
	}
	test(`${scope} accepts materialized classic default and replays the fully provisioned contract unchanged`, async () => {
		const h = harness(sla)
		const report = await h.run({
			readSnapshot: async () => materialize(h.topology)
		})
		assert.equal(report.contractSha256, expectedHash)
		h.topology.queues = materialize(h.topology).queues
		const before = structuredClone({
			state: h.state,
			topology: h.topology
		})
		const puts = h.putStates.length
		assert.equal(validate(h.topology, true).contractSha256, expectedHash)
		assert.deepEqual(await h.run(), report)
		assert.equal(h.putStates.length, puts)
		assert.deepEqual({ state: h.state, topology: h.topology }, before)
	})
	test(`${scope} still rejects wrong type, TTL, DLX, extra arguments and non-queue normalization`, async () => {
		const h = harness(sla)
		await h.run()
		const baseline = materialize(h.topology)
		const queue = topology =>
			topology.queues.find(row => row.name === selected.queues[0].name)
		const retry = topology =>
			topology.queues.find(row =>
				selected.queues.some(
					item =>
						item.name === row.name &&
						Object.hasOwn(item.arguments, 'x-message-ttl')
				)
			)
		for (const mutate of [
			topology => (queue(topology).type = 'quorum'),
			topology => (queue(topology).arguments['x-queue-type'] = 'quorum'),
			topology => (queue(topology).arguments['x-queue-type'] = null),
			topology => (queue(topology).arguments = []),
			topology => retry(topology).arguments['x-message-ttl']++,
			topology =>
				(retry(topology).arguments['x-dead-letter-exchange'] = 'wrong'),
			topology => (queue(topology).arguments['x-max-length'] = 10),
			topology =>
				(topology.exchanges[0].arguments['x-queue-type'] = 'classic'),
			topology =>
				(topology.bindings.find(
					row => row.destination === selected.queues[0].name
				).arguments['x-queue-type'] = 'classic')
		]) {
			const changed = structuredClone(baseline)
			mutate(changed)
			assert.throws(() => validate(changed, true))
		}
		if (!sla) {
			const changed = structuredClone(baseline)
			delete queue(changed).arguments['x-queue-type']
			assert.throws(() => validate(changed, true))
		}
	})
}

test('Intake SLA exact additive topology preserves sixteen kinds and isolates two principals', async () => {
	const contract = crmIntakeSlaBrokerContract(),
		h = harness(true)
	assert.equal(contract.exchanges.length, 2)
	assert.equal(contract.queues.length, 12)
	assert.equal(contract.bindings.length, 18)
	const [worker, publisher] = contract.principals
	assert.equal(worker.write, '^$')
	assert.equal(worker.configure, '^$')
	assert.match('winwidget.crm-intake.sla.v1', new RegExp(worker.read))
	assert.doesNotMatch(
		'winwidget.crm-intake.sla.v1.dead-letter',
		new RegExp(worker.read)
	)
	assert.equal(publisher.read, '^$')
	assert.equal(publisher.configure, '^$')
	assert.doesNotMatch(
		'notification.wincrm.task-reminder.email.requested.v1',
		new RegExp(publisher.topics[0].write)
	)
	for (const pattern of [
		contract.notificationAfter.read,
		contract.notificationAfter.configure,
		...contract.notificationAfter.topics.flatMap(row => [
			row.read,
			row.write
		])
	])
		assert.ok(Buffer.byteLength(pattern) <= 1024)
	h.topology.queues.push({
		...queueRow({
			name: 'winwidget.crm.sales.reminders',
			durable: true,
			auto_delete: false,
			arguments: {}
		}),
		consumers: 1,
		messages: 4
	})
	const old = structuredClone(h.topology.queues)
	const report = await h.run()
	assert.equal(report.authenticatedPrincipals, 2)
	assert.equal(report.legacyPrincipalsUnchanged, 25)
	assert.equal(report.notificationKinds, 16)
	assert.equal(report.exchanges, 2)
	assert.equal(h.state.users.length, 28)
	for (const row of old)
		assert.deepEqual(
			h.topology.queues.find(item => item.name === row.name),
			row
		)
	const puts = h.actions.filter(row => row[1] === 'PUT').length
	await h.run()
	assert.equal(h.actions.filter(row => row[1] === 'PUT').length, puts)
	assertCrmIntakeSlaBrokerSnapshot(h.topology, true)
})

test('Intake SLA interrupted grants resume without widening worker or rotating credentials', async () => {
	const reference = harness(true)
	await reference.run()
	for (let index = 1; index <= reference.putStates.length; index++) {
		const h = harness(true)
		h.failAfterPut = index
		await assert.rejects(h.run())
		h.failAfterPut = Infinity
		await h.run()
		assert.equal(
			h.actions.filter(
				([path, method]) =>
					method === 'PUT' && path.startsWith('/api/users/')
			).length,
			2
		)
	}
	for (const mutate of [
		h => h.state.users.push({ name: 'unexpected', tags: [] }),
		h =>
			h.topology.queues.push({
				...queueRow(crmIntakeSlaBrokerContract().queues[0]),
				consumers: 1
			}),
		h =>
			h.topology.queues.push({
				...queueRow(crmIntakeSlaBrokerContract().queues[0]),
				arguments: { 'x-message-ttl': 5 }
			})
	]) {
		const h = harness(true)
		mutate(h)
		await assert.rejects(h.run())
		assert.equal(h.actions.length, 0)
	}
})

test('optional contract keeps MVP separate and exact principal reads one queue and writes three topics', () => {
	assert.equal(contract.version, 'task-reminders-v1')
	assert.equal(contract.queues.length, 12)
	assert.equal(contract.bindings.length, 18)
	assert.equal(contract.principal.configure, '^$')
	for (const row of contract.queues)
		assert.equal(
			new RegExp(contract.principal.read).test(row.name),
			row.name === 'winwidget.crm.sales.reminders'
		)
	const writes = contract.principal.topics[0].write
	for (const key of [
		'crm.sales.reminder.tick.v1',
		'notification.wincrm.task-reminder.email.requested.v1',
		'notification.wincrm.task-reminder.telegram.requested.v1'
	]) {
		assert.match(key, new RegExp(writes))
		for (const invalid of [
			'x' + key,
			key + '.extra',
			key.replaceAll('.', 'x')
		])
			assert.doesNotMatch(invalid, new RegExp(writes))
	}
	assert.doesNotMatch(
		'notification.wincrm.invitation.email.requested.v1',
		new RegExp(writes)
	)
	assert.doesNotMatch(
		'winwidget.retry',
		new RegExp(contract.principal.write)
	)
	assert.equal(crmRemindersContractEnabled({}), false)
	assert.equal(
		crmRemindersContractEnabled({
			CRM_RABBITMQ_CONTRACT: 'mvp-v1',
			CRM_REMINDERS_RABBITMQ_CONTRACT: 'task-reminders-v1'
		}),
		true
	)
	for (const value of ['', 'true', 'task-reminders-v2'])
		assert.throws(() =>
			crmRemindersContractEnabled({
				CRM_REMINDERS_RABBITMQ_CONTRACT: value
			})
		)
	assert.throws(() =>
		crmRemindersContractEnabled({
			CRM_REMINDERS_RABBITMQ_CONTRACT: 'task-reminders-v1'
		})
	)
})

test('fourteen-kind compact ACL preserves every old resource/key, exact retries and 1024 byte bounds', () => {
	const topology = crmReminderNotificationTopology(),
		acl = assertReminderNotificationTopology(topology)
	for (const pattern of [
		acl.read,
		acl.write,
		acl.configure,
		...acl.topics.flatMap(row => [row.read, row.write])
	])
		assert.ok(Buffer.byteLength(pattern) <= 1024)
	for (const queue of topology.queueNames) {
		for (const value of [
			queue,
			queue + '.dead-letter',
			...[1, 2, 3].map(i => queue + '.retry-v2.' + i)
		]) {
			assert.match(value, new RegExp(acl.read))
			for (const invalid of [
				'prefix.' + value,
				value + '.suffix',
				value.replaceAll('.', 'x')
			])
				assert.doesNotMatch(invalid, new RegExp(acl.read))
		}
		assert.doesNotMatch(queue + '.retry-v2.4', new RegExp(acl.read))
	}
	for (const [values, regex] of [
		[topology.readRoutingKeys, acl.topics[0].read],
		[topology.writeRoutingKeys, acl.topics[0].write],
		[topology.deadLetterRoutingKeys, acl.topics[1].read]
	])
		for (const value of values) {
			assert.match(value, new RegExp(regex))
			assert.doesNotMatch(value + '.extra', new RegExp(regex))
			assert.doesNotMatch('x.' + value, new RegExp(regex))
		}
	assert.throws(() =>
		assertReminderNotificationTopology(
			crmReminderNotificationTopology(false)
		)
	)
	assert.throws(() =>
		assertReminderNotificationTopology({
			...topology,
			queueNames: [...topology.queueNames, 'winwidget.rogue']
		})
	)
	assert.throws(() => crmReminderExactPattern(['a.*']))
})

test('exact compression accepts only input words, including shared prefix/suffix cross-product traps', () => {
	const alphabet = ['a', 'b', '.'],
		words = [
			'a',
			'b',
			'.',
			'aa',
			'ab',
			'ba',
			'bb',
			'a.a',
			'a.b',
			'b.a',
			'b.b'
		]
	const universe = ['']
	for (let i = 0, level = ['']; i < 4; i++) {
		level = level.flatMap(prefix =>
			alphabet.map(character => prefix + character)
		)
		universe.push(...level)
	}
	for (let mask = 1; mask < 128; mask++) {
		const allowed = words.filter(
			(_, index) => (mask & (1 << (index % 7))) !== 0
		)
		const regex = new RegExp(crmReminderExactPattern(allowed))
		for (const word of universe)
			assert.equal(regex.test(word), allowed.includes(word))
	}
})

test('bootstrap inputs require exact source binding and suppress malformed or secret-bearing details', () => {
	assert.equal(inputs().legacyPrincipals.length, 25)
	for (const [env, owner, topology] of [
		[
			{ ...canonical, CRM_RABBITMQ_CONTRACT: 'disabled' },
			crm,
			crmReminderNotificationTopology()
		],
		[
			{ ...canonical, RABBITMQ_MANAGEMENT_URL: 'http://public.example' },
			crm,
			crmReminderNotificationTopology()
		],
		[
			canonical,
			{
				...crm,
				CRM_SALES_REMINDERS_RABBITMQ_URL:
					crm.CRM_SALES_REMINDERS_RABBITMQ_URL.replace(
						'127.0.0.1',
						'public.example'
					)
			},
			crmReminderNotificationTopology()
		],
		[
			canonical,
			{
				...crm,
				CRM_SALES_REMINDERS_RABBITMQ_URL:
					crm.CRM_SALES_REMINDERS_RABBITMQ_URL + '?secret=' + secret
			},
			crmReminderNotificationTopology()
		],
		[canonical, crm, crmReminderNotificationTopology(false)],
		[
			{ ...canonical, NOTIFICATION_DELIVERY_KINDS: 'email' },
			crm,
			crmReminderNotificationTopology()
		]
	])
		assert.throws(
			() => crmReminderBrokerInputs(env, owner, topology),
			error =>
				error.message ===
				'Invalid CRM reminder broker inputs; private details suppressed'
		)
})

test('provisioning is additive/idempotent and leaves active old CRM/ND data and users intact', async () => {
	const h = harness(),
		oldQueue = structuredClone(h.topology.queues[0]),
		oldUsers = structuredClone(h.state.users)
	const report = await h.run()
	assert.equal(report.notificationKinds, 14)
	assert.equal(report.releaseApproved, false)
	assert.equal(report.authenticatedPrincipals, 1)
	assert.equal(h.state.users.length, 26)
	assert.deepEqual(h.topology.queues[0], oldQueue)
	assert.deepEqual(h.state.users.slice(0, 25), oldUsers)
	const puts = h.actions.filter(([path]) =>
		path.startsWith('/api/')
	).length
	await h.run()
	assert.equal(
		h.actions.filter(([path]) => path.startsWith('/api/')).length,
		puts
	)
	assert.deepEqual(
		h.actions
			.filter(([path]) => path.startsWith('/api/users/'))
			.map(row => row[0]),
		['/api/users/' + name]
	)
})

test('every parent fence is mandatory and interruption resumes without credential rotation', async () => {
	const complete = harness()
	await complete.run()
	for (let at = 1; at <= complete.fenceCount; at++) {
		const h = harness()
		h.failFence = at
		await assert.rejects(h.run(), /private details suppressed/)
		h.failFence = Infinity
		await h.run()
		assert.equal(
			h.actions.filter(([path]) => path === '/api/users/' + name).length,
			1
		)
	}
	const h = harness()
	await assert.rejects(
		h.run({ assertReleaseFence: undefined }),
		/private details suppressed/
	)
	assert.equal(h.actions.length, 0)
})

test('a lost response after every committed PUT never leaves exchange write without exact topic restrictions', async () => {
	const complete = harness()
	await complete.run()
	const verify = state => {
		const resources = state.permissions.filter(row => row.user === name)
		if (resources.length)
			assert.deepEqual(
				state.topics.filter(row => row.user === name),
				topic(name, contract.principal.topics)
			)
	}
	for (let at = 1; at <= complete.putStates.length; at++) {
		const h = harness()
		h.failAfterPut = at
		await assert.rejects(h.run(), /private details suppressed/)
		assert.equal(h.putStates.length, at)
		h.putStates.forEach(verify)
		h.failAfterPut = Infinity
		await h.run()
		h.putStates.forEach(verify)
		assert.equal(
			h.actions.filter(([path]) => path === '/api/users/' + name).length,
			1
		)
	}
	const unsafe = harness()
	unsafe.state.users.push({ name, tags: [] })
	unsafe.state.permissions.push(resource(name, contract.principal))
	await assert.rejects(
		unsafe.run(),
		/preflight; private details suppressed/
	)
	assert.equal(unsafe.actions.length, 0)
})

test('mixed ND resource/topic ACL partial progress resumes only exact pending grants', async () => {
	const h = harness()
	h.failRequest = path =>
		path ===
		'/api/topic-permissions/winwidget/winwidget-notification-delivery'
	await assert.rejects(
		h.run(),
		/notification-acl; private details suppressed/
	)
	assert.deepEqual(
		h.state.permissions.find(
			row => row.user === 'winwidget-notification-delivery'
		),
		resource('winwidget-notification-delivery', contract.notificationAfter)
	)
	h.failRequest = undefined
	await h.run()
	assert.equal(
		h.actions.filter(([path]) => path === '/api/users/' + name).length,
		1
	)
})

test('wrong credentials, extra users/grants and active/unknown/mismatched new queues fail before mutations', async () => {
	const cases = [
		h => h.state.users.push({ name: 'rogue', tags: [] }),
		h =>
			h.state.permissions.push(
				resource(
					'winwidget-notification-delivery',
					contract.notificationBefore
				)
			),
		h => (h.state.topics[0].write = '.*'),
		h =>
			h.topology.queues.push({
				...queueRow(contract.queues[0]),
				consumers: 1
			}),
		h =>
			h.topology.queues.push({
				...queueRow(contract.queues[0]),
				consumers: undefined
			}),
		h =>
			h.topology.queues.push({
				...queueRow(contract.queues[0]),
				arguments: {}
			}),
		h =>
			h.topology.queues.push({
				...queueRow(contract.queues[0]),
				name: 'winwidget.crm.sales.reminders.rogue'
			}),
		h =>
			h.topology.bindings.push({
				source: 'winwidget.events',
				destination: contract.queues[0].name,
				destination_type: 'queue',
				routing_key: '#',
				arguments: {}
			})
	]
	for (const mutate of cases) {
		const h = harness()
		mutate(h)
		await assert.rejects(h.run(), /private details suppressed/)
		assert.equal(h.actions.length, 0)
	}
	const h = harness()
	await h.run()
	h.actions.length = 0
	h.passwords.set(name, 'wrong-existing-secret')
	await assert.rejects(h.run(), /private details suppressed/)
	assert.equal(h.actions.length, 0)
})

test('snapshot waits for new observed statistics and accepts active unrelated consumers', async () => {
	const data = snapshot()
	data.queues.push({
		...queueRow(contract.queues[0]),
		consumers: undefined
	})
	await assert.rejects(
		readCrmRemindersBrokerSnapshot(
			async path => data[path.split('/')[2]],
			1
		),
		/observation is incomplete/
	)
	data.queues[1].consumers = 0
	assertCrmRemindersBrokerSnapshot(
		await readCrmRemindersBrokerSnapshot(
			async path => data[path.split('/')[2]],
			1
		)
	)
	assert.throws(() => assertCrmRemindersBrokerSnapshot(data, true))
})

test('wrapper does not connect before fence and closes admin connection on failed observation', async () => {
	let connected = 0,
		closed = 0
	const connect = async () => {
		connected++
		return {
			createChannel: async () => ({ on() {} }),
			close: async () => {
				closed++
			}
		}
	}
	await assert.rejects(
		bootstrapCrmReminders({
			inputs: inputs(),
			connect,
			request: async () => [],
			assertReleaseFence: async () => {
				throw Error('lost')
			}
		})
	)
	assert.equal(connected, 0)
	await assert.rejects(
		bootstrapCrmReminders({
			inputs: inputs(),
			connect,
			request: async () => [],
			assertReleaseFence: async () => {}
		})
	)
	assert.equal(connected, 1)
	assert.equal(closed, 1)
})
