import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	commerceState,
	commerceTransition
} from './crm-commerce-activation-cli.mjs'
import {
	CRM_COMMERCE_TARGETS,
	crmCommerceBaseline,
	prepareCrmCommerceActivation,
	crmCommercePlanDigest,
	assertCrmCommerceProgress,
	assertCrmCommerceDatabaseProof
} from './crm-commerce-activation.mjs'

const revision = 'a'.repeat(40)
const hash = 'b'.repeat(64)
const id = value => value.toString(16).padStart(64, '0')
const imageId = value => `sha256:${id(value)}`
const now = Date.parse('2026-09-07T21:00:00Z')
const secret = 'synthetic-sensitive-value'
const env = object =>
	Object.entries(object).map(([key, value]) => `${key}=${value}`)
const validators = { crm() {}, companions() {} }
const suppressed = error =>
	error.message ===
		'CRM commerce activation rejected; private details suppressed' &&
	!error.stack.includes(secret)

function fixture(dadata = 'enabled') {
	const live = [],
		images = []
	const configs = {
		winwidget: { name: 'winwidget', services: {} },
		'winwidget-crm': { name: 'winwidget-crm', services: {} }
	}
	const environmentHashes = { canonical: hash, billing: hash, crm: hash }
	const settings =
		dadata === 'enabled'
			? { dadata, dadataKey: 'c'.repeat(40) }
			: { dadata }
	const imageOwners = [
		'crm-customers',
		'crm-access',
		'billing',
		'api-gateway',
		'widgets'
	]
	for (const [i, owner] of imageOwners.entries())
		images.push({
			Id: imageId(i + 1),
			Os: 'linux',
			Architecture: 'amd64',
			Config: {
				Env: ['NODE_ENV=production'],
				User: '1001',
				WorkingDir: '/app',
				Cmd: ['node', 'dist/src/main.js'],
				Entrypoint: ['docker-entrypoint.sh'],
				Labels: {
					'org.opencontainers.image.title': `winwidget-${owner}`,
					'org.opencontainers.image.revision': revision
				}
			}
		})
	for (const [i, key] of [
		...CRM_COMMERCE_TARGETS,
		'winwidget/api-gateway',
		'winwidget/widgets-service'
	].entries()) {
		const [project, name] = key.split('/')
		const owner = name.startsWith('billing-')
			? 'billing'
			: name.startsWith('crm-access-')
				? 'crm-access'
				: name.startsWith('crm-customers-')
					? 'crm-customers'
					: name === 'api-gateway'
						? name
						: 'widgets'
		const image = images.find(
			row =>
				row.Config.Labels['org.opencontainers.image.title'] ===
				`winwidget-${owner}`
		)
		const before = {
			NODE_ENV: 'production',
			APP_REVISION: revision,
			SYNTHETIC_SECRET: secret
		}
		if (owner === 'billing') {
			before.BILLING_WINCRM_PAYMENTS_ENABLED = 'false'
			if (name !== 'billing-api')
				before.BILLING_WINCRM_RECONCILIATION_ENABLED = 'true'
		} else if (owner === 'crm-access')
			before.CRM_ACCESS_BILLING_ENABLED = 'false'
		const after = { ...before }
		if (owner === 'billing') after.BILLING_WINCRM_PAYMENTS_ENABLED = 'true'
		else if (owner === 'crm-access')
			after.CRM_ACCESS_BILLING_ENABLED = 'true'
		else if (owner === 'crm-customers')
			after.CRM_CUSTOMERS_DADATA_API_KEY = settings.dadataKey ?? ''
		const service = {
			image: image.Id,
			environment: after,
			network_mode: 'host',
			user: '1001',
			read_only: true,
			cap_drop: ['ALL'],
			security_opt: ['no-new-privileges:true'],
			restart: 'unless-stopped',
			mem_limit: 268435456,
			mem_reservation: 134217728,
			memswap_limit: 268435456,
			cpus: 0.5,
			pids_limit: 100,
			init: true,
			logging: {
				driver: 'json-file',
				options: { 'max-size': '10m', 'max-file': '3' }
			},
			healthcheck: {
				test: ['CMD', 'node', 'health.js'],
				interval: '10s',
				timeout: '5s',
				start_period: '10s',
				retries: 6
			},
			stop_grace_period: '30s',
			labels: { 'com.winwidget.owner': owner }
		}
		if (project === 'winwidget') delete service.memswap_limit
		configs[project].services[name] = service
		live.push({
			Id: id(i + 20),
			Name: `/${project}-${name}-1`,
			Image: image.Id,
			Config: {
				...structuredClone(image.Config),
				Hostname: id(i).slice(0, 12),
				Image: image.Id,
				Env: env(before),
				StopTimeout: 30,
				Labels: {
					...image.Config.Labels,
					...service.labels,
					'com.docker.compose.project': project,
					'com.docker.compose.service': name,
					'com.docker.compose.oneoff': 'False',
					'com.docker.compose.container-number': '1',
					'com.docker.compose.config-hash': hash
				},
				Healthcheck: {
					Test: service.healthcheck.test,
					Interval: 10e9,
					Timeout: 5e9,
					StartPeriod: 10e9,
					Retries: 6
				}
			},
			HostConfig: {
				NetworkMode: 'host',
				Privileged: false,
				PidMode: '',
				ReadonlyRootfs: true,
				Init: true,
				CapDrop: ['ALL'],
				CapAdd: [],
				SecurityOpt: service.security_opt,
				RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
				Memory: 268435456,
				MemoryReservation: 134217728,
				MemorySwap: project === 'winwidget-crm' ? 268435456 : 536870912,
				NanoCpus: 5e8,
				PidsLimit: 100,
				LogConfig: { Type: 'json-file', Config: service.logging.options },
				ExtraHosts: [],
				Tmpfs: {}
			},
			Mounts: [],
			NetworkSettings: {},
			RestartCount: 0,
			State: {
				Running: true,
				Pid: i + 100,
				Paused: false,
				Restarting: false,
				OOMKilled: false,
				Dead: false,
				StartedAt: '2026-09-07T20:00:00Z',
				Health: { Status: 'healthy', Log: [] }
			}
		})
	}
	return {
		live,
		images: images.slice(0, 3),
		configs,
		settings,
		environmentHashes,
		baseline: crmCommerceBaseline(live, revision, environmentHashes)
	}
}
function planFor(f) {
	return prepareCrmCommerceActivation(f, validators)
}
function stateFor(plan, admitted = true) {
	return {
		admission: admitted
			? {
					schemaVersion: 1,
					kind: `${plan.kind}.admission`,
					planSha256: crmCommercePlanDigest(plan)
				}
			: null,
		completed: {},
		switching: null
	}
}
function activate(f, plan, state, index, complete = true) {
	const key = CRM_COMMERCE_TARGETS[index]
	const [project, name] = key.split('/')
	const row = f.live.find(
		item => item.Config.Labels['com.docker.compose.service'] === name
	)
	row.Id = id(1000 + index)
	row.Config.Hostname = row.Id.slice(0, 12)
	row.Config.Labels['com.docker.compose.config-hash'] = 'd'.repeat(64)
	row.Config.Env = env(plan.desired[project].services[name].environment)
	row.State.StartedAt = '2026-09-07T21:00:00Z'
	if (complete) {
		state.completed[key] = { id: row.Id, startedAt: row.State.StartedAt }
		state.switching = null
	} else state.switching = key
	return row
}

