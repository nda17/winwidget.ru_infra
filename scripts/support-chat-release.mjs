import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, lstatSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'
import { spawnSync } from 'node:child_process'
import { assertServiceConfiguration, migrationFiles } from './scoped-service-release.mjs'
import { SUPPORT_CHAT_KINDS, provisionSupportChatBroker, verifySupportChatBroker } from './support-chat-broker.mjs'

// Readers stay installed on rollback once an additive migration is applied.
// Product activation is a separately reviewed configuration operation.
export const SUPPORT_CHAT_TARGETS = Object.freeze([
	['winwidget', 'identity-api', 'identity'],
	['winwidget-crm', 'crm-access-api', 'crm-access'],
	['winwidget', 'operations-api', 'operations'],
	['winwidget', 'operations-worker', 'operations'],
	['winwidget', 'operations-outbox-publisher', 'operations'],
	['winwidget', 'operations-restore-worker', 'operations'],
	['winwidget', 'notification-delivery-worker', 'notification-delivery'],
	['winwidget', 'support-api', 'support'],
	['winwidget', 'support-worker', 'support'],
	['winwidget', 'support-outbox-publisher', 'support'],
	['winwidget', 'api-gateway', 'api-gateway']
])
export const SUPPORT_CHAT_ENV_NAMES = Object.freeze(['canonical', 'identity', 'notificationDelivery', 'operations', 'support', 'crm'])
export const SUPPORT_CHAT_MIGRATIONS = Object.freeze({
	'notification-delivery': ['20260909010000_add_support_notifications'],
	support: ['20260909160000_add_web_support_chat']
})
const deferredOperationsMigration = '20260910110000_remove_admin_backlog'
const hash = value => createHash('sha256').update(value).digest('hex')
const jsonHash = value => hash(JSON.stringify(value))
const sorted = rows => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
const keyOf = row => `${row.Config?.Labels?.['com.docker.compose.project']}/${row.Config?.Labels?.['com.docker.compose.service']}`
const targetKeys = SUPPORT_CHAT_TARGETS.map(([project, service]) => `${project}/${service}`)
const environment = rows => {
	assert.ok(Array.isArray(rows))
	const pairs = rows.map(row => { const index = row.indexOf('='); assert.ok(index > 0); return [row.slice(0, index), row.slice(index + 1)] })
	assert.equal(new Set(pairs.map(row => row[0])).size, pairs.length)
	return Object.fromEntries(pairs)
}
const environmentHash = env => jsonHash(Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))))
const stableContainer = row => ({ id: row.Id, image: row.Image, config: row.Config, host: row.HostConfig,
	mounts: sorted(row.Mounts ?? []), restartCount: row.RestartCount, startedAt: row.State.StartedAt,
	running: row.State.Running, status: row.State.Status, health: row.State.Health?.Status ?? null })
