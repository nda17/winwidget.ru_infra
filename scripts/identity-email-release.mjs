import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTES_MIGRATION, assertMigrationLedger, OTP_MIGRATION, SCOPED_SERVICES, sha256, migrationFiles, rootFileBytes, orderedMountInventory } from './scoped-service-release.mjs';
export const EMAIL_MIGRATION = '20260913000000_email_delivery_attempts';
export const EMAIL_MIGRATION_SHA256 = 'df3b21a77b51a0d3a5d8636729caded47927514c2ef6931d1f45f3707784c021';
const same = (a, b) => assert.deepEqual(a, b);
export const EMAIL_SOURCE_PATHS = Object.freeze(['auth/auth.service.ts', 'runtime/identity-housekeeping.service.ts', 'auth/email-verification.service.ts', 'auth/email-password-recovery.service.ts', 'users/users.service.ts', 'identity.module.ts', 'common/http-exception.filter.ts', 'transports/verification-transport.service.ts', 'transports/email-templates.ts']);
export function assertIdentityEmailSource(paths) {
	assert.ok(Array.isArray(paths) && paths.length > 0);
	for (const path of paths) assert.ok(EMAIL_SOURCE_PATHS.map(name => `apps/identity/src/${name}`).includes(path) ||
		/^apps\/identity\/(src\/[a-z0-9./-]+\.spec\.ts|test\/[a-z0-9./-]+\.(ts|mjs)|README\.md)$/.test(path) ||
		['apps/identity/prisma/schema.prisma', `apps/identity/prisma/migrations/${EMAIL_MIGRATION}/migration.sql`, '.github/workflows/ci.yml', '.github/scripts/static-check-services-lifecycle.sh', 'docs/backlog.md',
		'apps/operations/restore-manifests/database-restore-migrations.json', 'apps/operations/backup-manifests/database-backup-migrations.json'].includes(path), `Unapproved email release path: ${path}`);
}
export function assertIdentityEmailManifest(before, after, files) {
	assert.equal(files.at(-1)?.name, EMAIL_MIGRATION); assert.equal(files.at(-1)?.checksum, EMAIL_MIGRATION_SHA256);
	assert.ok(files.some(file => file.name === OTP_MIGRATION));
	assert.equal(before.schemaVersion, 1); assert.equal(after.schemaVersion, 1);
	same(Object.keys(before.targets).sort(), Object.keys(after.targets).sort());
	assert.ok(before.targets.identity);
	for (const key of Object.keys(before.targets)) if (key !== 'identity') same(before.targets[key], after.targets[key]);
	for (const [entry, migrations] of [[before.targets.identity, files.slice(0, -1)], [after.targets.identity, files]]) {
		same(entry.migrations, migrations); assert.equal(entry.manifestSha256, sha256(JSON.stringify({ schemaVersion: 1, target: 'identity', migrations })));
	}
}
export function assertIdentityEmailImages(before, after, owner, identityFiles) {
	assert.ok(['identity', 'operations'].includes(owner));
	for (const value of [before, after]) {
		assert.equal(value.owner, owner); assert.equal(value.schemaSha256, value.generatedSchemaSha256);
		assert.ok(value.compiled.length > 20); assert.ok(value.packages.length > 30);
	}
	for (const key of ['packages', 'packageSha256', 'assets']) same(before[key], after[key]);
	if (owner === 'operations') {
		for (const key of ['compiled', 'migrations', 'schemaSha256', 'keyringSha256']) same(before[key], after[key]);
		for (const key of ['backup', 'restore']) assertIdentityEmailManifest(before[key], after[key], identityFiles);
	} else {
		assert.equal(after.migrations.at(-1)?.name, EMAIL_MIGRATION); assert.equal(after.migrations.at(-1)?.checksum, EMAIL_MIGRATION_SHA256);
		same(before.migrations, after.migrations.slice(0, -1));
		const changed = path => EMAIL_SOURCE_PATHS.some(name => path === `src/${name.slice(0, -3)}.js` || path === `src/${name.slice(0, -3)}.js.map` || path === `src/${name.slice(0, -3)}.d.ts`);
		same(before.compiled.filter(row => !changed(row.path)), after.compiled.filter(row => !changed(row.path)));
	}
}
// Only the already-approved 774d worker -> eb19 API synchronization is
// permitted. The new candidate still compares strictly with the live API.
export const EMAIL_WORKER_SYNC = Object.freeze({
	worker: '774db6490808cbaff4ff96033c589205cb3935f7', api: 'eb19be4366d30de1576420a5d52484178bbca9c8',
	beforePackage: 'f2499e00371965652da6006d37ed74c9f44f22e311de22272873c6b90b5f6a71',
	afterPackage: 'fe0abdd528eba04ec31aaec2c34e592fd25a7a1327923b5dc7bad7649705a3f6'
});
export function assertIdentityEmailWorkerBaseline(before, api, workerRevision, apiRevision) {
	if (workerRevision === apiRevision) { same(before, api); return; }
	assert.equal(workerRevision, EMAIL_WORKER_SYNC.worker); assert.equal(apiRevision, EMAIL_WORKER_SYNC.api);
	assert.equal(before.owner, 'identity'); assert.equal(api.owner, 'identity');
	assert.equal(before.packageSha256, EMAIL_WORKER_SYNC.beforePackage); assert.equal(api.packageSha256, EMAIL_WORKER_SYNC.afterPackage);
	for (const key of ['migrations', 'assets', 'schemaSha256', 'generatedSchemaSha256']) same(before[key], api[key]);
	for (const [from, to, expected] of [[before, api, ['multer@2.2.0', 'nodemailer@9.0.3']], [api, before, ['multer@2.3.0', 'nodemailer@9.1.1']]]) same(from.packages.filter(name => !to.packages.includes(name)).sort(), expected);
	const modules = ['internal/internal.controller', 'internal/internal.service', 'runtime/identity-http.config', 'transports/verification-transport.service', 'workspaces/workspace-directory.controller'];
	same(before.compiled.map(row => row.path), api.compiled.map(row => row.path));
	const unchanged = row => !modules.some(name => (name.startsWith('transports/') ? ['.js', '.js.map'] : ['.js', '.js.map', '.d.ts']).some(extension => row.path === `src/${name}${extension}`));
	same(before.compiled.filter(unchanged), api.compiled.filter(unchanged));
}
function identityEmailImageInventory(owner) {
	assert.equal(process.getuid(), 1001); assert.ok(['identity', 'operations'].includes(owner));
	const files = root => {
		const rows = []; const visit = directory => {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				assert.ok(!entry.isSymbolicLink()); const path = join(directory, entry.name);
				if (entry.isDirectory()) visit(path); else { assert.ok(entry.isFile()); rows.push({ path: path.slice(root.length + 1), sha256: sha256(readFileSync(path)) }); }
			}
		}; visit(root); return rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	};
	const require = createRequire('/app/package.json');
	const value = { owner, compiled: files('/app/dist'), migrations: migrationFiles('/app/prisma/migrations'),
		schemaSha256: sha256(readFileSync('/app/prisma/schema.prisma')), generatedSchemaSha256: sha256(readFileSync(require.resolve(`@prisma/${owner}-client/schema.prisma`))),
		packageSha256: sha256(readFileSync('/app/package.json')), packages: readdirSync('/app/node_modules/.pnpm', { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== 'node_modules').map(entry => entry.name).sort(),
		assets: owner === 'identity' ? files('/app/assets') : [] };
	if (owner === 'operations') {
		value.backup = JSON.parse(readFileSync('/app/backup-manifests/database-backup-migrations.json'));
		value.restore = JSON.parse(readFileSync('/app/restore-manifests/database-restore-migrations.json'));
		value.keyringSha256 = sha256(readFileSync('/app/restore-manifests/database-backup-provenance-public-keys.json'));
	}
	process.stdout.write(JSON.stringify(value));
}
export function identityEmailNeighbors(live) {
	assert.ok(live.length >= 7 && live.length < 200); assert.equal(new Set(live.map(item => item.Id)).size, live.length);
	const target = item => item.Config.Labels['com.docker.compose.project'] === 'winwidget' && SCOPED_SERVICES['identity-email-delivery'].includes(item.Config.Labels['com.docker.compose.service']);
	for (const item of live) {
		assert.match(item.Id, /^[a-f0-9]{64}$/); assert.match(item.Image, /^sha256:[a-f0-9]{64}$/);
		if (target(item)) continue;
		assert.equal(item.State.Running, true); assert.equal(item.State.Restarting, false); assert.equal(item.State.OOMKilled, false);
		if (item.Config.Healthcheck) assert.equal(item.State.Health?.Status, 'healthy');
	}
	return sha256(JSON.stringify(live.filter(item => !target(item)).map(item => ({ id: item.Id, image: item.Image, config: item.Config, host: item.HostConfig, mounts: orderedMountInventory(item.Mounts), startedAt: item.State.StartedAt, restartCount: item.RestartCount })).sort((a, b) => a.id < b.id ? -1 : 1)));
}