test('durable admission and per-target start/observation receipts resume only the exact forward prefix', () => {
	const f = fixture(),
		plan = planFor(f)
	let state = stateFor(plan, false)
	const marker = stateFor(plan).admission
	assert.throws(() =>
		commerceTransition({ ...f, plan, state, marker: null }, 'begin')
	)
	assert.deepEqual(commerceState(state, marker, plan).admission, marker)
	assert.throws(() => commerceState(stateFor(plan), null, plan))
	assert.throws(() =>
		commerceState(state, { ...marker, planSha256: id(99) }, plan)
	)
	for (let index = 0; index < CRM_COMMERCE_TARGETS.length; index++) {
		const key = CRM_COMMERCE_TARGETS[index]
		const context = () => ({ ...f, plan, state, marker })
		state = commerceTransition(context(), 'begin')
		assert.throws(() => commerceTransition(context(), 'start'))
		const row = f.live.find(item => item.Id === f.baseline.targets[key].id)
		row.State.Running = false
		row.State.Pid = 0
		const started = commerceTransition(context(), 'start')
		assert.throws(() =>
			commerceTransition({ ...context(), started }, 'start')
		)
		assert.throws(() =>
			commerceTransition({ ...context(), started }, 'begin')
		)
		assert.throws(() =>
			commerceTransition({ ...context(), started }, 'observe')
		)
		const replacement = activate(f, plan, state, index, false)
		replacement.State.Running = true
		replacement.State.Health.Status = 'starting'
		const observed = commerceTransition(
			{ ...context(), started },
			'observe'
		)
		assert.throws(() =>
			commerceTransition({ ...context(), started, observed }, 'complete')
		)
		replacement.State.Health.Status = 'healthy'
		for (const mutate of [
			value => {
				value.started.key = CRM_COMMERCE_TARGETS[(index + 1) % 7]
			},
			value => {
				value.started.planSha256 = id(99)
			},
			value => {
				value.observed.id = id(9999)
			},
			value => {
				value.observed.startedAt = '2026-09-07T22:00:00Z'
			},
			value => {
				value.observed = null
			},
			value => {
				value.started = null
			},
			value => {
				value.marker = null
			}
		]) {
			const changed = structuredClone({ ...context(), started, observed })
			mutate(changed)
			assert.throws(
				() => commerceTransition(changed, 'complete'),
				undefined,
				mutate.toString()
			)
		}
		state = commerceTransition(
			{ ...context(), started, observed },
			'complete'
		)
		assert.equal(Object.keys(state.completed).length, index + 1)
	}
	assert.equal(
		commerceTransition({ ...f, plan, state, marker }, 'progress').complete,
		true
	)
})

