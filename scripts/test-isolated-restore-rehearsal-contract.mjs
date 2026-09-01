import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const scriptPath = new URL(
	'./run-isolated-restore-rehearsal.sh',
	import.meta.url
)
const workflowPath = new URL('../.github/workflows/ci.yml', import.meta.url)
const script = readFileSync(scriptPath, 'utf8')
const workflow = readFileSync(workflowPath, 'utf8')

const requireText = value => {
	assert(script.includes(value), `rehearsal contract is missing: ${value}`)
}

for (const value of [
	"readonly deploy_lock=\"$deploy_state_directory/.production-deploy.lock\"",
	"readonly rehearsal_lock=\"$deploy_state_directory/.isolated-restore-rehearsal.lock\"",
	"[[ -z \"${DOCKER_HOST:-}\" && -z \"${DOCKER_CONTEXT:-}\" ]]",
	"'unix:///var/run/docker.sock'",
	"readonly postgres_image='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'",
	"\"$postgres_volumes\" == '/var/lib/postgresql'",
	"grep -Fx 'PGDATA=/var/lib/postgresql/18/docker'",
	'--network none',
	'--network "container:$postgres_container_id"',
	'--read-only',
	'--cap-drop ALL',
	'--security-opt no-new-privileges',
	"--tmpfs '/var/lib/postgresql:rw,noexec,nosuid,nodev,size=1g,uid=999,gid=999,mode=0700'",
	"--tmpfs '/work:rw,noexec,nosuid,nodev,size=1g,uid=1001,gid=1001,mode=0700'",
	"--env 'DATABASE_RESTORE_ENABLED=false'",
	'OPERATIONS_RESTORE_ARTIFACT_REHEARSAL_ALLOW_MUTATION=true',
	'noProductionEnvironment',
	'artifact_set_digest',
	'LC_ALL=C sort -z',
	'assert_rehearsal_container',
	'remove_exact_container',
	'postgres_bind_mounts=',
	'runner_bind_mounts=',
	'expected_postgres_tmpfs=',
	'expected_runner_tmpfs=',
		'expected_postgres_environment=',
		'expected_runner_environment=',
		'evidence_validator_source',
		'node --eval "$evidence_validator_source" "$runner_script"',
		"process.argv[1] === '--validate-stdin'",
		"docker ps -aq --no-trunc --filter \"label=com.winwidget.purpose=$purpose_label\"",
	"readonly postgres_memory_limit='2g'",
	"readonly runner_memory_limit='2g'",
	'readonly postgres_memory_limit_bytes=$((2 * 1024 * 1024 * 1024))',
	'readonly runner_memory_limit_bytes=$((2 * 1024 * 1024 * 1024))',
	'readonly live_host_memory_reserve_bytes=$((2 * 1024 * 1024 * 1024))',
	`readonly required_memory_available_bytes=$((
	postgres_memory_limit_bytes +
		runner_memory_limit_bytes +
		live_host_memory_reserve_bytes
))`,
	'memory_available_bytes >= required_memory_available_bytes',
	'{{.HostConfig.MemorySwap}}',
	'memory_available_bytes',
	'disk_available_bytes',
	'disk_available_bytes="$(df -PB1',
	'mv tr sed df; do',
	'all_containers_before',
	'running_containers_before',
	'volumes_before',
	'networks_before',
	'cleanup_rehearsal ||',
	'isolated_restore_rehearsal=SUCCEEDED'
]) {
	requireText(value)
}

for (const forbidden of [
	/\bdocker\s+compose\b/,
	/--env-file\b/,
	/\.env\.production/,
	/restore-staging/,
	/restore-sealed/,
	/\bdocker\s+(?:system|container|image|builder|buildx|volume|network)\s+prune\b/,
	/\bdocker\s+(?:volume|network|image)\s+rm\b/,
	/\bdocker\s+container\s+rm\s+(?:-f|--force)\b/,
	/\brm\s+-rf\b/,
	/TELEGRAM_[A-Z_]*=/,
	/RABBITMQ_[A-Z_]*=/,
	/DATABASE_URL=/,
	/DATABASE_BACKUP_PROVENANCE_PRIVATE_KEY/
]) {
	assert(!forbidden.test(script), `forbidden rehearsal primitive: ${forbidden}`)
}

