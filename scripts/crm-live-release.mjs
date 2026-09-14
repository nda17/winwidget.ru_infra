import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { sha256, migrationFiles, assertServiceConfiguration } from './scoped-service-release.mjs';

export const LIVE_MIGRATION = '20260914090000_add_live_changes';
export const LIVE_OWNERS = ['crm-intake', 'crm-sales', 'crm-customers', 'support', 'operations'];
export const LIVE_TARGETS = ['crm-intake-api', 'crm-sales-api', 'crm-customers-api', 'support-api', 'operations-api', 'operations-worker', 'operations-outbox-publisher', 'operations-restore-worker'];
const codeFiles = ['crm-live-release.mjs', 'scoped-service-release.mjs'];
const ownerOf = name => LIVE_OWNERS.find(owner => name.startsWith(owner + '-'));
const projectOf = name => name.startsWith('crm-') ? 'winwidget-crm' : 'winwidget';
const serviceName = row => row.Config.Labels['com.docker.compose.service'];
const env = rows => Object.fromEntries((rows ?? []).map(row => { const i = row.indexOf('='); assert.ok(i > 0); return [row.slice(0, i), row.slice(i + 1)]; }));
const read = name => JSON.parse(readFileSync('/run/live-work/' + name));
const write = (name, value) => writeFileSync('/run/live-work/' + name, JSON.stringify(value), { mode: 0o600 });
const sorted = values => [...values].sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

