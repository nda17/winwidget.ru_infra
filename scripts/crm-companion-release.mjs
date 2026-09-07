import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { assertServiceConfiguration } from './scoped-service-release.mjs'
import { crmNeighborFingerprint } from './crm-release.mjs'

export const CRM_COMPANIONS = Object.freeze({
	identity: [
		'identity-api',
		'identity-worker',
		'identity-outbox-publisher'
	],
	billing: [
		'billing-api',
		'billing-worker',
		'billing-scheduler',
		'billing-outbox-publisher'
	],
	widgets: ['widgets-service'],
	'notification-delivery': ['notification-delivery-worker']
})
export const CRM_COMPANION_TARGETS = Object.freeze(
	Object.values(CRM_COMPANIONS).flat()
)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
// Parse the whole script before a child process can read stdin. A successful
// SSH exit alone is not evidence that the final verification was executed.
export function companionShellInput(script) {
	assert.equal(typeof script, 'string')
	return "bash -c '" + script.replaceAll("'", "'\\''") + "' </dev/null\n"
}

export function assertCompanionCutoverComplete(state) {
	assert.equal(state, 'finished:0:complete')
}
const envObject = values =>
	Object.fromEntries(
		values.map(value => {
			const split = value.indexOf('=')
			assert.ok(split > 0)
			return [value.slice(0, split), value.slice(split + 1)]
		})
	)
const allowed = key =>
	key === 'APP_REVISION' ||
	/CRM/.test(key) ||
	[
		'IDENTITY_NOTIFICATION_DELIVERY_TOKEN',
		'IDENTITY_INTERNAL_BASE_URL',
		'BILLING_INTERNAL_BASE_URL',
		'TRUST_PROXY'
	].includes(key)

export function companionNeighbors(live, gatewayRevision) {
	return crmNeighborFingerprint(
		live.filter(
			container =>
				!(
					container.Config?.Labels?.['com.docker.compose.project'] ===
						'winwidget' &&
					CRM_COMPANION_TARGETS.includes(
						container.Config.Labels['com.docker.compose.service']
					)
				)
		),
		gatewayRevision
	)
}

export function companionMigrationLedger(files, rows, complete = false) {
	const expected = new Map(files.map(file => [file.name, file.checksum]))
	assert.ok(expected.size > 0 && expected.size === files.length)
	const applied = new Set()
	for (const row of rows) {
		// Prisma retains failed attempts after an explicit migrate resolve
		// --rolled-back. They are history, not the applied checksum of this name.
		// A missing successful attempt still leaves the current file pending.
		if (row.rolled_back_at) {
			assert.ok(
				!row.finished_at && Number.isFinite(Date.parse(row.rolled_back_at))
			)
			assert.match(row.checksum, /^[a-f0-9]{64}$/)
			continue
		}
		assert.ok(
			row.finished_at &&
				!row.rolled_back_at &&
				!applied.has(row.migration_name)
		)
		assert.match(row.checksum, /^[a-f0-9]{64}$/)
		assert.equal(expected.get(row.migration_name), row.checksum)
		applied.add(row.migration_name)
	}
	const pending = [...expected.keys()]
		.filter(name => !applied.has(name))
		.sort()
	if (complete) assert.equal(pending.length, 0)
	return pending
}

