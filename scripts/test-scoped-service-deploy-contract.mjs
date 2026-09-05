import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
	NOTES_MIGRATION,
	OTP_MIGRATION,
	SCOPED_SERVICES,
	assertBrokerQuiet,
	assertIdentityManifestCompanion,
	assertMigrationLedger,
	assertOnlyNotesRouteRemoved,
	migrationFiles,
	prepareScopedCompose,
	sha256,
	validateRestoreEvidence,
	verifyDatabaseState
} from './scoped-service-release.mjs'

const scriptsRoot = dirname(fileURLToPath(import.meta.url))
const controllerPath = join(scriptsRoot, 'deploy-services-production.sh')
const scopedControllerPath = join(scriptsRoot, 'deploy-identity-operations-scoped.sh')
const revision = 'a'.repeat(40)
const oldRevision = 'b'.repeat(40)
const envHash = 'c'.repeat(64)
const identityScope = 'identity-with-operations-manifest'
const workerScope = 'workers-bootstrap-recovery'

function privateFixture(run) {
	const directory = mkdtempSync(join(tmpdir(), 'winwidget-scoped-contract-'))
	try {
		return run(directory)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

function rejectBeforeTransport(args, overrides, expected) {
	privateFixture(directory => {
		const bin = join(directory, 'bin')
		const calls = join(directory, 'calls')
		mkdirSync(bin)
		writeFileSync(calls, '')
		for (const name of ['ssh', 'git', 'docker', 'curl']) {
			writeFileSync(
				join(bin, name),
				'#!/bin/bash\nprintf "%s\\n" "$0 $*" >>"$SCOPED_TEST_CALLS"\nexit 91\n',
				{ mode: 0o700 }
			)
		}
		const result = spawnSync('/bin/bash', [controllerPath, ...args], {
			encoding: 'utf8',
			timeout: 5_000,
			env: {
				PATH: bin,
				LANG: 'C',
				SCOPED_TEST_CALLS: calls,
				INFRA_REVISION: revision,
				...overrides
			}
		})
		assert.equal(result.error, undefined)
		assert.equal(result.signal, null)
		assert.notEqual(result.status, 0)
		assert.match(result.stderr, expected)
		assert.equal(readFileSync(calls, 'utf8'), '', 'no transport or Docker before admission')
	})
}

test('real controller rejects mutable revision before any transport', () => {
	rejectBeforeTransport(['prod'], {}, /immutable lowercase 40-hex commit/)
	rejectBeforeTransport([revision], { INFRA_REVISION: 'main' }, /Infra revision/)
})

test('real controller refuses unknown scope without contacting production', () => {
	rejectBeforeTransport([revision], { RELEASE_SCOPE: 'identity operations' }, /Unsupported production release scope/)
})

test('real controller requires reviewed owner identity and exact env hash', () => {
	for (const scope of ['identity-with-operations-manifest', 'operations-runtime', 'gateway-remove-notes', workerScope]) {
		rejectBeforeTransport([revision], { RELEASE_SCOPE: scope }, /approved live revision and owner env SHA256/)
		rejectBeforeTransport([revision], {
			RELEASE_SCOPE: scope,
			EXPECTED_LIVE_REVISION: oldRevision,
			EXPECTED_SERVICE_ENV_SHA256: 'not-a-hash'
		}, /approved live revision and owner env SHA256/)
	}
})

test('worker release requires all three exact owner envs and no foreign authority', () => {
	const authorized = { RELEASE_SCOPE: workerScope, EXPECTED_LIVE_REVISION: oldRevision, EXPECTED_SERVICE_ENV_SHA256: envHash, EXPECTED_OPERATIONS_REVISION: oldRevision, EXPECTED_OPERATIONS_ENV_SHA256: envHash, EXPECTED_SUPPORT_ENV_SHA256: envHash }
	for (const value of ['', 'mutable']) rejectBeforeTransport([revision], { ...authorized, EXPECTED_SUPPORT_ENV_SHA256: value }, /exact Support env hash/)
	rejectBeforeTransport([revision], { ...authorized, EXPECTED_OPERATIONS_REVISION: revision }, /common approved live revision/)
	rejectBeforeTransport([revision], { ...authorized, OPERATIONS_RUNTIME_REVISION: oldRevision }, /Destructive authorization/)
	rejectBeforeTransport([revision], { RELEASE_SCOPE: 'all', EXPECTED_SUPPORT_ENV_SHA256: envHash }, /Scoped authorization/)
	rejectBeforeTransport([revision], { RELEASE_SCOPE: 'operations-runtime', EXPECTED_LIVE_REVISION: oldRevision, EXPECTED_SERVICE_ENV_SHA256: envHash, EXPECTED_SUPPORT_ENV_SHA256: envHash }, /Support authorization/)
})

test('all-services mode cannot inherit scoped or destructive authorization', () => {
	rejectBeforeTransport([revision], {
		RELEASE_SCOPE: 'all',
		EXPECTED_LIVE_REVISION: oldRevision
	}, /Scoped authorization cannot be attached/)
})

test('destructive Notes evidence cannot accidentally apply to a coordinated Identity release', () => {
	rejectBeforeTransport([revision], {
		RELEASE_SCOPE: 'identity-with-operations-manifest',
		EXPECTED_LIVE_REVISION: oldRevision,
		EXPECTED_SERVICE_ENV_SHA256: envHash,
		OPERATIONS_RUNTIME_REVISION: oldRevision,
		OPERATIONS_EVIDENCE_SHA256: envHash
	}, /Destructive authorization is only valid for Operations finalization/)
})

test('coordinated Identity release requires exact companion identities without leaking them into other scopes', () => {
	rejectBeforeTransport([revision], {
		RELEASE_SCOPE: 'identity-with-operations-manifest',
		EXPECTED_LIVE_REVISION: oldRevision,
		EXPECTED_SERVICE_ENV_SHA256: envHash
	}, /exact Operations companion identities/)
	rejectBeforeTransport([revision], {
		RELEASE_SCOPE: 'operations-runtime',
		EXPECTED_LIVE_REVISION: oldRevision,
		EXPECTED_SERVICE_ENV_SHA256: envHash,
		EXPECTED_OPERATIONS_REVISION: oldRevision,
		EXPECTED_OPERATIONS_ENV_SHA256: envHash
	}, /companion authorization is only valid/)
	rejectBeforeTransport([revision], { RELEASE_SCOPE: 'identity' }, /Unsupported production release scope/)
})

test('Operations finalization rejects a missing restore proof or a stale phase-A identity', () => {
	for (const proof of [
		{},
		{ OPERATIONS_RUNTIME_REVISION: revision, OPERATIONS_EVIDENCE_SHA256: envHash },
		{ OPERATIONS_RUNTIME_REVISION: oldRevision, OPERATIONS_EVIDENCE_SHA256: 'mutable-backup' }
	]) {
		rejectBeforeTransport([revision], {
			RELEASE_SCOPE: 'operations-backlog-finalize',
			EXPECTED_LIVE_REVISION: oldRevision,
			EXPECTED_SERVICE_ENV_SHA256: envHash,
			...proof
		}, /Operations finalization requires exact phase-A and restore evidence identities/)
	}
})

function composeFixture(scope = identityScope) {
	const image = {
		Id: `sha256:${'d'.repeat(64)}`,
		Config: {
			Env: ['PATH=/usr/bin'],
			Labels: { 'org.opencontainers.image.revision': revision },
			Cmd: ['node', 'main.js'],
			Entrypoint: null,
			User: ''
		}
	}
	const services = {}
	const live = SCOPED_SERVICES[scope].map((name, index) => {
		const environment = { APP_REVISION: revision, SERVICE_NAME: name }
		if (name === 'identity-api') environment.IDENTITY_LOGIN_OTP_ENABLED = 'true'
		if (scope === identityScope && ['operations-api', 'operations-restore-worker'].includes(name)) environment.DATABASE_RESTORE_ENABLED = 'false'
		if (scope === workerScope && name === 'operations-restore-worker') environment.DATABASE_RESTORE_ENABLED = 'false'
		const before = { ...environment, APP_REVISION: oldRevision }
		if (name === 'identity-api') before.IDENTITY_LOGIN_OTP_ENABLED = 'false'
		services[name] = {
			network_mode: 'host',
			stop_grace_period: '10s',
			environment,
			healthcheck: { test: ['CMD', 'node', 'health.js'], interval: '10s', timeout: '2s', start_period: '3s', retries: 3 },
			build: { context: '/synthetic/app' },
			depends_on: { postgres: { condition: 'service_healthy' } }
		}
		return {
			Id: (index + 1).toString(16).padStart(64, '0'),
			Image: `sha256:${'e'.repeat(64)}`,
			State: { Status: 'running', Health: { Status: 'healthy' } },
			Config: {
				Labels: {
					'com.docker.compose.service': name,
					'com.docker.compose.project': 'winwidget',
					'org.opencontainers.image.revision': oldRevision
				},
				Env: ['PATH=/usr/bin', ...Object.entries(before).map(([key, value]) => `${key}=${value}`)],
				Cmd: ['node', 'main.js'],
				Entrypoint: null,
				User: '',
				Healthcheck: { Test: ['CMD', 'node', 'health.js'], Interval: 10e9, Timeout: 2e9, StartPeriod: 3e9, Retries: 3 },
				StopTimeout: 10
			},
			HostConfig: {
				NetworkMode: 'host',
				Privileged: false,
				RestartPolicy: { Name: 'no' },
				LogConfig: { Type: 'json-file', Config: {} }
			},
			Mounts: []
		}
	})
	services['unrelated-widget-service'] = { image: 'never-touch-this-neighbor' }
	const operationsImage = { ...structuredClone(image), Id: `sha256:${'f'.repeat(64)}` }
	const supportImage = { ...structuredClone(image), Id: `sha256:${'1'.repeat(64)}` }
	return { scope, revision, previousRevision: oldRevision, operationsPreviousRevision: oldRevision, compose: { services }, live, image, operationsImage, supportImage }
}

test('worker Compose admits exactly seven running workers, three images and no API or scheduler', () => {
	const input = composeFixture(workerScope)
	input.live.forEach((container, index) => { container.State.Health.Status = index % 2 ? 'healthy' : 'unhealthy' })
	const { desired, rollback } = prepareScopedCompose(input)
	assert.deepEqual(Object.keys(desired.services), SCOPED_SERVICES[workerScope])
	assert.deepEqual(Object.keys(rollback.services), SCOPED_SERVICES[workerScope])
	for (const [name, service] of Object.entries(desired.services)) {
		assert.equal(service.image, name.startsWith('operations-') ? input.operationsImage.Id : name.startsWith('support-') ? input.supportImage.Id : input.image.Id)
		assert.equal(service.build, undefined)
		assert.equal(service.depends_on, undefined)
		assert.ok(!name.endsWith('-api') && !name.endsWith('-scheduler'))
		assert.equal(rollback.services[name].image, input.live.find(container => container.Config.Labels['com.docker.compose.service'] === name).Image)
	}
	for (const mutate of [
		candidate => { candidate.live[0].State.Status = 'exited' },
		candidate => { candidate.live[0].State.Health.Status = 'starting' },
		candidate => { candidate.live[0].Config.Labels['org.opencontainers.image.revision'] = revision },
		candidate => { candidate.supportImage.Config.Labels['org.opencontainers.image.revision'] = oldRevision },
		candidate => { candidate.operationsImage = undefined },
		candidate => { candidate.compose.services['operations-restore-worker'].environment.DATABASE_RESTORE_ENABLED = 'true' },
		candidate => { candidate.compose.services['operations-worker'].environment.NOTIFICATION_DELIVERY_INTERNAL_URL = 'http://127.0.0.1:4401' },
		candidate => { candidate.live.push(structuredClone(candidate.live[0])) },
		candidate => { candidate.compose.services['billing-worker'].environment.SERVICE_NAME = 'billing-api' }
	]) {
		const candidate = structuredClone(input)
		mutate(candidate)
		assert.throws(() => prepareScopedCompose(candidate))
	}
	const previous = composeFixture(identityScope)
	previous.live[1].State.Health.Status = 'unhealthy'
	assert.throws(() => prepareScopedCompose(previous), 'the exception cannot weaken prior scopes')
})

test('federation config reuses the exact Operations API image and normalizes only its reviewed ND origin', () => {
	const input = composeFixture('operations-federation-config')
	input.revision = oldRevision
	input.image.Id = input.live[0].Image
	input.image.Config.Labels['org.opencontainers.image.revision'] = oldRevision
	Object.assign(input.compose.services['operations-api'].environment, { APP_REVISION: oldRevision, DATABASE_RESTORE_ENABLED: 'false', NOTIFICATION_DELIVERY_INTERNAL_URL: 'http://127.0.0.1:4401' })
	input.live[0].Config.Env.push('DATABASE_RESTORE_ENABLED=false', 'NOTIFICATION_DELIVERY_INTERNAL_URL=http://127.0.0.1:4401/internal/notification-delivery')
	const { desired, rollback } = prepareScopedCompose(input)
	assert.deepEqual(Object.keys(desired.services), ['operations-api'])
	assert.equal(desired.services['operations-api'].image, input.live[0].Image)
	assert.equal(rollback.services['operations-api'].image, input.live[0].Image)
	assert.equal(rollback.services['operations-api'].environment.NOTIFICATION_DELIVERY_INTERNAL_URL, 'http://127.0.0.1:4401/internal/notification-delivery')
	for (const mutate of [
		candidate => { candidate.image.Id = `sha256:${'a'.repeat(64)}` },
		candidate => { candidate.compose.services['operations-api'].environment.APP_REVISION = revision },
		candidate => { candidate.compose.services['operations-api'].environment.DATABASE_RESTORE_ENABLED = 'true' },
		candidate => { candidate.compose.services['operations-api'].environment.TRUST_PROXY = 'true' },
		candidate => { candidate.live[0].Config.Env = candidate.live[0].Config.Env.filter(value => !value.startsWith('NOTIFICATION_DELIVERY_INTERNAL_URL=')) }
	]) {
		const candidate = structuredClone(input)
		mutate(candidate)
		assert.throws(() => prepareScopedCompose(candidate))
	}
	for (const url of ['http://127.0.0.1:4401/', 'http://127.0.0.1:4402', 'http://10.0.0.1:4401', 'https://127.0.0.1:4401', 'http://user:secret@127.0.0.1:4401', 'http://127.0.0.1:4401?anything=true']) {
		const candidate = structuredClone(input)
		candidate.compose.services['operations-api'].environment.NOTIFICATION_DELIVERY_INTERNAL_URL = url
		assert.throws(() => prepareScopedCompose(candidate))
	}
})

test('coordinated Compose adapter binds three Identity and four Operations owners to separate images', () => {
	const input = composeFixture()
	const before = structuredClone(input)
	const { desired, rollback } = prepareScopedCompose(input)
	assert.deepEqual(input, before, 'pure adapter cannot mutate source inventory')
	assert.deepEqual(Object.keys(desired.services), SCOPED_SERVICES[identityScope])
	assert.deepEqual(Object.keys(rollback.services), SCOPED_SERVICES[identityScope])
	for (const name of SCOPED_SERVICES[identityScope]) {
		assert.equal(desired.services[name].image, name.startsWith('operations-') ? input.operationsImage.Id : input.image.Id)
		assert.equal(desired.services[name].environment.APP_REVISION, revision)
		assert.equal(desired.services[name].build, undefined)
		assert.equal(desired.services[name].depends_on, undefined)
		assert.equal(rollback.services[name].image, input.live[0].Image)
		assert.equal(rollback.services[name].environment.APP_REVISION, oldRevision)
	}
	assert.equal(desired.services['identity-api'].environment.IDENTITY_LOGIN_OTP_ENABLED, 'true')
	assert.equal(rollback.services['identity-api'].environment.IDENTITY_LOGIN_OTP_ENABLED, 'false')
	assert.equal(desired.services['unrelated-widget-service'], undefined)
})

test('Compose capability normalization permits the Docker CAP_ prefix but rejects permission drift', () => {
	const input = composeFixture()
	input.compose.services['identity-api'].cap_add = ['CHOWN', 'SETGID']
	input.compose.services['identity-api'].cap_drop = ['ALL']
	input.live[0].HostConfig.CapAdd = ['CAP_SETGID', 'CAP_CHOWN']
	input.live[0].HostConfig.CapDrop = ['CAP_ALL']
	assert.doesNotThrow(() => prepareScopedCompose(input))
	for (const change of [
		changed => { changed.live[0].HostConfig.CapAdd = ['CAP_CHOWN', 'CAP_NET_ADMIN'] },
		changed => { changed.live[0].HostConfig.CapDrop = [] },
		changed => { changed.live[0].HostConfig.CapAdd.push('CAP_SYS_ADMIN') }
	]) {
		const changed = structuredClone(input)
		change(changed)
		assert.throws(() => prepareScopedCompose(changed))
	}
})

test('Compose extra_hosts normalizes array delimiters without accepting host or address drift', () => {
	const input = composeFixture()
	input.compose.services['identity-api'].extra_hosts = ['tg.winwidget.ru=127.0.0.1', 'ipv6.example.test=::1']
	input.live[0].HostConfig.ExtraHosts = ['ipv6.example.test:::1', 'tg.winwidget.ru:127.0.0.1']
	assert.doesNotThrow(() => prepareScopedCompose(input))
	const objectInput = structuredClone(input)
	objectInput.compose.services['identity-api'].extra_hosts = { 'tg.winwidget.ru': '127.0.0.1', 'ipv6.example.test': '::1' }
	assert.doesNotThrow(() => prepareScopedCompose(objectInput))
	const colonInput = structuredClone(input)
	colonInput.compose.services['identity-api'].extra_hosts = ['tg.winwidget.ru:127.0.0.1', 'ipv6.example.test:::1']
	assert.doesNotThrow(() => prepareScopedCompose(colonInput))
	for (const hosts of [
		['tg.winwidget.ru:127.0.0.2', 'ipv6.example.test:::1'],
		['other.example.test:127.0.0.1', 'ipv6.example.test:::1'],
		['tg.winwidget.ru:127.0.0.1'],
		['tg.winwidget.ru:127.0.0.1', 'ipv6.example.test:::2']
	]) {
		const changed = structuredClone(input)
		changed.live[0].HostConfig.ExtraHosts = hosts
		assert.throws(() => prepareScopedCompose(changed))
	}
	const malformed = structuredClone(input)
	malformed.compose.services['identity-api'].extra_hosts = ['tg.winwidget.ru']
	assert.throws(() => prepareScopedCompose(malformed))
})

test('migration inventory hashes all exact canonical SQL files in sorted order', () => {
	privateFixture(directory => {
		const root = join(realpathSync(directory), 'migrations')
		mkdirSync(root)
		const names = ['20260910010000_add_login_otp', '20260101000000_initial']
		for (const name of names) {
			mkdirSync(join(root, name))
			writeFileSync(join(root, name, 'migration.sql'), `-- ${name}\nSELECT 1;\n`)
		}
		writeFileSync(join(root, 'migration_lock.toml'), 'provider = "postgresql"\n')
		assert.deepEqual(migrationFiles(root), names.sort().map(name => ({
			name,
			checksum: sha256(Buffer.from(`-- ${name}\nSELECT 1;\n`))
		})))
	})
})

test('migration inventory rejects unexpected directories and filesystem entries instead of silently skipping DDL', () => {
	for (const scenario of ['uppercase-directory', 'unexpected-file', 'named-sql-file', 'directory-lock', 'missing-sql']) {
		privateFixture(directory => {
			const root = join(realpathSync(directory), 'migrations')
			mkdirSync(root)
			if (scenario === 'uppercase-directory') mkdirSync(join(root, '20260910010000_UNREVIEWED'))
			if (scenario === 'unexpected-file') writeFileSync(join(root, 'README.md'), 'unexpected')
			if (scenario === 'named-sql-file') writeFileSync(join(root, '20260910010000_unreviewed'), 'SELECT 1;')
			if (scenario === 'directory-lock') mkdirSync(join(root, 'migration_lock.toml'))
			if (scenario === 'missing-sql') mkdirSync(join(root, '20260910010000_missing_sql'))
			assert.throws(() => migrationFiles(root), scenario)
		})
	}
})

test('migration inventory rejects SQL, directory, lock and parent-path symlinks', () => {
	for (const scenario of ['sql', 'directory', 'lock', 'root', 'parent']) {
		privateFixture(directory => {
			const canonical = realpathSync(directory)
			const parent = join(canonical, 'real')
			const root = join(parent, 'migrations')
			const migration = join(root, '20260101000000_initial')
			mkdirSync(migration, { recursive: true })
			writeFileSync(join(canonical, 'unreviewed.sql'), 'SELECT 1;')
			if (scenario === 'sql') symlinkSync(join(canonical, 'unreviewed.sql'), join(migration, 'migration.sql'))
			else writeFileSync(join(migration, 'migration.sql'), 'SELECT 1;')
			if (scenario === 'directory') symlinkSync(migration, join(root, '20260910010000_unreviewed'))
			if (scenario === 'lock') symlinkSync(join(canonical, 'unreviewed.sql'), join(root, 'migration_lock.toml'))
			let selectedRoot = root
			if (scenario === 'root') {
				selectedRoot = join(canonical, 'root-link')
				symlinkSync(root, selectedRoot)
			}
			if (scenario === 'parent') {
				const alias = join(canonical, 'parent-link')
				symlinkSync(parent, alias)
				selectedRoot = join(alias, 'migrations')
			}
			assert.throws(() => migrationFiles(selectedRoot), scenario)
		})
	}
})

test('scoped Compose adapter refuses ownership, health, image and infrastructure drift', () => {
	const mutations = [
		input => { input.live[0].Config.Labels['com.docker.compose.project'] = 'another-project' },
		input => { input.live[0].Config.Labels['org.opencontainers.image.revision'] = revision },
		input => { input.live[0].State.Health.Status = 'unhealthy' },
		input => { input.live[0].State.Status = 'exited' },
		input => { input.live.push(structuredClone(input.live[0])) },
		input => { input.image.Config.Labels['org.opencontainers.image.revision'] = oldRevision },
		input => { input.operationsImage.Config.Labels['org.opencontainers.image.revision'] = oldRevision },
		input => { input.operationsPreviousRevision = revision },
		input => { input.compose.services['operations-api'].environment.DATABASE_RESTORE_ENABLED = 'true' },
		input => { input.compose.services['identity-api'].network_mode = 'bridge' },
		input => { input.compose.services['identity-api'].privileged = true },
		input => { input.compose.services['identity-api'].environment.DATABASE_URL = 'synthetic-unapproved' },
		input => { input.compose.services['identity-api'].environment.SERVICE_NAME = 'another-owner' },
		input => { input.compose.services['identity-api'].ports = [{ published: '4200', target: 4200 }] },
		input => { input.compose.services['identity-api'].healthcheck.interval = '10seconds' },
		input => { input.compose.services['identity-api'].volumes = [{ type: 'bind', source: '/unapproved', target: '/data' }] }
	]
	for (const mutate of mutations) {
		const input = composeFixture()
		mutate(input)
		assert.throws(() => prepareScopedCompose(input), undefined, mutate.toString())
	}
})

test('Operations phase-A adapter includes exactly its four runtimes and no neighbors', () => {
	const input = composeFixture('operations-runtime')
	const result = prepareScopedCompose(input)
	assert.deepEqual(Object.keys(result.desired.services), SCOPED_SERVICES['operations-runtime'])
	assert.equal(result.desired.services['identity-api'], undefined)
	assert.equal(result.desired.services['unrelated-widget-service'], undefined)
	assert.throws(() => prepareScopedCompose({ ...input, scope: 'operations-backlog-finalize' }))
})

function migrationFixture(pendingName = OTP_MIGRATION) {
	const files = [
		{ name: '20260101000000_initial', checksum: sha256('initial migration') },
		{ name: pendingName, checksum: sha256('pending migration') }
	]
	const ledger = [{ migration_name: files[0].name, checksum: files[0].checksum, finished_at: '2026-01-01T01:00:00.000Z', rolled_back_at: null }]
	return { files, ledger }
}

test('migration ledger allows only the exact final OTP or Notes migration', () => {
	for (const pendingName of [OTP_MIGRATION, NOTES_MIGRATION]) {
		const { files, ledger } = migrationFixture(pendingName)
		assert.equal(assertMigrationLedger(files, ledger, pendingName), false)
		ledger.push({ migration_name: pendingName, checksum: files[1].checksum, finished_at: '2026-09-05T20:00:00.000Z', rolled_back_at: null })
		assert.equal(assertMigrationLedger(files, ledger, pendingName, true), true)
		assert.throws(() => assertMigrationLedger(files, ledger, pendingName))
	}
})

test('migration ledger rejects drift, unfinished/rolled-back entries, unrelated pending changes', () => {
	const mutations = [
		input => { input.files[0].checksum = envHash },
		input => { input.ledger[0].finished_at = null },
		input => { input.ledger[0].rolled_back_at = '2026-09-05T20:00:00.000Z' },
		input => { input.ledger.push(structuredClone(input.ledger[0])) },
		input => { input.ledger[0].migration_name = '20250101000000_foreign' },
		input => { input.files.splice(1, 0, { name: '20260901000000_unreviewed', checksum: envHash }) },
		input => { input.files.reverse() }
	]
	for (const mutate of mutations) {
		const input = migrationFixture()
		mutate(input)
		assert.throws(() => assertMigrationLedger(input.files, input.ledger, OTP_MIGRATION), undefined, mutate.toString())
	}
})

test('Operations companion manifest can append only the reviewed Identity OTP migration', () => {
	const { files } = migrationFixture()
	const entry = migrations => ({ migrations, manifestSha256: sha256(JSON.stringify({ schemaVersion: 1, target: 'identity', migrations })) })
	const before = { schemaVersion: 1, targets: { identity: entry(files.slice(0, -1)), widgets: { preserved: 'same' } } }
	const after = { schemaVersion: 1, targets: { identity: entry(files), widgets: { preserved: 'same' } } }
	assertIdentityManifestCompanion(before, after, files)
	for (const mutate of [
		value => { value.targets.identity.manifestSha256 = envHash },
		value => { value.targets.identity.migrations[0].checksum = envHash },
		value => { value.targets.widgets.preserved = 'changed' },
		value => { value.targets.unapproved = {} },
		value => { value.targets.identity.migrations.pop() }
	]) {
		const changed = structuredClone(after)
		mutate(changed)
		assert.throws(() => assertIdentityManifestCompanion(before, changed, files))
	}
	assert.throws(() => assertIdentityManifestCompanion(before, after, [
		{ name: '20260101000000_workspaces', checksum: envHash }, files[1]
	]))
})

function routesFixture() {
	const before = Array.from({ length: 43 }, (_, index) => ({ id: `route-${index}`, prefix: `/api/v1/route-${index}`, upstream: 'http://127.0.0.1:4000' }))
	before[7] = { id: 'operations-notes', prefix: '/api/v1/notes', upstream: 'http://127.0.0.1:4800' }
	return { before, after: before.filter(route => route.id !== 'operations-notes') }
}

test('Gateway is permitted to remove only the exact Notes route without changing remaining routes', () => {
	const { before, after } = routesFixture()
	assertOnlyNotesRouteRemoved(before, after)
	const changed = structuredClone(after)
	changed[0].upstream = 'http://unapproved.invalid'
	assert.throws(() => assertOnlyNotesRouteRemoved(before, changed))
	assert.throws(() => assertOnlyNotesRouteRemoved(before, after.slice(1)))
	assert.throws(() => assertOnlyNotesRouteRemoved(before, [...after].reverse()))
	assert.throws(() => assertOnlyNotesRouteRemoved(before.map(route => ({ ...route, prefix: '/other' })), after))
})

test('Gateway scoped adapter pins the already running image and changes only route JSON', () => {
	const input = composeFixture('gateway-remove-notes')
	const { before, after } = routesFixture()
	input.compose.services['api-gateway'].environment.APP_REVISION = oldRevision
	input.compose.services['api-gateway'].environment.GATEWAY_ROUTES_JSON = JSON.stringify(after)
	input.live[0].Config.Env.push(`GATEWAY_ROUTES_JSON=${JSON.stringify(before)}`)
	input.image.Id = input.live[0].Image
	input.image.Config.Labels['org.opencontainers.image.revision'] = oldRevision
	const result = prepareScopedCompose(input)
	assert.deepEqual(Object.keys(result.desired.services), ['api-gateway'])
	assert.equal(result.desired.services['api-gateway'].image, input.live[0].Image)
	assert.equal(result.rollback.services['api-gateway'].image, input.live[0].Image)
	assert.equal(result.desired.services['api-gateway'].environment.APP_REVISION, oldRevision)
	assert.deepEqual(JSON.parse(result.desired.services['api-gateway'].environment.GATEWAY_ROUTES_JSON), after)
	assert.deepEqual(JSON.parse(result.rollback.services['api-gateway'].environment.GATEWAY_ROUTES_JSON), before)
	const changedImage = structuredClone(input)
	changedImage.image.Id = `sha256:${'2'.repeat(64)}`
	assert.throws(() => prepareScopedCompose(changedImage))
	const changedRevision = structuredClone(input)
	changedRevision.compose.services['api-gateway'].environment.APP_REVISION = revision
	assert.throws(() => prepareScopedCompose(changedRevision))
})

function restoreFixture() {
	const receipt = {
		schemaVersion: 1,
		kind: 'winwidget.operations.backlog-phase-a.v1',
		databaseId: '11111111-1111-1111-1111-111111111111',
		operationsRuntimeRevision: oldRevision,
		migrationManifestSha256: envHash,
		notesMigrationChecksum: 'e'.repeat(64),
		fencedAt: '2026-09-05T20:00:00.000Z',
		notesWriteFenceApplied: true
	}
	const evidence = {
		schemaVersion: 1,
		kind: 'winwidget.operations.backlog-backup-restore.v1',
		phaseAReceiptSha256: sha256(JSON.stringify(receipt)),
		databaseId: receipt.databaseId,
		operationsRuntimeRevision: receipt.operationsRuntimeRevision,
		migrationManifestSha256: receipt.migrationManifestSha256,
		artifactSha256: 'f'.repeat(64),
		restoreImageId: `sha256:${'1'.repeat(64)}`,
		postgresMajor: 18,
		restoreExitCode: 0,
		restoredSchema: 'operations',
		notesTablePresent: true,
		restoredNotesWriteFence: true,
		unrelatedAuditRoundTripEqual: true,
		notesRows: 2,
		backlogAuditRows: 4,
		restoredAt: '2026-09-05T20:10:00.000Z'
	}
	return { receipt, evidence }
}

test('restore admission binds actual restore, Notes fence, database and phase-A identity', () => {
	const { receipt, evidence } = restoreFixture()
	validateRestoreEvidence(evidence, receipt)
	for (const patch of [
		{ schemaVersion: 2 }, { phaseAReceiptSha256: envHash }, { databaseId: 'another-database' },
		{ operationsRuntimeRevision: revision }, { migrationManifestSha256: 'f'.repeat(64) },
		{ postgresMajor: 17 }, { restoreExitCode: 1 }, { restoredSchema: 'widgets' },
		{ artifactSha256: 'mutable' }, { restoreImageId: 'postgres:latest' },
		{ notesTablePresent: false }, { restoredNotesWriteFence: false },
		{ unrelatedAuditRoundTripEqual: false }, { notesRows: -1 }, { backlogAuditRows: 1.1 },
		{ restoredAt: '2026-09-05T19:00:00.000Z' }, { restoredAt: 'not-a-date' }
	]) {
		assert.throws(() => validateRestoreEvidence({ ...evidence, ...patch }, receipt), undefined, JSON.stringify(patch))
	}
	assert.throws(() => validateRestoreEvidence(evidence, { ...receipt, notesWriteFenceApplied: false }))
	assert.throws(() => validateRestoreEvidence(evidence, { ...receipt, notesMigrationChecksum: undefined }))
	assert.throws(() => validateRestoreEvidence(evidence, { ...receipt, notesMigrationChecksum: 'not-a-hash' }))
	assert.throws(() => validateRestoreEvidence(evidence, { ...receipt, notesMigrationChecksum: 'f'.repeat(64) }))
})

// Execute the real sourced Bash coordinator. Only process/host boundaries are
// replaced: no Docker daemon, SSH, production paths, database or network exists.
// The verifier's real pure contracts are exercised separately above.
const runtimeHarness = String.raw`
set -euo pipefail
umask 077
source "$SCOPED_LIBRARY"
app_root="$SCOPED_FIXTURE/app"
services_repository="$app_root/services"
release_root="$app_root/release"
compose_file="$release_root/compose.yml"
env_file="$app_root/deploy/backend/.env.production"
deploy_lock="$app_root/deploy/backend/lock"
deploy_lock_fd=9
scoped_diagnostic_fd=8
exec 8>&2
scoped_payload_directory="$app_root/payload"
services_revision="$TEST_REVISION"
infra_revision="$TEST_REVISION"
expected_live_revision="$TEST_PREVIOUS_REVISION"
release_scope="$TEST_SCOPE"
expected_env_sha256="$TEST_ENV_HASH"
expected_service_env_sha256="$TEST_ENV_HASH"
expected_operations_revision="$TEST_PREVIOUS_REVISION"
expected_operations_env_sha256="$TEST_ENV_HASH"
expected_support_env_sha256="$TEST_ENV_HASH"
operations_runtime_revision=''
operations_evidence_sha256=''
if [[ "$release_scope" == operations-backlog-finalize ]]; then
  operations_runtime_revision="$expected_live_revision"
  operations_evidence_sha256="$TEST_EVIDENCE_HASH"
fi
die() { printf '%s\n' "$1" >&2; exit 1; }
assert_root_owned_file() { [[ -f "$1" && ! -L "$1" ]] || die 'Synthetic file boundary'; }
assert_root_owned_directory() { [[ -d "$1" && ! -L "$1" ]] || die 'Synthetic directory boundary'; }
cleanup_scoped_payload() { printf 'CLEANUP_PAYLOAD\n' >>"$SCOPED_CALLS"; }
stat() {
  case "$2" in '%d:%i') printf '11:22\n' ;; '%a') printf '600\n' ;; *) return 81 ;; esac
}
flock() { [[ "$TEST_SCENARIO" != lost-lock ]]; }
sha256sum() { "$TEST_NODE" -e 'const f=require("fs"),c=require("crypto"); for(const p of process.argv.slice(1))console.log(c.createHash("sha256").update(f.readFileSync(p)).digest("hex")+"  "+p)' "$@"; }
sync() { :; }
sleep() { if [[ "$TEST_SCENARIO" == stop-timeout ]]; then SECONDS=$((SECONDS + 60)); fi; }
git() {
  if [[ " $* " == *' diff '* ]]; then
    if [[ "$TEST_SCOPE" == workers-bootstrap-recovery ]]; then
      for owner in billing operations support; do printf 'apps/%s/src/main.ts\napps/%s/src/runtime/bootstrap-failure.ts\n' "$owner" "$owner"; done
      if [[ "$TEST_SCENARIO" == source-drift ]]; then printf 'apps/operations/prisma/migrations/20260910110000_remove_admin_backlog/migration.sql\n'; fi
    elif [[ "$TEST_SCENARIO" == companion-drift ]]; then printf 'apps/operations/src/unsafe-change.ts\n';
    else printf 'apps/operations/restore-manifests/database-restore-migrations.json\n'; fi
  else printf '%s\n' "$TEST_REVISION"; fi
}
scoped_set_image_variables() { :; }
scoped_env_inventory() { printf 'unchanged-owner-envs\n'; }
scoped_inventory() {
  if [[ "$TEST_SCENARIO" == neighbor-drift && "$(<"$SCOPED_PHASE")" == desired ]]; then printf 'neighbor unexpected-replacement\n';
  else printf 'neighbor stable-id stable-image stable-revision\n'; fi
}
docker() {
  printf 'DOCKER' >>"$SCOPED_CALLS"
  printf ' <%s>' "$@" >>"$SCOPED_CALLS"
  printf '\n' >>"$SCOPED_CALLS"
  local current image rev service='operations-api' format='' previous='' arg snapshot='' action='' last='' cid='' number=''
  for arg in "$@"; do last="$arg"; done
  current="$(<"$SCOPED_PHASE")"
  image="$TEST_OLD_IMAGE"; rev="$TEST_PREVIOUS_REVISION"
  if [[ "$current" == desired && "$TEST_SCOPE" != gateway-remove-notes && "$TEST_SCOPE" != operations-federation-config ]]; then image="$TEST_NEW_IMAGE"; rev="$TEST_REVISION"; fi
  if [[ "$current" == desired && "$TEST_SCOPE" == identity-with-operations-manifest && "$last" =~ ^0+[1-4]$ ]]; then image="$TEST_OPERATIONS_IMAGE"; fi
  if [[ "$current" == desired && "$TEST_SCOPE" == workers-bootstrap-recovery ]]; then
    if [[ "$last" =~ ^0+[1-4]$ ]]; then image="$TEST_OPERATIONS_IMAGE"; fi
    if [[ "$last" =~ ^0+(10|11|12)$ ]]; then image="$TEST_SUPPORT_IMAGE"; fi
  fi
  case "$1" in
    ps)
      for arg in "$@"; do
        case "$arg" in label=com.docker.compose.service=*) service="${'${'}arg#label=com.docker.compose.service=}" ;; esac
      done
      case "$service" in
        operations-api|api-gateway) number=1 ;;
        operations-worker) number=2 ;;
        operations-outbox-publisher) number=3 ;;
        operations-restore-worker) number=4 ;;
        identity-api) number=5 ;;
        identity-worker) number=6 ;;
        identity-outbox-publisher) number=7 ;;
        billing-api) number=8 ;;
        billing-worker) number=9 ;;
        billing-outbox-publisher) number=13 ;;
        support-api) number=10 ;;
        support-worker) number=11 ;;
        support-outbox-publisher) number=12 ;;
        rabbitmq) number=14 ;;
        *) return 1 ;;
      esac
      printf -v cid '%064d' "$number"
      [[ " $* " == *' --all '* || ! -f "$SCOPED_FIXTURE/stopped-$cid" ]] || return 0
      printf '%s\n' "$cid" ;;
    inspect)
      if [[ "${'${'}2:-}" != --format ]]; then printf '[]\n'; return 0; fi
      format="$3"
      case "$format" in
        '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}') printf '%s %s\n' "$image" "$rev" ;;
        '{{.State.Running}} {{.State.Pid}}')
          if [[ -f "$SCOPED_FIXTURE/stopped-$last" && "$TEST_SCENARIO" != still-running ]]; then printf 'false 0\n'; else printf 'true 123\n'; fi ;;
        '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}')
          if [[ "$TEST_SCENARIO" == unhealthy && "$current" == desired ]]; then printf 'running unhealthy\n'; else printf 'running healthy\n'; fi ;;
        '{{.State.Health.Status}}')
          if [[ "$TEST_SCENARIO" == broker-unhealthy ]]; then printf 'unhealthy\n'; else printf 'healthy\n'; fi ;;
        *) return 82 ;;
      esac ;;
    image)
      if [[ "${'${'}3:-}" == --format ]]; then
        image="$TEST_NEW_IMAGE"
        if [[ "$TEST_SCOPE" == identity-with-operations-manifest && "$last" == winwidget-operations:* ]]; then image="$TEST_OPERATIONS_IMAGE"; fi
        if [[ "$TEST_SCOPE" == workers-bootstrap-recovery && "$last" == winwidget-operations:* ]]; then image="$TEST_OPERATIONS_IMAGE"; fi
        if [[ "$TEST_SCOPE" == workers-bootstrap-recovery && "$last" == winwidget-support:* ]]; then image="$TEST_SUPPORT_IMAGE"; fi
        printf '%s %s\n' "$image" "$TEST_REVISION"
      else printf '[]\n'; fi ;;
    build) [[ "$TEST_SCENARIO" != build-failed ]] ;;
    exec) [[ "$TEST_SCENARIO" != broker-unavailable ]] ;;
    kill)
      [[ "$2" == --signal=TERM ]] || return 81
      if [[ "$TEST_SCENARIO" == stop-interrupted ]]; then kill -TERM "$$"; fi
      if [[ "$TEST_SCENARIO" != stop-timeout ]]; then printf stopped >"$SCOPED_FIXTURE/stopped-$last"; fi ;;
    stop)
      for arg in "$@"; do
        if [[ "$arg" =~ ^[a-f0-9]{64}$ ]]; then printf stopped >"$SCOPED_FIXTURE/stopped-$arg"; fi
      done ;;
    start)
      for arg in "$@"; do
        if [[ "$arg" =~ ^[a-f0-9]{64}$ ]]; then rm -f -- "$SCOPED_FIXTURE/stopped-$arg"; fi
      done ;;
    compose)
      for arg in "$@"; do
        [[ "$previous" != -f ]] || snapshot="$arg"
        case "$arg" in up|run|config) action="$arg" ;; esac
        previous="$arg"; last="$arg"
      done
      if [[ "$action" == config ]]; then printf '{}\n'; return 0; fi
      if [[ "$action" == up ]]; then
        case "$snapshot" in */desired.json) printf desired >"$SCOPED_PHASE" ;; */rollback.json) printf rollback >"$SCOPED_PHASE" ;; *) return 83 ;; esac
        for number in 1 2 3 4 9 11 12 13; do printf -v cid '%064d' "$number"; rm -f -- "$SCOPED_FIXTURE/stopped-$cid"; done
        if [[ "$snapshot" == */desired.json ]]; then
          if [[ "$TEST_SCENARIO" == term || "$TEST_SCENARIO" == repeated-term ]]; then kill -TERM "$$"; fi
          if [[ "$TEST_SCENARIO" == hup ]]; then kill -HUP "$$"; fi
          [[ "$TEST_SCENARIO" != replace-failed && "$TEST_SCENARIO" != rollback-busy ]] || return 1
        elif [[ "$TEST_SCENARIO" == repeated-term ]]; then
          kill -TERM "$$"
        fi
        return 0
      fi
      if [[ "$action" == run && " $* " == *' database '* ]]; then
        if [[ " $* " == *' worker-quiet '* ]]; then
          if [[ "$TEST_SCENARIO" == database-busy ]]; then return 1; fi
          if [[ "$TEST_SCENARIO" == stop-busy && -f "$SCOPED_FIXTURE/stopped-$(printf '%064d' 9)" ]]; then return 1; fi
          if [[ "$TEST_SCENARIO" == rollback-busy && "$current" == desired ]]; then return 1; fi
        fi
        if [[ "$TEST_SCENARIO" == ledger-failed && " $* " == *' pre-migration '* ]]; then return 1; fi
        if [[ "$TEST_SCENARIO" == ledger-failed && " $* " == *' worker-ledger '* ]]; then return 1; fi
        if [[ "$TEST_SCENARIO" == ledger-post-failed && "$current" == desired && " $* " == *' worker-ledger '* ]]; then return 1; fi
        if [[ "$TEST_SCENARIO" == fence-failed && " $* " == *' fence '* ]]; then return 1; fi
        if [[ "$TEST_SCENARIO" == post-migration-failed && " $* " == *' post-migration '* ]]; then return 1; fi
        if [[ "$TEST_SCENARIO" == drain-failed && " $* " == *' operations-drain '* ]]; then return 1; fi
        printf 'DATABASE_ID=11111111-1111-1111-1111-111111111111\nMIGRATION_MANIFEST_SHA256=%s\n' "$TEST_ENV_HASH"
        return 0
      fi
      if [[ "$action" == run ]]; then
        printf 'MIGRATE %s\n' "$last" >>"$SCOPED_CALLS"
        [[ "$TEST_SCENARIO" != migration-unknown ]] || return 1
        if [[ "$TEST_SCENARIO" == migration-term ]]; then kill -TERM "$$"; fi
        return 0
      fi
      return 84 ;;
    run)
      for arg in "$@"; do last="$arg"; done
      case "$last" in
        *'readFileSync'*)
          if [[ "$TEST_SCOPE" == workers-bootstrap-recovery && "$TEST_SCENARIO" == manifest-failed && " $* " == *" $TEST_OPERATIONS_IMAGE "* ]]; then printf '{"changed":true}\n'; else printf '{}\n'; fi ;;
        identity-manifest) [[ "$TEST_SCENARIO" != manifest-failed ]] ;;
        broker-quiet)
          local sample=0
          [[ ! -f "$SCOPED_FIXTURE/broker-sample" ]] || sample="$(<"$SCOPED_FIXTURE/broker-sample")"
          sample=$((sample + 1)); printf '%s' "$sample" >"$SCOPED_FIXTURE/broker-sample"
          [[ "$TEST_SCENARIO" != broker-busy ]] || return 1
          [[ "$TEST_SCENARIO" != quiet-second || "$sample" != 2 ]] || return 1
          [[ "$TEST_SCENARIO" != quiet-last || "$sample" != 3 ]] || return 1 ;;
        prepare)
          [[ "$TEST_SCENARIO" != prepare-failed ]] || return 1
          printf '{}\n' >"$scoped_work_directory/desired.json"
          printf '{}\n' >"$scoped_work_directory/rollback.json" ;;
        phase-a) printf '{}\n' >"$scoped_work_directory/phase-a.json" ;;
        evidence) [[ "$TEST_SCENARIO" != evidence-failed ]] ;;
        finalized) printf '{}\n' >"$scoped_work_directory/finalized.json" ;;
        *) return 85 ;;
      esac ;;
    *) return 86 ;;
  esac
}
scoped_deploy_main
`

function runRuntime(scope, scenario = 'success') {
	return privateFixture(directory => {
		const root = join(directory, 'app')
		for (const relative of [
			'deploy/backend', 'payload', 'release/apps/operations/prisma/migrations/20260910110000_remove_admin_backlog',
			'services/apps/operations', 'services/apps/api-gateway', 'services/apps/identity', 'services/apps/billing', 'services/apps/support',
			`deploy/backend/scoped-releases/operations-backlog/${oldRevision}`
		]) mkdirSync(join(root, relative), { recursive: true })
		const env = 'SYNTHETIC_ONLY=true\n'
		for (const relative of [
			'deploy/backend/.env.production', 'services/apps/operations/.env.production',
			'services/apps/api-gateway/.env.production', 'services/apps/identity/.env.production', 'services/apps/billing/.env.production', 'services/apps/support/.env.production'
		]) writeFileSync(join(root, relative), env, { mode: 0o600 })
		for (const owner of ['billing', 'operations', 'support']) {
			mkdirSync(join(root, `release/apps/${owner}/src/runtime`), { recursive: true })
			for (const name of ['main.ts', 'runtime/bootstrap-failure.ts']) writeFileSync(join(root, `release/apps/${owner}/src/${name}`), '// synthetic\n')
		}
		for (const name of ['phase-a.json', 'restore-evidence.json']) {
			writeFileSync(join(root, `deploy/backend/scoped-releases/operations-backlog/${oldRevision}`, name), '{}\n', { mode: 0o600 })
		}
		writeFileSync(join(root, 'release/apps/operations/prisma/migrations/20260910110000_remove_admin_backlog/migration.sql'), '-- synthetic, never executed\n')
		const calls = join(directory, 'calls')
		const phase = join(directory, 'phase')
		writeFileSync(calls, '')
		writeFileSync(phase, 'old')
		const result = spawnSync('/bin/bash', ['-c', runtimeHarness], {
			encoding: 'utf8', timeout: 10_000,
			env: {
				PATH: '/usr/bin:/bin', LANG: 'C',
				SCOPED_LIBRARY: scopedControllerPath, SCOPED_FIXTURE: directory, SCOPED_CALLS: calls, SCOPED_PHASE: phase,
				TEST_SCOPE: scope, TEST_SCENARIO: scenario, TEST_NODE: process.execPath,
				TEST_REVISION: revision, TEST_PREVIOUS_REVISION: oldRevision,
				TEST_ENV_HASH: sha256(env), TEST_EVIDENCE_HASH: sha256('{}\n'),
				TEST_OLD_IMAGE: `sha256:${'e'.repeat(64)}`, TEST_NEW_IMAGE: `sha256:${'d'.repeat(64)}`,
				TEST_OPERATIONS_IMAGE: `sha256:${'f'.repeat(64)}`, TEST_SUPPORT_IMAGE: `sha256:${'1'.repeat(64)}`
			}
		})
		assert.equal(result.error, undefined, result.stderr)
		assert.equal(result.signal, null, result.stderr)
		return { ...result, calls: readFileSync(calls, 'utf8'), phase: readFileSync(phase, 'utf8'), stopped: readdirSync(directory).filter(name => name.startsWith('stopped-')).sort() }
	})
}

function assertOnlyScopedUp(result, names, rollback = false) {
	const updates = result.calls.split('\n').filter(line => line.includes('<up>'))
	assert.equal(updates.length, rollback ? 2 : 1, result.calls)
	for (const line of updates) {
		assert.ok(line.includes('<--no-build> <--no-deps> <--force-recreate>'), line)
		assert.ok(line.endsWith(names.map(name => `<${name}>`).join(' ')), line)
	}
	assert.ok(updates[0].includes('/desired.json>'), updates[0])
	if (rollback) assert.ok(updates[1].includes('/rollback.json>'), updates[1])
}

test('worker runtime builds three images and proves all owner ledgers before seven-only replacement without DDL', () => {
	const result = runRuntime(workerScope)
	assert.equal(result.status, 0, result.stderr)
	assertOnlyScopedUp(result, SCOPED_SERVICES[workerScope])
	const lines = result.calls.split('\n')
	const builds = lines.filter(line => line.startsWith('DOCKER <build>'))
	assert.equal(builds.length, 3)
	for (const owner of ['billing', 'operations', 'support']) {
		assert.equal(builds.filter(line => line.endsWith(`/release/apps/${owner}>`)).length, 1)
		const probes = lines.filter(line => line.includes(`<database> <worker-ledger> <${owner}>`))
		assert.equal(probes.length, 2)
		assert.ok(result.calls.indexOf(probes[0]) < result.calls.indexOf('<up>'))
		assert.ok(result.calls.lastIndexOf(probes[1]) > result.calls.indexOf('<up>'))
	}
	for (const build of builds) assert.ok(result.calls.indexOf(build) < result.calls.indexOf('<up>'))
	const graceful = lines.filter(line => line.startsWith('DOCKER <kill>'))
	assert.equal(graceful.length, 7)
	for (const line of graceful) assert.ok(line.includes('<--signal=TERM>') && result.calls.indexOf(line) < result.calls.indexOf('<up>'))
	assert.ok(result.calls.indexOf('<worker-quiet>') < result.calls.indexOf('DOCKER <kill>'))
	assert.ok(!result.calls.includes('MIGRATE ') && !result.calls.includes('DOCKER <stop>'), result.calls)
})

test('worker quiet-window aborts busy work before TERM and never force-kills unconfirmed exits', () => {
	for (const scenario of ['database-busy', 'broker-busy', 'broker-unhealthy', 'broker-unavailable', 'quiet-second', 'quiet-last']) {
		const result = runRuntime(workerScope, scenario)
		assert.notEqual(result.status, 0, scenario)
		assert.ok(!result.calls.includes('DOCKER <kill>') && !result.calls.includes('<up>'), result.calls)
	}
	for (const scenario of ['stop-timeout', 'stop-interrupted', 'stop-busy']) {
		const result = runRuntime(workerScope, scenario)
		assert.notEqual(result.status, 0, scenario)
		assert.match(result.stderr, /RECOVERY_REQUIRED/)
		assert.ok(!result.calls.includes('<up>') && !result.calls.includes('DOCKER <start>'), result.calls)
		assert.ok(!result.calls.includes('<--signal=KILL>') && !result.calls.includes('DOCKER <stop>'), result.calls)
	}
	const rollback = runRuntime(workerScope, 'rollback-busy')
	assert.notEqual(rollback.status, 0)
	assertOnlyScopedUp(rollback, SCOPED_SERVICES[workerScope])
	assert.match(rollback.stderr, /CRITICAL/)
})

test('broker quiet parser rejects unacked, unconfirmed, unavailable and malformed channel samples', () => {
	const channels = Array.from({ length: 8 }, () => ({ consumer_count: 1, messages_unacknowledged: 0, messages_unconfirmed: 0, confirm: true }))
	assertBrokerQuiet(channels)
	for (const rows of [[], {}, channels.slice(0, 6), [...channels, { consumer_count: 1, messages_unacknowledged: 1, messages_unconfirmed: 0 }], [...channels, { consumer_count: 0, messages_unacknowledged: 0, messages_unconfirmed: 1 }], [...channels, { consumer_count: '0', messages_unacknowledged: 0, messages_unconfirmed: 0 }]]) assert.throws(() => assertBrokerQuiet(rows))
})

test('worker source, manifest, configuration or ledger drift cannot mutate running processes', () => {
	for (const scenario of ['source-drift', 'manifest-failed', 'prepare-failed', 'ledger-failed', 'build-failed']) {
		const result = runRuntime(workerScope, scenario)
		assert.notEqual(result.status, 0, `${scenario}: ${result.stderr}`)
		assert.ok(!result.calls.includes('<up>') && !result.calls.includes('MIGRATE ') && !result.calls.includes('DOCKER <stop>'), result.calls)
	}
})

test('worker health, interruption and post-ledger failures roll back only the preserved seven images', () => {
	for (const scenario of ['replace-failed', 'unhealthy', 'term', 'hup', 'repeated-term', 'ledger-post-failed', 'neighbor-drift']) {
		const result = runRuntime(workerScope, scenario)
		assert.notEqual(result.status, 0, scenario)
		assertOnlyScopedUp(result, SCOPED_SERVICES[workerScope], true)
		assert.match(result.stderr, /Scoped rollback restored/)
		assert.ok(!result.calls.includes('MIGRATE ') && !result.calls.includes('DOCKER <stop>'), result.calls)
	}
})

test('actual worker source allowlist rejects domain, migration, manifest, Docker, dependency and symlink changes', () => {
	privateFixture(directory => {
		const required = []
		for (const owner of ['billing', 'operations', 'support']) {
			mkdirSync(join(directory, `apps/${owner}/src/runtime`), { recursive: true })
			for (const suffix of ['main.ts', 'runtime/bootstrap-failure.ts']) {
				const path = `apps/${owner}/src/${suffix}`
				required.push(path)
				writeFileSync(join(directory, path), '// synthetic source\n')
			}
		}
		const run = files => spawnSync('/bin/bash', ['-c', `
set -euo pipefail
source "$SCOPED_LIBRARY"
release_root="$TEST_ROOT"
expected_live_revision="$TEST_OLD"
services_revision="$TEST_NEW"
git() { if [[ " $* " == *' diff '* ]]; then printf '%s\\n' "$TEST_FILES"; else printf 'synthetic unapproved old lock'; fi; }
sha256sum() { "$TEST_NODE" -e 'const fs=require("fs"),c=require("crypto"); const b=process.argv[1]?fs.readFileSync(process.argv[1]):fs.readFileSync(0); console.log(c.createHash("sha256").update(b).digest("hex"))' "$@"; }
scoped_assert_worker_source
`], { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin', SCOPED_LIBRARY: scopedControllerPath, TEST_ROOT: directory, TEST_OLD: oldRevision, TEST_NEW: revision, TEST_FILES: files.join('\n'), TEST_NODE: process.execPath } })
		assert.equal(run(required).status, 0)
		for (const path of [
			'apps/billing/src/payments/payment.service.ts', 'apps/billing/Dockerfile', 'apps/support/package.json',
			'apps/operations/prisma/schema.prisma', 'apps/operations/prisma/migrations/20260910110000_remove_admin_backlog/migration.sql',
			'apps/operations/restore-manifests/database-restore-migrations.json', 'apps/crm-access/src/main.ts',
			'apps/identity/src/main.ts', 'apps/billing/pnpm-lock.yaml', 'apps/support/pnpm-lock.yaml'
		]) assert.notEqual(run([...required, path]).status, 0, path)
		assert.notEqual(run(required.slice(1)).status, 0, 'all three bootstrap fixes must be present')
		const helper = join(directory, 'apps/billing/src/runtime/bootstrap-failure.ts')
		rmSync(helper)
		symlinkSync(join(directory, 'apps/billing/src/main.ts'), helper)
		assert.notEqual(run(required).status, 0, 'runtime helper cannot be a symlink')
	})
})

test('worker ledger proof reads only the exact owner identity and already applied migrations', async () => {
	const files = [{ name: '20260801000000_init_owner', checksum: envHash }]
	for (const owner of ['billing', 'support', 'operations']) {
		const fake = (mutate = () => {}) => {
			const data = {
				identity: [{ database: `winwidget_${owner}`, schema: owner, username: `winwidget_${owner}_migration`, recovery: false }],
				service: [{ id: 'singleton', service_name: `${owner}-service`, database_id: '11111111-1111-1111-1111-111111111111' }],
				ledger: files.map(file => ({ migration_name: file.name, checksum: file.checksum, finished_at: '2026-08-01', rolled_back_at: null }))
			}
			mutate(data)
			return {
				$queryRawUnsafe: async sql => {
					assert.match(sql, /^SELECT /)
					if (sql.includes('current_database()')) return data.identity
					assert.ok(sql.includes(`"${owner}".`), 'no cross-owner query')
					if (sql.includes('.service_identity')) return data.service
					if (sql.includes('._prisma_migrations')) return data.ledger
					assert.fail('unexpected metadata query')
				},
				...Object.fromEntries(['databaseRestoreJob', 'databaseRestorePermit', 'databaseRestoreRecoveryAction', 'outboxEvent', 'providerOperation', 'integrationDeliveryReceipt', 'scheduledJobRun', 'auditEventReceipt', 'telegramWebhookInbox', 'telegramOutboundDelivery', 'consumerReceipt'].map(name => [name, { count: async () => 0 }])),
				databaseRestoreExecutionLease: { findUnique: async () => null }
			}
		}
		await verifyDatabaseState(fake(), files, 'worker-ledger', owner)
		await verifyDatabaseState(fake(), files, 'worker-quiet', owner)
		for (const model of owner === 'billing' ? ['providerOperation', 'outboxEvent', 'integrationDeliveryReceipt'] : owner === 'operations' ? ['scheduledJobRun', 'auditEventReceipt', 'integrationDeliveryReceipt', 'outboxEvent'] : ['telegramWebhookInbox', 'telegramOutboundDelivery', 'outboxEvent', 'consumerReceipt']) {
			const busy = fake()
			busy[model].count = async input => { assert.deepEqual(input.where.status.in, model === 'providerOperation' ? ['PENDING', 'PROCESSING'] : ['PROCESSING']); return 1 }
			await assert.rejects(() => verifyDatabaseState(busy, files, 'worker-quiet', owner))
		}
		for (const mutate of [
			data => { data.identity[0].username = `winwidget_${owner}_runtime` },
			data => { data.identity[0].database = 'foreign_owner' },
			data => { data.service[0].service_name = 'foreign-service' },
			data => { data.ledger = [] },
			data => { data.ledger[0].finished_at = null },
			data => { data.ledger[0].rolled_back_at = '2026-08-02' },
			data => { data.ledger[0].checksum = 'd'.repeat(64) },
			data => { data.ledger.push({ ...data.ledger[0], migration_name: NOTES_MIGRATION }) }
		]) await assert.rejects(() => verifyDatabaseState(fake(mutate), files, 'worker-ledger', owner))
		await assert.rejects(() => verifyDatabaseState(fake(), files, 'pre-migration', owner))
	}
})

test('federation runtime is one same-image API config replacement with no worker, build or database command', () => {
	const result = runRuntime('operations-federation-config')
	assert.equal(result.status, 0, result.stderr)
	assertOnlyScopedUp(result, ['operations-api'])
	assert.ok(!result.calls.includes('MIGRATE ') && !result.calls.includes('<database>') && !result.calls.includes('DOCKER <build>') && !result.calls.includes('DOCKER <stop>'), result.calls)
	for (const scenario of ['prepare-failed', 'replace-failed', 'unhealthy', 'hup', 'neighbor-drift']) {
		const failed = runRuntime('operations-federation-config', scenario)
		assert.notEqual(failed.status, 0)
		if (scenario === 'prepare-failed') assert.ok(!failed.calls.includes('<up>'))
		else {
			assertOnlyScopedUp(failed, ['operations-api'], true)
			assert.match(failed.stderr, /Scoped rollback restored/)
		}
	}
})

test('real coordinator starts only Operations phase-A runtimes, fences writers, never migrates Notes', () => {
	const result = runRuntime('operations-runtime')
	assert.equal(result.status, 0, result.stderr)
	assertOnlyScopedUp(result, SCOPED_SERVICES['operations-runtime'])
	assert.ok(!result.calls.includes('MIGRATE '), result.calls)
	assert.ok(result.calls.indexOf('<pre-migration>') < result.calls.indexOf('<up>'))
	assert.ok(result.calls.indexOf('<fence>') > result.calls.indexOf('<up>'))
	assert.ok(result.calls.indexOf('<phase-a>') > result.calls.indexOf('<fence>'))
})

test('real Gateway coordinator reuses its image without any build or migration', () => {
	const result = runRuntime('gateway-remove-notes')
	assert.equal(result.status, 0, result.stderr)
	assertOnlyScopedUp(result, ['api-gateway'])
	assert.ok(!result.calls.includes('DOCKER <build>'), result.calls)
	assert.ok(!result.calls.includes('MIGRATE '), result.calls)
})

test('real coordinator rejects bad candidate or migration ledger before runtime replacement', () => {
	for (const scenario of ['prepare-failed', 'ledger-failed', 'build-failed', 'lost-lock']) {
		const result = runRuntime('operations-runtime', scenario)
		assert.notEqual(result.status, 0, scenario)
		assert.ok(!result.calls.includes('<up>'), `${scenario}\n${result.calls}`)
		assert.ok(!result.calls.includes('MIGRATE '), `${scenario}\n${result.calls}`)
	}
})

test('real coordinator rolls back only its target snapshots after replacement failure or TERM', () => {
	for (const scenario of ['replace-failed', 'unhealthy', 'term', 'hup', 'repeated-term']) {
		const result = runRuntime('operations-runtime', scenario)
		assert.notEqual(result.status, 0, scenario)
		assertOnlyScopedUp(result, SCOPED_SERVICES['operations-runtime'], true)
		assert.equal(result.phase, 'rollback')
		assert.match(result.stderr, /Scoped rollback restored/)
		assert.ok(!result.calls.includes('MIGRATE '), result.calls)
	}
})

test('real phase-A coordinator never restores a Notes-capable writer after the fence begins', () => {
	const result = runRuntime('operations-runtime', 'fence-failed')
	assert.notEqual(result.status, 0)
	assertOnlyScopedUp(result, SCOPED_SERVICES['operations-runtime'])
	assert.equal(result.phase, 'desired')
	assert.match(result.stderr, /recovery snapshots retained/)
})

test('real coordinator detects a changed non-target inventory at the post-cutover gate', () => {
	const result = runRuntime('gateway-remove-notes', 'neighbor-drift')
	assert.notEqual(result.status, 0)
	assert.match(result.stderr, /non-target production container\/image changed/)
	assertOnlyScopedUp(result, ['api-gateway'], true)
	assert.ok(!result.calls.includes('MIGRATE '), result.calls)
})

test('real finalization requires evidence before the single Notes migration and never replaces runtime', () => {
	const rejected = runRuntime('operations-backlog-finalize', 'evidence-failed')
	assert.notEqual(rejected.status, 0)
	assert.ok(!rejected.calls.includes('MIGRATE '), rejected.calls)
	assert.ok(!rejected.calls.includes('<up>'), rejected.calls)
	const result = runRuntime('operations-backlog-finalize')
	assert.equal(result.status, 0, result.stderr)
	assert.ok(!result.calls.includes('<up>'), result.calls)
	assert.deepEqual(result.calls.split('\n').filter(line => line.startsWith('MIGRATE ')), ['MIGRATE operations-migrate'])
	assert.ok(result.calls.indexOf('<evidence>') < result.calls.indexOf('MIGRATE operations-migrate'))
	assert.ok(result.calls.indexOf('<post-migration>') > result.calls.indexOf('MIGRATE operations-migrate'))
	const failed = runRuntime('operations-backlog-finalize', 'post-migration-failed')
	assert.notEqual(failed.status, 0)
	assert.ok(!failed.calls.includes('<up>'), failed.calls)
	assert.match(failed.stderr, /recovery snapshots retained/)
})

test('coordinated Identity deployment builds and verifies both images before fencing four Operations processes', () => {
	const result = runRuntime(identityScope)
	assert.equal(result.status, 0, result.stderr)
	assertOnlyScopedUp(result, SCOPED_SERVICES[identityScope])
	assert.deepEqual(result.calls.split('\n').filter(line => line.startsWith('MIGRATE ')), ['MIGRATE identity-migrate'])
	const builds = result.calls.split('\n').filter(line => line.startsWith('DOCKER <build>'))
	assert.equal(builds.length, 2)
	assert.ok(builds[0].includes('winwidget-identity:'))
	assert.ok(builds[1].includes('winwidget-operations:'))
	const stop = result.calls.indexOf('DOCKER <stop>')
	assert.ok(result.calls.lastIndexOf('DOCKER <build>') < stop)
	assert.ok(result.calls.indexOf('<identity-manifest>') < stop)
	assert.ok(result.calls.indexOf('<prepare>') < stop)
	assert.ok(result.calls.indexOf('<pre-migration>') < stop)
	assert.ok(result.calls.indexOf('<operations-drain>') > stop)
	assert.ok(result.calls.indexOf('MIGRATE identity-migrate') > result.calls.indexOf('<operations-drain>'))
	assert.ok(result.calls.indexOf('<up>') > result.calls.indexOf('<post-migration>'))
	const stops = result.calls.split('\n').filter(line => line.startsWith('DOCKER <stop>'))
	assert.equal(stops.length, 1)
	assert.ok(stops[0].endsWith([1, 2, 3, 4].map(number => `<${String(number).padStart(64, '0')}>`).join(' ')))
	assert.deepEqual(result.stopped, [])
})

test('companion drift or failed manifest validation cannot stop a live process or migrate Identity', () => {
	for (const scenario of ['companion-drift', 'manifest-failed']) {
		const result = runRuntime(identityScope, scenario)
		assert.notEqual(result.status, 0)
		assert.ok(!result.calls.includes('DOCKER <stop>'), result.calls)
		assert.ok(!result.calls.includes('<up>'), result.calls)
		assert.ok(!result.calls.includes('MIGRATE '), result.calls)
	}
})

test('failed pre-DDL Operations drain resumes only the unchanged four Operations IDs', () => {
	for (const scenario of ['drain-failed', 'still-running']) {
		const result = runRuntime(identityScope, scenario)
		assert.notEqual(result.status, 0)
		assert.ok(!result.calls.includes('MIGRATE '), result.calls)
		assert.ok(!result.calls.includes('<up>'), result.calls)
		const starts = result.calls.split('\n').filter(line => line.startsWith('DOCKER <start>'))
		assert.deepEqual(starts, [`DOCKER <start> ${[1, 2, 3, 4].map(number => `<${String(number).padStart(64, '0')}>`).join(' ')}`])
		assert.deepEqual(result.stopped, [])
	}
})

test('successful or unknown Identity DDL never restores any old Operations manifest', () => {
	for (const scenario of ['migration-unknown', 'migration-term', 'post-migration-failed', 'replace-failed', 'unhealthy', 'term', 'hup']) {
		const result = runRuntime(identityScope, scenario)
		assert.notEqual(result.status, 0, scenario)
		assert.ok(result.calls.includes('MIGRATE identity-migrate'), `${scenario}\n${result.calls}`)
		assert.ok(!result.calls.includes('/rollback.json>'), result.calls)
		assert.ok(!result.calls.includes('DOCKER <start>'), result.calls)
		assert.match(result.stderr, /RECOVERY_REQUIRED: Operations remains fenced/)
		assert.deepEqual(result.stopped, [1, 2, 3, 4].map(number => `stopped-${String(number).padStart(64, '0')}`))
	}
})

function runTransport(scenario = 'success') {
	return privateFixture(directory => {
		const checkout = join(directory, 'infra')
		const bin = join(directory, 'bin')
		const trace = join(directory, 'transport.jsonl')
		for (const relative of ['.git', 'scripts', 'nginx']) mkdirSync(join(checkout, relative), { recursive: true })
		mkdirSync(bin)
		for (const relative of [
			'scripts/deploy-services-production.sh', 'scripts/deploy-identity-operations-scoped.sh',
			'scripts/scoped-service-release.mjs', 'nginx/backend-api.conf', 'nginx/frontend.conf'
		]) {
			if (scenario === 'missing-payload' && relative === 'scripts/scoped-service-release.mjs') continue
			writeFileSync(join(checkout, relative), readFileSync(join(scriptsRoot, '..', relative)))
		}
		const shim = `#!${process.execPath}
const fs = require('node:fs'), crypto = require('node:crypto'), path = require('node:path');
const name = path.basename(process.argv[1]), args = process.argv.slice(2), scenario = process.env.TEST_SCENARIO;
if (name === 'git') {
  if (args.includes('rev-parse') && args.includes('HEAD')) process.stdout.write(process.env.TEST_REVISION + '\\n');
  else if (args.includes('status')) {}
  else if (args.includes('remote') && args.includes('get-url')) process.stdout.write('https://github.com/nda17/winwidget.ru_infra.git\\n');
  else if (args.includes('ls-files')) {
    if (scenario === 'untracked-payload' && args.at(-1) === 'scripts/scoped-service-release.mjs') process.exit(1);
  } else process.exit(81);
} else if (name === 'sha256sum') {
  for (const filename of args) {
    const hash = scenario === 'invalid-payload-hash' && filename.endsWith('deploy-identity-operations-scoped.sh')
      ? 'not-a-hash' : crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
    process.stdout.write(hash + '  ' + filename + '\\n');
  }
} else if (name === 'ssh-keygen') {
  // Deliberately no real key material: this boundary only admits a synthetic fixture.
} else if (name === 'ssh') {
  const stdin = fs.readFileSync(0, 'utf8');
  fs.appendFileSync(process.env.TEST_TRANSPORT_TRACE, JSON.stringify({ args, stdin }) + '\\n');
} else process.exit(82);
`
		for (const name of ['git', 'sha256sum', 'ssh-keygen', 'ssh']) writeFileSync(join(bin, name), shim, { mode: 0o700 })
		const identity = join(directory, 'synthetic-key')
		const knownHosts = join(directory, 'synthetic-known-hosts')
		writeFileSync(identity, 'synthetic fixture, not a private key\n', { mode: 0o600 })
		writeFileSync(knownHosts, 'synthetic fixture, not a host credential\n', { mode: 0o600 })
		const optionalFrontend = scenario === 'forbidden-frontend' ? {
			FRONTEND_PRODUCTION_SSH_HOST: 'another-synthetic.invalid', FRONTEND_PRODUCTION_SSH_PORT: '22',
			FRONTEND_PRODUCTION_SSH_USER: 'root', FRONTEND_PRODUCTION_SSH_IDENTITY_FILE: identity,
			FRONTEND_PRODUCTION_SSH_KNOWN_HOSTS_FILE: knownHosts
		} : {}
		const result = spawnSync('/bin/bash', [join(checkout, 'scripts/deploy-services-production.sh'), revision], {
			encoding: 'utf8', timeout: 10_000,
			env: {
				PATH: `${bin}:/usr/bin:/bin`, LANG: 'C',
				TEST_SCENARIO: scenario, TEST_REVISION: revision, TEST_TRANSPORT_TRACE: trace,
				INFRA_REVISION: revision, RELEASE_SCOPE: identityScope,
				EXPECTED_LIVE_REVISION: oldRevision, EXPECTED_SERVICE_ENV_SHA256: envHash,
				EXPECTED_OPERATIONS_REVISION: oldRevision, EXPECTED_OPERATIONS_ENV_SHA256: envHash,
				PRODUCTION_SSH_HOST: 'synthetic.invalid', PRODUCTION_SSH_PORT: '2222', PRODUCTION_SSH_USER: 'root',
				PRODUCTION_SSH_IDENTITY_FILE: identity, PRODUCTION_SSH_KNOWN_HOSTS_FILE: knownHosts,
				EXPECTED_PRODUCTION_ENV_SHA256: envHash,
				...optionalFrontend
			}
		})
		assert.equal(result.error, undefined, result.stderr)
		assert.equal(result.signal, null, result.stderr)
		const calls = existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
		return { ...result, calls, identity, knownHosts }
	})
}

test('actual transport sends both exact tracked payloads through one pinned SSH and no frontend stage', () => {
	const result = runTransport()
	assert.equal(result.status, 0, result.stderr)
	assert.equal(result.calls.length, 1)
	const { args, stdin } = result.calls[0]
	for (const option of [
		'StrictHostKeyChecking=yes', `UserKnownHostsFile=${result.knownHosts}`,
		'ForwardAgent=no', 'IdentitiesOnly=yes', 'PasswordAuthentication=no', 'PermitLocalCommand=no'
	]) assert.ok(args.includes(option), option)
	assert.deepEqual(args.slice(0, 2), ['-F', '/dev/null'])
	assert.ok(args.includes(result.identity))
	assert.equal(args.at(-2), 'root@synthetic.invalid')
	const command = args.at(-1)
	assert.ok(command.includes('cat >"$controller_file"'))
	assert.ok(command.includes(' </dev/null'))
	const encodedArguments = command.match(/bash "\$controller_file" (.+) <\/dev\/null/)
	assert.ok(encodedArguments, 'remote command stages its complete stdin before execution')
	// All admitted parameters are hex/base64, scope names, or empty shell tokens.
	// Decode only this constrained argument list; never evaluate the SSH command.
	const parameters = encodedArguments[1].split(' ').map(value => value === "''" ? '' : value)
	assert.equal(parameters.length, 17)
	assert.deepEqual(parameters.slice(0, 3), [revision, revision, envHash])
	assert.deepEqual(parameters.slice(5, 10), [identityScope, oldRevision, envHash, '', ''])
	assert.deepEqual(parameters.slice(14), [oldRevision, envHash, ''])
	for (const [hashIndex, encodedIndex, filename] of [
		[10, 11, 'deploy-identity-operations-scoped.sh'], [12, 13, 'scoped-service-release.mjs']
	]) {
		const original = readFileSync(join(scriptsRoot, filename))
		assert.equal(parameters[hashIndex], sha256(original))
		assert.deepEqual(Buffer.from(parameters[encodedIndex], 'base64'), original)
	}
	assert.ok(stdin.includes('scoped_deploy_main'))
	assert.ok(stdin.includes('Scoped payload checksum mismatch'))
	assert.ok(!stdin.includes('FRONTEND_CONTROLLER'))
})

test('actual transport rejects missing/untracked/malformed payload and optional frontend before SSH', () => {
	for (const scenario of ['missing-payload', 'untracked-payload', 'invalid-payload-hash', 'forbidden-frontend']) {
		const result = runTransport(scenario)
		assert.notEqual(result.status, 0, scenario)
		assert.deepEqual(result.calls, [], `${scenario} must fail before any SSH invocation`)
	}
})

test('real inventory helpers fail closed when their Docker/find producer fails', () => {
	for (const helper of ['scoped_inventory', 'scoped_env_inventory']) {
		const result = spawnSync('/bin/bash', ['-c', `
set -euo pipefail
source "$SCOPED_LIBRARY"
scoped_targets=(operations-api)
services_repository=/synthetic-missing-fixture
docker() { return 71; }
find() { return 72; }
assert_root_owned_file() { return 73; }
${helper}
`], { encoding: 'utf8', timeout: 5_000, env: { PATH: '/usr/bin:/bin', LANG: 'C', SCOPED_LIBRARY: scopedControllerPath } })
		assert.equal(result.error, undefined)
		assert.notEqual(result.status, 0, `${helper} cannot silently admit an unreadable neighbor inventory`)
	}
})