const postgresCreateStart = script.indexOf(
	'postgres_container_id="$(docker container create'
)
const runnerCreateStart = script.indexOf(
	'runner_container_id="$(docker container create'
)
const runnerCreateEnd = script.indexOf(
	'[[ "$runner_container_id" =~',
	runnerCreateStart
)
assert(postgresCreateStart >= 0, 'postgres create block is missing')
assert(runnerCreateStart > postgresCreateStart, 'runner create block is missing')
assert(runnerCreateEnd > runnerCreateStart, 'runner create block is incomplete')
assert(
	!script.slice(postgresCreateStart, runnerCreateEnd).includes('--hostname'),
	'container network hostname override is forbidden'
)
const postgresCreateBlock = script.slice(postgresCreateStart, runnerCreateStart)
const runnerCreateBlock = script.slice(runnerCreateStart, runnerCreateEnd)
for (const [label, block, limit] of [
	['PostgreSQL', postgresCreateBlock, 'postgres_memory_limit'],
	['Operations runner', runnerCreateBlock, 'runner_memory_limit']
]) {
	assert(
		block.includes(`--memory "$${limit}"`),
		`${label} hard memory limit is missing`
	)
	assert(
		block.includes(`--memory-swap "$${limit}"`),
		`${label} no-swap limit is missing`
	)
}
assert.equal(
	(script.match(/\{\{\.HostConfig\.MemorySwap\}\}/g) ?? []).length,
	2,
	'both container resource inspections must verify the no-swap limit'
)
for (const limitBytes of [
	'postgres_memory_limit_bytes',
	'runner_memory_limit_bytes'
]) {
	assert(
		script.includes(`|$${limitBytes}|$${limitBytes}|`),
		`${limitBytes} must bind equal memory and memory-swap inspection values`
	)
}

const earlyTrap = script.indexOf('trap early_cleanup_on_exit EXIT')
const passwordCreation = script.indexOf('openssl rand -base64 48')
assert(earlyTrap >= 0, 'early cleanup trap is missing')
assert(
	earlyTrap < passwordCreation,
	'cleanup trap must precede password and artifact staging'
)

const dockerDeletionLines = script
	.split('\n')
	.map(line => line.trim())
	.filter(line =>
		/^docker\s+(?:(?:container|image|volume|network)\s+rm|rm|(?:system|container|image|builder|buildx|volume|network)\s+prune)\b/.test(
			line
		)
	)
assert.deepEqual(dockerDeletionLines, [
	'docker container rm -- "$container_id" >/dev/null || return 1'
])

const cleanupCall = script.lastIndexOf('\ncleanup_rehearsal ||\n')
const runnerEvidencePublish = script.lastIndexOf(
	'mv -T "$runner_evidence_part" "$runner_evidence"'
)
const successEvidence = script.lastIndexOf('isolated_restore_rehearsal=SUCCEEDED')
assert(cleanupCall >= 0, 'final cleanup call is missing')
assert(
	cleanupCall < runnerEvidencePublish && runnerEvidencePublish < successEvidence,
	'success evidence must be emitted only after exact cleanup'
)

const validatorStartMarker =
	"read -r -d '' evidence_validator_source <<'EVIDENCE_VALIDATOR' || true\n"
