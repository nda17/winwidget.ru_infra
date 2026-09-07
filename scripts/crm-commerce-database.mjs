import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
	crmUpgradeDatabaseConnection,
	crmUpgradeDatabaseInput,
	crmUpgradeDatabaseMemberships,
	crmUpgradeImageSource,
	crmUpgradeLedger,
	parseCrmUpgradeDatabaseHandoff
} from './crm-release.mjs'
import { assertCrmCommerceDatabaseProof } from './crm-commerce-activation.mjs'

const owners = ['billing', 'crm-access', 'crm-customers']
const countKeys = {
	billing: [
		'orders',
		'renewals',
		'providerOperations',
		'paidPeriods',
		'dueRenewals',
		'pendingProviderDeliveries',
		'unpublishedProviderOutbox'
	],
	'crm-access': ['accessOperations', 'accessCapacityFences'],
	'crm-customers': []
}
const failure = () =>
	new Error(
		'CRM commerce database probe rejected; private details suppressed'
	)
const exact = (value, keys) => {
	assert.ok(value && typeof value === 'object' && !Array.isArray(value))
	assert.deepEqual(Object.keys(value).sort(), [...keys].sort())
}
const stable = value =>
	JSON.stringify(value, (_, item) =>
		item && typeof item === 'object' && !Array.isArray(item)
			? Object.fromEntries(
					Object.entries(item).sort(([a], [b]) =>
						a < b ? -1 : a > b ? 1 : 0
					)
				)
			: item
	)
const hash = value =>
	createHash('sha256').update(stable(value)).digest('hex')
const ownerSchema = owner => {
	assert.ok(owners.includes(owner))
	return owner.replaceAll('-', '_')
}

// Private root-reader -> UID 1001 stdin only. No SQL or credentials in argv,
// Docker Env, logs or public output. These wrappers suppress parser details too.
export function crmCommerceDatabaseInput(owner, ownerEnv, live) {
	try {
		ownerSchema(owner)
		return crmUpgradeDatabaseInput(owner, ownerEnv, live)
	} catch {
		throw failure()
	}
}

export function parseCrmCommerceDatabaseHandoff(buffer) {
	try {
		const input = parseCrmUpgradeDatabaseHandoff(buffer)
		ownerSchema(input.owner)
		crmUpgradeDatabaseConnection(input.owner, input)
		return input
	} catch {
		throw failure()
	}
}

