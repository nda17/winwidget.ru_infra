import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { pathToFileURL } from 'node:url'
import {
	CRM_REMINDERS_TARGETS,
	crmRemindersBaseline,
	prepareCrmRemindersActivation,
	crmRemindersPlanDigest,
	assertCrmRemindersProgress
} from './crm-reminders-activation.mjs'
import { crmUpgradeDatabaseInput } from './crm-release.mjs'
import {
	crmReminderNotificationTopology,
	crmReminderBrokerInputs,
	crmRemindersBrokerContract
} from './crm-reminders-broker-topology.mjs'

export const REMINDERS_PAYLOAD_FILES = Object.freeze([
	'crm-reminders-activation-cli.mjs',
	'crm-reminders-activation.mjs',
	'crm-release.mjs',
	'scoped-service-release.mjs',
	'crm-broker-bootstrap.mjs',
	'crm-broker-topology.mjs',
	'crm-reminders-broker-topology.mjs'
])
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const exact = (value, keys) => {
	assert.ok(value && typeof value === 'object' && !Array.isArray(value))
	assert.deepEqual(Object.keys(value).sort(), [...keys].sort())
}
export function validateRemindersPayload(bytes) {
	assert.ok(
		Buffer.byteLength(bytes) > 0 && Buffer.byteLength(bytes) <= 524288
	)
	const value = JSON.parse(bytes)
	exact(value, ['schemaVersion', 'files'])
	assert.equal(value.schemaVersion, 1)
	assert.ok(Array.isArray(value.files))
	assert.deepEqual(
		value.files.map(row => row.name).sort(),
		[...REMINDERS_PAYLOAD_FILES].sort()
	)
	return value.files.map(row => {
		exact(row, ['name', 'sha256', 'content'])
		assert.match(row.sha256, /^[a-f0-9]{64}$/)
		assert.equal(typeof row.content, 'string')
		const content = Buffer.from(row.content)
		assert.equal(content.toString('utf8'), row.content)
		assert.ok(content.length > 0 && content.length <= 131072)
		assert.equal(sha(content), row.sha256)
		return { name: row.name, content }
	})
}
export function parseReminderEnv(bytes) {
	assert.equal(typeof bytes, 'string')
	assert.ok(Buffer.byteLength(bytes) <= 131072 && !bytes.includes('\0'))
	const keys = []
	for (const line of bytes.split(/\r?\n/)) {
		if (!line.trim() || line.trimStart().startsWith('#')) continue
		const match = /^([A-Z][A-Z0-9_]*)=/.exec(line)
		assert.ok(match && !keys.includes(match[1]))
		keys.push(match[1])
	}
	const value = parseEnv(bytes)
	assert.deepEqual(Object.keys(value).sort(), keys.sort())
	return value
}
export function remindersState(state, marker, plan) {
	const result = structuredClone(state)
	if (marker !== null) {
		exact(marker, ['schemaVersion', 'kind', 'planSha256'])
		assert.equal(marker.schemaVersion, 1)
		assert.equal(marker.kind, `${plan.kind}.admission`)
		assert.equal(marker.planSha256, crmRemindersPlanDigest(plan))
		if (result.admission !== null)
			assert.deepEqual(result.admission, marker)
		result.admission = marker
	} else assert.equal(result.admission, null)
	return result
}
const keyOf = row =>
	`${row.Config?.Labels?.['com.docker.compose.project']}/${row.Config?.Labels?.['com.docker.compose.service']}`
