import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { crmNeighborFingerprint } from './crm-release.mjs'
import { assertServiceConfiguration } from './scoped-service-release.mjs'

export const CRM_REMINDERS_TARGETS = Object.freeze([
	'winwidget/notification-delivery-worker',
	'winwidget-crm/crm-sales-reminders',
	'winwidget-crm/crm-sales-api'
])
const KIND = 'winwidget.crm.reminders-activation.v1'
export const CRM_INTAKE_SLA_ACTIVATION_KIND =
	'winwidget.crm.intake-sla-activation.v1'
export const CRM_INTAKE_SLA_TARGETS = Object.freeze([
	'winwidget/notification-delivery-worker',
	'winwidget-crm/crm-intake-sla-worker',
	'winwidget-crm/crm-intake-sla-publisher',
	'winwidget-crm/crm-intake-api'
])
// Exactly two reviewed workflows, not an extensible activation framework.
export function crmActivationSpec(value = KIND) {
	const kind = value.endsWith('.baseline') ? value.slice(0, -9) : value
	assert.ok([KIND, CRM_INTAKE_SLA_ACTIVATION_KIND].includes(kind))
	const sla = kind === CRM_INTAKE_SLA_ACTIVATION_KIND
	const targets = sla ? CRM_INTAKE_SLA_TARGETS : CRM_REMINDERS_TARGETS
	return {
		kind,
		targets,
		newTargets: targets.slice(1, -1),
		owner: sla ? 'crm-intake' : 'crm-sales',
		api: targets.at(-1),
		flag: sla ? 'CRM_INTAKE_SLA_ENABLED' : 'CRM_TASK_REMINDERS_ENABLED',
		prefix: sla ? 'wincrm-intake-sla-' : 'wincrm-task-reminder-'
	}
}
const stable = value =>
	JSON.stringify(value, (_, item) =>
		item && typeof item === 'object' && !Array.isArray(item)
			? Object.fromEntries(
					Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
				)
			: item
	)
const hash = value => createHash('sha256').update(value).digest('hex')
const digest = value => hash(stable(value))
const isHash = value =>
	typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const isRevision = value =>
	typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const keyOf = row =>
	`${row.Config?.Labels?.['com.docker.compose.project']}/${row.Config?.Labels?.['com.docker.compose.service']}`
const protectedCall = action => {
	try {
		return action()
	} catch {
		throw new Error(
			'CRM reminders activation rejected; private details suppressed'
		)
	}
}
function exact(value, keys) {
	assert.ok(value && typeof value === 'object' && !Array.isArray(value))
	assert.deepEqual(Object.keys(value).sort(), [...keys].sort())
}
function environment(entries) {
	assert.ok(Array.isArray(entries))
	const result = {}
	for (const entry of entries) {
		assert.equal(typeof entry, 'string')
		const split = entry.indexOf('='),
			key = entry.slice(0, split)
		assert.ok(
			split > 0 &&
				/^[A-Z_][A-Z0-9_]*$/.test(key) &&
				!Object.hasOwn(result, key)
		)
		result[key] = entry.slice(split + 1)
	}
	return result
}
function hashes(value) {
	exact(value, ['canonical', 'crm', 'notification-delivery'])
	Object.values(value).forEach(value => assert.ok(isHash(value)))
	return {
		canonical: value.canonical,
		crm: value.crm,
		'notification-delivery': value['notification-delivery']
	}
}
function configuration(row) {
	const config = structuredClone(row.Config)
	delete config.Hostname
	delete config.Image
	config.Env = environment(config.Env)
	config.Labels = Object.fromEntries(
		Object.entries(config.Labels).filter(
			([key]) =>
				!key.startsWith('com.docker.compose.') ||
				[
					'com.docker.compose.project',
					'com.docker.compose.service',
					'com.docker.compose.oneoff',
					'com.docker.compose.container-number'
				].includes(key)
		)
	)
	return {
		name: row.Name,
		config,
		host: row.HostConfig,
		mounts: [...row.Mounts].sort((a, b) =>
			a.Destination.localeCompare(b.Destination)
		)
	}
}
function running(row, healthy = true) {
	assert.ok(
		row && isHash(row.Id) && /^sha256:[a-f0-9]{64}$/.test(row.Image)
	)
	for (const flag of ['Paused', 'Restarting', 'OOMKilled', 'Dead'])
		assert.equal(row.State[flag], false)
	assert.equal(row.RestartCount, 0)
	if (healthy) {
		assert.equal(row.State.Running, true)
		assert.equal(row.State.Health.Status, 'healthy')
	} else if (row.State.Running)
		assert.ok(['starting', 'healthy'].includes(row.State.Health.Status))
	else assert.equal(row.State.Pid, 0)
	assert.ok(Number.isFinite(Date.parse(row.State.StartedAt)))
}
function inventory(live) {
	assert.ok(Array.isArray(live) && live.length > 2 && live.length <= 200)
	assert.equal(new Set(live.map(keyOf)).size, live.length)
	assert.equal(new Set(live.map(row => row.Id)).size, live.length)
	for (const row of live) {
		assert.ok(
			['winwidget', 'winwidget-crm'].includes(
				row.Config?.Labels?.['com.docker.compose.project']
			)
		)
		assert.match(
			row.Config.Labels['com.docker.compose.service'],
			/^[a-z][a-z0-9-]*$/
		)
	}
}
const neighbors = (live, revision, kind = KIND) =>
	crmNeighborFingerprint(
		live.filter(
			row => !crmActivationSpec(kind).targets.includes(keyOf(row))
		),
		revision
	)