function checkInventory(containers) {
	assert.ok(Array.isArray(containers) && containers.length >= SUPPORT_CHAT_TARGETS.length && containers.length <= 200)
	assert.equal(new Set(containers.map(row => row.Id)).size, containers.length)
	for (const row of containers) {
		assert.match(row.Id, /^[a-f0-9]{64}$/); assert.match(row.Image, /^sha256:[a-f0-9]{64}$/)
		assert.equal(row.State.Running, true); assert.equal(row.State.Status, 'running')
		if (['winwidget', 'winwidget-crm'].includes(row.Config.Labels?.['com.docker.compose.project'])) assert.equal(row.State.Health?.Status, 'healthy')
	}
	for (const key of targetKeys) assert.equal(containers.filter(row => keyOf(row) === key).length, 1)
}
export function supportChatNeighbors(containers) {
	checkInventory(containers)
	return jsonHash(sorted(containers.filter(row => !targetKeys.includes(keyOf(row))).map(stableContainer)))
}
export function supportChatBaseline({ containers, envHashes, gatewayRevision }) {
	checkInventory(containers)
	assert.match(gatewayRevision, /^[a-f0-9]{40}$/)
	assert.deepEqual(Object.keys(envHashes).sort(), [...SUPPORT_CHAT_ENV_NAMES].sort())
	const hashes = Object.fromEntries(SUPPORT_CHAT_ENV_NAMES.map(name => { assert.match(envHashes[name], /^[a-f0-9]{64}$/); return [name, envHashes[name]] }))
	const targets = SUPPORT_CHAT_TARGETS.map(([project, service]) => {
		const row = containers.find(item => keyOf(item) === `${project}/${service}`)
		const revision = row.Config.Labels['org.opencontainers.image.revision']
		assert.match(revision, /^[a-f0-9]{40}$/)
		if (service === 'api-gateway') assert.equal(revision, gatewayRevision)
		assert.equal(environment(row.Config.Env).APP_REVISION, revision)
		return { project, service, id: row.Id, image: row.Image, revision,
			environmentSha256: environmentHash(environment(row.Config.Env)), configurationSha256: jsonHash(stableContainer(row)) }
	})
	return { version: 'support-chat-v1', gatewayRevision, envHashes: hashes, targets, neighborsSha256: supportChatNeighbors(containers) }
}
export const supportChatBaselineSha256 = input => jsonHash(supportChatBaseline(input))

export function assertSupportChatFence({ before, live, desired, images, updated = [], paused = [] }) {
	assert.deepEqual([...new Set(updated)], updated)
	assert.ok(updated.every(name => SUPPORT_CHAT_TARGETS.some(row => row[1] === name)))
	assert.ok(paused.every(name => ['operations-worker', 'operations-restore-worker'].includes(name)))
	assert.equal(live.length, before.length)
	assert.equal(new Set(live.map(row => row.Id)).size, live.length)
	const peers = rows => sorted(rows.filter(row => !targetKeys.includes(keyOf(row))).map(stableContainer))
	assert.deepEqual(peers(live), peers(before))
	for (const [project, name, owner] of SUPPORT_CHAT_TARGETS) {
		const rows = live.filter(row => keyOf(row) === `${project}/${name}`)
		assert.equal(rows.length, 1)
		const row = rows[0], original = before.find(item => keyOf(item) === keyOf(row))
		if (paused.includes(name)) {
			assert.equal(row.Id, original.Id); assert.equal(row.Image, original.Image)
			assert.deepEqual(row.Config, original.Config); assert.deepEqual(row.HostConfig, original.HostConfig)
			assert.equal(row.State.Running, false)
			continue
		}
		assert.equal(row.State.Running, true); assert.equal(row.State.Health?.Status, 'healthy')
		if (!updated.includes(name)) { assert.deepEqual(stableContainer(row), stableContainer(original)); continue }
		const service = desired[project].services[name], image = images.find(item => item.Id === service.image)
		assert.ok(image); assert.equal(row.Image, service.image)
		assert.equal(row.Config.Labels['org.opencontainers.image.revision'], service.environment.APP_REVISION)
		assertServiceConfiguration(service, row, image, desired[project].secrets)
		assert.deepEqual(environment(row.Config.Env), { ...environment(image.Config.Env ?? []), ...service.environment })
		assert.equal(row.Config.Labels['com.winwidget.owner'] ?? owner, original.Config.Labels['com.winwidget.owner'] ?? owner)
	}
}