test('baseline contains exact seven immutable readers and no secret-bearing fields', () => {
	const f = fixture()
	assert.deepEqual(Object.keys(f.baseline.targets), CRM_COMMERCE_TARGETS)
	assert.equal(JSON.stringify(f.baseline).includes(secret), false)
	assert.equal(
		JSON.stringify(f.baseline).includes(f.settings.dadataKey),
		false
	)
	for (const mutate of [
		f => f.live.pop(),
		f => f.live.push(f.live[0]),
		f => (f.live[0].State.Health.Status = 'unhealthy'),
		f => f.live[0].Config.Env.push(`APP_REVISION=${revision}`),
		f =>
			(f.live[0].Config.Labels['org.opencontainers.image.revision'] =
				'e'.repeat(40))
	]) {
		const changed = fixture()
		mutate(changed)
		if (changed.live.length === 8) {
			assert.throws(
				() => prepareCrmCommerceActivation(changed, validators),
				suppressed
			)
		} else
			assert.throws(
				() =>
					crmCommerceBaseline(
						changed.live,
						revision,
						changed.environmentHashes
					),
				suppressed
			)
	}
})

test('baseline serializes environment hashes in the CLI canonical order for every caller key order', () => {
	const f = fixture()
	const hashes = {
		canonical: '1'.repeat(64),
		billing: '2'.repeat(64),
		crm: '3'.repeat(64)
	}
	const expected = crmCommerceBaseline(f.live, revision, hashes)
	assert.deepEqual(Object.keys(expected.environmentHashes), [
		'canonical',
		'billing',
		'crm'
	])
	for (const order of [
		['canonical', 'billing', 'crm'],
		['canonical', 'crm', 'billing'],
		['billing', 'canonical', 'crm'],
		['billing', 'crm', 'canonical'],
		['crm', 'canonical', 'billing'],
		['crm', 'billing', 'canonical']
	]) {
		const input = Object.fromEntries(order.map(key => [key, hashes[key]]))
		const actual = crmCommerceBaseline(f.live, revision, input)
		assert.equal(JSON.stringify(actual), JSON.stringify(expected))
		assert.deepEqual(Object.keys(input), order)
		assert.notEqual(actual.environmentHashes, input)
	}
})