export function remindersTransition(
	{ live, baseline, plan, state, marker, started = null, observed = null },
	action
) {
	state = remindersState(state, marker, plan)
	const progress = assertCrmRemindersProgress(live, baseline, plan, state)
	const key = progress.next
	if (action === 'progress') return progress
	assert.ok(key && state.admission)
	const index = CRM_REMINDERS_TARGETS.indexOf(key)
	const expectedStart = {
		schemaVersion: 1,
		planSha256: crmRemindersPlanDigest(plan),
		index,
		key
	}
	if (started !== null) assert.deepEqual(started, expectedStart)
	if (observed !== null) {
		exact(observed, [
			'schemaVersion',
			'planSha256',
			'index',
			'key',
			'id',
			'startedAt'
		])
		assert.deepEqual(
			{ ...observed, id: undefined, startedAt: undefined },
			{ ...expectedStart, id: undefined, startedAt: undefined }
		)
		assert.match(observed.id, /^[a-f0-9]{64}$/)
		assert.ok(Number.isFinite(Date.parse(observed.startedAt)))
		assert.ok(started)
	}
	const row = live.find(item => keyOf(item) === key)
	if (observed) {
		assert.equal(row?.Id, observed.id)
		assert.equal(row.State.StartedAt, observed.startedAt)
	}
	if (action === 'begin') {
		assert.equal(started, null)
		assert.equal(observed, null)
		state.switching = key
		assertCrmRemindersProgress(live, baseline, plan, state)
		return state
	}
	assert.equal(state.switching, key)
	if (action === 'start') {
		assert.equal(started, null)
		assert.equal(observed, null)
		assert.ok(!row || row.Id === baseline.targets[key].id)
		if (row) {
			assert.equal(row.State.Running, false)
			assert.equal(row.State.Pid, 0)
		}
		return expectedStart
	}
	assert.ok(started)
	if (action === 'observe') {
		assert.ok(row && row.Id !== baseline.targets[key].id)
		assert.equal(row.State.Running, true)
		assert.ok(Number.isFinite(Date.parse(row.State.StartedAt)))
		return { ...expectedStart, id: row.Id, startedAt: row.State.StartedAt }
	}
	if (action === 'complete') {
		assert.ok(observed)
		state.completed[key] = {
			id: observed.id,
			startedAt: observed.startedAt
		}
		state.switching = null
		assertCrmRemindersProgress(live, baseline, plan, state)
		return state
	}
	throw new Error('Unsupported transition')
}

function boundedStdin(limit = 16384) {
	const chunks = [],
		chunk = Buffer.alloc(4096)
	let total = 0,
		size
	while (
		(size = readSync(
			0,
			chunk,
			0,
			Math.min(chunk.length, limit + 1 - total),
			null
		))
	) {
		total += size
		assert.ok(total <= limit)
		chunks.push(Buffer.from(chunk.subarray(0, size)))
	}
	assert.ok(total > 0)
	return Buffer.concat(chunks)
}
function privateBytes(path, limit = 8 * 1048576) {
	const stat = lstatSync(path)
	assert.ok(
		stat.isFile() &&
			!stat.isSymbolicLink() &&
			stat.nlink === 1 &&
			stat.uid === 0 &&
			stat.gid === 0 &&
			(stat.mode & 0o777) === 0o600 &&
			stat.size > 0 &&
			stat.size <= limit
	)
	return readFileSync(path)
}
const directory = '/run/reminders'
const json = name =>
	JSON.parse(privateBytes(directory + '/' + name + '.json'))