const validatorStart = script.indexOf(validatorStartMarker)
const validatorEnd = script.indexOf('\nEVIDENCE_VALIDATOR\n', validatorStart)
assert(validatorStart >= 0, 'strict evidence validator start marker is missing')
assert(validatorEnd > validatorStart, 'strict evidence validator end marker is missing')
const validatorSource = script.slice(
	validatorStart + validatorStartMarker.length,
	validatorEnd
)
const servicesRevision = 'a'.repeat(40)
const normalRestorePhases = [
	'FENCING',
	'FENCED',
	'SAFETY_READY',
	'MUTATING',
	'VERIFIED',
	'UNFENCING',
	'UNFENCED'
]
const recoveryActions = [
	{
		action: 'VERIFY_AS_IS',
		phases: ['FENCING', 'FENCED', 'VERIFYING', 'VERIFIED', 'UNFENCING']
	},
	{
		action: 'ROLL_BACK_SAFETY',
		phases: [
			'FENCING',
			'FENCED',
			'MUTATING',
			'VERIFYING',
			'VERIFIED',
			'UNFENCING'
		]
	},
	{
		action: 'ROLL_FORWARD_SOURCE',
		phases: [
			'FENCING',
			'FENCED',
			'MUTATING',
			'VERIFYING',
			'VERIFIED',
			'UNFENCING'
		]
	}
]
const targetNames = [
	'notification-delivery',
	'campaigns',
	'reporting',
	'widgets',
	'identity',
	'platform',
	'support'
]
const validEvidence = {
	domain: 'winwidget.operations.database-restore-artifact-rehearsal.v1',
	schemaVersion: 1,
	status: 'SUCCEEDED',
	servicesSha: servicesRevision,
	postgresVersion: '180001',
	pgDumpVersion: 'pg_dump (PostgreSQL) 18.1 (Debian 18.1-1.pgdg120+1)',
	pgRestoreVersion: 'pg_restore (PostgreSQL) 18.1 (Debian 18.1-1.pgdg120+1)',
	completedAt: '2026-09-02T10:20:30.000Z',
	proofScope: {
		isolatedPostgresOnly: true,
		productionRestoreGateEnabled: false,
		covered: [
			'signed-artifact-provenance',
			'exact-revision-binding',
			'toc-and-migration-ledger',
			'acl-and-writer-fence',
			'normal-executor',
			'all-recovery-executors'
		],
		excluded: [
			'dual-approval',
			'permit-outbox-worker-cas',
			'signed-terminal-receipts',
			'restart-and-redelivery',
			'retention-and-alerts'
		]
	},
	targets: targetNames.map((target, index) => ({
		target,
		backupJobId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
		artifactSha256: String(index + 1).repeat(64),
		provenanceEnvelopeSha256: ['a', 'b', 'c', 'd', 'e', 'f', '0'][index].repeat(
			64
		),
		provenanceKeyId: 'production-ed25519-2026',
		migrationManifestSha: ['8', '9', '0', '1', '2', '3', '4'][index].repeat(64),
		fileSize: 1024 + index,
		normalSafetyBackupSha256: ['a', 'b', 'c', 'd', 'e', 'f', '0'][
			index
		].repeat(64),
		normalRestorePhases: [...normalRestorePhases],
		recoveryActions: recoveryActions.map((action, actionIndex) => ({
			action: action.action,
			artifactSha256:
				action.action === 'VERIFY_AS_IS'
					? null
					: action.action === 'ROLL_BACK_SAFETY'
						? ['a', 'b', 'c', 'd', 'e', 'f', '0'][index].repeat(64)
						: String(index + 1).repeat(64),
			phases: [...action.phases],
			writerFenceReleaseEvidenceSha256: ['5', '6', '7'][actionIndex].repeat(
				64
			)
		}))
	}))
}
const cloneEvidence = () => JSON.parse(JSON.stringify(validEvidence))
const validate = value =>
	spawnSync(
		process.execPath,
		['--eval', validatorSource, '--', '--validate-stdin'],
		{
			encoding: 'utf8',
			env: { ...process.env, APP_REVISION: servicesRevision },
			input: `${typeof value === 'string' ? value : JSON.stringify(value)}\n`
		}
	)

