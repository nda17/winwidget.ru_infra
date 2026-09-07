import assert from 'node:assert/strict'
import test from 'node:test'
import { CRM_UPGRADE_MIGRATIONS } from './crm-release.mjs'
import { assertCrmCommerceDatabaseProof } from './crm-commerce-activation.mjs'
import {
	crmCommerceDatabaseInput,
	crmCommerceDatabaseSql,
	mergeCrmCommerceDatabaseProof,
	parseCrmCommerceDatabaseHandoff,
	probeCrmCommerceDatabase
} from './crm-commerce-database.mjs'

const now = Date.parse('2026-09-07T14:00:00.000Z')
const at = new Date(now).toISOString()
const owners = ['billing', 'crm-access', 'crm-customers']
const rejected =
	/^CRM commerce database probe rejected; private details suppressed$/
const safeError = error => {
	assert.match(error.message, rejected)
	assert.equal(error.cause, undefined)
	return true
}
const binding = owner => {
	const schema = owner.replaceAll('-', '_')
	return {
		owner,
		migrationUrl: `postgresql://winwidget_${schema}_migration:fixture-only@127.0.0.1:55432/winwidget_${schema}?schema=${schema}&sslmode=disable`,
		runtimeBinding: {
			host: '127.0.0.1',
			port: '55432',
			username: `winwidget_${schema}_runtime`,
			database: `winwidget_${schema}`,
			schema
		}
	}
}
function fixture(owner) {
	const schema = owner.replaceAll('-', '_')
	const prefix = `winwidget_${schema}`
	const sql = crmCommerceDatabaseSql(owner)
	const rows = {
		identity: [
			{
				service_name: `${owner}-service`,
				database_id: `00000000-0000-4000-8000-00000000000${owners.indexOf(owner) + 1}`
			}
		],
		principal: [
			{
				db: prefix,
				username: `${prefix}_migration`,
				schema,
				recovery: false,
				version: 180003,
				read_only: 'on',
				isolation: 'repeatable read',
				checked_at: at,
				schema_owner: `${prefix}_migration`
			}
		],
		roles: ['migration', 'runtime'].map(name => ({
			rolname: `${prefix}_${name}`,
			rolcanlogin: true,
			rolsuper: false,
			rolcreatedb: false,
			rolcreaterole: false,
			rolinherit: owner === 'billing' && name === 'migration',
			rolreplication: false,
			rolbypassrls: false
		})),
		admin:
			owner === 'billing'
				? [
						{
							rolname: `${prefix}_admin`,
							rolcanlogin: true,
							rolsuper: true,
							databaseOwner: `${prefix}_admin`
						}
					]
				: [],
		memberships:
			owner === 'billing'
				? ['migration', 'runtime'].map(name => ({
						role: `${prefix}_${name}`,
						member: `${prefix}_admin`,
						grantor: `${prefix}_admin`,
						admin_option: false,
						inherit_option: true,
						set_option: true
					}))
				: [],
		ledger: [
			{
				id: '00000000-0000-4000-8000-000000000004',
				migration_name: '20260901000000_fixture',
				checksum: 'a'.repeat(64),
				finished_at: at,
				rolled_back_at: null
			}
		],
		acl: [
			{
				kind: 'schema',
				name: schema,
				owner: `${prefix}_migration`,
				acl: '{fixture}'
			}
		],
		billingGrants: [
			{
				read: true,
				append: true,
				mutate: false,
				grant_execute: false,
				receipt_execute: false
			}
		],
		billingTriggers: [
			'crm_admin_day_grants_append_only',
			'crm_admin_day_grants_no_truncate',
			'crm_admin_command_receipts_retention_guard',
			'crm_admin_command_receipts_no_truncate'
		].map(tgname => ({ tgname, tgenabled: 'O' })),
		counts: [
			owner === 'billing'
				? {
						orders: '0',
						renewals: '0',
						providerOperations: '0',
						paidPeriods: '0',
						dueRenewals: '0',
						pendingProviderDeliveries: '0',
						unpublishedProviderOutbox: '0'
					}
				: owner === 'crm-access'
					? { accessOperations: '0', accessCapacityFences: '0' }
					: {}
		]
	}
	const sourceFiles = {
		'schema.prisma': 'b'.repeat(64),
		'migration_lock.toml': 'c'.repeat(64),
		'20260901000000_fixture': 'a'.repeat(64)
	}
	const calls = []
	let disconnected = 0
	let transactionOptions
	const tx = {
		async $executeRawUnsafe(query) {
			calls.push(query)
			return 0
		},
		async $queryRawUnsafe(query) {
			calls.push(query)
			assert.deepEqual(calls.slice(0, 2), [
				'SET TRANSACTION READ ONLY',
				"SET LOCAL statement_timeout = '5s'"
			])
			const key = Object.keys(sql).find(key => sql[key] === query)
			assert.ok(key, 'No unreviewed SQL')
			return structuredClone(rows[key])
		}
	}
	const client = {
		async $transaction(action, options) {
			transactionOptions = options
			return action(tx)
		},
		async $disconnect() {
			disconnected += 1
		}
	}
	return {
		owner,
		input: binding(owner),
		sql,
		rows,
		sourceFiles,
		calls,
		tx,
		client,
		get disconnected() {
			return disconnected
		},
		get transactionOptions() {
			return transactionOptions
		},
		probe() {
			return probeCrmCommerceDatabase(owner, this.input, {
				sourceFiles: this.sourceFiles,
				client
			})
		}
	}
}

