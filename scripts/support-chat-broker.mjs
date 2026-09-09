import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

export const SUPPORT_CHAT_KINDS = Object.freeze([
	['support-team-email', 'winwidget.notification.support.team.email', 'notification.support.team.email.requested.v1'],
	['support-team-telegram', 'winwidget.notification.support.team.telegram', 'notification.support.team.telegram.requested.v1'],
	['support-client-email', 'winwidget.notification.support.client.email', 'notification.support.client.email.requested.v1']
])
export const SUPPORT_CHAT_OUTCOME = 'support.notification.delivery.outcome.v1'
export const SUPPORT_CHAT_OUTCOME_QUEUE = 'winwidget.support.notification-outcomes.v1'
const outcomeConsumer = 'support-notification-outcome'
const exchanges = ['winwidget.events', 'winwidget.retry', 'winwidget.dead-letter', 'winwidget.manual-retry']
export const SUPPORT_CHAT_PRINCIPALS = Object.freeze(['winwidget-notification-delivery', 'winwidget-support-worker', 'winwidget-support-publisher'])
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sort = rows => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))

// Decode only finite exact ACLs. Reject wildcards, unbounded repetition,
// backreferences and character ranges; no existing broad permission is hidden
// inside the additive extension. Result cardinality and byte sizes are bounded.
export function finitePermission(pattern) {
	assert.equal(typeof pattern, 'string')
	assert.ok(pattern.length <= 1024 && pattern.startsWith('^') && pattern.endsWith('$'))
	if (pattern === '^$') return []
	let index = 1
	const product = (left, right) => {
		assert.ok(left.length * right.length <= 4096)
		return left.flatMap(a => right.map(b => a + b))
	}
	const expression = () => {
		let alternatives = [], terms = ['']
		while (index < pattern.length - 1 && pattern[index] !== ')') {
			if (pattern[index] === '|') { alternatives.push(...terms); terms = ['']; index++; continue }
			let atom
			if (pattern[index] === '(') {
				index++
				if (pattern.slice(index, index + 2) === '?:') index += 2
				atom = expression()
				assert.equal(pattern[index++], ')')
			} else if (pattern[index] === '[') {
				index++
				const start = index
				while (/[a-z0-9]/.test(pattern[index] ?? '') && index < pattern.length) index++
				assert.ok(index > start)
				atom = [...pattern.slice(start, index)]
				assert.equal(pattern[index++], ']')
			} else if (pattern[index] === '\\') {
				index++
				assert.ok(['.', '-'].includes(pattern[index]))
				atom = [pattern[index++]]
			} else {
				assert.match(pattern[index], /^[a-z0-9-]$/)
				atom = [pattern[index++]]
			}
			if (pattern[index] === '?') { atom = [...atom, '']; index++ }
			terms = product(terms, atom)
		}
		return [...alternatives, ...terms]
	}
	const values = expression()
	assert.equal(index, pattern.length - 1)
	assert.ok(values.length <= 4096)
	for (const value of values) assert.match(value, /^[a-z0-9.-]+$/)
	return [...new Set(values)].sort()
}

export function exactPermission(values) {
	const rows = [...new Set(values)].sort()
	if (!rows.length) return '^$'
	for (const row of rows) assert.match(row, /^[a-z0-9.-]+$/)
	const escape = value => value.replaceAll('.', '\\.')
	const cache = new Map()
	const emit = remaining => {
		const key = JSON.stringify(remaining)
		if (cache.has(key)) return cache.get(key)
		if (remaining.length === 1) return escape(remaining[0])
		const choices = [false, true].map(reverse => {
			const groups = new Map()
			for (const row of remaining) {
				const char = reverse ? row.slice(-1) : row.slice(0, 1)
				if (!groups.has(char)) groups.set(char, [])
				groups.get(char).push(reverse ? row.slice(0, -1) : row.slice(1))
			}
			const terms = [...groups].map(([char, rest]) => !char ? '' : reverse ? emit(rest) + escape(char) : escape(char) + emit(rest))
			return terms.length === 1 ? terms[0] : '(?:' + terms.join('|') + ')'
		})
		const result = choices.sort((a, b) => a.length - b.length)[0]
		cache.set(key, result)
		return result
	}
	const alternatives = [emit(rows)]
	const remaining = new Set(rows), groups = []
	for (const version of ['v2', 'v1']) {
		const suffixes = ['', '.dead-letter', ...[1, 2, 3].map(index => `.retry-${version}.${index}`)]
		const bases = rows.filter(row => suffixes.every(suffix => remaining.has(row + suffix)))
		if (!bases.length) continue
		for (const base of bases) for (const suffix of suffixes) remaining.delete(base + suffix)
		groups.push(emit(bases) + `(?:\\.dead-letter|\\.retry-${version}\\.(?:1|2|3))?`)
	}
	if (groups.length) {
		if (remaining.size) groups.push(emit([...remaining]))
		alternatives.push('(?:' + groups.join('|') + ')')
	}
	const pattern = '^' + alternatives.sort((a, b) => a.length - b.length)[0] + '$'
	assert.ok(Buffer.byteLength(pattern) <= 1024)
	assert.deepEqual(finitePermission(pattern), rows)
	return pattern
}

