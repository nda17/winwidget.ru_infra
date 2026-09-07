import assert from 'node:assert/strict'
import { parseEnv } from 'node:util'
import { test } from 'node:test'
import { CRM_COMPANION_NEW_TOKENS, CRM_ACTIVATION_TARGETS, activateCrmCompanionEnv, crmActivationProcessEnv, patchCrmEnv, prepareCrmCompanionEnv } from './crm-companion-env.mjs'

const env = values => Object.entries(values).map(([key, value]) => key + '=' + value).join('\n') + '\n'
const fixture = () => ({
	canonicalBytes: '# keep comments\n' + env({
		CRM_RABBITMQ_CONTRACT: 'mvp-v1',
		NOTIFICATION_DELIVERY_KINDS: 'email,telegram,payment-email',
		IDENTITY_INTERNAL_BASE_URL: 'http://127.0.0.1:4900',
		BILLING_INTERNAL_BASE_URL: 'http://127.0.0.1:4800',
		UNRELATED_VALUE: '"spaces stay quoted"'
	}),
	crmBytes: env({
		CRM_ACCESS_BILLING_ENABLED: 'false',
		CRM_INTAKE_WIDGETS_ENABLED: 'false',
		CRM_INTAKE_WIDGET_TRANSFERS_ENABLED: 'false',
		IDENTITY_CRM_ACCESS_TOKEN: 'a'.repeat(64),
		BILLING_CRM_ACCESS_TOKEN: 'b'.repeat(64),
		BILLING_CRM_ACCESS_COMMERCE_TOKEN: 'c'.repeat(64),
		WIDGETS_CRM_INTAKE_TOKEN: 'd'.repeat(64)
	}),
	providerPassword: 'e'.repeat(64),
	newTokens: Object.fromEntries(CRM_COMPANION_NEW_TOKENS.map((key, index) => [key, String(index + 1).repeat(64)])),
	ownerBytes: Object.fromEntries(['identity', 'billing', 'widgets', 'notification-delivery'].map(owner => [owner, '# owner\nAPP_REVISION=' + 'f'.repeat(40) + '\nRABBITMQ_URL=unchanged\n']))
})

test('native and invitation activation changes only product flags and preserves paid gate, tokens and eleven delivery kinds',()=>{
	const input=fixture()
	input.canonicalBytes=patchCrmEnv(input.canonicalBytes,{NOTIFICATION_DELIVERY_KINDS:'email,telegram,payment-email,payment-telegram,limit-email,limit-telegram,campaign-email,campaign-telegram,daily-summary-delivery-telegram,subscription-expiry-email,subscription-expiry-telegram'})
	const prepared=prepareCrmCompanionEnv(input)
	prepared.owners['notification-delivery']=patchCrmEnv(prepared.owners['notification-delivery'],{NOTIFICATION_DELIVERY_KINDS:parseEnv(prepared.canonical).NOTIFICATION_DELIVERY_KINDS})
	const values={canonicalBytes:prepared.canonical,crmBytes:input.crmBytes,ownerBytes:prepared.owners}
	const next=activateCrmCompanionEnv(values),canonical=parseEnv(next.canonical)
	assert.equal(canonical.BILLING_WINCRM_PAYMENTS_ENABLED,'false')
	assert.equal(parseEnv(next.crm).CRM_ACCESS_BILLING_ENABLED,'false')
	assert.equal(canonical.NOTIFICATION_DELIVERY_KINDS,parseEnv(prepared.canonical).NOTIFICATION_DELIVERY_KINDS+',wincrm-invitation-email')
	for(const [project,names] of Object.entries(CRM_ACTIVATION_TARGETS))for(const name of names){
		const source={...parseEnv(prepared.canonical),...parseEnv(input.crmBytes),SECRET:'synthetic',APP_REVISION:'a'.repeat(40)}
		const result=crmActivationProcessEnv(project,name,source,canonical)
		assert.equal(result.SECRET,source.SECRET)
		assert.equal(result.APP_REVISION,source.APP_REVISION)
		assert.equal(result.BILLING_WINCRM_PAYMENTS_ENABLED,'false')
		assert.equal(result.CRM_ACCESS_BILLING_ENABLED,'false')
	}
	assert.throws(()=>activateCrmCompanionEnv({...values,canonicalBytes:patchCrmEnv(values.canonicalBytes,{BILLING_WINCRM_PAYMENTS_ENABLED:'true'})}))
	assert.throws(()=>activateCrmCompanionEnv({...values,canonicalBytes:next.canonical,crmBytes:next.crm,ownerBytes:next.owners}))
	assert.throws(()=>crmActivationProcessEnv('winwidget','billing-worker',{},canonical))
})

