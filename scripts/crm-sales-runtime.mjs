import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, migrationFiles, assertServiceConfiguration } from './scoped-service-release.mjs';
import { schemaTokens } from './crm-live-release.mjs';

export const SALES_RUNTIME_SCOPE = 'crm-sales-runtime';
export const SALES_RUNTIME_TARGET = 'crm-sales-api';
export const SALES_RUNTIME_PAYLOAD = ['crm-sales-runtime.mjs', 'crm-live-release.mjs', 'scoped-service-release.mjs'];
const exact = (value, keys) => { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); assert.deepEqual(Object.keys(value).sort(), [...keys].sort()); };
const sorted = rows => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const env = rows => Object.fromEntries((rows || []).map(row => { const at = row.indexOf('='); assert.ok(at > 0); return [row.slice(0, at), row.slice(at + 1)]; }));
const isTarget = row => row.Config.Labels?.['com.docker.compose.project'] === 'winwidget-crm' && row.Config.Labels?.['com.docker.compose.service'] === SALES_RUNTIME_TARGET;
function target(rows) { const found = rows.filter(isTarget); assert.equal(found.length, 1); return found[0]; }
function inventory(rows, minimum = 20) {
 assert.ok(Array.isArray(rows) && rows.length >= minimum && rows.length < 200);
 assert.equal(new Set(rows.map(row => row.Id)).size, rows.length);
 return sorted(rows.map(row => {
  assert.match(row.Id, /^[a-f0-9]{64}$/); assert.match(row.Image, /^sha256:[a-f0-9]{64}$/);
  return { id: row.Id, image: row.Image, name: row.Name, config: sha256(JSON.stringify(row.Config)), host: sha256(JSON.stringify(row.HostConfig)), mounts: sorted(row.Mounts), startedAt: row.State.StartedAt, status: row.State.Status, running: row.State.Running, paused: row.State.Paused, restarting: row.State.Restarting, oom: row.State.OOMKilled, health: row.State.Health?.Status, restarts: row.RestartCount };
 }));
}
export function salesRuntimeBaseline(live, envHashes) {
 exact(envHashes, ['canonical', 'crm']);
 for (const hash of Object.values(envHashes)) assert.match(hash, /^[a-f0-9]{64}$/);
 target(live);
 return sha256(JSON.stringify({ scope: SALES_RUNTIME_SCOPE, containers: inventory(live), envHashes }));
}
export function salesRuntimeNeighbors(rows) {
 const found = rows.filter(isTarget); assert.ok(found.length <= 1);
 return inventory(rows, 19).filter(row => row.id !== found[0]?.Id);
}
export function assertSalesRuntimeSource(paths) {
 assert.ok(Array.isArray(paths) && paths.length > 0);
 const allowed = /^(?:\.github\/workflows\/ci\.yml|\.github\/scripts\/static-check-services-lifecycle\.sh|apps\/crm-sales\/README\.md|apps\/crm-sales\/src\/sales\/sales\.(?:controller|dto|service)\.ts|apps\/crm-sales\/src\/sales\/[a-z.-]+\.spec\.ts)$/;
 for (const path of paths) assert.match(path, allowed);
 assert.ok(paths.includes('apps/crm-sales/src/sales/sales.service.ts'));
}
export function assertSalesRuntimeImages(before, after) {
 for (const value of [before, after]) {
  exact(value, ['owner', 'compiled', 'migrations', 'schema', 'generated', 'package', 'packages']);
  assert.equal(value.owner, 'crm-sales');
  for (const key of ['schema', 'generated', 'package']) assert.match(value[key], /^[a-f0-9]{64}$/);
  for (const key of ['compiled', 'migrations', 'packages']) assert.ok(Array.isArray(value[key]) && value[key].length > 0 && value[key].length < 3000);
  assert.equal(new Set(value.compiled.map(row => row.path)).size, value.compiled.length);
  for (const row of value.compiled) { exact(row, ['path', 'sha256']); assert.match(row.path, /^[a-zA-Z0-9_./-]+$/); assert.ok(!row.path.split('/').includes('..') && !row.path.startsWith('/')); assert.match(row.sha256, /^[a-f0-9]{64}$/); }
 }
 for (const key of ['migrations', 'schema', 'generated', 'package', 'packages']) assert.deepEqual(before[key], after[key]);
 assert.deepEqual(before.compiled.map(row => row.path), after.compiled.map(row => row.path));
 const changed = row => /^src\/sales\/sales\.(?:controller|dto|service)\.(?:js|js\.map|d\.ts)$/.test(row.path);
 assert.deepEqual(before.compiled.filter(row => !changed(row)), after.compiled.filter(row => !changed(row)));
 assert.ok(after.compiled.some(row => row.path === 'src/sales/sales.service.js'));
}
export function prepareSalesRuntime(input) {
 assert.match(input.revision, /^[a-f0-9]{40}$/); assert.match(input.expectedLiveRevision, /^[a-f0-9]{40}$/);
 assert.equal(salesRuntimeBaseline(input.live, input.envHashes), input.expectedBaseline);
 const row = target(input.live), before = input.images.before, after = input.images.after;
 for (const image of [before, after]) { assert.match(image.Id, /^sha256:[a-f0-9]{64}$/); assert.equal(image.Config.Labels['org.opencontainers.image.title'], 'winwidget-crm-sales'); }
 assert.equal(row.State.Status, 'running'); assert.equal(row.State.Health?.Status, 'healthy');
 assert.equal(row.Image, before.Id); assert.equal(row.Config.Labels['org.opencontainers.image.revision'], input.expectedLiveRevision);
 assert.equal(before.Config.Labels['org.opencontainers.image.revision'], input.expectedLiveRevision);
 assert.equal(after.Config.Labels['org.opencontainers.image.revision'], input.revision);
 assert.equal(after.Config.Labels['org.opencontainers.image.title'], 'winwidget-crm-sales');
 assert.equal(before.Architecture, after.Architecture); assert.equal(before.Os, after.Os);
 const source = input.compose, service = structuredClone(source.services[SALES_RUNTIME_TARGET]); assert.ok(service);
 assertServiceConfiguration(service, row, before, source.secrets || {});
 const environment = env(row.Config.Env);
 assert.equal(environment.CRM_SALES_PROCESS_ROLE, 'api'); assert.equal(environment.APP_REVISION, input.expectedLiveRevision);
 assert.deepEqual(environment, { ...env(before.Config.Env), ...Object.fromEntries(Object.entries(service.environment).map(([key, value]) => [key, String(value ?? '')])) });
 for (const key of ['build', 'profiles', 'depends_on']) delete service[key];
 service.image = before.Id; service.environment = environment;
 const secrets = Object.fromEntries((service.secrets || []).map(row => { assert.ok(source.secrets?.[row.source]); return [row.source, source.secrets[row.source]]; }));
 const volumes = Object.fromEntries((service.volumes || []).filter(row => row.type === 'volume').map(row => { assert.ok(source.volumes?.[row.source]); return [row.source, source.volumes[row.source]]; }));
 const rollback = { name: 'winwidget-crm', services: { [SALES_RUNTIME_TARGET]: service }, secrets, volumes };
 const desired = structuredClone(rollback), next = desired.services[SALES_RUNTIME_TARGET];
 next.image = after.Id; next.environment.APP_REVISION = input.revision;
 next.labels = { ...next.labels, 'org.opencontainers.image.revision': input.revision };
 assert.deepEqual({ ...env(after.Config.Env), ...next.environment }, { ...environment, APP_REVISION: input.revision });
 assertServiceConfiguration(next, { ...row, Config: { ...row.Config, Env: Object.entries(next.environment).map(([key, value]) => key + '=' + value) } }, after, desired.secrets);
 return { desired, rollback };
}
export function assertSalesRuntimePostflight(input, live, snapshot, rollback = false) {
 const row = target(live), image = rollback ? input.images.before : input.images.after;
 const revision = rollback ? input.expectedLiveRevision : input.revision;
 assert.equal(row.Image, image.Id); assert.equal(row.Config.Labels['org.opencontainers.image.revision'], revision);
 assert.equal(row.State.Status, 'running'); assert.equal(row.State.Health?.Status, 'healthy');
 assert.equal(row.State.OOMKilled, false); assert.equal(row.State.Restarting, false); assert.equal(row.RestartCount, 0);
 assert.equal(snapshot.services[SALES_RUNTIME_TARGET].image, image.Id);
 assertServiceConfiguration(snapshot.services[SALES_RUNTIME_TARGET], row, image, snapshot.secrets || {});
 assert.deepEqual(env(row.Config.Env), { ...env(image.Config.Env), ...snapshot.services[SALES_RUNTIME_TARGET].environment });
 assert.equal(env(row.Config.Env).APP_REVISION, revision);
 assert.deepEqual(salesRuntimeNeighbors(input.live), salesRuntimeNeighbors(live));
}
function imageInventory() {
 const walk = root => {
  const result = [];
  const visit = directory => { assert.equal(realpathSync(directory), directory); for (const entry of readdirSync(directory, { withFileTypes: true })) {
   assert.ok(!entry.isSymbolicLink()); const path = join(directory, entry.name);
   if (entry.isDirectory()) visit(path); else { assert.ok(entry.isFile()); result.push({ path: path.slice(root.length + 1), sha256: sha256(readFileSync(path)) }); }
  } };
  visit(root); return result.sort((a, b) => a.path.localeCompare(b.path));
 };
 const require = createRequire('/app/package.json');
 const schema = readFileSync('/app/prisma/schema.prisma'), generated = readFileSync(require.resolve('@prisma/crm-sales-client/schema.prisma'));
 assert.deepEqual(schemaTokens(schema.toString()), schemaTokens(generated.toString()));
 return { owner: 'crm-sales', compiled: walk('/app/dist'), migrations: migrationFiles('/app/prisma/migrations'), schema: sha256(schema), generated: sha256(generated), package: sha256(readFileSync('/app/package.json')), packages: readdirSync('/app/node_modules/.pnpm', { withFileTypes: true }).filter(row => row.isDirectory() && row.name !== 'node_modules').map(row => row.name).sort() };
}
async function databaseSnapshot() {
 assert.ok(process.env.CRM_SALES_MIGRATION_DATABASE_URL);
 const require = createRequire('/app/package.json'), { PrismaClient } = require('@prisma/crm-sales-client');
 const client = new PrismaClient({ datasources: { db: { url: process.env.CRM_SALES_MIGRATION_DATABASE_URL } }, log: [] });
 try {
  return await client.$transaction(async transaction => {
   await transaction.$executeRawUnsafe('SET TRANSACTION READ ONLY');
   const ledger = await transaction.$queryRawUnsafe('SELECT migration_name AS name, checksum, finished_at, rolled_back_at FROM crm_sales._prisma_migrations ORDER BY migration_name');
   assert.ok(ledger.every(row => row.finished_at && !row.rolled_back_at));
   assert.deepEqual(ledger.map(({ name, checksum }) => ({ name, checksum })), migrationFiles('/app/prisma/migrations'));
   const identity = await transaction.$queryRawUnsafe("SELECT service_name, database_id FROM crm_sales.service_identity WHERE id='singleton'");
   assert.equal(identity.length, 1); assert.equal(identity[0].service_name, 'crm-sales-service');
   const roles = await transaction.$queryRawUnsafe('SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname=current_user');
   assert.equal(roles.length, 1); assert.ok(roles[0].name.endsWith('_migration'));
   for (const key of ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolbypassrls']) assert.equal(roles[0][key], false);
   return { identity: identity[0], ledger };
  }, { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 15000 });
 } finally { await client.$disconnect(); }
}
export async function verifySalesRuntimeHttp(revision, fetcher = fetch) {
 for (const name of ['live', 'ready', 'revision']) {
  const response = await fetcher(`http://127.0.0.1:5330/health/${name}`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const value = await response.json(); assert.equal(value.service, 'crm-sales'); assert.equal(value.revision, revision);
  if (name !== 'revision') assert.equal(value.status, name === 'ready' ? 'ready' : 'ok');
 }
}
const read = filename => {
 const path = '/run/sales-work/' + filename, stat = lstatSync(path);
 assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && stat.gid === 0 && stat.nlink === 1 && (stat.mode & 0o7777) === 0o600 && stat.size < 16 * 1024 * 1024);
 return JSON.parse(readFileSync(path));
};
async function main() {
 const [command, version] = process.argv.slice(2);
 if (command === 'pack') {
  const files = SALES_RUNTIME_PAYLOAD.map(name => { const path = new URL('./' + name, import.meta.url), stat = lstatSync(path); assert.ok(stat.isFile() && !stat.isSymbolicLink()); const content = readFileSync(path, 'utf8'); assert.ok(Buffer.byteLength(content) <= (name === 'scoped-service-release.mjs' ? 147456 : 131072)); return { name, content, sha256: sha256(content) }; });
  const bytes = JSON.stringify({ schemaVersion: 1, files }); assert.ok(Buffer.byteLength(bytes) <= 262144); process.stdout.write(bytes); return;
 }
 assert.equal(process.env.SCOPED_SCOPE, SALES_RUNTIME_SCOPE);
 if (command === 'image') { process.stdout.write(JSON.stringify(imageInventory())); return; }
 if (command === 'database') { process.stdout.write(JSON.stringify(await databaseSnapshot())); return; }
 if (command === 'http') { assert.match(version, /^[a-f0-9]{40}$/); await verifySalesRuntimeHttp(version); return; }
 if (command === 'source') { assertSalesRuntimeSource(read('source-changes.json')); return; }
 if (command === 'baseline') { const value = read('baseline-input.json'); assert.equal(salesRuntimeBaseline(value.live, value.envHashes), value.expectedBaseline); return; }
 const input = read('input.json');
 if (command === 'prepare') {
  assertSalesRuntimeSource(read('source-changes.json'));
  assertSalesRuntimeImages(read('inventory-before.json'), read('inventory-after.json'));
  for (const [name, value] of Object.entries(prepareSalesRuntime(input))) writeFileSync('/run/sales-work/' + name + '.json', JSON.stringify(value), { mode: 0o600, flag: 'wx' });
 } else if (command === 'fence') assert.equal(salesRuntimeBaseline(read('live-current.json'), input.envHashes), input.expectedBaseline);
 else if (command === 'neighbors') assert.deepEqual(salesRuntimeNeighbors(input.live), salesRuntimeNeighbors(read('live-current.json')));
 else if (command === 'postflight') { assert.ok(['desired', 'rollback'].includes(version)); assertSalesRuntimePostflight(input, read('live-current.json'), read(version + '.json'), version === 'rollback'); }
 else throw new Error('Unsupported CRM Sales runtime action');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(() => { process.stderr.write('CRM Sales runtime verification failed; private details suppressed.\n'); process.exitCode = 1; });
