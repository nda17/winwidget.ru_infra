import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync, openSync, closeSync, fsyncSync, createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NOTES_MIGRATION = '20260910110000_remove_admin_backlog';
export const OTP_MIGRATION = '20260910010000_add_login_otp';
export const SCOPED_SERVICES = Object.freeze({
	'operations-api-runtime': ['operations-api'],
	'operations-federation-config': ['operations-api'],
	'workers-bootstrap-recovery': ['billing-api', 'billing-worker', 'billing-outbox-publisher', 'operations-worker', 'operations-outbox-publisher', 'operations-restore-worker', 'support-worker', 'support-outbox-publisher'],
	'identity-with-operations-manifest': ['identity-api', 'identity-worker', 'identity-outbox-publisher', 'operations-api', 'operations-worker', 'operations-outbox-publisher', 'operations-restore-worker'],
	'operations-runtime': ['operations-api', 'operations-worker', 'operations-outbox-publisher', 'operations-restore-worker'],
	'operations-backlog-backup': [],
	'operations-backlog-finalize': [],
	'gateway-remove-notes': ['api-gateway']
});
export const OPERATIONS_API_SOURCE_PATHS = Object.freeze([
	'apps/operations/src/messaging-admin/messaging-admin.service.ts',
	'apps/operations/src/messaging-admin/messaging-admin.service.spec.ts',
	'apps/operations/src/federation/operations-federation.client.spec.ts',
	'apps/operations/src/operations-http-contract.spec.ts'
]);
const API_FILTER_PATH = 'messaging-admin/messaging-admin.service.js';
export const OPERATIONS_API_PHASE_A_SHA256 = '445bb6da333f2c1fd8cbc7b63ed131989a60d88c4505d49a3985dd7468822914';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function assertBrokerQuiet(rows) {
	assert.ok(Array.isArray(rows) && rows.length >= 7);
	for (const row of rows) {
		for (const key of ['consumer_count', 'messages_unacknowledged', 'messages_unconfirmed']) assert.ok(Number.isSafeInteger(row[key]) && row[key] >= 0);
		assert.equal(row.messages_unacknowledged, 0);
		assert.equal(row.messages_unconfirmed, 0);
	}
}
const same = (left, right) => assert.deepEqual(left, right);
const sorted = value => [...(value ?? [])].sort();
const capabilities = values => sorted(values).map(value => value.replace(/^CAP_/, '')).sort();
const envObject = values => Object.fromEntries((values ?? []).map(value => {
	const separator = value.indexOf('=');
	assert.ok(separator > 0);
	return [value.slice(0, separator), value.slice(separator + 1)];
}));
const duration = value => {
	if (!value) return 0;
	const units = { ns: 1, us: 1e3, ms: 1e6, s: 1e9, m: 60e9, h: 3600e9 };
	const parts = [...String(value).matchAll(/(\d+(?:\.\d+)?)(ns|us|ms|s|m|h)/g)];
	assert.equal(parts.map(part => part[0]).join(''), String(value));
	return parts.reduce((total, part) => total + Number(part[1]) * units[part[2]], 0);
};
export function assertOnlyNotesRouteRemoved(before, after) {
	assert.ok(Array.isArray(before) && Array.isArray(after));
	assert.equal(before.length, 43);
	assert.equal(after.length, 42);
	const removed = before.filter(route => route.id === 'operations-notes');
	assert.equal(removed.length, 1);
	assert.equal(removed[0].pathPrefix, '/api/v1/notes');
	same(after, before.filter(route => route.id !== 'operations-notes'));
}

export function assertMigrationLedger(files, ledger, pendingName, allowApplied = false) {
	assert.ok(files.length > 0);
	const names = files.map(file => file.name);
	same(names, sorted(names));
	assert.equal(new Set(names).size, names.length);
	assert.equal(names.at(-1), pendingName);
	const applied = new Map();
	for (const row of ledger) {
		assert.ok(row.finished_at && !row.rolled_back_at && !applied.has(row.migration_name));
		assert.match(row.checksum, /^[a-f0-9]{64}$/);
		applied.set(row.migration_name, row.checksum);
	}
	const pending = [];
	for (const file of files) {
		assert.match(file.checksum, /^[a-f0-9]{64}$/);
		if (!applied.has(file.name)) pending.push(file.name);
		else assert.equal(applied.get(file.name), file.checksum);
	}
	assert.equal(applied.size + pending.length, files.length);
	assert.ok((pending.length === 1 && pending[0] === pendingName) || (allowApplied && pending.length === 0));
	return pending.length === 0;
}

export function assertServiceConfiguration(service, live, image, allSecrets) {
	assert.equal(service.network_mode, 'host');
	assert.equal(live.HostConfig.NetworkMode, 'host');
	assert.equal(Boolean(service.privileged), false);
	assert.equal(live.HostConfig.Privileged, false);
	assert.equal(service.pid ?? '', live.HostConfig.PidMode ?? '');
	assert.equal(service.user ?? image.Config.User ?? '', live.Config.User ?? '');
	same(service.command ?? image.Config.Cmd, live.Config.Cmd);
	same(service.entrypoint ?? image.Config.Entrypoint, live.Config.Entrypoint);
	assert.equal(Boolean(service.read_only), Boolean(live.HostConfig.ReadonlyRootfs));
	same(capabilities(service.cap_add), capabilities(live.HostConfig.CapAdd));
	same(capabilities(service.cap_drop), capabilities(live.HostConfig.CapDrop));
	same(sorted(service.security_opt), sorted(live.HostConfig.SecurityOpt));
	assert.equal(service.restart ?? 'no', live.HostConfig.RestartPolicy.Name || 'no');
	assert.equal(Number(service.mem_limit ?? 0), Number(live.HostConfig.Memory ?? 0));
	assert.equal(Number(service.mem_reservation ?? 0), Number(live.HostConfig.MemoryReservation ?? 0));
	assert.equal(Math.round(Number(service.cpus ?? 0) * 1e9), Number(live.HostConfig.NanoCpus ?? 0));
	assert.equal(Number(service.pids_limit ?? 0), Number(live.HostConfig.PidsLimit ?? 0));
	same(service.logging?.options ?? {}, live.HostConfig.LogConfig.Config ?? {});
	assert.equal(service.logging?.driver ?? 'json-file', live.HostConfig.LogConfig.Type);
	assert.equal(service.ports?.length ?? 0, 0);
	assert.equal(service.devices?.length ?? 0, 0);
	const hosts = Array.isArray(service.extra_hosts)
		? service.extra_hosts.map(value => { assert.match(value, /^[^=:]+[=:].+$/); return value.replace(/^([^=:]+)[=:]/, '$1:'); })
		: Object.entries(service.extra_hosts ?? {}).map(([host, ip]) => `${host}:${ip}`);
	same(sorted(hosts), sorted(live.HostConfig.ExtraHosts));
	const mounts = (service.volumes ?? []).map(volume => {
		assert.ok(['bind', 'volume'].includes(volume.type));
		return [volume.type, volume.source, volume.target, !volume.read_only];
	});
	for (const secret of service.secrets ?? []) {
		assert.equal(secret.uid ?? '0', '0');
		assert.equal(secret.gid ?? '0', '0');
		const source = allSecrets[secret.source]?.file;
		assert.ok(typeof source === 'string' && source.startsWith('/opt/winwidget/deploy/backend/'));
		mounts.push(['bind', source, `/run/secrets/${secret.target ?? secret.source}`, false]);
	}
	const actualMounts = (live.Mounts ?? []).filter(mount => mount.Type !== 'tmpfs')
		.map(mount => [mount.Type, mount.Source, mount.Destination, mount.RW]);
	same(sorted(mounts.map(JSON.stringify)), sorted(actualMounts.map(JSON.stringify)));
	const tmpfs = Object.fromEntries((service.tmpfs ?? []).map(value => {
		const separator = value.indexOf(':');
		return separator < 0 ? [value, ''] : [value.slice(0, separator), value.slice(separator + 1)];
	}));
	same(tmpfs, live.HostConfig.Tmpfs ?? {});
	same(service.healthcheck?.test, live.Config.Healthcheck?.Test);
	for (const [composeKey, inspectKey] of [['interval', 'Interval'], ['timeout', 'Timeout'], ['start_period', 'StartPeriod']]) {
		assert.equal(duration(service.healthcheck?.[composeKey]), live.Config.Healthcheck?.[inspectKey] ?? 0);
	}
	assert.equal(service.healthcheck?.retries ?? 0, live.Config.Healthcheck?.Retries ?? 0);
	assert.equal(duration(service.stop_grace_period), Number(live.Config.StopTimeout ?? 10) * 1e9);
}