export function assertSupportChatRoute(before, after) {
	const previous = JSON.parse(before), next = JSON.parse(after)
	assert.ok(Array.isArray(previous) && Array.isArray(next))
	const isSupport = row => row.pathPrefix === '/api/v1/support'
	assert.ok(previous.filter(isSupport).length <= 1)
	assert.equal(next.filter(isSupport).length, 1)
	assert.deepEqual(next.filter(row => !isSupport(row)), previous.filter(row => !isSupport(row)))
	if (previous.some(isSupport)) assert.deepEqual(next, previous)
	const route = next.find(isSupport)
	assert.deepEqual(Object.keys(route).sort(), ['authPolicy', 'id', 'pathPrefix', 'timeoutMs', 'upstreamUrl'].sort())
	assert.equal(route.id, 'support-web-chat')
	assert.equal(route.upstreamUrl, 'http://127.0.0.1:5100')
	assert.equal(route.authPolicy, 'required')
	assert.equal(route.timeoutMs, 30000)
	for (const row of next.filter(row => row.pathPrefix.startsWith('/api/v1/support/'))) {
		assert.equal(row.pathPrefix, '/api/v1/support/admin')
		assert.equal(row.authPolicy, 'required')
		assert.ok(previous.some(item => JSON.stringify(item) === JSON.stringify(row)))
	}
	assert.ok(!next.some(row => row.pathPrefix.startsWith('/api/v1/internal')))
}
const supportApiKeys = ['SUPPORT_NOTIFICATION_DELIVERY_TOKEN', 'SUPPORT_CRM_ACCESS_BASE_URL', 'SUPPORT_CRM_ACCESS_TOKEN',
	'SUPPORT_S3_ENDPOINT', 'SUPPORT_S3_REGION', 'SUPPORT_S3_BUCKET', 'SUPPORT_S3_FORCE_PATH_STYLE', 'SUPPORT_S3_ACCESS_KEY_ID', 'SUPPORT_S3_SECRET_ACCESS_KEY']
