import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const scriptPath = new URL(
	'./deploy-services-production.sh',
	import.meta.url
)
const workflowPath = new URL(
	'../.github/workflows/ci.yml',
	import.meta.url
)
const script = readFileSync(scriptPath, 'utf8')
const workflow = readFileSync(workflowPath, 'utf8')

const beginMarker = '# BEGIN WINWIDGET_DOCKER_CLEANUP'
const endMarker = '# END WINWIDGET_DOCKER_CLEANUP'
assert.equal(
	script.split(beginMarker).length - 1,
	1,
	'cleanup begin marker'
)
assert.equal(script.split(endMarker).length - 1, 1, 'cleanup end marker')
const cleanupStart = script.indexOf(beginMarker)
const cleanupEnd = script.indexOf(endMarker, cleanupStart)
assert(
	cleanupStart >= 0 && cleanupEnd > cleanupStart,
	'cleanup block order'
)
const cleanup = script.slice(cleanupStart, cleanupEnd + endMarker.length)

const requireCleanupText = value => {
	assert(cleanup.includes(value), `cleanup contract is missing: ${value}`)
}
for (const evidence of [
	'inspect_validated_project_container()',
	'collect_validated_project_container_inventory()',
	'verify_exact_project_container_inventory()',
	'capture_running_container_ids()',
	'capture_container_image_bindings()',
	'collect_obsolete_winwidget_image_references()',
	'verify_project_has_no_stopped_containers()',
	'cleanup_obsolete_winwidget_docker_resources()',
	'com.docker.compose.project=$COMPOSE_PROJECT_NAME',
	'com.docker.compose.service',
	'com.docker.compose.container-number',
	'com.docker.compose.oneoff',
	'com.docker.compose.config-hash',
	'created | exited)',
	'dead)',
	'Compose container is paused, restarting, removing or in an unknown state.',
	'Live running Compose service inventory differs from the exact manifest contract.',
	'running_ids_before="$(capture_running_container_ids)"',
	'[[ "$running_ids_current" == "$running_ids_before" ]]',
	'[[ "$running_ids_after" == "$running_ids_before" ]]',
	'protected_bindings_before="$(capture_container_image_bindings)"',
	'[[ "$protected_bindings_current" == "$protected_bindings_before" ]]',
	'[[ "$protected_bindings_after" == "$protected_bindings_before" ]]',
	'[[ "$repository" == winwidget-* ]]',
	'docker container rm -- "$container_id"',
	'docker image rm --no-prune -- "$image_reference"',
	'Running Docker container set changed before exact image removal.',
	'Running Docker container set changed after exact image removal.',
	'An unused tagged WinWidget image remains after exact cleanup.'
]) {
	requireCleanupText(evidence)
}

const dockerDeletionLines = script
	.split('\n')
	.map(line => line.trim())
	.filter(line =>
		/^docker\s+(?:(?:container|image|volume|network)\s+rm|rm|(?:system|container|image|builder|buildx|volume|network)\s+prune)\b/.test(
			line
		)
	)
assert.deepEqual(dockerDeletionLines, [
	'docker container rm -- "$container_id" >/dev/null ||',
	'docker image rm --no-prune -- "$image_reference" >/dev/null ||'
])
for (const line of dockerDeletionLines) {
	assert(
		cleanup.includes(line),
		`Docker deletion escaped cleanup block: ${line}`
	)
	assert(
		!/(?:^|\s)(?:-f|--force)(?:\s|$)/.test(line),
		'forced Docker deletion'
	)
}