test('owner probes use one bounded repeatable-read READ ONLY transaction and return only hashes/counts', async () => {
	for (const owner of owners) {
		const f = fixture(owner)
		const result = await f.probe()
		assert.deepEqual(f.transactionOptions, {
			isolationLevel: 'RepeatableRead',
			maxWait: 5000,
			timeout: 20000
		})
		assert.equal(f.disconnected, 1)
		assert.deepEqual(Object.keys(result).sort(), [
			'checkedAt',
			'counts',
			'identity',
			'owner',
			'schemaVersion'
		])
		assert.equal(result.checkedAt, at)
		assert.equal(result.identity.pendingMigrations, 0)
		assert.equal(result.identity.readOnly, true)
		for (const key of [
			'sourceSha256',
			'ledgerSha256',
			'rolesSha256',
			'aclSha256'
		])
			assert.match(result.identity[key], /^[a-f0-9]{64}$/)
		assert.ok(!JSON.stringify(result).includes('fixture-only'))
		assert.ok(!JSON.stringify(result).includes('migrationUrl'))
		assert.ok(!JSON.stringify(result).includes('checksum'))
		assert.deepEqual(
			Object.values(result.counts),
			Object.values(f.rows.counts[0]).map(Number)
		)
		assert.equal(
			f.calls.filter(query => query.startsWith('SET ')).length,
			2
		)
		assert.ok(f.calls.slice(2).every(query => /^SELECT\s/.test(query)))
		assert.ok(f.calls.length <= 13)
	}
})

test('SQL uses exact current owner table/column contracts and no Widgets payment tables', () => {
	const billing = crmCommerceDatabaseSql('billing').counts
	for (const table of [
		'crm_orders',
		'crm_auto_renewals',
		'crm_provider_operations',
		'crm_paid_periods',
		'crm_provider_deliveries',
		'outbox_events'
	])
		assert.ok(billing.includes(`billing.${table}`))
	assert.ok(
		!/billing\.(?:payments|subscriptions|auto_renewals|provider_operations|payment_receipts)\b/.test(
			billing
		)
	)
	// Scheduler selection mirrors WincrmCommerceService.advanceRenewals exactly:
	// a future retry must not fall back to an older next_charge_at.
	assert.ok(billing.includes("status='ACTIVE' AND dispatch_pending=false"))
	assert.ok(
		billing.includes(
			'next_retry_at<=transaction_timestamp() OR (next_retry_at IS NULL AND next_charge_at<=transaction_timestamp())'
		)
	)
	assert.ok(billing.includes("status<>'DELIVERED'"))
	assert.ok(billing.includes("status<>'PUBLISHED'"))
	assert.ok(
		billing.includes(
			"event_type='billing.wincrm.provider-operation.requested.v1' OR routing_key='billing.wincrm.provider-operation.requested.v1'"
		)
	)
	assert.ok(!billing.includes('payload'))
	const access = crmCommerceDatabaseSql('crm-access').counts
	assert.ok(access.includes('FROM crm_access.crm_billing_operations'))
	assert.ok(
		access.includes(
			'pending_operation_id IS NOT NULL OR pending_target_seats IS NOT NULL'
		)
	)
	assert.ok(!access.includes('admission_ceiling IS NOT NULL')) // persistent ceiling is not a pending fence
	assert.equal(crmCommerceDatabaseSql('crm-customers').counts, null)
	for (const owner of owners) {
		const sql = crmCommerceDatabaseSql(owner)
		assert.ok(sql.memberships.includes('WHERE membership.member IN'))
		assert.ok(sql.memberships.includes('OR membership.roleid IN'))
		assert.ok(sql.acl.includes('pg_attribute'))
		assert.ok(sql.acl.includes('pg_default_acl'))
		assert.ok(sql.acl.includes("SELECT 'database'"))
		assert.ok(sql.acl.includes('pg_get_userbyid'))
	}
	for (const owner of [
		'identity',
		'crm-sales',
		'crm-intake',
		'billing;DROP',
		''
	])
		assert.throws(() => crmCommerceDatabaseSql(owner), safeError)
})

