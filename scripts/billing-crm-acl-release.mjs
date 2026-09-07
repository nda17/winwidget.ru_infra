import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'
import { spawnSync } from 'node:child_process'

export const MIGRATION =
	'20260909110000_restrict_wincrm_commerce_runtime_acl'
export const MIGRATION_SHA256 =
	'ad429d7f4324f2dbf62de73e1492084dbf8b61cb589c172de891b0d5edf4a415'
export const TABLES = Object.freeze([
	'crm_auto_renewal_consents',
	'crm_auto_renewals',
	'crm_commerce_accounts',
	'crm_commerce_commands',
	'crm_orders',
	'crm_paid_periods',
	'crm_payment_receipts',
	'crm_provider_deliveries',
	'crm_provider_operations'
])
const hash = value => createHash('sha256').update(value).digest('hex')

export function assertSourcePair(before, after) {
	const target = `migrations/${MIGRATION}/migration.sql`
	assert.equal(after[target], MIGRATION_SHA256)
	assert.equal(Object.hasOwn(before, target), false)
	assert.deepEqual(
		Object.keys(after)
			.filter(key => key !== target)
			.sort(),
		Object.keys(before).sort()
	)
	assert.ok(Object.keys(before).length >= 11)
	for (const key of Object.keys(before))
		assert.equal(after[key], before[key])
}

function inventory(root, relative = '') {
	assert.ok(
		lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink()
	)
	const result = {}
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		assert.ok(!entry.isSymbolicLink())
		const path = join(root, entry.name),
			key = relative + entry.name
		if (entry.isDirectory())
			Object.assign(result, inventory(path, key + '/'))
		else {
			assert.ok(entry.isFile())
			result[key] = hash(readFileSync(path))
		}
	}
	return result
}

export function runtimeFingerprint(live, revision) {
	assert.match(revision, /^[a-f0-9]{40}$/)
	assert.ok(Array.isArray(live) && live.length >= 47 && live.length <= 200)
	assert.equal(new Set(live.map(row => row.Id)).size, live.length)
	for (const name of [
		'billing-api',
		'billing-worker',
		'billing-scheduler',
		'billing-outbox-publisher'
	]) {
		const matches = live.filter(
			row =>
				row.Config?.Labels?.['com.docker.compose.project'] ===
					'winwidget' &&
				row.Config.Labels['com.docker.compose.service'] === name
		)
		assert.equal(matches.length, 1)
		assert.equal(
			matches[0].Config.Labels['org.opencontainers.image.revision'],
			revision
		)
	}
	return hash(
		JSON.stringify(
			live
				.map(row => {
					assert.match(row.Id, /^[a-f0-9]{64}$/)
					assert.match(row.Image, /^sha256:[a-f0-9]{64}$/)
					assert.equal(row.State.Running, true)
					for (const key of ['Paused', 'Restarting', 'OOMKilled', 'Dead'])
						assert.equal(row.State[key], false)
					assert.equal(row.State.Health?.Status, 'healthy')
					assert.equal(row.RestartCount, 0)
					assert.ok(
						row.Config &&
							row.HostConfig &&
							row.Mounts &&
							row.NetworkSettings
					)
					return {
						id: row.Id,
						image: row.Image,
						config: row.Config,
						host: row.HostConfig,
						mounts: [...row.Mounts].sort((a, b) =>
							a.Destination.localeCompare(b.Destination)
						),
						network: row.NetworkSettings,
						started: row.State.StartedAt
					}
				})
				.sort((a, b) => a.id.localeCompare(b.id))
		)
	)
}

export function migrationUrl(value) {
	assert.equal(typeof value, 'string')
	assert.ok(value.length <= 4096)
	const url = new URL(value)
	assert.ok(['postgres:', 'postgresql:'].includes(url.protocol))
	assert.equal(url.username, 'winwidget_billing_migration')
	assert.ok(url.password && !url.hash)
	assert.equal(url.hostname, '127.0.0.1')
	assert.equal(url.port, '55437')
	assert.equal(url.pathname, '/winwidget_billing')
	assert.deepEqual([...url.searchParams.keys()].sort(), [
		'schema',
		'sslmode'
	])
	assert.equal(url.searchParams.get('schema'), 'billing')
	assert.equal(url.searchParams.get('sslmode'), 'disable')
	url.searchParams.set('connection_limit', '1')
	url.searchParams.set('pool_timeout', '5')
	url.searchParams.set('connect_timeout', '5')
	return url.toString()
}

export function verifyLedger(files, rows, phase) {
	assert.ok(['before', 'after'].includes(phase))
	const expected = new Map(files.map(row => [row.name, row.checksum]))
	assert.equal(expected.size, files.length)
	assert.equal(expected.get(MIGRATION), MIGRATION_SHA256)
	const applied = new Set()
	for (const row of rows) {
		assert.equal(row.rolled_back_at, null)
		assert.ok(row.finished_at && !applied.has(row.migration_name))
		assert.equal(expected.get(row.migration_name), row.checksum)
		applied.add(row.migration_name)
	}
	const pending = [...expected.keys()].filter(name => !applied.has(name))
	assert.deepEqual(pending, phase === 'before' ? [MIGRATION] : [])
}

export function verifyAcl(rows, phase) {
	assert.deepEqual(rows.map(row => row.name).sort(), TABLES)
	for (const row of rows) {
		assert.equal(row.owner, 'winwidget_billing_migration')
		assert.equal(row.can_select, true)
		assert.equal(row.can_insert, true)
		assert.equal(row.can_truncate, false)
		assert.equal(row.can_delete, phase === 'before')
		assert.equal(
			row.can_update,
			phase === 'before' || row.name !== 'crm_auto_renewal_consents'
		)
		assert.equal(row.column_update, row.can_update)
	}
}

