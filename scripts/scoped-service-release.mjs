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
	'platform-marketing-runtime': ['platform-api'],
	'operations-api-runtime': ['operations-api'],
	'operations-federation-config': ['operations-api'],
	'workers-bootstrap-recovery': ['billing-api', 'billing-worker', 'billing-outbox-publisher', 'operations-worker', 'operations-outbox-publisher', 'operations-restore-worker', 'support-worker', 'support-outbox-publisher'],
	'identity-with-operations-manifest': ['identity-api', 'identity-worker', 'identity-outbox-publisher', 'operations-api', 'operations-worker', 'operations-outbox-publisher', 'operations-restore-worker'],
	'operations-runtime': ['operations-api', 'operations-worker', 'operations-outbox-publisher', 'operations-restore-worker'],
	'operations-backup-runtime': ['operations-api', 'operations-worker', 'operations-outbox-publisher', 'operations-restore-worker'],
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
export const PLATFORM_MARKETING_SOURCE = Object.freeze({
	'content/platform-content.validation.ts': ['b19aa419513a9a8dc936846c15b1b3871aad2a0b6b04d0886538ed90a8a9b99d', 'eefe666009198306f4595712c6c686d29d2b96f9843dbc10003c9a58f8f36f8a'],
	'home-page-content/home-page-content.service.ts': ['f09abc76f355441b015df1cd929844987ebf2380eb307807bc085dda92849dc6', 'e5b0aa7a5487b5eb1e18cf25a367f43a05430a4c09c235e19a2cbd17d1fffcae']
});
const PLATFORM_COMPILED_PATHS = Object.keys(PLATFORM_MARKETING_SOURCE).map(path => path.replace(/\.ts$/, '.js'));
export function assertPlatformMarketingSource(before, after) {
	assert.ok(before && after);
	same(Object.keys(before).sort(), Object.keys(PLATFORM_MARKETING_SOURCE).sort());
	same(Object.keys(after).sort(), Object.keys(before).sort());
	for (const [path, hashes] of Object.entries(PLATFORM_MARKETING_SOURCE)) {
		assert.equal(sha256(before[path]), hashes[0]); assert.equal(sha256(after[path]), hashes[1]);
	}
}

export function validatePlatformInventory(value) {
	same(Object.keys(value).sort(), ['compiled', 'generatedModels', 'generatedSchemaSha256', 'kind', 'migrations', 'mode', 'packages', 'schemaSha256', 'schemaVersion'].sort());
	assert.equal(value.schemaVersion, 1); assert.equal(value.kind, 'winwidget.platform.marketing-image.v1');
	assert.ok(['legacy', 'marketing'].includes(value.mode));
	assert.equal(value.migrations.length, 8);
	same(value.migrations.map(row => row.name), [...new Set(value.migrations.map(row => row.name))].sort());
	for (const row of value.migrations) { same(Object.keys(row).sort(), ['checksum', 'name']); assert.match(row.name, /^\d{14}_[a-z0-9_]+$/); assert.match(row.checksum, /^[a-f0-9]{64}$/); }
	assert.equal(value.migrations.at(-1).name, '20260830020000_harden_default_routine_acl');
	assert.match(value.schemaSha256, /^[a-f0-9]{64}$/); assert.equal(value.schemaSha256, value.generatedSchemaSha256);
	same(value.generatedModels, ['BillingOfferProducerState', 'HomePageContent', 'LegalPage', 'OutboxEvent', 'PlatformSourceSequence', 'ServiceIdentity', 'SiteSettings']);
	assert.ok(Array.isArray(value.compiled) && value.compiled.length >= 30 && value.compiled.length <= 100);
	same(value.compiled.map(row => row.path), [...new Set(value.compiled.map(row => row.path))].sort());
	for (const row of value.compiled) { same(Object.keys(row).sort(), ['path', 'sha256']); assert.match(row.path, /^[a-z0-9][a-z0-9./-]*\.js$/); assert.ok(!row.path.includes('..')); assert.match(row.sha256, /^[a-f0-9]{64}$/); }
	for (const path of PLATFORM_COMPILED_PATHS) assert.equal(value.compiled.filter(row => row.path === path).length, 1);
	assert.ok(Array.isArray(value.packages) && value.packages.length > 30 && value.packages.length <= 2000);
	same(value.packages, [...new Set(value.packages)].sort());
	for (const name of value.packages) assert.match(name, /^[a-zA-Z0-9@+_.()-]+$/);
	assert.equal(value.packages.filter(name => name.startsWith('qs@')).length, 1);
	assert.ok(value.packages.includes(value.mode === 'legacy' ? 'qs@6.15.3' : 'qs@6.16.0'));
	return value;
}

export function assertPlatformImages(before, after) {
	validatePlatformInventory(before); validatePlatformInventory(after);
	assert.equal(before.mode, 'legacy'); assert.equal(after.mode, 'marketing');
	for (const key of ['migrations', 'schemaSha256', 'generatedSchemaSha256', 'generatedModels']) same(before[key], after[key]);
	same(before.packages.filter(name => !name.startsWith('qs@')), after.packages.filter(name => !name.startsWith('qs@')));
	same(before.compiled.filter(row => !PLATFORM_COMPILED_PATHS.includes(row.path)), after.compiled.filter(row => !PLATFORM_COMPILED_PATHS.includes(row.path)));
	for (const path of PLATFORM_COMPILED_PATHS) assert.notEqual(before.compiled.find(row => row.path === path).sha256, after.compiled.find(row => row.path === path).sha256);
}

