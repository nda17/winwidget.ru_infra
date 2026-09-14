# CRM live updates: production release

The `crm-live-updates` scope uses the existing immutable Services CI → pinned
Infra workflow → production lock path. It updates Intake, Sales, Customers and
Support APIs and the four Operations processes. Operations receives matching
backup/restore migration manifests and the Support restore routine allowlist;
its own schema and the deferred Notes migration remain unchanged.

Before release, collect a fresh `liveBaseline` from every running container and
the canonical, CRM, Support and Operations env hashes. Bind it to
`expected_crm_upgrade_baseline_sha256`; the digest contains the scope name, so
an earlier CRM upgrade digest cannot authorize this operation.
`expected_service_env_sha256` is the complete CRM env hash;
`expected_live_revision` is the current Operations revision. No env edit or
RabbitMQ topology operation belongs to this scope.

The controller verifies current configuration against retained CRM/Support
Compose snapshots and separately renders the Operations owner configuration.
Candidate images must preserve every prior owner migration and the Operations
application, except the exact Support restore ACL module and migration manifests.
All ordinary runtime environment, mounts, limits, security and health settings
must match the live processes. Images are built from the exact green Services SHA.

Operations must have no queued/running backup or restore work, restore execution
must be disabled and its execution lease must be empty. Gracefully stop all
Intake writers and Operations before DDL; never install the Intake notification
trigger while old writers can race its new table grants. Apply the four owner
migrations, reconcile exact CRM runtime/backup grants, verify their ledgers, then
start compatible Operations readers and domain APIs. Resume the preserved Intake
background container IDs. Final checks prove exact candidate images, health,
configuration, unchanged neighbors and unchanged env bytes.

Protected desired/rollback Compose files and per-owner ledger receipts remain in
`deploy/backend/.crm-live-release.*`. Before DDL, failure resumes preserved process
IDs. After all migrations and grants complete, domain APIs can roll back to prior
images while Operations retains its compatible new migration/ACL reader. A
partial migration or grant failure requires inspecting the private receipts and
completing the owner transition; do not replay failed migrations blindly, reverse
DDL, restore data, or start an outdated Operations migration reader.

After backend rollout, deploy the CRM frontend and verify the authorized browser:
a new lead appears in the list and bell without manual reload; read state updates
across tabs; support replies and existing task notifications remain accessible.
SSE carries scope-only invalidations, while normal authorized HTTP reads provide
the data. A reconnect takes a fresh snapshot. Task deadlines also refresh from a
server clock, because becoming due does not require a database write.

## Sales UX: code-only steady-state release

Use `crm-sales-runtime` for the Sales list filters and cohort analytics after the
live-change migration is already deployed. Do not replay `crm-live-updates` or
select the broader `crm-upgrade`: this scope replaces only `crm-sales-api` in the
existing `winwidget-crm` project. It performs no DDL, env edit, grants, broker
operation, worker restart or shared-image cleanup.

Collect the baseline on the VPS with `salesRuntimeBaseline(live, envHashes)` from
`scripts/crm-sales-runtime.mjs`. `live` is the full inspect of **all** Docker
containers, including stopped containers; `envHashes` has exactly `canonical`
and `crm`, the complete SHA-256 values of the respective production env files.
Never transfer or print the raw inspect/config: it contains runtime credentials.
Return only the scope-bound hash as `expected_crm_upgrade_baseline_sha256`.
`expected_live_revision` is the current Sales API OCI revision;
`expected_service_env_sha256` is the complete CRM env hash. The normal canonical
env hash and backend-only SSH secrets remain required. No frontend secret group
belongs in this scoped backend invocation.

Commit and verify Infra first, then pin its exact green revision in the Services
reusable-workflow call and lifecycle checks with `release_scope: crm-sales-runtime`
and the freshly collected baseline values. Deploy through the normal green
Services `prod` push. The controller still requires exact fetched `origin/prod`,
an immutable release checkout and the shared production deploy lock.

Preflight proves the live image, retained Compose configuration, full env bytes
and all container IDs/configuration/start times/restart counts. The candidate may
change only the Sales controller, DTO and service compiled modules; source paths
are restricted to those modules, their tests/readme and the two CI pin files.
Schemas, generated-schema tokens, migration names/checksums, package manifest and
installed package inventory must remain identical. Only the Sales image is built,
with 2.5 GiB available memory required before build and 2 GiB before replacement.

A read-only repeatable-read transaction verifies the service-owned database
identity and fully applied migration ledger. The same receipt must match after
replacement. The final runtime fence precedes a bounded graceful stop; no forced
kill is allowed. The single-service Compose snapshot uses the prior complete
environment and runtime settings, changing only image and revision. Direct
Sales live/ready/revision probes and exact neighbor checks complete postflight.

Protected evidence and desired/rollback snapshots remain under
`deploy/backend/.crm-sales-runtime.*`. A failed replacement restores the exact
prior image/config if immutable source, lock, env and all neighbors still match;
recovery also works when Compose removed the old API but could not create its
replacement. Before replacement, recovery resumes the exact preserved API ID.
Any failed health, ledger or neighbor verification keeps the release failed.
Inspect the retained private receipts if recovery cannot be proven; never rerun
blindly with a stale baseline. Finally, verify the authenticated CRM UX and its
role-scoped deal drilldowns after the frontend deployment.
