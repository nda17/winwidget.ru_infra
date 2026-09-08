import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { crmNeighborFingerprint } from './crm-release.mjs'
import { assertServiceConfiguration } from './scoped-service-release.mjs'

// Configuration only: immutable readers must already have passed crm-upgrade.
// Access authorization is ready before the first payment-capable Billing role.
export const CRM_COMMERCE_TARGETS = Object.freeze([
	'winwidget-crm/crm-customers-api',
	'winwidget-crm/crm-access-worker',
	'winwidget-crm/crm-access-outbox-publisher',
	'winwidget-crm/crm-access-api',
	'winwidget/billing-worker',
	'winwidget/billing-scheduler',
	'winwidget/billing-api'
])
const PAYMENTS = 'BILLING_WINCRM_PAYMENTS_ENABLED'
const RECONCILIATION = 'BILLING_WINCRM_RECONCILIATION_ENABLED'
const ACCESS = 'CRM_ACCESS_BILLING_ENABLED'
const DADATA = 'CRM_CUSTOMERS_DADATA_API_KEY'
const KIND = 'winwidget.crm.commerce-activation.v1'
const hash = value => createHash('sha256').update(value).digest('hex')
const stable = value =>
	JSON.stringify(value, (_, item) =>
		item && typeof item === 'object' && !Array.isArray(item)
			? Object.fromEntries(
					Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
				)
			: item
	)
const isHash = value =>
	typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const isRevision = value =>
	typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const keyOf = row =>
	`${row.Config?.Labels?.['com.docker.compose.project']}/${row.Config?.Labels?.['com.docker.compose.service']}`
const protectedCall = operation => {
	try {
		return operation()
	} catch {
		throw new Error(
			'CRM commerce activation rejected; private details suppressed'
		)
	}
}
function exact(value, keys) {
	assert.ok(value && typeof value === 'object' && !Array.isArray(value))
	assert.deepEqual(Object.keys(value).sort(), [...keys].sort())
}
function environment(entries) {
	assert.ok(Array.isArray(entries))
	const value = {}
	for (const entry of entries) {
		assert.equal(typeof entry, 'string')
		const split = entry.indexOf('=')
		const key = entry.slice(0, split)
		assert.ok(split > 0 && /^[A-Z_][A-Z0-9_]*$/.test(key))
		assert.equal(Object.hasOwn(value, key), false)
		value[key] = entry.slice(split + 1)
	}
	return value
}
function environmentHashes(value) {
	exact(value, ['canonical', 'billing', 'crm'])
	for (const hash of Object.values(value)) assert.ok(isHash(hash))
}
function configuration(row) {
	const config = structuredClone(row.Config)
	delete config.Hostname
	delete config.Image
	config.Env = environment(config.Env)
	config.Labels = Object.fromEntries(
		Object.entries(config.Labels).filter(
			([key]) =>
				!key.startsWith('com.docker.compose.') ||
				[
					'com.docker.compose.project',
					'com.docker.compose.service',
					'com.docker.compose.oneoff',
					'com.docker.compose.container-number'
				].includes(key)
		)
	)
	return {
		name: row.Name,
		config,
		host: row.HostConfig,
		mounts: [...row.Mounts].sort((a, b) =>
			a.Destination.localeCompare(b.Destination)
		)
	}
}
function ready(row) {
	assert.ok(isHash(row.Id) && /^sha256:[a-f0-9]{64}$/.test(row.Image))
	assert.equal(row.State.Running, true)
	assert.equal(row.State.Health.Status, 'healthy')
	for (const key of ['Paused', 'Restarting', 'OOMKilled', 'Dead'])
		assert.equal(row.State[key], false)
	assert.equal(row.RestartCount, 0)
	assert.ok(Number.isFinite(Date.parse(row.State.StartedAt)))
}
function inventory(live) {
	assert.ok(
		Array.isArray(live) &&
			live.length > CRM_COMMERCE_TARGETS.length &&
			live.length <= 200
	)
	assert.equal(new Set(live.map(keyOf)).size, live.length)
	assert.equal(new Set(live.map(row => row.Id)).size, live.length)
	for (const row of live) {
		assert.ok(
			['winwidget', 'winwidget-crm'].includes(
				row.Config?.Labels?.['com.docker.compose.project']
			)
		)
		assert.match(
			row.Config.Labels['com.docker.compose.service'],
			/^[a-z][a-z0-9-]*$/
		)
	}
}
function neighbors(live, revision) {
	return crmNeighborFingerprint(
		live.filter(row => !CRM_COMMERCE_TARGETS.includes(keyOf(row))),
		revision
	)
}
function baselineShape(value) {
	exact(value, [
		'schemaVersion',
		'kind',
		'gatewayRevision',
		'environmentHashes',
		'neighborsSha256',
		'targets'
	])
	assert.equal(value.schemaVersion, 1)
	assert.equal(value.kind, `${KIND}.baseline`)
	assert.ok(
		isRevision(value.gatewayRevision) && isHash(value.neighborsSha256)
	)
	environmentHashes(value.environmentHashes)
	exact(value.targets, CRM_COMMERCE_TARGETS)
	for (const target of Object.values(value.targets)) {
		exact(target, [
			'id',
			'image',
			'revision',
			'startedAt',
			'configurationSha256'
		])
		assert.ok(
			isHash(target.id) &&
				isHash(target.configurationSha256) &&
				isRevision(target.revision)
		)
		assert.match(target.image, /^sha256:[a-f0-9]{64}$/)
		assert.ok(Number.isFinite(Date.parse(target.startedAt)))
	}
}