// Identifiers are derived exclusively from the closed owner set. Counts never
// select contact, payment-method, provider request/response or customer data.
export function crmCommerceDatabaseSql(owner) {
	try {
		const schema = ownerSchema(owner)
		const principal = `winwidget_${schema}_migration`
		const runtime = `winwidget_${schema}_runtime`
		return {
			identity: `SELECT service_name, database_id::text FROM ${schema}.service_identity WHERE id='singleton'`,
			principal: `SELECT current_database() AS db, current_user AS username, current_schema() AS schema,
 pg_is_in_recovery() AS recovery, current_setting('server_version_num')::int AS version,
 current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation,
 transaction_timestamp()::text AS checked_at,
 (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='${schema}') AS schema_owner`,
			roles: `SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls
 FROM pg_roles WHERE rolname IN ('${principal}','${runtime}') ORDER BY rolname`,
			admin:
				owner === 'billing'
					? `SELECT role_state.rolname, role_state.rolcanlogin, role_state.rolsuper,
 pg_get_userbyid(database_state.datdba) AS "databaseOwner"
 FROM pg_roles role_state JOIN pg_database database_state ON database_state.datname=current_database()
 WHERE role_state.rolname='winwidget_billing_admin'`
					: null,
			memberships: `SELECT granted_role.rolname AS "role", member_role.rolname AS "member", grantor_role.rolname AS "grantor",
 membership.admin_option, membership.inherit_option, membership.set_option
 FROM pg_auth_members membership
 JOIN pg_roles granted_role ON granted_role.oid=membership.roleid
 JOIN pg_roles member_role ON member_role.oid=membership.member
 JOIN pg_roles grantor_role ON grantor_role.oid=membership.grantor
 WHERE membership.member IN ('${principal}'::regrole,'${runtime}'::regrole)
 OR membership.roleid IN ('${principal}'::regrole,'${runtime}'::regrole)
 ORDER BY granted_role.rolname, member_role.rolname, grantor_role.rolname, membership.admin_option, membership.inherit_option, membership.set_option`,
			ledger: `SELECT id, migration_name, checksum, finished_at::text, rolled_back_at::text FROM ${schema}._prisma_migrations ORDER BY migration_name, started_at`,
			// Same object ACL boundary as crm-upgrade, additionally covering database,
			// columns and owners. Fingerprints must remain exact across activation.
			acl: `SELECT kind, name, owner,
 CASE WHEN acl IS NULL THEN '' ELSE ARRAY(SELECT format('%s:%s:%s:%s',grantor,grantee,privilege_type,is_grantable) FROM aclexplode(acl) ORDER BY grantor,grantee,privilege_type,is_grantable)::text END AS acl FROM (
 SELECT 'relation' AS kind,c.relname AS name,pg_get_userbyid(c.relowner) AS owner,c.relacl AS acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${schema}' AND c.relkind IN ('r','S','v','m','f','p')
 UNION ALL SELECT 'column',c.relname || '.' || a.attname,pg_get_userbyid(c.relowner),a.attacl FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${schema}' AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
 UNION ALL SELECT 'schema',nspname,pg_get_userbyid(nspowner),nspacl FROM pg_namespace WHERE nspname='${schema}'
 UNION ALL SELECT 'database',datname,pg_get_userbyid(datdba),datacl FROM pg_database WHERE datname=current_database()
 UNION ALL SELECT 'default',d.oid::text,pg_get_userbyid(d.defaclrole),d.defaclacl FROM pg_default_acl d WHERE d.defaclrole='${principal}'::regrole
 UNION ALL SELECT 'routine',p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',pg_get_userbyid(p.proowner),p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='${schema}') a ORDER BY kind,name`,
			billingGrants:
				owner === 'billing'
					? "SELECT has_table_privilege('winwidget_billing_runtime','billing.crm_admin_day_grants','SELECT') AS read, has_table_privilege('winwidget_billing_runtime','billing.crm_admin_day_grants','INSERT') AS append, has_table_privilege('winwidget_billing_runtime','billing.crm_admin_day_grants','UPDATE,DELETE,TRUNCATE') AS mutate, has_function_privilege('winwidget_billing_runtime','billing.protect_crm_admin_day_grants()','EXECUTE') AS grant_execute, has_function_privilege('winwidget_billing_runtime','billing.protect_crm_admin_command_receipts()','EXECUTE') AS receipt_execute"
					: null,
			billingTriggers:
				owner === 'billing'
					? "SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid IN ('billing.crm_admin_day_grants'::regclass,'billing.command_receipts'::regclass) AND NOT tgisinternal ORDER BY tgname"
					: null,
			counts:
				owner === 'billing'
					? `SELECT
 (SELECT count(*)::text FROM billing.crm_orders) AS "orders",
 (SELECT count(*)::text FROM billing.crm_auto_renewals) AS "renewals",
 (SELECT count(*)::text FROM billing.crm_provider_operations) AS "providerOperations",
 (SELECT count(*)::text FROM billing.crm_paid_periods) AS "paidPeriods",
 (SELECT count(*)::text FROM billing.crm_auto_renewals WHERE status='ACTIVE' AND dispatch_pending=false
 AND (next_retry_at<=transaction_timestamp() OR (next_retry_at IS NULL AND next_charge_at<=transaction_timestamp()))) AS "dueRenewals",
 (SELECT count(*)::text FROM billing.crm_provider_deliveries WHERE status<>'DELIVERED') AS "pendingProviderDeliveries",
 (SELECT count(*)::text FROM billing.outbox_events WHERE status<>'PUBLISHED'
 AND (event_type='billing.wincrm.provider-operation.requested.v1' OR routing_key='billing.wincrm.provider-operation.requested.v1')) AS "unpublishedProviderOutbox"`
					: owner === 'crm-access'
						? `SELECT
 (SELECT count(*)::text FROM crm_access.crm_billing_operations) AS "accessOperations",
 (SELECT count(*)::text FROM crm_access.crm_billing_capacity WHERE pending_operation_id IS NOT NULL OR pending_target_seats IS NOT NULL) AS "accessCapacityFences"`
						: null
		}
	} catch {
		throw failure()
	}
}

