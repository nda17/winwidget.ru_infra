#!/usr/bin/env bash
# Sourced by the immutable root controller under its shared production lock.
# Preparation does not start CRM, migrate databases, provision the broker,
# change production env, replace existing runtime or open public routes.
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
		--entrypoint node "$crm_probe_image" /run/crm-release.mjs inventory
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
		rm -f -- "$crm_work_directory/desired.json" "$crm_work_directory/images.json" "$crm_work_directory/receipt.json"
		rmdir "$crm_work_directory"
	fi
	cleanup_scoped_payload
	exit "$status"
}

scoped_deploy_main() {
	local gateway_id owner prefix image_tag image_revision image_title image_id file destination
	local -a images=() image_env=()
	[[ "$release_scope" == crm-prepare ]] || die 'Unsupported CRM preparation scope.'
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