test('pre-admission rejects every nonzero counter, but admitted recovery preserves new activity', async () => {
	const results = await Promise.all(
		owners.map(owner => fixture(owner).probe())
	)
	const before = mergeCrmCommerceDatabaseProof(results, now)
	assert.equal(assertCrmCommerceDatabaseProof(before, before, now), true)
	for (const key of Object.keys(before.counts)) {
		const after = structuredClone(before)
		after.counts[key] = 1
		assert.throws(() =>
			assertCrmCommerceDatabaseProof(before, after, now, true)
		)
		assert.equal(
			assertCrmCommerceDatabaseProof(before, after, now, false),
			true
		)
	}
})

test('identity, principal, read-only/isolation and nonprivileged roles are fail closed before counters', async () => {
	const mutations = [
		f => {
			f.rows.identity[0].service_name = 'crm-sales-service'
		},
		f => {
			f.rows.identity[0].database_id = 'not-a-uuid'
		},
		f => {
			f.rows.identity.push(f.rows.identity[0])
		},
		f => {
			f.rows.principal[0].db = 'other_database'
		},
		f => {
			f.rows.principal[0].username = 'winwidget_billing_admin'
		},
		f => {
			f.rows.principal[0].schema = 'public'
		},
		f => {
			f.rows.principal[0].schema_owner = 'unexpected_role'
		},
		f => {
			f.rows.principal[0].recovery = true
		},
		f => {
			f.rows.principal[0].version = 170006
		},
		f => {
			f.rows.principal[0].version = '180003'
		},
		f => {
			f.rows.principal[0].read_only = 'off'
		},
		f => {
			f.rows.principal[0].isolation = 'read committed'
		},
		f => {
			f.rows.principal[0].checked_at = 'invalid'
		},
		f => {
			f.rows.principal[0].checked_at = null
		},
		f => {
			f.rows.roles.pop()
		},
		f => {
			f.rows.roles[0].rolname = 'unexpected_role'
		},
		...[
			'rolsuper',
			'rolcreatedb',
			'rolcreaterole',
			'rolreplication',
			'rolbypassrls'
		].map(key => f => {
			f.rows.roles[1][key] = true
		}),
		f => {
			f.rows.roles[1].rolcanlogin = false
		},
		f => {
			f.rows.roles[1].rolinherit = true
		}
	]
	for (const owner of owners)
		for (const mutate of mutations) {
			const f = fixture(owner)
			mutate(f)
			await assert.rejects(f.probe(), safeError)
			assert.equal(f.disconnected, 1)
			assert.ok(!f.calls.includes(f.sql.counts))
		}
})

test('reuse exact Billing admin memberships and zero CRM memberships, never broaden role graph', async () => {
	for (const owner of owners) {
		const f = fixture(owner)
		f.rows.memberships.push({
			role: 'pg_read_all_data',
			member: `winwidget_${owner.replaceAll('-', '_')}_runtime`,
			grantor: 'unexpected_role',
			admin_option: false,
			inherit_option: false,
			set_option: true
		})
		await assert.rejects(f.probe(), safeError)
	}
	for (const mutate of [
		f => {
			f.rows.memberships.pop()
		},
		f => {
			f.rows.memberships[0].admin_option = true
		},
		f => {
			;[f.rows.memberships[0].role, f.rows.memberships[0].member] = [
				f.rows.memberships[0].member,
				f.rows.memberships[0].role
			]
		},
		f => {
			f.rows.admin[0].rolsuper = false
		},
		f => {
			f.rows.admin[0].databaseOwner = 'unexpected_role'
		}
	]) {
		const f = fixture('billing')
		mutate(f)
		await assert.rejects(f.probe(), safeError)
	}
	for (const owner of ['crm-access', 'crm-customers']) {
		const f = fixture(owner)
		f.rows.roles[0].rolinherit = true
		await assert.rejects(f.probe(), safeError)
	}
})

