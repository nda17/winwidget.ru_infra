// Local-only proof producer. It never connects to production or uses Operations
// self-restore. A copied, hash-approved safety backup is restored into a newly
// created network-isolated PostgreSQL 18 container, then the exact Notes DDL is
// rehearsed. No dump, customer row, password or connection URL is logged.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256, validateRestoreEvidence, validateBackupAcquisition, validateBackupMetadata, OPERATIONS_BACKUP_METADATA_SQL, backupArtifact } from './scoped-service-release.mjs';

const flags = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
	const key = process.argv[index];
	assert.ok(['--artifact', '--artifact-sha256', '--acquisition', '--acquisition-sha256', '--phase-a', '--migration', '--image', '--output'].includes(key));
	assert.ok(!flags.has(key) && process.argv[index + 1]);
	flags.set(key, process.argv[index + 1]);
}
assert.equal(flags.size, 8);
const regular = filename => {
	assert.ok(isAbsolute(filename) && realpathSync(filename) === filename);
	const metadata = lstatSync(filename);
	assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1);
	assert.ok(metadata.size > 0 && metadata.size <= 1024 ** 3);
	return filename;
};
const artifact = regular(flags.get('--artifact'));
const phaseAPath = regular(flags.get('--phase-a'));
const migration = regular(flags.get('--migration'));
const artifactSha256 = flags.get('--artifact-sha256');
assert.match(artifactSha256, /^[a-f0-9]{64}$/);
const artifactMetadata = await backupArtifact(artifact);
assert.equal(artifactMetadata.artifactSha256, artifactSha256);
const receipt = JSON.parse(readFileSync(phaseAPath, 'utf8'));
assert.equal(receipt.schemaVersion, 1);
assert.equal(receipt.kind, 'winwidget.operations.backlog-phase-a.v1');
assert.equal(receipt.notesWriteFenceApplied, true);
const acquisitionPath = regular(flags.get('--acquisition'));
assert.ok(lstatSync(acquisitionPath).size <= 65536);
const acquisitionBytes = readFileSync(acquisitionPath);
assert.match(flags.get('--acquisition-sha256'), /^[a-f0-9]{64}$/);
assert.equal(sha256(acquisitionBytes), flags.get('--acquisition-sha256'));
const acquisition = JSON.parse(acquisitionBytes);
assert.equal(acquisitionBytes.toString(), JSON.stringify(acquisition));
validateBackupAcquisition(acquisition, receipt);
assert.equal(acquisition.artifactSha256, artifactSha256);
assert.equal(acquisition.artifactSize, artifactMetadata.artifactSize);
assert.equal(sha256(readFileSync(migration)), receipt.notesMigrationChecksum);
const image = flags.get('--image');
assert.match(image, /^sha256:[a-f0-9]{64}$/);
const output = flags.get('--output');
assert.ok(isAbsolute(output));
assert.equal(realpathSync(dirname(output)), dirname(output));
const owner = `winwidget-operations-backlog-proof-${randomUUID()}`;
let container;
let evidence;
const localDockerEnv = { ...process.env, DOCKER_HOST: undefined, DOCKER_CONTEXT: undefined, DOCKER_TLS_VERIFY: undefined, DOCKER_CERT_PATH: undefined };
const docker = (args, input, timeout = 120000) => {
	const result = spawnSync('docker', args, { input, env: localDockerEnv, encoding: input instanceof Uint8Array ? null : 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
	assert.equal(result.status, 0, 'Isolated Docker/PostgreSQL proof command failed; no private diagnostic output is exposed');
	return result.stdout?.toString() ?? '';
};
const sql = (query, database = 'winwidget_operations') => docker(['exec', '-i', container, 'psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--tuples-only', '--no-align', '--username', 'operations_rehearsal', '--dbname', database], query).trim();
const restore = database => docker(['exec', '-i', container, 'pg_restore', '--exit-on-error', '--single-transaction', '--username', 'operations_rehearsal', '--dbname', database], readFileSync(artifact));
const snapshot = database => ({ ...JSON.parse(sql(OPERATIONS_BACKUP_METADATA_SQL, database)), ...JSON.parse(sql(`
SELECT json_build_object(
  'databaseId', (SELECT database_id::text FROM operations.service_identity WHERE id = 'singleton' AND service_name = 'operations-service'),
  'identityRows', (SELECT count(*) FROM operations.service_identity),
  'notesRows', (SELECT count(*) FROM operations.notes),
  'backlogAuditRows', (SELECT count(*) FROM operations.admin_event_logs WHERE section = 'BACKLOG' OR entity_type = 'backlog_task' OR action IN ('BACKLOG_TASK_CREATE','BACKLOG_TASK_UPDATE','BACKLOG_TASK_DELETE')),
  'unrelatedAuditHash', (SELECT md5(COALESCE(string_agg(row_to_json(record)::text, '' ORDER BY id), '')) FROM operations.admin_event_logs record WHERE NOT (COALESCE(section = 'BACKLOG',false) OR COALESCE(entity_type = 'backlog_task',false) OR action IN ('BACKLOG_TASK_CREATE','BACKLOG_TASK_UPDATE','BACKLOG_TASK_DELETE'))),
  'runtimeCanWriteNotes', has_table_privilege('winwidget_operations_runtime', 'operations.notes', 'INSERT,UPDATE,DELETE,TRUNCATE') OR has_any_column_privilege('winwidget_operations_runtime', 'operations.notes', 'INSERT,UPDATE'),
  'migrations', (SELECT json_agg(json_build_object('name',migration_name,'checksum',checksum) ORDER BY migration_name) FROM operations._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
  'migrationRows', (SELECT count(*) FROM operations._prisma_migrations)
);`, database)) });

try {
	const context = docker(['context', 'show']).trim();
	assert.ok(context && !/production|remote/i.test(context));
	const contextInfo = JSON.parse(docker(['context', 'inspect', context]));
	assert.match(contextInfo[0]?.Endpoints?.docker?.Host ?? '', /^unix:\//);
	assert.equal(docker(['image', 'inspect', '--format', '{{.Id}}', image]).trim(), image);
	assert.match(docker(['run', '--rm', '--network', 'none', '--entrypoint', 'postgres', image, '--version']), /^postgres \(PostgreSQL\) 18\./);
	container = docker(['create', '--name', owner, '--network', 'none', '--label', `winwidget.operations-backlog-proof=${owner}`,
		'--memory', '768m', '--cpus', '1', '--pids-limit', '128', '--tmpfs', '/var/lib/postgresql:rw,size=1g',
		'--env', 'POSTGRES_USER=operations_rehearsal', '--env', 'POSTGRES_DB=winwidget_operations', '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', image]).trim();
	assert.match(container, /^[a-f0-9]{64}$/);
	docker(['start', container]);
	let ready = false;
	for (let attempt = 0; attempt < 60; attempt++) {
		const result = spawnSync('docker', ['exec', container, 'pg_isready', '--username', 'operations_rehearsal', '--dbname', 'winwidget_operations'], { env: localDockerEnv, encoding: 'utf8', timeout: 5000 });
		if (result.status === 0) { ready = true; break; }
		await new Promise(resolve => setTimeout(resolve, 500));
	}
	assert.equal(ready, true);
	sql(`CREATE ROLE winwidget_operations_admin NOLOGIN; CREATE ROLE winwidget_operations_migration NOLOGIN; CREATE ROLE winwidget_operations_runtime NOLOGIN; CREATE ROLE winwidget_operations_backup NOLOGIN; CREATE ROLE winwidget_operations_maintenance NOLOGIN;`);
	restore('winwidget_operations');
	const before = snapshot('winwidget_operations');
	validateBackupMetadata(before, receipt);
	assert.equal(sha256(JSON.stringify(before.acl)), acquisition.aclSha256);
	assert.equal(before.identityRows, 1);
	assert.equal(before.databaseId, receipt.databaseId);
	assert.equal(before.runtimeCanWriteNotes, false);
	assert.equal(before.migrationRows, before.migrations.length);
	assert.equal(sha256(JSON.stringify({ schemaVersion: 1, target: 'operations', migrations: before.migrations })), receipt.migrationManifestSha256);
	assert.equal(before.migrations.some(entry => entry.name === '20260910110000_remove_admin_backlog'), false);
	sql(readFileSync(migration, 'utf8'));
	const after = JSON.parse(sql(`SELECT json_build_object('notesAbsent', to_regclass('operations.notes') IS NULL, 'backlogRows', (SELECT count(*) FROM operations.admin_event_logs WHERE section='BACKLOG' OR entity_type='backlog_task' OR action IN ('BACKLOG_TASK_CREATE','BACKLOG_TASK_UPDATE','BACKLOG_TASK_DELETE')), 'auditHash', (SELECT md5(COALESCE(string_agg(row_to_json(record)::text, '' ORDER BY id), '')) FROM operations.admin_event_logs record));`));
	assert.equal(after.notesAbsent, true);
	assert.equal(after.backlogRows, 0);
	assert.equal(after.auditHash, before.unrelatedAuditHash);
	sql('CREATE DATABASE operations_backup_roundtrip');
	restore('operations_backup_roundtrip');
	const roundtrip = snapshot('operations_backup_roundtrip');
	assert.equal(roundtrip.database, 'operations_backup_roundtrip');
	assert.deepEqual({ ...roundtrip, database: before.database }, before);
	assert.deepEqual(await backupArtifact(artifact), artifactMetadata);
	evidence = {
		schemaVersion: 1, kind: 'winwidget.operations.backlog-backup-restore.v1',
		phaseAReceiptSha256: sha256(JSON.stringify(receipt)),
		databaseId: receipt.databaseId,
		operationsRuntimeRevision: receipt.operationsRuntimeRevision,
		migrationManifestSha256: receipt.migrationManifestSha256,
		artifactSha256, artifactSize: artifactMetadata.artifactSize, acquisitionReceiptSha256: sha256(acquisitionBytes),
		restoredAclSha256: sha256(JSON.stringify(before.acl)), restoreImageId: image, postgresMajor: 18, restoreExitCode: 0,
		restoredSchema: 'operations', notesTablePresent: true, restoredNotesWriteFence: true,
		unrelatedAuditRoundTripEqual: true, notesRows: before.notesRows,
		backlogAuditRows: before.backlogAuditRows, restoredAt: new Date().toISOString()
	};
	validateRestoreEvidence(evidence, receipt, acquisition);
} finally {
	if (container) {
		const label = docker(['inspect', '--format', '{{index .Config.Labels "winwidget.operations-backlog-proof"}}', container]).trim();
		assert.equal(label, owner);
		docker(['rm', '--force', '--volumes', container]);
	}
}
assert.ok(evidence);
writeFileSync(output, `${JSON.stringify(evidence)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
process.stdout.write(`Operations isolated restore and exact Notes deletion proof passed; evidenceSha256=${sha256(readFileSync(output))}\n`);