function baselineShape(value) {
	const {
		kind: KIND,
		targets: CRM_REMINDERS_TARGETS,
		newTargets,
		api
	} = crmActivationSpec(value?.kind)

	exact(value, [
		'schemaVersion',
		'kind',
		'gatewayRevision',
		'environmentHashes',
		'neighborsSha256',
		'targets'
	])
	assert.equal(value.schemaVersion, 1)
	assert.equal(value.kind, KIND + '.baseline')
	assert.ok(
		isRevision(value.gatewayRevision) && isHash(value.neighborsSha256)
	)
	hashes(value.environmentHashes)
	exact(value.targets, CRM_REMINDERS_TARGETS)
	for (const [key, row] of Object.entries(value.targets)) {
		exact(
			row,
			newTargets.includes(key)
				? ['absent', 'image', 'revision']
				: ['id', 'image', 'revision', 'startedAt', 'configurationSha256']
		)
		assert.match(row.image, /^sha256:[a-f0-9]{64}$/)
		assert.ok(isRevision(row.revision))
		if (newTargets.includes(key)) assert.equal(row.absent, true)
		else {
			assert.ok(isHash(row.id) && isHash(row.configurationSha256))
			assert.ok(Number.isFinite(Date.parse(row.startedAt)))
		}
	}
	for (const key of newTargets) {
		assert.equal(value.targets[key].image, value.targets[api].image)
		assert.equal(value.targets[key].revision, value.targets[api].revision)
	}
}
export function crmRemindersBaseline(
	live,
	gatewayRevision,
	environmentHashes,
	kind = KIND
) {
	return protectedCall(() => {
		const {
			kind: KIND,
			targets: CRM_REMINDERS_TARGETS,
			newTargets,
			api
		} = crmActivationSpec(kind)
		inventory(live)
		hashes(environmentHashes)
		if (KIND === CRM_INTAKE_SLA_ACTIVATION_KIND) {
			for (const [name, role] of [
				['crm-sales-api', 'api'],
				['crm-sales-reminders', 'reminders']
			]) {
				const row = live.find(
					row => keyOf(row) === 'winwidget-crm/' + name
				)
				running(row)
				assert.equal(
					environment(row.Config.Env).CRM_TASK_REMINDERS_ENABLED,
					'true'
				)
				assert.equal(
					environment(row.Config.Env).CRM_SALES_PROCESS_ROLE,
					role
				)
			}
		}
		assert.equal(
			live.some(row => newTargets.includes(keyOf(row))),
			false
		)
		const targets = {}
		for (const key of CRM_REMINDERS_TARGETS.filter(
			key => !newTargets.includes(key)
		)) {
			const row = live.find(row => keyOf(row) === key)
			running(row)
			const revision = environment(row.Config.Env).APP_REVISION
			assert.ok(isRevision(revision))
			assert.equal(
				row.Config.Labels['org.opencontainers.image.revision'],
				revision
			)
			targets[key] = {
				id: row.Id,
				image: row.Image,
				revision,
				startedAt: row.State.StartedAt,
				configurationSha256: digest(configuration(row))
			}
		}
		for (const key of newTargets)
			targets[key] = {
				absent: true,
				image: targets[api].image,
				revision: targets[api].revision
			}
		const result = {
			schemaVersion: 1,
			kind: KIND + '.baseline',
			gatewayRevision,
			environmentHashes: hashes(environmentHashes),
			neighborsSha256: neighbors(live, gatewayRevision, KIND),
			targets
		}
		baselineShape(result)
		return result
	})
}
function serviceConfiguration(service, row, image) {
	const permitted = [
		'image',
		'build',
		'depends_on',
		'profiles',
		'environment',
		'labels',
		'user',
		'network_mode',
		'extra_hosts',
		'read_only',
		'privileged',
		'pid',
		'cap_add',
		'cap_drop',
		'security_opt',
		'restart',
		'mem_limit',
		'mem_reservation',
		'memswap_limit',
		'cpus',
		'pids_limit',
		'logging',
		'ports',
		'devices',
		'volumes',
		'secrets',
		'tmpfs',
		'healthcheck',
		'stop_grace_period',
		'entrypoint',
		'command',
		'init'
	]
	assert.ok(Object.keys(service).every(key => permitted.includes(key)))
	for (const field of ['ports', 'devices', 'volumes', 'secrets'])
		assert.equal(service[field]?.length ?? 0, 0)
	assertServiceConfiguration(service, row, image, {})
	assert.equal(Boolean(service.init), Boolean(row.HostConfig.Init))
	assert.equal(
		row.HostConfig.MemorySwap,
		service.memswap_limit === undefined
			? 2 * Number(service.mem_limit ?? 0)
			: Number(service.memswap_limit)
	)
	assert.equal(row.Config.WorkingDir, image.Config.WorkingDir)
	assert.ok(
		Object.keys(service.labels ?? {}).every(
			key => !key.startsWith('com.docker.compose.')
		)
	)
	assert.equal(
		stable(
			Object.fromEntries(
				Object.entries(row.Config.Labels).filter(
					([key]) => !key.startsWith('com.docker.compose.')
				)
			)
		),
		stable({ ...image.Config.Labels, ...service.labels })
	)
	for (const field of [
		'Devices',
		'DeviceRequests',
		'VolumesFrom',
		'Links'
	])
		assert.equal(row.HostConfig[field]?.length ?? 0, 0)
	assert.equal(Object.keys(row.HostConfig.PortBindings ?? {}).length, 0)
}
function imageShape(image, owner, previous) {
	assert.equal(image.Id, previous.image)
	assert.equal(image.Os, 'linux')
	assert.ok(['amd64', 'arm64'].includes(image.Architecture))
	assert.equal(
		image.Config.Labels['org.opencontainers.image.revision'],
		previous.revision
	)
	// Legacy ND images do not carry the later per-service title label.
	if (owner !== 'notification-delivery')
		assert.equal(
			image.Config.Labels['org.opencontainers.image.title'],
			'winwidget-' + owner
		)
	for (const key of [
		'CRM_INTAKE_SLA_ENABLED',
		'CRM_INTAKE_NOTIFICATION_DELIVERY_TOKEN',
		'NOTIFICATION_DELIVERY_CRM_INTAKE_TOKEN',
		'CRM_INTAKE_SLA_RABBITMQ_URL',
		'CRM_TASK_REMINDERS_ENABLED',
		'CRM_SALES_NOTIFICATION_DELIVERY_TOKEN',
		'NOTIFICATION_DELIVERY_CRM_SALES_TOKEN',
		'RABBITMQ_URL'
	])
		assert.equal(
			Object.hasOwn(environment(image.Config.Env ?? []), key),
			false
		)
}

