# WinWidget infrastructure

`winwidget.ru_infra` owns the production deployment controller and operational
runbooks. Application source, Dockerfiles, Prisma schemas, and the production
Compose manifest remain in `winwidget.ru_services`; the frontend remains in
`winwidget.ru_client`.

Production secrets and `.env.production` files are never stored in this
repository, transferred through GitHub, or printed. The controller derives the
ten service-scoped files on the VPS from the hash-approved canonical source.

## Production deployment contract

The only entrypoint is the manually triggered
[`deploy-production.yml`](.github/workflows/deploy-production.yml) workflow.
The workflow revision itself is the immutable 40-hex infra revision. It also
accepts an immutable lowercase 40-hex commit from `winwidget.ru_services` and invokes
[`deploy-services-production.sh`](scripts/deploy-services-production.sh) over
SSH with a pinned host key.
The production job runs only when the workflow is dispatched from the canonical
`master` branch; tags and other branches are rejected before environment secrets
are exposed.

The controller has two modes:

- `--deploy` performs a routine forward deployment after Operations ownership
  is already `ACTIVE`.
- `--cutover` performs the one-time Operations snapshot import, activation,
  and control-plane bootstrap before starting service workers.

The services revision must equal the commit fetched from `origin/prod`; a SHA
from another branch or an older reachable commit is rejected. There are no
monolith, compatibility, rollback, or legacy runtime deployment targets. The
one-time `--cutover` path contains only exact terminal deletion targets.
A failed cutover before the terminal marker is resumed with `cutover`, the same
two snapshot hashes, and the same exact `origin/prod` revision. Once the durable
`.microservices-terminal-cutover-v1` marker exists, `cutover` must never be run
again: resume with `deploy` and the exact current `origin/prod` tip (which may be
a newer forward-only revision). The controller never guesses a previous state
and never starts an older image.

## GitHub production environment

Create a protected GitHub Environment named `production`. Require the desired
reviewers and restrict who can run the workflow. Configure these secrets:

| Secret | Purpose |
| --- | --- |
| `BACKEND_PRODUCTION_SSH_HOST` | Backend VPS host name or IPv4 address |
| `BACKEND_PRODUCTION_SSH_PORT` | SSH port |
| `BACKEND_PRODUCTION_SSH_USER` | Dedicated deployment user; the current controller requires root |
| `BACKEND_PRODUCTION_SSH_PRIVATE_KEY` | Unencrypted deployment key restricted to this VPS |
| `BACKEND_PRODUCTION_SSH_KNOWN_HOSTS` | Pre-verified pinned host-key line; never generate it with `ssh-keyscan` inside the workflow |
| `BACKEND_PRODUCTION_ENV_SHA256` | SHA-256 of the byte-identical canonical backend `.env.production` |

The deployment key must not be reused for GitHub repository access. The VPS
checkout uses its separately provisioned read-only deploy key.

When the production env changes, first follow the two-way synchronization rule:
compare local and VPS files, update the canonical local file, atomically install
the exact bytes on the VPS with `root:root` mode `0600`, compare them again, and
only then update `BACKEND_PRODUCTION_ENV_SHA256`. The workflow never transfers
or displays the env file. On the VPS, every deployment then atomically
materializes these ignored files, each with exactly the keys owned by its
tracked `.env.example`:

```text
/opt/winwidget/winwidget.ru_services/apps/<service>/.env.production
```

They are `root:root` mode `0600`. Compose receives the canonical source first
and all ten exact service files after it; containers still receive only their
explicit `environment` map. The controller hashes the complete derived file set
before runtime mutation and proves it is unchanged at the end. Missing and
placeholder values fail closed; an empty value is accepted only for the
explicitly optional `widgets:S3_KEY_PREFIX` setting.

## Nginx and Telegram relay

`nginx/backend-api.conf` is the apps-only public API configuration: Nginx
routes API traffic to Gateway `:4100` and widget assets to Widgets `:4700`.
It contains no Core `:4200` upstream. Every deployment compares its tracked
SHA-256 with `/etc/nginx/sites-available/api.winwidget.ru`, installs it
atomically when needed, validates `nginx -t`, reloads Nginx, and restores the
previous file if validation or reload fails.

`nginx/telegram-bridge/` owns the foreign VPS configuration for inbound
Telegram webhooks, outbound Bot API traffic and the intentionally public raw
TLS listener on `8443`. Installation and token-safe verification are described
in its local README.

## VPS prerequisites

The controller expects:

- Docker Engine with Docker Compose v2, Git, `flock`, `curl`, `sha256sum`, and
  GNU `stat`;
- a canonical checkout at `/opt/winwidget/winwidget.ru_services` whose `origin`
  is exactly `nda17/winwidget.ru_services`, with ignored writable
  `apps/<service>/.env.production` paths;