async function database(phase, source) {
	const env = parseEnv(readFileSync('/run/billing.env', 'utf8'))
	assert.equal(env.BILLING_WINCRM_PAYMENTS_ENABLED, 'false')
	const url = migrationUrl(env.BILLING_MIGRATION_DATABASE_URL)
	const { PrismaClient } = createRequire('/app/package.json')(
		'@prisma/billing-client'
	)
	const client = new PrismaClient({
		datasources: { db: { url } },
		log: []
	})
	try {
		return await client.$transaction(
			async tx => {
				await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
				await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'")
				const identity = await tx.$queryRawUnsafe(
					'SELECT current_database() AS db, current_user AS username, current_schema() AS schema, pg_is_in_recovery() AS recovery'
				)
				assert.deepEqual(identity, [
					{
						db: 'winwidget_billing',
						username: 'winwidget_billing_migration',
						schema: 'billing',
						recovery: false
					}
				])
				const owned = await tx.$queryRawUnsafe(
					'SELECT id, service_name, database_id::text AS database_id FROM billing.service_identity'
				)
				assert.equal(owned.length, 1)
				assert.equal(owned[0].id, 'singleton')
				assert.equal(owned[0].service_name, 'billing-service')
				assert.match(owned[0].database_id, /^[a-f0-9-]{36}$/)
				const files = Object.entries(source)
					.filter(([name]) => name.endsWith('/migration.sql'))
					.map(([name, checksum]) => ({
						name: name.split('/')[1],
						checksum
					}))
				verifyLedger(
					files,
					await tx.$queryRawUnsafe(
						'SELECT migration_name, checksum, finished_at, rolled_back_at FROM billing._prisma_migrations ORDER BY migration_name'
					),
					phase
				)
				const rows =
					await tx.$queryRawUnsafe(`SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner,
				has_table_privilege('winwidget_billing_runtime',c.oid,'SELECT') AS can_select,
				has_table_privilege('winwidget_billing_runtime',c.oid,'INSERT') AS can_insert,
				has_table_privilege('winwidget_billing_runtime',c.oid,'UPDATE') AS can_update,
				has_any_column_privilege('winwidget_billing_runtime',c.oid,'UPDATE') AS column_update,
				has_table_privilege('winwidget_billing_runtime',c.oid,'DELETE') AS can_delete,
				has_table_privilege('winwidget_billing_runtime',c.oid,'TRUNCATE') AS can_truncate
				FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
				WHERE n.nspname='billing' AND c.relname IN (${TABLES.map(name => `'${name}'`).join(',')})`)
				verifyAcl(rows, phase)
				const routine = await tx.$queryRawUnsafe(
					"SELECT has_function_privilege('winwidget_billing_runtime','billing.protect_wincrm_commerce_evidence()','EXECUTE') AS allowed"
				)
				assert.equal(routine[0].allowed, false)
				// All non-target table ACL, schema/role/default ACL and routine ACL
				// remain identical. No business rows, provider objects or secrets leave PG.
				const unchanged =
					await tx.$queryRawUnsafe(`SELECT kind, name, acl FROM (
				SELECT 'relation' AS kind, c.relname AS name, coalesce(c.relacl::text,'') AS acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='billing' AND c.relname NOT IN (${TABLES.map(name => `'${name}'`).join(',')})
				UNION ALL SELECT 'default', d.oid::text, d.defaclacl::text FROM pg_default_acl d WHERE d.defaclrole='winwidget_billing_migration'::regrole
				UNION ALL SELECT 'schema', nspname, coalesce(nspacl::text,'') FROM pg_namespace WHERE nspname='billing'
				UNION ALL SELECT 'routine', p.oid::text, coalesce(p.proacl::text,'') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='billing' AND p.proname <> 'protect_wincrm_commerce_evidence'
			) evidence ORDER BY kind,name`)
				return {
					databaseId: owned[0].database_id,
					unaffectedAclSha256: hash(JSON.stringify(unchanged)),
					migrationChecksum: MIGRATION_SHA256
				}
			},
			{ timeout: 15000 }
		)
	} finally {
		await client.$disconnect()
	}
}

async function main() {
	const mode = process.argv[2]
	if (mode === 'inventory') {
		console.log(
			runtimeFingerprint(
				JSON.parse(readFileSync(0, 'utf8')),
				process.env.BILLING_LIVE_REVISION
			)
		)
		return
	}
	assert.ok(['before', 'migrate', 'after'].includes(mode))
	const source = inventory('/run/candidate/prisma')
	assertSourcePair(inventory('/app/prisma'), source)
	if (mode === 'migrate') {
		// The exact pending migration was checked again in this same process.
		await database('before', source)
		const env = parseEnv(readFileSync('/run/billing.env', 'utf8'))
		const result = spawnSync(
			process.execPath,
			[
				'/app/node_modules/prisma/build/index.js',
				'migrate',
				'deploy',
				'--schema',
				'/run/candidate/prisma/schema.prisma'
			],
			{
				env: {
					PATH: process.env.PATH,
					NODE_ENV: 'production',
					BILLING_DATABASE_URL: migrationUrl(
						env.BILLING_MIGRATION_DATABASE_URL
					)
				},
				stdio: 'ignore',
				timeout: 60000
			}
		)
		assert.equal(result.status, 0)
		console.log('Billing CRM ACL migration process completed')
		return
	}
	console.log(JSON.stringify(await database(mode, source)))
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch(() => {
		console.error(
			'Billing CRM ACL verification failed; private diagnostics suppressed. Inspect the migration ledger before retry.'
		)
		process.exitCode = 1
	})
}
