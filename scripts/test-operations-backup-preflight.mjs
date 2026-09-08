import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
	NOTES_MIGRATION, OPERATIONS_CRM_BACKUP_TARGETS, sha256,
	createOperationsBackupProbeInput, validateOperationsBackupProbeInput,
	verifyOperationsBackupDatabaseState, verifyOperationsCrmBackupDatabaseState
} from './scoped-service-release.mjs'
import {
	OPERATIONS_BACKUP_TRUST, OPERATIONS_BACKUP_TRUST_TARGETS,
	assertOperationsBackupManifestImages, assertOperationsBackupTrustProof,
	createOperationsBackupTrustInput, validateOperationsBackupTrustInput,
	verifyOperationsBackupTrustState
} from './scoped-service-release.mjs'

// Exact public fixture: Services 65025008d4aa993adb96df435a744a29c4f021d3,
// apps/operations/restore-manifests/database-restore-migrations.json.
const legacyTrustManifest = {
	"schemaVersion": 1,
	"targets": {
		"notification-delivery": {
			"manifestSha256": "7fac808a05dd1d01fe8ef86e0378d2fefa7c7d39cbbccef1bcd51b956a45289f",
			"migrations": [
				{
					"name": "20260727000000_init_notification_delivery",
					"checksum": "dcedb9dc4a5cf766a61e03488eb4c154783f5ee6426f68965f632b720a7abab8"
				},
				{
					"name": "20260728000000_expand_notification_delivery_telegram_kinds",
					"checksum": "b57353faacf4e8863b7712dcc1c4e80dc9e66fd7364bcc4b9360c76467a153b3"
				},
				{
					"name": "20260728010000_add_delivery_checkpoint",
					"checksum": "a03ecfb514b0a75b4dc73711c36b3899b75d7d0e628a11789049fcb8cb435b77"
				},
				{
					"name": "20260730020000_allow_campaign_delivery_outcome_v2",
					"checksum": "41ff84b50d7a4284554e10d0fc194cfe18e7e15c29b1f953354c1db9aed72a2c"
				},
				{
					"name": "20260804030000_split_reporting_delivery_outcome_route",
					"checksum": "fed7b0bbdc5906c592c1bdc2d2c2d62b6f84a3e1227f6b322d700fd30f278089"
				},
				{
					"name": "20260828000000_remove_online_consultant_delivery_data",
					"checksum": "b87064c3e4269c660c5cd16d8e83afbfb78c3362afc8c30f1b9a9efa927d4596"
				},
				{
					"name": "20260830020000_harden_default_routine_acl",
					"checksum": "8fb3b0ffb05281d0b9e28aa2ea77d52f47101aebb8ff6b9f5c88b20825f471af"
				},
				{
					"name": "20260830030000_add_notification_delivery_retention_contract",
					"checksum": "a23bebd290dd472103075fda199ebc46ccf733fdc4cd8f50447e8dd412058f87"
				}
			]
		},
		"campaigns": {
			"manifestSha256": "ae6aee9d4f9b0e02f7e2621d0e869245228c04adaf1763c2f4f2df658dee9c49",
			"migrations": [
				{
					"name": "20260730000000_init_campaigns",
					"checksum": "f2228444eb76ed3d91cfd98af0be45b908359d19ddf0789790fc528ff00be778"
				},
				{
					"name": "20260814010000_add_audience_source_evidence",
					"checksum": "44c229a886e81834dace116579479df2a69d9e34a0b841d8be82eee3a13839d3"
				},
				{
					"name": "20260830020000_harden_default_routine_acl",
					"checksum": "a5ea83a5d6dfe2d7507b3db0cec66921ef9956a69a5d57e657d0b13613764ac5"
				}
			]
		},
		"reporting": {
			"manifestSha256": "1d1729b87523a387998506dff1d35266e27f4e6063f2759776566adc0792bfeb",
			"migrations": [
				{
					"name": "20260731000000_init_reporting",
					"checksum": "30dd74dbd4415944bf931b4f8e4d6f901731c2c712721346a562020a9366527c"
				},
				{
					"name": "20260731010000_add_core_operational_alerts_topic",
					"checksum": "49eb56ff848191b5d0ccfe3106d5e26e3537bf074ac218bc752bbe3888800aeb"
				},
				{
					"name": "20260731020000_add_schedule_authority_generation",
					"checksum": "93921d81576c80d1744bd751b7d93ce1ed8f1bfed3b7e2c3bc271f0fa74e2728"
				},
				{
					"name": "20260826020000_remove_core_runtime_dependencies",
					"checksum": "dac19d6bb8c5e35efee9729fc5cc513f39f12e84bae0e168f5f47d591aa920e9"
				},
				{
					"name": "20260827030000_replace_online_consultant_with_ai_consultant",
					"checksum": "0ffa70d09c41d51918c944c0d0b597d30798421eb8b19b43ea0a15b57b3a3592"
				},
				{
					"name": "20260830020000_harden_default_routine_acl",
					"checksum": "4023cc6ce9c58e2e72f0200512388e49dc23a4a2427dd1c3d97e7f2a65ca68b4"
				}
			]
		},
		"widgets": {
			"manifestSha256": "62cdb4c0a804dea3f090ac01d6a932baa732d5913f098c9cc165b35516d693d6",
			"migrations": [
				{
					"name": "20260804000000_init_widgets",
					"checksum": "a7fa21047bec5e15b21a7b9d8551a90c2cc5aa293ae5b83477f30ab3499b6bc3"
				},
				{
					"name": "20260806000000_add_widgets_retention",
					"checksum": "595cb0838460a5caf67b668b6e10a0bc840c043c1784a886634493937d72a962"
				},
				{
					"name": "20260827010000_remove_legacy_reporting_handoff",
					"checksum": "4834731c4e6577a96592b516c2dd78924650b39daed95daffe20c996fd0de742"
				},
				{
					"name": "20260827030000_rename_projection_aggregate_namespaces",
					"checksum": "2ffdbf115c0dc52f8b333123e3a5df8144ad5f9409d94f7a71a4417737391cc4"
				},
				{
					"name": "20260827210000_replace_online_consultant_with_ai_consultant",
					"checksum": "eae761af20092cb97b7e6fd51dfeb82be854e4b9f5c394ae65d2bb15223f6b4e"
				},
				{
					"name": "20260828010000_add_callback_otp_verification",
					"checksum": "5c752e87c819cafee943f1128f247386af10762e8be1dc7a8d8297ff4bdc1bad"
				},
				{
					"name": "20260830020000_harden_default_routine_acl",
					"checksum": "fa8874bdbb8bb43c9534bf4bf69bce24fbfd74777ddef432e329d8ab8da4c0e1"
				},
				{
					"name": "20260830030000_add_ai_consent_receipts",
					"checksum": "e5196d8d871b4256b32d9d66cc29c70f80b09ec9b59a644c8e57c418c2c35cb3"
				}
			]
		},
		"identity": {
			"manifestSha256": "c6b9ca960709ee22ea3bf408d14fe005557645784c8057aac3a37676bfc6303a",
			"migrations": [
				{
					"name": "20260814000000_init_identity",
					"checksum": "a56618b90b881d8a63482d4eba458148e6bc09b6a15950e288ac36d5bad4f9e1"
				},
				{
					"name": "20260823000000_clear_legacy_managed_avatar_paths",
					"checksum": "85ce014e36872ed2fc04f17b471c1b75b640f6545611c2c14cb8167cb778b770"
				},
				{
					"name": "20260827020000_remove_legacy_ownership_state",
					"checksum": "66df1dd8c3e52eb8c4a47e867f67bdaf6313b0f6bdcbf3e1851800e1b3b7a7ec"
				},
				{
					"name": "20260830020000_harden_default_routine_acl",
					"checksum": "be8118f8e5d7bdf75388779695641eb289640bc9d5bcaf572fbea3111553b73f"
				},
				{
					"name": "20260910010000_add_login_otp",
					"checksum": "314f52d752f36d8ea039a4f2c0094d750d62da59c0d63686e7f64de619e71e80"
				}
			]
		},
		"platform": {
			"manifestSha256": "554e36e09dd1b06f1cd107dfc3eaa1d57b4e6bd119e1709726b5280a1be82791",
			"migrations": [
				{
					"name": "20260823000000_init_platform",
					"checksum": "dab6eab5162dab9b8124457e122240792b4b15d70415fd726fc7dd5c708ae0fa"
				},
				{
					"name": "20260823010000_fix_service_identity_timestamp_monotonicity",
					"checksum": "201b82886579dc079f23d19ac41bbc3ef13eaee935a4302de869c79f1b7d8fb1"
				},
				{
					"name": "20260825000000_remove_legacy_demo_widget_labels",
					"checksum": "1d56bef0a69639ed24f9c912c146b98b55e4ce35fcd6816342c474872adc572a"
				},
				{
					"name": "20260827020000_remove_legacy_cutover_state",
					"checksum": "134fa1bc281ec996dbfa7df89d5a4fbbccf7d4716b9dad3d9e82bfcba4e6f8c9"
				},
				{
					"name": "20260827220000_replace_online_consultant_home_content",
					"checksum": "fe0fb0aa5ace973109cdbd2bbeee57f6c9b9cfb7cbd4b39adbc41da3fba045ad"
				},
				{
					"name": "20260828010000_publish_ai_consultant_home_card",
					"checksum": "1c18986e25274a1133f3b4002ae317f19dffc580fe36013583948bb54355a8c3"
				},
				{
					"name": "20260828020000_restore_selected_home_content",
					"checksum": "83c2d11d523510e9697d283fe000ecee2ee940d52f9f796323f47bd934f7ef73"
				},
				{
					"name": "20260830020000_harden_default_routine_acl",
					"checksum": "e106c9920d82fcfcef81f61b507c50ca415c061a19a8eac30c619b9fc861044e"
				}
			]
		},
		"support": {
			"manifestSha256": "40f3627571d7eadddf6430538f327871b2d4270b14ebfc7c025842d3aea7fe7e",
			"migrations": [
				{
					"name": "20260824010000_init_support",
					"checksum": "fe07f320c5acece381f1232709138d7ee55eab4de7f74da52a3f26ea56aef258"
				},
				{
					"name": "20260827020100_remove_legacy_cutover_state",
					"checksum": "70575b79e21d119993a88043f0d661669d4948768036f10506ea934bfb75916c"
				},
				{
					"name": "20260830020000_harden_default_routine_acl",
					"checksum": "8a7b82e266d02b2dd9da4ccd9c4bbd884d266ebf9c9b5b39011ea1dd97a24334"
				}
			]
		}
	}
}

