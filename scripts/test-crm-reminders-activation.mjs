import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'
import {
	CRM_REMINDERS_TARGETS as targets,
	crmRemindersBaseline,
	prepareCrmRemindersActivation,
	crmRemindersPlanDigest,
	assertCrmRemindersProgress
} from './crm-reminders-activation.mjs'
import {
	remindersTransition,
	reminderOverlaySources
} from './crm-reminders-activation-cli.mjs'
import { crmReminderNotificationTopology } from './crm-reminders-broker-topology.mjs'

const revision = 'a'.repeat(40),
	hash = 'b'.repeat(64)
const id = n => n.toString(16).padStart(64, '0')
const keyOf = row =>
	row.Config.Labels['com.docker.compose.project'] +
	'/' +
	row.Config.Labels['com.docker.compose.service']
const tokens = {
	CRM_SALES_NOTIFICATION_DELIVERY_TOKEN: 'd'.repeat(64),
	NOTIFICATION_DELIVERY_CRM_SALES_TOKEN: 'e'.repeat(64)
}
const envList = env =>
	Object.entries(env).map(([key, value]) => key + '=' + value)
function rowFor(project, name, service, image, number) {
	const seconds = value => Number(value.slice(0, -1))
	return {
		Id: id(number),
		Name: '/' + project + '-' + name + '-1',
		Image: image.Id,
		Config: {
			...structuredClone(image.Config),
			Image: image.Id,
			Hostname: id(number).slice(0, 12),
			User: service.user,
			Cmd: service.command ?? image.Config.Cmd,
			Env: envList({
				...Object.fromEntries(
					image.Config.Env.map(value => value.split('='))
				),
				...service.environment
			}),
			StopTimeout: seconds(service.stop_grace_period),
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
				Interval: seconds(service.healthcheck.interval) * 1e9,
				Timeout: seconds(service.healthcheck.timeout) * 1e9,
				StartPeriod: seconds(service.healthcheck.start_period) * 1e9,
				Retries: service.healthcheck.retries
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
			Memory: service.mem_limit,
			MemoryReservation: service.mem_reservation ?? 0,
			MemorySwap: service.memswap_limit ?? service.mem_limit * 2,
			NanoCpus: service.cpus * 1e9,
			PidsLimit: service.pids_limit,
			LogConfig: {
				Type: service.logging.driver,
				Config: service.logging.options
			},
			ExtraHosts: [],
			Tmpfs: Object.fromEntries(
				(service.tmpfs ?? []).map(value => [
					value.slice(0, value.indexOf(':')),
					value.slice(value.indexOf(':') + 1)
				])
			),
			Devices: [],
			DeviceRequests: [],
			PortBindings: {}
		},
		Mounts: [],
		NetworkSettings: {},
		RestartCount: 0,
		State: {
			Running: true,
			Pid: number,
			Paused: false,
			Restarting: false,
			OOMKilled: false,
			Dead: false,
			StartedAt: '2026-09-07T21:00:00.000Z',
			Health: { Status: 'healthy' }
		}
	}
}
function fixture() {
	const kinds = crmReminderNotificationTopology()
		.readRoutingKeys.filter((_, index) => index % 3 === 1)
		.map(key => key.slice(7))
	const images = ['notification-delivery', 'crm-sales'].map(
		(owner, index) => ({
			Id: 'sha256:' + id(index + 1),
			Os: 'linux',
			Architecture: 'amd64',
			Config: {
				Env: ['NODE_ENV=production'],
				User: index === 0 ? '1000' : '1001',
				WorkingDir: '/app',
				Cmd: ['node', 'dist/src/main.js'],
				Entrypoint: ['docker-entrypoint.sh'],
				Labels: {
					'org.opencontainers.image.revision': revision,
					...(index
						? { 'org.opencontainers.image.title': 'winwidget-crm-sales' }
						: {})
				}
			}
		})
	)
	const base = image => ({
		image: image.Id,
		environment: { NODE_ENV: 'production', APP_REVISION: revision },
		network_mode: 'host',
		user: image.Config.User,
		read_only: true,
		cap_drop: ['ALL'],
		security_opt: ['no-new-privileges:true'],
		restart: 'unless-stopped',
		mem_limit: 268435456,
		cpus: 0.5,
		pids_limit: 128,
		init: true,
		logging: {
			driver: 'json-file',
			options: { 'max-size': '10m', 'max-file': '3' }
		},
		healthcheck: {
			test: ['CMD', 'node', 'health.js'],
			interval: '10s',
			timeout: '3s',
			start_period: '45s',
			retries: 6
		},
		stop_grace_period: '45s',
		labels: {}
	})
	const notification = base(images[0]),
		api = { ...base(images[1]), memswap_limit: 268435456 }
	notification.environment.NOTIFICATION_DELIVERY_KINDS = kinds
		.slice(0, 12)
		.join(',')
	notification.environment.NOTIFICATION_DELIVERY_DATABASE_URL =
		'postgresql://winwidget_notification_delivery_runtime:synthetic@127.0.0.1:55433/winwidget_notification_delivery?schema=notification_delivery&sslmode=disable'
	Object.assign(api.environment, {
		CRM_SALES_DATABASE_URL:
			'postgresql://winwidget_crm_sales_runtime:synthetic@127.0.0.1:55445/winwidget_crm_sales?schema=crm_sales&sslmode=disable&connection_limit=12&pool_timeout=10',
		CRM_ACCESS_INTERNAL_BASE_URL: 'http://127.0.0.1:5300',
		CRM_ACCESS_CRM_SALES_TOKEN: 'c'.repeat(64)
	})
	const crmBefore = {
			name: 'winwidget-crm',
			services: { 'crm-sales-api': api }
		},
		notificationBefore = {
			name: 'winwidget',
			services: { 'notification-delivery-worker': notification }
		}
	const crmAfter = structuredClone(crmBefore),
		notificationAfter = structuredClone(notificationBefore)
	Object.assign(crmAfter.services['crm-sales-api'].environment, tokens, {
		CRM_TASK_REMINDERS_ENABLED: 'true',
		NOTIFICATION_DELIVERY_INTERNAL_BASE_URL: 'http://127.0.0.1:4401'
	})
	Object.assign(
		notificationAfter.services['notification-delivery-worker'].environment,
		tokens,
		{
			CRM_SALES_INTERNAL_BASE_URL: 'http://127.0.0.1:5330',
			NOTIFICATION_DELIVERY_KINDS: kinds.join(',')
		}
	)
	crmAfter.services['crm-sales-reminders'] = {
		...structuredClone(api),
		profiles: ['crm-reminders'],
		command: ['node', 'dist/src/main-reminders.js'],
		user: '1001:1001',
		tmpfs: ['/tmp:rw,nosuid,nodev,noexec,size=64m'],
		labels: {
			'com.winwidget.owner': 'crm-sales',
			'com.winwidget.purpose': 'reminders',
			'com.winwidget.singleton': 'true'
		},
		environment: {
			NODE_ENV: 'production',
			MODE: 'production',
			APP_REVISION: revision,
			CRM_SALES_PROCESS_ROLE: 'reminders',
			CRM_SALES_REMINDERS_PORT: '5331',
			CRM_TASK_REMINDERS_ENABLED: 'true',
			CRM_SALES_DATABASE_URL:
				api.environment.CRM_SALES_DATABASE_URL.replace(
					'connection_limit=12',
					'connection_limit=4'
				),
			CRM_ACCESS_INTERNAL_BASE_URL:
				api.environment.CRM_ACCESS_INTERNAL_BASE_URL,
			CRM_ACCESS_CRM_SALES_TOKEN:
				api.environment.CRM_ACCESS_CRM_SALES_TOKEN,
			...tokens,
			NOTIFICATION_DELIVERY_INTERNAL_BASE_URL: 'http://127.0.0.1:4401',
			RABBITMQ_URL:
				'amqp://winwidget-crm-sales-reminders:' +
				'f'.repeat(64) +
				'@127.0.0.1:5672/winwidget',
			RABBITMQ_CONNECTION_NAME: 'winwidget-crm-sales-reminders'
		},
		healthcheck: {
			...api.healthcheck,
			test: [
				'CMD',
				'node',
				'-e',
				"fetch('http://127.0.0.1:5331/health/ready',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
			]
		}
	}
	const live = [
		rowFor(
			'winwidget',
			'notification-delivery-worker',
			notification,
			images[0],
			20
		),
		rowFor('winwidget-crm', 'crm-sales-api', api, images[1], 21),
		rowFor('winwidget', 'api-gateway', base(images[0]), images[0], 22)
	]
	const environmentHashes = {
		canonical: hash,
		crm: hash,
		'notification-delivery': hash
	}
	return {
		live,
		images,
		configs: {
			crmBefore,
			crmAfter,
			notificationBefore,
			notificationAfter
		},
		environmentHashes,
		baseline: crmRemindersBaseline(live, revision, environmentHashes)
	}
}
const validator = configs => {
	assert.equal(
		configs.crmAfter.services['crm-sales-api'].environment
			.CRM_TASK_REMINDERS_ENABLED,
		'true'
	)
	assert.equal(
		configs.crmBefore.services['crm-sales-reminders'],
		undefined
	)
}
const planFor = f => prepareCrmRemindersActivation(f, validator)
const stateFor = plan => ({
	admission: {
		schemaVersion: 1,
		kind: plan.kind + '.admission',
		planSha256: crmRemindersPlanDigest(plan)
	},
	completed: {},
	switching: null
})
function replace(f, plan, index) {
	const [project, name] = targets[index].split('/'),
		image = f.images.find(
			image => image.Id === plan.targets[targets[index]].image
		)
	const row = rowFor(
		project,
		name,
		plan.desired[project].services[name],
		image,
		100 + index
	)
	row.State.StartedAt = '2026-09-07T22:00:00.000Z'
	const previous = f.live.findIndex(item => keyOf(item) === targets[index])
	if (previous >= 0) f.live.splice(previous, 1, row)
	else f.live.push(row)
	return row
}

