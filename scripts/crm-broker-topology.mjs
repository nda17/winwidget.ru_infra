import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

// Deployment tooling only. The CRM controller owns transport, credentials,
// the shared deploy lock and the immutable image/env checks.
// No business publication, consumption, purge, credential rotation or deletion.
const exact = values =>
	'^(?:' +
	values.map(value => value.replaceAll('.', '\\.')).join('|') +
	')$'
const exchanges = [
	{ name: 'winwidget.events', type: 'topic', owned: false },
	{ name: 'winwidget.dead-letter', type: 'topic', owned: false },
	{ name: 'winwidget.manual-retry', type: 'direct', owned: false }
]
const queues = []
const bindings = []
const principals = []
const binding = (queue, source, routingKey) =>
	bindings.push({
		source,
		destination: queue,
		destination_type: 'queue',
		routing_key: routingKey,
		arguments: {}
	})
const queue = name =>
	queues.push({
		name,
		durable: true,
		auto_delete: false,
		arguments: { 'x-queue-type': 'classic' }
	})
const principal = (name, read, write, topics = []) =>
	principals.push({ name, configure: '^$', read, write, topics })

for (const [consumer, event] of [
	['provision', 'crm.access.invitation-provision.v1'],
	['acceptance', 'identity.wincrm.invitation-accepted.v1'],
	['admission', 'crm.access.admission-wake.v1']
]) {
	const name = 'winwidget.crm-access.team.' + consumer
	queue(name)
	queue(name + '.dead-letter')
	binding(name, 'winwidget.events', event)
	binding(name, 'winwidget.manual-retry', 'crm-access.team.' + consumer)
	binding(
		name + '.dead-letter',
		'winwidget.dead-letter',
		'crm-access.team.' + consumer + '.dead-letter'
	)
}
principal(
	'winwidget-crm-access-worker',
	exact(
		queues
			.filter(item => !item.name.endsWith('.dead-letter'))
			.map(item => item.name)
	),
	'^$'
)
principal(
	'winwidget-crm-access-outbox-publisher',
	'^$',
	exact(exchanges.map(item => item.name)),
	[
		{
			exchange: 'winwidget.events',
			read: '^$',
			write: exact([
				'crm.access.invitation-provision.v1',
				'crm.access.admission-wake.v1'
			])
		},
		{
			exchange: 'winwidget.dead-letter',
			read: '^$',
			write: exact(
				['provision', 'acceptance', 'admission'].map(
					kind => 'crm-access.team.' + kind + '.dead-letter'
				)
			)
		}
	]
)
for (const [kind, prefix, name, event] of [
	[
		'',
		'winwidget.crm-intake',
		'winwidget.crm-intake.acceptance.v1',
		'crm.intake.acceptance.requested.v1'
	],
	[
		'widget-control-',
		'winwidget.crm-intake.widget-control',
		'winwidget.crm-intake.widget-control.v1',
		'crm.intake.widget-control.requested.v1'
	],
	[
		'widget-transfer-',
		'winwidget.crm-intake.widget-transfer',
		'winwidget.crm-intake.widget-transfer.v1',
		'widgets.wincrm.lead-transfer.requested.v1'
	]
]) {
	for (const suffix of ['events', 'dead-letter'])
		exchanges.push({
			name: prefix + '.' + suffix,
			type: 'direct',
			owned: true
		})
	queue(name)
	queue(name + '.dead-letter')
	binding(name, prefix + '.events', event)
	binding(name + '.dead-letter', prefix + '.dead-letter', event)
	if (kind === 'widget-transfer-') binding(name, 'winwidget.events', event)
	principal('winwidget-crm-intake-' + kind + 'worker', exact([name]), '^$')
	principal(
		'winwidget-crm-intake-' + kind + 'publisher',
		'^$',
		exact([prefix + '.events', prefix + '.dead-letter'])
	)
}
const providerQueue = 'winwidget.billing.wincrm-provider.v1'
const providerDead = 'winwidget.billing.wincrm-provider.dead-letter'
const providerEvent = 'billing.wincrm.provider-operation.requested.v1'
exchanges.push({ name: providerDead, type: 'direct', owned: true })
queue(providerQueue)
queue(providerQueue + '.dead-letter')
binding(providerQueue, 'winwidget.events', providerEvent)
binding(providerQueue + '.dead-letter', providerDead, providerEvent)
principal(
	'winwidget-billing-wincrm-provider-worker',
	exact([providerQueue]),
	'^$'
)

