#!/usr/bin/env bash
# Sourced only by the hash-pinned production controller after its SSH, immutable
# origin/prod checkout, canonical env and root-owned flock gates. No transport,
# production credentials, source selection or independent deploy entrypoint.
# Globals below are supplied and validated by that controller before sourcing.
# shellcheck disable=SC2154
[[ "${BASH_SOURCE[0]}" != "$0" ]] || {
	printf '%s\n' 'Use the pinned reusable production workflow.' >&2
	exit 1
}

scoped_assert_hash() {
	local file="$1" expected="$2"
	[[ "$expected" =~ ^[a-f0-9]{64}$ ]] || die 'Invalid approved scoped file hash.'
	assert_root_owned_file "$file"
	[[ "$(stat -c '%a' "$file")" == 600 && "$(sha256sum "$file" | awk '{print $1}')" == "$expected" ]] ||
		die 'Scoped input differs from its approved bytes or owner boundary.'
}

scoped_container_id() {
	local id
	id="$(docker ps --no-trunc --filter label=com.docker.compose.project=winwidget \
		--filter "label=com.docker.compose.service=$1" --format '{{.ID}}')" || return 1
	[[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
	printf '%s\n' "$id"
}

scoped_inventory() {
	local id service image revision ids
	ids="$(docker ps --no-trunc --filter label=com.docker.compose.project=winwidget --format '{{.ID}}')" || return 1
	[[ -n "$ids" ]] || return 1
	while IFS= read -r id; do
		[[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
		read -r service image revision < <(docker inspect --format \
			'{{index .Config.Labels "com.docker.compose.service"}} {{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$id")
		[[ "$service" =~ ^[a-z][a-z0-9-]*$ && "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
		case " ${scoped_targets[*]:-} " in *" $service "*) continue ;; esac
		printf '%s %s %s %s\n' "$service" "$id" "$image" "$revision"
	done <<<"$ids"
}

scoped_env_inventory() {
	local file files
	files="$(find "$services_repository/apps" -mindepth 2 -maxdepth 2 -type f -name .env.production | LC_ALL=C sort)" || return 1
	[[ -n "$files" ]] || return 1
	while IFS= read -r file; do
		assert_root_owned_file "$file"
		sha256sum "$file"
	done <<<"$files"
}

scoped_assert_unchanged_neighbors() {
	local neighbors envs
	neighbors="$(scoped_inventory | LC_ALL=C sort)" || die 'Cannot verify scoped production neighbors.'
	envs="$(scoped_env_inventory)" || die 'Cannot verify scoped production env inventory.'
	[[ "$neighbors" == "$scoped_neighbors_before" ]] ||
		die 'A non-target production container/image changed during the scoped operation.'
	[[ "$envs" == "$scoped_envs_before" &&
		"$(sha256sum "$env_file" | awk '{print $1}')" == "$expected_env_sha256" ]] ||
		die 'Production env changed during the scoped operation.'
}

scoped_set_image_variables() {
	local owner reference id image revision prefix
	for owner in api-gateway notification-delivery campaigns reporting widgets billing identity platform support operations; do
		case "$owner" in
			api-gateway) reference=api-gateway ;;
			notification-delivery) reference=notification-delivery-worker ;;
			campaigns | reporting | widgets) reference="$owner-service" ;;
			*) reference="$owner-api" ;;
		esac
		id="$(scoped_container_id "$reference")" || die 'A required existing service is not uniquely running.'
		read -r image revision < <(docker inspect --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$id")
		[[ "$image" =~ ^sha256:[a-f0-9]{64}$ && "$revision" =~ ^[a-f0-9]{40}$ ]] ||
			die 'An existing service has no immutable image identity.'
		if [[ "$owner" == api-gateway ]]; then
			export APP_VERSION="git-$revision" APP_REVISION="$revision"
			[[ "$(docker image inspect --format '{{.Id}}' "winwidget-api-gateway:$APP_VERSION")" == "$image" ]] ||
				die 'Live Gateway image tag no longer resolves to its exact image ID.'
		else
			prefix="${owner//-/_}"
			prefix="$(printf '%s' "$prefix" | tr '[:lower:]' '[:upper:]')"
			printf -v "${prefix}_IMAGE" '%s' "$image"
			printf -v "${prefix}_REVISION" '%s' "$revision"
			export "${prefix}_IMAGE" "${prefix}_REVISION"
		fi
	done
}

scoped_source_compose() {
	docker compose --profile '*' --project-name winwidget \
		--env-file "$env_file" "${scoped_env_arguments[@]}" -f "$compose_file" "$@"
}

scoped_compose() {
	local snapshot="$1"
	shift
	[[ "$snapshot" == desired || "$snapshot" == rollback ]] || return 1
	docker compose --project-name winwidget -f "$scoped_work_directory/$snapshot.json" "$@"
}

scoped_verifier() {
	local verification_revision="${operations_runtime_revision:-$services_revision}"
	if [[ "$release_scope" == operations-federation-config ]]; then verification_revision="$expected_live_revision"; fi
	docker run --rm --interactive --network none --read-only --cap-drop ALL \
		--security-opt no-new-privileges --user 0:0 \
		--env "SCOPED_SCOPE=$release_scope" --env "SCOPED_REVISION=$verification_revision" \
		--env "SCOPED_PREVIOUS_REVISION=$expected_live_revision" \
		--env "SCOPED_OPERATIONS_PREVIOUS_REVISION=${expected_operations_revision:-}" \
		--env "SCOPED_OPERATIONS_API_PREVIOUS_REVISION=${expected_operations_api_revision:-}" \
		--env "SCOPED_DATABASE_ID=${scoped_database_id:-}" \
		--env "SCOPED_MIGRATION_MANIFEST_SHA256=${scoped_migration_manifest_sha256:-}" \
		--env "SCOPED_APPLICATION_TREE=${scoped_application_tree:-}" \
		--env "SCOPED_INFRA_REVISION=$infra_revision" \
		--env "SCOPED_NOTES_CHECKSUM=${scoped_notes_checksum:-}" \
		--volume "$scoped_payload_directory/verifier.mjs:/run/scoped-verifier.mjs:ro" \
		--volume "$scoped_work_directory:/run/scoped" \
		--entrypoint node "$scoped_image_id" /run/scoped-verifier.mjs "$@"
}

scoped_database() {
	local action="$1" owner="${2:-$scoped_owner}" output key value
	output="$(scoped_source_compose run --rm --no-deps --interactive \
		--volume "$scoped_payload_directory/verifier.mjs:/run/scoped-verifier.mjs:ro" \
		--entrypoint node "$owner-migrate" /run/scoped-verifier.mjs database "$action" "$owner")" ||
		die 'Scoped database migration/identity/fence preflight failed.'
	scoped_database_id=''
	scoped_migration_manifest_sha256=''
	while IFS='=' read -r key value; do
		case "$key" in
			DATABASE_ID)
				[[ "$value" =~ ^[a-f0-9-]{36}$ && -z "$scoped_database_id" ]] || die 'Invalid scoped database identity receipt.'
				scoped_database_id="$value" ;;
			MIGRATION_MANIFEST_SHA256)
				[[ "$value" =~ ^[a-f0-9]{64}$ && -z "$scoped_migration_manifest_sha256" ]] || die 'Invalid scoped migration manifest receipt.'
				scoped_migration_manifest_sha256="$value" ;;
			*) die 'Unexpected scoped database verification output.' ;;
		esac
	done <<<"$output"
	[[ -n "$scoped_database_id" && -n "$scoped_migration_manifest_sha256" ]] || die 'Missing scoped database verification output.'
}

