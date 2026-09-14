#!/usr/bin/env bash
# Sourced only after the immutable origin/prod, canonical env and shared-lock gates.
# shellcheck disable=SC2154
[[ "${BASH_SOURCE[0]}" != "$0" ]] || { printf '%s\n' 'Use the pinned reusable production workflow.' >&2; exit 1; }
sales_id() {
 local id
 id="$(docker ps --all --no-trunc --filter label=com.docker.compose.project=winwidget-crm --filter label=com.docker.compose.service=crm-sales-api --format '{{.ID}}')" || return 1
 [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
 printf '%s\n' "$id"
}
sales_snapshot() {
 local -a ids=()
 mapfile -t ids < <(docker ps --all --no-trunc --format '{{.ID}}')
 (( ${#ids[@]} >= 20 && ${#ids[@]} < 200 )) || return 1
 docker inspect "${ids[@]}" >"$sales_directory/$1" 2>/dev/null
}
sales_node() {
 local image="$1"; shift
 local -a identity=(--user 0:0)
 [[ "$1" != image ]] || identity=()
 docker run --rm --network none --read-only --log-driver none --cap-drop ALL --security-opt no-new-privileges \
  "${identity[@]}" --memory 256m --pids-limit 64 --ulimit core=0:0 --env SCOPED_SCOPE=crm-sales-runtime \
  --volume "$sales_directory:/run/sales-work:rw" \
  --volume "$scoped_payload_directory/crm-sales-runtime.mjs:/run/sales-code/crm-sales-runtime.mjs:ro" \
  --volume "$scoped_payload_directory/crm-live-release.mjs:/run/sales-code/crm-live-release.mjs:ro" \
  --volume "$scoped_payload_directory/scoped-service-release.mjs:/run/sales-code/scoped-service-release.mjs:ro" \
  --entrypoint node "$image" /run/sales-code/crm-sales-runtime.mjs "$@"
}
sales_probe() {
 local action="$1" revision="${2:-}"
 local -a credentials=()
 [[ "$action" != database ]] || credentials=(--env-file "${sales_env_files[1]}")
 docker run --rm --network host --read-only --log-driver none --cap-drop ALL --security-opt no-new-privileges \
  --memory 256m --pids-limit 64 --ulimit core=0:0 --tmpfs /tmp:rw,nosuid,size=64m "${credentials[@]}" --env SCOPED_SCOPE=crm-sales-runtime \
  --volume "$scoped_payload_directory/crm-sales-runtime.mjs:/run/sales-code/crm-sales-runtime.mjs:ro" \
  --volume "$scoped_payload_directory/crm-live-release.mjs:/run/sales-code/crm-live-release.mjs:ro" \
  --volume "$scoped_payload_directory/scoped-service-release.mjs:/run/sales-code/scoped-service-release.mjs:ro" \
  --entrypoint node "$sales_candidate_image" /run/sales-code/crm-sales-runtime.mjs "$action" "$revision"
}
sales_inputs() {
 local index file
 [[ "$(stat -Lc '%d:%i' "/proc/$$/fd/$deploy_lock_fd")" == "$(stat -c '%d:%i' "$deploy_lock")" ]] || return 1
 flock -n "$deploy_lock_fd" || return 1
 [[ "$(git -C "$release_root" rev-parse HEAD)" == "$services_revision" && -z "$(git -C "$release_root" status --porcelain --untracked-files=all)" ]] || return 1
 for index in "${!sales_env_files[@]}"; do
  file="${sales_env_files[$index]}"; assert_root_owned_file "$file" || return 1
  [[ "$(stat -c '%a:%h' "$file")" == 600:1 && "$(sha256sum "$file" | awk '{print $1}')" == "${sales_env_hashes[$index]}" ]] || return 1
 done
}
sales_compose() {
 local version="$1"; shift
 docker compose --project-name winwidget-crm -f "$sales_directory/$version.json" "$@" crm-sales-api
}
sales_wait() {
 local deadline=$((SECONDS+180)) state id
 while ((SECONDS<deadline)); do
  id="$(sales_id)" || return 1
  state="$(docker inspect --format '{{.State.Status}}:{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id")" || return 1
  [[ "$state" != running:healthy ]] || return 0
  [[ "$state" != exited:* && "$state" != dead:* ]] || return 1
  sleep 2
 done
 return 1
}
sales_graceful_stop() {
 local deadline=$((SECONDS+60)) state
 docker kill --signal TERM "$sales_previous_id" >/dev/null || return 1
 while ((SECONDS<deadline)); do
  state="$(docker inspect --format '{{.State.Running}}:{{.State.ExitCode}}:{{.State.Pid}}' "$sales_previous_id")" || return 1
  case "$state" in false:0:0|false:143:0) return 0 ;; true:*) ;; *) return 1 ;; esac
  sleep 1
 done
 return 1
}
sales_finish() {
 local status=$? recovered=false
 trap - EXIT
 if ((status!=0)); then
  if [[ "${sales_stop_started:-false}" == true ]] && sales_inputs && sales_snapshot live-current.json && sales_node "$sales_previous_image" neighbors; then
   if [[ "${sales_replacement_started:-false}" == true ]]; then
    if sales_compose rollback up --detach --no-deps --no-build --pull never >/dev/null 2>&1 && sales_wait && \
     sales_probe http "$expected_live_revision" && sales_probe database >"$sales_directory/ledger-recovery.json" && \
     cmp -s "$sales_directory/ledger-before.json" "$sales_directory/ledger-recovery.json" && sales_snapshot live-current.json && \
     sales_node "$sales_previous_image" postflight rollback && sales_inputs; then recovered=true; fi
   elif [[ "$(sales_id)" == "$sales_previous_id" ]]; then
    if [[ "$(docker inspect --format '{{.State.Running}}' "$sales_previous_id")" == false ]]; then docker start "$sales_previous_id" >/dev/null 2>&1 || true; fi
    if sales_wait && sales_probe http "$expected_live_revision" && sales_snapshot live-current.json && sales_node "$sales_previous_image" neighbors; then recovered=true; fi
   fi
  fi
  if [[ "$recovered" == true ]]; then printf '%s\n' 'CRM Sales runtime failed; the prior Sales API image/config is healthy, neighbors preserved.' >&2
  else printf '%s\n' 'CRM Sales runtime stopped; inspect retained private evidence before recovery. No other service is changed by this scope.' >&2; fi
 fi
 cleanup_scoped_payload
 exit "$status"
}
scoped_deploy_main() {
 local file
 umask 077
 [[ "$release_scope" == crm-sales-runtime && "$expected_crm_upgrade_baseline_sha256" =~ ^[a-f0-9]{64}$ ]] || die 'Invalid CRM Sales runtime scope.'
 [[ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}" && "$(docker context inspect --format '{{.Endpoints.docker.Host}}')" == unix:///var/run/docker.sock ]] || die 'CRM Sales requires the local production daemon.'
 sales_env_files=("$env_file" "$app_root/deploy/backend/crm/.env.production"); sales_env_hashes=()
 for file in "${sales_env_files[@]}"; do
  assert_root_owned_file "$file"; [[ "$(stat -c '%a:%h' "$file")" == 600:1 ]] || die 'Unsafe production env.'
  sales_env_hashes+=("$(sha256sum "$file" | awk '{print $1}')")
 done
 [[ "${sales_env_hashes[0]}" == "$expected_env_sha256" && "${sales_env_hashes[1]}" == "$expected_service_env_sha256" ]] || die 'CRM Sales env baseline mismatch.'
 sales_directory="$(mktemp -d "$app_root/deploy/backend/.crm-sales-runtime.XXXXXX")"; chmod 700 "$sales_directory"
 trap sales_finish EXIT
 sales_previous_id="$(sales_id)" || die 'CRM Sales API is absent or ambiguous.'
 sales_previous_image="$(docker inspect --format '{{.Image}}' "$sales_previous_id")"
 [[ "$sales_previous_image" =~ ^sha256:[a-f0-9]{64}$ ]] || die 'Invalid Sales image.'
 docker run --rm --interactive --network none --read-only --log-driver none --cap-drop ALL --security-opt no-new-privileges --user 0:0 \
  --volume "$scoped_payload_directory:/run/payload:rw" --entrypoint node "$sales_previous_image" --input-type=module <<'UNPACK'
import assert from 'node:assert/strict';import{readFileSync,writeFileSync,chmodSync}from'node:fs';import{createHash}from'node:crypto';
try{const bytes=readFileSync('/run/payload/verifier.mjs');assert.ok(bytes.length<=262144);const value=JSON.parse(bytes);
assert.deepEqual(Object.keys(value).sort(),['files','schemaVersion']);assert.equal(value.schemaVersion,1);
assert.deepEqual(value.files.map(row=>row.name).sort(),['crm-live-release.mjs','crm-sales-runtime.mjs','scoped-service-release.mjs']);
for(const row of value.files){assert.deepEqual(Object.keys(row).sort(),['content','name','sha256']);assert.ok(Buffer.byteLength(row.content)<=(row.name==='scoped-service-release.mjs'?147456:131072));assert.equal(createHash('sha256').update(row.content).digest('hex'),row.sha256);}
for(const row of value.files){const path='/run/payload/'+row.name;writeFileSync(path,row.content,{flag:'wx',mode:0o444});chmodSync(path,0o444);}
}catch{process.stderr.write('CRM Sales payload rejected.\n');process.exitCode=1}
UNPACK
 sales_snapshot live-before.json || die 'Cannot capture Sales runtime baseline.'
 git -C "$release_root" merge-base --is-ancestor "$expected_live_revision" "$services_revision" || die 'Sales candidate does not descend from the live revision.'
 git -C "$release_root" diff --name-only "$expected_live_revision" "$services_revision" -- >"$sales_directory/source-changes.txt"
 python3 - "$sales_directory" "$expected_crm_upgrade_baseline_sha256" "${sales_env_hashes[@]}" <<'BASELINE'
import json,pathlib,sys
try:
 root=pathlib.Path(sys.argv[1]);live=json.loads((root/'live-before.json').read_text())
 (root/'baseline-input.json').write_text(json.dumps(dict(live=live,expectedBaseline=sys.argv[2],envHashes=dict(zip(['canonical','crm'],sys.argv[3:])))))
 (root/'source-changes.json').write_text(json.dumps((root/'source-changes.txt').read_text().splitlines()))
except Exception:
 sys.stderr.write('Sales baseline input rejected; private details suppressed.\n');sys.exit(1)
BASELINE
 sales_node "$sales_previous_image" source || die 'Candidate contains changes outside the Sales runtime release.'
 sales_node "$sales_previous_image" baseline || die 'Approved Sales runtime baseline differs before build.'
 sales_inputs || die 'Immutable source, lock or production env changed before build.'
 docker image inspect "$sales_previous_image" >"$sales_directory/image-before.json"
 sales_node "$sales_previous_image" image >"$sales_directory/inventory-before.json" || die 'Cannot inventory current Sales image.'
 awk '/MemAvailable:/ {exit !($2 >= 2621440)}' /proc/meminfo || die 'Sales build requires 2.5 GiB available memory.'
 docker build --build-arg "APP_REVISION=$services_revision" --tag "winwidget-crm-sales:git-$services_revision" "$release_root/apps/crm-sales" >"$sales_directory/build.log" 2>&1 || die 'Immutable Sales image build failed; private build log retained.'
 sales_candidate_image="$(docker image inspect --format '{{.Id}}' "winwidget-crm-sales:git-$services_revision")"
 [[ "$sales_candidate_image" =~ ^sha256:[a-f0-9]{64}$ ]] || die 'Invalid candidate Sales image.'
 docker image inspect "$sales_candidate_image" >"$sales_directory/image-after.json"
 sales_node "$sales_candidate_image" image >"$sales_directory/inventory-after.json" || die 'Cannot inventory candidate Sales image.'
 python3 - "$sales_directory" "$services_revision" "$expected_live_revision" "$expected_crm_upgrade_baseline_sha256" "${sales_env_hashes[@]}" <<'PREPARE'
import json,pathlib,stat,sys
try:
 root=pathlib.Path(sys.argv[1]);read=lambda name:json.loads((root/name).read_text());live=read('live-before.json')
 rows=[row for row in live if row['Config']['Labels'].get('com.docker.compose.project')=='winwidget-crm' and row['Config']['Labels'].get('com.docker.compose.service')=='crm-sales-api'];assert len(rows)==1
 files=rows[0]['Config']['Labels']['com.docker.compose.project.config_files'].split(',');assert len(files)==1
 path=pathlib.Path(files[0]);assert str(path).startswith('/opt/winwidget/deploy/backend/') and path.resolve()==path
 info=path.lstat();assert stat.S_ISREG(info.st_mode) and info.st_uid==info.st_gid==0 and info.st_nlink==1 and stat.S_IMODE(info.st_mode)==0o600 and info.st_size<16*1024*1024
 value=dict(live=live,compose=json.loads(path.read_text()),revision=sys.argv[2],expectedLiveRevision=sys.argv[3],expectedBaseline=sys.argv[4],envHashes=dict(zip(['canonical','crm'],sys.argv[5:])),images={phase:read('image-'+phase+'.json')[0] for phase in ['before','after']})
 (root/'input.json').write_text(json.dumps(value))
except Exception:
 sys.stderr.write('Sales configuration snapshot rejected; private details suppressed.\n');sys.exit(1)
PREPARE
 sales_node "$sales_previous_image" prepare || die 'Sales source, compiled code, schema, configuration or approved baseline differs.'
 sales_probe database >"$sales_directory/ledger-before.json" || die 'Sales read-only migration ledger preflight failed.'
 sales_probe http "$expected_live_revision" || die 'Existing Sales health or revision differs.'
 sales_inputs || die 'Immutable source, lock or production env changed.'
 awk '/MemAvailable:/ {exit !($2 >= 2097152)}' /proc/meminfo || die 'Sales replacement requires 2 GiB available memory.'
 sales_snapshot live-current.json || die 'Cannot refresh Sales runtime fence.'
 sales_node "$sales_previous_image" fence || die 'Runtime baseline changed before the first stop.'
 sales_stop_started=true
 sales_graceful_stop || die 'Graceful Sales API stop is unproven; no forced replacement.'
 sales_inputs || die 'Source, lock or production env changed after the stop.'
 sales_replacement_started=true
 sales_compose desired up --detach --no-deps --no-build --pull never >"$sales_directory/replacement.log" 2>&1 || die 'Sales API replacement failed.'
 sales_wait || die 'Sales API did not become healthy.'
 sales_probe http "$services_revision" || die 'Sales health or revision postflight failed.'
 sales_probe database >"$sales_directory/ledger-after.json" || die 'Sales read-only migration ledger postflight failed.'
 cmp -s "$sales_directory/ledger-before.json" "$sales_directory/ledger-after.json" || die 'Sales database identity or migration ledger changed.'
 sales_snapshot live-current.json || die 'Cannot capture Sales postflight.'
 sales_node "$sales_previous_image" postflight desired || die 'Sales config or unchanged neighbor postflight failed.'
 sales_inputs || die 'Production inputs changed during Sales replacement.'
 printf 'CRM Sales runtime verified at %s; exactly one API replaced, schema/env and all neighbors preserved. Recovery snapshots: %s\n' "$services_revision" "$sales_directory"
}