test('source/ledger must be complete and byte-matched including the sole reviewed Billing rollback', async () => {
	for (const mutate of [
		f => {
			f.rows.ledger[0].checksum = 'd'.repeat(64)
		},
		f => {
			f.rows.ledger[0].finished_at = null
		},
		f => {
			f.rows.ledger[0].rolled_back_at = at
		},
		f => {
			f.rows.ledger.push(f.rows.ledger[0])
		},
		f => {
			f.rows.ledger = []
		},
		f => {
			f.rows.ledger[0].migration_name = '20260801000000_unknown'
		},
		f => {
			f.sourceFiles['schema.prisma'] = 'invalid'
		},
		f => {
			delete f.sourceFiles['migration_lock.toml']
		},
		f => {
			f.sourceFiles['../../other-file'] = 'd'.repeat(64)
		},
		f => {
			f.sourceFiles['20260912000000_unreviewed'] = 'd'.repeat(64)
		}
	]) {
		const f = fixture('billing')
		mutate(f)
		await assert.rejects(f.probe(), safeError)
	}
	const f = fixture('billing')
	const migration = '20260909110000_restrict_wincrm_commerce_runtime_acl'
	f.sourceFiles[migration] = CRM_UPGRADE_MIGRATIONS.billing[migration]
	f.rows.ledger.push(
		{
			id: '412a6ec9-35c7-4c1a-ad94-b11dbae1e889',
			migration_name: migration,
			checksum: f.sourceFiles[migration],
			finished_at: null,
			rolled_back_at: at
		},
		{
			id: '00000000-0000-4000-8000-000000000005',
			migration_name: migration,
			checksum: f.sourceFiles[migration],
			finished_at: at,
			rolled_back_at: null
		}
	)
	assert.equal((await f.probe()).identity.pendingMigrations, 0)
})

test('Billing manual grants ACL and durable retention triggers remain mandatory', async () => {
	for (const mutate of [
		f => {
			f.rows.billingGrants[0].mutate = true
		},
		f => {
			f.rows.billingGrants[0].read = false
		},
		f => {
			f.rows.billingGrants[0].append = false
		},
		f => {
			f.rows.billingGrants[0].grant_execute = true
		},
		f => {
			f.rows.billingGrants[0].receipt_execute = true
		},
		f => {
			f.rows.billingTriggers.pop()
		},
		f => {
			f.rows.billingTriggers[0].tgenabled = 'D'
		},
		f => {
			f.rows.acl = []
		}
	]) {
		const f = fixture('billing')
		mutate(f)
		await assert.rejects(f.probe(), safeError)
	}
})

test('count decoding rejects partial, unsafe, negative or silently rounded PostgreSQL totals', async () => {
	for (const value of [
		null,
		undefined,
		0,
		1n,
		'-1',
		'1.5',
		'01',
		'1e3',
		'9007199254740992',
		'10000000000000000'
	]) {
		const f = fixture('billing')
		f.rows.counts[0].orders = value
		await assert.rejects(f.probe(), safeError)
	}
	for (const mutate of [
		f => {
			delete f.rows.counts[0].orders
		},
		f => {
			f.rows.counts[0].extra = '0'
		},
		f => {
			f.rows.counts = []
		},
		f => {
			f.rows.counts.push(f.rows.counts[0])
		}
	]) {
		const f = fixture('billing')
		mutate(f)
		await assert.rejects(f.probe(), safeError)
	}
	const f = fixture('billing')
	f.rows.counts[0].orders = '9007199254740991'
	assert.equal((await f.probe()).counts.orders, Number.MAX_SAFE_INTEGER)
})

