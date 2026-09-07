import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
	readFileSync,
	mkdtempSync,
	writeFileSync,
	rmSync,
	existsSync,
	readdirSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { test } from 'node:test'
import {
	COMMERCE_PAYLOAD_FILES,
	validateCommercePayload,
	commerceCompanionSource,
	validateCommerceCompanions
} from './crm-commerce-activation-cli.mjs'

const shell = readFileSync(
	new URL('./deploy-crm-commerce-scoped.sh', import.meta.url),
	'utf8'
)
const controller = readFileSync(
	new URL('./deploy-services-production.sh', import.meta.url),
	'utf8'
)
const sha = data => createHash('sha256').update(data).digest('hex')
test('canonical and Billing private env overlay preserves quoted strings and rejects duplicate declarations', () => {
	assert.deepEqual(
		commerceCompanionSource(
			'# canonical\nFLAG=false\nTEXT="with spaces"\n',
			"FLAG='true'\nOTHER=kept\n"
		),
		{ FLAG: 'true', TEXT: 'with spaces', OTHER: 'kept' }
	)
	for (const value of [
		'KEY=a\nKEY=b\n',
		'KEY=a\0',
		'bad-key=a\n',
		'export KEY=a\n',
		'MULTI="one\ntwo"\n'
	])
		assert.throws(() => commerceCompanionSource(value, ''))
})

const servicesRoot =
	process.env.CRM_COMMERCE_SERVICES_ROOT ??
	new URL('../../winwidget.ru_services/', import.meta.url).pathname
