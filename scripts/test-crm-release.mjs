import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
	crmNeighborFingerprint,
	crmPreparationReceipt,
	crmDatabaseNeighbors,
	crmDatabaseResources,
	crmDatabaseContainer,
	crmDatabaseCredentials
} from './crm-release.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const sha = value => createHash('sha256').update(value).digest('hex')
const revision = 'a'.repeat(40)
const previous = 'b'.repeat(40)
const hash = 'c'.repeat(64)
const owners = ['crm-access', 'crm-intake', 'crm-customers', 'crm-sales']
const id = number => number.toString(16).padStart(64, '0')
const image = number => 'sha256:' + id(number)
const fixture = () => {
	const config = {
		services: Object.fromEntries(
			owners.map((owner, index) => [
				owner + '-api',
				{
					image: image(index + 1),
					environment: { APP_REVISION: revision }
				}
			])
		)
	}
	return {
		composeBytes: JSON.stringify(config),
		images: owners.map((owner, index) => ({
			Id: image(index + 1),
			Os: 'linux',
			Architecture: 'amd64',
			Config: {
				Labels: {
					'org.opencontainers.image.title': 'winwidget-' + owner,
					'org.opencontainers.image.revision': revision
				}
			}
		})),
		servicesRevision: revision,
		infraRevision: revision,
		canonicalEnvSha256: hash,
		crmEnvSha256: hash,
		neighborsSha256: hash,
		architecture: 'amd64'
	}
}
const shape = () => ({
	kind: 'winwidget.crm.compose-shape.v1',
	runtimeProcesses: 12,
	databases: 4,
	migrationJobs: 4,
	releaseApproved: false
})
const neighbors = () =>
	['api-gateway', 'billing-api'].map((name, index) => ({
		Id: id(index + 1),
		Name: '/winwidget-' + name,
		Image: image(index + 1),
		Config: {
			Labels: {
				'com.docker.compose.project': 'winwidget',
				'com.docker.compose.service': name,
				'org.opencontainers.image.revision': previous
			},
			Env: ['SYNTHETIC_SECRET=fixture-only']
		},
		HostConfig: { NetworkMode: 'host' },
		NetworkSettings: {
			Networks: { host: { NetworkID: 'synthetic-network' } }
		},
		Mounts: [{ Destination: '/a' }, { Destination: '/b' }],
		RestartCount: 0,
		State: {
			Running: true,
			Paused: false,
			Restarting: false,
			OOMKilled: false,
			StartedAt: '2026-09-01T00:00:00Z',
			Health: { Status: 'healthy', Log: [] }
		}
	}))

const databaseFixture = (owner = owners[0]) => {
	const schema = owner.replaceAll('-', '_')
	const prefix = schema.toUpperCase()
	const reference = 'postgres:18-bookworm@sha256:' + id(90)
	const database = {
		image: reference,
		mem_limit: 512 * 1048576,
		memswap_limit: 512 * 1048576,
		cpus: '0.5',
		shm_size: 64 * 1048576,
		pids_limit: 200,
		ports: [{ published: '55442' }],
		command: ['postgres', '-c', 'max_connections=32'],
		environment: {
			POSTGRES_USER: 'winwidget_' + schema + '_admin',
			POSTGRES_DB: 'winwidget_' + schema,
			POSTGRES_PASSWORD_FILE:
				'/run/secrets/' + owner + '-postgres-admin-password'
		},
		healthcheck: {
			test: [
				'CMD',
				'pg_isready',
				'-U',
				'winwidget_' + schema + '_admin',
				'-d',
				'winwidget_' + schema
			]
		}
	}
	const postgresImage = {
		Id: image(90),
		Os: 'linux',
		Architecture: process.arch === 'x64' ? 'amd64' : process.arch,
		Config: {
			Env: ['PATH=/usr/local/bin:/usr/bin:/bin'],
			Entrypoint: ['docker-entrypoint.sh'],
			User: ''
		}
	}
	const config = {
		services: {
			...Object.fromEntries(
				owners.map(app => [app + '-postgres', structuredClone(database)])
			),
			[owner + '-api']: {
				environment: {
					[prefix + '_DATABASE_URL']:
						`postgresql://winwidget_${schema}_runtime:${'a'.repeat(64)}@127.0.0.1:55442/winwidget_${schema}?schema=${schema}`
				}
			},
			[owner + '-migrate']: {
				environment: {
					[prefix + '_DATABASE_URL']:
						`postgresql://winwidget_${schema}_migration:${'b'.repeat(64)}@127.0.0.1:55442/winwidget_${schema}?schema=${schema}`
				}
			}
		},
		secrets: {
			[owner + '-postgres-admin-password']: {
				file:
					'/opt/winwidget/deploy/backend/secrets/' +
					owner +
					'-postgres-admin-password'
			}
		}
	}
	const container = {
		Id: id(90),
		Name: '/winwidget-crm-' + owner + '-postgres-1',
		Image: postgresImage.Id,
		Config: {
			Image: reference,
			Labels: {
				'com.docker.compose.project': 'winwidget-crm',
				'com.docker.compose.service': owner + '-postgres',
				'com.docker.compose.container-number': '1',
				'com.docker.compose.oneoff': 'False',
				'com.winwidget.owner': owner,
				'com.winwidget.purpose': 'postgres'
			},
			Env: [
				...postgresImage.Config.Env,
				...Object.entries(database.environment).map(
					([key, value]) => key + '=' + value
				)
			],
			Cmd: database.command,
			Entrypoint: postgresImage.Config.Entrypoint,
			User: '',
			Healthcheck: {
				Test: database.healthcheck.test,
				Interval: 10e9,
				Timeout: 5e9,
				Retries: 12,
				StartPeriod: 10e9
			}
		},
		State: {
			Running: true,
			Paused: false,
			Restarting: false,
			OOMKilled: false,
			Dead: false,
			Health: { Status: 'healthy' }
		},
		HostConfig: {
			Memory: database.mem_limit,
			MemorySwap: database.memswap_limit,
			NanoCpus: 5e8,
			ShmSize: database.shm_size,
			PidsLimit: 200,
			Privileged: false,
			PidMode: '',
			IpcMode: 'private',
			NetworkMode: 'winwidget-crm_' + owner + '-postgres',
			RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
			PortBindings: {
				'5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55442' }]
			}
		},
		NetworkSettings: {
			Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55442' }] },
			Networks: { ['winwidget-crm_' + owner + '-postgres']: {} }
		},
		Mounts: [
			{
				Type: 'volume',
				Name: 'winwidget-crm_' + owner + '-postgres-data',
				Destination: '/var/lib/postgresql',
				RW: true
			},
			{
				Type: 'bind',
				Source: config.secrets[owner + '-postgres-admin-password'].file,
				Destination: '/run/secrets/' + owner + '-postgres-admin-password',
				RW: false
			}
		]
	}
	return { config, postgresImage, container }
}