export function supportChatTopology() {
	const queues = [], bindings = []
	const queue = (name, args = {}) => queues.push({ name, durable: true, auto_delete: false, arguments: args })
	const bind = (destination, source, routing_key) => bindings.push({ source, destination, destination_type: 'queue', routing_key, arguments: {} })
	const channel = (kind, name, event, version, legacyManual) => {
		queue(name); queue(name + '.dead-letter')
		bind(name, exchanges[0], event); bind(name, exchanges[3], kind)
		bind(name + '.dead-letter', exchanges[2], kind + '.dead-letter')
		if (legacyManual) {
			bind(name, exchanges[0], 'manual.' + kind)
			bind(name + '.dead-letter', exchanges[0], kind + '.dead-letter')
		}
		for (const [index, delay] of [30000, 300000, 1800000].entries()) {
			const retry = `${name}.retry-${version}.${index + 1}`
			queue(retry, { 'x-message-ttl': delay, 'x-dead-letter-exchange': exchanges[3], 'x-dead-letter-routing-key': kind })
			bind(retry, exchanges[1], `${kind}.retry.${index + 1}`)
		}
	}
	for (const [kind, name, event] of SUPPORT_CHAT_KINDS) channel(kind, name, event, 'v2', true)
	channel(outcomeConsumer, SUPPORT_CHAT_OUTCOME_QUEUE, SUPPORT_CHAT_OUTCOME, 'v1', false)
	return { queues, bindings }
}

export function extendSupportChatPermissions(snapshot) {
	const result = structuredClone(snapshot)
	const topology = supportChatTopology()
	const extend = (name, resourceAdditions, topicAdditions) => {
		const matches = result.permissions.filter(row => row.user === name && row.vhost === 'winwidget')
		assert.equal(matches.length, 1)
		for (const [key, values] of Object.entries(resourceAdditions)) {
			matches[0][key] = exactPermission([...finitePermission(matches[0][key]), ...values])
		}
		for (const [exchange, additions] of Object.entries(topicAdditions)) {
			let rows = result.topic_permissions.filter(row => row.user === name && row.vhost === 'winwidget' && row.exchange === exchange)
			assert.ok(rows.length <= 1)
			if (!rows.length) {
				const row = { user: name, vhost: 'winwidget', exchange, read: '^$', write: '^$' }
				result.topic_permissions.push(row); rows = [row]
			}
			for (const [key, values] of Object.entries(additions)) rows[0][key] = exactPermission([...finitePermission(rows[0][key]), ...values])
		}
	}
	const notificationQueues = topology.queues.filter(row => row.name.startsWith('winwidget.notification.support.')).map(row => row.name)
	const outcomeQueues = topology.queues.filter(row => row.name.startsWith(SUPPORT_CHAT_OUTCOME_QUEUE)).map(row => row.name)
	extend(SUPPORT_CHAT_PRINCIPALS[0], { configure: notificationQueues, read: notificationQueues, write: notificationQueues }, {
		'winwidget.events': {
			read: SUPPORT_CHAT_KINDS.flatMap(([kind, , event]) => [event, `manual.${kind}`, `${kind}.dead-letter`]),
			write: [SUPPORT_CHAT_OUTCOME, ...SUPPORT_CHAT_KINDS.map(([kind]) => `manual.${kind}`)]
		},
		'winwidget.dead-letter': {
			read: SUPPORT_CHAT_KINDS.map(([kind]) => `${kind}.dead-letter`),
			write: SUPPORT_CHAT_KINDS.map(([kind]) => `${kind}.dead-letter`)
		}
	})
	// RabbitMQ checks write permission on the configured DLX when the worker
	// asserts its durable retry queues, even though business publication is
	// performed exclusively by Support's transactional Outbox publisher.
	extend(SUPPORT_CHAT_PRINCIPALS[1], { configure: outcomeQueues, read: outcomeQueues, write: [...outcomeQueues, 'winwidget.manual-retry'] }, {
		'winwidget.events': { read: [SUPPORT_CHAT_OUTCOME], write: [] },
		'winwidget.dead-letter': { read: ['support-telegram-webhook.dead-letter', `${outcomeConsumer}.dead-letter`], write: [] }
	})
	extend(SUPPORT_CHAT_PRINCIPALS[2], { configure: [], read: [], write: [] }, {
		'winwidget.events': { read: [], write: SUPPORT_CHAT_KINDS.map(row => row[2]) },
		'winwidget.dead-letter': { read: [], write: [`${outcomeConsumer}.dead-letter`] }
	})
	return result
}

