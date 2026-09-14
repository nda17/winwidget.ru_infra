#!/usr/bin/env bash
# Sourced by the immutable controller, after origin/prod, env and shared-lock gates.
# shellcheck disable=SC2154
[[ "${BASH_SOURCE[0]}" != "$0" ]] || { printf '%s\n' 'Use the pinned reusable production workflow.' >&2; exit 1; }
live_owners=(crm-intake crm-sales crm-customers support operations)
live_id() {
 local project=winwidget
 [[ "$1" != crm-* ]] || project=winwidget-crm
 local id
 id="$(docker ps --all --no-trunc --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$1" --format '{{.ID}}')" || return 1
 [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
 printf '%s\n' "$id"
}
live_env() {
 case "$1" in crm-*) printf '%s\n' "$app_root/deploy/backend/crm/.env.production" ;; support|operations) printf '%s\n' "$services_repository/apps/$1/.env.production" ;; *) return 1 ;; esac
}
live_node() {
 local image="$1"; shift
 local -a identity=(--user 0:0)
 # Application files may be private to the image's runtime UID. Inventory
 # needs that existing identity, while host-owned config checks use root.
 [[ "$1" != image ]] || identity=()
 docker run --rm --interactive --network none --read-only --log-driver none --cap-drop ALL --security-opt no-new-privileges \
  "${identity[@]}" --memory 256m --pids-limit 64 --ulimit core=0:0 \
  --volume "$live_directory:/run/live-work:rw" --volume "$scoped_payload_directory/crm-live-release.mjs:/run/live-code/crm-live-release.mjs:ro" \
  --volume "$scoped_payload_directory/scoped-service-release.mjs:/run/live-code/scoped-service-release.mjs:ro" \
  --entrypoint node "$image" /run/live-code/crm-live-release.mjs "$@"
}
live_database() {
 local owner="$1" action="$2" file
 file="$(live_env "$owner")"
 docker run --rm --network host --read-only --log-driver none --cap-drop ALL --security-opt no-new-privileges \
  --memory 512m --pids-limit 64 --ulimit core=0:0 --tmpfs /tmp:rw,nosuid,size=64m --env-file "$file" \
  --volume "$scoped_payload_directory/crm-live-release.mjs:/run/live-code/crm-live-release.mjs:ro" \
  --volume "$scoped_payload_directory/scoped-service-release.mjs:/run/live-code/scoped-service-release.mjs:ro" \
  --volume "$live_directory/database-access.mjs:/run/live-code/database-access.mjs:ro" \
  --entrypoint node "winwidget-$owner:git-$services_revision" /run/live-code/crm-live-release.mjs "$action" "$owner" "${3:-}"
}
live_snapshot() {
 local -a ids=()
 mapfile -t ids < <(docker ps --no-trunc --format '{{.ID}}')
 (( ${#ids[@]} >= 20 && ${#ids[@]} < 200 )) || return 1
 docker inspect "${ids[@]}" >"$live_directory/$1"
}
live_inputs() {
 local file index
 [[ "$(stat -Lc '%d:%i' "/proc/$$/fd/$deploy_lock_fd")" == "$(stat -c '%d:%i' "$deploy_lock")" ]] || return 1
 flock -n "$deploy_lock_fd" || return 1
 [[ "$(git -C "$release_root" rev-parse HEAD)" == "$services_revision" && -z "$(git -C "$release_root" status --porcelain --untracked-files=all)" ]] || return 1
 for index in "${!live_env_files[@]}"; do
  file="${live_env_files[$index]}"; assert_root_owned_file "$file" || return 1
  [[ "$(stat -c '%a:%h' "$file")" == 600:1 && "$(sha256sum "$file" | awk '{print $1}')" == "${live_env_hashes[$index]}" ]] || return 1
 done
}
live_compose() {
 local version="$1" name="$2" project=winwidget; shift 2
 [[ "$name" != crm-* ]] || project=winwidget-crm
 docker compose --project-name "$project" -f "$live_directory/$project-$version.json" "$@" "$name"
}
live_wait() {
 local name="$1" deadline=$((SECONDS+180)) state
 while ((SECONDS<deadline)); do
  state="$(docker inspect --format '{{.State.Status}}:{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$(live_id "$name")")" || return 1
  [[ "$state" != running:healthy ]] || return 0
  [[ "$state" != exited:* && "$state" != dead:* ]] || return 1
  sleep 2
 done
 return 1
}
live_graceful_stop() {
 local id deadline=$((SECONDS+60)) state all
 for id in "${live_paused_ids[@]}"; do docker kill --signal TERM "$id" >/dev/null || return 1; done
 while ((SECONDS<deadline)); do
  all=true
  for id in "${live_paused_ids[@]}"; do
   state="$(docker inspect --format '{{.State.Running}}:{{.State.ExitCode}}:{{.State.Pid}}' "$id")" || return 1
   case "$state" in false:0:0|false:143:0) ;; true:*) all=false ;; *) return 1 ;; esac
  done
  [[ "$all" != true ]] || return 0
  sleep 1
 done
 return 1
}
live_finish() {
 local status=$? id name ready=true
 trap - EXIT
 if ((status!=0)); then
  if [[ "${live_stop_started:-false}" == true && "${live_migration_started:-false}" == false ]] && live_inputs; then
   for id in "${live_paused_ids[@]}"; do
    if [[ "$(docker inspect --format '{{.State.Running}}' "$id")" == false ]]; then docker start "$id" >/dev/null 2>&1 || ready=false; fi
   done
   if [[ "$ready" == true ]]; then printf '%s\n' 'Pre-migration recovery resumed the exact preserved process IDs.' >&2; fi
  elif [[ "${live_migrations_complete:-false}" == true ]] && live_inputs; then
   # The Operations companion must retain the new manifest/ACL reader. Domain
   # APIs remain compatible with the additive schema and may use prior images.
   for name in crm-intake-api crm-sales-api crm-customers-api support-api; do
    if ! live_compose rollback "$name" up --detach --no-deps --no-build --pull never >/dev/null 2>&1 || ! live_wait "$name"; then ready=false; fi
   done
   for id in "${live_background_ids[@]}"; do docker start "$id" >/dev/null 2>&1 || ready=false; done
   if [[ "$ready" == true ]]; then printf '%s\n' 'Domain API rollback restored prior images/config and preserved Intake workers; compatible Operations readers retained.' >&2; fi
  fi
  printf '%s\n' 'CRM live release stopped. Protected desired/rollback and per-owner migration receipts retained; no down migration or outdated Operations restart.' >&2
 fi
 cleanup_scoped_payload
 exit "$status"
}
scoped_deploy_main() {
 local owner name id image revision prefix file index before_image
 local -a image_env=()
 [[ "$release_scope" == crm-live-updates && "$expected_crm_upgrade_baseline_sha256" =~ ^[a-f0-9]{64}$ ]] || die 'Invalid CRM live release scope.'
 [[ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}" && "$(docker context inspect --format '{{.Endpoints.docker.Host}}')" == unix:///var/run/docker.sock ]] || die 'CRM live release requires the local production daemon.'
 live_env_files=("$env_file" "$app_root/deploy/backend/crm/.env.production" "$services_repository/apps/support/.env.production" "$services_repository/apps/operations/.env.production")
 live_env_hashes=()
 for file in "${live_env_files[@]}"; do
  assert_root_owned_file "$file"; [[ "$(stat -c '%a:%h' "$file")" == 600:1 ]] || die 'Unsafe owner env.'
  live_env_hashes+=("$(sha256sum "$file" | awk '{print $1}')")
 done
 [[ "${live_env_hashes[0]}" == "$expected_env_sha256" && "${live_env_hashes[1]}" == "$expected_service_env_sha256" ]] || die 'CRM live env baseline mismatch.'
 live_directory="$(mktemp -d "$app_root/deploy/backend/.crm-live-release.XXXXXX")"; chmod 700 "$live_directory"
 trap live_finish EXIT
 # The immutable checkout is private to root; expose only this reviewed public
 # module to the existing unprivileged image UID, never the repository or env.
 install -m 0444 "$release_root/deploy/crm/database-access.mjs" "$live_directory/database-access.mjs"
 live_probe_image="$(docker inspect --format '{{.Image}}' "$(live_id api-gateway)")"
 docker run --rm --interactive --network none --read-only --log-driver none --cap-drop ALL --security-opt no-new-privileges --user 0:0 \
  --volume "$scoped_payload_directory:/run/payload:rw" --entrypoint node "$live_probe_image" --input-type=module <<'UNPACK'
import assert from 'node:assert/strict';import{readFileSync,writeFileSync}from'node:fs';import{createHash}from'node:crypto';
try{const bytes=readFileSync('/run/payload/verifier.mjs');assert.ok(bytes.length<=262144);const value=JSON.parse(bytes);
assert.deepEqual(Object.keys(value).sort(),['files','schemaVersion']);assert.equal(value.schemaVersion,1);
assert.deepEqual(value.files.map(row=>row.name).sort(),['crm-live-release.mjs','scoped-service-release.mjs']);
for(const row of value.files){assert.deepEqual(Object.keys(row).sort(),['content','name','sha256']);assert.ok(Buffer.byteLength(row.content)<=(row.name==='scoped-service-release.mjs'?147456:131072));assert.equal(createHash('sha256').update(row.content).digest('hex'),row.sha256);}
for(const row of value.files)writeFileSync('/run/payload/'+row.name,row.content,{flag:'wx',mode:0o444});
}catch{process.stderr.write('CRM live payload rejected.\n');process.exitCode=1}
UNPACK
 live_snapshot live-before.json || die 'Cannot capture live production baseline.'
 for owner in api-gateway notification-delivery campaigns reporting widgets billing identity platform support operations crm-access crm-intake crm-sales crm-customers; do
  name="$owner-api"
  case "$owner" in api-gateway) name=api-gateway ;; notification-delivery) name=notification-delivery-worker ;; campaigns|reporting|widgets) name="$owner-service" ;; esac
  id="$(live_id "$name")" || die 'Existing owner image is ambiguous.'
  read -r image revision < <(docker inspect --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$id")
  [[ "$image" =~ ^sha256:[a-f0-9]{64}$ && "$revision" =~ ^[a-f0-9]{40}$ ]] || die 'Invalid immutable owner image.'
  if [[ "$owner" == api-gateway ]]; then image_env+=("APP_VERSION=git-$revision" "APP_REVISION=$revision")
  else prefix="$(printf '%s' "$owner" | tr '[:lower:]-' '[:upper:]_')"; image_env+=("${prefix}_IMAGE=$image" "${prefix}_REVISION=$revision"); fi
 done
 # Only Operations has no retained Compose snapshot. Render its existing owner
 # env separately, then prove exact equality to the running process configuration.
 env "${image_env[@]}" docker compose --profile '*' --project-name winwidget --env-file "$env_file" \
  --env-file "${live_env_files[3]}" -f "$compose_file" config --format json >"$live_directory/operations-compose.json" 2>/dev/null || die 'Cannot render current Operations configuration.'
 for owner in "${live_owners[@]}"; do
  id="$(live_id "$owner-api")"; before_image="$(docker inspect --format '{{.Image}}' "$id")"
  docker image inspect "$before_image" >"$live_directory/$owner-image-before.json"
  live_node "$before_image" image "$owner" >"$live_directory/$owner-before.json" || die 'Cannot inventory current owner image.'
  docker build --build-arg "APP_REVISION=$services_revision" --tag "winwidget-$owner:git-$services_revision" "$release_root/apps/$owner" >/dev/null 2>&1 || die 'CRM live immutable image build failed.'
  docker image inspect "winwidget-$owner:git-$services_revision" >"$live_directory/$owner-image-after.json"
  live_node "winwidget-$owner:git-$services_revision" image "$owner" >"$live_directory/$owner-after.json" || die 'Cannot inventory candidate image.'
 done
 python3 - "$live_directory" "$services_revision" "$expected_live_revision" "$expected_crm_upgrade_baseline_sha256" "${live_env_hashes[@]}" <<'PREPARE'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]); owners=['crm-intake','crm-sales','crm-customers','support','operations']
