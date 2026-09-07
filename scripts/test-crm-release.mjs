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
	statSync,
	symlinkSync,
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
	crmDatabaseCredentials,
	CRM_RUNTIME_NAMES,
	crmRuntimeNeighbors,
	crmRuntimeContainer,
	crmRuntimeLedger,
	CRM_UPGRADE_GROUPS,
	crmUpgradeGroups,
	crmUpgradeRemindersContract,
	crmUpgradeRemindersContractFromEnv,
	CRM_UPGRADE_MIGRATIONS,
	crmUpgradeNotificationDatabaseIdentity,
	crmUpgradeBaseline,
	crmUpgradeFence,
	crmUpgradeSource,
	crmUpgradeLedger,
	crmUpgradeDatabasePreserved,
	crmUpgradeDesired,
	crmUpgradeOldImages,
	crmUpgradeImageSource,
	crmUpgradeDatabaseInput,
	crmUpgradeDatabaseConnection,
	crmUpgradeDatabaseMemberships,
	parseCrmUpgradeDatabaseHandoff,
	assertCrmPublicGatesClosed
} from './crm-release.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const sha = value => createHash('sha256').update(value).digest('hex')
const revision = 'a'.repeat(40)
const previous = 'b'.repeat(40)
const hash = 'c'.repeat(64)
const owners = ['crm-access', 'crm-intake', 'crm-customers', 'crm-sales']
const id = number => number.toString(16).padStart(64, '0')
const image = number => 'sha256:' + id(number)
test('closed public API permits prepared specialized readers but not public feature activation', () => {
	const services = {
		'crm-access-api': {
			environment: { CRM_ACCESS_BILLING_ENABLED: 'false' }
		},
		'crm-intake-api': {
			environment: {
				CRM_INTAKE_WIDGETS_ENABLED: 'false',
				CRM_INTAKE_WIDGET_TRANSFERS_ENABLED: 'false'
			}
		}
	}
	for (const role of [
		'widget-control-worker',
		'widget-control-publisher',
		'widget-transfer-worker',
		'widget-transfer-publisher'
	])
		services['crm-intake-' + role] = {
			environment: {
				CRM_INTAKE_WIDGETS_ENABLED: 'true',
				CRM_INTAKE_WIDGET_TRANSFERS_ENABLED: role.startsWith('widget-transfer-')
					? 'true'
					: 'false'
			}
		}
	assertCrmPublicGatesClosed({ services })
	for (const name of Object.keys(services)) {
		const altered = structuredClone(services)
		const key = Object.keys(altered[name].environment)[0]
		altered[name].environment[key] =
			altered[name].environment[key] === 'true' ? 'false' : 'true'
		assert.throws(() => assertCrmPublicGatesClosed({ services: altered }))
	}
})
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

const reminderKinds =
	'email,telegram,payment-email,payment-telegram,limit-email,limit-telegram,campaign-email,campaign-telegram,daily-summary-delivery-telegram,subscription-expiry-email,subscription-expiry-telegram,wincrm-invitation-email,wincrm-task-reminder-email,wincrm-task-reminder-telegram'
function reminderEnvironment(name) {
	if (name === 'notification-delivery-worker')
		return { NOTIFICATION_DELIVERY_KINDS: reminderKinds }
	if (['crm-sales-api', 'crm-sales-reminders'].includes(name))
		return {
			CRM_TASK_REMINDERS_ENABLED: 'true',
			CRM_SALES_PROCESS_ROLE:
				name === 'crm-sales-api' ? 'api' : 'reminders'
		}
	return {}
}
function upgradeFixture(contract = 'disabled') {
	const names = [
		['winwidget', 'api-gateway'],
		['winwidget', 'billing-postgres'],
		['winwidget', 'identity-worker'],
		...owners.map(owner => ['winwidget-crm', owner + '-postgres']),
		...crmUpgradeGroups(contract).flatMap(([owner, ...services]) =>
			services.map(name => [
				owner.startsWith('crm-') ? 'winwidget-crm' : 'winwidget',
				name
			])
		)
	]
	const live = names.map(([project, name], index) => {
		const item = structuredClone(neighbors()[0])
		item.Id = id(index + 1)
		item.Image = image(index + 1)
		item.Name = `/${project}-${name}-1`
		item.Config.Hostname = item.Id.slice(0, 12)
		item.Config.Env.push(`APP_REVISION=${previous}`)
		if (contract !== 'disabled')
			item.Config.Env.push(
				...Object.entries(reminderEnvironment(name)).map(
					([key, value]) => `${key}=${value}`
				)
			)
		item.Config.Labels['com.docker.compose.project'] = project
		item.Config.Labels['com.docker.compose.service'] = name
		item.State.Dead = false
		return item
	})
	const baseline = crmUpgradeBaseline(
		live,
		previous,
		{
			billing: hash,
			canonical: hash,
			crm: hash,
			identity: hash,
			'notification-delivery': hash
		},
		contract
	)
	return { live, baseline }
}

test('upgrade reminder marker is explicit, bounded and never guessed from the running process', () => {
	assert.equal(crmUpgradeRemindersContract(), 'disabled')
	assert.equal(crmUpgradeGroups(), CRM_UPGRADE_GROUPS)
	assert.equal(
		crmUpgradeRemindersContractFromEnv(
			'SECRET=synthetic\n# CRM_REMINDERS_RABBITMQ_CONTRACT=task-reminders-v1\n'
		),
		'disabled'
	)
	for (const mode of ['disabled', 'task-reminders-v1'])
		for (const quote of ['', "'", '"'])
			assert.equal(
				crmUpgradeRemindersContractFromEnv(
					`SECRET=synthetic\nCRM_REMINDERS_RABBITMQ_CONTRACT=${quote}${mode}${quote}\n`
				),
				mode
			)
	for (const value of ['', 'true', 'mvp-v1', null, 1])
		assert.throws(() => crmUpgradeRemindersContract(value))
	for (const value of [
		'CRM_REMINDERS_RABBITMQ_CONTRACT=',
		'CRM_REMINDERS_RABBITMQ_CONTRACT=true',
		'CRM_REMINDERS_RABBITMQ_CONTRACT=disabled\nCRM_REMINDERS_RABBITMQ_CONTRACT=task-reminders-v1',
		'export CRM_REMINDERS_RABBITMQ_CONTRACT=task-reminders-v1',
		' CRM_REMINDERS_RABBITMQ_CONTRACT=task-reminders-v1',
		'CRM_REMINDERS_RABBITMQ_CONTRACT="task-reminders-v1',
		'x'.repeat(1048577)
	])
		assert.throws(() => crmUpgradeRemindersContractFromEnv(value))
	const { live, baseline } = upgradeFixture('task-reminders-v1')
	assert.equal(Object.keys(baseline.targets).length, 19)
	assert.equal(baseline.remindersContract, 'task-reminders-v1')
	assert.equal(crmUpgradeFence(live, baseline), true)
	assert.deepEqual(
		crmUpgradeGroups(baseline.remindersContract).find(
			([owner]) => owner === 'crm-sales'
		),
		['crm-sales', 'crm-sales-reminders', 'crm-sales-api']
	)
	assert.equal(crmUpgradeOldImages(baseline, 'crm-sales').length, 2)
	assert.throws(() =>
		crmUpgradeBaseline(live, previous, baseline.environmentHashes)
	)
	for (const change of [
		value => delete value.remindersContract,
		value => {
			value.remindersContract = 'unknown'
		},
		value => {
			delete value.targets['winwidget-crm/crm-sales-reminders']
		}
	]) {
		const altered = structuredClone(baseline)
		change(altered)
		assert.throws(() => crmUpgradeFence(live, altered))
	}
	for (const change of [
		rows =>
			rows.splice(
				rows.findIndex(
					row =>
						row.Config.Labels['com.docker.compose.service'] ===
						'crm-sales-reminders'
				),
				1
			),
		rows => {
			const extra = structuredClone(rows.at(-1))
			extra.Id = id(999)
			extra.Config.Labels['com.docker.compose.service'] =
				'crm-sales-unknown'
			rows.push(extra)
		},
		rows => {
			rows.find(
				row =>
					row.Config.Labels['com.docker.compose.service'] ===
					'crm-sales-api'
			).Config.Env = [
				`APP_REVISION=${previous}`,
				'CRM_TASK_REMINDERS_ENABLED=false'
			]
		}
	]) {
		const altered = structuredClone(live)
		change(altered)
		assert.throws(() =>
			crmUpgradeBaseline(
				altered,
				previous,
				baseline.environmentHashes,
				'task-reminders-v1'
			)
		)
	}
})

test('upgrade baseline seals exact target identities and all neighbors without a magic global count or secrets', () => {
	const { live, baseline } = upgradeFixture()
	assert.equal(Object.keys(baseline.targets).length, 18)
	assert.ok(
		Object.hasOwn(
			baseline.targets,
			'winwidget/notification-delivery-worker'
		)
	)
	assert.equal(
		Object.hasOwn(baseline.targets, 'winwidget-crm/crm-sales-reminders'),
		false
	)
	const missingOwnerEnv = { ...baseline.environmentHashes }
	delete missingOwnerEnv['notification-delivery']
	assert.throws(() => crmUpgradeBaseline(live, previous, missingOwnerEnv))
	assert.equal(
		JSON.stringify(baseline).includes('SYNTHETIC_SECRET'),
		false
	)
	assert.equal(crmUpgradeFence(live, baseline), true)
	for (const mutate of [
		rows => rows.pop(),
		rows => rows.push(rows[0]),
		rows => {
			rows[0].State.Health.Status = 'unhealthy'
		},
		rows => {
			rows[1].Id = id(999)
		},
		rows => {
			rows.at(-1).Config.Env.push('PAID_FLAG=true')
		},
		rows => {
			rows.at(-1).HostConfig.Privileged = true
		}
	]) {
		const changed = structuredClone(live)
		mutate(changed)
		assert.throws(() => crmUpgradeFence(changed, baseline))
	}
})

test('upgrade partial retry permits only the reviewed active group and exact old/new images', () => {
	const { live, baseline } = upgradeFixture()
	const item = live.find(
		row => row.Config.Labels['com.docker.compose.service'] === 'billing-api'
	)
	const key = 'winwidget/billing-api'
	const replacements = { [key]: { image: image(999), revision } }
	const upgrade = (name, number) => {
		const row = live.find(
			item => item.Config.Labels['com.docker.compose.service'] === name
		)
		row.Image = image(number)
		row.Id = id(number)
		row.Config.Labels['org.opencontainers.image.revision'] = revision
		row.Config.Env = row.Config.Env.map(value =>
			value.startsWith('APP_REVISION=') ? `APP_REVISION=${revision}` : value
		)
		replacements[`winwidget/${name}`] = { image: row.Image, revision }
	}
	upgrade('identity-api', 800)
	item.State.Running = false
	item.State.Health.Status = 'unhealthy'
	assert.throws(() => crmUpgradeFence(live, baseline, replacements))
	assert.equal(crmUpgradeFence(live, baseline, replacements, 'billing'), true)
	assert.throws(() =>
		crmUpgradeFence(live, baseline, replacements, 'crm-access')
	)
	item.Image = image(999)
	item.Id = id(777)
	item.Config.Hostname = 'new-hostname'
	item.Config.Labels['org.opencontainers.image.revision'] = revision
	item.Config.Env = item.Config.Env.map(line =>
		line.startsWith('APP_REVISION=') ? `APP_REVISION=${revision}` : line
	)
	item.State.Running = true
	item.State.Health.Status = 'healthy'
	assert.throws(() => crmUpgradeFence(live, baseline, replacements))
	for (const name of [
		'billing-worker',
		'billing-outbox-publisher',
		'billing-scheduler'
	])
		upgrade(name, 801 + Object.keys(replacements).length)
	assert.equal(crmUpgradeFence(live, baseline, replacements), true)
	item.Image = image(998)
	assert.throws(() => crmUpgradeFence(live, baseline, replacements, 'billing'))
})

test('upgrade source inventories every distinct old image including historical API-only and worker-only releases', () => {
	const { baseline } = upgradeFixture()
	for (const [owner, ...names] of CRM_UPGRADE_GROUPS)
		assert.equal(crmUpgradeOldImages(baseline, owner).length, names.length)
	const oldApi = baseline.targets['winwidget/billing-api'].image
	const oldWorker = baseline.targets['winwidget/billing-worker'].image
	assert.notEqual(oldApi, oldWorker)
	assert.ok(crmUpgradeOldImages(baseline, 'billing').includes(oldWorker))
	baseline.targets['winwidget/billing-worker'].image = oldApi
	assert.equal(crmUpgradeOldImages(baseline, 'billing').length, 3)
	assert.throws(() => crmUpgradeOldImages(baseline, 'unknown'))
	baseline.targets['winwidget/billing-worker'].image = 'mutable:tag'
	assert.throws(() => crmUpgradeOldImages(baseline, 'billing'))
})

