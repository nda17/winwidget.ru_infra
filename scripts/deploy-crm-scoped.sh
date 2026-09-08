#!/usr/bin/env bash
# Sourced by the immutable root controller under its shared production lock.
# crm-prepare seals immutable inputs without starting containers. The separate
# crm-databases scope initializes only owned databases and runs migrations.
# crm-runtime starts only the twelve already prepared CRM processes, with all
# business gates closed. No scope changes env, broker ACL or public routes.
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
		rm -f -- "$crm_work_directory/desired.json" "$crm_work_directory/images.json" "$crm_work_directory/receipt.json" "$crm_work_directory/postgres-image.json" "$crm_work_directory/runtime.json"
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
	if [[ "$release_scope" == crm-upgrade ]]; then crm_upgrade_main; return; fi
	case "$release_scope" in
		# Preparation and its following database stage must seal the same
		# neighbors, including when the four owned databases already exist.
		# database-neighbors still rejects every CRM application/unknown job;
		# database-main verifies the four database configurations separately.
		crm-prepare | crm-databases) crm_inventory_mode=database-neighbors ;;
		crm-runtime) crm_inventory_mode=runtime-neighbors ;;
		*) die 'Unsupported CRM scope.' ;;
	esac
	crm_initialize
	if [[ "$release_scope" == crm-runtime ]]; then crm_runtime_main; return; fi
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
	if [[ -n "$owner" && "$mode" != runtime-container ]]; then
		for index in "${!crm_owners[@]}"; do
			if [[ "${crm_owners[$index]}" == "$owner" ]]; then selected="${crm_images[$index]}"; break; fi
		done
		[[ "${crm_owners[$index]}" == "$owner" ]] || die 'Unknown CRM database owner.'
		arguments+=("$owner")
		mounts+=(--volume "$app_root/deploy/backend/secrets/$owner-postgres-admin-password:/run/crm-admin-password:ro"
			--volume "$app_root/deploy/backend/secrets/$owner-postgres-backup-password:/run/crm-backup-password:ro")
	elif [[ "$mode" == runtime-container ]]; then
		arguments+=("$owner")
	fi
	docker run --rm --interactive --log-driver none --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
		--user 0:0 --memory 128m --memory-swap 128m --cpus 0.5 --pids-limit 32 \
		--volume "$scoped_payload_directory/verifier.mjs:/run/crm-release.mjs:ro" \
		--volume "$release_root/.github/scripts/validate-crm-compose.mjs:/run/crm-compose-validator.mjs:ro" \
		--volume "$release_root/deploy/crm/database-access.mjs:/run/crm-database-access.mjs:ro" \
		--volume "$crm_work_directory:/run/crm:ro" ${mounts[@]+"${mounts[@]}"} \
		--env "CRM_AVAILABLE_MEMORY_BYTES=${crm_available_memory:-0}" \
		--env "CRM_SERVICES_REVISION=$services_revision" --env "CRM_ENV_SHA256=$expected_service_env_sha256" \
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
		crm_database_compose run --rm --no-deps --pull never --interactive=false -T --name "winwidget-crm-$owner-migration-$services_revision" "$owner-migrate" </dev/null >/dev/null 2>&1 ||
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