const validatorPath = join(
	servicesRoot,
	'.github/scripts/validate-crm-compose.mjs'
)
test(
	'real Services companion validator receives private parsed env, never the Compose YAML source',
	{ skip: !existsSync(validatorPath) },
	async () => {
		const { validateCrmCompanionCompose } = await import(
			pathToFileURL(validatorPath)
		)
		const targets = {
			IDENTITY_CRM_ACCESS_TOKEN: ['identity-api'],
			IDENTITY_NOTIFICATION_DELIVERY_TOKEN: [
				'identity-api',
				'notification-delivery-worker'
			],
			WINCRM_INVITATION_EMAIL_ENABLED: ['identity-api'],
			BILLING_CRM_ACCESS_TOKEN: ['billing-api'],
			BILLING_WINCRM_PAYMENTS_ENABLED: [
				'billing-api',
				'billing-worker',
				'billing-scheduler'
			],
			BILLING_WINCRM_RECONCILIATION_ENABLED: [
				'billing-worker',
				'billing-scheduler'
			],
			BILLING_WINCRM_FRONTEND_ORIGIN: ['billing-api', 'billing-worker'],
			BILLING_CRM_ACCESS_COMMERCE_BASE_URL: ['billing-worker'],
			BILLING_CRM_ACCESS_COMMERCE_TOKEN: ['billing-worker'],
			BILLING_WINCRM_PROVIDER_RABBITMQ_URL: ['billing-worker'],
			BILLING_WINCRM_PROVIDER_ASSERT_TOPOLOGY: ['billing-worker'],
			BILLING_WINCRM_WIDGETS_ELIGIBILITY_ENABLED: ['billing-api'],
			BILLING_WINCRM_WIDGETS_TOKEN: ['billing-api', 'widgets-service'],
			BILLING_WINCRM_CRM_INTAKE_TOKEN: ['billing-api'],
			WIDGETS_WINCRM_CONNECTOR_ENABLED: ['widgets-service'],
			WIDGETS_CRM_INTAKE_TOKEN: ['widgets-service'],
			WIDGETS_WINCRM_HTTP_TIMEOUT_MS: ['widgets-service']
		}
		const source = Object.fromEntries(
			Object.keys(targets).map(key => [
				key,
				key.endsWith('_TOKEN')
					? sha(key)
					: key.endsWith('_ENABLED')
						? 'false'
						: ''
			])
		)
		Object.assign(source, {
			BILLING_WINCRM_PAYMENTS_ENABLED: 'true',
			BILLING_WINCRM_RECONCILIATION_ENABLED: 'true',
			BILLING_WINCRM_PROVIDER_ASSERT_TOPOLOGY: 'false',
			BILLING_WINCRM_PROVIDER_RABBITMQ_URL: `amqp://winwidget-billing-wincrm-provider-worker:${'b'.repeat(64)}@127.0.0.1:5672/winwidget`,
			BILLING_CRM_ACCESS_COMMERCE_BASE_URL: 'http://127.0.0.1:5300',
			CRM_RABBITMQ_CONTRACT: 'mvp-v1',
			NOTIFICATION_DELIVERY_KINDS: 'email,telegram',
			BILLING_INTERNAL_BASE_URL: 'http://127.0.0.1:4800',
			IDENTITY_INTERNAL_BASE_URL: 'http://127.0.0.1:4900'
		})
		const config = { name: 'winwidget', services: {} }
		for (const [key, names] of Object.entries(targets))
			for (const name of names) {
				config.services[name] ??= { environment: {} }
				config.services[name].environment[key] = source[key]
			}
		config.services[
			'widgets-service'
		].environment.BILLING_INTERNAL_BASE_URL =
			source.BILLING_INTERNAL_BASE_URL
		Object.assign(
			config.services['notification-delivery-worker'].environment,
			{
				IDENTITY_INTERNAL_BASE_URL: source.IDENTITY_INTERNAL_BASE_URL,
				NOTIFICATION_DELIVERY_KINDS: source.NOTIFICATION_DELIVERY_KINDS
			}
		)
		const bytes =
			Object.entries(source)
				.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
				.join('\n') + '\n'
		assert.equal(
			validateCommerceCompanions(
				config,
				bytes,
				'',
				validateCrmCompanionCompose
			).wiringVerified,
			true
		)
		assert.throws(() =>
			validateCrmCompanionCompose(config, 'name: winwidget\nservices: {}')
		)
		assert.throws(() =>
			validateCommerceCompanions(
				config,
				bytes,
				'BILLING_WINCRM_PAYMENTS_ENABLED=false\n',
				validateCrmCompanionCompose
			)
		)
	}
)
function envelope() {
	return {
		schemaVersion: 1,
		files: COMMERCE_PAYLOAD_FILES.map(name => {
			const bytes = readFileSync(new URL(name, import.meta.url))
			return { name, sha256: sha(bytes), content: bytes.toString('utf8') }
		})
	}
}
test('exact bounded public module envelope fits unchanged SSH boundary and rejects all malformed entries', () => {
	const value = envelope(),
		bytes = JSON.stringify(value)
	assert.equal(validateCommercePayload(bytes).length, 5)
	assert.ok(
		gzipSync(bytes).toString('base64').length +
			gzipSync(shell).toString('base64').length <=
			90000
	)
	for (const mutate of [
		v => v.files.pop(),
		v => v.files.push(v.files[0]),
		v => {
			v.files[0].name = '../escape.mjs'
		},
		v => {
			v.files[0].name = '/run/escape.mjs'
		},
		v => {
			v.files[0].name = 'crm-release.mjs'
		},
		v => {
			v.files[0].sha256 = '0'.repeat(64)
		},
		v => {
			v.files[0].content = '\ud800'
		},
		v => {
			v.files[0].link = 'other'
		},
		v => {
			v.extra = true
		},
		v => {
			v.schemaVersion = 2
		},
		v => {
			const data = Buffer.alloc(131073)
			v.files[0].content = data.toString('utf8')
			v.files[0].sha256 = sha(data)
		},
		v => {
			v.files[0].content = ''
			v.files[0].sha256 = sha('')
		}
	]) {
		const next = structuredClone(value)
		mutate(next)
		assert.throws(
			() => validateCommercePayload(JSON.stringify(next)),
			undefined,
			mutate.toString()
		)
	}
	assert.throws(() => validateCommercePayload(' '.repeat(524289)))
})

test('actual bootstrap decoder validates all entries before creating any public file', () => {
	const temp = mkdtempSync(join(tmpdir(), 'crm-commerce-payload-'))
	try {
		const script = shell
			.split("<<'COMMERCE_UNPACK'\n")[1]
			.split('\nCOMMERCE_UNPACK')[0]
			.replaceAll('/run/payload', temp)
		for (const invalid of [false, true]) {
			const value = envelope()
			if (invalid) value.files.at(-1).sha256 = '0'.repeat(64)
			writeFileSync(join(temp, 'verifier.mjs'), JSON.stringify(value), {
				mode: 0o600
			})
			const result = spawnSync(process.execPath, ['--input-type=module'], {
				input: script,
				encoding: 'utf8'
			})
			assert.equal(result.status, invalid ? 1 : 0)
			if (!invalid)
				for (const name of COMMERCE_PAYLOAD_FILES) rmSync(join(temp, name))
			else assert.deepEqual(readdirSync(temp), ['verifier.mjs'])
		}
	} finally {
		rmSync(temp, { recursive: true, force: true })
	}
})

