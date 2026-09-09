import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, statSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { SUPPORT_CHAT_TARGETS, SUPPORT_CHAT_ENV_NAMES, supportChatBaseline, supportChatBaselineSha256,
	prepareSupportChatCompose, assertSupportChatFence, assertSupportChatRoute, assertSupportChatManifests, supportChatPayload, supportChatMigrationLedger } from './support-chat-release.mjs'

const oldRevision = 'a'.repeat(40), revision = 'b'.repeat(40)
const oldRoutes = [{ id: 'support-admin', pathPrefix: '/api/v1/support/admin', upstreamUrl: 'http://127.0.0.1:5100', authPolicy: 'required', timeoutMs: 60000 },
	{ id: 'crm', pathPrefix: '/api/v1/crm', upstreamUrl: 'http://127.0.0.1:5300', authPolicy: 'required', timeoutMs: 30000 }]
const route = { id: 'support-web-chat', pathPrefix: '/api/v1/support', upstreamUrl: 'http://127.0.0.1:5100', authPolicy: 'required', timeoutMs: 30000 }
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const env = values => Object.entries(values).map(([key, value]) => `${key}=${value}`)
test('ledger excludes resolved rollback history while unresolved attempts still block release', () => {
	const name = '20260828000000_remove_online_consultant_delivery_data'
	const rows = [
		{ name, checksum: 'a'.repeat(64), finished: false, rolledBack: true },
		{ name, checksum: 'b'.repeat(64), finished: true, rolledBack: false }
	]
	assert.deepEqual(supportChatMigrationLedger(rows), [{ name, checksum: 'b'.repeat(64) }])
	assert.throws(() => supportChatMigrationLedger([{ ...rows[0], rolledBack: false }, rows[1]]))
	assert.deepEqual(rows[0], { name, checksum: 'a'.repeat(64), finished: false, rolledBack: true })
})
function fixture() {
	const images = [...new Set(SUPPORT_CHAT_TARGETS.map(row => row[2]))].map((owner, index) => ({ Id: 'sha256:' + String(index + 1).repeat(64), Config: {
		Labels: { 'org.opencontainers.image.revision': revision }, Env: ['NODE_ENV=production', `APP_REVISION=${revision}`], User: 'node', Cmd: ['node', 'dist/src/main.js'], Entrypoint: null } }))
	const composes = {}, containers = SUPPORT_CHAT_TARGETS.map(([project, name, owner], index) => {
		const image = images[[...new Set(SUPPORT_CHAT_TARGETS.map(row => row[2]))].indexOf(owner)]
		const before = { NODE_ENV: 'production', APP_REVISION: oldRevision, EXISTING_SETTING: 'preserve' }
		if (name === 'api-gateway') before.GATEWAY_ROUTES_JSON = JSON.stringify(oldRoutes)
		if (name === 'identity-api') before.IDENTITY_SUPPORT_TOKEN = 'c'.repeat(64)
		if (name === 'support-api') { before.IDENTITY_SUPPORT_TOKEN = 'c'.repeat(64); before.TELEGRAM_SUPPORT_BOT_TOKEN = 'bot'; before.CORS_ALLOWED_ORIGINS = 'https://winwidget.ru,https://www.winwidget.ru' }
		if (name === 'notification-delivery-worker') before.NOTIFICATION_DELIVERY_KINDS = 'email,telegram,wincrm-invitation-email'
		const after = { ...before, APP_REVISION: revision }
		if (name === 'api-gateway') after.GATEWAY_ROUTES_JSON = JSON.stringify([...oldRoutes, route])
		if (name.startsWith('support-')) after.SUPPORT_WEB_CHAT_ENABLED = 'false'
		if (name === 'support-api') Object.assign(after, {
			SUPPORT_NOTIFICATION_DELIVERY_TOKEN: 'd'.repeat(64), SUPPORT_CRM_ACCESS_BASE_URL: 'http://127.0.0.1:5300', SUPPORT_CRM_ACCESS_TOKEN: 'e'.repeat(64),
			SUPPORT_S3_ENDPOINT: '', SUPPORT_S3_REGION: '', SUPPORT_S3_BUCKET: '', SUPPORT_S3_FORCE_PATH_STYLE: 'true', SUPPORT_S3_ACCESS_KEY_ID: '', SUPPORT_S3_SECRET_ACCESS_KEY: '' })
		if (name === 'notification-delivery-worker') Object.assign(after, { SUPPORT_INTERNAL_BASE_URL: 'http://127.0.0.1:5100', SUPPORT_NOTIFICATION_DELIVERY_TOKEN: 'd'.repeat(64), TELEGRAM_SUPPORT_BOT_TOKEN: 'bot' })
		if (name === 'crm-access-api') after.CRM_ACCESS_SUPPORT_TOKEN = 'e'.repeat(64)
		const labels = { 'com.docker.compose.project': project, 'com.docker.compose.service': name, 'com.winwidget.owner': owner, 'org.opencontainers.image.revision': oldRevision }
		const service = { image: image.Id, environment: after, labels: { 'com.winwidget.owner': owner }, network_mode: 'host', command: image.Config.Cmd,
			user: 'node', restart: 'unless-stopped', healthcheck: { test: ['CMD', 'node', '-e', 'health'], interval: '10s', timeout: '3s', retries: 6 }, stop_grace_period: '30s' }
		composes[owner] ??= { name: project, services: {}, secrets: {}, volumes: {} }; composes[owner].services[name] = service
		return { Id: (index + 1).toString(16).padStart(64, '0'), Image: 'sha256:' + 'f'.repeat(64), RestartCount: 0,
			Config: { Labels: labels, Env: env(before), User: 'node', Cmd: image.Config.Cmd, Entrypoint: null, Healthcheck: { Test: service.healthcheck.test, Interval: 10e9, Timeout: 3e9, Retries: 6 }, StopTimeout: 30 },
			HostConfig: { NetworkMode: 'host', Privileged: false, RestartPolicy: { Name: 'unless-stopped' }, LogConfig: { Type: 'json-file', Config: {} } }, Mounts: [],
			State: { Running: true, Status: 'running', StartedAt: '2026-09-10T00:00:00Z', Health: { Status: 'healthy' } } }
	})
	containers.push({ ...structuredClone(containers[0]), Id: 'f'.repeat(64), Config: { ...structuredClone(containers[0].Config), Labels: { 'com.docker.compose.project': 'winwidget', 'com.docker.compose.service': 'billing-api' } } })
	const envHashes = Object.fromEntries(SUPPORT_CHAT_ENV_NAMES.map(name => [name, '1'.repeat(64)]))
	const input = { containers, images, composes, revision, envHashes, gatewayRevision: oldRevision }
	return { ...input, expectedBaselineSha256: supportChatBaselineSha256(input) }
}
test('baseline exposes hashes only and binds each target, neighbor and complete prepared env file', () => {
	const input = fixture(), baseline = supportChatBaseline(input)
	assert.equal(baseline.targets.length, 11); assert.ok(!JSON.stringify(baseline).includes('EXISTING_SETTING'))
	for (const mutate of [value => { value.envHashes.support = '2'.repeat(64) }, value => { value.containers.at(-1).RestartCount++ }, value => { value.containers[0].Config.Env.push('UNEXPECTED=true') }]) {
		const changed = structuredClone(input); mutate(changed); assert.notEqual(supportChatBaselineSha256(changed), input.expectedBaselineSha256)
	}
})
test('release prepares only eleven owner processes and preserves unrelated live environment', () => {
	const input = fixture(), result = prepareSupportChatCompose(input)
	assert.deepEqual(Object.keys(result.desired['winwidget-crm'].services), ['crm-access-api'])
	assert.equal(Object.keys(result.desired.winwidget.services).length, 10)
	for (const config of Object.values(result.desired)) for (const service of Object.values(config.services)) assert.equal(service.environment.EXISTING_SETTING, 'preserve')
	assert.equal(result.rollback.winwidget.services['api-gateway'].environment.GATEWAY_ROUTES_JSON, JSON.stringify(oldRoutes))
	assertSupportChatFence({ before: input.containers, live: input.containers, desired: result.desired, images: input.images })
	const live = structuredClone(input.containers); live.at(-1).RestartCount++
	assert.throws(() => assertSupportChatFence({ before: input.containers, live, desired: result.desired, images: input.images }))
})
test('Gateway Compose git tag is bound to inspected revision and normalized to its immutable image ID', () => {
	const input = fixture(), service = input.composes['api-gateway'].services['api-gateway']
	const image = input.images.find(row => row.Id === service.image)
	service.image = `winwidget-api-gateway:git-${revision}`; image.RepoTags = [service.image]
	const result = prepareSupportChatCompose(input)
	assert.equal(result.desired.winwidget.services['api-gateway'].image, image.Id)
	for (const mutate of [
		value => { value.images.at(-1).RepoTags = [] },
		value => { value.composes['api-gateway'].services['api-gateway'].image = 'winwidget-api-gateway:latest' },
		value => { value.images.at(-1).Config.Labels['org.opencontainers.image.revision'] = oldRevision },
		value => { value.images.push(structuredClone(value.images.at(-1))) }
	]) { const changed = structuredClone(input); mutate(changed); assert.throws(() => prepareSupportChatCompose(changed)) }
})
test('scoped shell supplies every full-Compose application image variable from exact targets or live neighbors without a daemon', () => {
	const shellPath = resolve(dirname(fileURLToPath(import.meta.url)), 'deploy-support-chat-scoped.sh')
	const execute = mismatch => spawnSync('bash', ['-c', `
set -euo pipefail
source "$1"
die() { printf '%s\\n' "$1" >&2; exit 1; }
docker() {
 case "$1 $2" in
  'image inspect') printf '%s\\n' "$MOCK_GATEWAY_IMAGE" ;;
  'ps --no-trunc')
   [[ "$*" == *'label=com.docker.compose.project=winwidget'* ]] || return 1
   if [[ "$*" == *'label=com.docker.compose.service=crm-'* ]]; then [[ "$*" == *'label=com.docker.compose.project=winwidget-crm'* ]] || return 1; fi
   printf '%s\\n' "$MOCK_CONTAINER_ID" ;;
  'inspect --format') printf '%s %s\\n' "$MOCK_LIVE_IMAGE" "$MOCK_LIVE_REVISION" ;;
  *) return 1 ;;
 esac
}
image_env=()
for owner in "\${support_owners[@]}"; do support_image_variables "$owner" "$MOCK_TARGET_IMAGE" "$MOCK_TARGET_REVISION"; done
support_existing_compose_images
printf '%s\\n' "\${image_env[@]}"
`, 'support-compose-test', shellPath], { encoding: 'utf8', env: { PATH: process.env.PATH,
		MOCK_CONTAINER_ID: '1'.repeat(64), MOCK_LIVE_IMAGE: 'sha256:' + '2'.repeat(64), MOCK_LIVE_REVISION: oldRevision,
		MOCK_TARGET_IMAGE: 'sha256:' + '3'.repeat(64), MOCK_TARGET_REVISION: revision,
		MOCK_GATEWAY_IMAGE: 'sha256:' + (mismatch ? '4' : '3').repeat(64) } })
	const result = execute(false); assert.equal(result.status, 0, result.stderr)
	const variables = Object.fromEntries(result.stdout.trim().split('\n').map(value => value.split('=')))
	assert.equal(variables.APP_VERSION, `git-${revision}`); assert.equal(variables.APP_REVISION, revision)
	for (const owner of ['IDENTITY', 'CRM_ACCESS', 'OPERATIONS', 'NOTIFICATION_DELIVERY', 'SUPPORT']) {
		assert.equal(variables[`${owner}_IMAGE`], 'sha256:' + '3'.repeat(64)); assert.equal(variables[`${owner}_REVISION`], revision)
	}
	for (const owner of ['CAMPAIGNS', 'REPORTING', 'WIDGETS', 'BILLING', 'PLATFORM', 'CRM_INTAKE', 'CRM_CUSTOMERS', 'CRM_SALES']) {
		assert.equal(variables[`${owner}_IMAGE`], 'sha256:' + '2'.repeat(64)); assert.equal(variables[`${owner}_REVISION`], oldRevision)
	}
	assert.equal(Object.keys(variables).length, 28)
	assert.notEqual(execute(true).status, 0)
})
test('database and quiet helpers retain the image user and mount readable code without the private payload directory', () => {
	const shellPath = resolve(dirname(fileURLToPath(import.meta.url)), 'deploy-support-chat-scoped.sh')
	const directory = mkdtempSync(resolve(tmpdir(), 'support-owner-probe-'))
	const names = ['support-chat-release.mjs', 'support-chat-broker.mjs', 'scoped-service-release.mjs']
	try {
		chmodSync(directory, 0o700)
		for (const name of names) writeFileSync(resolve(directory, name), 'export {};\n', { mode: 0o444 })
		const result = spawnSync('bash', ['-c', `
set -euo pipefail
source "$1"
docker() { printf 'CALL\\0'; printf '%s\\0' "$@"; }
die() { exit 1; }
support_fence() { return 0; }
services_repository=/owner
services_revision=$MOCK_REVISION
scoped_payload_directory=$MOCK_PAYLOAD
support_env_files=(/canonical /identity /notification /operations /support /crm)
support_database identity database-preflight
support_database notification-delivery database-migrate
support_quiet
`, 'support-owner-probe-test', shellPath], { encoding: 'utf8', env: { PATH: process.env.PATH, MOCK_PAYLOAD: directory, MOCK_REVISION: revision } })
		assert.equal(result.status, 0, result.stderr)
		const calls = result.stdout.split('CALL\0').slice(1).map(value => value.split('\0').filter(Boolean))
		assert.equal(calls.length, 3)
		for (const args of calls) {
			assert.equal(args[0], 'run'); assert.ok(!args.includes('--user')); assert.ok(!args.includes('--cap-add'))
			assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL')
			const mounts = args.flatMap((value, index) => value === '--volume' ? [args[index + 1]] : [])
			assert.deepEqual(mounts, names.map(name => `${directory}/${name}:/run/support-code/${name}:ro`))
			for (const name of names) assert.equal(statSync(resolve(directory, name)).mode & 0o777, 0o444)
		}
		assert.equal(statSync(directory).mode & 0o777, 0o700)
	} finally { rmSync(directory, { recursive: true, force: true }) }
})
test('release rejects early activation, credential leaks, changed neighbors and unrelated env edits', () => {
	for (const mutate of [
		value => { value.composes.support.services['support-worker'].environment.SUPPORT_WEB_CHAT_ENABLED = 'true' },
		value => { value.composes.support.services['support-api'].environment.CORS_ALLOWED_ORIGINS += ',https://crm.winwidget.ru' },
		value => { value.composes.support.services['support-outbox-publisher'].environment.SUPPORT_S3_SECRET_ACCESS_KEY = 'leak' },
		value => { value.composes.identity.services['identity-api'].environment.EXISTING_SETTING = 'changed' },
		value => { value.composes['notification-delivery'].services['notification-delivery-worker'].environment.NOTIFICATION_DELIVERY_KINDS += ',support-team-email' },
		value => { value.composes['crm-access'].services['crm-access-api'].environment.CRM_ACCESS_SUPPORT_TOKEN = 'd'.repeat(64) },
		value => { value.containers.at(-1).RestartCount++ }
	]) { const input = fixture(); mutate(input); assert.throws(() => prepareSupportChatCompose(input)) }
})
test('authenticated Support route preserves existing support-admin and all other routes', () => {
	assertSupportChatRoute(JSON.stringify(oldRoutes), JSON.stringify([...oldRoutes, route]))
	for (const routes of [[...oldRoutes, { ...route, authPolicy: 'optional' }], [route], [...oldRoutes, route, { ...route, pathPrefix: '/api/v1/support/internal' }]]) assert.throws(() => assertSupportChatRoute(JSON.stringify(oldRoutes), JSON.stringify(routes)))
})
test('separate activation reuses existing immutable images and appends only three independent readers', () => {
	const input = fixture()
	Object.assign(input.composes.support.services['support-api'].environment, { SUPPORT_S3_ENDPOINT: 'https://storage.example.invalid', SUPPORT_S3_REGION: 'region', SUPPORT_S3_BUCKET: 'support', SUPPORT_S3_ACCESS_KEY_ID: 'key', SUPPORT_S3_SECRET_ACCESS_KEY: 'secret' })
	const released = prepareSupportChatCompose(input), containers = structuredClone(input.containers), composes = {}
	for (const [project, name, owner] of SUPPORT_CHAT_TARGETS) {
		const service = released.desired[project].services[name]
		const row = containers.find(row => row.Config.Labels['com.docker.compose.service'] === name)
		row.Image = service.image; row.Config.Env = env(service.environment); row.Config.Labels['org.opencontainers.image.revision'] = revision
		composes[owner] ??= { name: project, services: {}, secrets: {}, volumes: {} }; composes[owner].services[name] = structuredClone(service)
	}
	for (const name of ['support-api', 'support-worker', 'support-outbox-publisher']) composes.support.services[name].environment.SUPPORT_WEB_CHAT_ENABLED = 'true'
	composes.support.services['support-api'].environment.CORS_ALLOWED_ORIGINS += ',https://crm.winwidget.ru'
	composes['notification-delivery'].services['notification-delivery-worker'].environment.NOTIFICATION_DELIVERY_KINDS += ',support-team-email,support-team-telegram,support-client-email'
	const activation = { ...input, containers, composes, activation: true, gatewayRevision: revision, revision: 'c'.repeat(40) }
	activation.expectedBaselineSha256 = supportChatBaselineSha256(activation)
	const result = prepareSupportChatCompose(activation)
	for (const [project, name] of SUPPORT_CHAT_TARGETS) {
		const service = result.desired[project].services[name]
		assert.equal(service.environment.APP_REVISION, revision)
		assert.equal(service.image, containers.find(row => row.Config.Labels['com.docker.compose.service'] === name).Image)
	}
	assert.equal(result.desired.winwidget.services['support-api'].environment.SUPPORT_WEB_CHAT_ENABLED, 'true')
	assert.equal(result.desired.winwidget.services['support-api'].environment.CORS_ALLOWED_ORIGINS, 'https://winwidget.ru,https://www.winwidget.ru,https://crm.winwidget.ru')
	const existingCors = structuredClone(activation)
	const supportApi = existingCors.containers.find(row => row.Config.Labels['com.docker.compose.service'] === 'support-api')
	supportApi.Config.Env = supportApi.Config.Env.map(value => value.startsWith('CORS_ALLOWED_ORIGINS=') ? value + ',https://crm.winwidget.ru' : value)
	existingCors.expectedBaselineSha256 = supportChatBaselineSha256(existingCors)
	assert.equal(prepareSupportChatCompose(existingCors).desired.winwidget.services['support-api'].environment.CORS_ALLOWED_ORIGINS,
		result.desired.winwidget.services['support-api'].environment.CORS_ALLOWED_ORIGINS)
	for (const cors of ['https://crm.winwidget.ru', 'https://winwidget.ru,https://www.winwidget.ru,https://evil.example', '*', 'https://winwidget.ru,https://www.winwidget.ru']) {
		const changed = structuredClone(activation)
		changed.composes.support.services['support-api'].environment.CORS_ALLOWED_ORIGINS = cors
		assert.throws(() => prepareSupportChatCompose(changed))
	}
	const workerLeak = structuredClone(activation)
	workerLeak.composes.support.services['support-worker'].environment.CORS_ALLOWED_ORIGINS = 'https://crm.winwidget.ru'
	assert.throws(() => prepareSupportChatCompose(workerLeak))
	activation.composes['notification-delivery'].services['notification-delivery-worker'].environment.NOTIFICATION_DELIVERY_KINDS = 'support-team-email,support-team-telegram,support-client-email'
	assert.throws(() => prepareSupportChatCompose(activation))
})
test('backup manifest cannot introduce unrelated migrations or revise historical checksums', () => {
	const previous = { schemaVersion: 1, targets: { support: { migrations: [{ name: 'old', checksum: 'c' }], manifestSha256: 'old' }, identity: { migrations: [], manifestSha256: 'same' } } }
	const next = structuredClone(previous); next.targets.support.migrations.push({ name: '20260909160000_add_web_support_chat', checksum: 'd' })
	next.targets.support.manifestSha256 = hash({ schemaVersion: 1, target: 'support', migrations: next.targets.support.migrations })
	assertSupportChatManifests(previous, next)
	next.targets.identity.migrations.push({ name: 'unrelated', checksum: 'e' }); assert.throws(() => assertSupportChatManifests(previous, next))
})
test('existing immutable SSH controller dispatches the bounded payload and never broadens to all', () => {
	const root = dirname(fileURLToPath(import.meta.url)), payload = JSON.stringify(supportChatPayload(root))
	assert.ok(Buffer.byteLength(payload) <= 393216)
	const shell = readFileSync(resolve(root, 'deploy-support-chat-scoped.sh'), 'utf8')
	assert.ok(gzipSync(payload).length * 4 / 3 + gzipSync(shell).length * 4 / 3 < 90000)
	assert.ok(shell.includes('--no-deps --no-build --pull never'))
	assert.ok(!shell.includes('docker compose down') && !shell.includes('rabbitmqctl'))
	const controller = readFileSync(resolve(root, 'deploy-services-production.sh'), 'utf8')
	assert.ok(controller.includes('EXPECTED_SUPPORT_CHAT_BASELINE_SHA256') && controller.includes('deploy-support-chat-scoped.sh'))
})