# Initial closed-product runtime, or an exact idempotent replay. Upgrades to a
# different image/env require a new reviewed release; never roll data backwards.
crm_runtime_main() {
	local owner role file tag id image_revision title expected actual name state attempt names schema
	crm_owners=(crm-access crm-intake crm-customers crm-sales)
	crm_images=()
	crm_secret_files=()
	crm_secret_hashes=()
	crm_release_directory="$app_root/deploy/backend/crm/releases/$services_revision"
	assert_root_owned_directory "$crm_release_directory"
	for file in desired.json receipt.json; do
		assert_root_owned_file "$crm_release_directory/$file"
		[[ "$(stat -c '%a' "$crm_release_directory/$file")" == 600 ]] || die 'Unsafe prepared CRM artifact.'
	done
	crm_desired_hash="$(sha256sum "$crm_release_directory/desired.json" | awk '{print $1}')"
	crm_receipt_hash="$(sha256sum "$crm_release_directory/receipt.json" | awk '{print $1}')"
	for owner in "${crm_owners[@]}"; do
		tag="winwidget-$owner:git-$services_revision"
		read -r id image_revision title < <(docker image inspect --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.opencontainers.image.title"}}' "$tag")
		[[ "$id" =~ ^sha256:[a-f0-9]{64}$ && "$image_revision" == "$services_revision" && "$title" == "winwidget-$owner" ]] || die 'CRM runtime image differs from the prepared release.'
		crm_images+=("$id")
		for role in admin backup; do
			file="$app_root/deploy/backend/secrets/$owner-postgres-$role-password"
			assert_root_owned_file "$file"
			[[ "$(stat -c '%a' "$file")" == 600 ]] || die 'Unsafe CRM database credential file.'
			crm_secret_files+=("$file")
			crm_secret_hashes+=("$(sha256sum "$file" | awk '{print $1}')")
		done
	done
	crm_database_phase=true
	crm_fence
	crm_work_directory="$(mktemp -d "$app_root/deploy/backend/.crm-runtime.XXXXXX")"
	chmod 700 "$crm_work_directory"
	trap crm_cleanup_prepare EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM HUP
	cp -- "$crm_release_directory/desired.json" "$crm_work_directory/desired.json"
	cp -- "$crm_release_directory/receipt.json" "$crm_work_directory/receipt.json"
	docker image inspect "${crm_images[@]}" >"$crm_work_directory/images.json"
	names="$(crm_database_verifier runtime-seal </dev/null)" || die 'Prepared CRM runtime seal does not match images, source or CRM env.'
	[[ "$(printf '%s\n' "$names" | wc -l)" -eq 12 ]] || die 'Exactly twelve CRM application processes are required.'
	crm_database_verifier runtime-compose </dev/null >"$crm_work_directory/runtime.json" || die 'Cannot select the isolated CRM runtime.'
	crm_runtime_hash="$(sha256sum "$crm_work_directory/runtime.json" | awk '{print $1}')"
	# No image pulls, DB creation, migration replay, ACL changes or new dumps.
	expected=''
	for owner in "${crm_owners[@]}"; do
		id="$(crm_database_id "$owner")" || die 'CRM database is not unique.'
		[[ "$id" =~ ^[a-f0-9]{64}$ ]] || die 'Prepared CRM database is missing.'
		tag="$(docker inspect --format '{{.Config.Image}}' "$id")"
		docker image inspect "$tag" >"$crm_work_directory/postgres-image.json"
		crm_verify_database "$owner" "$id" || die 'CRM database configuration differs from the sealed release.'
		crm_database_auth "$owner" "$id" runtime || die 'CRM runtime database credential failed authentication.'
		schema="${owner//-/_}"
		printf 'SELECT coalesce(json_agg(t), '\''[]'\''::json) FROM (SELECT migration_name,checksum,finished_at,rolled_back_at FROM %s._prisma_migrations ORDER BY started_at) t;\n' "$schema" | crm_database_psql "$owner" "$id" | crm_database_verifier runtime-ledger "$owner" >/dev/null || die 'CRM migration ledger differs from its exact image.'
		expected+="$id"$'\n'
	done
	# An existing process is accepted only when its exact image/env and all
	# runtime settings already match. Stopped/unknown/one-off jobs are rejected.
	while IFS= read -r name; do
		id="$(docker ps -aq --no-trunc --filter label=com.docker.compose.project=winwidget-crm --filter "label=com.docker.compose.service=$name")"
		if [[ -n "$id" ]]; then
			[[ "$id" =~ ^[a-f0-9]{64}$ ]] || die 'Duplicate CRM runtime process.'
			docker inspect "$id" | crm_database_verifier runtime-container "$name" >/dev/null || die 'Existing CRM runtime differs from the selected release.'
			expected+="$id"$'\n'
		fi
	done <<<"$names"
	actual="$(docker ps -aq --no-trunc --filter label=com.docker.compose.project=winwidget-crm | sort)"
	[[ "$actual" == "$(printf '%s' "$expected" | sed '/^$/d' | sort)" ]] || die 'Unknown CRM container blocks runtime startup.'
	crm_runtime_memory_before="$(awk '/^MemAvailable:/ {printf "%.0f", $2*1024}' /proc/meminfo)"
	while IFS= read -r name; do
		crm_fence
		[[ "$(sha256sum "$crm_work_directory/runtime.json" | awk '{print $1}')" == "$crm_runtime_hash" ]] || die 'CRM runtime configuration changed.'
		crm_runtime_memory_check before-start
		env -i PATH="$PATH" docker compose --project-name winwidget-crm --env-file /dev/null --profile crm-runtime \
			-f "$crm_work_directory/runtime.json" up --detach --no-deps --no-build --pull never --no-recreate "$name" </dev/null >/dev/null 2>&1 || die 'CRM process failed to start; owned data remains intact.'
		id="$(docker ps -aq --no-trunc --filter label=com.docker.compose.project=winwidget-crm --filter "label=com.docker.compose.service=$name")"
		[[ "$id" =~ ^[a-f0-9]{64}$ ]] || die 'CRM process identity is not unique.'
		for ((attempt=0; attempt<90; attempt++)); do
			state="$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}} {{.RestartCount}} {{.State.OOMKilled}}' "$id")"
			[[ "$state" != 'running healthy 0 false' ]] || break
			[[ "$state" == 'running starting 0 false' ]] || die 'CRM startup failed; inspect this process without resetting data.'
			sleep 2
		done
		docker inspect "$id" | crm_database_verifier runtime-container "$name" >/dev/null || die 'CRM runtime failed exact health/configuration verification.'
		crm_runtime_memory_check
		printf '%s\n' "CRM runtime verified: $name."
	done <<<"$names"
	crm_fence
	while IFS= read -r name; do
		id="$(docker ps -q --no-trunc --filter label=com.docker.compose.project=winwidget-crm --filter "label=com.docker.compose.service=$name")"
		docker inspect "$id" | crm_database_verifier runtime-container "$name" >/dev/null || die 'Final CRM runtime verification failed.'
	done <<<"$names"
	crm_runtime_memory_check
	printf '%s\n' 'Twelve isolated CRM processes verified; public routes, Trial and paid sales remain closed. Load/browser verification is still required.'
}