// Public baseline: only IDs and hashes. Input hashes bind the approved prepared
// owner files; their old/new byte-preserving synchronization is a separate gate.
export function crmCommerceBaseline(live, gatewayRevision, hashes) {
	return protectedCall(() => {
		inventory(live)
		environmentHashes(hashes)
		const targets = {}
		for (const key of CRM_COMMERCE_TARGETS) {
			const row = live.find(item => keyOf(item) === key)
			ready(row)
			const revision = environment(row.Config.Env).APP_REVISION
			assert.ok(isRevision(revision))
			assert.equal(
				row.Config.Labels['org.opencontainers.image.revision'],
				revision
			)
			targets[key] = {
				id: row.Id,
				image: row.Image,
				revision,
				startedAt: row.State.StartedAt,
				configurationSha256: hash(stable(configuration(row)))
			}
		}
		const result = {
			schemaVersion: 1,
			kind: `${KIND}.baseline`,
			gatewayRevision,
			environmentHashes: {
				canonical: hashes.canonical,
				billing: hashes.billing,
				crm: hashes.crm
			},
			neighborsSha256: neighbors(live, gatewayRevision),
			targets
		}
		baselineShape(result)
		return result
	})
}

function nextEnvironment(key, before, settings) {
	const next = { ...before }
	if (key.startsWith('winwidget/billing-')) {
		assert.equal(before[PAYMENTS], 'false')
		next[PAYMENTS] = 'true'
		if (!key.endsWith('billing-api')) {
			assert.ok(['false', 'true'].includes(before[RECONCILIATION]))
			next[RECONCILIATION] = 'true'
		}
	} else if (key.includes('/crm-access-')) {
		assert.equal(before[ACCESS], 'false')
		next[ACCESS] = 'true'
	} else {
		assert.ok(!Object.hasOwn(before, DADATA) || before[DADATA] === '')
		if (settings.dadata === 'enabled') {
			assert.match(settings.dadataKey, /^[a-f0-9]{40}$/)
			next[DADATA] = settings.dadataKey
		} else next[DADATA] = ''
	}
	return next
}