export function prepareScopedCompose({ scope, revision, previousRevision, operationsPreviousRevision, operationsApiPreviousRevision, compose, live, image, operationsImage, supportImage }) {
	assert.ok(Object.hasOwn(SCOPED_SERVICES, scope));
	assert.match(revision, /^[a-f0-9]{40}$/);
	assert.match(previousRevision, /^[a-f0-9]{40}$/);
	if (operationsApiPreviousRevision) {
		assert.equal(scope, 'identity-with-operations-manifest');
		assert.match(operationsApiPreviousRevision, /^[a-f0-9]{40}$/);
	}
	const targets = SCOPED_SERVICES[scope];
	assert.ok(targets.length > 0);
	assert.equal(live.length, targets.length);
	const desired = { name: 'winwidget', services: {}, volumes: {}, secrets: {} };
	const rollback = structuredClone(desired);
	for (const name of targets) {
		const workers = scope === 'workers-bootstrap-recovery';
		const federation = scope === 'operations-federation-config';
		const operationsApi = scope === 'operations-api-runtime';
		const companion = scope === 'identity-with-operations-manifest' && name.startsWith('operations-');
		const expectedPreviousRevision = companion ? (name === 'operations-api' && operationsApiPreviousRevision ? operationsApiPreviousRevision : operationsPreviousRevision) : previousRevision;
		const expectedImage = companion || (workers && name.startsWith('operations-')) ? operationsImage
			: workers && name.startsWith('support-') ? supportImage : image;
		assert.match(expectedPreviousRevision ?? '', /^[a-f0-9]{40}$/);
		assert.ok(expectedImage);
		const current = live.filter(container => container.Config.Labels['com.docker.compose.service'] === name);
		assert.equal(current.length, 1);
		const container = current[0];
		assert.equal(container.Config.Labels['com.docker.compose.project'], 'winwidget');
		assert.equal(container.Config.Labels['org.opencontainers.image.revision'], expectedPreviousRevision);
		assert.equal(container.State.Status, 'running');
		if (workers && name !== 'billing-api') assert.ok(['healthy', 'unhealthy'].includes(container.State.Health?.Status));
		else assert.equal(container.State.Health?.Status, 'healthy');
		assert.match(container.Id, /^[a-f0-9]{64}$/);
		assert.match(container.Image, /^sha256:[a-f0-9]{64}$/);
		const service = structuredClone(compose.services[name]);
		assert.ok(service);
		assertServiceConfiguration(service, container, expectedImage, compose.secrets ?? {});
		const before = envObject(container.Config.Env);
		const after = Object.fromEntries(Object.entries(service.environment).map(([key, value]) => [key, String(value ?? '')]));
		const inherited = envObject(expectedImage.Config.Env);
		for (const [key, value] of Object.entries(before)) {
			if (!Object.hasOwn(after, key)) assert.equal(inherited[key], value);
		}
		for (const [key, value] of Object.entries(after)) {
			if (scope === 'gateway-remove-notes' && key === 'GATEWAY_ROUTES_JSON') {
				assertOnlyNotesRouteRemoved(JSON.parse(before[key]), JSON.parse(value));
			} else if (federation && key === 'NOTIFICATION_DELIVERY_INTERNAL_URL') {
				// One reviewed legacy configuration, not a general private-URL rewrite.
				assert.equal(before[key], 'http://127.0.0.1:4401/internal/notification-delivery');
				assert.equal(value, 'http://127.0.0.1:4401');
			} else if (key === 'APP_REVISION' && scope !== 'gateway-remove-notes') {
				assert.equal(value, revision);
			} else if (scope === 'identity-with-operations-manifest' && name === 'identity-api' && key === 'IDENTITY_LOGIN_OTP_ENABLED') {
				assert.ok(['false', 'true'].includes(value));
			} else {
				assert.equal(value, before[key]);
			}
		}
		if (scope === 'gateway-remove-notes' || federation) {
			assert.equal(image.Id, container.Image);
			assert.equal(after.APP_REVISION, previousRevision);
		} else assert.equal(expectedImage.Config.Labels['org.opencontainers.image.revision'], revision);
		if (federation) {
			assert.equal(revision, previousRevision);
			assert.equal(after.NOTIFICATION_DELIVERY_INTERNAL_URL, 'http://127.0.0.1:4401');
		}
		if (operationsApi || federation || (companion && ['operations-api', 'operations-restore-worker'].includes(name)) || (workers && name === 'operations-restore-worker')) {
			assert.equal(before.DATABASE_RESTORE_ENABLED, 'false');
			assert.equal(after.DATABASE_RESTORE_ENABLED, 'false');
		}
		delete service.build;
		delete service.depends_on;
		service.image = expectedImage.Id;
		for (const volume of service.volumes ?? []) {
			if (volume.type === 'volume') {
				assert.ok(Object.hasOwn(compose.volumes ?? {}, volume.source));
				desired.volumes[volume.source] = structuredClone(compose.volumes[volume.source]);
			}
		}
		for (const secret of service.secrets ?? []) {
			assert.ok(Object.hasOwn(compose.secrets ?? {}, secret.source));
			desired.secrets[secret.source] = structuredClone(compose.secrets[secret.source]);
		}
		desired.services[name] = service;
		rollback.services[name] = { ...structuredClone(service), image: container.Image, environment: before };
	}
	rollback.volumes = structuredClone(desired.volumes);
	rollback.secrets = structuredClone(desired.secrets);
	return { desired, rollback };
}

export function assertIdentityManifestCompanion(before, after, identityFiles) {
	assert.equal(before.schemaVersion, 1);
	assert.equal(after.schemaVersion, 1);
	same(Object.keys(before.targets).sort(), Object.keys(after.targets).sort());
	for (const target of Object.keys(before.targets)) {
		if (target !== 'identity') same(before.targets[target], after.targets[target]);
	}
	assert.equal(identityFiles.at(-1)?.name, OTP_MIGRATION);
	assert.equal(identityFiles.some(file => /workspaces|invitations/.test(file.name)), false);
	for (const [entry, migrations] of [[before.targets.identity, identityFiles.slice(0, -1)], [after.targets.identity, identityFiles]]) {
		same(entry.migrations, migrations);
		assert.equal(entry.manifestSha256, sha256(JSON.stringify({ schemaVersion: 1, target: 'identity', migrations })));
	}
}