test('database-only neighbor fence excludes only four unique owned database services', () => {
	const databases = owners.map(owner => databaseFixture(owner).container)
	assert.equal(
		crmDatabaseNeighbors([...neighbors(), ...databases], previous),
		crmNeighborFingerprint(neighbors(), previous)
	)
	for (const name of [
		'crm-access-api',
		'crm-intake-worker',
		'crm-sales-migrate',
		'unknown-postgres'
	]) {
		const candidate = structuredClone(databases[0])
		candidate.Config.Labels['com.docker.compose.service'] = name
		assert.throws(() =>
			crmDatabaseNeighbors([...neighbors(), candidate], previous)
		)
	}
	assert.throws(() =>
		crmDatabaseNeighbors(
			[...neighbors(), databases[0], databases[0]],
			previous
		)
	)
})

test('database preparation requires conservative memory headroom and every product flag off', () => {
	const { config } = databaseFixture()
	const validate = () => ({
		...shape(),
		databaseMemoryBytes: 2 * 1073741824,
		maxMigrationMemoryBytes: 256 * 1048576
	})
	const required = 4 * 1073741824 + 384 * 1048576
	assert.equal(
		crmDatabaseResources(config, validate, required).requiredMemoryBytes,
		required
	)
	for (const memory of [required - 1, 0, NaN, Infinity])
		assert.throws(() => crmDatabaseResources(config, validate, memory))
	config.services[
		'crm-access-api'
	].environment.CRM_INTAKE_WIDGET_TRANSFER_ENABLED = 'true'
	assert.throws(() => crmDatabaseResources(config, validate, required))
})

for (const owner of owners)
	test(
		owner +
			': actual database identity/configuration and three distinct scoped credentials are required',
		() => {
			const { config, container, postgresImage } = databaseFixture(owner)
			assert.equal(
				crmDatabaseContainer(container, config, postgresImage, owner),
				container.Id
			)
			const composeV5 = structuredClone(config)
			const imageWithoutDefaultUser = structuredClone(postgresImage)
			delete imageWithoutDefaultUser.Config.User
			assert.equal(
				crmDatabaseContainer(
					container,
					config,
					imageWithoutDefaultUser,
					owner
				),
				container.Id
			)
			for (const key of ['mem_limit', 'memswap_limit', 'shm_size'])
				composeV5.services[owner + '-postgres'][key] = String(
					composeV5.services[owner + '-postgres'][key]
				)
			assert.equal(
				crmDatabaseContainer(container, composeV5, postgresImage, owner),
				container.Id
			)
			for (const invalid of ['', '512m', '536870912.0', '-1', null]) {
				const malformed = structuredClone(composeV5)
				malformed.services[owner + '-postgres'].mem_limit = invalid
				assert.throws(() =>
					crmDatabaseContainer(container, malformed, postgresImage, owner)
				)
			}
			assert.throws(() =>
				crmDatabaseContainer(
					container,
					config,
					{
						...postgresImage,
						Architecture: 'incompatible'
					},
					owner
				)
			)
			assert.deepEqual(
				crmDatabaseCredentials(config, owner, 'c'.repeat(64)),
				{
					runtime: 'a'.repeat(64),
					migration: 'b'.repeat(64),
					backup: 'c'.repeat(64)
				}
			)
			for (const password of [
				'short',
				'a'.repeat(64),
				'c'.repeat(64) + '\n'
			])
				assert.throws(() =>
					crmDatabaseCredentials(config, owner, password)
				)
			for (const mutate of [
				value => {
					value.Image = image(91)
				},
				value => {
					value.State.Health.Status = 'starting'
				},
				value => {
					value.State.OOMKilled = true
				},
				value => {
					value.HostConfig.Memory = 0
				},
				value => {
					value.HostConfig.Privileged = true
				},
				value => {
					value.HostConfig.CapAdd = ['SYS_ADMIN']
				},
				value => {
					value.Config.Env.push('PGPASSWORD=unexpected')
				},
				value => {
					value.Config.Cmd = ['bash']
				},
				value => {
					value.Config.Healthcheck.Test = ['CMD', 'true']
				},
				value => {
					value.Mounts[0].Name = 'foreign'
				},
				value => {
					value.Mounts[1].RW = true
				},
				value => {
					value.HostConfig.PortBindings['5432/tcp'][0].HostIp = '0.0.0.0'
				},
				value => {
					value.NetworkSettings.Networks.foreign = {}
				},
				value => {
					value.Config.Labels['com.winwidget.owner'] = 'billing'
				}
			]) {
				const candidate = structuredClone(container)
				mutate(candidate)
				assert.throws(() =>
					crmDatabaseContainer(candidate, config, postgresImage, owner)
				)
			}
		}
	)