function optional(name) {
	try {
		return json(name)
	} catch (error) {
		if (error.code === 'ENOENT') return null
		throw error
	}
}
const currentHashes = () => ({
	canonical: process.env.REMINDERS_CANONICAL_SHA256,
	crm: process.env.REMINDERS_CRM_SHA256,
	'notification-delivery':
		process.env.REMINDERS_NOTIFICATION_DELIVERY_SHA256
})
function binding(plan) {
	return {
		schemaVersion: 1,
		scope: 'crm-reminders-activate',
		servicesRevision: process.env.REMINDERS_SERVICES_REVISION,
		infraRevision: process.env.REMINDERS_INFRA_REVISION,
		payloadSha256: process.env.REMINDERS_PAYLOAD_SHA256,
		controllerSha256: process.env.REMINDERS_CONTROLLER_SHA256,
		baselineSha256: sha(privateBytes(directory + '/baseline.json')),
		planSha256: crmRemindersPlanDigest(plan),
		planFileSha256: sha(privateBytes(directory + '/plan.json')),
		initialSha256: sha(privateBytes(directory + '/initial.json')),
		environmentHashes: currentHashes()
	}
}
function session() {
	const plan = json('plan'),
		baseline = json('baseline'),
		expected = binding(plan)
	assert.deepEqual(json('binding'), expected)
	assert.equal(
		expected.baselineSha256,
		process.env.REMINDERS_BASELINE_SHA256
	)
	assert.deepEqual(baseline.environmentHashes, currentHashes())
	assert.deepEqual(plan.environmentHashes, currentHashes())
	const state = json('state'),
		marker = optional('admission'),
		normalized = remindersState(state, marker, plan),
		index = Object.keys(normalized.completed).length
	return {
		live: json('inventory'),
		baseline,
		plan,
		state,
		marker,
		started: optional('start-' + index),
		observed: optional('observed-' + index)
	}
}
export function reminderOverlaySources(configs, live) {
	// Prepared owner env contains the final flags. Reconstruct ONLY approved
	// before-fields from the captured runtime; every other setting must still match.
	const result = structuredClone(configs)
	for (const [prefix, key, fields] of [
		[
			'notification',
			CRM_REMINDERS_TARGETS[0],
			[
				'CRM_SALES_INTERNAL_BASE_URL',
				'CRM_SALES_NOTIFICATION_DELIVERY_TOKEN',
				'NOTIFICATION_DELIVERY_CRM_SALES_TOKEN',
				'NOTIFICATION_DELIVERY_KINDS'
			]
		],
		[
			'crm',
			CRM_REMINDERS_TARGETS[2],
			[
				'CRM_TASK_REMINDERS_ENABLED',
				'CRM_SALES_NOTIFICATION_DELIVERY_TOKEN',
				'NOTIFICATION_DELIVERY_CRM_SALES_TOKEN',
				'NOTIFICATION_DELIVERY_INTERNAL_BASE_URL'
			]
		]
	]) {
		const rows = live.filter(row => keyOf(row) === key)
		assert.equal(rows.length, 1)
		const env = Object.fromEntries(
			rows[0].Config.Env.map(entry => {
				const split = entry.indexOf('=')
				assert.ok(split > 0)
				return [entry.slice(0, split), entry.slice(split + 1)]
			})
		)
		const before =
			result[prefix + 'Before'].services[key.split('/')[1]].environment
		for (const field of fields) {
			if (Object.hasOwn(env, field)) before[field] = env[field]
			else delete before[field]
		}
	}
	return result
}
function ownerFiles() {
	const canonical = parseReminderEnv(
		privateBytes('/run/canonical.env', 131072).toString('utf8')
	)
	const crm = parseReminderEnv(
		privateBytes('/run/crm.env', 131072).toString('utf8')
	)
	const notification = parseReminderEnv(
		privateBytes('/run/notification-delivery.env', 131072).toString('utf8')
	)
	assert.equal(canonical.CRM_RABBITMQ_CONTRACT, 'mvp-v1')
	assert.equal(
		canonical.CRM_REMINDERS_RABBITMQ_CONTRACT,
		'task-reminders-v1'
	)
	assert.equal(crm.CRM_TASK_REMINDERS_ENABLED, 'true')
	for (const field of [
		'NOTIFICATION_DELIVERY_KINDS',
		'CRM_SALES_INTERNAL_BASE_URL',
		'CRM_SALES_NOTIFICATION_DELIVERY_TOKEN',
		'NOTIFICATION_DELIVERY_CRM_SALES_TOKEN'
	])
		assert.equal(notification[field], canonical[field])
	for (const field of [
		'CRM_SALES_NOTIFICATION_DELIVERY_TOKEN',
		'NOTIFICATION_DELIVERY_CRM_SALES_TOKEN'
	])
		assert.equal(notification[field], crm[field])
	crmReminderBrokerInputs(
		canonical,
		crm,
		crmReminderNotificationTopology()
	)
	return { canonical, crm, notification }
}
export async function verifyReminderReadiness(
	input,
	fetcher = fetch,
	now = Date.now()
) {
	exact(input, ['token'])
	assert.match(input.token, /^[a-f0-9]{48,128}$/)
	const response = await fetcher(
		'http://127.0.0.1:4401/internal/v1/crm-sales/task-reminders/readiness',
		{
			method: 'GET',
			redirect: 'error',
			signal: AbortSignal.timeout(5000),
			headers: {
				'x-winwidget-service': 'crm-sales',
				'x-winwidget-internal-token': input.token
			}
		}
	)
	assert.equal(response.status, 200)
	assert.equal(response.headers.get('cache-control'), 'no-store')
	const reader = response.body.getReader()
	const chunks = []
	let total = 0
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			total += value.length
			assert.ok(total <= 8192)
			chunks.push(value)
		}
	} finally {
		await reader.cancel()
	}
	const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
	exact(value, ['schemaVersion', 'ready', 'checkedAt', 'channels'])
	assert.equal(value.schemaVersion, 1)
	assert.equal(value.ready, true)
	assert.deepEqual(value.channels, ['EMAIL', 'TELEGRAM'])
	const checkedAt = Date.parse(value.checkedAt)
	assert.ok(
		Number.isFinite(checkedAt) && Math.abs(checkedAt - now) <= 30000
	)
	return {
		schemaVersion: 1,
		ready: true,
		channels: value.channels,
		checkedAt: value.checkedAt
	}
}
async function main() {
	const [mode, argument] = process.argv.slice(2)
	assert.ok(process.argv.length <= 4)
	if (mode === 'pack') {
		const files = REMINDERS_PAYLOAD_FILES.map(name => {
			const path = new URL(name, import.meta.url),
				stat = lstatSync(path)
			assert.ok(stat.isFile() && !stat.isSymbolicLink())
			const bytes = readFileSync(path)
			return { name, sha256: sha(bytes), content: bytes.toString('utf8') }
		})
		const result = JSON.stringify({ schemaVersion: 1, files })
		validateRemindersPayload(result)
		return result
	}
	if (mode === 'readiness')
		return verifyReminderReadiness(JSON.parse(boundedStdin()))
	if (mode === 'source') {
		assert.ok(['crm-sales', 'notification-delivery'].includes(argument))
		const paths =
			argument === 'crm-sales'
				? [
						'dist/src/main-reminders.js',
						'dist/src/reminders/reminder-readiness.service.js',
						'dist/src/reminders/reminder-rules.controller.js'
					]
				: [
						'dist/src/notification-delivery/wincrm-task-reminder-context.service.js',
						'dist/src/notification-delivery/wincrm-task-reminder-readiness.controller.js',
						'dist/src/messaging/wincrm-task-reminder.contract.js'
					]
		return {
			owner: argument,
			files: paths.map(path => {
				const file = '/app/' + path,
					stat = lstatSync(file)
				assert.ok(
					stat.isFile() &&
						!stat.isSymbolicLink() &&
						stat.size > 0 &&
						stat.size <= 1048576
				)
				return { path, sha256: sha(readFileSync(file)) }
			})
		}
	}
	if (mode === 'readiness-input')
		return {
			token:
				ownerFiles().notification.NOTIFICATION_DELIVERY_CRM_SALES_TOKEN
		}
	if (mode === 'database-input') {
		assert.ok(['crm-sales', 'notification-delivery'].includes(argument))
		return crmUpgradeDatabaseInput(
			argument,
			privateBytes('/run/owner.env', 131072).toString('utf8'),
			json('initial')
		)
	}
	if (mode === 'baseline')
		return crmRemindersBaseline(
			json('inventory'),
			process.env.REMINDERS_GATEWAY_REVISION,
			currentHashes()
		)
	if (mode === 'target-images')
		return [
			...new Set(
				Object.values(json('baseline').targets).map(row => row.image)
			)
		].join('\n')
	if (mode === 'owner-image') {
		assert.ok(['crm-sales', 'notification-delivery'].includes(argument))
		return json('baseline').targets[
			argument === 'crm-sales'
				? CRM_REMINDERS_TARGETS[2]
				: CRM_REMINDERS_TARGETS[0]
		].image
	}
	if (mode === 'image-env') {
		const live = json('initial'),
			result = []
		for (const owner of [
			'notification-delivery',
			'campaigns',
			'reporting',
			'widgets',
			'billing',
			'identity',
			'platform',
			'support',
			'operations',
			'crm-access',
			'crm-intake',
			'crm-customers',
			'crm-sales'
		]) {
			const role =
				{
					'notification-delivery': 'notification-delivery-worker',
					campaigns: 'campaigns-service',
					reporting: 'reporting-service',
					widgets: 'widgets-service'
				}[owner] ?? owner + '-api'
			const rows = live.filter(
				row =>
					keyOf(row) ===
					(owner.startsWith('crm-') ? 'winwidget-crm/' : 'winwidget/') +
						role
			)
			assert.equal(rows.length, 1)
			const row = rows[0],
				revision = row.Config.Env.filter(entry =>
					entry.startsWith('APP_REVISION=')
				)
			assert.equal(revision.length, 1)
			assert.match(revision[0].slice(13), /^[a-f0-9]{40}$/)
			assert.match(row.Image, /^sha256:[a-f0-9]{64}$/)
			const prefix = owner.replaceAll('-', '_').toUpperCase()
			result.push(
				prefix + '_IMAGE=' + row.Image,
				prefix + '_REVISION=' + revision[0].slice(13)
			)
		}
		return result.join('\n')
	}
	if (mode === 'notification-topology') {
		ownerFiles()
		return crmReminderNotificationTopology()
	}
	if (mode === 'prepare') {
		assert.equal(optional('admission'), null)
		assert.equal(optional('plan'), null)
		ownerFiles()
		const { validateCrmReminderDeployment } =
			await import('/run/crm-reminder-validator.mjs')
		const configs = reminderOverlaySources(
			{
				crmBefore: json('crm-before'),
				crmAfter: json('crm-after'),
				notificationBefore: json('notification-before'),
				notificationAfter: json('notification-after')
			},
			json('initial')
		)
		return prepareCrmRemindersActivation(
			{
				live: json('initial'),
				baseline: json('baseline'),
				configs,
				images: json('images'),
				environmentHashes: currentHashes()
			},
			validateCrmReminderDeployment
		)
	}
	if (mode === 'seal') {
		assert.equal(optional('admission'), null)
		assert.equal(optional('binding'), null)
		const plan = json('plan')
		assertCrmRemindersProgress(json('inventory'), json('baseline'), plan, {
			admission: null,
			completed: {},
			switching: null
		})
		return binding(plan)
	}
	const input = session()
	if (mode === 'broker-report' || mode === 'broker-check') {
		const expected = {
			contractSha256: sha(JSON.stringify(crmRemindersBrokerContract())),
			topologyVerified: true,
			queues: 12,
			bindings: 18,
			releaseApproved: false,
			credentialsProvisioned: true,
			authenticatedPrincipals: 1,
			legacyPrincipalsUnchanged: 24,
			notificationAclVerified: true,
			notificationKinds: 14
		}
		if (mode === 'broker-check') {
			assert.deepEqual(json('broker'), {
				planSha256: crmRemindersPlanDigest(input.plan),
				report: expected
			})
			return true
		}
		assert.ok(input.marker)
		assert.equal(Object.keys(input.state.completed).length, 0)
		assert.equal(input.state.switching, null)
		assert.deepEqual(JSON.parse(boundedStdin()), expected)
		return {
			planSha256: crmRemindersPlanDigest(input.plan),
			report: expected
		}
	}
	if (mode === 'compose') {
		assert.ok(['winwidget', 'winwidget-crm'].includes(argument))
		return JSON.stringify(input.plan.desired[argument]).replaceAll(
			'$',
			() => '$$'
		)
	}
	if (mode === 'database-check' || mode === 'admit') {
		assertCrmRemindersProgress(
			input.live,
			input.baseline,
			input.plan,
			remindersState(input.state, input.marker, input.plan)
		)
		for (const owner of ['crm-sales', 'notification-delivery']) {
			const before = json(owner + '-database-before'),
				current = json(owner + '-database-current')
			assert.deepEqual(before, current)
			assert.deepEqual(current.pending, [])
		}
		if (mode === 'database-check') return true
		assert.equal(input.marker, null)
		return {
			schemaVersion: 1,
			kind: input.plan.kind + '.admission',
			planSha256: crmRemindersPlanDigest(input.plan)
		}
	}
	if (mode === 'select') {
		const progress = remindersTransition(input, 'progress')
		return progress.complete
			? 'complete'
			: CRM_REMINDERS_TARGETS.indexOf(progress.next) +
					' ' +
					progress.next +
					' ' +
					(input.baseline.targets[progress.next].id ?? 'absent')
	}
	return remindersTransition(input, mode)
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const value = await main()
		process.stdout.write(
			(typeof value === 'string' ? value : JSON.stringify(value)) + '\n'
		)
	} catch {
		process.stderr.write(
			'CRM reminders controller rejected; private details suppressed\n'
		)
		process.exitCode = 1
	}
}