const validResult = validate(validEvidence)
assert.equal(validResult.status, 0, validResult.stderr)
assert.deepEqual(JSON.parse(validResult.stdout), validEvidence)

const invalidCases = [
	['top-level keys', value => (value.extra = true)],
	['schema version', value => (value.schemaVersion = 2)],
	['status', value => (value.status = 'FAILED')],
	['services revision', value => (value.servicesSha = 'b'.repeat(40))],
	['PostgreSQL server version', value => (value.postgresVersion = '170001')],
	['pg_dump version', value => (value.pgDumpVersion = 'pg_dump (PostgreSQL) 17.1')],
	[
		'pg_restore version',
		value => (value.pgRestoreVersion = 'pg_restore (PostgreSQL) 18')
	],
	['timestamp', value => (value.completedAt = '2026-09-02')],
	['proof scope keys', value => (value.proofScope.extra = true)],
	['proof scope flags', value => (value.proofScope.isolatedPostgresOnly = false)],
	['covered proof scope', value => value.proofScope.covered.pop()],
	['excluded proof scope', value => value.proofScope.excluded.reverse()],
	['target count', value => value.targets.pop()],
	['target order', value => value.targets.reverse()],
	['target keys', value => (value.targets[0].extra = true)],
	['backup job ID', value => (value.targets[0].backupJobId = 'invalid')],
	[
		'duplicate backup job ID',
		value => (value.targets[1].backupJobId = value.targets[0].backupJobId)
	],
	['artifact SHA-256', value => (value.targets[0].artifactSha256 = 'invalid')],
	[
		'provenance envelope SHA-256',
		value => (value.targets[0].provenanceEnvelopeSha256 = 'invalid')
	],
	['provenance key ID', value => (value.targets[0].provenanceKeyId = 'bad key')],
	[
		'migration manifest SHA-256',
		value => (value.targets[0].migrationManifestSha = 'invalid')
	],
	[
		'normal safety backup SHA-256',
		value => (value.targets[0].normalSafetyBackupSha256 = 'invalid')
	],
	['artifact size', value => (value.targets[0].fileSize = 0)],
	['normal phases', value => value.targets[0].normalRestorePhases.pop()],
	['recovery action count', value => value.targets[0].recoveryActions.pop()],
	['recovery action keys', value => (value.targets[0].recoveryActions[0].extra = true)],
	[
		'recovery action',
		value => (value.targets[0].recoveryActions[0].action = 'ROLL_FORWARD_SOURCE')
	],
	['recovery action phases', value => value.targets[0].recoveryActions[1].phases.pop()],
	[
		'verify-as-is artifact SHA-256',
		value => (value.targets[0].recoveryActions[0].artifactSha256 = '1'.repeat(64))
	],
	[
		'rollback artifact SHA-256',
		value => (value.targets[0].recoveryActions[1].artifactSha256 = '1'.repeat(64))
	],
	[
		'roll-forward artifact SHA-256',
		value => (value.targets[0].recoveryActions[2].artifactSha256 = '2'.repeat(64))
	],
	[
		'recovery writer-fence release evidence SHA-256',
		value =>
			(value.targets[0].recoveryActions[0].writerFenceReleaseEvidenceSha256 =
				'invalid')
	]
]
for (const [label, mutate] of invalidCases) {
	const value = cloneEvidence()
	mutate(value)
	const result = validate(value)
	assert.notEqual(result.status, 0, `${label} must fail closed`)
	assert.equal(result.stdout, '', `${label} must not publish evidence`)
}
const malformedResult = validate('{"status":"SUCCEEDED"')
assert.notEqual(malformedResult.status, 0, 'malformed JSON must fail closed')
assert.equal(malformedResult.stdout, '', 'malformed JSON must not be published')

assert(
	workflow.includes(
		'node scripts/test-isolated-restore-rehearsal-contract.mjs'
	),
	'infra CI does not execute the isolated rehearsal contract test'
)

console.log('Isolated restore rehearsal contract passed')
