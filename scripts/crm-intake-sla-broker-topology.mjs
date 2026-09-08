import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
	CRM_REMINDERS_BROKER_VERSION,
	CRM_REMINDERS_PRINCIPAL,
	assertClassicQueueArguments,
	crmReminderBrokerInputs,
	crmReminderExactPattern,
	crmReminderNotificationTopology,
	crmRemindersBrokerContract
} from './crm-reminders-broker-topology.mjs'

export const CRM_INTAKE_SLA_BROKER_VERSION = 'intake-sla-v1'
export const CRM_INTAKE_SLA_WORKER = 'winwidget-crm-intake-sla-worker'
export const CRM_INTAKE_SLA_PUBLISHER =
	'winwidget-crm-intake-sla-publisher'
const pattern = crmReminderExactPattern
const kinds = ['email', 'telegram'].map(channel => [
	`wincrm-intake-sla-${channel}`,
	`winwidget.notification.wincrm.intake-sla.${channel}`,
	`notification.wincrm.intake-sla.${channel}.requested.v1`
])
const event = 'crm.intake.sla.evaluate.v1'
const mainQueue = 'winwidget.crm-intake.sla.v1'
const exchanges = ['events', 'dead-letter'].map(suffix => ({
	name: `winwidget.crm-intake.sla.${suffix}`,
	type: 'direct',
	durable: true,
	auto_delete: false,
	internal: false,
	arguments: {}
}))
export function crmIntakeSlaNotificationTopology(enabled = true) {
	assert.equal(typeof enabled, 'boolean')
	const previous = crmReminderNotificationTopology()
	if (!enabled) return previous
	return {
		...previous,
		queueNames: [...previous.queueNames, ...kinds.map(row => row[1])],
		readRoutingKeys: [
			...previous.readRoutingKeys,
			...kinds.flatMap(([kind, , type]) => [
				type,
				`manual.${kind}`,
				`${kind}.dead-letter`
			])
		],
		writeRoutingKeys: [
			...previous.writeRoutingKeys,
			...kinds.map(([kind]) => `manual.${kind}`)
		],
		deadLetterRoutingKeys: [
			...previous.deadLetterRoutingKeys,
			...kinds.map(([kind]) => `${kind}.dead-letter`)
		]
	}
}
export function crmIntakeSlaNotificationAcl(topology) {
	assert.deepEqual(topology, crmIntakeSlaNotificationTopology())
	const sharedExchanges = pattern([
		topology.eventsExchange,
		topology.retryExchange,
		topology.deadLetterExchange,
		topology.manualRetryExchange
	])
	// Every listed queue has exactly this same finite suffix set. Factoring it
	// once avoids exceeding RabbitMQ's 1KiB ACL bound; no wildcard is introduced.
	const resource = `^(?:${sharedExchanges.slice(1, -1)}|${pattern(topology.queueNames).slice(1, -1)}(?:\\.dead-letter|\\.retry-v2\\.(?:1|2|3))?)$`
	assert.ok(Buffer.byteLength(resource) <= 1024)
	return {
		configure: resource,
		read: resource,
		write: resource,
		topics: [
			{
				exchange: topology.eventsExchange,
				read: pattern(topology.readRoutingKeys),
				write: pattern(topology.writeRoutingKeys)
			},
			{
				exchange: topology.deadLetterExchange,
				read: pattern(topology.deadLetterRoutingKeys),
				write: pattern(topology.deadLetterRoutingKeys)
			}
		]
	}
}
export function assertIntakeSlaNotificationTopology(topology) {
	assert.deepEqual(topology, crmIntakeSlaNotificationTopology())
	return crmIntakeSlaNotificationAcl(topology)
}
export function crmIntakeSlaContractEnabled(canonical) {
	const mode = canonical.CRM_INTAKE_SLA_RABBITMQ_CONTRACT ?? 'disabled'
	assert.ok(['disabled', CRM_INTAKE_SLA_BROKER_VERSION].includes(mode))
	if (mode !== 'disabled') {
		assert.equal(canonical.CRM_RABBITMQ_CONTRACT, 'mvp-v1')
		assert.equal(
			canonical.CRM_REMINDERS_RABBITMQ_CONTRACT,
			CRM_REMINDERS_BROKER_VERSION
		)
	}
	return mode !== 'disabled'
}
const queue = name => ({
	name,
	durable: true,
	auto_delete: false,
	arguments: {}
})
const binding = (destination, source, routing_key) => ({
	source,
	destination,
	destination_type: 'queue',
	routing_key,
	arguments: {}
})
const queues = [queue(mainQueue), queue(mainQueue + '.dead-letter')]
const bindings = [
	binding(mainQueue, exchanges[0].name, event),
	binding(mainQueue + '.dead-letter', exchanges[1].name, event)
]
for (const [kind, name, type] of kinds) {
	queues.push(queue(name), queue(name + '.dead-letter'))
	bindings.push(
		binding(name, 'winwidget.events', type),
		binding(name, 'winwidget.events', `manual.${kind}`),
		binding(name, 'winwidget.manual-retry', kind),
		binding(
			name + '.dead-letter',
			'winwidget.dead-letter',
			`${kind}.dead-letter`
		),
		binding(
			name + '.dead-letter',
			'winwidget.events',
			`${kind}.dead-letter`
		)
	)
	for (const [index, delay] of [30000, 300000, 1800000].entries()) {
		const retry = `${name}.retry-v2.${index + 1}`
		queues.push({
			...queue(retry),
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
const contract = {
	version: CRM_INTAKE_SLA_BROKER_VERSION,
	vhost: 'winwidget',
	exchanges,
	queues,
	bindings,
	principals: [
		{
			name: CRM_INTAKE_SLA_WORKER,
			configure: '^$',
			read: pattern([mainQueue]),
			write: '^$',
			topics: []
		},
		{
			name: CRM_INTAKE_SLA_PUBLISHER,
			configure: '^$',
			read: '^$',
			write: pattern([
				...exchanges.map(row => row.name),
				'winwidget.events'
			]),
			topics: [
				{
					exchange: 'winwidget.events',
					read: '^$',
					write: pattern(kinds.map(row => row[2]))
				}
			]
		}
	],
	notificationBefore: crmRemindersBrokerContract().notificationAfter,
	notificationAfter: crmIntakeSlaNotificationAcl(
		crmIntakeSlaNotificationTopology()
	)
}
const contractSha256 = createHash('sha256')
	.update(JSON.stringify(contract))
	.digest('hex')
export const crmIntakeSlaBrokerContract = () => structuredClone(contract)
export const crmIntakeSlaBrokerOwns = name =>
	typeof name === 'string' &&
	['winwidget.crm-intake.sla', ...kinds.map(row => row[1])].some(
		prefix => name === prefix || name.startsWith(prefix + '.')
	)
const bindingKey = row =>
	JSON.stringify([
		row.source,
		row.destination,
		row.destination_type,
		row.routing_key,
		row.arguments
	])

// This pre-activation observation permits resumable subsets, not mismatches or
// active SLA consumers. Existing reminders may remain active and are untouched.
export function assertCrmIntakeSlaBrokerSnapshot(
	snapshot,
	complete = false
) {
	try {
		assert.equal(typeof complete, 'boolean')
		assert.ok(
			snapshot &&
				['exchanges', 'queues', 'bindings'].every(key =>
					Array.isArray(snapshot[key])
				)
		)
		for (const key of ['exchanges', 'queues']) {
			assert.ok(
				snapshot[key].every(row => row && typeof row.name === 'string')
			)
			assert.equal(
				new Set(snapshot[key].map(row => row.name)).size,
				snapshot[key].length
			)
		}
		for (const [name, type] of [
			['winwidget.events', 'topic'],
			['winwidget.dead-letter', 'topic'],
			['winwidget.retry', 'direct'],
			['winwidget.manual-retry', 'direct']
		]) {
			const row = snapshot.exchanges.find(item => item.name === name)
			assert.ok(row)
			for (const [key, value] of Object.entries({
				type,
				durable: true,
				auto_delete: false,
				internal: false,
				arguments: {}
			}))
				assert.deepEqual(row[key], value)
		}
		for (const row of snapshot.exchanges.filter(item =>
			crmIntakeSlaBrokerOwns(item.name)
		)) {
			const expected = exchanges.find(item => item.name === row.name)
			assert.ok(expected)
			for (const [key, value] of Object.entries(expected))
				assert.deepEqual(row[key], value)
			assert.deepEqual(row.effective_policy_definition ?? {}, {})
		}
		for (const row of snapshot.queues.filter(item =>
			crmIntakeSlaBrokerOwns(item.name)
		)) {
			const expected = queues.find(item => item.name === row.name)
			assert.ok(expected)
			const { arguments: expectedArguments, ...expectedQueue } = expected
			for (const [key, value] of Object.entries({
				...expectedQueue,
				type: 'classic',
				exclusive: false,
				consumers: 0
			}))
				assert.deepEqual(row[key], value)
			assertClassicQueueArguments(row, expectedArguments)
			assert.deepEqual(row.effective_policy_definition ?? {}, {})
		}
		const actual = []
		for (const row of snapshot.bindings) {
			if (
				!crmIntakeSlaBrokerOwns(row.source) &&
				!crmIntakeSlaBrokerOwns(row.destination)
			)
				continue
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
				bindings.some(item => bindingKey(item) === key) &&
					!actual.includes(key)
			)
			actual.push(key)
		}
		if (complete) {
			for (const row of exchanges)
				assert.ok(snapshot.exchanges.some(item => item.name === row.name))
			for (const row of queues)
				assert.ok(snapshot.queues.some(item => item.name === row.name))
			assert.deepEqual(actual.sort(), bindings.map(bindingKey).sort())
		}
		return {
			contractSha256,
			topologyVerified: complete,
			exchanges: exchanges.length,
			queues: queues.length,
			bindings: bindings.length,
			releaseApproved: false
		}
	} catch {
		throw new Error(
			'Invalid CRM Intake SLA broker topology; private details suppressed'
		)
	}
}

// Same immutable env boundary as the reminder bootstrap; secrets stay in process
// and are never part of the returned public provisioning report.
export function crmIntakeSlaBrokerInputs(
	canonical,
	crm,
	notificationTopology
) {
	try {
		assert.equal(crmIntakeSlaContractEnabled(canonical), true)
		assert.equal(canonical.CRM_RABBITMQ_CONTRACT, 'mvp-v1')
		assert.equal(
			canonical.CRM_REMINDERS_RABBITMQ_CONTRACT,
			CRM_REMINDERS_BROKER_VERSION
		)
		assertIntakeSlaNotificationTopology(notificationTopology)
		const configuredKinds = topology =>
			topology.deadLetterRoutingKeys
				.map(key => key.replace(/\.dead-letter$/, ''))
				.join(',')
		assert.ok(
			[
				configuredKinds(crmReminderNotificationTopology()),
				configuredKinds(notificationTopology)
			].includes(canonical.NOTIFICATION_DELIVERY_KINDS)
		)
		const previous = crmReminderBrokerInputs(
			{
				...canonical,
				NOTIFICATION_DELIVERY_KINDS: configuredKinds(
					crmReminderNotificationTopology()
				)
			},
			crm,
			crmReminderNotificationTopology()
		)
		const credentials = Object.fromEntries(
			contract.principals.map(({ name }) => {
				const key =
					name === CRM_INTAKE_SLA_WORKER
						? 'CRM_INTAKE_SLA_WORKER_RABBITMQ_URL'
						: 'CRM_INTAKE_SLA_PUBLISHER_RABBITMQ_URL'
				const url = new URL(crm[key])
				assert.equal(url.protocol, 'amqp:')
				assert.equal(url.hostname, '127.0.0.1')
				assert.ok(['', '5672'].includes(url.port))
				assert.equal(url.username, name)
				assert.equal(url.pathname, '/winwidget')
				assert.ok(!url.hash && !url.search)
				const password = decodeURIComponent(url.password)
				assert.match(password, /^[a-f0-9]{48,128}$/)
				assert.notEqual(password, previous.admin.password)
				assert.notEqual(
					password,
					previous.credentials[CRM_REMINDERS_PRINCIPAL]
				)
				return [name, password]
			})
		)
		assert.equal(new Set(Object.values(credentials)).size, 2)
		const legacyPrincipals = [
			...previous.legacyPrincipals,
			CRM_REMINDERS_PRINCIPAL
		]
		assert.equal(new Set(legacyPrincipals).size, 26)
		assert.ok(
			contract.principals.every(
				row => !legacyPrincipals.includes(row.name)
			)
		)
		return { admin: previous.admin, credentials, legacyPrincipals }
	} catch {
		throw new Error(
			'Invalid CRM Intake SLA broker inputs; private details suppressed'
		)
	}
}