test('companion preparation pairs credentials without enabling products or changing existing revisions', () => {
	const input = fixture()
	const result = prepareCrmCompanionEnv(input)
	const canonical = parseEnv(result.canonical)
	assert.ok(result.canonical.startsWith(input.canonicalBytes))
	assert.equal(canonical.BILLING_WINCRM_RECONCILIATION_ENABLED, 'true')
	assert.match(canonical.BILLING_WINCRM_PROVIDER_RABBITMQ_URL, /^amqp:\/\/winwidget-billing-wincrm-provider-worker:/)
	for (const key of ['BILLING_WINCRM_PAYMENTS_ENABLED', 'BILLING_WINCRM_WIDGETS_ELIGIBILITY_ENABLED', 'WIDGETS_WINCRM_CONNECTOR_ENABLED', 'WINCRM_INVITATION_EMAIL_ENABLED']) assert.equal(canonical[key], 'false')
	for (const [owner, bytes] of Object.entries(result.owners)) {
		assert.ok(bytes.startsWith(input.ownerBytes[owner]))
		assert.equal(parseEnv(bytes).APP_REVISION, 'f'.repeat(40))
	}
	assert.equal(parseEnv(result.owners.identity).IDENTITY_CRM_ACCESS_TOKEN, parseEnv(input.crmBytes).IDENTITY_CRM_ACCESS_TOKEN)
	assert.equal(parseEnv(result.owners.billing).BILLING_CRM_ACCESS_COMMERCE_TOKEN, parseEnv(input.crmBytes).BILLING_CRM_ACCESS_COMMERCE_TOKEN)
	assert.equal(parseEnv(result.owners.widgets).BILLING_WINCRM_WIDGETS_TOKEN, parseEnv(result.owners.billing).BILLING_WINCRM_WIDGETS_TOKEN)
	assert.equal(parseEnv(result.owners.identity).IDENTITY_NOTIFICATION_DELIVERY_TOKEN, parseEnv(result.owners['notification-delivery']).IDENTITY_NOTIFICATION_DELIVERY_TOKEN)
	assert.equal(parseEnv(result.owners.widgets).IDENTITY_CRM_ACCESS_TOKEN, undefined)
	assert.equal(parseEnv(result.owners.identity).BILLING_WINCRM_PROVIDER_RABBITMQ_URL, undefined)
	assert.deepEqual(prepareCrmCompanionEnv({ ...input, canonicalBytes: result.canonical, ownerBytes: result.owners }), result)
})

for (const [label, mutate] of [
	['closed broker', input => { input.canonicalBytes = patchCrmEnv(input.canonicalBytes, { CRM_RABBITMQ_CONTRACT: 'disabled' }) }],
	['active payments', input => { input.canonicalBytes = patchCrmEnv(input.canonicalBytes, { BILLING_WINCRM_PAYMENTS_ENABLED: 'true' }) }],
	['active CRM', input => { input.crmBytes = patchCrmEnv(input.crmBytes, { CRM_ACCESS_BILLING_ENABLED: 'true' }) }],
	['rotated pair', input => { input.canonicalBytes += 'IDENTITY_CRM_ACCESS_TOKEN=' + '9'.repeat(64) + '\n' }],
	['rotated owner', input => { input.ownerBytes.identity += 'IDENTITY_CRM_ACCESS_TOKEN=' + '9'.repeat(64) + '\n' }],
	['reused secret', input => { input.newTokens.BILLING_WINCRM_WIDGETS_TOKEN = input.providerPassword }],
	['existing token collision', input => { input.canonicalBytes += 'IDENTITY_WIDGETS_TOKEN=' + 'a'.repeat(64) + '\n' }],
	['duplicate key', input => { input.canonicalBytes += 'CRM_RABBITMQ_CONTRACT=mvp-v1\n' }],
	['unprepared reader', input => { input.canonicalBytes = patchCrmEnv(input.canonicalBytes, { NOTIFICATION_DELIVERY_KINDS: 'email,wincrm-invitation-email' }) }],
	['remote origin', input => { input.canonicalBytes = patchCrmEnv(input.canonicalBytes, { IDENTITY_INTERNAL_BASE_URL: 'https://example.invalid' }) }],
	['unknown owner revision', input => { input.ownerBytes.billing = 'APP_REVISION=unknown\n' }]
]) test('rejects ' + label + ' without printing private data', () => {
	const input = fixture()
	mutate(input)
	assert.throws(() => prepareCrmCompanionEnv(input), { message: 'CRM companion preparation rejected; private details suppressed' })
})

test('patcher retains untouched bytes and rejects ambiguous syntax and value injection', () => {
	assert.equal(patchCrmEnv('# hello\nA="keep spaces"\nB=old\n', { B: 'new', C: 'true' }), '# hello\nA="keep spaces"\nB=new\nC=true\n')
	for (const bytes of ['A=1\nA=2\n', 'export A=1\n', 'A=1\r\n', 'A=1']) assert.throws(() => patchCrmEnv(bytes, {}))
	for (const value of ['a\nB=x', 'a #comment', 'a\0b', '"quoted"']) assert.throws(() => patchCrmEnv('A=1\n', { A: value }))
})
