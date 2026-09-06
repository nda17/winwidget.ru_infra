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

export function crmDatabaseResources(
	config,
	validateCompose,
	availableMemory
) {
	const shape = validateCompose(config)
	assert.equal(shape.releaseApproved, false)
	for (const process of Object.values(config.services))
		for (const [key, value] of Object.entries(process.environment ?? {}))
			if (/^CRM_.*(?:ENABLED|CONNECTOR_ENABLED)$/.test(key))
				assert.equal(value, 'false')
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
		if (mode === 'inventory' || mode === 'database-neighbors') {
			assert.equal(process.argv.length, 3)
			const input = readFileSync(0, 'utf8')
			assert.ok(Buffer.byteLength(input) <= 8 * 1048576)
			process.stdout.write(
				(mode === 'inventory'
					? crmNeighborFingerprint
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
