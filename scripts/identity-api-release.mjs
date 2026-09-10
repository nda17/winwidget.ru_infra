import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OTP_MIGRATION, prepareScopedCompose, sha256, migrationFiles } from './scoped-service-release.mjs';

const same = (left, right) => assert.deepEqual(left, right);
const envObject = rows => Object.fromEntries((rows ?? []).map(row => { const separator = row.indexOf('='); assert.ok(separator > 0); return [row.slice(0, separator), row.slice(separator + 1)]; }));
const orderedMountInventory = mounts => { assert.ok(Array.isArray(mounts)); return mounts.map(mount => Object.fromEntries(Object.entries(mount).sort(([a], [b]) => a.localeCompare(b)))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))); };
export const IDENTITY_SMS_SOURCE = Object.freeze({ before: '46cf5d21383b7ca7cc5afd0736f25cf30c3105e46cb5d4930b38dd1cb4380c79', after: '568ea3f19344446a3ee6abde9c678a3c9c7d44a273d52196832bf2dbe0fa81b3' });
const IDENTITY_SMS_COMPILED = 'src/transports/verification-transport.service.js';
export function assertIdentitySmsSource(before, after) {
	assert.equal(sha256(before), IDENTITY_SMS_SOURCE.before); assert.equal(sha256(after), IDENTITY_SMS_SOURCE.after);
}
export function assertIdentitySmsCompiled(before, after) {
	assert.ok(typeof before === 'string' && before.length > 0 && before.length < 131072);
	let expected = before;
	for (const [previous, next] of [['`Ваш код подтверждения: ${code}`', '`Ваш код подтверждения в WinWidget: ${code}`'], ['`Ваш новый пароль: ${password}`', '`Ваш новый пароль в WinWidget: ${password}`']]) {
		assert.equal(expected.split(previous).length, 2); assert.equal(expected.includes(next), false); expected = expected.replace(previous, next);
	}
	assert.equal(after, expected);
}
export function validateIdentityApiInventory(value) {
	same(Object.keys(value).sort(), ['schemaVersion', 'kind', 'compiled', 'transportText', 'migrations', 'schemaSha256', 'generatedSchemaSha256', 'packages', 'packageSha256', 'assets'].sort());
	assert.equal(value.schemaVersion, 1); assert.equal(value.kind, 'winwidget.identity.sms-image.v1');
	for (const key of ['schemaSha256', 'generatedSchemaSha256', 'packageSha256']) assert.match(value[key], /^[a-f0-9]{64}$/);
	assert.equal(value.schemaSha256, value.generatedSchemaSha256);
	for (const key of ['compiled', 'assets']) {
		assert.ok(Array.isArray(value[key]) && value[key].length > 0 && value[key].length < 2000);
		same(value[key].map(row => row.path), [...new Set(value[key].map(row => row.path))].sort());
		for (const row of value[key]) { same(Object.keys(row).sort(), ['path', 'sha256']); assert.match(row.path, /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/); assert.ok(!row.path.includes('..')); assert.match(row.sha256, /^[a-f0-9]{64}$/); }
	}
	assert.ok(value.compiled.length >= 30);
	assert.equal(value.compiled.filter(row => row.path === IDENTITY_SMS_COMPILED).length, 1);
	assert.equal(value.compiled.find(row => row.path === IDENTITY_SMS_COMPILED).sha256, sha256(value.transportText));
	assert.equal(value.compiled.some(row => row.path === `${IDENTITY_SMS_COMPILED}.map`), false);
	assert.ok(Array.isArray(value.migrations) && value.migrations.length > 0);
	same(value.migrations.map(row => row.name), [...new Set(value.migrations.map(row => row.name))].sort());
	for (const row of value.migrations) { same(Object.keys(row).sort(), ['checksum', 'name']); assert.match(row.name, /^\d{14}_[a-z0-9_]+$/); assert.match(row.checksum, /^[a-f0-9]{64}$/); }
	assert.ok(value.migrations.some(row => row.name === OTP_MIGRATION));
	assert.ok(Array.isArray(value.packages) && value.packages.length > 30 && value.packages.length < 2000);
	same(value.packages, [...new Set(value.packages)].sort());
	for (const name of value.packages) assert.match(name, /^[a-zA-Z0-9@+_.()-]+$/);
	return value;
}
export function assertIdentityApiImages(before, after) {
	validateIdentityApiInventory(before); validateIdentityApiInventory(after);
	assertIdentitySmsCompiled(before.transportText, after.transportText);
	for (const key of ['migrations', 'schemaSha256', 'generatedSchemaSha256', 'packages', 'packageSha256', 'assets']) same(before[key], after[key]);
	same(before.compiled.filter(row => row.path !== IDENTITY_SMS_COMPILED), after.compiled.filter(row => row.path !== IDENTITY_SMS_COMPILED));
}
export function assertIdentityApiRuntime({ snapshot, live, image, revision }) {
	assert.match(revision, /^[a-f0-9]{40}$/); same(Object.keys(snapshot.services), ['identity-api']); assert.equal(live.length, 1);
	const current = live[0], service = snapshot.services['identity-api'];
	assert.equal(current.Image, image.Id); assert.equal(service.image, image.Id);
	assert.equal(current.Config.Labels['org.opencontainers.image.revision'], revision);
	assert.equal(current.RestartCount, 0); assert.equal(current.State.OOMKilled, false);
	const env = envObject(current.Config.Env); assert.equal(env.APP_REVISION, revision); assert.equal(env.IDENTITY_PROCESS_ROLE, 'api');
	same(env, { ...envObject(image.Config.Env), ...service.environment });
	prepareScopedCompose({ scope: 'identity-api-runtime', revision, previousRevision: revision, compose: snapshot, live, image });
}
function identityApiImageInventory() {
	assert.equal(process.getuid(), 1001); assert.equal(process.getgid(), 1001);
	const inventory = root => {
		const rows = [];
		const visit = directory => {
			assert.equal(realpathSync(directory), directory);
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				assert.ok(!entry.isSymbolicLink()); const path = join(directory, entry.name);
				if (entry.isDirectory()) visit(path);
				else { assert.ok(entry.isFile()); const name = path.slice(root.length + 1); if (name !== `${IDENTITY_SMS_COMPILED}.map`) rows.push({ path: name, sha256: sha256(readFileSync(path)) }); }
			}
		};
		visit(root); return rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	};
	const require = createRequire('/app/package.json');
	const value = { schemaVersion: 1, kind: 'winwidget.identity.sms-image.v1', compiled: inventory('/app/dist'), assets: inventory('/app/assets'),
		transportText: readFileSync(`/app/dist/${IDENTITY_SMS_COMPILED}`, 'utf8'), migrations: migrationFiles('/app/prisma/migrations'),
		schemaSha256: sha256(readFileSync('/app/prisma/schema.prisma')), generatedSchemaSha256: sha256(readFileSync(require.resolve('@prisma/identity-client/schema.prisma'))),
		packageSha256: sha256(readFileSync('/app/package.json')), packages: readdirSync('/app/node_modules/.pnpm', { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== 'node_modules').map(entry => entry.name).sort() };
	validateIdentityApiInventory(value); process.stdout.write(JSON.stringify(value));
}
export function identityApiNeighborFingerprint(live) {
	assert.ok(Array.isArray(live) && live.length >= 3 && live.length <= 200);
	assert.equal(new Set(live.map(item => item.Id)).size, live.length);
	const identity = name => live.filter(item => item.Config.Labels['com.docker.compose.project'] === 'winwidget' && item.Config.Labels['com.docker.compose.service'] === name);
	assert.equal(identity('identity-api').length, 1);
	for (const name of ['identity-worker', 'identity-outbox-publisher']) assert.equal(identity(name).length, 1);
	for (const item of live) {
		assert.match(item.Id, /^[a-f0-9]{64}$/); assert.match(item.Image, /^sha256:[a-f0-9]{64}$/);
		if (item === identity('identity-api')[0]) continue;
		assert.equal(item.State.Status, 'running'); assert.equal(item.State.Running, true); assert.equal(item.State.Paused, false);
		assert.equal(item.State.Restarting, false); assert.equal(item.State.OOMKilled, false);
		if (item.Config.Healthcheck) assert.equal(item.State.Health?.Status, 'healthy');
	}
	return sha256(JSON.stringify(live.filter(item => item !== identity('identity-api')[0]).map(item => ({ id: item.Id, image: item.Image, config: item.Config, host: item.HostConfig,
		mounts: orderedMountInventory(item.Mounts), startedAt: item.State.StartedAt, running: item.State.Running, status: item.State.Status, health: item.State.Health?.Status,
		restartCount: item.RestartCount })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
}
export async function verifyIdentityApiHttp(revision, fetcher = fetch) {
	assert.match(revision, /^[a-f0-9]{40}$/);
	for (const name of ['live', 'ready', 'revision']) {
		const response = await fetcher(`http://127.0.0.1:4900/health/${name}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000) });
		assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
		const value = await response.json(); assert.equal(value.service, 'identity'); assert.equal(value.revision, revision);
		if (name !== 'revision') { assert.equal(value.role, 'api'); assert.equal(value.status, name === 'ready' ? 'ready' : 'ok'); }
	}
}
export const IDENTITY_API_PAYLOAD_FILES = Object.freeze(['scoped-service-release.mjs', 'identity-api-release.mjs']);
export function validateIdentityApiPayload(bytes) {
	assert.ok(Buffer.byteLength(bytes) > 0 && Buffer.byteLength(bytes) <= 262144);
	const value = JSON.parse(bytes);
	const exact = (item, keys) => { assert.ok(item && typeof item === 'object' && !Array.isArray(item)); assert.deepEqual(Object.keys(item).sort(), keys.sort()); };
	exact(value, ['schemaVersion', 'files']); assert.equal(value.schemaVersion, 1); assert.ok(Array.isArray(value.files));
	assert.deepEqual(value.files.map(file => file.name).sort(), [...IDENTITY_API_PAYLOAD_FILES].sort());
	for (const file of value.files) {
		exact(file, ['name', 'sha256', 'content']); assert.equal(typeof file.content, 'string');
		assert.ok(Buffer.byteLength(file.content) > 0 && Buffer.byteLength(file.content) <= (file.name === 'scoped-service-release.mjs' ? 147456 : 32768));
		assert.equal(sha256(file.content), file.sha256);
	}
	return value.files;
}
function rootFileBytes(filename, maximum = 1048576) {
	const metadata = lstatSync(filename);
	assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 && metadata.uid === 0 && metadata.gid === 0 && (metadata.mode & 0o7777) === 0o600 && metadata.size > 0 && metadata.size <= maximum);
	assert.equal(realpathSync(filename), filename);
	return readFileSync(filename);
}
async function main() {
	const action = process.argv[2];
	if (action === 'pack') {
		const files = IDENTITY_API_PAYLOAD_FILES.map(name => {
			const path = new URL('./' + name, import.meta.url); const stat = lstatSync(path); assert.ok(stat.isFile() && !stat.isSymbolicLink());
			const content = readFileSync(path, 'utf8'); return { name, content, sha256: sha256(content) };
		});
		const bytes = JSON.stringify({ schemaVersion: 1, files }); validateIdentityApiPayload(bytes); process.stdout.write(bytes); return;
	}
	assert.equal(process.env.SCOPED_SCOPE, 'identity-api-runtime');
	if (action === 'identity-api-image') identityApiImageInventory();
	else if (action === 'identity-api-http') await verifyIdentityApiHttp(process.argv[3]);
	else if (action === 'identity-api-neighbors') process.stdout.write(identityApiNeighborFingerprint(JSON.parse(rootFileBytes('/run/scoped/identity-neighbors.json', 8 * 1024 * 1024))));
	else if (action === 'identity-api-source') assertIdentitySmsSource(rootFileBytes('/run/scoped/identity-source-before.ts'), rootFileBytes('/run/scoped/identity-source-after.ts'));
	else if (action === 'identity-api-images') assertIdentityApiImages(JSON.parse(rootFileBytes('/run/scoped/identity-image-before.json')), JSON.parse(rootFileBytes('/run/scoped/identity-image-after.json')));
	else if (action === 'identity-api-runtime') {
		const rollback = process.argv[3] === 'rollback'; assert.ok(['desired', 'rollback'].includes(process.argv[3]));
		assertIdentityApiRuntime({ snapshot: JSON.parse(rootFileBytes(`/run/scoped/${process.argv[3]}.json`)), live: JSON.parse(rootFileBytes('/run/scoped/identity-current.json')),
			image: JSON.parse(rootFileBytes(`/run/scoped/${rollback ? 'identity-previous-image' : 'image'}.json`))[0], revision: rollback ? process.env.SCOPED_PREVIOUS_REVISION : process.env.SCOPED_REVISION });
	}
	else if (action === 'prepare') {
		const result = prepareScopedCompose({ scope: process.env.SCOPED_SCOPE, revision: process.env.SCOPED_REVISION, previousRevision: process.env.SCOPED_PREVIOUS_REVISION,
			compose: JSON.parse(rootFileBytes('/run/scoped/compose.json', 4 * 1024 * 1024)), live: JSON.parse(rootFileBytes('/run/scoped/live.json', 4 * 1024 * 1024)), image: JSON.parse(rootFileBytes('/run/scoped/image.json'))[0] });
		for (const key of ['desired', 'rollback']) writeFileSync('/run/scoped/' + key + '.json', JSON.stringify(result[key]) + '\n', { mode: 0o600, flag: 'wx' });
	} else throw new Error('Unsupported Identity verifier action');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(() => { process.stderr.write('Identity release verification failed.\n'); process.exitCode = 1; });
