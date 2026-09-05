import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NOTES_MIGRATION = '20260910110000_remove_admin_backlog';
export const OTP_MIGRATION = '20260910010000_add_login_otp';
export const SCOPED_SERVICES = Object.freeze({
	'identity-with-operations-manifest': ['identity-api', 'identity-worker', 'identity-outbox-publisher', 'operations-api', 'operations-worker', 'operations-outbox-publisher', 'operations-restore-worker'],
	'operations-runtime': ['operations-api', 'operations-worker', 'operations-outbox-publisher', 'operations-restore-worker'],
	'operations-backlog-finalize': [],
	'gateway-remove-notes': ['api-gateway']
});
export const sha256 = value => createHash('sha256').update(value).digest('hex');
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
	assert.equal(removed[0].prefix, '/api/v1/notes');
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

export function prepareScopedCompose({ scope, revision, previousRevision, operationsPreviousRevision, compose, live, image, operationsImage }) {
	assert.ok(Object.hasOwn(SCOPED_SERVICES, scope));
	assert.match(revision, /^[a-f0-9]{40}$/);
	assert.match(previousRevision, /^[a-f0-9]{40}$/);
	const targets = SCOPED_SERVICES[scope];
	assert.ok(targets.length > 0);
	assert.equal(live.length, targets.length);
	const desired = { name: 'winwidget', services: {}, volumes: {}, secrets: {} };
	const rollback = structuredClone(desired);
	for (const name of targets) {
		const companion = scope === 'identity-with-operations-manifest' && name.startsWith('operations-');
		const expectedPreviousRevision = companion ? operationsPreviousRevision : previousRevision;
		const expectedImage = companion ? operationsImage : image;
		assert.match(expectedPreviousRevision ?? '', /^[a-f0-9]{40}$/);
		assert.ok(expectedImage);
		const current = live.filter(container => container.Config.Labels['com.docker.compose.service'] === name);
		assert.equal(current.length, 1);
		const container = current[0];
		assert.equal(container.Config.Labels['com.docker.compose.project'], 'winwidget');
		assert.equal(container.Config.Labels['org.opencontainers.image.revision'], expectedPreviousRevision);
		assert.equal(container.State.Status, 'running');
		assert.equal(container.State.Health?.Status, 'healthy');
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
			} else if (key === 'APP_REVISION' && scope !== 'gateway-remove-notes') {
				assert.equal(value, revision);
			} else if (scope === 'identity-with-operations-manifest' && name === 'identity-api' && key === 'IDENTITY_LOGIN_OTP_ENABLED') {
				assert.ok(['false', 'true'].includes(value));
			} else {
				assert.equal(value, before[key]);
			}
		}
		if (scope === 'gateway-remove-notes') {
			assert.equal(image.Id, container.Image);
			assert.equal(after.APP_REVISION, previousRevision);
		} else assert.equal(expectedImage.Config.Labels['org.opencontainers.image.revision'], revision);
		if (companion && ['operations-api', 'operations-restore-worker'].includes(name)) {
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

export function validateRestoreEvidence(evidence, receipt) {
	assert.equal(evidence.schemaVersion, 1);
	assert.equal(evidence.kind, 'winwidget.operations.backlog-backup-restore.v1');
	assert.equal(receipt.schemaVersion, 1);
	assert.equal(receipt.kind, 'winwidget.operations.backlog-phase-a.v1');
	assert.equal(receipt.notesWriteFenceApplied, true);
	assert.match(receipt.notesMigrationChecksum ?? '', /^[a-f0-9]{64}$/);
	assert.equal(evidence.phaseAReceiptSha256, sha256(JSON.stringify(receipt)));
	for (const key of ['databaseId', 'operationsRuntimeRevision', 'migrationManifestSha256']) assert.equal(evidence[key], receipt[key]);
	assert.match(evidence.artifactSha256, /^[a-f0-9]{64}$/);
	assert.match(evidence.restoreImageId, /^sha256:[a-f0-9]{64}$/);
	assert.equal(evidence.postgresMajor, 18);
	assert.equal(evidence.restoreExitCode, 0);
	assert.equal(evidence.restoredSchema, 'operations');
	assert.equal(evidence.notesTablePresent, true);
	assert.equal(evidence.restoredNotesWriteFence, true);
	assert.equal(evidence.unrelatedAuditRoundTripEqual, true);
	assert.ok(Number.isSafeInteger(evidence.notesRows) && evidence.notesRows >= 0);
	assert.ok(Number.isSafeInteger(evidence.backlogAuditRows) && evidence.backlogAuditRows >= 0);
	assert.ok(Date.parse(evidence.restoredAt) >= Date.parse(receipt.fencedAt));
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
	assert.ok(['identity', 'operations'].includes(owner));
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
	assert.ok(['identity', 'operations'].includes(owner));
	const require = createRequire('/app/package.json');
	const { PrismaClient } = require(`@prisma/${owner}-client`);
	// The all-services admission needs metadata the runtime must not own. Use
	// the existing migration credential, read-only here; never widen runtime ACL.
	if (action === 'all-guard') assert.ok(process.env.OPERATIONS_MIGRATION_DATABASE_URL);
	const client = new PrismaClient(action === 'all-guard'
		? { datasources: { db: { url: process.env.OPERATIONS_MIGRATION_DATABASE_URL } } }
		: undefined);
	try { await verifyDatabaseState(client, migrationFiles('/app/prisma/migrations'), action, owner); }
	finally { await client.$disconnect(); }
}

async function main() {
	const action = process.argv[2];
	if (action === 'prepare') {
		const input = {
			scope: process.env.SCOPED_SCOPE,
			revision: process.env.SCOPED_REVISION,
			previousRevision: process.env.SCOPED_PREVIOUS_REVISION,
			operationsPreviousRevision: process.env.SCOPED_OPERATIONS_PREVIOUS_REVISION,
			compose: JSON.parse(readFileSync('/run/scoped/compose.json', 'utf8')),
			live: JSON.parse(readFileSync('/run/scoped/live.json', 'utf8')),
			image: JSON.parse(readFileSync('/run/scoped/image.json', 'utf8'))[0],
			operationsImage: process.env.SCOPED_SCOPE === 'identity-with-operations-manifest' ? JSON.parse(readFileSync('/run/scoped/operations-image.json', 'utf8'))[0] : undefined
		};
		const result = prepareScopedCompose(input);
		for (const key of ['desired', 'rollback']) writeFileSync(`/run/scoped/${key}.json`, `${JSON.stringify(result[key])}\n`, { mode: 0o600, flag: 'wx' });
	} else if (action === 'identity-manifest') {
		assertIdentityManifestCompanion(
			JSON.parse(readFileSync('/run/scoped/operations-manifest-before.json', 'utf8')),
			JSON.parse(readFileSync('/run/scoped/operations-manifest-after.json', 'utf8')),
			migrationFiles('/app/prisma/migrations')
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
		assert.match(receipt.databaseId ?? '', /^[a-f0-9-]{36}$/);
		for (const key of ['operationsRuntimeRevision', 'operationsApplicationTree', 'infraRevision']) assert.match(receipt[key] ?? '', /^[a-f0-9]{40}$/);
		assert.match(receipt.migrationManifestSha256 ?? '', /^[a-f0-9]{64}$/);
		assert.match(receipt.notesMigrationChecksum ?? '', /^[a-f0-9]{64}$/);
		writeFileSync('/run/scoped/phase-a.json', JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });
	} else if (action === 'evidence') {
		const receipt = JSON.parse(readFileSync('/run/scoped/phase-a.json', 'utf8'));
		validateRestoreEvidence(JSON.parse(readFileSync('/run/scoped/restore-evidence.json', 'utf8')), receipt);
		assert.equal(receipt.operationsRuntimeRevision, process.env.SCOPED_REVISION);
		assert.equal(receipt.operationsApplicationTree, process.env.SCOPED_APPLICATION_TREE);
		assert.equal(receipt.databaseId, process.env.SCOPED_DATABASE_ID);
		assert.equal(receipt.migrationManifestSha256, process.env.SCOPED_MIGRATION_MANIFEST_SHA256);
		assert.equal(receipt.notesMigrationChecksum, process.env.SCOPED_NOTES_CHECKSUM);
	} else if (action === 'finalized') {
		const receipt = JSON.parse(readFileSync('/run/scoped/phase-a.json', 'utf8'));
		const evidence = JSON.parse(readFileSync('/run/scoped/restore-evidence.json', 'utf8'));
		validateRestoreEvidence(evidence, receipt);
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
	} else if (action === 'database') await databaseAction(process.argv[3], process.argv[4]);
	else throw new Error('Unsupported verifier action');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch(() => { process.stderr.write('Scoped release verification failed.\n'); process.exitCode = 1; });
}