const serviceKeys = [
	'image',
	'build',
	'depends_on',
	'profiles',
	'environment',
	'labels',
	'user',
	'network_mode',
	'read_only',
	'privileged',
	'pid',
	'cap_add',
	'cap_drop',
	'security_opt',
	'restart',
	'mem_limit',
	'mem_reservation',
	'memswap_limit',
	'cpus',
	'pids_limit',
	'logging',
	'ports',
	'devices',
	'volumes',
	'secrets',
	'tmpfs',
	'healthcheck',
	'stop_grace_period',
	'entrypoint',
	'command',
	'init'
]
function serviceConfiguration(service, row, image) {
	assert.ok(Object.keys(service).every(key => serviceKeys.includes(key)))
	exact(service.healthcheck, [
		'test',
		'interval',
		'timeout',
		'start_period',
		'retries'
	])
	exact(service.logging, ['driver', 'options'])
	for (const field of ['ports', 'devices', 'volumes', 'secrets'])
		assert.equal(service[field]?.length ?? 0, 0)
	assertServiceConfiguration(service, row, image, {})
	assert.equal(Boolean(service.init), Boolean(row.HostConfig.Init))
	// Existing CRM roles explicitly cap swap; existing Billing roles omit it.
	// Removing the CRM cap must fail before recreation, not only at postflight.
	assert.equal(
		Object.hasOwn(service, 'memswap_limit'),
		keyOf(row).startsWith('winwidget-crm/')
	)
	if (service.memswap_limit !== undefined)
		assert.equal(Number(service.memswap_limit), row.HostConfig.MemorySwap)
	else {
		// Docker's unset swap limit with --memory is twice the memory total.
		// https://docs.docker.com/engine/containers/resource_constraints/#--memory-swap-details
		assert.ok(
			Number.isSafeInteger(row.HostConfig.Memory) &&
				row.HostConfig.Memory > 0
		)
		assert.equal(row.HostConfig.MemorySwap, 2 * row.HostConfig.Memory)
	}
	assert.equal(image.Config.WorkingDir, row.Config.WorkingDir)
	assert.ok(
		Object.keys(service.labels ?? {}).every(
			key => !key.startsWith('com.docker.compose.')
		)
	)
	const labels = Object.fromEntries(
		Object.entries(row.Config.Labels).filter(
			([key]) => !key.startsWith('com.docker.compose.')
		)
	)
	assert.equal(
		stable(labels),
		stable({ ...image.Config.Labels, ...service.labels })
	)
}

// Reused by the one-target Customers provider configuration scope. These are
// validation primitives only; commerce targets, flags and admission stay local.
export {
	configuration as crmConfigOnlyConfiguration,
	environment as crmContainerEnvironment,
	ready as assertCrmConfigOnlyReady,
	serviceConfiguration as assertCrmConfigOnlyService
}

// This returns a PRIVATE plan containing materialized environments. Never log
// it; the shell must seal it 0600 and use only its digest in public receipts.
export function prepareCrmCommerceActivation(
	{ live, baseline, configs, images, settings, environmentHashes: hashes },
	validators
) {
	return protectedCall(() => {
		baselineShape(baseline)
		assert.equal(
			stable(crmCommerceBaseline(live, baseline.gatewayRevision, hashes)),
			stable(baseline)
		)
		exact(configs, ['winwidget', 'winwidget-crm'])
		exact(
			settings,
			settings.dadata === 'enabled' ? ['dadata', 'dadataKey'] : ['dadata']
		)
		assert.ok(['disabled', 'enabled'].includes(settings.dadata))
		assert.equal(typeof validators?.crm, 'function')
		assert.equal(typeof validators?.companions, 'function')
		validators.crm(configs['winwidget-crm'])
		validators.companions(configs.winwidget)
		const expectedImages = [
			...new Set(Object.values(baseline.targets).map(row => row.image))
		].sort()
		assert.deepEqual(images.map(row => row.Id).sort(), expectedImages)
		for (const image of images) {
			assert.equal(image.Os, 'linux')
			assert.ok(['amd64', 'arm64'].includes(image.Architecture))
			const inherited = environment(image.Config.Env ?? [])
			for (const key of [PAYMENTS, RECONCILIATION, ACCESS, DADATA])
				assert.equal(Object.hasOwn(inherited, key), false)
		}
		// Reject credential leakage even into a non-target or migration job.
		for (const [project, config] of Object.entries(configs)) {
			assert.equal(config.name, project)
			for (const [name, service] of Object.entries(config.services)) {
				const key = `${project}/${name}`
				if (Object.hasOwn(service.environment ?? {}, DADATA))
					assert.equal(key, 'winwidget-crm/crm-customers-api')
			}
		}
		const desired = {
			winwidget: { name: 'winwidget', services: {} },
			'winwidget-crm': { name: 'winwidget-crm', services: {} }
		}
		const targets = {}
		for (const key of CRM_COMMERCE_TARGETS) {
			const [project, name] = key.split('/')
			const previous = baseline.targets[key]
			const row = live.find(item => keyOf(item) === key)
			const image = images.find(item => item.Id === previous.image)
			const owner = name.startsWith('billing-')
				? 'billing'
				: name.startsWith('crm-access-')
					? 'crm-access'
					: 'crm-customers'
			assert.equal(
				image.Config.Labels['org.opencontainers.image.title'],
				`winwidget-${owner}`
			)
			assert.equal(
				image.Config.Labels['org.opencontainers.image.revision'],
				previous.revision
			)
			const service = structuredClone(configs[project].services[name])
			assert.equal(service.image, previous.image)
			assert.equal(service.environment.APP_REVISION, previous.revision)
			serviceConfiguration(service, row, image)
			const expectedEnv = nextEnvironment(
				key,
				environment(row.Config.Env),
				settings
			)
			const effective = {
				...environment(image.Config.Env ?? []),
				...service.environment
			}
			assert.equal(stable(effective), stable(expectedEnv))
			const candidate = structuredClone(row)
			candidate.Config.Env = Object.entries(effective).map(
				([key, value]) => `${key}=${value}`
			)
			delete service.build
			delete service.depends_on
			delete service.profiles
			desired[project].services[name] = service
			targets[key] = {
				...previous,
				desiredConfigurationSha256: hash(stable(configuration(candidate)))
			}
		}
		return {
			schemaVersion: 1,
			kind: KIND,
			baselineSha256: hash(stable(baseline)),
			environmentHashes: structuredClone(hashes),
			targets,
			desired
		}
	})
}