test('prepare preserves images and every unrelated effective env byte, with only the exact opt-in transitions', () => {
	for (const dadata of ['enabled', 'disabled']) {
		const f = fixture(dadata)
		const plan = planFor(f)
		assert.equal(Object.keys(plan.targets).length, 7)
		assert.equal(Object.keys(plan.desired.winwidget.services).length, 3)
		assert.equal(
			Object.keys(plan.desired['winwidget-crm'].services).length,
			4
		)
		assert.match(crmCommercePlanDigest(plan), /^[a-f0-9]{64}$/)
		for (const project of Object.values(plan.desired))
			for (const service of Object.values(project.services)) {
				assert.equal(service.environment.APP_REVISION, revision)
				assert.equal(service.environment.SYNTHETIC_SECRET, secret)
				assert.equal(service.build, undefined)
				assert.equal(service.depends_on, undefined)
				assert.equal(service.profiles, undefined)
			}
		assert.equal(
			f.live[4].Config.Env.includes(
				'BILLING_WINCRM_PAYMENTS_ENABLED=false'
			),
			true
		)
	}
	const f = fixture()
	for (const row of f.live.filter(row =>
		/billing-(worker|scheduler)$/.test(
			row.Config.Labels['com.docker.compose.service']
		)
	))
		row.Config.Env = row.Config.Env.map(entry =>
			entry === 'BILLING_WINCRM_RECONCILIATION_ENABLED=true'
				? 'BILLING_WINCRM_RECONCILIATION_ENABLED=false'
				: entry
		)
	f.baseline = crmCommerceBaseline(f.live, revision, f.environmentHashes)
	assert.ok(planFor(f))
})