test('upgrade source permits only reviewed expansion SQL and proves Identity schema/migrations unchanged', () => {
	const base = { 'schema.prisma': hash, '20260101000000_initial': hash }
	assert.equal(crmUpgradeSource('identity', base, base), true)
	assert.throws(() =>
		crmUpgradeSource('identity', base, {
			...base,
			'schema.prisma': 'd'.repeat(64)
		})
	)
	const changes = CRM_UPGRADE_MIGRATIONS['crm-sales']
	const next = { ...base, ...changes, 'schema.prisma': 'd'.repeat(64) }
	assert.equal(crmUpgradeSource('crm-sales', base, next), true)
	assert.throws(() =>
		crmUpgradeSource('crm-sales', base, {
			...next,
			'20260101000000_initial': 'e'.repeat(64)
		})
	)
	assert.throws(() =>
		crmUpgradeSource('crm-sales', base, {
			...next,
			'20270101000000_unreviewed': hash
		})
	)
	assert.throws(() =>
		crmUpgradeSource('crm-sales', base, {
			...next,
			'20260907120100_expand_workday_tasks': hash
		})
	)
})

function companyRequisitesSourceFixture() {
	const migration = '20260907210000_add_company_requisites'
	const checksum =
		'2906853950f496d481dc831af21d824418ecd7281f105ad3b3356e98c90fbfc1'
	const before = {
		'schema.prisma':
			'be7b6d591352f4dbd77310df08f3d27971a49ede45cb653a8ff6ac6ea2823b12',
		'database-access.json': hash,
		'migration_lock.toml': hash,
		'20260101000000_initial': hash
	}
	const after = {
		...before,
		'schema.prisma':
			'7d17e1d8b4cdc31cea0e342427aa84d1b388d3f22515b2e5cfcacde1afe79b42',
		[migration]: checksum
	}
	return { migration, checksum, before, after }
}

test('Customers contact preferences require their exact forward schema pair and preserve company requisites', () => {
	const { before: initial, after: before } =
		companyRequisitesSourceFixture()
	const migration = '20260907223000_add_contact_call_preferences'
	const after = {
		...before,
		'schema.prisma':
			'4ceda3fabb6a6923f5a75c540ff01b89926ea0d8c27c1f40e6e57e8fa40c51d2',
		[migration]:
			'6ec838976adc8aa583b29a7732fe9cbddabb60d63ab7efd3b67c7d78968e0fec'
	}
	assert.equal(crmUpgradeSource('crm-customers', before, after), true)
	assert.equal(crmUpgradeSource('crm-customers', initial, after), true)
	assert.equal(crmUpgradeSource('crm-customers', after, after), true)
	for (const alter of [
		value => delete value[migration],
		value => (value[migration] = hash),
		value => (value['schema.prisma'] = before['schema.prisma']),
		value => (value['schema.prisma'] = hash),
		value => (value['database-access.json'] = 'd'.repeat(64)),
		value => delete value['20260907210000_add_company_requisites']
	]) {
		const changed = structuredClone(after)
		alter(changed)
		assert.throws(() => crmUpgradeSource('crm-customers', before, changed))
	}
	assert.throws(() => crmUpgradeSource('crm-customers', after, before))
})

test('upgrade ND reader permits only CHECK expansion with unchanged Prisma, old SQL and ACL source', () => {
	const migration = '20260907230000_add_wincrm_task_reminders'
	const before = {
		'schema.prisma': hash,
		'migration_lock.toml': hash,
		'20260727000000_init_notification_delivery': hash
	}
	const after = {
		...before,
		[migration]: CRM_UPGRADE_MIGRATIONS['notification-delivery'][migration]
	}
	assert.equal(
		crmUpgradeSource('notification-delivery', before, after),
		true
	)
	assert.equal(
		crmUpgradeSource('notification-delivery', after, after),
		true
	)
	for (const alter of [
		value => (value['schema.prisma'] = 'd'.repeat(64)),
		value => (value[migration] = hash),
		value => (value['database-access.json'] = hash),
		value => delete value['20260727000000_init_notification_delivery'],
		value => (value['20260907230001_unreviewed'] = hash)
	]) {
		const changed = structuredClone(after)
		alter(changed)
		assert.throws(() =>
			crmUpgradeSource('notification-delivery', before, changed)
		)
	}
	assert.throws(() =>
		crmUpgradeSource('notification-delivery', after, before)
	)
})

test('Customers source accepts only the paired requisites schema and exact append-only migration', () => {
	const { migration, checksum, before, after } =
		companyRequisitesSourceFixture()
	assert.equal(
		CRM_UPGRADE_MIGRATIONS['crm-customers'][migration],
		checksum
	)
	assert.equal(crmUpgradeSource('crm-customers', before, after), true)
	assert.equal(crmUpgradeSource('crm-customers', before, before), true)
	assert.equal(crmUpgradeSource('crm-customers', after, after), true)
	for (const owner of [
		'identity',
		'crm-access',
		'crm-intake',
		'crm-sales',
		'billing'
	])
		assert.throws(() => crmUpgradeSource(owner, before, after), owner)
})

test('Customers requisites expansion preserves old SQL, schema binding and exact ACL without accepting partial changes', () => {
	const { migration, before, after } = companyRequisitesSourceFixture()
	const cases = [
		['unknown old schema', source => (source.before['schema.prisma'] = hash)],
		['unknown new schema', source => (source.after['schema.prisma'] = hash)],
		[
			'migration without schema',
			source => (source.after['schema.prisma'] = before['schema.prisma'])
		],
		['schema without migration', source => delete source.after[migration]],
		['modified migration', source => (source.after[migration] = hash)],
		[
			'renamed migration',
			source => {
				source.after['20260907210001_add_company_requisites'] =
					source.after[migration]
				delete source.after[migration]
			}
		],
		[
			'unreviewed SQL',
			source => (source.after['20260907210001_unreviewed'] = hash)
		],
		[
			'rewritten old SQL',
			source => (source.after['20260101000000_initial'] = 'd'.repeat(64))
		],
		[
			'removed old SQL',
			source => delete source.after['20260101000000_initial']
		],
		[
			'changed ACL',
			source => (source.after['database-access.json'] = 'd'.repeat(64))
		],
		['removed ACL', source => delete source.after['database-access.json']],
		[
			'changed migration lock',
			source => (source.after['migration_lock.toml'] = 'd'.repeat(64))
		],
		[
			'removed migration lock',
			source => delete source.after['migration_lock.toml']
		],
		['removed schema', source => delete source.after['schema.prisma']],
		[
			'preexisting mismatched migration',
			source => (source.before[migration] = source.after[migration])
		]
	]
	for (const [name, change] of cases) {
		const source = structuredClone({ before, after })
		change(source)
		assert.throws(
			() => crmUpgradeSource('crm-customers', source.before, source.after),
			name
		)
	}
	assert.throws(() => crmUpgradeSource('crm-customers', after, before))
})

test('Customers requisites ledger requires exact SQL, completed apply and no extra pending migration', () => {
	const { migration, checksum, after } = companyRequisitesSourceFixture()
	const initial = {
		id: 'initial',
		migration_name: '20260101000000_initial',
		checksum: hash,
		finished_at: '2026-01-01',
		rolled_back_at: null
	}
	const applied = {
		id: 'company-requisites',
		migration_name: migration,
		checksum,
		finished_at: '2026-09-07',
		rolled_back_at: null
	}
	assert.deepEqual(crmUpgradeLedger('crm-customers', after, [initial]), [
		migration
	])
	assert.throws(() => crmUpgradeLedger('crm-customers', after, [initial], true))
	assert.deepEqual(
		crmUpgradeLedger('crm-customers', after, [initial, applied], true),
		[]
	)
	for (const change of [
		row => (row.checksum = hash),
		row => (row.finished_at = null),
		row => (row.rolled_back_at = '2026-09-07')
	]) {
		const row = structuredClone(applied)
		change(row)
		assert.throws(() =>
			crmUpgradeLedger('crm-customers', after, [initial, row], true)
		)
	}
	assert.throws(() =>
		crmUpgradeLedger('crm-customers', after, [initial, applied, applied], true)
	)
	assert.throws(() =>
		crmUpgradeLedger(
			'crm-customers',
			{
				...after,
				'20260907210001_unreviewed': hash
			},
			[initial, applied]
		)
	)
})

function privateSourceFixture(directory) {
	const prisma = join(directory, 'prisma')
	const migration = '20260101000000_initial'
	mkdirSync(join(prisma, 'migrations', migration), {
		recursive: true,
		mode: 0o700
	})
	for (const path of [
		prisma,
		join(prisma, 'migrations'),
		join(prisma, 'migrations', migration)
	])
		chmodSync(path, 0o700)
	const content = {
		'schema.prisma': '// public synthetic Prisma schema\n',
		'database-access.json': '{"synthetic":true}\n',
		'migrations/migration_lock.toml': 'provider = "postgresql"\n',
		[`migrations/${migration}/migration.sql`]: 'SELECT 1;\n'
	}
	for (const [name, bytes] of Object.entries(content))
		writeFileSync(join(prisma, name), bytes, { mode: 0o600 })
	return { prisma, migration, content }
}

test('upgrade extractor reads actual owner-private 0600/0700 Prisma files without rewriting them', () => {
	const directory = mkdtempSync(join(tmpdir(), 'wincrm-upgrade-source-'))
	try {
		const { prisma, migration, content } = privateSourceFixture(directory)
		const expected = Object.fromEntries(
			Object.entries(content).map(([name, bytes]) => [
				name.startsWith('migrations/')
					? name.endsWith('/migration.sql')
						? migration
						: 'migration_lock.toml'
					: name,
				sha(bytes)
			])
		)
		assert.deepEqual(crmUpgradeImageSource(prisma), expected)
		for (const [name, bytes] of Object.entries(content)) {
			assert.equal(statSync(join(prisma, name)).mode & 0o777, 0o600)
			assert.equal(readFileSync(join(prisma, name), 'utf8'), bytes)
		}
		assert.equal(statSync(join(prisma, 'migrations')).mode & 0o777, 0o700)
		symlinkSync(prisma, join(directory, 'alias'))
		assert.throws(() => crmUpgradeImageSource(join(directory, 'alias')))
		writeFileSync(
			join(prisma, 'migrations', migration, 'unexpected.sql'),
			'SELECT 2;'
		)
		assert.throws(() => crmUpgradeImageSource(prisma))
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})

function databaseInputFixture(owner = 'identity') {
	const schema = owner.replaceAll('-', '_')
	const migrationUrl = `postgresql://winwidget_${schema}_migration:migration-test-secret@127.0.0.1:55442/winwidget_${schema}?schema=${schema}&sslmode=disable&connection_limit=1&pool_timeout=5`
	const runtimeUrl = `postgresql://winwidget_${schema}_runtime:runtime-secret-must-not-cross@127.0.0.1:55442/winwidget_${schema}?schema=${schema}&sslmode=disable`
	const migrationKey =
		owner === 'notification-delivery'
			? 'NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION'
			: `${schema.toUpperCase()}_MIGRATION_DATABASE_URL`
	const ownerEnv = `${migrationKey}=${JSON.stringify(migrationUrl)}\nUNRELATED_SECRET=not-in-handoff\n`
	const live = [
		{
			Config: {
				Labels: {
					'com.docker.compose.project': owner.startsWith('crm-')
						? 'winwidget-crm'
						: 'winwidget',
					'com.docker.compose.service':
						owner === 'notification-delivery'
							? 'notification-delivery-worker'
							: `${owner}-api`
				},
				Env: [
					`${schema.toUpperCase()}_DATABASE_URL=${runtimeUrl}`,
					'OTHER_SECRET=not-in-handoff'
				]
			}
		}
	]
	return { owner, schema, ownerEnv, live, migrationUrl, runtimeUrl }
}

test('database stdin handoff is owner-bound and contains only one migration secret for all seven images', () => {
	for (const [owner] of CRM_UPGRADE_GROUPS) {
		const fixture = databaseInputFixture(owner)
		const value = crmUpgradeDatabaseInput(owner, fixture.ownerEnv, fixture.live)
		assert.deepEqual(value, {
			owner,
			migrationUrl: fixture.migrationUrl,
			runtimeBinding: {
				host: '127.0.0.1',
				port: '55442',
				username: `winwidget_${fixture.schema}_runtime`,
				database: `winwidget_${fixture.schema}`,
				schema: fixture.schema
			}
		})
		assert.equal(
			crmUpgradeDatabaseConnection(owner, value).href,
			fixture.migrationUrl
		)
		assert.equal(JSON.stringify(value).includes('runtime-secret'), false)
		assert.equal(JSON.stringify(value).includes('not-in-handoff'), false)
		assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 16384)
	}
})

