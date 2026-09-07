import assert from 'node:assert/strict'
import { parseEnv } from 'node:util'

const pairs = [
	'IDENTITY_CRM_ACCESS_TOKEN',
	'BILLING_CRM_ACCESS_TOKEN',
	'BILLING_CRM_ACCESS_COMMERCE_TOKEN',
	'WIDGETS_CRM_INTAKE_TOKEN'
]
export const CRM_COMPANION_NEW_TOKENS = [
	'BILLING_WINCRM_WIDGETS_TOKEN',
	'BILLING_WINCRM_CRM_INTAKE_TOKEN',
	'IDENTITY_NOTIFICATION_DELIVERY_TOKEN'
]
const strong = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const closed = [
	'BILLING_WINCRM_PAYMENTS_ENABLED',
	'BILLING_WINCRM_WIDGETS_ELIGIBILITY_ENABLED',
	'WIDGETS_WINCRM_CONNECTOR_ENABLED',
	'WINCRM_INVITATION_EMAIL_ENABLED'
]

// Patch only explicitly selected keys, retaining comments, order and all other
// bytes. No example values, automatic credential rotation or product activation.
export function patchCrmEnv(bytes, changes) {
	try {
		assert.equal(typeof bytes, 'string')
		assert.ok(bytes.endsWith('\n') && !/[\0\r]/.test(bytes))
		const seen = new Set()
		const remaining = new Set(Object.keys(changes))
		const lines = bytes.slice(0, -1).split('\n').map(line => {
			if (!line.trim() || line.trimStart().startsWith('#')) return line
			const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
			assert.ok(match && !seen.has(match[1]))
			const key = match[1]
			seen.add(key)
			if (!remaining.delete(key)) return line
			return key + '=' + changes[key]
		})
		for (const [key, value] of Object.entries(changes)) {
			assert.match(key, /^[A-Z][A-Z0-9_]*$/)
			assert.ok(typeof value === 'string' && !/[\s#'"`$\\\0]/.test(value))
			assert.equal(parseEnv(key + '=' + value)[key], value)
		}
		for (const key of remaining) lines.push(key + '=' + changes[key])
		return lines.join('\n') + '\n'
	} catch {
		throw new Error('Invalid CRM env structure; private details suppressed')
	}
}

export function prepareCrmCompanionEnv({ canonicalBytes, crmBytes, providerPassword, newTokens, ownerBytes }) {
	try {
		const canonical = parseEnv(patchCrmEnv(canonicalBytes, {}))
		const crm = parseEnv(patchCrmEnv(crmBytes, {}))
		assert.equal(canonical.CRM_RABBITMQ_CONTRACT, 'mvp-v1')
		for (const key of closed) assert.equal(canonical[key] ?? 'false', 'false')
		for (const key of ['CRM_ACCESS_BILLING_ENABLED', 'CRM_INTAKE_WIDGETS_ENABLED', 'CRM_INTAKE_WIDGET_TRANSFERS_ENABLED'])
			assert.equal(crm[key], 'false')
		const changes = {}
		for (const key of pairs) {
			assert.ok(strong(crm[key]))
			assert.ok(!canonical[key] || canonical[key] === crm[key])
			changes[key] = crm[key]
		}
		for (const key of CRM_COMPANION_NEW_TOKENS) {
			assert.ok(strong(newTokens[key]))
			assert.ok(!canonical[key] || canonical[key] === newTokens[key])
			changes[key] = newTokens[key]
		}
		assert.ok(strong(providerPassword))
		const broker = 'amqp://winwidget-billing-wincrm-provider-worker:' + providerPassword + '@127.0.0.1:5672/winwidget'
		assert.ok(!canonical.BILLING_WINCRM_PROVIDER_RABBITMQ_URL || canonical.BILLING_WINCRM_PROVIDER_RABBITMQ_URL === broker)
		const secrets = Object.values(changes)
		assert.equal(new Set([...secrets, providerPassword]).size, secrets.length + 1)
		for (const [key, value] of Object.entries(canonical))
			if (key.endsWith('_TOKEN') && !Object.hasOwn(changes, key) && value)
				assert.ok(!secrets.includes(value))
		for (const [key, value] of Object.entries(crm))
			if (key.endsWith('_TOKEN') && !pairs.includes(key) && value)
				assert.ok(!secrets.includes(value) && value !== providerPassword)
		Object.assign(changes, Object.fromEntries(closed.map(key => [key, 'false'])), {
			BILLING_WINCRM_RECONCILIATION_ENABLED: 'true',
			BILLING_WINCRM_PROVIDER_RABBITMQ_URL: broker,
			BILLING_WINCRM_PROVIDER_ASSERT_TOPOLOGY: 'false',
			BILLING_WINCRM_FRONTEND_ORIGIN: 'https://crm.winwidget.ru',
			BILLING_CRM_ACCESS_COMMERCE_BASE_URL: 'http://127.0.0.1:5300',
			WIDGETS_WINCRM_HTTP_TIMEOUT_MS: '3000'
		})
		for (const [key, value] of Object.entries(changes))
			if (canonical[key] && key !== 'BILLING_WINCRM_RECONCILIATION_ENABLED') assert.equal(canonical[key], value)
		assert.ok(['false', 'true'].includes(canonical.BILLING_WINCRM_RECONCILIATION_ENABLED ?? 'false'))
		const kinds = canonical.NOTIFICATION_DELIVERY_KINDS?.split(',')
		assert.ok(kinds?.length && !kinds.includes('wincrm-invitation-email'))
		assert.equal(canonical.IDENTITY_INTERNAL_BASE_URL, 'http://127.0.0.1:4900')
		assert.equal(canonical.BILLING_INTERNAL_BASE_URL, 'http://127.0.0.1:4800')
		const ownerChanges = {
			identity: Object.fromEntries(['IDENTITY_CRM_ACCESS_TOKEN', 'IDENTITY_NOTIFICATION_DELIVERY_TOKEN', 'WINCRM_INVITATION_EMAIL_ENABLED'].map(key => [key, changes[key]])),
			billing: Object.fromEntries(Object.entries(changes).filter(([key]) => key.startsWith('BILLING_'))),
			widgets: { ...Object.fromEntries(Object.entries(changes).filter(([key]) => key.startsWith('WIDGETS_') || key === 'BILLING_WINCRM_WIDGETS_TOKEN')), BILLING_INTERNAL_BASE_URL: canonical.BILLING_INTERNAL_BASE_URL },
			'notification-delivery': { IDENTITY_NOTIFICATION_DELIVERY_TOKEN: changes.IDENTITY_NOTIFICATION_DELIVERY_TOKEN, IDENTITY_INTERNAL_BASE_URL: canonical.IDENTITY_INTERNAL_BASE_URL }
		}
		const owners = {}
		for (const [owner, selected] of Object.entries(ownerChanges)) {
			const before = parseEnv(patchCrmEnv(ownerBytes[owner], {}))
			assert.match(before.APP_REVISION, /^[a-f0-9]{40}$/)
			for (const [key, value] of Object.entries(selected))
				if (key.endsWith('_TOKEN') && before[key]) assert.equal(before[key], value)
			owners[owner] = patchCrmEnv(ownerBytes[owner], selected)
		}
		return { canonical: patchCrmEnv(canonicalBytes, changes), owners }
	} catch {
		throw new Error('CRM companion preparation rejected; private details suppressed')
	}
}
