import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'
import {
	CRM_COMMERCE_TARGETS,
	crmCommerceBaseline,
	prepareCrmCommerceActivation,
	crmCommercePlanDigest,
	assertCrmCommerceProgress,
	assertCrmCommerceDatabaseProof
} from './crm-commerce-activation.mjs'

export const COMMERCE_PAYLOAD_FILES = Object.freeze([
	'crm-commerce-activation-cli.mjs',
	'crm-commerce-activation.mjs',
	'crm-commerce-database.mjs',
	'crm-release.mjs',
	'scoped-service-release.mjs'
])
const sha = value => createHash('sha256').update(value).digest('hex')
const exact = (value, keys) => {
	assert.ok(value && typeof value === 'object' && !Array.isArray(value))
	assert.deepEqual(Object.keys(value).sort(), [...keys].sort())
}
export function validateCommercePayload(bytes) {
	assert.ok(
		Buffer.byteLength(bytes) > 0 && Buffer.byteLength(bytes) <= 524288
	)
	const envelope = JSON.parse(bytes)
	exact(envelope, ['schemaVersion', 'files'])
	assert.equal(envelope.schemaVersion, 1)
	assert.ok(Array.isArray(envelope.files))
	assert.deepEqual(
		envelope.files.map(file => file.name).sort(),
		[...COMMERCE_PAYLOAD_FILES].sort()
	)
	return envelope.files.map(file => {
		exact(file, ['name', 'sha256', 'content'])
		assert.match(file.sha256, /^[a-f0-9]{64}$/)
		assert.equal(typeof file.content, 'string')
		const content = Buffer.from(file.content, 'utf8')
		assert.equal(content.toString('utf8'), file.content)
		assert.ok(content.length > 0 && content.length <= 131072)
		assert.equal(sha(content), file.sha256)
		return { name: file.name, content }
	})
}

// Same ordered --env-file canonical, then Billing overlay as Compose. Reject
// duplicate declarations rather than relying on one parser's last-value rule.
export function commerceCompanionSource(canonicalBytes, billingBytes) {
	const parse = bytes => {
		assert.equal(typeof bytes, 'string')
		assert.ok(Buffer.byteLength(bytes) <= 131072 && !bytes.includes('\0'))
		const seen = new Set()
		for (const line of bytes.split(/\r?\n/)) {
			if (!line.trim() || line.trimStart().startsWith('#')) continue
			const match = /^([A-Z][A-Z0-9_]*)=/.exec(line)
			assert.ok(match && !seen.has(match[1]))
			seen.add(match[1])
		}
		const result = parseEnv(bytes)
		assert.deepEqual(Object.keys(result).sort(), [...seen].sort())
		return result
	}
	return { ...parse(canonicalBytes), ...parse(billingBytes) }
}
export function validateCommerceCompanions(
	config,
	canonicalBytes,
	billingBytes,
	validator
) {
	return validator(
		config,
		commerceCompanionSource(canonicalBytes, billingBytes)
	)
}

// A separate durable admission file is authoritative even if a signal happened
// before state.json was updated. A missing/malformed marker never authorizes SQL
// demand or a mutation. Recreating a private plan after admission is forbidden.
export function commerceState(state, marker, plan) {
	const result = structuredClone(state)
	if (marker !== null) {
		exact(marker, ['schemaVersion', 'kind', 'planSha256'])
		assert.equal(marker.schemaVersion, 1)
		assert.equal(marker.kind, `${plan.kind}.admission`)
		assert.equal(marker.planSha256, crmCommercePlanDigest(plan))
		if (result.admission !== null)
			assert.deepEqual(result.admission, marker)
		result.admission = marker
	} else assert.equal(result.admission, null)
	return result
}
const keyOf = row =>
	`${row.Config?.Labels?.['com.docker.compose.project']}/${row.Config?.Labels?.['com.docker.compose.service']}`