const ndKeys = ['SUPPORT_INTERNAL_BASE_URL', 'SUPPORT_NOTIFICATION_DELIVERY_TOKEN', 'TELEGRAM_SUPPORT_BOT_TOKEN']
function allowedEnv(name, activation = false) {
	if (activation) {
		if (name === 'support-api') return ['SUPPORT_WEB_CHAT_ENABLED', 'CORS_ALLOWED_ORIGINS']
		if (name.startsWith('support-')) return ['SUPPORT_WEB_CHAT_ENABLED']
		if (name === 'notification-delivery-worker') return ['NOTIFICATION_DELIVERY_KINDS']
		return []
	}
	if (name === 'support-api') return ['SUPPORT_WEB_CHAT_ENABLED', ...supportApiKeys]
	if (name.startsWith('support-')) return ['SUPPORT_WEB_CHAT_ENABLED']
	if (name === 'notification-delivery-worker') return ndKeys
	if (name === 'crm-access-api') return ['CRM_ACCESS_SUPPORT_TOKEN']
	if (name === 'api-gateway') return ['GATEWAY_ROUTES_JSON']
	return []
}
const token = value => assert.ok(typeof value === 'string' && /^[a-f0-9]{48,128}$/.test(value))
export function prepareSupportChatCompose({ containers, composes, images, revision, envHashes, gatewayRevision, expectedBaselineSha256, activation = false }) {
	assert.equal(typeof activation, 'boolean')
	assert.match(revision, /^[a-f0-9]{40}$/)
	assert.equal(supportChatBaselineSha256({ containers, envHashes, gatewayRevision }), expectedBaselineSha256)
	const desired = { winwidget: { name: 'winwidget', services: {}, volumes: {}, secrets: {} }, 'winwidget-crm': { name: 'winwidget-crm', services: {}, volumes: {}, secrets: {} } }
	const rollback = structuredClone(desired)
	for (const [project, name, owner] of SUPPORT_CHAT_TARGETS) {
		const live = containers.find(row => keyOf(row) === `${project}/${name}`)
		const targetRevision = activation ? live.Config.Labels['org.opencontainers.image.revision'] : revision
		const service = structuredClone(composes[owner].services[name])
		const matchingImages = images.filter(row => row.Id === service.image || (name === 'api-gateway'
			&& service.image === `winwidget-api-gateway:git-${targetRevision}` && row.RepoTags?.includes(service.image)))
		assert.equal(matchingImages.length, 1)
		const image = matchingImages[0]
		assert.equal(image.Config.Labels['org.opencontainers.image.revision'], targetRevision)
		if (activation) assert.equal(image.Id, live.Image)
		service.image = image.Id
		assertServiceConfiguration(service, live, image, composes[owner].secrets ?? {})
		const before = environment(live.Config.Env), imageEnv = environment(image.Config.Env ?? [])
		const candidate = { ...imageEnv, ...service.environment }
		const allowed = new Set(['APP_REVISION', ...allowedEnv(name, activation)])
		for (const key of new Set([...Object.keys(before), ...Object.keys(candidate)])) {
			if (allowed.has(key)) continue
			// Compose may omit image defaults inherited by the existing image.
			// Preserve the exact live environment for every unrelated key.
			if (Object.hasOwn(service.environment, key)) assert.equal(service.environment[key], before[key])
		}
		const after = { ...before, APP_REVISION: targetRevision }
		for (const key of allowedEnv(name, activation)) {
			assert.equal(typeof service.environment[key], 'string')
			after[key] = service.environment[key]
		}
		if (name.startsWith('support-')) {
			if (activation) assert.ok(['true', 'false'].includes(before.SUPPORT_WEB_CHAT_ENABLED))
			assert.equal(after.SUPPORT_WEB_CHAT_ENABLED, activation ? 'true' : 'false')
		}
		if (activation && name === 'support-api') {
			assert.equal(typeof before.CORS_ALLOWED_ORIGINS, 'string')
			const crmOrigin = 'https://crm.winwidget.ru'
			const origins = before.CORS_ALLOWED_ORIGINS.split(',').map(value => value.trim())
			assert.ok(origins.length > 0 && origins.every(Boolean))
			assert.equal(after.CORS_ALLOWED_ORIGINS, origins.includes(crmOrigin)
				? before.CORS_ALLOWED_ORIGINS : before.CORS_ALLOWED_ORIGINS + ',' + crmOrigin)
		}
		if (name === 'api-gateway' && !activation) assertSupportChatRoute(before.GATEWAY_ROUTES_JSON, after.GATEWAY_ROUTES_JSON)
		if (name === 'notification-delivery-worker') {
			const kinds = SUPPORT_CHAT_KINDS.map(row => row[0]), beforeKinds = before.NOTIFICATION_DELIVERY_KINDS.split(',')
			const existingSupportKinds = beforeKinds.filter(kind => kinds.includes(kind))
			assert.ok(existingSupportKinds.length === 0 || (activation && JSON.stringify(existingSupportKinds) === JSON.stringify(kinds)))
			const baseKinds = beforeKinds.filter(kind => !kinds.includes(kind))
			assert.equal(after.NOTIFICATION_DELIVERY_KINDS, activation ? [...baseKinds, ...kinds].join(',') : before.NOTIFICATION_DELIVERY_KINDS)
			assert.equal(after.SUPPORT_INTERNAL_BASE_URL, 'http://127.0.0.1:5100')
		}
		delete service.build; delete service.depends_on; delete service.profiles
		service.environment = after
		service.labels = { ...service.labels, 'org.opencontainers.image.revision': targetRevision }
		desired[project].services[name] = service
		rollback[project].services[name] = { ...structuredClone(service), image: live.Image, environment: before,
			labels: { ...service.labels, 'org.opencontainers.image.revision': live.Config.Labels['org.opencontainers.image.revision'] } }
		for (const target of [desired[project], rollback[project]]) {
			for (const value of service.secrets ?? []) target.secrets[value.source] = composes[owner].secrets[value.source]
			for (const value of service.volumes ?? []) if (value.type === 'volume') target.volumes[value.source] = composes[owner].volumes[value.source]
		}
	}
	const env = name => Object.values(desired).flatMap(row => Object.entries(row.services)).find(([key]) => key === name)[1].environment
	const support = env('support-api'), nd = env('notification-delivery-worker'), crm = env('crm-access-api')
	assert.equal(support.SUPPORT_CRM_ACCESS_BASE_URL, 'http://127.0.0.1:5300')
	for (const key of ['SUPPORT_CRM_ACCESS_TOKEN', 'SUPPORT_NOTIFICATION_DELIVERY_TOKEN']) token(support[key])
	assert.notEqual(support.SUPPORT_CRM_ACCESS_TOKEN, support.SUPPORT_NOTIFICATION_DELIVERY_TOKEN)
	assert.equal(support.SUPPORT_CRM_ACCESS_TOKEN, crm.CRM_ACCESS_SUPPORT_TOKEN)
	assert.equal(support.SUPPORT_NOTIFICATION_DELIVERY_TOKEN, nd.SUPPORT_NOTIFICATION_DELIVERY_TOKEN)
	assert.equal(support.TELEGRAM_SUPPORT_BOT_TOKEN, nd.TELEGRAM_SUPPORT_BOT_TOKEN)
	assert.equal(support.IDENTITY_SUPPORT_TOKEN, env('identity-api').IDENTITY_SUPPORT_TOKEN)
	if (activation) {
		for (const key of supportApiKeys) assert.ok(support[key])
		const endpoint = new URL(support.SUPPORT_S3_ENDPOINT)
		assert.equal(endpoint.protocol, 'https:'); assert.equal(endpoint.href, endpoint.origin + '/')
		assert.ok(!endpoint.username && !endpoint.password)
	}
	for (const [project, name] of SUPPORT_CHAT_TARGETS) {
		const values = desired[project].services[name].environment
		if (name !== 'support-api') for (const key of supportApiKeys.filter(key => key.startsWith('SUPPORT_S3_'))) assert.equal(Object.hasOwn(values, key), false)
	}
	return { desired, rollback, neighborsSha256: supportChatNeighbors(containers) }
}