const BACKUP_LIMIT = 1024 ** 3;
const instant = value => {
	assert.equal(typeof value, 'string');
	assert.equal(new Date(value).toISOString(), value);
	return Date.parse(value);
};
function validatePhaseA(receipt) {
	assert.equal(receipt.schemaVersion, 1);
	assert.equal(receipt.kind, 'winwidget.operations.backlog-phase-a.v1');
	assert.equal(receipt.notesWriteFenceApplied, true);
	assert.match(receipt.databaseId ?? '', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
	for (const key of ['operationsRuntimeRevision', 'operationsApplicationTree', 'infraRevision']) assert.match(receipt[key] ?? '', /^[a-f0-9]{40}$/);
	for (const key of ['migrationManifestSha256', 'notesMigrationChecksum']) assert.match(receipt[key] ?? '', /^[a-f0-9]{64}$/);
	assert.match(receipt.sourceWorkerContainerId ?? '', /^[a-f0-9]{64}$/);
	assert.match(receipt.sourceWorkerImageId ?? '', /^sha256:[a-f0-9]{64}$/);
	instant(receipt.fencedAt);
}
export function validateBackupAcquisition(acquisition, receipt) {
	validatePhaseA(receipt);
	assert.equal(acquisition.schemaVersion, 1);
	assert.equal(acquisition.kind, 'winwidget.operations.backlog-backup-acquisition.v1');
	assert.equal(acquisition.phaseAReceiptSha256, sha256(JSON.stringify(receipt)));
	for (const key of ['databaseId', 'operationsRuntimeRevision', 'migrationManifestSha256', 'sourceWorkerContainerId', 'sourceWorkerImageId']) assert.equal(acquisition[key], receipt[key]);
	assert.match(acquisition.executorContainerId ?? '', /^[a-f0-9]{64}$/);
	assert.notEqual(acquisition.executorContainerId, acquisition.sourceWorkerContainerId);
	assert.equal(acquisition.executorImageId, receipt.sourceWorkerImageId);
	assert.equal(acquisition.backupRole, 'winwidget_operations_backup');
	for (const key of ['artifactSha256', 'aclSha256']) assert.match(acquisition[key] ?? '', /^[a-f0-9]{64}$/);
	assert.ok(Number.isSafeInteger(acquisition.artifactSize) && acquisition.artifactSize > 0 && acquisition.artifactSize <= BACKUP_LIMIT);
	assert.match(acquisition.pgDumpVersion ?? '', /^pg_dump \(PostgreSQL\) 18\.\d+(?: .*)?$/);
	assert.ok(instant(receipt.fencedAt) <= instant(acquisition.startedAt));
	assert.ok(instant(acquisition.startedAt) <= instant(acquisition.completedAt));
}

// Role names/owners and normalized effective ACL, never role OIDs or customer
// rows. The same statement runs under the read-only backup principal and in a
// network-isolated restore. Database names deliberately stay outside acl.
export const OPERATIONS_BACKUP_METADATA_SQL = `
SELECT json_build_object(
 'databaseId', (SELECT database_id::text FROM operations.service_identity WHERE id='singleton' AND service_name='operations-service'),
 'identityRows', (SELECT count(*) FROM operations.service_identity),
 'database', current_database(), 'schema', 'operations',
 'notesPresent', to_regclass('operations.notes') IS NOT NULL,
 'runtimeCanWriteNotes', has_table_privilege('winwidget_operations_runtime','operations.notes','INSERT,UPDATE,DELETE,TRUNCATE') OR has_any_column_privilege('winwidget_operations_runtime','operations.notes','INSERT,UPDATE'),
 'runtimeCanReadNotes', has_table_privilege('winwidget_operations_runtime','operations.notes','SELECT'),
 'migrations', (SELECT json_agg(json_build_object('name',migration_name,'checksum',checksum) ORDER BY migration_name) FROM operations._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
 'migrationRows', (SELECT count(*) FROM operations._prisma_migrations),
 'acl', json_build_object(
  'schemas', (SELECT json_agg(json_build_array(nspname,pg_get_userbyid(nspowner),ARRAY(SELECT x::text FROM unnest(COALESCE(nspacl,acldefault('n',nspowner))) x ORDER BY x::text)) ORDER BY nspname) FROM pg_namespace WHERE nspname='operations'),
  'relations', (SELECT json_agg(json_build_array(c.relname,c.relkind,pg_get_userbyid(c.relowner),ARRAY(SELECT x::text FROM unnest(COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::\"char\" ELSE 'r'::\"char\" END,c.relowner))) x ORDER BY x::text)) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='operations' AND c.relkind IN ('r','p','v','m','S','f')),
  'columns', (SELECT json_agg(json_build_array(c.relname,a.attname,ARRAY(SELECT x::text FROM unnest(a.attacl) x ORDER BY x::text)) ORDER BY c.relname,a.attname) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='operations' AND a.attacl IS NOT NULL AND a.attnum>0 AND NOT a.attisdropped),
  'routines', (SELECT json_agg(json_build_array(p.proname,pg_get_function_identity_arguments(p.oid),pg_get_userbyid(p.proowner),ARRAY(SELECT x::text FROM unnest(COALESCE(p.proacl,acldefault('f',p.proowner))) x ORDER BY x::text)) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='operations'),
  'types', (SELECT json_agg(json_build_array(t.typname,t.typtype,pg_get_userbyid(t.typowner),ARRAY(SELECT x::text FROM unnest(COALESCE(t.typacl,acldefault('T',t.typowner))) x ORDER BY x::text)) ORDER BY t.typname) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace LEFT JOIN pg_class c ON c.oid=t.typrelid WHERE n.nspname='operations' AND (t.typtype IN ('e','d','r','m') OR (t.typtype='c' AND c.relkind='c'))),
  'defaults', (SELECT json_agg(json_build_array(pg_get_userbyid(a.defaclrole),a.defaclobjtype,ARRAY(SELECT x::text FROM unnest(a.defaclacl) x ORDER BY x::text)) ORDER BY pg_get_userbyid(a.defaclrole),a.defaclobjtype) FROM pg_default_acl a JOIN pg_namespace n ON n.oid=a.defaclnamespace WHERE n.nspname='operations')
 )) AS metadata;`;

export function validateBackupMetadata(metadata, receipt) {
	assert.equal(metadata.database, 'winwidget_operations');
	assert.equal(metadata.schema, 'operations');
	assert.equal(metadata.databaseId, receipt.databaseId);
	assert.equal(metadata.identityRows, 1);
	assert.equal(metadata.notesPresent, true);
	assert.equal(metadata.runtimeCanWriteNotes, false);
	assert.equal(metadata.runtimeCanReadNotes, true);
	assert.ok(Array.isArray(metadata.migrations) && metadata.migrations.length > 0);
	assert.equal(metadata.migrationRows, metadata.migrations.length);
	assert.equal(metadata.migrations.some(row => row.name === NOTES_MIGRATION), false);
	assert.equal(sha256(JSON.stringify({ schemaVersion: 1, target: 'operations', migrations: metadata.migrations })), receipt.migrationManifestSha256);
	assert.ok(metadata.acl && Array.isArray(metadata.acl.schemas) && Array.isArray(metadata.acl.relations));
}

export async function backupArtifact(filename) {
	assert.equal(realpathSync(filename), resolve(filename));
	const before = lstatSync(filename);
	assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size > 0 && before.size <= BACKUP_LIMIT);
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(filename)) hash.update(chunk);
	const after = lstatSync(filename);
	for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key]);
	return { artifactSha256: hash.digest('hex'), artifactSize: before.size };
}

export function parseOperationsBackupUrl(value) {
	assert.equal(typeof value, 'string');
	assert.ok(Buffer.byteLength(value, 'utf8') <= 4096);
	const url = new URL(value.trim());
	assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
	assert.equal(url.hostname, '127.0.0.1');
	assert.equal(url.port, '55441');
	assert.equal(url.pathname, '/winwidget_operations');
	assert.equal(decodeURIComponent(url.username), 'winwidget_operations_backup');
	assert.ok(url.password && !url.hash);
	const queryKeys = [...url.searchParams.keys()];
	assert.equal(new Set(queryKeys).size, queryKeys.length);
	for (const key of queryKeys) assert.ok(['schema', 'connection_limit', 'pool_timeout', 'connect_timeout', 'sslmode'].includes(key));
	assert.equal(url.searchParams.get('schema'), 'operations');
	// The existing owner URL explicitly disables TLS on this fixed loopback
	// connection, matching pg_dump's PGSSLMODE below. No remote/TLS bypass is allowed.
	if (url.searchParams.has('sslmode')) assert.equal(url.searchParams.get('sslmode'), 'disable');
	url.searchParams.set('connection_limit', '1');
	url.searchParams.set('pool_timeout', '5');
	url.searchParams.set('connect_timeout', '5');
	return url;
}

