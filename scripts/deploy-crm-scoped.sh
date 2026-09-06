#!/usr/bin/env bash
# Sourced by the immutable root controller under its shared production lock.
# crm-prepare seals immutable inputs without starting containers. The separate
# crm-databases scope initializes only owned databases and runs migrations.
# Neither scope starts CRM applications, provisions the broker, changes
# production env, replaces existing runtime or opens public routes.
# shellcheck disable=SC2154
[[ "${BASH_SOURCE[0]}" != "$0" ]] || {
	printf '%s\n' 'Use the pinned reusable production workflow.' >&2
	exit 1
}

crm_assert_inputs() {
	local file hash
	for file in "$env_file" "$crm_env_file"; do
		assert_root_owned_file "$file"
		[[ "$(stat -c '%a' "$file")" == 600 ]] || die 'CRM input must be root-owned mode 0600.'
	done
	[[ "$(sha256sum "$env_file" | awk '{print $1}')" == "$expected_env_sha256" &&
		"$(sha256sum "$crm_env_file" | awk '{print $1}')" == "$expected_service_env_sha256" ]] ||
		die 'CRM preparation input changed after approval.'
	assert_root_owned_file "$deploy_lock"
	[[ "$deploy_lock_fd" =~ ^[0-9]+$ && "$(stat -Lc '%d:%i' "/proc/$$/fd/$deploy_lock_fd")" == \
		"$(stat -c '%d:%i' "$deploy_lock")" ]] || die 'CRM deploy lock identity changed.'
	flock -n "$deploy_lock_fd" || die 'CRM no longer holds the shared production lock.'
	[[ "$(git -C "$release_root" rev-parse HEAD)" == "$services_revision" &&
		-z "$(git -C "$release_root" status --porcelain --untracked-files=all)" ]] ||
		die 'CRM release source changed during preparation.'
	hash="$(sha256sum "$scoped_payload_directory/verifier.mjs" | awk '{print $1}')"
	[[ "$hash" == "$scoped_node_sha256" ]] || die 'CRM verifier bytes changed.'
	if [[ -n "${crm_database_phase:-}" ]]; then
		[[ "$(sha256sum "$crm_release_directory/desired.json" | awk '{print $1}')" == "$crm_desired_hash" &&
			"$(sha256sum "$crm_release_directory/receipt.json" | awk '{print $1}')" == "$crm_receipt_hash" ]] ||
			die 'Prepared CRM artifacts changed during database setup.'
		local index
		for index in "${!crm_secret_files[@]}"; do
			assert_root_owned_file "${crm_secret_files[$index]}"
			[[ "$(stat -c '%a' "${crm_secret_files[$index]}")" == 600 &&
				"$(sha256sum "${crm_secret_files[$index]}" | awk '{print $1}')" == "${crm_secret_hashes[$index]}" ]] ||
				die 'A CRM database credential file changed.'
		done
		if [[ -n "${crm_work_directory:-}" && -f "$crm_work_directory/desired.json" ]]; then
			cmp -s "$crm_work_directory/desired.json" "$crm_release_directory/desired.json" || die 'CRM working configuration changed.'
		fi
	fi
}