export const SUPPORT_CHAT_PAYLOAD_FILES = Object.freeze(['support-chat-release.mjs', 'support-chat-broker.mjs', 'scoped-service-release.mjs'])
export function supportChatPayload(directory) {
	return { schemaVersion: 1, files: SUPPORT_CHAT_PAYLOAD_FILES.map(name => {
		const path = resolve(directory, name)
		assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink())
		const content = readFileSync(path, 'utf8')
		assert.ok(Buffer.byteLength(content) <= (name === 'scoped-service-release.mjs' ? 147456 : 131072))
		return { name, sha256: hash(content), content }
	}) }
}

const migrationKey = owner => owner === 'notification-delivery' ? 'NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION' : owner.replaceAll('-', '_').toUpperCase() + '_MIGRATION_DATABASE_URL'
const databaseOwner = owner => {
	assert.ok(['identity', 'crm-access', 'operations', 'notification-delivery', 'support'].includes(owner))
	return owner.replaceAll('-', '_')
}
export function supportChatMigrationLedger(rows) {
	assert.ok(Array.isArray(rows))
	const applied = []
	for (const row of rows) {
		assert.equal(typeof row.finished, 'boolean'); assert.equal(typeof row.rolledBack, 'boolean')
		// A resolved failed attempt is historical evidence, not an applied migration.
		if (row.rolledBack) continue
		assert.equal(row.finished, true)
		applied.push({ name: row.name, checksum: row.checksum })
	}
	return applied
}
async function databaseAction(action, owner) {
	databaseOwner(owner)
	assert.ok(['database-preflight', 'database-migrate'].includes(action))
	let stage = 'SOURCE_READ'
	try {
		await databaseActionSteps(action, owner, value => { stage = value })
	} catch {
		process.stderr.write(`Support database ${owner} ${action} failed at ${stage}.\n`)
		throw new Error('Support database contract failed')
	}
}
async function databaseActionSteps(action, owner, setStage) {
	const schema = databaseOwner(owner), prefix = schema.toUpperCase()
	const source = migrationFiles('/app/prisma/migrations')
	setStage('URL_VALIDATE')
	const url = new URL(process.env[migrationKey(owner)] ?? '')
	assert.equal(url.protocol, 'postgresql:'); assert.equal(url.hostname, '127.0.0.1')
	assert.equal(url.port, { identity: '55438', 'crm-access': '55442', operations: '55441', 'notification-delivery': '55432', support: '55440' }[owner])
	assert.equal(url.pathname, '/winwidget_' + schema); assert.equal(url.searchParams.get('schema'), schema)
	assert.equal(decodeURIComponent(url.username), 'winwidget_' + schema + '_migration')
	assert.ok(url.password && !url.hash)
	for (const key of url.searchParams.keys()) {
		assert.ok(['schema', 'sslmode', 'connection_limit', 'pool_timeout', 'connect_timeout'].includes(key))
		assert.equal(url.searchParams.getAll(key).length, 1)
	}
	assert.equal(url.searchParams.get('sslmode'), 'disable')
	setStage('CLIENT_INIT')
	const { PrismaClient } = createRequire('/app/package.json')('@prisma/' + owner + '-client')
	const client = new PrismaClient({ datasources: { db: { url: url.href } }, log: [] })
	const ledger = async () => {
		setStage('PG_VERSION')
		assert.match((await client.$queryRawUnsafe('SHOW server_version_num'))[0].server_version_num, /^18\d{4}$/)
		setStage('PG_IDENTITY')
		const identity = await client.$queryRawUnsafe('SELECT current_database() AS database, current_user AS username, current_schema() AS schema, pg_is_in_recovery() AS recovery')
		assert.deepEqual(identity, [{ database: 'winwidget_' + schema, username: 'winwidget_' + schema + '_migration', schema, recovery: false }])
		setStage('LEDGER_READ')
		const rows = await client.$queryRawUnsafe(`SELECT migration_name AS name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS "rolledBack" FROM "${schema}"._prisma_migrations ORDER BY migration_name`)
		setStage('LEDGER_STATUS')
		return supportChatMigrationLedger(rows)
	}
	try {
		const before = await ledger(), allowed = owner === 'operations' ? [deferredOperationsMigration] : SUPPORT_CHAT_MIGRATIONS[owner] ?? []
		setStage('LEDGER_COMPARE')
		const missing = source.filter(row => !before.some(item => item.name === row.name))
		assert.ok(missing.every(row => allowed.includes(row.name)))
		assert.deepEqual(before, source.filter(row => before.some(item => item.name === row.name)))
		if (action === 'database-preflight') return
		assert.equal(action, 'database-migrate'); assert.ok(Object.hasOwn(SUPPORT_CHAT_MIGRATIONS, owner))
		if (missing.length) {
			setStage('MIGRATION_DEPLOY')
			await client.$disconnect()
			const result = spawnSync('/app/node_modules/.bin/prisma', ['migrate', 'deploy', '--schema', '/app/prisma/schema.prisma'], {
				cwd: '/app', env: { PATH: process.env.PATH, NODE_ENV: 'production', [prefix + '_DATABASE_URL']: url.href }, stdio: 'ignore', timeout: 180000
			})
			assert.equal(result.status, 0)
		}
		const after = await ledger()
		setStage('POST_MIGRATION_COMPARE')
		assert.deepEqual(after, source)
		if (owner === 'support') {
			setStage('RUNTIME_GRANTS')
			await client.$executeRawUnsafe('REVOKE ALL ON support.web_conversations, support.web_commands, support.web_read_states, support.web_attachments, support.web_notification_settings, support.web_notification_intents, support.web_messages, support.web_rate_buckets FROM winwidget_support_runtime')
			await client.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE ON support.web_conversations, support.web_commands, support.web_read_states, support.web_attachments, support.web_notification_settings, support.web_notification_intents TO winwidget_support_runtime')
			await client.$executeRawUnsafe('GRANT SELECT, INSERT ON support.web_messages TO winwidget_support_runtime')
			await client.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON support.web_rate_buckets TO winwidget_support_runtime')
			await client.$executeRawUnsafe('REVOKE ALL ON SEQUENCE support.web_conversations_number_seq FROM winwidget_support_runtime')
			await client.$executeRawUnsafe('GRANT USAGE, SELECT ON SEQUENCE support.web_conversations_number_seq TO winwidget_support_runtime')
			setStage('BACKUP_GRANTS')
			await client.$executeRawUnsafe('GRANT SELECT ON support.web_conversations, support.web_commands, support.web_read_states, support.web_attachments, support.web_notification_settings, support.web_notification_intents, support.web_messages, support.web_rate_buckets TO winwidget_support_backup')
			await client.$executeRawUnsafe('GRANT SELECT ON SEQUENCE support.web_conversations_number_seq TO winwidget_support_backup')
		}
	} finally { await client.$disconnect() }
}

