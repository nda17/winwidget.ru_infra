#!/usr/bin/env bash
# Configuration-only activation. Sourced by the pinned controller under its
# existing global lock. Never build, migrate, grant, reset, or call a provider.
# shellcheck disable=SC2154
[[ "${BASH_SOURCE[0]}" != "$0" ]] || { printf '%s\n' 'Use the pinned reusable production workflow.' >&2; exit 1; }

commerce_files=(crm-commerce-activation-cli.mjs crm-commerce-activation.mjs crm-commerce-database.mjs crm-release.mjs scoped-service-release.mjs)

commerce_unpack() {
	# Only public, hash-verified code is writable here. Validate every entry before
	# writing any file; exact names exclude path traversal, links and duplicate keys.
	docker run --rm --interactive --network none --read-only --log-driver none --cap-drop ALL \
		--security-opt no-new-privileges --user 0:0 --memory 128m --memory-swap 128m --cpus 0.5 --pids-limit 32 --ulimit core=0:0 \
		--volume "$scoped_payload_directory:/run/payload:rw" --entrypoint node "$commerce_probe_image" --input-type=module <<'COMMERCE_UNPACK'
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,writeFileSync} from 'node:fs';
try {
 const bytes=readFileSync('/run/payload/verifier.mjs'); assert.ok(bytes.length>0&&bytes.length<=524288);
 const value=JSON.parse(bytes), names=['crm-commerce-activation-cli.mjs','crm-commerce-activation.mjs','crm-commerce-database.mjs','crm-release.mjs','scoped-service-release.mjs'];
 const exact=(item,keys)=>{assert.ok(item&&typeof item==='object'&&!Array.isArray(item));assert.deepEqual(Object.keys(item).sort(),keys.sort());};
 exact(value,['schemaVersion','files']);assert.equal(value.schemaVersion,1);assert.ok(Array.isArray(value.files));
 assert.deepEqual(value.files.map(item=>item.name).sort(),names.sort());
 const files=value.files.map(item=>{exact(item,['name','sha256','content']);assert.match(item.sha256,/^[a-f0-9]{64}$/);assert.equal(typeof item.content,'string');
 const data=Buffer.from(item.content,'utf8');assert.equal(data.toString('utf8'),item.content);assert.ok(data.length>0&&data.length<=147456);
 assert.equal(createHash('sha256').update(data).digest('hex'),item.sha256);return {...item,data};});
 for(const file of files) writeFileSync('/run/payload/'+file.name,file.data,{flag:'wx',mode:0o444});
} catch {process.stderr.write('CRM commerce payload rejected; private details suppressed\n');process.exitCode=1;}
COMMERCE_UNPACK
}

commerce_private() {
	local file="$1" size
	assert_root_owned_file "$file" || return 1
	[[ "$(stat -c '%a' "$file")" == 600 ]] || return 1
	size="$(stat -c '%s' "$file")" || return 1
	[[ "$size" =~ ^[0-9]+$ ]] && (( size > 0 && size <= 8388608 )) || return 1
}

commerce_inputs() {
	local file hash index
	assert_root_owned_file "$deploy_lock" || return 1
	[[ "$deploy_lock_fd" =~ ^[0-9]+$ && "$(stat -Lc '%d:%i' "/proc/$$/fd/$deploy_lock_fd")" == "$(stat -c '%d:%i' "$deploy_lock")" ]] || return 1
	flock -n "$deploy_lock_fd" || return 1
	[[ "$(git -C "$release_root" rev-parse HEAD)" == "$services_revision" && -z "$(git -C "$release_root" status --porcelain --untracked-files=all)" ]] || return 1
	for index in 0 1 2 3; do
		file="${commerce_inputs_files[$index]}"; commerce_private "$file" || return 1
		hash="$(sha256sum "$file" | awk '{print $1}')" || return 1
		[[ "$hash" == "${commerce_inputs_hashes[$index]}" ]] || return 1
	done
	[[ "$(sha256sum "$scoped_payload_directory/controller.sh" | awk '{print $1}')" == "$scoped_shell_sha256" &&
		"$(sha256sum "$scoped_payload_directory/verifier.mjs" | awk '{print $1}')" == "$scoped_node_sha256" ]] || return 1
	for index in "${!commerce_files[@]}"; do
		file="$scoped_payload_directory/${commerce_files[$index]}"
		assert_root_owned_file "$file" || return 1
		[[ "$(stat -c '%a' "$file")" == 444 && "$(sha256sum "$file" | awk '{print $1}')" == "${commerce_code_hashes[$index]}" ]] || return 1
	done
}