// This entrypoint is NOT the ordinary maintenance bootstrap: it receives only
// one read-only backup URL file. No HTTP server, Rabbit/JWT/admin/migration,
// provider or provenance signing credential enters this disposable executor.
async function captureOperationsBackup() {
	assert.equal(process.getuid(), 1001);
	for (const key of Object.keys(process.env)) assert.equal(/DATABASE_URL|BACKUP_URL|TOKEN|PASSWORD|SECRET|PRIVATE_KEY|RABBIT|SMTP|TELEGRAM/i.test(key), false);
	const credentialPath = '/run/operations-backup-url';
	const credential = lstatSync(credentialPath);
	assert.ok(credential.isFile() && !credential.isSymbolicLink() && credential.nlink === 1 && credential.uid === 1001 && (credential.mode & 0o777) === 0o400 && credential.size <= 4096);
	const url = parseOperationsBackupUrl(readFileSync(credentialPath, 'utf8'));
	const receipt = JSON.parse(readFileSync('/run/phase-a.json', 'utf8'));
	validatePhaseA(receipt);
	const startedAt = new Date().toISOString();
	assert.ok(instant(startedAt) >= instant(receipt.fencedAt));
	const files = migrationFiles('/app/prisma/migrations');
	assert.equal(files.at(-1).name, NOTES_MIGRATION);
	assert.equal(files.at(-1).checksum, receipt.notesMigrationChecksum);
	assert.equal(sha256(JSON.stringify({ schemaVersion: 1, target: 'operations', migrations: files.slice(0, -1) })), receipt.migrationManifestSha256);
	const require = createRequire('/app/package.json');
	const { PrismaClient } = require('@prisma/operations-client');
	const client = new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [] });
	const childEnv = { PATH: process.env.PATH, LC_ALL: 'C', PGHOST: url.hostname, PGPORT: url.port,
		PGDATABASE: 'winwidget_operations', PGUSER: 'winwidget_operations_backup', PGPASSWORD: decodeURIComponent(url.password),
		PGSSLMODE: 'disable', PGCONNECT_TIMEOUT: '5', PGOPTIONS: '-c statement_timeout=180000 -c lock_timeout=10000 -c default_transaction_read_only=on' };
	let child;
	let descriptor;
	const deadline = setTimeout(() => { child?.kill('SIGKILL'); process.exit(1); }, 210000);
	const run = (args, fd) => new Promise((resolveRun, reject) => {
		let output = '';
		child = spawn('pg_dump', args, { env: childEnv, stdio: ['ignore', fd ?? 'pipe', 'ignore'] });
		const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
		child.stdout?.on('data', chunk => { output += chunk; if (output.length > 256) child.kill('SIGKILL'); });
		child.once('error', () => { clearTimeout(timer); reject(new Error('Backup client failed')); });
		child.once('close', code => { clearTimeout(timer); code === 0 ? resolveRun(output.trim()) : reject(new Error('Backup client failed')); });
	});
	try {
		const principal = await client.$queryRawUnsafe(`SELECT current_user AS username, current_database() AS database, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication,
pg_has_role(current_user,'winwidget_operations_migration','MEMBER') AS migration_member, pg_has_role(current_user,'winwidget_operations_runtime','MEMBER') AS runtime_member,
has_schema_privilege(current_user,'operations','CREATE') AS schema_create, has_database_privilege(current_user,current_database(),'CREATE') AS database_create,
EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='operations' AND c.relkind IN ('r','p','v','m','f') AND (has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES'))) AS table_write,
EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='operations' AND c.relkind='S' AND has_sequence_privilege(current_user,c.oid,'USAGE,UPDATE')) AS sequence_write
FROM pg_roles WHERE rolname=current_user`);
		assert.equal(principal.length, 1);
		assert.equal(principal[0].username, 'winwidget_operations_backup');
		assert.equal(principal[0].database, 'winwidget_operations');
		for (const key of ['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'migration_member', 'runtime_member', 'schema_create', 'database_create', 'table_write', 'sequence_write']) assert.equal(principal[0][key], false);
		const before = (await client.$queryRawUnsafe(OPERATIONS_BACKUP_METADATA_SQL))[0].metadata;
		validateBackupMetadata(before, receipt);
		const pgDumpVersion = await run(['--version']);
		assert.match(pgDumpVersion, /^pg_dump \(PostgreSQL\) 18\.\d+(?: .*)?$/);
		descriptor = openSync('/run/backup/operations.dump', 'wx', 0o600);
		await run(['--format=custom', '--no-password', '--schema=operations', '--strict-names', '--lock-wait-timeout=10s'], descriptor);
		fsyncSync(descriptor);
		closeSync(descriptor); descriptor = undefined;
		const artifact = await backupArtifact('/run/backup/operations.dump');
		const after = (await client.$queryRawUnsafe(OPERATIONS_BACKUP_METADATA_SQL))[0].metadata;
		same(after, before);
		writeFileSync('/run/backup/capture.json', JSON.stringify({ ...artifact, aclSha256: sha256(JSON.stringify(before.acl)), pgDumpVersion,
			startedAt, completedAt: new Date().toISOString(), databaseId: before.databaseId,
			migrationManifestSha256: receipt.migrationManifestSha256 }), { mode: 0o600, flag: 'wx' });
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		await client.$disconnect();
		clearTimeout(deadline);
	}
}

export function parseIdentityMigrationInventory(bytes) {
	assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 1024 * 1024);
	const text = bytes.toString('utf8');
	assert.ok(Buffer.from(text).equals(bytes));
	const inventory = JSON.parse(text);
	same(Object.keys(inventory).sort(), ['migrations', 'schemaVersion', 'target']);
	assert.equal(inventory.schemaVersion, 1);
	assert.equal(inventory.target, 'identity');
	assert.ok(Array.isArray(inventory.migrations) && inventory.migrations.length > 0 && inventory.migrations.length <= 4096);
	for (const file of inventory.migrations) {
		same(Object.keys(file).sort(), ['checksum', 'name']);
		assert.match(file.name, /^\d{14}_[a-z0-9_]+$/);
		assert.match(file.checksum, /^[a-f0-9]{64}$/);
	}
	const names = inventory.migrations.map(file => file.name);
	same(names, sorted(names));
	assert.equal(new Set(names).size, names.length);
	return inventory.migrations;
}

export function validateRestoreEvidence(evidence, receipt, acquisition) {
	validateBackupAcquisition(acquisition, receipt);
	assert.equal(evidence.schemaVersion, 1);
	assert.equal(evidence.kind, 'winwidget.operations.backlog-backup-restore.v1');
	assert.equal(receipt.schemaVersion, 1);
	assert.equal(receipt.kind, 'winwidget.operations.backlog-phase-a.v1');
	assert.equal(receipt.notesWriteFenceApplied, true);
	assert.match(receipt.notesMigrationChecksum ?? '', /^[a-f0-9]{64}$/);
	assert.equal(evidence.phaseAReceiptSha256, sha256(JSON.stringify(receipt)));
	for (const key of ['databaseId', 'operationsRuntimeRevision', 'migrationManifestSha256']) assert.equal(evidence[key], receipt[key]);
	assert.match(evidence.artifactSha256, /^[a-f0-9]{64}$/);
	assert.equal(evidence.artifactSha256, acquisition.artifactSha256);
	assert.equal(evidence.artifactSize, acquisition.artifactSize);
	assert.equal(evidence.acquisitionReceiptSha256, sha256(JSON.stringify(acquisition)));
	assert.equal(evidence.restoredAclSha256, acquisition.aclSha256);
	assert.match(evidence.restoreImageId, /^sha256:[a-f0-9]{64}$/);
	assert.equal(evidence.postgresMajor, 18);
	assert.equal(evidence.restoreExitCode, 0);
	assert.equal(evidence.restoredSchema, 'operations');
	assert.equal(evidence.notesTablePresent, true);
	assert.equal(evidence.restoredNotesWriteFence, true);
	assert.equal(evidence.unrelatedAuditRoundTripEqual, true);
	assert.ok(Number.isSafeInteger(evidence.notesRows) && evidence.notesRows >= 0);
	assert.ok(Number.isSafeInteger(evidence.backlogAuditRows) && evidence.backlogAuditRows >= 0);
	assert.ok(instant(evidence.restoredAt) >= instant(acquisition.completedAt));
}

// The incident-specific runtime hunk is narrower than its file allowlist.
export function assertOperationsApiSource(before, after) {
	assert.ok(typeof before === 'string' && typeof after === 'string' && before.length <= 262144 && after.length <= 262144);
	const oldOpen = "\t\tif (status === 'OPEN' || status === 'UNRESOLVED')\n\t\t\twhere.resolvedAt = null;";
	const newOpen = "\t\tif (status === 'FAILED') {\n\t\t\twhere.resolvedAt = null;\n\t\t\twhere.retryingAt = null;\n\t\t} else if (status === 'OPEN' || status === 'UNRESOLVED')\n\t\t\twhere.resolvedAt = null;";
	const oldClosed = "\t\t} else if (status === 'RESOLVED' || status === 'CLOSED') {\n\t\t\twhere.resolvedAt = { not: null };";
	const newClosed = "\t\t} else if (status === 'RESOLVED') {\n\t\t\twhere.resolution = IntegrationFailureResolution.DELIVERED;\n\t\t} else if (status === 'CLOSED') {\n\t\t\twhere.resolution = IntegrationFailureResolution.CLOSED_NO_RETRY;";
	for (const part of [oldOpen, oldClosed]) assert.equal(before.split(part).length, 2);
	assert.equal(after, before.replace(oldOpen, newOpen).replace(oldClosed, newClosed));
}

function rootFileBytes(filename, maximum = 1048576) {
	const metadata = lstatSync(filename);
	assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 && metadata.uid === 0 && metadata.gid === 0 && (metadata.mode & 0o7777) === 0o600 && metadata.size > 0 && metadata.size <= maximum);
	assert.equal(realpathSync(filename), filename);
	return readFileSync(filename);
}

export function validateOperationsApiPhase(bytes, expected) {
	assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 65536);
	const phase = JSON.parse(bytes);
	assert.equal(bytes.toString(), JSON.stringify(phase));
	validatePhaseA(phase);
	assert.equal(sha256(bytes), OPERATIONS_API_PHASE_A_SHA256);
	assert.equal(phase.operationsRuntimeRevision, expected.revision);
	assert.equal(phase.operationsApplicationTree, expected.applicationTree);
	assert.equal(phase.notesMigrationChecksum, expected.notesChecksum);
	return phase;
}

export function validateOperationsApiInventory(value) {
	same(Object.keys(value).sort(), ['compiled', 'filterMode', 'generatedModels', 'generatedSchemaSha256', 'kind', 'migrations', 'restoreManifestSha256', 'restoreTargets', 'schemaSha256', 'schemaVersion'].sort());
	assert.equal(value.schemaVersion, 1);
	assert.equal(value.kind, 'winwidget.operations.api-image-inventory.v1');
	assert.ok(['legacy', 'fixed'].includes(value.filterMode));
	assert.equal(value.migrations.length, 14);
	assert.equal(value.migrations.at(-1).name, NOTES_MIGRATION);
	assert.equal(new Set(value.migrations.map(item => item.name)).size, 14);
	same(value.migrations.map(item => item.name), value.migrations.map(item => item.name).sort());
	for (const item of value.migrations) { same(Object.keys(item).sort(), ['checksum', 'name']); assert.match(item.name, /^\d{14}_[a-z0-9_]+$/); assert.match(item.checksum, /^[a-f0-9]{64}$/); }
	for (const key of ['schemaSha256', 'generatedSchemaSha256', 'restoreManifestSha256']) assert.match(value[key], /^[a-f0-9]{64}$/);
	assert.equal(value.generatedSchemaSha256, value.schemaSha256);
	// Operations deliberately is not one of its seven own restore targets.
	same(value.restoreTargets, ['campaigns', 'identity', 'notification-delivery', 'platform', 'reporting', 'support', 'widgets']);
	assert.ok(Array.isArray(value.generatedModels) && value.generatedModels.length > 10 && value.generatedModels.length < 100 && !value.generatedModels.includes('Note'));
	same(value.generatedModels, [...new Set(value.generatedModels)].sort());
	assert.ok(Array.isArray(value.compiled) && value.compiled.length > 10 && value.compiled.length <= 1024);
	for (const item of value.compiled) { same(Object.keys(item).sort(), ['path', 'sha256']); assert.match(item.path, /^[a-z0-9][a-z0-9./-]*\.js$/); assert.ok(!item.path.includes('..')); assert.match(item.sha256, /^[a-f0-9]{64}$/); }
	same(value.compiled.map(item => item.path), [...new Set(value.compiled.map(item => item.path))].sort());
	assert.equal(value.compiled.filter(item => item.path === API_FILTER_PATH).length, 1);
	return value;
}

