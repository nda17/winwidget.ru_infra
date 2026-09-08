import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { test } from 'node:test'
import {
	REMINDERS_PAYLOAD_FILES,
	INTAKE_SLA_PAYLOAD_FILES,
	crmActivationKind,
	validateRemindersPayload,
	parseReminderEnv,
	verifyReminderReadiness
} from './crm-reminders-activation-cli.mjs'

const shell = readFileSync(
	new URL('./deploy-crm-reminders-scoped.sh', import.meta.url),
	'utf8'
)
const hash = value => createHash('sha256').update(value).digest('hex')
test('private parser and immutable payload refuse duplicates, traversal, altered bytes and oversized entries', () => {
	assert.deepEqual(parseReminderEnv('KEY="quoted value"\nFLAG=true\n'), {
		KEY: 'quoted value',
		FLAG: 'true'
	})
	for (const value of [
		'KEY=a\nKEY=b\n',
		'export KEY=a\n',
		'KEY=x\0',
		'bad-key=y'
	])
		assert.throws(() => parseReminderEnv(value))
	const pack = spawnSync(
		process.execPath,
		[
			new URL('./crm-reminders-activation-cli.mjs', import.meta.url)
				.pathname,
			'pack'
		],
		{ encoding: 'utf8' }
	)
	assert.equal(pack.status, 0, pack.stderr)
	const parsed = JSON.parse(pack.stdout)
	assert.deepEqual(
		validateRemindersPayload(pack.stdout).map(row => row.name),
		REMINDERS_PAYLOAD_FILES
	)
	assert.ok(Buffer.byteLength(pack.stdout) <= 524288)
	const boundary = structuredClone(parsed)
	boundary.files[0].content = 'x'.repeat(147456)
	boundary.files[0].sha256 = hash(boundary.files[0].content)
	assert.equal(
		validateRemindersPayload(JSON.stringify(boundary)).length,
		REMINDERS_PAYLOAD_FILES.length
	)
	assert.ok(
		gzipSync(pack.stdout).toString('base64').length +
			gzipSync(shell).toString('base64').length <=
			112000
	)
	assert.throws(() => validateRemindersPayload(' '.repeat(524289)))
	for (const mutate of [
		value => {
			value.files[0].name = '../escape'
		},
		value => {
			value.files[0].content += 'changed'
		},
		value => {
			value.files.push(value.files[0])
		},
		value => {
			value.files[0].content = 'x'.repeat(147457)
			value.files[0].sha256 = hash(value.files[0].content)
		}
	]) {
		const value = structuredClone(parsed)
		mutate(value)
		assert.throws(() => validateRemindersPayload(JSON.stringify(value)))
	}
	assert.equal(spawnSync('/bin/bash', ['-n'], { input: shell }).status, 0)
})
test('readiness is a bounded authenticated GET on fixed loopback and cannot become a provider send', async () => {
	const token = 'a'.repeat(64),
		at = new Date().toISOString(),
		calls = []
	const good = {
		schemaVersion: 1,
		ready: true,
		checkedAt: at,
		channels: ['EMAIL', 'TELEGRAM']
	}
	const response = body =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'cache-control': 'no-store' }
		})
	assert.deepEqual(
		await verifyReminderReadiness({ token }, async (url, init) => {
			calls.push({ url, init })
			return response(good)
		}),
		good
	)
	assert.equal(calls.length, 1)
	assert.equal(
		calls[0].url,
		'http://127.0.0.1:4401/internal/v1/crm-sales/task-reminders/readiness'
	)
	assert.equal(calls[0].init.method, 'GET')
	assert.equal(calls[0].init.redirect, 'error')
	assert.deepEqual(calls[0].init.headers, {
		'x-winwidget-service': 'crm-sales',
		'x-winwidget-internal-token': token
	})
	assert.equal(calls[0].init.body, undefined)
	for (const invalid of [
		{ ...good, ready: false },
		{ ...good, channels: ['EMAIL'] },
		{ ...good, checkedAt: '2020-01-01T00:00:00Z' },
		{ ...good, extra: 'x'.repeat(8192) }
	])
		await assert.rejects(
			verifyReminderReadiness({ token }, async () => response(invalid))
		)
	await assert.rejects(
		verifyReminderReadiness(
			{ token },
			async () => new Response('{}', { status: 503 })
		)
	)
	const result = spawnSync(
		process.execPath,
		[
			new URL('./crm-reminders-activation-cli.mjs', import.meta.url)
				.pathname,
			'readiness'
		],
		{ input: '{"token":"synthetic-private"}', encoding: 'utf8' }
	)
	assert.equal(result.status, 1)
	assert.equal(result.stdout, '')
	assert.equal(result.stderr.includes('synthetic-private'), false)
})
test('SLA packaging is bounded, kind-specific and its readiness cannot use Sales credentials path', async () => {
	const kind = crmActivationKind('crm-intake-sla-activate')
	const pack = spawnSync(
		process.execPath,
		[
			new URL('./crm-reminders-activation-cli.mjs', import.meta.url)
				.pathname,
			'pack'
		],
		{
			encoding: 'utf8',
			env: {
				...process.env,
				REMINDERS_ACTIVATION_SCOPE: 'crm-intake-sla-activate'
			}
		}
	)
	assert.equal(pack.status, 0, pack.stderr)
	assert.deepEqual(
		validateRemindersPayload(pack.stdout, kind).map(row => row.name),
		INTAKE_SLA_PAYLOAD_FILES
	)
	assert.throws(() => validateRemindersPayload(pack.stdout))
	assert.ok(
		gzipSync(pack.stdout).toString('base64').length +
			gzipSync(shell).toString('base64').length <=
			116000
	)
	const router = readFileSync(
		new URL('./deploy-services-production.sh', import.meta.url),
		'utf8'
	)
	const commandSource = router.slice(
		router.indexOf("printf -v remote_controller_arguments ' %q'"),
		router.indexOf('# Stage the complete controller')
	)
	const values = Object.fromEntries(
		[...commandSource.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map(
			([, name]) => [name, 'a'.repeat(64)]
		)
	)
	Object.assign(values, {
		release_scope: 'crm-intake-sla-activate',
		scoped_shell_base64: gzipSync(shell, { level: 6 }).toString('base64'),
		scoped_node_base64: gzipSync(pack.stdout, { level: 6 }).toString(
			'base64'
		),
		backend_nginx_base64: readFileSync(
			new URL('../nginx/backend-api.conf', import.meta.url)
		).toString('base64')
	})
	const transport = spawnSync('/bin/bash', ['-s'], {
		encoding: 'utf8',
		env: { PATH: process.env.PATH, ...values },
		input: `set -euo pipefail\ndie(){ exit 1; }\n${commandSource}\nprintf '%s' "\${#remote_controller_command}"\n`
	})
	assert.equal(transport.status, 0, transport.stderr)
	assert.ok(Number(transport.stdout) < 131072)
	assert.match(
		router,
		/elif \[\[ "\$release_scope" == crm-reminders-activate[^\n]+\n\s*\(\( \$\{#scoped_shell_base64\} \+ \$\{#scoped_node_base64\} <= 112000/
	)
	assert.match(router, /scoped_shell_base64.*scoped_node_base64.*<= 90000/)
	assert.throws(() => crmActivationKind('all'))
	const result = {
		schemaVersion: 1,
		ready: true,
		checkedAt: new Date().toISOString(),
		channels: ['EMAIL', 'TELEGRAM']
	}
	await verifyReminderReadiness(
		{ token: 'a'.repeat(64) },
		async (url, init) => {
			assert.equal(
				url,
				'http://127.0.0.1:4401/internal/v1/crm-intake/sla/readiness'
			)
			assert.equal(init.headers['x-winwidget-service'], 'crm-intake')
			assert.equal(init.method, 'GET')
			assert.equal(init.body, undefined)
			return new Response(JSON.stringify(result), {
				headers: { 'cache-control': 'no-store' }
			})
		},
		Date.now(),
		kind
	)
})
test('actual probe argv isolates owner DB credentials on stdin and keeps three whole envs on root-only reader', () => {
	const source = shell.slice(
		shell.indexOf('reminders_probe()'),
		shell.indexOf('\nreminders_publish()')
	)
	const run = (mode, owner = 'crm-sales') =>
		spawnSync('/bin/bash', ['-s'], {
			encoding: 'utf8',
			input: `set -euo pipefail
reminders_files=(${REMINDERS_PAYLOAD_FILES.join(' ')})
scoped_payload_directory=/public/payload
reminders_directory=/private/state
release_scope=crm-reminders-activate
reminders_owner=crm-sales
reminders_validator=validate-crm-reminders-compose.mjs
reminders_probe_image=sha256:${'a'.repeat(64)}
reminders_notification_env=/private/notification.env
reminders_crm_env=/private/crm.env
env_file=/private/canonical.env
release_root=/public/services
expected_env_sha256=${'b'.repeat(64)}
expected_service_env_sha256=$expected_env_sha256
reminders_notification_hash=$expected_env_sha256
expected_crm_reminders_baseline_sha256=$expected_env_sha256
services_revision=${'a'.repeat(40)}
infra_revision=$services_revision
scoped_node_sha256=$expected_env_sha256
scoped_shell_sha256=$expected_env_sha256
expected_live_revision=$services_revision
docker(){ printf '%s\\n' "$@"; }
${source}
reminders_probe ${mode} ${owner}
`
		})
	for (const owner of ['crm-sales', 'notification-delivery']) {
		const db = run('database', owner),
			reader = run('database-input', owner)
		assert.equal(db.status, 0, db.stderr)
		assert.equal(reader.status, 0, reader.stderr)
		assert.match(db.stdout, /--network\nhost\n/)
		assert.match(db.stdout, /--user\n1001:1001\n/)
		assert.equal(db.stdout.includes('/private/'), false)
		assert.equal(db.stdout.includes('--env-file'), false)
		assert.match(
			db.stdout,
			new RegExp(
				'crm-release\\.mjs\\nupgrade-database\\n' + owner + '\\ncomplete'
			)
		)
		assert.match(reader.stdout, /--network\nnone\n/)
		assert.match(reader.stdout, /--user\n0:0\n/)
		assert.ok(
			reader.stdout.includes(
				'/private/' +
					(owner === 'crm-sales' ? 'crm' : 'notification') +
					'.env:/run/owner.env:ro'
			)
		)
	}
	const prepare = run('prepare')
	for (const value of [
		'/private/canonical.env:/run/canonical.env:ro',
		'/private/crm.env:/run/crm.env:ro',
		'/private/notification.env:/run/notification-delivery.env:ro',
		'validate-crm-reminders-compose.mjs'
	])
		assert.ok(prepare.stdout.includes(value))
	const readiness = run('readiness')
	assert.equal(readiness.stdout.includes('/private/'), false)
	assert.match(readiness.stdout, /--network\nhost\n/)
})
test('failed secret handoff producer cannot launch a database probe after partial output', () => {
	const source = shell.slice(
		shell.indexOf('reminders_databases()'),
		shell.indexOf('\nreminders_readiness()')
	)
	const result = spawnSync('/bin/bash', ['-s'], {
		encoding: 'utf8',
		input: `set -euo pipefail
reminders_directory=/must-not-write
reminders_owner=crm-sales
reminders_inputs(){ return 0; }
reminders_probe(){ case "$1" in owner-image) printf 'sha256:${'a'.repeat(64)}';; source) return 0;; database-input) printf '{"migrationUrl":"synthetic"}';return 1;; database) printf 'UNSAFE PROBE';; esac; }
${source}
reminders_databases
`
	})
	assert.notEqual(result.status, 0)
	assert.equal(result.stdout, '')
})
function loopHarness(
	temp,
	{
		index = 0,
		unknown = false,
		missing = false,
		syncFailure = false,
		brokerFailure = false,
		readiness = true,
		sla = false
	} = {}
) {
	const publication = shell.slice(
		shell.indexOf('reminders_publish()'),
		shell.indexOf('\nreminders_inventory()')
	)
	const admission = shell.slice(
		shell.indexOf(
			'\tif [[ ! -e "$reminders_directory/admission.json" ]]; then'
		),
		shell.indexOf('\twhile true; do')
	)
	const loop = shell.slice(
		shell.indexOf('\twhile true; do'),
		shell.indexOf('\tif ! reminders_databases ||')
	)
	const key = (
		sla
			? [
					'winwidget/notification-delivery-worker',
					'winwidget-crm/crm-intake-sla-worker',
					'winwidget-crm/crm-intake-sla-publisher',
					'winwidget-crm/crm-intake-api'
				]
			: [
					'winwidget/notification-delivery-worker',
					'winwidget-crm/crm-sales-reminders',
					'winwidget-crm/crm-sales-api'
				]
	)[index]
	return spawnSync('/bin/bash', ['-s'], {
		encoding: 'utf8',
		input: `set -euo pipefail
umask 077
reminders_directory='${temp}'
reminders_owner=${sla ? 'crm-intake' : 'crm-sales'}
die(){ printf '%s\\n' "$1" >&2;exit 1; }
reminders_private(){ [[ -f "$1" && ! -L "$1" ]]; }
sync(){ if [[ "$2" == "$reminders_directory/admission.json" && '${syncFailure}' == true ]];then return 1;fi; }
mv(){ if [[ "$1" == -T ]];then shift;fi;command mv "$@"; }
reminders_fence(){ return 0; }
reminders_inputs(){ return 0; }
reminders_readiness(){ [[ '${readiness}' == true ]]; }
reminders_broker(){ printf 'broker\\n' >>"$reminders_directory/actions"; [[ '${brokerFailure}' != true ]] || return 1; printf '{}' >"$reminders_directory/broker.json"; }
reminders_probe(){ case "$1" in
admit|begin|start) printf '{}';;
broker-check) [[ -e "$reminders_directory/broker.json" ]];;
select) if [[ -e "$reminders_directory/done" ]];then printf complete;else printf '${index} ${key} ${index === 1 || (sla && index === 2) ? 'absent' : 'a'.repeat(64)}';fi;;
observe) [[ '${missing}' != true ]] || return 1;printf '{}';;
complete) printf done >"$reminders_directory/done";printf '{}';;
*) return 1;;esac; }
docker(){ printf '%s\\n' "$*" >>"$reminders_directory/actions"; }
reminders_compose(){ printf '%s\\n' "compose $*" >>"$reminders_directory/actions"; [[ '${unknown}' != true ]]; }
sleep(){ return 0; }
${publication}
${admission}
${loop}
`
	})
}
test('actual loop records one create on lost outcome and resumes by observation, never repeated recreation', () => {
	for (const index of [0, 1]) {
		const temp = mkdtempSync(join(tmpdir(), 'crm-reminders-loop-'))
		try {
			const failed = loopHarness(temp, { index, unknown: true })
			assert.equal(failed.status, 1)
			assert.match(failed.stderr, /outcome is unknown/)
			assert.ok(
				existsSync(join(temp, 'admission.json')) &&
					existsSync(join(temp, 'start-' + index + '.json'))
			)
			const unknown = loopHarness(temp, { index, missing: true })
			assert.equal(unknown.status, 1)
			assert.match(unknown.stderr, /forward-only start receipt retained/)
			const resumed = loopHarness(temp, { index })
			assert.equal(resumed.status, 0, resumed.stderr)
			const actions = readFileSync(join(temp, 'actions'), 'utf8')
				.trim()
				.split('\n')
			assert.equal(
				actions.filter(line => line.startsWith('compose ')).length,
				1
			)
			assert.equal(actions.filter(line => line === 'broker').length, 1)
			assert.equal(
				actions.filter(line => line.startsWith('stop ')).length,
				index === 1 ? 0 : 1
			)
		} finally {
			rmSync(temp, { recursive: true, force: true })
		}
	}
})
test('actual admission fsync and broker failure cannot start targets; failed ND readiness cannot advance', () => {
	for (const options of [
		{ syncFailure: true },
		{ brokerFailure: true },
		{ readiness: false }
	]) {
		const temp = mkdtempSync(join(tmpdir(), 'crm-reminders-gate-'))
		try {
			const result = loopHarness(temp, options)
			assert.equal(result.status, 1)
			assert.ok(existsSync(join(temp, 'admission.json')))
			assert.equal(existsSync(join(temp, 'done')), false)
			const actions = existsSync(join(temp, 'actions'))
				? readFileSync(join(temp, 'actions'), 'utf8')
				: ''
			if (options.syncFailure || options.brokerFailure)
				assert.equal(actions.includes('compose '), false)
		} finally {
			rmSync(temp, { recursive: true, force: true })
		}
	}
})
test('SLA actual shell loop starts exactly two new roles and retains unknown-create receipts', () => {
	for (const index of [0, 1, 2, 3]) {
		const temp = mkdtempSync(join(tmpdir(), 'crm-intake-sla-loop-'))
		try {
			const failed = loopHarness(temp, { index, sla: true, unknown: true })
			assert.equal(failed.status, 1)
			assert.match(failed.stderr, /outcome is unknown/)
			const resumed = loopHarness(temp, { index, sla: true })
			assert.equal(resumed.status, 0, resumed.stderr)
			const actions = readFileSync(join(temp, 'actions'), 'utf8')
				.trim()
				.split('\n')
			assert.equal(
				actions.filter(line => line.startsWith('compose ')).length,
				1
			)
			assert.equal(
				actions.filter(line => line.startsWith('stop ')).length,
				index === 1 || index === 2 ? 0 : 1
			)
		} finally {
			rmSync(temp, { recursive: true, force: true })
		}
	}
})
test('controller has forward-only cleanup, complete owner probes and no build/migration/provider mutation command', () => {
	const cleanup = shell.slice(
		shell.indexOf('reminders_cleanup()'),
		shell.indexOf('\nscoped_deploy_main()')
	)
	assert.match(cleanup, /Forward recovery only/)
	assert.doesNotMatch(cleanup, /docker|rollback\(/)
	assert.doesNotMatch(
		shell,
		/docker (build|start|restart)|prisma migrate|pg_dump|curl /
	)
	assert.ok(
		shell.indexOf('reminders_capture "start-$index.json"') <
			shell.indexOf('reminders_compose "$project" "$name"')
	)
	assert.ok(shell.includes('args=(upgrade-database "$argument" complete)'))
	assert.ok(
		shell.includes('for owner in "$reminders_owner" notification-delivery')
	)
	assert.ok(shell.includes('CRM_BOOTSTRAP_CONTROLLER_PROTOCOL=stdio-v1'))
})
