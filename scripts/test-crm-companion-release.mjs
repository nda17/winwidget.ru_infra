import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	CRM_COMPANIONS,
	prepareCrmCompanionRelease,
	companionMigrationLedger,
	companionComposeBytes,
	assertCrmCompanionRuntime
} from './crm-companion-release.mjs'

const revision = 'a'.repeat(40),
	previous = 'b'.repeat(40)
const fixture = () => {
	const canonical = {
		BILLING_WINCRM_PAYMENTS_ENABLED: 'false',
		WIDGETS_WINCRM_CONNECTOR_ENABLED: 'false',
		BILLING_WINCRM_WIDGETS_ELIGIBILITY_ENABLED: 'false',
		WINCRM_INVITATION_EMAIL_ENABLED: 'false',
		NOTIFICATION_DELIVERY_KINDS: 'email,telegram'
	}
	const config = {
			name: 'winwidget',
			services: { 'operations-migrate': { command: ['must-not-run'] } }
		},
		images = [],
		live = []
	for (const [index, [owner, names]] of Object.entries(
		CRM_COMPANIONS
	).entries()) {
		const schema = owner.replaceAll('-', '_')
		const image = {
			Id: 'sha256:' + String(index + 1).repeat(64),
			RepoTags: ['winwidget-' + owner + ':git-' + revision],
			Os: 'linux',
			Config: {
				Labels: { 'org.opencontainers.image.revision': revision },
				Env: ['NODE_ENV=production'],
				Cmd: ['node', 'dist/src/main.js'],
				Entrypoint: ['docker-entrypoint.sh'],
				User: '1001'
			}
		}
		images.push(image)
		for (const name of [...names, owner + '-migrate']) {
			const environment = {
				APP_REVISION: revision,
				NODE_ENV: 'production',
				[schema.toUpperCase() + '_DATABASE_URL']:
					'postgresql://winwidget_' +
					schema +
					(name.endsWith('-migrate') ? '_migration' : '_runtime') +
					':synthetic-only@127.0.0.1:5432/winwidget_' +
					schema +
					'?schema=' +
					schema
			}
			config.services[name] = {
				network_mode: 'host',
				stop_grace_period: '10s',
				image: image.RepoTags[0],
				environment,
				build: { context: 'unused' },
				depends_on: { rabbitmq: { condition: 'service_healthy' } }
			}
			if (name.endsWith('-migrate')) {
				config.services[name].profiles = ['migration']
				continue
			}
			live.push({
				Image: image.Id,
				Config: {
					Labels: {
						'com.docker.compose.project': 'winwidget',
						'com.docker.compose.service': name
					},
					Env: Object.entries({
						...environment,
						APP_REVISION: previous
					}).map(([k, v]) => k + '=' + v),
					User: '1001',
					Cmd: image.Config.Cmd,
					Entrypoint: image.Config.Entrypoint
				},
				State: {
					Running: true,
					OOMKilled: false,
					Health: { Status: 'healthy' }
				},
				RestartCount: 0,
				HostConfig: {
					NetworkMode: 'host',
					Privileged: false,
					RestartPolicy: { Name: 'no' },
					LogConfig: { Type: 'json-file' }
				},
				Mounts: []
			})
		}
	}
	return {
		config,
		canonical,
		revision,
		images,
		live,
		validateCompanion: () => ({ wiringVerified: true })
	}
}

test('closed initial plan contains only nine companions and their four migration jobs', () => {
	const input = fixture(),
		result = prepareCrmCompanionRelease(input)
	assert.equal(Object.keys(result.desired.services).length, 13)
	assert.equal(result.desired.services['operations-migrate'], undefined)
	for (const service of Object.values(result.desired.services)) {
		assert.match(service.image, /^sha256:/)
		assert.equal(service.depends_on, undefined)
		assert.equal(service.build, undefined)
	}
	for (const keys of Object.values(result.changes))
		assert.deepEqual(keys, ['APP_REVISION'])
	assert.deepEqual(input.config.services['operations-migrate'], {
		command: ['must-not-run']
	})
})

