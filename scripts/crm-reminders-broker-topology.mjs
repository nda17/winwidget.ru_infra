import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
	crmBrokerContract,
	crmNotificationAcl
} from './crm-broker-topology.mjs'

export const CRM_REMINDERS_BROKER_VERSION = 'task-reminders-v1'
export const CRM_REMINDERS_PRINCIPAL = 'winwidget-crm-sales-reminders'
const exact = values =>
	'^(?:' +
	values.map(value => value.replaceAll('.', '\\.')).join('|') +
	')$'
const kinds = [
	[
		'email',
		'winwidget.lead-integration.email',
		'lead.integration.email.v2'
	],
	[
		'telegram',
		'winwidget.lead-integration.telegram',
		'lead.integration.telegram.v2'
	],
	[
		'payment-email',
		'winwidget.payment-notification.email',
		'payment.succeeded.v1'
	],
	[
		'payment-telegram',
		'winwidget.payment-notification.telegram.v2',
		'payment.notification.telegram.requested.v1'
	],
	[
		'limit-email',
		'winwidget.limit-notification.email',
		'lead.limit.reached.email.v2'
	],
	[
		'limit-telegram',
		'winwidget.limit-notification.telegram',
		'lead.limit.reached.telegram.v2'
	],
	[
		'campaign-email',
		'winwidget.notification.campaign.email.v2',
		'notification.campaign.email.requested.v2'
	],
	[
		'campaign-telegram',
		'winwidget.notification.campaign.telegram.v2',
		'notification.campaign.telegram.requested.v2'
	],
	[
		'daily-summary-delivery-telegram',
		'winwidget.notification.daily-summary.telegram',
		'notification.daily-summary.telegram.requested.v1'
	],
	[
		'subscription-expiry-email',
		'winwidget.notification.subscription-expiry.email',
		'notification.subscription-expiry.email.requested.v1'
	],
	[
		'subscription-expiry-telegram',
		'winwidget.notification.subscription-expiry.telegram',
		'notification.subscription-expiry.telegram.requested.v1'
	],
	[
		'wincrm-invitation-email',
		'winwidget.notification.wincrm.invitation.email',
		'notification.wincrm.invitation.email.requested.v1'
	],
	[
		'wincrm-task-reminder-email',
		'winwidget.notification.wincrm.task-reminder.email',
		'notification.wincrm.task-reminder.email.requested.v1'
	],
	[
		'wincrm-task-reminder-telegram',
		'winwidget.notification.wincrm.task-reminder.telegram',
		'notification.wincrm.task-reminder.telegram.requested.v1'
	]
]
export function crmReminderNotificationTopology(enabled = true) {
	assert.equal(typeof enabled, 'boolean')
	const rows = enabled ? kinds : kinds.slice(0, 12)
	return {
		eventsExchange: 'winwidget.events',
		retryExchange: 'winwidget.retry',
		deadLetterExchange: 'winwidget.dead-letter',
		manualRetryExchange: 'winwidget.manual-retry',
		queueNames: rows.map(row => row[1]),
		retryCount: 3,
		readRoutingKeys: rows.flatMap(([kind, , event]) => [
			event,
			`manual.${kind}`,
			`${kind}.dead-letter`
		]),
		writeRoutingKeys: [
			'notification.telegram.destination-unavailable.v1',
			'notification.delivery.outcome.v1',
			'reporting.notification.delivery.outcome.v1',
			'notification.delivery.outcome.v2',
			...rows.map(([kind]) => `manual.${kind}`)
		],
		deadLetterRoutingKeys: rows.map(([kind]) => `${kind}.dead-letter`)
	}
}
export function assertReminderNotificationTopology(input) {
	assert.deepEqual(input, crmReminderNotificationTopology())
	return crmReminderNotificationAcl(input)
}
// Choose exact prefix/suffix trie partitions. This remains a finite set, not a
// wildcard; fourteen kinds exceed the old prefix-only 1KiB ACL.
export function crmReminderExactPattern(values) {
	assert.ok(Array.isArray(values) && values.length > 0)
	for (const value of values) assert.match(value, /^[a-z0-9.-]+$/)
	const cache = new Map(),
		escape = value => value.replaceAll('.', '\\.')
	const emit = rows => {
		const key = JSON.stringify(rows)
		if (cache.has(key)) return cache.get(key)
		if (rows.length === 1) return escape(rows[0])
		const candidates = [false, true].map(reverse => {
			const groups = new Map()
			for (const row of rows) {
				const character = reverse ? row.slice(-1) : row.slice(0, 1)
				if (!groups.has(character)) groups.set(character, [])
				groups
					.get(character)
					.push(reverse ? row.slice(0, -1) : row.slice(1))
			}
			const branches = [...groups].map(([character, rest]) => {
				if (!character) return ''
				return reverse
					? emit(rest) + escape(character)
					: escape(character) + emit(rest)
			})
			return branches.length === 1
				? branches[0]
				: '(?:' + branches.join('|') + ')'
		})
		const result = candidates.sort((a, b) => a.length - b.length)[0]
		cache.set(key, result)
		return result
	}
	const pattern = '^' + emit([...new Set(values)].sort()) + '$'
	assert.ok(Buffer.byteLength(pattern) <= 1024)
	return pattern
}
export function crmReminderNotificationAcl(topology) {
	assert.deepEqual(topology, crmReminderNotificationTopology())
	const pattern = crmReminderExactPattern
	const resource = pattern([
		topology.eventsExchange,
		topology.retryExchange,
		topology.deadLetterExchange,
		topology.manualRetryExchange,
		...topology.queueNames.flatMap(queue => [
			queue,
			queue + '.dead-letter',
			...[1, 2, 3].map(index => queue + '.retry-v2.' + index)
		])
	])
	return {
		configure: resource,
		read: resource,
		write: resource,
		topics: [
			{
				exchange: 'winwidget.events',
				read: pattern(topology.readRoutingKeys),
				write: pattern(topology.writeRoutingKeys)
			},
			{
				exchange: 'winwidget.dead-letter',
				read: pattern(topology.deadLetterRoutingKeys),
				write: pattern(topology.deadLetterRoutingKeys)
			}
		]
	}
}
export function crmRemindersContractEnabled(canonical) {
	const mode = canonical.CRM_REMINDERS_RABBITMQ_CONTRACT ?? 'disabled'
	assert.ok(['disabled', CRM_REMINDERS_BROKER_VERSION].includes(mode))
	if (mode !== 'disabled')
		assert.equal(canonical.CRM_RABBITMQ_CONTRACT, 'mvp-v1')
	return mode !== 'disabled'
}
const queues = [
	{
		name: 'winwidget.crm.sales.reminders',
		durable: true,
		auto_delete: false,
		arguments: {
			'x-queue-type': 'classic',
			'x-dead-letter-exchange': 'winwidget.dead-letter',
			'x-dead-letter-routing-key': 'crm-sales-reminders.dead-letter'
		}
	},
	{
		name: 'winwidget.crm.sales.reminders.dead-letter',
		durable: true,
		auto_delete: false,
		arguments: { 'x-queue-type': 'classic' }
	}
]
const binding = (destination, source, routing_key) => ({
	source,
	destination,
	destination_type: 'queue',
	routing_key,
	arguments: {}
})
const bindings = [
	binding(
		queues[0].name,
		'winwidget.events',
		'crm.sales.reminder.tick.v1'
	),
	binding(
		queues[1].name,
		'winwidget.dead-letter',
		'crm-sales-reminders.dead-letter'
	)
]
for (const [kind, name, event] of kinds.slice(12)) {
	queues.push(
		{ name, durable: true, auto_delete: false, arguments: {} },
		{
			name: name + '.dead-letter',
			durable: true,
			auto_delete: false,
			arguments: {}
		}
	)
	bindings.push(
		binding(name, 'winwidget.events', event),
		binding(name, 'winwidget.events', `manual.${kind}`),
		binding(name, 'winwidget.manual-retry', kind),
		binding(
			name + '.dead-letter',
			'winwidget.dead-letter',
			kind + '.dead-letter'
		),
		binding(
			name + '.dead-letter',
			'winwidget.events',
			kind + '.dead-letter'
		)
	)
	for (const [index, delay] of [30000, 300000, 1800000].entries()) {
		const retry = `${name}.retry-v2.${index + 1}`
		queues.push({
			name: retry,
			durable: true,
			auto_delete: false,
			arguments: {
				'x-message-ttl': delay,
				'x-dead-letter-exchange': 'winwidget.manual-retry',
				'x-dead-letter-routing-key': kind
			}
		})
		bindings.push(
			binding(retry, 'winwidget.retry', `${kind}.retry.${index + 1}`)
		)
	}
}
const principal = {
	name: CRM_REMINDERS_PRINCIPAL,
	configure: '^$',
	read: exact(['winwidget.crm.sales.reminders']),
	write: exact(['winwidget.events']),
	topics: [
		{
			exchange: 'winwidget.events',
			read: '^$',
			write: exact([
				'crm.sales.reminder.tick.v1',
				...kinds.slice(12).map(row => row[2])
			])
		}
	]
}
const contract = {
	version: CRM_REMINDERS_BROKER_VERSION,
	vhost: 'winwidget',
	queues,
	bindings,
	principal,
	notificationBefore: crmNotificationAcl(
		crmReminderNotificationTopology(false)
	),
	notificationAfter: crmReminderNotificationAcl(
		crmReminderNotificationTopology()
	)
}
const contractSha256 = createHash('sha256')
	.update(JSON.stringify(contract))
	.digest('hex')