export function assertOperationsApiImages(before, after) {
	validateOperationsApiInventory(before); validateOperationsApiInventory(after);
	assert.equal(before.filterMode, 'legacy'); assert.equal(after.filterMode, 'fixed');
	for (const key of ['migrations', 'schemaSha256', 'generatedSchemaSha256', 'generatedModels', 'restoreManifestSha256', 'restoreTargets']) same(after[key], before[key]);
	same(after.compiled.filter(item => item.path !== API_FILTER_PATH), before.compiled.filter(item => item.path !== API_FILTER_PATH));
	assert.notEqual(after.compiled.find(item => item.path === API_FILTER_PATH).sha256, before.compiled.find(item => item.path === API_FILTER_PATH).sha256);
}

function operationsApiImageInventory(mode) {
	assert.equal(process.getuid(), 1001);
	assert.ok(['legacy', 'fixed'].includes(mode));
	const root = '/app/dist/src', compiled = [];
	const visit = directory => {
		assert.equal(realpathSync(directory), directory);
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			assert.ok(!entry.isSymbolicLink());
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else { assert.ok(entry.isFile()); if (entry.name.endsWith('.js')) compiled.push({ path: path.slice(root.length + 1), sha256: sha256(readFileSync(path)) }); }
		}
	};
	visit(root);
	const require = createRequire('/app/package.json');
	const { Prisma } = require('@prisma/operations-client');
	const { MessagingAdminService } = require(`/app/dist/src/${API_FILTER_PATH}`);
	const service = Object.create(MessagingAdminService.prototype);
	for (const status of ['OPEN', 'UNRESOLVED']) same(service.failureWhere({ status }), { resolvedAt: null });
	same(service.failureWhere({ status: 'RETRYING' }), { resolvedAt: null, retryingAt: { not: null } });
	for (const status of [undefined, 'ALL']) same(service.failureWhere({ status }), {});
	if (mode === 'legacy') {
		assert.throws(() => service.failureWhere({ status: 'FAILED' }));
		for (const status of ['RESOLVED', 'CLOSED']) same(service.failureWhere({ status }), { resolvedAt: { not: null } });
	} else {
		same(service.failureWhere({ status: 'FAILED' }), { resolvedAt: null, retryingAt: null });
		same(service.failureWhere({ status: 'RESOLVED' }), { resolution: 'DELIVERED' });
		same(service.failureWhere({ status: 'CLOSED' }), { resolution: 'CLOSED_NO_RETRY' });
	}
	assert.throws(() => service.failureWhere({ status: 'UNKNOWN' }));
	const restoreBytes = readFileSync('/app/restore-manifests/database-restore-migrations.json');
	const value = { schemaVersion: 1, kind: 'winwidget.operations.api-image-inventory.v1', filterMode: mode,
		migrations: migrationFiles('/app/prisma/migrations'), schemaSha256: sha256(readFileSync('/app/prisma/schema.prisma')),
		generatedSchemaSha256: sha256(readFileSync(require.resolve('@prisma/operations-client/schema.prisma'))),
		generatedModels: Prisma.dmmf.datamodel.models.map(item => item.name).sort(), restoreManifestSha256: sha256(restoreBytes),
		restoreTargets: Object.keys(JSON.parse(restoreBytes).targets).sort(), compiled: compiled.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
	validateOperationsApiInventory(value);
	process.stdout.write(JSON.stringify(value));
}

export function assertOperationsApiPeers(live, phase, expectedApi, allowStopped = false) {
	assert.equal(live.length, 5);
	for (const name of [...SCOPED_SERVICES['operations-runtime'], 'api-gateway']) {
		const found = live.filter(item => item.Config.Labels['com.docker.compose.service'] === name);
		assert.equal(found.length, 1);
		const item = found[0];
		assert.equal(item.Config.Labels['com.docker.compose.project'], 'winwidget');
		assert.match(item.Id, /^[a-f0-9]{64}$/);
		const env = envObject(item.Config.Env);
		if (name === 'api-gateway') {
			const routes = JSON.parse(env.GATEWAY_ROUTES_JSON);
			assert.equal(routes.length, 43); assert.equal(new Set(routes.map(route => route.id)).size, 43);
			same(routes.filter(route => route.id === 'operations-notes'), [{ id: 'operations-notes', pathPrefix: '/api/v1/notes', upstreamUrl: 'http://127.0.0.1:5200', authPolicy: 'required', timeoutMs: 30000 }]);
			assert.equal(routes.filter(route => route.upstreamUrl === 'http://127.0.0.1:5200').length, 8);
		} else {
			const api = name === 'operations-api';
			assert.equal(item.Image, api ? expectedApi.imageId : phase.sourceWorkerImageId);
			assert.equal(item.Config.Labels['org.opencontainers.image.revision'], api ? expectedApi.revision : phase.operationsRuntimeRevision);
			assert.equal(env.APP_REVISION, api ? expectedApi.revision : phase.operationsRuntimeRevision);
			if (name === 'operations-worker') assert.equal(item.Id, phase.sourceWorkerContainerId);
			if (api || name === 'operations-restore-worker') assert.equal(env.DATABASE_RESTORE_ENABLED, 'false');
		}
		if (name === 'operations-api' && allowStopped) {
			assert.ok(['running', 'exited', 'created'].includes(item.State.Status));
			if (item.State.Status !== 'running') assert.equal(item.State.Pid, 0);
		} else { assert.equal(item.State.Status, 'running'); assert.equal(item.State.Health?.Status, 'healthy'); }
	}
}

