#!/usr/bin/env bash
# Sourced only by the pinned controller under the shared production lock.
# Executes one immutable Billing-owned ACL migration, without runtime/env writes.
# shellcheck disable=SC2154
[[ "${BASH_SOURCE[0]}" != "$0" ]] || { printf '%s\n' 'Use the pinned production workflow.' >&2; exit 1; }

billing_acl_probe() {
	local mode="$1"
	docker run --rm --interactive --network "$([[ "$mode" == inventory ]] && printf none || printf host)" \
		--read-only --log-driver none --cap-drop ALL --security-opt no-new-privileges \
		--user 1001:1001 --memory 256m --memory-swap 256m --cpus 1 --pids-limit 64 \
		--tmpfs /tmp:rw,noexec,nosuid,size=16m \
		--env "BILLING_LIVE_REVISION=$expected_live_revision" \
		--volume "$scoped_payload_directory/verifier.mjs:/run/billing-acl.mjs:ro" \
		--volume "$billing_acl_work/owner.env:/run/billing.env:ro" \
		--volume "$billing_acl_work/prisma:/run/candidate/prisma:ro" \
		--entrypoint node "$billing_acl_image" /run/billing-acl.mjs "$mode"
}

billing_acl_inventory() {
	local ids
	ids="$(docker ps --no-trunc --format '{{.ID}}')"
	[[ -n "$ids" ]] || return 1
	# IDs are validated by the verifier; no secret-bearing inspect is logged.
	# shellcheck disable=SC2086
	docker inspect $ids | billing_acl_probe inventory
}

billing_acl_env_inventory() {
	local file
	while IFS= read -r file; do
		assert_root_owned_file "$file"
		sha256sum "$file"
	done < <(find "$services_repository/apps" -mindepth 2 -maxdepth 2 -type f -name .env.production | LC_ALL=C sort)
	for file in "$env_file" "$app_root/deploy/backend/crm/.env.production"; do
		assert_root_owned_file "$file"
		sha256sum "$file"
	done
}

billing_acl_fence() {
	[[ "$(billing_acl_env_inventory)" == "$billing_acl_envs" ]] || die 'A production env changed during Billing ACL release.'
	[[ "$(billing_acl_inventory)" == "$billing_acl_runtime" ]] || die 'A production container changed during Billing ACL release.'
	[[ "$(git -C "$release_root" rev-parse HEAD)" == "$services_revision" && -z "$(git -C "$release_root" status --porcelain --untracked-files=all)" ]] || die 'Billing migration source changed.'
	[[ "$(sha256sum "$scoped_payload_directory/verifier.mjs" | awk '{print $1}')" == "$scoped_node_sha256" ]] || die 'Billing verifier changed.'
	[[ "$(sha256sum "$billing_acl_work/owner.env" | awk '{print $1}')" == "$expected_service_env_sha256" ]] || die 'Billing private migration input changed.'
	[[ "$(stat -Lc '%d:%i' "/proc/$$/fd/$deploy_lock_fd")" == "$(stat -c '%d:%i' "$deploy_lock")" ]] || die 'Billing deploy lock identity changed.'
	flock -n "$deploy_lock_fd" || die 'Billing ACL release lost its shared lock.'
}

billing_acl_cleanup() {
	local result=$?
	trap - EXIT
	# Exact file only: no database dumps, copied project trees or runtime volumes.
	rm -f -- "$billing_acl_work/owner.env"
	if [[ -d "$billing_acl_work/prisma" && ! -L "$billing_acl_work/prisma" ]]; then
		# Only the bounded, public Prisma handoff created below. No release source
		# permissions are relaxed and no credentials are stored inside this tree.
		find "$billing_acl_work/prisma" -xdev -depth -delete
	fi
	rmdir -- "$billing_acl_work"
	cleanup_scoped_payload
	exit "$result"
}

