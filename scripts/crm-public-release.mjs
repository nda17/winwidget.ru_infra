import assert from 'node:assert/strict'

// Public routing and browser origins only. This does not enable billing,
// invitation delivery or native widget producers, and never changes databases.
export const CRM_PUBLIC_ROUTES = Object.freeze([
	['crm-access', '/api/v1/crm/access', 5300],
	['crm-templates', '/api/v1/crm/templates', 5330],
	['crm-sales', '/api/v1/crm/sales', 5330],
	['crm-customers', '/api/v1/crm/customers', 5320],
	['crm-intake', '/api/v1/crm/intake', 5310],
	['crm-intake-ingest', '/api/v1/crm/intake/ingest', 5310],
	['identity-workspace-invitations', '/api/v1/workspace-invitations', 4900],
	['billing-crm-settings', '/api/v1/billing-settings/crm', 4800]
].map(([id, pathPrefix, port]) => Object.freeze({
	id, pathPrefix, upstreamUrl: 'http://127.0.0.1:' + port,
	authPolicy: id === 'crm-intake-ingest' ? 'crm-source' : 'required',
	timeoutMs: 60000
})))

export const CRM_PUBLIC_TARGETS = Object.freeze({
	winwidget: ['identity-api', 'billing-api', 'widgets-service', 'api-gateway'],
	'winwidget-crm': ['crm-access-api', 'crm-customers-api', 'crm-sales-api', 'crm-intake-api']
})

export function crmPublicEnv(before) {
	assert.equal(before.CORS_ALLOWED_ORIGINS, 'https://winwidget.ru,https://www.winwidget.ru')
	const routes = JSON.parse(before.GATEWAY_ROUTES_JSON)
	assert.ok(Array.isArray(routes) && routes.length > 0)
	assert.equal(new Set(routes.map(route => route.id)).size, routes.length)
	assert.equal(new Set(routes.map(route => route.pathPrefix)).size, routes.length)
	for (const route of CRM_PUBLIC_ROUTES) {
		assert.ok(!routes.some(old => old.id === route.id || old.pathPrefix === route.pathPrefix))
	}
	return {...before,
		CORS_ALLOWED_ORIGINS: before.CORS_ALLOWED_ORIGINS + ',https://crm.winwidget.ru',
		GATEWAY_ROUTES_JSON: JSON.stringify([...routes, ...CRM_PUBLIC_ROUTES])
	}
}

export function crmPublicProcessEnv(project, name, before, canonicalBefore, canonicalAfter, gatewayRevision) {
	assert.ok(CRM_PUBLIC_TARGETS[project]?.includes(name))
	assert.deepEqual(canonicalAfter, crmPublicEnv(canonicalBefore))
	assert.match(gatewayRevision, /^[a-f0-9]{40}$/)
	const after = {...before}
	if (project === 'winwidget-crm') {
		assert.equal(before.CORS_ALLOWED_ORIGINS, 'https://crm.winwidget.ru')
		after.CORS_ALLOWED_ORIGINS = 'https://crm.winwidget.ru,https://winwidget.ru'
	} else {
		assert.equal(before.CORS_ALLOWED_ORIGINS, canonicalBefore.CORS_ALLOWED_ORIGINS)
		after.CORS_ALLOWED_ORIGINS = canonicalAfter.CORS_ALLOWED_ORIGINS
		if (name === 'api-gateway') {
			assert.equal(before.GATEWAY_ROUTES_JSON, canonicalBefore.GATEWAY_ROUTES_JSON)
			after.GATEWAY_ROUTES_JSON = canonicalAfter.GATEWAY_ROUTES_JSON
			after.APP_REVISION = gatewayRevision
		}
	}
	return after
}

export function crmPublicEnvBytes(bytes, changed) {
	const entries = Object.entries(changed)
	let result = bytes
	for (const [key, value] of entries) {
		assert.match(key, /^[A-Z][A-Z0-9_]*$/)
		assert.equal(typeof value, 'string')
		assert.ok(!/[\r\n]/.test(value))
		const pattern = new RegExp('^' + key + '=.*$', 'gm')
		assert.equal([...result.matchAll(pattern)].length, 1)
		result = result.replace(pattern, () => key + '=' + value)
	}
	return result
}
