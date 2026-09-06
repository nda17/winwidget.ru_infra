import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(
	new URL('./deploy-services-production.sh', import.meta.url),
	'utf8'
)
const heredoc = label => {
	const marker = "<<'" + label + "'\n"
	const begin = source.indexOf(marker)
	assert.ok(begin >= 0, label)
	const start = begin + marker.length
	const end = source.indexOf('\n' + label + '\n', start)
	assert.ok(end > start, label)
	return source.slice(start, end)
}
const inventoryCode = heredoc('RABBITMQ_EXPECTED_USERS')
const provisionCode = heredoc('PROVISION_RABBITMQ')
const definitionsEnd = provisionCode.indexOf(
	'const provisionTopology = async () => {'
)
assert.ok(definitionsEnd > 0)
const provisionDefinitions = provisionCode.slice(0, definitionsEnd)
const crmUsers = [
	'winwidget-crm-access-worker',
	'winwidget-crm-access-outbox-publisher',
	'winwidget-crm-intake-worker',
	'winwidget-crm-intake-publisher',
	'winwidget-crm-intake-widget-control-worker',
	'winwidget-crm-intake-widget-control-publisher',
	'winwidget-crm-intake-widget-transfer-worker',
	'winwidget-crm-intake-widget-transfer-publisher'
]
const serviceCredentials = [
	['NOTIFICATION_DELIVERY', 'notification-delivery'],
	['CAMPAIGNS', 'campaigns'],
	['REPORTING', 'reporting'],
	['WIDGETS', 'widgets'],
	['BILLING_WORKER', 'billing-worker'],
	['BILLING_PUBLISHER', 'billing-publisher'],
	['IDENTITY_WORKER', 'identity-worker'],
	['IDENTITY_PUBLISHER', 'identity-publisher'],
	['PLATFORM_PUBLISHER', 'platform-publisher'],
	['SUPPORT_WORKER', 'support-worker'],
	['SUPPORT_PUBLISHER', 'support-publisher'],
	['OPERATIONS_WORKER', 'operations-worker'],
	['OPERATIONS_RESTORE_WORKER', 'operations-restore-worker'],
	['OPERATIONS_PUBLISHER', 'operations-publisher']
]
const environment = mode => ({
	RABBITMQ_ADMIN_USER: 'winwidget-admin',
	RABBITMQ_MONITOR_USER: 'winwidget-monitor',
	RABBITMQ_ADMIN_PASSWORD: 'a'.repeat(64),
	RABBITMQ_MONITOR_PASSWORD: 'b'.repeat(64),
	RABBITMQ_VHOST: 'winwidget',
	RABBITMQ_MANAGEMENT_URL: 'http://127.0.0.1:15672',
	...(mode === undefined ? {} : { CRM_RABBITMQ_CONTRACT: mode }),
	...Object.fromEntries(
		serviceCredentials.map(([key, name]) => [
			'RABBITMQ_' + key + '_URL',
			'amqp://winwidget-' +
				name +
				':' +
				'c'.repeat(64) +
				'@127.0.0.1:5672/winwidget'
		])
	),
	NOTIFICATION_TOPOLOGY_CONTRACT: JSON.stringify({
		eventsExchange: 'winwidget.events',
		retryExchange: 'winwidget.retry',
		deadLetterExchange: 'winwidget.dead-letter',
		manualRetryExchange: 'winwidget.manual-retry',
		queueNames: ['winwidget.notification.test'],
		readRoutingKeys: ['notification.test.v1'],
		writeRoutingKeys: ['notification.outcome.v1'],
		deadLetterRoutingKeys: ['notification.dead-letter'],
		retryCount: 3
	}),
	REPORTING_TOPOLOGY_CONTRACT: JSON.stringify({
		eventsExchange: 'winwidget.events',
		retryExchange: 'winwidget.reporting.retry',
		deadLetterExchange: 'winwidget.dead-letter',
		manualRetryExchange: 'winwidget.reporting.manual-retry',
		reportingSettingsQueue: 'winwidget.reporting.settings',
		reportingSettingsRoutingKey:
			'operations.notification-routing.changed.v1',
		queueNames: ['winwidget.reporting.settings'],
		routingKeys: ['operations.notification-routing.changed.v1'],
		writeRoutingKeys: ['admin.audit.reporting.v1'],
		retryCount: 3
	})
})
const inventory = (mode, overrides = {}) => {
	let output = ''
	runInNewContext(
		inventoryCode,
		{
			process: {
				env: { ...environment(mode), ...overrides },
				exit: code => {
					throw new Error('inventory exit ' + code)
				},
				stdout: {
					write: value => {
						output += value
					}
				}
			}
		},
		{ timeout: 1000 }
	)
	return output.split('\n')
}
const permissions = mode => {
	const context = {
		process: { env: environment(mode) },
		Buffer,
		URL,
		require: name => {
			if (name === 'amqplib')
				return {
					connect: () => {
						throw new Error('No broker access allowed')
					}
				}
			assert.equal(
				name,
				'./dist/src/messaging/operations-messaging.constants.js'
			)
			return new Proxy(
				{
					OPERATIONS_AUDIT_SOURCES: [
						{ routingKey: 'admin.audit.widgets.v1' }
					],
					getOperationsAuditQueue: () =>
						'winwidget.operations.audit.widgets',
					getOperationsAuditRetryQueue: () =>
						'winwidget.operations.audit.widgets.retry',
					getOperationsAuditDeadLetterQueue: () =>
						'winwidget.operations.audit.widgets.dead-letter'
				},
				{
					get: (target, key) =>
						target[key] ??
						'winwidget.' + String(key).toLowerCase().replaceAll('_', '.')
				}
			)
		}
	}
	// Execute the actual provisioner's complete definitions, never its mutations.
	runInNewContext(
		provisionDefinitions + '\nglobalThis.result = JSON.stringify(users);',
		context,
		{ timeout: 1000 }
	)
	return JSON.parse(context.result)
}
const preflightStart = source.indexOf(
	'verify_current_rabbitmq_user_inventory() {'
)
const preflightEnd = source.indexOf('\n}\n', preflightStart) + 3
assert.ok(preflightStart > 0 && preflightEnd > preflightStart)
const preflight = (mode, actual) => {
	const result = spawnSync(
		'bash',
		[
			'-c',
			[
				'set -euo pipefail',
				'die() { exit 42; }',
				"compose_all() { printf '%s' 'test-broker-container'; }",
				'docker() {',
				'  [[ "$*" == "exec test-broker-container rabbitmqctl --silent list_users" ]] || exit 43',
				'  printf "%s\\n" "$ACTUAL_USERS"',
				'}',
				source.slice(preflightStart, preflightEnd),
				'verify_current_rabbitmq_user_inventory'
			].join('\n')
		],
		{
			encoding: 'utf8',
			env: {
				PATH: process.env.PATH,
				rabbitmq_expected_user_names: inventory(mode).join('\n'),
				ACTUAL_USERS: actual.join('\n')
			}
		}
	)
	assert.equal(result.signal, null)
	return result.status
}