scoped_wait_healthy() {
	local deadline=$((SECONDS + 180)) name id status ready
	while ((SECONDS < deadline)); do
		ready=true
		for name in "${scoped_targets[@]}"; do
			id="$(scoped_container_id "$name")" || { ready=false; continue; }
			status="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id")" || return 1
			[[ "$status" != 'running unhealthy' ]] || return 1
			[[ "$status" == 'running healthy' ]] || ready=false
		done
		[[ "$ready" != true ]] || return 0
		sleep 2
	done
	return 1
}

scoped_verify_target_images() {
	local name id image revision expected_image
	for name in "${scoped_targets[@]}"; do
		id="$(scoped_container_id "$name")" || return 1
		read -r image revision < <(docker inspect --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$id")
		expected_image="$scoped_image_id"
		if [[ "$release_scope" == identity-with-operations-manifest && "$name" == operations-* ]]; then expected_image="$scoped_operations_image_id"; fi
		if [[ "$release_scope" == workers-bootstrap-recovery ]]; then
			case "$name" in operations-*) expected_image="$scoped_operations_image_id" ;; support-*) expected_image="$scoped_support_image_id" ;; esac
		fi
		[[ "$image" == "$expected_image" && "$revision" == "$scoped_runtime_revision" ]] || return 1
	done
}