const permissionRows = (snapshot, names) => ({
	permissions: sort(snapshot.permissions.filter(row => names.includes(row.user)).map(({ user, vhost, configure, read, write }) => ({ user, vhost, configure, read, write }))),
	topic_permissions: sort(snapshot.topic_permissions.filter(row => names.includes(row.user)).map(({ user, vhost, exchange, read, write }) => ({ user, vhost, exchange, read, write })))
})
export function assertSupportChatBrokerSnapshot(snapshot, complete = false, allowConsumers = false) {
	const topology = supportChatTopology()
	const owned = name => topology.queues.some(row => row.name === name)
	for (const [index, name] of exchanges.entries()) {
		const rows = snapshot.exchanges.filter(row => row.name === name)
		assert.equal(rows.length, 1)
		assert.equal(rows[0].type, [0, 2].includes(index) ? 'topic' : 'direct')
		assert.equal(rows[0].durable, true)
		assert.equal(rows[0].auto_delete, false)
	}
	for (const expected of topology.queues) {
		const rows = snapshot.queues.filter(row => row.name === expected.name)
		assert.ok(rows.length <= 1)
		if (!rows.length) { assert.equal(complete, false); continue }
		const row = rows[0]
		assert.equal(row.durable, true); assert.equal(row.auto_delete, false)
		assert.ok(!row.type || row.type === 'classic')
		const args = { ...row.arguments }; if (args['x-queue-type'] === 'classic') delete args['x-queue-type']
		assert.deepEqual(args, expected.arguments)
		// Deployment prepares consumers with product gates closed. Retained
		// messages are valid and are never purged or used as a release gate.
		const consumers = Number(row.consumers ?? 0)
		assert.ok(Number.isSafeInteger(consumers) && consumers >= 0)
		const main = [SUPPORT_CHAT_OUTCOME_QUEUE, ...SUPPORT_CHAT_KINDS.map(item => item[1])].includes(row.name)
		assert.ok(consumers <= (allowConsumers && main ? 1 : 0))
	}
	const key = row => JSON.stringify([row.source, row.destination, row.destination_type, row.routing_key, row.arguments])
	const bindings = snapshot.bindings.filter(row => row.source && owned(row.destination))
	for (const row of bindings) assert.ok(topology.bindings.some(expected => key(expected) === key(row)))
	if (complete) for (const row of topology.bindings) assert.equal(bindings.filter(item => key(item) === key(row)).length, 1)
	return true
}

export async function readSupportChatBroker(request) {
	const rows = await Promise.all(['exchanges/winwidget', 'queues/winwidget', 'bindings/winwidget', 'permissions', 'topic-permissions'].map(path => request('GET', '/api/' + path)))
	for (const row of rows) assert.ok(Array.isArray(row))
	return Object.fromEntries(['exchanges', 'queues', 'bindings', 'permissions', 'topic_permissions'].map((key, index) => [key, rows[index]]))
}