export function platformNeighborFingerprint(live) {
	assert.ok(Array.isArray(live)); assert.equal(live.length, 31);
	assert.equal(new Set(live.map(item => item.Id)).size, 31);
	assert.equal(new Set(live.map(item => item.Config.Labels['com.docker.compose.service'])).size, 31);
	assert.equal(live.filter(item => item.Config.Labels['com.docker.compose.service'] === 'platform-api').length, 1);
	const peers = live.filter(item => item.Config.Labels['com.docker.compose.service'] !== 'platform-api');
	assert.equal(peers.filter(item => item.Config.Labels['com.docker.compose.service'] === 'platform-outbox-publisher').length, 1);
	for (const item of live) {
		assert.equal(item.Config.Labels['com.docker.compose.project'], 'winwidget'); assert.match(item.Id, /^[a-f0-9]{64}$/); assert.match(item.Image, /^sha256:[a-f0-9]{64}$/);
		if (item.Config.Labels['com.docker.compose.service'] === 'platform-api') continue;
		assert.equal(item.State.Status, 'running'); assert.equal(item.State.Running, true); assert.equal(item.State.Health?.Status, 'healthy');
	}
	return sha256(JSON.stringify(peers.map(item => ({ id: item.Id, image: item.Image, config: item.Config, host: item.HostConfig, mounts: orderedMountInventory(item.Mounts),
		startedAt: item.State.StartedAt, running: item.State.Running, status: item.State.Status, health: item.State.Health?.Status, restartCount: item.RestartCount }))
		.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
}

export function parsePlatformProbeUrl(value) {
	assert.ok(typeof value === 'string' && value.length < 4096);
	const url = new URL(value);
	assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
	assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55439'); assert.equal(url.pathname, '/winwidget_platform');
	assert.equal(decodeURIComponent(url.username), 'winwidget_platform_migration'); assert.ok(url.password); assert.equal(url.hash, '');
	const keys = [...url.searchParams.keys()]; assert.equal(new Set(keys).size, keys.length);
	assert.ok(keys.every(key => ['schema', 'sslmode', 'connection_limit', 'pool_timeout', 'connect_timeout'].includes(key)));
	assert.equal(url.searchParams.get('schema'), 'platform');
	if (url.searchParams.has('sslmode')) assert.equal(url.searchParams.get('sslmode'), 'disable');
	url.searchParams.set('connection_limit', '1'); url.searchParams.set('pool_timeout', '5'); url.searchParams.set('connect_timeout', '5');
	return url.toString();
}

export async function verifyPlatformDatabase(client, files) {
	assert.equal((await client.$queryRawUnsafe('SHOW transaction_read_only'))[0]?.transaction_read_only, 'on');
	const principal = await client.$queryRawUnsafe('SELECT current_database() AS database, current_user AS username, current_schema() AS schema, pg_is_in_recovery() AS recovery');
	same(principal, [{ database: 'winwidget_platform', username: 'winwidget_platform_migration', schema: 'platform', recovery: false }]);
	const identity = await client.$queryRawUnsafe("SELECT id, service_name, database_id::text AS database_id, current_semantic_fingerprint, platform.current_semantic_fingerprint() AS actual_fingerprint FROM platform.service_identity");
	assert.equal(identity.length, 1); assert.equal(identity[0].id, 'singleton'); assert.equal(identity[0].service_name, 'platform-service');
	assert.match(identity[0].database_id, /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
	assert.match(identity[0].current_semantic_fingerprint, /^[a-f0-9]{64}$/); assert.equal(identity[0].current_semantic_fingerprint, identity[0].actual_fingerprint);
	const ledger = await client.$queryRawUnsafe('SELECT migration_name, checksum, finished_at, rolled_back_at FROM platform._prisma_migrations ORDER BY migration_name');
	assert.equal(files.length, 8); same(ledger.map(row => ({ name: row.migration_name, checksum: row.checksum })), files);
	assert.ok(ledger.every(row => row.finished_at && !row.rolled_back_at));
	const content = await client.$queryRawUnsafe("SELECT aggregate_version::text AS version, source_sequence::text AS sequence, encode(sha256(convert_to(content::text, 'UTF8')), 'hex') AS sha256 FROM platform.home_page_content WHERE id='singleton'");
	assert.equal(content.length, 1); assert.match(content[0].sha256, /^[a-f0-9]{64}$/);
	for (const key of ['version', 'sequence']) assert.match(content[0][key], /^(0|[1-9][0-9]*)$/);
	const acl = await client.$queryRawUnsafe("SELECT jsonb_build_object('relations', (SELECT jsonb_agg(jsonb_build_array(c.relname, pg_get_userbyid(c.relowner), c.relacl::text) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='platform'), 'routines', (SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text, pg_get_userbyid(p.proowner), p.proacl::text) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='platform'), 'defaults', (SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(d.defaclrole), d.defaclobjtype, d.defaclacl::text) ORDER BY d.defaclrole, d.defaclobjtype) FROM pg_default_acl d JOIN pg_namespace n ON n.oid=d.defaclnamespace WHERE n.nspname='platform')) AS acl");
	assert.equal(acl.length, 1); assert.ok(acl[0].acl && typeof acl[0].acl === 'object');
	return sha256(JSON.stringify({ identity, files, content, acl })); // Hashes/owner metadata only; no content or credentials leave the database.
}

async function platformDatabaseAction() {
	assert.equal(process.getuid(), 1001);
	const require = createRequire('/app/package.json'); const { PrismaClient } = require('@prisma/platform-client');
	const client = new PrismaClient({ datasources: { db: { url: parsePlatformProbeUrl(process.env.PLATFORM_DATABASE_URL) } } });
	const deadline = setTimeout(() => process.exit(1), 15000);
	try {
		const files = migrationFiles('/app/prisma/migrations');
		const hash = await client.$transaction(async tx => {
			await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY'); await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
			return verifyPlatformDatabase(tx, files);
		}, { timeout: 10000, isolationLevel: 'RepeatableRead' });
		process.stdout.write(hash);
	} finally { await client.$disconnect(); clearTimeout(deadline); }
}

export async function verifyPlatformHttp(revision, fetcher = fetch) {
	assert.match(revision, /^[a-f0-9]{40}$/);
	for (const name of ['live', 'ready']) {
		const response = await fetcher(`http://127.0.0.1:5000/health/${name}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000) });
		assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
		const value = await response.json(); assert.equal(value.service, 'platform'); assert.equal(value.role, 'api'); assert.equal(value.revision, revision);
		assert.equal(value.status, name === 'ready' ? 'ready' : 'ok');
		if (name === 'ready') { assert.equal(value.database?.serviceName, 'platform-service'); assert.match(value.database.currentSemanticFingerprint, /^[a-f0-9]{64}$/); }
	}
	const response = await fetcher('http://127.0.0.1:5000/api/v1/home-page-content', { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000) });
	assert.equal(response.status, 200); const text = await response.text(); assert.ok(Buffer.byteLength(text) <= 2 * 1024 * 1024);
	const value = JSON.parse(text); assert.equal(value.id, 'singleton'); assert.ok(value.content && typeof value.content === 'object' && !Array.isArray(value.content));
	assert.ok(Number.isFinite(Date.parse(value.updatedAt)));
}

export function platformMarketingFixture() {
	const seo = { title: '', description: '', keywords: [], ogTitle: '', ogDescription: '' };
	const section = { enabled: true, title: '', subtitle: '', items: [] };
	const legacy = {
		seo, technicalSeo: { baseUrl: '', robotsDisallow: [], sitemapItems: [] },
		demoWidgets: { enabled: true, bubbleTexts: { wheel: '', quiz: '', callback: '', countdown: '', aiConsultant: '', stopOffer: '', calculator: '' } },
		hero: { titleBeforeAccent: '', accentText: '', titleAfterAccent: '', subtitle: '', primaryButtonText: '', faqButtonLabel: '', benefits: [] },
		analysis: { enabled: true, title: '', subtitle: '', cards: [] }, integrations: { enabled: true, title: '', items: [] },
		tools: { enabled: true, title: '', ctaText: '', items: [] }, audiences: section, caseStudies: section, leadFlow: section,
		whyWidgets: { enabled: true, title: '', subtitle: '', formTitle: '', widgetTitle: '', formItems: [], widgetItems: [] },
		steps: { enabled: true, title: '', resultText: '', items: [] }, customization: { enabled: true, title: '', subtitle: '', cards: [], features: [], bottomText: '' },
		dashboardPreview: { enabled: true, title: '', subtitle: '', cards: [], metrics: [] }, directLink: section, security: section,
		subscriptionBundle: { ...section, cardTitle: '' }, tariffComparison: { enabled: true, title: '', subtitle: '', rows: [] },
		pricing: { enabled: true, title: '', monthlyToggleText: '', yearlyToggleText: '', discountText: '', buttonText: '', plans: [] },
		microCta: { enabled: true, afterIntegrationsText: '', afterIntegrationsButtonText: '', afterStepsText: '', afterStepsButtonText: '' },
		seoText: { enabled: true, title: '', text: '' }, payment: { seoTitle: '', seoDescription: '' }, faq: { enabled: true, title: '', items: [] },
		cta: { enabled: true, text: '', buttonText: '', benefits: [] },
		footer: { aboutTitle: '', infoLines: [], email: '', ybsUrl: '', vkUrl: '', telegramUrl: '', vkAriaLabel: '', telegramAriaLabel: '', legalDisclaimer: '' }
	};
	const hero = { eyebrow: '', title: '', subtitle: '' }, integration = { ...section, note: '' }, faq = { enabled: true, title: '', items: [] };
	const product = { description: '', features: [], buttonText: '' }, buttons = { widgetsButtonText: '', crmButtonText: '' }, cta = { enabled: true, title: '', text: '' };
	return structuredClone({ legacy, marketing: { ...legacy,
		ecosystem: { seo, hero, products: { title: '', subtitle: '', widgets: product, crm: product }, integration, plans: { enabled: true, title: '', subtitle: '', ...buttons, note: '' }, faq, cta: { ...cta, ...buttons } },
		crmProduct: { seo, hero: { ...hero, buttonText: '' }, features: section, workflow: section, integration, faq, cta: { ...cta, buttonText: '' } }
	} });
}

function platformImageInventory(mode) {
	assert.equal(process.getuid(), 1001); assert.equal(process.getgid(), 1001); assert.ok(['legacy', 'marketing'].includes(mode));
	const root = '/app/dist/src', compiled = [];
	const visit = directory => {
		assert.equal(realpathSync(directory), directory);
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			assert.ok(!entry.isSymbolicLink()); const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else { assert.ok(entry.isFile()); if (entry.name.endsWith('.js')) compiled.push({ path: path.slice(root.length + 1), sha256: sha256(readFileSync(path)) }); }
		}
	};
	visit(root);
	const require = createRequire('/app/package.json'), { Prisma } = require('@prisma/platform-client');
	const { validateAndSanitizeStructuredHomeContent: validate } = require('/app/dist/src/content/platform-content.validation.js');
	const { legacy, marketing } = platformMarketingFixture(); same(validate(legacy), legacy);
	if (mode === 'legacy') assert.throws(() => validate(marketing)); else same(validate(marketing), marketing);
	for (const key of ['head', 'body', 'unexpected']) assert.throws(() => validate({ ...legacy, [key]: {} }));
	if (mode === 'marketing') {
		for (const key of ['enabled', 'price', 'release', 'url']) assert.throws(() => validate({ ...marketing, crmProduct: { ...marketing.crmProduct, [key]: true } }));
		assert.throws(() => validate({ ...marketing, ecosystem: {} }));
	}
	const { PlatformRuntimeService } = require('/app/dist/src/runtime/platform-runtime.service.js');
	const runtime = new PlatformRuntimeService({ get: key => key === 'PLATFORM_PROCESS_ROLE' ? 'api' : undefined });
	assert.equal(runtime.apiEnabled, true); assert.equal(runtime.outboxPublisherEnabled, false);
	const packages = readdirSync('/app/node_modules/.pnpm', { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== 'node_modules').map(entry => entry.name).sort();
	const value = { schemaVersion: 1, kind: 'winwidget.platform.marketing-image.v1', mode, packages,
		migrations: migrationFiles('/app/prisma/migrations'), schemaSha256: sha256(readFileSync('/app/prisma/schema.prisma')),
		generatedSchemaSha256: sha256(readFileSync(require.resolve('@prisma/platform-client/schema.prisma'))),
		generatedModels: Prisma.dmmf.datamodel.models.map(row => row.name).sort(), compiled: compiled.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
	validatePlatformInventory(value); process.stdout.write(JSON.stringify(value));
}
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

export function prepareScopedCompose({ scope, revision, previousRevision, operationsPreviousRevision, operationsApiPreviousRevision, compose, live, image, operationsImage, supportImage, backupBaseline, backupBaselineSha256 }) {
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
	if (scope === 'operations-backup-runtime') {
		assert.match(backupBaselineSha256 ?? '', /^[a-f0-9]{64}$/);
		assert.equal(operationsBackupFingerprint(backupBaseline), backupBaselineSha256);
		assert.equal(operationsBackupFingerprint(live), operationsBackupFingerprint(backupBaseline.filter(item => item.Config.Labels['com.docker.compose.project'] === 'winwidget' && targets.includes(item.Config.Labels['com.docker.compose.service']))));
		assertCrmBackupEnvironment(compose.services);
		for (const [key] of OPERATIONS_CRM_BACKUP_TARGETS) assert.equal(Object.hasOwn(envObject(image.Config.Env), key), false);
	}
	const desired = { name: 'winwidget', services: {}, volumes: {}, secrets: {} };
	const rollback = structuredClone(desired);
	for (const name of targets) {
		const workers = scope === 'workers-bootstrap-recovery';
		const federation = scope === 'operations-federation-config';
		const operationsApi = scope === 'operations-api-runtime';
		const companion = scope === 'identity-with-operations-manifest' && name.startsWith('operations-');
		const backup = scope === 'operations-backup-runtime';
		const expectedPreviousRevision = backup && name !== 'operations-api' ? live.find(item => item.Config.Labels['com.docker.compose.service'] === name)?.Config.Labels['org.opencontainers.image.revision']
			: companion ? (name === 'operations-api' && operationsApiPreviousRevision ? operationsApiPreviousRevision : operationsPreviousRevision) : previousRevision;
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
		if (backup) {
			assert.equal(new Set(container.Config.Env.map(row => row.slice(0, row.indexOf('=')))).size, container.Config.Env.length);
			assert.equal(before.APP_REVISION, expectedPreviousRevision);
			for (const [key] of OPERATIONS_CRM_BACKUP_TARGETS) assert.equal(Object.hasOwn(before, key), false);
		}
		if (scope === 'platform-marketing-runtime') {
			assert.equal(name, 'platform-api'); assert.equal(before.APP_REVISION, previousRevision);
			assert.equal(before.PLATFORM_PROCESS_ROLE, 'api'); assert.equal(after.PLATFORM_PROCESS_ROLE, 'api');
		}
		const inherited = envObject(expectedImage.Config.Env);
		if (backup) for (const [key, value] of Object.entries(inherited)) if (!Object.hasOwn(after, key)) assert.equal(value, before[key]);
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
			} else if (backup && name === 'operations-worker' && OPERATIONS_CRM_BACKUP_TARGETS.some(([backupKey]) => backupKey === key)) {
				// Exactly the four validated backup-only additions; never a runtime URL.
				assert.equal(Object.hasOwn(before, key), false);
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
		if (operationsApi || federation || ((companion || backup) && ['operations-api', 'operations-restore-worker'].includes(name)) || (workers && name === 'operations-restore-worker')) {
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

export const OPERATIONS_CRM_BACKUP_TARGETS = Object.freeze([
	['CRM_ACCESS_BACKUP_URL', 'crm_access', '55442'],
	['CRM_INTAKE_BACKUP_URL', 'crm_intake', '55443'],
	['CRM_CUSTOMERS_BACKUP_URL', 'crm_customers', '55444'],
	['CRM_SALES_BACKUP_URL', 'crm_sales', '55445']
].map(Object.freeze));

export function parseOperationsCrmBackupUrl(value, schema, port) {
	assert.ok(typeof value === 'string' && value.length > 0 && value.length <= 4096);
	assert.ok(OPERATIONS_CRM_BACKUP_TARGETS.some(target => target[1] === schema && target[2] === port));
	const url = new URL(value);
	assert.equal(url.protocol, 'postgresql:'); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, port);
	assert.equal(url.pathname, `/winwidget_${schema}`); assert.equal(url.hash, ''); assert.ok(url.password);
	assert.equal(decodeURIComponent(url.username), `winwidget_${schema}_backup`);
	same([...url.searchParams.keys()].sort(), ['schema', 'sslmode']);
	assert.equal(url.searchParams.get('schema'), schema); assert.equal(url.searchParams.get('sslmode'), 'disable');
	return url;
}

export function assertCrmBackupEnvironment(services) {
	assert.ok(services['operations-worker']);
	for (const [key, schema, port] of OPERATIONS_CRM_BACKUP_TARGETS) {
		for (const [name, service] of Object.entries(services)) assert.equal(Object.hasOwn(service.environment ?? {}, key), name === 'operations-worker');
		parseOperationsCrmBackupUrl(services['operations-worker'].environment[key], schema, port);
	}
}

// Exclude only volatile health-probe timestamps/output. Every configuration,
// mount, immutable image and container identity stays in the approved digest.
export function operationsBackupFingerprint(live, neighborsOnly = false) {
	assert.ok(Array.isArray(live) && live.length > 0 && live.length <= 200);
	const keys = new Set(), targetNames = new Set(), rows = [];
	for (const item of live) {
		const project = item.Config?.Labels?.['com.docker.compose.project'], name = item.Config?.Labels?.['com.docker.compose.service'];
		assert.ok(['winwidget', 'winwidget-crm'].includes(project)); assert.match(name ?? '', /^[a-z][a-z0-9-]*$/);
		const key = `${project}/${name}`; assert.equal(keys.has(key), false); keys.add(key);
		const target = project === 'winwidget' && SCOPED_SERVICES['operations-backup-runtime'].includes(name);
		if (target) targetNames.add(name);
		if (neighborsOnly && target) continue;
		assert.match(item.Id ?? '', /^[a-f0-9]{64}$/); assert.match(item.Image ?? '', /^sha256:[a-f0-9]{64}$/);
		assert.equal(item.State?.Status, 'running'); assert.equal(item.State.Running, true); assert.equal(item.State?.Health?.Status, 'healthy');
		assert.ok(Number.isSafeInteger(item.RestartCount) && item.RestartCount >= 0); assert.equal(typeof item.State.StartedAt, 'string'); assert.ok(Number.isFinite(Date.parse(item.State.StartedAt)));
		if (target) assert.match(item.Config.Labels['org.opencontainers.image.revision'] ?? '', /^[a-f0-9]{40}$/);
		rows.push({ key, id: item.Id, image: item.Image, config: item.Config, host: item.HostConfig, mounts: orderedMountInventory(item.Mounts), status: item.State.Status, running: item.State.Running, health: item.State.Health.Status, startedAt: item.State.StartedAt, restartCount: item.RestartCount });
	}
	if (!neighborsOnly) same([...targetNames].sort(), [...SCOPED_SERVICES['operations-backup-runtime']].sort());
	rows.sort((a, b) => a.key.localeCompare(b.key, 'en'));
	return sha256(JSON.stringify(rows));
}

export function operationsBackupImageInventory(root = '/app', generatedSchema) {
	const manifestPath = join(root, 'restore-manifests/database-restore-migrations.json');
	const manifestBytes = readFileSync(manifestPath), manifest = JSON.parse(manifestBytes);
	same(Object.keys(manifest.targets).sort(), ['campaigns', 'identity', 'notification-delivery', 'platform', 'reporting', 'support', 'widgets']);
	const value = { schemaVersion: 1, schemaSha256: sha256(readFileSync(join(root, 'prisma/schema.prisma'))),
		generatedSchemaSha256: sha256(readFileSync(generatedSchema)), migrations: migrationFiles(join(root, 'prisma/migrations')),
		restoreManifestSha256: sha256(manifestBytes), keyringSha256: sha256(readFileSync(join(root, 'restore-manifests/database-backup-provenance-public-keys.json'))) };
	assert.equal(value.schemaSha256, value.generatedSchemaSha256);
	return value;
}

export function assertOperationsBackupImagePair(before, after) {
	same(Object.keys(before).sort(), ['generatedSchemaSha256', 'keyringSha256', 'migrations', 'restoreManifestSha256', 'schemaSha256', 'schemaVersion']);
	assert.equal(before.schemaVersion, 1); assert.ok(before.migrations.length > 0);
	for (const key of ['generatedSchemaSha256', 'keyringSha256', 'restoreManifestSha256', 'schemaSha256']) assert.match(before[key], /^[a-f0-9]{64}$/);
	assert.equal(before.schemaSha256, before.generatedSchemaSha256);
	for (const row of before.migrations) { same(Object.keys(row).sort(), ['checksum', 'name']); assert.match(row.name, /^\d{14}_[a-z0-9_]+$/); assert.match(row.checksum, /^[a-f0-9]{64}$/); }
	same(before.migrations.map(row => row.name), [...new Set(before.migrations.map(row => row.name))].sort());
	same(before, after);
}

// Exact public source pair: Operations 73b372fa/65025008 -> Services 4ca81e6c.
// Existing APIs remain strict; only this backup-scope gate admits the reviewed
// owner manifests, with independent live ledger evidence before admission.
export const OPERATIONS_BACKUP_TRUST = Object.freeze({
	before: '50bd4c57e04f59cf39239432fc5d949a9d8fedc8f2cee81f1579b31b071bc64e',
	after: '7060c972da6f5f6c4f7b7f38a72037f208220fcd32dffd109180050e3801d8d0'
});
export const OPERATIONS_BACKUP_TRUST_TARGETS = Object.freeze([
	['notification-delivery', 'NOTIFICATION_DELIVERY_BACKUP_URL', '55432', '6c5bf79e6daeb866f24052f060dd71553cbcbaf8f2fc0edeec139b41769afcd3'],
	['widgets', 'WIDGETS_BACKUP_URL', '55436', 'fdfd10bc680b6d0692324d38fda39361bd5881f4e76eaca332bb9403f945e059'],
	['identity', 'IDENTITY_BACKUP_URL', '55438', 'bbdaeb72f8dd8bcba866402a0de492fb7af2146ee6f34fd94a065fe3c29604f1']
].map(Object.freeze));

export function assertOperationsBackupManifestImages(before, after) {
	const strip = value => {
		const { restoreManifestText, ...inventory } = value;
		assert.ok(typeof restoreManifestText === 'string' && Buffer.byteLength(restoreManifestText) <= 32768);
		assert.equal(sha256(restoreManifestText), inventory.restoreManifestSha256);
		return inventory;
	};
	const a = strip(before), b = strip(after);
	if (a.restoreManifestSha256 === b.restoreManifestSha256) return assertOperationsBackupImagePair(a, b);
	assert.equal(a.restoreManifestSha256, OPERATIONS_BACKUP_TRUST.before);
	assert.equal(b.restoreManifestSha256, OPERATIONS_BACKUP_TRUST.after);
	assertOperationsBackupImagePair(a, { ...b, restoreManifestSha256: a.restoreManifestSha256 });
	// Whole-file hashes pin all seven entries, including the unchanged four.
}

export function assertOperationsBackupPostflight({ live, desired, image, revision }) {
	const targets = SCOPED_SERVICES['operations-backup-runtime'];
	assert.equal(live.length, targets.length); same(Object.keys(desired.services).sort(), [...targets].sort());
	assertCrmBackupEnvironment(desired.services);
	for (const name of targets) {
		const found = live.filter(item => item.Config.Labels['com.docker.compose.service'] === name); assert.equal(found.length, 1);
		const item = found[0], service = desired.services[name];
		assert.equal(item.Config.Labels['com.docker.compose.project'], 'winwidget'); assert.equal(item.Config.Labels['org.opencontainers.image.revision'], revision);
		assert.equal(item.Image, image.Id); assert.equal(item.State.Status, 'running'); assert.equal(item.State.Running, true); assert.equal(item.State.Health?.Status, 'healthy');
		assertServiceConfiguration(service, item, image, desired.secrets);
		const effective = envObject(item.Config.Env);
		assert.equal(Object.keys(effective).length, item.Config.Env.length);
		same(effective, { ...envObject(image.Config.Env), ...service.environment });
		for (const [key] of OPERATIONS_CRM_BACKUP_TARGETS) assert.equal(Object.hasOwn(effective, key), name === 'operations-worker');
	}
}

export function assertOperationsBackupOriginal(live, baseline) {
	const original = baseline.filter(item => item.Config.Labels['com.docker.compose.project'] === 'winwidget' && SCOPED_SERVICES['operations-backup-runtime'].includes(item.Config.Labels['com.docker.compose.service']));
	assert.equal(live.length, 4);
	const normalized = live.map(item => {
		const before = original.find(row => row.Id === item.Id); assert.ok(before);
		assert.equal(item.State.Running, false); assert.equal(item.State.Pid, 0); assert.ok(['exited', 'created'].includes(item.State.Status));
		return { ...item, State: before.State };
	});
	assert.equal(operationsBackupFingerprint(normalized), operationsBackupFingerprint(original));
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

function orderedMountInventory(mounts) {
	assert.ok(Array.isArray(mounts));
	// Docker may enumerate Mounts in a different order on successive inspections.
	// Preserve every field and every entry; only this unordered inventory is sorted.
	return mounts.map(mount => {
		assert.ok(mount && typeof mount === 'object' && !Array.isArray(mount));
		return Object.fromEntries(Object.entries(mount).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
	}).sort((left, right) => {
		const a = JSON.stringify(left), b = JSON.stringify(right);
		return a < b ? -1 : a > b ? 1 : 0;
	});
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
	return sha256(JSON.stringify(neighbors.map(item => ({ id: item.Id, image: item.Image, config: item.Config, host: item.HostConfig, mounts: orderedMountInventory(item.Mounts),
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

// Backup-only readonly preflight. Credentials never become argv, output or a
// process environment; callers transport just this bounded envelope via stdin.
const backupProbeRecord = (value, keys) => {
	assert.ok(value && Object.getPrototypeOf(value) === Object.prototype);
	same(Object.keys(value).sort(), [...keys].sort());
	return value;
};
function operationsBackupProbeUrl(value, role) {
	assert.ok(['migration', 'runtime'].includes(role));
	assert.ok(typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\s\0]/.test(value));
	const url = new URL(value);
	assert.equal(url.protocol, 'postgresql:'); assert.equal(url.hostname, '127.0.0.1');
	assert.equal(url.port, '55441'); assert.equal(url.pathname, '/winwidget_operations'); assert.equal(url.hash, '');
	assert.equal(decodeURIComponent(url.username), `winwidget_operations_${role}`);
	assert.ok(decodeURIComponent(url.password) && !/[\0\r\n]/.test(decodeURIComponent(url.password)));
	const keys = [...url.searchParams.keys()]; assert.equal(new Set(keys).size, keys.length);
	assert.ok(keys.every(key => ['schema', 'sslmode', 'connection_limit', 'pool_timeout', 'connect_timeout'].includes(key)));
	assert.equal(url.searchParams.get('schema'), 'operations'); assert.equal(url.searchParams.get('sslmode'), 'disable');
	for (const key of ['connection_limit', 'pool_timeout', 'connect_timeout'])
		if (url.searchParams.has(key)) assert.match(url.searchParams.get(key), /^[1-9]\d{0,3}$/);
	return url;
}

export function validateOperationsBackupProbeInput(value) {
	try {
		backupProbeRecord(value, ['schemaVersion', 'operationsMigrationUrl', 'crmBackupUrls']);
		assert.equal(value.schemaVersion, 1);
		assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 32768);
		operationsBackupProbeUrl(value.operationsMigrationUrl, 'migration');
		const targets = OPERATIONS_CRM_BACKUP_TARGETS.map(([, schema]) => schema.replaceAll('_', '-'));
		backupProbeRecord(value.crmBackupUrls, targets);
		for (const [, schema, port] of OPERATIONS_CRM_BACKUP_TARGETS) {
			const raw = value.crmBackupUrls[schema.replaceAll('_', '-')];
			assert.ok(typeof raw === 'string' && !/[\s\0]/.test(raw));
			const url = parseOperationsCrmBackupUrl(raw, schema, port);
			assert.ok(decodeURIComponent(url.password) && !/[\0\r\n]/.test(decodeURIComponent(url.password)));
		}
		return structuredClone(value);
	} catch { throw new Error('Invalid Operations backup probe input; private details suppressed'); }
}

export function createOperationsBackupProbeInput(ownerEnvBytes, desired) {
	try {
		assert.ok(typeof ownerEnvBytes === 'string' || Buffer.isBuffer(ownerEnvBytes));
		assert.ok(Buffer.byteLength(ownerEnvBytes) <= 1048576);
		const text = ownerEnvBytes.toString(); assert.ok(!text.includes('\0'));
		const keys = new Set(); let migrationUrl;
		for (const line of text.split(/\r?\n/)) {
			if (!line.trim() || line.trimStart().startsWith('#')) continue;
			const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
			assert.ok(match && !keys.has(match[1])); keys.add(match[1]);
			if (match[1] !== 'OPERATIONS_MIGRATION_DATABASE_URL') continue;
			let value = match[2];
			if (value.startsWith('"')) value = JSON.parse(value);
			else if (value.startsWith("'")) { assert.ok(value.endsWith("'")); value = value.slice(1, -1); }
			migrationUrl = value;
		}
		assertCrmBackupEnvironment(desired.services);
		const migration = operationsBackupProbeUrl(migrationUrl, 'migration');
		const runtime = operationsBackupProbeUrl(desired.services['operations-api'].environment.OPERATIONS_DATABASE_URL, 'runtime');
		for (const key of ['protocol', 'hostname', 'port', 'pathname']) assert.equal(migration[key], runtime[key]);
		const input = validateOperationsBackupProbeInput({ schemaVersion: 1, operationsMigrationUrl: migrationUrl,
			crmBackupUrls: Object.fromEntries(OPERATIONS_CRM_BACKUP_TARGETS.map(([key, schema]) =>
				[schema.replaceAll('_', '-'), desired.services['operations-worker'].environment[key]])) });
		return Buffer.from(JSON.stringify(input));
	} catch { throw new Error('Cannot prepare Operations backup probe input; private details suppressed'); }
}

async function assertBackupProbeSession(client, schema, role) {
	assert.match(schema, /^(?:operations|crm_access|crm_intake|crm_customers|crm_sales)$/);
	assert.ok(['migration', 'backup'].includes(role));
	assert.equal((await client.$queryRawUnsafe('SHOW transaction_read_only'))[0]?.transaction_read_only, 'on');
	assert.match((await client.$queryRawUnsafe('SHOW server_version_num'))[0]?.server_version_num ?? '', /^18\d{4}$/);
	const identity = await client.$queryRawUnsafe(`SELECT current_database()::text AS database, current_user::text AS username,
		session_user::text AS session_user, current_schema()::text AS schema, pg_is_in_recovery() AS recovery`);
	same(identity, [{ database: `winwidget_${schema}`, username: `winwidget_${schema}_${role}`, session_user: `winwidget_${schema}_${role}`, schema, recovery: false }]);
	const principals = await client.$queryRawUnsafe(`SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
		AND ${schema === 'operations' ? 'TRUE' : 'NOT rolinherit'} AND NOT rolreplication AND NOT rolbypassrls AS restricted,
		NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = roles.oid OR roleid = roles.oid) AS no_memberships,
		(SELECT pg_get_userbyid(datdba) = 'winwidget_${schema}_admin' FROM pg_database WHERE datname = current_database()) AS database_owner_matches,
		(SELECT pg_get_userbyid(nspowner) = 'winwidget_${schema}_migration' FROM pg_namespace WHERE nspname = '${schema}') AS schema_owner_matches,
		has_database_privilege(current_user, current_database(), 'CONNECT') AS connect,
		NOT has_database_privilege(current_user, current_database(), '${schema === 'operations' ? 'CREATE' : 'CREATE,TEMPORARY'}') AS no_database_ddl,
		has_schema_privilege(current_user, '${schema}', 'USAGE') AS schema_usage,
		has_schema_privilege(current_user, '${schema}', 'CREATE') AS schema_create
		FROM pg_roles roles WHERE rolname = current_user`);
	assert.equal(principals.length, 1);
	const { no_memberships, ...principal } = principals[0];
	same(principal, { restricted: true, database_owner_matches: true,
		schema_owner_matches: true, connect: true, no_database_ddl: true, schema_usage: true, schema_create: role === 'migration' });
	if (schema !== 'operations') assert.equal(no_memberships, true);
	const serviceIdentity = await client.$queryRawUnsafe(`SELECT id, service_name, database_id::text AS database_id FROM "${schema}".service_identity`);
	assert.equal(serviceIdentity.length, 1); assert.equal(serviceIdentity[0].id, 'singleton');
	assert.equal(serviceIdentity[0].service_name, `${schema.replaceAll('_', '-')}-service`);
	assert.match(serviceIdentity[0].database_id ?? '', /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
	return serviceIdentity[0].database_id;
}

// Pure transaction-level checks are exported for fake-query negative tests;
// only the orchestrator below constructs real, bounded READ ONLY sessions.
export async function verifyOperationsBackupDatabaseState(client, files) {
	const databaseId = await assertBackupProbeSession(client, 'operations', 'migration');
	const ledger = await client.$queryRawUnsafe('SELECT migration_name, checksum, finished_at, rolled_back_at FROM operations._prisma_migrations ORDER BY migration_name');
	assertMigrationLedger(files, ledger, NOTES_MIGRATION, true);
	const ledgerSha256 = sha256(JSON.stringify(ledger.map(row => ({ name: row.migration_name, checksum: row.checksum }))));
	// Metadata is hashed inside PostgreSQL; neither application rows nor ACL
	// contents leave this probe. Pending Notes migration is observed, not applied.
	const metadata = await client.$queryRawUnsafe(`SELECT encode(sha256(convert_to(jsonb_build_object(
		'schema', (SELECT jsonb_build_array(n.nspname, pg_get_userbyid(n.nspowner), n.nspacl::text) FROM pg_namespace n WHERE n.nspname='operations'),
		'relations', (SELECT jsonb_agg(jsonb_build_array(c.relname, c.relkind, pg_get_userbyid(c.relowner), c.relacl::text, c.relrowsecurity, c.relforcerowsecurity) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='operations'),
		'columns', (SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,a.atttypid::text,a.atttypmod,a.attnotnull,a.attacl::text,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname='operations' AND a.attnum>0 AND NOT a.attisdropped),
		'constraints', (SELECT jsonb_agg(jsonb_build_array(c.conname,pg_get_constraintdef(c.oid)) ORDER BY c.conname,c.conrelid) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='operations'),
		'indexes', (SELECT jsonb_agg(jsonb_build_array(c.relname,pg_get_indexdef(c.oid)) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='operations' AND c.relkind='i'),
		'routines', (SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_userbyid(p.proowner),p.proacl::text,pg_get_functiondef(p.oid)) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='operations'),
		'types', (SELECT jsonb_agg(jsonb_build_array(t.typname,pg_get_userbyid(t.typowner),t.typacl::text,e.enumsortorder,e.enumlabel) ORDER BY t.typname,e.enumsortorder) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace LEFT JOIN pg_enum e ON e.enumtypid=t.oid WHERE n.nspname='operations' AND t.typtype='e'),
		'defaults', (SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(d.defaclrole),d.defaclobjtype,d.defaclacl::text) ORDER BY d.defaclrole,d.defaclobjtype) FROM pg_default_acl d JOIN pg_namespace n ON n.oid=d.defaclnamespace WHERE n.nspname='operations')
	)::text,'UTF8')),'hex') AS schema_sha256`);
	assert.equal(metadata.length, 1); assert.match(metadata[0].schema_sha256 ?? '', /^[a-f0-9]{64}$/);
	const counts = [];
	for (const model of ['scheduledJobRun', 'outboxEvent', 'auditEventReceipt', 'integrationDeliveryReceipt'])
		counts.push(await client[model].count({ where: { status: 'PROCESSING' } }));
	counts.push(await client.databaseRestoreJob.count({ where: { OR: [{ status: { in: ['QUEUED', 'PROCESSING'] } }, { status: 'RECOVERY_REQUIRED', recoveryResolvedAt: null }] } }));
	counts.push(await client.databaseRestorePermit.count({ where: { status: { in: ['PENDING_APPROVAL', 'APPROVED', 'CONSUMED'] } } }));
	counts.push(await client.databaseRestoreRecoveryAction.count({ where: { status: { notIn: ['RESOLVED', 'EXPIRED'] } } }));
	counts.push(await client.outboxEvent.count({ where: { eventType: { in: ['operations.database-restore.requested.v1', 'operations.database-restore.recovery-action.requested.v1'] }, status: { in: ['PENDING', 'PROCESSING'] } } }));
	assert.ok(counts.every(count => Number.isSafeInteger(count) && count >= 0));
	const lease = await client.databaseRestoreExecutionLease.findUnique({ where: { id: 'singleton' }, select: { operationType: true, operationId: true, leaseOwner: true, leaseToken: true } });
	return { databaseId, ledgerSha256, schemaSha256: metadata[0].schema_sha256,
		quiet: counts.every(count => count === 0) && (!lease || Object.values(lease).every(value => value === null)) };
}

export async function verifyOperationsCrmBackupDatabaseState(client, target, manifest) {
	assert.ok(OPERATIONS_CRM_BACKUP_TARGETS.some(([, schema]) => schema.replaceAll('_', '-') === target));
	const schema = target.replaceAll('-', '_'), owner = `winwidget_${schema}_migration`;
	assert.equal(manifest.target, target);
	assert.equal(manifest.manifestSha256, sha256(JSON.stringify({ schemaVersion: 1, target, migrations: manifest.migrations })));
	const databaseId = await assertBackupProbeSession(client, schema, 'backup');
	const ledger = await client.$queryRawUnsafe(`SELECT migration_name, checksum, finished_at, rolled_back_at FROM "${schema}"._prisma_migrations ORDER BY migration_name`);
	same(ledger.map(row => ({ name: row.migration_name, checksum: row.checksum })), manifest.migrations);
	assert.ok(ledger.length > 0 && ledger.every(row => row.finished_at && !row.rolled_back_at));
	const foreign = await client.$queryRawUnsafe(`SELECT NOT has_schema_privilege(current_user,'public','USAGE,CREATE') AS no_public,
		NOT has_database_privilege(current_user,'postgres','CONNECT') AND NOT has_database_privilege(current_user,'template1','CONNECT') AS no_foreign_database,
		NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('${schema}','information_schema') AND nspname !~ '^pg_' AND has_schema_privilege(current_user,oid,'USAGE,CREATE')) AS no_foreign_schema`);
	same(foreign, [{ no_public: true, no_foreign_database: true, no_foreign_schema: true }]);
	const relations = await client.$queryRawUnsafe(`SELECT c.relname AS name, c.relkind::text AS kind, pg_get_userbyid(c.relowner)::text AS owner,
		c.relrowsecurity AS rls, c.relforcerowsecurity AS forced_rls,
		CASE WHEN c.relkind='r' THEN has_table_privilege(current_user,c.oid,'SELECT') ELSE false END AS readable,
		CASE WHEN c.relkind='r' THEN has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES') ELSE false END AS writable,
		CASE WHEN c.relkind='S' THEN has_sequence_privilege(current_user,c.oid,'SELECT') ELSE false END AS sequence_readable,
		CASE WHEN c.relkind='S' THEN has_sequence_privilege(current_user,c.oid,'USAGE,UPDATE') ELSE false END AS sequence_writable
		FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${schema}' ORDER BY c.relname`);
	assert.ok(relations.length > 2 && relations.length <= 1000);
	assert.equal(new Set(relations.map(row => row.name)).size, relations.length);
	for (const row of relations) {
		assert.ok(['r', 'S', 'i'].includes(row.kind)); assert.equal(row.owner, owner);
		assert.equal(row.rls, false); assert.equal(row.forced_rls, false);
		assert.equal(row.readable, row.kind === 'r'); assert.equal(row.writable, false);
		assert.equal(row.sequence_readable, row.kind === 'S'); assert.equal(row.sequence_writable, false);
	}
	for (const name of ['service_identity', '_prisma_migrations']) assert.ok(relations.some(row => row.name === name && row.kind === 'r'));
	const enums = await client.$queryRawUnsafe(`SELECT t.typname AS name, pg_get_userbyid(t.typowner)::text AS owner, has_type_privilege(current_user,t.oid,'USAGE') AS usable FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='${schema}' AND t.typtype='e' ORDER BY t.typname`);
	assert.ok(enums.length <= 100);
	for (const row of enums) { assert.equal(row.owner, owner); assert.equal(row.usable, true); }
	const routines = await client.$queryRawUnsafe(`SELECT p.proname AS name, pg_get_userbyid(p.proowner)::text AS owner,
		p.pronargs::int AS args, p.prorettype='trigger'::regtype AS trigger, p.prosecdef AS security_definer,
		has_function_privilege(current_user,p.oid,'EXECUTE') AS executable FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='${schema}' ORDER BY p.proname`);
	assert.ok(routines.length <= 100);
	for (const row of routines) { assert.equal(row.owner, owner); assert.equal(row.args, 0); assert.equal(row.trigger, true); assert.equal(row.security_definer, false); assert.equal(row.executable, false); }
	return { target, databaseId, manifestSha256: manifest.manifestSha256 };
}

export async function verifyOperationsBackupDatabases(value) {
	const input = validateOperationsBackupProbeInput(value);
	assert.equal(process.getuid(), 1001);
	const require = createRequire('/app/package.json');
	const { PrismaClient } = require('@prisma/operations-client');
	const { parseDatabaseBackupMigrationManifests } = require('/app/dist/src/maintenance/database-backup-migration-manifest.service.js');
	const manifestPath = '/app/backup-manifests/database-backup-migrations.json';
	const stat = lstatSync(manifestPath); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 2097152);
	const manifests = parseDatabaseBackupMigrationManifests(JSON.parse(readFileSync(manifestPath, 'utf8')));
	const probe = async (rawUrl, check) => {
		const url = new URL(rawUrl);
		url.searchParams.set('connection_limit', '1'); url.searchParams.set('connect_timeout', '5'); url.searchParams.set('pool_timeout', '5');
		const client = new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [] });
		try {
			return await client.$transaction(async tx => {
				await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
				await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '8s'");
				await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1s'");
				return check(tx);
			}, { isolationLevel: 'RepeatableRead', timeout: 10000, maxWait: 5000 });
		} finally { await client.$disconnect(); }
	};
	const operations = await probe(input.operationsMigrationUrl, tx => verifyOperationsBackupDatabaseState(tx, migrationFiles('/app/prisma/migrations')));
	const crm = [];
	for (const [, schema] of OPERATIONS_CRM_BACKUP_TARGETS) {
		const target = schema.replaceAll('_', '-');
		crm.push(await probe(input.crmBackupUrls[target], tx => verifyOperationsCrmBackupDatabaseState(tx, target, manifests[target])));
	}
	return { operations, crm };
}