export function crmCommercePlanDigest(plan) {
	return protectedCall(() => {
		exact(plan, [
			'schemaVersion',
			'kind',
			'baselineSha256',
			'environmentHashes',
			'targets',
			'desired'
		])
		assert.equal(plan.schemaVersion, 1)
		assert.equal(plan.kind, KIND)
		assert.ok(isHash(plan.baselineSha256))
		environmentHashes(plan.environmentHashes)
		exact(plan.targets, CRM_COMMERCE_TARGETS)
		return hash(stable(plan))
	})
}

// Durable state is supplied by the locked shell journal. No inference from a
// timeout: completed IDs are immutable and only the next target may be absent.
export function assertCrmCommerceProgress(live, baseline, plan, state) {
	return protectedCall(() => {
		inventory(live)
		baselineShape(baseline)
		const planSha256 = crmCommercePlanDigest(plan)
		assert.equal(plan.baselineSha256, hash(stable(baseline)))
		exact(state, ['admission', 'completed', 'switching'])
		assert.equal(
			neighbors(live, baseline.gatewayRevision),
			baseline.neighborsSha256
		)
		const done = Object.keys(state.completed)
		assert.deepEqual(
			[...done].sort(),
			CRM_COMMERCE_TARGETS.slice(0, done.length).sort()
		)
		if (state.admission === null) {
			assert.equal(done.length, 0)
			assert.equal(state.switching, null)
		} else {
			exact(state.admission, ['schemaVersion', 'kind', 'planSha256'])
			assert.equal(state.admission.schemaVersion, 1)
			assert.equal(state.admission.kind, `${KIND}.admission`)
			assert.equal(state.admission.planSha256, planSha256)
			assert.ok(
				state.switching === null ||
					state.switching === CRM_COMMERCE_TARGETS[done.length]
			)
		}
		for (const key of CRM_COMMERCE_TARGETS) {
			const row = live.find(item => keyOf(item) === key)
			const old = baseline.targets[key]
			if (!row) {
				assert.equal(key, state.switching)
				continue
			}
			assert.equal(row.Image, old.image)
			assert.equal(environment(row.Config.Env).APP_REVISION, old.revision)
			assert.equal(
				row.Config.Labels['org.opencontainers.image.revision'],
				old.revision
			)
			const actual = hash(stable(configuration(row)))
			if (Object.hasOwn(state.completed, key)) {
				exact(state.completed[key], ['id', 'startedAt'])
				assert.notEqual(row.Id, old.id)
				assert.equal(row.Id, state.completed[key].id)
				assert.equal(row.State.StartedAt, state.completed[key].startedAt)
				assert.equal(actual, plan.targets[key].desiredConfigurationSha256)
				ready(row)
			} else if (key === state.switching) {
				assert.ok(isHash(row.Id))
				assert.equal(row.RestartCount, 0)
				assert.equal(row.State.OOMKilled, false)
				assert.equal(row.State.Dead, false)
				assert.equal(row.State.Paused, false)
				assert.equal(row.State.Restarting, false)
				if (row.Id === old.id) {
					assert.equal(actual, old.configurationSha256)
					assert.equal(row.State.StartedAt, old.startedAt)
				} else
					assert.equal(
						actual,
						plan.targets[key].desiredConfigurationSha256
					)
				if (!row.State.Running) assert.equal(row.State.Pid, 0)
				else
					assert.ok(
						['starting', 'healthy'].includes(row.State.Health.Status)
					)
			} else {
				assert.equal(row.Id, old.id)
				assert.equal(row.State.StartedAt, old.startedAt)
				assert.equal(actual, old.configurationSha256)
				ready(row)
			}
		}
		return {
			complete: done.length === CRM_COMMERCE_TARGETS.length,
			next: CRM_COMMERCE_TARGETS[done.length] ?? null,
			recovery: state.admission === null ? 'PRE_ADMISSION' : 'FORWARD_ONLY'
		}
	})
}