- the canonical env at `/opt/winwidget/deploy/backend/.env.production`, owned by
  `root:root` with mode `0600`;
- all external PostgreSQL volumes and password secret files referenced by the
  services Compose manifest;
- the production lock at
  `/opt/winwidget/deploy/backend/.production-deploy.lock` (the controller safely
  creates the regular file when absent).

`/opt/winwidget`, the canonical services checkout, its Git config/hooks, every
canonical app directory, and the release roots must be real root-owned paths
without group/world write permission. The canonical checkout must be clean.
The controller disables Git hooks while fetching and creating the immutable
worktree and rejects executable/include directives in repository config.

The repository checkout is only a Git object source. Each deployment creates or
reuses a clean detached worktree at
`/opt/winwidget/releases/winwidget.ru_services/<services-revision>` and runs the
Compose manifest from that immutable directory.

## Routine deployment

Run the `Deploy production services` workflow, choose `deploy`, and paste the
green services commit SHA. The controller then:

1. acquires the fixed production lock;
2. verifies the canonical env before doing work;
3. fetches `origin/prod` and requires its tip to be the requested commit;
4. rejects root-monolith runtime artifacts and any unexpected Compose service;
5. materializes the ten service-owned production env files from the approved
   canonical source without exposing values;
6. builds ten app-owned image families tagged `git-<revision>` and verifies each
   OCI revision label and immutable image ID;
7. validates the no-Core Gateway and Operations restore-worker hardening
   contracts without printing values;
8. starts the nine PostgreSQL services and RabbitMQ, provisions all exact
   service-owned RabbitMQ identities/permissions, and runs all nine migrations;
9. verifies Operations ownership is `ACTIVE`;
10. recreates non-Gateway services, starts the isolated Operations restore worker
   after the Operations Outbox publisher is healthy, and starts Gateway last;
11. checks container health, exact image IDs, local readiness, the public
    Gateway deployment revision, and the unchanged env hash.

The controller does not use `latest`, `--remove-orphans`, broad Docker pruning,
or reconstruction of the canonical production env from examples.

## First terminal cutover

Before running `cutover`, stage the two already reviewed exports on the VPS while
their source is still available:

```text
/opt/winwidget/deploy/backend/cutover-input/operations.snapshot.json
/opt/winwidget/deploy/backend/cutover-input/operations-control-plane.snapshot.json
```

Both files must be regular non-symlink files owned by `root:root` with mode
`0600`. Calculate their SHA-256 values independently and provide those hashes in
the two workflow inputs. Do not paste file contents into GitHub.

The `cutover` ordering is fixed:

1. validate the exact infra/services revisions, canonical env hash, generated
   service envs, apps-only Compose, images, databases, and RabbitMQ;
2. stop only the five exact Core writer/worker containers by Compose labels;
3. stop Reporting and delete only empty/unused immutable retry queues so the
   current Reporting owner can recreate their final DLX arguments;
4. provision all service RabbitMQ users, including the isolated
   `winwidget-operations-restore-worker`, and run all service migrations;
5. import the Notes/AdminEventLog snapshot (`EMPTY` to `IMPORTED`), activate
   Operations ownership, then bootstrap Telegram and Reporting control-plane data;
6. start service runtimes and Outbox publishers, the Operations restore worker,
   and Gateway in that order;
7. require all internal/public health and exact revision checks to pass;
8. require every allowlisted legacy queue to have zero messages, unacknowledged
   deliveries, and consumers, then delete it with empty/unused guards;
9. retire the three legacy RabbitMQ users, six exact Core Compose service
   families, the fingerprinted temporary Core PostgreSQL container/volume/secret,
   and only the allowlisted legacy restore-staging entries;
10. prove legacy queues/users/containers/volume and port `4200` are absent,
    repeat public readiness and verify env hashes;
11. atomically persist `.microservices-terminal-cutover-v1` with both approved
    snapshot hashes, their common Core source revision, the bootstrap event ID,
    and the Core system identifier; only then delete the imported snapshots.

Both imports are atomic and accept only the supplied SHA-256. Before the marker
is written, the protected snapshots remain available and the same `cutover`
request is the forward recovery path. After the marker is written, its state is
authoritative even if snapshot deletion or a later gate is interrupted: rerun
`deploy`, never `cutover`; the routine path verifies the marker and completes
the allowlisted snapshot cleanup idempotently. The shared restore root is
preserved because Operations owns it—only old Core staging subdirectories and
markers are deleted.

## Local static verification

These checks do not connect to production:

```bash
bash -n scripts/deploy-services-production.sh
shellcheck -x scripts/deploy-services-production.sh
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/deploy-production.yml")'
git diff --check
```