crm_inventory() {
	local ids id
	local -a containers=()
	ids="$(docker ps --no-trunc --format '{{.ID}}')" || return 1
	[[ -n "$ids" ]] || return 1
	while IFS= read -r id; do
		[[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
		containers+=("$id")
	done <<<"$ids"
	docker inspect "${containers[@]}" | docker run --rm --interactive --network none --read-only \
		--cap-drop ALL --security-opt no-new-privileges --user 0:0 --memory 128m --memory-swap 128m --cpus 0.5 --pids-limit 32 \
		--env "CRM_GATEWAY_REVISION=$expected_live_revision" \
		--volume "$scoped_payload_directory/verifier.mjs:/run/crm-release.mjs:ro" \
		--entrypoint node "$crm_probe_image" /run/crm-release.mjs "${crm_inventory_mode:-inventory}"
}

crm_fence() {
	local neighbors
	crm_assert_inputs
	neighbors="$(crm_inventory)" || die 'Cannot verify CRM preparation neighbors.'
	[[ "$neighbors" == "$crm_neighbors" ]] || die 'An existing container changed during CRM preparation.'
}

crm_cleanup_prepare() {
	local status=$?
	trap - EXIT
	if [[ -n "${crm_work_directory:-}" ]]; then
		rm -f -- "$crm_work_directory/desired.json" "$crm_work_directory/images.json" "$crm_work_directory/receipt.json" "$crm_work_directory/postgres-image.json"
		rmdir "$crm_work_directory"
	fi
	cleanup_scoped_payload
	exit "$status"
}

crm_initialize() {
	local gateway_id image_revision file
	[[ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}" ]] || die 'CRM preparation requires the local production Docker daemon.'
	[[ "$(docker context inspect --format '{{.Endpoints.docker.Host}}')" == unix:///var/run/docker.sock ]] ||
		die 'CRM preparation cannot target a remote Docker daemon.'
	crm_env_file="$app_root/deploy/backend/crm/.env.production"
	assert_root_owned_directory "$app_root/deploy/backend/crm"
	crm_assert_inputs
	for file in "$release_root/deploy/docker-compose.crm.yml" "$release_root/.github/scripts/validate-crm-compose.mjs"; do
		[[ -f "$file" && ! -L "$file" ]] || die 'The pinned CRM release contract is missing or unsafe.'
	done
	gateway_id="$(docker ps --no-trunc --filter label=com.docker.compose.project=winwidget \
		--filter label=com.docker.compose.service=api-gateway --format '{{.ID}}')"
	[[ "$gateway_id" =~ ^[a-f0-9]{64}$ ]] || die 'The existing Gateway is not uniquely running.'
	read -r crm_probe_image image_revision < <(docker inspect --format \
		'{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$gateway_id")
	[[ "$crm_probe_image" =~ ^sha256:[a-f0-9]{64}$ && "$image_revision" == "$expected_live_revision" ]] ||
		die 'The existing Gateway differs from the approved CRM baseline.'
	image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$crm_probe_image")"
	[[ "$image_revision" == "$expected_live_revision" ]] || die 'The Gateway image revision differs from its container label.'
	crm_neighbors="$(crm_inventory)" || die 'Existing runtime is not healthy and identifiable.'
	[[ "$crm_neighbors" =~ ^[a-f0-9]{64}$ ]] || die 'Invalid CRM neighbor fingerprint.'
}

scoped_deploy_main() {
	local owner prefix image_tag image_revision image_title image_id file destination
	local -a images=() image_env=()
	case "$release_scope" in
		crm-prepare) crm_inventory_mode=inventory ;;
		crm-databases) crm_inventory_mode=database-neighbors ;;
		*) die 'Unsupported CRM scope.' ;;
	esac
	crm_initialize
	if [[ "$release_scope" == crm-databases ]]; then crm_database_main; return; fi
	crm_work_directory="$(mktemp -d "$app_root/deploy/backend/.crm-prepare.XXXXXX")"
	chmod 700 "$crm_work_directory"
	trap crm_cleanup_prepare EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM HUP
	for owner in crm-access crm-intake crm-customers crm-sales; do
		crm_fence
		image_tag="winwidget-$owner:git-$services_revision"
		if ! docker image inspect "$image_tag" >/dev/null 2>&1; then
			docker build --build-arg "APP_REVISION=$services_revision" --tag "$image_tag" "$release_root/apps/$owner" \
				>/dev/null 2>&1 || die 'CRM immutable image build failed.'
		fi
		read -r image_id image_revision image_title < <(docker image inspect --format \
			'{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.opencontainers.image.title"}}' "$image_tag")
		[[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ && "$image_revision" == "$services_revision" && "$image_title" == "winwidget-$owner" ]] ||
			die 'A CRM candidate image does not match its exact owner/revision.'
		images+=("$image_id")
		prefix="${owner//-/_}"
		prefix="$(printf '%s' "$prefix" | tr '[:lower:]' '[:upper:]')"
		image_env+=("${prefix}_IMAGE=$image_id" "${prefix}_REVISION=$services_revision")
	done
	crm_fence
	# Clear ambient Compose overrides; only reviewed CRM env and the four
	# inspected immutable image identities may enter the normalized artifact.
	env -i PATH="$PATH" "${image_env[@]}" docker compose --profile '*' --project-name winwidget-crm \
		--env-file "$crm_env_file" -f "$release_root/deploy/docker-compose.crm.yml" config --format json \
		>"$crm_work_directory/desired.json" 2>/dev/null || die 'CRM Compose materialization failed.'
	docker image inspect "${images[@]}" >"$crm_work_directory/images.json"
	chmod 600 "$crm_work_directory/desired.json" "$crm_work_directory/images.json"
	docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 0:0 \
		--memory 128m --memory-swap 128m --cpus 0.5 --pids-limit 32 \
		--volume "$scoped_payload_directory/verifier.mjs:/run/crm-release.mjs:ro" \
		--volume "$release_root/.github/scripts/validate-crm-compose.mjs:/run/crm-compose-validator.mjs:ro" \
		--volume "$crm_work_directory:/run/crm:ro" \
		--env "CRM_SERVICES_REVISION=$services_revision" --env "CRM_INFRA_REVISION=$infra_revision" \
		--env "CRM_CANONICAL_ENV_SHA256=$expected_env_sha256" --env "CRM_ENV_SHA256=$expected_service_env_sha256" \
		--env "CRM_NEIGHBORS_SHA256=$crm_neighbors" \
		--entrypoint node "${images[0]}" /run/crm-release.mjs prepare >"$crm_work_directory/receipt.json" \
		|| die 'CRM prepared images/configuration failed verification.'
	chmod 600 "$crm_work_directory/receipt.json"
	crm_fence
	# These two files are release inputs, not a database backup or activation
	# receipt. Replaying preparation may verify them but cannot overwrite them.
	destination="$app_root/deploy/backend/crm/releases"
	if [[ ! -e "$destination" && ! -L "$destination" ]]; then install -d -m 700 "$destination"; fi
	assert_root_owned_directory "$destination"
	destination="$destination/$services_revision"
	if [[ ! -e "$destination" && ! -L "$destination" ]]; then mkdir -m 700 "$destination"; fi
	assert_root_owned_directory "$destination"
	for file in desired.json receipt.json; do
		if [[ -e "$destination/$file" || -L "$destination/$file" ]]; then
			assert_root_owned_file "$destination/$file"
			[[ "$(stat -c '%a' "$destination/$file")" == 600 ]] || die 'Unsafe prepared CRM artifact permissions.'
			cmp -s "$crm_work_directory/$file" "$destination/$file" || die 'An immutable CRM preparation already exists with different inputs.'
		else
			ln "$crm_work_directory/$file" "$destination/$file" || die 'Cannot atomically seal the CRM preparation artifact.'
		fi
	done
	crm_fence
	printf '%s\n' 'CRM preparation verified: four images and isolated Compose sealed; no runtime, migration, broker or public-route activation.'
}

crm_database_compose() {
	env -i PATH="$PATH" docker compose --project-name winwidget-crm --env-file /dev/null \
		--profile crm-databases --profile crm-migrations -f "$crm_work_directory/desired.json" "$@"
}

crm_database_verifier() {
	local mode="$1" owner="${2:-}" selected="${crm_images[0]}" index
	local -a mounts=() arguments=("$mode")
	if [[ -n "$owner" ]]; then
		for index in "${!crm_owners[@]}"; do
			if [[ "${crm_owners[$index]}" == "$owner" ]]; then selected="${crm_images[$index]}"; break; fi
		done
		[[ "${crm_owners[$index]}" == "$owner" ]] || die 'Unknown CRM database owner.'
		arguments+=("$owner")
		mounts+=(--volume "$app_root/deploy/backend/secrets/$owner-postgres-admin-password:/run/crm-admin-password:ro"
			--volume "$app_root/deploy/backend/secrets/$owner-postgres-backup-password:/run/crm-backup-password:ro")
	fi
	docker run --rm --interactive --log-driver none --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
		--user 0:0 --memory 128m --memory-swap 128m --cpus 0.5 --pids-limit 32 \
		--volume "$scoped_payload_directory/verifier.mjs:/run/crm-release.mjs:ro" \
		--volume "$release_root/.github/scripts/validate-crm-compose.mjs:/run/crm-compose-validator.mjs:ro" \
		--volume "$release_root/deploy/crm/database-access.mjs:/run/crm-database-access.mjs:ro" \
		--volume "$crm_work_directory:/run/crm:ro" ${mounts[@]+"${mounts[@]}"} \
		--env "CRM_AVAILABLE_MEMORY_BYTES=${crm_available_memory:-0}" \
		--entrypoint node "$selected" /run/crm-release.mjs "${arguments[@]}"
}

crm_database_id() {
	local owner="$1" id
	id="$(docker ps -aq --no-trunc --filter label=com.docker.compose.project=winwidget-crm \
		--filter "label=com.docker.compose.service=$owner-postgres")" || return 1
	[[ -z "$id" || "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
	printf '%s' "$id"
}

crm_verify_database() {
	local owner="$1" id="$2" verified
	[[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
	verified="$(docker inspect "$id" | crm_database_verifier database-container "$owner")" || return 1
	[[ "$verified" == "$id" ]]
}

crm_database_psql() {
	local owner="$1" id="$2" schema="${1//-/_}"
	crm_verify_database "$owner" "$id" || die 'CRM PostgreSQL changed before SQL.'
	docker exec --user postgres --interactive "$id" psql -X -q -tA -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate \
		-U "winwidget_${schema}_admin" -d "winwidget_$schema" 2>/dev/null
}

crm_database_auth() {
	local owner="$1" id="$2" role="$3" schema="${1//-/_}"
	crm_verify_database "$owner" "$id" || die 'CRM PostgreSQL changed before authentication.'
	if [[ "$role" == admin ]]; then
		printf 'SELECT 1;\n' | docker exec --user 0:0 --interactive "$id" sh -ec \
			'IFS= read -r PGPASSWORD < "$1" || test -n "$PGPASSWORD"; export PGPASSWORD; exec psql -X -q -tA -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$2" -d "$3"' \
			sh "/run/secrets/$owner-postgres-admin-password" "winwidget_${schema}_admin" "winwidget_$schema" >/dev/null 2>&1
	else
		case "$role" in migration|runtime|backup) ;; *) return 1 ;; esac
		crm_database_verifier "database-auth-$role" "$owner" | docker exec --user postgres --interactive "$id" sh -ec \
			'IFS= read -r PGPASSWORD; export PGPASSWORD; exec psql -X -q -tA -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$1" -d "$2"' \
			sh "winwidget_${schema}_$role" "winwidget_$schema" >/dev/null 2>&1
	fi
}

crm_database_main() {
	local owner role file image_tag image_id image_revision image_title id attempt state exists schema all_ids actual_ids expected_ids
	crm_owners=(crm-access crm-intake crm-customers crm-sales)
	crm_images=()
	crm_secret_files=()
	crm_secret_hashes=()
	crm_release_directory="$app_root/deploy/backend/crm/releases/$services_revision"
	assert_root_owned_directory "$app_root/deploy/backend/crm/releases"
	assert_root_owned_directory "$crm_release_directory"
	assert_root_owned_directory "$app_root/deploy/backend/secrets"
	for file in desired.json receipt.json; do
		assert_root_owned_file "$crm_release_directory/$file"
		[[ "$(stat -c '%a' "$crm_release_directory/$file")" == 600 ]] || die 'Unsafe CRM prepared artifact mode.'
	done
	crm_desired_hash="$(sha256sum "$crm_release_directory/desired.json" | awk '{print $1}')"
	crm_receipt_hash="$(sha256sum "$crm_release_directory/receipt.json" | awk '{print $1}')"
	[[ -f "$release_root/deploy/crm/database-access.mjs" && ! -L "$release_root/deploy/crm/database-access.mjs" ]] ||
		die 'Pinned service-owned database access implementation is missing.'
	for owner in "${crm_owners[@]}"; do
		image_tag="winwidget-$owner:git-$services_revision"
		read -r image_id image_revision image_title < <(docker image inspect --format \
			'{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.opencontainers.image.title"}}' "$image_tag")
		[[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ && "$image_revision" == "$services_revision" && "$image_title" == "winwidget-$owner" ]] ||
			die 'CRM database stage requires the four already prepared immutable owner images.'
		crm_images+=("$image_id")
		for role in admin backup; do
			file="$app_root/deploy/backend/secrets/$owner-postgres-$role-password"
			assert_root_owned_file "$file"
			[[ "$(stat -c '%a' "$file")" == 600 ]] || die 'CRM database credential file must be private.'
			crm_secret_files+=("$file")
			crm_secret_hashes+=("$(sha256sum "$file" | awk '{print $1}')")
		done
	done
	crm_database_phase=true
	crm_fence
	crm_work_directory="$(mktemp -d "$app_root/deploy/backend/.crm-prepare.XXXXXX")"
	chmod 700 "$crm_work_directory"
	trap crm_cleanup_prepare EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM HUP
	cp -- "$crm_release_directory/desired.json" "$crm_work_directory/desired.json"
	docker image inspect "${crm_images[@]}" >"$crm_work_directory/images.json"
	chmod 600 "$crm_work_directory/desired.json" "$crm_work_directory/images.json"
	# Recompute the preparation receipt, using the actual current non-CRM
	# neighbors. It must match the original bytes before any new database starts.
	docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 0:0 \
		--memory 128m --memory-swap 128m --cpus 0.5 --pids-limit 32 \
		--volume "$scoped_payload_directory/verifier.mjs:/run/crm-release.mjs:ro" \
		--volume "$release_root/.github/scripts/validate-crm-compose.mjs:/run/crm-compose-validator.mjs:ro" \
		--volume "$crm_work_directory:/run/crm:ro" \
		--env "CRM_SERVICES_REVISION=$services_revision" --env "CRM_INFRA_REVISION=$infra_revision" \
		--env "CRM_CANONICAL_ENV_SHA256=$expected_env_sha256" --env "CRM_ENV_SHA256=$expected_service_env_sha256" \
		--env "CRM_NEIGHBORS_SHA256=$crm_neighbors" \
		--entrypoint node "${crm_images[0]}" /run/crm-release.mjs prepare >"$crm_work_directory/receipt.json" ||
		die 'CRM database preparation no longer matches the actual environment.'
	cmp -s "$crm_work_directory/receipt.json" "$crm_release_directory/receipt.json" || die 'CRM database stage must use exactly the sealed preparation.'
	crm_available_memory="$(awk '/^MemAvailable:/ { printf "%.0f", $2 * 1024 }' /proc/meminfo)"
	[[ "$crm_available_memory" =~ ^[0-9]+$ ]] || die 'Cannot measure CRM database preparation headroom.'
	crm_postgres_image="$(crm_database_verifier database-resources)" || die 'Insufficient headroom or unsafe CRM flags for database preparation.'
	[[ "$crm_postgres_image" =~ ^postgres:18-bookworm@sha256:[a-f0-9]{64}$ ]] || die 'CRM PostgreSQL must be digest-pinned.'
	crm_fence
	docker image inspect "$crm_postgres_image" >/dev/null 2>&1 || docker pull "$crm_postgres_image" >/dev/null 2>&1 || die 'Pinned CRM PostgreSQL image is unavailable.'
	docker image inspect "$crm_postgres_image" >"$crm_work_directory/postgres-image.json"
	chmod 600 "$crm_work_directory/postgres-image.json"
	for owner in "${crm_owners[@]}"; do
		crm_database_verifier database-check "$owner" >/dev/null || die 'CRM owner manifest or scoped database credentials are invalid.'
	done
	# Reject all extra CRM project containers, including stopped/one-off jobs.
	all_ids="$(docker ps -aq --no-trunc --filter label=com.docker.compose.project=winwidget-crm)" || die 'Cannot inventory existing CRM containers.'
	expected_ids=''
	for owner in "${crm_owners[@]}"; do
		id="$(crm_database_id "$owner")" || die 'CRM database container is not unique.'
		if [[ -n "$id" ]]; then
			crm_verify_database "$owner" "$id" || die 'An existing CRM database differs from the sealed configuration.'
			expected_ids+="$id"$'\n'
		fi
		# Existing named storage/networks must carry the exact owner labels.
		for role in volume network; do
			file="winwidget-crm_$owner-postgres"
			[[ "$role" != volume ]] || file+="-data"
			if docker "$role" inspect "$file" >/dev/null 2>&1; then
				state="$(docker "$role" inspect --format '{{index .Labels "com.winwidget.owner"}}|{{index .Labels "com.docker.compose.project"}}' "$file")"
				[[ "$state" == "$owner|winwidget-crm" ]] || die 'CRM database storage/network ownership mismatch.'
			fi
		done
	done
	actual_ids="$(printf '%s\n' "$all_ids" | sed '/^$/d' | sort)"
	expected_ids="$(printf '%s' "$expected_ids" | sed '/^$/d' | sort)"
	[[ "$actual_ids" == "$expected_ids" ]] || die 'CRM database stage cannot coexist with applications or unknown jobs.'
	for owner in "${crm_owners[@]}"; do
		crm_fence
		id="$(crm_database_id "$owner")" || die 'Cannot resolve CRM database identity.'
		if [[ -z "$id" ]]; then
			crm_database_compose up --detach --no-deps --no-build --pull never --no-recreate "$owner-postgres" >/dev/null 2>&1 ||
				die 'CRM database start failed; owned data is retained.'
			id="$(crm_database_id "$owner")" || die 'Started CRM database identity is not unique.'
			[[ "$id" =~ ^[a-f0-9]{64}$ ]] || die 'CRM database did not start.'
			for ((attempt=0; attempt<90; attempt++)); do
				state="$(docker inspect --format '{{.State.Health.Status}}' "$id")" || die 'CRM database disappeared during startup.'
				[[ "$state" != healthy ]] || break
				[[ "$state" == starting ]] || die 'CRM database is unhealthy; its data is retained.'
				sleep 1
			done
		fi
		crm_verify_database "$owner" "$id" || die 'CRM database readiness/configuration mismatch.'
		crm_database_auth "$owner" "$id" admin || die 'CRM administrator credential does not match the existing database.'
		schema="${owner//-/_}"
		for role in migration runtime backup; do
			exists="$(printf "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='winwidget_%s_%s');\n" "$schema" "$role" | crm_database_psql "$owner" "$id")" || die 'Cannot inspect CRM role identity.'
			case "$exists" in
				t) crm_database_auth "$owner" "$id" "$role" || die 'Existing CRM role password differs; rotation is forbidden.' ;;
				f) ;;
				*) die 'Unexpected CRM role probe response.' ;;
			esac
		done
		crm_fence
		crm_database_verifier database-bootstrap "$owner" | crm_database_psql "$owner" "$id" >/dev/null || die 'CRM role bootstrap failed; existing data is retained.'
		for role in migration runtime backup; do
			crm_database_auth "$owner" "$id" "$role" || die 'CRM role authentication failed after bootstrap.'
		done
		crm_fence
		crm_database_compose run --rm --no-deps --pull never --name "winwidget-crm-$owner-migration-$services_revision" "$owner-migrate" >/dev/null 2>&1 ||
			die 'CRM migration job failed; no automatic reset, down migration or data deletion is allowed.'
		crm_fence
		crm_database_verifier database-grants "$owner" | crm_database_psql "$owner" "$id" >/dev/null || die 'CRM migration ledger or exact runtime grants failed verification.'
		printf '%s\n' "CRM database verified: $owner; scoped role authentication and exact migration ledger passed."
	done
	crm_fence
	for owner in "${crm_owners[@]}"; do
		id="$(crm_database_id "$owner")" || die 'CRM database identity changed after migration.'
		crm_verify_database "$owner" "$id" || die 'CRM database configuration changed after migration.'
	done
	printf '%s\n' 'Four CRM databases initialized and migrated; no applications, broker, payments or public routes activated. Full runtime capacity remains unproven.'
}
