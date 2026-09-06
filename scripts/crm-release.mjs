import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const owners = ['crm-access', 'crm-intake', 'crm-customers', 'crm-sales']
const digest = value => createHash('sha256').update(value).digest('hex')
const revision = value =>
	typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const sha = value =>
	typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const imageId = value =>
	typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)

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
		assert.equal(process.argv.length, 3)
		const mode = process.argv[2]
		if (mode === 'inventory') {
			const input = readFileSync(0, 'utf8')
			assert.ok(Buffer.byteLength(input) <= 8 * 1048576)
			process.stdout.write(
				crmNeighborFingerprint(
					JSON.parse(input),
					process.env.CRM_GATEWAY_REVISION
				) + '\n'
			)
		} else if (mode === 'prepare') {
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
		} else throw new Error('Unsupported mode')
	} catch {
		process.stderr.write(
			'CRM release verification failed; private details suppressed\n'
		)
		process.exitCode = 1
	}
}