async function operationsQuiet() {
	assert.equal(process.env.DATABASE_RESTORE_ENABLED, 'false')
	const { PrismaClient } = createRequire('/app/package.json')('@prisma/operations-client')
	const client = new PrismaClient({ datasources: { db: { url: process.env.OPERATIONS_DATABASE_URL } }, log: [] })
	try {
		const [runs, jobs, lease] = await Promise.all([
			client.scheduledJobRun.count({ where: { status: { in: ['QUEUED', 'PROCESSING'] } } }),
			client.databaseRestoreJob.count({ where: { status: { in: ['QUEUED', 'PROCESSING', 'RECOVERY_REQUIRED'] } } }),
			client.databaseRestoreExecutionLease.findUnique({ where: { id: 'singleton' } })
		])
		assert.equal(runs, 0); assert.equal(jobs, 0)
		if (lease) for (const key of ['operationType', 'operationId', 'leaseOwner', 'leaseToken']) assert.equal(lease[key], null)
	} finally { await client.$disconnect() }
}

export function assertSupportChatManifests(before, after) {
	assert.equal(before.schemaVersion, 1); assert.equal(after.schemaVersion, 1)
	assert.deepEqual(Object.keys(before.targets).sort(), Object.keys(after.targets).sort())
	for (const [owner, previous] of Object.entries(before.targets)) {
		const candidate = after.targets[owner]
		const allowed = SUPPORT_CHAT_MIGRATIONS[owner]
		if (!allowed) { assert.deepEqual(candidate, previous); continue }
		assert.deepEqual(candidate.migrations.filter(row => !allowed.includes(row.name)), previous.migrations.filter(row => !allowed.includes(row.name)))
		assert.ok(allowed.every(name => candidate.migrations.some(row => row.name === name)))
		assert.equal(candidate.manifestSha256, jsonHash({ schemaVersion: 1, target: owner, migrations: candidate.migrations }))
	}
}