test('aggregate uses oldest snapshot, rejects missing/duplicate/stale/future owners and preserves fingerprints', async () => {
	const results = await Promise.all(
		owners.map(owner => fixture(owner).probe())
	)
	results[0].checkedAt = new Date(now - 40000).toISOString()
	const proof = mergeCrmCommerceDatabaseProof(results, now)
	assert.equal(proof.checkedAt, results[0].checkedAt)
	for (const mutate of [
		r => r.pop(),
		r => {
			r[1] = r[0]
		},
		r => {
			r[0].checkedAt = new Date(now - 60001).toISOString()
		},
		r => {
			r[2].checkedAt = new Date(now + 1).toISOString()
		},
		r => {
			r[0].identity.databaseId = r[1].identity.databaseId
		},
		r => {
			r[0].identity.sourceSha256 = ''
		},
		r => {
			r[0].identity.pendingMigrations = 1
		},
		r => {
			r[0].identity.readOnly = false
		},
		r => {
			r[0].identity.extra = true
		},
		r => {
			r[0].counts.orders = '0'
		},
		r => {
			r[2].counts.orders = 0
		},
		r => {
			r[0].unexpected = true
		}
	]) {
		const changed = structuredClone(results)
		mutate(changed)
		assert.throws(
			() => mergeCrmCommerceDatabaseProof(changed, now),
			safeError
		)
	}
	for (const field of [
		'databaseId',
		'sourceSha256',
		'ledgerSha256',
		'rolesSha256',
		'aclSha256'
	]) {
		const changed = structuredClone(proof)
		changed.owners.billing[field] =
			field === 'databaseId'
				? '00000000-0000-4000-8000-000000000009'
				: 'f'.repeat(64)
		assert.throws(() =>
			assertCrmCommerceDatabaseProof(proof, changed, now, false)
		)
	}
})

test('private handoff inherits exact migration/runtime binding and never returns raw parser/driver errors', async () => {
	for (const owner of owners) {
		const input = binding(owner)
		assert.deepEqual(
			parseCrmCommerceDatabaseHandoff(Buffer.from(JSON.stringify(input))),
			input
		)
		const schema = owner.replaceAll('-', '_')
		const live = [
			{
				Config: {
					Labels: {
						'com.docker.compose.project':
							owner === 'billing' ? 'winwidget' : 'winwidget-crm',
						'com.docker.compose.service': `${owner}-api`
					},
					Env: [
						`${schema.toUpperCase()}_DATABASE_URL=${input.migrationUrl.replace('_migration:', '_runtime:')}`
					]
				}
			}
		]
		assert.deepEqual(
			crmCommerceDatabaseInput(
				owner,
				`${schema.toUpperCase()}_MIGRATION_DATABASE_URL=${input.migrationUrl}`,
				live
			),
			input
		)
	}
	for (const mutate of [
		v => {
			v.owner = 'identity'
		},
		v => {
			v.extra = true
		},
		v => {
			v.migrationUrl = v.migrationUrl.replace(
				'127.0.0.1',
				'example.invalid'
			)
		},
		v => {
			v.migrationUrl = v.migrationUrl.replace('_migration:', '_admin:')
		},
		v => {
			v.migrationUrl += '&schema=public'
		},
		v => {
			v.migrationUrl += '&options=unsafe'
		},
		v => {
			v.runtimeBinding.port = '55433'
		},
		v => {
			v.runtimeBinding.schema = 'public'
		}
	]) {
		const v = binding('billing')
		mutate(v)
		assert.throws(
			() =>
				parseCrmCommerceDatabaseHandoff(Buffer.from(JSON.stringify(v))),
			safeError
		)
	}
	for (const value of [
		Buffer.alloc(0),
		Buffer.alloc(16385),
		Buffer.from('{"migrationUrl":"secret-parser-fixture"'),
		Buffer.from('{"owner":"billing","owner":"billing"}'),
		Buffer.from([0xff]),
		Buffer.from(JSON.stringify(binding('billing')) + '\n')
	])
		assert.throws(() => parseCrmCommerceDatabaseHandoff(value), safeError)
	const f = fixture('billing')
	f.tx.$queryRawUnsafe = async () => {
		throw new Error('secret-driver-fixture')
	}
	await assert.rejects(f.probe(), safeError)
	assert.equal(f.disconnected, 1)
	const badInput = fixture('billing')
	badInput.input.migrationUrl = 'secret-url-fixture'
	await assert.rejects(badInput.probe(), safeError)
	assert.equal(badInput.calls.length, 0)
})

test('canonical source hashing is insensitive to object key insertion order, not content changes', async () => {
	const first = fixture('crm-access')
	const before = await first.probe()
	const second = fixture('crm-access')
	second.sourceFiles = Object.fromEntries(
		Object.entries(second.sourceFiles).reverse()
	)
	assert.equal(
		(await second.probe()).identity.sourceSha256,
		before.identity.sourceSha256
	)
	second.sourceFiles['schema.prisma'] = 'e'.repeat(64)
	assert.notEqual(
		(await second.probe()).identity.sourceSha256,
		before.identity.sourceSha256
	)
})