export function liveBaseline(live, envHashes) {
 assert.ok(live.length >= 20 && live.length < 200);
 assert.equal(new Set(live.map(row => row.Id)).size, live.length);
 const containers = sorted(live.map(row => {
  assert.match(row.Id, /^[a-f0-9]{64}$/); assert.match(row.Image, /^sha256:[a-f0-9]{64}$/);
  return { id: row.Id, image: row.Image, name: row.Name, config: sha256(JSON.stringify(row.Config)), host: sha256(JSON.stringify(row.HostConfig)), mounts: row.Mounts };
 }));
 return sha256(JSON.stringify({ scope: 'crm-live-updates', containers, envHashes }));
}
export function prepareLiveCompose(input) {
 assert.match(input.revision, /^[a-f0-9]{40}$/);
 assert.equal(liveBaseline(input.live, input.envHashes), input.expectedBaseline);
 const prepared = {};
 for (const project of ['winwidget', 'winwidget-crm']) prepared[project] = { desired: { name: project, services: {}, secrets: {}, volumes: {} }, rollback: { name: project, services: {}, secrets: {}, volumes: {} } };
 for (const name of LIVE_TARGETS) {
  const owner = ownerOf(name), project = projectOf(name), source = input.configs[owner];
  const rows = input.live.filter(row => serviceName(row) === name && row.Config.Labels['com.docker.compose.project'] === project);
  assert.equal(rows.length, 1); const row = rows[0];
  assert.equal(row.State.Status, 'running'); assert.equal(row.State.Health?.Status, 'healthy');
  const oldImage = input.images[owner].before, candidate = input.images[owner].after;
  assert.equal(row.Image, oldImage.Id);
  if (owner === 'operations') assert.equal(row.Config.Labels['org.opencontainers.image.revision'], input.expectedLiveRevision);
  assert.equal(candidate.Config.Labels['org.opencontainers.image.revision'], input.revision);
  const service = structuredClone(source.services[name]); assert.ok(service);
  assertServiceConfiguration(service, row, oldImage, source.secrets ?? {});
  const before = env(row.Config.Env);
  const rendered = { ...env(oldImage.Config.Env), ...Object.fromEntries(Object.entries(service.environment).map(([key,value]) => [key,String(value ?? '')])) };
  assert.deepEqual(rendered, before);
  for (const key of ['build', 'profiles', 'depends_on']) delete service[key];
  service.image = oldImage.Id;
  service.environment = before;
  for (const version of ['desired','rollback']) {
   Object.assign(prepared[project][version].secrets, source.secrets ?? {});
   Object.assign(prepared[project][version].volumes, source.volumes ?? {});
   prepared[project][version].services[name] = structuredClone(service);
  }
  const next = prepared[project].desired.services[name];
  next.image = candidate.Id;
  next.labels = { ...next.labels, 'org.opencontainers.image.revision': input.revision };
  if (Object.hasOwn(next.environment, 'APP_REVISION')) next.environment.APP_REVISION = input.revision;
  // Even image defaults must leave all owner configuration unchanged.
  const actualNext = { ...env(candidate.Config.Env), ...next.environment };
  const expectedNext = { ...before };
  if (Object.hasOwn(before, 'APP_REVISION')) expectedNext.APP_REVISION = input.revision;
  assert.deepEqual(actualNext, expectedNext);
 }
 return prepared;
}
// Prisma formats the generated schema. Compare lexical tokens while retaining
// quoted values and token boundaries, so formatting cannot mask a model change.
export function schemaTokens(source) {
 return source.match(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_][A-Za-z_0-9]*|[0-9]+(?:\.[0-9]+)?|[^\s]/g)
  ?.filter(token => !token.startsWith('//') && !token.startsWith('/*')) ?? [];
}
function imageInventory(owner) {
 assert.ok(LIVE_OWNERS.includes(owner));
 const walk = root => {
  const result=[];
  const visit = directory => { for(const item of readdirSync(directory, {withFileTypes:true})) {
   const path=join(directory,item.name);assert.ok(!item.isSymbolicLink());
   if(item.isDirectory())visit(path);else{assert.ok(item.isFile());result.push({path:path.slice(root.length+1),sha256:sha256(readFileSync(path))});}
  } }; visit(root);return sorted(result);
 };
 const require=createRequire('/app/package.json');
 const result={owner,compiled:walk('/app/dist'),migrations:migrationFiles('/app/prisma/migrations'),schema:sha256(readFileSync('/app/prisma/schema.prisma')),generated:sha256(readFileSync(require.resolve('@prisma/'+owner+'-client/schema.prisma'))),package:sha256(readFileSync('/app/package.json'))};
 assert.deepEqual(schemaTokens(readFileSync('/app/prisma/schema.prisma','utf8')),schemaTokens(readFileSync(require.resolve('@prisma/'+owner+'-client/schema.prisma'),'utf8')));
 if(owner==='operations')for(const kind of ['backup','restore'])result[kind]=JSON.parse(readFileSync('/app/'+kind+'-manifests/database-'+kind+'-migrations.json'));
 return result;
}
export function verifyLiveImages(images) {
 for(const owner of LIVE_OWNERS){
  const {before,after}=images[owner];assert.equal(before.owner,owner);assert.equal(after.owner,owner);
  if(owner==='operations'){
   const changed = path => /^src\/restore\/database-restore-acl\.contract\.(?:js|js\.map|d\.ts)$/.test(path);
   assert.deepEqual(before.compiled.filter(row=>!changed(row.path)),after.compiled.filter(row=>!changed(row.path)));
   for(const key of ['schema','generated','migrations','package'])assert.deepEqual(before[key],after[key]);
   for(const kind of ['backup','restore']){
    assert.deepEqual(Object.keys(before[kind].targets),Object.keys(after[kind].targets));
    for(const target of Object.keys(before[kind].targets)){
     const previous=before[kind].targets[target],next=after[kind].targets[target];
     if(LIVE_OWNERS.includes(target)&&target!=='operations'){
      assert.deepEqual(next.migrations,images[target].after.migrations);
      assert.deepEqual(previous.migrations,images[target].before.migrations);
      assert.equal(next.manifestSha256,sha256(JSON.stringify({schemaVersion:1,target,migrations:next.migrations})));
     }else assert.deepEqual(previous,next);
    }
   }
  }else{
   assert.equal(after.migrations.at(-1).name,LIVE_MIGRATION);
   assert.deepEqual(before.migrations,after.migrations.slice(0,-1));
  }
 }
}
async function database(owner,phase){
 assert.ok(LIVE_OWNERS.includes(owner));assert.ok(['pre','post','quiet'].includes(phase));
 const prefix=owner.replaceAll('-','_').toUpperCase(),schema=owner.replaceAll('-','_');
 const require=createRequire('/app/package.json');const {PrismaClient}=require('@prisma/'+owner+'-client');
 const client=new PrismaClient({datasources:{db:{url:process.env[prefix+'_MIGRATION_DATABASE_URL']}},log:[]});
 try {
  const files=migrationFiles('/app/prisma/migrations');
  const expected=owner==='operations'?files.filter(file=>file.name!=='20260910110000_remove_admin_backlog'):phase==='pre'?files.slice(0,-1):files;
  const ledger=await client.$queryRawUnsafe(`SELECT migration_name AS name,checksum,finished_at,rolled_back_at FROM ${schema}._prisma_migrations ORDER BY migration_name`);
  assert.ok(ledger.every(row=>row.finished_at&&!row.rolled_back_at));
  assert.deepEqual(ledger.map(({name,checksum})=>({name,checksum})),expected);
  const identity=await client.$queryRawUnsafe(`SELECT service_name,database_id FROM ${schema}.service_identity WHERE id='singleton'`);
  assert.equal(identity.length,1);assert.equal(identity[0].service_name,owner+'-service');
  const role=await client.$queryRawUnsafe("SELECT current_user AS name,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user");
  for(const key of ['rolsuper','rolcreatedb','rolcreaterole','rolbypassrls'])assert.equal(role[0][key],false);
  assert.ok(role[0].name.endsWith('_migration'));
  if(owner==='operations'&&phase==='quiet'){
   assert.equal(process.env.DATABASE_RESTORE_ENABLED,'false');
   assert.equal(await client.scheduledJobRun.count({where:{status:{in:['QUEUED','PROCESSING']}}}),0);
   assert.equal(await client.databaseRestoreJob.count({where:{status:{in:['QUEUED','PROCESSING','RECOVERY_REQUIRED']}}}),0);
   const lease=await client.databaseRestoreExecutionLease.findUnique({where:{id:'singleton'}});
   if(lease)for(const key of ['operationType','operationId','leaseOwner','leaseToken'])assert.equal(lease[key],null);
  }
  process.stdout.write(JSON.stringify({identity:identity[0],migrations:expected}));
 }finally{await client.$disconnect()}
}
async function main(){
 const [command,owner,phase]=process.argv.slice(2);
 if(command==='pack'){
  const files=codeFiles.map(name=>{const path=new URL('./'+name,import.meta.url);assert.ok(lstatSync(path).isFile());const content=readFileSync(path,'utf8');return{name,content,sha256:sha256(content)}});
  process.stdout.write(JSON.stringify({schemaVersion:1,files}));return;
 }
 if(command==='image'){process.stdout.write(JSON.stringify(imageInventory(owner)));return;}
 if(command==='database'){await database(owner,phase);return;}
 if(command==='migrate'){
  assert.ok(LIVE_OWNERS.includes(owner)&&owner!=='operations');await database(owner,'pre');
  const prefix=owner.replaceAll('-','_').toUpperCase(),require=createRequire('/app/package.json');
  const child=spawnSync(process.execPath,[require.resolve('prisma/build/index.js'),'migrate','deploy','--schema','/app/prisma/schema.prisma'],{cwd:'/app',env:{...process.env,[prefix+'_DATABASE_URL']:process.env[prefix+'_MIGRATION_DATABASE_URL']},encoding:'utf8',timeout:120000});
  assert.equal(child.status,0);return;
 }
 if(command==='grants'){
  assert.ok(['crm-intake','crm-sales','crm-customers'].includes(owner));
  const {readDatabaseAccess,databaseRuntimeGrantsSql}=await import('./database-access.mjs');
  const {contract,migrations}=readDatabaseAccess('/app/prisma',owner);process.stdout.write(databaseRuntimeGrantsSql(contract,migrations));return;
 }
 if(command==='prepare'){
  const input=read('input.json');verifyLiveImages(read('image-inventories.json'));
  for(const [project,versions]of Object.entries(prepareLiveCompose(input)))for(const [version,value]of Object.entries(versions))write(project+'-'+version+'.json',value);
  return;
 }
 if(command==='baseline'){const input=read('input.json');process.stdout.write(liveBaseline(input.live,input.envHashes));return;}
 if(command==='fence'){const input=read('input.json');assert.equal(liveBaseline(read('live-fence.json'),input.envHashes),input.expectedBaseline);return;}
 if(command==='configuration-preflight'){
  const input=read('input.json');
  for(const name of LIVE_TARGETS){
   const row=input.live.find(row=>serviceName(row)===name&&row.Config.Labels['com.docker.compose.project']===projectOf(name));assert.ok(row);
   const source=input.configs[ownerOf(name)],image=input.images[ownerOf(name)].before,service=source.services[name];
   assertServiceConfiguration(service,row,image,source.secrets??{});
   assert.deepEqual(env(row.Config.Env),{...env(image.Config.Env),...Object.fromEntries(Object.entries(service.environment).map(([key,value])=>[key,String(value??'')]))});
  }
  return;
 }
 if(command==='postflight'){
  const input=read('input.json'),live=read('live-after.json');
  for(const name of LIVE_TARGETS){
   const row=live.find(row=>serviceName(row)===name&&row.Config.Labels['com.docker.compose.project']===projectOf(name));assert.ok(row);
   const image=input.images[ownerOf(name)].after;assert.equal(row.Image,image.Id);assert.equal(row.State.Health.Status,'healthy');
   const desired=read(projectOf(name)+'-desired.json');assertServiceConfiguration(desired.services[name],row,image,desired.secrets);
   assert.deepEqual(env(row.Config.Env),{...env(image.Config.Env),...desired.services[name].environment});
  }
  const neighbors=rows=>sorted(rows.filter(row=>!LIVE_TARGETS.includes(serviceName(row))).map(row=>({Id:row.Id,Image:row.Image,Config:row.Config,HostConfig:row.HostConfig,Mounts:row.Mounts})));
  assert.deepEqual(neighbors(input.live),neighbors(live));return;
 }
 throw new Error('Unsupported live release action');
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(()=>{process.stderr.write('CRM live release check failed; private details suppressed.\n');process.exitCode=1});