test('existing default inventory and permissions are unchanged by an absent opt-in', () => {
	assert.deepEqual(inventory(), inventory('disabled'))
	assert.deepEqual(
		inventory(),
		[
			'winwidget-admin',
			'winwidget-monitor',
			...serviceCredentials.map(([, name]) => 'winwidget-' + name)
		].sort()
	)
	assert.deepEqual(permissions(), permissions('disabled'))
})

test('native-v1 admits precisely eight process-scoped CRM users, no API or shared user', () => {
	assert.deepEqual(
		inventory('native-v1'),
		[...inventory(), ...crmUsers].sort()
	)
	assert.equal(inventory('native-v1').length, 24)
	assert.throws(() =>
		inventory('native-v1', { RABBITMQ_ADMIN_USER: crmUsers[0] })
	)
	assert.throws(() =>
		inventory('native-v1', { RABBITMQ_MONITOR_USER: crmUsers[1] })
	)
})

test('actual shell preflight rejects extra, missing, legacy and premature CRM principals', () => {
	assert.equal(preflight(undefined, inventory()), 0)
	assert.equal(preflight('native-v1', inventory('native-v1')), 0)
	for (const actual of [
		inventory(),
		inventory('native-v1').slice(1),
		[...inventory('native-v1'), 'winwidget-crm-unknown-worker'],
		[...inventory('native-v1'), 'winwidget-core']
	])
		assert.equal(preflight('native-v1', actual), 42)
	assert.equal(preflight(undefined, inventory('native-v1')), 42)
})