export function validateOperationsBackupTrustInput(value) {
	try {
		backupProbeRecord(value, ['schemaVersion', 'urls']); assert.equal(value.schemaVersion, 1);
		assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 16384);
		backupProbeRecord(value.urls, OPERATIONS_BACKUP_TRUST_TARGETS.map(row => row[0]));
		for (const [target, , port] of OPERATIONS_BACKUP_TRUST_TARGETS) {
			const raw = value.urls[target], schema = target.replaceAll('-', '_');
			assert.ok(typeof raw === 'string' && raw.length > 0 && raw.length <= 4096 && !/[\s\0]/.test(raw));
			const url = new URL(raw);
			assert.equal(url.protocol, 'postgresql:'); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, port);
			assert.equal(url.pathname, `/winwidget_${schema}`); assert.equal(url.hash, '');
			assert.equal(decodeURIComponent(url.username), `winwidget_${schema}_backup`);
			assert.ok(url.password && !/[\0\r\n]/.test(decodeURIComponent(url.password)));
			same([...url.searchParams.keys()].sort(), ['schema', 'sslmode']);
			assert.equal(url.searchParams.get('schema'), schema); assert.equal(url.searchParams.get('sslmode'), 'disable');
		}
		return structuredClone(value);
	} catch { throw new Error('Invalid Operations trust input; private details suppressed'); }
}