const trustManifest = structuredClone(legacyTrustManifest)
for (const [target, additions] of Object.entries({
	'notification-delivery': [
		['20260907000000_add_wincrm_invitation_email', 'dcbb2dded41b89ed178384893e03952ca8566f5556ce7a9d44ec5a4d67901983'],
		['20260907230000_add_wincrm_task_reminders', 'ecd2b1677dccc6c0515ef38baf28a4407c0ae4882c68bbcf4d60da11fd807b27']
	],
	widgets: [['20260907010000_add_native_wincrm_connector', '48522f742401eb3f8067ba75bc13ebbc09755f062d323e37c93d0a9698f364c4']],
	identity: [
		['20260902080000_add_workspaces_and_refresh_rotation', 'e40b381bacdc09658edb72fb8de63348ccef87aec67653c2d4de735f7afd57d6'],
		['20260906010000_add_wincrm_workspace_invitations', 'ba972d159327e8de05f4b997850d99f7577591f414e8bd09b02781c5ab72d9fb']
	]
})) {
	const migrations = [...trustManifest.targets[target].migrations, ...additions.map(([name, checksum]) => ({name, checksum}))].sort((a,b) => a.name.localeCompare(b.name))
	trustManifest.targets[target] = { manifestSha256: sha256(JSON.stringify({schemaVersion:1,target,migrations})), migrations }
}
test('backup manifest transition permits exactly the reviewed public pair without changing the keyring/schema', () => {
	const inventory = manifest => {
		const restoreManifestText = JSON.stringify(manifest, null, '\t') + '\n'
		return {schemaVersion:1,schemaSha256:'a'.repeat(64),generatedSchemaSha256:'a'.repeat(64),keyringSha256:'b'.repeat(64),migrations:[{name:'20260101000000_initial',checksum:'c'.repeat(64)}],restoreManifestText,restoreManifestSha256:sha256(restoreManifestText)}
	}
	const before=inventory(legacyTrustManifest),after=inventory(trustManifest)
	assert.equal(before.restoreManifestSha256,OPERATIONS_BACKUP_TRUST.before)
	assert.equal(after.restoreManifestSha256,OPERATIONS_BACKUP_TRUST.after)
	assert.doesNotThrow(()=>assertOperationsBackupManifestImages(before,after))
	for(const property of ['schemaSha256','keyringSha256','generatedSchemaSha256','restoreManifestSha256']) assert.throws(()=>assertOperationsBackupManifestImages(before,{...after,[property]:'0'.repeat(64)}))
	assert.throws(()=>assertOperationsBackupManifestImages(before,{...after,restoreManifestText:after.restoreManifestText+' '}))
})
test('restore owner probe receives only three existing worker backup credentials', () => {
	const environment=Object.fromEntries(OPERATIONS_BACKUP_TRUST_TARGETS.map(([target,key,port])=>[key,`postgresql://winwidget_${target.replaceAll('-','_')}_backup:synthetic@127.0.0.1:${port}/winwidget_${target.replaceAll('-','_')}?schema=${target.replaceAll('-','_')}&sslmode=disable`]))
	const desired={services:{'operations-worker':{environment},'operations-api':{environment:{}}}}
	const input=JSON.parse(createOperationsBackupTrustInput(desired))
	assert.deepEqual(validateOperationsBackupTrustInput(input),input)
	assert.deepEqual(Object.keys(input.urls),OPERATIONS_BACKUP_TRUST_TARGETS.map(row=>row[0]))
	assert.throws(()=>validateOperationsBackupTrustInput({...input,extra:true}))
	const bad=structuredClone(input);bad.urls.identity=bad.urls.identity.replace('127.0.0.1','example.com');assert.throws(()=>validateOperationsBackupTrustInput(bad))
	desired.services['operations-api'].environment.IDENTITY_BACKUP_URL=environment.IDENTITY_BACKUP_URL
	assert.throws(()=>createOperationsBackupTrustInput(desired))
})
test('restore owner proof must be fresh and preserve all three identities, ledgers and ACLs', () => {
	const now=Date.now(), value={schemaVersion:1,checkedAt:new Date(now).toISOString(),manifestSha256:OPERATIONS_BACKUP_TRUST.after,targets:OPERATIONS_BACKUP_TRUST_TARGETS.map(([target,,,manifestSha256])=>({target,manifestSha256,identitySha256:'a'.repeat(64),aclSha256:'b'.repeat(64)}))}
	assert.doesNotThrow(()=>assertOperationsBackupTrustProof(value,value,now))
	assert.throws(()=>assertOperationsBackupTrustProof(value,value,now+60001))
	assert.throws(()=>assertOperationsBackupTrustProof(value,value,now-1))
	for(const key of ['identitySha256','aclSha256','manifestSha256']){const changed=structuredClone(value);changed.targets[0][key]='c'.repeat(64);assert.throws(()=>assertOperationsBackupTrustProof(changed,value,now))}
})
test('owner ledger verification uses the ND database anchor and service identities only where they exist', async () => {
	for (const [target,,,digest] of OPERATIONS_BACKUP_TRUST_TARGETS) {
		const schema=target.replaceAll('-','_'), manifest=trustManifest.targets[target], calls=[]
		const ledger=manifest.migrations.map((row,i)=>({id:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,migration_name:row.name,checksum:row.checksum,finished_at:new Date(),rolled_back_at:null}))
		const client={$queryRawUnsafe:async sql=>{calls.push(sql)
			if(sql==='SHOW transaction_read_only')return [{transaction_read_only:'on'}]
			if(sql==='SHOW server_version_num')return [{server_version_num:'180003'}]
			if(sql.includes('AS database_oid'))return [{database:`winwidget_${schema}`,username:`winwidget_${schema}_backup`,session_user:`winwidget_${schema}_backup`,schema,recovery:false,database_oid:'16596'}]
			if(sql.includes('AS restricted'))return [{restricted:true,no_memberships:true,database_owner:true,schema_owner:true,connect:true,no_database_ddl:true,read_schema:true,no_dml:true,no_routine_execute:true}]
			if(sql.includes('_prisma_migrations'))return ledger
			if(sql.includes('service_identity'))return [{id:'singleton',service_name:`${target}-service`,database_id:'11111111-1111-4111-8111-111111111111'}]
			if(sql.includes('AS acl_sha256'))return [{acl_sha256:'d'.repeat(64)}]
			throw Error('Unexpected SQL')
		}}
		const proof=await verifyOperationsBackupTrustState(client,target,manifest)
		assert.equal(proof.manifestSha256,digest)
		assert.equal(calls.some(sql=>sql.includes('service_identity')),target!=='notification-delivery')
		ledger[0].rolled_back_at=new Date()
		await assert.rejects(verifyOperationsBackupTrustState(client,target,manifest))
	}
})