test('invalid or empty versions fail closed in both inventory and provisioner', () => {
	for (const mode of [
		'',
		'true',
		'false',
		'native-v2',
		'*',
		' native-v1',
		'native-v1\n'
	]) {
		assert.throws(() => inventory(mode))
		assert.throws(() => permissions(mode))
	}
})

test('CRM changes only the exact Widgets event write permission, never existing resource/read grants', () => {
	const before = permissions()
	const after = permissions('native-v1')
	assert.equal(after.length, before.length)
	assert.ok(
		after.every(user => !crmUsers.includes(user.username)),
		'routine provisioner must not manage CRM credentials'
	)
	const oldWidgets = before.find(
		user => user.username === 'winwidget-widgets'
	)
	const newWidgets = after.find(
		user => user.username === 'winwidget-widgets'
	)
	const oldTopic = oldWidgets.topics.find(
		topic => topic.exchange === 'winwidget.events'
	)
	const newTopic = newWidgets.topics.find(
		topic => topic.exchange === 'winwidget.events'
	)
	assert.equal(
		oldTopic.write,
		'^(widgets\\.(widget|lead)\\.changed\\.v1|lead\\.(integration\\.(email|telegram|webhook|bitrix24|amo-crm)|limit\\.reached\\.(email|telegram))\\.v2|admin\\.audit\\.widgets\\.v1)$'
	)
	assert.equal(
		newTopic.write,
		oldTopic.write.slice(0, -2) +
			'|widgets\\.wincrm\\.lead-transfer\\.requested\\.v1)$'
	)
	const allowed = new RegExp(newTopic.write)
	const nativeEvent = 'widgets.wincrm.lead-transfer.requested.v1'
	assert.equal(new RegExp(oldTopic.write).test(nativeEvent), false)
	assert.equal(allowed.test(nativeEvent), true)
	for (const route of [
		'widgets.widget.changed.v1',
		'widgets.lead.changed.v1',
		'admin.audit.widgets.v1',
		...['email', 'telegram', 'webhook', 'bitrix24', 'amo-crm'].map(
			channel => 'lead.integration.' + channel + '.v2'
		),
		'lead.limit.reached.email.v2',
		'lead.limit.reached.telegram.v2'
	])
		assert.equal(allowed.test(route), true)
	for (const route of [
		nativeEvent + '.extra',
		'prefix.' + nativeEvent,
		nativeEvent.replace('.v1', '.v2'),
		nativeEvent.replaceAll('.', 'x'),
		'widgets.wincrm.other.v1',
		'crm.access.team.v1',
		'identity.user.changed.v1',
		'billing.subscription.changed.v1',
		'admin.audit.billing.v1'
	])
		assert.equal(allowed.test(route), false)
	newTopic.write = oldTopic.write
	assert.deepEqual(
		after,
		before,
		'all other permissions, credentials and tags must remain identical'
	)
})

test('preflight and steady-state retain exact equality; CI executes this contract', () => {
	assert.ok(
		source.includes(
			'[[ "$actual_user_names" == "$rabbitmq_expected_user_names" ]]'
		)
	)
	assert.ok(
		source.includes(
			'[[ "$actual_rabbitmq_user_names" == "$rabbitmq_expected_user_names" ]]'
		)
	)
	assert.ok(
		readFileSync(
			new URL('../.github/workflows/ci.yml', import.meta.url),
			'utf8'
		).includes(
			'node --test scripts/test-crm-rabbitmq-coexistence-contract.mjs'
		)
	)
})