export async function verifyOperationsApiHttp(revision, fetcher = fetch) {
	assert.match(revision, /^[a-f0-9]{40}$/);
	for (const name of ['live', 'ready', 'deployment']) {
		const path = name === 'deployment' ? '/api/v1/health/deployment' : `/health/${name}`;
		const response = await fetcher(`http://127.0.0.1:5200${path}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000) });
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('cache-control'), 'no-store');
		const value = await response.json();
		assert.equal(value.service, 'operations'); assert.equal(value.role, 'api'); assert.equal(value.revision, revision);
		if (name !== 'deployment') assert.equal(value.status, name === 'ready' ? 'ready' : 'ok');
	}
}

export function operationsApiNeighborFingerprint(live) {
	assert.equal(live.length, 31);
	assert.equal(new Set(live.map(item => item.Id)).size, 31);
	assert.equal(live.filter(item => item.Config.Labels['com.docker.compose.service'] === 'operations-api').length, 1);
	for (const item of live) {
		assert.equal(item.Config.Labels['com.docker.compose.project'], 'winwidget');
		assert.match(item.Id, /^[a-f0-9]{64}$/);
	}
	const neighbors = live.filter(item => item.Config.Labels['com.docker.compose.service'] !== 'operations-api');
	return sha256(JSON.stringify(neighbors.map(item => ({ id: item.Id, image: item.Image, config: item.Config, host: item.HostConfig, mounts: item.Mounts,
		status: item.State.Status, running: item.State.Running, startedAt: item.State.StartedAt, health: item.State.Health?.Status ?? null, restartCount: item.RestartCount }))
		.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
}

export function migrationFiles(root) {
	assert.equal(realpathSync(root), resolve(root));
	assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink());
	const names = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.name === 'migration_lock.toml') {
			assert.ok(entry.isFile() && !entry.isSymbolicLink());
			continue;
		}
		assert.match(entry.name, /^\d{14}_[a-z0-9_]+$/);
		assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
		names.push(entry.name);
	}
	return names.sort().map(name => {
		const filename = join(root, name, 'migration.sql');
		assert.ok(lstatSync(filename).isFile() && !lstatSync(filename).isSymbolicLink());
		return { name, checksum: sha256(readFileSync(filename)) };
	});
}

export async function verifyDatabaseState(client, files, action, owner, context = {}) {
	assert.ok(['identity', 'operations'].includes(owner) || (['worker-ledger', 'worker-quiet'].includes(action) && ['billing', 'support'].includes(owner)));
	if (action === 'operations-api-pre-finalize') {
		assert.equal(owner, 'operations');
		assert.equal((await client.$queryRawUnsafe('SHOW transaction_read_only'))[0]?.transaction_read_only, 'on');
	}
	{
		const identity = await client.$queryRawUnsafe(`SELECT current_database() AS database, current_user AS username, current_schema() AS schema, pg_is_in_recovery() AS recovery`);
		same(identity.map(row => [row.database, row.schema, row.recovery]), [[`winwidget_${owner}`, owner, false]]);
		assert.equal(identity[0].username, `winwidget_${owner}_migration`);
		const serviceIdentity = await client.$queryRawUnsafe(`SELECT id, service_name, database_id::text AS database_id FROM "${owner}".service_identity`);
		assert.equal(serviceIdentity.length, 1);
		assert.equal(serviceIdentity[0].id, 'singleton');
		assert.equal(serviceIdentity[0].service_name, `${owner}-service`);
		assert.match(serviceIdentity[0].database_id, /^[a-f0-9-]{36}$/);
		const ledger = await client.$queryRawUnsafe(`SELECT migration_name, checksum, finished_at, rolled_back_at FROM "${owner}"._prisma_migrations ORDER BY migration_name`);
		const pendingName = owner === 'identity' ? OTP_MIGRATION : NOTES_MIGRATION;
		if (action === 'all-guard') {
			const expectedChecksum = context.notesChecksum ?? process.env.SCOPED_NOTES_CHECKSUM;
			assert.match(expectedChecksum ?? '', /^[a-f0-9]{64}$/);
			assert.equal(ledger.filter(row => row.migration_name === NOTES_MIGRATION && row.finished_at && !row.rolled_back_at && row.checksum === expectedChecksum).length, 1);
			const tables = await client.$queryRaw`SELECT to_regclass('operations.notes')::text AS notes`;
			assert.equal(tables[0].notes, null);
			const finalized = context.finalizedReceipt ?? JSON.parse(readFileSync('/run/scoped/finalized.json', 'utf8'));
			assert.equal(finalized.schemaVersion, 1);
			assert.equal(finalized.kind, 'winwidget.operations.backlog-finalized.v1');
			assert.equal(finalized.databaseId, serviceIdentity[0].database_id);
			assert.equal(finalized.migrationChecksum, expectedChecksum);
			for (const key of ['phaseAReceiptSha256', 'restoreEvidenceSha256']) assert.match(finalized[key] ?? '', /^[a-f0-9]{64}$/);
			return;
		}
		const assertOperationsIdle = async tx => {
			const [jobs, permits, recovery, outbox, lease] = await Promise.all([
				tx.databaseRestoreJob.count({ where: { OR: [{ status: { in: ['QUEUED', 'PROCESSING'] } }, { status: 'RECOVERY_REQUIRED', recoveryResolvedAt: null }] } }),
				tx.databaseRestorePermit.count({ where: { status: { in: ['PENDING_APPROVAL', 'APPROVED', 'CONSUMED'] } } }),
				tx.databaseRestoreRecoveryAction.count({ where: { status: { notIn: ['RESOLVED', 'EXPIRED'] } } }),
				tx.outboxEvent.count({ where: { eventType: { in: ['operations.database-restore.requested.v1', 'operations.database-restore.recovery-action.requested.v1'] }, status: { in: ['PENDING', 'PROCESSING'] } } }),
				tx.databaseRestoreExecutionLease.findUnique({ where: { id: 'singleton' }, select: { operationType: true, operationId: true, leaseOwner: true, leaseToken: true } })
			]);
			assert.ok([jobs, permits, recovery, outbox].every(count => count === 0));
			assert.ok(!lease || Object.values(lease).every(value => value === null));
		};
		if (action === 'operations-api-pre-finalize') {
			assert.equal(files.length, 14);
			assert.equal(files.at(-1)?.name, NOTES_MIGRATION);
			assert.equal(assertMigrationLedger(files, ledger, NOTES_MIGRATION), false);
			const expectedId = context.databaseId ?? process.env.SCOPED_DATABASE_ID;
			const expectedManifest = context.migrationManifestSha256 ?? process.env.SCOPED_MIGRATION_MANIFEST_SHA256;
			const expectedNotesChecksum = context.notesChecksum ?? process.env.SCOPED_NOTES_CHECKSUM;
			assert.equal(serviceIdentity[0].database_id, expectedId);
			assert.equal(files.at(-1).checksum, expectedNotesChecksum);
			assert.equal(sha256(JSON.stringify({ schemaVersion: 1, target: 'operations', migrations: files.slice(0, -1) })), expectedManifest);
			assert.equal((await client.$queryRaw`SELECT to_regclass('operations.notes') IS NOT NULL AS present`)[0].present, true);
			const grants = await client.$queryRawUnsafe("SELECT count(*)::int AS count FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl, acldefault('r', relation.relowner))) permission WHERE namespace.nspname = 'operations' AND relation.relname = 'notes' AND permission.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE') AND permission.grantee <> 'winwidget_operations_migration'::regrole");
			assert.equal(grants[0].count, 0);
			const columns = await client.$queryRawUnsafe("SELECT count(*)::int AS count FROM pg_attribute attribute JOIN pg_class relation ON relation.oid = attribute.attrelid JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace CROSS JOIN LATERAL aclexplode(attribute.attacl) permission WHERE namespace.nspname = 'operations' AND relation.relname = 'notes' AND permission.privilege_type IN ('INSERT','UPDATE') AND permission.grantee <> 'winwidget_operations_migration'::regrole");
			assert.equal(columns[0].count, 0);
			const effective = await client.$queryRawUnsafe("SELECT has_table_privilege('winwidget_operations_runtime', 'operations.notes', 'INSERT,UPDATE,DELETE,TRUNCATE') OR has_any_column_privilege('winwidget_operations_runtime', 'operations.notes', 'INSERT,UPDATE') AS writable");
			assert.equal(effective[0].writable, false);
			await assertOperationsIdle(client);
			// Hash inside the owner DB; no row contents leave this read-only probe.
			const fingerprints = [];
			for (const [table, predicate] of [['notes', 'TRUE'], ['admin_event_logs', "section='BACKLOG' OR entity_type='backlog_task' OR action IN ('BACKLOG_TASK_CREATE','BACKLOG_TASK_UPDATE','BACKLOG_TASK_DELETE')"]]) {
				const rows = await client.$queryRawUnsafe(`SELECT count(*)::text AS count, encode(sha256(convert_to(COALESCE(string_agg(encode(sha256(convert_to(to_jsonb(value)::text, 'UTF8')), 'hex'), '' ORDER BY value.id), ''), 'UTF8')), 'hex') AS fingerprint FROM operations.${table} value WHERE ${predicate}`);
				assert.equal(rows.length, 1); assert.match(rows[0].count, /^(0|[1-9][0-9]*)$/); assert.match(rows[0].fingerprint, /^[a-f0-9]{64}$/);
				fingerprints.push(rows[0]);
			}
			process.stdout.write(`DATABASE_ID=${expectedId}\nMIGRATION_MANIFEST_SHA256=${expectedManifest}\nNOTES_STATE_SHA256=${sha256(JSON.stringify(fingerprints))}\n`);
			return;
		}
		if (action === 'operations-quiet') {
			assert.equal(owner, 'operations');
			await assertOperationsIdle(client);
			for (const model of ['scheduledJobRun', 'outboxEvent', 'auditEventReceipt', 'integrationDeliveryReceipt']) assert.equal(await client[model].count({ where: { status: 'PROCESSING' } }), 0);
			return; // Quiet sampling never substitutes for the independent ledger gate.
		}
		if (['worker-ledger', 'worker-quiet'].includes(action)) {
			assert.ok(['billing', 'operations', 'support'].includes(owner));
			assert.ok(files.length > 0);
			same(ledger.map(row => ({ name: row.migration_name, checksum: row.checksum })), files);
			assert.ok(ledger.every(row => row.finished_at && !row.rolled_back_at));
			assert.equal(files.some(file => [OTP_MIGRATION, NOTES_MIGRATION].includes(file.name)), false);
			if (owner === 'operations') await assertOperationsIdle(client);
			if (action === 'worker-quiet') {
				const models = {
					billing: ['providerOperation', 'outboxEvent', 'integrationDeliveryReceipt'],
					operations: ['scheduledJobRun', 'outboxEvent', 'auditEventReceipt', 'integrationDeliveryReceipt'],
					support: ['telegramWebhookInbox', 'telegramOutboundDelivery', 'outboxEvent', 'consumerReceipt']
				};
				for (const model of models[owner]) {
					const statuses = model === 'providerOperation' ? ['PENDING', 'PROCESSING'] : ['PROCESSING'];
					assert.equal(await client[model].count({ where: { status: { in: statuses } } }), 0);
				}
			}
			process.stdout.write(`DATABASE_ID=${serviceIdentity[0].database_id}\nMIGRATION_MANIFEST_SHA256=${sha256(JSON.stringify({ schemaVersion: 1, target: owner, migrations: files }))}\n`);
			return;
		}
		if (action === 'operations-drain') {
			assert.equal(owner, 'operations');
			assert.equal(files.some(file => file.name === NOTES_MIGRATION), false);
			same(ledger.map(row => ({ name: row.migration_name, checksum: row.checksum })), files);
			assert.ok(ledger.every(row => row.finished_at && !row.rolled_back_at));
			await client.$transaction(async tx => {
				await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
				await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10s'");
				const sessions = await tx.$queryRawUnsafe("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = 'winwidget_operations' AND usename = 'winwidget_operations_runtime'");
				assert.equal(sessions[0].count, 0);
				await tx.$executeRawUnsafe('LOCK TABLE operations.scheduled_job_runs IN SHARE MODE');
				const jobs = await tx.$queryRawUnsafe("SELECT count(*)::int AS count FROM operations.scheduled_job_runs WHERE status = 'PROCESSING'");
				assert.equal(jobs[0].count, 0);
				await assertOperationsIdle(tx);
			}, { timeout: 15000 });
			process.stdout.write(`DATABASE_ID=${serviceIdentity[0].database_id}\nMIGRATION_MANIFEST_SHA256=${sha256(JSON.stringify({ schemaVersion: 1, target: owner, migrations: files }))}\n`);
			return;
		}
		if (owner === 'identity') assert.equal(files.some(file => /workspaces|invitations/.test(file.name)), false);
		const applied = assertMigrationLedger(files, ledger, pendingName, action === 'post-migration');
		assert.equal(applied, action === 'post-migration');
		const manifest = { schemaVersion: 1, target: owner, migrations: files.filter(file => file.name !== pendingName) };
		if (owner === 'operations') {
			await assertOperationsIdle(client);
			const table = await client.$queryRaw`SELECT to_regclass('operations.notes')::text AS notes`;
			assert.equal(table[0].notes !== null, action !== 'post-migration');
			if (action === 'fence') {
				await client.$transaction(async tx => {
					await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '10s'");
					await tx.$executeRawUnsafe('LOCK TABLE operations.notes IN ACCESS EXCLUSIVE MODE NOWAIT');
					await tx.$executeRawUnsafe('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON operations.notes FROM winwidget_operations_runtime');
				});
			}
			if (action === 'fence' || action === 'pre-finalize') {
				const grants = await client.$queryRawUnsafe(`SELECT count(*)::int AS count FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl, acldefault('r', relation.relowner))) permission WHERE namespace.nspname = 'operations' AND relation.relname = 'notes' AND permission.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE') AND permission.grantee <> 'winwidget_operations_migration'::regrole`);
				assert.equal(grants[0].count, 0);
				const columnGrants = await client.$queryRawUnsafe(`SELECT count(*)::int AS count FROM pg_attribute attribute JOIN pg_class relation ON relation.oid = attribute.attrelid JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace CROSS JOIN LATERAL aclexplode(attribute.attacl) permission WHERE namespace.nspname = 'operations' AND relation.relname = 'notes' AND permission.privilege_type IN ('INSERT','UPDATE') AND permission.grantee <> 'winwidget_operations_migration'::regrole`);
				assert.equal(columnGrants[0].count, 0);
				const effective = await client.$queryRawUnsafe(`SELECT has_table_privilege('winwidget_operations_runtime', 'operations.notes', 'INSERT,UPDATE,DELETE,TRUNCATE') OR has_any_column_privilege('winwidget_operations_runtime', 'operations.notes', 'INSERT,UPDATE') AS writable`);
				assert.equal(effective[0].writable, false);
				await client.$transaction(async tx => {
					await tx.$executeRawUnsafe('LOCK TABLE operations.notes IN ACCESS EXCLUSIVE MODE NOWAIT');
				});
			}
		}
		process.stdout.write(`DATABASE_ID=${serviceIdentity[0].database_id}\nMIGRATION_MANIFEST_SHA256=${sha256(JSON.stringify(manifest))}\n`);
	}
}

