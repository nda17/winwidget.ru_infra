import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prepareScopedCompose, sha256 } from './scoped-service-release.mjs';

export const GATEWAY_TILDA_SOURCE = Object.freeze([
	'b484e8e2b2dbf57cba786ebd2f92e9aa3fbda79474687ce05d3849c238119261',
	'7a0d31c86b275509a6f8405fd31d58508c746e190bb335117c6a763d971aa316'
]);
export const GATEWAY_TILDA_CRM_ROLES = Object.freeze([
	'crm-access-api', 'crm-access-worker', 'crm-access-outbox-publisher',
	'crm-customers-api', 'crm-sales-api', 'crm-sales-reminders', 'crm-intake-api',
	'crm-intake-worker', 'crm-intake-publisher', 'crm-intake-widget-control-worker',
	'crm-intake-widget-control-publisher', 'crm-intake-widget-transfer-worker',
	'crm-intake-widget-transfer-publisher', 'crm-intake-sla-worker', 'crm-intake-sla-publisher',
	'crm-access-postgres', 'crm-customers-postgres', 'crm-sales-postgres', 'crm-intake-postgres'
]);
export function gatewayTildaNeighborFingerprint(live) {
	assert.ok(Array.isArray(live) && live.length > 20 && live.length <= 200);
	assert.equal(new Set(live.map(item => item.Id)).size, live.length);
	const key = item => `${item.Config?.Labels?.['com.docker.compose.project']}/${item.Config?.Labels?.['com.docker.compose.service']}`;
	assert.equal(live.filter(item => key(item) === 'winwidget/api-gateway').length, 1);
	assert.deepEqual(live.filter(item => key(item).startsWith('winwidget-crm/')).map(item => item.Config.Labels['com.docker.compose.service']).sort(), [...GATEWAY_TILDA_CRM_ROLES].sort());
	for (const name of ['identity-api', 'billing-api', 'billing-worker', 'billing-outbox-publisher', 'billing-scheduler', 'notification-delivery-worker'])
		assert.equal(live.filter(item => key(item) === `winwidget/${name}`).length, 1);
	const peers = live.filter(item => key(item) !== 'winwidget/api-gateway');
	for (const item of peers) {
		assert.match(item.Id, /^[a-f0-9]{64}$/); assert.match(item.Image, /^sha256:[a-f0-9]{64}$/);
		if (['winwidget', 'winwidget-crm'].includes(item.Config.Labels?.['com.docker.compose.project'])) {
			assert.equal(item.State.Running, true); assert.equal(item.State.Status, 'running'); assert.equal(item.State.Health?.Status, 'healthy');
		}
	}
	return sha256(JSON.stringify(peers.map(item => ({ id: item.Id, image: item.Image, config: item.Config, host: item.HostConfig,
		mounts: orderedMountInventory(item.Mounts), restartCount: item.RestartCount, startedAt: item.State.StartedAt,
		running: item.State.Running, status: item.State.Status, health: item.State.Health?.Status })).sort((a, b) => a.id.localeCompare(b.id))));
}
export function assertGatewayTildaImages(before, after) {
	const names = ['config.js', 'jwks.js', 'jwt.js', 'logger.js', 'main.js', 'server.js'];
	for (const inventory of [before, after]) {
		assert.deepEqual(Object.keys(inventory).sort(), names);
		for (const hash of Object.values(inventory)) assert.match(hash, /^[a-f0-9]{64}$/);
	}
	for (const name of names.filter(name => name !== 'server.js')) assert.equal(after[name], before[name]);
	assert.notEqual(before['server.js'], after['server.js']);
	assert.equal(after['server.js'], '5be487540905e7511db2d568f706284a804007a46ef620f7ba298ec74f2b570a');
}
export async function verifyGatewayTildaHttp(mode, fetcher = fetch) {
	assert.ok(['legacy', 'tilda'].includes(mode));
	const source = '/api/v1/crm/intake/ingest/11111111-1111-4111-8111-111111111111';
	const checks = [['GET', '/health/live', 200], ['GET', '/health/ready', 200],
		['POST', source, 401], ['POST', source + '/tilda', mode === 'tilda' ? 401 : 404],
		['OPTIONS', source + '/tilda', 404], ['POST', source + '/tilda?token=synthetic-invalid', 404],
		['POST', source + '/%74ilda', 404], ['GET', '/api/v1/crm/intake/inbox', 401],
		['GET', '/api/v1/internal', 404]];
	for (const [method, path, status] of checks) {
		// No source token, user JWT, business body, provider call or real ingestion.
		const response = await fetcher('http://127.0.0.1:4100' + path, { method, redirect: 'error', signal: AbortSignal.timeout(3000) });
		assert.equal(response.status, status); assert.equal(response.headers.get('cache-control'), 'no-store');
		const value = await response.json();
		if (path === '/health/live') assert.equal(value.status, 'ok');
		else if (path === '/health/ready') assert.equal(value.status, 'ready');
		else assert.equal(value.code, status === 404 ? 'route_not_found' : 'authentication_required');
	}
}

