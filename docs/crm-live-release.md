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