for (const [name, mutate] of [
	[
		'payments enabled',
		f => {
			f.canonical.BILLING_WINCRM_PAYMENTS_ENABLED = 'true'
		}
	],
	[
		'reader enabled',
		f => {
			f.canonical.NOTIFICATION_DELIVERY_KINDS += ',wincrm-invitation-email'
		}
	],
	[
		'wrong image revision',
		f => {
			f.images[0].Config.Labels['org.opencontainers.image.revision'] =
				previous
		}
	],
	[
		'duplicate target',
		f => {
			f.live.push(structuredClone(f.live[0]))
		}
	],
	[
		'missing target',
		f => {
			f.live.shift()
		}
	],
	[
		'privileged process',
		f => {
			f.config.services['billing-worker'].privileged = true
		}
	],
	[
		'foreign database',
		f => {
			f.config.services['billing-api'].environment.BILLING_DATABASE_URL =
				f.config.services['identity-api'].environment.IDENTITY_DATABASE_URL
		}
	],
	[
		'foreign mount',
		f => {
			f.config.services['widgets-service'].volumes = [
				{ source: '/private', target: '/private' }
			]
		}
	],
	[
		'unhealthy baseline',
		f => {
			f.live[0].State.Health.Status = 'unhealthy'
		}
	],
	[
		'unrelated env drift',
		f => {
			f.config.services['billing-api'].environment.UNRELATED_SECRET =
				'never-print-this'
		}
	],
	[
		'companion validator failure',
		f => {
			f.validateCompanion = () => {
				throw Error('never-print-this')
			}
		}
	]
])
	test('rejects ' + name + ' before cutover', () => {
		const input = fixture()
		mutate(input)
		assert.throws(
			() => prepareCrmCompanionRelease(input),
			error =>
				error.message.startsWith('CRM companion release rejected') &&
				!error.message.includes('never-print-this')
		)
	})

test('exact runtime proof checks configuration, secrets, health, revision and absence of restarts', () => {
	const input = fixture(),
		{ desired } = prepareCrmCompanionRelease(input)
	for (const live of input.live)
		live.Config.Env = live.Config.Env.map(value =>
			value.startsWith('APP_REVISION=')
				? 'APP_REVISION=' + revision
				: value
		)
	const proof = { ...input, desired }
	assert.equal(assertCrmCompanionRuntime(proof).runtimeProcesses, 9)
	for (const mutate of [
		f => {
			f.live[0].Config.Env.push('UNEXPECTED_SECRET=synthetic')
		},
		f => {
			f.live[0].RestartCount = 1
		},
		f => {
			f.live[0].Image = 'sha256:' + '9'.repeat(64)
		},
		f => {
			f.live[0].HostConfig.Privileged = true
		}
	]) {
		const variant = { ...proof, live: structuredClone(proof.live) }
		mutate(variant)
		assert.throws(() => assertCrmCompanionRuntime(variant))
	}
})

test('migration ledger admits missing older dates but rejects drift, failed or foreign migrations', () => {
	const files = ['20260901', '20260902', '20260910'].map(
		(name, index) => ({ name, checksum: String(index).repeat(64) })
	)
	const row = file => ({
		migration_name: file.name,
		checksum: file.checksum,
		finished_at: '2026-09-07',
		rolled_back_at: null
	})
	const rows = [row(files[0]), row(files[2])]
	assert.deepEqual(companionMigrationLedger(files, rows), ['20260902'])
	assert.throws(() => companionMigrationLedger(files, rows, true))
	assert.deepEqual(
		companionMigrationLedger(files, files.map(row), true),
		[]
	)
	const rolledBack = {
		...row(files[1]),
		checksum: '9'.repeat(64),
		finished_at: null,
		rolled_back_at: '2026-09-06T12:00:00Z'
	}
	assert.deepEqual(
		companionMigrationLedger(files, [...rows, rolledBack]),
		['20260902']
	)
	assert.deepEqual(
		companionMigrationLedger(files, [rolledBack, ...files.map(row)], true),
		[]
	)
	assert.throws(() =>
		companionMigrationLedger(files, [
			{ ...rolledBack, finished_at: '2026-09-07' }
		])
	)
	assert.throws(() =>
		companionMigrationLedger(files, [
			{ ...rolledBack, rolled_back_at: 'invalid' }
		])
	)
	for (const variant of [
		[...rows, rows[0]],
		[{ ...rows[0], checksum: '9'.repeat(64) }],
		[{ ...rows[0], finished_at: null }],
		[{ ...rows[0], migration_name: 'unknown' }]
	])
		assert.throws(() => companionMigrationLedger(files, variant))
})

test('normalized Compose preserves literal dollars rather than interpreting credentials again', () => {
	assert.equal(
		JSON.parse(
			companionComposeBytes({
				environment: { PASSWORD: 'literal${UNRELATED}$value' }
			})
		).environment.PASSWORD,
		'literal$${UNRELATED}$$value'
	)
})