test('prepare rejects activation drift, key leakage, credentials, source image changes and privilege changes before admission', () => {
	for (const [name, mutate] of [
		[
			'payments not enabled',
			f =>
				(f.configs.winwidget.services[
					'billing-api'
				].environment.BILLING_WINCRM_PAYMENTS_ENABLED = 'false')
		],
		[
			'reconciliation disabled',
			f =>
				(f.configs.winwidget.services[
					'billing-scheduler'
				].environment.BILLING_WINCRM_RECONCILIATION_ENABLED = 'false')
		],
		[
			'wrong Access role',
			f =>
				(f.configs['winwidget-crm'].services[
					'crm-access-worker'
				].environment.CRM_ACCESS_BILLING_ENABLED = 'false')
		],
		[
			'APP_REVISION drift',
			f =>
				(f.configs.winwidget.services[
					'billing-api'
				].environment.APP_REVISION = 'e'.repeat(40))
		],
		[
			'token rotation',
			f =>
				(f.configs.winwidget.services[
					'billing-api'
				].environment.SYNTHETIC_SECRET = 'changed')
		],
		[
			'secret removed',
			f =>
				delete f.configs.winwidget.services['billing-api'].environment
					.SYNTHETIC_SECRET
		],
		[
			'Widgets flag',
			f =>
				(f.configs.winwidget.services[
					'billing-api'
				].environment.BILLING_WINCRM_WIDGETS_ELIGIBILITY_ENABLED = 'true')
		],
		[
			'CORS drift',
			f =>
				(f.configs['winwidget-crm'].services[
					'crm-access-api'
				].environment.CORS_ALLOWED_ORIGINS = 'https://foreign.invalid')
		],
		['wrong DaData', f => (f.settings.dadataKey = 'invalid')],
		[
			'DaData in worker',
			f =>
				(f.configs.winwidget.services[
					'billing-worker'
				].environment.CRM_CUSTOMERS_DADATA_API_KEY = f.settings.dadataKey)
		],
		[
			'DaData in migrate',
			f =>
				(f.configs['winwidget-crm'].services['crm-customers-migrate'] = {
					environment: {
						CRM_CUSTOMERS_DADATA_API_KEY: f.settings.dadataKey
					}
				})
		],
		[
			'DaData in image',
			f =>
				f.images[0].Config.Env.push(
					`CRM_CUSTOMERS_DADATA_API_KEY=${f.settings.dadataKey}`
				)
		],
		[
			'flag in image',
			f =>
				f.images[2].Config.Env.push('BILLING_WINCRM_PAYMENTS_ENABLED=true')
		],
		['missing image', f => f.images.pop()],
		['duplicate image', f => f.images.push(f.images[0])],
		[
			'changed image ID',
			f =>
				(f.configs.winwidget.services['billing-api'].image = imageId(999))
		],
		[
			'wrong image owner',
			f =>
				(f.images[0].Config.Labels['org.opencontainers.image.title'] =
					'winwidget-billing')
		],
		[
			'wrong image revision',
			f =>
				(f.images[0].Config.Labels['org.opencontainers.image.revision'] =
					'e'.repeat(40))
		],
		[
			'host privilege',
			f => (f.configs.winwidget.services['billing-api'].privileged = true)
		],
		[
			'capability',
			f =>
				(f.configs.winwidget.services['billing-api'].cap_add = [
					'SYS_ADMIN'
				])
		],
		[
			'mount',
			f =>
				(f.configs.winwidget.services['billing-api'].volumes = [
					{ type: 'bind', source: '/foreign', target: '/foreign' }
				])
		],
		[
			'port',
			f =>
				(f.configs.winwidget.services['billing-api'].ports = ['80:4800'])
		],
		[
			'unknown deployment setting',
			f =>
				(f.configs.winwidget.services['billing-api'].entrypoint_magic =
					secret)
		],
		[
			'memory drift',
			f => (f.configs.winwidget.services['billing-api'].mem_limit = 1024)
		],
		[
			'removed CRM swap cap',
			f =>
				delete f.configs['winwidget-crm'].services['crm-access-api']
					.memswap_limit
		],
		[
			'disabled readiness',
			f =>
				(f.configs.winwidget.services['billing-api'].healthcheck.disable =
					true)
		],
		[
			'changed start interval',
			f =>
				(f.configs.winwidget.services[
					'billing-api'
				].healthcheck.start_interval = '500ms')
		],
		[
			'unknown healthcheck key',
			f =>
				(f.configs.winwidget.services['billing-api'].healthcheck.unknown =
					true)
		],
		[
			'changed Billing swap default',
			f => {
				f.live[4].HostConfig.MemorySwap = 268435456
				f.baseline = crmCommerceBaseline(
					f.live,
					revision,
					f.environmentHashes
				)
			}
		],
		[
			'removed source label',
			f =>
				delete f.configs['winwidget-crm'].services['crm-customers-api']
					.labels['com.winwidget.owner']
		],
		[
			'new source label',
			f =>
				(f.configs['winwidget-crm'].services[
					'crm-customers-api'
				].labels.FOREIGN = 'changed')
		],
		[
			'env hash drift',
			f => (f.environmentHashes.billing = 'e'.repeat(64))
		],
		[
			'neighbor restart',
			f => (f.live.at(-1).State.StartedAt = '2026-09-07T20:30:00Z')
		],
		['neighbor replacement', f => (f.live.at(-1).Id = id(999))],
		[
			'already open baseline',
			f => {
				f.live[4].Config.Env = f.live[4].Config.Env.map(entry =>
					entry.replace('PAYMENTS_ENABLED=false', 'PAYMENTS_ENABLED=true')
				)
				f.baseline = crmCommerceBaseline(
					f.live,
					revision,
					f.environmentHashes
				)
			}
		]
	]) {
		const f = fixture()
		mutate(f)
		assert.throws(
			() => planFor(f),
			error => suppressed(error),
			name
		)
	}
	const f = fixture()
	assert.throws(
		() =>
			prepareCrmCommerceActivation(f, {
				...validators,
				crm() {
					throw new Error(secret)
				}
			}),
		suppressed
	)
})