for (const forbidden of [
	/\bdocker\s+(?:system|container|image|builder|buildx|volume|network)\s+prune\b/,
	/\bdocker\s+(?:volume|network)\s+rm\b/,
	/\bdocker\s+compose\b[^\n]*\bdown\b/,
	/--remove-orphans/,
	/\brm\s+-rf\b/,
	/\.deleteQueue\s*\(/,
	/\bdocker\s+image\s+rm\b[^\n]*\$image_id/
]) {
	assert(
		!forbidden.test(script),
		`forbidden cleanup primitive: ${forbidden}`
	)
}

const cleanupCalls = [
	...script.matchAll(/^cleanup_obsolete_winwidget_docker_resources$/gm)
]
assert.equal(
	cleanupCalls.length,
	1,
	'cleanup must have one production call'
)
const cleanupCall = cleanupCalls[0].index
const envInvariant = script.indexOf(
	"die 'A service-owned production env changed during deployment.'"
)
const preCleanupSteadyStateCall = script.lastIndexOf(
	'\nverify_steady_state_phase pre_cleanup\n',
	cleanupCall
)
const postCleanupSteadyStateCall = script.indexOf(
	'\nverify_steady_state_phase post_cleanup\n',
	cleanupCall
)
const publicRevisionGate = script.lastIndexOf(
	'\'https://api.winwidget.ru/api/v1/health/deployment\' "$services_revision" ||',
	cleanupCall
)
const telegramGate = script.lastIndexOf(
	'\nverify_telegram_proxy_health ||',
	cleanupCall
)
assert(
	envInvariant >= 0 && envInvariant < preCleanupSteadyStateCall,
	'cleanup precedes env gate'
)
assert(publicRevisionGate >= 0, 'cleanup precedes public revision gate')
assert(telegramGate >= 0, 'cleanup precedes Telegram health gate')
assert(
	preCleanupSteadyStateCall < cleanupCall &&
		cleanupCall < postCleanupSteadyStateCall,
	'cleanup must be enclosed by explicit steady-state phases'
)

const steadyStateStart = script.indexOf('verify_steady_state_phase()')
const rolloutStart = script.indexOf(
	'compose_all up -d --no-build --force-recreate "${runtime_without_gateway[@]}"',
	steadyStateStart
)
assert(
	steadyStateStart >= 0 && rolloutStart > steadyStateStart,
	'steady-state phase function boundary'
)
const steadyStatePhase = script.slice(steadyStateStart, rolloutStart)
for (const evidence of [
	'[[ "$phase" == \'pre_cleanup\' || "$phase" == \'post_cleanup\' ]]',
	'verify_exact_project_container_inventory',
	'verify_project_has_no_stopped_containers',
	'verify_current_reporting_routing_projection',
	'Legacy RabbitMQ queue remains in steady state',
	'RabbitMQ user inventory differs from the exact apps-only contract',
	'Legacy RabbitMQ user remains in steady state',
	'Temporary Core PostgreSQL container remains in steady state',
	'Temporary Core PostgreSQL volume remains in steady state',
	'A protected legacy Core/restore artifact remains in steady state',
	'A listener remains on the retired Core port 4200'
]) {
	assert(
		steadyStatePhase.includes(evidence),
		`steady-state phase contract is missing: ${evidence}`
	)
}

assert(
	workflow.includes(
		'node scripts/test-production-docker-cleanup-contract.mjs'
	),
	'infra CI does not execute the cleanup contract test'
)

const behavioralHarness = `
set -euo pipefail

COMPOSE_PROJECT_NAME='winwidget'
infrastructure_services=('postgres')
runtime_services=('api')
scenario='normal'
stopped_present=1
old_ref_one_present=1
old_ref_two_present=1
removed_container_count=0
removed_image_count=0

printf -v project_running_infra '%064x' 10
printf -v project_running_api '%064x' 11
printf -v project_stopped_api '%064x' 12
printf -v foreign_project_stopped '%064x' 13
printf -v unexpected_running_container '%064x' 14
printf -v compose_hash '%064x' 255
image_infra="sha256:$project_running_infra"
image_api="sha256:$project_running_api"
image_obsolete="sha256:$project_stopped_api"
image_foreign_project="sha256:$foreign_project_stopped"

mock_state_directory="$(mktemp -d)"
running_capture_count_file="$mock_state_directory/running-captures"
image_rm_attempt_count_file="$mock_state_directory/image-rm-attempts"
printf '0\\n' >"$running_capture_count_file"
printf '0\\n' >"$image_rm_attempt_count_file"
cleanup_mock_state() {
	rm -f -- "$running_capture_count_file" "$image_rm_attempt_count_file"
	rmdir -- "$mock_state_directory"
}
trap cleanup_mock_state EXIT

die() {
	printf 'contract harness rejected unsafe state: %s\\n' "$1" >&2
	exit 90
}

docker() {
	local command_name="$1"
	shift
	case "$command_name" in
		ps)
			if [[ " $* " == *' -aq '* ]]; then
				if [[ "$*" == *"label=com.docker.compose.project=$COMPOSE_PROJECT_NAME"* ]]; then
					printf '%s\\n' "$project_running_infra" "$project_running_api"
					if ((stopped_present)); then
						printf '%s\\n' "$project_stopped_api"
					fi
				else
					printf '%s\\n' "$project_running_infra" "$project_running_api"
					if ((stopped_present)); then
						printf '%s\\n' "$project_stopped_api"
					fi
					printf '%s\\n' "$foreign_project_stopped"
				fi
			else
				local running_capture_count
				IFS= read -r running_capture_count <"$running_capture_count_file"
				running_capture_count=$((running_capture_count + 1))
				printf '%s\\n' "$running_capture_count" >"$running_capture_count_file"
				printf '%s\\n' "$project_running_api" "$project_running_infra"
				if [[ "$scenario" == 'running-mutation' && \
					"$running_capture_count" -ge 4 ]]; then
					printf '%s\\n' "$unexpected_running_container"
				fi
			fi
			;;
		container)
			[[ "$1" == 'inspect' ]] || return 91
			shift
			local format='' container_id
			if [[ "$1" == '--format' ]]; then
				format="$2"
				container_id="$3"
			else
				container_id="$1"
			fi
			if [[ "$container_id" == "$project_stopped_api" ]] && ((!stopped_present)); then
				return 1
			fi
			case "$container_id" in
				"$project_running_infra" | "$project_running_api" | \
				"$project_stopped_api" | "$foreign_project_stopped") ;;
				*) return 1 ;;
			esac
			[[ -n "$format" ]] || return 0
			if [[ "$format" == *'.Image'* ]]; then
				case "$container_id" in
					"$project_running_infra")
						printf '%s|%s\\n' "$container_id" "$image_infra"
						;;
					"$project_running_api")
						printf '%s|%s\\n' "$container_id" "$image_api"
						;;
					"$project_stopped_api")
						printf '%s|%s\\n' "$container_id" "$image_obsolete"
						;;
					"$foreign_project_stopped")
						printf '%s|%s\\n' "$container_id" "$image_foreign_project"
						;;
				esac
				return 0
			fi
			case "$container_id" in
				"$project_running_infra")
					printf '%s|/winwidget-postgres-1|running|true|false|false|false|winwidget|postgres|1|False|%s\\n' \
						"$container_id" "$compose_hash"
					;;
				"$project_running_api")
					printf '%s|/winwidget-api-1|running|true|false|false|false|winwidget|api|1|False|%s\\n' \
						"$container_id" "$compose_hash"
					;;
				"$project_stopped_api")
					if [[ "$scenario" == 'paused' ]]; then
						printf '%s|/winwidget-api-2|paused|true|true|false|false|winwidget|api|2|False|%s\\n' \
							"$container_id" "$compose_hash"
					elif [[ "$scenario" == 'wrong-project' ]]; then
						printf '%s|/winwidget-api-2|exited|false|false|false|false|foreign|api|2|False|%s\\n' \
							"$container_id" "$compose_hash"
					elif [[ "$scenario" == 'wrong-name' ]]; then
						printf '%s|/foreign-api-2|exited|false|false|false|false|winwidget|api|2|False|%s\\n' \
							"$container_id" "$compose_hash"
					else
						printf '%s|/winwidget-api-2|exited|false|false|false|false|winwidget|api|2|False|%s\\n' \
							"$container_id" "$compose_hash"
					fi
					;;
				*) return 1 ;;
			esac
			;;
		image)
			local image_command="$1"
			shift
			case "$image_command" in
				ls)
					printf 'winwidget-postgres|git-current|%s|<none>\\n' "$image_infra"
					printf 'winwidget-api|git-current|%s|<none>\\n' "$image_api"
					printf 'winwidget-shared|git-keep|%s|<none>\\n' "$image_foreign_project"
					if ((old_ref_one_present)); then
						printf 'winwidget-old|git-old|%s|<none>\\n' "$image_obsolete"
					fi
					if ((old_ref_two_present)); then
						printf 'winwidget-old|latest|%s|<none>\\n' "$image_obsolete"
					fi
					printf 'foreign-image|latest|sha256:%064x|<none>\\n' 15
					;;
				inspect)
					local image_reference
					if [[ "$1" == '--format' ]]; then
						image_reference="$3"
					else
						image_reference="$1"
					fi
					case "$image_reference" in
						winwidget-postgres:git-current) printf '%s\\n' "$image_infra" ;;
						winwidget-api:git-current) printf '%s\\n' "$image_api" ;;
						winwidget-shared:git-keep) printf '%s\\n' "$image_foreign_project" ;;
						winwidget-old:git-old)
							((old_ref_one_present)) || return 1
							printf '%s\\n' "$image_obsolete"
							;;
						winwidget-old:latest)
							((old_ref_two_present)) || return 1
							printf '%s\\n' "$image_obsolete"
							;;
						*) return 1 ;;
					esac
					;;
				rm)
					local image_rm_attempt_count
					IFS= read -r image_rm_attempt_count <"$image_rm_attempt_count_file"
					image_rm_attempt_count=$((image_rm_attempt_count + 1))
					printf '%s\\n' "$image_rm_attempt_count" >"$image_rm_attempt_count_file"
					[[ "$1" == '--no-prune' && "$2" == '--' && "$#" -eq 3 ]] || return 92
					case "$3" in
						winwidget-old:git-old)
							((old_ref_one_present)) || return 1
							old_ref_one_present=0
							;;
						winwidget-old:latest)
							((old_ref_two_present)) || return 1
							old_ref_two_present=0
							;;
						*) return 93 ;;
					esac
					removed_image_count=$((removed_image_count + 1))
					;;
				*) return 94 ;;
			esac
			;;
		*) return 95 ;;
	esac
}

docker_container_rm() {
	return 96
}

${cleanup}

# Intercept the sole allowed container deletion form after the production
# functions have been loaded; all other Docker calls still use the mock above.
eval "$(declare -f docker | sed 's/^docker ()/docker_original ()/')"
docker() {
	if [[ "$1" == 'container' && "$2" == 'rm' ]]; then
		[[ "$3" == '--' && "$#" -eq 4 && "$4" == "$project_stopped_api" ]] || return 97
		((stopped_present)) || return 1
		stopped_present=0
		removed_container_count=$((removed_container_count + 1))
		return 0
	fi
	docker_original "$@"
}

# A stopped foreign-project container is outside the deletion target while its
# image binding remains protected from WinWidget tag cleanup.
if grep -Fqx -- "$foreign_project_stopped" <<<"$(capture_running_container_ids)"; then
	die 'Stopped foreign-project container appeared in the running ID set.'
fi
grep -Fqx -- \
	"$foreign_project_stopped|$image_foreign_project" \
	<<<"$(capture_container_image_bindings)" ||
	die 'Stopped foreign-project container image binding is not protected.'

cleanup_obsolete_winwidget_docker_resources
[[ "$stopped_present" -eq 0 && "$removed_container_count" -eq 1 ]]
[[ "$old_ref_one_present" -eq 0 && "$old_ref_two_present" -eq 0 ]]
[[ "$removed_image_count" -eq 2 ]]
docker image inspect winwidget-postgres:git-current >/dev/null
docker image inspect winwidget-api:git-current >/dev/null
docker image inspect winwidget-shared:git-keep >/dev/null

# The exact cleanup is idempotent once no valid target remains.
cleanup_obsolete_winwidget_docker_resources
[[ "$removed_container_count" -eq 1 && "$removed_image_count" -eq 2 ]]

# A new running container discovered immediately before image deletion must
# abort before Docker receives any image-rm command.
printf '0\\n' >"$running_capture_count_file"
printf '0\\n' >"$image_rm_attempt_count_file"
if (
	trap - EXIT
	scenario='running-mutation'
	stopped_present=1
	old_ref_one_present=1
	old_ref_two_present=1
	cleanup_obsolete_winwidget_docker_resources >/dev/null 2>&1
); then
	die 'Running-ID mutation did not block image cleanup.'
fi
IFS= read -r image_rm_attempt_count <"$image_rm_attempt_count_file"
[[ "$image_rm_attempt_count" -eq 0 ]] ||
	die 'Image deletion started after a running-ID mutation.'

if (
	trap - EXIT
	scenario='paused'
	stopped_present=1
	inspect_validated_project_container "$project_stopped_api" >/dev/null 2>&1
); then
	die 'Paused project container was accepted by cleanup validation.'
fi
if (
	trap - EXIT
	scenario='wrong-project'
	stopped_present=1
	inspect_validated_project_container "$project_stopped_api" >/dev/null 2>&1
); then
	die 'A foreign Compose project container was accepted by cleanup validation.'
fi
if (
	trap - EXIT
	scenario='wrong-name'
	stopped_present=1
	inspect_validated_project_container "$project_stopped_api" >/dev/null 2>&1
); then
	die 'A container with mismatched Compose name and labels was accepted.'
fi

printf 'production_docker_cleanup_behavior=PASS\\n'
`

const behavior = spawnSync('bash', ['-s'], {
	encoding: 'utf8',
	input: behavioralHarness
})
assert.equal(
	behavior.status,
	0,
	`cleanup behavior harness failed:\n${behavior.stdout}${behavior.stderr}`
)
assert.match(
	behavior.stdout,
	/production_docker_cleanup_behavior=PASS/,
	'cleanup behavior harness did not reach its final assertions'
)

process.stdout.write('production_docker_cleanup_contract=PASS\n')
