#!/usr/bin/env bash
# Configuration-only activation. Sourced by the pinned controller under its
# existing global lock. Only the reviewed optional broker grant is provisioned;
# never build, migrate, reset credentials, publish events, or call a provider.
# shellcheck disable=SC2154
[[ "${BASH_SOURCE[0]}" != "$0" ]] || { printf '%s\n' 'Use the pinned reusable production workflow.' >&2; exit 1; }

reminders_files=(crm-reminders-activation-cli.mjs crm-reminders-activation.mjs crm-release.mjs scoped-service-release.mjs crm-broker-bootstrap.mjs crm-broker-topology.mjs crm-reminders-broker-topology.mjs)

reminders_unpack() {
	# Only public, hash-verified code is writable here. Validate every entry before
	# writing any file; exact names exclude path traversal, links and duplicate keys.
	docker run --rm --interactive --network none --read-only --log-driver none --cap-drop ALL \
		--security-opt no-new-privileges --user 0:0 --memory 128m --memory-swap 128m --cpus 0.5 --pids-limit 32 --ulimit core=0:0 \
		--volume "$scoped_payload_directory:/run/payload:rw" --entrypoint node "$reminders_probe_image" --input-type=module <<'REMINDERS_UNPACK'
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,writeFileSync} from 'node:fs';
try {
 const bytes=readFileSync('/run/payload/verifier.mjs'); assert.ok(bytes.length>0&&bytes.length<=524288);
 const value=JSON.parse(bytes), names=['crm-reminders-activation-cli.mjs','crm-reminders-activation.mjs','crm-release.mjs','scoped-service-release.mjs','crm-broker-bootstrap.mjs','crm-broker-topology.mjs','crm-reminders-broker-topology.mjs'];
 const exact=(item,keys)=>{assert.ok(item&&typeof item==='object'&&!Array.isArray(item));assert.deepEqual(Object.keys(item).sort(),keys.sort());};
 exact(value,['schemaVersion','files']);assert.equal(value.schemaVersion,1);assert.ok(Array.isArray(value.files));
 assert.deepEqual(value.files.map(item=>item.name).sort(),names.sort());
 const files=value.files.map(item=>{exact(item,['name','sha256','content']);assert.match(item.sha256,/^[a-f0-9]{64}$/);assert.equal(typeof item.content,'string');
 const data=Buffer.from(item.content,'utf8');assert.equal(data.toString('utf8'),item.content);assert.ok(data.length>0&&data.length<=147456);
 assert.equal(createHash('sha256').update(data).digest('hex'),item.sha256);return {...item,data};});
 for(const file of files) writeFileSync('/run/payload/'+file.name,file.data,{flag:'wx',mode:0o444});
} catch {process.stderr.write('CRM reminders payload rejected; private details suppressed\n');process.exitCode=1;}
REMINDERS_UNPACK
}

reminders_private() {
	local file="$1" size
	assert_root_owned_file "$file" || return 1
	[[ "$(stat -c '%a' "$file")" == 600 ]] || return 1
	size="$(stat -c '%s' "$file")" || return 1
	[[ "$size" =~ ^[0-9]+$ ]] && (( size > 0 && size <= 8388608 )) || return 1
}