scoped_deploy_main() {
	local owner_env id revision title changed file before after relative target source_count=0
	[[ "$release_scope" == billing-crm-commerce-acl ]] || die 'Unsupported Billing ACL scope.'
	[[ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}" && "$(docker context inspect --format '{{.Endpoints.docker.Host}}')" == unix:///var/run/docker.sock ]] || die 'Billing ACL release requires the production local daemon.'
	owner_env="$services_repository/apps/billing/.env.production"
	assert_root_owned_file "$owner_env"
	[[ "$(stat -c '%a' "$owner_env")" == 600 && "$(sha256sum "$owner_env" | awk '{print $1}')" == "$expected_service_env_sha256" ]] || die 'Billing owner env differs from approved bytes.'
	id="$(docker ps --no-trunc --filter label=com.docker.compose.project=winwidget --filter label=com.docker.compose.service=billing-api --format '{{.ID}}')"
	[[ "$id" =~ ^[a-f0-9]{64}$ ]] || die 'Billing API must be uniquely healthy.'
	read -r billing_acl_image revision < <(docker inspect --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$id")
	[[ "$billing_acl_image" =~ ^sha256:[a-f0-9]{64}$ && "$revision" == "$expected_live_revision" ]] || die 'Billing runtime differs from the approved revision.'
	read -r revision title < <(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.opencontainers.image.title"}}' "$billing_acl_image")
	[[ "$revision" == "$expected_live_revision" && "$title" == winwidget-billing ]] || die 'Billing immutable migration executor has drifted.'
	changed="$(git -C "$release_root" diff --name-only "$expected_live_revision" "$services_revision" -- apps/billing)"
	while IFS= read -r file; do
		case "$file" in
			apps/billing/README.md | apps/billing/test/integration/wincrm-commerce-postgres18.integration.mjs | apps/billing/prisma/migrations/20260909110000_restrict_wincrm_commerce_runtime_acl/migration.sql) ;;
			*) die 'Billing ACL release cannot change runtime code, packages, schema or other migrations.' ;;
		esac
	done <<<"$changed"
	billing_acl_work="$(mktemp -d "$app_root/deploy/backend/.billing-crm-acl.XXXXXX")"
	chmod 700 "$billing_acl_work"
	trap billing_acl_cleanup EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM HUP
	# Temporary credential handoff only, removed on both success and failure.
	install -o 1001 -g 1001 -m 400 "$owner_env" "$billing_acl_work/owner.env"
	# Git worktrees created under the controller's umask 077 are root-only.
	# Hand off only the exact public Prisma inputs to the non-root executor;
	# source-pair/hash validation still runs before every database operation.
	install -d -o 1001 -g 1001 -m 500 "$billing_acl_work/prisma" "$billing_acl_work/prisma/migrations"
	while IFS= read -r file; do
		relative="${file#apps/billing/prisma/}"
		[[ "$relative" =~ ^(schema\.prisma|migration_lock\.toml|migrations/[0-9]{14}_[a-z0-9_]+/migration\.sql)$ ]] || die 'Unexpected Billing Prisma handoff path.'
		[[ -f "$release_root/$file" && ! -L "$release_root/$file" ]] || die 'Unsafe Billing Prisma source.'
		target="$billing_acl_work/prisma/$relative"
		install -d -o 1001 -g 1001 -m 500 "$(dirname "$target")"
		install -o 1001 -g 1001 -m 400 "$release_root/$file" "$target"
		cmp -s "$release_root/$file" "$target" || die 'Billing public source handoff changed bytes.'
		source_count=$((source_count + 1))
	done < <(git -C "$release_root" ls-files apps/billing/prisma)
	[[ "$source_count" == 13 ]] || die 'Unexpected Billing Prisma source count.'
	billing_acl_envs="$(billing_acl_env_inventory)"
	billing_acl_runtime="$(billing_acl_inventory)"
	[[ "$billing_acl_runtime" =~ ^[a-f0-9]{64}$ ]] || die 'Cannot seal the live runtime fingerprint.'
	billing_acl_fence
	before="$(billing_acl_probe before)" || die 'Billing ACL preflight failed; no migration was started.'
	printf '%s\n' 'Billing-owned ACL preflight passed; all live containers will remain unchanged.'
	billing_acl_fence
	billing_acl_probe migrate || die 'Billing ACL migration did not complete; inspect the ledger before retry. Runtime was not replaced.'
	after="$(billing_acl_probe after)" || die 'Billing ACL postflight failed; inspect exact privileges before retry.'
	[[ "$before" == "$after" ]] || die 'Billing database identity or unrelated ACL changed.'
	billing_acl_fence
	printf '%s\n' 'Billing CRM ACL verified: 9 tables protected, consent append-only, Widgets ACL/env/all runtime containers unchanged.'
}