// PRIVATE plan: all materialized environments stay in the locked 0600 journal.
export function prepareCrmRemindersActivation(
	{ live, baseline, configs, images, environmentHashes },
	validateReminderDeployment
) {
	return protectedCall(() => {
		baselineShape(baseline)
		const spec = crmActivationSpec(baseline.kind)
		const { kind: KIND, targets: CRM_REMINDERS_TARGETS, newTargets } = spec
		assert.equal(
			stable(
				crmRemindersBaseline(
					live,
					baseline.gatewayRevision,
					environmentHashes,
					KIND
				)
			),
			stable(baseline)
		)
		exact(configs, [
			'crmBefore',
			'crmAfter',
			'notificationBefore',
			'notificationAfter'
		])
		assert.equal(typeof validateReminderDeployment, 'function')
		validateReminderDeployment(configs)
		assert.deepEqual(
			images.map(row => row.Id).sort(),
			[
				...new Set(Object.values(baseline.targets).map(row => row.image))
			].sort()
		)
		const desired = {
				winwidget: { name: 'winwidget', services: {} },
				'winwidget-crm': { name: 'winwidget-crm', services: {} }
			},
			targets = {}
		for (const key of CRM_REMINDERS_TARGETS) {
			const [project, name] = key.split('/'),
				previous = baseline.targets[key]
			const image = images.find(row => row.Id === previous.image),
				owner =
					project === 'winwidget' ? 'notification-delivery' : spec.owner
			imageShape(image, owner, previous)
			const prefix = project === 'winwidget' ? 'notification' : 'crm',
				before = configs[prefix + 'Before'],
				after = configs[prefix + 'After']
			assert.equal(before.name, project)
			assert.equal(after.name, project)
			const service = structuredClone(after.services[name])
			assert.equal(service.image, previous.image)
			assert.equal(service.environment.APP_REVISION, previous.revision)
			const effective = {
				...environment(image.Config.Env ?? []),
				...service.environment
			}
			if (!newTargets.includes(key)) {
				const row = live.find(row => keyOf(row) === key),
					oldService = before.services[name]
				assert.equal(oldService.image, previous.image)
				serviceConfiguration(oldService, row, image)
				assert.equal(
					stable({
						...environment(image.Config.Env ?? []),
						...oldService.environment
					}),
					stable(environment(row.Config.Env))
				)
				if (owner === spec.owner)
					assert.equal(
						oldService.environment[spec.flag] ?? 'false',
						'false'
					)
				else
					assert.equal(
						oldService.environment.NOTIFICATION_DELIVERY_KINDS.split(
							','
						).some(kind => kind.trim().startsWith(spec.prefix)),
						false
					)
				const candidate = structuredClone(row)
				candidate.Config.Env = Object.entries(effective).map(
					([key, value]) => key + '=' + value
				)
				serviceConfiguration(service, candidate, image)
				targets[key] = {
					...previous,
					desiredConfigurationSha256: digest(configuration(candidate))
				}
			} else targets[key] = { ...previous }
			delete service.build
			delete service.depends_on
			delete service.profiles
			desired[project].services[name] = service
		}
		return {
			schemaVersion: 1,
			kind: KIND,
			baselineSha256: digest(baseline),
			environmentHashes: hashes(environmentHashes),
			targets,
			desired,
			images: structuredClone(images)
		}
	})
}
export function crmRemindersPlanDigest(plan) {
	return protectedCall(() => {
		const { kind: KIND, targets: CRM_REMINDERS_TARGETS } =
			crmActivationSpec(plan?.kind)
		exact(plan, [
			'schemaVersion',
			'kind',
			'baselineSha256',
			'environmentHashes',
			'targets',
			'desired',
			'images'
		])
		assert.equal(plan.schemaVersion, 1)
		assert.equal(plan.kind, KIND)
		assert.ok(isHash(plan.baselineSha256))
		hashes(plan.environmentHashes)
		exact(plan.targets, CRM_REMINDERS_TARGETS)
		return digest(plan)
	})
}
function newConfiguration(row, plan, key) {
	const service =
			plan.desired['winwidget-crm'].services[key.split('/')[1]],
		image = plan.images.find(image => image.Id === plan.targets[key].image)
	serviceConfiguration(service, row, image)
	assert.equal(
		stable(environment(row.Config.Env)),
		stable({
			...environment(image.Config.Env ?? []),
			...service.environment
		})
	)
	assert.equal(row.Name, '/winwidget-crm-' + key.split('/')[1] + '-1')
	assert.equal(row.Config.Labels['com.docker.compose.oneoff'], 'False')
	assert.equal(
		row.Config.Labels['com.docker.compose.container-number'],
		'1'
	)
}
export function assertCrmRemindersProgress(live, baseline, plan, state) {
	return protectedCall(() => {
		inventory(live)
		baselineShape(baseline)
		const {
			kind: KIND,
			targets: CRM_REMINDERS_TARGETS,
			newTargets
		} = crmActivationSpec(baseline.kind)
		assert.equal(plan.kind, KIND)
		const planSha256 = crmRemindersPlanDigest(plan)
		assert.equal(plan.baselineSha256, digest(baseline))
		exact(state, ['admission', 'completed', 'switching'])
		assert.equal(
			neighbors(live, baseline.gatewayRevision, KIND),
			baseline.neighborsSha256
		)
		const done = Object.keys(state.completed)
		assert.deepEqual(
			[...done].sort(),
			CRM_REMINDERS_TARGETS.slice(0, done.length).sort()
		)
		if (state.admission === null) {
			assert.equal(done.length, 0)
			assert.equal(state.switching, null)
		} else {
			exact(state.admission, ['schemaVersion', 'kind', 'planSha256'])
			assert.equal(state.admission.schemaVersion, 1)
			assert.equal(state.admission.kind, KIND + '.admission')
			assert.equal(state.admission.planSha256, planSha256)
			assert.ok(
				state.switching === null ||
					state.switching === CRM_REMINDERS_TARGETS[done.length]
			)
		}
		for (const key of CRM_REMINDERS_TARGETS) {
			const row = live.find(row => keyOf(row) === key),
				old = baseline.targets[key],
				complete = Object.hasOwn(state.completed, key),
				switching = key === state.switching
			if (!row) {
				assert.ok(!complete && (newTargets.includes(key) || switching))
				continue
			}
			assert.equal(row.Image, old.image)
			assert.equal(environment(row.Config.Env).APP_REVISION, old.revision)
			assert.equal(
				row.Config.Labels['org.opencontainers.image.revision'],
				old.revision
			)
			if (newTargets.includes(key)) {
				assert.ok(complete || switching)
				newConfiguration(row, plan, key)
			}
			if (complete) {
				exact(state.completed[key], ['id', 'startedAt'])
				assert.notEqual(row.Id, old.id)
				assert.equal(row.Id, state.completed[key].id)
				assert.equal(row.State.StartedAt, state.completed[key].startedAt)
				if (!newTargets.includes(key))
					assert.equal(
						digest(configuration(row)),
						plan.targets[key].desiredConfigurationSha256
					)
				running(row)
			} else if (switching) {
				running(row, false)
				if (!newTargets.includes(key)) {
					assert.equal(
						digest(configuration(row)),
						row.Id === old.id
							? old.configurationSha256
							: plan.targets[key].desiredConfigurationSha256
					)
					if (row.Id === old.id)
						assert.equal(row.State.StartedAt, old.startedAt)
				}
			} else {
				assert.equal(row.Id, old.id)
				assert.equal(row.State.StartedAt, old.startedAt)
				assert.equal(digest(configuration(row)), old.configurationSha256)
				running(row)
			}
		}
		return {
			complete: done.length === CRM_REMINDERS_TARGETS.length,
			next: CRM_REMINDERS_TARGETS[done.length] ?? null,
			recovery: state.admission === null ? 'PRE_ADMISSION' : 'FORWARD_ONLY'
		}
	})
}