crm_runtime_memory_check() {
	local available reserve=2147483648
	[[ "${1:-}" != before-start ]] || reserve=2684354560
	available="$(awk '/^MemAvailable:/ {printf "%.0f", $2*1024}' /proc/meminfo)"
	[[ "$available" =~ ^[0-9]+$ && "$crm_runtime_memory_before" =~ ^[0-9]+$ ]] || die 'Cannot measure CRM memory headroom.'
	(( available >= reserve && crm_runtime_memory_before - available <= 3221225472 )) || die 'CRM startup exceeded its memory envelope; keep public access closed.'
}

# Steady-state upgrade only. Baseline/plan are bounded, root-private release
# evidence, not database backups. No env, DB-container, broker or flag writes.
crm_upgrade_inventory() {
	local ids id
	local -a values=()
	ids="$(docker ps -aq --no-trunc)" || return 1
	[[ -n "$ids" ]] || return 1
	while IFS= read -r id; do [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1; values+=("$id"); done <<<"$ids"
	docker inspect "${values[@]}"
}

crm_upgrade_verify_inventory() {
	local status=0
	# Finish enumeration before starting the verifier container: a pipeline
	# would race docker ps against the ephemeral verifier's own creation.
	crm_upgrade_inventory >"$crm_work_directory/current-live.pending" || return 1
	crm_upgrade_probe "$@" <"$crm_work_directory/current-live.pending" || status=$?
	rm -f -- "$crm_work_directory/current-live.pending"
	return "$status"
}

crm_upgrade_probe() {
	local mode="$1" owner="${2:-}" selected="${3:-$crm_probe_image}" phase="${4:-}" network=none user=0:0 crm_upgrade_handoff
	export -n crm_upgrade_handoff
	local -a mounts=() command=()
	case "$mode" in
		upgrade-contract|upgrade-sla-contract) mounts=(--volume "$env_file:/run/crm/canonical.env:ro") ;;
		upgrade-source) user=1001:1001 ;;
		upgrade-database) user=1001:1001; network=host ;;
		upgrade-database-input)
			case "$owner" in identity|billing|crm-access|crm-customers|notification-delivery|crm-sales|crm-intake) ;; *) return 1 ;; esac
			mounts=(--volume "$crm_work_directory/live.json:/run/crm/live.json:ro")
			if [[ "$owner" == crm-* ]]; then mounts+=(--volume "$crm_env_file:/run/crm/crm.env:ro")
			else mounts+=(--volume "$services_repository/apps/$owner/.env.production:/run/crm/$owner.env:ro"); fi ;;
		*) mounts=(
			--volume "$release_root/.github/scripts/validate-crm-compose.mjs:/run/crm-compose-validator.mjs:ro"
			--volume "$release_root/deploy/crm/database-access.mjs:/run/crm-database-access.mjs:ro"
			--volume "$crm_work_directory:/run/crm:ro"
		) ;;
	esac
	if [[ "${crm_upgrade_reminders_contract:-disabled}" == task-reminders-v1 && "$mode" == upgrade-prepare ]]; then
		mounts+=(--volume "$release_root/.github/scripts/validate-crm-reminders-compose.mjs:/run/crm-reminders-compose-validator.mjs:ro")
	fi
	if [[ "${crm_upgrade_sla_contract:-disabled}" == intake-sla-v1 && "$mode" == upgrade-prepare ]]; then
		mounts+=(--volume "$release_root/.github/scripts/validate-crm-intake-sla-compose.mjs:/run/crm-intake-sla-compose-validator.mjs:ro")
	fi
	if [[ "$owner" == notification-delivery && ( "$mode" == upgrade-source || "$mode" == upgrade-database ) ]]; then user=1000:1000; fi
	# The image owns Prisma/package files as UID 1001, including historical
	# 0600/0700 files. Do not add DAC capabilities or widen private artifact ACLs.
	command=(docker run --rm --interactive --network "$network" --read-only --log-driver none
		--cap-drop ALL --security-opt no-new-privileges --user "$user" --memory 256m --memory-swap 256m --cpus 1 --pids-limit 64
		--tmpfs '/tmp:rw,noexec,nosuid,size=16m' \
		--env "CRM_GATEWAY_REVISION=$expected_live_revision" --env "CRM_SERVICES_REVISION=$services_revision" \
		--env "CRM_INFRA_REVISION=$infra_revision" --env "CRM_UPGRADE_ENV_HASHES=$crm_upgrade_env_hashes" \
		--env "CRM_UPGRADE_SWITCHING_OWNER=${crm_upgrade_switching_owner:-}" \
		--env "CRM_REMINDERS_RABBITMQ_CONTRACT=${crm_upgrade_reminders_contract:-disabled}" \
		--env "CRM_INTAKE_SLA_RABBITMQ_CONTRACT=${crm_upgrade_sla_contract:-disabled}" \
		--volume "$scoped_payload_directory/verifier.mjs:/run/crm-release.mjs:ro"
		${mounts[@]+"${mounts[@]}"}
		--entrypoint node "$selected" /run/crm-release.mjs "$mode" "$owner" "$phase")
	if [[ "$mode" == upgrade-database ]]; then
		# Buffer the bounded handoff only in this non-exported shell variable:
		# a failing producer must never start the DB verifier, even after output.
		# No env copy, Docker credential env, private workdir or runtime password.
		crm_upgrade_handoff="$(crm_upgrade_probe upgrade-database-input "$owner" "$crm_probe_image")" || return 1
		(( ${#crm_upgrade_handoff} > 0 && ${#crm_upgrade_handoff} <= 16384 )) || return 1
		printf '%s' "$crm_upgrade_handoff" | "${command[@]}"
	else
		"${command[@]}"
	fi
}

crm_upgrade_env_fence() {
	local owner file hash
	crm_assert_inputs
	[[ "$(sha256sum "$crm_upgrade_baseline_file" | awk '{print $1}')" == "$expected_crm_upgrade_baseline_sha256" ]] || die 'Approved CRM upgrade baseline changed.'
	cmp -s "$crm_upgrade_baseline_file" "$crm_work_directory/baseline.json" || die 'CRM baseline handoff changed.'
	for owner in billing identity notification-delivery; do
		file="$services_repository/apps/$owner/.env.production"
		assert_root_owned_file "$file"
		hash="$(sha256sum "$file" | awk '{print $1}')"
		[[ "$hash" == "$(<"$crm_work_directory/$owner-env.sha256")" ]] || die 'A companion owner env changed during CRM upgrade.'
	done
	if [[ -n "${crm_upgrade_plan_hash:-}" ]]; then
		[[ "$(sha256sum "$crm_work_directory/plan.json" | awk '{print $1}')" == "$crm_upgrade_plan_hash" ]] || die 'Immutable CRM upgrade plan changed.'
	fi
	for file in "$crm_work_directory"/*; do
		[[ -e "$file" || -L "$file" ]] || continue
		assert_root_owned_file "$file"
		[[ "$(stat -c '%a' "$file")" == 600 ]] || die 'CRM upgrade artifact is not private.'
	done
}

crm_upgrade_fence() {
	crm_upgrade_env_fence
	crm_upgrade_verify_inventory upgrade-fence >/dev/null || die 'CRM upgrade target or neighbor drifted; no automatic rollback.'
}

crm_upgrade_compose() {
	local unit="$1"; shift
	local expected
	case "$unit" in crm) expected="$crm_upgrade_runtime_hash" ;; companions) expected="$crm_upgrade_companion_hash" ;; *) die 'Invalid CRM upgrade Compose unit.' ;; esac
	[[ "$(sha256sum "$crm_work_directory/$unit-runtime.json" | awk '{print $1}')" == "$expected" ]] || die 'CRM upgrade runtime artifact changed.'
	env -i PATH="$PATH" docker compose --project-name "$([[ "$unit" == crm ]] && printf winwidget-crm || printf winwidget)" \
		--env-file /dev/null --profile '*' -f "$crm_work_directory/$unit-runtime.json" "$@"
}

crm_upgrade_stop_owner() {
	local unit="$1" owner="$2" name id; shift 2
	printf '%s\n' "$owner" >"$crm_work_directory/switching-owner.pending"
	mv -- "$crm_work_directory/switching-owner.pending" "$crm_work_directory/switching-owner"
	crm_upgrade_switching_owner="$owner"
	crm_upgrade_compose "$unit" stop --timeout 90 "$@" </dev/null >/dev/null 2>&1 || die 'CRM group failed to stop; do not start a mixed group.'
	for name in "$@"; do
		id="$(docker ps -aq --no-trunc --filter "label=com.docker.compose.project=$([[ "$unit" == crm ]] && printf winwidget-crm || printf winwidget)" --filter "label=com.docker.compose.service=$name")"
		[[ -z "$id" || "$id" =~ ^[a-f0-9]{64}$ ]] || die 'Duplicate CRM upgrade target.'
		if [[ -n "$id" ]]; then [[ "$(docker inspect --format '{{.State.Running}} {{.State.Pid}}' "$id")" == 'false 0' ]] || die 'Old CRM group still has a live process.'; fi
	done
}

crm_upgrade_main() {
	local owner prefix tag image revision title gateway_id before before_images file hash name id attempt state unit task_writers_stopped task_writer_stop_required
	local -a images=() image_env=() base_image_env=() names=()
	umask 077
	[[ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}" && "$(docker context inspect --format '{{.Endpoints.docker.Host}}')" == unix:///var/run/docker.sock ]] || die 'CRM upgrade requires the local production daemon.'
	crm_env_file="$app_root/deploy/backend/crm/.env.production"
	crm_upgrade_baseline_file="$app_root/deploy/backend/crm/upgrade-baseline.json"
	assert_root_owned_file "$crm_upgrade_baseline_file"
	[[ "$(stat -c '%a' "$crm_upgrade_baseline_file")" == 600 && "$(sha256sum "$crm_upgrade_baseline_file" | awk '{print $1}')" == "$expected_crm_upgrade_baseline_sha256" ]] || die 'CRM upgrade requires the freshly approved exact baseline.'
	crm_assert_inputs
	gateway_id="$(docker ps -q --no-trunc --filter label=com.docker.compose.project=winwidget --filter label=com.docker.compose.service=api-gateway)"
	[[ "$gateway_id" =~ ^[a-f0-9]{64}$ ]] || die 'Gateway baseline is not uniquely running.'
	read -r crm_probe_image revision < <(docker inspect --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$gateway_id")
	[[ "$crm_probe_image" =~ ^sha256:[a-f0-9]{64}$ && "$revision" == "$expected_live_revision" ]] || die 'Gateway baseline revision changed.'
	# Read the explicit canonical marker, never infer activation from containers.
	crm_upgrade_env_hashes='{}'
	crm_upgrade_reminders_contract="$(crm_upgrade_probe upgrade-contract)" || die 'Cannot read CRM reminder contract.'
	case "$crm_upgrade_reminders_contract" in disabled|task-reminders-v1) ;; *) die 'Unknown CRM reminder contract.' ;; esac
	crm_upgrade_sla_contract="$(crm_upgrade_probe upgrade-sla-contract)" || die 'Cannot read CRM Intake SLA contract.'
	case "$crm_upgrade_sla_contract" in disabled) ;; intake-sla-v1) [[ "$crm_upgrade_reminders_contract" == task-reminders-v1 ]] || die 'SLA requires active reminder contract.' ;; *) die 'Unknown CRM Intake SLA contract.' ;; esac
	file="$app_root/deploy/backend/crm/upgrades"
	[[ -e "$file" ]] || install -d -m 700 "$file"
	assert_root_owned_directory "$file"
	crm_work_directory="$file/$services_revision"
	[[ -e "$crm_work_directory" ]] || install -d -m 700 "$crm_work_directory"
	assert_root_owned_directory "$crm_work_directory"
	[[ "$(stat -c '%a' "$crm_work_directory")" == 700 ]] || die 'CRM upgrade directory must be private.'
	for file in "$crm_work_directory"/*; do
		[[ -e "$file" || -L "$file" ]] || continue
		assert_root_owned_file "$file"
		[[ "$(stat -c '%a' "$file")" == 600 ]] || die 'CRM upgrade artifact must be private.'
	done
	if [[ ! -e "$crm_work_directory/baseline.json" ]]; then install -m 600 "$crm_upgrade_baseline_file" "$crm_work_directory/baseline.json"; fi
	crm_upgrade_env_hashes="{\"canonical\":\"$expected_env_sha256\",\"crm\":\"$expected_service_env_sha256\""
	for owner in billing identity notification-delivery; do
		file="$services_repository/apps/$owner/.env.production"
		assert_root_owned_file "$file"
		[[ "$(stat -c '%a' "$file")" == 600 ]] || die 'Companion owner env must be private.'
		hash="$(sha256sum "$file" | awk '{print $1}')"
		if [[ -e "$crm_work_directory/$owner-env.sha256" ]]; then [[ "$(<"$crm_work_directory/$owner-env.sha256")" == "$hash" ]] || die 'Companion env differs from the existing release.'
		else printf '%s\n' "$hash" >"$crm_work_directory/$owner-env.sha256"; fi
		crm_upgrade_env_hashes+=",\"$owner\":\"$hash\""
	done
	crm_upgrade_env_hashes+='}'
	crm_upgrade_switching_owner=''
	if [[ -e "$crm_work_directory/switching-owner" ]]; then
		crm_upgrade_switching_owner="$(<"$crm_work_directory/switching-owner")"
		case "$crm_upgrade_switching_owner" in identity|billing|crm-access|crm-customers|notification-delivery|crm-sales|crm-intake) ;; *) die 'Invalid interrupted CRM upgrade group.' ;; esac
	fi
	if [[ -e "$crm_work_directory/plan.json" ]]; then
		assert_root_owned_file "$crm_work_directory/plan.json"
		crm_upgrade_plan_hash="$(sha256sum "$crm_work_directory/plan.json" | awk '{print $1}')"
		crm_upgrade_fence
	else
		[[ -z "$crm_upgrade_switching_owner" ]] || die 'Interrupted CRM upgrade is missing its immutable plan.'
		crm_upgrade_verify_inventory upgrade-baseline-check >/dev/null || die 'Live runtime/env no longer matches the approved baseline.'
	fi
	# Tags are immutable. All owner images and source-pair checks precede SQL.
	crm_runtime_memory_before="$(awk '/^MemAvailable:/ {printf "%.0f", $2*1024}' /proc/meminfo)"
	for owner in identity billing crm-access crm-customers notification-delivery crm-sales crm-intake; do
		crm_upgrade_env_fence
		crm_runtime_memory_check before-start
		tag="winwidget-$owner:git-$services_revision"
		if ! docker image inspect "$tag" >/dev/null 2>&1; then
			docker build --build-arg "APP_REVISION=$services_revision" --tag "$tag" "$release_root/apps/$owner" >/dev/null 2>&1 || die 'CRM upgrade image build failed.'
		fi
		if [[ "$owner" == notification-delivery ]]; then
			read -r image revision title < <(docker image inspect --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{.Config.User}}' "$tag")
			[[ "$image" =~ ^sha256:[a-f0-9]{64}$ && "$revision" == "$services_revision" && "$title" == node ]] || die 'ND candidate image identity mismatch.'
		else
			read -r image revision title < <(docker image inspect --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.opencontainers.image.title"}}' "$tag")
			[[ "$image" =~ ^sha256:[a-f0-9]{64}$ && "$revision" == "$services_revision" && "$title" == "winwidget-$owner" ]] || die 'CRM upgrade candidate image identity mismatch.'
		fi
		images+=("$image")
		prefix="${owner//-/_}"; prefix="$(printf '%s' "$prefix" | tr '[:lower:]' '[:upper:]')"
		image_env+=("${prefix}_IMAGE=$image" "${prefix}_REVISION=$services_revision")
		crm_upgrade_probe upgrade-source "$owner" "$image" >"$crm_work_directory/$owner-source-after.json"
		before_images="$(crm_upgrade_probe upgrade-old-images "$owner")" || die 'Cannot resolve approved old owner images.'
		[[ -n "$before_images" ]] || die 'Missing immutable old owner image.'
		while IFS= read -r before; do
			[[ "$before" =~ ^sha256:[a-f0-9]{64}$ ]] || die 'Invalid immutable old owner image.'
			crm_upgrade_probe upgrade-source "$owner" "$before" >"$crm_work_directory/$owner-source-before.json"
			crm_upgrade_probe upgrade-source-check "$owner" >/dev/null || die 'Owner schema/migrations exceed the reviewed CRM upgrade.'
		done <<<"$before_images"
	done
	docker image inspect "${images[@]}" >"$crm_work_directory/images.json"
	if [[ ! -e "$crm_work_directory/plan.json" ]]; then
		crm_upgrade_inventory >"$crm_work_directory/live.json"
		while IFS= read -r file; do [[ "$file" =~ ^[A-Z_]+=(sha256:[a-f0-9]{64}|[a-f0-9]{40}|git-[a-f0-9]{40})$ ]] || die 'Invalid public image override.'; base_image_env+=("$file"); done < <(crm_upgrade_probe upgrade-env <"$crm_work_directory/live.json")
		for owner in billing identity notification-delivery; do
			env -i PATH="$PATH" "${base_image_env[@]}" "${image_env[@]}" docker compose --project-name winwidget --profile '*' \
				--env-file "$env_file" --env-file "$services_repository/apps/$owner/.env.production" -f "$release_root/deploy/docker-compose.prod.yml" config --format json \
				>"$crm_work_directory/$owner.json" 2>/dev/null || die 'CRM companion Compose cannot be materialized safely.'
			if [[ "$owner" == notification-delivery && "$crm_upgrade_reminders_contract" == task-reminders-v1 ]]; then
				mv -- "$crm_work_directory/$owner.json" "$crm_work_directory/$owner-base.json"
				env -i PATH="$PATH" "${base_image_env[@]}" "${image_env[@]}" docker compose --project-name winwidget --profile '*' \
					--env-file "$env_file" --env-file "$services_repository/apps/$owner/.env.production" \
					-f "$release_root/deploy/docker-compose.prod.yml" -f "$release_root/deploy/docker-compose.notification-reminders.yml" config --format json \
					>"$crm_work_directory/$owner.json" 2>/dev/null || die 'CRM reminder reader Compose cannot be materialized safely.'
				if [[ "$crm_upgrade_sla_contract" == intake-sla-v1 ]]; then
					mv -- "$crm_work_directory/$owner.json" "$crm_work_directory/$owner-reminders.json"
					env -i PATH="$PATH" "${base_image_env[@]}" "${image_env[@]}" docker compose --project-name winwidget --profile '*' \
						--env-file "$env_file" --env-file "$services_repository/apps/$owner/.env.production" \
						-f "$release_root/deploy/docker-compose.prod.yml" -f "$release_root/deploy/docker-compose.notification-reminders.yml" -f "$release_root/deploy/docker-compose.notification-intake-sla.yml" config --format json \
						>"$crm_work_directory/$owner.json" 2>/dev/null || die 'CRM SLA reader Compose cannot be materialized safely.'
				fi
			fi
		done
		env -i PATH="$PATH" "${image_env[@]}" docker compose --project-name winwidget-crm --profile '*' --env-file "$crm_env_file" \
			-f "$release_root/deploy/docker-compose.crm.yml" config --format json >"$crm_work_directory/crm.json" 2>/dev/null || die 'CRM upgrade Compose cannot be materialized.'
		if [[ "$crm_upgrade_reminders_contract" == task-reminders-v1 ]]; then
			mv -- "$crm_work_directory/crm.json" "$crm_work_directory/crm-base.json"
			env -i PATH="$PATH" "${image_env[@]}" docker compose --project-name winwidget-crm --profile '*' --env-file "$crm_env_file" \
				-f "$release_root/deploy/docker-compose.crm.yml" -f "$release_root/deploy/docker-compose.crm-reminders.yml" config --format json \
				>"$crm_work_directory/crm.json" 2>/dev/null || die 'CRM reminder Sales Compose cannot be materialized safely.'
			if [[ "$crm_upgrade_sla_contract" == intake-sla-v1 ]]; then
				mv -- "$crm_work_directory/crm.json" "$crm_work_directory/crm-reminders.json"
				env -i PATH="$PATH" "${image_env[@]}" docker compose --project-name winwidget-crm --profile '*' --env-file "$crm_env_file" \
					-f "$release_root/deploy/docker-compose.crm.yml" -f "$release_root/deploy/docker-compose.crm-reminders.yml" -f "$release_root/deploy/docker-compose.crm-intake-sla.yml" config --format json \
					>"$crm_work_directory/crm.json" 2>/dev/null || die 'CRM Intake SLA Compose cannot be materialized safely.'
			fi
		fi
		crm_upgrade_probe upgrade-prepare >"$crm_work_directory/plan.pending" || die 'CRM upgrade configuration changes more than the approved code/images.'
		mv -- "$crm_work_directory/plan.pending" "$crm_work_directory/plan.json"
		crm_upgrade_plan_hash="$(sha256sum "$crm_work_directory/plan.json" | awk '{print $1}')"
	else
		crm_upgrade_probe upgrade-prepare >"$crm_work_directory/plan.pending" || die 'Cannot revalidate the sealed CRM upgrade plan.'
		cmp -s "$crm_work_directory/plan.pending" "$crm_work_directory/plan.json" || die 'Sealed CRM upgrade inputs no longer reproduce the same plan.'
		rm -f -- "$crm_work_directory/plan.pending"
	fi
	for unit in crm companions; do crm_upgrade_probe upgrade-compose "$unit" >"$crm_work_directory/$unit-runtime.json"; done
	crm_upgrade_runtime_hash="$(sha256sum "$crm_work_directory/crm-runtime.json" | awk '{print $1}')"
	crm_upgrade_companion_hash="$(sha256sum "$crm_work_directory/companions-runtime.json" | awk '{print $1}')"
	# Every owner preflight, including unchanged Identity, must pass before the
	# first migration or runtime stop. A retry first proves the same databases.
	for owner in identity billing crm-access crm-customers notification-delivery crm-sales crm-intake; do
		crm_upgrade_fence
		image="winwidget-$owner:git-$services_revision"
		if [[ ! -e "$crm_work_directory/$owner-database-before.json" ]]; then
			[[ ! -e "$crm_work_directory/mutation-started" && -z "$crm_upgrade_switching_owner" ]] || die 'Interrupted CRM upgrade is missing its original database proof.'
			crm_upgrade_probe upgrade-database "$owner" "$image" >"$crm_work_directory/$owner-database.pending" || die 'CRM owner migration preflight failed.'
			mv -- "$crm_work_directory/$owner-database.pending" "$crm_work_directory/$owner-database-before.json"
		fi
		# Freshly re-read even after a partial attempt: unfinished Prisma rows are
		# never silently recovered, and applied migration files are not replayed.
		crm_upgrade_probe upgrade-database "$owner" "$image" >"$crm_work_directory/$owner-database-after.json" || die 'CRM owner has an unresolved migration state.'
		crm_upgrade_probe upgrade-database-check "$owner" '' pending >/dev/null || die 'CRM database or previous ACL changed before mutation.'
	done
	printf '%s\n' "$services_revision" >"$crm_work_directory/mutation-started"
	crm_runtime_memory_before="$(awk '/^MemAvailable:/ {printf "%.0f", $2*1024}' /proc/meminfo)"
	# Within each dependency-ordered group: migrate, grant, verify, then switch.
	# Prisma commits the Sales enum file before the next constraints migration.
	for owner in identity billing crm-access crm-customers notification-delivery crm-sales crm-intake; do
		crm_upgrade_fence
		image="winwidget-$owner:git-$services_revision"
		unit=companions; [[ "$owner" != crm-* ]] || unit=crm
		task_writers_stopped=false
		crm_upgrade_probe upgrade-database "$owner" "$image" >"$crm_work_directory/$owner-database-after.json" || die 'CRM owner changed after preflight.'
		crm_upgrade_probe upgrade-database-check "$owner" '' pending >/dev/null || die 'CRM database continuity failed before owner upgrade.'
		# New invoker task triggers need their table grants before any old writer
		# can execute them. Reuse the sealed forward-recovery switching marker.
		if [[ "$owner" == crm-sales || "$owner" == crm-intake ]]; then
			task_writer_stop_required="$(crm_upgrade_probe upgrade-pending "$owner" '' task-writers)" || die 'Cannot verify Sales task-trigger migration boundary.'
			[[ "$task_writer_stop_required" == 0 || "$task_writer_stop_required" == 1 ]] || die 'Invalid Sales task-trigger migration boundary.'
			if [[ "$task_writer_stop_required" == 1 ]]; then
				if [[ "$owner" == crm-sales ]]; then
					names=(crm-sales-api)
					[[ "$crm_upgrade_reminders_contract" != task-reminders-v1 ]] || names=(crm-sales-reminders crm-sales-api)
				else
					names=(crm-intake-worker crm-intake-widget-control-worker crm-intake-widget-transfer-worker crm-intake-publisher crm-intake-widget-control-publisher crm-intake-widget-transfer-publisher)
					[[ "$crm_upgrade_sla_contract" != intake-sla-v1 ]] || names+=(crm-intake-sla-worker crm-intake-sla-publisher)
					names+=(crm-intake-api)
				fi
				crm_upgrade_fence
				crm_runtime_memory_check before-start
				crm_upgrade_stop_owner "$unit" "$owner" "${names[@]}"
				task_writers_stopped=true
			fi
		fi
		if [[ "$owner" != identity && "$(crm_upgrade_probe upgrade-pending "$owner")" != 0 ]]; then
			crm_upgrade_compose "$unit" run --rm --no-deps --pull never --interactive=false -T "$owner-migrate" </dev/null >/dev/null 2>&1 || die 'CRM owner migration failed; inspect ledger before retry, never reset data.'
		fi
		crm_upgrade_fence
		if [[ "$owner" == crm-* ]]; then
			id="$(docker ps -q --no-trunc --filter label=com.docker.compose.project=winwidget-crm --filter "label=com.docker.compose.service=$owner-postgres")"
			[[ "$id" =~ ^[a-f0-9]{64}$ ]] || die 'CRM owner PostgreSQL is not unique.'
			prefix="${owner//-/_}"
			crm_upgrade_probe upgrade-grants "$owner" "$image" | docker exec --user postgres --interactive "$id" \
				psql -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate -U "winwidget_${prefix}_admin" -d "winwidget_$prefix" >/dev/null 2>&1 || die 'CRM exact runtime grants failed; role bootstrap is not allowed.'
		fi
		crm_upgrade_probe upgrade-database "$owner" "$image" complete >"$crm_work_directory/$owner-database-after.json" || die 'CRM owner post-migration verification failed.'
		crm_upgrade_probe upgrade-database-check "$owner" >/dev/null || die 'CRM database UUID or previous ACL changed.'
		if crm_upgrade_verify_inventory upgrade-complete "$owner" >/dev/null 2>&1; then
			if [[ "$crm_upgrade_switching_owner" == "$owner" ]]; then
				crm_upgrade_switching_owner=''
				rm -f -- "$crm_work_directory/switching-owner"
			fi
			continue
		fi
		crm_upgrade_fence
		case "$owner" in
			identity) names=(identity-api) ;;
			billing) names=(billing-worker billing-outbox-publisher billing-scheduler billing-api) ;;
			crm-access) names=(crm-access-worker crm-access-outbox-publisher crm-access-api) ;;
			crm-customers) names=(crm-customers-api) ;;
			notification-delivery) names=(notification-delivery-worker) ;;
			crm-sales)
				names=(crm-sales-api)
				[[ "$crm_upgrade_reminders_contract" != task-reminders-v1 ]] || names=(crm-sales-reminders crm-sales-api) ;;
			crm-intake)
				names=(crm-intake-worker crm-intake-widget-control-worker crm-intake-widget-transfer-worker crm-intake-publisher crm-intake-widget-control-publisher crm-intake-widget-transfer-publisher)
				[[ "$crm_upgrade_sla_contract" != intake-sla-v1 ]] || names+=(crm-intake-sla-worker crm-intake-sla-publisher)
				names+=(crm-intake-api) ;;
		esac
		unit=companions; [[ "$owner" != crm-* ]] || unit=crm
		crm_runtime_memory_check before-start
		if [[ "$task_writers_stopped" != true ]]; then crm_upgrade_stop_owner "$unit" "$owner" "${names[@]}"; fi
		for name in "${names[@]}"; do
			crm_upgrade_fence
			crm_upgrade_compose "$unit" up --detach --no-deps --no-build --pull never --force-recreate "$name" </dev/null >/dev/null 2>&1 || die 'CRM replacement failed; retain desired image/SQL and retry the same release.'
			id="$(docker ps -q --no-trunc --filter "label=com.docker.compose.project=$([[ "$unit" == crm ]] && printf winwidget-crm || printf winwidget)" --filter "label=com.docker.compose.service=$name")"
			[[ "$id" =~ ^[a-f0-9]{64}$ ]] || die 'CRM replacement is not uniquely running.'
			for ((attempt=0; attempt<90; attempt++)); do
				state="$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}} {{.RestartCount}} {{.State.OOMKilled}}' "$id")"
				[[ "$state" != 'running healthy 0 false' ]] || break
				[[ "$state" == 'running starting 0 false' ]] || die 'CRM replacement is not healthy; no old-writer rollback.'
				sleep 2
			done
			[[ "$state" == 'running healthy 0 false' ]] || die 'CRM replacement readiness timed out.'
			crm_runtime_memory_check
		done
		crm_upgrade_switching_owner=''
		crm_upgrade_verify_inventory upgrade-complete "$owner" >/dev/null || die 'CRM group final image/config/health verification failed.'
		rm -f -- "$crm_work_directory/switching-owner"
		printf '%s\n' "CRM upgrade group verified: $owner."
	done
	crm_upgrade_fence
	crm_upgrade_verify_inventory upgrade-complete all >/dev/null || die 'CRM upgrade is incomplete.'
	for owner in identity billing crm-access crm-customers notification-delivery crm-sales crm-intake; do
		crm_upgrade_probe upgrade-database "$owner" "winwidget-$owner:git-$services_revision" complete >"$crm_work_directory/$owner-database-after.json" || die 'CRM final database verification failed.'
		crm_upgrade_probe upgrade-database-check "$owner" >/dev/null || die 'CRM final database continuity failed.'
	done
	crm_upgrade_fence
	local process_count=18
	[[ "$crm_upgrade_reminders_contract" != task-reminders-v1 ]] || process_count=19
	[[ "$crm_upgrade_sla_contract" != intake-sla-v1 ]] || process_count=21
	printf '%s\n' "CRM steady-state code upgrade verified: $process_count processes; existing database identities/ACL, neighbors and env preserved. No broker or product-gate mutations; queue and browser/payment checks remain separate."
}
