import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(
	new URL('./deploy-services-production.sh', import.meta.url),
	'utf8'
)
const heredoc = label => {
	const marker = "<<'" + label + "'"
	const begin = source.indexOf(marker)
	assert.ok(begin >= 0, label)
	const start = source.indexOf('\n', begin) + 1
	const end = source.indexOf('\n' + label + '\n', start)
	assert.ok(end > start, label)
	return source.slice(start, end)
}
const materialize = (overrides = {}) => {
	const examples = {
		billing: [
			'BILLING_CRM_ACCESS_TOKEN',
			'BILLING_WINCRM_PAYMENTS_ENABLED',
			'BILLING_WINCRM_RECONCILIATION_ENABLED',
			'BILLING_WINCRM_FRONTEND_ORIGIN',
			'BILLING_CRM_ACCESS_COMMERCE_BASE_URL',
			'BILLING_CRM_ACCESS_COMMERCE_TOKEN',
			'BILLING_WINCRM_PROVIDER_RABBITMQ_URL',
			'BILLING_WINCRM_PROVIDER_ASSERT_TOPOLOGY',
			'BILLING_WINCRM_WIDGETS_ELIGIBILITY_ENABLED',
			'BILLING_WINCRM_WIDGETS_TOKEN',
			'BILLING_WINCRM_CRM_INTAKE_TOKEN'
		],
		identity: [
			'IDENTITY_CRM_ACCESS_TOKEN',
			'WINCRM_INVITATION_EMAIL_ENABLED',
			'IDENTITY_NOTIFICATION_DELIVERY_TOKEN'
		],
		widgets: [
			'WIDGETS_WINCRM_CONNECTOR_ENABLED',
			'WIDGETS_CRM_INTAKE_TOKEN',
			'BILLING_WINCRM_WIDGETS_TOKEN',
			'WIDGETS_WINCRM_HTTP_TIMEOUT_MS'
		],
		'notification-delivery': ['IDENTITY_NOTIFICATION_DELIVERY_TOKEN']
	}
	const values = {
		DATABASE_RESTORE_RECEIPT_HMAC_KEY_BASE64: Buffer.alloc(32, 1).toString(
			'base64'
		),
		DATABASE_RESTORE_RECEIPT_HMAC_KEY_ID: 'test-receipt-key',
		IDENTITY_CRM_ACCESS_TOKEN: 'a'.repeat(64),
		BILLING_CRM_ACCESS_TOKEN: 'b'.repeat(64),
		...overrides
	}
	const written = new Map()
	runInNewContext(
		heredoc('MATERIALIZE_SERVICE_ENVS'),
		{
			Buffer,
			process: { env: { EXPECTED_SERVICES_REVISION: 'c'.repeat(40) } },
			require: name => {
				if (name === 'node:path') return path
				assert.equal(name, 'node:fs')
				return {
					readFileSync: file => {
						if (file === '/run/winwidget/canonical.env')
							return Object.entries(values)
								.map(([key, value]) => key + '=' + value)
								.join('\n')
						if (
							file.endsWith('/database-backup-provenance-public-keys.json')
						)
							return JSON.stringify({
								schemaVersion: 1,
								domain:
									'winwidget.operations.database-backup-provenance.v1',
								keys: [
									{
										keyId: 'operations-backup-ed25519-2026-08-31',
										publicKeySpkiDerBase64: 'synthetic-only'
									}
								]
							})
						const match =
							/^\/run\/winwidget\/apps\/([a-z-]+)\/\.env\.example$/.exec(
								file
							)
						assert.ok(match)
						return [
							'APP_REVISION',
							'NODE_ENV',
							...(examples[match[1]] ?? [])
						]
							.map(key => key + '=change_me')
							.join('\n')
					},
					writeFileSync: (file, contents, options) => {
						assert.match(
							file,
							/^\/run\/winwidget\/output\/[a-z-]+\.env\.production$/
						)
						assert.equal(options.mode, 0o600)
						assert.equal(options.flag, 'wx')
						assert.equal(written.has(file), false)
						written.set(
							file,
							Object.fromEntries(
								contents
									.trimEnd()
									.split('\n')
									.map(line => {
										const index = line.indexOf('=')
										return [line.slice(0, index), line.slice(index + 1)]
									})
							)
						)
					}
				}
			}
		},
		{ timeout: 1000 }
	)
	return Object.fromEntries(
		[...written].map(([file, value]) => [
			path.basename(file, '.env.production'),
			value
		])
	)
}