scoped_assert_worker_source() {
	local changes path hashes before after owner
	# All app build contexts are bounded; no migration/schema, package, Docker,
	# API/domain, CRM or shared runtime edits may ride this recovery release.
	changes="$(git -C "$release_root" diff --name-only "$expected_live_revision" "$services_revision" -- apps)" || return 1
	[[ -n "$changes" ]] || return 1
	while IFS= read -r path; do
		case "$path" in
			apps/billing/src/main.ts | apps/operations/src/main.ts | apps/support/src/main.ts | \
			apps/billing/src/main.spec.ts | apps/operations/src/main.spec.ts | apps/support/src/main.spec.ts | \
			apps/billing/src/runtime/bootstrap-failure.ts | apps/operations/src/runtime/bootstrap-failure.ts | apps/support/src/runtime/bootstrap-failure.ts | \
			apps/billing/src/runtime/bootstrap-failure.spec.ts | apps/operations/src/runtime/bootstrap-failure.spec.ts | apps/support/src/runtime/bootstrap-failure.spec.ts) continue ;;
			# Exact reviewed qs-only lockfiles. Billing dependencies stay unchanged.
			apps/operations/pnpm-lock.yaml) hashes='6268a07f4d5f104e72b46c525a91a4a54346849c10f1fbd46a7902769a1a777c f890de4c88d1a06418bafea8d08732178bba5e6ba561765f2ed049511d13dded' ;;
			apps/support/pnpm-lock.yaml) hashes='75b3f03dde5f1ba6de36bf6414a85628f39e83440e7e6b760c904f2c8c73d47b 250982c8d4449b674dc1973ae1b69217f4b6071d8ff3e492750b27dea688aee1' ;;
			apps/notification-delivery/pnpm-lock.yaml) hashes='7fffd7c6fa71b08a297a9dfc950824a4be83526d83695bd5a27c5119f6ddb5b3 9b003c6fac565127c8080fa99e3c456eff0cc5a7b61ec6325e9ac01ad771683e' ;;
			apps/campaigns/pnpm-lock.yaml) hashes='4c5f260e4210ff0fb43f52ff955e7c899abc210bb8a78785c7b6aa2e46b05c7a d912e13d6ccc29558568837f758e553290c0be961194430ffa89653fbe47434b' ;;
			apps/reporting/pnpm-lock.yaml) hashes='55e4a78f5763ab46fdf2463086f8473bdc7982fb0b1c2786cab287913316d563 056976c5e08a7ce8abd24dc24c93cdc8cc2fd7ba05fea2a26a5cc54b8bda8a1f' ;;
			apps/widgets/pnpm-lock.yaml) hashes='86a2188a5ab5b27ee0dc201291cf893554992e1de84249e6624a8edd2565f72d 1fac1e49ee942dc7d62f97fb6ae875dc7bbed22ca1c02ae8e1685db143d4913d' ;;
			apps/identity/pnpm-lock.yaml) hashes='ad884866fcebea23b7d79b53b515b131f4e88e11ec0c3bd411d942dcc46eb215 05d918beaf4e6cb27856d417464fbd8a99279a50583d4a5e795c1fd63581f241' ;;
			apps/platform/pnpm-lock.yaml) hashes='43e3f9b66437458a180f5db4da7bf4690c873305612a9672f81536c3ff3ac208 6e05a87a7969056e5112832b76828f12ca0f9bb113928ca7081977651ab907f3' ;;
			*) return 1 ;;
		esac
		read -r before after <<<"$hashes"
		[[ "$(git -C "$release_root" show "$expected_live_revision:$path" | sha256sum | awk '{print $1}')" == "$before" &&
			"$(sha256sum "$release_root/$path" | awk '{print $1}')" == "$after" ]] || return 1
	done <<<"$changes"
	for owner in billing operations support; do
		for path in "apps/$owner/src/main.ts" "apps/$owner/src/runtime/bootstrap-failure.ts"; do
			[[ $'\n'"$changes"$'\n' == *$'\n'"$path"$'\n'* && -f "$release_root/$path" && ! -L "$release_root/$path" ]] || return 1
		done
	done
}

scoped_workers_quiet() {
	local owner broker action=worker-quiet
	local -a owners=(billing operations support)
	if [[ "$release_scope" == identity-with-operations-manifest || "$release_scope" == operations-runtime ]]; then owners=(operations); action=operations-quiet; fi
	broker="$(scoped_container_id rabbitmq)" || return 1
	[[ "$(docker inspect --format '{{.State.Health.Status}}' "$broker")" == healthy ]] || return 1
	docker exec "$broker" rabbitmq-diagnostics -q check_running >/dev/null 2>&1 || return 1
	docker exec "$broker" rabbitmq-diagnostics -q check_port_connectivity >/dev/null 2>&1 || return 1
	docker exec "$broker" rabbitmqctl --quiet --formatter json list_channels consumer_count messages_unacknowledged messages_unconfirmed confirm |
		scoped_verifier broker-quiet >/dev/null 2>&1 || return 1
	for owner in "${owners[@]}"; do
		scoped_source_compose run --rm --no-deps --interactive \
			--volume "$scoped_payload_directory/verifier.mjs:/run/scoped-verifier.mjs:ro" \
			--entrypoint node "$owner-migrate" /run/scoped-verifier.mjs database "$action" "$owner" >/dev/null 2>&1 || return 1
	done
}

