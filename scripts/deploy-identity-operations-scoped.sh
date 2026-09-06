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
	local -a verifier_mounts=(--volume "$scoped_payload_directory/verifier.mjs:/run/scoped-verifier.mjs:ro")
	if [[ "$release_scope" == operations-api-runtime ]]; then
		verification_revision="$services_revision"
		verifier_mounts+=(--env "SCOPED_PHASE_A_REVISION=$expected_live_revision"
			--env "SCOPED_API_REVISION=${scoped_api_expected_revision:-}" --env "SCOPED_API_IMAGE=${scoped_api_expected_image:-}")
	fi
	if [[ -n "${scoped_backup_artifact:-}" ]]; then verifier_mounts+=(--volume "$scoped_backup_artifact:/run/scoped-artifact.dump:ro"); fi
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
		--env "SCOPED_SOURCE_WORKER_ID=${scoped_source_worker_id:-}" --env "SCOPED_SOURCE_WORKER_IMAGE=${scoped_source_worker_image:-}" \
		--env "SCOPED_BACKUP_EXECUTOR_ID=${scoped_backup_executor_id:-}" --env "SCOPED_BACKUP_EXECUTOR_IMAGE=${scoped_backup_executor_image:-}" \
		--volume "$scoped_work_directory:/run/scoped" \
		"${verifier_mounts[@]}" \
		--entrypoint node "$scoped_image_id" /run/scoped-verifier.mjs "$@"
}

scoped_backup_load() {
	local file
	assert_root_owned_directory "$scoped_state_directory/backup"
	for file in acquisition.json operations.dump; do
		assert_root_owned_file "$scoped_state_directory/backup/$file"
		[[ "$(stat -c '%a' "$scoped_state_directory/backup/$file")" == 600 ]] || die 'Unsafe sealed backup file mode.'
	done
	install -m 600 "$scoped_state_directory/backup/acquisition.json" "$scoped_work_directory/acquisition.json"
	scoped_backup_artifact="$scoped_state_directory/backup/operations.dump"
	scoped_verifier backup-verify || die 'Sealed backup differs from its phase-A acquisition receipt.'
}