export function createOperationsBackupTrustInput(desired) {
	try {
		const environment = desired.services['operations-worker'].environment;
		for (const [, key] of OPERATIONS_BACKUP_TRUST_TARGETS) {
			for (const [name, service] of Object.entries(desired.services))
				assert.equal(Object.hasOwn(service.environment ?? {}, key), name === 'operations-worker');
		}
		return Buffer.from(JSON.stringify(validateOperationsBackupTrustInput({ schemaVersion: 1,
			urls: Object.fromEntries(OPERATIONS_BACKUP_TRUST_TARGETS.map(([target, key]) => [target, environment[key]])) })));
	} catch { throw new Error('Cannot prepare Operations trust input; private details suppressed'); }
}

const ND_BACKUP_RECOVERED_MIGRATION = '20260828000000_remove_online_consultant_delivery_data';
// Read-only recognition of the two reviewed historical receipts. Never resolve
// migrations or discard arbitrary failed/rolled-back rows from the owner ledger.
const ND_BACKUP_RECOVERED_ROWS = Object.freeze([
	Object.freeze({
		id: '9fcc2093-f12e-4c6b-9633-0687acbc2320', migration_name: ND_BACKUP_RECOVERED_MIGRATION,
		checksum: 'c19ca8b79eae01ef55034640ed0c1fb3fd6aa9700bdd7c403e5ef6f6e7cc76e4',
		started_at: '2026-08-28 06:44:36.325562+00', finished_at: null,
		rolled_back_at: '2026-08-28 07:33:40.575583+00', applied_steps_count: 0,
		logs_fingerprint: 'd41d8cd98f00b204e9800998ecf8427e'
	}),
	Object.freeze({
		id: '18a2268c-e992-4115-82be-0c80552297bc', migration_name: ND_BACKUP_RECOVERED_MIGRATION,
		checksum: 'b87064c3e4269c660c5cd16d8e83afbfb78c3362afc8c30f1b9a9efa927d4596',
		started_at: '2026-08-28 07:37:05.763502+00', finished_at: '2026-08-28 07:37:05.780369+00',
		rolled_back_at: null, applied_steps_count: 1,
		logs_fingerprint: 'd41d8cd98f00b204e9800998ecf8427e'
	})
]);
function operationsBackupNdLedger(ledger, manifest) {
	const rows = ledger.filter(row => row.migration_name === ND_BACKUP_RECOVERED_MIGRATION);
	if (rows.length > 1 || ledger.some(row => ND_BACKUP_RECOVERED_ROWS.some(known => known.id === row.id))) {
		assert.equal(rows.length, 2);
		assert.equal(manifest.migrations.find(row => row.name === ND_BACKUP_RECOVERED_MIGRATION)?.checksum, ND_BACKUP_RECOVERED_ROWS[1].checksum);
		for (const expected of ND_BACKUP_RECOVERED_ROWS) {
			const matching = ledger.filter(row => row.id === expected.id);
			assert.equal(matching.length, 1);
			same(matching[0], expected);
		}
		return ledger.filter(row => row.id !== ND_BACKUP_RECOVERED_ROWS[0].id);
	}
	return ledger;
}