test('preparation binds the four inspected owner images to the exact validated Compose bytes without claiming deployment', () => {
	const input = fixture()
	let validated = 0
	const result = crmPreparationReceipt(input, config => {
		assert.deepEqual(config, JSON.parse(input.composeBytes))
		validated++
		return shape()
	})
	assert.equal(validated, 1)
	assert.equal(result.kind, 'winwidget.crm.preparation.v1')
	assert.equal(result.composeSha256, sha(input.composeBytes))
	assert.deepEqual(
		result.artifacts.map(item => item.owner),
		owners
	)
	for (const key of [
		'capacityVerified',
		'credentialsProvisioned',
		'migrationsApplied',
		'runtimeDeployed',
		'releaseApproved'
	])
		assert.equal(result[key], false)
	assert.deepEqual(crmPreparationReceipt(input, shape), result)
})

test('preparation refuses wrong owner, image, architecture, revision, artifact or a failing exact service-owned shape validator', () => {
	for (const mutate of [
		value => {
			value.servicesRevision = 'prod'
		},
		value => {
			value.infraRevision = previous
		},
		value => {
			value.canonicalEnvSha256 = 'invalid'
		},
		value => {
			value.crmEnvSha256 = ''
		},
		value => {
			value.neighborsSha256 = 'invalid'
		},
		value => {
			value.images[0].Id = 'mutable:latest'
		},
		value => {
			value.images[0].Id = value.images[1].Id
		},
		value => {
			value.images[0].Config.Labels['org.opencontainers.image.revision'] =
				previous
		},
		value => {
			value.images[0].Config.Labels['org.opencontainers.image.title'] =
				'winwidget-billing'
		},
		value => {
			value.images[0].Architecture = 'arm64'
		},
		value => {
			value.images[0].Os = 'windows'
		},
		value => {
			value.images.pop()
		},
		value => {
			const config = JSON.parse(value.composeBytes)
			config.services['crm-access-api'].image = image(9)
			value.composeBytes = JSON.stringify(config)
		},
		value => {
			const config = JSON.parse(value.composeBytes)
			config.services['crm-access-api'].environment.APP_REVISION = previous
			value.composeBytes = JSON.stringify(config)
		}
	]) {
		const value = fixture()
		mutate(value)
		// Infra may intentionally differ from services; both must be immutable.
		if (value.infraRevision === previous) {
			assert.equal(
				crmPreparationReceipt(value, shape).infraRevision,
				previous
			)
			continue
		}
		assert.throws(() => crmPreparationReceipt(value, shape))
	}
	assert.throws(() =>
		crmPreparationReceipt(fixture(), () => {
			throw new Error('shape rejected')
		})
	)
	assert.throws(() =>
		crmPreparationReceipt(fixture(), () => ({
			...shape(),
			releaseApproved: true
		}))
	)
})

test('neighbor fingerprint ignores health-log churn and mount order but detects env, restart, image and process changes', () => {
	const baseline = neighbors()
	const expected = crmNeighborFingerprint(baseline, previous)
	assert.match(expected, /^[a-f0-9]{64}$/)
	baseline[0].State.Health.Log.push({ Output: 'new readiness check' })
	baseline[0].Mounts.reverse()
	baseline.reverse()
	assert.equal(crmNeighborFingerprint(baseline, previous), expected)
	for (const mutate of [
		value => {
			value[1].Config.Env = ['CHANGED=true']
		},
		value => {
			value[1].RestartCount++
		},
		value => {
			value[1].Image = image(99)
		},
		value => {
			value[1].Id = id(99)
		},
		value => {
			value[1].State.StartedAt = '2026-09-02T00:00:00Z'
		},
		value => {
			value[1].Mounts[0].Destination = '/different'
		},
		value => {
			value[1].NetworkSettings.Networks.host.NetworkID = 'changed'
		}
	]) {
		const value = neighbors()
		mutate(value)
		assert.notEqual(crmNeighborFingerprint(value, previous), expected)
	}
	for (const mutate of [
		value => {
			value[0].State.Health.Status = 'unhealthy'
		},
		value => {
			value[0].State.OOMKilled = true
		},
		value => {
			value[0].State.Running = false
		},
		value => {
			value[0].State.Paused = true
		},
		value => {
			value[0].State.Restarting = true
		},
		value => {
			value[0].Config.Labels['org.opencontainers.image.revision'] =
				revision
		},
		value => {
			value.push(value[0])
		},
		value => {
			value.shift()
		}
	]) {
		const value = neighbors()
		mutate(value)
		assert.throws(() => crmNeighborFingerprint(value, previous))
	}
})

