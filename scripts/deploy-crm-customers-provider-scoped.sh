#!/usr/bin/env bash
# One existing Customers API; configuration only. No build, SQL or provider call.
# shellcheck disable=SC2154
[[ "${BASH_SOURCE[0]}" != "$0" ]] || { printf '%s\n' 'Use the pinned reusable production workflow.' >&2; exit 1; }

provider_files=(crm-customers-provider-config.mjs crm-commerce-activation.mjs crm-release.mjs scoped-service-release.mjs)

provider_private() {
	local file="$1" size
	assert_root_owned_file "$file" || return 1
	[[ "$(stat -c '%a' "$file")" == 600 && "$(stat -c '%h' "$file")" == 1 ]] || return 1
	size="$(stat -c '%s' "$file")" || return 1
	[[ "$size" =~ ^[0-9]+$ ]] && (( size > 0 && size <= 8388608 ))
}
provider_unpack() {
	docker run --rm --interactive --network none --read-only --log-driver none --cap-drop ALL \
		--security-opt no-new-privileges --user 0:0 --memory 128m --memory-swap 128m --cpus 0.5 --pids-limit 32 --ulimit core=0:0 \
		--volume "$scoped_payload_directory:/run/payload:rw" --entrypoint node "$provider_probe_image" --input-type=module <<'PROVIDER_UNPACK'
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
try {
 const bytes=readFileSync('/run/payload/verifier.mjs'); assert.ok(bytes.length>0&&bytes.length<=524288);
 const value=JSON.parse(bytes), names=['crm-customers-provider-config.mjs','crm-commerce-activation.mjs','crm-release.mjs','scoped-service-release.mjs'];
 const exact=(item,keys)=>{assert.ok(item&&typeof item==='object'&&!Array.isArray(item));assert.deepEqual(Object.keys(item).sort(),keys.sort());};
 exact(value,['schemaVersion','files']);assert.equal(value.schemaVersion,1);assert.ok(Array.isArray(value.files));
 assert.deepEqual(value.files.map(item=>item.name).sort(),names.sort());
 const files=value.files.map(item=>{exact(item,['name','sha256','content']);assert.match(item.sha256,/^[a-f0-9]{64}$/);assert.equal(typeof item.content,'string');
 const data=Buffer.from(item.content,'utf8');assert.equal(data.toString('utf8'),item.content);assert.ok(data.length>0&&data.length<=147456);
 assert.equal(createHash('sha256').update(data).digest('hex'),item.sha256);return {...item,data};});
 for(const file of files) writeFileSync('/run/payload/'+file.name,file.data,{flag:'wx',mode:0o444});
} catch {process.stderr.write('CRM provider payload rejected; private details suppressed\n');process.exitCode=1;}
PROVIDER_UNPACK
}
provider_inputs() {
	local file index
	assert_root_owned_file "$deploy_lock" || return 1
	[[ "$deploy_lock_fd" =~ ^[0-9]+$ && "$(stat -Lc '%d:%i' "/proc/$$/fd/$deploy_lock_fd")" == "$(stat -c '%d:%i' "$deploy_lock")" ]] || return 1
	flock -n "$deploy_lock_fd" || return 1
	[[ "$(git -C "$release_root" rev-parse HEAD)" == "$services_revision" && -z "$(git -C "$release_root" status --porcelain --untracked-files=all)" ]] || return 1
	for index in 0 1 2; do
		file="${provider_input_files[$index]}"; provider_private "$file" || return 1
		[[ "$(sha256sum "$file" | awk '{print $1}')" == "${provider_input_hashes[$index]}" ]] || return 1
	done
	[[ "$(sha256sum "$scoped_payload_directory/controller.sh" | awk '{print $1}')" == "$scoped_shell_sha256" &&
		"$(sha256sum "$scoped_payload_directory/verifier.mjs" | awk '{print $1}')" == "$scoped_node_sha256" ]] || return 1
	for index in "${!provider_files[@]}"; do
		file="$scoped_payload_directory/${provider_files[$index]}"
		assert_root_owned_file "$file" || return 1
		[[ "$(stat -c '%a' "$file")" == 444 && "$(sha256sum "$file" | awk '{print $1}')" == "${provider_code_hashes[$index]}" ]] || return 1
	done
}
provider_probe() {
	local file
	local -a mounts=(--volume "$provider_directory:/run/provider:ro")
	for file in "${provider_files[@]}"; do mounts+=(--volume "$scoped_payload_directory/$file:/run/provider-code/$file:ro"); done
	docker run --rm --interactive --network none --read-only --log-driver none --cap-drop ALL \
		--security-opt no-new-privileges --user 0:0 --memory 256m --memory-swap 256m --cpus 1 --pids-limit 64 --ulimit core=0:0 \
		--tmpfs /tmp:rw,noexec,nosuid,size=16m \
		--env "PROVIDER_CANONICAL_SHA256=$expected_env_sha256" --env "PROVIDER_CRM_SHA256=$expected_service_env_sha256" \
		--env "PROVIDER_BASELINE_SHA256=$expected_crm_customers_provider_baseline_sha256" \
		--env "PROVIDER_SERVICES_REVISION=$services_revision" --env "PROVIDER_INFRA_REVISION=$infra_revision" \
		--env "PROVIDER_PAYLOAD_SHA256=$scoped_node_sha256" --env "PROVIDER_CONTROLLER_SHA256=$scoped_shell_sha256" \
		--env "PROVIDER_GATEWAY_REVISION=$expected_live_revision" \
		"${mounts[@]}" --entrypoint timeout "$provider_probe_image" -s TERM -k 5s 45s node /run/provider-code/crm-customers-provider-config.mjs "$1"
}
provider_publish() {
	local pending="$1" name="$2" replace="$3" destination="$provider_directory/$2"
	[[ "$pending" == "$provider_directory"/.pending.* && "$name" =~ ^[a-z][a-z0-9-]*\.json$ ]] || return 1
	provider_private "$pending" || return 1
	if [[ -e "$destination" || -L "$destination" ]]; then
		[[ "$replace" == true ]] || return 1
		provider_private "$destination" || return 1
	fi
	sync -f "$pending" || return 1
	mv -T -- "$pending" "$destination" || return 1
	sync -f "$destination" && sync -f "$provider_directory"
}
provider_capture() {
	local name="$1" replace="$2" pending
	shift 2
	pending="$(mktemp "$provider_directory/.pending.XXXXXX")" || return 1
	chmod 600 "$pending" || return 1
	"$@" >"$pending" || { rm -f -- "$pending"; return 1; }
	provider_publish "$pending" "$name" "$replace"
}
provider_inventory() {
	local project ids id
	local -a selected=()
	for project in winwidget winwidget-crm; do
		ids="$(docker ps --all --no-trunc --filter "label=com.docker.compose.project=$project" --format '{{.ID}}')" || return 1
		[[ -n "$ids" ]] || return 1
		while IFS= read -r id; do [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1; selected+=("$id"); done <<<"$ids"
	done
	(( ${#selected[@]} <= 200 )) || return 1
	docker inspect "${selected[@]}"
}
provider_fence() {
	provider_inputs && provider_capture inventory.json true provider_inventory && provider_probe progress >/dev/null
}
provider_compose() {
	provider_private "$provider_directory/runtime.json" || return 1
	[[ "$(sha256sum "$provider_directory/runtime.json" | awk '{print $1}')" == "$provider_runtime_hash" ]] || return 1
	# No retry/timeout: started.json is already durable, unknown means observe only.
	env -i PATH="$PATH" docker compose --project-name winwidget-crm --env-file /dev/null --profile '*' \
		-f "$provider_directory/runtime.json" up --detach --no-build --pull never --no-deps --force-recreate crm-customers-api >/dev/null 2>&1
}
provider_cleanup() {
	local status=$?
	trap - EXIT
	if (( status != 0 )); then
		printf '%s\n' 'CRM Customers provider activation interrupted. Private plan and single-attempt receipts retained; no rollback or automatic second stop/create.' >&2
	fi
	cleanup_scoped_payload
	exit "$status"
}
scoped_deploy_main() {
	local gateway_id revision directory file pending values attempt target_id target_image
	local -a image_env=()
	[[ "$release_scope" == crm-customers-provider-config && "$expected_crm_customers_provider_baseline_sha256" =~ ^[a-f0-9]{64}$ ]] || die 'Invalid Customers provider scope approval.'
	[[ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}" && "$(docker context inspect --format '{{.Endpoints.docker.Host}}')" == unix:///var/run/docker.sock ]] || die 'Provider activation requires the local production Docker daemon.'
	provider_crm_env="$app_root/deploy/backend/crm/.env.production"
	provider_baseline="$app_root/deploy/backend/crm/customers-provider-baseline.json"
	assert_root_owned_directory "$app_root/deploy/backend/crm"
	for file in "$env_file" "$provider_crm_env" "$provider_baseline"; do provider_private "$file" || die 'Unsafe provider input.'; done
	provider_input_files=("$env_file" "$provider_crm_env" "$provider_baseline")
	provider_input_hashes=("$expected_env_sha256" "$expected_service_env_sha256" "$expected_crm_customers_provider_baseline_sha256")
	gateway_id="$(docker ps --no-trunc --filter label=com.docker.compose.project=winwidget --filter label=com.docker.compose.service=api-gateway --format '{{.ID}}')"
	[[ "$gateway_id" =~ ^[a-f0-9]{64}$ ]] || die 'Existing Gateway is not uniquely running.'
	read -r provider_probe_image revision < <(docker inspect --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$gateway_id")
	[[ "$provider_probe_image" =~ ^sha256:[a-f0-9]{64}$ && "$revision" == "$expected_live_revision" ]] || die 'Gateway baseline differs from approval.'
	[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$provider_probe_image")" == "$expected_live_revision" ]] || die 'Gateway image identity differs.'
	provider_unpack || die 'Cannot unpack immutable provider controller.'
	provider_code_hashes=()
	for file in "${provider_files[@]}"; do provider_code_hashes+=("$(sha256sum "$scoped_payload_directory/$file" | awk '{print $1}')"); done
	provider_inputs || die 'Provider approval inputs changed.'
	directory="$app_root/deploy/backend/crm/customers-provider-activations"
	if [[ ! -e "$directory" && ! -L "$directory" ]]; then install -d -o root -g root -m 0700 "$directory"; fi
	assert_root_owned_directory "$directory"
	[[ "$(stat -c '%a' "$directory")" == 700 ]] || die 'Unsafe provider parent directory.'
	provider_directory="$directory/$services_revision"
	if [[ ! -e "$provider_directory" && ! -L "$provider_directory" ]]; then install -d -o root -g root -m 0700 "$provider_directory"; fi
	assert_root_owned_directory "$provider_directory"
	[[ "$(stat -c '%a' "$provider_directory")" == 700 ]] || die 'Unsafe provider activation directory.'
	trap provider_cleanup EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM HUP
	if [[ ! -e "$provider_directory/baseline.json" ]]; then
		[[ ! -e "$provider_directory/plan.json" && ! -e "$provider_directory/admission.json" ]] || die 'Incomplete sealed activation must not be re-prepared.'
		pending="$(mktemp "$provider_directory/.pending.XXXXXX")"; cp -- "$provider_baseline" "$pending"
		provider_publish "$pending" baseline.json false
	fi
	cmp -s "$provider_baseline" "$provider_directory/baseline.json" || die 'Sealed provider baseline differs.'
	provider_capture inventory.json true provider_inventory || die 'Cannot read provider runtime inventory.'
	if [[ ! -e "$provider_directory/plan.json" ]]; then
		[[ ! -e "$provider_directory/admission.json" && ! -e "$provider_directory/binding.json" && ! -e "$provider_directory/switching.json" ]] || die 'Sealed activation cannot be re-prepared.'
		provider_capture fresh-baseline.json true provider_probe baseline
		cmp -s "$provider_directory/fresh-baseline.json" "$provider_directory/baseline.json" || die 'Runtime no longer equals approved provider baseline.'
		provider_capture initial.json true provider_inventory
		values="$(provider_probe image-env)" || die 'Cannot bind existing CRM images.'
		while IFS= read -r file; do [[ "$file" =~ ^CRM_[A-Z_]+=(sha256:[a-f0-9]{64}|[a-f0-9]{40})$ ]] || die 'Invalid immutable image override.'; image_env+=("$file"); done <<<"$values"
		target_id="$(docker ps --no-trunc --filter label=com.docker.compose.project=winwidget-crm --filter label=com.docker.compose.service=crm-customers-api --format '{{.ID}}')"
		[[ "$target_id" =~ ^[a-f0-9]{64}$ ]] || die 'Customers API is not unique.'
		target_image="$(docker inspect --format '{{.Image}}' "$target_id")"
		[[ "$target_image" =~ ^sha256:[a-f0-9]{64}$ ]] || die 'Invalid Customers image.'
		provider_capture images.json true docker image inspect "$target_image"
		provider_capture crm.json true env -i PATH="$PATH" "${image_env[@]}" docker compose --project-name winwidget-crm --profile '*' --env-file "$provider_crm_env" -f "$release_root/deploy/docker-compose.crm.yml" config --format json 2>/dev/null || die 'Cannot materialize private CRM configuration.'
		provider_capture plan.json false provider_probe prepare || die 'Provider configuration exceeds the single approved env delta.'
	fi
	if [[ ! -e "$provider_directory/binding.json" ]]; then provider_capture binding.json false provider_probe seal || die 'Cannot seal provider plan.'; fi
	provider_fence || die 'Provider state/input continuity failed.'
	if [[ ! -e "$provider_directory/runtime.json" ]]; then provider_capture runtime.json false provider_probe compose; fi
	pending="$(mktemp "$provider_directory/.pending.XXXXXX")"; provider_probe compose >"$pending" || die 'Cannot verify runtime configuration.'
	cmp -s "$pending" "$provider_directory/runtime.json" || die 'Runtime configuration changed.'
	rm -f -- "$pending"
	provider_runtime_hash="$(sha256sum "$provider_directory/runtime.json" | awk '{print $1}')"
	if [[ ! -e "$provider_directory/admission.json" ]]; then provider_capture admission.json false provider_probe admit; fi
	if ! sync -f "$provider_directory/admission.json" || ! sync -f "$provider_directory"; then die 'Provider admission durability failed.'; fi
	if [[ ! -e "$provider_directory/completed.json" ]]; then
		if [[ ! -e "$provider_directory/switching.json" ]]; then
			provider_capture switching.json false provider_probe begin || die 'Cannot persist single stop intent.'
			provider_fence || die 'Provider fence failed before stop.'
			target_id="$(provider_probe target-id)" || die 'Cannot resolve sealed original Customers ID.'
			[[ "$target_id" =~ ^[a-f0-9]{64}$ ]] || die 'Customers API is not unique before stop.'
			docker stop --time 90 "$target_id" >/dev/null 2>&1 || die 'Original stop outcome is unknown; inspect retained receipt.'
		fi
		provider_fence || die 'Provider fence failed after stop.'
		if [[ ! -e "$provider_directory/started.json" ]]; then
			provider_capture started.json false provider_probe start || die 'Cannot admit the single create attempt.'
			provider_inputs || die 'Provider inputs changed before create.'
			provider_compose || die 'Compose outcome is unknown; no automatic second create.'
		fi
		for ((attempt=0; attempt<60; attempt++)); do
			provider_fence || die 'Provider replacement identity/configuration changed.'
			if [[ ! -e "$provider_directory/observed.json" ]]; then
				provider_capture observed.json false provider_probe observe 2>/dev/null || { sleep 2; continue; }
			fi
			if provider_capture completed.json false provider_probe complete 2>/dev/null; then break; fi
			sleep 2
		done
		(( attempt < 60 )) || die 'Customers API not provably healthy; forward-only receipts retained.'
	fi
	provider_fence || die 'Final provider runtime continuity failed.'
	printf '%s\n' 'CRM Customers provider configuration verified: one healthy API replacement on its existing image; all neighbors and all other effective configuration preserved. No provider request was made.'
}