export async function verifyOperationsBackupTrustState(client, target, manifest) {
	const contract = OPERATIONS_BACKUP_TRUST_TARGETS.find(row => row[0] === target); assert.ok(contract);
	const schema = target.replaceAll('-', '_'), principal = `winwidget_${schema}_backup`;
	assert.equal(manifest.manifestSha256, contract[3]);
	assert.equal(sha256(JSON.stringify({ schemaVersion: 1, target, migrations: manifest.migrations })), contract[3]);
	assert.equal((await client.$queryRawUnsafe('SHOW transaction_read_only'))[0]?.transaction_read_only, 'on');
	assert.match((await client.$queryRawUnsafe('SHOW server_version_num'))[0]?.server_version_num ?? '', /^18\d{4}$/);
	const [session] = await client.$queryRawUnsafe(`SELECT current_database()::text AS database, current_user::text AS username,
		session_user::text AS session_user, current_schema()::text AS schema, pg_is_in_recovery() AS recovery,
		(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid`);
	assert.ok(session); const { database_oid, ...binding } = session;
	same(binding, { database: `winwidget_${schema}`, username: principal, session_user: principal, schema, recovery: false });
	assert.match(database_oid ?? '', /^[1-9][0-9]{0,9}$/); assert.ok(Number(database_oid) <= 4294967295);
	// Widgets/Identity already grant their backup role TO their own bootstrap
	// superuser, never privileges TO the backup reader. Preserve that exact edge;
	// ND has none. Unknown members, grantors or options remain rejected.
	const expectedAdminEdges = target === 'notification-delivery' ? 0 : 1;
	const role = await client.$queryRawUnsafe(`SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
		AND NOT rolreplication AND NOT rolbypassrls AS restricted,
		NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=current_user::regrole)
		AND (SELECT count(*) FROM pg_auth_members WHERE roleid=current_user::regrole)=${expectedAdminEdges}
		AND NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles a ON a.oid=m.member
			WHERE m.roleid=current_user::regrole AND NOT (a.rolname='winwidget_${schema}_admin'
			AND m.grantor=a.oid AND NOT m.admin_option AND m.inherit_option AND m.set_option
			AND a.rolsuper AND a.rolcanlogin
			AND a.oid=(SELECT datdba FROM pg_database WHERE datname=current_database()))) AS membership_contract,
		(SELECT pg_get_userbyid(datdba)='winwidget_${schema}_admin' FROM pg_database WHERE datname=current_database()) AS database_owner,
		(SELECT pg_get_userbyid(nspowner)='winwidget_${schema}_migration' FROM pg_namespace WHERE nspname='${schema}') AS schema_owner,
		has_database_privilege(current_user,current_database(),'CONNECT') AS connect,
		NOT has_database_privilege(current_user,current_database(),'CREATE') AS no_database_ddl,
		has_schema_privilege(current_user,'${schema}','USAGE') AND NOT has_schema_privilege(current_user,'${schema}','CREATE') AS read_schema,
		NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${schema}' AND
		((c.relkind IN ('r','p') AND (has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES')))
		OR (c.relkind='S' AND has_sequence_privilege(current_user,c.oid,'USAGE,UPDATE')))) AS no_dml,
		NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
		WHERE n.nspname='${schema}' AND has_function_privilege(current_user,p.oid,'EXECUTE')) AS no_routine_execute
		FROM pg_roles WHERE rolname=current_user`);
	same(role, [{ restricted: true, membership_contract: true, database_owner: true, schema_owner: true, connect: true, no_database_ddl: true, read_schema: true, no_dml: true, no_routine_execute: true }]);
	const rows = await client.$queryRawUnsafe(target === 'notification-delivery'
		? `SELECT id, migration_name, checksum,
			to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS started_at,
			to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS finished_at,
			to_char(rolled_back_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS rolled_back_at,
			applied_steps_count, md5(coalesce(logs, '')) AS logs_fingerprint
			FROM "${schema}"._prisma_migrations ORDER BY migration_name, id`
		: `SELECT id, migration_name, checksum, finished_at, rolled_back_at FROM "${schema}"._prisma_migrations ORDER BY migration_name`);
	const ledger = target === 'notification-delivery' ? operationsBackupNdLedger(rows, manifest) : rows;
	same(ledger.map(row => ({ name: row.migration_name, checksum: row.checksum })), manifest.migrations);
	assert.ok(ledger.length && ledger.every(row => row.finished_at && !row.rolled_back_at));
	let identity;
	if (target === 'notification-delivery') {
		// ND has no service_identity: never invent a service UUID. Bind the
		// endpoint/OID and immutable earliest completed ledger receipt instead.
		const first = ledger[0]; assert.equal(first.migration_name, '20260727000000_init_notification_delivery');
		assert.match(first.id ?? '', /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
		identity = { kind: 'postgres-database-ledger-anchor.v1', host: '127.0.0.1', port: contract[2], database: session.database,
			schema, databaseOid: database_oid, anchor: { id: first.id, migrationName: first.migration_name, checksum: first.checksum } };
	} else if (target === 'widgets') {
		// Widgets has its own identity shape: id='widgets-service', no service_name.
		const rows = await client.$queryRawUnsafe('SELECT id, database_id::text AS database_id FROM widgets.service_identity');
		assert.equal(rows.length, 1); assert.equal(rows[0].id, 'widgets-service');
		assert.match(rows[0].database_id ?? '', /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
		identity = { kind: 'widgets-service-identity.v1', ...rows[0] };
	} else {
		const rows = await client.$queryRawUnsafe(`SELECT id, service_name, database_id::text AS database_id FROM "${schema}".service_identity`);
		assert.equal(rows.length, 1); assert.equal(rows[0].id, 'singleton'); assert.equal(rows[0].service_name, `${target}-service`);
		assert.match(rows[0].database_id ?? '', /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
		identity = { kind: 'service-identity.v1', ...rows[0] };
	}
	const acl = await client.$queryRawUnsafe(`SELECT encode(sha256(convert_to(jsonb_build_object(
		'role', (SELECT jsonb_build_array(rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls) FROM pg_roles WHERE rolname=current_user),
		'memberships', (SELECT jsonb_agg(jsonb_build_array(roleid::text,member::text,admin_option) ORDER BY roleid,member) FROM pg_auth_members WHERE member=current_user::regrole OR roleid=current_user::regrole),
		'database', (SELECT jsonb_build_array(pg_get_userbyid(datdba),datacl::text) FROM pg_database WHERE datname=current_database()),
		'schema', (SELECT jsonb_build_array(pg_get_userbyid(nspowner),nspacl::text) FROM pg_namespace WHERE nspname='${schema}'),
		'relations', (SELECT jsonb_agg(jsonb_build_array(c.relname,pg_get_userbyid(c.relowner),c.relacl::text) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${schema}'),
		'columns', (SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,a.attacl::text) ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${schema}' AND a.attnum>0 AND NOT a.attisdropped),
		'routines', (SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_userbyid(p.proowner),p.proacl::text) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='${schema}'),
		'defaults', (SELECT jsonb_agg(jsonb_build_array(d.defaclrole::text,d.defaclobjtype,d.defaclacl::text) ORDER BY d.defaclrole,d.defaclobjtype) FROM pg_default_acl d JOIN pg_namespace n ON n.oid=d.defaclnamespace WHERE n.nspname='${schema}')
	)::text,'UTF8')),'hex') AS acl_sha256`);
	assert.equal(acl.length, 1); assert.match(acl[0].acl_sha256 ?? '', /^[a-f0-9]{64}$/);
	return { target, identitySha256: sha256(JSON.stringify(identity)), manifestSha256: manifest.manifestSha256, aclSha256: acl[0].acl_sha256 };
}

export function assertOperationsBackupTrustProof(value, before, now = Date.now()) {
	backupProbeRecord(value, ['schemaVersion', 'checkedAt', 'manifestSha256', 'targets']); assert.equal(value.schemaVersion, 1);
	assert.equal(value.manifestSha256, OPERATIONS_BACKUP_TRUST.after);
	assert.ok(instant(value.checkedAt) <= now && now - instant(value.checkedAt) <= 60000);
	same(value.targets.map(row => row.target), OPERATIONS_BACKUP_TRUST_TARGETS.map(row => row[0]));
	for (const row of value.targets) {
		backupProbeRecord(row, ['target', 'identitySha256', 'manifestSha256', 'aclSha256']);
		for (const key of ['identitySha256', 'manifestSha256', 'aclSha256']) assert.match(row[key] ?? '', /^[a-f0-9]{64}$/);
		assert.equal(row.manifestSha256, OPERATIONS_BACKUP_TRUST_TARGETS.find(item => item[0] === row.target)[3]);
	}
	if (before) same({ ...value, checkedAt: before.checkedAt }, before);
}

export async function verifyOperationsBackupTrustDatabases(value) {
	const input = validateOperationsBackupTrustInput(value); assert.equal(process.getuid(), 1001);
	const require = createRequire('/app/package.json'), { PrismaClient } = require('@prisma/operations-client');
	const bytes = readFileSync('/app/restore-manifests/database-restore-migrations.json');
	assert.equal(sha256(bytes), OPERATIONS_BACKUP_TRUST.after);
	const manifests = JSON.parse(bytes).targets, checkedAt = new Date().toISOString(), targets = [];
	for (const [target] of OPERATIONS_BACKUP_TRUST_TARGETS) {
		const url = new URL(input.urls[target]);
		url.searchParams.set('connection_limit', '1'); url.searchParams.set('connect_timeout', '5'); url.searchParams.set('pool_timeout', '5');
		const client = new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [] });
		try {
			targets.push(await client.$transaction(async tx => {
				await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY'); await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
				await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1s'");
				return verifyOperationsBackupTrustState(tx, target, manifests[target]);
			}, { isolationLevel: 'RepeatableRead', timeout: 10000, maxWait: 5000 }));
		} finally { await client.$disconnect(); }
	}
	const result = { schemaVersion: 1, checkedAt, manifestSha256: OPERATIONS_BACKUP_TRUST.after, targets };
	assertOperationsBackupTrustProof(result); return result;
}

async function main() {
	const action = process.argv[2];
	if (action === 'operations-backup-fingerprint') {
		assert.ok(['baseline', 'neighbors'].includes(process.argv[3]));
		process.stdout.write(operationsBackupFingerprint(JSON.parse(rootFileBytes('/run/scoped/backup-inventory.json', 8 * 1024 * 1024)), process.argv[3] === 'neighbors'));
	} else if (action === 'operations-backup-image') {
		assert.equal(process.getuid(), 1001); assert.equal(process.getgid(), 1001); assert.ok(['legacy', 'candidate'].includes(process.argv[3]));
		const require = createRequire('/app/package.json');
		const inventory = operationsBackupImageInventory('/app', require.resolve('@prisma/operations-client/schema.prisma'));
		if (process.argv[3] === 'candidate') {
			const backup = JSON.parse(readFileSync('/app/backup-manifests/database-backup-migrations.json'));
			const { parseDatabaseBackupMigrationManifests } = require('/app/dist/src/maintenance/database-backup-migration-manifest.service.js');
			parseDatabaseBackupMigrationManifests(backup);
			same(Object.keys(backup.targets).sort(), ['campaigns', 'crm-access', 'crm-customers', 'crm-intake', 'crm-sales', 'identity', 'notification-delivery', 'platform', 'reporting', 'support', 'widgets']);
			const restore = JSON.parse(readFileSync('/app/restore-manifests/database-restore-migrations.json'));
			for (const [target, value] of Object.entries(restore.targets)) same(backup.targets[target], value);
		}
		process.stdout.write(JSON.stringify({ ...inventory, restoreManifestText: readFileSync('/app/restore-manifests/database-restore-migrations.json', 'utf8') }));
	} else if (action === 'operations-backup-image-pair') {
		assertOperationsBackupManifestImages(JSON.parse(rootFileBytes('/run/scoped/backup-image-before.json')), JSON.parse(rootFileBytes('/run/scoped/backup-image-after.json')));
	} else if (action === 'operations-backup-trust-input') {
		process.stdout.write(createOperationsBackupTrustInput(JSON.parse(rootFileBytes('/run/scoped/desired.json', 4 * 1024 * 1024))));
	} else if (action === 'operations-backup-trust-database') {
		assert.equal(process.getuid(), 1001); assert.equal(process.getgid(), 1001);
		let size = 0; const chunks = [];
		for await (const chunk of process.stdin) { size += chunk.length; assert.ok(size <= 16384); chunks.push(chunk); }
		process.stdout.write(JSON.stringify(await verifyOperationsBackupTrustDatabases(JSON.parse(Buffer.concat(chunks).toString('utf8')))));
	} else if (action === 'operations-backup-trust-pair') {
		assert.ok(['initial', 'quiet', 'active'].includes(process.argv[3]));
		assertOperationsBackupTrustProof(JSON.parse(rootFileBytes('/run/scoped/backup-trust-current.json')),
			process.argv[3] === 'initial' ? undefined : JSON.parse(rootFileBytes('/run/scoped/backup-trust-before.json')));
	} else if (action === 'operations-backup-input') {
		process.stdout.write(createOperationsBackupProbeInput(rootFileBytes('/run/scoped-owner.env'), JSON.parse(rootFileBytes('/run/scoped/desired.json', 4 * 1024 * 1024))));
	} else if (action === 'operations-backup-database') {
		assert.equal(process.getuid(), 1001); assert.equal(process.getgid(), 1001);
		let size = 0; const chunks = [];
		for await (const chunk of process.stdin) { size += chunk.length; assert.ok(size <= 32768); chunks.push(chunk); }
		assert.ok(size > 0);
		const input = validateOperationsBackupProbeInput(JSON.parse(Buffer.concat(chunks).toString('utf8')));
		process.stdout.write(JSON.stringify(await verifyOperationsBackupDatabases(input)));
	} else if (action === 'operations-backup-database-pair') {
		assert.ok(['initial', 'quiet', 'active'].includes(process.argv[3]));
		const current = JSON.parse(rootFileBytes('/run/scoped/backup-database-current.json'));
		assert.equal(typeof current.operations.quiet, 'boolean');
		if (process.argv[3] !== 'active') assert.equal(current.operations.quiet, true);
		if (process.argv[3] !== 'initial') {
			const before = JSON.parse(rootFileBytes('/run/scoped/backup-database-before.json'));
			same({ ...current, operations: { ...current.operations, quiet: true } }, { ...before, operations: { ...before.operations, quiet: true } });
		}
	} else if (action === 'operations-backup-admission') {
		assert.match(process.env.SCOPED_REVISION ?? '', /^[a-f0-9]{40}$/); assert.match(process.env.SCOPED_INFRA_REVISION ?? '', /^[a-f0-9]{40}$/);
		assert.equal(operationsBackupFingerprint(JSON.parse(rootFileBytes('/run/scoped/backup-baseline.json', 8 * 1024 * 1024))), process.env.SCOPED_OPERATIONS_BACKUP_BASELINE_SHA256);
		const trust = JSON.parse(rootFileBytes('/run/scoped/backup-trust-current.json'));
		assertOperationsBackupTrustProof(trust, JSON.parse(rootFileBytes('/run/scoped/backup-trust-before.json')));
		const result = { schemaVersion: 1, kind: 'winwidget.operations.backup-runtime-admission.v1', revision: process.env.SCOPED_REVISION, infraRevision: process.env.SCOPED_INFRA_REVISION,
			baselineSha256: process.env.SCOPED_OPERATIONS_BACKUP_BASELINE_SHA256, imageId: JSON.parse(rootFileBytes('/run/scoped/image.json'))[0].Id,
			database: JSON.parse(rootFileBytes('/run/scoped/backup-database-current.json')), trust, admittedAt: new Date().toISOString(), recovery: 'FORWARD_ONLY' };
		writeFileSync('/run/scoped/backup-admission.json', JSON.stringify(result), { mode: 0o600, flag: 'wx' });
	} else if (action === 'operations-backup-postflight') {
		assertOperationsBackupPostflight({ live: JSON.parse(rootFileBytes('/run/scoped/backup-postflight.json', 4 * 1024 * 1024)), desired: JSON.parse(rootFileBytes('/run/scoped/desired.json', 4 * 1024 * 1024)), image: JSON.parse(rootFileBytes('/run/scoped/image.json'))[0], revision: process.env.SCOPED_REVISION });
	} else if (action === 'operations-backup-original') {
		assertOperationsBackupOriginal(JSON.parse(rootFileBytes('/run/scoped/backup-original.json', 4 * 1024 * 1024)), JSON.parse(rootFileBytes('/run/scoped/backup-baseline.json', 8 * 1024 * 1024)));
	} else if (action === 'operations-backup-complete') {
		const admission = JSON.parse(rootFileBytes('/run/scoped/backup-admission.json'));
		assert.equal(admission.revision, process.env.SCOPED_REVISION);
		const trust = JSON.parse(rootFileBytes('/run/scoped/backup-trust-current.json'));
		assertOperationsBackupTrustProof(trust, admission.trust);
		writeFileSync('/run/scoped/backup-completed.json', JSON.stringify({ ...admission, kind: 'winwidget.operations.backup-runtime-completed.v1',
			postflight: { trust, database: JSON.parse(rootFileBytes('/run/scoped/backup-database-current.json')) }, completedAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
	} else if (action === 'platform-image-inventory') platformImageInventory(process.argv[3]);
	else if (action === 'platform-http') await verifyPlatformHttp(process.argv[3]);
	else if (action === 'platform-database') await platformDatabaseAction();
	else if (action === 'platform-neighbors') process.stdout.write(platformNeighborFingerprint(JSON.parse(rootFileBytes('/run/scoped/platform-neighbors.json'))));
	else if (action === 'platform-source') {
		const before = {}, after = {};
		for (const [index, path] of Object.keys(PLATFORM_MARKETING_SOURCE).entries()) {
			before[path] = rootFileBytes(`/run/scoped/platform-source-before-${index}.ts`, 262144);
			after[path] = rootFileBytes(`/run/scoped/platform-source-after-${index}.ts`, 262144);
		}
		assertPlatformMarketingSource(before, after);
	} else if (action === 'platform-image-pair') {
		assertPlatformImages(JSON.parse(rootFileBytes('/run/scoped/platform-image-before.json')), JSON.parse(rootFileBytes('/run/scoped/platform-image-after.json')));
	} else if (action === 'backup-capture') await captureOperationsBackup();
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
			backupBaseline: process.env.SCOPED_SCOPE === 'operations-backup-runtime' ? JSON.parse(rootFileBytes('/run/scoped/backup-baseline.json', 8 * 1024 * 1024)) : undefined,
			backupBaselineSha256: process.env.SCOPED_OPERATIONS_BACKUP_BASELINE_SHA256,
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
