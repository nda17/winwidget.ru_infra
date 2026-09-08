import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
	crmConfigOnlyConfiguration,
	crmContainerEnvironment,
	assertCrmConfigOnlyReady,
	assertCrmConfigOnlyService
} from './crm-commerce-activation.mjs'
import { crmNeighborFingerprint } from './crm-release.mjs'

const KIND = 'winwidget.crm.customers-provider-config.v1'
export const PROVIDER_TARGET = 'winwidget-crm/crm-customers-api'
export const PROVIDER_KEY = 'CRM_CUSTOMERS_DADATA_API_KEY'
export const PROVIDER_PAYLOAD_FILES = Object.freeze([
	'crm-customers-provider-config.mjs',
	'crm-commerce-activation.mjs',
	'crm-release.mjs',
	'scoped-service-release.mjs'
])
const sha = value => createHash('sha256').update(value).digest('hex')
const stable = value =>
	JSON.stringify(value, (_, item) =>
		item && typeof item === 'object' && !Array.isArray(item)
			? Object.fromEntries(
					Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
				)
			: item
	)
const keyOf = row =>
	`${row.Config?.Labels?.['com.docker.compose.project']}/${row.Config?.Labels?.['com.docker.compose.service']}`
const exact = (value, keys) => {
	assert.ok(value && typeof value === 'object' && !Array.isArray(value))
	assert.deepEqual(Object.keys(value).sort(), [...keys].sort())
}
const hash = value => assert.match(value, /^[a-f0-9]{64}$/)
const revision = value => assert.match(value, /^[a-f0-9]{40}$/)
const safe = fn => {
	try {
		return fn()
	} catch {
		throw new Error(
			'CRM Customers provider configuration rejected; private details suppressed'
		)
	}
}
const fingerprint = row => sha(stable(crmConfigOnlyConfiguration(row)))
function inventory(live) {
	assert.ok(Array.isArray(live) && live.length > 1 && live.length <= 200)
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
function envHashes(hashes) {
	exact(hashes, ['canonical', 'crm'])
	Object.values(hashes).forEach(hash)
	return { canonical: hashes.canonical, crm: hashes.crm }
}
function shape(baseline) {
	exact(baseline, [
		'schemaVersion',
		'kind',
		'gatewayRevision',
		'environmentHashes',
		'neighborsSha256',
		'target'
	])
	assert.equal(baseline.schemaVersion, 1)
	assert.equal(baseline.kind, `${KIND}.baseline`)
	revision(baseline.gatewayRevision)
	envHashes(baseline.environmentHashes)
	hash(baseline.neighborsSha256)
	exact(baseline.target, [
		'id',
		'image',
		'revision',
		'startedAt',
		'configurationSha256'
	])
	hash(baseline.target.id)
	hash(baseline.target.configurationSha256)
	revision(baseline.target.revision)
	assert.match(baseline.target.image, /^sha256:[a-f0-9]{64}$/)
	assert.ok(Number.isFinite(Date.parse(baseline.target.startedAt)))
}
const neighbors = (live, gateway) =>
	crmNeighborFingerprint(
		live.filter(row => keyOf(row) !== PROVIDER_TARGET),
		gateway
	)

// Public IDs/hashes only. The hashes bind the already reconciled complete files,
// never a key fragment. Root/VPS env synchronization is a separate operator step.
export function customersProviderBaseline(live, gatewayRevision, hashes) {
	return safe(() => {
		inventory(live)
		const row = live.find(item => keyOf(item) === PROVIDER_TARGET)
		assertCrmConfigOnlyReady(row)
		const env = crmContainerEnvironment(row.Config.Env)
		assert.equal(env[PROVIDER_KEY], '')
		assert.equal(
			env.APP_REVISION,
			row.Config.Labels['org.opencontainers.image.revision']
		)
		const result = {
			schemaVersion: 1,
			kind: `${KIND}.baseline`,
			gatewayRevision,
			environmentHashes: envHashes(hashes),
			neighborsSha256: neighbors(live, gatewayRevision),
			target: {
				id: row.Id,
				image: row.Image,
				revision: env.APP_REVISION,
				startedAt: row.State.StartedAt,
				configurationSha256: fingerprint(row)
			}
		}
		shape(result)
		return result
	})
}
export function prepareCustomersProvider({
	live,
	baseline,
	config,
	image,
	hashes
}) {
	return safe(() => {
		shape(baseline)
		assert.equal(
			stable(
				customersProviderBaseline(live, baseline.gatewayRevision, hashes)
			),
			stable(baseline)
		)
		assert.equal(config.name, 'winwidget-crm')
		for (const [name, service] of Object.entries(config.services)) {
			if (Object.hasOwn(service.environment ?? {}, PROVIDER_KEY))
				assert.equal(name, 'crm-customers-api')
		}
		const row = live.find(item => keyOf(item) === PROVIDER_TARGET)
		assert.equal(image.Id, row.Image)
		assert.equal(image.Os, 'linux')
		assert.ok(['amd64', 'arm64'].includes(image.Architecture))
		assert.equal(
			image.Config.Labels['org.opencontainers.image.title'],
			'winwidget-crm-customers'
		)
		assert.equal(
			image.Config.Labels['org.opencontainers.image.revision'],
			baseline.target.revision
		)
		const inherited = crmContainerEnvironment(image.Config.Env ?? [])
		assert.equal(Object.hasOwn(inherited, PROVIDER_KEY), false)
		const service = structuredClone(config.services['crm-customers-api'])
		assert.equal(service.image, row.Image)
		assertCrmConfigOnlyService(service, row, image)
		const effective = { ...inherited, ...service.environment }
		assert.match(effective[PROVIDER_KEY], /^[a-f0-9]{40}$/)
		const expected = {
			...crmContainerEnvironment(row.Config.Env),
			[PROVIDER_KEY]: effective[PROVIDER_KEY]
		}
		assert.equal(stable(effective), stable(expected))
		const candidate = structuredClone(row)
		candidate.Config.Env = Object.entries(effective).map(
			([key, value]) => `${key}=${value}`
		)
		delete service.build
		delete service.depends_on
		delete service.profiles
		return {
			schemaVersion: 1,
			kind: KIND,
			baselineSha256: sha(stable(baseline)),
			environmentHashes: envHashes(hashes),
			desiredConfigurationSha256: fingerprint(candidate),
			desired: {
				name: 'winwidget-crm',
				services: { 'crm-customers-api': service }
			}
		}
	})
}
export function customersProviderPlanDigest(plan) {
	return safe(() => {
		exact(plan, [
			'schemaVersion',
			'kind',
			'baselineSha256',
			'environmentHashes',
			'desiredConfigurationSha256',
			'desired'
		])
		assert.equal(plan.schemaVersion, 1)
		assert.equal(plan.kind, KIND)
		hash(plan.baselineSha256)
		hash(plan.desiredConfigurationSha256)
		envHashes(plan.environmentHashes)
		exact(plan.desired, ['name', 'services'])
		assert.equal(plan.desired.name, 'winwidget-crm')
		exact(plan.desired.services, ['crm-customers-api'])
		return sha(stable(plan))
	})
}

// Separate write-once receipts survive uncertain stop/create observations. An
// existing start receipt can only be observed, never authorize another create.
export function customersProviderTransition(
	{
		live,
		baseline,
		plan,
		admission = null,
		switching = null,
		started = null,
		observed = null,
		completed = null
	},
	action
) {
	return safe(() => {
		inventory(live)
		shape(baseline)
		const planSha256 = customersProviderPlanDigest(plan)
		assert.equal(plan.baselineSha256, sha(stable(baseline)))
		assert.deepEqual(plan.environmentHashes, baseline.environmentHashes)
		assert.equal(
			neighbors(live, baseline.gatewayRevision),
			baseline.neighborsSha256
		)
		const receipt = kind => ({
			schemaVersion: 1,
			kind: `${KIND}.${kind}`,
			planSha256
		})
		if (admission) assert.deepEqual(admission, receipt('admission'))
		if (switching) {
			assert.ok(admission)
			assert.deepEqual(switching, receipt('switching'))
		}
		if (started) {
			assert.ok(switching)
			assert.deepEqual(started, receipt('start'))
		}
		if (observed) {
			assert.ok(started)
			exact(observed, [
				'schemaVersion',
				'kind',
				'planSha256',
				'id',
				'startedAt'
			])
			assert.deepEqual(
				{ ...observed, id: undefined, startedAt: undefined },
				{ ...receipt('observed'), id: undefined, startedAt: undefined }
			)
			hash(observed.id)
			assert.ok(Number.isFinite(Date.parse(observed.startedAt)))
		}
		if (completed) {
			assert.ok(observed)
			assert.deepEqual(completed, {
				...observed,
				kind: `${KIND}.completed`
			})
		}
		const row = live.find(item => keyOf(item) === PROVIDER_TARGET)
		const old = baseline.target
		if (!row) assert.ok(switching && !observed)
		else {
			assert.equal(row.Image, old.image)
			assert.equal(
				crmContainerEnvironment(row.Config.Env).APP_REVISION,
				old.revision
			)
			assert.equal(
				row.Config.Labels['org.opencontainers.image.revision'],
				old.revision
			)
			assert.equal(row.RestartCount, 0)
			for (const key of ['Paused', 'Restarting', 'OOMKilled', 'Dead'])
				assert.equal(row.State[key], false)
			if (row.Id === old.id) {
				assert.equal(observed, null)
				assert.equal(row.State.StartedAt, old.startedAt)
				assert.equal(fingerprint(row), old.configurationSha256)
				if (!switching) assertCrmConfigOnlyReady(row)
			} else {
				assert.ok(started)
				hash(row.Id)
				assert.equal(fingerprint(row), plan.desiredConfigurationSha256)
				if (observed) {
					assert.equal(row.Id, observed.id)
					assert.equal(row.State.StartedAt, observed.startedAt)
				}
			}
			if (!row.State.Running) assert.equal(row.State.Pid, 0)
			else
				assert.ok(
					['starting', 'healthy'].includes(row.State.Health.Status)
				)
			if (completed) assertCrmConfigOnlyReady(row)
		}
		if (action === 'progress') return { complete: completed !== null }
		if (action === 'admit') {
			assert.equal(admission, null)
			return receipt('admission')
		}
		assert.ok(admission)
		if (action === 'begin') {
			assert.equal(switching, null)
			return receipt('switching')
		}
		assert.ok(switching)
		if (action === 'start') {
			assert.equal(started, null)
			if (row) {
				assert.equal(row.Id, old.id)
				assert.equal(row.State.Running, false)
				assert.equal(row.State.Pid, 0)
			}
			return receipt('start')
		}
		assert.ok(started)
		assert.ok(row && row.Id !== old.id)
		if (action === 'observe') {
			assert.equal(observed, null)
			assert.equal(row.State.Running, true)
			assert.ok(Number.isFinite(Date.parse(row.State.StartedAt)))
			return {
				...receipt('observed'),
				id: row.Id,
				startedAt: row.State.StartedAt
			}
		}
		if (action === 'complete') {
			assert.ok(observed)
			assert.equal(completed, null)
			assertCrmConfigOnlyReady(row)
			return { ...observed, kind: `${KIND}.completed` }
		}
		throw new Error('Unsupported transition')
	})
}

export function validateProviderPayload(bytes) {
	assert.ok(
		Buffer.byteLength(bytes) > 0 && Buffer.byteLength(bytes) <= 524288
	)
	const value = JSON.parse(bytes)
	exact(value, ['schemaVersion', 'files'])
	assert.equal(value.schemaVersion, 1)
	assert.deepEqual(
		value.files.map(file => file.name).sort(),
		[...PROVIDER_PAYLOAD_FILES].sort()
	)
	return value.files.map(file => {
		exact(file, ['name', 'sha256', 'content'])
		hash(file.sha256)
		assert.equal(typeof file.content, 'string')
		const content = Buffer.from(file.content, 'utf8')
		assert.equal(content.toString('utf8'), file.content)
		assert.ok(content.length > 0 && content.length <= 147456)
		assert.equal(sha(content), file.sha256)
		return { name: file.name, content }
	})
}
function privateBytes(path) {
	const stat = lstatSync(path)
	assert.ok(
		stat.isFile() &&
			!stat.isSymbolicLink() &&
			stat.nlink === 1 &&
			stat.uid === 0 &&
			stat.gid === 0
	)
	assert.equal(stat.mode & 0o777, 0o600)
	assert.ok(stat.size > 0 && stat.size <= 8388608)
	return readFileSync(path)
}
const directory = '/run/provider'
const json = name => JSON.parse(privateBytes(`${directory}/${name}.json`))
const optional = name => {
	try {
		return json(name)
	} catch (error) {
		if (error.code === 'ENOENT') return null
		throw error
	}
}
const currentHashes = () =>
	envHashes({
		canonical: process.env.PROVIDER_CANONICAL_SHA256,
		crm: process.env.PROVIDER_CRM_SHA256
	})
function binding(plan) {
	return {
		schemaVersion: 1,
		scope: 'crm-customers-provider-config',
		servicesRevision: process.env.PROVIDER_SERVICES_REVISION,
		infraRevision: process.env.PROVIDER_INFRA_REVISION,
		payloadSha256: process.env.PROVIDER_PAYLOAD_SHA256,
		controllerSha256: process.env.PROVIDER_CONTROLLER_SHA256,
		baselineSha256: sha(privateBytes(`${directory}/baseline.json`)),
		initialSha256: sha(privateBytes(`${directory}/initial.json`)),
		planSha256: customersProviderPlanDigest(plan),
		planFileSha256: sha(privateBytes(`${directory}/plan.json`)),
		environmentHashes: currentHashes()
	}
}
async function main() {
	assert.equal(process.argv.length, 3)
	const mode = process.argv[2]
	if (mode === 'pack') {
		const files = PROVIDER_PAYLOAD_FILES.map(name => {
			const path = new URL(name, import.meta.url),
				stat = lstatSync(path)
			assert.ok(stat.isFile() && !stat.isSymbolicLink())
			const content = readFileSync(path, 'utf8')
			return { name, sha256: sha(content), content }
		})
		const result = JSON.stringify({ schemaVersion: 1, files })
		validateProviderPayload(result)
		return result
	}
	if (mode === 'baseline')
		return customersProviderBaseline(
			json('inventory'),
			process.env.PROVIDER_GATEWAY_REVISION,
			currentHashes()
		)
	if (mode === 'image-env') {
		const result = []
		for (const owner of ['access', 'intake', 'customers', 'sales']) {
			const row = json('initial').find(
				item => keyOf(item) === `winwidget-crm/crm-${owner}-api`
			)
			assertCrmConfigOnlyReady(row)
			const rev = crmContainerEnvironment(row.Config.Env).APP_REVISION
			revision(rev)
			result.push(
				`CRM_${owner.toUpperCase()}_IMAGE=${row.Image}`,
				`CRM_${owner.toUpperCase()}_REVISION=${rev}`
			)
		}
		return result.join('\n')
	}
	if (mode === 'prepare') {
		assert.equal(optional('admission'), null)
		assert.equal(optional('plan'), null)
		const images = json('images')
		assert.equal(images.length, 1)
		return prepareCustomersProvider({
			live: json('initial'),
			baseline: json('baseline'),
			config: json('crm'),
			image: images[0],
			hashes: currentHashes()
		})
	}
	const plan = json('plan'),
		baseline = json('baseline')
	const expected = binding(plan)
	assert.equal(
		expected.baselineSha256,
		process.env.PROVIDER_BASELINE_SHA256
	)
	assert.deepEqual(plan.environmentHashes, currentHashes())
	assert.deepEqual(baseline.environmentHashes, currentHashes())
	const input = {
		live: json('inventory'),
		baseline,
		plan,
		...Object.fromEntries(
			['admission', 'switching', 'started', 'observed', 'completed'].map(
				key => [key, optional(key)]
			)
		)
	}
	if (mode === 'seal') {
		assert.equal(optional('binding'), null)
		assert.equal(input.admission, null)
		customersProviderTransition(input, 'progress')
		return expected
	}
	assert.deepEqual(json('binding'), expected)
	if (mode === 'target-id') {
		customersProviderTransition(input, 'progress')
		return baseline.target.id
	}
	if (mode === 'compose')
		return JSON.stringify(plan.desired).replaceAll('$', () => '$$')
	return customersProviderTransition(input, mode)
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const result = await main()
		process.stdout.write(
			(typeof result === 'string' ? result : JSON.stringify(result)) + '\n'
		)
	} catch {
		process.stderr.write(
			'CRM Customers provider controller rejected; private details suppressed\n'
		)
		process.exitCode = 1
	}
}