const contract = {
	version: 'mvp-v1',
	vhost: 'winwidget',
	exchanges,
	queues,
	bindings,
	principals
}
const contractSha256 = createHash('sha256')
	.update(JSON.stringify(contract))
	.digest('hex')
export const crmBrokerContract = () => structuredClone(contract)

// Run only inside the CRM controller's locked bootstrap stage. Existing
// credentials are never reset; an interrupted bootstrap resumes missing grants.
export async function provisionCrmBrokerPrincipals({
	channel,
	request,
	readSnapshot,
	assertReleaseFence,
	connect,
	credentials,
	legacyPrincipals
}) {
	let stage = 'preflight'
	const crmNames = principals.map(item => item.name)
	const object = value =>
		value && typeof value === 'object' && !Array.isArray(value)
	const snapshot = async () => {
		const [users, permissions, topics] = await Promise.all([
			request('/api/users'),
			request('/api/permissions'),
			request('/api/topic-permissions')
		])
		assert.ok([users, permissions, topics].every(Array.isArray))
		assert.ok(
			users.every(item => object(item) && typeof item.name === 'string')
		)
		assert.equal(new Set(users.map(item => item.name)).size, users.length)
		assert.ok(
			[...permissions, ...topics].every(
				item =>
					object(item) &&
					typeof item.user === 'string' &&
					typeof item.vhost === 'string' &&
					users.some(user => user.name === item.user)
			)
		)
		assert.deepEqual(
			users
				.filter(item => !crmNames.includes(item.name))
				.map(item => item.name)
				.sort(),
			[...legacyPrincipals].sort()
		)
		return { users, permissions, topics }
	}
	const withoutCrm = value => ({
		users: value.users
			.filter(item => !crmNames.includes(item.name))
			.sort((a, b) => a.name.localeCompare(b.name)),
		permissions: value.permissions
			.filter(item => !crmNames.includes(item.user))
			.sort((a, b) =>
				JSON.stringify([a.user, a.vhost]).localeCompare(
					JSON.stringify([b.user, b.vhost])
				)
			),
		topics: value.topics
			.filter(item => !crmNames.includes(item.user))
			.sort((a, b) =>
				JSON.stringify([a.user, a.vhost, a.exchange]).localeCompare(
					JSON.stringify([b.user, b.vhost, b.exchange])
				)
			)
	})
	const resourceGrant = principal => ({
		user: principal.name,
		vhost: 'winwidget',
		configure: principal.configure,
		write: principal.write,
		read: principal.read
	})
	const topicGrants = principal =>
		principal.topics.map(topic => ({
			user: principal.name,
			vhost: 'winwidget',
			...topic
		}))
	const validatePartial = (state, complete) => {
		for (const principal of principals) {
			const user = state.users.find(item => item.name === principal.name)
			if (complete) assert.ok(user)
			if (user) {
				assert.deepEqual(user.tags, [])
				assert.deepEqual(user.limits ?? {}, {})
			}
			const grants = state.permissions.filter(
				item => item.user === principal.name
			)
			if (!user) assert.equal(grants.length, 0)
			assert.ok(grants.length <= 1)
			if (complete || grants.length)
				assert.deepEqual(grants, [resourceGrant(principal)])
			const allowed = topicGrants(principal)
			const actual = state.topics.filter(
				item => item.user === principal.name
			)
			if (!user) assert.equal(actual.length, 0)
			assert.equal(
				new Set(actual.map(item => item.exchange)).size,
				actual.length
			)
			for (const grant of actual)
				assert.ok(allowed.some(item => isDeepStrictEqual(item, grant)))
			if (complete) assert.equal(actual.length, allowed.length)
		}
	}
	const authenticate = async principal => {
		await assertReleaseFence()
		const connection = await connect(
			principal.name,
			credentials[principal.name]
		)
		try {
			const probe = await connection.createChannel()
			await probe.close()
		} finally {
			await connection.close()
		}
	}
	try {
		assert.equal(typeof assertReleaseFence, 'function')
		assert.equal(typeof connect, 'function')
		assert.ok(
			Array.isArray(legacyPrincipals) &&
				legacyPrincipals.length === 16 &&
				new Set(legacyPrincipals).size === 16 &&
				legacyPrincipals.every(
					name =>
						typeof name === 'string' &&
						/^[a-z][a-z0-9-]{0,99}$/.test(name) &&
						!crmNames.includes(name)
				)
		)
		assert.deepEqual(Object.keys(credentials).sort(), [...crmNames].sort())
		assert.ok(
			Object.values(credentials).every(
				value =>
					typeof value === 'string' && /^[a-f0-9]{48,128}$/.test(value)
			)
		)
		assert.equal(
			new Set(Object.values(credentials)).size,
			principals.length
		)
		// Capture caller-owned values before any asynchronous operation.
		credentials = { ...credentials }
		legacyPrincipals = [...legacyPrincipals]
		await assertReleaseFence()
		const before = await snapshot()
		validatePartial(before, false)
		// Opening a connection requires a vhost grant. An interrupted bootstrap
		// without that grant is checked after the exact missing grant is installed.
		for (const principal of principals.filter(item =>
			before.permissions.some(grant => grant.user === item.name)
		))
			await authenticate(principal)
		stage = 'topology'
		await provisionCrmBrokerTopology({
			channel,
			readSnapshot,
			assertReleaseFence
		})
		stage = 'principals'
		for (const principal of principals) {
			const name = encodeURIComponent(principal.name)
			if (!before.users.some(item => item.name === principal.name)) {
				await assertReleaseFence()
				await request('/api/users/' + name, 'PUT', {
					password: credentials[principal.name],
					tags: ''
				})
			}
			if (!before.permissions.some(item => item.user === principal.name)) {
				await assertReleaseFence()
				await request('/api/permissions/winwidget/' + name, 'PUT', {
					configure: principal.configure,
					write: principal.write,
					read: principal.read
				})
			}
			for (const topic of principal.topics) {
				if (
					before.topics.some(
						item =>
							item.user === principal.name &&
							item.exchange === topic.exchange
					)
				)
					continue
				await assertReleaseFence()
				await request(
					'/api/topic-permissions/winwidget/' + name,
					'PUT',
					topic
				)
			}
		}
		stage = 'authenticate'
		for (const principal of principals) await authenticate(principal)
		stage = 'verify'
		await assertReleaseFence()
		const after = await snapshot()
		validatePartial(after, true)
		assert.deepEqual(withoutCrm(after), withoutCrm(before))
		for (const user of before.users)
			assert.deepEqual(
				after.users.find(item => item.name === user.name),
				user
			)
		const topology = assertCrmBrokerSnapshot(await readSnapshot(), true)
		return {
			...topology,
			credentialsProvisioned: true,
			authenticatedPrincipals: 9,
			legacyPrincipalsUnchanged: 16,
			releaseApproved: false
		}
	} catch {
		throw new Error('CRM broker bootstrap failed at ' + stage)
	}
}
const key = value =>
	JSON.stringify([
		value.source,
		value.destination,
		value.destination_type,
		value.routing_key,
		value.arguments
	])