test('runtime progresses only in dependency order, records exact new IDs and remains forward-only after admission', () => {
	const f = fixture(),
		plan = planFor(f),
		state = stateFor(plan, false)
	assert.equal(
		assertCrmCommerceProgress(f.live, f.baseline, plan, state).recovery,
		'PRE_ADMISSION'
	)
	Object.assign(state, stateFor(plan))
	for (let i = 0; i < CRM_COMMERCE_TARGETS.length; i++) {
		state.switching = CRM_COMMERCE_TARGETS[i]
		const row = f.live[i]
		row.State.Running = false
		row.State.Pid = 0
		assert.equal(
			assertCrmCommerceProgress(f.live, f.baseline, plan, state).recovery,
			'FORWARD_ONLY'
		)
		assert.equal(
			assertCrmCommerceProgress(
				f.live.filter(item => item !== row),
				f.baseline,
				plan,
				state
			).next,
			CRM_COMMERCE_TARGETS[i]
		)
		const replaced = activate(f, plan, state, i, false)
		replaced.State.Running = true
		replaced.State.Health.Status = 'starting'
		assert.equal(
			assertCrmCommerceProgress(f.live, f.baseline, plan, state).complete,
			false
		)
		replaced.State.Health.Status = 'healthy'
		activate(f, plan, state, i)
		assert.equal(
			assertCrmCommerceProgress(f.live, f.baseline, plan, state).complete,
			i === 6
		)
	}
	assert.equal(
		assertCrmCommerceProgress(f.live, f.baseline, plan, state).next,
		null
	)
	const replay = structuredClone(state)
	assert.deepEqual(
		assertCrmCommerceProgress(f.live, f.baseline, plan, replay),
		{ complete: true, next: null, recovery: 'FORWARD_ONLY' }
	)
})

test('runtime rejects skipped groups, missing marker, rollback, double recreation and unknown state without exposing secrets', () => {
	for (const [name, mutate] of [
		[
			'missing admission',
			(f, p, s) => {
				activate(f, p, s, 0)
				s.admission = null
			}
		],
		['wrong plan', (f, p, s) => (s.admission.planSha256 = hash)],
		[
			'skip to Billing',
			(f, p, s) => (s.switching = CRM_COMMERCE_TARGETS[4])
		],
		['completed suffix', (f, p, s) => activate(f, p, s, 4)],
		['lost target', f => f.live.shift()],
		['neighbor restart', f => f.live.at(-1).RestartCount++],
		['unknown stopped target', f => (f.live[0].State.Running = false)],
		[
			'old ID restarted',
			f => (f.live[0].State.StartedAt = '2026-09-07T21:00:00Z')
		],
		[
			'changed activated env',
			(f, p, s) => {
				activate(f, p, s, 0)
				f.live[0].Config.Env.push('FOREIGN=true')
			}
		],
		[
			'old env rollback',
			(f, p, s) => {
				activate(f, p, s, 0)
				f.live[0].Config.Env = f.live[0].Config.Env.filter(
					entry => !entry.startsWith('CRM_CUSTOMERS_DADATA_API_KEY=')
				)
			}
		],
		[
			'new ID replaced again',
			(f, p, s) => {
				activate(f, p, s, 0)
				f.live[0].Id = id(888)
			}
		],
		[
			'new ID restarted',
			(f, p, s) => {
				activate(f, p, s, 0)
				f.live[0].State.StartedAt = '2026-09-07T21:01:00Z'
			}
		],
		[
			'unhealthy completion',
			(f, p, s) => {
				activate(f, p, s, 0)
				f.live[0].State.Health.Status = 'unhealthy'
			}
		],
		[
			'tampered desired plan',
			(f, p) =>
				(p.desired.winwidget.services[
					'billing-api'
				].environment.SYNTHETIC_SECRET = 'changed')
		]
	]) {
		const f = fixture(),
			plan = planFor(f),
			state = stateFor(plan)
		mutate(f, plan, state)
		assert.throws(
			() => assertCrmCommerceProgress(f.live, f.baseline, plan, state),
			suppressed,
			name
		)
	}
})