reminders_inputs() {
	local file hash index
	assert_root_owned_file "$deploy_lock" || return 1
	[[ "$deploy_lock_fd" =~ ^[0-9]+$ && "$(stat -Lc '%d:%i' "/proc/$$/fd/$deploy_lock_fd")" == "$(stat -c '%d:%i' "$deploy_lock")" ]] || return 1
	flock -n "$deploy_lock_fd" || return 1
	[[ "$(git -C "$release_root" rev-parse HEAD)" == "$services_revision" && -z "$(git -C "$release_root" status --porcelain --untracked-files=all)" ]] || return 1
	for index in 0 1 2 3; do
		file="${reminders_inputs_files[$index]}"; reminders_private "$file" || return 1
		hash="$(sha256sum "$file" | awk '{print $1}')" || return 1
		[[ "$hash" == "${reminders_inputs_hashes[$index]}" ]] || return 1
	done
	[[ "$(sha256sum "$scoped_payload_directory/controller.sh" | awk '{print $1}')" == "$scoped_shell_sha256" &&
		"$(sha256sum "$scoped_payload_directory/verifier.mjs" | awk '{print $1}')" == "$scoped_node_sha256" ]] || return 1
	for index in "${!reminders_files[@]}"; do
		file="$scoped_payload_directory/${reminders_files[$index]}"
		assert_root_owned_file "$file" || return 1
		[[ "$(stat -c '%a' "$file")" == 444 && "$(sha256sum "$file" | awk '{print $1}')" == "${reminders_code_hashes[$index]}" ]] || return 1
	done
}

reminders_probe() {
	local mode="$1" argument="${2:-}" image="${3:-$reminders_probe_image}" file network=none user=0:0 script=crm-reminders-activation-cli.mjs
	local -a mounts=() args=("$mode")
	[[ -z "$argument" ]] || args+=("$argument")
	for file in "${reminders_files[@]}"; do mounts+=(--volume "$scoped_payload_directory/$file:/run/reminders-code/$file:ro"); done
	if [[ "$mode" == database ]]; then
		network=host; user=1001:1001; script=crm-release.mjs; args=(upgrade-database "$argument" complete)
	elif [[ "$mode" == readiness ]]; then
		network=host; user=1001:1001
	else
		mounts+=(--volume "$reminders_directory:/run/reminders:ro")
		if [[ "$mode" == database-input ]]; then
			case "$argument" in notification-delivery) file="$reminders_notification_env" ;; crm-sales) file="$reminders_crm_env" ;; *) return 1 ;; esac
			mounts+=(--volume "$file:/run/owner.env:ro")
		elif [[ "$mode" == prepare || "$mode" == notification-topology || "$mode" == readiness-input ]]; then
			mounts+=(--volume "$release_root/.github/scripts/validate-crm-reminders-compose.mjs:/run/crm-reminder-validator.mjs:ro"
				--volume "$env_file:/run/canonical.env:ro" --volume "$reminders_notification_env:/run/notification-delivery.env:ro" --volume "$reminders_crm_env:/run/crm.env:ro")
		fi
	fi
	docker run --rm --interactive --network "$network" --read-only --log-driver none --cap-drop ALL \
		--security-opt no-new-privileges --user "$user" --memory 256m --memory-swap 256m --cpus 1 --pids-limit 64 --ulimit core=0:0 \
		--tmpfs /tmp:rw,noexec,nosuid,size=16m \
		--env "REMINDERS_CANONICAL_SHA256=$expected_env_sha256" --env "REMINDERS_CRM_SHA256=$expected_service_env_sha256" \
		--env "REMINDERS_NOTIFICATION_DELIVERY_SHA256=$reminders_notification_hash" --env "REMINDERS_BASELINE_SHA256=$expected_crm_reminders_baseline_sha256" \
		--env "REMINDERS_SERVICES_REVISION=$services_revision" --env "REMINDERS_INFRA_REVISION=$infra_revision" \
		--env "REMINDERS_PAYLOAD_SHA256=$scoped_node_sha256" --env "REMINDERS_CONTROLLER_SHA256=$scoped_shell_sha256" \
		--env "REMINDERS_GATEWAY_REVISION=$expected_live_revision" \
		"${mounts[@]}" --entrypoint timeout "$image" -s TERM -k 5s 45s \
		node "/run/reminders-code/$script" "${args[@]}"
}