scoped_workers_graceful_stop() {
	local id state deadline=$((SECONDS + 45)) stopped
	for id in "$@"; do
		[[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
		state="$(docker inspect --format '{{.State.Running}} {{.State.Pid}}' "$id")" || return 1
		[[ "$state" == 'false 0' ]] || docker kill --signal=TERM "$id" >/dev/null 2>&1 || return 1
	done
	while ((SECONDS < deadline)); do
		stopped=true
		for id in "$@"; do
			[[ "$(docker inspect --format '{{.State.Running}} {{.State.Pid}}' "$id")" == 'false 0' ]] || stopped=false
		done
		[[ "$stopped" != true ]] || return 0
		sleep 1
	done
	return 1
}

scoped_workers_rollback_ready() {
	local name id
	local -a ids=()
	for name in "${scoped_targets[@]}"; do
		id="$(docker ps --all --no-trunc --filter label=com.docker.compose.project=winwidget --filter "label=com.docker.compose.service=$name" --format '{{.ID}}')" || return 1
		[[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
		ids+=("$id")
	done
	scoped_workers_quiet && scoped_workers_graceful_stop "${ids[@]}" && scoped_workers_quiet || return 1
	for id in "${ids[@]}"; do
		[[ "$(docker inspect --format '{{.State.Running}} {{.State.Pid}}' "$id")" == 'false 0' ]] || return 1
	done
}

scoped_cleanup() {
	local exit_code="$?" name id fence_confirmed=true
	# Bash 5 can enter EXIT while a signalled function still redirects fd 2.
	# Restore only diagnostics; raw Docker/Compose output remains suppressed.
	exec 2>&"$scoped_diagnostic_fd"
	trap - EXIT
	trap '' INT TERM HUP
	set +e
	if [[ "$exit_code" != 0 && "${scoped_identity_ddl_started:-false}" == true ]]; then
		# A failed migration process does not prove PostgreSQL rolled back. Never
		# let an old manifest sign a backup after a successful/unknown Identity DDL.
		for name in operations-api operations-worker operations-outbox-publisher operations-restore-worker; do
			id="$(docker ps --no-trunc --filter label=com.docker.compose.project=winwidget --filter "label=com.docker.compose.service=$name" --format '{{.ID}}')" || { fence_confirmed=false; continue; }
			[[ -n "$id" ]] || continue
			if [[ ! "$id" =~ ^[a-f0-9]{64}$ ]] || ! scoped_workers_graceful_stop "$id" ||
				[[ "$(docker inspect --format '{{.State.Running}} {{.State.Pid}}' "$id")" != 'false 0' ]]; then fence_confirmed=false; fi
		done
		if [[ "$fence_confirmed" == true ]]; then
			printf '%s\n' 'RECOVERY_REQUIRED: Operations remains fenced; prove Identity ledger/manifest agreement before resuming it.' >&2
		else
			printf '%s\n' 'RECOVERY_REQUIRED: Operations stop could not be proven; urgently verify its physical fence and Identity ledger/manifest. No old manifest was resumed.' >&2
		fi
	elif [[ "$exit_code" != 0 && "${scoped_operations_stopped:-false}" == true && "${scoped_cutover_started:-false}" == false ]]; then
		if scoped_workers_quiet && docker start "${scoped_operations_ids[@]}" >/dev/null 2>&1 && scoped_wait_healthy; then
			printf '%s\n' 'Pre-DDL drain failed; unchanged Operations containers were resumed on their original manifests.' >&2
		else
			printf '%s\n' 'RECOVERY_REQUIRED: pre-DDL Operations restart needs operator verification.' >&2
		fi
	elif [[ "$exit_code" != 0 && "${scoped_cutover_started:-false}" == true && "${scoped_fence_started:-false}" == false ]]; then
		if { [[ "$release_scope" != workers-bootstrap-recovery && "$release_scope" != operations-runtime ]] || scoped_workers_rollback_ready; } &&
			scoped_compose rollback up -d --no-build --no-deps --force-recreate "${scoped_targets[@]}" >/dev/null 2>&1 && scoped_wait_healthy; then
			printf '%s\n' 'Scoped rollback restored the preserved image/config; additive migrations were not reversed.' >&2
		else
			printf '%s\n' 'CRITICAL: scoped rollback requires operator recovery; preserved snapshots were retained.' >&2
		fi
	elif [[ "$exit_code" != 0 && "${scoped_workers_stop_started:-false}" == true ]]; then
		printf '%s\n' 'RECOVERY_REQUIRED: inspect scoped processes; graceful stop was incomplete. No force-kill or automatic old-worker restart was attempted.' >&2
	fi
	if [[ "$exit_code" == 0 && -n "${scoped_work_directory:-}" ]]; then
		find "$scoped_work_directory" -mindepth 1 -maxdepth 1 -type f -delete
		rmdir "$scoped_work_directory"
	elif [[ -n "${scoped_work_directory:-}" ]]; then
		printf 'Protected scoped recovery snapshots retained: %s\n' "$scoped_work_directory" >&2
	fi
	cleanup_scoped_payload
	exit "$exit_code"
}

scoped_assert_backlog_already_finalized() {
	local id image finalized notes_checksum
	id="$(scoped_container_id operations-api)" || die 'Cannot prove Operations destructive migration is already finalized.'
	image="$(docker inspect --format '{{.Image}}' "$id")"
	[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || die 'Invalid Operations image identity for all-services gate.'
	finalized="$app_root/deploy/backend/scoped-releases/operations-backlog/finalized.json"
	assert_root_owned_directory "$app_root/deploy/backend/scoped-releases"
	assert_root_owned_directory "$app_root/deploy/backend/scoped-releases/operations-backlog"
	assert_root_owned_file "$finalized"
	assert_root_owned_file "$services_repository/apps/operations/.env.production"
	[[ "$(stat -c '%a' "$finalized")" == 600 ]] || die 'Unsafe Operations finalized receipt.'
	notes_checksum="$(sha256sum "$release_root/apps/operations/prisma/migrations/20260910110000_remove_admin_backlog/migration.sql" | awk '{print $1}')"
	docker run --rm --network host --read-only --cap-drop ALL --security-opt no-new-privileges \
		--env-file "$services_repository/apps/operations/.env.production" \
		--env "SCOPED_NOTES_CHECKSUM=$notes_checksum" \
		--volume "$finalized:/run/scoped/finalized.json:ro" \
		--volume "$scoped_payload_directory/verifier.mjs:/run/scoped-verifier.mjs:ro" \
		--entrypoint node "$image" /run/scoped-verifier.mjs database all-guard operations ||
		die 'All-services deployment is forbidden while destructive Notes finalization is unproven.'
}

scoped_deploy_main() {
	local id name prefix image_revision old_image revision image_tag companion_files receipt_staging receipt_destination owner before_receipt role_revision
	[[ "${scoped_diagnostic_fd:-}" =~ ^[0-9]+$ && "$scoped_diagnostic_fd" -gt 2 && "$scoped_diagnostic_fd" != "$deploy_lock_fd" ]] ||
		die 'Scoped recovery diagnostic descriptor is invalid.'
	[[ "$release_scope" =~ ^(identity-with-operations-manifest|operations-runtime|operations-backlog-finalize|gateway-remove-notes|workers-bootstrap-recovery|operations-federation-config)$ &&
		"$services_revision" =~ ^[a-f0-9]{40}$ && "$expected_live_revision" =~ ^[a-f0-9]{40}$ ]] ||
		die 'Invalid scoped release authorization.'
	[[ "$(stat -Lc '%d:%i' "/proc/self/fd/$deploy_lock_fd")" == "$(stat -c '%d:%i' "$deploy_lock")" ]] ||
		die 'Scoped deployment did not inherit the canonical production lock.'
	flock -n "$deploy_lock_fd" || die 'Scoped deployment lost the canonical production lock.'
	case "$release_scope" in
		operations-federation-config) scoped_owner=operations; scoped_targets=(operations-api) ;;
		workers-bootstrap-recovery) scoped_owner=billing; scoped_targets=(billing-api billing-worker billing-outbox-publisher operations-worker operations-outbox-publisher operations-restore-worker support-worker support-outbox-publisher) ;;
		identity-with-operations-manifest) scoped_owner=identity; scoped_targets=(identity-api identity-worker identity-outbox-publisher operations-api operations-worker operations-outbox-publisher operations-restore-worker) ;;
		operations-runtime) scoped_owner=operations; scoped_targets=(operations-api operations-worker operations-outbox-publisher operations-restore-worker) ;;
		operations-backlog-finalize) scoped_owner=operations; scoped_targets=() ;;
		gateway-remove-notes) scoped_owner=api-gateway; scoped_targets=(api-gateway) ;;
	esac
	scoped_owner_env="$services_repository/apps/$scoped_owner/.env.production"
	scoped_assert_hash "$scoped_owner_env" "$expected_service_env_sha256"
	scoped_env_arguments=(--env-file "$scoped_owner_env")
	if [[ "$release_scope" == workers-bootstrap-recovery ]]; then
		[[ "$expected_operations_revision" == "$expected_live_revision" ]] || die 'Worker owners must share the approved live revision.'
		scoped_assert_hash "$services_repository/apps/operations/.env.production" "$expected_operations_env_sha256"
		scoped_assert_hash "$services_repository/apps/support/.env.production" "$expected_support_env_sha256"
		scoped_env_arguments+=(--env-file "$services_repository/apps/operations/.env.production" --env-file "$services_repository/apps/support/.env.production")
		scoped_assert_worker_source || die 'Worker recovery source exceeds the exact bootstrap and qs-only allowlist.'
	fi
	if [[ "$release_scope" == identity-with-operations-manifest ]]; then
		scoped_assert_hash "$services_repository/apps/operations/.env.production" "$expected_operations_env_sha256"
		scoped_env_arguments+=(--env-file "$services_repository/apps/operations/.env.production")
		[[ "$expected_operations_revision" =~ ^[a-f0-9]{40}$ ]] || die 'Invalid approved Operations companion revision.'
		companion_files="$(git -C "$release_root" diff --name-only "$expected_operations_revision" "$services_revision" -- apps/operations)"
		if [[ -n "${expected_operations_api_revision:-}" ]]; then
			[[ "$expected_operations_api_revision" =~ ^[a-f0-9]{40}$ && "$companion_files" == apps/operations/restore-manifests/database-restore-migrations.json &&
				-z "$(git -C "$release_root" diff --name-only "$expected_operations_revision" "$services_revision" -- apps/billing apps/support)" ]] || die 'Mixed baseline must preserve worker recovery source.'
			for owner in billing operations support; do
				git -C "$release_root" cat-file -e "$expected_operations_revision:apps/$owner/src/runtime/bootstrap-failure.ts" || die 'Worker baseline has no bootstrap recovery.'
			done
		fi
		case "$companion_files" in
			'apps/operations/restore-manifests/database-restore-migrations.json') ;;
			$'apps/operations/pnpm-lock.yaml\napps/operations/restore-manifests/database-restore-migrations.json')
				# Reviewed qs 6.15.3 -> 6.16.0 security-only patch: exact old/new
				# whole-file hashes also reject changed transitive dependencies.
				[[ "$(git -C "$release_root" show "$expected_operations_revision:apps/operations/pnpm-lock.yaml" | sha256sum | awk '{print $1}')" == 6268a07f4d5f104e72b46c525a91a4a54346849c10f1fbd46a7902769a1a777c &&
					"$(sha256sum "$release_root/apps/operations/pnpm-lock.yaml" | awk '{print $1}')" == f890de4c88d1a06418bafea8d08732178bba5e6ba561765f2ed049511d13dded ]] ||
					die 'Operations dependency patch differs from the exact reviewed qs security fix.' ;;
			*) die 'Operations companion may change only its restore manifest and the exact reviewed qs lockfile patch.' ;;
		esac
	fi
	[[ "$(sha256sum "$env_file" | awk '{print $1}')" == "$expected_env_sha256" ]] || die 'Canonical production env changed before scoped deployment.'
	scoped_neighbors_before="$(scoped_inventory | LC_ALL=C sort)"
	scoped_envs_before="$(scoped_env_inventory)"
	scoped_set_image_variables
	export COMPOSE_PROJECT_NAME=winwidget
	scoped_runtime_revision="$services_revision"
	if [[ "$scoped_owner" == api-gateway ]]; then id="$(scoped_container_id api-gateway)"; else id="$(scoped_container_id "$scoped_owner-api")"; fi
	read -r old_image revision < <(docker inspect --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$id")
	[[ "$revision" == "$expected_live_revision" ]] || die 'Live owner revision differs from the approved baseline.'
	[[ "$old_image" =~ ^sha256:[a-f0-9]{64}$ ]] || die 'Invalid preserved owner image ID.'
	scoped_image_id="$old_image"
	scoped_cutover_started=false
	scoped_fence_started=false
	scoped_work_directory="$(mktemp -d "$app_root/deploy/backend/.scoped-release.XXXXXX")"
	chmod 700 "$scoped_work_directory"
	trap scoped_cleanup EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	trap 'exit 129' HUP
	if [[ "$release_scope" == identity-with-operations-manifest || "$release_scope" == operations-runtime || "$release_scope" == workers-bootstrap-recovery ]]; then
		image_tag="winwidget-$scoped_owner:git-$services_revision"
		docker build --build-arg "APP_REVISION=$services_revision" --tag "$image_tag" "$release_root/apps/$scoped_owner" >/dev/null 2>&1 || die 'Scoped immutable image build failed.'
		read -r scoped_image_id image_revision < <(docker image inspect --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_tag")
		[[ "$scoped_image_id" =~ ^sha256:[a-f0-9]{64}$ && "$image_revision" == "$services_revision" ]] || die 'Scoped image does not match the exact green source revision.'
	else
		scoped_runtime_revision="$expected_live_revision"
	fi
	if [[ "$scoped_owner" != api-gateway ]]; then
		prefix="$(printf '%s' "$scoped_owner" | tr '[:lower:]' '[:upper:]')"
		printf -v "${prefix}_IMAGE" '%s' "$scoped_image_id"
		printf -v "${prefix}_REVISION" '%s' "$scoped_runtime_revision"
		export "${prefix}_IMAGE" "${prefix}_REVISION"
	fi
	if [[ "$release_scope" == workers-bootstrap-recovery ]]; then
		for owner in operations support; do
			id="$(scoped_container_id "$owner-worker")" || die 'A worker owner is not uniquely running.'
			read -r old_image revision < <(docker inspect --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$id")
			[[ "$revision" == "$expected_live_revision" && "$old_image" =~ ^sha256:[a-f0-9]{64}$ ]] || die 'Worker owner differs from the approved live baseline.'
			if [[ "$owner" == operations ]]; then
				docker run --rm --network none --entrypoint node "$old_image" -e \
					'process.stdout.write(require("node:fs").readFileSync("/app/restore-manifests/database-restore-migrations.json"))' >"$scoped_work_directory/operations-manifest-before.json"
			fi
			image_tag="winwidget-$owner:git-$services_revision"
			docker build --build-arg "APP_REVISION=$services_revision" --tag "$image_tag" "$release_root/apps/$owner" >/dev/null 2>&1 || die 'Worker owner immutable image build failed.'
			read -r old_image image_revision < <(docker image inspect --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_tag")
			[[ "$old_image" =~ ^sha256:[a-f0-9]{64}$ && "$image_revision" == "$services_revision" ]] || die 'Worker image differs from the exact green revision.'
			printf -v "scoped_${owner}_image_id" '%s' "$old_image"
			prefix="$(printf '%s' "$owner" | tr '[:lower:]' '[:upper:]')"
			printf -v "${prefix}_IMAGE" '%s' "$old_image"
			printf -v "${prefix}_REVISION" '%s' "$services_revision"
			export "${prefix}_IMAGE" "${prefix}_REVISION"
			docker image inspect "$old_image" >"$scoped_work_directory/$owner-image.json"
			if [[ "$owner" == operations ]]; then
				docker run --rm --network none --entrypoint node "$old_image" -e \
					'process.stdout.write(require("node:fs").readFileSync("/app/restore-manifests/database-restore-migrations.json"))' >"$scoped_work_directory/operations-manifest-after.json"
				cmp -s "$scoped_work_directory/operations-manifest-before.json" "$scoped_work_directory/operations-manifest-after.json" || die 'Worker recovery must preserve the exact Operations restore manifest.'
			fi
		done
	fi
	if [[ "$release_scope" == identity-with-operations-manifest ]]; then
		scoped_operations_ids=()
		for name in operations-api operations-worker operations-outbox-publisher operations-restore-worker; do
			id="$(scoped_container_id "$name")" || die 'Operations companion process is not uniquely running.'
			read -r old_image revision < <(docker inspect --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$id")
			role_revision="$expected_operations_revision"
			if [[ "$name" == operations-api ]]; then role_revision="${expected_operations_api_revision:-$role_revision}"; fi
			[[ "$revision" == "$role_revision" && "$old_image" =~ ^sha256:[a-f0-9]{64}$ ]] || die 'Operations role differs from its approved baseline.'
			scoped_operations_ids+=("$id")
			docker run --rm --network none --entrypoint node "$old_image" -e \
				'process.stdout.write(require("node:fs").readFileSync("/app/restore-manifests/database-restore-migrations.json"))' >"$scoped_work_directory/role-manifest.json"
			if [[ "$name" == operations-api ]]; then cp "$scoped_work_directory/role-manifest.json" "$scoped_work_directory/operations-manifest-before.json";
			else cmp -s "$scoped_work_directory/role-manifest.json" "$scoped_work_directory/operations-manifest-before.json" || die 'Live Operations manifests disagree.'; fi
		done
		scoped_operations_stopped=false
		scoped_identity_ddl_started=false
		docker build --build-arg "APP_REVISION=$services_revision" --tag "winwidget-operations:git-$services_revision" "$release_root/apps/operations" >/dev/null 2>&1 || die 'Operations manifest companion image build failed.'
		read -r scoped_operations_image_id image_revision < <(docker image inspect --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "winwidget-operations:git-$services_revision")
		[[ "$scoped_operations_image_id" =~ ^sha256:[a-f0-9]{64}$ && "$image_revision" == "$services_revision" ]] || die 'Operations companion immutable image identity is invalid.'
		export OPERATIONS_IMAGE="$scoped_operations_image_id" OPERATIONS_REVISION="$services_revision"
		docker image inspect "$scoped_operations_image_id" >"$scoped_work_directory/operations-image.json"
		docker run --rm --network none --entrypoint node "$scoped_operations_image_id" -e \
			'process.stdout.write(require("node:fs").readFileSync("/app/restore-manifests/database-restore-migrations.json", "utf8"))' \
			>"$scoped_work_directory/operations-manifest-after.json"
		scoped_verifier identity-manifest || die 'Operations companion must change only the exact additive Identity migration manifest.'
	fi
	scoped_application_tree="$(git -C "$release_root" rev-parse "HEAD:apps/$scoped_owner")"
	[[ "$scoped_application_tree" =~ ^[a-f0-9]{40}$ ]] || die 'Invalid scoped application tree identity.'
	if [[ "$release_scope" == operations-runtime || "$release_scope" == operations-backlog-finalize ]]; then
		scoped_notes_checksum="$(sha256sum "$release_root/apps/operations/prisma/migrations/20260910110000_remove_admin_backlog/migration.sql" | awk '{print $1}')"
	fi
	if [[ "$release_scope" == operations-backlog-finalize ]]; then
		[[ "$operations_runtime_revision" == "$expected_live_revision" && "$operations_evidence_sha256" =~ ^[a-f0-9]{64}$ ]] || die 'Invalid Operations finalization authority.'
		scoped_state_directory="$app_root/deploy/backend/scoped-releases/operations-backlog/$operations_runtime_revision"
		assert_root_owned_directory "$scoped_state_directory"
		scoped_assert_hash "$scoped_state_directory/restore-evidence.json" "$operations_evidence_sha256"
		assert_root_owned_file "$scoped_state_directory/phase-a.json"
		install -m 600 "$scoped_state_directory/phase-a.json" "$scoped_work_directory/phase-a.json"
		install -m 600 "$scoped_state_directory/restore-evidence.json" "$scoped_work_directory/restore-evidence.json"
		scoped_database pre-finalize
		scoped_verifier evidence || die 'Operations safety backup has no matching successful isolated restore evidence.'
		scoped_assert_unchanged_neighbors
		scoped_fence_started=true
		scoped_source_compose run --rm --no-deps operations-migrate >/dev/null 2>&1 || die 'Operations destructive migration failed; no automatic runtime rollback is allowed.'
		scoped_database post-migration
		scoped_verifier finalized
		receipt_destination="$app_root/deploy/backend/scoped-releases/operations-backlog/finalized.json"
		assert_root_owned_directory "$(dirname "$receipt_destination")"
		[[ ! -e "$receipt_destination" && ! -L "$receipt_destination" ]] || die 'A finalized receipt already exists; preserve its recovery chain.'
		receipt_staging="$(mktemp "$(dirname "$receipt_destination")/.finalized.XXXXXX")"
		install -m 600 "$scoped_work_directory/finalized.json" "$receipt_staging"
		sync -f "$receipt_staging"
		mv -- "$receipt_staging" "$receipt_destination"
		sync -f "$(dirname "$receipt_destination")"
		scoped_assert_unchanged_neighbors
		printf 'Operations Notes finalization completed: infra=%s services=%s\n' "$infra_revision" "$services_revision"
		return
	fi
	scoped_source_compose config --format json >"$scoped_work_directory/compose.json"
	scoped_target_ids=()
	for name in "${scoped_targets[@]}"; do scoped_target_ids+=("$(scoped_container_id "$name")"); done
	docker inspect "${scoped_target_ids[@]}" >"$scoped_work_directory/live.json"
	docker image inspect "$scoped_image_id" >"$scoped_work_directory/image.json"
	chmod 600 "$scoped_work_directory/compose.json" "$scoped_work_directory/live.json" "$scoped_work_directory/image.json"
	scoped_verifier prepare || die 'Scoped candidate changes unapproved runtime configuration or Gateway routes.'
	if [[ "$release_scope" == identity-with-operations-manifest ]]; then
		scoped_database pre-migration
		scoped_workers_quiet || die 'Operations is not quiet.'
		sleep 2
		scoped_workers_quiet || die 'Operations became busy.'
		for name in "${!scoped_operations_ids[@]}"; do
			[[ "$(scoped_container_id "${scoped_targets[$((name + 3))]}")" == "${scoped_operations_ids[$name]}" ]] || die 'Operations identity changed before stop.'
		done
		scoped_workers_quiet || die 'Operations became busy before stop.'
		scoped_workers_stop_started=true
		scoped_workers_graceful_stop "${scoped_operations_ids[@]}" || die 'Operations graceful stop failed; no force-kill.'
		scoped_workers_quiet || die 'Operations remains busy after stop.'
		for id in "${scoped_operations_ids[@]}"; do
			[[ "$(docker inspect --format '{{.State.Running}} {{.State.Pid}}' "$id")" == 'false 0' ]] || die 'An old Operations process is not physically stopped.'
		done
		scoped_operations_stopped=true
		scoped_database operations-drain operations
		scoped_assert_unchanged_neighbors
		scoped_identity_ddl_started=true
		scoped_source_compose run --rm --no-deps identity-migrate >/dev/null 2>&1 || die 'Scoped Identity additive migration failed.'
		scoped_database post-migration
	elif [[ "$release_scope" == operations-runtime ]]; then
		scoped_database pre-migration
	elif [[ "$release_scope" == workers-bootstrap-recovery ]]; then
		for owner in billing operations support; do
			scoped_database worker-ledger "$owner"
			printf '%s %s\n' "$scoped_database_id" "$scoped_migration_manifest_sha256" >"$scoped_work_directory/$owner-ledger-before"
		done
	fi
	scoped_assert_unchanged_neighbors
	if [[ "$release_scope" == workers-bootstrap-recovery || "$release_scope" == operations-runtime ]]; then
		# Repeated quiet samples reduce interruption risk; this is NOT an atomic
		# writer fence. Never clear receipts/leases or force-kill a busy process.
		scoped_workers_quiet || die 'Worker quiet-window preflight is busy or unavailable.'
		sleep 2
		scoped_workers_quiet || die 'New work appeared during the worker quiet window.'
		for name in "${!scoped_targets[@]}"; do
			[[ "$(scoped_container_id "${scoped_targets[$name]}")" == "${scoped_target_ids[$name]}" ]] || die 'A worker changed identity before graceful stop.'
		done
		scoped_assert_unchanged_neighbors
		scoped_workers_quiet || die 'New work appeared immediately before worker stop.'
		scoped_workers_stop_started=true
		scoped_workers_graceful_stop "${scoped_target_ids[@]}" || die 'Worker graceful exit was not proven; no force-kill or replacement was performed.'
		scoped_workers_quiet || die 'Nonterminal work remains after worker exit; inspect the stopped workers before resuming.'
		scoped_assert_unchanged_neighbors
		for id in "${scoped_target_ids[@]}"; do
			[[ "$(docker inspect --format '{{.State.Running}} {{.State.Pid}}' "$id")" == 'false 0' ]] || die 'A stopped worker resumed before replacement; no force-kill is permitted.'
		done
	fi
	scoped_cutover_started=true
	scoped_compose desired up -d --no-build --no-deps --force-recreate "${scoped_targets[@]}" >/dev/null 2>&1 || die 'Scoped runtime replacement failed.'
	scoped_wait_healthy || die 'Scoped runtime did not become healthy.'
	scoped_verify_target_images || die 'Scoped running images differ from the verified immutable image.'
	if [[ "$release_scope" == workers-bootstrap-recovery ]]; then
		for owner in billing operations support; do
			scoped_database worker-ledger "$owner"
			before_receipt="$(<"$scoped_work_directory/$owner-ledger-before")"
			[[ "$before_receipt" == "$scoped_database_id $scoped_migration_manifest_sha256" ]] || die 'Worker recovery changed an owner database identity or migration ledger.'
		done
	fi
	if [[ "$release_scope" == operations-runtime ]]; then
		# Never return a Notes-capable runtime once the persistent DB writer fence
		# has begun. The relation remains present; this is not the drop migration.
		scoped_fence_started=true
		scoped_database fence
		scoped_verifier phase-a
		for scoped_state_directory in "$app_root/deploy/backend/scoped-releases" "$app_root/deploy/backend/scoped-releases/operations-backlog" "$app_root/deploy/backend/scoped-releases/operations-backlog/$services_revision"; do
			if [[ ! -e "$scoped_state_directory" && ! -L "$scoped_state_directory" ]]; then install -d -m 700 "$scoped_state_directory"; fi
			assert_root_owned_directory "$scoped_state_directory"
		done
		[[ ! -e "$scoped_state_directory/phase-a.json" && ! -L "$scoped_state_directory/phase-a.json" ]] || die 'Operations phase-A receipt already exists; preserve its backup chain.'
		install -m 600 "$scoped_work_directory/phase-a.json" "$scoped_state_directory/phase-a.json"
		sync -f "$scoped_state_directory/phase-a.json"
	fi
	scoped_assert_unchanged_neighbors
	printf 'Scoped production deployment completed: scope=%s infra=%s services=%s\n' "$release_scope" "$infra_revision" "$services_revision"
}
