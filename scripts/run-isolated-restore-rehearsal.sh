#!/usr/bin/env bash

set -euo pipefail
umask 077

usage() {
	cat >&2 <<'USAGE'
Usage:
  run-isolated-restore-rehearsal.sh \
    <40-hex-services-revision> \
    <remote-artifact-set-directory> \
    <64-hex-artifact-set-sha256>

Required environment:
  INFRA_REVISION
  PRODUCTION_SSH_HOST
  PRODUCTION_SSH_PORT
  PRODUCTION_SSH_USER
  PRODUCTION_SSH_IDENTITY_FILE
  PRODUCTION_SSH_KNOWN_HOSTS_FILE
USAGE
	exit 2
}

die() {
	printf '%s\n' "$1" >&2
	exit 1
}

[[ $# -eq 3 ]] || usage

services_revision="$1"
artifact_source_directory="$2"
artifact_set_sha256="$3"
infra_revision="${INFRA_REVISION:-}"

[[ "$services_revision" =~ ^[0-9a-f]{40}$ ]] ||
	die 'Services revision must be an immutable lowercase 40-hex commit.'
[[ "$artifact_set_sha256" =~ ^[0-9a-f]{64}$ ]] ||
	die 'Artifact set SHA-256 must be lowercase 64-hex.'
[[ "$infra_revision" =~ ^[0-9a-f]{40}$ ]] ||
	die 'Infra revision must be an immutable lowercase 40-hex commit.'
[[ "$artifact_source_directory" == \
	"/var/lib/winwidget-operations/rehearsal-sources/$services_revision/$artifact_set_sha256" ]] ||
	die 'Remote artifact directory is outside the exact rehearsal source boundary.'

controller_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ -d "$controller_root/.git" && ! -L "$controller_root" ]] ||
	die 'Infrastructure controller must run from its canonical Git checkout.'
[[ "$(git -C "$controller_root" rev-parse HEAD 2>/dev/null)" == "$infra_revision" ]] ||
	die 'Infrastructure checkout does not match INFRA_REVISION.'
[[ -z "$(git -C "$controller_root" status --porcelain --untracked-files=all)" ]] ||
	die 'Infrastructure checkout must be clean before a production rehearsal.'
infra_repository_origin="$(git -C "$controller_root" remote get-url origin 2>/dev/null)" ||
	die 'Cannot read the infrastructure repository origin.'
case "$infra_repository_origin" in
	git@github.com:nda17/winwidget.ru_infra | git@github.com:nda17/winwidget.ru_infra.git | \
		https://github.com/nda17/winwidget.ru_infra | https://github.com/nda17/winwidget.ru_infra.git | \
		ssh://git@github.com/nda17/winwidget.ru_infra | ssh://git@github.com/nda17/winwidget.ru_infra.git) ;;
	*) die 'Infrastructure controller origin is not the approved GitHub repository.' ;;
esac

required_environment=(
	PRODUCTION_SSH_HOST
	PRODUCTION_SSH_PORT
	PRODUCTION_SSH_USER
	PRODUCTION_SSH_IDENTITY_FILE
	PRODUCTION_SSH_KNOWN_HOSTS_FILE
)
for variable_name in "${required_environment[@]}"; do
	[[ -n "${!variable_name:-}" ]] ||
		die "Required rehearsal setting is missing: $variable_name"
done