reminders_publish() {
	local pending="$1" name="$2" replace="${3:-false}" destination="$reminders_directory/$2"
	[[ "$pending" == "$reminders_directory"/.pending.* && "$name" =~ ^[a-z][a-z0-9-]*\.json$ ]] || return 1
	reminders_private "$pending" || return 1
	if [[ -e "$destination" || -L "$destination" ]]; then
		[[ "$replace" == true ]] || return 1
		reminders_private "$destination" || return 1
	fi
	sync -f "$pending" || return 1
	mv -T -- "$pending" "$destination" || return 1
	sync -f "$destination" && sync -f "$reminders_directory"
}

reminders_capture() {
	local name="$1" replace="$2" pending
	shift 2
	pending="$(mktemp "$reminders_directory/.pending.XXXXXX")" || return 1
	chmod 600 "$pending" || return 1
	"$@" >"$pending" || { rm -f -- "$pending"; return 1; }
	reminders_publish "$pending" "$name" "$replace"
}

reminders_inventory() {
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

reminders_fence() {
	reminders_inputs || return 1
	reminders_capture inventory.json true reminders_inventory || return 1
	reminders_probe progress >/dev/null
}

reminders_databases() {
	local owner image handoff pending
	export -n handoff
	reminders_inputs || return 1
	for owner in crm-sales notification-delivery; do
		image="$(reminders_probe owner-image "$owner")" || return 1
		[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
		reminders_probe source "$owner" "$image" >/dev/null || return 1
		handoff="$(reminders_probe database-input "$owner")" || return 1
		(( ${#handoff} > 0 && ${#handoff} <= 16384 )) || return 1
		pending="$(mktemp "$reminders_directory/.pending.XXXXXX")" || return 1
		printf '%s' "$handoff" | reminders_probe database "$owner" "$image" >"$pending" || return 1
		unset handoff
		reminders_publish "$pending" "$owner-database-current.json" true || return 1
	done
}

reminders_readiness() {
	local handoff
	export -n handoff
	reminders_inputs || return 1
	handoff="$(reminders_probe readiness-input)" || return 1
	(( ${#handoff} > 0 && ${#handoff} <= 16384 )) || return 1
	printf '%s' "$handoff" | reminders_probe readiness >/dev/null
}

reminders_broker() {
	local image revision topology_hash file line report='' status=0 broker_pid reader writer pipes
	local -a mounts=()
	reminders_fence || return 1
	reminders_capture notification-topology.json true reminders_probe notification-topology || return 1
	topology_hash="$(sha256sum "$reminders_directory/notification-topology.json" | awk '{print $1}')" || return 1
	image="$(reminders_probe owner-image crm-sales)" || return 1
	revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" || return 1
	[[ "$image" =~ ^sha256:[a-f0-9]{64}$ && "$revision" =~ ^[a-f0-9]{40}$ ]] || return 1
	for file in "${reminders_files[@]}"; do mounts+=(--volume "$scoped_payload_directory/$file:/run/reminders-code/$file:ro"); done
	# Existing stdio fence handshake: no credential or broker payload is an argv
	# value. Every child mutation waits for a fresh parent runtime/input fence.
	pipes="$(mktemp -d "$reminders_directory/.broker.XXXXXX")" || return 1
	chmod 700 "$pipes" || return 1
	mkfifo -m 600 "$pipes/input" "$pipes/output" || return 1
		docker run --rm --interactive --network host --read-only --log-driver none --cap-drop ALL \
			--security-opt no-new-privileges --user 0:0 --memory 256m --memory-swap 256m --cpus 1 --pids-limit 64 --ulimit core=0:0 \
			--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m "${mounts[@]}" \
			--volume "$env_file:/run/wincrm/canonical.env:ro" --volume "$reminders_crm_env:/run/wincrm/crm.env:ro" \
			--volume "$reminders_directory/notification-topology.json:/run/wincrm/notification-topology.json:ro" --volume "$deploy_lock:/run/wincrm/deploy.lock:ro" \
			--env CRM_BOOTSTRAP_CONTROLLER_PROTOCOL=stdio-v1 --env "CRM_BOOTSTRAP_IMAGE_REVISION=$revision" --env "APP_REVISION=$revision" \
			--env "CRM_BOOTSTRAP_CANONICAL_SHA256=$expected_env_sha256" --env "CRM_BOOTSTRAP_CRM_SHA256=$expected_service_env_sha256" \
			--env "CRM_BOOTSTRAP_NOTIFICATION_SHA256=$topology_hash" \
			--entrypoint timeout "$image" -s TERM -k 5s 180s node /run/reminders-code/crm-broker-bootstrap.mjs provision-reminders <"$pipes/input" >"$pipes/output" &
	broker_pid=$!
	exec {writer}>"$pipes/input"
	exec {reader}<"$pipes/output"
	while IFS= read -r line <&"$reader"; do
		if [[ "$line" == CRM_FENCE ]]; then
			if ! reminders_fence || ! printf '%s\n' CRM_FENCE_OK >&"$writer"; then status=1; break; fi
		else
			if [[ -n "$report" || ${#line} -gt 4096 || "$line" != \{*\} ]]; then status=1; break; fi
			report="$line"
		fi
	done
	exec {writer}>&-
	exec {reader}<&-
	wait "$broker_pid" || status=1
	rm -f -- "$pipes/input" "$pipes/output"
	rmdir -- "$pipes"
	(( status == 0 )) && [[ -n "$report" ]] || return 1
	reminders_fence || return 1
	printf '%s' "$report" | reminders_capture broker.json false reminders_probe broker-report
}

reminders_compose() {
	local project="$1" name="$2" file="$reminders_directory/$1-runtime.json" expected
	case "$project/$name" in
		winwidget-crm/crm-sales-api|winwidget-crm/crm-sales-reminders) expected="$reminders_crm_runtime_hash" ;;
		winwidget/notification-delivery-worker) expected="$reminders_notification_runtime_hash" ;;
		*) return 1 ;;
	esac
	reminders_private "$file" || return 1
	[[ "$(sha256sum "$file" | awk '{print $1}')" == "$expected" ]] || return 1
	# No timeout/retry around this mutating call. Its durable start marker already
	# exists; failure or lost connection is unknown, never permission to recreate.
	env -i PATH="$PATH" docker compose --project-name "$project" --env-file /dev/null --profile '*' \
		-f "$file" up --detach --no-build --pull never --no-deps --force-recreate "$name" >/dev/null 2>&1
}

reminders_cleanup() {
	local status=$?
	trap - EXIT
	if (( status != 0 )); then
		if [[ -e "$reminders_directory/admission.json" || -L "$reminders_directory/admission.json" ]]; then
			printf '%s\n' 'CRM reminders activation interrupted after admission. Forward recovery only; preserved private plan and original start receipts. No rollback or automatic recreation.' >&2
		else printf '%s\n' 'CRM reminders activation stopped before admission; no runtime mutation was authorized.' >&2; fi
	fi
	cleanup_scoped_payload
	exit "$status"
}

scoped_deploy_main() {
	local gateway_id revision directory file hash pending selection index key old_id project name image values attempt
	local -a image_env=() images=()
	[[ "$release_scope" == crm-reminders-activate && "$expected_crm_reminders_baseline_sha256" =~ ^[a-f0-9]{64}$ ]] || die 'Invalid reminders scope approval.'
	[[ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}" && "$(docker context inspect --format '{{.Endpoints.docker.Host}}')" == unix:///var/run/docker.sock ]] || die 'Reminders activation requires the local production Docker daemon.'
	reminders_crm_env="$app_root/deploy/backend/crm/.env.production"
	reminders_notification_env="$services_repository/apps/notification-delivery/.env.production"
	reminders_baseline="$app_root/deploy/backend/crm/reminders-activation-baseline.json"
	for directory in "$app_root/deploy/backend/crm" "$services_repository/apps" "$services_repository/apps/notification-delivery"; do assert_root_owned_directory "$directory"; done
	for file in "$env_file" "$reminders_crm_env" "$reminders_notification_env" "$reminders_baseline"; do reminders_private "$file" || die 'Unsafe reminders input.'; done
	reminders_notification_hash="$(sha256sum "$reminders_notification_env" | awk '{print $1}')"
	reminders_inputs_files=("$env_file" "$reminders_notification_env" "$reminders_crm_env" "$reminders_baseline")
	reminders_inputs_hashes=("$expected_env_sha256" "$reminders_notification_hash" "$expected_service_env_sha256" "$expected_crm_reminders_baseline_sha256")
	gateway_id="$(docker ps --no-trunc --filter label=com.docker.compose.project=winwidget --filter label=com.docker.compose.service=api-gateway --format '{{.ID}}')"
	[[ "$gateway_id" =~ ^[a-f0-9]{64}$ ]] || die 'Existing Gateway is not uniquely running.'
	read -r reminders_probe_image revision < <(docker inspect --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$gateway_id")
	[[ "$reminders_probe_image" =~ ^sha256:[a-f0-9]{64}$ && "$revision" == "$expected_live_revision" ]] || die 'Gateway baseline differs from approval.'
	[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$reminders_probe_image")" == "$expected_live_revision" ]] || die 'Gateway image identity differs.'
	reminders_unpack || die 'Cannot unpack immutable reminders controller.'
	reminders_code_hashes=()
	for file in "${reminders_files[@]}"; do reminders_code_hashes+=("$(sha256sum "$scoped_payload_directory/$file" | awk '{print $1}')"); done
	reminders_inputs || die 'Reminders approval inputs changed.'
	directory="$app_root/deploy/backend/crm/reminders-activations"
	if [[ ! -e "$directory" && ! -L "$directory" ]]; then install -d -o root -g root -m 0700 "$directory"; fi
	assert_root_owned_directory "$directory"
	[[ "$(stat -c '%a' "$directory")" == 700 ]] || die 'Unsafe private reminders directory.'
	reminders_directory="$directory/$services_revision"
	if [[ ! -e "$reminders_directory" && ! -L "$reminders_directory" ]]; then install -d -o root -g root -m 0700 "$reminders_directory"; fi
	assert_root_owned_directory "$reminders_directory"
	[[ "$(stat -c '%a' "$reminders_directory")" == 700 ]] || die 'Unsafe private activation directory.'
	trap reminders_cleanup EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM HUP
	if [[ ! -e "$reminders_directory/baseline.json" ]]; then
		[[ ! -e "$reminders_directory/plan.json" && ! -e "$reminders_directory/admission.json" ]] || die 'Incomplete sealed activation must not be re-prepared.'
		pending="$(mktemp "$reminders_directory/.pending.XXXXXX")"; cp -- "$reminders_baseline" "$pending"
		reminders_publish "$pending" baseline.json
	fi
	cmp -s "$reminders_baseline" "$reminders_directory/baseline.json" || die 'Sealed baseline differs from approval.'
	reminders_capture inventory.json true reminders_inventory || die 'Cannot read reminders runtime inventory.'
	if [[ ! -e "$reminders_directory/plan.json" ]]; then
		[[ ! -e "$reminders_directory/admission.json" && ! -e "$reminders_directory/binding.json" && ! -e "$reminders_directory/state.json" ]] || die 'Sealed activation cannot be re-prepared.'
		reminders_capture fresh-baseline.json true reminders_probe baseline || die 'Cannot validate reminders baseline.'
		cmp -s "$reminders_directory/fresh-baseline.json" "$reminders_directory/baseline.json" || die 'Runtime no longer equals approved reminders baseline.'
		# Pre-plan only: the semantic baseline above, not volatile Health.Log,
		# decides whether the current inventory still belongs to this approval.
		reminders_capture initial.json true reminders_inventory
		values="$(reminders_probe image-env)" || die 'Cannot bind immutable images.'
		while IFS= read -r file; do [[ "$file" =~ ^[A-Z_]+=(sha256:[a-f0-9]{64}|[a-f0-9]{40})$ ]] || die 'Invalid immutable image override.'; image_env+=("$file"); done <<<"$values"
		values="$(reminders_probe target-images)" || die 'Cannot select immutable target images.'
		while IFS= read -r image; do [[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || die 'Invalid target image.'; images+=("$image"); done <<<"$values"
		reminders_capture images.json true docker image inspect "${images[@]}" || die 'Cannot inspect target images.'
		reminders_capture notification-before.json true env -i PATH="$PATH" "${image_env[@]}" docker compose --project-name winwidget --profile '*' --env-file "$env_file" --env-file "$reminders_notification_env" -f "$release_root/deploy/docker-compose.prod.yml" config --format json 2>/dev/null || die 'Cannot materialize Notification configuration.'
		reminders_capture notification-after.json true env -i PATH="$PATH" "${image_env[@]}" docker compose --project-name winwidget --profile '*' --env-file "$env_file" --env-file "$reminders_notification_env" -f "$release_root/deploy/docker-compose.prod.yml" -f "$release_root/deploy/docker-compose.notification-reminders.yml" config --format json 2>/dev/null || die 'Cannot materialize Notification reminder overlay.'
		reminders_capture crm-before.json true env -i PATH="$PATH" "${image_env[@]}" docker compose --project-name winwidget-crm --profile '*' --env-file "$reminders_crm_env" -f "$release_root/deploy/docker-compose.crm.yml" config --format json 2>/dev/null || die 'Cannot materialize CRM configuration.'
		reminders_capture crm-after.json true env -i PATH="$PATH" "${image_env[@]}" docker compose --project-name winwidget-crm --profile '*' --env-file "$reminders_crm_env" -f "$release_root/deploy/docker-compose.crm.yml" -f "$release_root/deploy/docker-compose.crm-reminders.yml" config --format json 2>/dev/null || die 'Cannot materialize CRM reminder overlay.'
		reminders_capture plan.json false reminders_probe prepare || die 'Reminders configuration exceeds approved exact changes.'
	fi
	if [[ ! -e "$reminders_directory/binding.json" ]]; then reminders_capture binding.json false reminders_probe seal || die 'Cannot seal reminders plan.'; fi
	if [[ ! -e "$reminders_directory/state.json" ]]; then
		[[ ! -e "$reminders_directory/admission.json" ]] || die 'Admission has lost its state.'
		reminders_capture state.json false printf '%s\n' '{"admission":null,"completed":{},"switching":null}'
	fi
	reminders_fence || die 'Activation state/input continuity failed.'
	for project in winwidget winwidget-crm; do
		if [[ ! -e "$reminders_directory/$project-runtime.json" ]]; then reminders_capture "$project-runtime.json" false reminders_probe compose "$project" || die 'Cannot seal runtime configuration.'; fi
		pending="$(mktemp "$reminders_directory/.pending.XXXXXX")"; reminders_probe compose "$project" >"$pending" || die 'Cannot verify runtime configuration.'
		cmp -s "$pending" "$reminders_directory/$project-runtime.json" || die 'Runtime configuration changed.'
		rm -f -- "$pending"
	done
	reminders_notification_runtime_hash="$(sha256sum "$reminders_directory/winwidget-runtime.json" | awk '{print $1}')"
	reminders_crm_runtime_hash="$(sha256sum "$reminders_directory/winwidget-crm-runtime.json" | awk '{print $1}')"
	reminders_databases || die 'Read-only reminders database preflight failed.'
	for name in crm-sales notification-delivery; do
		if [[ ! -e "$reminders_directory/$name-database-before.json" ]]; then
			[[ ! -e "$reminders_directory/admission.json" ]] || die 'Admitted activation lost original database proof.'
			pending="$(mktemp "$reminders_directory/.pending.XXXXXX")"; cp -- "$reminders_directory/$name-database-current.json" "$pending"; reminders_publish "$pending" "$name-database-before.json"
		fi
	done
	if ! reminders_fence || ! reminders_probe database-check >/dev/null; then die 'Reminder database continuity or complete migration gate failed.'; fi
	if [[ ! -e "$reminders_directory/admission.json" ]]; then
		reminders_capture admission.json false reminders_probe admit || die 'Cannot persist reminders admission.'
	fi
	# Also resync a pre-existing marker after an interrupted fsync. Until this
	# succeeds, no stop/create is permitted. Cleanup NEVER rolls anything back.
	if ! sync -f "$reminders_directory/admission.json" || ! sync -f "$reminders_directory"; then die 'Admission durability failed.'; fi
	if [[ ! -e "$reminders_directory/broker.json" ]]; then reminders_broker || die 'Reminder broker provisioning interrupted; exact forward retry only.'; fi
	reminders_probe broker-check >/dev/null || die 'Missing or mismatched durable broker receipt.'
	while true; do
		reminders_fence || die 'Reminders forward-recovery fence failed.'
		selection="$(reminders_probe select)" || die 'Cannot resolve next reminders target.'
		[[ "$selection" != complete ]] || break
		read -r index key old_id <<<"$selection"
		[[ "$index" =~ ^[0-2]$ && ( "$old_id" =~ ^[a-f0-9]{64}$ || ( "$index" == 1 && "$old_id" == absent ) ) ]] || die 'Invalid reminders target receipt.'
		project="${key%%/*}"; name="${key#*/}"
		if [[ ! -e "$reminders_directory/start-$index.json" ]]; then
			reminders_capture state.json true reminders_probe begin || die 'Cannot persist forward switching intent.'
			reminders_fence || die 'Reminders fence failed before stop.'
			if [[ "$old_id" != absent ]]; then docker stop --time 90 "$old_id" >/dev/null 2>&1 || die 'Original stop outcome is unknown; retry only after inspection.'; fi
			reminders_fence || die 'Original process did not stop cleanly.'
			reminders_capture "start-$index.json" false reminders_probe start || die 'Cannot durably admit the single create attempt.'
			reminders_inputs || die 'Reminders inputs changed before create.'
			reminders_compose "$project" "$name" || die 'Compose outcome is unknown; no automatic second create attempt.'
		fi
		for ((attempt=0; attempt<60; attempt++)); do
			reminders_fence || die 'Reminders replacement identity/configuration changed.'
			if [[ ! -e "$reminders_directory/observed-$index.json" ]]; then
				# A missing/unstarted container is not proof of failure. Bound the
				# observation window, then retain start marker for explicit recovery.
				reminders_capture "observed-$index.json" false reminders_probe observe 2>/dev/null || { sleep 2; continue; }
			fi
			if [[ "$index" == 0 ]] && ! reminders_readiness; then sleep 2; continue; fi
			if reminders_capture state.json true reminders_probe complete 2>/dev/null; then break; fi
			sleep 2
		done
		(( attempt < 60 )) || die 'Replacement did not become provably healthy; forward-only start receipt retained.'
		printf '%s\n' "CRM reminders target verified: $key."
	done
	if ! reminders_databases || ! reminders_fence || ! reminders_probe database-check >/dev/null; then die 'Final reminders database/runtime continuity failed.'; fi
	reminders_readiness || die 'Final reminder delivery readiness is not confirmed.'
	printf '%s\n' 'CRM reminders activation verified: exactly two config-only replacements and one new Sales reminder process; immutable images, database identity/ledger/ACL and all neighbors preserved. No provider call was made by this controller.'
}