test('production router keeps old decoder unchanged and isolates commerce envelope authorization', () => {
	assert.match(controller, /release_scope.*crm-commerce-activate/)
	assert.match(controller, /EXPECTED_CRM_COMMERCE_BASELINE_SHA256/)
	assert.match(
		controller,
		/Commerce activation authorization cannot be reused by another scope/
	)
	assert.match(controller, /head -c 131073/)
	assert.match(controller, /head -c 524289/)
	assert.match(
		controller,
		/scoped_shell_base64.*scoped_node_base64.*<= 90000/
	)
	assert.match(
		controller,
		/export expected_crm_commerce_baseline_sha256="\$\{21:-\}"/
	)
	const remote = controller
		.split("<<'REMOTE_CONTROLLER'\n")[1]
		?.split('\nREMOTE_CONTROLLER')[0]
	if (remote)
		assert.equal(
			spawnSync('/bin/bash', ['-n'], { input: remote }).status,
			0
		)
})

test('real shell probe argv keeps private env on root reader only and credentials solely in bounded stdin', () => {
	const source = shell.slice(
		shell.indexOf('commerce_probe()'),
		shell.indexOf('\ncommerce_publish()')
	)
	const run = mode =>
		spawnSync('/bin/bash', ['-s'], {
			encoding: 'utf8',
			input: `set -euo pipefail
commerce_files=(crm-commerce-activation-cli.mjs crm-commerce-activation.mjs crm-commerce-database.mjs crm-release.mjs scoped-service-release.mjs)
scoped_payload_directory=/public/payload
commerce_directory=/private/state
commerce_probe_image=sha256:${'a'.repeat(64)}
commerce_billing_env=/private/billing.env
commerce_crm_env=/private/crm.env
expected_env_sha256=${'b'.repeat(64)}
expected_service_env_sha256=$expected_env_sha256
commerce_billing_hash=$expected_env_sha256
expected_crm_commerce_baseline_sha256=$expected_env_sha256
services_revision=${'a'.repeat(40)}
infra_revision=$services_revision
scoped_node_sha256=$expected_env_sha256
scoped_shell_sha256=$expected_env_sha256
expected_live_revision=$services_revision
docker(){ printf '%s\\n' "$@"; }
${source}
commerce_probe ${mode} billing
`
		})
	const db = run('database'),
		reader = run('database-input')
	assert.equal(db.status, 0)
	assert.equal(reader.status, 0)
	const args = db.stdout.split('\n')
	for (const pair of [
		['--network', 'host'],
		['--user', '1001:1001'],
		['--cap-drop', 'ALL'],
		['--log-driver', 'none'],
		['--entrypoint', 'timeout']
	])
		assert.equal(args[args.indexOf(pair[0]) + 1], pair[1])
	assert.ok(!db.stdout.includes('/private/'))
	assert.ok(!args.includes('--cap-add'))
	assert.ok(
		reader.stdout.includes('/private/billing.env:/run/owner.env:ro')
	)
	assert.ok(!reader.stdout.includes('/private/crm.env:'))
	assert.match(reader.stdout, /--network\nnone\n/)
	assert.match(reader.stdout, /--user\n0:0\n/)
})

test('failed input producer cannot launch the database target even if it emitted valid-looking bytes', () => {
	const source = shell.slice(
		shell.indexOf('commerce_databases()'),
		shell.indexOf('\ncommerce_compose()')
	)
	const result = spawnSync('/bin/bash', ['-s'], {
		encoding: 'utf8',
		input: `set -euo pipefail
commerce_directory=/must-not-write
commerce_inputs(){ return 0; }
commerce_probe(){ case "$1" in owner-image) printf 'sha256:${'a'.repeat(64)}';; database-input) printf '{"migrationUrl":"synthetic"}';return 1;; database) printf 'UNSAFE TARGET STARTED';; esac; }
${source}
commerce_databases
`
	})
	assert.notEqual(result.status, 0)
	assert.equal(result.stdout, '')
})