[[ "$PRODUCTION_SSH_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ ]] ||
	die 'Production SSH host is invalid.'
if [[ ! "$PRODUCTION_SSH_PORT" =~ ^[0-9]{1,5}$ ]] ||
	((10#$PRODUCTION_SSH_PORT < 1 || 10#$PRODUCTION_SSH_PORT > 65535)); then
	die 'Production SSH port is invalid.'
fi
[[ "$PRODUCTION_SSH_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] ||
	die 'Production SSH user is invalid.'

identity_file="$PRODUCTION_SSH_IDENTITY_FILE"
known_hosts_file="$PRODUCTION_SSH_KNOWN_HOSTS_FILE"
[[ -f "$identity_file" && ! -L "$identity_file" ]] ||
	die 'Production SSH identity file must be a regular non-symlink file.'
[[ "$(stat -c '%a' "$identity_file" 2>/dev/null || stat -f '%Lp' "$identity_file")" == '600' ]] ||
	die 'Production SSH identity file must have mode 0600.'
ssh-keygen -y -P '' -f "$identity_file" >/dev/null 2>&1 ||
	die 'Production SSH identity file is invalid or requires a passphrase.'
[[ -s "$known_hosts_file" && ! -L "$known_hosts_file" ]] ||
	die 'Production SSH known_hosts file must be a non-empty regular file.'
[[ "$(stat -c '%a' "$known_hosts_file" 2>/dev/null || stat -f '%Lp' "$known_hosts_file")" == '600' ]] ||
	die 'Production SSH known_hosts file must have mode 0600.'

ssh_options=(
	-F /dev/null
	-o BatchMode=yes
	-o ClearAllForwardings=yes
	-o ConnectTimeout=15
	-o ForwardAgent=no
	-o IdentitiesOnly=yes
	-o LogLevel=ERROR
	-o PasswordAuthentication=no
	-o PermitLocalCommand=no
	-o RequestTTY=no
	-o ServerAliveCountMax=3
	-o ServerAliveInterval=15
	-o StrictHostKeyChecking=yes
	-o "UserKnownHostsFile=$known_hosts_file"
	-i "$identity_file"
	-p "$PRODUCTION_SSH_PORT"
)

printf -v remote_controller_arguments ' %q' \
	"$infra_revision" \
	"$services_revision" \
	"$artifact_source_directory" \
	"$artifact_set_sha256"
# shellcheck disable=SC2016
remote_controller_command='set -euo pipefail
[[ "$(id -u)" == "0" ]]
controller_directory="/opt/winwidget/deploy/backend"
[[ -d "$controller_directory" && ! -L "$controller_directory" &&
	"$(realpath -e "$controller_directory")" == "$controller_directory" &&
	"$(stat -c "%u:%g" "$controller_directory")" == "0:0" ]]
controller_directory_mode="$(stat -c "%a" "$controller_directory")"
[[ "$controller_directory_mode" =~ ^[0-7]{3,4}$ ]]
(( (8#$controller_directory_mode & 8#022) == 0 ))
controller_file="$(mktemp "$controller_directory/.restore-rehearsal-controller.XXXXXX")"
trap '\''rm -f -- "$controller_file"'\'' EXIT
cat >"$controller_file"
chown 0:0 "$controller_file"
chmod 600 "$controller_file"
bash "$controller_file"'"$remote_controller_arguments"' </dev/null'

# shellcheck disable=SC2029
ssh "${ssh_options[@]}" \
	"$PRODUCTION_SSH_USER@$PRODUCTION_SSH_HOST" \
	"$remote_controller_command" <<'REMOTE_CONTROLLER'
set -euo pipefail
umask 077

die() {
	printf '%s\n' "$1" >&2
	exit 1
}

infra_revision="$1"
services_revision="$2"
artifact_source_directory="$3"
artifact_set_sha256="$4"

[[ "$(id -u)" == '0' ]] ||
	die 'The isolated restore rehearsal must run as root on the backend VPS.'
[[ "$infra_revision" =~ ^[0-9a-f]{40}$ ]] ||
	die 'Remote infra revision is invalid.'
[[ "$services_revision" =~ ^[0-9a-f]{40}$ ]] ||
	die 'Remote services revision is invalid.'
[[ "$artifact_set_sha256" =~ ^[0-9a-f]{64}$ ]] ||
	die 'Remote artifact set SHA-256 is invalid.'
[[ "$artifact_source_directory" == \
	"/var/lib/winwidget-operations/rehearsal-sources/$services_revision/$artifact_set_sha256" ]] ||
	die 'Remote artifact source escaped the exact rehearsal boundary.'

for command_name in \
	docker flock openssl realpath sha256sum stat timeout install find sort sync \
	grep awk wc date rmdir cmp chmod chown mv tr sed df; do
	command -v "$command_name" >/dev/null 2>&1 ||
		die "Required rehearsal command is unavailable: $command_name"
done

readonly app_root='/opt/winwidget'
readonly deploy_state_directory="$app_root/deploy/backend"
readonly deploy_lock="$deploy_state_directory/.production-deploy.lock"
readonly rehearsal_lock="$deploy_state_directory/.isolated-restore-rehearsal.lock"
readonly operations_root='/var/lib/winwidget-operations'
readonly source_root="$operations_root/rehearsal-sources"
readonly runs_root="$operations_root/rehearsal-runs"
readonly evidence_root="$operations_root/rehearsal-evidence"
readonly postgres_image='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
readonly operations_image="winwidget-operations:git-$services_revision"
readonly expected_postgres_user='operations_restore_artifact_superuser'
readonly expected_postgres_database='operations_restore_artifact_control'
readonly password_file_name='rehearsal-postgres-password'
readonly runner_script='dist/src/restore/database-restore-artifact-rehearsal.js'
readonly purpose_label='winwidget-isolated-restore-rehearsal'
readonly postgres_memory_limit='2g'
readonly runner_memory_limit='2g'
readonly postgres_memory_limit_bytes=$((2 * 1024 * 1024 * 1024))
readonly runner_memory_limit_bytes=$((2 * 1024 * 1024 * 1024))
readonly live_host_memory_reserve_bytes=$((2 * 1024 * 1024 * 1024))
readonly required_memory_available_bytes=$((
	postgres_memory_limit_bytes +
		runner_memory_limit_bytes +
		live_host_memory_reserve_bytes
))

read -r -d '' evidence_validator_source <<'EVIDENCE_VALIDATOR' || true
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');

const DOMAIN = 'winwidget.operations.database-restore-artifact-rehearsal.v1';
const SERVICES_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const ISO_TIMESTAMP_PATTERN =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_EVIDENCE_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const TARGETS = [
	'notification-delivery',
	'campaigns',
	'reporting',
	'widgets',
	'identity',
	'platform',
	'support'
];
const NORMAL_PHASES = [
	'FENCING',
	'FENCED',
	'SAFETY_READY',
	'MUTATING',
	'VERIFIED',
	'UNFENCING',
	'UNFENCED'
];
const RECOVERY_ACTIONS = [
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
];
const COVERED_SCOPE = [
	'signed-artifact-provenance',
	'exact-revision-binding',
	'toc-and-migration-ledger',
	'acl-and-writer-fence',
	'normal-executor',
	'all-recovery-executors'
];
const EXCLUDED_SCOPE = [
	'dual-approval',
	'permit-outbox-worker-cas',
	'signed-terminal-receipts',
	'restart-and-redelivery',
	'retention-and-alerts'
];

const fail = message => {
	throw new Error(message);
};

const exactRecord = (value, expectedKeys, label) => {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		fail(`${label} must be an object`);
	}
	const actualKeys = Object.keys(value).sort();
	const sortedExpectedKeys = [...expectedKeys].sort();
	if (
		actualKeys.length !== sortedExpectedKeys.length ||
		actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
	) {
		fail(`${label} keys are invalid`);
	}
	return value;
};

const exactArray = (value, expected, label) => {
	if (
		!Array.isArray(value) ||
		value.length !== expected.length ||
		value.some((item, index) => item !== expected[index])
	) {
		fail(`${label} is invalid`);
	}
};

const assertToolVersion = (value, command) => {
	const pattern = new RegExp(
		`^${command} \\(PostgreSQL\\) 18\\.[0-9]+(?:\\.[0-9]+)?(?: \\([\\x20-\\x7e]{1,120}\\))?$`
	);
	if (typeof value !== 'string' || !pattern.test(value)) {
		fail(`${command} version is invalid`);
	}
};

const validateEvidence = raw => {
	if (
		typeof raw !== 'string' ||
		Buffer.byteLength(raw, 'utf8') > MAX_EVIDENCE_BYTES ||
		!raw.endsWith('\n') ||
		raw.slice(0, -1).includes('\n') ||
		raw.includes('\r')
	) {
		fail('evidence framing is invalid');
	}
	const encoded = raw.slice(0, -1);
	let evidence;
	try {
		evidence = JSON.parse(encoded);
	} catch {
		fail('evidence JSON is invalid');
	}
	if (JSON.stringify(evidence) !== encoded) {
		fail('evidence JSON is not canonical');
	}
	const record = exactRecord(
		evidence,
		[
			'completedAt',
			'domain',
			'pgDumpVersion',
			'pgRestoreVersion',
			'postgresVersion',
			'proofScope',
			'schemaVersion',
			'servicesSha',
			'status',
			'targets'
		],
		'evidence'
	);
	if (
		record.domain !== DOMAIN ||
		record.schemaVersion !== 1 ||
		record.status !== 'SUCCEEDED'
	) {
		fail('evidence identity is invalid');
	}
	const expectedServicesSha = process.env.APP_REVISION ?? '';
	if (
		!SERVICES_SHA_PATTERN.test(expectedServicesSha) ||
		record.servicesSha !== expectedServicesSha
	) {
		fail('evidence services revision is invalid');
	}
	if (
		typeof record.postgresVersion !== 'string' ||
		!/^18[0-9]{4}$/.test(record.postgresVersion)
	) {
		fail('PostgreSQL server version is invalid');
	}
	assertToolVersion(record.pgDumpVersion, 'pg_dump');
	assertToolVersion(record.pgRestoreVersion, 'pg_restore');
	if (
		typeof record.completedAt !== 'string' ||
		!ISO_TIMESTAMP_PATTERN.test(record.completedAt) ||
		new Date(record.completedAt).toISOString() !== record.completedAt
	) {
		fail('evidence timestamp is invalid');
	}
	const proofScope = exactRecord(
		record.proofScope,
		['covered', 'excluded', 'isolatedPostgresOnly', 'productionRestoreGateEnabled'],
		'proof scope'
	);
	if (
		proofScope.isolatedPostgresOnly !== true ||
		proofScope.productionRestoreGateEnabled !== false
	) {
		fail('proof scope flags are invalid');
	}
	exactArray(proofScope.covered, COVERED_SCOPE, 'covered proof scope');
	exactArray(proofScope.excluded, EXCLUDED_SCOPE, 'excluded proof scope');
	if (!Array.isArray(record.targets) || record.targets.length !== TARGETS.length) {
		fail('target evidence count is invalid');
	}
	const backupJobIds = new Set();
	record.targets.forEach((targetValue, targetIndex) => {
		const target = exactRecord(
			targetValue,
			[
				'artifactSha256',
				'backupJobId',
				'fileSize',
				'migrationManifestSha',
				'normalSafetyBackupSha256',
				'normalRestorePhases',
				'provenanceEnvelopeSha256',
				'provenanceKeyId',
				'recoveryActions',
				'target'
			],
			`target evidence ${targetIndex}`
		);
		if (target.target !== TARGETS[targetIndex]) {
			fail('target evidence order is invalid');
		}
		if (
			typeof target.backupJobId !== 'string' ||
			!UUID_V4_PATTERN.test(target.backupJobId) ||
			backupJobIds.has(target.backupJobId)
		) {
			fail('backup job evidence is invalid');
		}
		backupJobIds.add(target.backupJobId);
		for (const field of [
			'artifactSha256',
			'normalSafetyBackupSha256',
			'provenanceEnvelopeSha256',
			'migrationManifestSha'
		]) {
			if (typeof target[field] !== 'string' || !SHA256_PATTERN.test(target[field])) {
				fail(`${field} is invalid`);
			}
		}
		if (
			typeof target.provenanceKeyId !== 'string' ||
			!KEY_ID_PATTERN.test(target.provenanceKeyId)
		) {
			fail('provenance key ID is invalid');
		}
		if (
			!Number.isSafeInteger(target.fileSize) ||
			target.fileSize < 5 ||
			target.fileSize > MAX_ARTIFACT_BYTES
		) {
			fail('artifact file size is invalid');
		}
		exactArray(target.normalRestorePhases, NORMAL_PHASES, 'normal restore phases');
		if (
			!Array.isArray(target.recoveryActions) ||
			target.recoveryActions.length !== RECOVERY_ACTIONS.length
		) {
			fail('recovery action count is invalid');
		}
		target.recoveryActions.forEach((actionValue, actionIndex) => {
			const action = exactRecord(
				actionValue,
				[
					'action',
					'artifactSha256',
					'phases',
					'writerFenceReleaseEvidenceSha256'
				],
				`recovery action ${actionIndex}`
			);
			const expectedAction = RECOVERY_ACTIONS[actionIndex];
			if (action.action !== expectedAction.action) {
				fail('recovery action order is invalid');
			}
			exactArray(action.phases, expectedAction.phases, 'recovery action phases');
			const expectedArtifactSha256 =
				expectedAction.action === 'VERIFY_AS_IS'
					? null
					: expectedAction.action === 'ROLL_BACK_SAFETY'
						? target.normalSafetyBackupSha256
						: target.artifactSha256;
			if (action.artifactSha256 !== expectedArtifactSha256) {
				fail('recovery artifact SHA-256 is invalid');
			}
			if (
				typeof action.writerFenceReleaseEvidenceSha256 !== 'string' ||
				!SHA256_PATTERN.test(action.writerFenceReleaseEvidenceSha256)
			) {
				fail('recovery writer-fence release evidence SHA-256 is invalid');
			}
		});
	});
	return evidence;
};

const main = () => {
	let raw;
	if (process.argv[1] === '--validate-stdin') {
		raw = readFileSync(0, 'utf8');
	} else {
		const runnerPath = process.argv[1];
		if (typeof runnerPath !== 'string' || runnerPath.length === 0) {
			fail('rehearsal runner path is missing');
		}
		const child = spawnSync(process.execPath, [runnerPath], {
			encoding: 'utf8',
			env: process.env,
			maxBuffer: MAX_EVIDENCE_BYTES + 1
		});
		if (
			child.error ||
			child.signal !== null ||
			child.status !== 0 ||
			child.stderr !== ''
		) {
			fail('isolated rehearsal child process failed');
		}
		raw = child.stdout;
	}
	const evidence = validateEvidence(raw);
	process.stdout.write(`${JSON.stringify(evidence)}\n`);
};

try {
	main();
} catch {
	process.stderr.write('Isolated rehearsal evidence validation failed.\n');
	process.exitCode = 1;
}
EVIDENCE_VALIDATOR

assert_root_directory() {
	local path="$1" expected_mode="$2"
	[[ -d "$path" && ! -L "$path" && "$(realpath -e "$path")" == "$path" ]] ||
		die "Root directory boundary is unsafe: $path"
	[[ "$(stat -c '%u:%g:%a' "$path")" == "0:0:$expected_mode" ]] ||
		die "Root directory metadata is unsafe: $path"
}

assert_lock() {
	local path="$1" directory directory_mode
	directory="$(dirname -- "$path")"
	[[ -d "$directory" && ! -L "$directory" &&
		"$(realpath -e "$directory")" == "$directory" &&
		"$(stat -c '%u:%g' "$directory")" == '0:0' ]] ||
		die "Lock directory boundary is unsafe: $directory"
	directory_mode="$(stat -c '%a' "$directory")"
	[[ "$directory_mode" =~ ^[0-7]{3,4}$ ]] ||
		die "Lock directory mode is invalid: $directory"
	(( (8#$directory_mode & 8#022) == 0 )) ||
		die "Lock directory is group/world writable: $directory"
	[[ ! -L "$path" && (! -e "$path" || -f "$path") ]] ||
		die "Lock path is unsafe: $path"
	exec {lock_fd}>"$path"
	chown 0:0 "$path"
	chmod 600 "$path"
	[[ "$(stat -c '%u:%g:%a:%h' "$path")" == '0:0:600:1' ]] ||
		die "Lock metadata is unsafe: $path"
	flock -n "$lock_fd" ||
		die "Another production operation holds the lock: $path"
}

[[ -d "$deploy_state_directory" ]] ||
	die 'Production deploy state directory is missing.'
assert_lock "$deploy_lock"
readonly deploy_lock_fd="$lock_fd"
assert_lock "$rehearsal_lock"
readonly rehearsal_lock_fd="$lock_fd"
: "$deploy_lock_fd" "$rehearsal_lock_fd"

[[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" ]] ||
	die 'Docker endpoint overrides are forbidden during the rehearsal.'
[[ "$(docker context show)" == 'default' ]] ||
	die 'The rehearsal requires the default local Docker context.'
[[ "$(docker context inspect default --format '{{.Endpoints.docker.Host}}')" == \
	'unix:///var/run/docker.sock' ]] ||
	die 'The default Docker context is not the local production socket.'
docker info >/dev/null 2>&1 ||
	die 'The local production Docker daemon is unavailable.'

if [[ ! -e "$operations_root" && ! -L "$operations_root" ]]; then
	install -d -o root -g root -m 0755 "$operations_root"
fi
[[ -d "$operations_root" && ! -L "$operations_root" &&
	"$(realpath -e "$operations_root")" == "$operations_root" &&
	"$(stat -c '%u:%g' "$operations_root")" == '0:0' ]] ||
	die 'Operations host root is unsafe.'
operations_root_mode="$(stat -c '%a' "$operations_root")"
(( (8#$operations_root_mode & 8#022) == 0 )) ||
	die 'Operations host root is group/world writable.'
for protected_root in "$source_root" "$runs_root" "$evidence_root"; do
	if [[ ! -e "$protected_root" && ! -L "$protected_root" ]]; then
		install -d -o root -g root -m 0700 "$protected_root"
	fi
	assert_root_directory "$protected_root" '700'
done
[[ -z "$(docker ps -aq --no-trunc --filter "label=com.winwidget.purpose=$purpose_label")" ]] ||
	die 'A stale isolated restore rehearsal container requires exact-ID recovery.'
[[ -z "$(find "$runs_root" -mindepth 1 -maxdepth 1 -print -quit)" ]] ||
	die 'A stale isolated restore rehearsal run directory requires review.'

[[ -d "$artifact_source_directory" && ! -L "$artifact_source_directory" &&
	"$(realpath -e "$artifact_source_directory")" == "$artifact_source_directory" ]] ||
	die 'Artifact source directory is missing or unsafe.'
[[ "$(stat -c '%u:%g:%a' "$artifact_source_directory")" == '0:0:700' ]] ||
	die 'Artifact source directory must be root:root mode 0700.'
[[ "$(dirname -- "$(dirname -- "$artifact_source_directory")")" == "$source_root" ]] ||
	die 'Artifact source directory has an invalid parent boundary.'

mapfile -d '' source_files < <(
	find "$artifact_source_directory" -mindepth 1 -maxdepth 1 -print0 |
		LC_ALL=C sort -z
)
[[ ${#source_files[@]} -eq 14 ]] ||
	die 'Artifact source must contain exactly seven dump/sidecar pairs.'
dump_count=0
sidecar_count=0
source_total_bytes=0
for source_file in "${source_files[@]}"; do
	file_name="${source_file##*/}"
	file_size="$(stat -c '%s' "$source_file")"
	[[ "$file_size" =~ ^[0-9]+$ ]] ||
		die 'Artifact source file size is invalid.'
	source_total_bytes=$((source_total_bytes + file_size))
	[[ "$file_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,220}$ ]] ||
		die 'Artifact source contains an unsafe filename.'
	[[ -f "$source_file" && ! -L "$source_file" &&
		"$(stat -c '%u:%g:%a:%h:%F' "$source_file")" == \
		'0:0:600:1:regular file' ]] ||
		die 'Artifact source file metadata is unsafe.'
	case "$file_name" in
		*.dump.provenance.json)
			((file_size <= 64 * 1024)) ||
				die 'Artifact provenance sidecar exceeds the safe size limit.'
			sidecar_count=$((sidecar_count + 1))
			;;
		*.dump)
			((file_size <= 20 * 1024 * 1024)) ||
				die 'Artifact dump exceeds the standard Bot API recovery limit.'
			dump_count=$((dump_count + 1))
			;;
		*) die 'Artifact source contains an unexpected file.' ;;
	esac
done
[[ "$dump_count" -eq 7 && "$sidecar_count" -eq 7 ]] ||
	die 'Artifact source does not contain seven exact file pairs.'
memory_available_bytes="$(awk '/^MemAvailable:/ { printf "%.0f\n", $2 * 1024; exit }' /proc/meminfo)"
disk_available_bytes="$(df -PB1 "$runs_root" | awk 'NR == 2 { print $4 }')"
[[ "$memory_available_bytes" =~ ^[0-9]+$ &&
	"$disk_available_bytes" =~ ^[0-9]+$ ]] ||
	die 'Cannot measure rehearsal host capacity.'
((memory_available_bytes >= required_memory_available_bytes)) ||
	die 'The backend VPS cannot preserve the combined rehearsal and live-service memory reserve.'
((disk_available_bytes >= source_total_bytes + 256 * 1024 * 1024)) ||
	die 'The backend VPS lacks protected staging capacity.'

artifact_set_digest() {
	local directory="$1" path name size digest
	while IFS= read -r -d '' path; do
		name="${path##*/}"
		size="$(stat -c '%s' "$path")"
		digest="$(sha256sum "$path" | awk '{print $1}')"
		[[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
		printf '%s\0%s\0%s\n' "$name" "$size" "$digest"
	done < <(
		find "$directory" -mindepth 1 -maxdepth 1 -type f -print0 |
			LC_ALL=C sort -z
	) |
		sha256sum | awk '{print $1}'
}

[[ "$(artifact_set_digest "$artifact_source_directory")" == "$artifact_set_sha256" ]] ||
	die 'Artifact source aggregate SHA-256 mismatch.'

operations_image_id="$(docker image inspect --format '{{.Id}}' "$operations_image" 2>/dev/null)" ||
	die 'The exact Operations image is unavailable.'
[[ "$operations_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] ||
	die 'The Operations image ID is invalid.'
[[ "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$operations_image_id")" == \
	"$services_revision" ]] ||
	die 'The Operations image revision label is invalid.'
[[ "$(docker image inspect --format '{{json .Config.Entrypoint}}|{{.Config.User}}' "$operations_image_id")" == \
	'["/usr/local/bin/operations-entrypoint.sh"]|operations' ]] ||
	die 'The Operations image runtime contract is invalid.'

postgres_image_id="$(docker image inspect --format '{{.Id}}' "$postgres_image" 2>/dev/null)" ||
	die 'The pinned PostgreSQL 18 rehearsal image is unavailable.'
[[ "$postgres_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] ||
	die 'The PostgreSQL image ID is invalid.'
[[ "$(docker image inspect --format '{{json .Config.Entrypoint}}|{{json .Config.Cmd}}' "$postgres_image_id")" == \
	'["docker-entrypoint.sh"]|["postgres"]' ]] ||
	die 'The PostgreSQL image entrypoint contract is invalid.'
postgres_volumes="$(docker image inspect --format '{{range $key, $_ := .Config.Volumes}}{{println $key}}{{end}}' "$postgres_image_id")"
[[ "$postgres_volumes" == '/var/lib/postgresql' ]] ||
	die 'The PostgreSQL 18 image volume contract is invalid.'
docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$postgres_image_id" |
	grep -Fx 'PGDATA=/var/lib/postgresql/18/docker' >/dev/null ||
	die 'The PostgreSQL 18 PGDATA contract is invalid.'

run_id="$(tr -d '\n' </proc/sys/kernel/random/uuid)"
[[ "$run_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] ||
	die 'Cannot allocate a rehearsal run ID.'
run_directory="$runs_root/$run_id"
stage_directory="$run_directory/artifacts"
postgres_secrets_directory="$run_directory/postgres-secrets"
runner_secrets_directory="$run_directory/runner-secrets"
raw_stdout="$run_directory/runner.stdout"
raw_stderr="$run_directory/runner.stderr"
evidence_pending_directory="$evidence_root/.pending-$run_id"
evidence_directory="$evidence_root/$run_id"
postgres_name="winwidget-restore-rehearsal-postgres-$run_id"
runner_name="winwidget-restore-rehearsal-runner-$run_id"

early_cleanup_on_exit() {
	local status="$?" source_file file_name
	trap - EXIT
	set +e
	for source_file in "${source_files[@]}"; do
		file_name="${source_file##*/}"
		rm -f -- "$stage_directory/$file_name"
	done
	rm -f -- \
		"$run_directory/.postgres-password" \
		"$postgres_secrets_directory/$password_file_name" \
		"$runner_secrets_directory/$password_file_name" \
		"$raw_stdout" \
		"$raw_stderr"
	rmdir -- "$stage_directory" "$postgres_secrets_directory" \
		"$runner_secrets_directory" "$run_directory" 2>/dev/null
	rmdir -- "$evidence_pending_directory" 2>/dev/null
	exit "$status"
}
trap early_cleanup_on_exit EXIT

install -d -o root -g root -m 0700 "$run_directory"
install -d -o 1001 -g 1001 -m 0700 "$stage_directory"
install -d -o 999 -g 999 -m 0500 "$postgres_secrets_directory"
install -d -o 1001 -g 1001 -m 0500 "$runner_secrets_directory"
[[ ! -e "$evidence_pending_directory" && ! -L "$evidence_pending_directory" &&
	! -e "$evidence_directory" && ! -L "$evidence_directory" ]] ||
	die 'Rehearsal evidence path already exists.'
install -d -o root -g root -m 0700 "$evidence_pending_directory"

password_staging="$run_directory/.postgres-password"
openssl rand -base64 48 >"$password_staging"
chown 0:0 "$password_staging"
chmod 600 "$password_staging"
install -o 999 -g 999 -m 0400 \
	"$password_staging" "$postgres_secrets_directory/$password_file_name"
install -o 1001 -g 1001 -m 0400 \
	"$password_staging" "$runner_secrets_directory/$password_file_name"
cmp -s "$postgres_secrets_directory/$password_file_name" \
	"$runner_secrets_directory/$password_file_name" ||
	die 'Ephemeral PostgreSQL password copies differ.'
rm -f -- "$password_staging"

for source_file in "${source_files[@]}"; do
	file_name="${source_file##*/}"
	install -o 1001 -g 1001 -m 0400 \
		"$source_file" "$stage_directory/$file_name"
	cmp -s "$source_file" "$stage_directory/$file_name" ||
		die 'Artifact staging copy verification failed.'
	sync -f "$stage_directory/$file_name"
done
chmod 0500 "$stage_directory"
sync -f "$stage_directory"
[[ "$(artifact_set_digest "$stage_directory")" == "$artifact_set_sha256" ]] ||
	die 'Staged artifact aggregate SHA-256 mismatch.'

all_containers_before="$(docker ps -aq --no-trunc | LC_ALL=C sort)"
running_containers_before="$(docker ps -q --no-trunc | LC_ALL=C sort)"
volumes_before="$(docker volume ls -q | LC_ALL=C sort)"
networks_before="$(docker network ls -q --no-trunc | LC_ALL=C sort)"
all_containers_inventory_sha256="$(printf '%s' "$all_containers_before" | sha256sum | awk '{print $1}')"
running_containers_inventory_sha256="$(printf '%s' "$running_containers_before" | sha256sum | awk '{print $1}')"
volumes_inventory_sha256="$(printf '%s' "$volumes_before" | sha256sum | awk '{print $1}')"
networks_inventory_sha256="$(printf '%s' "$networks_before" | sha256sum | awk '{print $1}')"

postgres_container_id=''
runner_container_id=''
cleanup_complete='false'

assert_rehearsal_container() {
	local container_id="$1" expected_name="$2" expected_role="$3" identity
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || return 1
	identity="$(docker container inspect --format \
		'{{.Id}}|{{.Name}}|{{ index .Config.Labels "com.winwidget.purpose" }}|{{ index .Config.Labels "com.winwidget.rehearsal.run" }}|{{ index .Config.Labels "com.winwidget.rehearsal.role" }}|{{ index .Config.Labels "com.winwidget.rehearsal.services-revision" }}' \
		"$container_id" 2>/dev/null)" || return 1
	[[ "$identity" == \
		"$container_id|/$expected_name|$purpose_label|$run_id|$expected_role|$services_revision" ]]
}

remove_exact_container() {
	local container_id="$1" expected_name="$2" expected_role="$3" running
	[[ -n "$container_id" ]] || return 0
	assert_rehearsal_container "$container_id" "$expected_name" "$expected_role" ||
		return 1
	running="$(docker container inspect --format '{{.State.Running}}' "$container_id")" ||
		return 1
	if [[ "$running" == 'true' ]]; then
		docker container stop --timeout 30 "$container_id" >/dev/null || return 1
	fi
	assert_rehearsal_container "$container_id" "$expected_name" "$expected_role" ||
		return 1
	docker container rm -- "$container_id" >/dev/null || return 1
	if docker container inspect "$container_id" >/dev/null 2>&1; then
		return 1
	fi
}

cleanup_run_files() {
	local source_file file_name
	for source_file in "${source_files[@]}"; do
		file_name="${source_file##*/}"
		rm -f -- "$stage_directory/$file_name"
	done
	rm -f -- \
		"$postgres_secrets_directory/$password_file_name" \
		"$runner_secrets_directory/$password_file_name" \
		"$raw_stdout" \
		"$raw_stderr"
	rmdir -- "$stage_directory" "$postgres_secrets_directory" \
		"$runner_secrets_directory" "$run_directory"
}

cleanup_rehearsal() {
	local failed=0
	remove_exact_container "$runner_container_id" "$runner_name" 'runner' || failed=1
	remove_exact_container "$postgres_container_id" "$postgres_name" 'postgres' || failed=1
	if ((failed == 0)); then
		cleanup_run_files || failed=1
	fi
	if [[ "$(docker ps -aq --no-trunc | LC_ALL=C sort)" != "$all_containers_before" ||
		"$(docker ps -q --no-trunc | LC_ALL=C sort)" != "$running_containers_before" ||
		"$(docker volume ls -q | LC_ALL=C sort)" != "$volumes_before" ||
		"$(docker network ls -q --no-trunc | LC_ALL=C sort)" != "$networks_before" ]]; then
		failed=1
	fi
	((failed == 0)) || return 1
	cleanup_complete='true'
}

on_exit() {
	local status="$?"
	trap - EXIT
	if [[ "$cleanup_complete" != 'true' ]] && ! cleanup_rehearsal; then
		printf '%s\n' 'Isolated restore rehearsal cleanup requires manual exact-ID review.' >&2
		status=73
	fi
	if [[ "$cleanup_complete" == 'true' ]]; then
		rm -f -- \
			"$evidence_pending_directory/runner.json.part" \
			"$evidence_pending_directory/host.json.part"
		rmdir -- "$evidence_pending_directory" 2>/dev/null || true
	fi
	exit "$status"
}
trap on_exit EXIT

postgres_container_id="$(docker container create \
	--name "$postgres_name" \
	--label "com.winwidget.purpose=$purpose_label" \
	--label "com.winwidget.rehearsal.run=$run_id" \
	--label 'com.winwidget.rehearsal.role=postgres' \
	--label "com.winwidget.rehearsal.services-revision=$services_revision" \
	--network none \
	--read-only \
	--user 999:999 \
	--cap-drop ALL \
	--security-opt no-new-privileges \
	--pids-limit 256 \
	--memory "$postgres_memory_limit" \
	--memory-swap "$postgres_memory_limit" \
	--cpus 2 \
	--tmpfs '/var/lib/postgresql:rw,noexec,nosuid,nodev,size=1g,uid=999,gid=999,mode=0700' \
	--tmpfs '/tmp:rw,noexec,nosuid,nodev,size=64m,uid=999,gid=999,mode=0700' \
	--tmpfs '/var/run/postgresql:rw,noexec,nosuid,nodev,size=16m,uid=999,gid=999,mode=0700' \
	--mount "type=bind,src=$postgres_secrets_directory,dst=/run/secrets,readonly" \
	--env "POSTGRES_USER=$expected_postgres_user" \
	--env "POSTGRES_DB=$expected_postgres_database" \
	--env "POSTGRES_PASSWORD_FILE=/run/secrets/$password_file_name" \
	--env 'PGDATA=/var/lib/postgresql/18/docker' \
	--health-cmd "pg_isready --username=$expected_postgres_user --dbname=$expected_postgres_database" \
	--health-interval 2s \
	--health-timeout 2s \
	--health-retries 30 \
	--health-start-period 5s \
	--log-driver none \
	"$postgres_image_id")"
[[ "$postgres_container_id" =~ ^[0-9a-f]{64}$ ]] ||
	die 'PostgreSQL rehearsal container ID is invalid.'
assert_rehearsal_container "$postgres_container_id" "$postgres_name" 'postgres' ||
	die 'PostgreSQL rehearsal container identity is invalid.'

runner_container_id="$(docker container create \
	--name "$runner_name" \
	--label "com.winwidget.purpose=$purpose_label" \
	--label "com.winwidget.rehearsal.run=$run_id" \
	--label 'com.winwidget.rehearsal.role=runner' \
	--label "com.winwidget.rehearsal.services-revision=$services_revision" \
	--network "container:$postgres_container_id" \
	--read-only \
	--user 1001:1001 \
	--workdir /app \
	--cap-drop ALL \
	--security-opt no-new-privileges \
	--pids-limit 256 \
	--memory "$runner_memory_limit" \
	--memory-swap "$runner_memory_limit" \
	--cpus 2 \
	--tmpfs '/work:rw,noexec,nosuid,nodev,size=1g,uid=1001,gid=1001,mode=0700' \
	--tmpfs '/tmp:rw,noexec,nosuid,nodev,size=64m,uid=1001,gid=1001,mode=0700' \
	--mount "type=bind,src=$stage_directory,dst=/artifacts,readonly" \
	--mount "type=bind,src=$runner_secrets_directory,dst=/run/secrets,readonly" \
	--env 'OPERATIONS_RESTORE_ARTIFACT_REHEARSAL_ALLOW_MUTATION=true' \
	--env 'OPERATIONS_RESTORE_ARTIFACT_DIR=/artifacts' \
	--env 'OPERATIONS_RESTORE_ARTIFACT_WORK_DIR=/work' \
	--env "OPERATIONS_RESTORE_ARTIFACT_POSTGRES_USER=$expected_postgres_user" \
	--env "OPERATIONS_RESTORE_ARTIFACT_POSTGRES_DB=$expected_postgres_database" \
	--env "OPERATIONS_RESTORE_ARTIFACT_POSTGRES_PASSWORD_FILE=/run/secrets/$password_file_name" \
	--env 'DATABASE_RESTORE_ENABLED=false' \
	--env "APP_REVISION=$services_revision" \
	--log-driver none \
	"$operations_image_id" node --eval "$evidence_validator_source" "$runner_script")"
[[ "$runner_container_id" =~ ^[0-9a-f]{64}$ ]] ||
	die 'Operations rehearsal runner container ID is invalid.'
assert_rehearsal_container "$runner_container_id" "$runner_name" 'runner' ||
	die 'Operations rehearsal runner container identity is invalid.'

[[ "$(docker container inspect --format '{{.HostConfig.NetworkMode}}|{{.HostConfig.ReadonlyRootfs}}|{{.HostConfig.Privileged}}' "$postgres_container_id")" == \
	'none|true|false' ]] ||
	die 'PostgreSQL rehearsal isolation contract drifted.'
[[ "$(docker container inspect --format '{{.HostConfig.NetworkMode}}|{{.HostConfig.ReadonlyRootfs}}|{{.HostConfig.Privileged}}|{{.Config.User}}|{{.Config.WorkingDir}}' "$runner_container_id")" == \
	"container:$postgres_container_id|true|false|1001:1001|/app" ]] ||
	die 'Operations rehearsal runner isolation contract drifted.'
[[ "$(docker container inspect --format '{{.Image}}|{{.Config.User}}|{{.HostConfig.PidsLimit}}|{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{.HostConfig.NanoCpus}}|{{.HostConfig.LogConfig.Type}}' "$postgres_container_id")" == \
	"$postgres_image_id|999:999|256|$postgres_memory_limit_bytes|$postgres_memory_limit_bytes|2000000000|none" ]] ||
	die 'PostgreSQL rehearsal resource or image contract drifted.'
[[ "$(docker container inspect --format '{{.Image}}|{{.Config.User}}|{{.HostConfig.PidsLimit}}|{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{.HostConfig.NanoCpus}}|{{.HostConfig.LogConfig.Type}}' "$runner_container_id")" == \
	"$operations_image_id|1001:1001|256|$runner_memory_limit_bytes|$runner_memory_limit_bytes|2000000000|none" ]] ||
	die 'Operations rehearsal resource or image contract drifted.'
for container_id in "$postgres_container_id" "$runner_container_id"; do
	[[ "$(docker container inspect --format '{{json .HostConfig.CapDrop}}|{{json .HostConfig.SecurityOpt}}|{{len .HostConfig.PortBindings}}' "$container_id")" == \
		'["ALL"]|["no-new-privileges"]|0' ]] ||
		die 'A rehearsal container capability or port boundary drifted.'
	[[ -z "$(docker container inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}' "$container_id")" ]] ||
		die 'A rehearsal container received a persistent Docker volume.'
done

postgres_bind_mounts="$(docker container inspect --format '{{range .Mounts}}{{if eq .Type "bind"}}{{println .Source .Destination .RW}}{{end}}{{end}}' "$postgres_container_id" | LC_ALL=C sort)"
runner_bind_mounts="$(docker container inspect --format '{{range .Mounts}}{{if eq .Type "bind"}}{{println .Source .Destination .RW}}{{end}}{{end}}' "$runner_container_id" | LC_ALL=C sort)"
[[ "$postgres_bind_mounts" == \
	"$postgres_secrets_directory /run/secrets false" ]] ||
	die 'PostgreSQL rehearsal bind mount contract drifted.'
expected_runner_bind_mounts="$(
	printf '%s\n' \
		"$stage_directory /artifacts false" \
		"$runner_secrets_directory /run/secrets false" |
		LC_ALL=C sort
)"
[[ "$runner_bind_mounts" == "$expected_runner_bind_mounts" ]] ||
	die 'Operations rehearsal bind mount contract drifted.'

postgres_tmpfs="$(docker container inspect --format '{{range $path, $options := .HostConfig.Tmpfs}}{{println $path $options}}{{end}}' "$postgres_container_id" | LC_ALL=C sort)"
runner_tmpfs="$(docker container inspect --format '{{range $path, $options := .HostConfig.Tmpfs}}{{println $path $options}}{{end}}' "$runner_container_id" | LC_ALL=C sort)"
expected_postgres_tmpfs="$(
	printf '%s\n' \
		'/tmp rw,noexec,nosuid,nodev,size=64m,uid=999,gid=999,mode=0700' \
		'/var/lib/postgresql rw,noexec,nosuid,nodev,size=1g,uid=999,gid=999,mode=0700' \
		'/var/run/postgresql rw,noexec,nosuid,nodev,size=16m,uid=999,gid=999,mode=0700' |
		LC_ALL=C sort
)"
expected_runner_tmpfs="$(
	printf '%s\n' \
		'/tmp rw,noexec,nosuid,nodev,size=64m,uid=1001,gid=1001,mode=0700' \
		'/work rw,noexec,nosuid,nodev,size=1g,uid=1001,gid=1001,mode=0700' |
		LC_ALL=C sort
)"
[[ "$postgres_tmpfs" == "$expected_postgres_tmpfs" ]] ||
	die 'PostgreSQL rehearsal tmpfs contract drifted.'
[[ "$runner_tmpfs" == "$expected_runner_tmpfs" ]] ||
	die 'Operations rehearsal tmpfs contract drifted.'
[[ "$(docker volume ls -q | LC_ALL=C sort)" == "$volumes_before" ]] ||
	die 'A rehearsal container created an unexpected Docker volume.'

postgres_image_environment="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$postgres_image_id")"
postgres_environment="$(docker container inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$postgres_container_id" | LC_ALL=C sort)"
expected_postgres_environment="$(
	{
		printf '%s\n' "$postgres_image_environment"
		printf '%s\n' \
			"POSTGRES_USER=$expected_postgres_user" \
			"POSTGRES_DB=$expected_postgres_database" \
			"POSTGRES_PASSWORD_FILE=/run/secrets/$password_file_name"
	} | sed '/^$/d' | LC_ALL=C sort
)"
[[ "$postgres_environment" == "$expected_postgres_environment" ]] ||
	die 'PostgreSQL rehearsal environment contract drifted.'

operations_image_environment="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$operations_image_id")"
runner_environment="$(docker container inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$runner_container_id" | LC_ALL=C sort)"
expected_runner_environment="$(
	{
		printf '%s\n' "$operations_image_environment"
		printf '%s\n' \
			'OPERATIONS_RESTORE_ARTIFACT_REHEARSAL_ALLOW_MUTATION=true' \
			'OPERATIONS_RESTORE_ARTIFACT_DIR=/artifacts' \
			'OPERATIONS_RESTORE_ARTIFACT_WORK_DIR=/work' \
			"OPERATIONS_RESTORE_ARTIFACT_POSTGRES_USER=$expected_postgres_user" \
			"OPERATIONS_RESTORE_ARTIFACT_POSTGRES_DB=$expected_postgres_database" \
			"OPERATIONS_RESTORE_ARTIFACT_POSTGRES_PASSWORD_FILE=/run/secrets/$password_file_name" \
			'DATABASE_RESTORE_ENABLED=false' \
			"APP_REVISION=$services_revision"
	} | sed '/^$/d' | LC_ALL=C sort
)"
[[ "$runner_environment" == "$expected_runner_environment" ]] ||
	die 'Operations rehearsal environment contract drifted.'

docker container start "$postgres_container_id" >/dev/null
postgres_health=''
for _ in $(seq 1 60); do
	postgres_health="$(docker container inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$postgres_container_id")"
	[[ "$postgres_health" == 'healthy' ]] && break
	[[ "$postgres_health" != 'unhealthy' ]] ||
		die 'Ephemeral PostgreSQL became unhealthy.'
	sleep 1
done
[[ "$postgres_health" == 'healthy' ]] ||
	die 'Ephemeral PostgreSQL did not become healthy in time.'

if ! timeout --signal=TERM --kill-after=30s 4h \
	docker container start --attach "$runner_container_id" \
	>"$raw_stdout" 2>"$raw_stderr"; then
	die 'The isolated Operations restore runner failed.'
fi
[[ "$(docker container inspect --format '{{.State.Status}}|{{.State.ExitCode}}' "$runner_container_id")" == \
	'exited|0' ]] ||
	die 'The isolated Operations restore runner did not exit successfully.'
[[ ! -s "$raw_stderr" && -s "$raw_stdout" &&
	"$(stat -c '%s' "$raw_stdout")" -le 262144 &&
	"$(wc -l <"$raw_stdout")" -eq 1 ]] ||
	die 'The isolated runner output boundary is invalid.'

[[ "$(docker container inspect --format '{{.State.Running}}|{{.State.Health.Status}}' "$postgres_container_id")" == \
	'true|healthy' ]] ||
	die 'Ephemeral PostgreSQL changed state during evidence capture.'
assert_rehearsal_container "$postgres_container_id" "$postgres_name" 'postgres' ||
	die 'PostgreSQL rehearsal identity changed during execution.'
assert_rehearsal_container "$runner_container_id" "$runner_name" 'runner' ||
	die 'Runner rehearsal identity changed during execution.'
[[ "$(docker image inspect --format '{{.Id}}|{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$operations_image")" == \
	"$operations_image_id|$services_revision" ]] ||
	die 'The Operations image binding changed during the rehearsal.'
[[ "$(artifact_set_digest "$stage_directory")" == "$artifact_set_sha256" ]] ||
	die 'The staged artifact set changed during the rehearsal.'

runner_evidence_part="$evidence_pending_directory/runner.json.part"
runner_evidence="$evidence_pending_directory/runner.json"
install -o root -g root -m 0600 "$raw_stdout" "$runner_evidence_part"
sync -f "$runner_evidence_part"

cleanup_rehearsal ||
	die 'Isolated restore rehearsal cleanup did not restore the Docker inventory.'
trap - EXIT

mv -T "$runner_evidence_part" "$runner_evidence"
sync -f "$evidence_pending_directory"

completed_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
host_evidence_part="$evidence_pending_directory/host.json.part"
host_evidence="$evidence_pending_directory/host.json"
printf '%s\n' \
	"{\"schemaVersion\":1,\"domain\":\"winwidget.infrastructure.isolated-restore-rehearsal.v1\",\"status\":\"SUCCEEDED\",\"runId\":\"$run_id\",\"completedAt\":\"$completed_at\",\"infraRevision\":\"$infra_revision\",\"servicesRevision\":\"$services_revision\",\"operationsImageId\":\"$operations_image_id\",\"postgresImageId\":\"$postgres_image_id\",\"artifactSetSha256\":\"$artifact_set_sha256\",\"sourceTotalBytes\":$source_total_bytes,\"capacityBefore\":{\"memoryAvailableBytes\":$memory_available_bytes,\"diskAvailableBytes\":$disk_available_bytes},\"inventorySha256\":{\"allContainers\":\"$all_containers_inventory_sha256\",\"runningContainers\":\"$running_containers_inventory_sha256\",\"volumes\":\"$volumes_inventory_sha256\",\"networks\":\"$networks_inventory_sha256\"},\"isolation\":{\"postgresNetworkNone\":true,\"runnerSharesOnlyPostgresNamespace\":true,\"readOnlyRootFilesystems\":true,\"tmpfsOnlyDatabaseAndWork\":true,\"capabilitiesDropped\":true,\"noNewPrivileges\":true,\"noPublishedPorts\":true,\"noDockerSocket\":true,\"noProductionEnvironment\":true},\"cleanup\":{\"exactContainersRemoved\":true,\"allContainerInventoryUnchanged\":true,\"runningInventoryUnchanged\":true,\"volumeInventoryUnchanged\":true,\"networkInventoryUnchanged\":true,\"ephemeralSecretsRemoved\":true,\"stagedCopiesRemoved\":true}}" \
	>"$host_evidence_part"
chmod 600 "$host_evidence_part"
sync -f "$host_evidence_part"
mv -T "$host_evidence_part" "$host_evidence"
for evidence_file in "$runner_evidence" "$host_evidence"; do
	evidence_sha256="$(sha256sum "$evidence_file" | awk '{print $1}')"
	printf '%s\n' "$evidence_sha256" >"$evidence_file.sha256"
	chmod 600 "$evidence_file.sha256"
	sync -f "$evidence_file.sha256"
done
sync -f "$evidence_pending_directory"
mv -T "$evidence_pending_directory" "$evidence_directory"
sync -f "$evidence_root"

printf '%s\n' \
	"isolated_restore_rehearsal=SUCCEEDED" \
	"run_id=$run_id" \
	"services_revision=$services_revision" \
	"infra_revision=$infra_revision" \
	"artifact_set_sha256=$artifact_set_sha256" \
	"evidence_directory=$evidence_directory"
REMOTE_CONTROLLER