export async function verifyIdentityEmailDatabase(client, files, action, owner, { serviceIdentity, ledger, assertOperationsIdle }) {
	assert.ok(['email-pre', 'email-post', 'email-quiet', 'email-drain'].includes(action));
	assert.equal((await client.$queryRawUnsafe('SHOW transaction_read_only'))[0]?.transaction_read_only, 'on');
	assert.match((await client.$queryRawUnsafe('SHOW server_version_num'))[0]?.server_version_num ?? '', /^18\d{4}$/);
	if (owner === 'identity') {
		assert.equal(files.at(-1)?.checksum, EMAIL_MIGRATION_SHA256);
		const applied = assertMigrationLedger(files, ledger, EMAIL_MIGRATION, action !== 'email-pre');
		if (action === 'email-post') assert.equal(applied, true);
		if (action === 'email-pre') {
			const [acl] = await client.$queryRawUnsafe("WITH p AS (SELECT x.grantee,x.privilege_type FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) x WHERE d.defaclrole='winwidget_identity_migration'::regrole AND d.defaclobjtype='r' AND d.defaclnamespace IN (0,'identity'::regnamespace)) SELECT count(DISTINCT privilege_type) FILTER (WHERE grantee='winwidget_identity_runtime'::regrole AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE'))=4 AS runtime, COALESCE(bool_or(grantee='winwidget_identity_runtime'::regrole AND privilege_type='TRUNCATE'),false) AS truncate, COALESCE(bool_or(grantee='winwidget_identity_backup'::regrole AND privilege_type='SELECT'),false) AS backup, COALESCE(bool_or(grantee=0),false) AS public_access FROM p");
			same(acl, { runtime: true, truncate: false, backup: true, public_access: false });
		}
		const tables = await client.$queryRawUnsafe("SELECT to_regclass('identity.verification_email_attempts')::text AS attempts, to_regclass('identity.email_password_recoveries')::text AS recoveries");
		assert.equal(Boolean(tables[0].attempts && tables[0].recoveries), applied);
		if (!applied) same(tables, [{ attempts: null, recoveries: null }]);
		if (applied) for (const table of ['verification_email_attempts', 'email_password_recoveries']) {
			const [acl] = await client.$queryRawUnsafe(`SELECT pg_get_userbyid(relowner) AS owner, (has_table_privilege('winwidget_identity_runtime', oid, 'SELECT') AND has_table_privilege('winwidget_identity_runtime', oid, 'INSERT') AND has_table_privilege('winwidget_identity_runtime', oid, 'UPDATE') AND has_table_privilege('winwidget_identity_runtime', oid, 'DELETE')) AS runtime, has_table_privilege('winwidget_identity_runtime', oid, 'TRUNCATE') AS truncate, has_table_privilege('winwidget_identity_backup', oid, 'SELECT') AS backup FROM pg_class WHERE oid='identity.${table}'::regclass`);
			same(acl, { owner: 'winwidget_identity_migration', runtime: true, truncate: false, backup: true });
		}
		if (['email-quiet', 'email-drain'].includes(action)) for (const model of ['outboxEvent', 'consumerReceipt', 'telegramUpdateReceipt']) assert.equal(await client[model].count({ where: { status: 'PROCESSING' } }), 0);
	} else {
		assert.equal(owner, 'operations'); assertMigrationLedger(files, ledger, NOTES_MIGRATION, true); await assertOperationsIdle(client);
		if (action !== 'email-post') for (const model of ['scheduledJobRun', 'outboxEvent', 'auditEventReceipt', 'integrationDeliveryReceipt']) assert.equal(await client[model].count({ where: { status: 'PROCESSING' } }), 0);
	}
	if (action === 'email-drain') {
		const [sessions] = await client.$queryRawUnsafe(`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname='winwidget_${owner}' AND usename='winwidget_${owner}_runtime'`);
		assert.equal(sessions.count, 0);
	}
	const migrations = owner === 'identity' ? files.slice(0, -1) : ledger.map(row => ({ name: row.migration_name, checksum: row.checksum }));
	process.stdout.write(`DATABASE_ID=${serviceIdentity[0].database_id}\nMIGRATION_MANIFEST_SHA256=${sha256(JSON.stringify({ schemaVersion: 1, target: owner, migrations }))}\n`);
	return;
}
export async function runIdentityEmailAction(action) {
	if (action === 'email-source') {
		assertIdentityEmailSource(readFileSync(0, 'utf8').trim().split('\n'));
	} else if (action === 'email-image') {
		identityEmailImageInventory(process.argv[3]);
	} else if (action === 'email-images') {
		const read = name => JSON.parse(rootFileBytes(`/run/scoped/email-${name}.json`, 4 * 1024 * 1024));
		const after = read('identity-after'), api = read('identity-api-before');
		assertIdentityEmailImages(api, after, 'identity');
		for (const name of ['identity-worker', 'identity-outbox-publisher']) assertIdentityEmailWorkerBaseline(read(`${name}-before`), api, process.env.SCOPED_IDENTITY_WORKERS_PREVIOUS_REVISION || process.env.SCOPED_PREVIOUS_REVISION, process.env.SCOPED_PREVIOUS_REVISION);
		for (const name of SCOPED_SERVICES['identity-email-delivery'].filter(name => name.startsWith('operations-'))) assertIdentityEmailImages(read(`${name}-before`), read('operations-after'), 'operations', after.migrations);
	} else if (action === 'email-neighbors') {
		process.stdout.write(identityEmailNeighbors(JSON.parse(readFileSync(0, 'utf8'))));
	} else if (action === 'email-http') {
		assert.match(process.env.SCOPED_REVISION ?? '', /^[a-f0-9]{40}$/);
		for (const name of ['live', 'ready', 'revision']) {
			const response = await fetch(`http://127.0.0.1:4900/health/${name}`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
			assert.equal(response.status, 200); const data = await response.json(); assert.equal(data.service, 'identity'); assert.equal(data.revision, process.env.SCOPED_REVISION);
		}
	} else throw new Error('Unsupported email release action');
}
export const IDENTITY_EMAIL_PAYLOAD_FILES = Object.freeze(['scoped-service-release.mjs', 'identity-email-release.mjs']);
export function validateIdentityEmailPayload(bytes) {
	assert.ok(Buffer.byteLength(bytes) > 0 && Buffer.byteLength(bytes) <= 262144);
	const value = JSON.parse(bytes);
	const exact = (item, keys) => { assert.ok(item && typeof item === 'object' && !Array.isArray(item)); assert.deepEqual(Object.keys(item).sort(), keys.sort()); };
	exact(value, ['schemaVersion', 'files']); assert.equal(value.schemaVersion, 1); assert.ok(Array.isArray(value.files));
	assert.deepEqual(value.files.map(file => file.name).sort(), [...IDENTITY_EMAIL_PAYLOAD_FILES].sort());
	for (const file of value.files) {
		exact(file, ['name', 'sha256', 'content']); assert.equal(typeof file.content, 'string');
		assert.ok(Buffer.byteLength(file.content) > 0 && Buffer.byteLength(file.content) <= (file.name === 'scoped-service-release.mjs' ? 147456 : 32768));
		assert.equal(sha256(file.content), file.sha256);
	}
	return value.files;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
 try {
  assert.equal(process.argv[2], 'pack');
  const files = IDENTITY_EMAIL_PAYLOAD_FILES.map(name => {
   const path = new URL('./' + name, import.meta.url), stat = lstatSync(path);
   assert.ok(stat.isFile() && !stat.isSymbolicLink());
   const content = readFileSync(path, 'utf8'); return { name, content, sha256: sha256(content) };
  });
  const bytes = JSON.stringify({ schemaVersion: 1, files }); validateIdentityEmailPayload(bytes); process.stdout.write(bytes);
 } catch { process.stderr.write('Email release payload rejected.\n'); process.exitCode = 1; }
}