test('actual env materializer keeps CRM opt-in defaults and does not substitute example secrets', () => {
	const result = materialize()
	assert.equal(Object.keys(result).length, 10)
	assert.equal(result.billing.BILLING_WINCRM_PAYMENTS_ENABLED, 'false')
	assert.equal(
		result.billing.BILLING_WINCRM_RECONCILIATION_ENABLED,
		'false'
	)
	assert.equal(result.billing.BILLING_WINCRM_PROVIDER_RABBITMQ_URL, '')
	assert.equal(result.identity.WINCRM_INVITATION_EMAIL_ENABLED, 'false')
	assert.equal(
		result['notification-delivery'].IDENTITY_NOTIFICATION_DELIVERY_TOKEN,
		''
	)
	assert.equal(result.widgets.WIDGETS_WINCRM_CONNECTOR_ENABLED, 'false')
	assert.equal(JSON.stringify(result).includes('change_me'), false)
	assert.throws(() => materialize({ BILLING_CRM_ACCESS_TOKEN: '' }))
	assert.throws(() => materialize({ IDENTITY_CRM_ACCESS_TOKEN: '' }))
})

test('actual env materializer requires missing credentials when their precise CRM feature is active', () => {
	for (const key of [
		'BILLING_WINCRM_PAYMENTS_ENABLED',
		'BILLING_WINCRM_RECONCILIATION_ENABLED',
		'BILLING_WINCRM_WIDGETS_ELIGIBILITY_ENABLED',
		'WIDGETS_WINCRM_CONNECTOR_ENABLED',
		'WINCRM_INVITATION_EMAIL_ENABLED'
	]) {
		assert.throws(() => materialize({ [key]: 'true' }))
		assert.throws(() => materialize({ [key]: 'yes' }))
	}
	assert.throws(() =>
		materialize({
			NOTIFICATION_DELIVERY_KINDS: 'email,wincrm-invitation-email'
		})
	)
	const broker = 'amqp://synthetic:synthetic@127.0.0.1:5672/winwidget'
	const result = materialize({
		BILLING_WINCRM_RECONCILIATION_ENABLED: 'true',
		BILLING_WINCRM_PROVIDER_RABBITMQ_URL: broker
	})
	assert.equal(result.billing.BILLING_WINCRM_PROVIDER_RABBITMQ_URL, broker)
	assert.equal(result.billing.BILLING_WINCRM_PAYMENTS_ENABLED, 'false')
	const mail = materialize({
		WINCRM_INVITATION_EMAIL_ENABLED: 'true',
		NOTIFICATION_DELIVERY_KINDS: 'email,wincrm-invitation-email',
		IDENTITY_NOTIFICATION_DELIVERY_TOKEN: 'd'.repeat(64)
	})
	assert.equal(
		mail.identity.IDENTITY_NOTIFICATION_DELIVERY_TOKEN,
		mail['notification-delivery'].IDENTITY_NOTIFICATION_DELIVERY_TOKEN
	)
})
const inventoryCode = heredoc('RABBITMQ_EXPECTED_USERS')
test('actual companion validation wrapper suppresses malformed input, loader and validator errors', () => {
	const code = heredoc('CRM_COMPANION_CONTRACT')
	const run = (module, input) =>
		spawnSync(
			process.execPath,
			[
				'-e',
				module === undefined
					? code
					: code.replace(
							'/run/winwidget/validate-crm-compose.mjs',
							'data:text/javascript;base64,' +
								Buffer.from(module).toString('base64')
						)
			],
			{
				input,
				encoding: 'utf8',
				timeout: 5000,
				env: { SYNTHETIC_CRM_CANONICAL: 'fixture-only' }
			}
		)
	const module =
		'export function validateCrmCompanionCompose(config, source) { if(config.test !== true || source.SYNTHETIC_CRM_CANONICAL !== "fixture-only") throw new Error("sensitive-validator-message"); }'
	const ok = run(module, '{"test":true}')
	assert.equal(ok.status, 0)
	assert.equal(ok.stdout + ok.stderr, '')
	for (const result of [
		run(module, 'sensitive-invalid-json'),
		run(module, '{}'),
		run(undefined, '{}')
	]) {
		assert.equal(result.status, 1)
		assert.equal(result.stdout, '')
		assert.equal(
			result.stderr,
			'Production CRM companion wiring is invalid; private details suppressed.\n'
		)
	}
	const invocation = source.slice(
		source.indexOf('crm_companion_validator_file='),
		source.indexOf('unset crm_companion_validator')
	)
	for (const boundary of [
		'--network none',
		'--read-only',
		'--cap-drop ALL',
		'--security-opt no-new-privileges',
		'--env-file "$env_file"',
		'$crm_companion_validator_file:/run/winwidget/validate-crm-compose.mjs:ro',
		'winwidget-api-gateway:git-$services_revision',
		"die 'Production CRM companion environment validation failed.'"
	])
		assert.ok(invocation.includes(boundary))
})
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
	'winwidget-crm-intake-widget-transfer-publisher',
	'winwidget-billing-wincrm-provider-worker'
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
		queueNames: [
			'winwidget.notification.test',
			'winwidget.notification.wincrm.invitation.email'
		],
		readRoutingKeys: [
			'notification.test.v1',
			'notification.wincrm.invitation.email.requested.v1'
		],
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
const permissions = (mode, overrides = {}) => {
	const context = {
		process: { env: { ...environment(mode), ...overrides } },
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

test('mvp-v1 admits eight CRM process users plus the isolated Billing provider consumer', () => {
	assert.deepEqual(
		inventory('mvp-v1'),
		[...inventory(), ...crmUsers].sort()
	)
	assert.equal(inventory('mvp-v1').length, 25)
	assert.throws(() =>
		inventory('mvp-v1', { RABBITMQ_ADMIN_USER: crmUsers[0] })
	)
	assert.throws(() =>
		inventory('mvp-v1', { RABBITMQ_MONITOR_USER: crmUsers[1] })
	)
})

test('actual shell preflight rejects extra, missing, legacy and premature CRM principals', () => {
	assert.equal(preflight(undefined, inventory()), 0)
	assert.equal(preflight('mvp-v1', inventory('mvp-v1')), 0)
	for (const actual of [
		inventory(),
		inventory('mvp-v1').slice(1),
		inventory('mvp-v1').filter(
			name => name !== 'winwidget-billing-wincrm-provider-worker'
		),
		[...inventory('mvp-v1'), 'winwidget-crm-unknown-worker'],
		[...inventory('mvp-v1'), 'winwidget-core']
	])
		assert.equal(preflight('mvp-v1', actual), 42)
	assert.equal(preflight(undefined, inventory('mvp-v1')), 42)
})

test('invalid or empty versions fail closed in both inventory and provisioner', () => {
	for (const mode of [
		'',
		'true',
		'false',
		'native-v2',
		'native-v1',
		'*',
		' mvp-v1',
		'mvp-v1\n'
	]) {
		assert.throws(() => inventory(mode))
		assert.throws(() => permissions(mode))
	}
})

test('MVP adds only exact producer routes and the Billing-owned provider DLQ exchange', () => {
	const before = permissions()
	const after = permissions('mvp-v1')
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
	for (const [username, additional, legacy] of [
		[
			'winwidget-identity-publisher',
			[
				'identity.wincrm.invitation-accepted.v1',
				'notification.wincrm.invitation.email.requested.v1'
			],
			'^(identity\\.user\\.changed\\.v1|billing\\.(identity\\.changed|referral\\.requested|lifecycle-repair\\.requested)\\.v1|admin\\.audit\\.identity\\.v1)$'
		],
		[
			'winwidget-billing-publisher',
			['billing.wincrm.provider-operation.requested.v1'],
			'^(payment\\.succeeded\\.v1|payment\\.notification\\.telegram\\.requested\\.v1|payment\\.auto-renewal\\.charge\\.requested\\.v1|notification\\.subscription-expiry\\.(email|telegram)\\.requested\\.v1|billing\\.(payment|subscription)(\\.details)?\\.changed\\.v1|billing\\.(affiliate|settings)\\.changed\\.v1|admin\\.audit\\.billing\\.v1)$'
		]
	]) {
		const oldUser = before.find(user => user.username === username)
		const newUser = after.find(user => user.username === username)
		const oldEvent = oldUser.topics.find(
			topic => topic.exchange === 'winwidget.events'
		)
		const newEvent = newUser.topics.find(
			topic => topic.exchange === 'winwidget.events'
		)
		assert.equal(oldEvent.write, legacy)
		assert.equal(
			newEvent.write,
			legacy.slice(0, -2) +
				'|' +
				additional.map(route => route.replaceAll('.', '\\.')).join('|') +
				')$'
		)
		for (const route of additional) {
			assert.equal(new RegExp(oldEvent.write).test(route), false)
			assert.equal(new RegExp(newEvent.write).test(route), true)
			for (const wrong of [
				route + '.extra',
				'prefix.' + route,
				route.replace('.v1', '.v2'),
				route.replaceAll('.', 'x')
			])
				assert.equal(new RegExp(newEvent.write).test(wrong), false)
		}
		for (const forbidden of [
			'crm.access.admission-wake.v1',
			nativeEvent,
			'other.provider-operation.requested.v1'
		])
			assert.equal(new RegExp(newEvent.write).test(forbidden), false)
		newEvent.write = oldEvent.write
	}
	const oldBilling = before.find(
		user => user.username === 'winwidget-billing-publisher'
	)
	const newBilling = after.find(
		user => user.username === 'winwidget-billing-publisher'
	)
	assert.equal(
		oldBilling.write,
		'^winwidget\\.(events|billing\\.(retry|dead-letter))$'
	)
	assert.equal(
		newBilling.write,
		'^winwidget\\.(events|billing\\.(retry|dead-letter)|billing\\.wincrm-provider\\.dead-letter)$'
	)
	for (const exchange of [
		'winwidget.events',
		'winwidget.billing.retry',
		'winwidget.billing.dead-letter',
		'winwidget.billing.wincrm-provider.dead-letter'
	])
		assert.equal(new RegExp(newBilling.write).test(exchange), true)
	for (const exchange of [
		'winwidget.billing.wincrm-provider.v1',
		'winwidget.billing.wincrm-provider.dead-letter.extra',
		'winwidget.crm-intake.events',
		'winwidget.dead-letter'
	])
		assert.equal(new RegExp(newBilling.write).test(exchange), false)
	newBilling.write = oldBilling.write
	assert.deepEqual(
		after,
		before,
		'all other permissions, credentials and tags must remain identical'
	)
})

test('MVP refuses missing invitation email reader before any provisioning', () => {
	for (const missing of ['readRoutingKeys', 'queueNames']) {
		const topology = JSON.parse(
			environment('mvp-v1').NOTIFICATION_TOPOLOGY_CONTRACT
		)
		topology[missing] = [
			missing === 'readRoutingKeys'
				? 'notification.test.v1'
				: 'winwidget.notification.test'
		]
		const overrides = {
			NOTIFICATION_TOPOLOGY_CONTRACT: JSON.stringify(topology)
		}
		assert.doesNotThrow(() => permissions('disabled', overrides))
		assert.throws(() => permissions('mvp-v1', overrides))
	}
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