async function main() {
	const [command, directory] = process.argv.slice(2)
	if (command === 'pack') { process.stdout.write(JSON.stringify(supportChatPayload(directory))); return }
	if (command === 'baseline' || command === 'baseline-sha256') {
		const input = JSON.parse(readFileSync(0, 'utf8'))
		process.stdout.write(command === 'baseline' ? JSON.stringify(supportChatBaseline(input)) : supportChatBaselineSha256(input)); return
	}
	const work = '/run/support-work', read = name => JSON.parse(readFileSync(work + '/' + name, 'utf8'))
	const write = (name, value) => writeFileSync(work + '/' + name, JSON.stringify(value), { mode: 0o600 })
	if (command === 'inputs') {
		const envHashes = Object.fromEntries(SUPPORT_CHAT_ENV_NAMES.map(name => [name, hash(readFileSync('/run/support-input/' + name))]))
		write('env-hashes.json', envHashes)
		const input = { containers: read('before.json'), envHashes, gatewayRevision: process.env.SUPPORT_GATEWAY_REVISION }
		assert.equal(supportChatBaselineSha256(input), process.env.SUPPORT_EXPECTED_BASELINE)
		write('baseline.json', supportChatBaseline(input)); return
	}
	if (command === 'prepare') {
		const composes = Object.fromEntries([...new Set(SUPPORT_CHAT_TARGETS.map(row => row[2]))].map(owner => [owner, read(owner + '.json')]))
		const result = prepareSupportChatCompose({ containers: read('before.json'), composes, images: read('images.json'), revision: process.env.SUPPORT_REVISION,
			envHashes: read('env-hashes.json'), gatewayRevision: process.env.SUPPORT_GATEWAY_REVISION, expectedBaselineSha256: process.env.SUPPORT_EXPECTED_BASELINE,
			activation: process.env.SUPPORT_RELEASE_SCOPE === 'support-chat-activate' })
		for (const project of ['winwidget', 'winwidget-crm']) {
			write('desired-' + project + '.json', result.desired[project]); write('rollback-' + project + '.json', result.rollback[project])
		}
		write('prepared.json', result); write('state.json', { updated: [], paused: [] }); return
	}
	if (command === 'fence') {
		const state = read('state.json'), prepared = read('prepared.json')
		assertSupportChatFence({ before: read('before.json'), live: read('live.json'), images: read('images.json'), desired: prepared.desired, ...state }); return
	}
	if (['updated', 'paused', 'unpaused'].includes(command)) {
		assert.ok(SUPPORT_CHAT_TARGETS.some(row => row[1] === directory))
		const state = read('state.json')
		if (command === 'updated') state.updated = [...new Set([...state.updated, directory])]
		if (command === 'paused') state.paused = [...new Set([...state.paused, directory])]
		if (command === 'unpaused') state.paused = state.paused.filter(name => name !== directory)
		write('state.json', state); return
	}
	if (command === 'manifests') {
		assert.ok(['backup', 'restore'].includes(directory))
		assertSupportChatManifests(read('manifest-' + directory + '-before.json'), read('manifest-' + directory + '-after.json')); return
	}
	if (command.startsWith('database-')) { await databaseAction(command, directory); return }
	if (command === 'operations-quiet') { await operationsQuiet(); return }
	if (command === 'broker') {
		const canonical = parseEnv(readFileSync('/run/support-input/canonical', 'utf8'))
		assert.equal(canonical.RABBITMQ_MANAGEMENT_URL, 'http://127.0.0.1:15672'); assert.equal(canonical.RABBITMQ_VHOST, 'winwidget')
		assert.ok(canonical.RABBITMQ_ADMIN_USER && canonical.RABBITMQ_ADMIN_PASSWORD)
		const authorization = 'Basic ' + Buffer.from(canonical.RABBITMQ_ADMIN_USER + ':' + canonical.RABBITMQ_ADMIN_PASSWORD).toString('base64')
		const request = async (method, path, body) => {
			assert.ok(path.startsWith('/api/') && !path.includes('..'))
			const response = await fetch('http://127.0.0.1:15672' + path, { method, headers: { authorization, 'content-type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10000) })
			assert.ok(response.ok)
			const bytes = await response.text(); assert.ok(bytes.length <= 16 * 1024 * 1024)
			return bytes ? JSON.parse(bytes) : null
		}
		const envHashes = read('env-hashes.json')
		if (process.env.SUPPORT_RELEASE_SCOPE === 'support-chat-activate') {
			write('broker-receipt.json', await verifySupportChatBroker(request)); return
		}
		write('broker-receipt.json', await provisionSupportChatBroker(request, async () => {
			for (const name of SUPPORT_CHAT_ENV_NAMES) assert.equal(hash(readFileSync('/run/support-input/' + name)), envHashes[name])
		})); return
	}
	if (command === 'http') {
		for (const [port, path, status] of [[4100, '/health/ready', 200], [4100, '/api/v1/support/conversations', 401], [4100, '/api/v1/internal', 404], [5100, '/health/ready', 200]]) {
			const response = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'error', signal: AbortSignal.timeout(3000) }); assert.equal(response.status, status)
		}
		return
	}
	throw new Error('Unsupported support-chat verifier action')
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch(() => { process.stderr.write('Support chat release contract failed; private details suppressed.\n'); process.exitCode = 1 })
}
