import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { parseEnv } from 'node:util'
import { pathToFileURL } from 'node:url'
import {
	crmBrokerContract,
	provisionCrmBrokerPrincipals,
	readCrmBrokerSnapshot
} from './crm-broker-topology.mjs'

const serviceNames = [
	'notification-delivery',
	'campaigns',
	'reporting',
	'widgets',
	'billing-worker',
	'billing-publisher',
	'identity-worker',
	'identity-publisher',
	'platform-publisher',
	'support-worker',
	'support-publisher',
	'operations-worker',
	'operations-restore-worker',
	'operations-publisher'
]
const digest = value => createHash('sha256').update(value).digest('hex')
const strong = value =>
	typeof value === 'string' && /^[a-f0-9]{48,128}$/.test(value)

// Fixed same-VPS boundary. Neither endpoint discovery nor arbitrary URLs may
// redirect the root-only bootstrap credentials to another host.
export function crmBrokerInputs(canonical, crm, providerPassword) {
	try {
		assert.ok(
			['disabled', 'mvp-v1'].includes(
				canonical.CRM_RABBITMQ_CONTRACT ?? 'disabled'
			)
		)
		assert.equal(canonical.RABBITMQ_VHOST, 'winwidget')
		assert.equal(
			canonical.RABBITMQ_MANAGEMENT_URL,
			'http://127.0.0.1:15672'
		)
		for (const key of [
			'CRM_ACCESS_BILLING_ENABLED',
			'CRM_INTAKE_WIDGETS_ENABLED',
			'CRM_INTAKE_WIDGET_TRANSFERS_ENABLED'
		])
			assert.equal(crm[key], 'false')
		for (const key of [
			'BILLING_WINCRM_PAYMENTS_ENABLED',
			'WIDGETS_WINCRM_CONNECTOR_ENABLED',
			'WINCRM_INVITATION_EMAIL_ENABLED'
		])
			assert.equal(canonical[key] ?? 'false', 'false')
		const legacyPrincipals = [
			canonical.RABBITMQ_ADMIN_USER,
			canonical.RABBITMQ_MONITOR_USER
		]
		assert.ok(
			legacyPrincipals.every(
				name =>
					typeof name === 'string' && /^[a-z][a-z0-9-]{0,99}$/.test(name)
			)
		)
		assert.ok(
			typeof canonical.RABBITMQ_ADMIN_PASSWORD === 'string' &&
				canonical.RABBITMQ_ADMIN_PASSWORD.length >= 24
		)
		const parse = (raw, name) => {
			const url = new URL(raw)
			assert.equal(url.protocol, 'amqp:')
			assert.equal(url.hostname, '127.0.0.1')
			assert.ok(['', '5672'].includes(url.port))
			assert.equal(url.pathname, '/winwidget')
			assert.equal(url.username, name)
			assert.ok(url.password && !url.hash && !url.search)
			return decodeURIComponent(url.password)
		}
		for (const name of serviceNames) {
			const principal = 'winwidget-' + name
			parse(
				canonical[
					'RABBITMQ_' + name.replaceAll('-', '_').toUpperCase() + '_URL'
				],
				principal
			)
			legacyPrincipals.push(principal)
		}
		assert.equal(new Set(legacyPrincipals).size, 16)
		assert.ok(strong(providerPassword))
		const credentials = Object.fromEntries(
			crmBrokerContract().principals.map(({ name }) => [
				name,
				name === 'winwidget-billing-wincrm-provider-worker'
					? providerPassword
					: parse(
							crm[
								name
									.slice('winwidget-'.length)
									.replaceAll('-', '_')
									.toUpperCase() + '_RABBITMQ_URL'
							],
							name
						)
			])
		)
		assert.ok(Object.values(credentials).every(strong))
		assert.equal(new Set(Object.values(credentials)).size, 9)
		assert.ok(
			!Object.values(credentials).includes(
				canonical.RABBITMQ_ADMIN_PASSWORD
			)
		)
		return {
			credentials,
			legacyPrincipals,
			admin: {
				username: canonical.RABBITMQ_ADMIN_USER,
				password: canonical.RABBITMQ_ADMIN_PASSWORD
			}
		}
	} catch {
		throw new Error(
			'Invalid CRM broker bootstrap inputs; private details suppressed'
		)
	}
}

export async function bootstrapCrmBroker({
	inputs,
	connect,
	request,
	assertReleaseFence
}) {
	let connection
	try {
		await assertReleaseFence()
		connection = await connect(
			inputs.admin.username,
			inputs.admin.password
		)
		const channel = await connection.createChannel()
		channel.on('error', () => {})
		return await provisionCrmBrokerPrincipals({
			channel,
			connect,
			request,
			assertReleaseFence,
			credentials: inputs.credentials,
			legacyPrincipals: inputs.legacyPrincipals,
			readSnapshot: () => readCrmBrokerSnapshot(request)
		})
	} finally {
		if (connection) await connection.close()
	}
}