async function databaseAction(action, owner) {
	assert.ok(['identity', 'operations'].includes(owner) || (['worker-ledger', 'worker-quiet'].includes(action) && ['billing', 'support'].includes(owner)));
	const require = createRequire('/app/package.json');
	const { PrismaClient } = require(`@prisma/${owner}-client`);
	// The all-services admission needs metadata the runtime must not own. Use
	// the existing migration credential, read-only here; never widen runtime ACL.
	if (action === 'all-guard') assert.ok(process.env.OPERATIONS_MIGRATION_DATABASE_URL);
	const client = new PrismaClient(action === 'all-guard'
		? { datasources: { db: { url: process.env.OPERATIONS_MIGRATION_DATABASE_URL } } }
		: undefined);
	const deadline = ['worker-quiet', 'operations-quiet', 'operations-api-pre-finalize'].includes(action) ? setTimeout(() => process.exit(1), 15000) : undefined;
	try {
		const files = migrationFiles('/app/prisma/migrations');
		if (action === 'operations-api-pre-finalize') {
			await client.$transaction(async tx => {
				await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
				await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10s'");
				await verifyDatabaseState(tx, files, action, owner);
			}, { timeout: 12000, isolationLevel: 'RepeatableRead' });
		} else await verifyDatabaseState(client, files, action, owner);
	}
	finally { await client.$disconnect(); clearTimeout(deadline); }
}

