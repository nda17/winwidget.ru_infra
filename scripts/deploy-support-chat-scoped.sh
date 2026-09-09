#!/usr/bin/env bash
# Sourced only by the immutable production controller under its shared lock.
# No feature activation, external notification, env mutation or queue deletion.
# shellcheck disable=SC2154
[[ "${BASH_SOURCE[0]}" != "$0" ]] || { printf '%s\n' 'Use the pinned reusable production workflow.' >&2; exit 1; }

support_code_files=(support-chat-release.mjs support-chat-broker.mjs scoped-service-release.mjs)
support_owners=(identity crm-access operations notification-delivery support api-gateway)

support_image_variables() {
	local owner="$1" image="$2" revision="$3" prefix
	[[ "$image" =~ ^sha256:[a-f0-9]{64}$ && "$revision" =~ ^[a-f0-9]{40}$ ]] || die 'Support Compose image identity is invalid.'
	if [[ "$owner" == api-gateway ]]; then
		[[ "$(docker image inspect --format '{{.Id}}' "winwidget-api-gateway:git-$revision")" == "$image" ]] || die 'Gateway image tag no longer resolves to its exact image ID.'
		image_env+=("APP_VERSION=git-$revision" "APP_REVISION=$revision")
	else
		prefix="$(printf '%s' "$owner" | tr '[:lower:]-' '[:upper:]_')"
		image_env+=("${prefix}_IMAGE=$image" "${prefix}_REVISION=$revision")
	fi
}
support_existing_compose_images() {
	local owner project name id image revision
	# Full Compose interpolation needs neighboring image variables even though
	# prepared output contains only the eleven explicitly allowed processes.
	for owner in campaigns reporting widgets billing platform crm-intake crm-customers crm-sales; do
		project=winwidget
		case "$owner" in
			campaigns | reporting | widgets) name="$owner-service" ;;
			crm-*) project=winwidget-crm; name="$owner-api" ;;
			*) name="$owner-api" ;;
		esac
		id="$(docker ps --no-trunc --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$name" --format '{{.ID}}')"
		[[ "$id" =~ ^[a-f0-9]{64}$ ]] || die 'Support Compose neighbor is not uniquely running.'
		read -r image revision < <(docker inspect --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$id")
		support_image_variables "$owner" "$image" "$revision"
	done
}