read=lambda name:json.loads((root/name).read_text())
live=read('live-before.json');configs={}
for owner in owners:
 if owner=='operations':configs[owner]=read('operations-compose.json');continue
 row=next(row for row in live if row['Config']['Labels'].get('com.docker.compose.service')==owner+'-api')
 files=row['Config']['Labels']['com.docker.compose.project.config_files'].split(',');assert len(files)==1
 path=pathlib.Path(files[0]);assert str(path).startswith('/opt/winwidget/deploy/backend/') and path.is_file() and not path.is_symlink()
 configs[owner]=json.loads(path.read_text())
value=dict(live=live,configs=configs,revision=sys.argv[2],expectedLiveRevision=sys.argv[3],expectedBaseline=sys.argv[4],envHashes=dict(zip(['canonical','crm','support','operations'],sys.argv[5:])),images={owner:{phase:read(owner+'-image-'+phase+'.json')[0] for phase in ['before','after']} for owner in owners})
(root/'input.json').write_text(json.dumps(value));(root/'image-inventories.json').write_text(json.dumps({owner:{phase:read(owner+'-'+phase+'.json') for phase in ['before','after']} for owner in owners}))
PREPARE
 live_node "$live_probe_image" prepare || die 'CRM live configuration, source or approved baseline differs.'
 for owner in "${live_owners[@]}"; do live_database "$owner" database pre >"$live_directory/$owner-ledger-before.json" || die 'CRM live migration preflight failed.'; done
 live_database operations database quiet >/dev/null || die 'Operations backup/restore must be idle.'
 live_inputs || die 'Immutable source, production lock or env changed.'
 live_snapshot live-fence.json || die 'Cannot refresh runtime fence.'
 live_node "$live_probe_image" fence || die 'Runtime baseline changed before the first stop.'
 # Every Intake writer stops before its new invoker trigger is installed.
 live_paused_ids=()
 for name in crm-intake-api crm-intake-worker crm-intake-publisher crm-intake-widget-control-worker crm-intake-widget-control-publisher crm-intake-widget-transfer-worker crm-intake-widget-transfer-publisher crm-intake-sla-worker crm-intake-sla-publisher operations-api operations-worker operations-outbox-publisher operations-restore-worker; do
  live_paused_ids+=("$(live_id "$name")")
 done
 printf '%s\n' "${live_paused_ids[@]}" >"$live_directory/paused-ids"
 live_background_ids=("${live_paused_ids[@]:1:8}")
 live_stop_started=true
 live_graceful_stop || die 'Graceful writer stop is unproven; no forced replacement.'
 live_database operations database quiet >/dev/null || die 'Operations work appeared during drain.'
 live_migration_started=true
 for owner in crm-intake crm-sales crm-customers support; do
  live_database "$owner" migrate >"$live_directory/$owner-migration.json" || die 'Owner migration failed; inspect transactional ledger before recovery.'
  if [[ "$owner" == crm-* ]]; then
   prefix="${owner//-/_}"; id="$(live_id "$owner-postgres")"
   live_database "$owner" grants | docker exec --user postgres --interactive "$id" psql -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate -U "winwidget_${prefix}_admin" -d "winwidget_$prefix" >/dev/null 2>&1 || die 'Exact owner runtime grants failed.'
  fi
  live_database "$owner" database post >"$live_directory/$owner-ledger-after.json" || die 'Owner post-migration ledger failed.'
 done
 live_migrations_complete=true
 live_inputs || die 'Owner env changed during migration.'
 for name in operations-api operations-worker operations-outbox-publisher operations-restore-worker crm-intake-api crm-sales-api crm-customers-api support-api; do
  live_compose desired "$name" up --detach --no-deps --no-build --pull never >/dev/null 2>&1 || die 'Scoped CRM live process replacement failed.'
  live_wait "$name" || die 'Scoped CRM live process did not become healthy.'
 done
 # Resume the exact preserved background process IDs; their code is unchanged.
 for index in 1 2 3 4 5 6 7 8; do docker start "${live_paused_ids[$index]}" >/dev/null || die 'Cannot resume preserved Intake worker.'; done
 for name in crm-intake-worker crm-intake-publisher crm-intake-widget-control-worker crm-intake-widget-control-publisher crm-intake-widget-transfer-worker crm-intake-widget-transfer-publisher crm-intake-sla-worker crm-intake-sla-publisher; do live_wait "$name" || die 'Preserved Intake worker did not recover.'; done
 if ! live_snapshot live-after.json || ! live_node "$live_probe_image" postflight || ! live_inputs; then die 'CRM live postflight failed.'; fi
 printf 'CRM live release verified at %s; eight target processes updated, owner env and all neighbors preserved. Recovery snapshots: %s\n' "$services_revision" "$live_directory"
}