commerce_probe() {
	local mode="$1" argument="${2:-}" image="${3:-$commerce_probe_image}" file network=none user=0:0
	local -a mounts=() args=("$mode")
	[[ -z "$argument" ]] || args+=("$argument")
	for file in "${commerce_files[@]}"; do mounts+=(--volume "$scoped_payload_directory/$file:/run/commerce-code/$file:ro"); done
	if [[ "$mode" == database ]]; then
		network=host; user=1001:1001
	else
		mounts+=(--volume "$commerce_directory:/run/commerce:ro")
		if [[ "$mode" == database-input ]]; then
			case "$argument" in billing) file="$commerce_billing_env" ;; crm-access|crm-customers) file="$commerce_crm_env" ;; *) return 1 ;; esac
			mounts+=(--volume "$file:/run/owner.env:ro")
		elif [[ "$mode" == prepare ]]; then
			mounts+=(--volume "$release_root/.github/scripts/validate-crm-compose.mjs:/run/crm-compose-validator.mjs:ro"
				--volume "$env_file:/run/canonical.env:ro" --volume "$commerce_billing_env:/run/billing.env:ro")
		fi
	fi
	docker run --rm --interactive --network "$network" --read-only --log-driver none --cap-drop ALL \
		--security-opt no-new-privileges --user "$user" --memory 256m --memory-swap 256m --cpus 1 --pids-limit 64 --ulimit core=0:0 \
		--tmpfs /tmp:rw,noexec,nosuid,size=16m \
		--env "COMMERCE_CANONICAL_SHA256=$expected_env_sha256" --env "COMMERCE_CRM_SHA256=$expected_service_env_sha256" \
		--env "COMMERCE_BILLING_SHA256=$commerce_billing_hash" --env "COMMERCE_BASELINE_SHA256=$expected_crm_commerce_baseline_sha256" \
		--env "COMMERCE_SERVICES_REVISION=$services_revision" --env "COMMERCE_INFRA_REVISION=$infra_revision" \
		--env "COMMERCE_PAYLOAD_SHA256=$scoped_node_sha256" --env "COMMERCE_CONTROLLER_SHA256=$scoped_shell_sha256" \
		--env "COMMERCE_GATEWAY_REVISION=$expected_live_revision" \
		"${mounts[@]}" --entrypoint timeout "$image" -s TERM -k 5s 45s \
		node /run/commerce-code/crm-commerce-activation-cli.mjs "${args[@]}"
}

commerce_publish() {
	local pending="$1" name="$2" replace="${3:-false}" destination="$commerce_directory/$2"
	[[ "$pending" == "$commerce_directory"/.pending.* && "$name" =~ ^[a-z][a-z0-9-]*\.json$ ]] || return 1
	commerce_private "$pending" || return 1
	if [[ -e "$destination" || -L "$destination" ]]; then
		[[ "$replace" == true ]] || return 1
		commerce_private "$destination" || return 1
	fi
	sync -f "$pending" || return 1
	mv -T -- "$pending" "$destination" || return 1
	sync -f "$destination" && sync -f "$commerce_directory"
}

commerce_capture() {
	local name="$1" replace="$2" pending
	shift 2
	pending="$(mktemp "$commerce_directory/.pending.XXXXXX")" || return 1
	chmod 600 "$pending" || return 1
	"$@" >"$pending" || { rm -f -- "$pending"; return 1; }
	commerce_publish "$pending" "$name" "$replace"
}