test('database root reader rejects absent, duplicate and cross-owner runtime/env bindings', () => {
	const { owner, ownerEnv, live, schema } = databaseInputFixture()
	for (const changed of [
		[],
		[...live, ...live],
		[
			{
				...live[0],
				Config: {
					...live[0].Config,
					Labels: {
						...live[0].Config.Labels,
						'com.docker.compose.project': 'foreign'
					}
				}
			}
		]
	])
		assert.throws(() => crmUpgradeDatabaseInput(owner, ownerEnv, changed))
	assert.throws(() => crmUpgradeDatabaseInput('billing', ownerEnv, live))
	assert.throws(() => crmUpgradeDatabaseInput(owner, ownerEnv + ownerEnv, live))
	assert.throws(() => crmUpgradeDatabaseInput(owner, 'x'.repeat(1048577), live))
	assert.throws(() =>
		crmUpgradeDatabaseInput(owner, 'INVALID LINE\n' + ownerEnv, live)
	)
	const duplicate = structuredClone(live)
	duplicate[0].Config.Env.push(duplicate[0].Config.Env[0])
	assert.throws(() => crmUpgradeDatabaseInput(owner, ownerEnv, duplicate))
	for (const replace of [
		value => value.replace(':55442/', ':55443/'),
		value => value.replace('_runtime:', '_migration:'),
		value => value.replace('127.0.0.1', 'localhost'),
		value => value.replace(`schema=${schema}`, 'schema=foreign'),
		value => value + `&schema=${schema}`
	]) {
		const changed = structuredClone(live)
		changed[0].Config.Env[0] = replace(changed[0].Config.Env[0])
		assert.throws(() => crmUpgradeDatabaseInput(owner, ownerEnv, changed))
	}
})

test('upgrade ND database continuity binds real OID and immutable complete ledger without a fictitious service UUID', () => {
	const fixture = databaseInputFixture('notification-delivery')
	const input = crmUpgradeDatabaseInput(
		fixture.owner,
		fixture.ownerEnv,
		fixture.live
	)
	const principal = {
		db: 'winwidget_notification_delivery',
		schema: 'notification_delivery',
		databaseOid: '16596'
	}
	const row = {
		id: '11111111-2222-4333-8444-555555555555',
		migration_name: '20260727000000_init_notification_delivery',
		checksum: hash,
		finished_at: '2026-07-27 00:00:00+00',
		rolled_back_at: null
	}
	const identity = crmUpgradeNotificationDatabaseIdentity(
		input,
		principal,
		[row]
	)
	assert.equal(identity.kind, 'postgres-database-ledger-anchor.v1')
	assert.equal(identity.databaseOid, '16596')
	assert.equal(JSON.stringify(identity).includes('secret'), false)
	const before = {
		databaseId: null,
		databaseIdentity: identity,
		ledger: [row],
		roles: [],
		memberships: [],
		acl: [],
		pending: ['new']
	}
	const after = {
		...structuredClone(before),
		ledger: [
			row,
			{
				...row,
				id: '66666666-2222-4333-8444-555555555555',
				migration_name: '20260907230000_add_wincrm_task_reminders'
			}
		],
		pending: []
	}
	assert.equal(crmUpgradeDatabasePreserved(before, after), true)
	for (const alter of [
		value => (value.databaseIdentity.databaseOid = '16597'),
		value => (value.databaseIdentity.host = 'localhost'),
		value => (value.databaseIdentity.port = '55443'),
		value =>
			(value.databaseIdentity.anchor.id =
				'66666666-2222-4333-8444-555555555555'),
		value => (value.ledger[0].checksum = 'd'.repeat(64)),
		value => (value.ledger[0].finished_at = null),
		value => value.ledger.shift(),
		value => delete value.databaseIdentity,
		value => delete value.ledger,
		value => value.memberships.push({ role: 'foreign' })
	]) {
		const changed = structuredClone(after)
		alter(changed)
		assert.throws(() => crmUpgradeDatabasePreserved(before, changed))
	}
	for (const databaseOid of ['0', '-1', '4294967296', '123x', null])
		assert.throws(() =>
			crmUpgradeNotificationDatabaseIdentity(
				input,
				{ ...principal, databaseOid },
				[row]
			)
		)
	for (const ledger of [
		[],
		[{ ...row, finished_at: null }],
		[{ ...row, rolled_back_at: '2026-01-01' }],
		[
			{
				...row,
				migration_name: '20260907230000_add_wincrm_task_reminders'
			}
		]
	])
		assert.throws(() =>
			crmUpgradeNotificationDatabaseIdentity(input, principal, ledger)
		)
	assert.deepEqual(
		crmUpgradeDatabaseMemberships('notification-delivery', []),
		[]
	)
	assert.throws(() =>
		crmUpgradeDatabaseMemberships('notification-delivery', [
			{ role: 'winwidget_notification_delivery_runtime' }
		])
	)
	const wrong = structuredClone(fixture.live)
	wrong[0].Config.Labels['com.docker.compose.service'] =
		'notification-delivery-api'
	assert.throws(() =>
		crmUpgradeDatabaseInput(fixture.owner, fixture.ownerEnv, wrong)
	)
	assert.throws(() =>
		crmUpgradeDatabaseInput(
			fixture.owner,
			fixture.ownerEnv.replace(
				'MIGRATION_URL_PRODUCTION',
				'MIGRATION_DATABASE_URL'
			),
			fixture.live
		)
	)
})

test('non-root database consumer revalidates exact envelope, migration identity and approved runtime binding', () => {
	const fixture = databaseInputFixture()
	const value = crmUpgradeDatabaseInput(
		fixture.owner,
		fixture.ownerEnv,
		fixture.live
	)
	for (const change of [
		entry => {
			entry.owner = 'billing'
		},
		entry => {
			entry.unexpected = 'secret'
		},
		entry => {
			entry.runtimeBinding.port = '55443'
		},
		entry => {
			entry.runtimeBinding.host = 'localhost'
		},
		entry => {
			entry.runtimeBinding.username = 'winwidget_identity_migration'
		},
		entry => {
			entry.runtimeBinding.database = 'foreign'
		},
		entry => {
			entry.runtimeBinding.schema = 'foreign'
		},
		entry => {
			entry.runtimeBinding.password = 'not-allowed'
		},
		entry => {
			entry.migrationUrl = entry.migrationUrl.replace(
				'_migration:',
				'_runtime:'
			)
		},
		entry => {
			entry.migrationUrl = entry.migrationUrl.replace('127.0.0.1', 'localhost')
		},
		entry => {
			entry.migrationUrl = entry.migrationUrl.replace(
				'/winwidget_identity?',
				'/foreign?'
			)
		},
		entry => {
			entry.migrationUrl = entry.migrationUrl.replace(
				'schema=identity',
				'schema=foreign'
			)
		},
		entry => {
			entry.migrationUrl = entry.migrationUrl.replace(
				'sslmode=disable',
				'sslmode=require'
			)
		},
		entry => {
			entry.migrationUrl += '&schema=identity'
		},
		entry => {
			entry.migrationUrl += '&connection_limit=1'
		},
		entry => {
			entry.migrationUrl += '&unexpected=value'
		},
		entry => {
			entry.migrationUrl += '#fragment'
		},
		entry => {
			entry.migrationUrl = 'x'.repeat(8193)
		}
	]) {
		const changed = structuredClone(value)
		change(changed)
		assert.throws(() => crmUpgradeDatabaseConnection(fixture.owner, changed))
	}
	for (const changed of [null, [], {}, 'text'])
		assert.throws(() => crmUpgradeDatabaseConnection(fixture.owner, changed))
	for (const raw of [
		'{',
		JSON.stringify({ ...value, owner: 'billing' }),
		JSON.stringify(value).replace(
			'"owner":"identity"',
			'"owner":"billing","owner":"identity"'
		),
		'x'.repeat(16385)
	]) {
		const result = spawnSync(
			process.execPath,
			[
				join(root, 'crm-release.mjs'),
				'upgrade-database',
				fixture.owner,
				'complete'
			],
			{ encoding: 'utf8', input: raw }
		)
		assert.notEqual(result.status, 0)
		assert.equal(result.stdout, '')
		assert.equal(
			result.stderr,
			'CRM release verification failed; private details suppressed\n'
		)
	}
})

test('bounded database handoff parser rejects duplicate keys and malformed bytes before Prisma loads', () => {
	const { owner, ownerEnv, live } = databaseInputFixture()
	const value = crmUpgradeDatabaseInput(owner, ownerEnv, live)
	const raw = JSON.stringify(value)
	assert.deepEqual(parseCrmUpgradeDatabaseHandoff(Buffer.from(raw)), value)
	for (const bytes of [
		Buffer.from(
			raw.replace(
				'"owner":"identity"',
				'"owner":"billing","owner":"identity"'
			)
		),
		Buffer.from(
			raw.replace('"port":"55442"', '"port":"55443","port":"55442"')
		),
		Buffer.from('{'),
		Buffer.alloc(0),
		Buffer.alloc(16385, 32),
		Buffer.from([0xc3, 0x28])
	])
		assert.throws(() => parseCrmUpgradeDatabaseHandoff(bytes))
})

