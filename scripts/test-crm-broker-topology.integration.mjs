import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import {
	crmBrokerContract,
	readCrmBrokerSnapshot,
	provisionCrmBrokerPrincipals
} from './crm-broker-topology.mjs'

const image =
	'rabbitmq:4.2.9-management-alpine@sha256:0ab90fc05c41e9d2d8f11af5036e466c364adf5085ed83c477ab41aec0bdde86'
const contract = crmBrokerContract()
const runId = randomBytes(6).toString('hex')
const name = 'wincrm-broker-contract-' + runId
const user = 'crm-contract-admin'
const password = randomBytes(32).toString('hex')
const mode = process.argv[2]
let stage = 'local-boundary'
let id
let dockerContext
let lastSnapshot
const connections = new Set()
const exec = (args, env = {}) =>
	execFileSync('docker', args, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 120000,
		env: { ...process.env, ...env }
	}).trim()
const docker = (args, env) =>
	exec(['--context', dockerContext, ...args], env)
const pause = milliseconds =>
	new Promise(resolve => setTimeout(resolve, milliseconds))
const wait = async (probe, seconds = 30) => {
	const end = Date.now() + seconds * 1000
	do {
		if (await probe()) return
		await pause(250)
	} while (Date.now() < end)
	throw new Error('Fixture deadline')
}
let failed = false
try {
	assert.equal(process.argv.length, 3)
	assert.ok(['--local', '--ci'].includes(mode))
	assert.ok(!process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT)
	dockerContext = exec(['context', 'show'])
	const socket = exec([
		'context',
		'inspect',
		dockerContext,
		'--format',
		'{{.Endpoints.docker.Host}}'
	])
	if (mode === '--local') {
		assert.equal(dockerContext, 'colima')
		assert.equal(
			socket,
			'unix://' + homedir() + '/.colima/default/docker.sock'
		)
		assert.equal(docker(['info', '--format', '{{.Name}}']), 'colima')
	} else {
		assert.equal(process.env.CI, 'true')
		assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
		assert.equal(process.env.GITHUB_REPOSITORY, 'nda17/winwidget.ru_infra')
		assert.equal(dockerContext, 'default')
		assert.equal(socket, 'unix:///var/run/docker.sock')
	}
	assert.equal(
		docker(['ps', '-aq']),
		'',
		'Test requires an empty local daemon'
	)
	const amqp = createRequire(process.env.CRM_BROKER_TEST_PACKAGE_JSON)(
		'amqplib'
	)
	stage = 'pull-pinned-fixture'
	console.log('CRM broker test: ' + stage)
	docker(['pull', image])
	stage = 'start-owned-broker'
	id = docker(
		[
			'run',
			'-d',
			'--name',
			name,
			'--label',
			'winwidget.test=crm-broker-contract',
			'--label',
			'winwidget.test.run=' + runId,
			'--memory=512m',
			'--memory-swap=512m',
			'--cpus=1',
			'-p',
			'127.0.0.1::5672',
			'-p',
			'127.0.0.1::15672',
			'-e',
			'RABBITMQ_DEFAULT_USER=' + user,
			'-e',
			'RABBITMQ_DEFAULT_PASS',
			'-e',
			'RABBITMQ_DEFAULT_VHOST=winwidget',
			'-e',
			'RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS=+S 2:2',
			image
		],
		{ RABBITMQ_DEFAULT_PASS: password }
	)
	assert.match(id, /^[a-f0-9]{64}$/)
	const inspect = () => JSON.parse(docker(['inspect', id]))[0]
	const owned = () => {
		const value = inspect()
		assert.equal(value.Id, id)
		assert.equal(value.Name, '/' + name)
		assert.equal(value.Config.Image, image)
		assert.equal(value.Config.Labels['winwidget.test.run'], runId)
		assert.equal(value.State.OOMKilled, false)
		return value
	}
	const ports = owned().NetworkSettings.Ports
	const port = key => {
		assert.equal(ports[key].length, 1)
		assert.equal(ports[key][0].HostIp, '127.0.0.1')
		const value = Number(ports[key][0].HostPort)
		assert.ok(
			Number.isSafeInteger(value) && value > 1024 && value <= 65535
		)
		return value
	}
	const amqpPort = port('5672/tcp')
	const httpOrigin = 'http://127.0.0.1:' + port('15672/tcp')
	const request = async (path, method = 'GET', body) => {
		const result = await fetch(httpOrigin + path, {
			method,
			redirect: 'error',
			signal: AbortSignal.timeout(3000),
			headers: {
				authorization:
					'Basic ' + Buffer.from(user + ':' + password).toString('base64'),
				'content-type': 'application/json'
			},
			...(body ? { body: JSON.stringify(body) } : {})
		})
		assert.ok(result.ok, 'Fixture HTTP failed')
		return method === 'GET' ? result.json() : null
	}
	await wait(async () => {
		try {
			await request('/api/overview')
			return true
		} catch {
			return false
		}
	}, 90)
	const connect = async (username, secret) => {
		const value = await amqp.connect(
			{
				protocol: 'amqp',
				hostname: '127.0.0.1',
				port: amqpPort,
				username,
				password: secret,
				vhost: 'winwidget',
				heartbeat: 10
			},
			{ timeout: 10000 }
		)
		value.on('error', () => {})
		connections.add(value)
		value.once('close', () => connections.delete(value))
		return value
	}
	const admin = await connect(user, password)
	const channel = await admin.createConfirmChannel()
	channel.on('error', () => {})
	for (const item of contract.exchanges.filter(item => !item.owned))
		await channel.assertExchange(item.name, item.type, { durable: true })
	const legacyPrincipals = [
		user,
		...Array.from({ length: 15 }, (_, index) => 'legacy-contract-' + index)
	]
	for (const name of legacyPrincipals.slice(1)) {
		await request('/api/users/' + name, 'PUT', {
			password: randomBytes(32).toString('hex'),
			tags: ''
		})
		await request('/api/permissions/winwidget/' + name, 'PUT', {
			configure: '^$',
			write: '^$',
			read: '^$'
		})
	}
	const credentials = Object.fromEntries(
		contract.principals.map(item => [
			item.name,
			randomBytes(32).toString('hex')
		])
	)
	const readSnapshot = async () => {
		lastSnapshot = await readCrmBrokerSnapshot(request)
		return lastSnapshot
	}
	const options = {
		channel,
		request,
		connect,
		credentials,
		legacyPrincipals,
		readSnapshot,
		assertReleaseFence: async () => {
			assert.equal(owned().State.Running, true)
			assert.equal(docker(['ps', '-aq', '--no-trunc']), id)
		}
	}
	stage = 'first-provision'
	console.log('CRM broker test: ' + stage)
	const first = await provisionCrmBrokerPrincipals(options)
	const identities = await request('/api/users')
	const publish = async (target, exchange, routingKey) => {
		let returned = false
		const onReturn = () => {
			returned = true
		}
		target.on('return', onReturn)
		try {
			await new Promise((resolve, reject) =>
				target.publish(
					exchange,
					routingKey,
					Buffer.from(JSON.stringify({ synthetic: true, runId })),
					{ persistent: true, mandatory: true },
					error =>
						error
							? reject(new Error('Synthetic confirm failed'))
							: resolve()
				)
			)
			await new Promise(resolve => setImmediate(resolve))
			assert.equal(returned, false, 'Synthetic event was returned')
		} finally {
			target.off('return', onReturn)
		}
	}
	for (const item of contract.queues) await publish(channel, '', item.name)
	for (const item of contract.queues)
		assert.equal((await channel.checkQueue(item.name)).messageCount, 1)
	stage = 'idempotent-preservation'
	assert.deepEqual(await provisionCrmBrokerPrincipals(options), first)
	assert.deepEqual(await request('/api/users'), identities)
	stage = 'resume-interrupted-principal'
	await request(
		'/api/permissions/winwidget/' + contract.principals[0].name,
		'DELETE'
	)
	assert.deepEqual(await provisionCrmBrokerPrincipals(options), first)
	assert.deepEqual(await request('/api/users'), identities)
	stage = 'reject-credential-drift-without-rotation'
	await assert.rejects(
		provisionCrmBrokerPrincipals({
			...options,
			credentials: {
				...credentials,
				[contract.principals[0].name]: randomBytes(32).toString('hex')
			}
		}),
		/^Error: CRM broker bootstrap failed at preflight$/
	)
	assert.deepEqual(await request('/api/users'), identities)
	for (const item of contract.queues)
		assert.equal((await channel.checkQueue(item.name)).messageCount, 1)
	stage = 'least-privilege-push-and-confirm'
	const subscriptions = []
	let received = 0
	const runtime = new Map()
	for (const principal of contract.principals) {
		const connection = await connect(
			principal.name,
			credentials[principal.name]
		)
		const consumerChannel = await connection.createConfirmChannel()
		consumerChannel.on('error', () => {})
		runtime.set(principal.name, consumerChannel)
		if (principal.name.endsWith('worker')) {
			for (const item of contract.queues.filter(item =>
				new RegExp(principal.read).test(item.name)
			)) {
				const subscription = await consumerChannel.consume(
					item.name,
					message => {
						if (message) {
							received++
							consumerChannel.ack(message)
						}
					},
					{ noAck: false }
				)
				subscriptions.push({
					channel: consumerChannel,
					tag: subscription.consumerTag
				})
			}
		}
		// The rejected operation closes only this sacrificial channel.
		const forbidden = await connection.createChannel()
		forbidden.on('error', () => {})
		await assert.rejects(
			forbidden.assertQueue('winwidget.foreign-contract-test', {
				durable: true
			})
		)
	}
	assert.equal(subscriptions.length, 7)
	await wait(() => received === 7)
	for (const principal of contract.principals.filter(
		item => !item.name.endsWith('worker')
	)) {
		const topic = principal.topics.find(
			item => item.exchange === 'winwidget.events'
		)
		const routes = contract.bindings.filter(
			item =>
				!item.destination.endsWith('.dead-letter') &&
				new RegExp(principal.write).test(item.source) &&
				(!topic ||
					(item.source === topic.exchange &&
						new RegExp(topic.write).test(item.routing_key)))
		)
		assert.ok(routes.length > 0)
		for (const route of routes)
			await publish(
				runtime.get(principal.name),
				route.source,
				route.routing_key
			)
	}
	await wait(() => received === 12)
	for (const subscription of subscriptions)
		await subscription.channel.cancel(subscription.tag)
	for (const item of contract.queues.filter(item =>
		item.name.endsWith('.dead-letter')
	))
		assert.equal(
			(await channel.checkQueue(item.name)).messageCount,
			1,
			'DLQ synthetic data must remain untouched'
		)
	await channel.close()
	console.log(
		JSON.stringify({
			localFixtureOnly: true,
			topologyVerified: true,
			repeatedProvisionPreservedMessages: 14,
			scopedPrincipalsVerified: 9,
			legacyPrincipalsPreserved: 16,
			interruptedGrantResumed: true,
			wrongCredentialRejectedWithoutRotation: true,
			pushConsumersVerified: 7,
			confirmedPublicationsDelivered: 5,
			unrelatedConfigureDenied: 9,
			productionTouched: false,
			contractSha256: first.contractSha256
		})
	)
} catch (error) {
	failed = true
	console.error(
		'CRM broker integration failed at ' +
			stage +
			'; private details suppressed'
	)
	if (
		/^CRM (topology provisioning|broker bootstrap) failed at (preflight|declare-exchanges|declare-queues|bind-queues|verify|topology|principals|authenticate)$/.test(
			error?.message ?? ''
		)
	)
		console.error(error.message)
	if (lastSnapshot)
		console.error(
			JSON.stringify({
				knownExchanges: lastSnapshot.exchanges
					.filter(item =>
						contract.exchanges.some(wanted => wanted.name === item.name)
					)
					.map(item => ({
						name: item.name,
						durable: item.durable === true,
						autoDelete: item.auto_delete === true,
						internal: item.internal === true,
						knownType: ['direct', 'topic'].includes(item.type),
						argumentCount: Object.keys(item.arguments ?? {}).length
					})),
				knownQueues: lastSnapshot.queues
					.filter(item =>
						contract.queues.some(wanted => wanted.name === item.name)
					)
					.map(item => ({
						name: item.name,
						durable: item.durable === true,
						autoDelete: item.auto_delete === true,
						exclusive: item.exclusive === true,
						consumersType: typeof item.consumers,
						argumentCount: Object.keys(item.arguments ?? {}).length,
						policyCount: Object.keys(
							item.effective_policy_definition ?? {}
						).length
					})),
				bindingsCount: lastSnapshot.bindings.length
			})
		)
} finally {
	for (const connection of [...connections].reverse()) {
		try {
			await connection.close()
		} catch {
			failed = true
		}
	}
	if (id) {
		try {
			const value = JSON.parse(docker(['inspect', id]))[0]
			assert.equal(value.Id, id)
			assert.equal(value.Name, '/' + name)
			assert.equal(value.Config.Labels['winwidget.test.run'], runId)
			assert.equal(value.Config.Image, image)
			docker(['stop', '--time', '30', id])
			const stopped = JSON.parse(docker(['inspect', id]))[0]
			assert.equal(stopped.State.OOMKilled, false)
			assert.equal(stopped.State.ExitCode, 0)
			docker(['rm', '-v', id])
			assert.equal(docker(['ps', '-aq']), '')
			console.log(
				'Owned synthetic RabbitMQ container and anonymous volumes removed'
			)
		} catch {
			failed = true
			console.error(
				'Owned RabbitMQ cleanup requires inspection; details suppressed'
			)
		}
	}
	process.exitCode = failed ? 1 : 0
}
