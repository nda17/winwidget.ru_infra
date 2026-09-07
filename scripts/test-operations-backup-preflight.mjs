import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
	NOTES_MIGRATION, OPERATIONS_CRM_BACKUP_TARGETS, sha256,
	createOperationsBackupProbeInput, validateOperationsBackupProbeInput,
	verifyOperationsBackupDatabaseState, verifyOperationsCrmBackupDatabaseState
} from './scoped-service-release.mjs'

const migrationUrl = 'postgresql://winwidget_operations_migration:synthetic%40password@127.0.0.1:55441/winwidget_operations?schema=operations&sslmode=disable'
const fixture = () => {
	const services = Object.fromEntries(['operations-api', 'operations-worker', 'operations-outbox-publisher', 'operations-restore-worker'].map(name => [name, { environment: {} }]))
	services['operations-api'].environment.OPERATIONS_DATABASE_URL = migrationUrl.replace('_migration:', '_runtime:')
	for (const [key, schema, port] of OPERATIONS_CRM_BACKUP_TARGETS)
		services['operations-worker'].environment[key] = `postgresql://winwidget_${schema}_backup:synthetic%3Apassword@127.0.0.1:${port}/winwidget_${schema}?schema=${schema}&sslmode=disable`
	return { services }
}
const envelope = () => JSON.parse(createOperationsBackupProbeInput(`UNRELATED_SECRET=not-for-probe\nOPERATIONS_MIGRATION_DATABASE_URL=${migrationUrl}\n`, fixture()))

test('input includes exactly five selected URLs, accepts env quoting and never forwards unrelated secrets', () => {
	for (const value of [migrationUrl, JSON.stringify(migrationUrl), `'${migrationUrl}'`]) {
		const desired = fixture(), before = structuredClone(desired)
		const bytes = createOperationsBackupProbeInput(Buffer.from(`UNRELATED_SECRET=not-for-probe\nOPERATIONS_MIGRATION_DATABASE_URL=${value}\nCRM_ACCESS_BACKUP_URL=ignored-owner-env\n`), desired)
		assert.ok(Buffer.isBuffer(bytes) && bytes.length <= 32768)
		assert.doesNotMatch(bytes.toString(), /not-for-probe|ignored-owner-env|UNRELATED/)
		const input = JSON.parse(bytes)
		assert.deepEqual(Object.keys(input), ['schemaVersion', 'operationsMigrationUrl', 'crmBackupUrls'])
		assert.deepEqual(Object.keys(input.crmBackupUrls), ['crm-access', 'crm-intake', 'crm-customers', 'crm-sales'])
		assert.deepEqual(validateOperationsBackupProbeInput(input), input)
		assert.deepEqual(desired, before)
	}
})

test('owner env rejects duplicate/missing/oversized/malformed input with no private error values', () => {
	for (const text of ['', `OPERATIONS_MIGRATION_DATABASE_URL=${migrationUrl}\nOPERATIONS_MIGRATION_DATABASE_URL=${migrationUrl}`,
		`OTHER=first\nOTHER=second\nOPERATIONS_MIGRATION_DATABASE_URL=${migrationUrl}`, 'INVALID LINE synthetic-secret',
		`OPERATIONS_MIGRATION_DATABASE_URL="unterminated-synthetic-secret`, `OPERATIONS_MIGRATION_DATABASE_URL=${migrationUrl}\0`, 'x'.repeat(1048577)]) {
		assert.throws(() => createOperationsBackupProbeInput(text, fixture()), error =>
			/ private details suppressed/.test(error.message) && !/postgresql|synthetic|unterminated/.test(error.message))
	}
})

test('input rejects wrong runtime binding, misplaced CRM credentials and absent worker URL', () => {
	for (const mutate of [
		value => { value.services['operations-api'].environment.OPERATIONS_DATABASE_URL = migrationUrl },
		value => { value.services['operations-api'].environment.OPERATIONS_DATABASE_URL = migrationUrl.replace('_migration:', '_runtime:').replace('55441', '55442') },
		value => { value.services['operations-api'].environment.CRM_ACCESS_BACKUP_URL = value.services['operations-worker'].environment.CRM_ACCESS_BACKUP_URL },
		value => { delete value.services['operations-worker'].environment.CRM_SALES_BACKUP_URL },
		value => { value.services.extra = { environment: { CRM_ACCESS_BACKUP_URL: '' } } }
	]) {
		const value = fixture(); mutate(value)
		assert.throws(() => createOperationsBackupProbeInput(`OPERATIONS_MIGRATION_DATABASE_URL=${migrationUrl}`, value), /private details suppressed/)
	}
})

