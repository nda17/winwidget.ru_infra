import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import {
	MIGRATION,
	MIGRATION_SHA256,
	TABLES,
	assertSourcePair,
	migrationUrl,
	runtimeFingerprint,
	verifyAcl,
	verifyLedger
} from './billing-crm-acl-release.mjs'

test('only the exact additive ACL migration can differ from the live Prisma source', () => {
	const before = Object.fromEntries(
		Array.from({ length: 10 }, (_, i) => [
			`migrations/${i}/migration.sql`,
			'a'.repeat(64)
		])
	)
	before['schema.prisma'] = 'b'.repeat(64)
	const target = `migrations/${MIGRATION}/migration.sql`
	const after = { ...before, [target]: MIGRATION_SHA256 }
	assertSourcePair(before, after)
	for (const mutate of [
		row => {
			row[target] = 'c'.repeat(64)
		},
		row => {
			delete row[target]
		},
		row => {
			row['schema.prisma'] = 'c'.repeat(64)
		},
		row => {
			row['extra.sql'] = 'c'.repeat(64)
		},
		row => {
			delete row['migrations/0/migration.sql']
		},
		row => {
			row['migrations/0/migration.sql'] = 'c'.repeat(64)
		}
	]) {
		const changed = { ...after }
		mutate(changed)
		assert.throws(() => assertSourcePair(before, changed))
	}
	assert.throws(() => assertSourcePair(after, after))
})

test('migration connection is bound to the Billing owner and local database only', () => {
	const source =
		'postgresql://winwidget_billing_migration:synthetic%40only@127.0.0.1:55437/winwidget_billing?schema=billing&sslmode=disable'
	const result = new URL(migrationUrl(source))
	assert.equal(result.searchParams.get('connection_limit'), '1')
	assert.equal(result.password, new URL(source).password)
	for (const [from, to] of [
		['55437', '5432'],
		['127.0.0.1', 'localhost'],
		['winwidget_billing_migration', 'winwidget_billing_runtime'],
		['/winwidget_billing', '/winwidget_identity'],
		['schema=billing', 'schema=public'],
		['sslmode=disable', 'sslmode=require'],
		['postgresql:', 'https:'],
		[':synthetic%40only', '']
	])
		assert.throws(() => migrationUrl(source.replace(from, to)))
	for (const extra of [
		'&schema=billing',
		'&options=unsafe',
		'#fragment',
		'&connection_limit=10'
	])
		assert.throws(() => migrationUrl(source + extra))
})

test('ledger admits one pending immutable migration and rejects failed, duplicate or drifted evidence', () => {
	const files = [
		{ name: 'old', checksum: 'b'.repeat(64) },
		{ name: MIGRATION, checksum: MIGRATION_SHA256 }
	]
	const rows = [
		{
			migration_name: 'old',
			checksum: 'b'.repeat(64),
			finished_at: '2026-09-07T00:00:00Z',
			rolled_back_at: null
		}
	]
	verifyLedger(files, rows, 'before')
	const after = [
		...rows,
		{
			migration_name: MIGRATION,
			checksum: MIGRATION_SHA256,
			finished_at: '2026-09-07T01:00:00Z',
			rolled_back_at: null
		}
	]
	verifyLedger(files, after, 'after')
	assert.throws(() => verifyLedger(files, rows, 'after'))
	assert.throws(() => verifyLedger(files, after, 'before'))
	for (const mutate of [
		row => {
			row[0].finished_at = null
		},
		row => {
			row[0].rolled_back_at = '2026-09-07'
		},
		row => {
			row[0].checksum = 'c'.repeat(64)
		},
		row => {
			row.push(row[0])
		},
		row => {
			row[0].migration_name = 'unknown'
		}
	]) {
		const changed = structuredClone(rows)
		mutate(changed)
		assert.throws(() => verifyLedger(files, changed, 'before'))
	}
})

