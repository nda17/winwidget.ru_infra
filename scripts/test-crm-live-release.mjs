import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { liveBaseline, prepareLiveCompose, verifyLiveImages, LIVE_OWNERS, LIVE_TARGETS, LIVE_MIGRATION } from './crm-live-release.mjs';
import { sha256 } from './scoped-service-release.mjs';
const revision='a'.repeat(40),old='b'.repeat(40),digest='c'.repeat(64);
function fixture(){
 const input={revision,expectedLiveRevision:old,envHashes:{canonical:digest,crm:digest,support:digest,operations:digest},live:[],configs:{},images:{}};
 for(const owner of LIVE_OWNERS){
  input.configs[owner]={services:{}};
  input.images[owner]={before:{Id:'sha256:'+'d'.repeat(64),Config:{Env:['PATH=/usr/bin'],Labels:{'org.opencontainers.image.revision':old},Cmd:['node','main.js'],Entrypoint:null,User:''}},after:{Id:'sha256:'+'e'.repeat(64),Config:{Env:['PATH=/usr/bin'],Labels:{'org.opencontainers.image.revision':revision},Cmd:['node','main.js'],Entrypoint:null,User:''}}};
 }
 for(const [i,name]of [...LIVE_TARGETS,...Array.from({length:12},(_,i)=>'neighbor-'+i)].entries()){
  const owner=LIVE_OWNERS.find(owner=>name.startsWith(owner+'-')),environment={APP_REVISION:old,SECRET:'synthetic-test-value'};
  input.live.push({Id:(i+1).toString(16).padStart(64,'0'),Name:name,Image:'sha256:'+'d'.repeat(64),State:{Status:'running',Health:{Status:'healthy'}},Config:{Env:['PATH=/usr/bin',...Object.entries(environment).map(([key,value])=>key+'='+value)],Labels:{'com.docker.compose.service':name,'com.docker.compose.project':name.startsWith('crm-')?'winwidget-crm':'winwidget','org.opencontainers.image.revision':old},Cmd:['node','main.js'],Entrypoint:null,User:'',Healthcheck:{Test:['CMD','true']},StopTimeout:10},HostConfig:{NetworkMode:'host',Privileged:false,RestartPolicy:{Name:'no'},LogConfig:{Type:'json-file',Config:{}}},Mounts:[]});
  if(owner)input.configs[owner].services[name]={network_mode:'host',stop_grace_period:'10s',environment,healthcheck:{test:['CMD','true']},depends_on:{database:{condition:'service_healthy'}},build:{context:'/synthetic'}};
 }
 input.expectedBaseline=liveBaseline(input.live,input.envHashes);return input;
}
test('updates precisely eight processes in their existing Compose projects and retains rollback config',()=>{
 const input=fixture(),result=prepareLiveCompose(input);
 assert.equal(Object.keys(result.winwidget.desired.services).length,5);assert.equal(Object.keys(result['winwidget-crm'].desired.services).length,3);
 for(const project of Object.values(result))for(const name of Object.keys(project.desired.services)){
  assert.equal(project.desired.services[name].environment.APP_REVISION,revision);assert.equal(project.rollback.services[name].environment.APP_REVISION,old);
  assert.equal(project.desired.services[name].environment.SECRET,'synthetic-test-value');assert.equal(project.desired.services[name].build,undefined);assert.equal(project.desired.services[name].depends_on,undefined);
 }
});
test('fails closed on stale baseline, foreign env, resources, role or image changes',()=>{
 for(const mutate of [input=>input.envHashes.crm='f'.repeat(64),input=>input.live[10].Id='f'.repeat(64),input=>input.configs.support.services['support-api'].environment.SECRET='different',input=>input.configs.operations.services['operations-worker'].mem_limit=12345,input=>input.images.support.after.Config.Env.push('UNREVIEWED=1'),input=>input.images.support.after.Config.Labels['org.opencontainers.image.revision']=old]){
  const input=fixture();mutate(input);assert.throws(()=>prepareLiveCompose(input));
 }
});
test('backup and restore companions accept only the four exact new migration inventories and Support ACL module',()=>{
 const migration={name:'20260101000000_initial',checksum:digest},next={name:LIVE_MIGRATION,checksum:sha256('live')};
 const entry=(target,migrations)=>({migrations,manifestSha256:sha256(JSON.stringify({schemaVersion:1,target,migrations}))});
 const images=Object.fromEntries(LIVE_OWNERS.map(owner=>[owner,{before:{owner,compiled:[{path:'src/main.js',sha256:digest}],migrations:[migration],schema:digest,generated:digest,package:digest},after:{owner,compiled:[{path:'src/main.js',sha256:digest}],migrations:owner==='operations'?[migration]:[migration,next],schema:digest,generated:digest,package:digest}}]));
 for(const kind of ['backup','restore'])for(const phase of ['before','after'])images.operations[phase][kind]={schemaVersion:1,targets:Object.fromEntries(['identity','support',...(kind==='backup'?['crm-intake','crm-sales','crm-customers']:[])].map(target=>[target,entry(target,phase==='after'&&target!=='identity'?[migration,next]:[migration])]))};
 verifyLiveImages(images);
 for(const mutate of [value=>value.operations.after.compiled[0].sha256='foreign',value=>value.support.after.migrations[0].checksum='changed',value=>value.operations.after.backup.targets.identity.migrations.push(next),value=>value.operations.after.restore.targets.support.manifestSha256=digest]){const copy=structuredClone(images);mutate(copy);assert.throws(()=>verifyLiveImages(copy));}
});
test('release never applies broker topology or destructive Operations migrations',()=>{
 const shell=readFileSync(new URL('./deploy-crm-live-scoped.sh',import.meta.url),'utf8');
 assert.doesNotMatch(shell,/rabbitmqctl|rabbitmqadmin|management\/|operations-migrate|pg_dump|docker (?:system|volume|image) prune/);
 assert.ok(shell.indexOf(' live_graceful_stop ||')<shell.indexOf('  live_database "$owner" migrate'));
 assert.ok(shell.indexOf(' live_database operations database quiet')<shell.indexOf(' live_graceful_stop ||'));
});