function probeArguments(mode, owner, producer = 'success', contract = 'disabled') {
	const directory = mkdtempSync(join(tmpdir(), 'wincrm-upgrade-argv-'))
	try {
		const result = spawnSync(
			'/bin/bash',
			[
				'-c',
				`
set -euo pipefail
source "$TEST_LIBRARY"
scoped_payload_directory='/synthetic public payload'
release_root='/synthetic release'
crm_work_directory='/private workdir'
services_repository='/synthetic services'
crm_env_file='/private CRM/.env.production'
env_file='/private canonical/.env.production'
expected_live_revision="$TEST_REVISION"
services_revision="$TEST_REVISION"
infra_revision="$TEST_REVISION"
crm_upgrade_env_hashes='{}'
crm_upgrade_reminders_contract="$TEST_CONTRACT"
crm_probe_image="$TEST_GATEWAY"
export crm_upgrade_handoff='inherited-public-value'
docker() {
  local mode="\${@: -3:1}" input attributes
  attributes="$(declare -p crm_upgrade_handoff 2>/dev/null || true)"
  [[ "$attributes" != 'declare -x'* ]] || return 19
  printf '%s\\0' "$@" >"$TEST_DIRECTORY/$mode.argv"
  if [[ "$mode" == upgrade-database-input ]]; then
    if [[ "$TEST_PRODUCER" == oversize ]]; then printf '%16385s' ''; return 0; fi
    if [[ "$TEST_PRODUCER" == empty ]]; then return 0; fi
    printf 'PRIVATE_STDIN_SENTINEL'
    [[ "$TEST_PRODUCER" != failed ]] || return 17
  elif [[ "$mode" == upgrade-database ]]; then
    input="$(command dd bs=1024 count=1 2>/dev/null)"
    [[ "$input" == PRIVATE_STDIN_SENTINEL ]] || return 18
    printf 'true\\n'
  fi
}
crm_upgrade_probe "$TEST_MODE" "$TEST_OWNER" "$TEST_IMAGE" complete
`
			],
			{
				encoding: 'utf8',
				env: {
					PATH: process.env.PATH,
					TEST_LIBRARY: join(root, 'deploy-crm-scoped.sh'),
					TEST_DIRECTORY: directory,
					TEST_MODE: mode,
					TEST_OWNER: owner,
					TEST_IMAGE: image(2),
					TEST_GATEWAY: image(1),
					TEST_REVISION: revision,
					TEST_PRODUCER: producer,
					TEST_CONTRACT: contract
				}
			}
		)
		return {
			result,
			calls: Object.fromEntries(
				readdirSync(directory).map(file => [
					file.replace('.argv', ''),
					readFileSync(join(directory, file), 'utf8').split('\0').slice(0, -1)
				])
			)
		}
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

test('real upgrade probe argv isolates source and piped database reads without adding capabilities or private mounts', () => {
	const ordinary = [
		'upgrade-contract',
		'upgrade-baseline',
		'upgrade-old-images',
		'upgrade-baseline-check',
		'upgrade-source-check',
		'upgrade-database-check',
		'upgrade-pending',
		'upgrade-grants',
		'upgrade-env',
		'upgrade-prepare',
		'upgrade-fence',
		'upgrade-complete',
		'upgrade-compose'
	]
	for (const owner of CRM_UPGRADE_GROUPS.map(([owner]) => owner)) {
		for (const mode of ['upgrade-source', 'upgrade-database', ...ordinary]) {
			const { result, calls } = probeArguments(mode, owner)
			assert.equal(result.status, 0, result.stderr)
			assert.equal(result.stdout.includes('PRIVATE_STDIN_SENTINEL'), false)
			for (const [actualMode, args] of Object.entries(calls)) {
				const values = flag =>
					args.flatMap((value, index) =>
						value === flag ? [args[index + 1]] : []
					)
				assert.deepEqual(values('--cap-drop'), ['ALL'])
				assert.deepEqual(values('--cap-add'), [])
				assert.deepEqual(values('--security-opt'), ['no-new-privileges'])
				assert.ok(args.includes('--read-only') && args.includes('--rm'))
				assert.deepEqual(values('--log-driver'), ['none'])
				assert.deepEqual(values('--network'), [
					actualMode === 'upgrade-database' ? 'host' : 'none'
				])
				assert.deepEqual(values('--user'), [
					['upgrade-source', 'upgrade-database'].includes(actualMode)
						? owner === 'notification-delivery'
							? '1000:1000'
							: '1001:1001'
						: '0:0'
				])
				assert.ok(values('--volume').every(value => value.endsWith(':ro')))
				assert.ok(
					!args.some(value =>
						/PRIVATE_STDIN|migration-test-secret|DAC_|privileged/.test(value)
					)
				)
				assert.deepEqual(args.slice(-4), [
					'/run/crm-release.mjs',
					actualMode,
					owner,
					actualMode === 'upgrade-database-input' ? '' : 'complete'
				])
				if (['upgrade-source', 'upgrade-database'].includes(actualMode))
					assert.deepEqual(values('--volume'), [
						'/synthetic public payload/verifier.mjs:/run/crm-release.mjs:ro'
					])
				else if (actualMode === 'upgrade-database-input') {
					assert.equal(args[args.indexOf('--entrypoint') + 2], image(1))
					assert.deepEqual(values('--volume'), [
						'/synthetic public payload/verifier.mjs:/run/crm-release.mjs:ro',
						'/private workdir/live.json:/run/crm/live.json:ro',
						owner.startsWith('crm-')
							? '/private CRM/.env.production:/run/crm/crm.env:ro'
							: `/synthetic services/apps/${owner}/.env.production:/run/crm/${owner}.env:ro`
					])
				} else if (actualMode === 'upgrade-contract')
					assert.deepEqual(values('--volume'), [
						'/synthetic public payload/verifier.mjs:/run/crm-release.mjs:ro',
						'/private canonical/.env.production:/run/crm/canonical.env:ro'
					])
				else
					assert.ok(
						values('--volume').includes('/private workdir:/run/crm:ro')
					)
			}
			assert.equal(
				Object.keys(calls).length,
				mode === 'upgrade-database' ? 2 : 1
			)
		}
	}
	for (const scenario of ['failed', 'oversize', 'empty']) {
		const failed = probeArguments('upgrade-database', 'identity', scenario)
		assert.notEqual(failed.result.status, 0)
		assert.equal(failed.result.stdout, '')
		assert.deepEqual(Object.keys(failed.calls), ['upgrade-database-input'])
	}
})

test('real enabled upgrade probe binds only the nonsecret marker and read-only overlay validator', () => {
	const { result, calls } = probeArguments('upgrade-prepare', 'crm-sales', 'success', 'task-reminders-v1')
	assert.equal(result.status, 0, result.stderr)
	const args = calls['upgrade-prepare']
	assert.ok(args.includes('CRM_REMINDERS_RABBITMQ_CONTRACT=task-reminders-v1'))
	assert.ok(args.includes('/synthetic release/.github/scripts/validate-crm-reminders-compose.mjs:/run/crm-reminders-compose-validator.mjs:ro'))
	assert.equal(args.some(value => value.includes('/private canonical/')), false)
	assert.equal(args[args.indexOf('--network') + 1], 'none')
	assert.equal(args[args.indexOf('--log-driver') + 1], 'none')
	assert.equal(args.includes('--cap-add'), false)
})

test('upgrade ledgers distinguish pending, complete and the single retained Billing rolled-back attempt', () => {
	const name = '20260101000000_initial'
	const row = {
		id: 'initial',
		migration_name: name,
		checksum: hash,
		finished_at: '2026-01-01',
		rolled_back_at: null
	}
	const files = { [name]: hash, ...CRM_UPGRADE_MIGRATIONS['crm-sales'] }
	assert.deepEqual(
		crmUpgradeLedger('crm-sales', files, [row]),
		Object.keys(CRM_UPGRADE_MIGRATIONS['crm-sales']).sort()
	)
	assert.throws(() => crmUpgradeLedger('crm-sales', files, [row], true))
	assert.throws(() =>
		crmUpgradeLedger('crm-sales', files, [{ ...row, finished_at: null }])
	)
	assert.throws(() => crmUpgradeLedger('crm-sales', files, [row, row]))
	const acl = '20260909110000_restrict_wincrm_commerce_runtime_acl'
	const old = {
		id: '412a6ec9-35c7-4c1a-ad94-b11dbae1e889',
		migration_name: acl,
		checksum: CRM_UPGRADE_MIGRATIONS.billing[acl],
		finished_at: null,
		rolled_back_at: '2026-09-07'
	}
	const success = {
		...old,
		id: 'success',
		finished_at: '2026-09-07',
		rolled_back_at: null
	}
	assert.deepEqual(
		crmUpgradeLedger('billing', { [acl]: old.checksum }, [old, success], true),
		[]
	)
	assert.throws(() =>
		crmUpgradeLedger('billing', { [acl]: old.checksum }, [old])
	)
	assert.throws(() =>
		crmUpgradeLedger('billing', { [acl]: old.checksum }, [
			{ ...old, id: 'unknown-attempt' },
			success
		])
	)
})

function companionMembershipFixture(owner) {
	const prefix = `winwidget_${owner}`
	return {
		admin: {
			rolname: `${prefix}_admin`,
			rolcanlogin: true,
			rolsuper: true,
			databaseOwner: `${prefix}_admin`
		},
		memberships: ['migration', 'runtime'].map(role => ({
			role: `${prefix}_${role}`,
			member: `${prefix}_admin`,
			grantor: `${prefix}_admin`,
			admin_option: false,
			inherit_option: true,
			set_option: true
		}))
	}
}

test('companion membership proof permits only two own-admin edges in canonical order', () => {
	for (const owner of ['identity', 'billing']) {
		const { admin, memberships } = companionMembershipFixture(owner)
		const reversed = [...memberships].reverse()
		const result = crmUpgradeDatabaseMemberships(owner, reversed, admin)
		assert.deepEqual(result, memberships)
		assert.deepEqual(reversed, [...memberships].reverse())
		assert.notEqual(result, memberships)
		assert.notEqual(result[0], memberships[0])
	}
})

test('companion membership proof rejects every missing, extra, reversed or changed edge', () => {
	for (const owner of ['identity', 'billing']) {
		const fixture = companionMembershipFixture(owner)
		for (const mutate of [
			value => {
				value.memberships = []
			},
			value => {
				value.memberships.pop()
			},
			value => {
				value.memberships.push({ ...value.memberships[0] })
			},
			value => {
				value.memberships[1] = { ...value.memberships[0] }
			},
			value => {
				value.memberships[0].role = `winwidget_${owner}_backup`
			},
			value => {
				value.memberships[0].role = 'pg_maintain'
			},
			value => {
				value.memberships[0].role = 'winwidget_foreign_migration'
			},
			value => {
				value.memberships[0].member = 'winwidget_foreign_admin'
			},
			value => {
				value.memberships[0].member = `winwidget_${owner}_runtime`
			},
			value => {
				value.memberships[0].grantor = 'winwidget_foreign_admin'
			},
			value => {
				value.memberships[0].admin_option = true
			},
			value => {
				value.memberships[0].inherit_option = false
			},
			value => {
				value.memberships[0].set_option = false
			},
			value => {
				value.memberships[0].admin_option = 'false'
			},
			value => {
				delete value.memberships[0].grantor
			},
			value => {
				value.memberships[0].unexpected = true
			},
			value => {
				const row = value.memberships[0]
				const role = row.role
				row.role = row.member
				row.member = role
			}
		]) {
			const altered = structuredClone(fixture)
			mutate(altered)
			assert.throws(() =>
				crmUpgradeDatabaseMemberships(
					owner,
					altered.memberships,
					altered.admin
				)
			)
		}
		for (const malformed of [
			null,
			{},
			[null],
			[1],
			['migration'],
			[[...fixture.memberships]]
		])
			assert.throws(() =>
				crmUpgradeDatabaseMemberships(owner, malformed, fixture.admin)
			)
	}
})

test('companion membership proof requires its exact login superuser to own the database', () => {
	for (const owner of ['identity', 'billing']) {
		const { memberships, admin } = companionMembershipFixture(owner)
		for (const invalid of [
			null,
			undefined,
			{},
			[],
			{ ...admin, rolname: 'winwidget_foreign_admin' },
			{ ...admin, rolname: `winwidget_${owner}_migration` },
			{ ...admin, rolcanlogin: false },
			{ ...admin, rolsuper: false },
			{ ...admin, rolsuper: 'true' },
			{ ...admin, databaseOwner: `winwidget_${owner}_migration` },
			{ ...admin, databaseOwner: 'winwidget_foreign_admin' },
			{ ...admin, unexpected: true }
		])
			assert.throws(() =>
				crmUpgradeDatabaseMemberships(owner, memberships, invalid)
			)
	}
})

test('four CRM databases still forbid memberships in either direction without companion exceptions', () => {
	for (const owner of owners) {
		assert.deepEqual(crmUpgradeDatabaseMemberships(owner, []), [])
		const prefix = `winwidget_${owner.replaceAll('-', '_')}`
		const row = {
			role: `${prefix}_migration`,
			member: `${prefix}_admin`,
			grantor: `${prefix}_admin`,
			admin_option: false,
			inherit_option: true,
			set_option: true
		}
		assert.throws(() => crmUpgradeDatabaseMemberships(owner, [row]))
		assert.throws(() =>
			crmUpgradeDatabaseMemberships(owner, [
				{ ...row, role: row.member, member: row.role }
			])
		)
		assert.throws(() =>
			crmUpgradeDatabaseMemberships(
				owner,
				[],
				companionMembershipFixture('identity').admin
			)
		)
	}
	for (const owner of ['operations', 'crm', '', 'identity; SELECT 1'])
		assert.throws(() => crmUpgradeDatabaseMemberships(owner, []))
})

test('upgrade database proof preserves UUID, roles, memberships and existing ACL while allowing new owned objects', () => {
	const before = {
		databaseId: 'owned-db',
		pending: ['new'],
		roles: [
			{ rolname: 'winwidget_crm_access_runtime', rolinherit: false }
		],
		memberships: [],
		acl: [{ kind: 'relation', name: 'legacy', acl: 'unchanged' }]
	}
	const after = {
		...before,
		pending: [],
		acl: [
			...before.acl,
			{ kind: 'relation', name: 'new', acl: 'restricted' }
		]
	}
	assert.equal(crmUpgradeDatabasePreserved(before, after), true)
	assert.throws(() =>
		crmUpgradeDatabasePreserved(before, {
			...after,
			databaseId: 'other-db'
		})
	)
	assert.throws(() =>
		crmUpgradeDatabasePreserved(before, { ...after, acl: [] })
	)
	assert.throws(() =>
		crmUpgradeDatabasePreserved(before, { ...after, pending: ['new'] })
	)
	assert.throws(() =>
		crmUpgradeDatabasePreserved(before, { ...after, roles: [] })
	)
	assert.throws(() =>
		crmUpgradeDatabasePreserved(before, {
			...after,
			memberships: companionMembershipFixture('identity').memberships
		})
	)
	for (const field of ['roles', 'memberships']) {
		const legacy = { ...before }
		delete legacy[field]
		assert.throws(() => crmUpgradeDatabasePreserved(legacy, legacy))
		assert.throws(() =>
			crmUpgradeDatabasePreserved(before, { ...after, [field]: undefined })
		)
	}
	for (const owner of ['identity', 'billing']) {
		const memberships = companionMembershipFixture(owner).memberships
		const companionBefore = { ...before, memberships }
		const companionAfter = {
			...after,
			memberships: structuredClone(memberships)
		}
		assert.equal(
			crmUpgradeDatabasePreserved(companionBefore, companionAfter),
			true
		)
		for (const mutate of [
			rows => {
				rows.pop()
			},
			rows => {
				rows[0].set_option = false
			},
			rows => {
				rows[0].grantor = 'winwidget_foreign_admin'
			}
		]) {
			const altered = structuredClone(companionAfter)
			mutate(altered.memberships)
			assert.throws(() =>
				crmUpgradeDatabasePreserved(companionBefore, altered)
			)
			assert.throws(() =>
				crmUpgradeDatabasePreserved(companionBefore, altered, false)
			)
		}
	}
})

function upgradeDesiredFixture(contract = 'disabled') {
	const { live } = upgradeFixture(contract)
	const crm = { name: 'winwidget-crm', services: {} }
	const companions = { name: 'winwidget', services: {} }
	const images = CRM_UPGRADE_GROUPS.map(([owner], index) => ({
		Id: image(500 + index),
		Os: 'linux',
		Architecture: process.arch === 'x64' ? 'amd64' : process.arch,
		Config: {
			Labels: {
				...(owner === 'notification-delivery'
					? {}
					: { 'org.opencontainers.image.title': `winwidget-${owner}` }),
				'org.opencontainers.image.revision': revision
			},
			Env: ['PATH=/usr/bin'],
			Cmd: ['node', 'dist/main.js'],
			Entrypoint: ['docker-entrypoint.sh'],
			User: owner === 'notification-delivery' ? 'node' : '1001:1001',
			WorkingDir: '/app'
		}
	}))
	for (const [index, [owner, ...names]] of crmUpgradeGroups(
		contract
	).entries()) {
		const config = owner.startsWith('crm-') ? crm : companions
		const candidate = images[index]
		for (const name of names) {
			const stopSeconds =
				owner === 'identity' || name === 'billing-api'
					? 30
					: owner === 'billing'
						? 90
						: 45
			const service = {
				image: candidate.Id,
				user: candidate.Config.User,
				labels: { 'com.winwidget.owner': owner },
				environment: {
					APP_REVISION: revision,
					SYNTHETIC_SECRET: 'fixture-only',
					...(contract === 'disabled' ? {} : reminderEnvironment(name))
				},
				network_mode: 'host',
				read_only: true,
				init: true,
				cap_drop: ['ALL'],
				restart: 'unless-stopped',
				stop_grace_period:
					stopSeconds === 90 ? '1m30s' : `${stopSeconds}s`,
				mem_limit: 384 * 1048576,
				memswap_limit: 384 * 1048576,
				cpus: 1,
				pids_limit: 128,
				security_opt: ['no-new-privileges:true'],
				logging: {
					driver: 'json-file',
					options: { 'max-size': '10m', 'max-file': '3' }
				},
				tmpfs: ['/tmp:rw,nosuid,nodev,noexec,size=64m'],
				healthcheck: {
					test: ['CMD', 'node', 'healthcheck.js'],
					interval: '10s',
					timeout: '5s',
					start_period: '30s',
					retries: 3
				}
			}
			if (owner === 'identity')
				service.extra_hosts = ['tg.winwidget.ru=127.0.0.1']
			config.services[name] = service
			const current = live.find(
				row => row.Config.Labels['com.docker.compose.service'] === name
			)
			current.Mounts = []
			Object.assign(current.Config, {
				User: service.user,
				Cmd: candidate.Config.Cmd,
				Entrypoint: candidate.Config.Entrypoint,
				WorkingDir: '/app',
				StopTimeout: stopSeconds,
				Env: [
					'PATH=/usr/bin',
					...Object.entries({
						...service.environment,
						APP_REVISION: previous
					}).map(([key, value]) => `${key}=${value}`)
				],
				Healthcheck: {
					Test: service.healthcheck.test,
					Interval: 10e9,
					Timeout: 5e9,
					StartPeriod: 30e9,
					Retries: 3
				}
			})
			Object.assign(current.Config.Labels, service.labels, {
				'com.docker.compose.oneoff': 'False',
				'com.docker.compose.container-number': '1'
			})
			current.HostConfig = {
				NetworkMode: 'host',
				ExtraHosts:
					owner === 'identity' ? ['tg.winwidget.ru:127.0.0.1'] : [],
				Privileged: false,
				ReadonlyRootfs: true,
				Init: true,
				Memory: service.mem_limit,
				MemorySwap: service.memswap_limit,
				NanoCpus: 1e9,
				PidsLimit: 128,
				CapDrop: ['ALL'],
				SecurityOpt: service.security_opt,
				PidMode: '',
				IpcMode: 'private',
				RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
				LogConfig: { Type: 'json-file', Config: service.logging.options },
				Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=64m' }
			}
		}
		if (owner !== 'identity') {
			const schema = owner.replaceAll('-', '_')
			config.services[`${owner}-migrate`] = {
				network_mode: 'host',
				restart: 'no',
				entrypoint: ['./node_modules/.bin/prisma'],
				command: ['migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
				environment: {
					APP_REVISION: revision,
					NODE_ENV: 'production',
					...(owner.startsWith('crm-') ? { MODE: 'production' } : {}),
					[`${schema.toUpperCase()}_DATABASE_URL`]: `postgresql://winwidget_${schema}_migration:synthetic@127.0.0.1:55442/winwidget_${schema}?schema=${schema}`
				}
			}
		}
	}
	const baseline = crmUpgradeBaseline(
		live,
		previous,
		{
			billing: hash,
			canonical: hash,
			crm: hash,
			identity: hash,
			'notification-delivery': hash
		},
		contract
	)
	const reminderBase =
		contract === 'disabled'
			? undefined
			: {
					crm: structuredClone(crm),
					notification: structuredClone(companions),
					notificationAfter: structuredClone(companions)
				}
	if (reminderBase) {
		delete reminderBase.crm.services['crm-sales-reminders']
		delete reminderBase.crm.services['crm-sales-api'].environment
			.CRM_TASK_REMINDERS_ENABLED
		reminderBase.notification.services[
			'notification-delivery-worker'
		].environment.NOTIFICATION_DELIVERY_KINDS = reminderKinds
			.split(',')
			.slice(0, 12)
			.join(',')
	}
	return {
		live,
		baseline,
		crm,
		companions,
		images,
		servicesRevision: revision,
		...(reminderBase ? { reminderBase } : {})
	}
}

test('upgrade enabled reminder desired preserves both owner overlays, exact credentials/config and legacy disabled output', () => {
	const disabled = upgradeDesiredFixture()
	assert.equal(
		Object.hasOwn(disabled.baseline, 'remindersContract'),
		false
	)
	assert.deepEqual(
		crmUpgradeBaseline(
			disabled.live,
			previous,
			disabled.baseline.environmentHashes,
			'disabled'
		),
		disabled.baseline
	)
	const input = upgradeDesiredFixture('task-reminders-v1')
	let baseCalls = 0,
		overlayCalls = 0
	const validateBase = value => {
		assert.deepEqual(value, input.reminderBase.crm)
		baseCalls++
	}
	const validateOverlay = value => {
		assert.deepEqual(value, {
			crmBefore: input.reminderBase.crm,
			crmAfter: input.crm,
			notificationBefore: input.reminderBase.notification,
			notificationAfter: input.reminderBase.notificationAfter
		})
		overlayCalls++
	}
	const { desired, replacements } = crmUpgradeDesired(
		input,
		validateBase,
		validateOverlay
	)
	assert.equal(baseCalls, 1)
	assert.equal(overlayCalls, 1)
	assert.equal(Object.keys(replacements).length, 19)
	assert.equal(
		desired.crm.services['crm-sales-reminders'].image,
		desired.crm.services['crm-sales-api'].image
	)
	assert.equal(
		desired.crm.services['crm-sales-api'].environment
			.CRM_TASK_REMINDERS_ENABLED,
		'true'
	)
	assert.equal(
		desired.companions.services['notification-delivery-worker'].environment
			.NOTIFICATION_DELIVERY_KINDS,
		reminderKinds
	)
	assert.throws(() => crmUpgradeDesired(input, () => {}))
	assert.throws(() =>
		crmUpgradeDesired(
			input,
			() => {},
			() => {
				throw Error('invalid overlay')
			}
		)
	)
	for (const mutate of [
		value => {
			delete value.reminderBase
		},
		value => {
			delete value.baseline.remindersContract
		},
		value => {
			delete value.crm.services['crm-sales-reminders']
		},
		value => {
			value.crm.services[
				'crm-sales-api'
			].environment.CRM_TASK_REMINDERS_ENABLED = 'false'
		},
		value => {
			value.crm.services['crm-sales-reminders'].environment.RABBITMQ_URL =
				'amqp://foreign:synthetic@127.0.0.1:5672/winwidget'
		},
		value => {
			value.crm.services[
				'crm-sales-reminders'
			].environment.CRM_SALES_DATABASE_URL =
				'postgresql://wrong:synthetic@127.0.0.1/foreign'
		},
		value => {
			value.crm.services[
				'crm-sales-reminders'
			].environment.CRM_SALES_NOTIFICATION_DELIVERY_TOKEN =
				'different-synthetic'
		},
		value => {
			value.crm.services['crm-sales-reminders'].mem_limit = 1
		},
		value => {
			value.crm.services['crm-sales-reminders'].cap_add = ['ALL']
			value.live.find(
				item =>
					item.Config.Labels['com.docker.compose.service'] ===
					'crm-sales-reminders'
			).HostConfig.CapAdd = ['ALL']
		},
		value => {
			value.companions.services[
				'notification-delivery-worker'
			].environment.NOTIFICATION_DELIVERY_KINDS = reminderKinds
				.split(',')
				.slice(0, 12)
				.join(',')
		}
	]) {
		const changed = structuredClone(input)
		mutate(changed)
		assert.throws(() =>
			crmUpgradeDesired(
				changed,
				() => {},
				() => {}
			)
		)
	}
})

test('upgrade enabled reminder group allows only a completed prefix and an explicit two-process Sales switch', () => {
	const { live, baseline } = upgradeFixture('task-reminders-v1')
	const groups = crmUpgradeGroups(baseline.remindersContract)
	const replacements = {}
	const replace = name => {
		const current = live.find(
			item => item.Config.Labels['com.docker.compose.service'] === name
		)
		const key = `${current.Config.Labels['com.docker.compose.project']}/${name}`
		current.Id = id(600 + Object.keys(replacements).length)
		current.Image = image(600 + Object.keys(replacements).length)
		current.Config.Env = current.Config.Env.map(value =>
			value.startsWith('APP_REVISION=')
				? `APP_REVISION=${revision}`
				: value
		)
		current.Config.Labels['org.opencontainers.image.revision'] = revision
		replacements[key] = { image: current.Image, revision }
	}
	for (const [owner, ...names] of groups) {
		if (owner === 'crm-sales') break
		for (const name of names) replace(name)
	}
	const api = live.find(
		item =>
			item.Config.Labels['com.docker.compose.service'] === 'crm-sales-api'
	)
	api.State.Running = false
	replace('crm-sales-reminders')
	assert.throws(() => crmUpgradeFence(live, baseline, replacements))
	assert.equal(
		crmUpgradeFence(live, baseline, replacements, 'crm-sales'),
		true
	)
	assert.throws(() =>
		crmUpgradeFence(live, baseline, replacements, 'crm-intake')
	)
	replace('crm-sales-api')
	api.State.Running = true
	assert.equal(crmUpgradeFence(live, baseline, replacements), true)
})

test('upgrade desired contract selects only approved groups and isolated migration jobs without changing product env', () => {
	const input = upgradeDesiredFixture()
	const { desired, replacements } = crmUpgradeDesired(input, () => {})
	assert.equal(Object.keys(replacements).length, 18)
	assert.equal(Object.keys(desired.crm.services).length, 16)
	assert.equal(Object.keys(desired.companions.services).length, 8)
	assert.equal(
		desired.companions.services['notification-delivery-migrate'].user,
		'1000:1000'
	)
	assert.ok(
		CRM_UPGRADE_GROUPS.findIndex(
			([owner]) => owner === 'notification-delivery'
		) < CRM_UPGRADE_GROUPS.findIndex(([owner]) => owner === 'crm-sales')
	)
	for (const change of [
		value => value.images.reverse(),
		value =>
			(value.images.find(
				image => image.Config.User === 'node'
			).Config.User = 'root'),
		value =>
			(value.images.find(
				image => image.Config.User === 'node'
			).Config.Labels['org.opencontainers.image.title'] =
				'winwidget-foreign')
	]) {
		const changed = structuredClone(input)
		change(changed)
		assert.throws(() => crmUpgradeDesired(changed, () => {}))
	}
	assert.equal(
		Object.hasOwn(desired.companions.services, 'identity-migrate'),
		false
	)
	for (const config of Object.values(desired))
		for (const [name, service] of Object.entries(config.services)) {
			assert.equal(Object.hasOwn(service, 'build'), false)
			assert.equal(Object.hasOwn(service, 'depends_on'), false)
			if (name.endsWith('-migrate')) {
				assert.equal(service.read_only, true)
				assert.equal(service.logging.driver, 'none')
				assert.deepEqual(service.cap_drop, ['ALL'])
			}
		}
	for (const mutate of [
		x => x.images.push(x.images[0]),
		x => {
			x.images[0].Config.Labels['org.opencontainers.image.revision'] = previous
		},
		x => {
			x.companions.services[
				'billing-api'
			].environment.BILLING_WINCRM_PAYMENTS_ENABLED = 'true'
		},
		x => {
			x.companions.services['identity-api'].privileged = true
		},
		x => {
			x.companions.services['billing-migrate'].environment.EXTRA_SECRET =
				'wrong'
		},
		x => {
			x.crm.services['crm-sales-migrate'].command = [
				'migrate',
				'reset',
				'--force'
			]
		},
		x => {
			x.crm.services['crm-access-worker'].mem_limit = 1
		},
		x => {
			x.companions.services['identity-api'].command = ['node', 'worker.js']
		}
	]) {
		const changed = structuredClone(input)
		mutate(changed)
		assert.throws(() => crmUpgradeDesired(changed, () => {}))
	}
	assert.throws(() =>
		crmUpgradeDesired(input, () => {
			throw new Error('invalid owner shape')
		})
	)
})

test('upgrade desired preserves exact Identity proxy hosts across Compose representations', () => {
	const input = upgradeDesiredFixture()
	const current = input.live.find(
		row => row.Config.Labels['com.docker.compose.service'] === 'identity-api'
	)
	current.HostConfig.ExtraHosts.push('ipv6.example.test:::1')
	input.baseline = crmUpgradeBaseline(
		input.live,
		previous,
		input.baseline.environmentHashes
	)
	for (const hosts of [
		['tg.winwidget.ru=127.0.0.1', 'ipv6.example.test=::1'],
		['ipv6.example.test:::1', 'tg.winwidget.ru:127.0.0.1'],
		{ 'ipv6.example.test': '::1', 'tg.winwidget.ru': '127.0.0.1' }
	]) {
		const candidate = structuredClone(input)
		candidate.companions.services['identity-api'].extra_hosts = hosts
		const { desired } = crmUpgradeDesired(candidate, () => {})
		assert.deepEqual(
			desired.companions.services['identity-api'].extra_hosts,
			hosts
		)
	}
})

test('upgrade desired rejects host, address, addition, removal and malformed proxy drift', () => {
	const input = upgradeDesiredFixture()
	for (const hosts of [
		['other.example.test=127.0.0.1'],
		['tg.winwidget.ru=127.0.0.2'],
		['tg.winwidget.ru=127.0.0.1', 'other.example.test=127.0.0.1'],
		['tg.winwidget.ru=127.0.0.1', 'tg.winwidget.ru=127.0.0.1'],
		[],
		{},
		undefined,
		null,
		'',
		false,
		['tg.winwidget.ru'],
		['tg.winwidget.ru='],
		['tg.winwidget.ru=127.0.0.1 extra'],
		{ 'tg.winwidget.ru': 127 },
		{ 'invalid host': '127.0.0.1' }
	]) {
		const candidate = structuredClone(input)
		candidate.companions.services['identity-api'].extra_hosts = hosts
		assert.throws(() => crmUpgradeDesired(candidate, () => {}))
	}
	// An unchanged candidate also cannot hide live drift behind normalization.
	const changedLive = structuredClone(input)
	changedLive.live.find(
		row => row.Config.Labels['com.docker.compose.service'] === 'identity-api'
	).HostConfig.ExtraHosts = ['tg.winwidget.ru:127.0.0.2']
	assert.throws(() => crmUpgradeDesired(changedLive, () => {}))
})

test('upgrade desired compares compound companion durations as exact nanoseconds', () => {
	for (const name of ['identity-api', ...CRM_UPGRADE_GROUPS[1].slice(1)]) {
		const input = upgradeDesiredFixture()
		const current = input.live.find(
			row => row.Config.Labels['com.docker.compose.service'] === name
		)
		current.Config.StopTimeout = 90
		input.baseline = crmUpgradeBaseline(
			input.live,
			previous,
			input.baseline.environmentHashes
		)
		for (const value of [
			'90s',
			'1m30s',
			'0h1m30s',
			'90000ms',
			'1.5m',
			'1m29.999999999s1ns'
		]) {
			const candidate = structuredClone(input)
			candidate.companions.services[name].stop_grace_period = value
			assert.doesNotThrow(() => crmUpgradeDesired(candidate, () => {}))
		}
	}
	for (const [field, actual] of [
		['interval', 'Interval'],
		['timeout', 'Timeout'],
		['start_period', 'StartPeriod']
	]) {
		for (const [value, expected] of [
			['1m30s', 90e9],
			['9s1000ms', 10e9],
			['1h2m3.004005006s', 3723004005006],
			['1µs', 1000],
			['1μs', 1000],
			['1us', 1000],
			['0s', 0]
		]) {
			const input = upgradeDesiredFixture()
			input.companions.services['billing-worker'].healthcheck[field] = value
			input.live.find(
				row =>
					row.Config.Labels['com.docker.compose.service'] === 'billing-worker'
			).Config.Healthcheck[actual] = expected
			input.baseline = crmUpgradeBaseline(
				input.live,
				previous,
				input.baseline.environmentHashes
			)
			assert.doesNotThrow(() => crmUpgradeDesired(input, () => {}))
		}
	}
})

test('upgrade desired rejects changed or invalid durations instead of rounding or ignoring suffixes', () => {
	for (const value of [
		'89s',
		'91s',
		'1m29s',
		'1m31s',
		'1m29.999999999s',
		'1m30.000000001s',
		'',
		'1m30',
		' 90s',
		'90s ',
		'90s extra',
		'+90s',
		'-90s',
		'1d',
		'Infinitys',
		'0.0000000001s',
		'9007199254740992ns',
		`${'1'.repeat(129)}s`,
		'1..5m',
		90,
		false
	]) {
		const input = upgradeDesiredFixture()
		input.companions.services['billing-worker'].stop_grace_period = value
		assert.throws(() => crmUpgradeDesired(input, () => {}))
	}
	for (const field of ['interval', 'timeout', 'start_period']) {
		const input = upgradeDesiredFixture()
		input.companions.services['identity-api'].healthcheck[field] = '1ns'
		assert.throws(() => crmUpgradeDesired(input, () => {}))
	}
})

// Execute the real coordinator with isolated command/verification doubles.
// No Docker daemon, production path, credentials or network are used here.
function runUpgradeController(
	scenario = 'success',
	replay = false,
	contract = 'disabled'
) {
	const directory = mkdtempSync(join(tmpdir(), 'wincrm-upgrade-contract-'))
	try {
		for (const path of [
			'deploy/backend/crm',
			'services/apps/billing',
			'services/apps/identity',
			'services/apps/notification-delivery',
			'release',
			'payload'
		])
			mkdirSync(join(directory, path), { recursive: true, mode: 0o700 })
		for (const path of [
			'deploy/backend/.env.production',
			'deploy/backend/crm/.env.production',
			'deploy/backend/crm/upgrade-baseline.json',
			'services/apps/billing/.env.production',
			'services/apps/identity/.env.production',
			'services/apps/notification-delivery/.env.production'
		])
			writeFileSync(join(directory, path), '{}\n', { mode: 0o600 })
		const script = `
set -euo pipefail
source "$TEST_LIBRARY"
app_root="$TEST_DIRECTORY"
services_repository="$app_root/services"
release_root="$app_root/release"
env_file="$app_root/deploy/backend/.env.production"
scoped_payload_directory="$app_root/payload"
services_revision="$TEST_REVISION"
infra_revision="$TEST_REVISION"
expected_live_revision="$TEST_PREVIOUS"
expected_env_sha256="$TEST_HASH"
expected_service_env_sha256="$TEST_HASH"
expected_crm_upgrade_baseline_sha256="$TEST_HASH"
release_scope=crm-upgrade
die() { printf '%s\\n' "$1" >&2; exit 1; }
assert_root_owned_directory() { [[ -d "$1" && ! -L "$1" ]] || die 'unsafe directory'; }
assert_root_owned_file() { [[ -f "$1" && ! -L "$1" ]] || die 'unsafe file'; }
stat() { if [[ -d "\${@: -1}" ]]; then printf '700\\n'; else printf '600\\n'; fi; }
sha256sum() { printf '%s\\n' "$TEST_HASH"; }
crm_assert_inputs() { [[ "$TEST_SCENARIO" != env-drift ]] || die 'env changed'; }
crm_runtime_memory_check() { [[ "$TEST_SCENARIO" != low-memory ]] || die 'low memory'; }
awk() { if [[ "$*" == *'/proc/meminfo'* ]]; then printf '17179869184'; else command awk "$@"; fi; }
crm_upgrade_inventory() { printf '[]\\n'; }
owner_names() {
  case "$1" in
    identity) printf 'identity-api' ;;
    billing) printf 'billing-worker billing-outbox-publisher billing-scheduler billing-api' ;;
    crm-access) printf 'crm-access-worker crm-access-outbox-publisher crm-access-api' ;;
    crm-customers) printf 'crm-customers-api' ;;
    notification-delivery) printf 'notification-delivery-worker' ;;
    crm-sales) if [[ "$TEST_CONTRACT" == task-reminders-v1 ]]; then printf 'crm-sales-reminders crm-sales-api'; else printf 'crm-sales-api'; fi ;;
    crm-intake) printf 'crm-intake-worker crm-intake-widget-control-worker crm-intake-widget-transfer-worker crm-intake-publisher crm-intake-widget-control-publisher crm-intake-widget-transfer-publisher crm-intake-api' ;;
  esac
}
crm_upgrade_probe() {
  local mode="$1" owner="\${2:-}" name
  printf 'PROBE %s %s %s\\n' "$mode" "$owner" "\${4:-}" >>"$TEST_TRACE"
  case "$mode" in
    upgrade-contract)
      [[ "$TEST_SCENARIO" != contract-read-failed ]] || return 9
      if [[ "$TEST_SCENARIO" == invalid-contract ]]; then printf 'unknown\\n'; else printf '%s\\n' "$TEST_CONTRACT"; fi ;;
    upgrade-baseline-check|upgrade-fence)
      while IFS= read -r line; do :; done
      [[ "$TEST_SCENARIO" != baseline-drift ]] || return 10
      printf 'true\\n' ;;
    upgrade-source-check) [[ "$TEST_SCENARIO" != identity-schema-drift || "$owner" != identity ]] || return 11 ;;
    upgrade-source|upgrade-prepare|upgrade-compose|upgrade-database) printf '{}\\n' ;;
    upgrade-old-images)
      printf '%s\\n' "$TEST_IMAGE"
      if [[ "$TEST_SCENARIO" == mixed-old-images && "$owner" == billing ]]; then printf '%s\\n' "$TEST_OLD_IMAGE"; fi ;;
    upgrade-env) printf 'APP_REVISION=%s\\n' "$TEST_REVISION" ;;
    upgrade-database-check)
      [[ "$TEST_SCENARIO" != uuid-drift || "$owner" != crm-access || ! -f "$TEST_DIRECTORY/migrated-crm-access" ]] || return 12 ;;
    upgrade-pending)
      if [[ "$owner" == billing || "$owner" == crm-access || "$owner" == crm-sales || "$owner" == notification-delivery ]] && [[ ! -f "$TEST_DIRECTORY/migrated-$owner" ]]; then printf '1\\n'; else printf '0\\n'; fi ;;
    upgrade-grants)
      [[ "$TEST_SCENARIO" != grants-failed || "$owner" != crm-access ]] || return 13
      printf 'PRIVATE_SQL_SENTINEL\\n' ;;
    upgrade-complete)
      while IFS= read -r line; do :; done
      if [[ "$owner" == all ]]; then
        for name in $TEST_TARGETS; do [[ -f "$TEST_DIRECTORY/new-$name" ]] || return 14; done
      else
        for name in $(owner_names "$owner"); do [[ -f "$TEST_DIRECTORY/new-$name" ]] || return 15; done
      fi ;;
    *) return 90 ;;
  esac
}
crm_upgrade_compose() {
  local unit="$1" operation="$2" last="\${@: -1}" arg
  printf 'COMPOSE %s\\n' "$*" >>"$TEST_TRACE"
  case "$operation" in
    run)
      [[ "$last" != identity-migrate && "$*" == *'--rm --no-deps --pull never'* ]] || return 16
      [[ "$TEST_SCENARIO" != migration-failed || "$last" != crm-sales-migrate ]] || return 17
      touch "$TEST_DIRECTORY/migrated-\${last%-migrate}" ;;
    stop)
      for arg in "$@"; do
        if [[ " $TEST_TARGETS " == *" $arg "* ]]; then touch "$TEST_DIRECTORY/stopped-$arg"; fi
      done ;;
    up)
      [[ "$*" == *'--no-deps --no-build --pull never --force-recreate'* && " $TEST_TARGETS " == *" $last "* ]] || return 18
      if [[ "$TEST_SCENARIO" == partial-start && "$last" == crm-access-api && ! -f "$TEST_DIRECTORY/failure-observed" ]]; then touch "$TEST_DIRECTORY/failure-observed"; return 19; fi
      if [[ "$TEST_SCENARIO" == partial-sales && "$last" == crm-sales-api && ! -f "$TEST_DIRECTORY/failure-observed" ]]; then touch "$TEST_DIRECTORY/failure-observed"; return 19; fi
      touch "$TEST_DIRECTORY/new-$last"
      rm -f -- "$TEST_DIRECTORY/stopped-$last" ;;
    *) return 91 ;;
  esac
}
docker() {
  local last="\${@: -1}" owner
  printf 'DOCKER %s\\n' "$*" >>"$TEST_TRACE"
  case "$1" in
    context) printf 'unix:///var/run/docker.sock\\n' ;;
    ps) printf '%s\\n' "$TEST_ID" ;;
    inspect)
      if [[ "$*" == *'.State.Running'* ]]; then printf 'false 0\\n'
      elif [[ "$*" == *'.State.Status'* ]]; then printf 'running healthy 0 false\\n'
      else printf '%s %s\\n' "$TEST_IMAGE" "$TEST_PREVIOUS"; fi ;;
    image)
      [[ "$2" == inspect ]] || return 92
      if [[ "$3" == --format ]]; then owner="\${last#winwidget-}"; owner="\${owner%%:*}"; if [[ "$owner" == notification-delivery ]]; then printf '%s %s node\\n' "$TEST_IMAGE" "$TEST_REVISION"; else printf '%s %s winwidget-%s\\n' "$TEST_IMAGE" "$TEST_REVISION" "$owner"; fi
      else printf '[]\\n'; fi ;;
    exec)
      [[ "$*" == *'psql -X -q -v ON_ERROR_STOP=1'* ]] || return 20
      while IFS= read -r line; do :; done ;;
    *) return 93 ;;
  esac
}
env() {
  [[ "$1" == -i && "$2" == PATH=* ]] || return 21
  shift 2
  while [[ "$1" != docker ]]; do [[ "$1" == *_IMAGE=* || "$1" == *_REVISION=* || "$1" == APP_VERSION=* ]] || return 22; shift; done
  [[ "$*" == *'compose '* && "$*" == *'config --format json'* ]] || return 23
  printf 'MATERIALIZE %s\\n' "$*" >>"$TEST_TRACE"
  printf '{}\\n'
}
scoped_deploy_main
`
		const execute = () =>
			spawnSync('/bin/bash', ['-c', script], {
				encoding: 'utf8',
				timeout: 15000,
				env: {
					PATH: process.env.PATH,
					TEST_DIRECTORY: directory,
					TEST_TRACE: join(directory, 'trace'),
					TEST_LIBRARY: join(root, 'deploy-crm-scoped.sh'),
					TEST_SCENARIO: scenario,
					TEST_CONTRACT: contract,
					TEST_REVISION: revision,
					TEST_PREVIOUS: previous,
					TEST_HASH: hash,
					TEST_IMAGE: image(900),
					TEST_OLD_IMAGE: image(901),
					TEST_ID: id(900),
					TEST_TARGETS: crmUpgradeGroups(contract)
						.flatMap(([, ...names]) => names)
						.join(' ')
				}
			})
		const first = execute()
		const firstCalls = existsSync(join(directory, 'trace'))
			? readFileSync(join(directory, 'trace'), 'utf8')
			: ''
		const second = replay ? execute() : null
		return {
			first,
			second,
			firstCalls,
			calls: existsSync(join(directory, 'trace'))
				? readFileSync(join(directory, 'trace'), 'utf8')
				: ''
		}
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

test('upgrade coordinator validates both old Billing image sources before its first mutation', () => {
	const result = runUpgradeController('mixed-old-images')
	assert.equal(result.first.status, 0, result.first.stderr)
	const beforeMutation = result.calls.slice(0, result.calls.indexOf('COMPOSE '))
	assert.equal(
		beforeMutation
			.split('\n')
			.filter(line => line.startsWith('PROBE upgrade-source-check billing '))
			.length,
		2
	)
})

test('upgrade coordinator switches exactly 18 targets in dependency groups and replay never restarts completed groups', () => {
	const result = runUpgradeController('success', true)
	assert.equal(result.first.status, 0, result.first.stderr)
	assert.equal(result.second.status, 0, result.second.stderr)
	const starts = result.calls
		.split('\n')
		.filter(line => line.startsWith('COMPOSE ') && line.includes(' up '))
	assert.deepEqual(
		starts.map(line => line.split(' ').at(-1)),
		CRM_UPGRADE_GROUPS.flatMap(([, ...names]) => names)
	)
	assert.equal(result.calls.includes('identity-migrate'), false)
	assert.equal(result.calls.includes('DOCKER build'), false)
	assert.equal(result.calls.includes('DOCKER volume'), false)
	assert.equal(result.calls.includes('DOCKER network'), false)
	assert.equal(result.first.stdout.includes('PRIVATE_SQL_SENTINEL'), false)
	const firstMutation = result.firstCalls.indexOf('COMPOSE companions stop')
	for (const [owner] of CRM_UPGRADE_GROUPS)
		assert.ok(
			result.firstCalls.indexOf(`PROBE upgrade-database ${owner}`) <
				firstMutation
		)
	for (const [owner, ...names] of CRM_UPGRADE_GROUPS) {
		const stop = result.firstCalls.indexOf(
			`stop --timeout 90 ${names.join(' ')}`
		)
		const start = result.firstCalls.indexOf(`--force-recreate ${names[0]}`)
		assert.ok(stop >= 0 && stop < start)
		if (owner.startsWith('crm-'))
			assert.ok(
				result.firstCalls.indexOf(`PROBE upgrade-grants ${owner}`) < stop
			)
	}
})

test('upgrade coordinator fails closed before unsafe mutation and retains exact partial release for retry', () => {
	for (const scenario of [
		'env-drift',
		'baseline-drift',
		'identity-schema-drift',
		'low-memory',
		'invalid-contract',
		'contract-read-failed'
	]) {
		const result = runUpgradeController(scenario)
		assert.notEqual(result.first.status, 0, scenario)
		assert.equal(result.calls.includes('COMPOSE '), false, scenario)
	}
	for (const scenario of ['migration-failed', 'grants-failed', 'uuid-drift']) {
		const result = runUpgradeController(scenario)
		assert.notEqual(result.first.status, 0, scenario)
		assert.equal(
			result.calls.includes('--force-recreate crm-intake-api'),
			false,
			scenario
		)
	}
	const result = runUpgradeController('partial-start', true)
	assert.notEqual(result.first.status, 0)
	assert.equal(result.second.status, 0, result.second.stderr)
	const secondCalls = result.calls.slice(result.firstCalls.length)
	assert.equal(secondCalls.includes('--force-recreate identity-api'), false)
	assert.equal(secondCalls.includes('--force-recreate billing-api'), false)
	assert.equal(secondCalls.includes('--force-recreate crm-access-api'), true)
	assert.equal(secondCalls.includes('--force-recreate crm-intake-api'), true)
})

test('upgrade enabled coordinator materializes both overlays and switches Sales together without starting neighbors', () => {
	const result = runUpgradeController('success', true, 'task-reminders-v1')
	assert.equal(result.first.status, 0, result.first.stderr)
	assert.equal(result.second.status, 0, result.second.stderr)
	const starts = result.calls
		.split('\n')
		.filter(line => line.startsWith('COMPOSE ') && line.includes(' up '))
	assert.deepEqual(
		starts.map(line => line.split(' ').at(-1)),
		crmUpgradeGroups('task-reminders-v1').flatMap(([, ...names]) => names)
	)
	const materialized = result.calls
		.split('\n')
		.filter(line => line.startsWith('MATERIALIZE '))
	assert.equal(
		materialized.filter(line =>
			line.includes('docker-compose.crm-reminders.yml')
		).length,
		1
	)
	assert.equal(
		materialized.filter(line =>
			line.includes('docker-compose.notification-reminders.yml')
		).length,
		1
	)
	const stopped = result.calls.indexOf(
		'COMPOSE crm stop --timeout 90 crm-sales-reminders crm-sales-api'
	)
	const workerStarted = result.calls.indexOf(
		'--force-recreate crm-sales-reminders'
	)
	const apiStarted = result.calls.indexOf('--force-recreate crm-sales-api')
	assert.ok(
		stopped > 0 && stopped < workerStarted && workerStarted < apiStarted
	)
	assert.ok(
		result.calls.indexOf('--force-recreate notification-delivery-worker') <
			stopped
	)
	assert.equal(result.calls.includes('broker'), false)
	const disabled = runUpgradeController()
	assert.equal(disabled.first.status, 0, disabled.first.stderr)
	assert.equal(
		disabled.calls.includes('docker-compose.crm-reminders.yml'),
		false
	)
	assert.equal(
		disabled.calls.includes('docker-compose.notification-reminders.yml'),
		false
	)
	assert.equal(
		disabled.calls.includes('--force-recreate crm-sales-reminders'),
		false
	)
	const retry = runUpgradeController(
		'partial-sales',
		true,
		'task-reminders-v1'
	)
	assert.notEqual(retry.first.status, 0)
	assert.equal(retry.second.status, 0, retry.second.stderr)
	const resumed = retry.calls.slice(retry.firstCalls.length)
	assert.equal(
		resumed.includes('--force-recreate notification-delivery-worker'),
		false
	)
	assert.ok(
		resumed.includes(
			'COMPOSE crm stop --timeout 90 crm-sales-reminders crm-sales-api'
		)
	)
	assert.ok(
		resumed.includes('--force-recreate crm-sales-reminders') &&
			resumed.includes('--force-recreate crm-sales-api')
	)
})

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
		crmDatabaseNeighbors([...neighbors(), databases[0], databases[0]], previous)
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
				crmDatabaseContainer(container, config, imageWithoutDefaultUser, owner),
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
			assert.deepEqual(crmDatabaseCredentials(config, owner, 'c'.repeat(64)), {
				runtime: 'a'.repeat(64),
				migration: 'b'.repeat(64),
				backup: 'c'.repeat(64)
			})
			for (const password of ['short', 'a'.repeat(64), 'c'.repeat(64) + '\n'])
				assert.throws(() => crmDatabaseCredentials(config, owner, password))
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
			assert.equal(crmPreparationReceipt(value, shape).infraRevision, previous)
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
			value[0].Config.Labels['org.opencontainers.image.revision'] = revision
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
		spawnSync(process.execPath, [join(root, 'crm-release.mjs'), 'inventory'], {
			input,
			encoding: 'utf8',
			timeout: 5000,
			env: { CRM_GATEWAY_REVISION: previous }
		})
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
		writeFileSync(join(directory, 'input-compose.json'), input.composeBytes, {
			mode: 0o600
		})
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
		if (scope === 'crm-databases' || scope === 'crm-runtime') {
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
			const prepared = join(directory, 'deploy/backend/crm/releases', revision)
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
			if (scope === 'crm-runtime' && scenario !== 'missing-database')
				for (const owner of owners)
					writeFileSync(join(directory, 'running-' + owner), '')
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
awk() { if [[ "$*" == *'/proc/meminfo'* ]]; then if [[ "$TEST_SCENARIO" == low-runtime-memory ]]; then printf '1073741824'; else printf '17179869184'; fi; else command awk "$@"; fi; }
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
        number=10
        for app in $TEST_RUNTIME_NAMES; do
          if [[ -f "$TEST_DIRECTORY/runtime-$app" && ( "$*" != *'label=com.docker.compose.service='* || "$*" == *"service=$app" ) ]]; then printf '%064d\\n' "$number"; fi
          number=$((number+1))
        done
        if [[ "$TEST_SCENARIO" == unknown-container && "$*" != *'label=com.docker.compose.service='* ]]; then printf '%064d\\n' 99; fi
      else printf '%s\\n' "$TEST_CONTAINER"; fi ;;
    inspect)
      if [[ "$*" == *'.State.Status'* ]]; then
        if [[ "$TEST_SCENARIO" == unhealthy-runtime ]]; then printf 'running unhealthy 0 false\\n'; else printf 'running healthy 0 false\\n'; fi
      elif [[ "$*" == *'.State.Health.Status'* ]]; then printf 'healthy\\n'
      elif [[ "$*" == *'.Config.Image'* ]]; then printf 'postgres:18-bookworm@sha256:%064d\\n' 90
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
      if [[ "$mode" == inventory || "$mode" == database-neighbors || "$mode" == runtime-neighbors ]]; then
        [[ "$mode" == database-neighbors || "$mode" == runtime-neighbors ]] || return 101
        command cat >/dev/null
        if [[ "$TEST_SCENARIO" == neighbor-drift && -f "$TEST_DIRECTORY/built-winwidget-crm-access:git-$TEST_REVISION" ]]; then printf 'drift\\n'; else printf '%s\\n' "$TEST_HASH"; fi
      elif [[ "$mode" == runtime-seal ]]; then
        [[ "$TEST_SCENARIO" != invalid-runtime-seal ]] || return 102
        for arg in $TEST_RUNTIME_NAMES; do printf '%s\\n' "$arg"; done
      elif [[ "$mode" == runtime-compose ]]; then printf '{}\\n'
      elif [[ "$mode" == runtime-ledger ]]; then
        command cat >/dev/null
        [[ "$TEST_SCENARIO" != invalid-runtime-ledger ]] || return 103
        printf '1\\n'
      elif [[ "$mode" == runtime-container ]]; then
        command cat >/dev/null
        [[ "$TEST_SCENARIO" != runtime-drift ]] || return 104
        printf '%064d\\n' 10
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
      if [[ "$TEST_SCOPE" == crm-runtime ]]; then
        [[ "$*" == *' up '* && "$*" == *'--no-recreate'* && " $TEST_RUNTIME_NAMES " == *" $last "* ]] || return 105
        : >"$TEST_DIRECTORY/runtime-$last"
      elif [[ "$TEST_SCOPE" != crm-databases ]]; then command cat "$TEST_DIRECTORY/input-compose.json"
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
  if [[ "$TEST_SCOPE" == crm-databases || "$TEST_SCOPE" == crm-runtime ]]; then [[ "$count" == 0 ]] || return 90; else [[ "$count" == 8 ]] || return 90; fi
  shift
  docker "$@"
}
scoped_deploy_main
`
		const execute = () =>
			spawnSync('/bin/bash', ['-c', script], {
				encoding: 'utf8',
				timeout: scope === 'crm-prepare' ? 20000 : 60000,
				env: {
					PATH: process.env.PATH,
					TEST_NODE: process.execPath,
					TEST_DIRECTORY: directory,
					TEST_TRACE: trace,
					TEST_LIBRARY: join(root, 'deploy-crm-scoped.sh'),
					TEST_SCENARIO: scenario,
					TEST_SCOPE: scope,
					TEST_RUNTIME_NAMES: CRM_RUNTIME_NAMES.join(' '),
					TEST_REVISION: revision,
					TEST_PREVIOUS: previous,
					TEST_HASH: hash,
					TEST_ENV_HASH:
						scenario === 'env-drift' ? hash : sha('synthetic-only\n'),
					TEST_VERIFIER_HASH: sha(readFileSync(join(root, 'crm-release.mjs'))),
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
				name =>
					name.startsWith('.crm-prepare.') || name.startsWith('.crm-runtime.')
			)
		}
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

test('runtime fence excludes only known applications and preserves database and other-service identities', () => {
	const base = neighbors()
	const runtime = {
		...structuredClone(base[1]),
		Id: id(30),
		Config: {
			Labels: {
				'com.docker.compose.project': 'winwidget-crm',
				'com.docker.compose.service': CRM_RUNTIME_NAMES[0]
			}
		}
	}
	assert.equal(
		crmRuntimeNeighbors([...base, runtime], previous),
		crmNeighborFingerprint(base, previous)
	)
	assert.throws(() =>
		crmRuntimeNeighbors([...base, runtime, runtime], previous)
	)
	runtime.Config.Labels['com.docker.compose.service'] = 'crm-unexpected'
	assert.throws(() => crmRuntimeNeighbors([...base, runtime], previous))
	const db = structuredClone(base[1])
	db.Id = id(40)
	db.Config.Labels['com.docker.compose.project'] = 'winwidget-crm'
	db.Config.Labels['com.docker.compose.service'] = 'crm-access-postgres'
	assert.notEqual(
		crmRuntimeNeighbors([...base, db], previous),
		crmNeighborFingerprint(base, previous)
	)
})

test('runtime ledger requires exact successful migrations, without missing, failed or modified entries', () => {
	const migrations = [{ name: 'a', checksum: hash }]
	const row = {
		migration_name: 'a',
		checksum: hash,
		finished_at: '2026-09-07',
		rolled_back_at: null
	}
	assert.equal(crmRuntimeLedger(migrations, [row]), 1)
	for (const rows of [
		[],
		[row, row],
		[{ ...row, checksum: 'f'.repeat(64) }],
		[{ ...row, finished_at: null }],
		[{ ...row, rolled_back_at: '2026-09-07' }]
	])
		assert.throws(() => crmRuntimeLedger(migrations, rows))
})

test('each runtime process requires its exact immutable image, env, isolation and healthy state', () => {
	for (const name of CRM_RUNTIME_NAMES) {
		const owner = owners.find(value => name.startsWith(value + '-'))
		const candidate = {
			Id: image(1),
			Config: {
				Labels: { 'org.opencontainers.image.revision': revision },
				Env: ['PATH=/usr/bin'],
				Cmd: ['node', 'dist/main.js'],
				Entrypoint: ['docker-entrypoint.sh']
			}
		}
		const service = {
			image: candidate.Id,
			user: '1001:1001',
			labels: { 'com.winwidget.owner': owner },
			environment: {
				APP_REVISION: revision,
				SYNTHETIC_SECRET: 'synthetic-only'
			},
			mem_limit: 384 * 1048576,
			memswap_limit: 384 * 1048576,
			cpus: 1,
			pids_limit: 128,
			security_opt: ['no-new-privileges:true'],
			logging: {
				driver: 'json-file',
				options: { 'max-size': '10m', 'max-file': '3' }
			},
			tmpfs: ['/tmp:rw,nosuid,nodev,noexec,size=64m'],
			healthcheck: {
				test: ['CMD', 'node', 'healthcheck.js'],
				interval: '10s',
				timeout: '5s',
				start_period: '30s',
				retries: 3
			}
		}
		const config = { services: { [name]: service } }
		const live = {
			Id: id(1),
			Image: candidate.Id,
			Name: '/winwidget-crm-' + name + '-1',
			RestartCount: 0,
			State: {
				Running: true,
				Paused: false,
				Restarting: false,
				OOMKilled: false,
				Dead: false,
				Health: { Status: 'healthy' }
			},
			Mounts: [],
			Config: {
				Image: candidate.Id,
				Labels: {
					...service.labels,
					'com.docker.compose.project': 'winwidget-crm',
					'com.docker.compose.service': name,
					'com.docker.compose.oneoff': 'False',
					'com.docker.compose.container-number': '1'
				},
				Env: [
					...candidate.Config.Env,
					...Object.entries(service.environment).map(
						([key, value]) => key + '=' + value
					)
				],
				User: service.user,
				Cmd: candidate.Config.Cmd,
				Entrypoint: candidate.Config.Entrypoint,
				StopTimeout: 45,
				Healthcheck: {
					Test: service.healthcheck.test,
					Interval: 10e9,
					Timeout: 5e9,
					StartPeriod: 30e9,
					Retries: 3
				}
			},
			HostConfig: {
				NetworkMode: 'host',
				Privileged: false,
				ReadonlyRootfs: true,
				Init: true,
				Memory: service.mem_limit,
				MemorySwap: service.memswap_limit,
				NanoCpus: 1e9,
				PidsLimit: 128,
				CapDrop: ['ALL'],
				SecurityOpt: service.security_opt,
				PidMode: '',
				IpcMode: 'private',
				RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
				LogConfig: { Type: 'json-file', Config: service.logging.options },
				Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=64m' }
			}
		}
		assert.equal(crmRuntimeContainer(live, config, [candidate], name), live.Id)
		for (const mutate of [
			x => {
				x.Image = image(2)
			},
			x => {
				x.Config.Env.push('FOREIGN_SECRET=wrong')
			},
			x => {
				x.State.OOMKilled = true
			},
			x => {
				x.RestartCount = 1
			},
			x => {
				x.State.Health.Status = 'unhealthy'
			},
			x => {
				x.HostConfig.Memory = 1
			},
			x => {
				x.HostConfig.Privileged = true
			},
			x => {
				x.HostConfig.ReadonlyRootfs = false
			},
			x => {
				x.HostConfig.Init = false
			},
			x => {
				x.HostConfig.PortBindings = { '80/tcp': [] }
			},
			x => {
				x.Mounts = [{ Type: 'bind', Destination: '/run/foreign' }]
			},
			x => {
				x.Config.Labels['com.docker.compose.project'] = 'winwidget'
			},
			x => {
				x.Config.User = '0:0'
			}
		]) {
			const changed = structuredClone(live)
			mutate(changed)
			assert.throws(() =>
				crmRuntimeContainer(changed, config, [candidate], name)
			)
		}
	}
})

test('actual CRM runtime controller starts exactly twelve applications and accepts an exact replay', () => {
	const result = runController('success', true, 'crm-runtime')
	assert.equal(result.first.status, 0, result.first.stderr)
	assert.equal(result.second.status, 0, result.second.stderr)
	assert.match(result.first.stdout, /Twelve isolated CRM processes verified/)
	assert.deepEqual(result.temporary, [])
	assert.doesNotMatch(
		result.calls,
		/DOCKER (build|pull|stop|rm|volume|network) /
	)
	assert.doesNotMatch(
		result.calls,
		/database-bootstrap|database-grants| compose .* run /
	)
	assert.doesNotMatch(
		result.first.stdout + result.first.stderr,
		/PRIVATE_PIPE_SENTINEL/
	)
	const starts = result.calls
		.split('\n')
		.filter(line => line.startsWith('DOCKER compose ') && line.includes(' up '))
	assert.equal(starts.length, 24)
	assert.deepEqual(
		starts.slice(0, 12).map(line => line.split(' ').at(-1)),
		CRM_RUNTIME_NAMES
	)
})

test('actual CRM runtime blocks unsafe inputs before any application starts', () => {
	for (const scenario of [
		'invalid-runtime-seal',
		'invalid-runtime-ledger',
		'missing-database',
		'unknown-container',
		'low-runtime-memory',
		'env-drift',
		'lock-lost'
	]) {
		const result = runController(scenario, false, 'crm-runtime')
		assert.notEqual(result.first.status, 0, scenario)
		assert.doesNotMatch(result.calls, /DOCKER compose .* up /, scenario)
		assert.doesNotMatch(
			result.calls,
			/DOCKER (stop|rm|volume|network) /,
			scenario
		)
	}
})

test('actual CRM runtime fails at an unhealthy first process without starting further processes', () => {
	const result = runController('unhealthy-runtime', false, 'crm-runtime')
	assert.notEqual(result.first.status, 0)
	assert.equal(
		result.calls
			.split('\n')
			.filter(
				line => line.startsWith('DOCKER compose ') && line.includes(' up ')
			).length,
		1
	)
	assert.doesNotMatch(result.calls, /DOCKER (stop|rm|volume|network) /)
})

test('actual CRM controller prepares four images, preserves immutable artifacts on replay and never starts runtime or migrates', () => {
	const result = runController('success', true)
	assert.equal(result.first.status, 0, result.first.stderr)
	assert.equal(result.second.status, 0, result.second.stderr)
	assert.equal(
		result.calls.split('\n').filter(line => line.startsWith('DOCKER build '))
			.length,
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
	assert.match(result.second.stderr, /immutable CRM preparation already exists/)
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
				line => line.startsWith('DOCKER compose ') && line.includes(' run ')
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
		let container, upgradeImageTag
		try {
			if (mode === 'ci') {
				// Exercise the real permission boundary, not the coordinator double.
				// A dedicated public context must not include the test DB password.
				stage = 'actual-image-private-prisma-setup'
				const contextDirectory = join(directory, 'upgrade-source-image')
				mkdirSync(contextDirectory, { mode: 0o700 })
				const { prisma } = privateSourceFixture(contextDirectory)
				writeFileSync(
					join(contextDirectory, 'package.json'),
					'{"name":"synthetic-upgrade"}',
					{ mode: 0o600 }
				)
				writeFileSync(
					join(contextDirectory, 'verifier.mjs'),
					readFileSync(join(root, 'crm-release.mjs')),
					{ mode: 0o444 }
				)
				const nodeImage =
					'node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0'
				writeFileSync(
					join(contextDirectory, 'Dockerfile'),
					[
						`FROM ${nodeImage}`,
						'WORKDIR /app',
						'COPY --chown=1001:1001 prisma /app/prisma',
						'COPY --chown=1001:1001 package.json /app/package.json',
						'COPY verifier.mjs /run/crm-release.mjs',
						''
					].join('\n'),
					{ mode: 0o600 }
				)
				const candidateTag = `wincrm-upgrade-source-test:${process.pid}`
				assert.notEqual(docker(['image', 'inspect', candidateTag]).status, 0)
				upgradeImageTag = candidateTag
				output(docker(['pull', nodeImage]))
				output(
					docker([
						'build',
						'--network',
						'none',
						'--tag',
						upgradeImageTag,
						contextDirectory
					])
				)
				const sourceProbe = user =>
					docker([
						'run',
						'--rm',
						'--interactive',
						'--network',
						'none',
						'--read-only',
						'--log-driver',
						'none',
						'--cap-drop',
						'ALL',
						'--security-opt',
						'no-new-privileges',
						'--user',
						user,
						'--memory',
						'256m',
						'--memory-swap',
						'256m',
						'--cpus',
						'1',
						'--pids-limit',
						'64',
						'--entrypoint',
						'node',
						upgradeImageTag,
						'/run/crm-release.mjs',
						'upgrade-source',
						'identity',
						''
					])
				stage = 'actual-root-without-dac-cannot-read-image-owner-files'
				const denied = sourceProbe('0:0')
				assert.equal(denied.status, 1)
				assert.equal(denied.stdout, '')
				assert.equal(
					denied.stderr,
					'CRM release verification failed; private details suppressed\n'
				)
				stage = 'actual-owner-without-capabilities-reads-prisma'
				assert.deepEqual(
					JSON.parse(output(sourceProbe('1001:1001'))),
					crmUpgradeImageSource(prisma)
				)
				stage = 'actual-owner-reads-private-package-manifest'
				assert.equal(
					output(
						docker([
							'run',
							'--rm',
							'--network',
							'none',
							'--read-only',
							'--log-driver',
							'none',
							'--cap-drop',
							'ALL',
							'--security-opt',
							'no-new-privileges',
							'--user',
							'1001:1001',
							'--entrypoint',
							'node',
							upgradeImageTag,
							'-e',
							'const fs=require("node:fs"); if((fs.statSync("/app/package.json").mode&511)!==384)process.exit(1); process.stdout.write(require("/app/package.json").name)'
						])
					),
					'synthetic-upgrade'
				)
			}
			stage = 'pull-pinned-postgres'
			output(docker(['pull', image]))
			stage = 'start-owned-postgres'
			output(compose(['up', '--detach', '--no-build', '--pull', 'never']))
			container = output(compose(['ps', '-q', service]))
			assert.match(container, /^[a-f0-9]{64}$/)
			for (let attempt = 0; attempt < 90; attempt++) {
				const health = output(
					docker(['inspect', '--format', '{{.State.Health.Status}}', container])
				)
				if (health === 'healthy') break
				assert.equal(health, 'starting')
				await delay(1000)
			}
			stage = 'actual-container-identity'
			const config = JSON.parse(output(compose(['config', '--format', 'json'])))
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
			if (
				upgradeImageTag &&
				docker(['image', 'inspect', upgradeImageTag]).status === 0
			)
				output(docker(['image', 'rm', upgradeImageTag]))
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
				const actual = JSON.parse(output(docker(['inspect', container])))[0]
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