support_private() {
	assert_root_owned_file "$1" && [[ "$(stat -c '%a:%h' "$1")" == 600:1 ]]
}
support_inputs() {
	local index file
	[[ "$(stat -Lc '%d:%i' "/proc/$$/fd/$deploy_lock_fd")" == "$(stat -c '%d:%i' "$deploy_lock")" ]] || return 1
	flock -n "$deploy_lock_fd" || return 1
	[[ "$(git -C "$release_root" rev-parse HEAD)" == "$services_revision" && -z "$(git -C "$release_root" status --porcelain --untracked-files=all)" ]] || return 1
	for index in "${!support_env_files[@]}"; do
		file="${support_env_files[$index]}"; support_private "$file" || return 1
		[[ "$(sha256sum "$file" | awk '{print $1}')" == "${support_env_hashes[$index]}" ]] || return 1
	done
	[[ "$(sha256sum "$scoped_payload_directory/controller.sh" | awk '{print $1}')" == "$scoped_shell_sha256" &&
		"$(sha256sum "$scoped_payload_directory/verifier.mjs" | awk '{print $1}')" == "$scoped_node_sha256" ]] || return 1
	for index in "${!support_code_files[@]}"; do
		file="$scoped_payload_directory/${support_code_files[$index]}"
		assert_root_owned_file "$file" || return 1
		[[ "$(sha256sum "$file" | awk '{print $1}')" == "${support_code_hashes[$index]}" ]] || return 1
	done
}
support_node() {
	local file index
	local -a mounts=(--volume "$support_directory:/run/support-work:rw")
	for file in "${support_code_files[@]}"; do mounts+=(--volume "$scoped_payload_directory/$file:/run/support-code/$file:ro"); done
	for index in "${!support_env_files[@]}"; do mounts+=(--volume "${support_env_files[$index]}:/run/support-input/${support_env_names[$index]}:ro"); done
	docker run --rm --network "${support_probe_network:-none}" --read-only --log-driver none --cap-drop ALL \
		--security-opt no-new-privileges --user 0:0 --memory 256m --memory-swap 256m --cpus 1 --pids-limit 64 --ulimit core=0:0 \
		--tmpfs /tmp:rw,noexec,nosuid,size=16m \
		--env "SUPPORT_REVISION=$services_revision" --env "SUPPORT_GATEWAY_REVISION=$expected_live_revision" \
		--env "SUPPORT_EXPECTED_BASELINE=$expected_support_chat_baseline_sha256" \
		--env "SUPPORT_RELEASE_SCOPE=$release_scope" \
		"${mounts[@]}" --entrypoint node "$support_probe_image" /run/support-code/support-chat-release.mjs "$@"
}
support_inventory() {
	local name project ids id
	local -a selected=()
	ids="$(docker ps --no-trunc --format '{{.ID}}')" || return 1
	while IFS= read -r id; do [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1; selected+=("$id"); done <<<"$ids"
	# Include the two explicitly paused backup processes, never another stopped job.
	for name in operations-worker operations-restore-worker; do
		project=winwidget
		ids="$(docker ps --all --no-trunc --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$name" --format '{{.ID}}')" || return 1
		[[ "$ids" =~ ^[a-f0-9]{64}$ ]] || return 1
		if [[ " ${selected[*]} " != *" $ids "* ]]; then selected+=("$ids"); fi
	done
	(( ${#selected[@]} <= 200 )) || return 1
	docker inspect "${selected[@]}"
}
support_fence() {
	support_inputs && support_inventory >"$support_directory/live.json" && support_node fence
}
support_compose() {
	local project=winwidget
	[[ "$1" != crm-access-api ]] || project=winwidget-crm
	shift
	env -i PATH="$PATH" docker compose --project-name "$project" -f "$support_directory/desired-$project.json" "$@"
}
support_wait() {
	local name="$1" project=winwidget id health attempt
	[[ "$name" != crm-access-api ]] || project=winwidget-crm
	for ((attempt=0; attempt<90; attempt++)); do
		id="$(docker ps --all --no-trunc --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$name" --format '{{.ID}}')"
		[[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
		health="$(docker inspect --format '{{.State.Status}}:{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id")"
		[[ "$health" != running:healthy ]] || return 0
		[[ "$health" != exited:* && "$health" != dead:* ]] || return 1
		sleep 2
	done
	return 1
}
support_start() {
	local name="$1"
	support_fence || die 'Support runtime or immutable inputs changed.'
	support_compose "$name" up --detach --no-deps --no-build --pull never "$name" >/dev/null 2>&1 || die 'Support scoped process update failed.'
	support_wait "$name" || die 'Support scoped process did not become healthy.'
	if ! support_node unpaused "$name" || ! support_node updated "$name"; then die 'Cannot record scoped process state.'; fi
	support_fence || die 'Support replacement differs from its prepared image/configuration.'
}
support_database() {
	local owner="$1" action="$2" file="$services_repository/apps/$1/.env.production" image="winwidget-$1:git-$services_revision"
	[[ "$owner" != crm-access ]] || file="${support_env_files[5]}"
	support_fence || die 'Support release fence failed before database work.'
	docker run --rm --network host --read-only --log-driver none --cap-drop ALL --security-opt no-new-privileges \
		--user 0:0 --memory 512m --memory-swap 512m --cpus 1 --pids-limit 64 --ulimit core=0:0 \
		--tmpfs /tmp:rw,nosuid,size=64m --env-file "$file" \
		--volume "$scoped_payload_directory:/run/support-code:ro" \
		--entrypoint node "$image" /run/support-code/support-chat-release.mjs "$action" "$owner" \
		|| die 'Support owned migration/ledger/privilege verification failed.'
}
support_quiet() {
	docker run --rm --network host --read-only --log-driver none --cap-drop ALL --security-opt no-new-privileges \
		--user 0:0 --memory 256m --memory-swap 256m --cpus 1 --pids-limit 64 --ulimit core=0:0 \
		--env-file "${support_env_files[3]}" --volume "$scoped_payload_directory:/run/support-code:ro" \
		--entrypoint node "winwidget-operations:git-$services_revision" /run/support-code/support-chat-release.mjs operations-quiet
}
support_finish() {
	local status=$?
	trap - EXIT
	# Keep root-only desired/rollback/baseline and progress evidence for recovery.
	# Never downgrade an Operations migration reader or remove retained events.
	if (( status != 0 )); then
		printf '%s\n' 'Support scoped operation stopped. Inspect private progress before retry; retain compatible readers, owner env, migrations and queues.' >&2
	fi
	cleanup_scoped_payload
	exit "$status"
}

scoped_deploy_main() {
	local owner prefix image id name file index manifest operations_before_image
	local -a image_ids=() image_env=()
	[[ "$release_scope" =~ ^support-chat(-activate)?$ && "$expected_support_chat_baseline_sha256" =~ ^[a-f0-9]{64}$ ]] || die 'Invalid Support release scope.'
	[[ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}" && "$(docker context inspect --format '{{.Endpoints.docker.Host}}')" == unix:///var/run/docker.sock ]] || die 'Support release requires the local production Docker daemon.'
	support_env_names=(canonical identity notificationDelivery operations support crm)
	support_env_files=("$env_file" "$services_repository/apps/identity/.env.production" "$services_repository/apps/notification-delivery/.env.production" "$services_repository/apps/operations/.env.production" "$services_repository/apps/support/.env.production" "$app_root/deploy/backend/crm/.env.production")
	support_env_hashes=()
	for file in "${support_env_files[@]}"; do support_private "$file" || die 'Unsafe Support release input.'; support_env_hashes+=("$(sha256sum "$file" | awk '{print $1}')"); done
	[[ "${support_env_hashes[0]}" == "$expected_env_sha256" && "${support_env_hashes[5]}" == "$expected_service_env_sha256" ]] || die 'Support canonical/CRM env hash mismatch.'
	id="$(docker ps --no-trunc --filter label=com.docker.compose.project=winwidget --filter label=com.docker.compose.service=api-gateway --format '{{.ID}}')"
	[[ "$id" =~ ^[a-f0-9]{64}$ ]] || die 'Support release needs one running Gateway.'
	support_probe_image="$(docker inspect --format '{{.Image}}' "$id")"
	[[ "$support_probe_image" =~ ^sha256:[a-f0-9]{64}$ ]] || die 'Invalid Support verifier image.'
	docker run --rm --interactive --network none --read-only --log-driver none --cap-drop ALL --security-opt no-new-privileges \
		--user 0:0 --memory 128m --memory-swap 128m --pids-limit 32 --volume "$scoped_payload_directory:/run/payload:rw" \
		--entrypoint node "$support_probe_image" --input-type=module <<'SUPPORT_UNPACK'
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
try {
 const bytes=readFileSync('/run/payload/verifier.mjs'); assert.ok(bytes.length>0&&bytes.length<=393216);
 const value=JSON.parse(bytes), names=['support-chat-release.mjs','support-chat-broker.mjs','scoped-service-release.mjs'];
 assert.deepEqual(Object.keys(value).sort(),['files','schemaVersion']); assert.equal(value.schemaVersion,1);
 assert.deepEqual(value.files.map(row=>row.name).sort(),names.sort());
 for(const row of value.files){assert.deepEqual(Object.keys(row).sort(),['content','name','sha256']);assert.equal(typeof row.content,'string');
 assert.ok(Buffer.byteLength(row.content)>0&&Buffer.byteLength(row.content)<=(row.name==='scoped-service-release.mjs'?147456:131072));
 assert.equal(createHash('sha256').update(row.content).digest('hex'),row.sha256);}
 for(const row of value.files)writeFileSync('/run/payload/'+row.name,row.content,{flag:'wx',mode:0o444});
}catch{process.stderr.write('Support payload rejected.\n');process.exitCode=1;}
SUPPORT_UNPACK
	support_code_hashes=()
	for name in "${support_code_files[@]}"; do support_code_hashes+=("$(sha256sum "$scoped_payload_directory/$name" | awk '{print $1}')"); done
	support_directory="$(mktemp -d "$app_root/deploy/backend/.$release_scope-release-$services_revision.XXXXXX")"
	chmod 700 "$support_directory"
	trap support_finish EXIT
	support_inventory >"$support_directory/before.json" || die 'Cannot capture Support baseline.'
	if ! support_inputs || ! support_node inputs; then die 'Support runtime differs from the approved baseline.'; fi
	for owner in "${support_owners[@]}"; do
		support_inputs || die 'Support inputs changed before build.'
		image="winwidget-$owner:git-$services_revision"
		if [[ "$release_scope" == support-chat-activate ]]; then
			case "$owner" in
				identity | crm-access | support | operations) name="$owner-api" ;;
				notification-delivery) name=notification-delivery-worker ;;
				api-gateway) name=api-gateway ;;
			esac
			id="$(docker ps --no-trunc --filter "label=com.docker.compose.service=$name" --format '{{.ID}}')"
			[[ "$id" =~ ^[a-f0-9]{64}$ ]] || die 'Support activation process is not uniquely running.'
			read -r image prefix < <(docker inspect --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$id")
			[[ "$image" =~ ^sha256:[a-f0-9]{64}$ && "$prefix" =~ ^[a-f0-9]{40}$ ]] || die 'Support activation image identity is invalid.'
			git -C "$release_root" diff --quiet "$prefix" "$services_revision" -- "apps/$owner" || die 'Support activation cannot change application source; release compatible images first.'
			image_ids+=("$image")
			support_image_variables "$owner" "$image" "$prefix"
			continue
		fi
		if ! docker image inspect "$image" >/dev/null 2>&1; then
			docker build --build-arg "APP_REVISION=$services_revision" --tag "$image" "$release_root/apps/$owner" >/dev/null 2>&1 || die 'Support scoped immutable image build failed.'
		fi
		read -r id prefix < <(docker image inspect --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
		[[ "$id" =~ ^sha256:[a-f0-9]{64}$ && "$prefix" == "$services_revision" ]] || die 'Support candidate image revision mismatch.'
		image_ids+=("$id")
		support_image_variables "$owner" "$id" "$services_revision"
	done
	support_existing_compose_images
	docker image inspect "${image_ids[@]}" >"$support_directory/images.json"
	for owner in "${support_owners[@]}"; do
		file="$services_repository/apps/$owner/.env.production"
		if [[ "$owner" == api-gateway ]]; then file="$env_file"; fi
		if [[ "$owner" == crm-access ]]; then
			env -i PATH="$PATH" "${image_env[@]}" docker compose --profile '*' --project-name winwidget-crm --env-file "${support_env_files[5]}" -f "$release_root/deploy/docker-compose.crm.yml" config --format json >"$support_directory/$owner.json" 2>/dev/null || die 'Support CRM Compose materialization failed.'
		else
			env -i PATH="$PATH" "${image_env[@]}" docker compose --profile '*' --project-name winwidget --env-file "$env_file" --env-file "$file" -f "$release_root/deploy/docker-compose.prod.yml" config --format json >"$support_directory/$owner.json" 2>/dev/null || die "Support $owner Compose materialization failed."
		fi
	done
	support_node prepare || die 'Support candidate changes exceed the scoped configuration contract.'
	if [[ "$release_scope" == support-chat-activate ]]; then
		support_probe_network=host support_node broker || die 'Support activation topology/ACL preflight failed.'
		# Delivery and outcome readers precede the API that admits new messages.
		for name in notification-delivery-worker support-worker support-outbox-publisher support-api; do support_start "$name"; done
		support_probe_network=host support_node http || die 'Support activation authenticated route smoke failed.'
		support_fence || die 'Support activation final runtime fence failed.'
		printf '%s\n' 'Support chat runtime is active on existing immutable images. Notification settings remain service-owned; no external test was sent.'
		return
	fi
	for owner in identity crm-access operations notification-delivery support; do support_database "$owner" database-preflight; done
	# Compare backup manifests before any restart. Unrelated migration changes
	# cannot silently become mandatory for a service outside this release scope.
	id="$(docker ps --no-trunc --filter label=com.docker.compose.project=winwidget --filter label=com.docker.compose.service=operations-worker --format '{{.ID}}')"
	operations_before_image="$(docker inspect --format '{{.Image}}' "$id")"
	for manifest in restore backup; do
		for index in before after; do
			image="$operations_before_image"
			[[ "$index" != after ]] || image="winwidget-operations:git-$services_revision"
			docker run --rm --network none --read-only --log-driver none --cap-drop ALL --security-opt no-new-privileges --entrypoint node "$image" \
				-e "process.stdout.write(require('node:fs').readFileSync('/app/$manifest-manifests/database-$manifest-migrations.json'))" >"$support_directory/manifest-$manifest-$index.json" || die 'Cannot inspect Operations migration manifest.'
		done
		support_node manifests "$manifest" || die 'Operations backup/restore manifest changes outside Support scope.'
	done
	support_probe_network=host support_node broker || die 'Support broker exact additive provisioning failed.'
	for name in identity-api crm-access-api operations-api operations-outbox-publisher; do support_start "$name"; done
	support_quiet || die 'Operations backup or restore is active; retry after completion.'
	for name in operations-worker operations-restore-worker; do
		support_fence || die 'Support fence failed before backup pause.'
		support_compose "$name" stop --timeout 60 "$name" >/dev/null 2>&1 || die 'Cannot pause Operations backup process.'
		support_node paused "$name" || die 'Cannot record backup pause.'
	done
	support_quiet || die 'Operations became active during backup pause.'
	support_database notification-delivery database-migrate
	support_start notification-delivery-worker
	support_database support database-migrate
	for name in operations-worker operations-restore-worker support-api support-worker support-outbox-publisher api-gateway; do support_start "$name"; done
	support_probe_network=host support_node http || die 'Support authenticated Gateway route smoke failed.'
	support_fence || die 'Support release final runtime fence failed.'
	printf '%s\n' 'Support chat compatible readers, additive migrations, retained topology and authenticated Gateway route are ready. Product and notification gates remain disabled.'
}