export const crmRemindersBrokerContract = () => structuredClone(contract)
const owned = name =>
	[
		'winwidget.crm.sales.reminders',
		...kinds.slice(12).map(row => row[1])
	].some(prefix => name === prefix || name.startsWith(prefix + '.'))
const bindingKey = value =>
	JSON.stringify([
		value.source,
		value.destination,
		value.destination_type,
		value.routing_key,
		value.arguments
	])

export async function readCrmRemindersBrokerSnapshot(
	request,
	timeoutMs = 15000,
	activation = 'reminders'
) {
	assert.ok(['reminders', 'intake-sla'].includes(activation))
	const owns =
		activation === 'intake-sla'
			? (await import('./crm-intake-sla-broker-topology.mjs'))
					.crmIntakeSlaBrokerOwns
			: owned
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
		assert.ok([exchanges, queues, bindings].every(Array.isArray))
		if (
			queues.every(
				row =>
					row &&
					typeof row.name === 'string' &&
					(!owns(row.name) ||
						(Number.isSafeInteger(row.consumers) && row.consumers >= 0))
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
	throw new Error('CRM reminder broker observation is incomplete')
}

// Management may materialize the broker's classic default even when assertQueue
// omitted it. Accept only that exact representation, never other arguments.
export function assertClassicQueueArguments(row, expected) {
	assert.equal(row.type, 'classic')
	assert.ok(
		row.arguments &&
			typeof row.arguments === 'object' &&
			!Array.isArray(row.arguments)
	)
	const actual = { ...row.arguments }
	if (
		!Object.hasOwn(expected, 'x-queue-type') &&
		actual['x-queue-type'] === 'classic'
	)
		delete actual['x-queue-type']
	assert.deepEqual(actual, expected)
}

export function assertCrmRemindersBrokerSnapshot(
	snapshot,
	complete = false
) {
	assert.ok(
		snapshot &&
			['exchanges', 'queues', 'bindings'].every(key =>
				Array.isArray(snapshot[key])
			)
	)
	for (const [name, type] of [
		['winwidget.events', 'topic'],
		['winwidget.dead-letter', 'topic'],
		['winwidget.retry', 'direct'],
		['winwidget.manual-retry', 'direct']
	]) {
		const rows = snapshot.exchanges.filter(row => row.name === name)
		assert.equal(rows.length, 1)
		assert.equal(rows[0].type, type)
		assert.equal(rows[0].durable, true)
		assert.equal(rows[0].auto_delete, false)
		assert.equal(rows[0].internal, false)
		assert.deepEqual(rows[0].arguments, {})
	}
	assert.equal(
		new Set(snapshot.queues.map(row => row.name)).size,
		snapshot.queues.length
	)
	for (const row of snapshot.queues.filter(row => owned(row.name))) {
		const expected = queues.find(queue => queue.name === row.name)
		assert.ok(expected, 'Unexpected reminder queue')
		assert.equal(row.type, 'classic')
		assert.equal(row.durable, true)
		assert.equal(row.exclusive, false)
		assert.equal(row.auto_delete, false)
		assert.equal(row.consumers, 0)
		assertClassicQueueArguments(row, expected.arguments)
		assert.deepEqual(row.effective_policy_definition ?? {}, {})
	}
	if (complete)
		for (const queue of queues)
			assert.ok(snapshot.queues.some(row => row.name === queue.name))
	const actual = []
	for (const row of snapshot.bindings) {
		if (!owned(row.source) && !owned(row.destination)) continue
		if (
			row.source === '' &&
			queues.some(queue => queue.name === row.destination) &&
			row.routing_key === row.destination &&
			row.destination_type === 'queue' &&
			isDeepStrictEqual(row.arguments, {})
		)
			continue
		const key = bindingKey(row)
		assert.ok(
			bindings.some(binding => bindingKey(binding) === key) &&
				!actual.includes(key),
			'Unexpected reminder binding'
		)
		actual.push(key)
	}
	if (complete)
		assert.deepEqual(actual.sort(), bindings.map(bindingKey).sort())
	return {
		contractSha256,
		topologyVerified: complete,
		queues: queues.length,
		bindings: bindings.length,
		releaseApproved: false
	}
}

export async function provisionCrmRemindersBroker({
	channel,
	request,
	connect,
	credentials,
	legacyPrincipals,
	readSnapshot,
	assertReleaseFence,
	activation = 'reminders'
}) {
	let stage = 'preflight'
	try {
		assert.ok(['reminders', 'intake-sla'].includes(activation))
		const sla = activation === 'intake-sla'
		const module = sla
			? await import('./crm-intake-sla-broker-topology.mjs')
			: null
		const selected = sla ? module.crmIntakeSlaBrokerContract() : contract
		const principals = sla ? selected.principals : [principal]
		const names = principals.map(row => row.name)
		const owns = sla ? module.crmIntakeSlaBrokerOwns : owned
		const assertSnapshot = sla
			? module.assertCrmIntakeSlaBrokerSnapshot
			: assertCrmRemindersBrokerSnapshot
		assert.equal(typeof assertReleaseFence, 'function')
		assert.deepEqual(Object.keys(credentials).sort(), [...names].sort())
		for (const name of names)
			assert.match(credentials[name], /^[a-f0-9]{48,128}$/)
		assert.equal(new Set(Object.values(credentials)).size, names.length)
		assert.equal(legacyPrincipals.length, sla ? 26 : 25)
		assert.equal(new Set(legacyPrincipals).size, legacyPrincipals.length)
		assert.ok(
			legacyPrincipals.includes('winwidget-notification-delivery') &&
				names.every(name => !legacyPrincipals.includes(name))
		)
		credentials = { ...credentials }
		legacyPrincipals = [...legacyPrincipals]
		const read = async () => {
			const [users, permissions, topics] = await Promise.all(
				['/api/users', '/api/permissions', '/api/topic-permissions'].map(
					path => request(path)
				)
			)
			assert.ok([users, permissions, topics].every(Array.isArray))
			assert.deepEqual(
				users
					.filter(user => !names.includes(user.name))
					.map(user => user.name)
					.sort(),
				[...legacyPrincipals].sort()
			)
			assert.equal(
				new Set(users.map(user => user.name)).size,
				users.length
			)
			assert.ok(
				[...permissions, ...topics].every(grant =>
					users.some(user => user.name === grant.user)
				)
			)
			return { users, permissions, topics }
		}
		const grant = (name, acl) => ({
			user: name,
			vhost: 'winwidget',
			configure: acl.configure,
			write: acl.write,
			read: acl.read
		})
		const grants = (name, acl) =>
			acl.topics.map(topic => ({
				user: name,
				vhost: 'winwidget',
				...topic
			}))
		const validate = (state, complete) => {
			for (const principal of principals) {
				const name = principal.name
				const user = state.users.find(user => user.name === name)
				if (complete) assert.ok(user)
				if (user) {
					assert.deepEqual(user.tags, [])
					assert.deepEqual(user.limits ?? {}, {})
				}
				const resource = state.permissions.filter(row => row.user === name)
				assert.ok(resource.length <= 1)
				if (resource.length || complete)
					assert.deepEqual(resource, [grant(name, principal)])
				const topics = state.topics.filter(row => row.user === name)
				assert.ok(topics.length <= principal.topics.length)
				if (topics.length || resource.length || complete)
					assert.deepEqual(topics, grants(name, principal))
				if (!user) assert.equal(resource.length + topics.length, 0)
			}
			const notification = 'winwidget-notification-delivery'
			const nd = state.permissions.filter(row => row.user === notification)
			assert.ok(
				isDeepStrictEqual(nd, [
					grant(notification, selected.notificationAfter)
				]) ||
					(!complete &&
						isDeepStrictEqual(nd, [
							grant(notification, selected.notificationBefore)
						]))
			)
			const nt = state.topics.filter(row => row.user === notification)
			assert.equal(nt.length, 2)
			assert.equal(new Set(nt.map(row => row.exchange)).size, 2)
			for (const topic of nt)
				assert.ok(
					grants(notification, selected.notificationAfter).some(row =>
						isDeepStrictEqual(row, topic)
					) ||
						(!complete &&
							grants(notification, selected.notificationBefore).some(row =>
								isDeepStrictEqual(row, topic)
							))
				)
		}
		const authenticate = async name => {
			await assertReleaseFence()
			const connection = await connect(name, credentials[name])
			try {
				const probe = await connection.createChannel()
				await probe.close()
			} finally {
				await connection.close()
			}
		}
		await assertReleaseFence()
		const before = await read()
		validate(before, false)
		const topologyBefore = await readSnapshot()
		assertSnapshot(topologyBefore)
		for (const name of names)
			if (before.permissions.some(row => row.user === name))
				await authenticate(name)
		stage = 'topology'
		for (const exchange of selected.exchanges ?? []) {
			await assertReleaseFence()
			await channel.assertExchange(exchange.name, exchange.type, {
				durable: true,
				autoDelete: false,
				internal: false,
				arguments: exchange.arguments
			})
		}
		for (const queue of selected.queues) {
			await assertReleaseFence()
			await channel.assertQueue(queue.name, {
				durable: true,
				exclusive: false,
				autoDelete: false,
				arguments: queue.arguments
			})
		}
		for (const row of selected.bindings) {
			await assertReleaseFence()
			await channel.bindQueue(
				row.destination,
				row.source,
				row.routing_key,
				{}
			)
		}
		stage = 'principal'
		for (const principal of principals) {
			const name = principal.name
			if (!before.users.some(user => user.name === name)) {
				await assertReleaseFence()
				await request(`/api/users/${name}`, 'PUT', {
					password: credentials[name],
					tags: ''
				})
			}
			// A missing topic grant is unrestricted in RabbitMQ. Establish its exact
			// restriction before allowing any write to the shared topic exchange.
			for (const topic of principal.topics)
				if (
					!before.topics.some(
						row => row.user === name && row.exchange === topic.exchange
					)
				) {
					await assertReleaseFence()
					await request(
						`/api/topic-permissions/winwidget/${name}`,
						'PUT',
						topic
					)
				}
			if (!before.permissions.some(row => row.user === name)) {
				await assertReleaseFence()
				await request(`/api/permissions/winwidget/${name}`, 'PUT', {
					configure: principal.configure,
					read: principal.read,
					write: principal.write
				})
			}
		}
		stage = 'notification-acl'
		const ndName = 'winwidget-notification-delivery',
			acl = selected.notificationAfter
		if (
			!isDeepStrictEqual(
				before.permissions.find(row => row.user === ndName),
				grant(ndName, acl)
			)
		) {
			await assertReleaseFence()
			await request(`/api/permissions/winwidget/${ndName}`, 'PUT', {
				configure: acl.configure,
				read: acl.read,
				write: acl.write
			})
		}
		for (const topic of acl.topics)
			if (
				!before.topics.some(row =>
					isDeepStrictEqual(row, {
						user: ndName,
						vhost: 'winwidget',
						...topic
					})
				)
			) {
				await assertReleaseFence()
				await request(
					`/api/topic-permissions/winwidget/${ndName}`,
					'PUT',
					topic
				)
			}
		stage = 'verify'
		for (const name of names) await authenticate(name)
		await assertReleaseFence()
		const after = await read()
		validate(after, true)
		const stable = state => ({
			users: state.users
				.filter(row => !names.includes(row.name))
				.sort((a, b) => a.name.localeCompare(b.name)),
			permissions: state.permissions
				.filter(row => ![...names, ndName].includes(row.user))
				.sort((a, b) =>
					JSON.stringify(a).localeCompare(JSON.stringify(b))
				),
			topics: state.topics
				.filter(row => ![...names, ndName].includes(row.user))
				.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
		})
		assert.deepEqual(stable(after), stable(before))
		for (const user of before.users)
			assert.deepEqual(
				after.users.find(row => row.name === user.name),
				user
			)
		const topologyAfter = await readSnapshot()
		const stableTopology = snapshot => ({
			exchanges: snapshot.exchanges
				.filter(row => !owns(row.name))
				.map(
					({
						name,
						durable,
						auto_delete,
						type,
						internal,
						arguments: args
					}) => ({
						name,
						durable,
						auto_delete,
						type,
						internal,
						arguments: args
					})
				)
				.sort((a, b) => a.name.localeCompare(b.name)),
			queues: snapshot.queues
				.filter(row => !owns(row.name))
				.map(
					({
						name,
						durable,
						auto_delete,
						type,
						exclusive,
						arguments: args
					}) => ({
						name,
						durable,
						auto_delete,
						type,
						exclusive,
						arguments: args
					})
				)
				.sort((a, b) => a.name.localeCompare(b.name)),
			bindings: snapshot.bindings
				.filter(row => !owns(row.source) && !owns(row.destination))
				.map(bindingKey)
				.sort()
		})
		assert.deepEqual(
			stableTopology(topologyAfter),
			stableTopology(topologyBefore)
		)
		return {
			...assertSnapshot(topologyAfter, true),
			credentialsProvisioned: true,
			authenticatedPrincipals: names.length,
			legacyPrincipalsUnchanged: legacyPrincipals.length - 1,
			notificationAclVerified: true,
			notificationKinds: sla ? 16 : 14
		}
	} catch {
		throw new Error(
			'CRM reminder broker bootstrap failed at ' +
				stage +
				'; private details suppressed'
		)
	}
}

export function crmReminderBrokerInputs(
	canonical,
	crm,
	notificationTopology
) {
	try {
		crmRemindersContractEnabled(canonical)
		assert.equal(canonical.CRM_RABBITMQ_CONTRACT, 'mvp-v1')
		assert.equal(canonical.RABBITMQ_VHOST, 'winwidget')
		assert.equal(
			canonical.RABBITMQ_MANAGEMENT_URL,
			'http://127.0.0.1:15672'
		)
		assertReminderNotificationTopology(notificationTopology)
		assert.ok(
			[
				kinds
					.slice(0, 12)
					.map(row => row[0])
					.join(','),
				kinds.map(row => row[0]).join(',')
			].includes(canonical.NOTIFICATION_DELIVERY_KINDS)
		)
		const admin = {
			username: canonical.RABBITMQ_ADMIN_USER,
			password: canonical.RABBITMQ_ADMIN_PASSWORD
		}
		assert.match(admin.username, /^[a-z][a-z0-9-]{0,99}$/)
		assert.ok(
			typeof admin.password === 'string' &&
				admin.password.length >= 32 &&
				!/[\0\r\n]/.test(admin.password)
		)
		assert.match(canonical.RABBITMQ_MONITOR_USER, /^[a-z][a-z0-9-]{0,99}$/)
		const url = new URL(crm.CRM_SALES_REMINDERS_RABBITMQ_URL)
		assert.equal(url.protocol, 'amqp:')
		assert.equal(url.hostname, '127.0.0.1')
		assert.ok(['', '5672'].includes(url.port))
		assert.equal(url.username, CRM_REMINDERS_PRINCIPAL)
		assert.equal(url.pathname, '/winwidget')
		assert.ok(!url.hash && !url.search)
		const password = decodeURIComponent(url.password)
		assert.match(password, /^[a-f0-9]{48,128}$/)
		assert.notEqual(password, admin.password)
		const legacyPrincipals = [
			admin.username,
			canonical.RABBITMQ_MONITOR_USER,
			...[
				'notification-delivery',
				'campaigns',
				'reporting',
				'widgets',
				'billing-worker',
				'billing-publisher',
				'identity-worker',
				'identity-publisher',
				'platform-publisher',
				'support-worker',
				'support-publisher',
				'operations-worker',
				'operations-restore-worker',
				'operations-publisher'
			].map(name => 'winwidget-' + name),
			...crmBrokerContract().principals.map(row => row.name)
		]
		assert.equal(new Set(legacyPrincipals).size, 25)
		assert.ok(!legacyPrincipals.includes(CRM_REMINDERS_PRINCIPAL))
		return {
			admin,
			credentials: { [CRM_REMINDERS_PRINCIPAL]: password },
			legacyPrincipals
		}
	} catch {
		throw new Error(
			'Invalid CRM reminder broker inputs; private details suppressed'
		)
	}
}