export function createParentFence(input, output, timeoutMs = 15000) {
	assert.ok(
		Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000
	)
	const lines = createInterface({ input, crlfDelay: Infinity })
	const replies = lines[Symbol.asyncIterator]()
	return {
		async check() {
			let timer
			try {
				const next = replies.next()
				output.write('CRM_FENCE\n')
				const reply = await Promise.race([
					next,
					new Promise((_, reject) => {
						timer = setTimeout(
							() => reject(new Error('Parent fence deadline')),
							timeoutMs
						)
					})
				])
				assert.ok(!reply.done && reply.value === 'CRM_FENCE_OK')
			} finally {
				clearTimeout(timer)
			}
		},
		close() {
			lines.close()
			input.pause()
		}
	}
}

// Runs only inside the operator's immutable, root-owned Docker invocation.
// The parent holds the existing production flock for the complete operation,
// verifies all container/image identities before and after, and synchronizes
// the canonical env only after success. No Docker socket is mounted here.
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	let stage = 'boundary'
	let parent
	try {
		assert.equal(process.argv.length, 3)
		assert.equal(process.argv[2], 'provision')
		assert.equal(process.platform, 'linux')
		assert.equal(process.getuid(), 0)
		assert.equal(process.env.CRM_BOOTSTRAP_CONTROLLER_PROTOCOL, 'stdio-v1')
		assert.match(
			process.env.CRM_BOOTSTRAP_IMAGE_REVISION ?? '',
			/^[a-f0-9]{40}$/
		)
		assert.equal(
			process.env.APP_REVISION,
			process.env.CRM_BOOTSTRAP_IMAGE_REVISION
		)
		const paths = {
			canonical: '/run/wincrm/canonical.env',
			crm: '/run/wincrm/crm.env',
			provider: '/run/wincrm/provider-password'
		}
		const checks = Object.entries(paths).map(([name, path]) => {
			const expected =
				process.env['CRM_BOOTSTRAP_' + name.toUpperCase() + '_SHA256']
			assert.match(expected ?? '', /^[a-f0-9]{64}$/)
			return { path, expected }
		})
		const lock = lstatSync('/run/wincrm/deploy.lock')
		assert.ok(lock.isFile() && !lock.isSymbolicLink() && lock.uid === 0)
		parent = createParentFence(process.stdin, process.stdout)
		const deadline = Date.now() + 180_000
		const assertReleaseFence = async () => {
			// A fresh host-side lock/env/image/container check precedes EVERY
			// mutation. Bound file mounts alone cannot detect atomic host renames.
			await parent.check()
			assert.ok(Date.now() < deadline)
			const current = lstatSync('/run/wincrm/deploy.lock')
			assert.equal(current.ino, lock.ino)
			assert.equal(current.dev, lock.dev)
			for (const { path, expected } of checks) {
				const stat = lstatSync(path)
				assert.ok(
					stat.isFile() &&
						!stat.isSymbolicLink() &&
						stat.uid === 0 &&
						stat.gid === 0 &&
						(stat.mode & 0o777) === 0o600
				)
				assert.equal(digest(readFileSync(path)), expected)
			}
		}
		await assertReleaseFence()
		stage = 'inputs'
		const inputs = crmBrokerInputs(
			parseEnv(readFileSync(paths.canonical, 'utf8')),
			parseEnv(readFileSync(paths.crm, 'utf8')),
			readFileSync(paths.provider, 'utf8').replace(/\n$/, '')
		)
		const amqp = createRequire('/app/package.json')('amqplib')
		const connect = async (username, password) => {
			const connection = await amqp.connect(
				{
					protocol: 'amqp',
					hostname: '127.0.0.1',
					port: 5672,
					username,
					password,
					vhost: 'winwidget',
					heartbeat: 10
				},
				{ timeout: 5000 }
			)
			connection.on('error', () => {})
			return connection
		}
		const request = async (path, method = 'GET', body) => {
			assert.ok(['GET', 'PUT'].includes(method))
			assert.match(
				path,
				/^\/api\/(users|permissions|topic-permissions|exchanges|queues|bindings)(?:\/[a-z0-9-]+)*$/
			)
			const response = await fetch('http://127.0.0.1:15672' + path, {
				method,
				redirect: 'error',
				signal: AbortSignal.timeout(5000),
				headers: {
					authorization:
						'Basic ' +
						Buffer.from(
							inputs.admin.username + ':' + inputs.admin.password
						).toString('base64'),
					'content-type': 'application/json'
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) })
			})
			assert.ok(response.ok)
			return method === 'GET' ? response.json() : null
		}
		stage = 'provision'
		const report = await bootstrapCrmBroker({
			inputs,
			connect,
			request,
			assertReleaseFence
		})
		await assertReleaseFence()
		process.stdout.write(JSON.stringify(report) + '\n')
	} catch {
		process.stderr.write(
			'CRM broker bootstrap failed at ' +
				stage +
				'; private details suppressed\n'
		)
		process.exitCode = 1
	} finally {
		parent?.close()
	}
}