const ownedName = name =>
	[
		'winwidget.crm-access',
		'winwidget.crm-intake',
		'winwidget.billing.wincrm-provider'
	].some(prefix => name === prefix || name.startsWith(prefix + '.'))

export async function readCrmBrokerSnapshot(request, timeoutMs = 15000) {
	assert.ok(
		Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000
	)
	const deadline = Date.now() + timeoutMs
	do {
		const [exchanges, queues, bindings] = await Promise.all(
			['exchanges', 'queues', 'bindings'].map(kind =>
				request('/api/' + kind + '/winwidget')
			)
		)
		assert.ok(
			[exchanges, queues, bindings].every(Array.isArray),
			'Invalid broker observation'
		)
		// RabbitMQ Management creates resource rows before its first statistics
		// sample. An absent consumer count is UNKNOWN, never a proven zero.
		if (
			queues.every(
				item =>
					item &&
					typeof item.name === 'string' &&
					(!ownedName(item.name) ||
						(Number.isSafeInteger(item.consumers) && item.consumers >= 0))
			)
		)
			return { exchanges, queues, bindings }
		if (Date.now() >= deadline) break
		await new Promise(resolve =>
			setTimeout(
				resolve,
				Math.min(250, Math.max(1, deadline - Date.now()))
			)
		)
	} while (Date.now() <= deadline)
	throw new Error('CRM broker observation is incomplete')
}