test('all nine tables retain business grants and lose only removal and consent updates', () => {
	const rows = TABLES.map(name => ({
		name,
		owner: 'winwidget_billing_migration',
		can_select: true,
		can_insert: true,
		can_update: true,
		column_update: true,
		can_delete: true,
		can_truncate: false
	}))
	verifyAcl(rows, 'before')
	const after = rows.map(row => ({
		...row,
		can_delete: false,
		can_update: row.name !== 'crm_auto_renewal_consents',
		column_update: row.name !== 'crm_auto_renewal_consents'
	}))
	verifyAcl(after, 'after')
	for (const mutate of [
		value => {
			value.pop()
		},
		value => {
			value.push(value[0])
		},
		value => {
			value[0].can_delete = true
		},
		value => {
			value[0].can_truncate = true
		},
		value => {
			value[0].can_insert = false
		},
		value => {
			value[0].can_select = false
		},
		value => {
			value[0].column_update = true
		},
		value => {
			value[0].owner = 'another'
		}
	]) {
		const changed = structuredClone(after)
		mutate(changed)
		assert.throws(() => verifyAcl(changed, 'after'))
	}
})

function fixture() {
	return Array.from({ length: 47 }, (_, i) => ({
		Id: i.toString(16).padStart(64, '0'),
		Image: `sha256:${'b'.repeat(64)}`,
		Config: {
			Labels: {
				'com.docker.compose.project': 'winwidget',
				'com.docker.compose.service':
					[
						'billing-api',
						'billing-worker',
						'billing-scheduler',
						'billing-outbox-publisher'
					][i] ?? `neighbor-${i}`,
				'org.opencontainers.image.revision': 'a'.repeat(40)
			},
			Env: ['SYNTHETIC_SECRET=do-not-print']
		},
		HostConfig: {},
		Mounts: [],
		NetworkSettings: {},
		RestartCount: 0,
		State: {
			Running: true,
			Paused: false,
			Restarting: false,
			OOMKilled: false,
			Dead: false,
			Health: { Status: 'healthy' },
			StartedAt: '2026-09-07T00:00:00Z'
		}
	}))
}

test('every live container including all CRM processes stays in the unchanged-runtime fence', () => {
	const live = fixture(),
		revision = 'a'.repeat(40),
		before = runtimeFingerprint(live, revision)
	assert.match(before, /^[a-f0-9]{64}$/)
	assert.equal(runtimeFingerprint([...live].reverse(), revision), before)
	for (const mutate of [
		row => {
			row[46].Config.Env.push('DRIFT=true')
		},
		row => {
			row[46].Image = `sha256:${'c'.repeat(64)}`
		},
		row => {
			row[20].State.StartedAt = '2026-09-07T01:00:00Z'
		}
	]) {
		const changed = structuredClone(live)
		mutate(changed)
		assert.notEqual(runtimeFingerprint(changed, revision), before)
	}
	for (const mutate of [
		row => {
			row.pop()
		},
		row => {
			row[0].RestartCount = 1
		},
		row => {
			row[0].State.OOMKilled = true
		},
		row => {
			row[5].State.Health.Status = 'unhealthy'
		},
		row => {
			row[0].Config.Labels['org.opencontainers.image.revision'] =
				'c'.repeat(40)
		},
		row => {
			row[1].Id = row[0].Id
		}
	]) {
		const changed = structuredClone(live)
		mutate(changed)
		assert.throws(() => runtimeFingerprint(changed, revision))
	}
})

test('scope does not build, replace, delete or publish any runtime resources', () => {
	const shell = readFileSync(
		new URL('deploy-billing-crm-acl-scoped.sh', import.meta.url),
		'utf8'
	)
	assert.doesNotMatch(
		shell,
		/docker (?:build|stop|restart|rm|volume|network|compose)|pg_dump|rabbitmqctl|migrate resolve/
	)
	assert.match(shell, /flock -n "\$deploy_lock_fd"/)
	assert.match(shell, /before="\$\(billing_acl_probe before\)"/)
	assert.match(shell, /billing_acl_probe migrate/)
	assert.match(shell, /after="\$\(billing_acl_probe after\)"/)
	assert.match(shell, /"\$before" == "\$after"/)
	assert.equal(spawnSync('bash', ['-n'], { input: shell }).status, 0)
})