const orderedMountInventory = mounts => {
	assert.ok(Array.isArray(mounts));
	return mounts.map(mount => Object.fromEntries(Object.entries(mount).sort(([a], [b]) => a.localeCompare(b))))
		.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
};
const envObject = rows => Object.fromEntries(rows.map(row => {
	const separator = row.indexOf('='); assert.ok(separator > 0); return [row.slice(0, separator), row.slice(separator + 1)];
}));
export function prepareGatewayTildaCompose(input) {
	assert.equal(input.scope, 'gateway-tilda-upgrade');
	const result = prepareScopedCompose(input), before = envObject(input.live[0].Config.Env);
	assert.equal(before.APP_REVISION, input.previousRevision);
	assert.equal(new Set(input.live[0].Config.Env.map(row => row.slice(0, row.indexOf('=')))).size, input.live[0].Config.Env.length);
	assert.deepEqual({ ...envObject(input.image.Config.Env), ...result.desired.services['api-gateway'].environment }, { ...before, APP_REVISION: input.revision });
	const routes = JSON.parse(before.GATEWAY_ROUTES_JSON);
	assert.equal(routes.filter(route => route.authPolicy === 'crm-source').length, 1);
	const ingest = routes.find(route => route.authPolicy === 'crm-source');
	assert.equal(ingest.pathPrefix, '/api/v1/crm/intake/ingest');
	assert.equal(ingest.upstreamUrl, 'http://127.0.0.1:5310');
	assert.equal(routes.filter(route => route.pathPrefix === '/api/v1/crm/intake' && route.authPolicy === 'required').length, 1);
	return result;
}
export const GATEWAY_TILDA_PAYLOAD_FILES = Object.freeze(['scoped-service-release.mjs', 'gateway-tilda-release.mjs']);
export function validateGatewayTildaPayload(bytes) {
	assert.ok(Buffer.byteLength(bytes) > 0 && Buffer.byteLength(bytes) <= 262144);
	const value = JSON.parse(bytes);
	const exact = (item, keys) => { assert.ok(item && typeof item === 'object' && !Array.isArray(item)); assert.deepEqual(Object.keys(item).sort(), keys.sort()); };
	exact(value, ['schemaVersion', 'files']); assert.equal(value.schemaVersion, 1); assert.ok(Array.isArray(value.files));
	assert.deepEqual(value.files.map(file => file.name).sort(), [...GATEWAY_TILDA_PAYLOAD_FILES].sort());
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
		const files = GATEWAY_TILDA_PAYLOAD_FILES.map(name => {
			const path = new URL('./' + name, import.meta.url); const stat = lstatSync(path); assert.ok(stat.isFile() && !stat.isSymbolicLink());
			const content = readFileSync(path, 'utf8'); return { name, content, sha256: sha256(content) };
		});
		const bytes = JSON.stringify({ schemaVersion: 1, files }); validateGatewayTildaPayload(bytes); process.stdout.write(bytes); return;
	}
	assert.equal(process.env.SCOPED_SCOPE, 'gateway-tilda-upgrade');
	if (action === 'gateway-tilda-neighbors') process.stdout.write(gatewayTildaNeighborFingerprint(JSON.parse(rootFileBytes('/run/scoped/gateway-neighbors.json', 8 * 1024 * 1024))));
	else if (action === 'gateway-tilda-image') {
		process.stdout.write(JSON.stringify(Object.fromEntries(readdirSync('/app/dist/src').filter(name => name.endsWith('.js')).sort().map(name => [name, sha256(readFileSync('/app/dist/src/' + name))]))));
	} else if (action === 'gateway-tilda-images') assertGatewayTildaImages(JSON.parse(rootFileBytes('/run/scoped/gateway-image-before.json')), JSON.parse(rootFileBytes('/run/scoped/gateway-image-after.json')));
	else if (action === 'gateway-tilda-source') assert.deepEqual([sha256(rootFileBytes('/run/scoped/gateway-source-before.ts', 131072)), sha256(rootFileBytes('/run/scoped/gateway-source-after.ts', 131072))], GATEWAY_TILDA_SOURCE);
	else if (action === 'gateway-tilda-http') await verifyGatewayTildaHttp(process.argv[3]);
	else if (action === 'prepare') {
		const result = prepareGatewayTildaCompose({ scope: process.env.SCOPED_SCOPE, revision: process.env.SCOPED_REVISION, previousRevision: process.env.SCOPED_PREVIOUS_REVISION,
			compose: JSON.parse(rootFileBytes('/run/scoped/compose.json', 4 * 1024 * 1024)), live: JSON.parse(rootFileBytes('/run/scoped/live.json', 4 * 1024 * 1024)), image: JSON.parse(rootFileBytes('/run/scoped/image.json'))[0] });
		for (const key of ['desired', 'rollback']) writeFileSync('/run/scoped/' + key + '.json', JSON.stringify(result[key]) + '\n', { mode: 0o600, flag: 'wx' });
	} else throw new Error('Unsupported Gateway verifier action');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(() => { process.stderr.write('Gateway release verification failed.\n'); process.exitCode = 1; });