test('admission failure cleanup is forward-only and never restarts original readers', () => {
	const source = shell.slice(
		shell.indexOf('commerce_cleanup()'),
		shell.indexOf('\nscoped_deploy_main()')
	)
	const temp = mkdtempSync(join(tmpdir(), 'crm-commerce-admission-'))
	try {
		writeFileSync(join(temp, 'admission.json'), '{}', { mode: 0o600 })
		const result = spawnSync('/bin/bash', ['-s'], {
			encoding: 'utf8',
			input: `set -euo pipefail
commerce_directory='${temp}'
cleanup_scoped_payload(){ return 0; }
docker(){ printf 'UNSAFE DOCKER'; }
${source}
trap commerce_cleanup EXIT
exit 1
`
		})
		assert.equal(result.status, 1)
		assert.equal(result.stdout, '')
		assert.match(result.stderr, /Forward recovery only/)
	} finally {
		rmSync(temp, { recursive: true, force: true })
	}
	assert.ok(
		shell.indexOf('commerce_capture admission.json') <
			shell.indexOf('docker stop --time 90')
	)
	assert.ok(
		shell.indexOf('commerce_capture "start-$index.json"') <
			shell.indexOf('commerce_compose "$project" "$name"')
	)
	assert.ok(
		!/docker (build|start|restart)|prisma migrate|pg_dump|curl |rollback.*\(/.test(
			shell
		)
	)
})

// Exercise the actual shell loop and durable file publication with a fake
// daemon; no Docker binary, socket, network or production path is used.
function loopHarness(
	temp,
	{ unknown = false, missing = false, syncFailure = false } = {}
) {
	const publications = shell.slice(
		shell.indexOf('commerce_publish()'),
		shell.indexOf('\ncommerce_inventory()')
	)
	const admission = shell.slice(
		shell.indexOf(
			'\tif [[ ! -e "$commerce_directory/admission.json" ]]; then'
		),
		shell.indexOf('\twhile true; do')
	)
	const loop = shell.slice(
		shell.indexOf('\twhile true; do'),
		shell.indexOf('\tif ! commerce_databases ||')
	)
	return spawnSync('/bin/bash', ['-s'], {
		encoding: 'utf8',
		input: `set -euo pipefail
umask 077
commerce_directory='${temp}'
die(){ printf '%s\\n' "$1" >&2;exit 1; }
commerce_private(){ [[ -f "$1" && ! -L "$1" ]]; }
sync(){ if [[ "$2" == "$commerce_directory/admission.json" && '${syncFailure}' == true ]]; then return 1;fi; }
mv(){ if [[ "$1" == -T ]];then shift;fi;command mv "$@"; }
commerce_fence(){ return 0; }
commerce_inputs(){ return 0; }
commerce_probe(){ case "$1" in
 admit|begin|start) printf '{}';;
 select) if [[ -e "$commerce_directory/done" ]]; then printf complete;else printf '0 winwidget-crm/crm-customers-api ${'a'.repeat(64)}';fi;;
 observe) [[ '${missing}' != true ]] || return 1;printf '{}';;
 complete) printf done >"$commerce_directory/done";printf '{}';;
 *) return 1;;esac; }
docker(){ printf '%s\\n' "$*" >>"$commerce_directory/actions"; }
commerce_compose(){ printf '%s\\n' "compose $*" >>"$commerce_directory/actions"; [[ '${unknown}' != true ]]; }
sleep(){ return 0; }
${publications}
${admission}
${loop}
`
	})
}
test('actual loop issues a single create across lost response, missing replacement and later prefix resume', () => {
	const temp = mkdtempSync(join(tmpdir(), 'crm-commerce-loop-'))
	try {
		const failed = loopHarness(temp, { unknown: true })
		assert.equal(failed.status, 1)
		assert.match(failed.stderr, /Compose outcome is unknown/)
		assert.ok(
			existsSync(join(temp, 'admission.json')) &&
				existsSync(join(temp, 'start-0.json'))
		)
		const uncertain = loopHarness(temp, { missing: true })
		assert.equal(uncertain.status, 1)
		assert.match(uncertain.stderr, /forward-only start receipt retained/)
		assert.equal(
			readFileSync(join(temp, 'actions'), 'utf8')
				.split('\n')
				.filter(line => line.startsWith('compose ')).length,
			1
		)
		const resumed = loopHarness(temp)
		assert.equal(resumed.status, 0, resumed.stderr)
		assert.ok(existsSync(join(temp, 'observed-0.json')))
		const actions = readFileSync(join(temp, 'actions'), 'utf8')
			.trim()
			.split('\n')
		assert.equal(actions.length, 2)
		assert.match(actions[0], /^stop --time 90 [a-f0-9]{64}$/)
		assert.equal(actions[1], 'compose winwidget-crm crm-customers-api')
	} finally {
		rmSync(temp, { recursive: true, force: true })
	}
})
test('actual admission fsync failure after rename leaves a marker and performs no stop or create', () => {
	const temp = mkdtempSync(join(tmpdir(), 'crm-commerce-sync-'))
	try {
		const result = loopHarness(temp, { syncFailure: true })
		assert.equal(result.status, 1)
		assert.ok(existsSync(join(temp, 'admission.json')))
		assert.equal(existsSync(join(temp, 'actions')), false)
	} finally {
		rmSync(temp, { recursive: true, force: true })
	}
})