export async function verifySupportChatBroker(request) {
	const snapshot = await readSupportChatBroker(request)
	assertSupportChatBrokerSnapshot(snapshot, true, true)
	assert.deepEqual(permissionRows(snapshot, SUPPORT_CHAT_PRINCIPALS), permissionRows(extendSupportChatPermissions(snapshot), SUPPORT_CHAT_PRINCIPALS))
	return { version: 'support-chat-v1', topologySha256: digest(supportChatTopology()), permissionsSha256: digest(permissionRows(snapshot, SUPPORT_CHAT_PRINCIPALS)) }
}

// Management API is topology administration only. This function cannot publish,
// consume, purge, delete or recreate a queue, user, exchange or message.
export async function provisionSupportChatBroker(request, fence = async () => {}) {
	const before = await readSupportChatBroker(request)
	assertSupportChatBrokerSnapshot(before)
	const desired = extendSupportChatPermissions(before)
	const beforeOwned = permissionRows(before, SUPPORT_CHAT_PRINCIPALS)
	const targetOwned = permissionRows(desired, SUPPORT_CHAT_PRINCIPALS)
	const peers = snapshot => {
		const names = [...new Set([...snapshot.permissions, ...snapshot.topic_permissions].map(row => row.user))].filter(name => !SUPPORT_CHAT_PRINCIPALS.includes(name))
		return permissionRows(snapshot, names)
	}
	const peerDigest = digest(peers(before))
	const ownedQueues = new Set(supportChatTopology().queues.map(row => row.name))
	const peerTopology = snapshot => ({
		exchanges: sort(snapshot.exchanges.map(({ name, type, durable, auto_delete, internal, arguments: args }) => ({ name, type, durable, auto_delete, internal, arguments: args }))),
		queues: sort(snapshot.queues.filter(row => !ownedQueues.has(row.name)).map(({ name, type, durable, auto_delete, arguments: args }) => ({ name, type, durable, auto_delete, arguments: args }))),
		bindings: sort(snapshot.bindings.filter(row => !ownedQueues.has(row.destination)).map(({ source, destination, destination_type, routing_key, arguments: args }) => ({ source, destination, destination_type, routing_key, arguments: args })))
	})
	const topologyDigest = digest(peerTopology(before))
	let latest = before
	const checked = async () => {
		await fence()
		const current = await readSupportChatBroker(request)
		assert.equal(digest(peers(current)), peerDigest)
		assert.equal(digest(peerTopology(current)), topologyDigest)
		assert.deepEqual(permissionRows(current, SUPPORT_CHAT_PRINCIPALS), permissionRows(latest, SUPPORT_CHAT_PRINCIPALS))
		assertSupportChatBrokerSnapshot(current)
		return current
	}
	for (const row of targetOwned.permissions) {
		await checked()
		const { user, vhost, configure, read, write } = row
		await request('PUT', `/api/permissions/${encodeURIComponent(vhost)}/${encodeURIComponent(user)}`, { configure, read, write })
		latest.permissions = latest.permissions.filter(item => item.user !== user || item.vhost !== vhost).concat(row)
	}
	for (const row of targetOwned.topic_permissions) {
		await checked()
		const { user, vhost, exchange, read, write } = row
		await request('PUT', `/api/topic-permissions/${encodeURIComponent(vhost)}/${encodeURIComponent(user)}`, { exchange, read, write })
		latest.topic_permissions = latest.topic_permissions.filter(item => item.user !== user || item.vhost !== vhost || item.exchange !== exchange).concat(row)
	}
	for (const row of supportChatTopology().queues) {
		await checked()
		await request('PUT', `/api/queues/winwidget/${encodeURIComponent(row.name)}`, { durable: row.durable, auto_delete: row.auto_delete, arguments: row.arguments })
	}
	for (const row of supportChatTopology().bindings) {
		await checked()
		await request('POST', `/api/bindings/winwidget/e/${encodeURIComponent(row.source)}/q/${encodeURIComponent(row.destination)}`, { routing_key: row.routing_key, arguments: row.arguments })
	}
	const after = await checked()
	assertSupportChatBrokerSnapshot(after, true)
	assert.deepEqual(permissionRows(after, SUPPORT_CHAT_PRINCIPALS), targetOwned)
	return { version: 'support-chat-v1', beforePermissionsSha256: digest(beforeOwned), afterPermissionsSha256: digest(targetOwned), topologySha256: digest(supportChatTopology()), preservedPrincipalsSha256: peerDigest }
}