function databaseProof() {
	const owners = {}
	for (const [i, owner] of [
		'billing',
		'crm-access',
		'crm-customers'
	].entries()) {
		const schema = owner.replaceAll('-', '_')
		owners[owner] = {
			databaseId: `11111111-1111-4111-8111-${String(i + 1).padStart(12, '0')}`,
			database: `winwidget_${schema}`,
			schema,
			serviceName: `${owner}-service`,
			principal: `winwidget_${schema}_migration`,
			readOnly: true,
			recovery: false,
			postgresVersion: 180003,
			sourceSha256: hash,
			ledgerSha256: hash,
			rolesSha256: hash,
			aclSha256: hash,
			pendingMigrations: 0
		}
	}
	return {
		schemaVersion: 1,
		checkedAt: new Date(now).toISOString(),
		owners,
		counts: {
			orders: 0,
			renewals: 0,
			providerOperations: 0,
			paidPeriods: 0,
			dueRenewals: 0,
			pendingProviderDeliveries: 0,
			unpublishedProviderOutbox: 0,
			accessOperations: 0,
			accessCapacityFences: 0
		}
	}
}
test('read-only preflight requires fresh exact owner/schema/ledger/ACL proofs and zero demand, never authorizes a write', () => {
	const before = databaseProof()
	assert.equal(
		assertCrmCommerceDatabaseProof(before, structuredClone(before), now),
		true
	)
	for (const [name, mutate] of [
		['foreign owner', p => (p.owners.billing.database = 'foreign')],
		['foreign schema', p => (p.owners.billing.schema = 'foreign')],
		[
			'foreign identity',
			p => (p.owners.billing.serviceName = 'foreign-service')
		],
		['replica', p => (p.owners.billing.recovery = true)],
		[
			'runtime principal',
			p => (p.owners.billing.principal = 'winwidget_billing_runtime')
		],
		['writable transaction', p => (p.owners.billing.readOnly = false)],
		['old PostgreSQL', p => (p.owners.billing.postgresVersion = 170009)],
		[
			'new UUID',
			p =>
				(p.owners.billing.databaseId =
					'22222222-2222-4222-8222-222222222222')
		],
		['pending migration', p => (p.owners.billing.pendingMigrations = 1)],
		['missing owner', p => delete p.owners['crm-customers']],
		[
			'source changed',
			p => (p.owners.billing.sourceSha256 = 'd'.repeat(64))
		],
		[
			'ledger changed',
			p => (p.owners.billing.ledgerSha256 = 'd'.repeat(64))
		],
		[
			'roles changed',
			p => (p.owners.billing.rolesSha256 = 'd'.repeat(64))
		],
		['ACL changed', p => (p.owners.billing.aclSha256 = 'd'.repeat(64))],
		[
			'stale proof',
			p => (p.checkedAt = new Date(now - 60001).toISOString())
		],
		['future proof', p => (p.checkedAt = new Date(now + 1).toISOString())],
		...Object.keys(before.counts).map(key => [
			`nonzero ${key}`,
			p => (p.counts[key] = 1)
		]),
		['missing count', p => delete p.counts.orders],
		['string count', p => (p.counts.orders = '0')]
	]) {
		const after = structuredClone(before)
		mutate(after)
		assert.throws(
			() => assertCrmCommerceDatabaseProof(before, after, now),
			suppressed,
			name
		)
	}
	const afterAdmission = structuredClone(before)
	afterAdmission.counts.orders = 1
	assert.equal(
		assertCrmCommerceDatabaseProof(before, afterAdmission, now, false),
		true
	)
})