// Initial closed-product cutover only. No Operations migrations, Gateway route
// changes, broker ACL mutations, database creation, backups or old-image fallback.
export function prepareCrmCompanionRelease({
	config,
	canonical,
	revision,
	images,
	live,
	validateCompanion
}) {
	try {
		assert.match(revision, /^[a-f0-9]{40}$/)
		assert.equal(config.name, 'winwidget')
		validateCompanion(config, canonical)
		for (const key of [
			'BILLING_WINCRM_PAYMENTS_ENABLED',
			'WIDGETS_WINCRM_CONNECTOR_ENABLED',
			'BILLING_WINCRM_WIDGETS_ELIGIBILITY_ENABLED',
			'WINCRM_INVITATION_EMAIL_ENABLED'
		])
			assert.equal(canonical[key], 'false')
		assert.ok(
			!canonical.NOTIFICATION_DELIVERY_KINDS.split(',').includes(
				'wincrm-invitation-email'
			)
		)
		assert.equal(images.length, 4)
		const desired = { name: 'winwidget', services: {} }
		const changes = {}
		for (const [owner, names] of Object.entries(CRM_COMPANIONS)) {
			const image = images.find(item =>
				item.RepoTags?.includes('winwidget-' + owner + ':git-' + revision)
			)
			assert.ok(image?.Id && image.Os === 'linux')
			assert.match(image.Id, /^sha256:[a-f0-9]{64}$/)
			assert.equal(
				image.Config.Labels['org.opencontainers.image.revision'],
				revision
			)
			for (const name of [...names, owner + '-migrate']) {
				const service = structuredClone(config.services[name])
				assert.ok(
					service && service.network_mode === 'host' && !service.privileged
				)
				assert.ok(
					!service.secrets?.length &&
						!service.volumes?.length &&
						!service.ports?.length
				)
				assert.equal(service.environment.APP_REVISION, revision)
				const schema = owner.replaceAll('-', '_')
				const urlKey = schema.toUpperCase() + '_DATABASE_URL'
				const url = new URL(service.environment[urlKey])
				assert.equal(url.hostname, '127.0.0.1')
				assert.equal(url.pathname, '/winwidget_' + schema)
				assert.equal(url.searchParams.get('schema'), schema)
				assert.equal(
					url.username,
					'winwidget_' +
						schema +
						(name.endsWith('-migrate') ? '_migration' : '_runtime')
				)
				if (!name.endsWith('-migrate')) {
					const matches = live.filter(
						item =>
							item.Config?.Labels?.['com.docker.compose.project'] ===
								'winwidget' &&
							item.Config.Labels['com.docker.compose.service'] === name
					)
					assert.equal(matches.length, 1)
					const before = envObject(matches[0].Config.Env)
					assert.equal(matches[0].State.Running, true)
					assert.equal(matches[0].State.Health.Status, 'healthy')
					assert.equal(matches[0].State.OOMKilled, false)
					assertServiceConfiguration(service, matches[0], image, {})
					const inherited = envObject(image.Config.Env ?? [])
					changes[name] = []
					for (const [key, value] of Object.entries(service.environment)) {
						if (String(value) === before[key]) continue
						assert.ok(
							allowed(key),
							'Unexpected companion setting: ' + name + ':' + key
						)
						changes[name].push(key)
					}
					for (const [key, value] of Object.entries(before))
						if (!Object.hasOwn(service.environment, key))
							assert.equal(inherited[key], value)
				}
				delete service.build
				delete service.depends_on
				service.image = image.Id
				desired.services[name] = service
			}
		}
		assert.equal(Object.keys(desired.services).length, 13)
		return { desired, changes }
	} catch (error) {
		// Field names are useful for a drift audit. Never propagate an assertion
		// with actual/expected values from private environment or image data.
		const field =
			/^Unexpected companion setting: ([a-z-]+:[A-Z0-9_]+)$/.exec(
				error.message ?? ''
			)
		throw new Error(
			'CRM companion release rejected' +
				(field ? ': ' + field[1] : '; private details suppressed')
		)
	}
}

export function assertCrmCompanionRuntime({
	desired,
	live,
	images,
	revision
}) {
	for (const name of CRM_COMPANION_TARGETS) {
		const matches = live.filter(
			item =>
				item.Config?.Labels?.['com.docker.compose.project'] ===
					'winwidget' &&
				item.Config.Labels['com.docker.compose.service'] === name
		)
		assert.equal(matches.length, 1)
		const actual = matches[0],
			service = desired.services[name]
		const image = images.find(item => item.Id === service.image)
		assert.ok(image)
		assert.equal(actual.Image, image.Id)
		assert.equal(actual.State.Health.Status, 'healthy')
		assert.equal(actual.State.Running, true)
		assert.equal(actual.State.OOMKilled, false)
		assert.equal(actual.RestartCount, 0)
		const expected = {
			...envObject(image.Config.Env ?? []),
			...service.environment
		}
		assert.equal(expected.APP_REVISION, revision)
		assert.deepEqual(envObject(actual.Config.Env), expected)
		assertServiceConfiguration(service, actual, image, {})
	}
	return {
		runtimeProcesses: 9,
		revision,
		configurationSha256: digest(JSON.stringify(desired)),
		productsEnabled: false
	}
}

// Compose interpolation is a second parse; preserve literal dollar signs from
// the first normalization (including existing credentials) without expansion.
export function companionComposeBytes(config) {
	return JSON.stringify(config).replaceAll('$', () => '$$') + '\n'
}