commerce_inventory() {
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

commerce_fence() {
	commerce_inputs || return 1
	commerce_capture inventory.json true commerce_inventory || return 1
	commerce_probe progress >/dev/null
}

commerce_databases() {
	local owner image handoff pending
	export -n handoff
	commerce_inputs || return 1
	for owner in billing crm-access crm-customers; do
		image="$(commerce_probe owner-image "$owner")" || return 1
		[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
		handoff="$(commerce_probe database-input "$owner")" || return 1
		(( ${#handoff} > 0 && ${#handoff} <= 16384 )) || return 1
		pending="$(mktemp "$commerce_directory/.pending.XXXXXX")" || return 1
		printf '%s' "$handoff" | commerce_probe database "$owner" "$image" >"$pending" || return 1
		unset handoff
		commerce_publish "$pending" "$owner-database.json" true || return 1
	done
	commerce_capture database-current.json true commerce_probe database-merge
}

commerce_compose() {
	local project="$1" name="$2" file="$commerce_directory/$1-runtime.json" expected
	case "$project/$name" in
		winwidget-crm/crm-customers-api|winwidget-crm/crm-access-api|winwidget-crm/crm-access-worker|winwidget-crm/crm-access-outbox-publisher) expected="$commerce_crm_runtime_hash" ;;
		winwidget/billing-api|winwidget/billing-worker|winwidget/billing-scheduler) expected="$commerce_billing_runtime_hash" ;;
		*) return 1 ;;
	esac
	commerce_private "$file" || return 1
	[[ "$(sha256sum "$file" | awk '{print $1}')" == "$expected" ]] || return 1
	# No timeout/retry around this mutating call. Its durable start marker already
	# exists; failure or lost connection is unknown, never permission to recreate.
	env -i PATH="$PATH" docker compose --project-name "$project" --env-file /dev/null --profile '*' \
		-f "$file" up --detach --no-build --pull never --no-deps --force-recreate "$name" >/dev/null 2>&1
}

commerce_cleanup() {
	local status=$?
	trap - EXIT
	if (( status != 0 )); then
		if [[ -e "$commerce_directory/admission.json" || -L "$commerce_directory/admission.json" ]]; then
			printf '%s\n' 'CRM commerce activation interrupted after admission. Forward recovery only; preserved private plan and original start receipts. No rollback or automatic recreation.' >&2
		else printf '%s\n' 'CRM commerce activation stopped before admission; no runtime mutation was authorized.' >&2; fi
	fi
	cleanup_scoped_payload
	exit "$status"
}

scoped_deploy_main() {
	local gateway_id revision directory file hash pending selection index key old_id project name image values attempt
	local -a image_env=() images=()
	[[ "$release_scope" == crm-commerce-activate && "$expected_crm_commerce_baseline_sha256" =~ ^[a-f0-9]{64}$ ]] || die 'Invalid commerce scope approval.'
	[[ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}" && "$(docker context inspect --format '{{.Endpoints.docker.Host}}')" == unix:///var/run/docker.sock ]] || die 'Commerce activation requires the local production Docker daemon.'
	commerce_crm_env="$app_root/deploy/backend/crm/.env.production"
	commerce_billing_env="$services_repository/apps/billing/.env.production"
	commerce_baseline="$app_root/deploy/backend/crm/commerce-activation-baseline.json"
	for directory in "$app_root/deploy/backend/crm" "$services_repository/apps" "$services_repository/apps/billing"; do assert_root_owned_directory "$directory"; done
	for file in "$env_file" "$commerce_crm_env" "$commerce_billing_env" "$commerce_baseline"; do commerce_private "$file" || die 'Unsafe commerce input.'; done
	commerce_billing_hash="$(sha256sum "$commerce_billing_env" | awk '{print $1}')"
	commerce_inputs_files=("$env_file" "$commerce_billing_env" "$commerce_crm_env" "$commerce_baseline")
	commerce_inputs_hashes=("$expected_env_sha256" "$commerce_billing_hash" "$expected_service_env_sha256" "$expected_crm_commerce_baseline_sha256")
	gateway_id="$(docker ps --no-trunc --filter label=com.docker.compose.project=winwidget --filter label=com.docker.compose.service=api-gateway --format '{{.ID}}')"
	[[ "$gateway_id" =~ ^[a-f0-9]{64}$ ]] || die 'Existing Gateway is not uniquely running.'
	read -r commerce_probe_image revision < <(docker inspect --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$gateway_id")
	[[ "$commerce_probe_image" =~ ^sha256:[a-f0-9]{64}$ && "$revision" == "$expected_live_revision" ]] || die 'Gateway baseline differs from approval.'
	[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$commerce_probe_image")" == "$expected_live_revision" ]] || die 'Gateway image identity differs.'
	commerce_unpack || die 'Cannot unpack immutable commerce controller.'
	commerce_code_hashes=()
	for file in "${commerce_files[@]}"; do commerce_code_hashes+=("$(sha256sum "$scoped_payload_directory/$file" | awk '{print $1}')"); done
	commerce_inputs || die 'Commerce approval inputs changed.'
	directory="$app_root/deploy/backend/crm/commerce-activations"
	if [[ ! -e "$directory" && ! -L "$directory" ]]; then install -d -o root -g root -m 0700 "$directory"; fi
	assert_root_owned_directory "$directory"
	[[ "$(stat -c '%a' "$directory")" == 700 ]] || die 'Unsafe private commerce directory.'
	commerce_directory="$directory/$services_revision"
	if [[ ! -e "$commerce_directory" && ! -L "$commerce_directory" ]]; then install -d -o root -g root -m 0700 "$commerce_directory"; fi
	assert_root_owned_directory "$commerce_directory"
	[[ "$(stat -c '%a' "$commerce_directory")" == 700 ]] || die 'Unsafe private activation directory.'
	trap commerce_cleanup EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM HUP
	if [[ ! -e "$commerce_directory/baseline.json" ]]; then
		[[ ! -e "$commerce_directory/plan.json" && ! -e "$commerce_directory/admission.json" ]] || die 'Incomplete sealed activation must not be re-prepared.'
		pending="$(mktemp "$commerce_directory/.pending.XXXXXX")"; cp -- "$commerce_baseline" "$pending"
		commerce_publish "$pending" baseline.json
	fi
	cmp -s "$commerce_baseline" "$commerce_directory/baseline.json" || die 'Sealed baseline differs from approval.'
	commerce_capture inventory.json true commerce_inventory || die 'Cannot read commerce runtime inventory.'
	if [[ ! -e "$commerce_directory/plan.json" ]]; then
		[[ ! -e "$commerce_directory/admission.json" && ! -e "$commerce_directory/binding.json" && ! -e "$commerce_directory/state.json" ]] || die 'Sealed activation cannot be re-prepared.'
		commerce_capture fresh-baseline.json true commerce_probe baseline || die 'Cannot validate commerce baseline.'
		cmp -s "$commerce_directory/fresh-baseline.json" "$commerce_directory/baseline.json" || die 'Runtime no longer equals approved commerce baseline.'
		# Pre-plan only: the semantic baseline above, not volatile Health.Log,
		# decides whether the current inventory still belongs to this approval.
		commerce_capture initial.json true commerce_inventory
		values="$(commerce_probe image-env)" || die 'Cannot bind immutable images.'
		while IFS= read -r file; do [[ "$file" =~ ^[A-Z_]+=(sha256:[a-f0-9]{64}|[a-f0-9]{40})$ ]] || die 'Invalid immutable image override.'; image_env+=("$file"); done <<<"$values"
		values="$(commerce_probe target-images)" || die 'Cannot select immutable target images.'
		while IFS= read -r image; do [[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || die 'Invalid target image.'; images+=("$image"); done <<<"$values"
		commerce_capture images.json true docker image inspect "${images[@]}" || die 'Cannot inspect target images.'
		commerce_capture billing.json true env -i PATH="$PATH" "${image_env[@]}" docker compose --project-name winwidget --profile '*' --env-file "$env_file" --env-file "$commerce_billing_env" -f "$release_root/deploy/docker-compose.prod.yml" config --format json 2>/dev/null || die 'Cannot materialize Billing configuration.'
		commerce_capture crm.json true env -i PATH="$PATH" "${image_env[@]}" docker compose --project-name winwidget-crm --profile '*' --env-file "$commerce_crm_env" -f "$release_root/deploy/docker-compose.crm.yml" config --format json 2>/dev/null || die 'Cannot materialize CRM configuration.'
		commerce_capture plan.json false commerce_probe prepare || die 'Commerce configuration exceeds approved exact changes.'
	fi
	if [[ ! -e "$commerce_directory/binding.json" ]]; then commerce_capture binding.json false commerce_probe seal || die 'Cannot seal commerce plan.'; fi
	if [[ ! -e "$commerce_directory/state.json" ]]; then
		[[ ! -e "$commerce_directory/admission.json" ]] || die 'Admission has lost its state.'
		commerce_capture state.json false printf '%s\n' '{"admission":null,"completed":{},"switching":null}'
	fi
	commerce_fence || die 'Activation state/input continuity failed.'
	for project in winwidget winwidget-crm; do
		if [[ ! -e "$commerce_directory/$project-runtime.json" ]]; then commerce_capture "$project-runtime.json" false commerce_probe compose "$project" || die 'Cannot seal runtime configuration.'; fi
		pending="$(mktemp "$commerce_directory/.pending.XXXXXX")"; commerce_probe compose "$project" >"$pending" || die 'Cannot verify runtime configuration.'
		cmp -s "$pending" "$commerce_directory/$project-runtime.json" || die 'Runtime configuration changed.'
		rm -f -- "$pending"
	done
	commerce_billing_runtime_hash="$(sha256sum "$commerce_directory/winwidget-runtime.json" | awk '{print $1}')"
	commerce_crm_runtime_hash="$(sha256sum "$commerce_directory/winwidget-crm-runtime.json" | awk '{print $1}')"
	commerce_databases || die 'Read-only commerce database preflight failed.'
	if [[ ! -e "$commerce_directory/database-before.json" ]]; then
		[[ ! -e "$commerce_directory/admission.json" ]] || die 'Admitted activation lost original database proof.'
		pending="$(mktemp "$commerce_directory/.pending.XXXXXX")"; cp -- "$commerce_directory/database-current.json" "$pending"; commerce_publish "$pending" database-before.json
	fi
	if ! commerce_fence || ! commerce_probe database-check >/dev/null; then die 'Commerce database continuity or initial zero-demand gate failed.'; fi
	if [[ ! -e "$commerce_directory/admission.json" ]]; then
		commerce_capture admission.json false commerce_probe admit || die 'Cannot persist commerce admission.'
	fi
	# Also resync a pre-existing marker after an interrupted fsync. Until this
	# succeeds, no stop/create is permitted. Cleanup NEVER rolls anything back.
	if ! sync -f "$commerce_directory/admission.json" || ! sync -f "$commerce_directory"; then die 'Admission durability failed.'; fi
	while true; do
		commerce_fence || die 'Commerce forward-recovery fence failed.'
		selection="$(commerce_probe select)" || die 'Cannot resolve next commerce target.'
		[[ "$selection" != complete ]] || break
		read -r index key old_id <<<"$selection"
		[[ "$index" =~ ^[0-6]$ && "$old_id" =~ ^[a-f0-9]{64}$ ]] || die 'Invalid commerce target receipt.'
		project="${key%%/*}"; name="${key#*/}"
		if [[ ! -e "$commerce_directory/start-$index.json" ]]; then
			commerce_capture state.json true commerce_probe begin || die 'Cannot persist forward switching intent.'
			commerce_fence || die 'Commerce fence failed before stop.'
			docker stop --time 90 "$old_id" >/dev/null 2>&1 || die 'Original stop outcome is unknown; retry only after inspection.'
			commerce_fence || die 'Original process did not stop cleanly.'
			commerce_capture "start-$index.json" false commerce_probe start || die 'Cannot durably admit the single create attempt.'
			commerce_inputs || die 'Commerce inputs changed before create.'
			commerce_compose "$project" "$name" || die 'Compose outcome is unknown; no automatic second create attempt.'
		fi
		for ((attempt=0; attempt<60; attempt++)); do
			commerce_fence || die 'Commerce replacement identity/configuration changed.'
			if [[ ! -e "$commerce_directory/observed-$index.json" ]]; then
				# A missing/unstarted container is not proof of failure. Bound the
				# observation window, then retain start marker for explicit recovery.
				commerce_capture "observed-$index.json" false commerce_probe observe 2>/dev/null || { sleep 2; continue; }
			fi
			if commerce_capture state.json true commerce_probe complete 2>/dev/null; then break; fi
			sleep 2
		done
		(( attempt < 60 )) || die 'Replacement did not become provably healthy; forward-only start receipt retained.'
		printf '%s\n' "CRM commerce target verified: $key."
	done
	if ! commerce_databases || ! commerce_fence || ! commerce_probe database-check >/dev/null; then die 'Final commerce database/runtime continuity failed.'; fi
	printf '%s\n' 'CRM commerce activation verified: exactly seven config-only replacements; immutable images, database identity/ledger/ACL and all neighbors preserved. No provider call was made by this controller.'
}
