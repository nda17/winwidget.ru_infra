import assert from 'node:assert/strict'
import {test} from 'node:test'
import {CRM_PUBLIC_ROUTES, CRM_PUBLIC_TARGETS, crmPublicEnv, crmPublicProcessEnv, crmPublicEnvBytes} from './crm-public-release.mjs'

const before = {
	CORS_ALLOWED_ORIGINS: 'https://winwidget.ru,https://www.winwidget.ru',
	GATEWAY_ROUTES_JSON: JSON.stringify([{id:'widgets',pathPrefix:'/api/v1/widgets',upstreamUrl:'http://127.0.0.1:4700',authPolicy:'required',timeoutMs:60000}]),
	BILLING_WINCRM_PAYMENTS_ENABLED: 'false',
	WIDGETS_WINCRM_CONNECTOR_ENABLED: 'false'
}
test('adds only eight exact routes and CRM origin without rewriting legacy routes or product gates', () => {
	const after=crmPublicEnv(before), routes=JSON.parse(after.GATEWAY_ROUTES_JSON)
	assert.deepEqual(routes.slice(0,1),JSON.parse(before.GATEWAY_ROUTES_JSON))
	assert.deepEqual(routes.slice(1),CRM_PUBLIC_ROUTES)
	assert.equal(routes.filter(route=>route.authPolicy==='crm-source').length,1)
	assert.equal(routes.find(route=>route.authPolicy==='crm-source').pathPrefix,'/api/v1/crm/intake/ingest')
	assert.equal(after.BILLING_WINCRM_PAYMENTS_ENABLED,'false')
	assert.equal(after.WIDGETS_WINCRM_CONNECTOR_ENABLED,'false')
	assert.equal(after.CORS_ALLOWED_ORIGINS,before.CORS_ALLOWED_ORIGINS+',https://crm.winwidget.ru')
})
test('rejects already activated, conflicting routes and unexpected origins',()=>{
	assert.throws(()=>crmPublicEnv(crmPublicEnv(before)))
	for(const CORS_ALLOWED_ORIGINS of ['*','https://unexpected.example'])assert.throws(()=>crmPublicEnv({...before,CORS_ALLOWED_ORIGINS}))
	for(const route of CRM_PUBLIC_ROUTES) assert.throws(()=>crmPublicEnv({...before,GATEWAY_ROUTES_JSON:JSON.stringify([route])}))
})
test('only approved HTTP processes receive origins, only Gateway receives new routes/revision',()=>{
	for(const [project,names] of Object.entries(CRM_PUBLIC_TARGETS))for(const name of names){
		const source={...before,APP_REVISION:'b'.repeat(40),PRIVATE_TOKEN:'synthetic',CORS_ALLOWED_ORIGINS:project==='winwidget-crm'?'https://crm.winwidget.ru':before.CORS_ALLOWED_ORIGINS}
		const actual=crmPublicProcessEnv(project,name,source,before,crmPublicEnv(before),'a'.repeat(40))
		assert.equal(actual.PRIVATE_TOKEN,source.PRIVATE_TOKEN)
		assert.equal(actual.BILLING_WINCRM_PAYMENTS_ENABLED,'false')
		assert.equal(actual.APP_REVISION,name==='api-gateway'?'a'.repeat(40):source.APP_REVISION)
		assert.equal(actual.GATEWAY_ROUTES_JSON,name==='api-gateway'?crmPublicEnv(before).GATEWAY_ROUTES_JSON:source.GATEWAY_ROUTES_JSON)
	}
	for(const name of ['billing-worker','operations-api','crm-access-postgres'])assert.throws(()=>crmPublicProcessEnv('winwidget',name,before,before,crmPublicEnv(before),'a'.repeat(40)))
	assert.throws(()=>crmPublicProcessEnv('winwidget','api-gateway',before,before,{...crmPublicEnv(before),BILLING_WINCRM_PAYMENTS_ENABLED:'true'},'a'.repeat(40)))
})
test('full env editing preserves unrelated bytes and rejects ambiguous fields',()=>{
	const bytes='# heading\nUNCHANGED=synthetic\nCORS_ALLOWED_ORIGINS=old\n# tail\n'
	assert.equal(crmPublicEnvBytes(bytes,{CORS_ALLOWED_ORIGINS:'new'}),bytes.replace('=old','=new'))
	assert.throws(()=>crmPublicEnvBytes(bytes,{MISSING:'x'}))
	assert.throws(()=>crmPublicEnvBytes(bytes+'CORS_ALLOWED_ORIGINS=second\n',{CORS_ALLOWED_ORIGINS:'x'}))
	assert.throws(()=>crmPublicEnvBytes(bytes,{CORS_ALLOWED_ORIGINS:'x\nEVIL=true'}))
})