test('baseline records new worker absence and only ND/Sales immutable targets; hash binding is strict', () => {
	const f = fixture(),
		plan = planFor(f)
	assert.equal(f.baseline.targets[targets[1]].absent, true)
	assert.equal(f.baseline.targets[targets[1]].id, undefined)
	assert.equal(
		plan.targets[targets[1]].image,
		f.baseline.targets[targets[2]].image
	)
	assert.deepEqual(Object.keys(plan.desired.winwidget.services), [
		'notification-delivery-worker'
	])
	assert.deepEqual(Object.keys(plan.desired['winwidget-crm'].services), [
		'crm-sales-reminders',
		'crm-sales-api'
	])
	assert.equal(
		plan.desired['winwidget-crm'].services['crm-sales-reminders'].profiles,
		undefined
	)
	assert.throws(() =>
		prepareCrmRemindersActivation(
			{
				...f,
				environmentHashes: { ...f.environmentHashes, crm: 'c'.repeat(64) }
			},
			validator
		)
	)
	replace(f, plan, 1)
	assert.throws(() =>
		crmRemindersBaseline(f.live, revision, f.environmentHashes)
	)
})
test('baseline bytes and plan hashes do not depend on caller environment key ordering', () => {
	const f = fixture()
	const expected = {
		canonical: 'a'.repeat(64),
		crm: 'b'.repeat(64),
		'notification-delivery': 'c'.repeat(64)
	}
	const permutations = keys =>
		keys.length
			? keys.flatMap(key =>
					permutations(keys.filter(value => value !== key)).map(tail => [
						key,
						...tail
					])
				)
			: [[]]
	let baselineBytes, planBytes
	for (const order of permutations(Object.keys(expected))) {
		const environmentHashes = Object.fromEntries(
				order.map(key => [key, expected[key]])
			),
			original = JSON.stringify(environmentHashes)
		const baseline = crmRemindersBaseline(
			f.live,
			revision,
			environmentHashes
		)
		const plan = prepareCrmRemindersActivation(
			{ ...f, baseline, environmentHashes },
			validator
		)
		baselineBytes ??= JSON.stringify(baseline)
		planBytes ??= JSON.stringify(plan)
		assert.equal(JSON.stringify(baseline), baselineBytes)
		assert.equal(JSON.stringify(plan), planBytes)
		assert.equal(JSON.stringify(environmentHashes), original)
	}
})
test('prepared source changes only explicitly approved before-fields; other drift remains visible', () => {
	const f = fixture(),
		configs = structuredClone(f.configs)
	configs.notificationBefore.services[
		'notification-delivery-worker'
	].environment = structuredClone(
		configs.notificationAfter.services['notification-delivery-worker']
			.environment
	)
	const normalized = reminderOverlaySources(configs, f.live)
	assert.deepEqual(normalized, f.configs)
	configs.notificationBefore.services[
		'notification-delivery-worker'
	].environment.UNAPPROVED = 'synthetic-private'
	assert.throws(
		() =>
			prepareCrmRemindersActivation(
				{ ...f, configs: reminderOverlaySources(configs, f.live) },
				validator
			),
		error => !error.message.includes('synthetic-private')
	)
})
test('validator required, before flag stays disabled and image/config/neighbor drifts fail closed', () => {
	for (const mutate of [
		f => {
			f.images[1].Id = 'sha256:' + id(500)
		},
		f => {
			f.configs.crmBefore.services[
				'crm-sales-api'
			].environment.CRM_TASK_REMINDERS_ENABLED = 'true'
		},
		f => {
			f.configs.crmAfter.services['crm-sales-api'].cpus = 2
		},
		f => {
			f.live[2].State.StartedAt = '2026-09-07T23:00:00Z'
		},
		f => {
			f.configs.notificationAfter.services[
				'notification-delivery-worker'
			].image = 'latest'
		},
		f => {
			f.live.push(structuredClone(f.live[0]))
		}
	]) {
		const f = fixture()
		mutate(f)
		assert.throws(() => planFor(f), /private details suppressed/)
	}
	assert.throws(() => prepareCrmRemindersActivation(fixture(), undefined))
})
test('three ordered transitions preserve all images; new worker has no stop ID', () => {
	const f = fixture(),
		plan = planFor(f)
	let state = stateFor(plan)
	for (let index = 0; index < 3; index++) {
		const input = () => ({
			live: f.live,
			baseline: f.baseline,
			plan,
			state,
			marker: state.admission
		})
		assert.equal(
			remindersTransition(input(), 'progress').next,
			targets[index]
		)
		state = remindersTransition(input(), 'begin')
		const old = f.live.find(row => keyOf(row) === targets[index])
		if (old) {
			old.State.Running = false
			old.State.Pid = 0
		}
		const started = remindersTransition(input(), 'start')
		assert.throws(() =>
			remindersTransition({ ...input(), started }, 'start')
		)
		const row = replace(f, plan, index),
			observed = remindersTransition({ ...input(), started }, 'observe')
		assert.equal(observed.id, row.Id)
		state = remindersTransition(
			{ ...input(), started, observed },
			'complete'
		)
	}
	assert.equal(
		assertCrmRemindersProgress(f.live, f.baseline, plan, state).complete,
		true
	)
	assert.equal(f.live[2].Id, id(22))
})
test('unknown create outcome never authorizes another start; observed/restarted identity cannot be adopted', () => {
	const f = fixture(),
		plan = planFor(f)
	let state = stateFor(plan)
	const input = () => ({
		live: f.live,
		baseline: f.baseline,
		plan,
		state,
		marker: state.admission
	})
	state = remindersTransition(input(), 'begin')
	f.live[0].State.Running = false
	f.live[0].State.Pid = 0
	const started = remindersTransition(input(), 'start')
	f.live.splice(0, 1)
	assert.throws(() =>
		remindersTransition({ ...input(), started }, 'start')
	)
	assert.throws(() =>
		remindersTransition({ ...input(), started }, 'observe')
	)
	const row = replace(f, plan, 0),
		observed = remindersTransition({ ...input(), started }, 'observe')
	row.Id = id(999)
	assert.throws(() =>
		remindersTransition({ ...input(), started, observed }, 'complete')
	)
	row.Id = observed.id
	row.RestartCount = 1
	assert.throws(() =>
		remindersTransition({ ...input(), started, observed }, 'complete')
	)
})
test('new worker only appears at its ordered switching step and rejects host/container privilege drift', () => {
	const f = fixture(),
		plan = planFor(f),
		state = stateFor(plan)
	replace(f, plan, 1)
	assert.throws(() =>
		assertCrmRemindersProgress(f.live, f.baseline, plan, state)
	)
	const nd = replace(f, plan, 0)
	state.completed[targets[0]] = {
		id: nd.Id,
		startedAt: nd.State.StartedAt
	}
	state.switching = targets[1]
	assert.doesNotThrow(() =>
		assertCrmRemindersProgress(f.live, f.baseline, plan, state)
	)
	const worker = f.live.find(row => keyOf(row) === targets[1])
	worker.HostConfig.Devices = [{ PathOnHost: '/dev/private' }]
	assert.throws(() =>
		assertCrmRemindersProgress(f.live, f.baseline, plan, state)
	)
})
const validatorPath = new URL(
	'../../winwidget.ru_services/.github/scripts/validate-crm-reminders-compose.mjs',
	import.meta.url
)
test(
	'actual Services overlay validator accepts the pinned isolated three-target plan',
	{ skip: !existsSync(validatorPath) },
	async () => {
		const { validateCrmReminderDeployment } = await import(
			validatorPath.href
		)
		assert.doesNotThrow(() =>
			prepareCrmRemindersActivation(
				fixture(),
				validateCrmReminderDeployment
			)
		)
	}
)