async function main() {
	const action = process.argv[2];
	if (action === 'backup-capture') await captureOperationsBackup();
	else if (action === 'operations-api-inventory') operationsApiImageInventory(process.argv[3]);
	else if (action === 'operations-api-http') await verifyOperationsApiHttp(process.argv[3]);
	else if (action === 'api-neighbors') process.stdout.write(operationsApiNeighborFingerprint(JSON.parse(rootFileBytes('/run/scoped/api-neighbors.json'))));
	else if (action === 'api-source') {
		assertOperationsApiSource(rootFileBytes('/run/scoped/api-source-before.ts', 262144).toString(), rootFileBytes('/run/scoped/api-source-after.ts', 262144).toString());
	} else if (action === 'api-image-pair') {
		assertOperationsApiImages(JSON.parse(rootFileBytes('/run/scoped/api-image-before.json')), JSON.parse(rootFileBytes('/run/scoped/api-image-after.json')));
	} else if (action === 'api-phase') {
		assert.ok(['healthy', 'recovery'].includes(process.argv[3]));
		const phase = validateOperationsApiPhase(rootFileBytes('/run/scoped/phase-a.json', 65536), { revision: process.env.SCOPED_PHASE_A_REVISION, applicationTree: process.env.SCOPED_APPLICATION_TREE, notesChecksum: process.env.SCOPED_NOTES_CHECKSUM });
		const before = validateOperationsApiInventory(JSON.parse(rootFileBytes('/run/scoped/api-image-before.json')));
		assert.equal(before.filterMode, 'legacy');
		assert.equal(before.migrations.at(-1).checksum, phase.notesMigrationChecksum);
		assert.equal(sha256(JSON.stringify({ schemaVersion: 1, target: 'operations', migrations: before.migrations.slice(0, -1) })), phase.migrationManifestSha256);
		assertOperationsApiPeers(JSON.parse(rootFileBytes('/run/scoped/api-peers.json')), phase, { revision: process.env.SCOPED_API_REVISION, imageId: process.env.SCOPED_API_IMAGE }, process.argv[3] === 'recovery');
		process.stdout.write(`DATABASE_ID=${phase.databaseId}\nMIGRATION_MANIFEST_SHA256=${phase.migrationManifestSha256}\n`);
	}
	else if (action === 'backup-admission') {
		const receipt = JSON.parse(readFileSync('/run/scoped/phase-a.json', 'utf8'));
		validatePhaseA(receipt);
		assert.equal(receipt.operationsRuntimeRevision, process.env.SCOPED_REVISION);
		assert.equal(receipt.operationsApplicationTree, process.env.SCOPED_APPLICATION_TREE);
		assert.equal(receipt.notesMigrationChecksum, process.env.SCOPED_NOTES_CHECKSUM);
		const live = JSON.parse(readFileSync('/run/scoped/backup-live.json', 'utf8'));
		assert.equal(live.length, 4);
		for (const name of SCOPED_SERVICES['operations-runtime']) {
			const found = live.filter(item => item.Config.Labels['com.docker.compose.service'] === name);
			assert.equal(found.length, 1);
			const item = found[0];
			assert.equal(item.Config.Labels['com.docker.compose.project'], 'winwidget');
			assert.equal(item.Config.Labels['org.opencontainers.image.revision'], receipt.operationsRuntimeRevision);
			assert.equal(item.Image, receipt.sourceWorkerImageId);
			assert.equal(item.State.Status, 'running');
			assert.equal(item.State.Health?.Status, 'healthy');
			if (name === 'operations-worker') assert.equal(item.Id, receipt.sourceWorkerContainerId);
			if (['operations-api', 'operations-restore-worker'].includes(name)) assert.equal(envObject(item.Config.Env).DATABASE_RESTORE_ENABLED, 'false');
		}
	} else if (action === 'backup-seal') {
		assert.equal(process.getuid(), 0);
		const receipt = JSON.parse(readFileSync('/run/scoped/phase-a.json', 'utf8'));
		const capture = JSON.parse(readFileSync('/run/scoped/capture.json', 'utf8'));
		const artifact = await backupArtifact('/run/scoped-artifact.dump');
		for (const key of ['artifactSha256', 'artifactSize']) assert.equal(capture[key], artifact[key]);
		for (const key of ['databaseId', 'migrationManifestSha256']) assert.equal(capture[key], receipt[key]);
		const acquisition = {
			schemaVersion: 1, kind: 'winwidget.operations.backlog-backup-acquisition.v1',
			phaseAReceiptSha256: sha256(JSON.stringify(receipt)), databaseId: receipt.databaseId,
			operationsRuntimeRevision: receipt.operationsRuntimeRevision, migrationManifestSha256: receipt.migrationManifestSha256,
			sourceWorkerContainerId: receipt.sourceWorkerContainerId, sourceWorkerImageId: receipt.sourceWorkerImageId,
			executorContainerId: process.env.SCOPED_BACKUP_EXECUTOR_ID, executorImageId: process.env.SCOPED_BACKUP_EXECUTOR_IMAGE,
			backupRole: 'winwidget_operations_backup', startedAt: capture.startedAt, completedAt: capture.completedAt,
			...artifact, aclSha256: capture.aclSha256, pgDumpVersion: capture.pgDumpVersion
		};
		validateBackupAcquisition(acquisition, receipt);
		writeFileSync('/run/scoped/acquisition.json', JSON.stringify(acquisition), { mode: 0o600, flag: 'wx' });
	} else if (action === 'backup-verify') {
		const receipt = JSON.parse(readFileSync('/run/scoped/phase-a.json', 'utf8'));
		const bytes = readFileSync('/run/scoped/acquisition.json');
		const acquisition = JSON.parse(bytes);
		assert.equal(bytes.toString(), JSON.stringify(acquisition));
		validateBackupAcquisition(acquisition, receipt);
		const artifact = await backupArtifact('/run/scoped-artifact.dump');
		for (const key of ['artifactSha256', 'artifactSize']) assert.equal(acquisition[key], artifact[key]);
	} else if (action === 'prepare') {
		const input = {
			scope: process.env.SCOPED_SCOPE,
			revision: process.env.SCOPED_REVISION,
			previousRevision: process.env.SCOPED_PREVIOUS_REVISION,
			operationsPreviousRevision: process.env.SCOPED_OPERATIONS_PREVIOUS_REVISION,
			operationsApiPreviousRevision: process.env.SCOPED_OPERATIONS_API_PREVIOUS_REVISION,
			compose: JSON.parse(readFileSync('/run/scoped/compose.json', 'utf8')),
			live: JSON.parse(readFileSync('/run/scoped/live.json', 'utf8')),
			image: JSON.parse(readFileSync('/run/scoped/image.json', 'utf8'))[0],
			operationsImage: ['identity-with-operations-manifest', 'workers-bootstrap-recovery'].includes(process.env.SCOPED_SCOPE) ? JSON.parse(readFileSync('/run/scoped/operations-image.json', 'utf8'))[0] : undefined,
			supportImage: process.env.SCOPED_SCOPE === 'workers-bootstrap-recovery' ? JSON.parse(readFileSync('/run/scoped/support-image.json', 'utf8'))[0] : undefined
		};
		const result = prepareScopedCompose(input);
		for (const key of ['desired', 'rollback']) writeFileSync(`/run/scoped/${key}.json`, `${JSON.stringify(result[key])}\n`, { mode: 0o600, flag: 'wx' });
	} else if (action === 'identity-migration-inventory') {
		assert.equal(process.getuid(), 1001);
		assert.equal(process.getgid(), 1001);
		const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, target: 'identity', migrations: migrationFiles('/app/prisma/migrations') }));
		parseIdentityMigrationInventory(bytes);
		process.stdout.write(bytes);
	} else if (action === 'identity-manifest') {
		assert.equal(process.getuid(), 0);
		const inventoryPath = '/run/scoped/identity-migrations.json';
		const inventory = lstatSync(inventoryPath);
		assert.ok(inventory.isFile() && !inventory.isSymbolicLink() && inventory.nlink === 1);
		assert.equal(inventory.uid, 0);
		assert.equal(inventory.gid, 0);
		assert.equal(inventory.mode & 0o7777, 0o600);
		assert.ok(inventory.size > 0 && inventory.size <= 1024 * 1024);
		assertIdentityManifestCompanion(
			JSON.parse(readFileSync('/run/scoped/operations-manifest-before.json', 'utf8')),
			JSON.parse(readFileSync('/run/scoped/operations-manifest-after.json', 'utf8')),
			parseIdentityMigrationInventory(readFileSync(inventoryPath))
		);
	} else if (action === 'phase-a') {
		const receipt = {
			schemaVersion: 1,
			kind: 'winwidget.operations.backlog-phase-a.v1',
			databaseId: process.env.SCOPED_DATABASE_ID,
			operationsRuntimeRevision: process.env.SCOPED_REVISION,
			migrationManifestSha256: process.env.SCOPED_MIGRATION_MANIFEST_SHA256,
			notesMigrationChecksum: process.env.SCOPED_NOTES_CHECKSUM,
			operationsApplicationTree: process.env.SCOPED_APPLICATION_TREE,
			infraRevision: process.env.SCOPED_INFRA_REVISION,
			fencedAt: new Date().toISOString(),
			notesWriteFenceApplied: true
		};
		receipt.sourceWorkerContainerId = process.env.SCOPED_SOURCE_WORKER_ID;
		receipt.sourceWorkerImageId = process.env.SCOPED_SOURCE_WORKER_IMAGE;
		validatePhaseA(receipt);
		assert.match(receipt.databaseId ?? '', /^[a-f0-9-]{36}$/);
		for (const key of ['operationsRuntimeRevision', 'operationsApplicationTree', 'infraRevision']) assert.match(receipt[key] ?? '', /^[a-f0-9]{40}$/);
		assert.match(receipt.migrationManifestSha256 ?? '', /^[a-f0-9]{64}$/);
		assert.match(receipt.notesMigrationChecksum ?? '', /^[a-f0-9]{64}$/);
		writeFileSync('/run/scoped/phase-a.json', JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });
	} else if (action === 'evidence') {
		const receipt = JSON.parse(readFileSync('/run/scoped/phase-a.json', 'utf8'));
		validateRestoreEvidence(JSON.parse(readFileSync('/run/scoped/restore-evidence.json', 'utf8')), receipt, JSON.parse(readFileSync('/run/scoped/acquisition.json', 'utf8')));
		assert.equal(receipt.operationsRuntimeRevision, process.env.SCOPED_REVISION);
		assert.equal(receipt.operationsApplicationTree, process.env.SCOPED_APPLICATION_TREE);
		assert.equal(receipt.databaseId, process.env.SCOPED_DATABASE_ID);
		assert.equal(receipt.migrationManifestSha256, process.env.SCOPED_MIGRATION_MANIFEST_SHA256);
		assert.equal(receipt.notesMigrationChecksum, process.env.SCOPED_NOTES_CHECKSUM);
	} else if (action === 'finalized') {
		const receipt = JSON.parse(readFileSync('/run/scoped/phase-a.json', 'utf8'));
		const evidence = JSON.parse(readFileSync('/run/scoped/restore-evidence.json', 'utf8'));
		validateRestoreEvidence(evidence, receipt, JSON.parse(readFileSync('/run/scoped/acquisition.json', 'utf8')));
		const result = {
			schemaVersion: 1, kind: 'winwidget.operations.backlog-finalized.v1',
			databaseId: receipt.databaseId,
			operationsRuntimeRevision: receipt.operationsRuntimeRevision,
			phaseAReceiptSha256: sha256(JSON.stringify(receipt)),
			restoreEvidenceSha256: sha256(readFileSync('/run/scoped/restore-evidence.json')),
			migrationChecksum: process.env.SCOPED_NOTES_CHECKSUM,
			finalizedAt: new Date().toISOString()
		};
		assert.match(result.migrationChecksum ?? '', /^[a-f0-9]{64}$/);
		writeFileSync('/run/scoped/finalized.json', JSON.stringify(result), { mode: 0o600, flag: 'wx' });
	} else if (action === 'broker-quiet') assertBrokerQuiet(JSON.parse(readFileSync(0, 'utf8')));
	else if (action === 'database') await databaseAction(process.argv[3], process.argv[4]);
	else throw new Error('Unsupported verifier action');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch(() => { process.stderr.write('Scoped release verification failed.\n'); process.exitCode = 1; });
}