scoped_backup_acquire() {
	local name id key value credential_count=0 deadline state available staging file
	local -a live_ids=()
	[[ "$operations_runtime_revision" == "$expected_live_revision" ]] || die 'Backup requires the exact live phase-A revision.'
	scoped_state_directory="$app_root/deploy/backend/scoped-releases/operations-backlog/$operations_runtime_revision"
	assert_root_owned_directory "$scoped_state_directory"
	assert_root_owned_file "$scoped_state_directory/phase-a.json"
	[[ "$(stat -c '%a' "$scoped_state_directory/phase-a.json")" == 600 ]] || die 'Unsafe phase-A receipt mode.'
	install -m 600 "$scoped_state_directory/phase-a.json" "$scoped_work_directory/phase-a.json"
	for name in operations-api operations-worker operations-outbox-publisher operations-restore-worker; do
		id="$(scoped_container_id "$name")" || die 'A phase-A Operations role is not uniquely running.'
		live_ids+=("$id")
	done
	docker inspect "${live_ids[@]}" >"$scoped_work_directory/backup-live.json"
	chmod 600 "$scoped_work_directory/backup-live.json"
	scoped_verifier backup-admission || die 'Backup requires matching phase-A runtime, source worker, database fence and restore-disabled configuration.'
	if [[ -e "$scoped_state_directory/backup" || -L "$scoped_state_directory/backup" ]]; then
		scoped_backup_load
		scoped_assert_unchanged_neighbors
		printf '%s\n' 'Existing sealed Operations backup verified read-only; no acquisition or phase-A replay performed.'
		return
	fi
	available="$(df -Pk "$scoped_state_directory" | awk 'NR==2 {print $4}')"
	[[ "$available" =~ ^[0-9]+$ && "$available" -ge 3145728 ]] || die 'Operations backup requires at least 3 GiB free local storage.'
	# Extract exactly one already-hash-approved owner key, never source an env
	# file and never expose its value in argv, Docker Env, logs or diagnostics.
	while IFS='=' read -r key value; do
		[[ "$key" == OPERATIONS_BACKUP_URL ]] || continue
		credential_count=$((credential_count + 1))
		[[ "$credential_count" == 1 && -n "$value" && ${#value} -le 4096 ]] || die 'Invalid owner backup credential structure.'
		if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then value="${value:1:${#value}-2}"; fi
		printf '%s' "$value" >"$scoped_work_directory/backup-url"
	done <"$scoped_owner_env"
	unset value
	[[ "$credential_count" == 1 ]] || die 'Operations backup credential is absent.'
	install -d -m 700 "$scoped_work_directory/backup-output"
	install -m 400 "$scoped_work_directory/phase-a.json" "$scoped_work_directory/backup-phase-a.json"
	chmod 400 "$scoped_work_directory/backup-url"
	chown 1001:1001 "$scoped_work_directory/backup-url" "$scoped_work_directory/backup-phase-a.json" "$scoped_work_directory/backup-output"
	scoped_backup_executor_image="$scoped_image_id"
	scoped_backup_executor_id="$(docker create --network host --read-only --cap-drop ALL --security-opt no-new-privileges \
		--user 1001:1001 --memory 512m --cpus 1 --pids-limit 64 --ulimit fsize=1073741824:1073741824 \
		--label "winwidget.scoped-backup=$scoped_work_directory" \
		--volume "$scoped_payload_directory/verifier.mjs:/run/scoped-verifier.mjs:ro" \
		--volume "$scoped_work_directory/backup-url:/run/operations-backup-url:ro" \
		--volume "$scoped_work_directory/backup-phase-a.json:/run/phase-a.json:ro" \
		--volume "$scoped_work_directory/backup-output:/run/backup" \
		--entrypoint node "$scoped_backup_executor_image" /run/scoped-verifier.mjs backup-capture)" || die 'Owned backup executor creation failed.'
	[[ "$scoped_backup_executor_id" =~ ^[a-f0-9]{64}$ ]] || die 'Invalid owned backup executor identity.'
	docker start "$scoped_backup_executor_id" >/dev/null 2>&1 || die 'Owned backup executor start failed.'
	deadline=$((SECONDS + 240))
	while ((SECONDS < deadline)); do
		state="$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}} {{.State.Pid}} {{.State.OOMKilled}}' "$scoped_backup_executor_id")" || die 'Owned backup executor state unavailable.'
		[[ "$state" != 'exited 0 0 false' ]] || break
		[[ "$state" == running\ * ]] || die 'Owned backup executor failed; no receipt was sealed.'
		sleep 1
	done
	[[ "$state" == 'exited 0 0 false' ]] || die 'Owned backup deadline exceeded; no receipt was sealed.'
	[[ "$(docker inspect --format '{{.Image}} {{index .Config.Labels "winwidget.scoped-backup"}}' "$scoped_backup_executor_id")" == "$scoped_backup_executor_image $scoped_work_directory" ]] || die 'Owned backup executor identity changed.'
	for file in operations.dump capture.json; do
		[[ -f "$scoped_work_directory/backup-output/$file" && ! -L "$scoped_work_directory/backup-output/$file" &&
			"$(stat -c '%h' "$scoped_work_directory/backup-output/$file")" == 1 ]] || die 'Invalid owned backup output boundary.'
		chown 0:0 "$scoped_work_directory/backup-output/$file"
		chmod 600 "$scoped_work_directory/backup-output/$file"
	done
	install -m 600 "$scoped_work_directory/backup-output/capture.json" "$scoped_work_directory/capture.json"
	scoped_backup_artifact="$scoped_work_directory/backup-output/operations.dump"
	scoped_verifier backup-seal || die 'Owned backup output failed independent hash/identity validation.'
	scoped_assert_unchanged_neighbors
	# Only root writes the sealed chain. Atomic directory install makes a retry
	# either verify the complete immutable pair or find no sealed artifact.
	staging="$(mktemp -d "$scoped_state_directory/.backup.XXXXXX")"
	chmod 700 "$staging"
	mv -- "$scoped_backup_artifact" "$staging/operations.dump"
	install -m 600 "$scoped_work_directory/acquisition.json" "$staging/acquisition.json"
	sync -f "$staging/operations.dump"
	sync -f "$staging/acquisition.json"
	sync -f "$staging"
	[[ ! -e "$scoped_state_directory/backup" && ! -L "$scoped_state_directory/backup" ]] || die 'A sealed backup appeared; refuse overwrite.'
	mv -T -- "$staging" "$scoped_state_directory/backup"
	sync -f "$scoped_state_directory"
	scoped_backup_artifact="$scoped_state_directory/backup/operations.dump"
	scoped_verifier backup-verify || die 'Installed backup failed final byte verification.'
	scoped_assert_unchanged_neighbors
	printf '%s\n' 'Operations file-only safety backup sealed; restore rehearsal remains a separate mandatory gate.'
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

scoped_collect_identity_migrations() {
	[[ "$release_scope" == identity-with-operations-manifest && "$scoped_image_id" =~ ^sha256:[a-f0-9]{64}$ ]] ||
		die 'Invalid Identity migration inventory scope.'
	# Only public verifier code enters the image-owner process. Root-only Compose,
	# credentials and manifest snapshots remain outside this container.
	(
		umask 077
		set -o noclobber
		docker run --rm --network none --read-only --cap-drop ALL \
			--security-opt no-new-privileges --user 1001:1001 \
			--volume "$scoped_payload_directory/verifier.mjs:/run/scoped-verifier.mjs:ro" \
			--entrypoint timeout "$scoped_image_id" --signal=TERM --kill-after=5s 30s \
			node /run/scoped-verifier.mjs identity-migration-inventory \
			>"$scoped_work_directory/identity-migrations.json"
	) || die 'Cannot read the exact Identity image migration inventory as its owner.'
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

scoped_assert_operations_api_source() {
	local changes path
	local -a required=(apps/operations/src/messaging-admin/messaging-admin.service.ts
		apps/operations/src/messaging-admin/messaging-admin.service.spec.ts
		apps/operations/src/federation/operations-federation.client.spec.ts
		apps/operations/src/operations-http-contract.spec.ts)
	changes="$(git -C "$release_root" diff --name-only "$expected_live_revision" "$services_revision")" || return 1
	[[ -n "$changes" ]] || return 1
	while IFS= read -r path; do
		case "$path" in
			apps/operations/src/messaging-admin/messaging-admin.service.ts | apps/operations/src/messaging-admin/messaging-admin.service.spec.ts | \
			apps/operations/src/federation/operations-federation.client.spec.ts | apps/operations/src/operations-http-contract.spec.ts | \
			.github/workflows/ci.yml | .github/scripts/static-check-services-lifecycle.sh | README.md | docs/backlog.md) ;;
			*) return 1 ;;
		esac
		[[ -f "$release_root/$path" && ! -L "$release_root/$path" && "$(realpath -e "$release_root/$path")" == "$release_root/$path" ]] || return 1
	done <<<"$changes"
	for path in "${required[@]}"; do [[ $'\n'"$changes"$'\n' == *$'\n'"$path"$'\n'* ]] || return 1; done
	git -C "$release_root" show "$expected_live_revision:${required[0]}" >"$scoped_work_directory/api-source-before.ts" || return 1
	chmod 600 "$scoped_work_directory/api-source-before.ts" || return 1
	install -m 600 "$release_root/${required[0]}" "$scoped_work_directory/api-source-after.ts" || return 1
	scoped_verifier api-source || return 1
}

scoped_api_image_inventory() {
	local image="$1" mode="$2" output="$3"
	[[ "$image" =~ ^sha256:[a-f0-9]{64}$ && "$mode" =~ ^(legacy|fixed)$ && "$output" =~ ^api-image-(before|after).json$ ]] || return 1
	# Image-owner access to public compiled code/schema only. No credentials or
	# root-owned release receipts cross this mount boundary.
	(
		umask 077
		set -o noclobber
		docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
			--user 1001:1001 --memory 256m --cpus 0.5 --pids-limit 32 \
			--volume "$scoped_payload_directory/verifier.mjs:/run/scoped-verifier.mjs:ro" \
			--entrypoint timeout "$image" --signal=TERM --kill-after=5s 30s \
			node /run/scoped-verifier.mjs operations-api-inventory "$mode" >"$scoped_work_directory/$output"
	) || return 1
}

scoped_api_neighbors() {
	local ids id result
	local -a container_ids=()
	ids="$(docker ps --all --no-trunc --filter label=com.docker.compose.project=winwidget --format '{{.ID}}')" || return 1
	while IFS= read -r id; do [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1; container_ids+=("$id"); done <<<"$ids"
	[[ "${#container_ids[@]}" == 31 ]] || return 1
	docker inspect "${container_ids[@]}" >"$scoped_work_directory/api-neighbors.json" || return 1
	chmod 600 "$scoped_work_directory/api-neighbors.json" || return 1
	result="$(scoped_verifier api-neighbors)" || return 1
	[[ "$result" =~ ^[a-f0-9]{64}$ ]] || return 1
	printf '%s' "$result"
}

scoped_api_chain() {
	local mode="$1" directory filename id output key value database='' manifest=''
	local -a ids=()
	[[ "$mode" == healthy || "$mode" == recovery ]] || return 1
	for directory in "$app_root/deploy/backend/scoped-releases" "$app_root/deploy/backend/scoped-releases/operations-backlog" "$scoped_state_directory"; do
		assert_root_owned_directory "$directory"
	done
	[[ "$(stat -c '%a' "$scoped_state_directory")" == 700 ]] || return 1
	# The filter repair neither requires nor reads backup artifacts. Finalization
	# changes the admitted schema state and therefore requires separate review.
	for filename in "$app_root/deploy/backend/scoped-releases/operations-backlog/finalized.json" "$scoped_state_directory/finalized.json"; do
		[[ ! -e "$filename" && ! -L "$filename" ]] || return 1
	done
	filename="$scoped_state_directory/phase-a.json"
	assert_root_owned_file "$filename"
	[[ "$(stat -c '%a' "$filename")" == 600 ]] || return 1
	install -m 600 "$filename" "$scoped_work_directory/phase-a.json" || return 1
	for filename in operations-api operations-worker operations-outbox-publisher operations-restore-worker api-gateway; do
		id="$(docker ps --all --no-trunc --filter label=com.docker.compose.project=winwidget --filter "label=com.docker.compose.service=$filename" --format '{{.ID}}')" || return 1
		[[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
		ids+=("$id")
	done
	docker inspect "${ids[@]}" >"$scoped_work_directory/api-peers.json" || return 1
	chmod 600 "$scoped_work_directory/api-peers.json" || return 1
	output="$(scoped_verifier api-phase "$mode")" || return 1
	while IFS='=' read -r key value; do
		case "$key" in
			DATABASE_ID) [[ "$value" =~ ^[a-f0-9-]{36}$ && -z "$database" ]] || return 1; database="$value" ;;
			MIGRATION_MANIFEST_SHA256) [[ "$value" =~ ^[a-f0-9]{64}$ && -z "$manifest" ]] || return 1; manifest="$value" ;;
			*) return 1 ;;
		esac
	done <<<"$output"
	[[ -n "$database" && -n "$manifest" ]] || return 1
	[[ -z "${scoped_api_database_id:-}" || "$scoped_api_database_id $scoped_api_manifest_sha256" == "$database $manifest" ]] || return 1
	scoped_api_database_id="$database"; scoped_api_manifest_sha256="$manifest"
}

scoped_api_database() {
	local output expected fingerprint
	output="$(scoped_source_compose run --rm --no-deps --interactive --user 1001:1001 \
		--env "SCOPED_DATABASE_ID=$scoped_api_database_id" --env "SCOPED_MIGRATION_MANIFEST_SHA256=$scoped_api_manifest_sha256" \
		--env "SCOPED_NOTES_CHECKSUM=$scoped_notes_checksum" \
		--volume "$scoped_payload_directory/verifier.mjs:/run/scoped-verifier.mjs:ro" \
		--entrypoint node operations-migrate /run/scoped-verifier.mjs database operations-api-pre-finalize operations)" || return 1
	fingerprint="${output##*$'\n'NOTES_STATE_SHA256=}"
	[[ "$fingerprint" =~ ^[a-f0-9]{64}$ ]] || return 1
	expected="$(printf 'DATABASE_ID=%s\nMIGRATION_MANIFEST_SHA256=%s' "$scoped_api_database_id" "$scoped_api_manifest_sha256")"
	[[ "$output" == "$expected"$'\n'"NOTES_STATE_SHA256=$fingerprint" ]] || return 1
	[[ -z "${scoped_api_notes_state_sha256:-}" || "$scoped_api_notes_state_sha256" == "$fingerprint" ]] || return 1
	scoped_api_notes_state_sha256="$fingerprint"
}

scoped_api_http() {
	docker run --rm --network host --read-only --cap-drop ALL --security-opt no-new-privileges \
		--user 1001:1001 --memory 256m --cpus 0.5 --pids-limit 32 \
		--volume "$scoped_payload_directory/verifier.mjs:/run/scoped-verifier.mjs:ro" \
		--entrypoint timeout "$scoped_api_expected_image" --signal=TERM --kill-after=5s 30s \
		node /run/scoped-verifier.mjs operations-api-http "$scoped_api_expected_revision" || return 1
}

scoped_api_assert_neighbors() {
	local fingerprint
	scoped_assert_unchanged_neighbors
	fingerprint="$(scoped_api_neighbors)" || return 1
	[[ "$fingerprint" == "$scoped_api_neighbors_before" ]] || return 1
}

scoped_api_rollback() {
	local id image revision
	id="$(docker ps --all --no-trunc --filter label=com.docker.compose.project=winwidget --filter label=com.docker.compose.service=operations-api --format '{{.ID}}')" || return 1
	[[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
	read -r image revision < <(docker inspect --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$id")
	[[ "$image $revision" == "$scoped_image_id $services_revision" || "$image $revision" == "$scoped_api_previous_image_id $expected_live_revision" ]] || return 1
	scoped_api_expected_image="$image"; scoped_api_expected_revision="$revision"
	(scoped_api_chain recovery && scoped_api_database && scoped_api_assert_neighbors) || return 1
	scoped_workers_graceful_stop "$id" || return 1
	[[ "$(docker inspect --format '{{.State.Running}} {{.State.Pid}}' "$id")" == 'false 0' ]] || return 1
	(scoped_api_chain recovery && scoped_api_database && scoped_api_assert_neighbors) || return 1
	scoped_compose rollback up -d --no-build --no-deps --force-recreate operations-api >/dev/null 2>&1 || return 1
	scoped_wait_healthy || return 1
	id="$(scoped_container_id operations-api)" || return 1
	[[ "$(docker inspect --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$id")" == "$scoped_api_previous_image_id $expected_live_revision" ]] || return 1
	scoped_api_expected_image="$scoped_api_previous_image_id"; scoped_api_expected_revision="$expected_live_revision"
	(scoped_api_http && scoped_api_chain healthy && scoped_api_database && scoped_api_assert_neighbors) || return 1
}

scoped_deploy_operations_api() {
	local id image_tag image_revision
	scoped_api_previous_image_id="$1"; scoped_api_previous_id="$2"
	[[ -z "$operations_runtime_revision$operations_evidence_sha256" ]] || die 'API-only release does not accept backup/finalization authority.'
	scoped_state_directory="$app_root/deploy/backend/scoped-releases/operations-backlog/$expected_live_revision"
	# This is the source tree that issued phase A, not the new API candidate tree.
	scoped_application_tree="$(git -C "$release_root" rev-parse "$expected_live_revision:apps/operations")"
	[[ "$scoped_application_tree" =~ ^[a-f0-9]{40}$ ]] || die 'Invalid phase-A application tree.'
	scoped_notes_checksum="$(sha256sum "$release_root/apps/operations/prisma/migrations/20260910110000_remove_admin_backlog/migration.sql" | awk '{print $1}')"
	scoped_api_expected_image="$scoped_api_previous_image_id"; scoped_api_expected_revision="$expected_live_revision"
	scoped_assert_operations_api_source || die 'API-only candidate exceeds the exact read-filter hunk, three tests and release metadata allowlist.'
	scoped_api_image_inventory "$scoped_api_previous_image_id" legacy api-image-before.json || die 'Preserved API image inventory is unavailable or is not the Notes-free baseline.'
	scoped_api_neighbors_before="$(scoped_api_neighbors)" || die 'API-only release requires its exact 30 unchanged neighbors.'
	if ! scoped_api_chain healthy || ! scoped_api_database; then die 'API-only release requires the exact phase-A receipt, pending Notes migration and existing writer fence.'; fi
	image_tag="winwidget-operations:git-$services_revision"
	docker build --build-arg "APP_REVISION=$services_revision" --tag "$image_tag" "$release_root/apps/operations" >/dev/null 2>&1 || die 'API-only immutable image build failed.'
	read -r scoped_image_id image_revision < <(docker image inspect --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_tag")
	[[ "$scoped_image_id" =~ ^sha256:[a-f0-9]{64}$ && "$image_revision" == "$services_revision" ]] || die 'API image has an unexpected immutable revision.'
	scoped_api_image_inventory "$scoped_image_id" fixed api-image-after.json || die 'Candidate API compiled read-filter or owner inventory is invalid.'
	scoped_verifier api-image-pair || die 'API-only image changed another compiled module, Prisma schema or restore catalog.'
	export OPERATIONS_IMAGE="$scoped_image_id" OPERATIONS_REVISION="$services_revision"
	scoped_source_compose config --format json >"$scoped_work_directory/compose.json"
	scoped_target_ids=("$scoped_api_previous_id")
	docker inspect "${scoped_target_ids[@]}" >"$scoped_work_directory/live.json"
	docker image inspect "$scoped_image_id" >"$scoped_work_directory/image.json"
	chmod 600 "$scoped_work_directory/compose.json" "$scoped_work_directory/live.json" "$scoped_work_directory/image.json"
	scoped_verifier prepare || die 'API-only candidate changes unapproved runtime configuration.'
	if ! scoped_api_chain healthy || ! scoped_api_database || ! scoped_api_assert_neighbors; then die 'Post-build API-only admission changed.'; fi
	[[ "$(scoped_container_id operations-api)" == "$scoped_api_previous_id" ]] || die 'API changed identity before graceful stop.'
	scoped_workers_stop_started=true
	scoped_workers_graceful_stop "$scoped_api_previous_id" || die 'API graceful exit was not proven; no force-kill or replacement was performed.'
	[[ "$(docker inspect --format '{{.State.Running}} {{.State.Pid}}' "$scoped_api_previous_id")" == 'false 0' ]] || die 'Old API is not physically stopped.'
	if ! scoped_api_chain recovery || ! scoped_api_database || ! scoped_api_assert_neighbors; then die 'Post-stop API admission is unknown; keep the preserved Notes-free API stopped for review.'; fi
	scoped_cutover_started=true
	scoped_compose desired up -d --no-build --no-deps --force-recreate operations-api >/dev/null 2>&1 || die 'API-only replacement failed.'
	if ! scoped_wait_healthy || ! scoped_verify_target_images; then die 'API-only immutable runtime is not healthy.'; fi
	scoped_api_expected_image="$scoped_image_id"; scoped_api_expected_revision="$services_revision"
	if ! scoped_api_http || ! scoped_api_chain healthy || ! scoped_api_database || ! scoped_api_assert_neighbors; then die 'API-only postflight failed.'; fi
	id="$(scoped_container_id operations-api)" || die 'New API identity is unavailable.'
	[[ "$id" != "$scoped_api_previous_id" ]] || die 'API-only replacement was not observed.'
	printf 'Operations API-only release completed without DDL or worker replacement: infra=%s services=%s\n' "$infra_revision" "$services_revision"
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

scoped_platform_source() {
	local changes path checksum index=0 peers base=19a0ecd47fd448ca82d1efeb67df59bb00a0c293
	local -a paths=(content/platform-content.validation.ts home-page-content/home-page-content.service.ts)
	# The API live baseline predates other owners' already-reviewed releases.
	# Pin their entire app trees independently; never import CRM foundation.
	peers="$(git -C "$release_root" ls-tree "$services_revision:apps" | awk '$4 != "platform"')" || return 1
	[[ "$(printf '%s' "$peers" | sha256sum | awk '{print $1}')" == 51d78c0fa9bd6eb66d04152968023a512d784cc15e3cdaf352fcf254e0c75f85 ]] || return 1
	changes="$(git -C "$release_root" diff --name-only "$base" "$services_revision")" || return 1
	while IFS= read -r path; do
		case "$path" in
			apps/platform/src/content/platform-content.validation.ts | apps/platform/src/home-page-content/home-page-content.service.ts | apps/platform/src/content/product-marketing-content.spec.ts | apps/platform/package.json | apps/platform/pnpm-lock.yaml | \
			.github/workflows/ci.yml | .github/scripts/static-check-services-lifecycle.sh | .github/scripts/verify-production-audit.cjs | README.md | docs/backlog.md) ;;
			*) return 1 ;;
		esac
		[[ -f "$release_root/$path" && ! -L "$release_root/$path" && "$(realpath -e "$release_root/$path")" == "$release_root/$path" ]] || return 1
	done <<<"$changes"
	changes="$(git -C "$release_root" diff --name-only "$expected_live_revision" "$services_revision" -- apps/platform)" || return 1
	for path in "${paths[@]}"; do
		[[ $'\n'"$changes"$'\n' == *$'\n'"apps/platform/src/$path"$'\n'* ]] || return 1
		git -C "$release_root" show "$expected_live_revision:apps/platform/src/$path" >"$scoped_work_directory/platform-source-before-$index.ts" || return 1
		chmod 600 "$scoped_work_directory/platform-source-before-$index.ts" || return 1
		install -m 600 "$release_root/apps/platform/src/$path" "$scoped_work_directory/platform-source-after-$index.ts" || return 1
		index=$((index + 1))
	done
	while IFS= read -r path; do
		case "$path" in apps/platform/src/content/platform-content.validation.ts | apps/platform/src/home-page-content/home-page-content.service.ts | apps/platform/src/content/product-marketing-content.spec.ts | apps/platform/package.json | apps/platform/pnpm-lock.yaml) ;; *) return 1 ;; esac
	done <<<"$changes"
	[[ "$(sha256sum "$release_root/apps/platform/src/content/product-marketing-content.spec.ts" | awk '{print $1}')" == 21215144c5c82c2ae5ab83bec44be05251823640b8ee9e014ce261033cb0c975 ]] || return 1
	checksum="$(git -C "$release_root" show "$expected_live_revision:apps/platform/pnpm-lock.yaml" | sha256sum | awk '{print $1}')" || return 1
	[[ "$checksum" == 43e3f9b66437458a180f5db4da7bf4690c873305612a9672f81536c3ff3ac208 ]] || return 1
	checksum="$(git -C "$release_root" show "$expected_live_revision:apps/platform/package.json" | sha256sum | awk '{print $1}')" || return 1
	[[ "$checksum" == 0d76b8e37309b80169c96614dcf86bed4de401c2eac719146edbe8263396a179 ]] || return 1
	checksum="$(sha256sum "$release_root/apps/platform/package.json" | awk '{print $1}') $(sha256sum "$release_root/apps/platform/pnpm-lock.yaml" | awk '{print $1}')" || return 1
	case "$checksum" in
		'0d76b8e37309b80169c96614dcf86bed4de401c2eac719146edbe8263396a179 6e05a87a7969056e5112832b76828f12ca0f9bb113928ca7081977651ab907f3' | \
		'8a13a67914923aa88a4818aebfd2b202ce8878d378252bfd1dcb58854ed05522 50fdfebd27b207af7acbc18094ff4be5351cf8ef555845621fb6709d5d951714') ;;
		*) return 1 ;;
	esac
	scoped_verifier platform-source || return 1
}

scoped_platform_image_inventory() {
	local image="$1" mode="$2" output="$3"
	[[ "$image" =~ ^sha256:[a-f0-9]{64}$ && "$mode" =~ ^(legacy|marketing)$ && "$output" =~ ^platform-image-(before|after).json$ ]] || return 1
	(
		umask 077; set -o noclobber
		docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
			--user 1001:1001 --memory 256m --cpus 0.5 --pids-limit 32 \
			--volume "$scoped_payload_directory/verifier.mjs:/run/scoped-verifier.mjs:ro" \
			--entrypoint timeout "$image" --signal=TERM --kill-after=5s 30s node /run/scoped-verifier.mjs platform-image-inventory "$mode" >"$scoped_work_directory/$output"
	) || return 1
}

scoped_platform_neighbors() {
	local ids id result
	local -a container_ids=()
	ids="$(docker ps --all --no-trunc --filter label=com.docker.compose.project=winwidget --format '{{.ID}}')" || return 1
	while IFS= read -r id; do [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1; container_ids+=("$id"); done <<<"$ids"
	[[ "${#container_ids[@]}" == 31 ]] || return 1
	docker inspect "${container_ids[@]}" >"$scoped_work_directory/platform-neighbors.json" || return 1
	chmod 600 "$scoped_work_directory/platform-neighbors.json" || return 1
	result="$(scoped_verifier platform-neighbors)" || return 1
	[[ "$result" =~ ^[a-f0-9]{64}$ ]] || return 1
	printf '%s' "$result"
}

scoped_platform_database() {
	local output
	# Existing owner migration credential, but the executable is exclusively a
	# bounded READ ONLY probe. No prisma migrate, write fence, GRANT or dump.
	output="$(scoped_source_compose run --rm --no-deps --interactive --user 1001:1001 \
		--volume "$scoped_payload_directory/verifier.mjs:/run/scoped-verifier.mjs:ro" \
		--entrypoint timeout platform-migrate --signal=TERM --kill-after=5s 20s node /run/scoped-verifier.mjs platform-database)" || return 1
	[[ "$output" =~ ^[a-f0-9]{64}$ ]] || return 1
	[[ -z "${scoped_platform_state_sha256:-}" || "$output" == "$scoped_platform_state_sha256" ]] || return 1
	scoped_platform_state_sha256="$output"
}

scoped_platform_http() {
	docker run --rm --network host --read-only --cap-drop ALL --security-opt no-new-privileges \
		--user 1001:1001 --memory 256m --cpus 0.5 --pids-limit 32 \
		--volume "$scoped_payload_directory/verifier.mjs:/run/scoped-verifier.mjs:ro" \
		--entrypoint timeout "$scoped_platform_expected_image" --signal=TERM --kill-after=5s 30s \
		node /run/scoped-verifier.mjs platform-http "$scoped_platform_expected_revision" || return 1
}

scoped_platform_assert_neighbors() {
	local fingerprint
	(scoped_assert_unchanged_neighbors) || return 1
	fingerprint="$(scoped_platform_neighbors)" || return 1
	[[ "$fingerprint" == "$scoped_platform_neighbors_before" ]] || return 1
}

scoped_platform_rollback() {
	local id image revision
	id="$(docker ps --all --no-trunc --filter label=com.docker.compose.project=winwidget --filter label=com.docker.compose.service=platform-api --format '{{.ID}}')" || return 1
	[[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
	read -r image revision < <(docker inspect --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$id")
	[[ "$image $revision" == "$scoped_image_id $services_revision" || "$image $revision" == "$scoped_platform_previous_image $expected_live_revision" ]] || return 1
	# Stop the only content writer BEFORE checking content/version. A successful
	# new-format write forbids silently returning the old strict validator.
	scoped_workers_graceful_stop "$id" || return 1
	[[ "$(docker inspect --format '{{.State.Running}} {{.State.Pid}}' "$id")" == 'false 0' ]] || return 1
	(scoped_platform_database && scoped_platform_assert_neighbors) || return 1
	scoped_compose rollback up -d --no-build --no-deps --force-recreate platform-api >/dev/null 2>&1 || return 1
	scoped_wait_healthy || return 1
	id="$(scoped_container_id platform-api)" || return 1
	[[ "$(docker inspect --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$id")" == "$scoped_platform_previous_image $expected_live_revision" ]] || return 1
	scoped_platform_expected_image="$scoped_platform_previous_image"; scoped_platform_expected_revision="$expected_live_revision"
	(scoped_platform_http && scoped_platform_database && scoped_platform_assert_neighbors) || return 1
}

scoped_deploy_platform() {
	local image_tag image_revision publisher
	scoped_platform_previous_image="$1"; scoped_platform_previous_id="$2"
	[[ -z "$operations_runtime_revision$operations_evidence_sha256$expected_operations_revision$expected_operations_env_sha256$expected_operations_api_revision$expected_support_env_sha256" ]] || die 'Platform release accepts no foreign or destructive authority.'
	scoped_platform_expected_image="$1"; scoped_platform_expected_revision="$expected_live_revision"
	(scoped_platform_source) || die 'Platform source exceeds the exact CMS and qs-only allowlist.'
	publisher="$(scoped_container_id platform-outbox-publisher)" || die 'Platform publisher is not uniquely running.'
	[[ "$(docker inspect --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$publisher")" == "$scoped_platform_previous_image $expected_live_revision" ]] || die 'Platform publisher differs from the approved unchanged baseline.'
	scoped_platform_neighbors_before="$(scoped_platform_neighbors)" || die 'Platform release requires 30 healthy unchanged neighbors.'
	scoped_platform_image_inventory "$1" legacy platform-image-before.json || die 'Preserved Platform image inventory is invalid.'
	scoped_platform_database || die 'Platform database identity/ledger/read-only baseline is invalid.'
	scoped_platform_http || die 'Preserved Platform read-only HTTP contract is not ready.'
	image_tag="winwidget-platform:git-$services_revision"
	docker build --build-arg "APP_REVISION=$services_revision" --tag "$image_tag" "$release_root/apps/platform" >/dev/null 2>&1 || die 'Platform immutable image build failed.'
	read -r scoped_image_id image_revision < <(docker image inspect --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_tag")
	[[ "$scoped_image_id" =~ ^sha256:[a-f0-9]{64}$ && "$image_revision" == "$services_revision" ]] || die 'Platform image revision is not the exact green candidate.'
	scoped_platform_image_inventory "$scoped_image_id" marketing platform-image-after.json || die 'Candidate Platform image contract is invalid.'
	scoped_verifier platform-image-pair || die 'Platform image changed another module, package, schema or migration.'
	export PLATFORM_IMAGE="$scoped_image_id" PLATFORM_REVISION="$services_revision"
	scoped_source_compose config --format json >"$scoped_work_directory/compose.json"
	scoped_target_ids=("$scoped_platform_previous_id")
	docker inspect "${scoped_target_ids[@]}" >"$scoped_work_directory/live.json"
	docker image inspect "$scoped_image_id" >"$scoped_work_directory/image.json"
	chmod 600 "$scoped_work_directory/compose.json" "$scoped_work_directory/live.json" "$scoped_work_directory/image.json"
	scoped_verifier prepare || die 'Platform candidate changes unapproved runtime configuration.'
	(scoped_platform_database && scoped_platform_assert_neighbors) || die 'Platform post-build admission changed.'
	[[ "$(scoped_container_id platform-api)" == "$scoped_platform_previous_id" ]] || die 'Platform API changed identity before stop.'
	scoped_workers_stop_started=true
	scoped_workers_graceful_stop "$scoped_platform_previous_id" || die 'Platform graceful exit was not proven; no forced stop or replacement.'
	[[ "$(docker inspect --format '{{.State.Running}} {{.State.Pid}}' "$scoped_platform_previous_id")" == 'false 0' ]] || die 'Old Platform API is not physically stopped.'
	(scoped_platform_database && scoped_platform_assert_neighbors) || die 'Post-stop Platform state is unknown; preserved API remains stopped for review.'
	scoped_cutover_started=true
	scoped_compose desired up -d --no-build --no-deps --force-recreate platform-api >/dev/null 2>&1 || die 'Platform API replacement failed.'
	(scoped_wait_healthy && scoped_verify_target_images) || die 'Platform candidate is not healthy on its exact immutable image.'
	scoped_platform_expected_image="$scoped_image_id"; scoped_platform_expected_revision="$services_revision"
	(scoped_platform_http && scoped_platform_database && scoped_platform_assert_neighbors) || die 'Platform postflight failed; safe rollback requires unchanged content.'
	[[ "$(scoped_container_id platform-api)" != "$scoped_platform_previous_id" ]] || die 'Platform API replacement was not observed.'
	printf 'Platform marketing API release completed without DDL or publisher replacement: infra=%s services=%s\n' "$infra_revision" "$services_revision"
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
	if [[ "${scoped_backup_executor_id:-}" =~ ^[a-f0-9]{64}$ ]]; then
		if [[ "$(docker inspect --format '{{.Image}} {{index .Config.Labels "winwidget.scoped-backup"}}' "$scoped_backup_executor_id" 2>/dev/null)" == "$scoped_backup_executor_image $scoped_work_directory" ]]; then
			# Only this disposable, read-only dump executor; never a live worker.
			docker rm --force "$scoped_backup_executor_id" >/dev/null 2>&1
		fi
	fi
	if [[ -n "${scoped_work_directory:-}" ]]; then
		for name in backup-url backup-phase-a.json; do
			if [[ -f "$scoped_work_directory/$name" && ! -L "$scoped_work_directory/$name" ]]; then rm -- "$scoped_work_directory/$name"; fi
		done
		if [[ "$exit_code" == 0 && -d "$scoped_work_directory/backup-output" && ! -L "$scoped_work_directory/backup-output" ]]; then
			find "$scoped_work_directory/backup-output" -mindepth 1 -maxdepth 1 -type f -delete
			rmdir "$scoped_work_directory/backup-output"
		fi
	fi
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
	elif [[ "$exit_code" != 0 && "$release_scope" == platform-marketing-runtime && "${scoped_cutover_started:-false}" == true ]]; then
		if scoped_platform_rollback; then
			printf '%s\n' 'Platform rollback restored the preserved API; content/version, database and all neighbors are unchanged.' >&2
		else
			printf '%s\n' 'RECOVERY_REQUIRED: Platform content/state or graceful stop is unknown; no incompatible validator, database rollback or forced stop was attempted.' >&2
		fi
	elif [[ "$exit_code" != 0 && "$release_scope" == operations-api-runtime && "${scoped_cutover_started:-false}" == true ]]; then
		if scoped_api_rollback; then
			printf '%s\n' 'API-only rollback restored the preserved Notes-free image/config; no database changes were made.' >&2
		else
			printf '%s\n' 'CRITICAL: API-only recovery requires operator review; no forced stop, worker replacement or database rollback was attempted.' >&2
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
	[[ "$release_scope" =~ ^(identity-with-operations-manifest|operations-runtime|operations-backlog-backup|operations-backlog-finalize|gateway-remove-notes|workers-bootstrap-recovery|operations-federation-config|operations-api-runtime|platform-marketing-runtime)$ &&
		"$services_revision" =~ ^[a-f0-9]{40}$ && "$expected_live_revision" =~ ^[a-f0-9]{40}$ ]] ||
		die 'Invalid scoped release authorization.'
	[[ "$(stat -Lc '%d:%i' "/proc/self/fd/$deploy_lock_fd")" == "$(stat -c '%d:%i' "$deploy_lock")" ]] ||
		die 'Scoped deployment did not inherit the canonical production lock.'
	flock -n "$deploy_lock_fd" || die 'Scoped deployment lost the canonical production lock.'
	case "$release_scope" in
		platform-marketing-runtime) scoped_owner=platform; scoped_targets=(platform-api) ;;
		operations-federation-config | operations-api-runtime) scoped_owner=operations; scoped_targets=(operations-api) ;;
		workers-bootstrap-recovery) scoped_owner=billing; scoped_targets=(billing-api billing-worker billing-outbox-publisher operations-worker operations-outbox-publisher operations-restore-worker support-worker support-outbox-publisher) ;;
		identity-with-operations-manifest) scoped_owner=identity; scoped_targets=(identity-api identity-worker identity-outbox-publisher operations-api operations-worker operations-outbox-publisher operations-restore-worker) ;;
		operations-runtime) scoped_owner=operations; scoped_targets=(operations-api operations-worker operations-outbox-publisher operations-restore-worker) ;;
		operations-backlog-backup | operations-backlog-finalize) scoped_owner=operations; scoped_targets=() ;;
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
	if [[ "$release_scope" == platform-marketing-runtime ]]; then
		scoped_deploy_platform "$old_image" "$id"
		return
	fi
	if [[ "$release_scope" == operations-api-runtime ]]; then
		scoped_deploy_operations_api "$old_image" "$id"
		return
	fi
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
		scoped_collect_identity_migrations
		scoped_verifier identity-manifest || die 'Operations companion must change only the exact additive Identity migration manifest.'
	fi
	scoped_application_tree="$(git -C "$release_root" rev-parse "HEAD:apps/$scoped_owner")"
	[[ "$scoped_application_tree" =~ ^[a-f0-9]{40}$ ]] || die 'Invalid scoped application tree identity.'
	if [[ "$release_scope" == operations-runtime || "$release_scope" == operations-backlog-backup || "$release_scope" == operations-backlog-finalize ]]; then
		scoped_notes_checksum="$(sha256sum "$release_root/apps/operations/prisma/migrations/20260910110000_remove_admin_backlog/migration.sql" | awk '{print $1}')"
	fi
	if [[ "$release_scope" == operations-backlog-backup ]]; then
		scoped_backup_acquire
		return
	fi
	if [[ "$release_scope" == operations-backlog-finalize ]]; then
		[[ "$operations_runtime_revision" == "$expected_live_revision" && "$operations_evidence_sha256" =~ ^[a-f0-9]{64}$ ]] || die 'Invalid Operations finalization authority.'
		scoped_state_directory="$app_root/deploy/backend/scoped-releases/operations-backlog/$operations_runtime_revision"
		assert_root_owned_directory "$scoped_state_directory"
		scoped_assert_hash "$scoped_state_directory/restore-evidence.json" "$operations_evidence_sha256"
		assert_root_owned_file "$scoped_state_directory/phase-a.json"
		install -m 600 "$scoped_state_directory/phase-a.json" "$scoped_work_directory/phase-a.json"
		install -m 600 "$scoped_state_directory/restore-evidence.json" "$scoped_work_directory/restore-evidence.json"
		scoped_backup_load
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
		scoped_source_worker_id="$(scoped_container_id operations-worker)" || die 'Phase-A source worker is not uniquely running.'
		scoped_source_worker_image="$(docker inspect --format '{{.Image}}' "$scoped_source_worker_id")"
		[[ "$scoped_source_worker_image" == "$scoped_image_id" ]] || die 'Phase-A source worker image identity changed.'
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