export function commerceTransition(
	{ live, baseline, plan, state, marker, started = null, observed = null },
	action
) {
	state = commerceState(state, marker, plan)
	const progress = assertCrmCommerceProgress(live, baseline, plan, state)
	const key = progress.next
	if (action === 'progress') return progress
	assert.ok(key && state.admission)
	const index = CRM_COMMERCE_TARGETS.indexOf(key)
	const expectedStart = {
		schemaVersion: 1,
		planSha256: crmCommercePlanDigest(plan),
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
		assertCrmCommerceProgress(live, baseline, plan, state)
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
		assertCrmCommerceProgress(live, baseline, plan, state)
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
function privateBytes(path, limit = 8 * 1024 * 1024) {
	const stat = lstatSync(path)
	assert.ok(
		stat.isFile() &&
			!stat.isSymbolicLink() &&
			stat.nlink === 1 &&
			stat.uid === 0 &&
			stat.gid === 0
	)
	assert.equal(stat.mode & 0o777, 0o600)
	assert.ok(stat.size > 0 && stat.size <= limit)
	return readFileSync(path)
}
const directory = '/run/commerce'
const json = name => JSON.parse(privateBytes(`${directory}/${name}.json`))
function optional(name) {
	try {
		return json(name)
	} catch (error) {
		if (error.code === 'ENOENT') return null
		throw error
	}
}
const currentHashes = () => ({
	canonical: process.env.COMMERCE_CANONICAL_SHA256,
	billing: process.env.COMMERCE_BILLING_SHA256,
	crm: process.env.COMMERCE_CRM_SHA256
})
function binding(plan, baseline) {
	return {
		schemaVersion: 1,
		scope: 'crm-commerce-activate',
		servicesRevision: process.env.COMMERCE_SERVICES_REVISION,
		infraRevision: process.env.COMMERCE_INFRA_REVISION,
		payloadSha256: process.env.COMMERCE_PAYLOAD_SHA256,
		controllerSha256: process.env.COMMERCE_CONTROLLER_SHA256,
		baselineSha256: sha(privateBytes(`${directory}/baseline.json`)),
		planSha256: crmCommercePlanDigest(plan),
		planFileSha256: sha(privateBytes(`${directory}/plan.json`)),
		initialSha256: sha(privateBytes(`${directory}/initial.json`)),
		environmentHashes: currentHashes()
	}
}
function session() {
	const plan = json('plan'),
		baseline = json('baseline')
	const expected = binding(plan, baseline)
	assert.deepEqual(json('binding'), expected)
	assert.equal(
		expected.baselineSha256,
		process.env.COMMERCE_BASELINE_SHA256
	)
	assert.deepEqual(baseline.environmentHashes, currentHashes())
	assert.deepEqual(plan.environmentHashes, currentHashes())
	const state = json('state'),
		marker = optional('admission')
	const normalized = commerceState(state, marker, plan)
	const index = Object.keys(normalized.completed).length
	return {
		live: json('inventory'),
		baseline,
		plan,
		state,
		marker,
		started: optional(`start-${index}`),
		observed: optional(`observed-${index}`)
	}
}
async function main() {
	const [mode, argument] = process.argv.slice(2)
	assert.ok(process.argv.length <= 4)
	if (mode === 'pack') {
		const files = COMMERCE_PAYLOAD_FILES.map(name => {
			const path = new URL(name, import.meta.url)
			const stat = lstatSync(path)
			assert.ok(stat.isFile() && !stat.isSymbolicLink())
			const bytes = readFileSync(path)
			const content = bytes.toString('utf8')
			assert.ok(bytes.equals(Buffer.from(content, 'utf8')))
			return { name, sha256: sha(bytes), content }
		})
		const result = JSON.stringify({ schemaVersion: 1, files })
		validateCommercePayload(result)
		return result
	}
	if (mode === 'database') {
		const { parseCrmCommerceDatabaseHandoff, probeCrmCommerceDatabase } =
			await import('./crm-commerce-database.mjs')
		return probeCrmCommerceDatabase(
			argument,
			parseCrmCommerceDatabaseHandoff(boundedStdin())
		)
	}
	if (mode === 'database-input') {
		const { crmCommerceDatabaseInput } =
			await import('./crm-commerce-database.mjs')
		return crmCommerceDatabaseInput(
			argument,
			privateBytes('/run/owner.env', 131072).toString('utf8'),
			json('initial')
		)
	}
	if (mode === 'database-merge') {
		const { mergeCrmCommerceDatabaseProof } =
			await import('./crm-commerce-database.mjs')
		return mergeCrmCommerceDatabaseProof(
			['billing', 'crm-access', 'crm-customers'].map(owner =>
				json(`${owner}-database`)
			)
		)
	}
	if (mode === 'baseline')
		return crmCommerceBaseline(
			json('inventory'),
			process.env.COMMERCE_GATEWAY_REVISION,
			currentHashes()
		)
	if (mode === 'target-images')
		return [
			...new Set(
				Object.values(json('baseline').targets).map(target => target.image)
			)
		].join('\n')
	if (mode === 'owner-image') {
		assert.ok(
			['billing', 'crm-access', 'crm-customers'].includes(argument)
		)
		const baseline = json('baseline')
		const key = `${argument === 'billing' ? 'winwidget' : 'winwidget-crm'}/${argument}-api`
		assert.match(baseline.targets[key].image, /^sha256:[a-f0-9]{64}$/)
		return baseline.targets[key].image
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
				}[owner] ?? `${owner}-api`
			const row = live.find(
				item =>
					keyOf(item) ===
					`${owner.startsWith('crm-') ? 'winwidget-crm' : 'winwidget'}/${role}`
			)
			assert.match(row?.Image, /^sha256:[a-f0-9]{64}$/)
			const revision = row.Config.Env.filter(entry =>
				entry.startsWith('APP_REVISION=')
			)
			assert.equal(revision.length, 1)
			assert.match(revision[0].slice(13), /^[a-f0-9]{40}$/)
			const prefix = owner.replaceAll('-', '_').toUpperCase()
			result.push(
				`${prefix}_IMAGE=${row.Image}`,
				`${prefix}_REVISION=${revision[0].slice(13)}`
			)
		}
		return result.join('\n')
	}
	if (mode === 'prepare') {
		assert.equal(optional('admission'), null)
		assert.equal(optional('plan'), null)
		const { validateCrmCompose, validateCrmCompanionCompose } =
			await import('/run/crm-compose-validator.mjs')
		const configs = {
			winwidget: json('billing'),
			'winwidget-crm': json('crm')
		}
		const key =
			configs['winwidget-crm'].services['crm-customers-api'].environment
				.CRM_CUSTOMERS_DADATA_API_KEY
		return prepareCrmCommerceActivation(
			{
				live: json('initial'),
				baseline: json('baseline'),
				configs,
				images: json('images'),
				environmentHashes: currentHashes(),
				settings: key
					? { dadata: 'enabled', dadataKey: key }
					: { dadata: 'disabled' }
			},
			{
				crm: validateCrmCompose,
				companions: config =>
					validateCommerceCompanions(
						config,
						privateBytes('/run/canonical.env', 131072).toString('utf8'),
						privateBytes('/run/billing.env', 131072).toString('utf8'),
						validateCrmCompanionCompose
					)
			}
		)
	}
	if (mode === 'seal') {
		assert.equal(optional('admission'), null)
		assert.equal(optional('binding'), null)
		const plan = json('plan'),
			baseline = json('baseline')
		assertCrmCommerceProgress(json('inventory'), baseline, plan, {
			admission: null,
			completed: {},
			switching: null
		})
		return binding(plan, baseline)
	}
	const input = session()
	if (mode === 'compose') {
		assert.ok(['winwidget', 'winwidget-crm'].includes(argument))
		return JSON.stringify(input.plan.desired[argument]).replaceAll(
			'$',
			() => '$$'
		)
	}
	if (mode === 'database-check' || mode === 'admit') {
		const state = commerceState(input.state, input.marker, input.plan)
		assertCrmCommerceProgress(
			input.live,
			input.baseline,
			input.plan,
			state
		)
		assertCrmCommerceDatabaseProof(
			json('database-before'),
			json('database-current'),
			Date.now(),
			state.admission === null
		)
		if (mode === 'database-check') return true
		assert.equal(input.marker, null)
		return {
			schemaVersion: 1,
			kind: `${input.plan.kind}.admission`,
			planSha256: crmCommercePlanDigest(input.plan)
		}
	}
	if (mode === 'select') {
		const progress = commerceTransition(input, 'progress')
		if (progress.complete) return 'complete'
		return `${CRM_COMMERCE_TARGETS.indexOf(progress.next)} ${progress.next} ${input.baseline.targets[progress.next].id}`
	}
	return commerceTransition(input, mode)
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const result = await main()
		process.stdout.write(
			(typeof result === 'string' ? result : JSON.stringify(result)) + '\n'
		)
	} catch {
		process.stderr.write(
			'CRM commerce controller rejected; private details suppressed\n'
		)
		process.exitCode = 1
	}
}
