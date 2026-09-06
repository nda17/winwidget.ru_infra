import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
	crmNeighborFingerprint,
	crmPreparationReceipt
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

function runController(scenario = 'success', replay = false) {
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
release_scope=crm-prepare
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
docker() {
  printf 'DOCKER %s\\n' "$*" >>"$TEST_TRACE"
  local last=''
  for arg in "$@"; do last="$arg"; done
  case "$1" in
    context) printf 'unix:///var/run/docker.sock\\n' ;;
    ps) printf '%s\\n' "$TEST_CONTAINER" ;;
    inspect) printf '%s %s\\n' "$TEST_PROBE_IMAGE" "$TEST_PREVIOUS" ;;
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
      if [[ "$last" == inventory ]]; then
        command cat >/dev/null
        if [[ "$TEST_SCENARIO" == neighbor-drift && -f "$TEST_DIRECTORY/built-winwidget-crm-access:git-$TEST_REVISION" ]]; then printf 'drift\\n'; else printf '%s\\n' "$TEST_HASH"; fi
      else
        [[ "$TEST_SCENARIO" != invalid-config ]] || return 86
        command cat "$TEST_DIRECTORY/input-receipt.json"
      fi ;;
    compose) command cat "$TEST_DIRECTORY/input-compose.json" ;;
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
  [[ "$count" == 8 ]] || return 90
  shift
  docker "$@"
}
scoped_deploy_main
`
		const execute = () =>
			spawnSync('/bin/bash', ['-c', script], {
				encoding: 'utf8',
				timeout: 20000,
				env: {
					PATH: process.env.PATH,
					TEST_NODE: process.execPath,
					TEST_DIRECTORY: directory,
					TEST_TRACE: trace,
					TEST_LIBRARY: join(root, 'deploy-crm-scoped.sh'),
					TEST_SCENARIO: scenario,
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