test('strict envelope and all five private URLs fail closed on authority overrides', () => {
	for (const change of [
		value => { value.schemaVersion = 2 }, value => { value.extra = true },
		value => { delete value.operationsMigrationUrl }, value => { value.crmBackupUrls.extra = migrationUrl },
		value => { delete value.crmBackupUrls['crm-sales'] }, value => { value.crmBackupUrls = [] }
	]) { const input = envelope(); change(input); assert.throws(() => validateOperationsBackupProbeInput(input), /private details suppressed/) }
	for (const field of ['operationsMigrationUrl', ...Object.keys(envelope().crmBackupUrls)]) {
		const baseline = envelope(), original = field === 'operationsMigrationUrl' ? baseline[field] : baseline.crmBackupUrls[field]
		for (const bad of [null, '', 'invalid', 'x'.repeat(4097), original.replace('postgresql:', 'https:'), original.replace('127.0.0.1', '192.0.2.1'),
			original.replace(/:5544[1-5]\//, ':5432/'), original.replace(/_(migration|backup):/, '_runtime:'), original.replace(/:[^:@]+@/, '@'),
			original.replace('schema=', 'other='), original.replace('sslmode=disable', 'sslmode=require'),
			...['#fragment', '&schema=other', '&%73chema=other', '&sslmode=disable', '&host=other', '&password=other', '&user=owner', '&options=-csearch_path=public'].map(suffix => original + suffix)]) {
			const input = structuredClone(baseline)
			if (field === 'operationsMigrationUrl') input[field] = bad
			else input.crmBackupUrls[field] = bad
			assert.throws(() => validateOperationsBackupProbeInput(input), error =>
				/private details suppressed/.test(error.message) && !/synthetic|postgresql|192\.0\.2/.test(error.message))
		}
	}
})

const databaseId = '11111111-1111-4111-8111-111111111111'
const checksum = 'a'.repeat(64), schemaSha256 = 'b'.repeat(64)
const crmFiles = [{ name: '20260901000000_init', checksum }]
const operationFiles = [...crmFiles, { name: NOTES_MIGRATION, checksum: 'c'.repeat(64) }]
const manifestFor = target => ({ target, migrations: crmFiles, manifestSha256: sha256(JSON.stringify({ schemaVersion: 1, target, migrations: crmFiles })) })
const ledgerFor = files => files.map(item => ({ migration_name: item.name, checksum: item.checksum, finished_at: new Date('2026-09-01'), rolled_back_at: null }))
function databaseFixture(schema = 'operations') {
	const role = schema === 'operations' ? 'migration' : 'backup'
	const f = {
		readOnly: 'on', version: '180001', queries: [], counters: {}, lease: null,
		identity: { database: `winwidget_${schema}`, username: `winwidget_${schema}_${role}`, session_user: `winwidget_${schema}_${role}`, schema, recovery: false },
		principal: { restricted: true, no_memberships: true, database_owner_matches: true, schema_owner_matches: true, connect: true, no_database_ddl: true, schema_usage: true, schema_create: role === 'migration' },
		serviceIdentity: [{ id: 'singleton', service_name: `${schema.replaceAll('_', '-')}-service`, database_id: databaseId }],
		ledger: ledgerFor(crmFiles), metadata: [{ schema_sha256: schemaSha256 }],
		foreign: { no_public: true, no_foreign_database: true, no_foreign_schema: true },
		relations: ['_prisma_migrations', 'service_identity', 'records'].map(name => ({ name, kind: 'r', owner: `winwidget_${schema}_migration`, rls: false, forced_rls: false, readable: true, writable: false, sequence_readable: false, sequence_writable: false })),
		enums: [{ name: 'Status', owner: `winwidget_${schema}_migration`, usable: true }],
		routines: [{ name: 'state_guard', owner: `winwidget_${schema}_migration`, args: 0, trigger: true, security_definer: false, executable: false }]
	}
	const client = { $queryRawUnsafe: async query => {
		f.queries.push(query)
		assert.match(query, /^(?:SELECT|SHOW) /, 'transaction checker must not execute a mutation')
		if (query === 'SHOW transaction_read_only') return [{ transaction_read_only: f.readOnly }]
		if (query === 'SHOW server_version_num') return [{ server_version_num: f.version }]
		if (query.startsWith('SELECT current_database()')) return [f.identity]
		if (query.includes('FROM pg_roles roles')) return [f.principal]
		if (query.includes('SELECT id, service_name')) return f.serviceIdentity
		if (query.includes('SELECT migration_name')) return f.ledger
		if (query.includes('AS schema_sha256')) return f.metadata
		if (query.includes('AS no_public')) return [f.foreign]
		if (query.startsWith('SELECT c.relname AS name')) return f.relations
		if (query.startsWith('SELECT t.typname AS name')) return f.enums
		if (query.startsWith('SELECT p.proname AS name')) return f.routines
		throw new Error('Unexpected readonly query')
	} }
	for (const model of ['scheduledJobRun', 'outboxEvent', 'auditEventReceipt', 'integrationDeliveryReceipt', 'databaseRestoreJob', 'databaseRestorePermit', 'databaseRestoreRecoveryAction'])
		client[model] = { count: async args => { f.queries.push({ model, args }); return f.counters[model] ?? 0 } }
	client.databaseRestoreExecutionLease = { findUnique: async () => f.lease }
	return { ...f, client, state: f }
}

test('Operations observes pending or applied Notes migration without imposing phase-A or changing data', async () => {
	for (const files of [crmFiles, operationFiles]) {
		const f = databaseFixture(); f.state.ledger = ledgerFor(files)
		const result = await verifyOperationsBackupDatabaseState(f.client, operationFiles)
		assert.deepEqual(result, { databaseId, schemaSha256, ledgerSha256: sha256(JSON.stringify(files)), quiet: true })
		assert.doesNotMatch(JSON.stringify(result), /username|password|migration_name|service_name|queries/)
		assert.ok(f.queries.some(query => query.model === 'auditEventReceipt'))
	}
})

test('Operations reports busy counts/restore lease without hiding them as quiet after worker starts', async () => {
	for (const busy of ['scheduledJobRun', 'outboxEvent', 'auditEventReceipt', 'integrationDeliveryReceipt', 'databaseRestoreJob', 'databaseRestorePermit', 'databaseRestoreRecoveryAction', 'lease']) {
		const f = databaseFixture()
		if (busy === 'lease') f.state.lease = { operationType: 'RESTORE', operationId: databaseId, leaseOwner: null, leaseToken: null }
		else f.state.counters[busy] = 1
		assert.equal((await verifyOperationsBackupDatabaseState(f.client, operationFiles)).quiet, false)
	}
})

test('Operations fails on unknown identity, writable transaction, failed/drifted ledger or unsafe role', async () => {
	for (const mutate of [
		f => { f.readOnly = 'off' }, f => { f.version = '170009' }, f => { f.identity.database = 'other' },
		f => { f.identity.session_user = 'owner' }, f => { f.identity.recovery = true }, f => { f.principal.restricted = false },
		f => { f.principal.database_owner_matches = false }, f => { f.serviceIdentity[0].database_id = 'bad' },
		f => { f.serviceIdentity[0].service_name = 'other-service' }, f => { f.ledger[0].checksum = 'd'.repeat(64) },
		f => { f.ledger[0].finished_at = null }, f => { f.ledger[0].rolled_back_at = new Date() },
		f => { f.ledger.push(f.ledger[0]) }, f => { f.metadata[0].schema_sha256 = 'bad' }, f => { f.counters.scheduledJobRun = -1 }
	]) { const f = databaseFixture(); mutate(f.state); await assert.rejects(verifyOperationsBackupDatabaseState(f.client, operationFiles)) }
})

test('four CRM backup readers verify exact ledger and return only safe identity/manifest evidence', async () => {
	for (const [, schema] of OPERATIONS_CRM_BACKUP_TARGETS) {
		const target = schema.replaceAll('_', '-'), f = databaseFixture(schema), manifest = manifestFor(target)
		assert.deepEqual(await verifyOperationsCrmBackupDatabaseState(f.client, target, manifest), { target, databaseId, manifestSha256: manifest.manifestSha256 })
		assert.ok(f.queries.some(query => typeof query === 'string' && query.includes('MAINTAIN')))
		assert.ok(f.queries.some(query => typeof query === 'string' && query.includes('has_any_column_privilege')))
	}
})

test('CRM rejects incomplete backup ACLs, inherited/elevated privilege, RLS and writable sequences/functions', async () => {
	for (const mutate of [
		f => { f.principal.no_memberships = false }, f => { f.principal.schema_create = true }, f => { f.principal.no_database_ddl = false },
		f => { f.foreign.no_foreign_schema = false }, f => { f.foreign.no_public = false }, f => { f.foreign.no_foreign_database = false },
		f => { f.relations[0].readable = false }, f => { f.relations[1].writable = true }, f => { f.relations[1].rls = true },
		f => { f.relations[1].forced_rls = true }, f => { f.relations[1].owner = 'owner' }, f => { f.relations[1].kind = 'f' },
		f => { f.relations[1].sequence_writable = true }, f => { f.relations = [] }, f => { f.enums[0].usable = false },
		f => { f.routines[0].executable = true }, f => { f.routines[0].security_definer = true }, f => { f.routines[0].args = 1 },
		f => { f.ledger[0].finished_at = null }, f => { f.ledger.push(f.ledger[0]) }, f => { f.serviceIdentity[0].service_name = 'operations-service' }
	]) { const f = databaseFixture('crm_access'); mutate(f.state); await assert.rejects(verifyOperationsCrmBackupDatabaseState(f.client, 'crm-access', manifestFor('crm-access'))) }
})

test('runtime probe constructs only bounded readonly sessions, uses candidate manifest parser and never process env credentials', () => {
	const source = readFileSync(new URL('./scoped-service-release.mjs', import.meta.url), 'utf8')
	const body = source.slice(source.indexOf('export async function verifyOperationsBackupDatabases(value)'), source.indexOf('\nasync function main()'))
	assert.match(body, /assert\.equal\(process\.getuid\(\), 1001\)/)
	assert.match(body, /parseDatabaseBackupMigrationManifests/)
	assert.match(body, /SET TRANSACTION READ ONLY/)
	assert.match(body, /isolationLevel: 'RepeatableRead', timeout: 10000, maxWait: 5000/)
	assert.match(body, /finally \{ await client\.\$disconnect\(\); \}/)
	assert.doesNotMatch(body, /process\.env|spawn\(|pg_dump|GRANT |REVOKE |INSERT |UPDATE |DELETE /)
})