function readCounts(owner, row) {
	exact(row, countKeys[owner])
	return Object.fromEntries(
		Object.entries(row).map(([key, value]) => {
			assert.equal(typeof value, 'string')
			assert.match(value, /^(0|[1-9]\d{0,15})$/)
			const count = Number(value)
			assert.ok(Number.isSafeInteger(count))
			return [key, count]
		})
	)
}

// Dependency injection is only for local tests. The sealed production caller
// supplies owner+stdin input, never overrides source files or the client.
export async function probeCrmCommerceDatabase(
	owner,
	input,
	dependencies = {}
) {
	let client
	try {
		const schema = ownerSchema(owner)
		const url = crmUpgradeDatabaseConnection(owner, input)
		const files =
			dependencies.sourceFiles ?? crmUpgradeImageSource('/app/prisma')
		assert.ok(
			Object.keys(files).length > 1 && Object.keys(files).length <= 103
		)
		assert.match(files['schema.prisma'], /^[a-f0-9]{64}$/)
		assert.match(files['migration_lock.toml'], /^[a-f0-9]{64}$/)
		assert.ok(Object.keys(files).some(name => /^\d{14}_/.test(name)))
		for (const [name, value] of Object.entries(files)) {
			assert.ok(
				[
					'schema.prisma',
					'database-access.json',
					'migration_lock.toml'
				].includes(name) || /^\d{14}_[a-z0-9_]+$/.test(name)
			)
			assert.match(value, /^[a-f0-9]{64}$/)
		}
		client =
			dependencies.client ??
			new (createRequire('/app/package.json')(
				`@prisma/${owner}-client`
			).PrismaClient)({
				datasources: { db: { url: url.toString() } },
				log: []
			})
		const sql = crmCommerceDatabaseSql(owner)
		return await client.$transaction(
			async tx => {
				await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
				await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'")
				const one = async query => {
					const rows = await tx.$queryRawUnsafe(query)
					assert.ok(Array.isArray(rows) && rows.length === 1)
					return rows[0]
				}
				const identity = await one(sql.identity)
				assert.equal(identity.service_name, `${owner}-service`)
				assert.match(
					identity.database_id,
					/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
				)
				const principal = await one(sql.principal)
				assert.equal(principal.db, `winwidget_${schema}`)
				assert.equal(principal.username, `winwidget_${schema}_migration`)
				assert.equal(principal.schema, schema)
				assert.equal(principal.schema_owner, principal.username)
				assert.equal(principal.recovery, false)
				assert.ok(
					Number.isInteger(principal.version) &&
						principal.version >= 180000 &&
						principal.version < 190000
				)
				assert.equal(principal.read_only, 'on')
				assert.equal(principal.isolation, 'repeatable read')
				assert.equal(typeof principal.checked_at, 'string')
				const checkedAt = new Date(principal.checked_at).toISOString()
				const roles = await tx.$queryRawUnsafe(sql.roles)
				assert.deepEqual(
					roles.map(role => role.rolname),
					[`winwidget_${schema}_migration`, `winwidget_${schema}_runtime`]
				)
				for (const role of roles) {
					assert.equal(role.rolcanlogin, true)
					for (const key of [
						'rolsuper',
						'rolcreatedb',
						'rolcreaterole',
						'rolreplication',
						'rolbypassrls'
					])
						assert.equal(role[key], false)
					assert.equal(typeof role.rolinherit, 'boolean')
					if (owner !== 'billing' || role.rolname.endsWith('_runtime'))
						assert.equal(role.rolinherit, false)
				}
				const admin = sql.admin ? await one(sql.admin) : null
				const memberships = crmUpgradeDatabaseMemberships(
					owner,
					await tx.$queryRawUnsafe(sql.memberships),
					admin
				)
				const ledger = await tx.$queryRawUnsafe(sql.ledger)
				const pending = crmUpgradeLedger(owner, files, ledger, true)
				const acl = await tx.$queryRawUnsafe(sql.acl)
				assert.ok(Array.isArray(acl) && acl.length > 0)
				if (sql.billingGrants) {
					assert.deepEqual(await one(sql.billingGrants), {
						read: true,
						append: true,
						mutate: false,
						grant_execute: false,
						receipt_execute: false
					})
					const triggers = await tx.$queryRawUnsafe(sql.billingTriggers)
					for (const name of [
						'crm_admin_day_grants_append_only',
						'crm_admin_day_grants_no_truncate',
						'crm_admin_command_receipts_retention_guard',
						'crm_admin_command_receipts_no_truncate'
					])
						assert.ok(
							triggers.some(
								row => row.tgname === name && row.tgenabled === 'O'
							)
						)
				}
				const counts = readCounts(
					owner,
					sql.counts ? await one(sql.counts) : {}
				)
				return {
					schemaVersion: 1,
					owner,
					checkedAt,
					identity: {
						databaseId: identity.database_id,
						database: principal.db,
						schema,
						serviceName: identity.service_name,
						principal: principal.username,
						readOnly: true,
						recovery: false,
						postgresVersion: principal.version,
						sourceSha256: hash(files),
						ledgerSha256: hash(ledger),
						rolesSha256: hash({ roles, memberships, admin }),
						aclSha256: hash(acl),
						pendingMigrations: pending.length
					},
					counts
				}
			},
			{ isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 20000 }
		)
	} catch {
		throw failure()
	} finally {
		if (client) {
			try {
				await client.$disconnect()
			} catch {
				throw failure()
			}
		}
	}
}

