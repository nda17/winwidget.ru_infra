import assert from 'node:assert/strict'
import test from 'node:test'
import { crmIntakeSlaNotificationAcl, crmIntakeSlaNotificationTopology } from './crm-intake-sla-broker-topology.mjs'
import { SUPPORT_CHAT_KINDS, SUPPORT_CHAT_OUTCOME, SUPPORT_CHAT_OUTCOME_QUEUE, finitePermission, exactPermission,
	extendSupportChatPermissions, supportChatTopology, provisionSupportChatBroker, verifySupportChatBroker } from './support-chat-broker.mjs'

function fixture() {
	const nd = crmIntakeSlaNotificationAcl(crmIntakeSlaNotificationTopology())
	const worker = { configure: '^(winwidget\\.(events|retry|dead-letter|manual-retry)|winwidget\\.support\\.telegram-webhook\\.v1(\\.retry-v2\\.[123]|\\.dead-letter)?)$',
		read: '^(winwidget\\.(events|retry|dead-letter|manual-retry)|winwidget\\.support\\.telegram-webhook\\.v1(\\.retry-v2\\.[123]|\\.dead-letter)?)$',
		write: '^winwidget\\.support\\.telegram-webhook\\.v1(\\.retry-v2\\.[123]|\\.dead-letter)?$',
		topics: [{ exchange: 'winwidget.events', read: '^support\\.telegram\\.webhook-admitted\\.v1$', write: '^$' }] }
	const publisher = { configure: '^$', read: '^$', write: '^winwidget\\.(events|retry|dead-letter|manual-retry)$',
		topics: [{ exchange: 'winwidget.events', read: '^$', write: '^(support\\.telegram\\.webhook-admitted\\.v1|admin\\.audit\\.support\\.v1)$' },
			{ exchange: 'winwidget.dead-letter', read: '^$', write: '^support-telegram-webhook\\.dead-letter$' }] }
	const owners = [['winwidget-notification-delivery', nd], ['winwidget-support-worker', worker], ['winwidget-support-publisher', publisher]]
	return {
		exchanges: ['events', 'retry', 'dead-letter', 'manual-retry'].map(name => ({ name: 'winwidget.' + name, type: ['events', 'dead-letter'].includes(name) ? 'topic' : 'direct', durable: true, auto_delete: false })),
		queues: [{ name: 'unrelated', durable: true, auto_delete: false, arguments: {}, messages: 9, consumers: 1 }], bindings: [],
		permissions: [...owners.map(([user, { configure, read, write }]) => ({ user, vhost: 'winwidget', configure, read, write })), { user: 'unrelated', vhost: 'winwidget', configure: '.*', read: '.*', write: '.*' }],
		topic_permissions: owners.flatMap(([user, { topics }]) => topics.map(row => ({ user, vhost: 'winwidget', ...row })))
	}
}
test('finite ACL extension preserves every previous permission and fits RabbitMQ 1KiB limits', () => {
	const before = fixture(), after = extendSupportChatPermissions(before)
	for (const row of before.permissions.filter(row => row.user !== 'unrelated')) {
		const next = after.permissions.find(item => item.user === row.user)
		for (const key of ['configure', 'read', 'write']) {
			assert.ok(Buffer.byteLength(next[key]) <= 1024)
			for (const value of finitePermission(row[key])) assert.ok(finitePermission(next[key]).includes(value))
		}
	}
	const nd = after.permissions.find(row => row.user === 'winwidget-notification-delivery')
	const worker = after.permissions.find(row => row.user === 'winwidget-support-worker')
	assert.ok(new RegExp(worker.write).test('winwidget.manual-retry'))
	assert.ok(!new RegExp(nd.read).test(SUPPORT_CHAT_OUTCOME_QUEUE))
	for (const [, name] of SUPPORT_CHAT_KINDS) assert.ok(new RegExp(nd.read).test(name))
	const publisher = after.topic_permissions.find(row => row.user === 'winwidget-support-publisher' && row.exchange === 'winwidget.events')
	assert.ok(!new RegExp(publisher.write).test(SUPPORT_CHAT_OUTCOME))
	for (const [, , event] of SUPPORT_CHAT_KINDS) assert.ok(new RegExp(publisher.write).test(event))
	assert.deepEqual(after.permissions.find(row => row.user === 'unrelated'), before.permissions.find(row => row.user === 'unrelated'))
	assert.deepEqual(extendSupportChatPermissions(after), after)
})
test('ACL decoder rejects all unbounded or ambiguous regex constructions', () => {
	for (const pattern of ['.*', '^.*$', '^winwidget.+$', '^a{1,9}$', '^a\\1$', '^[a-z]$', '^a.$', '^a$', '^$']) {
		if (['^a$', '^$'].includes(pattern)) assert.doesNotThrow(() => finitePermission(pattern))
		else assert.throws(() => finitePermission(pattern))
	}
	const values = ['a', 'a.b', 'a.c', 'd.e']
	assert.deepEqual(finitePermission(exactPermission(values)), values)
})
test('four consumers have independent main/retry/DLQ routes with manual retry TTL destinations', () => {
	const { queues, bindings } = supportChatTopology()
	assert.equal(queues.length, 20); assert.equal(new Set(queues.map(row => row.name)).size, 20)
	for (const [kind, name] of [...SUPPORT_CHAT_KINDS, ['support-notification-outcome', SUPPORT_CHAT_OUTCOME_QUEUE]]) {
		const retries = queues.filter(row => row.name.startsWith(name + '.retry-'))
		assert.deepEqual(retries.map(row => row.arguments['x-message-ttl']), [30000, 300000, 1800000])
		for (const row of retries) {
			assert.equal(row.arguments['x-dead-letter-exchange'], 'winwidget.manual-retry')
			assert.equal(row.arguments['x-dead-letter-routing-key'], kind)
		}
		assert.ok(bindings.some(row => row.destination === name && row.source === 'winwidget.manual-retry' && row.routing_key === kind))
	}
})
function api(snapshot, calls = []) {
	return async (method, path, body) => {
		calls.push([method, path])
		if (method === 'GET') {
			const kind = path.split('/')[2].replace('-', '_')
			return structuredClone(snapshot[kind])
		}
		assert.ok(['PUT', 'POST'].includes(method)); assert.ok(!/\/(?:publish|purge|get)$/.test(path))
		const parts = path.split('/').map(decodeURIComponent)
		if (parts[2] === 'permissions') {
			const row = snapshot.permissions.find(row => row.user === parts[4] && row.vhost === parts[3]); Object.assign(row, body); return null
		}
		if (parts[2] === 'topic-permissions') {
			const row = snapshot.topic_permissions.find(row => row.user === parts[4] && row.vhost === parts[3] && row.exchange === body.exchange)
			if (row) Object.assign(row, body); else snapshot.topic_permissions.push({ user: parts[4], vhost: parts[3], ...body }); return null
		}
		if (parts[2] === 'queues') {
			if (!snapshot.queues.some(row => row.name === parts[4])) snapshot.queues.push({ name: parts[4], consumers: 0, ...body }); return null
		}
		assert.equal(parts[2], 'bindings')
		const binding = { source: parts[5], destination: parts[7], destination_type: 'queue', ...body }
		if (!snapshot.bindings.some(row => JSON.stringify(row) === JSON.stringify(binding))) snapshot.bindings.push(binding)
		return null
	}
}
test('provision is additive and resumable with retained messages and no business sends', async () => {
	const before = fixture(), snapshot = structuredClone(before), calls = [], request = api(snapshot, calls)
	await provisionSupportChatBroker(request)
	snapshot.queues.find(row => row.name === SUPPORT_CHAT_OUTCOME_QUEUE).messages = 3
	await provisionSupportChatBroker(request)
	assert.deepEqual(snapshot.queues.find(row => row.name === 'unrelated'), before.queues[0])
	assert.equal(snapshot.queues.find(row => row.name === SUPPORT_CHAT_OUTCOME_QUEUE).messages, 3)
	assert.ok(calls.every(([method]) => ['GET', 'PUT', 'POST'].includes(method)))
})
test('incompatible durable queue, active consumer or wildcard target ACL prevents any mutation', async () => {
	for (const mutate of [
		value => value.queues.push({ ...supportChatTopology().queues[0], consumers: 1 }),
		value => value.queues.push({ ...supportChatTopology().queues[0], arguments: { 'x-queue-type': 'quorum' } }),
		value => { value.permissions[0].configure = '.*' }
	]) {
		const snapshot = fixture(), calls = []; mutate(snapshot)
		await assert.rejects(() => provisionSupportChatBroker(api(snapshot, calls)))
		assert.ok(calls.every(([method]) => method === 'GET'))
	}
})
test('activation verifies complete topology without mutations and permits exactly one resumed consumer', async () => {
	const snapshot = fixture()
	await provisionSupportChatBroker(api(snapshot))
	snapshot.queues.find(row => row.name === SUPPORT_CHAT_OUTCOME_QUEUE).consumers = 1
	const calls = []
	await verifySupportChatBroker(api(snapshot, calls))
	assert.ok(calls.every(([method]) => method === 'GET'))
	snapshot.queues.find(row => row.name === SUPPORT_CHAT_OUTCOME_QUEUE).consumers = 2
	await assert.rejects(() => verifySupportChatBroker(api(snapshot)))
})