test('ND backup trust recognizes only the exact reviewed historical failed-and-recovered receipt pair', async () => {
	const target='notification-delivery', schema='notification_delivery', manifest=trustManifest.targets[target], calls=[];
	const name='20260828000000_remove_online_consultant_delivery_data';
	const reviewed=[
		{id:'9fcc2093-f12e-4c6b-9633-0687acbc2320', migration_name:name, checksum:'c19ca8b79eae01ef55034640ed0c1fb3fd6aa9700bdd7c403e5ef6f6e7cc76e4', started_at:'2026-08-28 06:44:36.325562+00', finished_at:null, rolled_back_at:'2026-08-28 07:33:40.575583+00', applied_steps_count:0, logs_fingerprint:'d41d8cd98f00b204e9800998ecf8427e'},
		{id:'18a2268c-e992-4115-82be-0c80552297bc', migration_name:name, checksum:'b87064c3e4269c660c5cd16d8e83afbfb78c3362afc8c30f1b9a9efa927d4596', started_at:'2026-08-28 07:37:05.763502+00', finished_at:'2026-08-28 07:37:05.780369+00', rolled_back_at:null, applied_steps_count:1, logs_fingerprint:'d41d8cd98f00b204e9800998ecf8427e'}
	];
	const normal=manifest.migrations.filter(row=>row.name!==name).map((row,i)=>({id:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`, migration_name:row.name, checksum:row.checksum, started_at:'2026-08-01 00:00:00.000001+00', finished_at:'2026-08-01 00:00:01.000001+00', rolled_back_at:null, applied_steps_count:1, logs_fingerprint:'d41d8cd98f00b204e9800998ecf8427e'}));
	let ledger;
	const reset=()=>{ledger=structuredClone([...normal,...reviewed]).sort((a,b)=>a.migration_name.localeCompare(b.migration_name)||a.id.localeCompare(b.id));};
	const client={$queryRawUnsafe:async sql=>{calls.push(sql);
		if(sql==='SHOW transaction_read_only')return [{transaction_read_only:'on'}];
		if(sql==='SHOW server_version_num')return [{server_version_num:'180003'}];
		if(sql.includes('AS database_oid'))return [{database:`winwidget_${schema}`,username:`winwidget_${schema}_backup`,session_user:`winwidget_${schema}_backup`,schema,recovery:false,database_oid:'16596'}];
		if(sql.includes('AS restricted'))return [{restricted:true,no_memberships:true,database_owner:true,schema_owner:true,connect:true,no_database_ddl:true,read_schema:true,no_dml:true,no_routine_execute:true}];
		if(sql.includes('_prisma_migrations'))return ledger;
		if(sql.includes('AS acl_sha256'))return [{acl_sha256:'d'.repeat(64)}];
		throw Error('Unexpected SQL');
	}};
	reset();
	const proof=await verifyOperationsBackupTrustState(client,target,manifest);
	assert.equal(proof.manifestSha256,OPERATIONS_BACKUP_TRUST_TARGETS[0][3]);
	const query=calls.find(sql=>sql.includes('_prisma_migrations'));
	assert.match(query,/to_char\(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS\.US'\)/);
	assert.match(query,/applied_steps_count, md5\(coalesce\(logs, ''\)\) AS logs_fingerprint/);
	assert.equal(calls.some(sql=>/^\s*(ALTER|INSERT|UPDATE|DELETE)\b|service_identity/.test(sql)),false);
	for (const expected of reviewed) {
		for (const key of Object.keys(expected)) {
			reset();
			const row=ledger.find(row=>row.id===expected.id);
			row[key]=typeof expected[key]==='number'?expected[key]+1:expected[key]===null?'2026-08-28 09:00:00.000000+00':expected[key]+'changed';
			await assert.rejects(verifyOperationsBackupTrustState(client,target,manifest),`changed reviewed ${expected.id}/${key}`);
		}
		reset(); ledger=ledger.filter(row=>row.id!==expected.id);
		await assert.rejects(verifyOperationsBackupTrustState(client,target,manifest),'incomplete reviewed pair');
	}
	for (const mutate of [
		rows=>rows.push({...reviewed[0],id:'33333333-3333-4333-8333-333333333333'}),
		rows=>rows.push({...reviewed[1],id:'44444444-4444-4444-8444-444444444444'}),
		rows=>rows.push({...reviewed[0],migration_name:'unknown_migration',id:'55555555-5555-4555-8555-555555555555'}),
		rows=>{rows[0].rolled_back_at='2026-08-28 09:00:00.000000+00';},
		rows=>{rows[0].finished_at=null;},
		rows=>{rows[0].checksum='f'.repeat(64);},
		rows=>{rows[0].migration_name='unknown_migration';}
	]) {reset();mutate(ledger);await assert.rejects(verifyOperationsBackupTrustState(client,target,manifest));}
	reset();
	const changed=structuredClone(manifest);
	changed.migrations.find(row=>row.name===name).checksum=reviewed[0].checksum;
	await assert.rejects(verifyOperationsBackupTrustState(client,target,changed),'source SQL must match reviewed successful checksum');
})

const migrationUrl = 'postgresql://winwidget_operations_migration:synthetic%40password@127.0.0.1:55441/winwidget_operations?schema=operations&sslmode=disable'
const fixture = () => {
	const services = Object.fromEntries(['operations-api', 'operations-worker', 'operations-outbox-publisher', 'operations-restore-worker'].map(name => [name, { environment: {} }]))
	services['operations-api'].environment.OPERATIONS_DATABASE_URL = migrationUrl.replace('_migration:', '_runtime:')
	for (const [key, schema, port] of OPERATIONS_CRM_BACKUP_TARGETS)
		services['operations-worker'].environment[key] = `postgresql://winwidget_${schema}_backup:synthetic%3Apassword@127.0.0.1:${port}/winwidget_${schema}?schema=${schema}&sslmode=disable`
	return { services }
}
const envelope = () => JSON.parse(createOperationsBackupProbeInput(`UNRELATED_SECRET=not-for-probe\nOPERATIONS_MIGRATION_DATABASE_URL=${migrationUrl}\n`, fixture()))

test('input includes exactly five selected URLs, accepts env quoting and never forwards unrelated secrets', () => {
	for (const value of [migrationUrl, JSON.stringify(migrationUrl), `'${migrationUrl}'`]) {
		const desired = fixture(), before = structuredClone(desired)
		const bytes = createOperationsBackupProbeInput(Buffer.from(`UNRELATED_SECRET=not-for-probe\nOPERATIONS_MIGRATION_DATABASE_URL=${value}\nCRM_ACCESS_BACKUP_URL=ignored-owner-env\n`), desired)
		assert.ok(Buffer.isBuffer(bytes) && bytes.length <= 32768)
		assert.doesNotMatch(bytes.toString(), /not-for-probe|ignored-owner-env|UNRELATED/)
		const input = JSON.parse(bytes)
		assert.deepEqual(Object.keys(input), ['schemaVersion', 'operationsMigrationUrl', 'crmBackupUrls'])
		assert.deepEqual(Object.keys(input.crmBackupUrls), ['crm-access', 'crm-intake', 'crm-customers', 'crm-sales'])
		assert.deepEqual(validateOperationsBackupProbeInput(input), input)
		assert.deepEqual(desired, before)
	}
})

test('owner env rejects duplicate/missing/oversized/malformed input with no private error values', () => {
	for (const text of ['', `OPERATIONS_MIGRATION_DATABASE_URL=${migrationUrl}\nOPERATIONS_MIGRATION_DATABASE_URL=${migrationUrl}`,
		`OTHER=first\nOTHER=second\nOPERATIONS_MIGRATION_DATABASE_URL=${migrationUrl}`, 'INVALID LINE synthetic-secret',
		`OPERATIONS_MIGRATION_DATABASE_URL="unterminated-synthetic-secret`, `OPERATIONS_MIGRATION_DATABASE_URL=${migrationUrl}\0`, 'x'.repeat(1048577)]) {
		assert.throws(() => createOperationsBackupProbeInput(text, fixture()), error =>
			/ private details suppressed/.test(error.message) && !/postgresql|synthetic|unterminated/.test(error.message))
	}
})

test('input rejects wrong runtime binding, misplaced CRM credentials and absent worker URL', () => {
	for (const mutate of [
		value => { value.services['operations-api'].environment.OPERATIONS_DATABASE_URL = migrationUrl },
		value => { value.services['operations-api'].environment.OPERATIONS_DATABASE_URL = migrationUrl.replace('_migration:', '_runtime:').replace('55441', '55442') },
		value => { value.services['operations-api'].environment.CRM_ACCESS_BACKUP_URL = value.services['operations-worker'].environment.CRM_ACCESS_BACKUP_URL },
		value => { delete value.services['operations-worker'].environment.CRM_SALES_BACKUP_URL },
		value => { value.services.extra = { environment: { CRM_ACCESS_BACKUP_URL: '' } } }
	]) {
		const value = fixture(); mutate(value)
		assert.throws(() => createOperationsBackupProbeInput(`OPERATIONS_MIGRATION_DATABASE_URL=${migrationUrl}`, value), /private details suppressed/)
	}
})

test('strict envelope and all five private URLs fail closed on authority overrides', () => {
	for (const change of [
		value => { value.schemaVersion = 2 }, value => { value.extra = true },
		value => { delete value.operationsMigrationUrl }, value => { value.crmBackupUrls.extra = migrationUrl },
		value => { delete value.crmBackupUrls['crm-sales'] }, value => { value.crmBackupUrls = [] }
	]) { const input = envelope(); change(input); assert.throws(() => validateOperationsBackupProbeInput(input), /private details suppressed/) }
	for (const field of ['operationsMigrationUrl', ...Object.keys(envelope().crmBackupUrls)]) {
		const baseline = envelope(), original = field === 'operationsMigrationUrl' ? baseline[field] : baseline.crmBackupUrls[field]
		for (const bad of [null, '', 'invalid', 'x'.repeat(4097), original.replace('postgresql:', 'https:'), original.replace('127.0.0.1', '192.0.2.1'),
			original.replace(/:5544[1-5]\//, ':5432/'), original.replace(/_(migration|backup):/, '_runtime:'), original.replace(/:[^:@]+@/, '@'),
			original.replace('schema=', 'other='), original.replace('sslmode=disable', 'sslmode=require'),
			...['#fragment', '&schema=other', '&%73chema=other', '&sslmode=disable', '&host=other', '&password=other', '&user=owner', '&options=-csearch_path=public'].map(suffix => original + suffix)]) {
			const input = structuredClone(baseline)
			if (field === 'operationsMigrationUrl') input[field] = bad
			else input.crmBackupUrls[field] = bad
			assert.throws(() => validateOperationsBackupProbeInput(input), error =>
				/private details suppressed/.test(error.message) && !/synthetic|postgresql|192\.0\.2/.test(error.message))
		}
	}
})

const databaseId = '11111111-1111-4111-8111-111111111111'
const checksum = 'a'.repeat(64), schemaSha256 = 'b'.repeat(64)
const crmFiles = [{ name: '20260901000000_init', checksum }]
const operationFiles = [...crmFiles, { name: NOTES_MIGRATION, checksum: 'c'.repeat(64) }]
const manifestFor = target => ({ target, migrations: crmFiles, manifestSha256: sha256(JSON.stringify({ schemaVersion: 1, target, migrations: crmFiles })) })
const ledgerFor = files => files.map(item => ({ migration_name: item.name, checksum: item.checksum, finished_at: new Date('2026-09-01'), rolled_back_at: null }))
function databaseFixture(schema = 'operations') {
	const role = schema === 'operations' ? 'migration' : 'backup'
	const f = {
		readOnly: 'on', version: '180001', queries: [], counters: {}, lease: null,
		identity: { database: `winwidget_${schema}`, username: `winwidget_${schema}_${role}`, session_user: `winwidget_${schema}_${role}`, schema, recovery: false },
		principal: { restricted: true, no_memberships: true, database_owner_matches: true, schema_owner_matches: true, connect: true, no_database_ddl: true, schema_usage: true, schema_create: role === 'migration' },
		serviceIdentity: [{ id: 'singleton', service_name: `${schema.replaceAll('_', '-')}-service`, database_id: databaseId }],
		ledger: ledgerFor(crmFiles), metadata: [{ schema_sha256: schemaSha256 }],
		foreign: { no_public: true, no_foreign_database: true, no_foreign_schema: true },
		relations: ['_prisma_migrations', 'service_identity', 'records'].map(name => ({ name, kind: 'r', owner: `winwidget_${schema}_migration`, rls: false, forced_rls: false, readable: true, writable: false, sequence_readable: false, sequence_writable: false })),
		enums: [{ name: 'Status', owner: `winwidget_${schema}_migration`, usable: true }],
		routines: [{ name: 'state_guard', owner: `winwidget_${schema}_migration`, args: 0, trigger: true, security_definer: false, executable: false }]
	}
	const client = { $queryRawUnsafe: async query => {
		f.queries.push(query)
		assert.match(query, /^(?:SELECT|SHOW) /, 'transaction checker must not execute a mutation')
		if (query === 'SHOW transaction_read_only') return [{ transaction_read_only: f.readOnly }]
		if (query === 'SHOW server_version_num') return [{ server_version_num: f.version }]
		if (query.startsWith('SELECT current_database()')) return [f.identity]
		if (query.includes('FROM pg_roles roles')) {
			assert.ok(query.includes(`pg_get_userbyid(datdba) = 'winwidget_${schema}_admin'`), 'database owner must match service bootstrap contract')
			assert.ok(!query.includes('_owner_admin'))
			return [f.principal]
		}
		if (query.includes('SELECT id, service_name')) return f.serviceIdentity
		if (query.includes('SELECT migration_name')) return f.ledger
		if (query.includes('AS schema_sha256')) return f.metadata
		if (query.includes('AS no_public')) return [f.foreign]
		if (query.startsWith('SELECT c.relname AS name')) return f.relations
		if (query.startsWith('SELECT t.typname AS name')) return f.enums
		if (query.startsWith('SELECT p.proname AS name')) return f.routines
		throw new Error('Unexpected readonly query')
	} }
	for (const model of ['scheduledJobRun', 'outboxEvent', 'auditEventReceipt', 'integrationDeliveryReceipt', 'databaseRestoreJob', 'databaseRestorePermit', 'databaseRestoreRecoveryAction'])
		client[model] = { count: async args => { f.queries.push({ model, args }); return f.counters[model] ?? 0 } }
	client.databaseRestoreExecutionLease = { findUnique: async () => f.lease }
	return { ...f, client, state: f }
}

test('Operations observes pending or applied Notes migration without imposing phase-A or changing data', async () => {
	for (const files of [crmFiles, operationFiles]) {
		const f = databaseFixture(); f.state.ledger = ledgerFor(files)
		const result = await verifyOperationsBackupDatabaseState(f.client, operationFiles)
		assert.deepEqual(result, { databaseId, schemaSha256, ledgerSha256: sha256(JSON.stringify(files)), quiet: true })
		assert.doesNotMatch(JSON.stringify(result), /username|password|migration_name|service_name|queries/)
		assert.ok(f.queries.some(query => query.model === 'auditEventReceipt'))
	}
})

test('Operations reports busy counts/restore lease without hiding them as quiet after worker starts', async () => {
	for (const busy of ['scheduledJobRun', 'outboxEvent', 'auditEventReceipt', 'integrationDeliveryReceipt', 'databaseRestoreJob', 'databaseRestorePermit', 'databaseRestoreRecoveryAction', 'lease']) {
		const f = databaseFixture()
		if (busy === 'lease') f.state.lease = { operationType: 'RESTORE', operationId: databaseId, leaseOwner: null, leaseToken: null }
		else f.state.counters[busy] = 1
		assert.equal((await verifyOperationsBackupDatabaseState(f.client, operationFiles)).quiet, false)
	}
})

test('Operations fails on unknown identity, writable transaction, failed/drifted ledger or unsafe role', async () => {
	for (const mutate of [
		f => { f.readOnly = 'off' }, f => { f.version = '170009' }, f => { f.identity.database = 'other' },
		f => { f.identity.session_user = 'owner' }, f => { f.identity.recovery = true }, f => { f.principal.restricted = false },
		f => { f.principal.database_owner_matches = false }, f => { f.serviceIdentity[0].database_id = 'bad' },
		f => { f.serviceIdentity[0].service_name = 'other-service' }, f => { f.ledger[0].checksum = 'd'.repeat(64) },
		f => { f.ledger[0].finished_at = null }, f => { f.ledger[0].rolled_back_at = new Date() },
		f => { f.ledger.push(f.ledger[0]) }, f => { f.metadata[0].schema_sha256 = 'bad' }, f => { f.counters.scheduledJobRun = -1 }
	]) { const f = databaseFixture(); mutate(f.state); await assert.rejects(verifyOperationsBackupDatabaseState(f.client, operationFiles)) }
})

test('four CRM backup readers verify exact ledger and return only safe identity/manifest evidence', async () => {
	for (const [, schema] of OPERATIONS_CRM_BACKUP_TARGETS) {
		const target = schema.replaceAll('_', '-'), f = databaseFixture(schema), manifest = manifestFor(target)
		assert.deepEqual(await verifyOperationsCrmBackupDatabaseState(f.client, target, manifest), { target, databaseId, manifestSha256: manifest.manifestSha256 })
		assert.ok(f.queries.some(query => typeof query === 'string' && query.includes('MAINTAIN')))
		assert.ok(f.queries.some(query => typeof query === 'string' && query.includes('has_any_column_privilege')))
	}
})

test('CRM rejects incomplete backup ACLs, inherited/elevated privilege, RLS and writable sequences/functions', async () => {
	for (const mutate of [
		f => { f.principal.no_memberships = false }, f => { f.principal.schema_create = true }, f => { f.principal.no_database_ddl = false },
		f => { f.foreign.no_foreign_schema = false }, f => { f.foreign.no_public = false }, f => { f.foreign.no_foreign_database = false },
		f => { f.relations[0].readable = false }, f => { f.relations[1].writable = true }, f => { f.relations[1].rls = true },
		f => { f.relations[1].forced_rls = true }, f => { f.relations[1].owner = 'owner' }, f => { f.relations[1].kind = 'f' },
		f => { f.relations[1].sequence_writable = true }, f => { f.relations = [] }, f => { f.enums[0].usable = false },
		f => { f.routines[0].executable = true }, f => { f.routines[0].security_definer = true }, f => { f.routines[0].args = 1 },
		f => { f.ledger[0].finished_at = null }, f => { f.ledger.push(f.ledger[0]) }, f => { f.serviceIdentity[0].service_name = 'operations-service' }
	]) { const f = databaseFixture('crm_access'); mutate(f.state); await assert.rejects(verifyOperationsCrmBackupDatabaseState(f.client, 'crm-access', manifestFor('crm-access'))) }
})

test('runtime probe constructs only bounded readonly sessions, uses candidate manifest parser and never process env credentials', () => {
	const source = readFileSync(new URL('./scoped-service-release.mjs', import.meta.url), 'utf8')
	const body = source.slice(source.indexOf('export async function verifyOperationsBackupDatabases(value)'), source.indexOf('\nasync function main()'))
	assert.match(body, /assert\.equal\(process\.getuid\(\), 1001\)/)
	assert.match(body, /parseDatabaseBackupMigrationManifests/)
	assert.match(body, /SET TRANSACTION READ ONLY/)
	assert.match(body, /isolationLevel: 'RepeatableRead', timeout: 10000, maxWait: 5000/)
	assert.match(body, /finally \{ await client\.\$disconnect\(\); \}/)
	assert.doesNotMatch(body, /process\.env|spawn\(|pg_dump|GRANT |REVOKE |INSERT |UPDATE |DELETE /)
})
