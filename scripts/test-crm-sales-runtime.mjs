import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { salesRuntimeBaseline, salesRuntimeNeighbors, assertSalesRuntimeSource, assertSalesRuntimeImages, prepareSalesRuntime, assertSalesRuntimePostflight, verifySalesRuntimeHttp, SALES_RUNTIME_TARGET } from './crm-sales-runtime.mjs';
const revision='a'.repeat(40),old='b'.repeat(40),digest='c'.repeat(64),imageId='sha256:'+'d'.repeat(64),candidateId='sha256:'+'e'.repeat(64);
const environment={APP_REVISION:old,CRM_SALES_PROCESS_ROLE:'api',SECRET:'synthetic-private-value'};
function fixture(){
 const image=version=>({Id:version===old?imageId:candidateId,Architecture:'amd64',Os:'linux',Config:{Env:['PATH=/usr/bin'],Labels:{'org.opencontainers.image.revision':version,'org.opencontainers.image.title':'winwidget-crm-sales'},Cmd:['node','dist/src/main.js'],Entrypoint:null,User:'1001'}});
 const service={network_mode:'host',stop_grace_period:'10s',environment:{...environment},healthcheck:{test:['CMD','true']},depends_on:{database:{condition:'service_healthy'}},build:{context:'/synthetic'},profiles:['crm']};
 const input={revision,expectedLiveRevision:old,envHashes:{canonical:digest,crm:digest},compose:{services:{[SALES_RUNTIME_TARGET]:service,unrelated:{}},secrets:{unrelated:{file:'/private/not-used'}},volumes:{unrelated:{}}},images:{before:image(old),after:image(revision)},live:[]};
 for(let i=0;i<20;i++)input.live.push({Id:(i+1).toString(16).padStart(64,'0'),Image:imageId,Name:i===0?SALES_RUNTIME_TARGET:'neighbor-'+i,RestartCount:0,State:{Status:i===19?'exited':'running',Running:i!==19,Paused:false,Restarting:false,OOMKilled:false,StartedAt:'2026-09-14T00:00:00.000Z',Health:i===19?undefined:{Status:'healthy'}},Config:{Env:['PATH=/usr/bin',...Object.entries(environment).map(([key,value])=>key+'='+value)],Labels:{'com.docker.compose.service':i===0?SALES_RUNTIME_TARGET:'neighbor-'+i,'com.docker.compose.project':'winwidget-crm','org.opencontainers.image.revision':old},Cmd:['node','dist/src/main.js'],Entrypoint:null,User:'1001',Healthcheck:{Test:['CMD','true']},StopTimeout:10},HostConfig:{NetworkMode:'host',Privileged:false,RestartPolicy:{Name:'no'},LogConfig:{Type:'json-file',Config:{}}},Mounts:[]});
 input.expectedBaseline=salesRuntimeBaseline(input.live,input.envHashes);return input;
}
function deployed(input,rollback=false){
 const live=structuredClone(input.live),row=live[0];row.Id='f'.repeat(64);row.Image=rollback?imageId:candidateId;row.Config.Labels['org.opencontainers.image.revision']=rollback?old:revision;row.Config.Env=row.Config.Env.map(value=>value.startsWith('APP_REVISION=')?'APP_REVISION='+(rollback?old:revision):value);return live;
}
test('one Sales API receives the new immutable image and revision; retained rollback excludes unrelated definitions',()=>{
 const input=fixture(),{desired,rollback}=prepareSalesRuntime(input);
 assert.deepEqual(Object.keys(desired.services),[SALES_RUNTIME_TARGET]);assert.deepEqual(desired.secrets,{});assert.deepEqual(desired.volumes,{});
 assert.equal(desired.services[SALES_RUNTIME_TARGET].image,candidateId);assert.equal(rollback.services[SALES_RUNTIME_TARGET].image,imageId);
 assert.equal(desired.services[SALES_RUNTIME_TARGET].environment.APP_REVISION,revision);assert.equal(rollback.services[SALES_RUNTIME_TARGET].environment.APP_REVISION,old);
 assert.equal(desired.services[SALES_RUNTIME_TARGET].environment.SECRET,environment.SECRET);
 for(const key of ['build','depends_on','profiles'])assert.equal(desired.services[SALES_RUNTIME_TARGET][key],undefined);
 assertSalesRuntimePostflight(input,deployed(input),desired);assertSalesRuntimePostflight(input,deployed(input,true),rollback,true);
});
test('baseline binds stopped neighbors, image/config/mount/state/restarts and both complete env hashes',()=>{
 const input=fixture();
 for(const mutate of [value=>value.live.at(-1).Id='f'.repeat(64),value=>value.live.at(-1).Image=candidateId,value=>value.live[1].Config.Env.push('EXTRA=1'),value=>value.live[1].HostConfig.Memory=1,value=>value.live[1].Mounts.push({Type:'bind',Source:'/one',Destination:'/two',RW:false}),value=>value.live[1].State.StartedAt='later',value=>value.live[1].RestartCount++,value=>value.live[1].State.Health.Status='unhealthy',value=>value.live[1].State.Running=false,value=>value.envHashes.canonical='f'.repeat(64),value=>value.envHashes.crm='f'.repeat(64)]){
  const copy=structuredClone(input);mutate(copy);assert.notEqual(salesRuntimeBaseline(copy.live,copy.envHashes),input.expectedBaseline);assert.throws(()=>prepareSalesRuntime(copy));
 }
 const shuffled=structuredClone(input.live).reverse();assert.equal(salesRuntimeBaseline(shuffled,input.envHashes),input.expectedBaseline);
 assert.throws(()=>salesRuntimeBaseline([...input.live,input.live[0]],input.envHashes));
 assert.throws(()=>salesRuntimeBaseline(input.live.slice(1),input.envHashes));
});
test('configuration and candidate default changes fail closed even with the approved current baseline',()=>{
 for(const mutate of [value=>value.compose.services[SALES_RUNTIME_TARGET].environment.SECRET='changed',value=>value.compose.services[SALES_RUNTIME_TARGET].mem_limit=123,value=>value.compose.services[SALES_RUNTIME_TARGET].network_mode='bridge',value=>value.images.after.Config.Env.push('UNREVIEWED=1'),value=>value.images.after.Config.Cmd=['node','other.js'],value=>value.images.after.Config.User='0',value=>value.images.after.Architecture='arm64',value=>value.images.after.Config.Labels['org.opencontainers.image.revision']=old,value=>value.images.after.Config.Labels['org.opencontainers.image.title']='winwidget-other']){
  const input=fixture();mutate(input);assert.throws(()=>prepareSalesRuntime(input));
 }
});
test('postflight verifies all neighbors and exact Sales runtime, including rollback after missing target creation',()=>{
 const input=fixture(),{desired}=prepareSalesRuntime(input),live=deployed(input);
 for(const mutate of [value=>value[1].Id='a'.repeat(64),value=>value[1].RestartCount++,value=>value[1].State.StartedAt='later',value=>value[0].RestartCount++,value=>value[0].Config.Env.push('NEW=1'),value=>value[0].Image=imageId,value=>value[0].State.Health.Status='unhealthy']){const copy=structuredClone(live);mutate(copy);assert.throws(()=>assertSalesRuntimePostflight(input,copy,desired));}
 assert.deepEqual(salesRuntimeNeighbors(input.live),salesRuntimeNeighbors(input.live.slice(1)));
 const missing=structuredClone(input.live.slice(1));missing[0].RestartCount++;assert.notDeepEqual(salesRuntimeNeighbors(input.live),salesRuntimeNeighbors(missing));
});
test('source scope permits the exact Sales feature and CI pin changes, and rejects other runtime work',()=>{
 const required='apps/crm-sales/src/sales/sales.service.ts';
 assertSalesRuntimeSource([required,'apps/crm-sales/src/sales/sales.controller.ts','apps/crm-sales/src/sales/sales.dto.ts','apps/crm-sales/src/sales/sales.service.spec.ts','apps/crm-sales/README.md','.github/workflows/ci.yml','.github/scripts/static-check-services-lifecycle.sh']);
 for(const path of ['apps/crm-sales/prisma/schema.prisma','apps/crm-sales/package.json','apps/crm-sales/Dockerfile','apps/crm-sales/src/sales/other.ts','apps/crm-intake/src/main.ts','deploy/docker-compose.prod.yml','docs/backlog.md'])assert.throws(()=>assertSalesRuntimeSource([required,path]));
 assert.throws(()=>assertSalesRuntimeSource(['.github/workflows/ci.yml']));
});
test('candidate image preserves schemas, every migration, generated client and package inventory; compiled changes only in three Sales modules',()=>{
 const before={owner:'crm-sales',schema:digest,generated:digest,package:digest,packages:['pkg@1.0.0'],migrations:[{name:'20260914090000_add_live_changes',checksum:digest}],compiled:[{path:'src/main.js',sha256:digest},{path:'src/sales/sales.service.js',sha256:digest},{path:'src/sales/sales.dto.js.map',sha256:digest}]};
 const after=structuredClone(before);after.compiled[1].sha256='f'.repeat(64);after.compiled[2].sha256='f'.repeat(64);assertSalesRuntimeImages(before,after);
 for(const mutate of [value=>value.schema='f'.repeat(64),value=>value.generated='f'.repeat(64),value=>value.package='f'.repeat(64),value=>value.packages.push('new@1.0.0'),value=>value.migrations[0].checksum='f'.repeat(64),value=>value.compiled[0].sha256='f'.repeat(64),value=>value.compiled.pop(),value=>value.compiled.push(value.compiled[1]),value=>value.compiled[1].sha256='invalid']){const copy=structuredClone(after);mutate(copy);assert.throws(()=>assertSalesRuntimeImages(before,copy));}
});
test('direct live/ready/revision probes require Sales identity, current revision, no-store and no redirect',async()=>{
 const seen=[];
 const valid=async(url,options)=>{seen.push([url,options]);const name=url.split('/').at(-1);return{status:200,headers:new Headers({'cache-control':'no-store'}),json:async()=>({service:'crm-sales',revision,status:name==='ready'?'ready':'ok'})};};
 await verifySalesRuntimeHttp(revision,valid);assert.equal(seen.length,3);assert.ok(seen.every(([url,options])=>url.startsWith('http://127.0.0.1:5330/health/')&&options.redirect==='error'&&options.signal instanceof AbortSignal));
 for(const mutate of [value=>value.status=302,value=>value.headers=new Headers(),value=>value.json=async()=>({service:'crm-sales',revision:old,status:'ok'}),value=>value.json=async()=>({service:'crm-intake',revision,status:'ok'})])await assert.rejects(verifySalesRuntimeHttp(revision,async(url,options)=>{const value=await valid(url,options);mutate(value);return value;}));
});
const shellPath=new URL('./deploy-crm-sales-runtime-scoped.sh',import.meta.url).pathname;
test('controller orders schema/env/lock/baseline gates before stopping exactly one API, with bounded rollback and no migration/broker actions',()=>{
 const shell=readFileSync(shellPath,'utf8'),module=readFileSync(new URL('./crm-sales-runtime.mjs',import.meta.url),'utf8');
 assert.ok(shell.includes('docker ps --all --no-trunc'));
 assert.ok(shell.indexOf(' sales_node "$sales_previous_image" source')<shell.indexOf(' docker build --build-arg'));
 assert.ok(shell.indexOf(' sales_node "$sales_previous_image" baseline')<shell.indexOf(' docker build --build-arg'));
 assert.ok(shell.indexOf(' sales_node "$sales_previous_image" prepare')<shell.indexOf(' sales_stop_started=true'));
 assert.ok(shell.indexOf(' sales_probe database >"$sales_directory/ledger-before.json"')<shell.indexOf(' sales_stop_started=true'));
 assert.ok(shell.indexOf(' sales_node "$sales_previous_image" fence')<shell.indexOf(' sales_stop_started=true'));
 assert.ok(shell.indexOf(' sales_graceful_stop ||')<shell.indexOf(' sales_compose desired up'));
 assert.match(shell,/docker kill --signal TERM "\$sales_previous_id"/);assert.match(shell,/sales_compose rollback up --detach --no-deps --no-build --pull never/);
 assert.doesNotMatch(shell,/rabbitmqctl|rabbitmqadmin|management\/|pg_dump|docker (?:system|volume|image) prune|migrate deploy|--signal KILL|--remove-orphans/);
 assert.match(module,/SET TRANSACTION READ ONLY/);assert.doesNotMatch(module,/\b(?:INSERT INTO|UPDATE crm_sales|ALTER TABLE|GRANT |TRUNCATE|DROP TABLE)\b/);
});
test('failed replacement automatically rolls back and verifies ledger, health and neighbors, retaining failing exit status',()=>{
 const directory=mkdtempSync(join(tmpdir(),'sales-recovery-'));
 try{
  const script=`source "$1"
sales_stop_started=true; sales_replacement_started=true; sales_directory="$2"; sales_previous_image=old; expected_live_revision=old
sales_inputs(){ return 0; }; sales_snapshot(){ return 0; }; sales_node(){ printf 'verify:%s\\n' "$2"; }; sales_compose(){ printf 'compose:%s\\n' "$1"; }; sales_wait(){ return 0; }; sales_probe(){ printf '{}'; }; cmp(){ return 0; }; cleanup_scoped_payload(){ printf 'cleanup\\n'; }
false
sales_finish
`;
  const result=spawnSync('bash',['-c',script,'test',shellPath,directory],{encoding:'utf8'});
  assert.equal(result.status,1);assert.match(result.stdout,/verify:neighbors/);assert.match(result.stdout,/verify:postflight/);assert.match(result.stdout,/cleanup/);assert.match(result.stderr,/prior Sales API image\/config is healthy/);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('graceful stop refuses a forced-kill exit instead of replacing the API',()=>{
 const result=spawnSync('bash',['-c','source "$1"; sales_previous_id=existing; docker(){ if [[ "$1" == kill ]]; then return 0; fi; printf "false:137:0\\n"; }; sales_graceful_stop','test',shellPath],{encoding:'utf8'});assert.equal(result.status,1);
});
