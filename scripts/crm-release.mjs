import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const owners = ['crm-access', 'crm-intake', 'crm-customers', 'crm-sales']
export const CRM_RUNTIME_NAMES = Object.freeze([
	'crm-access-api',
	'crm-customers-api',
	'crm-sales-api',
	'crm-intake-api',
	'crm-access-worker',
	'crm-access-outbox-publisher',
	'crm-intake-worker',
	'crm-intake-publisher',
	'crm-intake-widget-control-worker',
	'crm-intake-widget-control-publisher',
	'crm-intake-widget-transfer-worker',
	'crm-intake-widget-transfer-publisher'
])
const digest = value => createHash('sha256').update(value).digest('hex')
const revision = value =>
	typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const sha = value =>
	typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const imageId = value =>
	typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)

// Reviewed steady-state upgrade groups. Stop every old process in a group
// before starting any replacement, keeping unrelated services and all DBs live.
export const CRM_UPGRADE_GROUPS = Object.freeze(
	[
		['identity', 'identity-api'],
		[
			'billing',
			'billing-worker',
			'billing-outbox-publisher',
			'billing-scheduler',
			'billing-api'
		],
		[
			'crm-access',
			'crm-access-worker',
			'crm-access-outbox-publisher',
			'crm-access-api'
		],
		['crm-customers', 'crm-customers-api'],
		['notification-delivery', 'notification-delivery-worker'],
		['crm-sales', 'crm-sales-api'],
		[
			'crm-intake',
			'crm-intake-worker',
			'crm-intake-widget-control-worker',
			'crm-intake-widget-transfer-worker',
			'crm-intake-publisher',
			'crm-intake-widget-control-publisher',
			'crm-intake-widget-transfer-publisher',
			'crm-intake-api'
		]
	].map(Object.freeze)
)
const reminderUpgradeGroups = Object.freeze(
	CRM_UPGRADE_GROUPS.map(group =>
		group[0] === 'crm-sales'
			? Object.freeze([
					'crm-sales',
					'crm-sales-reminders',
					'crm-sales-api'
				])
			: group
	)
)
export function crmUpgradeRemindersContract(value = 'disabled') {
	assert.ok(['disabled', 'task-reminders-v1'].includes(value))
	return value
}
export function crmUpgradeRemindersContractFromEnv(source) {
	assert.equal(typeof source, 'string')
	assert.ok(Buffer.byteLength(source) <= 1048576)
	const lines = source
		.split(/\r?\n/)
		.filter(line =>
			/^\s*(?:export\s+)?CRM_REMINDERS_RABBITMQ_CONTRACT\b/.test(line)
		)
	assert.ok(lines.length <= 1)
	if (!lines.length) return 'disabled'
	const match =
		/^CRM_REMINDERS_RABBITMQ_CONTRACT=(disabled|task-reminders-v1|"(?:disabled|task-reminders-v1)"|'(?:disabled|task-reminders-v1)')$/.exec(
			lines[0]
		)
	assert.ok(match)
	return crmUpgradeRemindersContract(match[1].replace(/^['"]|['"]$/g, ''))
}
export function crmUpgradeIntakeSlaContract(
	value = 'disabled',
	reminders = 'disabled'
) {
	assert.ok(['disabled', 'intake-sla-v1'].includes(value))
	if (value !== 'disabled')
		assert.equal(
			crmUpgradeRemindersContract(reminders),
			'task-reminders-v1'
		)
	return value
}
export function crmUpgradeIntakeSlaContractFromEnv(source) {
	const reminders = crmUpgradeRemindersContractFromEnv(source)
	const lines = source
		.split(/\r?\n/)
		.filter(line =>
			/^\s*(?:export\s+)?CRM_INTAKE_SLA_RABBITMQ_CONTRACT\b/.test(line)
		)
	assert.ok(lines.length <= 1)
	if (!lines.length) return 'disabled'
	const match =
		/^CRM_INTAKE_SLA_RABBITMQ_CONTRACT=(disabled|intake-sla-v1|"(?:disabled|intake-sla-v1)"|'(?:disabled|intake-sla-v1)')$/.exec(
			lines[0]
		)
	assert.ok(match)
	return crmUpgradeIntakeSlaContract(
		match[1].replace(/^['"]|['"]$/g, ''),
		reminders
	)
}
export function crmUpgradeGroups(
	contract = 'disabled',
	intakeSlaContract = 'disabled'
) {
	const groups =
		crmUpgradeRemindersContract(contract) === 'disabled'
			? CRM_UPGRADE_GROUPS
			: reminderUpgradeGroups
	return crmUpgradeIntakeSlaContract(intakeSlaContract, contract) ===
		'disabled'
		? groups
		: groups.map(group =>
				group[0] === 'crm-intake'
					? Object.freeze([
							...group.slice(0, -1),
							'crm-intake-sla-worker',
							'crm-intake-sla-publisher',
							group.at(-1)
						])
					: group
			)
}
export const CRM_UPGRADE_MIGRATIONS = Object.freeze({
	identity: {},
	billing: {
		'20260909110000_restrict_wincrm_commerce_runtime_acl':
			'ad429d7f4324f2dbf62de73e1492084dbf8b61cb589c172de891b0d5edf4a415',
		'20260910120000_add_crm_admin_day_grants':
			'08604505885f1e2228387b4f5ffd6f32e75bbb74e240c05faab7e87ae5e244d4'
	},
	'crm-access': {
		'20260907100000_add_employee_profiles':
			'ad58076fcfc75a84c55efe0ea08aab8292ba0688790f0566cf5336538ecc635a',
		'20260907150000_add_workspace_branding':
			'c4d1fb7192e1a35f82b8f2108def86d13d3fa02741a5dffa5d2ac3f273b1252e'
	},
	'crm-customers': {
		'20260907210000_add_company_requisites':
			'2906853950f496d481dc831af21d824418ecd7281f105ad3b3356e98c90fbfc1',
		'20260907223000_add_contact_call_preferences':
			'6ec838976adc8aa583b29a7732fe9cbddabb60d63ab7efd3b67c7d78968e0fec'
	},
	'notification-delivery': {
		'20260907230000_add_wincrm_task_reminders':
			'ecd2b1677dccc6c0515ef38baf28a4407c0ae4882c68bbcf4d60da11fd807b27'
	},
	'crm-sales': {
		'20260907120000_add_task_in_progress':
			'1718b37fd803dd6112cbae330434c8997daf86bf4a7a890a38a55ec07cff634a',
		'20260907120100_expand_workday_tasks':
			'682d6f9684489a51e7f138588e5cceb38b6c05824cbc7dc6d186354aad54be53',
		'20260907140000_add_workday_commands':
			'3af100250b2046060f9ab3a368d37dd88065dac222247a5f16108390a003a87e',
		'20260907220000_add_reminder_rules':
			'd207e844a7f74b858745d598ebfb9a76cb910f83847931dfb087ad86e9794ddf',
		'20260907230000_add_reminder_delivery':
			'd05634a4704c8947cb48a9bf379436e519417545d09ddec6833b1bb692491190',
		'20260908090000_allow_task_reopen_after_deal_close':
			'7e5c9fb33cc6451ef5d2fb974e9bf1b018827bbdd0d0d518d60015220280a650',
		'20260908120000_add_recurring_task_series':
			'9a03d38db5037068c19c606d16a2515e3088d51c3e2bd88d60aa8270c87eb318',
		'20260908130000_add_task_assignment_notifications':
			'c26b5649ceaace470fcfbe10d76013a7edb7d20192d71669eb999f114fc7c87e',
		'20260908140000_add_task_notification_center':
			'799490bcf980d282ef48041934b8728dc6554d0db267455051b145fb0b7eef8a'
	},
	'crm-intake': {
		'20260908150000_add_intake_sla':
			'589b0303e2153e90d5a2edf6dc9655a1a4d96f59ade4f7057d17419bcd7b3234'
	}
})
const upgradeProject = owner =>
	owner.startsWith('crm-') ? 'winwidget-crm' : 'winwidget'
const upgradeKey = item =>
	`${item.Config?.Labels?.['com.docker.compose.project']}/${item.Config?.Labels?.['com.docker.compose.service']}`
const upgradeTargetsFor = (contract, intakeSlaContract) =>
	crmUpgradeGroups(contract, intakeSlaContract).flatMap(
		([owner, ...names]) =>
			names.map(name => `${upgradeProject(owner)}/${name}`)
	)
const envObject = entries => {
	const result = {}
	for (const entry of entries) {
		const at = entry.indexOf('=')
		assert.ok(at > 0 && !Object.hasOwn(result, entry.slice(0, at)))
		result[entry.slice(0, at)] = entry.slice(at + 1)
	}
	return result
}
const stableJson = value =>
	JSON.stringify(value, (_, item) =>
		item && typeof item === 'object' && !Array.isArray(item)
			? Object.fromEntries(
					Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
				)
			: item
	)

function upgradeConfiguration(container) {
	const config = structuredClone(container.Config)
	delete config.Hostname
	delete config.Image
	config.Env = envObject(config.Env)
	delete config.Env.APP_REVISION
	config.Labels = Object.fromEntries(
		Object.entries(config.Labels).filter(
			([key]) =>
				!key.startsWith('com.docker.compose.') &&
				key !== 'org.opencontainers.image.revision'
		)
	)
	return {
		key: upgradeKey(container),
		name: container.Name,
		containerNumber:
			container.Config.Labels['com.docker.compose.container-number'],
		oneoff: container.Config.Labels['com.docker.compose.oneoff'],
		config,
		host: container.HostConfig,
		mounts: [...container.Mounts].sort((a, b) =>
			a.Destination.localeCompare(b.Destination)
		)
	}
}

function upgradeHealthy(item) {
	assert.ok(sha(item.Id) && imageId(item.Image))
	assert.equal(item.State.Running, true)
	for (const key of ['Paused', 'Restarting', 'OOMKilled', 'Dead'])
		assert.equal(item.State[key], false)
	assert.equal(item.State.Health.Status, 'healthy')
	assert.equal(item.RestartCount, 0)
}

// Public baseline contains only identities/hashes, never container env values.
export function crmUpgradeBaseline(
	live,
	gatewayRevision,
	environmentHashes,
	remindersContract = 'disabled',
	intakeSlaContract = 'disabled'
) {
	const upgradeTargets = upgradeTargetsFor(
		remindersContract,
		intakeSlaContract
	)
	assert.ok(Array.isArray(live) && live.length <= 200)
	assert.equal(new Set(live.map(upgradeKey)).size, live.length)
	assert.equal(new Set(live.map(item => item.Id)).size, live.length)
	assert.deepEqual(Object.keys(environmentHashes).sort(), [
		'billing',
		'canonical',
		'crm',
		'identity',
		'notification-delivery'
	])
	for (const value of Object.values(environmentHashes))
		assert.ok(sha(value))
	for (const key of upgradeTargets)
		assert.equal(live.filter(item => upgradeKey(item) === key).length, 1)
	// No stopped/unknown CRM one-offs may be hidden from the snapshot.
	assert.deepEqual(
		live
			.filter(item => upgradeKey(item).startsWith('winwidget-crm/'))
			.map(upgradeKey)
			.sort(),
		[
			...upgradeTargets.filter(key => key.startsWith('winwidget-crm/')),
			...owners.map(owner => `winwidget-crm/${owner}-postgres`)
		].sort()
	)
	for (const item of live) upgradeHealthy(item)
	if (remindersContract !== 'disabled') {
		for (const name of ['crm-sales-api', 'crm-sales-reminders']) {
			const env = envObject(
				live.find(item => upgradeKey(item) === `winwidget-crm/${name}`)
					.Config.Env
			)
			assert.equal(env.CRM_TASK_REMINDERS_ENABLED, 'true')
			assert.equal(
				env.CRM_SALES_PROCESS_ROLE,
				name === 'crm-sales-api' ? 'api' : 'reminders'
			)
		}
		const env = envObject(
			live.find(
				item =>
					upgradeKey(item) === 'winwidget/notification-delivery-worker'
			).Config.Env
		)
		const kinds = (env.NOTIFICATION_DELIVERY_KINDS ?? '').split(',')
		assert.deepEqual(
			[...kinds].sort(),
			[
				'email',
				'telegram',
				'payment-email',
				'payment-telegram',
				'limit-email',
				'limit-telegram',
				'campaign-email',
				'campaign-telegram',
				'daily-summary-delivery-telegram',
				'subscription-expiry-email',
				'subscription-expiry-telegram',
				'wincrm-invitation-email',
				'wincrm-task-reminder-email',
				'wincrm-task-reminder-telegram',
				...(intakeSlaContract === 'disabled'
					? []
					: ['wincrm-intake-sla-email', 'wincrm-intake-sla-telegram'])
			].sort()
		)
	}
	if (intakeSlaContract !== 'disabled') {
		for (const [name, role] of [
			['crm-intake-api', 'api'],
			['crm-intake-sla-worker', 'sla-worker'],
			['crm-intake-sla-publisher', 'sla-publisher']
		]) {
			const env = envObject(
				live.find(item => upgradeKey(item) === `winwidget-crm/${name}`)
					.Config.Env
			)
			assert.equal(env.CRM_INTAKE_SLA_ENABLED, 'true')
			assert.equal(env.CRM_INTAKE_PROCESS_ROLE, role)
		}
	}
	return {
		schemaVersion: 1,
		kind: 'winwidget.crm.upgrade-baseline.v1',
		...(remindersContract === 'disabled' ? {} : { remindersContract }),
		...(intakeSlaContract === 'disabled' ? {} : { intakeSlaContract }),
		gatewayRevision,
		environmentHashes,
		neighborsSha256: crmNeighborFingerprint(
			live.filter(item => !upgradeTargets.includes(upgradeKey(item))),
			gatewayRevision
		),
		targets: Object.fromEntries(
			upgradeTargets.map(key => {
				const item = live.find(container => upgradeKey(container) === key)
				const currentRevision =
					item.Config.Labels['org.opencontainers.image.revision'] ??
					envObject(item.Config.Env).APP_REVISION
				assert.ok(revision(currentRevision))
				assert.equal(
					envObject(item.Config.Env).APP_REVISION,
					currentRevision
				)
				return [
					key,
					{
						id: item.Id,
						image: item.Image,
						revision: currentRevision,
						configurationSha256: digest(
							stableJson(upgradeConfiguration(item))
						)
					}
				]
			})
		)
	}
}

export function crmUpgradeImageSource(prismaRoot) {
	assert.ok(
		lstatSync(prismaRoot).isDirectory() &&
			!lstatSync(prismaRoot).isSymbolicLink()
	)
	const files = {}
	for (const name of ['schema.prisma', 'database-access.json']) {
		const file = join(prismaRoot, name)
		if (
			name === 'database-access.json' &&
			!readdirSync(prismaRoot).includes(name)
		)
			continue
		assert.ok(
			lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink()
		)
		files[name] = digest(readFileSync(file))
	}
	const migrations = join(prismaRoot, 'migrations')
	assert.ok(
		lstatSync(migrations).isDirectory() &&
			!lstatSync(migrations).isSymbolicLink()
	)
	// Billing/CRM keep the lock beside schema.prisma; Notification Delivery
	// keeps it inside migrations. Hash exactly one real file in either layout.
	const rootLock = join(prismaRoot, 'migration_lock.toml')
	if (readdirSync(prismaRoot).includes('migration_lock.toml')) {
		assert.ok(
			lstatSync(rootLock).isFile() && !lstatSync(rootLock).isSymbolicLink()
		)
		assert.ok(!readdirSync(migrations).includes('migration_lock.toml'))
		files['migration_lock.toml'] = digest(readFileSync(rootLock))
	}
	for (const name of readdirSync(migrations).sort()) {
		if (name === 'migration_lock.toml') {
			const lock = join(migrations, name)
			assert.ok(
				lstatSync(lock).isFile() && !lstatSync(lock).isSymbolicLink()
			)
			files[name] = digest(readFileSync(lock))
			continue
		}
		assert.match(name, /^\d{14}_[a-z0-9_]+$/)
		const directory = join(migrations, name)
		assert.ok(
			lstatSync(directory).isDirectory() &&
				!lstatSync(directory).isSymbolicLink()
		)
		assert.deepEqual(readdirSync(directory), ['migration.sql'])
		const file = join(directory, 'migration.sql')
		assert.ok(
			lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink()
		)
		files[name] = digest(readFileSync(file))
	}
	assert.ok(
		Object.keys(files).length > 1 && Object.keys(files).length <= 103
	)
	return files
}

export function crmUpgradeOldImages(baseline, owner) {
	assert.ok(Object.hasOwn(CRM_UPGRADE_MIGRATIONS, owner))
	const group = crmUpgradeGroups(
		baseline.remindersContract,
		baseline.intakeSlaContract
	)
		.find(([name]) => name === owner)
		.slice(1)
	const values = [
		...new Set(
			group.map(
				name => baseline.targets[`${upgradeProject(owner)}/${name}`].image
			)
		)
	]
	for (const value of values) assert.ok(imageId(value))
	return values
}

export function crmUpgradeSource(owner, before, after) {
	assert.ok(Object.hasOwn(CRM_UPGRADE_MIGRATIONS, owner))
	let intakeExpansion = false
	if (owner === 'crm-intake') {
		const migration = '20260908150000_add_intake_sla'
		if (
			before['schema.prisma'] !== after['schema.prisma'] ||
			before['database-access.json'] !== after['database-access.json'] ||
			Object.hasOwn(before, migration) !== Object.hasOwn(after, migration)
		) {
			// One reviewed forward-only schema/ACL/SQL pair. All older SQL and
			// the migration lock remain byte-identical in the checks below.
			assert.equal(
				before['schema.prisma'],
				'257d0a67d31d85da2c4d33c0faae2432c78c0f277dcd6b14df2f608b049e0127'
			)
			assert.equal(
				before['database-access.json'],
				'7b725eb5dd949b495b0c7d220d5e06b7becd0bb32561806ead18edc75f1985e7'
			)
			assert.equal(Object.hasOwn(before, migration), false)
			assert.equal(
				after['schema.prisma'],
				'3b4e7e2aee31723947be674c718b5fbde51caa90061485d12106a7ce47cc5e22'
			)
			assert.equal(
				after['database-access.json'],
				'30bcb199891779d8f6eefe89cb1af8280b957e98e6c7eb2db1d749146384ae01'
			)
			assert.equal(
				after[migration],
				CRM_UPGRADE_MIGRATIONS[owner][migration]
			)
			intakeExpansion = true
		}
	}
	if (owner === 'crm-customers') {
		const migrations = Object.keys(CRM_UPGRADE_MIGRATIONS[owner])
		const schemas = [
			'be7b6d591352f4dbd77310df08f3d27971a49ede45cb653a8ff6ac6ea2823b12',
			'7d17e1d8b4cdc31cea0e342427aa84d1b388d3f22515b2e5cfcacde1afe79b42',
			'4ceda3fabb6a6923f5a75c540ff01b89926ea0d8c27c1f40e6e57e8fa40c51d2'
		]
		if (
			before['schema.prisma'] !== after['schema.prisma'] ||
			migrations.some(
				name => !Object.hasOwn(before, name) && Object.hasOwn(after, name)
			)
		) {
			// Exact forward-only schema/SQL pairs, preserving every old SQL byte
			// and the unchanged table-level ACL manifest. No unpaired model edit.
			const start = schemas.indexOf(before['schema.prisma'])
			const end = schemas.indexOf(after['schema.prisma'])
			assert.ok(start >= 0 && end > start)
			for (const name of migrations.slice(start, end)) {
				assert.equal(Object.hasOwn(before, name), false)
				assert.equal(after[name], CRM_UPGRADE_MIGRATIONS[owner][name])
			}
			assert.deepEqual(
				migrations.filter(
					name =>
						!Object.hasOwn(before, name) && Object.hasOwn(after, name)
				),
				migrations.slice(start, end)
			)
		}
	}
	for (const [name, checksum] of Object.entries(before)) {
		assert.ok(sha(checksum))
		if (
			(['schema.prisma', 'database-access.json'].includes(name) &&
				(['billing', 'crm-access', 'crm-sales'].includes(owner) ||
					intakeExpansion)) ||
			(owner === 'crm-customers' && name === 'schema.prisma')
		) {
			assert.ok(sha(after[name]))
			continue
		}
		assert.equal(after[name], checksum)
	}
	for (const [name, checksum] of Object.entries(after)) {
		assert.ok(sha(checksum))
		if (Object.hasOwn(before, name)) continue
		assert.equal(CRM_UPGRADE_MIGRATIONS[owner][name], checksum)
	}
	if (owner === 'identity' || (owner === 'crm-intake' && !intakeExpansion))
		assert.deepEqual(after, before)
	return true
}

// Exact, read-only evidence of ND's completed 28 Aug recovery. Failed SQL is
// historical only; it is never run, resolved, removed or silently reclassified.
export const CRM_NOTIFICATION_RECOVERY_ROWS = Object.freeze([
	Object.freeze({
		id: '9fcc2093-f12e-4c6b-9633-0687acbc2320',
		migration_name:
			'20260828000000_remove_online_consultant_delivery_data',
		checksum:
			'c19ca8b79eae01ef55034640ed0c1fb3fd6aa9700bdd7c403e5ef6f6e7cc76e4',
		started_at: '2026-08-28 06:44:36.325562+00',
		finished_at: null,
		rolled_back_at: '2026-08-28 07:33:40.575583+00',
		applied_steps_count: 0,
		logs_fingerprint: 'd41d8cd98f00b204e9800998ecf8427e'
	}),
	Object.freeze({
		id: '18a2268c-e992-4115-82be-0c80552297bc',
		migration_name:
			'20260828000000_remove_online_consultant_delivery_data',
		checksum:
			'b87064c3e4269c660c5cd16d8e83afbfb78c3362afc8c30f1b9a9efa927d4596',
		started_at: '2026-08-28 07:37:05.763502+00',
		finished_at: '2026-08-28 07:37:05.780369+00',
		rolled_back_at: null,
		applied_steps_count: 1,
		logs_fingerprint: 'd41d8cd98f00b204e9800998ecf8427e'
	})
])

function assertNotificationRecovery(files, rows) {
	const name = CRM_NOTIFICATION_RECOVERY_ROWS[0].migration_name
	assert.equal(files[name], CRM_NOTIFICATION_RECOVERY_ROWS[1].checksum)
	const recovered = rows.filter(row => row.migration_name === name)
	assert.equal(recovered.length, 2)
	for (const expected of CRM_NOTIFICATION_RECOVERY_ROWS) {
		const actual = recovered.find(row => row.id === expected.id)
		assert.ok(actual)
		assert.deepEqual(
			Object.fromEntries(
				Object.keys(expected).map(key => [key, actual[key]])
			),
			expected
		)
	}
}

export function crmUpgradeLedger(owner, files, rows, complete = false) {
	assert.ok(Object.hasOwn(CRM_UPGRADE_MIGRATIONS, owner))
	if (
		owner === 'notification-delivery' &&
		rows.some(row =>
			CRM_NOTIFICATION_RECOVERY_ROWS.some(known => known.id === row.id)
		)
	)
		assertNotificationRecovery(files, rows)
	const applied = new Set()
	for (const row of rows) {
		if (row.rolled_back_at) {
			if (owner === 'notification-delivery') {
				assert.equal(row.id, CRM_NOTIFICATION_RECOVERY_ROWS[0].id)
				assert.equal(
					row.migration_name,
					CRM_NOTIFICATION_RECOVERY_ROWS[0].migration_name
				)
				assertNotificationRecovery(files, rows)
				continue
			}
			// Retain the separately reviewed Billing recovery unchanged.
			assert.equal(owner, 'billing')
			assert.equal(row.id, '412a6ec9-35c7-4c1a-ad94-b11dbae1e889')
			assert.equal(
				row.migration_name,
				'20260909110000_restrict_wincrm_commerce_runtime_acl'
			)
			assert.equal(
				row.checksum,
				CRM_UPGRADE_MIGRATIONS.billing[row.migration_name]
			)
			assert.equal(row.finished_at, null)
			assert.ok(Number.isFinite(Date.parse(row.rolled_back_at)))
			continue
		}
		assert.ok(row.finished_at && !applied.has(row.migration_name))
		assert.equal(files[row.migration_name], row.checksum)
		applied.add(row.migration_name)
	}
	const pending = Object.keys(files)
		.filter(name => /^\d{14}_/.test(name) && !applied.has(name))
		.sort()
	for (const name of pending) {
		assert.equal(CRM_UPGRADE_MIGRATIONS[owner][name], files[name])
		// The old ACL release must already have completed successfully.
		assert.notEqual(
			name,
			'20260909110000_restrict_wincrm_commerce_runtime_acl'
		)
	}
	if (complete) assert.equal(pending.length, 0)
	return pending
}

export function crmUpgradeTaskWriterStop(owner, pending) {
	assert.ok(Object.hasOwn(CRM_UPGRADE_MIGRATIONS, owner))
	assert.ok(Array.isArray(pending))
	assert.ok(
		pending.every(name =>
			Object.hasOwn(CRM_UPGRADE_MIGRATIONS[owner], name)
		)
	)
	return (
		(owner === 'crm-intake' &&
			pending.includes('20260908150000_add_intake_sla')) ||
		(owner === 'crm-sales' &&
			pending.some(name =>
				[
					'20260908130000_add_task_assignment_notifications',
					'20260908140000_add_task_notification_center'
				].includes(name)
			))
	)
}

export function crmUpgradeFence(
	live,
	baseline,
	replacements = {},
	switchingOwner = null
) {
	assert.equal(baseline.kind, 'winwidget.crm.upgrade-baseline.v1')
	assert.equal(baseline.schemaVersion, 1)
	const groups = crmUpgradeGroups(
		baseline.remindersContract,
		baseline.intakeSlaContract
	)
	const upgradeTargets = upgradeTargetsFor(
		baseline.remindersContract,
		baseline.intakeSlaContract
	)
	assert.deepEqual(
		Object.keys(baseline.targets).sort(),
		[...upgradeTargets].sort()
	)
	assert.equal(new Set(live.map(upgradeKey)).size, live.length)
	assert.ok(
		Object.keys(replacements).every(key => upgradeTargets.includes(key))
	)
	const switching =
		switchingOwner === null
			? []
			: groups.find(([owner]) => owner === switchingOwner)?.slice(1)
	assert.ok(switching)
	assert.equal(
		crmNeighborFingerprint(
			live.filter(item => !upgradeTargets.includes(upgradeKey(item))),
			baseline.gatewayRevision
		),
		baseline.neighborsSha256
	)
	for (const key of upgradeTargets) {
		const item = live.find(container => upgradeKey(container) === key)
		const mayBeStopped = switching.includes(key.split('/')[1])
		if (!item) {
			assert.ok(mayBeStopped)
			continue
		}
		const previous = baseline.targets[key]
		const next = replacements[key]
		assert.equal(
			digest(stableJson(upgradeConfiguration(item))),
			previous.configurationSha256
		)
		if (item.Image === previous.image) {
			assert.equal(item.Id, previous.id)
			assert.equal(
				envObject(item.Config.Env).APP_REVISION,
				previous.revision
			)
		} else {
			assert.ok(next && imageId(next.image) && revision(next.revision))
			assert.equal(item.Image, next.image)
			assert.equal(envObject(item.Config.Env).APP_REVISION, next.revision)
			assert.equal(
				item.Config.Labels['org.opencontainers.image.revision'],
				next.revision
			)
		}
		assert.equal(item.State.OOMKilled, false)
		assert.equal(item.RestartCount, 0)
		if (!mayBeStopped) upgradeHealthy(item)
	}
	// A partial replay can contain only a completed prefix, one explicitly
	// switching group and untouched suffix. Never accept a skipped dependency
	// or a mixed old/new worker group as an already completed deployment.
	let remaining = false
	for (const [owner, ...names] of groups) {
		const states = names.map(name => {
			const key = `${upgradeProject(owner)}/${name}`
			return live.find(item => upgradeKey(item) === key)?.Image ===
				baseline.targets[key].image
				? 'old'
				: 'new'
		})
		if (owner === switchingOwner) {
			assert.equal(remaining, false)
			remaining = true
			continue
		}
		assert.equal(new Set(states).size, 1)
		if (states[0] === 'old') remaining = true
		else assert.equal(remaining, false)
	}
	return true
}

function upgradeCompanionConfiguration(service, live, image) {
	const host = live.HostConfig
	const same = (a, b) => assert.equal(stableJson(a), stableJson(b))
	assert.equal(service.network_mode, 'host')
	assert.equal(host.NetworkMode, 'host')
	assert.equal(Boolean(service.privileged), false)
	assert.equal(host.Privileged, false)
	assert.equal(service.pid ?? '', host.PidMode ?? '')
	assert.equal(
		service.user ?? image.Config.User ?? '',
		live.Config.User ?? ''
	)
	same(service.command ?? image.Config.Cmd, live.Config.Cmd)
	same(
		service.entrypoint ?? image.Config.Entrypoint,
		live.Config.Entrypoint
	)
	assert.equal(image.Config.WorkingDir, live.Config.WorkingDir)
	assert.equal(Boolean(service.read_only), Boolean(host.ReadonlyRootfs))
	for (const [key, actual] of [
		['cap_add', 'CapAdd'],
		['cap_drop', 'CapDrop'],
		['security_opt', 'SecurityOpt']
	])
		same(
			[...(service[key] ?? [])].sort(),
			[...(host[actual] ?? [])].sort()
		)
	assert.equal(service.restart ?? 'no', host.RestartPolicy.Name)
	for (const [key, actual] of [
		['mem_limit', 'Memory'],
		['mem_reservation', 'MemoryReservation'],
		['pids_limit', 'PidsLimit']
	])
		assert.equal(Number(service[key] ?? 0), Number(host[actual] ?? 0))
	assert.equal(
		Math.round(Number(service.cpus ?? 0) * 1e9),
		Number(host.NanoCpus ?? 0)
	)
	assert.equal(service.logging?.driver ?? 'json-file', host.LogConfig.Type)
	same(service.logging?.options ?? {}, host.LogConfig.Config ?? {})
	for (const key of ['ports', 'devices', 'volumes', 'secrets'])
		assert.equal(service[key]?.length ?? 0, 0)
	// Compose renders host mappings as an object or an array using '=' / ':'.
	// Preserve the exact existing mappings, including Identity's Telegram proxy.
	assert.ok(
		service.extra_hosts == null || typeof service.extra_hosts === 'object'
	)
	const extraHosts = Array.isArray(service.extra_hosts)
		? service.extra_hosts.map(value => {
				assert.match(value, /^[^=:\s]+[=:]\S+$/)
				return value.replace(/^([^=:]+)[=:]/, '$1:')
			})
		: Object.entries(service.extra_hosts ?? {}).map(([name, address]) => {
				assert.match(name, /^[^=:\s]+$/)
				assert.match(address, /^\S+$/)
				return `${name}:${address}`
			})
	same(extraHosts.sort(), [...(host.ExtraHosts ?? [])].sort())
	assert.equal(live.Mounts.length, 0)
	assert.ok(
		!host.Devices?.length && !host.Binds?.length && !host.CapAdd?.length
	)
	assert.equal(Object.keys(host.PortBindings ?? {}).length, 0)
	same(service.healthcheck?.test, live.Config.Healthcheck.Test)
	const nanos = value => {
		if (value === undefined || value === null) return 0
		assert.ok(
			typeof value === 'string' && value.length > 0 && value.length <= 128
		)
		// Compose uses Go duration strings: 90s becomes 1m30s. Sum exact
		// nanoseconds without floating-point rounding or accepting partial input.
		const units = {
			ns: 1n,
			us: 1000n,
			µs: 1000n,
			μs: 1000n,
			ms: 1000000n,
			s: 1000000000n,
			m: 60000000000n,
			h: 3600000000000n
		}
		let cursor = 0,
			total = 0n
		for (const match of value.matchAll(
			/(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h)/g
		)) {
			assert.equal(match.index, cursor)
			const [whole, fraction = ''] = match[1].split('.')
			const divisor = 10n ** BigInt(fraction.length)
			const scaled = BigInt(whole + fraction) * units[match[2]]
			assert.equal(scaled % divisor, 0n)
			total += scaled / divisor
			assert.ok(total <= BigInt(Number.MAX_SAFE_INTEGER))
			cursor += match[0].length
		}
		assert.equal(cursor, value.length)
		return Number(total)
	}
	for (const [key, actual] of [
		['interval', 'Interval'],
		['timeout', 'Timeout'],
		['start_period', 'StartPeriod']
	])
		assert.equal(
			nanos(service.healthcheck?.[key]),
			live.Config.Healthcheck[actual] ?? 0
		)
	assert.equal(
		service.healthcheck?.retries ?? 0,
		live.Config.Healthcheck.Retries ?? 0
	)
	assert.equal(
		nanos(service.stop_grace_period),
		(live.Config.StopTimeout ?? 10) * 1e9
	)
}

// canonical ND env already contains sixteen kinds. The base Compose reads that
// same variable, while its reminder-only overlay explicitly selects fourteen.
// Reconstruct only this known intermediate field; final desired env still must
// equal the captured runtime byte-for-byte apart from APP_REVISION below.
export function crmUpgradeSlaNotificationBase(base, reminders, final) {
	const copy = structuredClone(base)
	const environment = config =>
		config.services['notification-delivery-worker'].environment
	const before = environment(copy),
		middle = environment(reminders),
		after = environment(final)
	assert.equal(
		before.NOTIFICATION_DELIVERY_KINDS,
		after.NOTIFICATION_DELIVERY_KINDS
	)
	assert.equal(
		after.NOTIFICATION_DELIVERY_KINDS,
		middle.NOTIFICATION_DELIVERY_KINDS +
			',wincrm-intake-sla-email,wincrm-intake-sla-telegram'
	)
	before.NOTIFICATION_DELIVERY_KINDS = middle.NOTIFICATION_DELIVERY_KINDS
	return copy
}

export function crmUpgradeDesired(
	{
		crm,
		companions,
		images,
		live,
		baseline,
		servicesRevision,
		reminderBase,
		intakeSlaBase
	},
	validateCrmCompose,
	validateCrmReminderDeployment,
	validateCrmIntakeSlaDeployment
) {
	assert.ok(revision(servicesRevision))
	const contract = crmUpgradeRemindersContract(baseline.remindersContract)
	const slaContract = crmUpgradeIntakeSlaContract(
		baseline.intakeSlaContract,
		contract
	)
	const groups = crmUpgradeGroups(contract, slaContract)
	if (slaContract === 'disabled') assert.equal(intakeSlaBase, undefined)
	else {
		assert.ok(
			intakeSlaBase && typeof validateCrmIntakeSlaDeployment === 'function'
		)
		validateCrmIntakeSlaDeployment({
			crmBefore: intakeSlaBase.crm,
			crmAfter: crm,
			notificationBefore: intakeSlaBase.notification,
			notificationAfter: reminderBase.notificationAfter
		})
	}
	if (contract === 'disabled') {
		assert.equal(reminderBase, undefined)
		validateCrmCompose(crm)
	} else {
		assert.ok(
			reminderBase && typeof validateCrmReminderDeployment === 'function'
		)
		validateCrmCompose(reminderBase.crm)
		validateCrmReminderDeployment({
			crmBefore: reminderBase.crm,
			crmAfter: intakeSlaBase?.crm ?? crm,
			notificationBefore: reminderBase.notification,
			notificationAfter:
				intakeSlaBase?.notification ?? reminderBase.notificationAfter
		})
		assert.deepEqual(
			companions.services['notification-delivery-worker'],
			reminderBase.notificationAfter.services[
				'notification-delivery-worker'
			]
		)
		assert.deepEqual(
			companions.services['notification-delivery-migrate'],
			reminderBase.notificationAfter.services[
				'notification-delivery-migrate'
			]
		)
	}
	assert.equal(crm.name, 'winwidget-crm')
	assert.equal(companions.name, 'winwidget')
	assert.equal(images.length, groups.length)
	assert.equal(new Set(images.map(item => item.Id)).size, images.length)
	crmUpgradeFence(live, baseline)
	const desired = {
		crm: { name: 'winwidget-crm', services: {} },
		companions: { name: 'winwidget', services: {} }
	}
	const replacements = {}
	for (const [index, [owner, ...names]] of groups.entries()) {
		// The sealed image inventory follows the explicit owner build order.
		// Legacy ND has only a revision label; keep its exact node runtime.
		const image = images[index]
		assert.ok(imageId(image?.Id))
		assert.equal(
			image.Config.Labels?.['org.opencontainers.image.title'],
			owner === 'notification-delivery' ? undefined : `winwidget-${owner}`
		)
		if (owner === 'notification-delivery')
			assert.equal(image.Config.User, 'node')
		assert.equal(
			image.Config.Labels['org.opencontainers.image.revision'],
			servicesRevision
		)
		assert.equal(image.Os, 'linux')
		assert.equal(
			image.Architecture,
			process.arch === 'x64' ? 'amd64' : process.arch
		)
		const project = upgradeProject(owner)
		const selected = owner.startsWith('crm-')
			? desired.crm
			: desired.companions
		const config = owner.startsWith('crm-') ? crm : companions
		for (const name of names) {
			const key = `${project}/${name}`
			const current = live.find(item => upgradeKey(item) === key)
			const service = structuredClone(config.services[name])
			assert.ok(service)
			const expectedEnv = {
				...envObject(image.Config.Env ?? []),
				...service.environment
			}
			const actualEnv = envObject(current.Config.Env)
			assert.equal(expectedEnv.APP_REVISION, servicesRevision)
			assert.deepEqual(
				{ ...expectedEnv, APP_REVISION: actualEnv.APP_REVISION },
				actualEnv
			)
			if (owner.startsWith('crm-')) {
				const candidate = structuredClone(current)
				candidate.Image = image.Id
				candidate.Config.Image = image.Id
				candidate.Config.Env = Object.entries(expectedEnv).map(
					([k, v]) => `${k}=${v}`
				)
				candidate.Config.Labels['org.opencontainers.image.revision'] =
					servicesRevision
				crmRuntimeContainer(
					candidate,
					config,
					images,
					name,
					contract,
					slaContract
				)
			} else upgradeCompanionConfiguration(service, current, image)
			delete service.build
			delete service.depends_on
			service.image = image.Id
			selected.services[name] = service
			replacements[key] = { image: image.Id, revision: servicesRevision }
		}
		if (owner !== 'identity') {
			const migration = structuredClone(
				config.services[`${owner}-migrate`]
			)
			assert.ok(
				migration &&
					!migration.volumes?.length &&
					!migration.secrets?.length
			)
			assert.equal(migration.network_mode, 'host')
			assert.equal(migration.restart ?? 'no', 'no')
			assert.deepEqual(migration.entrypoint, [
				'./node_modules/.bin/prisma'
			])
			assert.deepEqual(migration.command, [
				'migrate',
				'deploy',
				'--schema',
				'prisma/schema.prisma'
			])
			const key =
				owner.replaceAll('-', '_').toUpperCase() + '_DATABASE_URL'
			assert.deepEqual(
				Object.keys(migration.environment).sort(),
				[
					'APP_REVISION',
					key,
					'NODE_ENV',
					...(owner.startsWith('crm-') ? ['MODE'] : [])
				].sort()
			)
			if (owner.startsWith('crm-'))
				assert.equal(migration.environment.MODE, 'production')
			assert.equal(migration.environment.APP_REVISION, servicesRevision)
			assert.equal(migration.environment.NODE_ENV, 'production')
			const url = new URL(migration.environment[key])
			assert.ok(
				['postgres:', 'postgresql:'].includes(url.protocol) &&
					url.password &&
					!url.hash
			)
			assert.equal(url.hostname, '127.0.0.1')
			assert.equal(
				url.username,
				`winwidget_${owner.replaceAll('-', '_')}_migration`
			)
			assert.equal(
				url.pathname,
				`/winwidget_${owner.replaceAll('-', '_')}`
			)
			assert.equal(
				url.searchParams.get('schema'),
				owner.replaceAll('-', '_')
			)
			delete migration.build
			delete migration.depends_on
			migration.image = image.Id
			Object.assign(migration, {
				user:
					owner === 'notification-delivery' ? '1000:1000' : '1001:1001',
				read_only: true,
				cap_drop: ['ALL'],
				security_opt: ['no-new-privileges:true'],
				restart: 'no',
				mem_limit: 536870912,
				memswap_limit: 536870912,
				cpus: '1',
				pids_limit: 128,
				tmpfs: ['/tmp:rw,nosuid,nodev,noexec,size=64m'],
				logging: { driver: 'none' }
			})
			selected.services[`${owner}-migrate`] = migration
		}
	}
	return { desired, replacements }
}

// Internal stdin handoff only: never persist/print this envelope outside the
// root-reader -> non-root image-verifier pipe. It contains one migration secret.
export function crmUpgradeDatabaseInput(owner, ownerEnv, live) {
	assert.ok(Object.hasOwn(CRM_UPGRADE_MIGRATIONS, owner))
	const schema = owner.replaceAll('-', '_')
	assert.equal(typeof ownerEnv, 'string')
	assert.ok(Buffer.byteLength(ownerEnv) <= 1048576)
	assert.ok(Array.isArray(live) && live.length <= 1000)
	const env = {}
	for (const line of ownerEnv.split(/\r?\n/)) {
		if (!line.trim() || line.trimStart().startsWith('#')) continue
		const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
		assert.ok(match && !Object.hasOwn(env, match[1]))
		let value = match[2]
		if (value.startsWith('"')) value = JSON.parse(value)
		else if (value.startsWith("'")) {
			assert.ok(value.endsWith("'"))
			value = value.slice(1, -1)
		}
		env[match[1]] = value
	}
	const approved = live.filter(
		item =>
			upgradeKey(item) ===
			`${upgradeProject(owner)}/${owner === 'notification-delivery' ? 'notification-delivery-worker' : `${owner}-api`}`
	)
	assert.equal(approved.length, 1)
	const runtimeUrl = new URL(
		envObject(approved[0].Config.Env)[
			`${schema.toUpperCase()}_DATABASE_URL`
		]
	)
	assert.ok(['postgres:', 'postgresql:'].includes(runtimeUrl.protocol))
	assert.equal(runtimeUrl.searchParams.getAll('schema').length, 1)
	const input = {
		owner,
		migrationUrl:
			env[
				owner === 'notification-delivery'
					? 'NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION'
					: `${schema.toUpperCase()}_MIGRATION_DATABASE_URL`
			],
		runtimeBinding: {
			host: runtimeUrl.hostname,
			port: runtimeUrl.port,
			username: runtimeUrl.username,
			database: runtimeUrl.pathname.slice(1),
			schema: runtimeUrl.searchParams.get('schema')
		}
	}
	crmUpgradeDatabaseConnection(owner, input)
	assert.ok(Buffer.byteLength(JSON.stringify(input)) <= 16384)
	return input
}

export function crmUpgradeDatabaseConnection(owner, input) {
	assert.ok(Object.hasOwn(CRM_UPGRADE_MIGRATIONS, owner))
	const schema = owner.replaceAll('-', '_')
	assert.ok(input && typeof input === 'object' && !Array.isArray(input))
	assert.deepEqual(Object.keys(input).sort(), [
		'migrationUrl',
		'owner',
		'runtimeBinding'
	])
	assert.equal(input.owner, owner)
	assert.equal(typeof input.migrationUrl, 'string')
	assert.ok(
		input.migrationUrl.length > 0 && input.migrationUrl.length <= 8192
	)
	const url = new URL(input.migrationUrl)
	assert.ok(['postgres:', 'postgresql:'].includes(url.protocol))
	assert.equal(url.hostname, '127.0.0.1')
	assert.equal(url.username, `winwidget_${schema}_migration`)
	assert.equal(url.pathname, `/winwidget_${schema}`)
	assert.equal(url.searchParams.get('schema'), schema)
	assert.equal(url.searchParams.get('sslmode'), 'disable')
	assert.ok(url.password && !url.hash)
	assert.match(url.port, /^\d{2,5}$/)
	assert.ok(Number(url.port) <= 65535 && Number(url.port) > 0)
	assert.deepEqual(input.runtimeBinding, {
		host: '127.0.0.1',
		port: url.port,
		username: `winwidget_${schema}_runtime`,
		database: `winwidget_${schema}`,
		schema
	})
	for (const key of url.searchParams.keys())
		assert.ok(
			['schema', 'sslmode', 'connection_limit', 'pool_timeout'].includes(
				key
			) && url.searchParams.getAll(key).length === 1
		)
	return url
}

export function parseCrmUpgradeDatabaseHandoff(buffer) {
	assert.ok(
		Buffer.isBuffer(buffer) && buffer.length > 0 && buffer.length <= 16384
	)
	const bytes = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
	const value = JSON.parse(bytes)
	// The trusted producer emits canonical compact JSON. Reject duplicate
	// keys/alternate encodings instead of silently accepting last-key wins.
	assert.equal(JSON.stringify(value), bytes)
	return value
}

export function crmUpgradeDatabaseRoles(owner, roles) {
	assert.ok(Object.hasOwn(CRM_UPGRADE_MIGRATIONS, owner))
	const prefix = `winwidget_${owner.replaceAll('-', '_')}`
	assert.ok(Array.isArray(roles))
	assert.deepEqual(roles.map(role => role.rolname).sort(), [
		`${prefix}_migration`,
		`${prefix}_runtime`
	])
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
		if (
			owner.startsWith('crm-') ||
			role.rolname === 'winwidget_billing_runtime'
		)
			assert.equal(role.rolinherit, false)
		// ND's existing owner roles use PostgreSQL's INHERIT default and have
		// zero memberships in either direction (checked independently below).
		// Preserve that exact baseline, not Billing's explicit NOINHERIT rollout.
		if (owner === 'notification-delivery')
			assert.equal(role.rolinherit, true)
	}
	return roles
}

export function crmUpgradeDatabaseMemberships(owner, rows, admin = null) {
	assert.ok(Object.hasOwn(CRM_UPGRADE_MIGRATIONS, owner))
	assert.ok(Array.isArray(rows) && rows.length <= 2)
	const companion = owner === 'identity' || owner === 'billing'
	const prefix = `winwidget_${owner.replaceAll('-', '_')}`
	if (companion)
		assert.deepEqual(admin, {
			rolname: `${prefix}_admin`,
			rolcanlogin: true,
			rolsuper: true,
			databaseOwner: `${prefix}_admin`
		})
	else assert.equal(admin, null)
	for (const row of rows)
		assert.ok(
			row &&
				typeof row === 'object' &&
				!Array.isArray(row) &&
				typeof row.role === 'string'
		)
	const canonical = rows
		.map(row => ({ ...row }))
		.sort((left, right) =>
			left.role < right.role ? -1 : left.role > right.role ? 1 : 0
		)
	// Existing companions grant their own application roles TO the already
	// privileged bootstrap admin, never admin privileges TO an application role.
	// CRM bootstrap has no memberships in either direction. No wildcard edges.
	assert.deepEqual(
		canonical,
		companion
			? ['migration', 'runtime'].map(role => ({
					role: `${prefix}_${role}`,
					member: `${prefix}_admin`,
					grantor: `${prefix}_admin`,
					admin_option: false,
					inherit_option: true,
					set_option: true
				}))
			: []
	)
	return canonical
}

// ND predates service_identity. Its explicit continuity contract is the exact
// endpoint/database OID plus the immutable earliest completed ledger receipt.
// This is not a service UUID and does not authorize role/bootstrap mutations.
export function crmUpgradeNotificationDatabaseIdentity(
	input,
	principal,
	rows
) {
	const url = crmUpgradeDatabaseConnection('notification-delivery', input)
	assert.equal(principal.db, 'winwidget_notification_delivery')
	assert.equal(principal.schema, 'notification_delivery')
	assert.match(principal.databaseOid, /^[1-9][0-9]{0,9}$/)
	assert.ok(Number(principal.databaseOid) <= 4294967295)
	assert.ok(Array.isArray(rows) && rows.length > 0)
	const ordered = [...rows].sort((a, b) =>
		a.migration_name.localeCompare(b.migration_name)
	)
	const first = ordered[0]
	assert.match(
		first.id,
		/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
	)
	assert.equal(
		first.migration_name,
		'20260727000000_init_notification_delivery'
	)
	assert.ok(
		sha(first.checksum) && first.finished_at && !first.rolled_back_at
	)
	return {
		kind: 'postgres-database-ledger-anchor.v1',
		database: principal.db,
		schema: principal.schema,
		databaseOid: principal.databaseOid,
		host: url.hostname,
		port: url.port,
		anchor: {
			id: first.id,
			migrationName: first.migration_name,
			checksum: first.checksum
		}
	}
}

async function crmUpgradeDatabase(owner, complete, input) {
	const url = crmUpgradeDatabaseConnection(owner, input)
	const schema = owner.replaceAll('-', '_')
	const { PrismaClient } = createRequire('/app/package.json')(
		`@prisma/${owner}-client`
	)
	const client = new PrismaClient({
		datasources: { db: { url: url.toString() } },
		log: []
	})
	try {
		return await client.$transaction(
			async tx => {
				await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
				await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'")
				const [identity] =
					owner === 'notification-delivery'
						? []
						: await tx.$queryRawUnsafe(
								`SELECT service_name, database_id::text FROM ${schema}.service_identity WHERE id='singleton'`
							)
				if (owner !== 'notification-delivery') {
					assert.equal(identity?.service_name, `${owner}-service`)
					assert.match(identity.database_id, /^[a-f0-9-]{36}$/)
				}
				const [principal] = await tx.$queryRawUnsafe(
					"SELECT current_database() AS db, current_user AS username, current_schema() AS schema, pg_is_in_recovery() AS recovery, current_setting('server_version_num')::int AS version"
				)
				assert.equal(principal.db, `winwidget_${schema}`)
				assert.equal(principal.username, `winwidget_${schema}_migration`)
				assert.equal(principal.schema, schema)
				assert.equal(principal.recovery, false)
				assert.ok(
					principal.version >= 180000 && principal.version < 190000
				)
				if (owner === 'notification-delivery') {
					const [database] = await tx.$queryRawUnsafe(
						'SELECT oid::text AS oid FROM pg_database WHERE datname=current_database()'
					)
					principal.databaseOid = database?.oid
				}
				const roles = await tx.$queryRawUnsafe(
					`SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls FROM pg_roles WHERE rolname IN ('winwidget_${schema}_migration','winwidget_${schema}_runtime') ORDER BY rolname`
				)
				crmUpgradeDatabaseRoles(owner, roles)
				const companion = owner === 'identity' || owner === 'billing'
				const admins = companion
					? await tx.$queryRawUnsafe(
							`SELECT role_state.rolname, role_state.rolcanlogin, role_state.rolsuper,
 pg_get_userbyid(database_state.datdba) AS "databaseOwner"
 FROM pg_roles role_state JOIN pg_database database_state ON database_state.datname=current_database()
 WHERE role_state.rolname='winwidget_${schema}_admin'`
						)
					: []
				assert.equal(admins.length, companion ? 1 : 0)
				const memberships = crmUpgradeDatabaseMemberships(
					owner,
					await tx.$queryRawUnsafe(
						`SELECT granted_role.rolname AS "role", member_role.rolname AS "member", grantor_role.rolname AS "grantor",
 membership.admin_option, membership.inherit_option, membership.set_option
 FROM pg_auth_members membership
 JOIN pg_roles granted_role ON granted_role.oid=membership.roleid
 JOIN pg_roles member_role ON member_role.oid=membership.member
 JOIN pg_roles grantor_role ON grantor_role.oid=membership.grantor
 WHERE membership.member IN ('winwidget_${schema}_migration'::regrole,'winwidget_${schema}_runtime'::regrole)
 OR membership.roleid IN ('winwidget_${schema}_migration'::regrole,'winwidget_${schema}_runtime'::regrole)
 ORDER BY granted_role.rolname, member_role.rolname, grantor_role.rolname, membership.admin_option, membership.inherit_option, membership.set_option`
					),
					admins[0] ?? null
				)
				const rows = await tx.$queryRawUnsafe(
					`SELECT id, migration_name, checksum, finished_at::text, rolled_back_at::text${owner === 'notification-delivery' ? ", started_at::text, applied_steps_count, md5(COALESCE(logs,'')) AS logs_fingerprint" : ''} FROM ${schema}._prisma_migrations ORDER BY migration_name, started_at`
				)
				const pending = crmUpgradeLedger(
					owner,
					crmUpgradeImageSource('/app/prisma'),
					rows,
					complete
				)
				const acl = await tx.$queryRawUnsafe(`SELECT kind, name,
 CASE WHEN acl IS NULL THEN '' ELSE ARRAY(SELECT format('%s:%s:%s:%s',grantor,grantee,privilege_type,is_grantable) FROM aclexplode(acl) ORDER BY grantor,grantee,privilege_type,is_grantable)::text END AS acl FROM (
 SELECT 'relation' AS kind,c.relname AS name,c.relacl AS acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${schema}' AND c.relkind IN ('r','S')
 UNION ALL SELECT 'schema',nspname,nspacl FROM pg_namespace WHERE nspname='${schema}'
 UNION ALL SELECT 'default',d.oid::text,d.defaclacl FROM pg_default_acl d WHERE d.defaclrole='winwidget_${schema}_migration'::regrole
 UNION ALL SELECT 'routine',p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='${schema}') a ORDER BY kind,name`)
				if (complete && owner === 'billing') {
					const [grant] = await tx.$queryRawUnsafe(
						"SELECT has_table_privilege('winwidget_billing_runtime','billing.crm_admin_day_grants','SELECT') AS read, has_table_privilege('winwidget_billing_runtime','billing.crm_admin_day_grants','INSERT') AS append, has_table_privilege('winwidget_billing_runtime','billing.crm_admin_day_grants','UPDATE,DELETE,TRUNCATE') AS mutate, has_function_privilege('winwidget_billing_runtime','billing.protect_crm_admin_day_grants()','EXECUTE') AS grant_execute, has_function_privilege('winwidget_billing_runtime','billing.protect_crm_admin_command_receipts()','EXECUTE') AS receipt_execute"
					)
					assert.deepEqual(grant, {
						read: true,
						append: true,
						mutate: false,
						grant_execute: false,
						receipt_execute: false
					})
					const triggers = await tx.$queryRawUnsafe(
						"SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid IN ('billing.crm_admin_day_grants'::regclass,'billing.command_receipts'::regclass) AND NOT tgisinternal ORDER BY tgname"
					)
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
				return {
					databaseId: identity?.database_id ?? null,
					...(owner === 'notification-delivery'
						? {
								databaseIdentity: crmUpgradeNotificationDatabaseIdentity(
									input,
									principal,
									rows
								),
								ledger: rows
							}
						: {}),
					pending,
					acl,
					roles,
					memberships
				}
			},
			{ timeout: 20000 }
		)
	} finally {
		await client.$disconnect()
	}
}

export function crmUpgradeDatabasePreserved(
	before,
	after,
	complete = true
) {
	assert.equal(after.databaseId, before.databaseId)
	if (before.databaseId === null || after.databaseId === null) {
		assert.equal(
			before.databaseIdentity?.kind,
			'postgres-database-ledger-anchor.v1'
		)
		assert.deepEqual(after.databaseIdentity, before.databaseIdentity)
		assert.ok(Array.isArray(before.ledger) && Array.isArray(after.ledger))
		assert.ok(before.ledger.length > 0)
		for (const row of before.ledger) {
			const matching = after.ledger.filter(item => item.id === row.id)
			assert.equal(matching.length, 1)
			assert.deepEqual(matching[0], row)
		}
	}
	assert.ok(Array.isArray(before.roles) && Array.isArray(after.roles))
	assert.deepEqual(after.roles, before.roles)
	assert.ok(
		Array.isArray(before.memberships) && Array.isArray(after.memberships)
	)
	assert.deepEqual(after.memberships, before.memberships)
	if (complete) assert.equal(after.pending.length, 0)
	for (const row of before.acl)
		assert.deepEqual(
			after.acl.find(
				item => item.kind === row.kind && item.name === row.name
			),
			row
		)
	return true
}

async function crmUpgradeCommand(mode) {
	const input = () => {
		const bytes = readFileSync(0, 'utf8')
		assert.ok(Buffer.byteLength(bytes) <= 8 * 1048576)
		return JSON.parse(bytes)
	}
	const databaseInput = () => {
		const buffer = Buffer.alloc(16385)
		let size = 0
		while (size < buffer.length) {
			const count = readSync(0, buffer, size, buffer.length - size, null)
			if (count === 0) break
			size += count
		}
		return parseCrmUpgradeDatabaseHandoff(buffer.subarray(0, size))
	}
	const json = name =>
		JSON.parse(readFileSync(`/run/crm/${name}.json`, 'utf8'))
	const baselineInput = () => {
		const baseline = json('baseline')
		assert.equal(
			crmUpgradeRemindersContract(baseline.remindersContract),
			crmUpgradeRemindersContract(
				process.env.CRM_REMINDERS_RABBITMQ_CONTRACT
			)
		)
		assert.equal(
			crmUpgradeIntakeSlaContract(
				baseline.intakeSlaContract,
				baseline.remindersContract
			),
			crmUpgradeIntakeSlaContract(
				process.env.CRM_INTAKE_SLA_RABBITMQ_CONTRACT,
				process.env.CRM_REMINDERS_RABBITMQ_CONTRACT
			)
		)
		return baseline
	}
	if (mode === 'upgrade-contract' || mode === 'upgrade-sla-contract') {
		const file = '/run/crm/canonical.env'
		assert.ok(lstatSync(file).size <= 1048576)
		process.stdout.write(
			(mode === 'upgrade-contract'
				? crmUpgradeRemindersContractFromEnv
				: crmUpgradeIntakeSlaContractFromEnv)(readFileSync(file, 'utf8')) +
				'\n'
		)
		return undefined
	}
	if (mode === 'upgrade-baseline')
		return crmUpgradeBaseline(
			input(),
			process.env.CRM_GATEWAY_REVISION,
			JSON.parse(process.env.CRM_UPGRADE_ENV_HASHES),
			crmUpgradeRemindersContract(
				process.env.CRM_REMINDERS_RABBITMQ_CONTRACT
			),
			crmUpgradeIntakeSlaContract(
				process.env.CRM_INTAKE_SLA_RABBITMQ_CONTRACT,
				process.env.CRM_REMINDERS_RABBITMQ_CONTRACT
			)
		)
	if (mode === 'upgrade-source')
		return crmUpgradeImageSource('/app/prisma')
	if (mode === 'upgrade-old-images') {
		const values = crmUpgradeOldImages(json('baseline'), process.argv[3])
		process.stdout.write(values.join('\n') + '\n')
		return undefined
	}
	if (mode === 'upgrade-baseline-check') {
		const baseline = baselineInput()
		assert.deepEqual(
			baseline.environmentHashes,
			JSON.parse(process.env.CRM_UPGRADE_ENV_HASHES)
		)
		assert.equal(
			baseline.gatewayRevision,
			process.env.CRM_GATEWAY_REVISION
		)
		crmUpgradeFence(input(), baseline)
		return true
	}
	if (mode === 'upgrade-source-check') {
		const owner = process.argv[3]
		return crmUpgradeSource(
			owner,
			json(`${owner}-source-before`),
			json(`${owner}-source-after`)
		)
	}
	if (mode === 'upgrade-database-input') {
		const owner = process.argv[3]
		assert.ok(Object.hasOwn(CRM_UPGRADE_MIGRATIONS, owner))
		const envFile = `/run/crm/${owner.startsWith('crm-') ? 'crm' : owner}.env`
		assert.ok(lstatSync(envFile).size <= 1048576)
		assert.ok(lstatSync('/run/crm/live.json').size <= 8 * 1048576)
		return crmUpgradeDatabaseInput(
			owner,
			readFileSync(envFile, 'utf8'),
			json('live')
		)
	}
	if (mode === 'upgrade-database')
		return crmUpgradeDatabase(
			process.argv[3],
			process.argv[4] === 'complete',
			databaseInput()
		)
	if (mode === 'upgrade-database-check') {
		const owner = process.argv[3]
		assert.ok(Object.hasOwn(CRM_UPGRADE_MIGRATIONS, owner))
		return crmUpgradeDatabasePreserved(
			json(`${owner}-database-before`),
			json(`${owner}-database-after`),
			process.argv[4] !== 'pending'
		)
	}
	if (mode === 'upgrade-pending') {
		const owner = process.argv[3]
		assert.ok(Object.hasOwn(CRM_UPGRADE_MIGRATIONS, owner))
		const pending = json(`${owner}-database-after`).pending
		if (process.argv[4] === 'task-writers')
			return Number(crmUpgradeTaskWriterStop(owner, pending))
		assert.ok(!process.argv[4])
		return pending.length
	}
	if (mode === 'upgrade-grants') {
		const owner = process.argv[3]
		assert.ok(owners.includes(owner))
		const { readDatabaseAccess, databaseRuntimeGrantsSql } =
			await import('/run/crm-database-access.mjs')
		const { contract, migrations } = readDatabaseAccess(
			'/app/prisma',
			owner
		)
		process.stdout.write(databaseRuntimeGrantsSql(contract, migrations))
		return undefined
	}
	if (mode === 'upgrade-env') {
		const live = input()
		const values = {
			APP_REVISION: process.env.CRM_SERVICES_REVISION,
			APP_VERSION: `git-${process.env.CRM_SERVICES_REVISION}`
		}
		for (const owner of [
			'notification-delivery',
			'campaigns',
			'reporting',
			'widgets',
			'billing',
			'identity',
			'platform',
			'support',
			'operations'
		]) {
			const role =
				{
					'notification-delivery': 'notification-delivery-worker',
					campaigns: 'campaigns-service',
					reporting: 'reporting-service',
					widgets: 'widgets-service'
				}[owner] ?? `${owner}-api`
			const item = live.find(
				row => upgradeKey(row) === `winwidget/${role}`
			)
			assert.ok(item && imageId(item.Image))
			const prefix = owner.replaceAll('-', '_').toUpperCase()
			values[`${prefix}_IMAGE`] = item.Image
			values[`${prefix}_REVISION`] = envObject(
				item.Config.Env
			).APP_REVISION
			assert.ok(revision(values[`${prefix}_REVISION`]))
		}
		process.stdout.write(
			Object.entries(values)
				.map(([key, value]) => `${key}=${value}`)
				.join('\n') + '\n'
		)
		return undefined
	}
	if (mode === 'upgrade-prepare') {
		const baseline = baselineInput()
		const { validateCrmCompose } =
			await import('/run/crm-compose-validator.mjs')
		const enabled =
			crmUpgradeRemindersContract(baseline.remindersContract) ===
			'task-reminders-v1'
		const validateReminders = enabled
			? (await import('/run/crm-reminders-compose-validator.mjs'))
					.validateCrmReminderDeployment
			: undefined
		const sla =
			crmUpgradeIntakeSlaContract(
				baseline.intakeSlaContract,
				baseline.remindersContract
			) !== 'disabled'
		const validateSla = sla
			? (await import('/run/crm-intake-sla-compose-validator.mjs'))
					.validateCrmIntakeSlaDeployment
			: undefined
		const billing = json('billing'),
			identity = json('identity'),
			notification = json('notification-delivery')
		const intakeSlaBase = sla
			? {
					crm: json('crm-reminders'),
					notification: json('notification-delivery-reminders')
				}
			: undefined
		const reminderBase = enabled
			? {
					crm: json('crm-base'),
					notification: sla
						? crmUpgradeSlaNotificationBase(
								json('notification-delivery-base'),
								intakeSlaBase.notification,
								notification
							)
						: json('notification-delivery-base'),
					notificationAfter: notification
				}
			: undefined
		const companions = {
			name: 'winwidget',
			services: {
				...billing.services,
				'identity-api': identity.services['identity-api'],
				'notification-delivery-worker':
					notification.services['notification-delivery-worker'],
				'notification-delivery-migrate':
					notification.services['notification-delivery-migrate']
			}
		}
		const { desired, replacements } = crmUpgradeDesired(
			{
				crm: json('crm'),
				companions,
				images: json('images'),
				live: json('live'),
				baseline,
				servicesRevision: process.env.CRM_SERVICES_REVISION,
				...(sla ? { intakeSlaBase } : {}),
				...(enabled ? { reminderBase } : {})
			},
			validateCrmCompose,
			validateReminders,
			validateSla
		)
		return {
			schemaVersion: 1,
			servicesRevision: process.env.CRM_SERVICES_REVISION,
			infraRevision: process.env.CRM_INFRA_REVISION,
			baselineSha256: digest(readFileSync('/run/crm/baseline.json')),
			desired,
			replacements
		}
	}
	if (mode === 'upgrade-fence') {
		const baseline = baselineInput()
		const upgradeTargets = upgradeTargetsFor(
			baseline.remindersContract,
			baseline.intakeSlaContract
		)
		const plan = json('plan')
		assert.equal(plan.schemaVersion, 1)
		assert.equal(plan.servicesRevision, process.env.CRM_SERVICES_REVISION)
		assert.equal(plan.infraRevision, process.env.CRM_INFRA_REVISION)
		assert.equal(
			plan.baselineSha256,
			digest(readFileSync('/run/crm/baseline.json'))
		)
		assert.deepEqual(
			Object.keys(plan.replacements).sort(),
			[...upgradeTargets].sort()
		)
		assert.deepEqual(
			baseline.environmentHashes,
			JSON.parse(process.env.CRM_UPGRADE_ENV_HASHES)
		)
		assert.equal(
			baseline.gatewayRevision,
			process.env.CRM_GATEWAY_REVISION
		)
		return crmUpgradeFence(
			input(),
			baseline,
			plan.replacements,
			process.env.CRM_UPGRADE_SWITCHING_OWNER || null
		)
	}
	if (mode === 'upgrade-complete') {
		const baseline = baselineInput()
		const plan = json('plan'),
			live = input()
		crmUpgradeFence(
			live,
			baseline,
			plan.replacements,
			process.env.CRM_UPGRADE_SWITCHING_OWNER || null
		)
		const group =
			process.argv[3] === 'all'
				? upgradeTargetsFor(
						baseline.remindersContract,
						baseline.intakeSlaContract
					)
				: crmUpgradeGroups(
						baseline.remindersContract,
						baseline.intakeSlaContract
					)
						.find(([owner]) => owner === process.argv[3])
						?.slice(1)
						.map(name => `${upgradeProject(process.argv[3])}/${name}`)
		assert.ok(group)
		for (const key of group) {
			const item = live.find(row => upgradeKey(row) === key)
			assert.equal(item?.Image, plan.replacements[key].image)
			upgradeHealthy(item)
		}
		return true
	}
	if (mode === 'upgrade-compose') {
		const unit = process.argv[3]
		assert.ok(['crm', 'companions'].includes(unit))
		process.stdout.write(
			JSON.stringify(json('plan').desired[unit]).replaceAll(
				'$',
				() => '$$'
			) + '\n'
		)
		return undefined
	}
	throw new Error('Unsupported CRM upgrade verifier mode')
}

// Hash only stable container configuration; Health.Log/uptime are observations,
// not configuration. Never return Config.Env or another secret-bearing field.
export function crmNeighborFingerprint(containers, gatewayRevision) {
	assert.ok(revision(gatewayRevision))
	assert.ok(
		Array.isArray(containers) &&
			containers.length > 0 &&
			containers.length <= 200
	)
	assert.equal(
		new Set(containers.map(item => item.Id)).size,
		containers.length
	)
	const gateway = containers.filter(
		item =>
			item.Config?.Labels?.['com.docker.compose.project'] ===
				'winwidget' &&
			item.Config?.Labels?.['com.docker.compose.service'] === 'api-gateway'
	)
	assert.equal(gateway.length, 1)
	assert.equal(
		gateway[0].Config.Labels['org.opencontainers.image.revision'],
		gatewayRevision
	)
	const stable = containers
		.map(item => {
			assert.ok(
				sha(item.Id) &&
					imageId(item.Image) &&
					typeof item.Name === 'string'
			)
			assert.equal(item.State?.Running, true)
			assert.equal(item.State?.Paused, false)
			assert.equal(item.State?.Restarting, false)
			assert.equal(item.State?.OOMKilled, false)
			assert.equal(item.State?.Health?.Status, 'healthy')
			assert.ok(
				Number.isSafeInteger(item.RestartCount) && item.RestartCount >= 0
			)
			assert.ok(
				item.Config && item.HostConfig && Array.isArray(item.Mounts)
			)
			assert.ok(
				item.NetworkSettings && typeof item.NetworkSettings === 'object'
			)
			assert.ok(
				typeof item.State.StartedAt === 'string' &&
					Number.isFinite(Date.parse(item.State.StartedAt))
			)
			return {
				Id: item.Id,
				Name: item.Name,
				Image: item.Image,
				Config: item.Config,
				HostConfig: item.HostConfig,
				NetworkSettings: item.NetworkSettings,
				Mounts: [...item.Mounts].sort((a, b) =>
					a.Destination.localeCompare(b.Destination)
				),
				RestartCount: item.RestartCount,
				StartedAt: item.State.StartedAt
			}
		})
		.sort((a, b) => a.Id.localeCompare(b.Id))
	return digest(JSON.stringify(stable))
}

// The database-only stage may add these four containers, but never excludes
// a CRM application, migration job or an unknown process from its fence.
export function crmDatabaseNeighbors(containers, gatewayRevision) {
	assert.ok(Array.isArray(containers))
	const seen = new Set()
	const neighbors = containers.filter(item => {
		if (
			item.Config?.Labels?.['com.docker.compose.project'] !==
			'winwidget-crm'
		)
			return true
		const name = item.Config.Labels['com.docker.compose.service']
		assert.ok(owners.some(owner => name === owner + '-postgres'))
		assert.ok(!seen.has(name))
		seen.add(name)
		return false
	})
	return crmNeighborFingerprint(neighbors, gatewayRevision)
}

export function crmRuntimeNeighbors(containers, gatewayRevision) {
	const seen = new Set()
	return crmNeighborFingerprint(
		containers.filter(item => {
			if (
				item.Config?.Labels?.['com.docker.compose.project'] !==
				'winwidget-crm'
			)
				return true
			const name = item.Config.Labels['com.docker.compose.service']
			assert.ok(
				CRM_RUNTIME_NAMES.includes(name) ||
					owners.some(owner => name === owner + '-postgres')
			)
			assert.ok(!seen.has(name))
			seen.add(name)
			return !CRM_RUNTIME_NAMES.includes(name)
		}),
		gatewayRevision
	)
}

export function crmRuntimeContainer(
	container,
	config,
	images,
	name,
	remindersContract = 'disabled',
	intakeSlaContract = 'disabled'
) {
	assert.ok(
		CRM_RUNTIME_NAMES.includes(name) ||
			(crmUpgradeRemindersContract(remindersContract) ===
				'task-reminders-v1' &&
				name === 'crm-sales-reminders') ||
			(crmUpgradeIntakeSlaContract(
				intakeSlaContract,
				remindersContract
			) === 'intake-sla-v1' &&
				['crm-intake-sla-worker', 'crm-intake-sla-publisher'].includes(
					name
				))
	)
	const expected = config.services[name]
	const image = images.find(item => item.Id === expected.image)
	assert.ok(image && sha(container.Id))
	assert.equal(container.Image, image.Id)
	assert.equal(container.Config.Image, image.Id)
	assert.equal(container.Name, '/winwidget-crm-' + name + '-1')
	const labels = container.Config.Labels
	assert.equal(labels['com.docker.compose.project'], 'winwidget-crm')
	assert.equal(labels['com.docker.compose.service'], name)
	assert.equal(labels['com.docker.compose.oneoff'], 'False')
	assert.equal(labels['com.docker.compose.container-number'], '1')
	for (const [key, value] of Object.entries(expected.labels))
		assert.equal(labels[key], value)
	assert.equal(
		image.Config.Labels['org.opencontainers.image.revision'],
		expected.environment.APP_REVISION
	)
	const state = container.State
	assert.equal(state.Running, true)
	for (const key of ['Paused', 'Restarting', 'OOMKilled', 'Dead'])
		assert.equal(state[key], false)
	assert.equal(state.Health.Status, 'healthy')
	assert.equal(container.RestartCount, 0)
	const env = entries =>
		Object.fromEntries(
			entries.map(line => {
				const split = line.indexOf('=')
				assert.ok(split > 0)
				return [line.slice(0, split), line.slice(split + 1)]
			})
		)
	assert.deepEqual(env(container.Config.Env), {
		...env(image.Config.Env ?? []),
		...expected.environment
	})
	assert.equal(container.Config.User, expected.user)
	assert.deepEqual(
		container.Config.Cmd,
		expected.command ?? image.Config.Cmd
	)
	assert.deepEqual(
		container.Config.Entrypoint,
		expected.entrypoint ?? image.Config.Entrypoint
	)
	assert.equal(container.Config.StopTimeout, 45)
	const host = container.HostConfig
	assert.equal(host.NetworkMode, 'host')
	assert.equal(host.Privileged, false)
	assert.equal(host.ReadonlyRootfs, true)
	assert.equal(host.Init, true)
	assert.equal(host.Memory, Number(expected.mem_limit))
	assert.equal(host.MemorySwap, Number(expected.memswap_limit))
	assert.equal(host.NanoCpus, Math.round(Number(expected.cpus) * 1e9))
	assert.equal(host.PidsLimit, expected.pids_limit)
	assert.deepEqual(host.CapDrop, ['ALL'])
	assert.ok(!host.CapAdd?.length)
	assert.deepEqual(host.SecurityOpt, expected.security_opt)
	assert.equal(host.PidMode, '')
	assert.equal(host.IpcMode, 'private')
	for (const key of ['Devices', 'VolumesFrom', 'Links', 'ExtraHosts'])
		assert.ok(!host[key]?.length)
	assert.equal(Object.keys(host.PortBindings ?? {}).length, 0)
	assert.deepEqual(host.RestartPolicy, {
		Name: 'unless-stopped',
		MaximumRetryCount: 0
	})
	assert.deepEqual(host.LogConfig, {
		Type: expected.logging.driver,
		Config: expected.logging.options
	})
	assert.deepEqual(
		host.Tmpfs,
		Object.fromEntries(
			expected.tmpfs.map(value => {
				const split = value.indexOf(':')
				return [value.slice(0, split), value.slice(split + 1)]
			})
		)
	)
	assert.ok(
		container.Mounts.every(
			mount => mount.Type === 'tmpfs' && mount.Destination === '/tmp'
		)
	)
	assert.deepEqual(
		container.Config.Healthcheck.Test,
		expected.healthcheck.test
	)
	const duration = value => {
		const match = /^(\d+)(ms|s|m)$/.exec(value)
		assert.ok(match)
		return Number(match[1]) * { ms: 1e6, s: 1e9, m: 60e9 }[match[2]]
	}
	for (const [key, target] of [
		['interval', 'Interval'],
		['timeout', 'Timeout'],
		['start_period', 'StartPeriod']
	])
		assert.equal(
			container.Config.Healthcheck[target],
			duration(expected.healthcheck[key])
		)
	assert.equal(
		container.Config.Healthcheck.Retries,
		expected.healthcheck.retries
	)
	return container.Id
}

export function crmRuntimeLedger(migrations, rows) {
	assert.equal(rows.length, migrations.length)
	assert.ok(rows.every(row => row.finished_at && !row.rolled_back_at))
	const sort = values =>
		[...values].sort((a, b) => a.name.localeCompare(b.name))
	assert.deepEqual(
		sort(
			rows.map(row => ({
				name: row.migration_name,
				checksum: row.checksum
			}))
		),
		sort(migrations)
	)
	return migrations.length
}

export function crmDatabaseResources(
	config,
	validateCompose,
	availableMemory
) {
	const shape = validateCompose(config)
	assert.equal(shape.releaseApproved, false)
	assertCrmPublicGatesClosed(config)
	const databaseImages = owners.map(
		owner => config.services[owner + '-postgres'].image
	)
	assert.equal(new Set(databaseImages).size, 1)
	assert.match(
		databaseImages[0],
		/^postgres:18-bookworm@sha256:[a-f0-9]{64}$/
	)
	// Conservative preparation headroom, not a full runtime/load approval.
	// Count all four DB caps even on replay, plus the largest sequential
	// migration job, a 128 MiB verifier and the agreed 2 GiB host reserve.
	const required =
		shape.databaseMemoryBytes +
		shape.maxMigrationMemoryBytes +
		128 * 1048576 +
		2 * 1073741824
	assert.ok(Number.isSafeInteger(required) && required > 0)
	assert.ok(
		Number.isSafeInteger(availableMemory) && availableMemory >= required
	)
	return { image: databaseImages[0], requiredMemoryBytes: required }
}

// Specialized readers must be running before producers can be opened. These
// process-local flags do not expose the public Intake API or enable Widgets.
export function assertCrmPublicGatesClosed(config) {
	for (const [name, service] of Object.entries(config.services))
		for (const [key, value] of Object.entries(service.environment ?? {})) {
			if (!/^CRM_.*ENABLED$/.test(key)) continue
			const background =
				(/^crm-intake-widget-(control|transfer)-(worker|publisher)$/.test(
					name
				) &&
					key === 'CRM_INTAKE_WIDGETS_ENABLED') ||
				(/^crm-intake-widget-transfer-(worker|publisher)$/.test(name) &&
					key === 'CRM_INTAKE_WIDGET_TRANSFERS_ENABLED')
			assert.equal(value, background ? 'true' : 'false')
		}
}

export function crmDatabaseContainer(
	container,
	config,
	postgresImage,
	owner
) {
	assert.ok(owners.includes(owner))
	const expected = config.services[owner + '-postgres']
	assert.ok(sha(container.Id) && imageId(postgresImage.Id))
	assert.equal(postgresImage.Os, 'linux')
	assert.equal(
		postgresImage.Architecture,
		process.arch === 'x64' ? 'amd64' : process.arch
	)
	assert.equal(container.Image, postgresImage.Id)
	assert.equal(container.Config.Image, expected.image)
	const labels = container.Config.Labels
	assert.equal(labels['com.docker.compose.project'], 'winwidget-crm')
	assert.equal(labels['com.docker.compose.service'], owner + '-postgres')
	assert.equal(labels['com.docker.compose.container-number'], '1')
	assert.equal(labels['com.docker.compose.oneoff'], 'False')
	assert.equal(labels['com.winwidget.owner'], owner)
	assert.equal(labels['com.winwidget.purpose'], 'postgres')
	assert.equal(container.Name, '/winwidget-crm-' + owner + '-postgres-1')
	assert.equal(container.State.Running, true)
	assert.equal(container.State.Paused, false)
	assert.equal(container.State.Restarting, false)
	assert.equal(container.State.OOMKilled, false)
	assert.equal(container.State.Dead, false)
	assert.equal(container.State.Health.Status, 'healthy')
	const host = container.HostConfig
	// Compose v5 may serialize byte limits as decimal strings; Docker inspect
	// returns numbers. Match the service-owned validator without loose coercion.
	const bytes = value => {
		if (typeof value === 'string') {
			assert.match(value, /^[0-9]+$/)
			value = Number(value)
		}
		assert.ok(Number.isSafeInteger(value) && value > 0)
		return value
	}
	assert.equal(host.Memory, bytes(expected.mem_limit))
	assert.equal(host.MemorySwap, bytes(expected.memswap_limit))
	assert.equal(host.NanoCpus, Math.round(Number(expected.cpus) * 1e9))
	assert.equal(host.ShmSize, bytes(expected.shm_size))
	assert.equal(host.PidsLimit, expected.pids_limit)
	assert.equal(host.Privileged, false)
	assert.ok(!host.CapAdd?.length && !host.Devices?.length)
	assert.ok(!host.VolumesFrom?.length && !host.Links?.length)
	assert.equal(host.IpcMode, 'private')
	assert.equal(host.PidMode, '')
	assert.equal(host.NetworkMode, 'winwidget-crm_' + owner + '-postgres')
	assert.deepEqual(host.RestartPolicy, {
		Name: 'unless-stopped',
		MaximumRetryCount: 0
	})
	assert.deepEqual(host.PortBindings, {
		'5432/tcp': [
			{ HostIp: '127.0.0.1', HostPort: expected.ports[0].published }
		]
	})
	assert.deepEqual(container.NetworkSettings.Ports, {
		'5432/tcp': [
			{ HostIp: '127.0.0.1', HostPort: expected.ports[0].published }
		]
	})
	assert.deepEqual(Object.keys(container.NetworkSettings.Networks), [
		'winwidget-crm_' + owner + '-postgres'
	])
	assert.deepEqual(container.Config.Cmd, expected.command)
	assert.deepEqual(
		container.Config.Entrypoint,
		postgresImage.Config.Entrypoint
	)
	assert.equal(container.Config.User, postgresImage.Config.User ?? '')
	assert.equal(
		container.Config.Healthcheck.Test.join('|'),
		expected.healthcheck.test.join('|')
	)
	assert.equal(container.Config.Healthcheck.Interval, 10 * 1e9)
	assert.equal(container.Config.Healthcheck.Timeout, 5 * 1e9)
	assert.equal(container.Config.Healthcheck.Retries, 12)
	assert.equal(container.Config.Healthcheck.StartPeriod, 10 * 1e9)
	const env = lines =>
		Object.fromEntries(
			lines.map(line => {
				const offset = line.indexOf('=')
				assert.ok(offset > 0)
				return [line.slice(0, offset), line.slice(offset + 1)]
			})
		)
	assert.deepEqual(env(container.Config.Env), {
		...env(postgresImage.Config.Env),
		...expected.environment
	})
	const mounts = container.Mounts
	assert.equal(mounts.length, 2)
	const volume = mounts.find(
		item => item.Destination === '/var/lib/postgresql'
	)
	assert.equal(volume?.Type, 'volume')
	assert.equal(volume.Name, 'winwidget-crm_' + owner + '-postgres-data')
	assert.equal(volume.RW, true)
	const secret = mounts.find(
		item =>
			item.Destination ===
			'/run/secrets/' + owner + '-postgres-admin-password'
	)
	assert.equal(secret?.Type, 'bind')
	assert.equal(
		secret.Source,
		config.secrets[owner + '-postgres-admin-password'].file
	)
	assert.equal(secret.RW, false)
	return container.Id
}

export function crmDatabaseCredentials(config, owner, backupPassword) {
	assert.ok(owners.includes(owner))
	const prefix = owner.replaceAll('-', '_').toUpperCase()
	const schema = owner.replaceAll('-', '_')
	const passwords = { backup: backupPassword }
	for (const role of ['migration', 'runtime']) {
		const process =
			config.services[owner + (role === 'migration' ? '-migrate' : '-api')]
		const url = new URL(process.environment[prefix + '_DATABASE_URL'])
		assert.equal(url.protocol, 'postgresql:')
		assert.equal(url.hostname, '127.0.0.1')
		assert.equal(url.pathname, '/winwidget_' + schema)
		assert.equal(url.username, 'winwidget_' + schema + '_' + role)
		assert.equal(url.searchParams.get('schema'), schema)
		passwords[role] = url.password
	}
	assert.ok(
		Object.values(passwords).every(
			value =>
				typeof value === 'string' && /^[a-f0-9]{48,128}$/.test(value)
		)
	)
	assert.equal(new Set(Object.values(passwords)).size, 3)
	return passwords
}

export function crmPreparationReceipt(
	{
		composeBytes,
		images,
		servicesRevision,
		infraRevision,
		canonicalEnvSha256,
		crmEnvSha256,
		neighborsSha256,
		architecture
	},
	validateCompose
) {
	assert.ok(revision(servicesRevision) && revision(infraRevision))
	assert.ok([canonicalEnvSha256, crmEnvSha256, neighborsSha256].every(sha))
	assert.ok(['amd64', 'arm64'].includes(architecture))
	assert.ok(
		typeof composeBytes === 'string' &&
			Buffer.byteLength(composeBytes) <= 1048576
	)
	assert.equal(typeof validateCompose, 'function')
	const config = JSON.parse(composeBytes)
	const shape = validateCompose(config)
	assert.equal(shape.kind, 'winwidget.crm.compose-shape.v1')
	assert.equal(shape.runtimeProcesses, 12)
	assert.equal(shape.databases, 4)
	assert.equal(shape.migrationJobs, 4)
	assert.equal(shape.releaseApproved, false)
	assert.ok(Array.isArray(images) && images.length === 4)
	assert.equal(new Set(images.map(item => item.Id)).size, 4)
	const artifacts = owners.map(owner => {
		const matches = images.filter(
			item =>
				item.Config?.Labels?.['org.opencontainers.image.title'] ===
				'winwidget-' + owner
		)
		assert.equal(matches.length, 1)
		const image = matches[0]
		assert.ok(imageId(image.Id))
		assert.equal(image.Os, 'linux')
		assert.equal(image.Architecture, architecture)
		assert.equal(
			image.Config.Labels['org.opencontainers.image.revision'],
			servicesRevision
		)
		for (const [name, process] of Object.entries(config.services)) {
			if (!name.startsWith(owner + '-') || name.endsWith('-postgres'))
				continue
			assert.equal(process.image, image.Id)
			assert.equal(process.environment.APP_REVISION, servicesRevision)
		}
		return { owner, image: image.Id, revision: servicesRevision }
	})
	return {
		schemaVersion: 1,
		kind: 'winwidget.crm.preparation.v1',
		servicesRevision,
		infraRevision,
		canonicalEnvSha256,
		crmEnvSha256,
		neighborsSha256,
		composeSha256: digest(composeBytes),
		artifacts,
		runtimeProcesses: 12,
		databases: 4,
		migrationJobs: 4,
		capacityVerified: false,
		credentialsProvisioned: false,
		migrationsApplied: false,
		runtimeDeployed: false,
		releaseApproved: false
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const mode = process.argv[2]
		if (mode?.startsWith('upgrade-')) {
			const result = await crmUpgradeCommand(mode)
			if (result !== undefined)
				process.stdout.write(JSON.stringify(result) + '\n')
		} else if (
			['inventory', 'database-neighbors', 'runtime-neighbors'].includes(
				mode
			)
		) {
			assert.equal(process.argv.length, 3)
			const input = readFileSync(0, 'utf8')
			assert.ok(Buffer.byteLength(input) <= 8 * 1048576)
			process.stdout.write(
				(mode === 'inventory'
					? crmNeighborFingerprint
					: mode === 'runtime-neighbors'
						? crmRuntimeNeighbors
						: crmDatabaseNeighbors)(
					JSON.parse(input),
					process.env.CRM_GATEWAY_REVISION
				) + '\n'
			)
		} else if (mode === 'prepare') {
			assert.equal(process.argv.length, 3)
			const { validateCrmCompose } =
				await import('/run/crm-compose-validator.mjs')
			const report = crmPreparationReceipt(
				{
					composeBytes: readFileSync('/run/crm/desired.json', 'utf8'),
					images: JSON.parse(readFileSync('/run/crm/images.json', 'utf8')),
					servicesRevision: process.env.CRM_SERVICES_REVISION,
					infraRevision: process.env.CRM_INFRA_REVISION,
					canonicalEnvSha256: process.env.CRM_CANONICAL_ENV_SHA256,
					crmEnvSha256: process.env.CRM_ENV_SHA256,
					neighborsSha256: process.env.CRM_NEIGHBORS_SHA256,
					architecture: process.arch === 'x64' ? 'amd64' : process.arch
				},
				validateCrmCompose
			)
			process.stdout.write(JSON.stringify(report) + '\n')
		} else if (mode.startsWith('runtime-')) {
			const { validateCrmCompose } =
				await import('/run/crm-compose-validator.mjs')
			const composeBytes = readFileSync('/run/crm/desired.json', 'utf8')
			const config = JSON.parse(composeBytes)
			validateCrmCompose(config)
			const images = JSON.parse(
				readFileSync('/run/crm/images.json', 'utf8')
			)
			if (mode === 'runtime-seal') {
				const receipt = JSON.parse(
					readFileSync('/run/crm/receipt.json', 'utf8')
				)
				assert.equal(
					receipt.servicesRevision,
					process.env.CRM_SERVICES_REVISION
				)
				assert.equal(receipt.crmEnvSha256, process.env.CRM_ENV_SHA256)
				assert.deepEqual(
					crmPreparationReceipt(
						{
							...receipt,
							composeBytes,
							images,
							architecture: process.arch === 'x64' ? 'amd64' : process.arch
						},
						validateCrmCompose
					),
					receipt
				)
				assertCrmPublicGatesClosed(config)
				const names = Object.keys(config.services).filter(name =>
					config.services[name].profiles?.includes('crm-runtime')
				)
				assert.deepEqual(names.sort(), [...CRM_RUNTIME_NAMES].sort())
				process.stdout.write(CRM_RUNTIME_NAMES.join('\n') + '\n')
			} else if (mode === 'runtime-compose') {
				const selected = {
					name: 'winwidget-crm',
					services: Object.fromEntries(
						CRM_RUNTIME_NAMES.map(name => [name, config.services[name]])
					)
				}
				process.stdout.write(
					JSON.stringify(selected).replaceAll('$', () => '$$') + '\n'
				)
			} else if (mode === 'runtime-container') {
				const input = JSON.parse(readFileSync(0, 'utf8'))
				assert.equal(input.length, 1)
				process.stdout.write(
					crmRuntimeContainer(input[0], config, images, process.argv[3]) +
						'\n'
				)
			} else if (mode === 'runtime-ledger') {
				const owner = process.argv[3]
				assert.ok(owners.includes(owner))
				const { readDatabaseAccess } =
					await import('/run/crm-database-access.mjs')
				const { migrations } = readDatabaseAccess('/app/prisma', owner)
				process.stdout.write(
					String(
						crmRuntimeLedger(
							migrations,
							JSON.parse(readFileSync(0, 'utf8'))
						)
					) + '\n'
				)
			} else throw new Error('Unsupported runtime mode')
		} else if (mode.startsWith('database-')) {
			assert.ok(process.argv.length === 3 || process.argv.length === 4)
			const { validateCrmCompose } =
				await import('/run/crm-compose-validator.mjs')
			const config = JSON.parse(
				readFileSync('/run/crm/desired.json', 'utf8')
			)
			validateCrmCompose(config)
			const owner = process.argv[3]
			if (mode === 'database-resources') {
				assert.equal(process.argv.length, 3)
				const report = crmDatabaseResources(
					config,
					validateCrmCompose,
					Number(process.env.CRM_AVAILABLE_MEMORY_BYTES)
				)
				process.stdout.write(report.image + '\n')
			} else if (mode === 'database-container') {
				const container = JSON.parse(readFileSync(0, 'utf8'))
				assert.equal(container.length, 1)
				const images = JSON.parse(
					readFileSync('/run/crm/postgres-image.json', 'utf8')
				)
				assert.equal(images.length, 1)
				process.stdout.write(
					crmDatabaseContainer(container[0], config, images[0], owner) +
						'\n'
				)
			} else {
				assert.ok(owners.includes(owner))
				const passwordFile = path => {
					const value = readFileSync(path, 'utf8')
					assert.match(value, /^[a-f0-9]{48,128}\n?$/)
					return value.replace(/\n$/, '')
				}
				const backup = passwordFile('/run/crm-backup-password')
				const passwords = crmDatabaseCredentials(config, owner, backup)
				const admin = passwordFile('/run/crm-admin-password')
				assert.ok(!Object.values(passwords).includes(admin))
				const {
					readDatabaseAccess,
					databaseBootstrapSql,
					databaseRuntimeGrantsSql
				} = await import('/run/crm-database-access.mjs')
				const { contract, migrations } = readDatabaseAccess(
					'/app/prisma',
					owner
				)
				if (mode === 'database-check') process.stdout.write(owner + '\n')
				else if (mode === 'database-bootstrap')
					process.stdout.write(databaseBootstrapSql(contract, passwords))
				else if (mode === 'database-grants')
					process.stdout.write(
						databaseRuntimeGrantsSql(contract, migrations)
					)
				else if (/^database-auth-(migration|runtime|backup)$/.test(mode)) {
					const role = mode.slice('database-auth-'.length)
					// Private pipe only: a single password line, then SQL for psql.
					process.stdout.write(passwords[role] + '\nSELECT 1;\n')
				} else throw new Error('Unsupported database mode')
			}
		} else throw new Error('Unsupported mode')
	} catch {
		process.stderr.write(
			'CRM release verification failed; private details suppressed\n'
		)
		process.exitCode = 1
	}
}