// Use the oldest owner timestamp: a late final query must not make an earlier
// owner snapshot look fresh. Callers refresh all three before an admission.
export function mergeCrmCommerceDatabaseProof(results, now = Date.now()) {
	try {
		assert.ok(Number.isSafeInteger(now))
		assert.ok(Array.isArray(results) && results.length === 3)
		assert.deepEqual(
			results.map(row => row.owner).sort(),
			[...owners].sort()
		)
		const proof = {
			schemaVersion: 1,
			checkedAt: '',
			owners: {},
			counts: {}
		}
		const timestamps = []
		for (const row of results) {
			exact(row, [
				'schemaVersion',
				'owner',
				'checkedAt',
				'identity',
				'counts'
			])
			assert.equal(row.schemaVersion, 1)
			assert.equal(typeof row.checkedAt, 'string')
			const at = Date.parse(row.checkedAt)
			assert.ok(Number.isFinite(at) && at <= now && now - at <= 60000)
			timestamps.push(at)
			proof.owners[row.owner] = row.identity
			exact(row.counts, countKeys[row.owner])
			Object.assign(proof.counts, row.counts)
		}
		proof.checkedAt = new Date(Math.min(...timestamps)).toISOString()
		// Not an idle/admission decision: validate only exact shape and identity.
		assertCrmCommerceDatabaseProof(proof, proof, now, false)
		return proof
	} catch {
		throw failure()
	}
}
