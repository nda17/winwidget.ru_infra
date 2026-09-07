import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import { crmBrokerContract } from './crm-broker-topology.mjs'
import {
	crmBrokerInputs,
	bootstrapCrmBroker,
	createParentFence
} from './crm-broker-bootstrap.mjs'

const secret = value => createHash('sha256').update(value).digest('hex')
export function bootstrapFixture(
	adminUser = 'winwidget-admin',
	adminPassword = secret('admin')
) {
	const canonical = {
		RABBITMQ_ADMIN_USER: adminUser,
		RABBITMQ_ADMIN_PASSWORD: adminPassword,
		RABBITMQ_MONITOR_USER: 'winwidget-monitor',
		RABBITMQ_VHOST: 'winwidget',
		RABBITMQ_MANAGEMENT_URL: 'http://127.0.0.1:15672'
	}
	for (const name of [
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
	])
		canonical[
			'RABBITMQ_' + name.replaceAll('-', '_').toUpperCase() + '_URL'
		] =
			'amqp://winwidget-' +
			name +
			':' +
			secret(name) +
			'@127.0.0.1:5672/winwidget'
	const crm = {
		CRM_ACCESS_BILLING_ENABLED: 'false',
		CRM_INTAKE_WIDGETS_ENABLED: 'false',
		CRM_INTAKE_WIDGET_TRANSFERS_ENABLED: 'false'
	}
	for (const { name } of crmBrokerContract().principals.filter(p =>
		p.name.startsWith('winwidget-crm-')
	))
		crm[
			name.slice(10).replaceAll('-', '_').toUpperCase() + '_RABBITMQ_URL'
		] = 'amqp://' + name + ':' + secret(name) + '@127.0.0.1:5672/winwidget'
	return { canonical, crm, provider: secret('provider') }
}

test('bootstrap reads exactly nine scoped credentials and sixteen existing principals', () => {
	const value = bootstrapFixture()
	const inputs = crmBrokerInputs(
		value.canonical,
		value.crm,
		value.provider
	)
	assert.equal(inputs.legacyPrincipals.length, 16)
	assert.deepEqual(
		Object.keys(inputs.credentials),
		crmBrokerContract().principals.map(p => p.name)
	)
	assert.equal(
		inputs.credentials['winwidget-billing-wincrm-provider-worker'],
		value.provider
	)
	assert.equal(inputs.admin.username, 'winwidget-admin')
	assert.deepEqual(
		crmBrokerInputs(
			{ ...value.canonical, CRM_RABBITMQ_CONTRACT: 'mvp-v1' },
			value.crm,
			value.provider
		),
		inputs
	)
})

test('invalid, aliased, public and active-product inputs fail without exposing values', () => {
	const cases = [
		v => {
			v.canonical.RABBITMQ_MANAGEMENT_URL =
				'https://example.test/SECRET_SENTINEL'
		},
		v => {
			v.canonical.RABBITMQ_VHOST = 'another'
		},
		v => {
			v.canonical.RABBITMQ_MONITOR_USER = v.canonical.RABBITMQ_ADMIN_USER
		},
		v => {
			delete v.canonical.RABBITMQ_WIDGETS_URL
		},
		v => {
			v.canonical.RABBITMQ_WIDGETS_URL = v.canonical.RABBITMQ_REPORTING_URL
		},
		v => {
			v.canonical.CRM_RABBITMQ_CONTRACT = 'arbitrary'
		},
		v => {
			v.canonical.BILLING_WINCRM_PAYMENTS_ENABLED = 'true'
		},
		v => {
			v.canonical.WIDGETS_WINCRM_CONNECTOR_ENABLED = 'true'
		},
		v => {
			v.canonical.WINCRM_INVITATION_EMAIL_ENABLED = 'true'
		},
		v => {
			v.crm.CRM_ACCESS_BILLING_ENABLED = 'true'
		},
		v => {
			v.crm.CRM_INTAKE_WIDGETS_ENABLED = 'true'
		},
		v => {
			v.crm.CRM_INTAKE_WIDGET_TRANSFERS_ENABLED = 'true'
		},
		v => {
			delete v.crm.CRM_ACCESS_WORKER_RABBITMQ_URL
		},
		v => {
			v.crm.CRM_ACCESS_WORKER_RABBITMQ_URL += '?other=true'
		},
		v => {
			v.crm.CRM_ACCESS_WORKER_RABBITMQ_URL =
				v.crm.CRM_ACCESS_WORKER_RABBITMQ_URL.replace(
					'127.0.0.1',
					'example.test'
				)
		},
		v => {
			v.provider = secret('winwidget-crm-access-worker')
		},
		v => {
			v.provider = 'SECRET_SENTINEL'
		}
	]
	for (const edit of cases) {
		const value = bootstrapFixture()
		edit(value)
		assert.throws(
			() => crmBrokerInputs(value.canonical, value.crm, value.provider),
			{
				message:
					'Invalid CRM broker bootstrap inputs; private details suppressed'
			}
		)
	}
})

test('a failed parent fence prevents connection and admin connection closes on failure', async () => {
	let calls = 0
	await assert.rejects(
		bootstrapCrmBroker({
			assertReleaseFence: async () => {
				throw Error('fence')
			},
			connect: async () => {
				calls++
			}
		})
	)
	assert.equal(calls, 0)
	const value = bootstrapFixture()
	let closed = false
	await assert.rejects(
		bootstrapCrmBroker({
			inputs: crmBrokerInputs(value.canonical, value.crm, value.provider),
			assertReleaseFence: async () => {},
			connect: async () => ({
				createChannel: async () => {
					throw Error('closed')
				},
				close: async () => {
					closed = true
				}
			})
		})
	)
	assert.equal(closed, true)
})

test('the production entrypoint refuses an unapproved invocation without private output', () => {
	const result = spawnSync(
		process.execPath,
		[
			fileURLToPath(
				new URL('./crm-broker-bootstrap.mjs', import.meta.url)
			),
			'not-provision'
		],
		{
			encoding: 'utf8',
			env: { PATH: process.env.PATH },
			timeout: 1000
		}
	)
	assert.equal(result.status, 1)
	assert.equal(result.stdout, '')
	assert.equal(
		result.stderr,
		'CRM broker bootstrap failed at boundary; private details suppressed\n'
	)
})

test('every mutation handshake requires a fresh positive parent response', async () => {
	for (const response of ['CRM_FENCE_OK\n', 'DENIED\n', '', null]) {
		const input = new PassThrough(),
			output = new PassThrough()
		const fence = createParentFence(input, output, 30)
		let requests = 0
		output.on('data', data => {
			assert.equal(String(data), 'CRM_FENCE\n')
			requests++
			if (response === null) input.end()
			else if (response) input.write(response)
		})
		try {
			if (response === 'CRM_FENCE_OK\n') {
				await fence.check()
				await fence.check()
				assert.equal(requests, 2)
			} else {
				await assert.rejects(fence.check())
				assert.equal(requests, 1)
			}
		} finally {
			fence.close()
			input.destroy()
			output.destroy()
		}
	}
})