test('actual inventory CLI emits only a fingerprint or a sanitized failure', () => {
	const run = input =>
		spawnSync(
			process.execPath,
			[join(root, 'crm-release.mjs'), 'inventory'],
			{
				input,
				encoding: 'utf8',
				timeout: 5000,
				env: { CRM_GATEWAY_REVISION: previous }
			}
		)
	const good = run(JSON.stringify(neighbors()))
	assert.equal(good.status, 0, good.stderr)
	assert.equal(
		good.stdout.trim(),
		crmNeighborFingerprint(neighbors(), previous)
	)
	for (const input of [
		'malformed SYNTHETIC_SECRET',
		JSON.stringify([{ private: 'SYNTHETIC_SECRET' }])
	]) {
		const bad = run(input)
		assert.equal(bad.status, 1)
		assert.equal(bad.stdout, '')
		assert.equal(
			bad.stderr,
			'CRM release verification failed; private details suppressed\n'
		)
	}
})

function runController(
	scenario = 'success',
	replay = false,
	scope = 'crm-prepare'
) {
	const directory = mkdtempSync(join(tmpdir(), 'wincrm-prepare-contract-'))
	chmodSync(directory, 0o700)
	try {
		for (const path of [
			'deploy/backend/crm',
			'release/deploy',
			'release/.github/scripts',
			'payload'
		])
			mkdirSync(join(directory, path), { recursive: true, mode: 0o700 })
		for (const path of [
			'deploy/backend/.env.production',
			'deploy/backend/crm/.env.production',
			'deploy/backend/.production-deploy.lock',
			'release/deploy/docker-compose.crm.yml',
			'release/.github/scripts/validate-crm-compose.mjs'
		])
			writeFileSync(join(directory, path), 'synthetic-only\n', {
				mode: 0o600
			})
		writeFileSync(
			join(directory, 'payload/verifier.mjs'),
			readFileSync(join(root, 'crm-release.mjs')),
			{ mode: 0o444 }
		)
		const input = fixture()
		writeFileSync(
			join(directory, 'input-compose.json'),
			input.composeBytes,
			{ mode: 0o600 }
		)
		writeFileSync(
			join(directory, 'input-images.json'),
			JSON.stringify(input.images),
			{ mode: 0o600 }
		)
		writeFileSync(
			join(directory, 'input-receipt.json'),
			JSON.stringify(crmPreparationReceipt(input, shape)) + '\n',
			{ mode: 0o600 }
		)
		if (scope === 'crm-databases') {
			mkdirSync(join(directory, 'deploy/backend/secrets'), {
				recursive: true,
				mode: 0o700
			})
			mkdirSync(join(directory, 'release/deploy/crm'), {
				recursive: true,
				mode: 0o700
			})
			writeFileSync(
				join(directory, 'release/deploy/crm/database-access.mjs'),
				'// synthetic SQL module\n',
				{ mode: 0o444 }
			)
			const prepared = join(
				directory,
				'deploy/backend/crm/releases',
				revision
			)
			mkdirSync(prepared, { recursive: true, mode: 0o700 })
			writeFileSync(join(prepared, 'desired.json'), input.composeBytes, {
				mode: 0o600
			})
			writeFileSync(
				join(prepared, 'receipt.json'),
				JSON.stringify(crmPreparationReceipt(input, shape)) + '\n',
				{ mode: 0o600 }
			)
			for (const owner of owners)
				for (const role of ['admin', 'backup'])
					writeFileSync(
						join(
							directory,
							'deploy/backend/secrets',
							owner + '-postgres-' + role + '-password'
						),
						'synthetic-private\n',
						{ mode: 0o600 }
					)
		}
		const trace = join(directory, 'calls')
		const script = `
set -euo pipefail
umask 077
source "$TEST_LIBRARY"
app_root="$TEST_DIRECTORY"
release_root="$app_root/release"
env_file="$app_root/deploy/backend/.env.production"
deploy_lock="$app_root/deploy/backend/.production-deploy.lock"
deploy_lock_fd=19
scoped_payload_directory="$app_root/payload"
release_scope="$TEST_SCOPE"
services_revision="$TEST_REVISION"
infra_revision="$TEST_REVISION"
expected_live_revision="$TEST_PREVIOUS"
expected_env_sha256="$TEST_ENV_HASH"
expected_service_env_sha256="$TEST_ENV_HASH"
scoped_node_sha256="$TEST_VERIFIER_HASH"
die() { printf '%s\\n' "$1" >&2; exit 1; }
assert_root_owned_directory() { [[ -d "$1" && ! -L "$1" ]] || die 'unsafe directory'; }
assert_root_owned_file() { [[ -f "$1" && ! -L "$1" ]] || die 'unsafe file'; }
cleanup_scoped_payload() { printf 'CLEANUP\\n' >>"$TEST_TRACE"; }
stat() {
  if [[ "$*" == *'%a'* ]]; then printf '600\\n'; else printf '1:2\\n'; fi
}
sha256sum() { "$TEST_NODE" -e 'const f=require("node:fs"),c=require("node:crypto");console.log(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$1"; }
git() { if [[ "$*" == *rev-parse* ]]; then printf '%s\\n' "$TEST_REVISION"; fi; }
flock() { [[ "$TEST_SCENARIO" != lock-lost ]] || return 1; }
awk() { if [[ "$*" == *'/proc/meminfo'* ]]; then printf '17179869184'; else command awk "$@"; fi; }
docker() {
  printf 'DOCKER %s\\n' "$*" >>"$TEST_TRACE"
  local last=''
  for arg in "$@"; do last="$arg"; done
  case "$1" in
    context) printf 'unix:///var/run/docker.sock\\n' ;;
    ps)
      if [[ "$*" == *'label=com.docker.compose.project=winwidget-crm'* ]]; then
        local number=1 app
        for app in crm-access crm-intake crm-customers crm-sales; do
          if [[ -f "$TEST_DIRECTORY/running-$app" && ( "$*" != *'label=com.docker.compose.service='* || "$*" == *"service=$app-postgres"* ) ]]; then printf '%064d\\n' "$number"; fi
          number=$((number+1))
        done
        if [[ "$TEST_SCENARIO" == unknown-container && "$*" != *'label=com.docker.compose.service='* ]]; then printf '%064d\\n' 99; fi
      else printf '%s\\n' "$TEST_CONTAINER"; fi ;;
    inspect)
      if [[ "$*" == *'.State.Health.Status'* ]]; then printf 'healthy\\n'
      elif [[ "$*" == *'org.opencontainers.image.revision'* ]]; then printf '%s %s\\n' "$TEST_PROBE_IMAGE" "$TEST_PREVIOUS"
      else printf '[]\\n'; fi ;;
    image)
      if [[ "$2" != inspect ]]; then return 83; fi
      if [[ "$3" != --format ]]; then
        if [[ "$3" == winwidget-* ]]; then [[ -f "$TEST_DIRECTORY/built-$3" ]]; else command cat "$TEST_DIRECTORY/input-images.json"; fi
      elif [[ "$*" == *org.opencontainers.image.title* ]]; then
        case "$last" in
          winwidget-crm-access:*) printf '%s %s winwidget-crm-access\\n' "$TEST_IMAGE_1" "$TEST_REVISION" ;;
          winwidget-crm-intake:*) printf '%s %s winwidget-crm-intake\\n' "$TEST_IMAGE_2" "$TEST_REVISION" ;;
          winwidget-crm-customers:*) printf '%s %s winwidget-crm-customers\\n' "$TEST_IMAGE_3" "$TEST_REVISION" ;;
          winwidget-crm-sales:*) printf '%s %s winwidget-crm-sales\\n' "$TEST_IMAGE_4" "$TEST_REVISION" ;;
          *) return 84 ;;
        esac
      else printf '%s\\n' "$TEST_PREVIOUS"; fi ;;
    build)
      [[ "$TEST_SCENARIO" != build-failed ]] || return 85
      local tag='' previous_arg=''
      for arg in "$@"; do if [[ "$previous_arg" == --tag ]]; then tag="$arg"; fi; previous_arg="$arg"; done
      : >"$TEST_DIRECTORY/built-$tag" ;;
    run)
      local mode='' previous_arg='' arg
      for arg in "$@"; do if [[ "$previous_arg" == /run/crm-release.mjs ]]; then mode="$arg"; fi; previous_arg="$arg"; done
      if [[ "$mode" == inventory || "$mode" == database-neighbors ]]; then
        command cat >/dev/null
        if [[ "$TEST_SCENARIO" == neighbor-drift && -f "$TEST_DIRECTORY/built-winwidget-crm-access:git-$TEST_REVISION" ]]; then printf 'drift\\n'; else printf '%s\\n' "$TEST_HASH"; fi
      elif [[ "$mode" == database-resources ]]; then
        [[ "$TEST_SCENARIO" != capacity-failed ]] || return 92
        printf 'postgres:18-bookworm@sha256:%064d\\n' 90
      elif [[ "$mode" == database-container ]]; then
        command cat >/dev/null
        [[ "$TEST_SCENARIO" != container-drift ]] || return 93
        case "$last" in crm-access) printf '%064d\\n' 1 ;; crm-intake) printf '%064d\\n' 2 ;; crm-customers) printf '%064d\\n' 3 ;; crm-sales) printf '%064d\\n' 4 ;; *) return 94 ;; esac
      elif [[ "$mode" == database-check ]]; then printf '%s\\n' "$last"
      elif [[ "$mode" == database-bootstrap || "$mode" == database-grants || "$mode" == database-auth-* ]]; then
        [[ "$*" == *'--log-driver none'* ]] || return 95
        printf '%s\\n' "$mode"
        printf 'PRIVATE_PIPE_SENTINEL\\n'
      else
        [[ "$TEST_SCENARIO" != invalid-config ]] || return 86
        command cat "$TEST_DIRECTORY/input-receipt.json"
      fi ;;
    compose)
      if [[ "$TEST_SCOPE" != crm-databases ]]; then command cat "$TEST_DIRECTORY/input-compose.json"
      elif [[ "$*" == *' up '* ]]; then
        [[ "$last" == crm-*-postgres && "$*" == *'--no-recreate'* ]] || return 96
        : >"$TEST_DIRECTORY/running-\${last%-postgres}"
      elif [[ "$*" == *' run '* ]]; then
        [[ "$last" == crm-*-migrate && "$*" == *'--rm --no-deps'* ]] || return 97
        [[ "$TEST_SCENARIO" != migration-failed ]] || return 98
      else return 99; fi ;;
    exec)
      local input
      input="$(command cat)"
      [[ "$TEST_SCENARIO" != password-failed || "$input" != 'SELECT 1;' ]] || return 100
      if [[ "$input" == SELECT\\ EXISTS* ]]; then
        if [[ -f "$TEST_DIRECTORY/roles-exist" ]]; then printf 't\\n'; else printf 'f\\n'; fi
      elif [[ "$input" == database-bootstrap* ]]; then : >"$TEST_DIRECTORY/roles-exist"
      fi ;;
    volume|network)
      [[ "$TEST_SCENARIO" == foreign-volume ]] || return 1
      if [[ "$*" == *'--format'* ]]; then printf 'foreign|another-project\\n'; fi ;;
    *) return 87 ;;
  esac
}
# env -i must remove ambient variables, but the test's synthetic Docker
# implementation remains in-process. Inspect the exact env contract here.
env() {
  [[ "$1" == -i && "$2" == PATH=* ]] || return 88
  printf 'CLEAN_COMPOSE_ENV\\n' >>"$TEST_TRACE"
  shift 2
  local count=0
  while [[ "$1" != docker ]]; do [[ "$1" == CRM_*_IMAGE=* || "$1" == CRM_*_REVISION=* ]] || return 89; count=$((count+1)); shift; done
  if [[ "$TEST_SCOPE" == crm-databases ]]; then [[ "$count" == 0 ]] || return 90; else [[ "$count" == 8 ]] || return 90; fi
  shift
  docker "$@"
}
scoped_deploy_main
`
		const execute = () =>
			spawnSync('/bin/bash', ['-c', script], {
				encoding: 'utf8',
				timeout: scope === 'crm-databases' ? 60000 : 20000,
				env: {
					PATH: process.env.PATH,
					TEST_NODE: process.execPath,
					TEST_DIRECTORY: directory,
					TEST_TRACE: trace,
					TEST_LIBRARY: join(root, 'deploy-crm-scoped.sh'),
					TEST_SCENARIO: scenario,
					TEST_SCOPE: scope,
					TEST_REVISION: revision,
					TEST_PREVIOUS: previous,
					TEST_HASH: hash,
					TEST_ENV_HASH:
						scenario === 'env-drift' ? hash : sha('synthetic-only\n'),
					TEST_VERIFIER_HASH: sha(
						readFileSync(join(root, 'crm-release.mjs'))
					),
					TEST_PROBE_IMAGE: image(9),
					TEST_CONTAINER: id(9),
					TEST_IMAGE_1: image(1),
					TEST_IMAGE_2: image(2),
					TEST_IMAGE_3: image(3),
					TEST_IMAGE_4: image(4)
				}
			})
		const first = execute()
		assert.equal(first.error, undefined)
		assert.equal(first.signal, null)
		if (replay && scenario === 'different-artifact') {
			writeFileSync(
				join(directory, 'input-receipt.json'),
				JSON.stringify({
					...crmPreparationReceipt(input, shape),
					infraRevision: previous
				}) + '\n',
				{ mode: 0o600 }
			)
		}
		const second = replay ? execute() : null
		const receiptPath = join(
			directory,
			'deploy/backend/crm/releases',
			revision,
			'receipt.json'
		)
		return {
			first,
			second,
			calls: existsSync(trace) ? readFileSync(trace, 'utf8') : '',
			receipt: existsSync(receiptPath)
				? JSON.parse(readFileSync(receiptPath, 'utf8'))
				: null,
			temporary: readdirSync(join(directory, 'deploy/backend')).filter(
				name => name.startsWith('.crm-prepare.')
			)
		}
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

test('actual CRM controller prepares four images, preserves immutable artifacts on replay and never starts runtime or migrates', () => {
	const result = runController('success', true)
	assert.equal(result.first.status, 0, result.first.stderr)
	assert.equal(result.second.status, 0, result.second.stderr)
	assert.equal(
		result.calls
			.split('\n')
			.filter(line => line.startsWith('DOCKER build ')).length,
		4
	)
	assert.equal(
		result.calls.split('\n').filter(line => line === 'CLEAN_COMPOSE_ENV')
			.length,
		2
	)
	assert.equal(result.receipt.runtimeDeployed, false)
	assert.deepEqual(result.temporary, [])
	assert.doesNotMatch(
		result.calls,
		/DOCKER (?:stop|kill|start|rm|exec|volume|network)|compose .* (?:up|run|down)/
	)
})

test('actual CRM controller refuses changed env/lock/neighbors and failed build/config before sealing any release', () => {
	for (const scenario of [
		'env-drift',
		'lock-lost',
		'neighbor-drift',
		'build-failed',
		'invalid-config'
	]) {
		const result = runController(scenario)
		assert.notEqual(result.first.status, 0, scenario)
		assert.equal(result.receipt, null)
		assert.deepEqual(result.temporary, [])
		assert.doesNotMatch(
			result.calls,
			/DOCKER (?:stop|kill|start|rm|exec|volume|network)|compose .* (?:up|run|down)/
		)
		if (['env-drift', 'lock-lost'].includes(scenario))
			assert.doesNotMatch(result.calls, /DOCKER build/)
	}
})

test('CRM preparation cannot overwrite an existing receipt with different inputs', () => {
	const result = runController('different-artifact', true)
	assert.equal(result.first.status, 0, result.first.stderr)
	assert.equal(result.second.status, 1)
	assert.match(
		result.second.stderr,
		/immutable CRM preparation already exists/
	)
	assert.equal(result.receipt.infraRevision, revision)
	assert.deepEqual(result.temporary, [])
})

test('actual database stage initializes only four owners, migrates exact images and repeats without replacing containers or passwords', () => {
	const result = runController('success', true, 'crm-databases')
	assert.equal(result.first.status, 0, result.first.stderr)
	assert.equal(result.second.status, 0, result.second.stderr)
	assert.equal(
		result.calls
			.split('\n')
			.filter(
				line => line.startsWith('DOCKER compose ') && line.includes(' up ')
			).length,
		4
	)
	assert.equal(
		result.calls
			.split('\n')
			.filter(
				line =>
					line.startsWith('DOCKER compose ') && line.includes(' run ')
			).length,
		8
	)
	assert.doesNotMatch(
		result.calls,
		/DOCKER (?:build|stop|kill|start|rm)|compose .* (?:down|restart)|PRIVATE_PIPE_SENTINEL/
	)
	assert.doesNotMatch(
		result.first.stdout +
			result.first.stderr +
			result.second.stdout +
			result.second.stderr,
		/PRIVATE_PIPE_SENTINEL/
	)
	assert.deepEqual(result.temporary, [])
})

test('actual database stage fails closed without deleting owned storage or touching applications', () => {
	for (const scenario of [
		'env-drift',
		'lock-lost',
		'capacity-failed',
		'unknown-container',
		'foreign-volume',
		'password-failed',
		'container-drift',
		'migration-failed'
	]) {
		const result = runController(scenario, false, 'crm-databases')
		assert.notEqual(result.first.status, 0, scenario)
		assert.doesNotMatch(
			result.calls,
			/DOCKER (?:stop|kill|start|rm)|DOCKER (?:volume|network) (?:rm|prune)|compose .* (?:down|restart)/
		)
		if (
			[
				'env-drift',
				'lock-lost',
				'capacity-failed',
				'unknown-container',
				'foreign-volume'
			].includes(scenario)
		)
			assert.doesNotMatch(result.calls, /compose .* (?:up|run)/, scenario)
		assert.doesNotMatch(
			result.first.stdout + result.first.stderr,
			/PRIVATE_PIPE_SENTINEL/
		)
		assert.deepEqual(result.temporary, [])
	}
})

test(
	'real pinned PostgreSQL container matches the database verifier and authenticates via a root-private file',
	{ skip: !process.env.CRM_DATABASE_TEST_DOCKER },
	async () => {
		const mode = process.env.CRM_DATABASE_TEST_DOCKER
		assert.ok(['local', 'ci'].includes(mode))
		assert.ok(!process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT)
		if (mode === 'ci')
			assert.ok(
				process.env.CI === 'true' &&
					process.env.GITHUB_REPOSITORY === 'nda17/winwidget.ru_infra'
			)
		else assert.equal(process.platform, 'darwin')
		const context = mode === 'ci' ? 'default' : 'colima'
		let stage = 'context'
		const run = (bin, args, options = {}) =>
			spawnSync(bin, args, {
				encoding: 'utf8',
				stdio: ['pipe', 'pipe', 'pipe'],
				timeout: 180000,
				...options
			})
		const output = result => {
			const failure = String(result.stderr ?? '')
			const causes = [
				'permission denied',
				'operation not permitted',
				'no such file',
				'mount',
				'not shared',
				'address already in use',
				'invalid',
				'validating',
				'not allowed',
				'unsupported',
				'unhealthy',
				'cannot connect',
				'memory',
				'timeout'
			].filter(label => failure.toLowerCase().includes(label))
			assert.ok(
				result.status === 0,
				stage +
					': command failed (' +
					causes.join(', ') +
					'); private details suppressed'
			)
			return result.stdout.trim()
		}
		const docker = args => run('docker', ['--context', context, ...args])
		assert.equal(output(run('docker', ['context', 'show'])), context)
		assert.equal(
			output(
				docker([
					'context',
					'inspect',
					context,
					'--format',
					'{{.Endpoints.docker.Host}}'
				])
			),
			mode === 'ci'
				? 'unix:///var/run/docker.sock'
				: `unix://${homedir()}/.colima/default/docker.sock`
		)
		const owner = 'crm-access',
			service = owner + '-postgres',
			volume = 'winwidget-crm_' + service + '-data',
			network = 'winwidget-crm_' + service
		assert.equal(
			output(
				docker([
					'ps',
					'-aq',
					'--filter',
					'label=com.docker.compose.project=winwidget-crm'
				])
			),
			''
		)
		assert.notEqual(docker(['volume', 'inspect', volume]).status, 0)
		assert.notEqual(docker(['network', 'inspect', network]).status, 0)
		const directory = mkdtempSync(
			join(
				mode === 'local' ? '/private/tmp' : tmpdir(),
				'wincrm-database-container-'
			)
		)
		chmodSync(directory, 0o700)
		const password = randomBytes(32).toString('hex'),
			secret = join(directory, 'admin-password')
		writeFileSync(secret, password + '\n', { mode: 0o600 })
		const image =
			'postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
		const composeFile = join(directory, 'compose.json')
		const fixture = databaseFixture(owner)
		const spec = {
			name: 'winwidget-crm',
			services: {
				[service]: {
					image,
					labels: {
						'com.winwidget.owner': owner,
						'com.winwidget.purpose': 'postgres'
					},
					mem_limit: '512m',
					memswap_limit: '512m',
					cpus: '0.5',
					shm_size: '64m',
					pids_limit: 200,
					restart: 'unless-stopped',
					command: fixture.config.services[service].command,
					environment: {
						...fixture.config.services[service].environment,
						POSTGRES_INITDB_ARGS:
							'--locale=C.UTF-8 --encoding=UTF8 --auth-host=scram-sha-256 --data-checksums',
						PGDATA: '/var/lib/postgresql/18/docker'
					},
					ports: ['127.0.0.1:55442:5432'],
					volumes: [service + '-data:/var/lib/postgresql'],
					networks: [service],
					secrets: [owner + '-postgres-admin-password'],
					healthcheck: {
						...fixture.config.services[service].healthcheck,
						interval: '10s',
						timeout: '5s',
						retries: 12,
						start_period: '10s'
					}
				}
			},
			volumes: {
				[service + '-data']: { labels: { 'com.winwidget.owner': owner } }
			},
			networks: {
				[service]: {
					driver: 'bridge',
					labels: { 'com.winwidget.owner': owner }
				}
			},
			secrets: { [owner + '-postgres-admin-password']: { file: secret } }
		}
		writeFileSync(composeFile, JSON.stringify(spec), { mode: 0o600 })
		const compose = args =>
			docker([
				'compose',
				'--env-file',
				'/dev/null',
				'--project-name',
				'winwidget-crm',
				'-f',
				composeFile,
				...args
			])
		let container
		try {
			stage = 'pull-pinned-postgres'
			output(docker(['pull', image]))
			stage = 'start-owned-postgres'
			output(compose(['up', '--detach', '--no-build', '--pull', 'never']))
			container = output(compose(['ps', '-q', service]))
			assert.match(container, /^[a-f0-9]{64}$/)
			for (let attempt = 0; attempt < 90; attempt++) {
				const health = output(
					docker([
						'inspect',
						'--format',
						'{{.State.Health.Status}}',
						container
					])
				)
				if (health === 'healthy') break
				assert.equal(health, 'starting')
				await delay(1000)
			}
			stage = 'actual-container-identity'
			const config = JSON.parse(
				output(compose(['config', '--format', 'json']))
			)
			const actual = JSON.parse(output(docker(['inspect', container])))[0]
			const postgresImage = JSON.parse(
				output(docker(['image', 'inspect', image]))
			)[0]
			assert.equal(
				crmDatabaseContainer(actual, config, postgresImage, owner),
				container
			)
			const auth = () =>
				run(
					'/bin/bash',
					[
						'-c',
						`set -euo pipefail
source "$TEST_LIBRARY"
die() { exit 1; }
crm_verify_database() { return 0; }
crm_database_auth crm-access "$TEST_CONTAINER" admin
`
					],
					{
						env: {
							PATH: process.env.PATH,
							TEST_LIBRARY: join(root, 'deploy-crm-scoped.sh'),
							TEST_CONTAINER: container
						}
					}
				)
			stage = 'actual-private-file-auth'
			output(auth())
			writeFileSync(secret, randomBytes(32).toString('hex') + '\n', {
				mode: 0o600
			})
			assert.notEqual(
				auth().status,
				0,
				'changed file must not authenticate against existing stored password'
			)
			writeFileSync(secret, password + '\n', { mode: 0o600 })
			output(auth())
		} finally {
			stage = 'owned-test-cleanup'
			// Compose may create the container before its startup command fails.
			// This exact name was absent before the test; verify ownership below.
			if (!container) {
				const created = docker([
					'inspect',
					'--format',
					'{{.Id}}',
					'winwidget-crm-crm-access-postgres-1'
				])
				if (created.status === 0) container = created.stdout.trim()
			}
			if (container) {
				const actual = JSON.parse(
					output(docker(['inspect', container]))
				)[0]
				assert.equal(actual.Config.Labels['com.winwidget.owner'], owner)
				assert.equal(
					actual.Config.Labels['com.docker.compose.project'],
					'winwidget-crm'
				)
				assert.equal(
					actual.Config.Labels['com.docker.compose.service'],
					service
				)
				assert.equal(actual.Name, '/winwidget-crm-crm-access-postgres-1')
				output(docker(['rm', '--force', '--volumes', container]))
			}
			for (const [kind, name] of [
				['volume', volume],
				['network', network]
			]) {
				if (docker([kind, 'inspect', name]).status === 0) {
					assert.equal(
						output(
							docker([
								kind,
								'inspect',
								'--format',
								'{{index .Labels "com.winwidget.owner"}}|{{index .Labels "com.docker.compose.project"}}',
								name
							])
						),
						'crm-access|winwidget-crm'
					)
					output(docker([kind, 'rm', name]))
				}
			}
			rmSync(directory, { recursive: true, force: true })
		}
	}
)
