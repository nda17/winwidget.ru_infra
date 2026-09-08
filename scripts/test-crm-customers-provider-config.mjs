import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
	PROVIDER_TARGET,
	PROVIDER_KEY,
	PROVIDER_PAYLOAD_FILES,
	customersProviderBaseline,
	prepareCustomersProvider,
	customersProviderTransition,
	validateProviderPayload
} from './crm-customers-provider-config.mjs'

const revision = 'a'.repeat(40),
	hash = 'b'.repeat(64),
	key = 'c'.repeat(40)
const id = value => value.toString(16).padStart(64, '0')
const env = value =>
	Object.entries(value).map(([key, value]) => `${key}=${value}`)
const shell = readFileSync(
	new URL('./deploy-crm-customers-provider-scoped.sh', import.meta.url),
	'utf8'
)
const router = readFileSync(
	new URL('./deploy-services-production.sh', import.meta.url),
	'utf8'
)
function fixture() {
	const image = {
		Id: `sha256:${id(1)}`,
		Os: 'linux',
		Architecture: 'amd64',
		Config: {
			Env: ['NODE_ENV=production'],
			User: '1001',
			WorkingDir: '/app',
			Cmd: ['node', 'dist/src/main.js'],
			Entrypoint: ['docker-entrypoint.sh'],
			Labels: {
				'org.opencontainers.image.title': 'winwidget-crm-customers',
				'org.opencontainers.image.revision': revision
			}
		}
	}
	const before = {
		NODE_ENV: 'production',
		APP_REVISION: revision,
		DATABASE_URL: 'synthetic-private-db-url',
		[PROVIDER_KEY]: ''
	}
	const service = {
		image: image.Id,
		environment: { ...before, [PROVIDER_KEY]: key },
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
		labels: { 'com.winwidget.owner': 'crm-customers' }
	}
	const row = {
		Id: id(20),
		Image: image.Id,
		Name: '/winwidget-crm-crm-customers-api-1',
		Config: {
			...structuredClone(image.Config),
			Hostname: 'old-host',
			Image: image.Id,
			Env: env(before),
			StopTimeout: 30,
			Labels: {
				...image.Config.Labels,
				...service.labels,
				'com.docker.compose.project': 'winwidget-crm',
				'com.docker.compose.service': 'crm-customers-api',
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
			Memory: service.mem_limit,
			MemoryReservation: service.mem_reservation,
			MemorySwap: service.memswap_limit,
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
			Pid: 120,
			Paused: false,
			Restarting: false,
			OOMKilled: false,
			Dead: false,
			StartedAt: '2026-09-08T10:00:00Z',
			Health: { Status: 'healthy' }
		}
	}
	const gateway = structuredClone(row)
	gateway.Id = id(21)
	gateway.Name = '/winwidget-api-gateway-1'
	gateway.Config.Labels['com.docker.compose.project'] = 'winwidget'
	gateway.Config.Labels['com.docker.compose.service'] = 'api-gateway'
	const database = structuredClone(gateway)
	database.Id = id(22)
	database.Name = '/winwidget-crm-customers-postgres-1'
	database.Config.Labels['com.docker.compose.service'] =
		'crm-customers-postgres'
	const live = [row, gateway, database],
		hashes = { canonical: hash, crm: hash }
	return {
		live,
		image,
		hashes,
		config: {
			name: 'winwidget-crm',
			services: { 'crm-customers-api': service }
		},
		baseline: customersProviderBaseline(live, revision, hashes)
	}
}
const suppressed = error =>
	error.message ===
	'CRM Customers provider configuration rejected; private details suppressed'
test('public baseline is canonical IDs/hashes; plan changes only the key in one existing API', () => {
	const f = fixture(),
		plan = prepareCustomersProvider(f)
	assert.equal(PROVIDER_TARGET, 'winwidget-crm/crm-customers-api')
	assert.deepEqual(Object.keys(plan.desired.services), [
		'crm-customers-api'
	])
	assert.equal(
		plan.desired.services['crm-customers-api'].image,
		f.image.Id
	)
	assert.equal(
		plan.desired.services['crm-customers-api'].environment[PROVIDER_KEY],
		key
	)
	assert.equal(JSON.stringify(f.baseline).includes(key), false)
	assert.equal(
		JSON.stringify(f.baseline).includes('synthetic-private-db-url'),
		false
	)
	assert.equal(
		JSON.stringify(
			customersProviderBaseline(f.live, revision, {
				crm: hash,
				canonical: hash
			})
		),
		JSON.stringify(f.baseline)
	)
})
test('preflight rejects rotation, missing old declaration, neighbors, image, authority, resources and every non-key env drift', () => {
	for (const mutate of [
		f => {
			f.live[0].Config.Env = f.live[0].Config.Env.filter(
				value => !value.startsWith(PROVIDER_KEY + '=')
			)
		},
		f => {
			f.live[0].Config.Env.push('APP_REVISION=duplicate')
		},
		f => {
			f.live[0].Config.Env = f.live[0].Config.Env.map(value =>
				value.startsWith(PROVIDER_KEY + '=')
					? PROVIDER_KEY + '=' + key
					: value
			)
		},
		f => {
			f.live[1].Id = id(100)
		},
		f => {
			f.image.Id = `sha256:${id(999)}`
		},
		f => {
			f.image.Config.Env.push(PROVIDER_KEY + '=' + key)
		},
		f => {
			f.config.services['crm-customers-api'].environment.DATABASE_URL +=
				'changed'
		},
		f => {
			f.config.services['crm-customers-api'].environment.NEW_FLAG = 'true'
		},
		f => {
			f.config.services['crm-customers-api'].environment[PROVIDER_KEY] = ''
		},
		f => {
			f.config.services['crm-customers-api'].environment[PROVIDER_KEY] =
				'invalid-token'
		},
		f => {
			f.config.services['crm-customers-api'].memswap_limit = 0
		},
		f => {
			f.config.services['crm-customers-api'].ports = [
				{ target: 80, published: '80' }
			]
		},
		f => {
			f.config.services['crm-customers-api'].security_opt = []
		},
		f => {
			f.config.services['crm-customers-api'].volumes = [
				{ type: 'bind', source: '/secret', target: '/secret' }
			]
		},
		f => {
			f.config.services['crm-customers-api'].working_dir = '/other'
		},
		f => {
			f.config.services['crm-customers-api'].healthcheck.test = [
				'CMD',
				'true'
			]
		},
		f => {
			f.config.services.other = { environment: { [PROVIDER_KEY]: key } }
		},
		f => {
			f.hashes.crm = 'd'.repeat(64)
		}
	]) {
		const f = fixture()
		mutate(f)
		assert.throws(() => prepareCustomersProvider(f), suppressed)
	}
})
function transitionFixture() {
	const f = fixture(),
		plan = prepareCustomersProvider(f)
	return { ...f, plan }
}
function reachStart(f) {
	f.admission = customersProviderTransition(f, 'admit')
	f.switching = customersProviderTransition(f, 'begin')
	f.live[0].State.Running = false
	f.live[0].State.Pid = 0
	f.started = customersProviderTransition(f, 'start')
}
function replacement(f) {
	const row = f.live[0]
	row.Id = id(100)
	row.Config.Hostname = 'new-host'
	row.Config.Labels['com.docker.compose.config-hash'] = 'd'.repeat(64)
	row.Config.Env = env(
		f.plan.desired.services['crm-customers-api'].environment
	)
	row.State.StartedAt = '2026-09-08T11:00:00Z'
	row.State.Running = true
	row.State.Pid = 220
}
test('write-once transitions allow observation-only recovery and require healthy exact replacement', () => {
	const f = transitionFixture()
	assert.throws(() => customersProviderTransition(f, 'start'), suppressed)
	reachStart(f)
	assert.throws(() => customersProviderTransition(f, 'start'), suppressed)
	assert.throws(() => customersProviderTransition(f, 'begin'), suppressed)
	assert.throws(
		() => customersProviderTransition(f, 'observe'),
		suppressed
	)
	replacement(f)
	f.observed = customersProviderTransition(f, 'observe')
	f.live[0].State.Health.Status = 'starting'
	assert.throws(
		() => customersProviderTransition(f, 'complete'),
		suppressed
	)
	f.live[0].State.Health.Status = 'healthy'
	f.completed = customersProviderTransition(f, 'complete')
	assert.deepEqual(customersProviderTransition(f, 'progress'), {
		complete: true
	})
	for (const mutate of [
		value => {
			value.live[0].Id = id(101)
		},
		value => {
			value.live[0].RestartCount++
		},
		value => {
			value.live[0].State.StartedAt = '2026-09-08T12:00:00Z'
		},
		value => {
			value.live[0].Config.Env.push('NEW_KEY=changed')
		},
		value => {
			value.live[2].Id = id(102)
		},
		value => {
			value.live[1].HostConfig.Privileged = true
		},
		value => {
			value.started = null
		}
	]) {
		const changed = structuredClone(f)
		mutate(changed)
		assert.throws(
			() => customersProviderTransition(changed, 'progress'),
			suppressed
		)
	}
})
test('absent target is accepted only after sealed switching; no implicit retry/rollback or premature success', () => {
	const f = transitionFixture()
	f.live.shift()
	assert.throws(
		() => customersProviderTransition(f, 'progress'),
		suppressed
	)
	const g = transitionFixture()
	reachStart(g)
	g.live.shift()
	assert.deepEqual(customersProviderTransition(g, 'progress'), {
		complete: false
	})
	assert.throws(
		() => customersProviderTransition(g, 'complete'),
		suppressed
	)
	assert.throws(() => customersProviderTransition(g, 'start'), suppressed)
})
test('payload is tracked-name/hash bounded, network-isolated and within existing activation SSH budget', () => {
	const pack = spawnSync(
		process.execPath,
		[
			new URL('./crm-customers-provider-config.mjs', import.meta.url)
				.pathname,
			'pack'
		],
		{ encoding: 'utf8' }
	)
	assert.equal(pack.status, 0, pack.stderr)
	assert.deepEqual(
		validateProviderPayload(pack.stdout).map(row => row.name),
		PROVIDER_PAYLOAD_FILES
	)
	const boundary = JSON.parse(pack.stdout)
	boundary.files[0].content = 'x'.repeat(147456)
	boundary.files[0].sha256 = createHash('sha256')
		.update(boundary.files[0].content)
		.digest('hex')
	assert.equal(
		validateProviderPayload(JSON.stringify(boundary)).length,
		PROVIDER_PAYLOAD_FILES.length
	)
	assert.ok(
		gzipSync(pack.stdout).toString('base64').length +
			gzipSync(shell).toString('base64').length <=
			112000
	)
	for (const mutate of [
		value => {
			value.files[0].name = '../escape'
		},
		value => {
			value.files.push(value.files[0])
		},
		value => {
			value.files[0].content += 'changed'
		},
		value => {
			value.files[0].content = 'x'.repeat(147457)
			value.files[0].sha256 = createHash('sha256')
				.update(value.files[0].content)
				.digest('hex')
		}
	]) {
		const value = JSON.parse(pack.stdout)
		mutate(value)
		assert.throws(() => validateProviderPayload(JSON.stringify(value)))
	}
	assert.throws(() => validateProviderPayload('x'.repeat(524289)))
	assert.equal(spawnSync('/bin/bash', ['-n'], { input: shell }).status, 0)
	assert.doesNotMatch(
		shell,
		/docker (build|start|restart)|prisma migrate|pg_dump|curl /
	)
	assert.match(shell, /--network none --read-only --log-driver none/)
	assert.match(
		shell,
		/--no-build --pull never --no-deps --force-recreate crm-customers-api/
	)
	assert.match(
		router,
		/expected_crm_customers_provider_baseline_sha256="\$\{23:-\}"/
	)
})

test('actual router requires provider-only approval and keeps the new argument isolated at position 23', () => {
	const guard = router.slice(
		router.indexOf(
			'if [[ "$release_scope" == crm-customers-provider-config ]]; then'
		),
		router.indexOf(
			'if [[ "$release_scope" == operations-backup-runtime ]]; then'
		)
	)
	const run = (scope, baseline) =>
		spawnSync('/bin/bash', ['-s'], {
			encoding: 'utf8',
			input: `set -euo pipefail\ndie(){ exit 31; }\nrelease_scope=${scope}\nexpected_crm_customers_provider_baseline_sha256='${baseline}'\n${guard}`
		})
	assert.equal(run('crm-customers-provider-config', hash).status, 0)
	assert.equal(run('crm-customers-provider-config', '').status, 31)
	assert.equal(run('crm-customers-provider-config', revision).status, 31)
	for (const other of [
		'all',
		'crm-commerce-activate',
		'crm-upgrade',
		'crm-reminders-activate',
		'operations-backup-runtime'
	]) {
		assert.equal(run(other, hash).status, 31)
		assert.equal(run(other, '').status, 0)
	}
	assert.match(
		router,
		/expected_crm_customers_provider_baseline_sha256="\$\{23:-\}"/
	)
	assert.match(
		router,
		/remote_controller_arguments.*'' '' "\$expected_crm_customers_provider_baseline_sha256"/
	)
	assert.match(router, /local encoded="\$1" destination="\$2" size limit=131072/)
	assert.match(router, /head -c "\$\(\(limit \+ 1\)\)"/)
	assert.match(router, /scoped_shell_base64.*scoped_node_base64.*<= 90000/)
})

function loopHarness(
	temp,
	{
		unknown = false,
		missing = false,
		syncFailure = false,
		stopFailure = false
	} = {}
) {
	const publication = shell.slice(
		shell.indexOf('provider_publish()'),
		shell.indexOf('\nprovider_inventory()')
	)
	const loop = shell.slice(
		shell.indexOf(
			'\tif [[ ! -e "$provider_directory/admission.json" ]]; then'
		),
		shell.indexOf("\tprovider_fence || die 'Final provider")
	)
	return spawnSync('/bin/bash', ['-s'], {
		encoding: 'utf8',
		input: `set -euo pipefail
umask 077
provider_directory='${temp}'
die(){ printf '%s\\n' "$1" >&2; exit 1; }
provider_private(){ [[ -f "$1" && ! -L "$1" ]]; }
sync(){ if [[ "$2" == "$provider_directory/admission.json" && '${syncFailure}' == true ]]; then return 1; fi; }
mv(){ if [[ "$1" == -T ]]; then shift; fi; command mv "$@"; }
provider_fence(){ return 0; }
provider_inputs(){ return 0; }
provider_probe(){ case "$1" in admit|begin|start) printf '{}';; target-id) printf '${id(20)}';; observe) [[ '${missing}' != true ]] || return 1; printf '{}';; complete) printf '{}';; *) return 1;; esac; }
docker(){ if [[ "$1" == ps ]]; then printf '${id(20)}'; else printf '%s\\n' "$*" >>"$provider_directory/actions"; [[ '${stopFailure}' != true ]]; fi; }
provider_compose(){ printf 'compose\\n' >>"$provider_directory/actions"; [[ '${unknown}' != true ]]; }
sleep(){ return 0; }
${publication}
${loop}
`
	})
}
test('actual shell unknown create resumes by observation without a second stop/create', () => {
	const temp = mkdtempSync(join(tmpdir(), 'crm-provider-loop-'))
	try {
		const failed = loopHarness(temp, { unknown: true })
		assert.equal(failed.status, 1)
		assert.match(failed.stderr, /outcome is unknown/)
		assert.ok(existsSync(join(temp, 'started.json')))
		const waiting = loopHarness(temp, { missing: true })
		assert.equal(waiting.status, 1)
		assert.match(waiting.stderr, /forward-only receipts retained/)
		const resumed = loopHarness(temp)
		assert.equal(resumed.status, 0, resumed.stderr)
		assert.ok(existsSync(join(temp, 'completed.json')))
		const repeated = loopHarness(temp)
		assert.equal(repeated.status, 0, repeated.stderr)
		assert.deepEqual(
			readFileSync(join(temp, 'actions'), 'utf8').trim().split('\n'),
			[`stop --time 90 ${id(20)}`, 'compose']
		)
	} finally {
		rmSync(temp, { recursive: true, force: true })
	}
})
test('actual shell never mutates before admission fsync and never retries an unknown stop', () => {
	for (const settings of [{ syncFailure: true }, { stopFailure: true }]) {
		const temp = mkdtempSync(join(tmpdir(), 'crm-provider-gate-'))
		try {
			const failed = loopHarness(temp, settings)
			assert.equal(failed.status, 1)
			assert.equal(existsSync(join(temp, 'started.json')), false)
			if (settings.syncFailure)
				assert.equal(existsSync(join(temp, 'actions')), false)
			else {
				const resumed = loopHarness(temp)
				assert.equal(resumed.status, 0, resumed.stderr)
				assert.equal(
					readFileSync(join(temp, 'actions'), 'utf8')
						.split('\n')
						.filter(row => row.startsWith('stop ')).length,
					1
				)
			}
		} finally {
			rmSync(temp, { recursive: true, force: true })
		}
	}
})