// Probe adapter must derive these from READ ONLY owner transactions. This pure
// function neither opens databases nor makes a provider request.
export function assertCrmCommerceDatabaseProof(
	before,
	after,
	now,
	requireIdle = true
) {
	return protectedCall(() => {
		assert.ok(Number.isSafeInteger(now))
		assert.equal(typeof requireIdle, 'boolean')
		for (const proof of [before, after]) {
			exact(proof, ['schemaVersion', 'checkedAt', 'owners', 'counts'])
			assert.equal(proof.schemaVersion, 1)
			const at = Date.parse(proof.checkedAt)
			assert.ok(Number.isFinite(at) && at <= now)
			exact(proof.owners, ['billing', 'crm-access', 'crm-customers'])
			for (const [owner, row] of Object.entries(proof.owners)) {
				exact(row, [
					'databaseId',
					'database',
					'schema',
					'serviceName',
					'principal',
					'readOnly',
					'recovery',
					'postgresVersion',
					'sourceSha256',
					'ledgerSha256',
					'rolesSha256',
					'aclSha256',
					'pendingMigrations'
				])
				const schema = owner.replaceAll('-', '_')
				assert.match(
					row.databaseId,
					/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
				)
				assert.equal(row.database, `winwidget_${schema}`)
				assert.equal(row.schema, schema)
				assert.equal(row.serviceName, `${owner}-service`)
				assert.equal(row.principal, `winwidget_${schema}_migration`)
				assert.equal(row.readOnly, true)
				assert.equal(row.recovery, false)
				assert.ok(
					Number.isInteger(row.postgresVersion) &&
						row.postgresVersion >= 180000 &&
						row.postgresVersion < 190000
				)
				for (const key of [
					'sourceSha256',
					'ledgerSha256',
					'rolesSha256',
					'aclSha256'
				])
					assert.ok(isHash(row[key]))
				assert.equal(row.pendingMigrations, 0)
			}
			assert.equal(
				new Set(Object.values(proof.owners).map(row => row.databaseId))
					.size,
				3
			)
			exact(proof.counts, [
				'orders',
				'renewals',
				'providerOperations',
				'paidPeriods',
				'dueRenewals',
				'pendingProviderDeliveries',
				'unpublishedProviderOutbox',
				'accessOperations',
				'accessCapacityFences'
			])
			for (const value of Object.values(proof.counts)) {
				assert.ok(Number.isSafeInteger(value) && value >= 0)
				if (requireIdle) assert.equal(value, 0)
			}
		}
		assert.ok(now - Date.parse(after.checkedAt) <= 60000)
		assert.ok(Date.parse(after.checkedAt) >= Date.parse(before.checkedAt))
		assert.equal(stable(before.owners), stable(after.owners))
		return true
	})
}