export function assertCrmBrokerSnapshot(snapshot, complete = false) {
	assert.ok(
		snapshot &&
			['exchanges', 'queues', 'bindings'].every(field =>
				Array.isArray(snapshot[field])
			),
		'Invalid broker inventory'
	)
	for (const [field, desired] of [
		['exchanges', exchanges],
		['queues', queues]
	]) {
		const wanted = new Map(desired.map(item => [item.name, item]))
		const names = new Set()
		for (const item of snapshot[field]) {
			assert.ok(
				item && typeof item.name === 'string' && !names.has(item.name),
				'Invalid broker resource identity'
			)
			names.add(item.name)
			const expected = wanted.get(item.name)
			if (!expected) {
				assert.ok(
					!ownedName(item.name),
					'Unrecognized CRM topology requires an explicit recovery plan'
				)
				continue
			}
			assert.equal(item.durable, true, 'CRM resources must be durable')
			assert.equal(
				item.auto_delete,
				false,
				'Auto-delete CRM resources are forbidden'
			)
			assert.deepEqual(
				item.arguments,
				field === 'queues' ? expected.arguments : {},
				'CRM topology arguments differ; no TTL/DLX migration is implicit'
			)
			if (field === 'exchanges') {
				assert.equal(item.type, expected.type, 'Exchange type differs')
				assert.equal(
					item.internal,
					false,
					'Internal exchange is forbidden'
				)
			} else {
				assert.equal(item.type, 'classic', 'CRM queue type differs')
				assert.equal(
					item.exclusive,
					false,
					'Exclusive CRM queue is forbidden'
				)
				assert.equal(
					item.consumers,
					0,
					'CRM consumers must be stopped before topology provisioning'
				)
				assert.deepEqual(
					item.effective_policy_definition ?? {},
					{},
					'Queue policy requires separate review'
				)
			}
		}
		for (const item of desired)
			if (complete || item.owned === false)
				assert.ok(
					names.has(item.name),
					'Required broker resource is absent'
				)
	}
	const expectedBindings = new Set(bindings.map(key))
	const actualBindings = new Set()
	for (const item of snapshot.bindings) {
		assert.ok(
			item &&
				typeof item.source === 'string' &&
				typeof item.destination === 'string',
			'Invalid binding identity'
		)
		if (!ownedName(item.source) && !ownedName(item.destination)) continue
		// RabbitMQ provides an implicit default-exchange binding for each queue.
		if (
			item.source === '' &&
			queues.some(queue => queue.name === item.destination) &&
			item.destination_type === 'queue' &&
			item.routing_key === item.destination &&
			JSON.stringify(item.arguments) === '{}'
		)
			continue
		const value = key(item)
		assert.ok(
			expectedBindings.has(value) && !actualBindings.has(value),
			'Unexpected CRM binding'
		)
		actualBindings.add(value)
	}
	if (complete)
		assert.deepEqual(
			[...actualBindings].sort(),
			[...expectedBindings].sort(),
			'CRM bindings are incomplete'
		)
	return {
		contractSha256,
		topologyVerified: complete,
		credentialsProvisioned: false,
		releaseApproved: false,
		expectedPrincipals: 9,
		ownedExchanges: 7,
		queues: 14,
		bindings: 18
	}
}

export async function provisionCrmBrokerTopology({
	channel,
	readSnapshot,
	assertReleaseFence
}) {
	// Deliberately no standalone CLI: a pinned CRM controller must supply a
	// fresh deploy-lock/env/image fence before EVERY mutation and final proof.
	let stage = 'preflight'
	try {
		assert.equal(typeof assertReleaseFence, 'function')
		assert.equal(typeof readSnapshot, 'function')
		await assertReleaseFence()
		assertCrmBrokerSnapshot(await readSnapshot())
		stage = 'declare-exchanges'
		for (const exchange of exchanges.filter(item => item.owned)) {
			await assertReleaseFence()
			await channel.assertExchange(exchange.name, exchange.type, {
				durable: true,
				autoDelete: false,
				internal: false,
				arguments: {}
			})
		}
		stage = 'declare-queues'
		for (const item of queues) {
			await assertReleaseFence()
			await channel.assertQueue(item.name, {
				durable: true,
				exclusive: false,
				autoDelete: false,
				arguments: item.arguments
			})
		}
		stage = 'bind-queues'
		for (const item of bindings) {
			await assertReleaseFence()
			await channel.bindQueue(
				item.destination,
				item.source,
				item.routing_key,
				{}
			)
		}
		stage = 'verify'
		await assertReleaseFence()
		return assertCrmBrokerSnapshot(await readSnapshot(), true)
	} catch {
		// Do not expose broker exceptions, addresses, credentials or message data.
		throw new Error('CRM topology provisioning failed at ' + stage)
	}
}
