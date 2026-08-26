#!/usr/bin/env bash

set -euo pipefail
umask 077

usage() {
	cat >&2 <<'USAGE'
Usage:
  deploy-services-production.sh --deploy <40-hex-services-revision>
  deploy-services-production.sh --cutover <40-hex-services-revision>

Required environment:
  INFRA_REVISION
  PRODUCTION_SSH_HOST
  PRODUCTION_SSH_PORT
  PRODUCTION_SSH_USER
  PRODUCTION_SSH_IDENTITY_FILE
  PRODUCTION_SSH_KNOWN_HOSTS_FILE
  EXPECTED_PRODUCTION_ENV_SHA256

Required only with --cutover:
  OPERATIONS_SNAPSHOT_SHA256
  OPERATIONS_CONTROL_PLANE_SNAPSHOT_SHA256
USAGE
	exit 2
}

die() {
	printf '%s\n' "$1" >&2
	exit 1
}

[[ $# -eq 2 ]] || usage

case "$1" in
	--deploy) deploy_mode='deploy' ;;
	--cutover) deploy_mode='cutover' ;;
	*) usage ;;
esac

services_revision="$2"
[[ "$services_revision" =~ ^[0-9a-f]{40}$ ]] ||
	die 'Services revision must be an immutable lowercase 40-hex commit.'

infra_revision="${INFRA_REVISION:-}"
[[ "$infra_revision" =~ ^[0-9a-f]{40}$ ]] ||
	die 'Infra revision must be an immutable lowercase 40-hex commit.'

controller_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ -d "$controller_root/.git" && ! -L "$controller_root" ]] ||
	die 'Infrastructure controller must run from its canonical Git checkout.'
[[ "$(git -C "$controller_root" rev-parse HEAD 2>/dev/null)" == "$infra_revision" ]] ||
	die 'Infrastructure checkout does not match INFRA_REVISION.'
[[ -z "$(git -C "$controller_root" status --porcelain --untracked-files=all)" ]] ||
	die 'Infrastructure checkout must be clean before production deployment.'
infra_repository_origin="$(git -C "$controller_root" remote get-url origin 2>/dev/null)" ||
	die 'Cannot read the infrastructure repository origin.'
case "$infra_repository_origin" in
	git@github.com:nda17/winwidget.ru_infra | git@github.com:nda17/winwidget.ru_infra.git | \
		https://github.com/nda17/winwidget.ru_infra | https://github.com/nda17/winwidget.ru_infra.git | \
		ssh://git@github.com/nda17/winwidget.ru_infra | ssh://git@github.com/nda17/winwidget.ru_infra.git) ;;
	*) die 'Infrastructure controller origin is not the approved GitHub repository.' ;;
esac

backend_nginx_file="$controller_root/nginx/backend-api.conf"
[[ -f "$backend_nginx_file" && ! -L "$backend_nginx_file" ]] ||
	die 'Tracked apps-only backend Nginx config is missing or unsafe.'
git -C "$controller_root" ls-files --error-unmatch \
	nginx/backend-api.conf >/dev/null 2>&1 ||
	die 'Apps-only backend Nginx config is not tracked by infra Git.'
backend_nginx_sha256="$(sha256sum "$backend_nginx_file" | awk '{print $1}')"
[[ "$backend_nginx_sha256" =~ ^[0-9a-f]{64}$ ]] ||
	die 'Cannot calculate apps-only backend Nginx SHA-256.'
backend_nginx_base64="$(base64 <"$backend_nginx_file" | tr -d '\n')"
[[ -n "$backend_nginx_base64" &&
	"$backend_nginx_base64" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] ||
	die 'Cannot encode the apps-only backend Nginx config.'

required_environment=(
	PRODUCTION_SSH_HOST
	PRODUCTION_SSH_PORT
	PRODUCTION_SSH_USER
	PRODUCTION_SSH_IDENTITY_FILE
	PRODUCTION_SSH_KNOWN_HOSTS_FILE
	EXPECTED_PRODUCTION_ENV_SHA256
)
for variable_name in "${required_environment[@]}"; do
	[[ -n "${!variable_name:-}" ]] ||
		die "Required deployment setting is missing: $variable_name"
done

[[ "$PRODUCTION_SSH_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ ]] ||
	die 'Production SSH host is invalid.'
if [[ ! "$PRODUCTION_SSH_PORT" =~ ^[0-9]{1,5}$ ]] ||
	((10#$PRODUCTION_SSH_PORT < 1 || 10#$PRODUCTION_SSH_PORT > 65535)); then
	die 'Production SSH port is invalid.'
fi
[[ "$PRODUCTION_SSH_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] ||
	die 'Production SSH user is invalid.'
[[ "$EXPECTED_PRODUCTION_ENV_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
	die 'Expected production env SHA-256 must be lowercase 64-hex.'

identity_file="$PRODUCTION_SSH_IDENTITY_FILE"
known_hosts_file="$PRODUCTION_SSH_KNOWN_HOSTS_FILE"
[[ -f "$identity_file" && ! -L "$identity_file" ]] ||
	die 'Production SSH identity file must be a regular non-symlink file.'
[[ "$(stat -c '%a' "$identity_file" 2>/dev/null || stat -f '%Lp' "$identity_file")" == '600' ]] ||
	die 'Production SSH identity file must have mode 0600.'
ssh-keygen -y -P '' -f "$identity_file" >/dev/null 2>&1 ||
	die 'Production SSH identity file is invalid or requires a passphrase.'
[[ -s "$known_hosts_file" && ! -L "$known_hosts_file" ]] ||
	die 'Production SSH known_hosts file must be a non-empty regular file.'
[[ "$(stat -c '%a' "$known_hosts_file" 2>/dev/null || stat -f '%Lp' "$known_hosts_file")" == '600' ]] ||
	die 'Production SSH known_hosts file must have mode 0600.'

operations_snapshot_sha256="${OPERATIONS_SNAPSHOT_SHA256:-}"
control_plane_snapshot_sha256="${OPERATIONS_CONTROL_PLANE_SNAPSHOT_SHA256:-}"
if [[ "$deploy_mode" == 'cutover' ]]; then
	[[ "$operations_snapshot_sha256" =~ ^[0-9a-f]{64}$ ]] ||
		die 'Operations snapshot SHA-256 is required for --cutover.'
	[[ "$control_plane_snapshot_sha256" =~ ^[0-9a-f]{64}$ ]] ||
		die 'Operations control-plane snapshot SHA-256 is required for --cutover.'
elif [[ -n "$operations_snapshot_sha256" || -n "$control_plane_snapshot_sha256" ]]; then
	die 'Snapshot hashes are accepted only with --cutover.'
fi
if [[ "$deploy_mode" == 'deploy' ]]; then
	operations_snapshot_sha256='-'
	control_plane_snapshot_sha256='-'
fi

ssh_options=(
	-F /dev/null
	-o BatchMode=yes
	-o ClearAllForwardings=yes
	-o ConnectTimeout=15
	-o ForwardAgent=no
	-o IdentitiesOnly=yes
	-o LogLevel=ERROR
	-o PasswordAuthentication=no
	-o PermitLocalCommand=no
	-o RequestTTY=no
	-o ServerAliveCountMax=3
	-o ServerAliveInterval=15
	-o StrictHostKeyChecking=yes
	-o "UserKnownHostsFile=$known_hosts_file"
	-i "$identity_file"
	-p "$PRODUCTION_SSH_PORT"
)

ssh "${ssh_options[@]}" \
	"$PRODUCTION_SSH_USER@$PRODUCTION_SSH_HOST" \
	bash -s -- \
	"$deploy_mode" \
	"$infra_revision" \
	"$services_revision" \
	"$EXPECTED_PRODUCTION_ENV_SHA256" \
	"$operations_snapshot_sha256" \
	"$control_plane_snapshot_sha256" \
	"$backend_nginx_sha256" \
	"$backend_nginx_base64" <<'REMOTE_CONTROLLER'
set -euo pipefail
umask 077

die() {
	printf '%s\n' "$1" >&2
	exit 1
}

deploy_mode="$1"
infra_revision="$2"
services_revision="$3"
expected_env_sha256="$4"
operations_snapshot_sha256="$5"
control_plane_snapshot_sha256="$6"
backend_nginx_sha256="$7"
backend_nginx_base64="$8"

[[ "$deploy_mode" == 'deploy' || "$deploy_mode" == 'cutover' ]] ||
	die 'Remote deployment mode is invalid.'
[[ "$infra_revision" =~ ^[0-9a-f]{40}$ ]] ||
	die 'Remote infra revision is invalid.'
[[ "$services_revision" =~ ^[0-9a-f]{40}$ ]] ||
	die 'Remote services revision is invalid.'
[[ "$expected_env_sha256" =~ ^[0-9a-f]{64}$ ]] ||
	die 'Remote expected env SHA-256 is invalid.'
if [[ "$deploy_mode" == 'deploy' ]]; then
	[[ "$operations_snapshot_sha256" == '-' &&
		"$control_plane_snapshot_sha256" == '-' ]] ||
		die 'Routine deploy received unexpected snapshot arguments.'
	operations_snapshot_sha256=''
	control_plane_snapshot_sha256=''
else
	[[ "$operations_snapshot_sha256" =~ ^[0-9a-f]{64}$ &&
		"$control_plane_snapshot_sha256" =~ ^[0-9a-f]{64}$ ]] ||
		die 'Remote cutover snapshot hashes are invalid.'
fi
[[ "$backend_nginx_sha256" =~ ^[0-9a-f]{64}$ &&
	"$backend_nginx_base64" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] ||
	die 'Remote apps-only backend Nginx artifact is invalid.'
[[ "$(id -u)" == '0' ]] ||
	die 'Production deployment controller must run as root.'

readonly app_root='/opt/winwidget'
readonly services_repository="$app_root/winwidget.ru_services"
readonly releases_parent="$app_root/releases"
readonly releases_root="$app_root/releases/winwidget.ru_services"
readonly release_root="$releases_root/$services_revision"
readonly env_file="$app_root/deploy/backend/.env.production"
readonly deploy_lock="$app_root/deploy/backend/.production-deploy.lock"
readonly operations_snapshot_file="$app_root/deploy/backend/cutover-input/operations.snapshot.json"
readonly control_plane_snapshot_file="$app_root/deploy/backend/cutover-input/operations-control-plane.snapshot.json"
readonly terminal_cutover_marker="$app_root/deploy/backend/.microservices-terminal-cutover-v1"
readonly expected_repository_slug='nda17/winwidget.ru_services'

assert_root_owned_directory() {
	local path="$1" mode
	[[ -d "$path" && ! -L "$path" && "$(realpath -e "$path")" == "$path" &&
		"$(stat -c '%u:%g' "$path")" == '0:0' ]] ||
		die "Root-owned directory boundary is unsafe: $path"
	mode="$(stat -c '%a' "$path")"
	[[ "$mode" =~ ^[0-7]{3,4}$ ]] ||
		die "Directory mode is invalid: $path"
	(( (8#$mode & 8#022) == 0 )) ||
		die "Directory is group/world writable: $path"
}

assert_root_owned_file() {
	local path="$1" mode
	[[ -f "$path" && ! -L "$path" && "$(realpath -e "$path")" == "$path" &&
		"$(stat -c '%u:%g:%h' "$path")" == '0:0:1' ]] ||
		die "Root-owned file boundary is unsafe: $path"
	mode="$(stat -c '%a' "$path")"
	[[ "$mode" =~ ^[0-7]{3,4}$ ]] ||
		die "File mode is invalid: $path"
	(( (8#$mode & 8#022) == 0 )) ||
		die "File is group/world writable: $path"
}

assert_root_owned_directory "$app_root"
assert_root_owned_directory "$app_root/deploy"
assert_root_owned_directory "$app_root/deploy/backend"

[[ -f "$env_file" && ! -L "$env_file" ]] ||
	die 'Canonical production env is missing or unsafe.'
[[ "$(realpath -e "$env_file")" == "$env_file" ]] ||
	die 'Canonical production env path is not canonical.'
[[ "$(stat -c '%u:%g:%a:%h' "$env_file")" == '0:0:600:1' ]] ||
	die 'Canonical production env must be root:root mode 0600 with one link.'

deploy_state_directory="$(dirname "$deploy_lock")"
[[ -d "$deploy_state_directory" && ! -L "$deploy_state_directory" &&
	"$(stat -c '%u:%g' "$deploy_state_directory")" == '0:0' ]] ||
	die 'Production deploy state directory is unsafe.'
deploy_state_directory_mode="$(stat -c '%a' "$deploy_state_directory")"
[[ "$deploy_state_directory_mode" =~ ^[0-7]{3,4}$ ]] ||
	die 'Production deploy state directory mode is invalid.'
(( (8#$deploy_state_directory_mode & 8#022) == 0 )) ||
	die 'Production deploy state directory must not be group/world writable.'
[[ ! -L "$deploy_lock" && (! -e "$deploy_lock" || -f "$deploy_lock") ]] ||
	die 'Production deploy lock path is unsafe.'
exec {deploy_lock_fd}>"$deploy_lock"
chown 0:0 "$deploy_lock"
chmod 600 "$deploy_lock"
[[ "$(stat -c '%u:%g:%a:%h' "$deploy_lock")" == '0:0:600:1' ]] ||
	die 'Production deploy lock identity is unsafe.'
flock -n "$deploy_lock_fd" ||
	die 'Another production deployment currently holds the production lock.'

if [[ "$deploy_mode" == 'deploy' ]]; then
	[[ -f "$terminal_cutover_marker" && ! -L "$terminal_cutover_marker" ]] ||
		die 'Routine deployment requires a completed terminal microservices cutover.'
else
	[[ ! -e "$terminal_cutover_marker" && ! -L "$terminal_cutover_marker" ]] ||
		die 'Terminal microservices cutover is already complete; use --deploy.'
fi

env_sha256_before="$(sha256sum "$env_file" | awk '{print $1}')"
[[ "$env_sha256_before" == "$expected_env_sha256" ]] ||
	die 'Canonical production env differs from the approved byte-identical hash.'

[[ -d "$services_repository/.git" && ! -L "$services_repository" ]] ||
	die 'The canonical winwidget.ru_services checkout is not provisioned.'
assert_root_owned_directory "$services_repository"
assert_root_owned_directory "$services_repository/.git"
assert_root_owned_file "$services_repository/.git/config"
assert_root_owned_directory "$services_repository/.git/hooks"
[[ -z "$(find "$services_repository/.git/hooks" -xdev -mindepth 1 \
	\( -type l -o -perm /022 \) -print -quit)" ]] ||
	die 'Services repository hooks contain an unsafe entry.'
if git config --file "$services_repository/.git/config" --name-only \
	--get-regexp '^(include\..*\.path|include\.path|core\.hooksPath|core\.fsmonitor|remote\..*\.uploadpack|filter\..*\.(clean|smudge|process)|diff\..*\.command)$' \
	>/dev/null 2>&1; then
	die 'Services repository config contains an executable/include hook.'
fi
[[ -z "$(git -c core.hooksPath=/dev/null -C "$services_repository" \
	status --porcelain --untracked-files=all)" ]] ||
	die 'Canonical services checkout must be clean.'
repository_origin="$(git -c core.hooksPath=/dev/null -C "$services_repository" remote get-url origin 2>/dev/null)" ||
	die 'Cannot read the services repository origin.'
case "$repository_origin" in
	"git@github.com:$expected_repository_slug" | "git@github.com:$expected_repository_slug.git" | \
		"https://github.com/$expected_repository_slug" | "https://github.com/$expected_repository_slug.git" | \
		"ssh://git@github.com/$expected_repository_slug" | "ssh://git@github.com/$expected_repository_slug.git") ;;
	*) die 'The services repository origin is not the approved GitHub repository.' ;;
esac

export GIT_TERMINAL_PROMPT=0
git -c core.hooksPath=/dev/null -C "$services_repository" fetch --force --no-tags origin \
	'+refs/heads/prod:refs/remotes/origin/prod' >/dev/null 2>&1 ||
	die 'Cannot fetch the approved services production branch.'
git -C "$services_repository" cat-file -e "${services_revision}^{commit}" 2>/dev/null ||
	die 'Requested services revision is not available after fetch.'
[[ "$(git -C "$services_repository" rev-parse "${services_revision}^{commit}")" == "$services_revision" ]] ||
	die 'Requested revision did not resolve to the exact commit.'
[[ "$(git -C "$services_repository" rev-parse refs/remotes/origin/prod)" == \
	"$services_revision" ]] ||
	die 'Requested revision must be the exact fetched origin/prod commit.'

if [[ ! -e "$releases_parent" && ! -L "$releases_parent" ]]; then
	install -d -o root -g root -m 0755 "$releases_parent"
fi
assert_root_owned_directory "$releases_parent"
if [[ ! -e "$releases_root" && ! -L "$releases_root" ]]; then
	install -d -o root -g root -m 0755 "$releases_root"
fi
assert_root_owned_directory "$releases_root"
if [[ -e "$release_root" ]]; then
	[[ -d "$release_root" && ! -L "$release_root" ]] ||
		die 'Existing release path is unsafe.'
	assert_root_owned_directory "$release_root"
	[[ "$(git -C "$release_root" rev-parse HEAD 2>/dev/null)" == "$services_revision" ]] ||
		die 'Existing release directory points to another revision.'
	[[ -z "$(git -C "$release_root" status --porcelain --untracked-files=all)" ]] ||
		die 'Existing release directory is not clean.'
else
	git -c core.hooksPath=/dev/null -C "$services_repository" worktree add --detach "$release_root" \
		"$services_revision" >/dev/null 2>&1 ||
		die 'Cannot create the immutable services release worktree.'
	assert_root_owned_directory "$release_root"
fi

readonly compose_file="$release_root/deploy/docker-compose.prod.yml"
[[ -f "$compose_file" && ! -L "$compose_file" ]] ||
	die 'Release Compose manifest is missing or unsafe.'

retired_root_runtime_paths=(
	"$release_root/src"
	"$release_root/Dockerfile"
	"$release_root/docker-entrypoint.sh"
	"$release_root/database-restore-entrypoint.sh"
	"$release_root/nest-cli.json"
	"$release_root/tsconfig.json"
	"$release_root/tsconfig.build.json"
)
for retired_path in "${retired_root_runtime_paths[@]}"; do
	[[ ! -e "$retired_path" ]] ||
		die 'Requested release still contains a retired root runtime artifact.'
done

required_apps=(
	api-gateway
	billing
	campaigns
	identity
	notification-delivery
	operations
	platform
	reporting
	support
	widgets
)
for app_name in "${required_apps[@]}"; do
	assert_root_owned_directory "$services_repository/apps/$app_name"
	assert_root_owned_directory "$release_root/apps/$app_name"
	[[ -f "$release_root/apps/$app_name/package.json" &&
		-f "$release_root/apps/$app_name/pnpm-lock.yaml" &&
		-f "$release_root/apps/$app_name/Dockerfile" &&
		-f "$release_root/apps/$app_name/.env.example" ]] ||
		die 'Requested release is missing an app-owned build contract.'
	git -C "$release_root" ls-files --error-unmatch \
		"apps/$app_name/.env.example" >/dev/null 2>&1 ||
		die 'A service env example is not tracked by the requested revision.'
	git -C "$release_root" check-ignore -q \
		"apps/$app_name/.env.production" ||
		die 'A service production env path is not ignored by the services repository.'
done

export COMPOSE_PROJECT_NAME='winwidget'
export APP_VERSION="git-$services_revision"
export APP_REVISION="$services_revision"
export NOTIFICATION_DELIVERY_IMAGE="winwidget-notification-delivery:git-$services_revision"
export NOTIFICATION_DELIVERY_REVISION="$services_revision"
export CAMPAIGNS_IMAGE="winwidget-campaigns:git-$services_revision"
export CAMPAIGNS_REVISION="$services_revision"
export REPORTING_IMAGE="winwidget-reporting:git-$services_revision"
export REPORTING_REVISION="$services_revision"
export WIDGETS_IMAGE="winwidget-widgets:git-$services_revision"
export WIDGETS_REVISION="$services_revision"
export BILLING_IMAGE="winwidget-billing:git-$services_revision"
export BILLING_REVISION="$services_revision"
export IDENTITY_IMAGE="winwidget-identity:git-$services_revision"
export IDENTITY_REVISION="$services_revision"
export PLATFORM_IMAGE="winwidget-platform:git-$services_revision"
export PLATFORM_REVISION="$services_revision"
export SUPPORT_IMAGE="winwidget-support:git-$services_revision"
export SUPPORT_REVISION="$services_revision"
export OPERATIONS_IMAGE="winwidget-operations:git-$services_revision"
export OPERATIONS_REVISION="$services_revision"

compose_canonical() {
	docker compose \
		--project-name "$COMPOSE_PROJECT_NAME" \
		--env-file "$env_file" \
		-f "$compose_file" \
		"$@"
}

# Build only the isolated parser image from the already hash-approved canonical
# source. No service container is started before service-owned env files exist.
compose_canonical build api-gateway

service_env_staging="$(mktemp -d "$deploy_state_directory/.service-envs.XXXXXX")"
[[ -d "$service_env_staging" && ! -L "$service_env_staging" &&
	"$(stat -c '%u:%g:%a' "$service_env_staging")" == '0:0:700' ]] ||
	die 'Cannot create protected service env staging.'
pending_service_env=''
pending_service_env_directory=''
cleanup_service_env_staging() {
	if [[ -n "${pending_service_env:-}" && -n "${pending_service_env_directory:-}" &&
		"$(dirname "$pending_service_env")" == "$pending_service_env_directory" &&
		"$pending_service_env_directory" == "$services_repository/apps/"* &&
		-f "$pending_service_env" && ! -L "$pending_service_env" ]]; then
		rm -f -- "$pending_service_env"
	fi
	if [[ -n "${service_env_staging:-}" && -d "$service_env_staging" &&
		! -L "$service_env_staging" &&
		"$(dirname "$service_env_staging")" == "$deploy_state_directory" ]]; then
		find "$service_env_staging" -mindepth 1 -maxdepth 1 -type f -delete
		rmdir "$service_env_staging"
	fi
}
trap cleanup_service_env_staging EXIT

docker run --rm \
	--network none \
	--read-only \
	--cap-drop ALL \
	--security-opt no-new-privileges \
	--user 0:0 \
	--env "EXPECTED_SERVICES_REVISION=$services_revision" \
	--entrypoint node \
	--volume "$env_file:/run/winwidget/canonical.env:ro" \
	--volume "$release_root/apps:/run/winwidget/apps:ro" \
	--volume "$service_env_staging:/run/winwidget/output" \
	"winwidget-api-gateway:git-$services_revision" - <<'MATERIALIZE_SERVICE_ENVS'
const fs = require('node:fs');
const path = require('node:path');

const apps = [
	'api-gateway',
	'billing',
	'campaigns',
	'identity',
	'notification-delivery',
	'operations',
	'platform',
	'reporting',
	'support',
	'widgets'
];
const fail = () => {
	throw new Error('service env materialization failed');
};
const parse = source => {
	if (source.includes('\0') || source.includes('\r')) fail();
	const values = new Map();
	const order = [];
	for (const line of source.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const separator = trimmed.indexOf('=');
		if (separator < 1) fail();
		const key = trimmed.slice(0, separator).trim();
		const rawValue = trimmed.slice(separator + 1).trim();
		if (!/^[A-Z][A-Z0-9_]*$/.test(key) || values.has(key)) fail();
		if (/(^|_)CORE($|_)/.test(key)) fail();
		values.set(key, rawValue);
		order.push(key);
	}
	if (!order.length) fail();
	return { values, order };
};

const canonical = parse(
	fs.readFileSync('/run/winwidget/canonical.env', 'utf8')
).values;
const revision = process.env.EXPECTED_SERVICES_REVISION ?? '';
if (!/^[0-9a-f]{40}$/.test(revision)) fail();

const rabbitAliases = {
	'billing': 'RABBITMQ_BILLING_WORKER_URL',
	'campaigns': 'RABBITMQ_CAMPAIGNS_URL',
	'identity': 'RABBITMQ_IDENTITY_WORKER_URL',
	'notification-delivery': 'RABBITMQ_NOTIFICATION_DELIVERY_URL',
	'operations': 'RABBITMQ_OPERATIONS_WORKER_URL',
	'platform': 'RABBITMQ_PLATFORM_PUBLISHER_URL',
	'reporting': 'RABBITMQ_REPORTING_URL',
	'support': 'RABBITMQ_SUPPORT_WORKER_URL',
	'widgets': 'RABBITMQ_WIDGETS_URL'
};
const connectionNames = {
	'billing': 'winwidget-billing-worker',
	'campaigns': 'winwidget-campaigns-all',
	'identity': 'winwidget-identity-worker',
	'notification-delivery': 'winwidget-notification-delivery',
	'operations': 'winwidget-operations-worker',
	'platform': 'winwidget-platform-outbox-publisher',
	'reporting': 'winwidget-reporting',
	'support': 'winwidget-support-worker',
	'widgets': 'winwidget-widgets-all'
};
const aliases = {
	'billing:YOOKASSA_SHOP_ID': 'YOOKASSA_PRODUCTION_SHOP_ID',
	'billing:YOOKASSA_SECRET_KEY': 'YOOKASSA_PRODUCTION_SECRET_KEY',
	'identity:IDENTITY_PORT': 'IDENTITY_API_PORT',
	'identity:JWT_ACCESS_ACTIVE_KID': 'IDENTITY_JWT_ACCESS_ACTIVE_KID',
	'identity:JWT_ACCESS_JWKS_BASE64': 'IDENTITY_JWT_ACCESS_JWKS_BASE64',
	'identity:JWT_ACCESS_PRIVATE_KEY_BASE64': 'IDENTITY_JWT_ACCESS_PRIVATE_KEY_BASE64',
	'support:SUPPORT_PORT': 'SUPPORT_API_PORT'
};
const fallbacks = new Map([
	['api-gateway:JWT_MAX_TOKEN_LIFETIME_SECONDS', '900'],
	['api-gateway:SHUTDOWN_GRACE_MS', '10000'],
	['billing:RABBITMQ_ASSERT_TOPOLOGY', 'false'],
	['campaigns:RABBITMQ_ASSERT_TOPOLOGY', 'true'],
	['identity:RABBITMQ_ASSERT_TOPOLOGY', 'false'],
	['identity:IDENTITY_HOUSEKEEPING_INTERVAL_MS', '3600000'],
	['notification-delivery:RABBITMQ_ASSERT_TOPOLOGY', 'true'],
	['notification-delivery:NOTIFICATION_DELIVERY_OUTBOX_BATCH_SIZE', '50'],
	['notification-delivery:NOTIFICATION_DELIVERY_OUTBOX_POLL_INTERVAL_MS', '1000'],
	['notification-delivery:NOTIFICATION_DELIVERY_OUTBOX_RETENTION_DAYS', '7'],
	['notification-delivery:SMTP_PORT', '2525'],
	['notification-delivery:SMTP_SECURE', 'false'],
	['operations:CAMPAIGNS_INTERNAL_BASE_URL', 'http://127.0.0.1:4500'],
	['operations:DATABASE_RESTORE_ENABLED', 'false'],
	['operations:OPERATIONS_RESTORE_WORKER_PORT', '5203'],
	['operations:RABBITMQ_ASSERT_TOPOLOGY', 'true'],
	['operations:REPORTING_INTERNAL_BASE_URL', 'http://127.0.0.1:4600'],
	['operations:TELEGRAM_INFO_BOT_CONFIGURED', 'true'],
	['platform:RABBITMQ_ASSERT_TOPOLOGY', 'false'],
	['reporting:RABBITMQ_ASSERT_TOPOLOGY', 'true'],
	['reporting:TZ', 'Europe/Moscow'],
	['support:RABBITMQ_ASSERT_TOPOLOGY', 'false'],
	['support:SUPPORT_PROCESS_ROLE', 'api'],
	['widgets:RABBITMQ_ASSERT_TOPOLOGY', 'true'],
	['widgets:WIDGETS_ASSETS_DIR', 'public/widgets'],
	['widgets:WIDGETS_UPLOADS_DIR', 'uploads'],
	['widgets:WIDGETS_PROVIDER_PREFETCH', '10'],
	['widgets:WIDGETS_RABBITMQ_TOPOLOGY_SCOPE', 'all']
]);
const overrides = new Map();
const explicitlyOptionalEmptyValues = new Set(['widgets:S3_KEY_PREFIX']);
for (const app of apps) {
	overrides.set(`${app}:APP_REVISION`, revision);
	overrides.set(`${app}:NODE_ENV`, 'production');
	if (connectionNames[app]) {
		overrides.set(`${app}:RABBITMQ_CONNECTION_NAME`, connectionNames[app]);
		fallbacks.set(`${app}:RABBITMQ_MAX_MESSAGE_BYTES`, '262144');
	}
}
for (const slug of [
	'notification-delivery',
	'campaigns',
	'reporting',
	'widgets',
	'billing',
	'identity',
	'platform',
	'support',
	'operations'
]) {
	const prefix = slug.replaceAll('-', '_').toUpperCase();
	overrides.set(
		`operations:DATABASE_RESTORE_${prefix}_ADMIN_PASSWORD_FILE`,
		`/run/secrets/database-restore-${slug}-admin-password`
	);
}

for (const app of apps) {
	const examplePath = path.join('/run/winwidget/apps', app, '.env.example');
	const example = parse(fs.readFileSync(examplePath, 'utf8'));
	const output = [];
	for (const key of example.order) {
		const ownerKey = `${app}:${key}`;
		let rawValue;
		if (key === 'RABBITMQ_URL' && rabbitAliases[app]) {
			rawValue = canonical.get(rabbitAliases[app]);
		} else if (aliases[ownerKey]) {
			rawValue = canonical.get(aliases[ownerKey]);
		} else if (overrides.has(ownerKey)) {
			rawValue = overrides.get(ownerKey);
		} else if (canonical.has(key)) {
			rawValue = canonical.get(key);
		} else {
			rawValue = fallbacks.get(ownerKey);
		}
		if (
			typeof rawValue !== 'string' ||
			(!rawValue && !explicitlyOptionalEmptyValues.has(ownerKey)) ||
			/[\0\r\n]/.test(rawValue) ||
			/change_me/i.test(rawValue) ||
			rawValue.includes(':4200')
		) fail();
		output.push(`${key}=${rawValue}`);
	}
	const target = path.join('/run/winwidget/output', `${app}.env.production`);
	fs.writeFileSync(target, `${output.join('\n')}\n`, {
		encoding: 'utf8',
		flag: 'wx',
		mode: 0o600
	});
}
MATERIALIZE_SERVICE_ENVS

service_env_files=()
compose_env_arguments=(--env-file "$env_file")
for app_name in "${required_apps[@]}"; do
	staged_env="$service_env_staging/$app_name.env.production"
	target_env="$services_repository/apps/$app_name/.env.production"
	[[ -f "$staged_env" && ! -L "$staged_env" &&
		"$(stat -c '%u:%g:%a:%h' "$staged_env")" == '0:0:600:1' ]] ||
		die 'A materialized service env is missing or unsafe.'
	[[ ! -L "$target_env" && (! -e "$target_env" || -f "$target_env") ]] ||
		die 'A service production env target is unsafe.'
	temporary_env="$services_repository/apps/$app_name/.env.production.tmp.$$"
	[[ ! -e "$temporary_env" && ! -L "$temporary_env" ]] ||
		die 'A service production env temporary path already exists.'
	pending_service_env="$temporary_env"
	pending_service_env_directory="$services_repository/apps/$app_name"
	install -o 0 -g 0 -m 600 "$staged_env" "$temporary_env"
	sync -f "$temporary_env"
	mv -f -- "$temporary_env" "$target_env"
	sync -f "$services_repository/apps/$app_name"
	pending_service_env=''
	pending_service_env_directory=''
	[[ -f "$target_env" && ! -L "$target_env" &&
		"$(stat -c '%u:%g:%a:%h' "$target_env")" == '0:0:600:1' ]] ||
		die 'A service production env was not installed safely.'
	service_env_files+=("$target_env")
	compose_env_arguments+=(--env-file "$target_env")
done

service_env_manifest_sha256() {
	{
		local index app_name file_sha256
		for index in "${!required_apps[@]}"; do
			app_name="${required_apps[$index]}"
			file_sha256="$(sha256sum "${service_env_files[$index]}" | awk '{print $1}')"
			printf '%s\0%s\n' "apps/$app_name/.env.production" "$file_sha256"
		done
	} | sha256sum | awk '{print $1}'
}
service_env_manifest_sha256_before="$(service_env_manifest_sha256)"
[[ "$service_env_manifest_sha256_before" =~ ^[0-9a-f]{64}$ ]] ||
	die 'Cannot calculate the service env manifest hash.'

compose_default() {
	docker compose \
		--project-name "$COMPOSE_PROJECT_NAME" \
		"${compose_env_arguments[@]}" \
		-f "$compose_file" \
		"$@"
}

compose_all() {
	docker compose \
		--profile '*' \
		--project-name "$COMPOSE_PROJECT_NAME" \
		"${compose_env_arguments[@]}" \
		-f "$compose_file" \
		"$@"
}

infrastructure_services=(
	notification-delivery-postgres
	campaigns-postgres
	reporting-postgres
	widgets-postgres
	billing-postgres
	identity-postgres
	platform-postgres
	support-postgres
	operations-postgres
	rabbitmq
)
runtime_services=(
	api-gateway
	notification-delivery-worker
	campaigns-service
	reporting-service
	widgets-service
	billing-api
	billing-scheduler
	billing-worker
	billing-outbox-publisher
	identity-api
	identity-worker
	identity-outbox-publisher
	platform-api
	platform-outbox-publisher
	support-api
	operations-api
	support-worker
	operations-worker
	support-outbox-publisher
	operations-outbox-publisher
	operations-restore-worker
)
runtime_without_gateway=(
	notification-delivery-worker
	campaigns-service
	reporting-service
	widgets-service
	billing-api
	billing-scheduler
	billing-worker
	billing-outbox-publisher
	identity-api
	identity-worker
	identity-outbox-publisher
	platform-api
	platform-outbox-publisher
	support-api
	operations-api
	support-worker
	operations-worker
	support-outbox-publisher
	operations-outbox-publisher
)
migration_services=(
	notification-delivery-migrate
	campaigns-migrate
	reporting-migrate
	widgets-migrate
	billing-migrate
	identity-migrate
	platform-migrate
	support-migrate
	operations-migrate
)
build_services=(
	api-gateway
	notification-delivery-worker
	campaigns-service
	reporting-service
	widgets-service
	billing-api
	identity-api
	platform-api
	support-api
	operations-api
)

expected_default_services="$({
	printf '%s\n' rabbitmq
	printf '%s\n' "${runtime_services[@]}"
} | LC_ALL=C sort)"
actual_default_services="$(compose_default config --services 2>/dev/null | LC_ALL=C sort)" ||
	die 'Production Compose cannot be resolved from the canonical env.'
[[ "$actual_default_services" == "$expected_default_services" ]] ||
	die 'Production Compose default service set is not the exact apps-only contract.'

expected_all_services="$({
	printf '%s\n' "${infrastructure_services[@]}"
	printf '%s\n' "${runtime_services[@]}"
	printf '%s\n' "${migration_services[@]}"
} | LC_ALL=C sort)"
actual_all_services="$(compose_all config --services 2>/dev/null | LC_ALL=C sort)" ||
	die 'Production Compose profiles cannot be resolved.'
[[ "$actual_all_services" == "$expected_all_services" ]] ||
	die 'Production Compose contains an unexpected service or migration target.'

compose_all build "${build_services[@]}"

built_images=(
	"winwidget-api-gateway:git-$services_revision"
	"winwidget-notification-delivery:git-$services_revision"
	"winwidget-campaigns:git-$services_revision"
	"winwidget-reporting:git-$services_revision"
	"winwidget-widgets:git-$services_revision"
	"winwidget-billing:git-$services_revision"
	"winwidget-identity:git-$services_revision"
	"winwidget-platform:git-$services_revision"
	"winwidget-support:git-$services_revision"
	"winwidget-operations:git-$services_revision"
)
declare -A built_image_ids=()
for image_name in "${built_images[@]}"; do
	image_id="$(docker image inspect --format '{{.Id}}' "$image_name" 2>/dev/null)" ||
		die 'A required service image was not built.'
	[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] ||
		die 'A built service image has an invalid immutable image ID.'
	image_revision="$(
		docker image inspect --format \
			'{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
			"$image_name" 2>/dev/null
	)" || die 'A required service image was not built.'
	[[ "$image_revision" == "$services_revision" ]] ||
		die 'A built service image has the wrong immutable revision label.'
	built_image_ids["$image_name"]="$image_id"
done

readonly operations_restore_host_root='/var/lib/winwidget-operations'
readonly operations_restore_storage='/var/lib/winwidget-operations/restores'
if [[ ! -e "$operations_restore_host_root" &&
	! -L "$operations_restore_host_root" ]]; then
	install -d -o root -g root -m 0755 "$operations_restore_host_root"
fi
assert_root_owned_directory "$operations_restore_host_root"
if [[ ! -e "$operations_restore_storage" &&
	! -L "$operations_restore_storage" ]]; then
	install -d -o 1001 -g 1001 -m 0700 "$operations_restore_storage"
fi
[[ -d "$operations_restore_storage" && ! -L "$operations_restore_storage" &&
	"$(realpath -e "$operations_restore_storage")" ==
		"$operations_restore_storage" &&
	"$(stat -c '%u:%g:%a' "$operations_restore_storage")" == '1001:1001:700' ]] ||
	die 'Operations restore storage must be canonical UID/GID 1001 mode 0700.'
docker run --rm \
	--network none \
	--read-only \
	--tmpfs /tmp:rw,noexec,nosuid,nodev,size=8m \
	--cap-drop ALL \
	--security-opt no-new-privileges \
	--pids-limit 32 \
	--log-driver none \
	--user 1001:1001 \
	--volume "$operations_restore_storage:/run/winwidget/restores" \
	--entrypoint node \
	"winwidget-operations:git-$services_revision" - <<'RESTORE_STORAGE_PROBE'
const { randomUUID } = require('node:crypto');
const { open, unlink } = require('node:fs/promises');

(async () => {
	const path = `/run/winwidget/restores/.write-probe-${randomUUID()}`;
	const handle = await open(path, 'wx', 0o600);
	try {
		await handle.writeFile('probe');
		await handle.sync();
	} finally {
		await handle.close();
		await unlink(path);
	}
})().catch(() => {
	process.stderr.write('Operations restore storage probe failed.\n');
	process.exit(1);
});
RESTORE_STORAGE_PROBE

docker run --rm \
	--network none \
	--read-only \
	--cap-drop ALL \
	--security-opt no-new-privileges \
	--user 0:0 \
	--entrypoint node \
	--volume "$env_file:/run/winwidget/env.production:ro" \
	--volume "$release_root/apps/api-gateway/.env.example:/run/winwidget/gateway.env.example:ro" \
	"winwidget-api-gateway:git-$services_revision" - <<'ENV_CONTRACT'
const fs = require('node:fs');

function fail() {
	throw new Error('invalid production env contract');
}

function parseEnv(path) {
	const source = fs.readFileSync(path, 'utf8');
	if (source.includes('\0') || source.includes('\r')) fail();
	const values = new Map();
	for (const line of source.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const separator = trimmed.indexOf('=');
		if (separator < 1) fail();
		const key = trimmed.slice(0, separator).trim();
		let value = trimmed.slice(separator + 1).trim();
		if (!/^[A-Z][A-Z0-9_]*$/.test(key) || values.has(key)) fail();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (/(^|_)CORE($|_)/.test(key) || value.includes(':4200')) fail();
		values.set(key, value);
	}
	return values;
}

try {
	const values = parseEnv('/run/winwidget/env.production');
	const exampleValues = parseEnv('/run/winwidget/gateway.env.example');
	const retiredCoreKeys = [
		'DATABASE_URL_PRODUCTION',
		'DATABASE_MIGRATION_URL_PRODUCTION',
		'MAINTENANCE_DATABASE_URL_PRODUCTION',
		'DATABASE_BACKUP_URL'
	];
	if (retiredCoreKeys.some(key => values.has(key))) fail();
	if (values.get('COMPOSE_PROJECT_NAME') !== 'winwidget') fail();
	if (
		values.get('TELEGRAM_API_BASE_URL') !==
			'https://tg.winwidget.ru/telegram-api' ||
		values.get('TELEGRAM_API_PROXY_IP') !== '185.184.122.62'
	) fail();
	const databaseContracts = [
		{
			prefix: 'NOTIFICATION_DELIVERY',
			runtimeKey: 'NOTIFICATION_DELIVERY_DATABASE_URL',
			migrationKey: 'NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION',
			port: '55432',
			schema: 'notification_delivery'
		},
		{
			prefix: 'CAMPAIGNS',
			runtimeKey: 'CAMPAIGNS_DATABASE_URL',
			migrationKey: 'CAMPAIGNS_MIGRATION_DATABASE_URL',
			port: '55433',
			schema: 'campaigns'
		},
		{
			prefix: 'REPORTING',
			runtimeKey: 'REPORTING_DATABASE_URL',
			migrationKey: 'REPORTING_MIGRATION_DATABASE_URL',
			port: '55435',
			schema: 'reporting'
		},
		{
			prefix: 'WIDGETS',
			runtimeKey: 'WIDGETS_DATABASE_URL',
			migrationKey: 'WIDGETS_MIGRATION_DATABASE_URL',
			port: '55436',
			schema: 'widgets'
		},
		{
			prefix: 'BILLING',
			runtimeKey: 'BILLING_DATABASE_URL',
			migrationKey: 'BILLING_MIGRATION_DATABASE_URL',
			port: '55437',
			schema: 'billing'
		},
		{
			prefix: 'IDENTITY',
			runtimeKey: 'IDENTITY_DATABASE_URL',
			migrationKey: 'IDENTITY_MIGRATION_DATABASE_URL',
			port: '55438',
			schema: 'identity'
		},
		{
			prefix: 'PLATFORM',
			runtimeKey: 'PLATFORM_DATABASE_URL',
			migrationKey: 'PLATFORM_MIGRATION_DATABASE_URL',
			port: '55439',
			schema: 'platform'
		},
		{
			prefix: 'SUPPORT',
			runtimeKey: 'SUPPORT_DATABASE_URL',
			migrationKey: 'SUPPORT_MIGRATION_DATABASE_URL',
			port: '55440',
			schema: 'support'
		},
		{
			prefix: 'OPERATIONS',
			runtimeKey: 'OPERATIONS_DATABASE_URL',
			migrationKey: 'OPERATIONS_MIGRATION_DATABASE_URL',
			port: '55441',
			schema: 'operations'
		}
	];
	const validateDatabaseUrl = (rawValue, contract, roleSuffix) => {
		if (typeof rawValue !== 'string' || rawValue.length === 0) fail();
		const parsed = new URL(rawValue);
		const database = `winwidget_${contract.schema}`;
		const queryKeys = [...parsed.searchParams.keys()].sort();
		if (
			parsed.protocol !== 'postgresql:' ||
			parsed.hostname !== '127.0.0.1' ||
			parsed.port !== contract.port ||
			parsed.pathname !== `/${database}` ||
			decodeURIComponent(parsed.username) !== `${database}_${roleSuffix}` ||
			parsed.password.length === 0 ||
			parsed.hash !== '' ||
			JSON.stringify(queryKeys) !==
				JSON.stringify(['schema', 'sslmode']) ||
			parsed.searchParams.get('schema') !== contract.schema ||
			parsed.searchParams.get('sslmode') !== 'disable'
		) fail();
	};
	for (const contract of databaseContracts) {
		const database = `winwidget_${contract.schema}`;
		const runtimeUrl = values.get(contract.runtimeKey);
		const migrationUrl = values.get(contract.migrationKey);
		if (
			values.get(`${contract.prefix}_POSTGRES_PORT`) !== contract.port ||
			values.get(`${contract.prefix}_POSTGRES_ADMIN_USER`) !==
				`${database}_admin` ||
			runtimeUrl === migrationUrl
		) fail();
		validateDatabaseUrl(runtimeUrl, contract, 'runtime');
		validateDatabaseUrl(migrationUrl, contract, 'migration');
	}
	const routes = JSON.parse(values.get('GATEWAY_ROUTES_JSON') || 'null');
	const expectedRoutes = JSON.parse(
		exampleValues.get('GATEWAY_ROUTES_JSON') || 'null'
	);
	if (!Array.isArray(routes) || routes.length !== 43) fail();
	if (JSON.stringify(routes) !== JSON.stringify(expectedRoutes)) fail();
	const ids = new Set();
	const prefixes = new Set();
	for (const route of routes) {
		if (!route || typeof route !== 'object' || Array.isArray(route)) fail();
		if (typeof route.id !== 'string' || ids.has(route.id)) fail();
		if (
			typeof route.pathPrefix !== 'string' ||
			prefixes.has(route.pathPrefix) ||
			route.pathPrefix === '/api/v1'
		) fail();
		if (
			typeof route.upstreamUrl !== 'string' ||
			route.upstreamUrl.includes(':4200')
		) fail();
		ids.add(route.id);
		prefixes.add(route.pathPrefix);
	}
	const operationsRoutes = new Map([
		['operations-notes', '/api/v1/notes'],
		['operations-admin-event-log', '/api/v1/admin-event-log'],
		['operations-restores', '/api/v1/dev-tools/database-restores'],
		['operations-telegram', '/api/v1/telegram-bot/admin'],
		['operations-messaging', '/api/v1/messaging/admin'],
		['operations-alerts', '/api/v1/admin-alerts'],
		['operations-health-admin', '/api/v1/health/admin'],
		['operations-health-deployment', '/api/v1/health/deployment']
	]);
	for (const [id, pathPrefix] of operationsRoutes) {
		const route = routes.find(candidate => candidate.id === id);
		if (
			!route ||
			route.pathPrefix !== pathPrefix ||
			route.upstreamUrl !== 'http://127.0.0.1:5200'
		) fail();
	}
	if (routes.filter(route => route.upstreamUrl === 'http://127.0.0.1:5200').length !== 8) fail();
} catch {
	process.stderr.write('Production env failed the apps-only services contract.\n');
	process.exit(1);
}
ENV_CONTRACT

compose_contract_validator=''
read -r -d '' compose_contract_validator <<'COMPOSE_CONTRACT' || true
const fs = require('node:fs');

function fail() {
	throw new Error('invalid production Compose contract');
}

function sorted(values) {
	return [...values].sort((left, right) => left.localeCompare(right));
}

try {
	const config = JSON.parse(fs.readFileSync(0, 'utf8'));
	const services = config.services;
	if (!services || typeof services !== 'object' || Array.isArray(services)) fail();
	const restoreWorker = services['operations-restore-worker'];
	const operationsApi = services['operations-api'];
	if (!restoreWorker || !operationsApi) fail();
	const telegramRuntimeNames = [
		'notification-delivery-worker',
		'identity-api',
		'support-api',
		'support-worker',
		'operations-worker'
	];
	for (const name of telegramRuntimeNames) {
		const service = services[name];
		if (
			!service ||
			service.environment?.TELEGRAM_API_BASE_URL !==
				'https://tg.winwidget.ru/telegram-api' ||
			JSON.stringify(service.extra_hosts ?? []) !==
				JSON.stringify(['tg.winwidget.ru=185.184.122.62'])
		) fail();
	}
	if (
		operationsApi.environment?.TELEGRAM_INFO_BOT_CONFIGURED !== 'true' ||
		Object.hasOwn(
			operationsApi.environment ?? {},
			'TELEGRAM_INFO_BOT_TOKEN'
		) ||
		Object.hasOwn(
			operationsApi.environment ?? {},
			'TELEGRAM_API_BASE_URL'
		) ||
		JSON.stringify(operationsApi.extra_hosts ?? []) !== '[]'
	) fail();
	for (const name of ['support-api', 'support-worker']) {
		if (
			services[name].environment?.TELEGRAM_API_PROXY_IP !==
				'185.184.122.62'
		) fail();
	}

	const databaseTargets = [
		['notification-delivery', 'NOTIFICATION_DELIVERY', '55432'],
		['campaigns', 'CAMPAIGNS', '55433'],
		['reporting', 'REPORTING', '55435'],
		['widgets', 'WIDGETS', '55436'],
		['billing', 'BILLING', '55437'],
		['identity', 'IDENTITY', '55438'],
		['platform', 'PLATFORM', '55439'],
		['support', 'SUPPORT', '55440'],
		['operations', 'OPERATIONS', '55441']
	];
	const environment = restoreWorker.environment ?? {};
	const expectedEnvironmentKeys = [
		'APP_REVISION',
		'NODE_ENV',
		'MODE',
		'OPERATIONS_DATABASE_URL',
		'OPERATIONS_LISTEN_HOST',
		'OPERATIONS_RESTORE_WORKER_PORT',
		'OPERATIONS_PROCESS_ROLE',
		'RABBITMQ_URL',
		'RABBITMQ_CONNECTION_NAME',
		'RABBITMQ_ASSERT_TOPOLOGY',
		'RABBITMQ_MAX_MESSAGE_BYTES',
		'DATABASE_RESTORE_STORAGE_DIR'
	];
	for (const [, prefix] of databaseTargets) {
		expectedEnvironmentKeys.push(
			`${prefix}_POSTGRES_ADMIN_USER`,
			`${prefix}_POSTGRES_PORT`,
			`DATABASE_RESTORE_${prefix}_ADMIN_PASSWORD_FILE`
		);
	}
	if (
		JSON.stringify(sorted(Object.keys(environment))) !==
		JSON.stringify(sorted(expectedEnvironmentKeys))
	) fail();
	if (
		environment.APP_REVISION !== process.env.EXPECTED_SERVICES_REVISION ||
		environment.OPERATIONS_PROCESS_ROLE !== 'restore-worker' ||
		environment.OPERATIONS_LISTEN_HOST !== '127.0.0.1' ||
		environment.OPERATIONS_RESTORE_WORKER_PORT !== '5203' ||
		environment.DATABASE_RESTORE_STORAGE_DIR !== '/var/lib/winwidget-operations/restores' ||
		environment.RABBITMQ_CONNECTION_NAME !== 'winwidget-operations-restore-worker' ||
		environment.RABBITMQ_ASSERT_TOPOLOGY !== 'true'
	) fail();
	const rabbitUrl = new URL(environment.RABBITMQ_URL);
	if (
		rabbitUrl.pathname !== '/winwidget' ||
		decodeURIComponent(rabbitUrl.username) !== 'winwidget-operations-restore-worker'
	) fail();

	for (const [slug, prefix, port] of databaseTargets) {
		if (
			environment[`${prefix}_POSTGRES_PORT`] !== port ||
			environment[`DATABASE_RESTORE_${prefix}_ADMIN_PASSWORD_FILE`] !==
				`/run/secrets/database-restore-${slug}-admin-password` ||
			`DATABASE_RESTORE_${prefix}_ADMIN_URL` in environment
		) fail();
	}
	if ('TELEGRAM_INFO_BOT_TOKEN' in environment) fail();

	const expectedSecrets = databaseTargets
		.map(([slug]) => [
			`${slug}-postgres-admin-password`,
			`database-restore-${slug}-admin-password`
		])
		.sort(([left], [right]) => left.localeCompare(right));
	const actualSecrets = (restoreWorker.secrets ?? [])
		.map(secret => [secret.source, secret.target])
		.sort(([left], [right]) => left.localeCompare(right));
	if (JSON.stringify(actualSecrets) !== JSON.stringify(expectedSecrets)) fail();

	const restoreStorage = environment.DATABASE_RESTORE_STORAGE_DIR;
	for (const [name, service] of Object.entries(services)) {
		const mounts = service.volumes ?? [];
		const restoreMounts = mounts.filter(
			mount => mount.source === restoreStorage || mount.target === restoreStorage
		);
		if (name === 'operations-api' || name === 'operations-restore-worker') {
			if (
				mounts.length !== 1 ||
				restoreMounts.length !== 1 ||
				restoreMounts[0].type !== 'bind' ||
				restoreMounts[0].source !== restoreStorage ||
				restoreMounts[0].target !== restoreStorage
			) fail();
		} else if (restoreMounts.length !== 0) fail();
	}

	const tmpfs = (restoreWorker.tmpfs ?? []).map(String);
	if (
		restoreWorker.read_only !== true ||
		restoreWorker.init !== true ||
		JSON.stringify(restoreWorker.security_opt ?? []) !==
			JSON.stringify(['no-new-privileges:true']) ||
		JSON.stringify(sorted(restoreWorker.cap_drop ?? [])) !== JSON.stringify(['ALL']) ||
		(restoreWorker.cap_add ?? []).length !== 0 ||
		!tmpfs.some(
			value =>
				value.startsWith('/tmp:') &&
				value.includes('noexec') &&
				value.includes('nosuid') &&
				value.includes('nodev') &&
				value.includes('size=64m') &&
				value.includes('mode=1777')
		) ||
		restoreWorker.depends_on?.rabbitmq?.condition !== 'service_healthy' ||
		restoreWorker.depends_on?.['operations-outbox-publisher']?.condition !== 'service_started' ||
		!JSON.stringify(restoreWorker.healthcheck?.test ?? []).includes(
			'OPERATIONS_RESTORE_WORKER_PORT||5203'
		) ||
		restoreWorker.stop_grace_period !== '1m30s' ||
		restoreWorker.restart !== 'unless-stopped'
	) fail();
} catch {
	process.stderr.write('Production Compose failed the Operations restore-worker contract.\n');
	process.exit(1);
}
COMPOSE_CONTRACT

if ! compose_all config --format json 2>/dev/null |
	docker run --rm -i \
		--network none \
		--read-only \
		--cap-drop ALL \
		--security-opt no-new-privileges \
		--user 0:0 \
		--env "EXPECTED_SERVICES_REVISION=$services_revision" \
		--entrypoint node \
		"winwidget-api-gateway:git-$services_revision" \
		-e "$compose_contract_validator"; then
	die 'Production Compose apps-only hardening validation failed.'
fi
unset compose_contract_validator

compose_all up -d --no-build "${infrastructure_services[@]}"

wait_for_healthy_services() {
	local deadline=$((SECONDS + 300))
	local service_name container_id state health all_ready
	while ((SECONDS < deadline)); do
		all_ready='true'
		for service_name in "$@"; do
			container_id="$(compose_all ps --status running -q "$service_name" 2>/dev/null)"
			if [[ -z "$container_id" || "$container_id" == *$'\n'* ]]; then
				all_ready='false'
				continue
			fi
			read -r state health < <(
				docker inspect --format \
					'{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
					"$container_id" 2>/dev/null || printf 'missing missing\n'
			)
			if [[ "$state" != 'running' || "$health" != 'healthy' ]]; then
				[[ "$health" != 'unhealthy' ]] ||
					die "Production service became unhealthy: $service_name"
				all_ready='false'
			fi
		done
		[[ "$all_ready" != 'true' ]] || return 0
		sleep 2
	done
	die 'Production services did not become healthy before the deadline.'
}

wait_for_healthy_services "${infrastructure_services[@]}"

legacy_core_services=(
	api
	outbox-publisher
	integration-worker
	maintenance-worker
	database-restore-worker
)
legacy_core_container_ids=()

find_exact_named_container() {
	local container_name="$1" inventory
	inventory="$(
		docker ps -a --no-trunc \
			--filter "name=^/${container_name}$" \
			--format '{{.ID}}|{{.Names}}'
	)" || die "Cannot read Docker container inventory: $container_name"
	[[ "$inventory" != *$'\n'* ]] ||
		die "Docker container name is ambiguous: $container_name"
	if [[ -n "$inventory" ]]; then
		[[ "$inventory" =~ ^([0-9a-f]{64})\|(.+)$ &&
			"${BASH_REMATCH[2]}" == "$container_name" ]] ||
			die "Docker container inventory is invalid: $container_name"
		printf '%s' "${BASH_REMATCH[1]}"
	fi
}

docker_volume_exists() {
	local volume_name="$1" volume_inventory
	volume_inventory="$(docker volume ls --format '{{.Name}}')" ||
		die 'Cannot read Docker volume inventory.'
	grep -Fqx -- "$volume_name" <<<"$volume_inventory"
}

find_project_service_container() {
	local service_name="$1" container_ids
	container_ids="$(
		docker ps -aq \
			--filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
			--filter "label=com.docker.compose.service=$service_name"
	)" || die "Cannot read exact project service inventory: $service_name"
	[[ "$container_ids" != *$'\n'* ]] ||
		die "Multiple containers found for exact project service: $service_name"
	if [[ -n "$container_ids" ]]; then
		[[ "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.service" }}' "$container_ids")" == \
			"$COMPOSE_PROJECT_NAME|$service_name" ]] ||
			die "Container labels differ from exact cleanup target: $service_name"
	fi
	printf '%s' "$container_ids"
}

stop_project_service_if_present() {
	local service_name="$1" container_id running
	container_id="$(find_project_service_container "$service_name")"
	[[ -n "$container_id" ]] || return 0
	running="$(docker inspect --format '{{.State.Running}}' "$container_id")"
	if [[ "$running" == 'true' ]]; then
		docker stop --time 90 "$container_id" >/dev/null
	fi
	[[ "$(docker inspect --format '{{.State.Running}}' "$container_id")" == 'false' ]] ||
		die "Exact project service did not stop: $service_name"
	printf '%s' "$container_id"
}

if [[ "$deploy_mode" == 'cutover' ]]; then
	for legacy_service in "${legacy_core_services[@]}"; do
		legacy_container_id="$(stop_project_service_if_present "$legacy_service")"
		[[ -z "$legacy_container_id" ]] ||
			legacy_core_container_ids+=("$legacy_container_id")
	done

	# Reporting retry queues carry immutable DLX arguments. Stop the sole
	# consumer and delete only empty, unused queues so the apps-only owner can
	# recreate them with the terminal routing contract.
	stop_project_service_if_present reporting-service >/dev/null
	rabbitmq_container_id="$(compose_all ps --status running -q rabbitmq 2>/dev/null)"
	[[ -n "$rabbitmq_container_id" && "$rabbitmq_container_id" != *$'\n'* ]] ||
		die 'Exactly one running RabbitMQ container is required for terminal cutover.'
	reporting_retry_queues=(
		winwidget.reporting.settings.retry.1
		winwidget.reporting.settings.retry.2
		winwidget.reporting.settings.retry.3
	)
	queue_inventory="$(
		docker exec "$rabbitmq_container_id" rabbitmqctl --silent \
			list_queues -p winwidget name messages_ready messages_unacknowledged consumers
	)"
	for queue_name in "${reporting_retry_queues[@]}"; do
		queue_row="$(awk -v queue="$queue_name" '$1 == queue { print; count += 1 } END { if (count > 1) exit 1 }' <<<"$queue_inventory")" ||
			die 'Reporting retry queue inventory is ambiguous.'
		[[ -n "$queue_row" ]] || continue
		read -r _queue_name messages_ready messages_unacknowledged consumers <<<"$queue_row"
		[[ "$messages_ready" == '0' && "$messages_unacknowledged" == '0' &&
			"$consumers" == '0' ]] ||
			die "Reporting retry queue is not empty and unused: $queue_name"
		docker exec "$rabbitmq_container_id" rabbitmqctl delete_queue \
			-p winwidget "$queue_name" --if-empty --if-unused >/dev/null
	done
fi

notification_topology_contract="$(
	docker run --rm \
		--network none \
		--read-only \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=8m \
		--cap-drop ALL \
		--security-opt no-new-privileges \
		--pids-limit 32 \
		--log-driver none \
		--entrypoint node \
		"winwidget-notification-delivery:git-$services_revision" - <<'NOTIFICATION_TOPOLOGY'
const constants = require('./dist/src/messaging/messaging.constants.js');
const contract = {
	eventsExchange: constants.EVENTS_EXCHANGE,
	retryExchange: constants.RETRY_EXCHANGE,
	deadLetterExchange: constants.DEAD_LETTER_EXCHANGE,
	manualRetryExchange: constants.MANUAL_RETRY_EXCHANGE,
	queueNames: constants.MESSAGING_KINDS.map(
		kind => constants.MESSAGING_QUEUE_NAMES[kind]
	),
	retryCount: constants.RETRY_DELAYS_MS.length,
	readRoutingKeys: constants.MESSAGING_KINDS.flatMap(kind => [
		constants.MESSAGING_ROUTING_KEYS[kind],
		constants.getManualRetryRoutingKey(kind),
		constants.getDeadLetterRoutingKey(kind)
	]),
	writeRoutingKeys: [
		constants.TELEGRAM_DESTINATION_UNAVAILABLE_EVENT_TYPE,
		constants.NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
		constants.REPORTING_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
		constants.CAMPAIGN_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
		...constants.MESSAGING_KINDS.map(
			kind => constants.getManualRetryRoutingKey(kind)
		)
	],
	deadLetterRoutingKeys: constants.MESSAGING_KINDS.map(
		kind => constants.getDeadLetterRoutingKey(kind)
	)
};
if (
	contract.eventsExchange !== 'winwidget.events' ||
	contract.retryExchange !== 'winwidget.retry' ||
	contract.deadLetterExchange !== 'winwidget.dead-letter' ||
	contract.manualRetryExchange !== 'winwidget.manual-retry' ||
	contract.queueNames.length < 1 ||
	new Set(contract.queueNames).size !== contract.queueNames.length ||
	contract.queueNames.some(
		name => typeof name !== 'string' || !name.startsWith('winwidget.')
	) ||
	contract.retryCount !== 3 ||
	contract.readRoutingKeys.some(key => typeof key !== 'string' || !key) ||
	contract.writeRoutingKeys.some(key => typeof key !== 'string' || !key) ||
	contract.deadLetterRoutingKeys.some(
		key => typeof key !== 'string' || !key
	)
) {
	process.exit(1);
}
process.stdout.write(JSON.stringify(contract));
NOTIFICATION_TOPOLOGY
)" || die 'Notification Delivery topology contract extraction failed.'
[[ -n "$notification_topology_contract" ]] ||
	die 'Notification Delivery topology contract is empty.'

reporting_topology_contract="$(
	docker run --rm \
		--network none \
		--read-only \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=8m \
		--cap-drop ALL \
		--security-opt no-new-privileges \
		--pids-limit 32 \
		--log-driver none \
		--entrypoint node \
		"winwidget-reporting:git-$services_revision" - <<'REPORTING_TOPOLOGY'
const constants = require('./dist/src/messaging/reporting-messaging.constants.js');
const contract = {
	eventsExchange: constants.REPORTING_EVENTS_EXCHANGE,
	retryExchange: constants.REPORTING_RETRY_EXCHANGE,
	manualRetryExchange: constants.REPORTING_MANUAL_RETRY_EXCHANGE,
	deadLetterExchange: constants.REPORTING_DEAD_LETTER_EXCHANGE,
	queueNames: constants.REPORTING_CONSUMER_KINDS.map(
		kind => constants.REPORTING_QUEUE_NAMES[kind]
	),
	routingKeys: constants.REPORTING_CONSUMER_KINDS.map(
		kind => constants.REPORTING_ROUTING_KEYS[kind]
	),
	reportingSettingsQueue:
		constants.REPORTING_QUEUE_NAMES.reportingSettings,
	reportingSettingsRoutingKey:
		constants.REPORTING_ROUTING_KEYS.reportingSettings,
	retryCount: constants.REPORTING_RETRY_DELAYS_MS.length,
	writeRoutingKeys: [
		constants.DAILY_SUMMARY_NOTIFICATION_EVENT_TYPE,
		constants.REPORTING_ADMIN_AUDIT_ROUTING_KEY
	]
};
if (
	contract.eventsExchange !== 'winwidget.events' ||
	contract.retryExchange !== 'winwidget.reporting.retry' ||
	contract.manualRetryExchange !== 'winwidget.reporting.manual-retry' ||
	contract.deadLetterExchange !== 'winwidget.dead-letter' ||
	contract.reportingSettingsQueue !== 'winwidget.reporting.settings' ||
	contract.reportingSettingsRoutingKey !==
		'operations.notification-routing.changed.v1' ||
	contract.routingKeys.includes(
		'reporting.core-operational-routing.changed.v1'
	) ||
	contract.queueNames.length < 1 ||
	new Set(contract.queueNames).size !== contract.queueNames.length ||
	contract.queueNames.some(
		name => typeof name !== 'string' || !name.startsWith('winwidget.reporting.')
	) ||
	contract.routingKeys.some(key => typeof key !== 'string' || !key) ||
	contract.retryCount !== 3 ||
	contract.writeRoutingKeys.some(key => typeof key !== 'string' || !key)
) {
	process.exit(1);
}
process.stdout.write(JSON.stringify(contract));
REPORTING_TOPOLOGY
)" || die 'Reporting topology contract extraction failed.'
[[ -n "$reporting_topology_contract" ]] ||
	die 'Reporting topology contract is empty.'

rabbitmq_expected_user_names="$(
	docker run --rm \
		--network none \
		--read-only \
		--cap-drop ALL \
		--security-opt no-new-privileges \
		--pids-limit 32 \
		--log-driver none \
		--env-file "$env_file" \
		--entrypoint node \
		"winwidget-operations:git-$services_revision" - <<'RABBITMQ_EXPECTED_USERS'
const expectedServiceUsers = [
	'winwidget-notification-delivery',
	'winwidget-campaigns',
	'winwidget-reporting',
	'winwidget-widgets',
	'winwidget-billing-worker',
	'winwidget-billing-publisher',
	'winwidget-identity-worker',
	'winwidget-identity-publisher',
	'winwidget-platform-publisher',
	'winwidget-support-worker',
	'winwidget-support-publisher',
	'winwidget-operations-worker',
	'winwidget-operations-restore-worker',
	'winwidget-operations-publisher'
];
const admin = process.env.RABBITMQ_ADMIN_USER ?? '';
const monitor = process.env.RABBITMQ_MONITOR_USER ?? '';
const names = [admin, monitor, ...expectedServiceUsers];
if (
	names.some(name => !/^[A-Za-z0-9._-]+$/.test(name)) ||
	new Set(names).size !== names.length
) process.exit(1);
process.stdout.write(names.sort().join('\n'));
RABBITMQ_EXPECTED_USERS
)" || die 'Cannot extract the exact RabbitMQ user inventory contract.'
[[ -n "$rabbitmq_expected_user_names" ]] ||
	die 'RabbitMQ user inventory contract is empty.'

docker run --rm \
	--network host \
	--read-only \
	--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
	--cap-drop ALL \
	--security-opt no-new-privileges \
	--pids-limit 64 \
	--log-driver none \
	--env-file "$env_file" \
	--env "NOTIFICATION_TOPOLOGY_CONTRACT=$notification_topology_contract" \
	--env "REPORTING_TOPOLOGY_CONTRACT=$reporting_topology_contract" \
	--env "WINWIDGET_DEPLOY_MODE=$deploy_mode" \
	--entrypoint node \
	"winwidget-operations:git-$services_revision" - <<'PROVISION_RABBITMQ'
const amqp = require('amqplib');
const constants = require('./dist/src/messaging/operations-messaging.constants.js');

const fail = () => {
	throw new Error('RabbitMQ provisioning contract failed');
};
const value = name => process.env[name] ?? '';
const vhost = value('RABBITMQ_VHOST');
const managementUrl = value('RABBITMQ_MANAGEMENT_URL').replace(/\/$/, '');
const adminUser = value('RABBITMQ_ADMIN_USER');
const adminPassword = value('RABBITMQ_ADMIN_PASSWORD');
if (
	vhost !== 'winwidget' ||
	managementUrl !== 'http://127.0.0.1:15672' ||
	!/^[A-Za-z0-9._-]+$/.test(adminUser) ||
	adminPassword.length < 32 ||
	/[\0\r\n]/.test(adminPassword)
) fail();

const parseService = (name, expectedUsername) => {
	let url;
	try {
		url = new URL(value(name));
	} catch {
		fail();
	}
	let username;
	let password;
	let parsedVhost;
	try {
		username = decodeURIComponent(url.username);
		password = decodeURIComponent(url.password);
		parsedVhost = decodeURIComponent(url.pathname.slice(1));
	} catch {
		fail();
	}
	if (
		url.protocol !== 'amqp:' ||
		url.hostname !== '127.0.0.1' ||
		(url.port && url.port !== '5672') ||
		url.search ||
		url.hash ||
		username !== expectedUsername ||
		password.length < 32 ||
		password.startsWith('change_me') ||
		/[\0\r\n]/.test(password) ||
		parsedVhost !== vhost
	) fail();
	return { username, password };
};

const services = {
	notification: parseService(
		'RABBITMQ_NOTIFICATION_DELIVERY_URL',
		'winwidget-notification-delivery'
	),
	campaigns: parseService('RABBITMQ_CAMPAIGNS_URL', 'winwidget-campaigns'),
	reporting: parseService('RABBITMQ_REPORTING_URL', 'winwidget-reporting'),
	widgets: parseService('RABBITMQ_WIDGETS_URL', 'winwidget-widgets'),
	billingWorker: parseService(
		'RABBITMQ_BILLING_WORKER_URL',
		'winwidget-billing-worker'
	),
	billingPublisher: parseService(
		'RABBITMQ_BILLING_PUBLISHER_URL',
		'winwidget-billing-publisher'
	),
	identityWorker: parseService(
		'RABBITMQ_IDENTITY_WORKER_URL',
		'winwidget-identity-worker'
	),
	identityPublisher: parseService(
		'RABBITMQ_IDENTITY_PUBLISHER_URL',
		'winwidget-identity-publisher'
	),
	platformPublisher: parseService(
		'RABBITMQ_PLATFORM_PUBLISHER_URL',
		'winwidget-platform-publisher'
	),
	supportWorker: parseService(
		'RABBITMQ_SUPPORT_WORKER_URL',
		'winwidget-support-worker'
	),
	supportPublisher: parseService(
		'RABBITMQ_SUPPORT_PUBLISHER_URL',
		'winwidget-support-publisher'
	),
	operationsWorker: parseService(
		'RABBITMQ_OPERATIONS_WORKER_URL',
		'winwidget-operations-worker'
	),
	operationsRestoreWorker: parseService(
		'RABBITMQ_OPERATIONS_RESTORE_WORKER_URL',
		'winwidget-operations-restore-worker'
	),
	operationsPublisher: parseService(
		'RABBITMQ_OPERATIONS_PUBLISHER_URL',
		'winwidget-operations-publisher'
	)
};
const monitor = {
	username: value('RABBITMQ_MONITOR_USER'),
	password: value('RABBITMQ_MONITOR_PASSWORD')
};
if (
	!/^[A-Za-z0-9._-]+$/.test(monitor.username) ||
	monitor.password.length < 32 ||
	/[\0\r\n]/.test(monitor.password)
) fail();
const usernames = [
	adminUser,
	monitor.username,
	...Object.values(services).map(service => service.username)
];
if (new Set(usernames).size !== usernames.length) fail();

const authorization = `Basic ${Buffer.from(`${adminUser}:${adminPassword}`).toString('base64')}`;
const encoded = input => encodeURIComponent(input);
const request = async (path, options = {}, expected = [200, 201, 204]) => {
	const response = await fetch(`${managementUrl}${path}`, {
		...options,
		headers: {
			authorization,
			...(options.body ? { 'content-type': 'application/json' } : {})
		},
		redirect: 'error',
		signal: AbortSignal.timeout(10_000)
	});
	if (!expected.includes(response.status)) fail();
	if ([201, 204, 404].includes(response.status)) return null;
	return response.json();
};
const connect = async (username, password, connectionName) => {
	const connection = await amqp.connect(
		{
			protocol: 'amqp',
			hostname: '127.0.0.1',
			port: 5672,
			username,
			password,
			vhost,
			clientProperties: { connection_name: connectionName }
		},
		{ timeout: 10_000 }
	);
	await connection.close();
};

const auditSources = constants.OPERATIONS_AUDIT_SOURCES;
if (!Array.isArray(auditSources) || !auditSources.length) fail();
const auditQueueNames = auditSources.flatMap(source => [
	constants.getOperationsAuditQueue(source),
	constants.getOperationsAuditRetryQueue(source),
	constants.getOperationsAuditDeadLetterQueue(source)
]);
const exactQueuePattern = names =>
	`^(?:${names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;
let notificationTopology;
try {
	notificationTopology = JSON.parse(value('NOTIFICATION_TOPOLOGY_CONTRACT'));
} catch {
	fail();
}
if (
	!notificationTopology ||
	notificationTopology.eventsExchange !== 'winwidget.events' ||
	notificationTopology.retryExchange !== 'winwidget.retry' ||
	notificationTopology.deadLetterExchange !== 'winwidget.dead-letter' ||
	notificationTopology.manualRetryExchange !== 'winwidget.manual-retry' ||
	!Array.isArray(notificationTopology.queueNames) ||
	!Array.isArray(notificationTopology.readRoutingKeys) ||
	!Array.isArray(notificationTopology.writeRoutingKeys) ||
	!Array.isArray(notificationTopology.deadLetterRoutingKeys) ||
	notificationTopology.queueNames.length < 1 ||
	new Set(notificationTopology.queueNames).size !==
		notificationTopology.queueNames.length ||
	notificationTopology.queueNames.some(
		name => typeof name !== 'string' || !name.startsWith('winwidget.')
	) ||
	notificationTopology.readRoutingKeys.some(
		key => typeof key !== 'string' || !key
	) ||
	notificationTopology.writeRoutingKeys.some(
		key => typeof key !== 'string' || !key
	) ||
	notificationTopology.deadLetterRoutingKeys.some(
		key => typeof key !== 'string' || !key
	) ||
	notificationTopology.retryCount !== 3
) fail();
const notificationResourcePattern = exactQueuePattern([
	notificationTopology.eventsExchange,
	notificationTopology.retryExchange,
	notificationTopology.deadLetterExchange,
	notificationTopology.manualRetryExchange,
	...notificationTopology.queueNames.flatMap(queue => [
		queue,
		`${queue}.dead-letter`,
		...Array.from(
			{ length: notificationTopology.retryCount },
			(_, index) => `${queue}.retry-v2.${index + 1}`
		)
	])
]);
const notificationReadTopicPattern = exactQueuePattern(
	notificationTopology.readRoutingKeys
);
const notificationWriteTopicPattern = exactQueuePattern(
	notificationTopology.writeRoutingKeys
);
const notificationDeadLetterTopicPattern = exactQueuePattern(
	notificationTopology.deadLetterRoutingKeys
);
let reportingTopology;
try {
	reportingTopology = JSON.parse(value('REPORTING_TOPOLOGY_CONTRACT'));
} catch {
	fail();
}
if (
	!reportingTopology ||
	reportingTopology.eventsExchange !== 'winwidget.events' ||
	reportingTopology.retryExchange !== 'winwidget.reporting.retry' ||
	reportingTopology.manualRetryExchange !==
		'winwidget.reporting.manual-retry' ||
	reportingTopology.deadLetterExchange !== 'winwidget.dead-letter' ||
	reportingTopology.reportingSettingsQueue !==
		'winwidget.reporting.settings' ||
	reportingTopology.reportingSettingsRoutingKey !==
		'operations.notification-routing.changed.v1' ||
	!Array.isArray(reportingTopology.queueNames) ||
	!Array.isArray(reportingTopology.routingKeys) ||
	!Array.isArray(reportingTopology.writeRoutingKeys) ||
	reportingTopology.queueNames.length < 1 ||
	new Set(reportingTopology.queueNames).size !==
		reportingTopology.queueNames.length ||
	reportingTopology.routingKeys.includes(
		'reporting.core-operational-routing.changed.v1'
	) ||
	reportingTopology.queueNames.some(
		name =>
			typeof name !== 'string' ||
			!name.startsWith('winwidget.reporting.')
	) ||
	reportingTopology.routingKeys.some(
		key => typeof key !== 'string' || !key
	) ||
	reportingTopology.writeRoutingKeys.some(
		key => typeof key !== 'string' || !key
	) ||
	reportingTopology.retryCount !== 3
) fail();
const reportingReadTopicPattern = exactQueuePattern(
	reportingTopology.routingKeys
);
const reportingWriteTopicPattern = exactQueuePattern(
	reportingTopology.writeRoutingKeys
);
const auditQueuePattern = exactQueuePattern(auditQueueNames);
const operationsWorkerQueuePattern = exactQueuePattern([
	...auditQueueNames,
	constants.OPERATIONS_SCHEDULED_JOB_QUEUE,
	constants.OPERATIONS_SCHEDULED_JOB_RETRY_QUEUE,
	constants.OPERATIONS_SCHEDULED_JOB_DLQ
]);
const restoreQueuePattern = exactQueuePattern([
	constants.OPERATIONS_DATABASE_RESTORE_QUEUE,
	constants.OPERATIONS_DATABASE_RESTORE_RETRY_QUEUE,
	constants.OPERATIONS_DATABASE_RESTORE_DLQ
]);

const users = [
	{
		...services.notification,
		configure: notificationResourcePattern,
		write: notificationResourcePattern,
		read: notificationResourcePattern,
		topics: [
			{ exchange: 'winwidget.events', write: notificationWriteTopicPattern, read: notificationReadTopicPattern },
			{ exchange: 'winwidget.dead-letter', write: notificationDeadLetterTopicPattern, read: notificationDeadLetterTopicPattern }
		]
	},
	{
		...services.campaigns,
		configure: '^winwidget\\.campaigns(\\..*)?$',
		write: '^(winwidget\\.(events|dead-letter)|winwidget\\.campaigns(\\..*)?)$',
		read: '^(winwidget\\.(events|dead-letter)|winwidget\\.campaigns(\\..*)?)$',
		topics: [
			{ exchange: 'winwidget.events', write: '^(admin\\.audit\\.event\\.v1|campaign\\.snapshot\\.requested\\.v1|notification\\.campaign\\.(email|telegram)\\.requested\\.v2|notification\\.delivery\\.outcome\\.v2)$', read: '^(campaign\\.snapshot\\.requested\\.v1|notification\\.delivery\\.outcome\\.v2)$' },
			{ exchange: 'winwidget.dead-letter', write: '^campaigns\\.(snapshot|outcome)\\.dead-letter$', read: '^campaigns\\.(snapshot|outcome)\\.dead-letter$' }
		]
	},
	{
		...services.reporting,
		configure: '^winwidget\\.reporting(\\..*)?$',
		write: '^(winwidget\\.(events|dead-letter)|winwidget\\.reporting(\\..*)?)$',
		read: '^(winwidget\\.(events|dead-letter)|winwidget\\.reporting(\\..*)?)$',
		topics: [
			{ exchange: 'winwidget.events', write: reportingWriteTopicPattern, read: reportingReadTopicPattern },
			{ exchange: 'winwidget.dead-letter', write: '^reporting\\.(identityUser|billingPayment|billingSubscription|widget|lead|reportingSettings|deliveryOutcome)\\.dead-letter$', read: '^reporting\\.(identityUser|billingPayment|billingSubscription|widget|lead|reportingSettings|deliveryOutcome)\\.dead-letter$' }
		]
	},
	{
		...services.widgets,
		configure: '^(winwidget\\.widgets(\\..*)?|winwidget\\.lead-integration\\.(webhook|bitrix24|amo-crm)(\\.(dead-letter|retry\\.[1-3]))?)$',
		write: '^(winwidget\\.(events|dead-letter)|winwidget\\.widgets(\\..*)?|winwidget\\.lead-integration\\.(webhook|bitrix24|amo-crm)(\\.(dead-letter|retry\\.[1-3]))?)$',
		read: '^(winwidget\\.(events|dead-letter)|winwidget\\.widgets(\\..*)?|winwidget\\.lead-integration\\.(webhook|bitrix24|amo-crm)(\\.(dead-letter|retry\\.[1-3]))?)$',
		topics: [
			{ exchange: 'winwidget.events', write: '^(widgets\\.(widget|lead)\\.changed\\.v1|lead\\.(integration\\.(email|telegram|webhook|bitrix24|amo-crm)|limit\\.reached\\.(email|telegram))\\.v2|admin\\.audit\\.widgets\\.v1)$', read: '^(identity\\.user\\.changed\\.v1|billing\\.subscription\\.changed\\.v1|lead\\.integration\\.(webhook|bitrix24|amo-crm)\\.v2)$' },
			{ exchange: 'winwidget.dead-letter', write: '^widgets\\.(identity|entitlement|webhook|bitrix24|amo-crm)\\.dead-letter$', read: '^widgets\\.(identity|entitlement|webhook|bitrix24|amo-crm)\\.dead-letter$' }
		]
	},
	{
		...services.billingWorker,
		configure: '^winwidget\\.(billing\\.(retry|dead-letter)|billing\\.(identity|notification-routing|trial|referral|lifecycle-repair)\\.v1(\\.retry\\.[123]|\\.dead-letter)?|billing\\.offer\\.v2(\\.retry\\.[123]|\\.dead-letter)?|billing\\.notification-delivery-outcome(\\.retry\\.[123]|\\.dead-letter)?|payment\\.auto-renewal(\\.retry\\.[123]|\\.dead-letter)?)$',
		write: '^winwidget\\.(billing\\.(retry|dead-letter)|billing\\.(identity|notification-routing|trial|referral|lifecycle-repair)\\.v1(\\.retry\\.[123]|\\.dead-letter)?|billing\\.offer\\.v2(\\.retry\\.[123]|\\.dead-letter)?|billing\\.notification-delivery-outcome(\\.retry\\.[123]|\\.dead-letter)?|payment\\.auto-renewal(\\.retry\\.[123]|\\.dead-letter)?)$',
		read: '^winwidget\\.(events|billing\\.(retry|dead-letter)|billing\\.(identity|notification-routing|trial|referral|lifecycle-repair)\\.v1(\\.retry\\.[123]|\\.dead-letter)?|billing\\.offer\\.v2(\\.retry\\.[123]|\\.dead-letter)?|billing\\.notification-delivery-outcome(\\.retry\\.[123]|\\.dead-letter)?|payment\\.auto-renewal(\\.retry\\.[123]|\\.dead-letter)?)$',
		topics: [{ exchange: 'winwidget.events', write: '^$', read: '^(billing\\.identity\\.changed\\.v1|billing\\.notification-routing\\.changed\\.v1|billing\\.trial\\.requested\\.v1|billing\\.referral\\.requested\\.v1|billing\\.offer\\.changed\\.v2|billing\\.lifecycle-repair\\.requested\\.v1|payment\\.auto-renewal\\.charge\\.requested\\.v1|notification\\.delivery\\.outcome\\.v1)$' }]
	},
	{
		...services.billingPublisher,
		configure: '^$', write: '^winwidget\\.(events|billing\\.(retry|dead-letter))$', read: '^$',
		topics: [{ exchange: 'winwidget.events', write: '^(payment\\.succeeded\\.v1|payment\\.notification\\.telegram\\.requested\\.v1|payment\\.auto-renewal\\.charge\\.requested\\.v1|notification\\.subscription-expiry\\.(email|telegram)\\.requested\\.v1|billing\\.(payment|subscription)(\\.details)?\\.changed\\.v1|billing\\.(affiliate|settings)\\.changed\\.v1|admin\\.audit\\.billing\\.v1)$', read: '^$' }]
	},
	{
		...services.identityWorker,
		configure: '^(winwidget\\.(events|retry|dead-letter|manual-retry)|winwidget\\.notification\\.telegram-destination-unavailable(\\.dead-letter|\\.retry-v2\\.[123])?)$',
		write: '^winwidget\\.notification\\.telegram-destination-unavailable(\\.dead-letter|\\.retry-v2\\.[123])?$',
		read: '^(winwidget\\.(events|retry|dead-letter|manual-retry)|winwidget\\.notification\\.telegram-destination-unavailable(\\.dead-letter|\\.retry-v2\\.[123])?)$',
		topics: [
			{ exchange: 'winwidget.events', write: '^$', read: '^(notification\\.telegram\\.destination-unavailable\\.v1|manual\\.telegram-destination-unavailable|telegram-destination-unavailable\\.dead-letter)$' },
			{ exchange: 'winwidget.dead-letter', write: '^$', read: '^telegram-destination-unavailable\\.dead-letter$' }
		]
	},
	{
		...services.identityPublisher,
		configure: '^$', write: '^winwidget\\.(events|retry|dead-letter|manual-retry)$', read: '^$',
		topics: [
			{ exchange: 'winwidget.events', write: '^(identity\\.user\\.changed\\.v1|billing\\.(identity\\.changed|referral\\.requested|lifecycle-repair\\.requested)\\.v1|admin\\.audit\\.identity\\.v1)$', read: '^$' },
			{ exchange: 'winwidget.dead-letter', write: '^telegram-destination-unavailable\\.dead-letter$', read: '^$' }
		]
	},
	{
		...services.platformPublisher,
		configure: '^$', write: '^winwidget\\.events$', read: '^$',
		topics: [{ exchange: 'winwidget.events', write: '^(admin\\.audit\\.platform\\.v1|billing\\.offer\\.changed\\.v2)$', read: '^$' }]
	},
	{
		...services.supportWorker,
		configure: '^(winwidget\\.(events|retry|dead-letter|manual-retry)|winwidget\\.support\\.telegram-webhook\\.v1(\\.retry-v2\\.[123]|\\.dead-letter)?)$',
		write: '^winwidget\\.support\\.telegram-webhook\\.v1(\\.retry-v2\\.[123]|\\.dead-letter)?$',
		read: '^(winwidget\\.(events|retry|dead-letter|manual-retry)|winwidget\\.support\\.telegram-webhook\\.v1(\\.retry-v2\\.[123]|\\.dead-letter)?)$',
		topics: [{ exchange: 'winwidget.events', write: '^$', read: '^support\\.telegram\\.webhook-admitted\\.v1$' }]
	},
	{
		...services.supportPublisher,
		configure: '^$', write: '^winwidget\\.(events|retry|dead-letter|manual-retry)$', read: '^$',
		topics: [
			{ exchange: 'winwidget.events', write: '^(support\\.telegram\\.webhook-admitted\\.v1|admin\\.audit\\.support\\.v1)$', read: '^$' },
			{ exchange: 'winwidget.dead-letter', write: '^support-telegram-webhook\\.dead-letter$', read: '^$' }
		]
	},
	{
		...services.operationsWorker,
		configure: `^(winwidget\\.(events|retry|dead-letter|manual-retry)|${operationsWorkerQueuePattern.slice(1, -1)})$`,
		write: '^winwidget\\.(retry|dead-letter)$', read: operationsWorkerQueuePattern,
		topics: [{ exchange: 'winwidget.dead-letter', write: '^operations\\.admin\\.audit\\.[a-z0-9-]+\\.dead-letter\\.v1$', read: '^$' }]
	},
	{
		...services.operationsRestoreWorker,
		configure: restoreQueuePattern, write: '^$', read: restoreQueuePattern, topics: []
	},
	{
		...services.operationsPublisher,
		configure: '^$', write: '^winwidget\\.(events|manual-retry)$', read: '^$',
		topics: [{ exchange: 'winwidget.events', write: '^operations\\.[a-z0-9.-]+\\.v1$', read: '^$' }]
	},
	{
		...monitor,
		configure: '^$', write: '^$', read: '^$', topics: [], tags: 'monitoring'
	}
];

const provisionTopology = async () => {
	const connection = await amqp.connect({
		protocol: 'amqp', hostname: '127.0.0.1', port: 5672,
		username: adminUser, password: adminPassword, vhost,
		clientProperties: { connection_name: 'winwidget-infra-topology-owner' }
	}, { timeout: 10_000 });
	try {
		const channel = await connection.createChannel();
		try {
			await channel.assertExchange(constants.OPERATIONS_EVENTS_EXCHANGE, 'topic', { durable: true });
			await channel.assertExchange(constants.OPERATIONS_RETRY_EXCHANGE, 'direct', { durable: true });
			await channel.assertExchange(constants.OPERATIONS_DEAD_LETTER_EXCHANGE, 'topic', { durable: true });
			await channel.assertExchange(constants.OPERATIONS_MANUAL_RETRY_EXCHANGE, 'direct', { durable: true });
			for (const source of auditSources) {
				const queue = constants.getOperationsAuditQueue(source);
				const retryQueue = constants.getOperationsAuditRetryQueue(source);
				const dlq = constants.getOperationsAuditDeadLetterQueue(source);
				const deadKey = constants.getOperationsAuditDeadLetterRoutingKey(source);
				await channel.assertQueue(queue, { durable: true, arguments: { 'x-dead-letter-exchange': constants.OPERATIONS_DEAD_LETTER_EXCHANGE, 'x-dead-letter-routing-key': deadKey } });
				await channel.bindQueue(queue, constants.OPERATIONS_EVENTS_EXCHANGE, source.routingKey);
				await channel.bindQueue(queue, constants.OPERATIONS_MANUAL_RETRY_EXCHANGE, constants.getOperationsAuditManualRetryRoutingKey(source));
				await channel.assertQueue(retryQueue, { durable: true, arguments: { 'x-dead-letter-exchange': constants.OPERATIONS_EVENTS_EXCHANGE, 'x-dead-letter-routing-key': source.routingKey } });
				await channel.bindQueue(retryQueue, constants.OPERATIONS_RETRY_EXCHANGE, constants.getOperationsAuditRetryRoutingKey(source));
				await channel.assertQueue(dlq, { durable: true, arguments: { 'x-message-ttl': constants.OPERATIONS_AUDIT_DLQ_RETENTION_MS } });
				await channel.bindQueue(dlq, constants.OPERATIONS_DEAD_LETTER_EXCHANGE, deadKey);
			}
			const jobs = [
				[constants.OPERATIONS_SCHEDULED_JOB_QUEUE, constants.OPERATIONS_SCHEDULED_JOB_RETRY_QUEUE, constants.OPERATIONS_SCHEDULED_JOB_DLQ, constants.OPERATIONS_SCHEDULED_JOB_ROUTING_KEY],
				[constants.OPERATIONS_DATABASE_RESTORE_QUEUE, constants.OPERATIONS_DATABASE_RESTORE_RETRY_QUEUE, constants.OPERATIONS_DATABASE_RESTORE_DLQ, constants.OPERATIONS_DATABASE_RESTORE_ROUTING_KEY]
			];
			for (const [queue, retryQueue, dlq, routingKey] of jobs) {
				const retryKey = `${routingKey}.retry.v1`;
				const deadKey = `${routingKey}.dead-letter.v1`;
				await channel.assertQueue(queue, { durable: true, arguments: { 'x-dead-letter-exchange': constants.OPERATIONS_DEAD_LETTER_EXCHANGE, 'x-dead-letter-routing-key': deadKey } });
				await channel.bindQueue(queue, constants.OPERATIONS_EVENTS_EXCHANGE, routingKey);
				await channel.assertQueue(retryQueue, { durable: true, arguments: { 'x-dead-letter-exchange': constants.OPERATIONS_EVENTS_EXCHANGE, 'x-dead-letter-routing-key': routingKey } });
				await channel.bindQueue(retryQueue, constants.OPERATIONS_RETRY_EXCHANGE, retryKey);
				await channel.assertQueue(dlq, { durable: true, arguments: { 'x-message-ttl': constants.OPERATIONS_AUDIT_DLQ_RETENTION_MS } });
				await channel.bindQueue(dlq, constants.OPERATIONS_DEAD_LETTER_EXCHANGE, deadKey);
			}
		} finally {
			await channel.close();
		}
	} finally {
		await connection.close();
	}
};

const removeRetiredReportingBinding = async () => {
	if (value('WINWIDGET_DEPLOY_MODE') !== 'cutover') return;
	const exchange = 'winwidget.events';
	const queue = reportingTopology.reportingSettingsQueue;
	const retiredRoutingKey =
		'reporting.core-operational-routing.changed.v1';
	const basePath =
		`/api/bindings/${encoded(vhost)}/e/${encoded(exchange)}/q/${encoded(queue)}`;
	const bindings = await request(basePath, {}, [200, 404]);
	if (bindings !== null && !Array.isArray(bindings)) fail();
	const retired = (bindings ?? []).filter(
		binding =>
			binding?.source === exchange &&
			binding?.destination === queue &&
			binding?.destination_type === 'queue' &&
			binding?.routing_key === retiredRoutingKey
	);
	if (retired.length > 1) fail();
	for (const binding of retired) {
		if (
			typeof binding.properties_key !== 'string' ||
			!binding.properties_key
		) fail();
		await request(
			`${basePath}/${encoded(binding.properties_key)}`,
			{ method: 'DELETE' }
		);
	}
	const remaining = await request(basePath, {}, [200, 404]);
	if (
		(remaining ?? []).some(
			binding => binding?.routing_key === retiredRoutingKey
		)
	) fail();
};

(async () => {
	await connect(adminUser, adminPassword, 'winwidget-infra-admin-check');
	await request(`/api/vhosts/${encoded(vhost)}`, { method: 'PUT' });
	const exactAdminUser = await request(`/api/users/${encoded(adminUser)}`);
	const exactAdminTags = Array.isArray(exactAdminUser?.tags)
		? exactAdminUser.tags.join(',')
		: exactAdminUser?.tags;
	if (
		exactAdminUser?.name !== adminUser ||
		exactAdminTags !== 'administrator'
	) fail();
	const exactAdminPermission = await request(
		`/api/permissions/${encoded(vhost)}/${encoded(adminUser)}`
	);
	if (
		exactAdminPermission?.configure !== '.*' ||
		exactAdminPermission?.write !== '.*' ||
		exactAdminPermission?.read !== '.*'
	) fail();
	await provisionTopology();
	await removeRetiredReportingBinding();
	for (const user of users) {
		await request(`/api/users/${encoded(user.username)}`, {
			method: 'PUT',
			body: JSON.stringify({ password: user.password, tags: user.tags ?? '' })
		});
		const permissions = await request(`/api/users/${encoded(user.username)}/permissions`);
		if (!Array.isArray(permissions)) fail();
		for (const permission of permissions) {
			if (permission?.vhost === vhost) continue;
			await request(`/api/permissions/${encoded(permission.vhost)}/${encoded(user.username)}`, { method: 'DELETE' });
		}
		await request(`/api/permissions/${encoded(vhost)}/${encoded(user.username)}`, {
			method: 'PUT',
			body: JSON.stringify({ configure: user.configure, write: user.write, read: user.read })
		});
		const topics = await request(`/api/topic-permissions/${encoded(vhost)}/${encoded(user.username)}`, {}, [200, 404]);
		if (topics !== null && !Array.isArray(topics)) fail();
		for (const topic of topics ?? []) {
			await request(`/api/topic-permissions/${encoded(vhost)}/${encoded(user.username)}/${encoded(topic.exchange)}`, { method: 'DELETE' });
		}
		for (const topic of user.topics) {
			await request(`/api/topic-permissions/${encoded(vhost)}/${encoded(user.username)}`, { method: 'PUT', body: JSON.stringify(topic) });
		}
		const exactPermission = await request(
			`/api/permissions/${encoded(vhost)}/${encoded(user.username)}`
		);
		if (
			exactPermission?.configure !== user.configure ||
			exactPermission?.write !== user.write ||
			exactPermission?.read !== user.read
		) fail();
		const exactUser = await request(`/api/users/${encoded(user.username)}`);
		const exactTags = Array.isArray(exactUser?.tags)
			? exactUser.tags.join(',')
			: exactUser?.tags;
		if (exactUser?.name !== user.username || exactTags !== (user.tags ?? '')) fail();
		const exactTopics = await request(
			`/api/topic-permissions/${encoded(vhost)}/${encoded(user.username)}`,
			{},
			[200, 404]
		);
		const normalizedTopics = (exactTopics ?? [])
			.map(topic => ({ exchange: topic.exchange, write: topic.write, read: topic.read }))
			.sort((left, right) => left.exchange.localeCompare(right.exchange));
		const wantedTopics = [...user.topics]
			.sort((left, right) => left.exchange.localeCompare(right.exchange));
		if (JSON.stringify(normalizedTopics) !== JSON.stringify(wantedTopics)) fail();
		await connect(user.username, user.password, `winwidget-infra-${user.username}-check`);
	}
})().catch(() => {
	process.stderr.write('RabbitMQ service identity or topology provisioning failed.\n');
	process.exit(1);
});
PROVISION_RABBITMQ

for migration_service in "${migration_services[@]}"; do
	if ! compose_all run --rm --no-deps "$migration_service" >/dev/null 2>&1; then
		die "Production migration failed: $migration_service"
	fi
done

run_operations_cli() {
	compose_all run --rm --no-deps operations-api node "$@"
}

run_operations_cli_with_file() {
	local source_file="$1"
	local target_file="$2"
	shift 2
	compose_all run --rm --no-deps \
		--volume "$source_file:$target_file:ro" \
		operations-api node "$@"
}

verify_cutover_input_inventory() {
	local cutover_input_directory entry_path
	local -a cutover_input_entries=()
	cutover_input_directory="$(dirname "$operations_snapshot_file")"
	[[ "$cutover_input_directory" == "$(dirname "$control_plane_snapshot_file")" ]] ||
		die 'Operations cutover snapshots do not share the protected directory.'
	assert_root_owned_directory "$cutover_input_directory"
	mapfile -d '' -t cutover_input_entries < <(
		find "$cutover_input_directory" -xdev -mindepth 1 -maxdepth 1 -print0
	)
	[[ "${#cutover_input_entries[@]}" == '2' ]] ||
		die 'Protected cutover input directory must contain exactly two snapshots.'
	for entry_path in "${cutover_input_entries[@]}"; do
		[[ "$entry_path" == "$operations_snapshot_file" ||
			"$entry_path" == "$control_plane_snapshot_file" ]] ||
			die 'Protected cutover input directory contains an unexpected artifact.'
	done
}

verified_control_plane_event_id=''
verified_control_plane_source_revision=''
verify_control_plane_convergence() {
	local expected_sha256="$1"
	local expected_event_id="${2:-}"
	local expected_source_revision="${3:-}"
	local require_current_projection="${4:-false}"
	local operations_result event_id source_revision route_thread_id changed_at extra_field
	[[ "$expected_sha256" =~ ^[0-9a-f]{64}$ ]] ||
		die 'Control-plane convergence SHA-256 is invalid.'
	[[ -z "$expected_event_id" ||
		"$expected_event_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] ||
		die 'Control-plane convergence event ID is invalid.'
	[[ -z "$expected_source_revision" ||
		"$expected_source_revision" =~ ^[0-9a-f]{40}$ ]] ||
		die 'Control-plane convergence source revision is invalid.'
	[[ "$require_current_projection" == 'true' ||
		"$require_current_projection" == 'false' ]] ||
		die 'Control-plane convergence projection mode is invalid.'

	operations_result="$(
		compose_all run --rm --no-deps \
			--env "EXPECTED_CONTROL_PLANE_SHA256=$expected_sha256" \
			--env "REQUIRE_CURRENT_CONTROL_PLANE_PROJECTION=$require_current_projection" \
			operations-api node - <<'VERIFY_OPERATIONS_CONTROL_PLANE'
const {
	OutboxStatus,
	PrismaClient
} = require('@prisma/operations-client');
const constants = require('./dist/src/messaging/operations-messaging.constants.js');

const fail = () => {
	throw new Error('Operations control-plane convergence failed');
};
const sha256 = process.env.EXPECTED_CONTROL_PLANE_SHA256 ?? '';
const databaseUrl = process.env.OPERATIONS_DATABASE_URL ?? '';
const managementUrl = process.env.RABBITMQ_MANAGEMENT_URL ?? '';
const monitorUser = process.env.RABBITMQ_MONITOR_USER ?? '';
const monitorPassword = process.env.RABBITMQ_MONITOR_PASSWORD ?? '';
const vhost = process.env.RABBITMQ_VHOST ?? '';
const requireCurrentProjection =
	process.env.REQUIRE_CURRENT_CONTROL_PLANE_PROJECTION === 'true';
if (
	!/^[0-9a-f]{64}$/.test(sha256) ||
	!databaseUrl ||
	!managementUrl ||
	!monitorUser ||
	!monitorPassword ||
	!vhost
) fail();

const client = new PrismaClient({
	datasources: { db: { url: databaseUrl } }
});
const sleep = milliseconds =>
	new Promise(resolve => setTimeout(resolve, milliseconds));

(async () => {
	let converged;
	for (let attempt = 0; attempt < 30; attempt += 1) {
		const [state, outbox, settings] = await Promise.all([
			client.operationsControlPlaneBootstrapState.findUnique({
				where: { id: 'singleton' }
			}),
			client.outboxEvent.findUnique({
				where: {
					deduplicationKey: `operations-control-bootstrap-routing:${sha256}`
				}
			}),
			client.telegramBotSettings.findUnique({
				where: { id: 'singleton' },
				select: { operationalAlertsThreadId: true }
			})
		]);
		if (
			!state ||
			state.sourceSha256 !== sha256 ||
			!/^[0-9a-f]{40}$/.test(state.sourceRevision) ||
			(requireCurrentProjection && !settings)
		) fail();
		if (outbox?.status === OutboxStatus.PUBLISHED) {
			const payload = outbox.payload;
			if (
				!payload ||
				typeof payload !== 'object' ||
				Array.isArray(payload) ||
				JSON.stringify(Object.keys(payload).sort()) !==
					JSON.stringify([
						'changedAt',
						'eventId',
						'operationalAlertsThreadId',
						'schemaVersion'
					]) ||
				payload.schemaVersion !== 1 ||
				payload.eventId !== outbox.eventId ||
				(requireCurrentProjection &&
					payload.operationalAlertsThreadId !==
						settings.operationalAlertsThreadId) ||
				typeof payload.changedAt !== 'string' ||
				!Number.isFinite(Date.parse(payload.changedAt)) ||
				outbox.eventType !==
					constants.OPERATIONS_NOTIFICATION_ROUTING_CHANGED_EVENT_TYPE ||
				outbox.routingKey !==
					constants.OPERATIONS_NOTIFICATION_ROUTING_CHANGED_ROUTING_KEY ||
				!outbox.publishedAt
			) fail();
			converged = {
				eventId: outbox.eventId,
				sourceRevision: state.sourceRevision,
				routeThreadId: payload.operationalAlertsThreadId,
				changedAt: payload.changedAt
			};
			break;
		}
		await sleep(2000);
	}
	if (!converged) fail();

	const base = new URL(managementUrl);
	const bindingUrl = new URL(
		`/api/bindings/${encodeURIComponent(vhost)}/e/${encodeURIComponent('winwidget.events')}/q/${encodeURIComponent('winwidget.reporting.settings')}`,
		base
	);
	const response = await fetch(bindingUrl, {
		headers: {
			authorization: `Basic ${Buffer.from(`${monitorUser}:${monitorPassword}`).toString('base64')}`
		},
		redirect: 'error',
		signal: AbortSignal.timeout(10000)
	});
	if (!response.ok) fail();
	const bindings = await response.json();
	if (!Array.isArray(bindings)) fail();
	const current = bindings.filter(
		binding =>
			binding?.source === 'winwidget.events' &&
			binding?.destination === 'winwidget.reporting.settings' &&
			binding?.destination_type === 'queue' &&
			binding?.routing_key ===
				'operations.notification-routing.changed.v1'
	);
	const retired = bindings.filter(
		binding =>
			binding?.source === 'winwidget.events' &&
			binding?.destination === 'winwidget.reporting.settings' &&
			binding?.destination_type === 'queue' &&
			binding?.routing_key ===
				'reporting.core-operational-routing.changed.v1'
	);
	if (current.length !== 1 || retired.length !== 0) fail();

	process.stdout.write(
		`${converged.eventId}|${converged.sourceRevision}|${converged.routeThreadId === null ? 'null' : converged.routeThreadId}|${converged.changedAt}`
	);
})()
	.catch(() => {
		process.stderr.write(
			'Operations control-plane convergence verification failed.\n'
		);
		process.exitCode = 1;
	})
	.finally(async () => {
		await client.$disconnect();
	});
VERIFY_OPERATIONS_CONTROL_PLANE
	)" || die 'Operations control-plane convergence verification failed.'
	[[ -n "$operations_result" && "$operations_result" != *$'\n'* ]] ||
		die 'Operations control-plane convergence result is malformed.'
	IFS='|' read -r event_id source_revision route_thread_id changed_at extra_field <<<"$operations_result"
	[[ "$event_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ &&
		"$source_revision" =~ ^[0-9a-f]{40}$ &&
		("$route_thread_id" == 'null' || "$route_thread_id" =~ ^[1-9][0-9]*$) &&
		"$changed_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T &&
		-z "$extra_field" ]] ||
		die 'Operations control-plane convergence result is invalid.'
	[[ -z "$expected_event_id" || "$event_id" == "$expected_event_id" ]] ||
		die 'Operations bootstrap event differs from the terminal marker.'
	[[ -z "$expected_source_revision" ||
		"$source_revision" == "$expected_source_revision" ]] ||
		die 'Operations bootstrap source revision differs from the terminal marker.'

	compose_all run --rm --no-deps \
		--env "EXPECTED_CONTROL_PLANE_EVENT_ID=$event_id" \
		--env "EXPECTED_CONTROL_PLANE_ROUTE_THREAD_ID=$route_thread_id" \
		--env "EXPECTED_CONTROL_PLANE_CHANGED_AT=$changed_at" \
		--env "REQUIRE_CURRENT_CONTROL_PLANE_PROJECTION=$require_current_projection" \
		reporting-service node - <<'VERIFY_REPORTING_CONTROL_PLANE' >/dev/null
const { PrismaClient } = require('@prisma/reporting-client');

const fail = () => {
	throw new Error('Reporting control-plane convergence failed');
};
const eventId = process.env.EXPECTED_CONTROL_PLANE_EVENT_ID ?? '';
const routeThreadRaw =
	process.env.EXPECTED_CONTROL_PLANE_ROUTE_THREAD_ID ?? '';
const changedAt = process.env.EXPECTED_CONTROL_PLANE_CHANGED_AT ?? '';
const databaseUrl = process.env.REPORTING_DATABASE_URL ?? '';
const requireCurrentProjection =
	process.env.REQUIRE_CURRENT_CONTROL_PLANE_PROJECTION === 'true';
if (
	!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(eventId) ||
	!(routeThreadRaw === 'null' || /^[1-9][0-9]*$/.test(routeThreadRaw)) ||
	!Number.isFinite(Date.parse(changedAt)) ||
	!databaseUrl
) fail();
const routeThreadId =
	routeThreadRaw === 'null' ? null : Number(routeThreadRaw);
if (routeThreadId !== null && !Number.isSafeInteger(routeThreadId)) fail();
const client = new PrismaClient({
	datasources: { db: { url: databaseUrl } }
});
const sleep = milliseconds =>
	new Promise(resolve => setTimeout(resolve, milliseconds));

(async () => {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		const [receipt, settings] = await Promise.all([
			client.consumerReceipt.findUnique({
				where: {
					eventId_consumer: {
						eventId,
						consumer: 'reporting-settings-v1'
					}
				}
			}),
			client.reportingSettings.findUnique({
				where: { id: 'daily-summary' },
				select: {
					operationalAlertsThreadId: true,
					operationalAlertsChangedAt: true
				}
			})
		]);
		if (receipt?.status === 'DEAD_LETTERED') fail();
		if (receipt?.status === 'DELIVERED' && receipt.deliveredAt) {
			if (
				!requireCurrentProjection ||
				(settings?.operationalAlertsThreadId === routeThreadId &&
					settings.operationalAlertsChangedAt?.toISOString() ===
						new Date(changedAt).toISOString())
			) return;
		}
		await sleep(2000);
	}
	fail();
})()
	.catch(() => {
		process.stderr.write(
			'Reporting control-plane convergence verification failed.\n'
		);
		process.exitCode = 1;
	})
	.finally(async () => {
		await client.$disconnect();
	});
VERIFY_REPORTING_CONTROL_PLANE

	verified_control_plane_event_id="$event_id"
	verified_control_plane_source_revision="$source_revision"
}

terminal_marker_cutover_revision=''
terminal_marker_operations_sha256=''
terminal_marker_control_plane_sha256=''
terminal_marker_source_revision=''
terminal_marker_event_id=''
validate_terminal_cutover_marker() {
	local -a marker_lines=()
	[[ -f "$terminal_cutover_marker" && ! -L "$terminal_cutover_marker" &&
		"$(realpath -e "$terminal_cutover_marker")" ==
			"$terminal_cutover_marker" &&
		"$(stat -c '%u:%g:%a:%h' "$terminal_cutover_marker")" ==
			'0:0:600:1' ]] || return 1
	mapfile -t marker_lines <"$terminal_cutover_marker"
	[[ "${#marker_lines[@]}" == '7' &&
		"${marker_lines[0]}" == 'version=1' ]] || return 1
	[[ "${marker_lines[1]}" =~ ^cutover_services_revision=([0-9a-f]{40})$ ]] ||
		return 1
	terminal_marker_cutover_revision="${BASH_REMATCH[1]}"
	[[ "${marker_lines[2]}" =~ ^operations_snapshot_sha256=([0-9a-f]{64})$ ]] ||
		return 1
	terminal_marker_operations_sha256="${BASH_REMATCH[1]}"
	[[ "${marker_lines[3]}" =~ ^control_plane_snapshot_sha256=([0-9a-f]{64})$ ]] ||
		return 1
	terminal_marker_control_plane_sha256="${BASH_REMATCH[1]}"
	[[ "${marker_lines[4]}" =~ ^control_plane_source_revision=([0-9a-f]{40})$ ]] ||
		return 1
	terminal_marker_source_revision="${BASH_REMATCH[1]}"
	[[ "${marker_lines[5]}" =~ ^bootstrap_event_id=([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$ ]] ||
		return 1
	terminal_marker_event_id="${BASH_REMATCH[1]}"
	[[ "${marker_lines[6]}" ==
		'core_system_identifier=7668360958158979115' ]] || return 1
}

write_terminal_cutover_marker() {
	local marker_tmp
	[[ "$deploy_mode" == 'cutover' &&
		"$operations_snapshot_sha256" =~ ^[0-9a-f]{64}$ &&
		"$control_plane_snapshot_sha256" =~ ^[0-9a-f]{64}$ &&
		"$verified_control_plane_source_revision" =~ ^[0-9a-f]{40}$ &&
		"$verified_control_plane_event_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ &&
		! -e "$terminal_cutover_marker" && ! -L "$terminal_cutover_marker" ]] ||
		die 'Terminal cutover marker cannot be created safely.'
	marker_tmp="$(mktemp "$deploy_state_directory/.microservices-terminal-cutover.XXXXXX")"
	if ! {
		printf '%s\n' \
			'version=1' \
			"cutover_services_revision=$services_revision" \
			"operations_snapshot_sha256=$operations_snapshot_sha256" \
			"control_plane_snapshot_sha256=$control_plane_snapshot_sha256" \
			"control_plane_source_revision=$verified_control_plane_source_revision" \
			"bootstrap_event_id=$verified_control_plane_event_id" \
			'core_system_identifier=7668360958158979115' >"$marker_tmp" &&
			chown 0:0 "$marker_tmp" &&
			chmod 600 "$marker_tmp" &&
			sync -f "$marker_tmp" &&
			mv -f -- "$marker_tmp" "$terminal_cutover_marker" &&
			sync -f "$deploy_state_directory" &&
			validate_terminal_cutover_marker
	}; then
		rm -f -- "$marker_tmp"
		if [[ -f "$terminal_cutover_marker" &&
			! -L "$terminal_cutover_marker" ]]; then
			rm -f -- "$terminal_cutover_marker" ||
				die 'Invalid terminal cutover marker could not be removed.'
			sync -f "$deploy_state_directory" ||
				die 'Terminal cutover marker cleanup could not be synchronized.'
		fi
		die 'Terminal cutover marker could not be written and verified.'
	fi
}

cleanup_terminal_snapshot_artifacts() {
	local cutover_input_directory legacy_operations_snapshot_root entry_path
	local expected_snapshot_sha256 snapshot_name
	validate_terminal_cutover_marker ||
		die 'Terminal marker is required for snapshot cleanup.'
	cutover_input_directory="$(dirname "$operations_snapshot_file")"
	if [[ -e "$cutover_input_directory" || -L "$cutover_input_directory" ]]; then
		assert_root_owned_directory "$cutover_input_directory"
		while IFS= read -r -d '' entry_path; do
			case "$entry_path" in
				"$operations_snapshot_file")
					expected_snapshot_sha256="$terminal_marker_operations_sha256"
					;;
				"$control_plane_snapshot_file")
					expected_snapshot_sha256="$terminal_marker_control_plane_sha256"
					;;
				*) die 'Protected cutover input contains an unexpected artifact.' ;;
			esac
			[[ -f "$entry_path" && ! -L "$entry_path" &&
				"$(realpath -e "$entry_path")" == "$entry_path" &&
				"$(stat -c '%u:%g:%a:%h' "$entry_path")" == '0:0:600:1' &&
				"$(sha256sum "$entry_path" | awk '{print $1}')" ==
					"$expected_snapshot_sha256" ]] ||
				die 'Protected cutover snapshot differs from the terminal marker.'
		done < <(find "$cutover_input_directory" -xdev -mindepth 1 -maxdepth 1 -print0)
		for entry_path in \
			"$operations_snapshot_file" \
			"$control_plane_snapshot_file"; do
			[[ ! -e "$entry_path" && ! -L "$entry_path" ]] ||
				rm -f -- "$entry_path"
		done
		rmdir "$cutover_input_directory" 2>/dev/null ||
			die 'Protected cutover input directory is not empty after cleanup.'
	fi

	legacy_operations_snapshot_root="$app_root/deploy/backend/operations-cutover"
	if [[ -e "$legacy_operations_snapshot_root" ||
		-L "$legacy_operations_snapshot_root" ]]; then
		[[ -d "$legacy_operations_snapshot_root" &&
			! -L "$legacy_operations_snapshot_root" &&
			"$(realpath -e "$legacy_operations_snapshot_root")" ==
				"$legacy_operations_snapshot_root" &&
			"$(stat -c '%u:%g:%a' "$legacy_operations_snapshot_root")" ==
				'0:1001:770' &&
			"$(stat -c '%d' "$legacy_operations_snapshot_root")" ==
				"$(stat -c '%d' "$deploy_state_directory")" ]] ||
			die 'Legacy Operations snapshot root differs from the live reviewed contract.'
		while IFS= read -r -d '' entry_path; do
			snapshot_name="$(basename "$entry_path")"
			[[ "$snapshot_name" =~ ^operations-[0-9a-f]{40}\.json$ &&
				-f "$entry_path" && ! -L "$entry_path" &&
				"$(realpath -e "$entry_path")" == "$entry_path" &&
				"$(stat -c '%u:%g:%a:%h' "$entry_path")" ==
					'1001:1001:600:1' &&
				"$(stat -c '%d' "$entry_path")" ==
					"$(stat -c '%d' "$legacy_operations_snapshot_root")" &&
				"$(sha256sum "$entry_path" | awk '{print $1}')" ==
					"$terminal_marker_operations_sha256" ]] ||
				die 'Legacy Operations snapshot differs from the terminal marker.'
		done < <(find "$legacy_operations_snapshot_root" -xdev -mindepth 1 -maxdepth 1 -print0)
		find "$legacy_operations_snapshot_root" -xdev -mindepth 1 -maxdepth 1 \
			-type f -name 'operations-*.json' -delete
		rmdir "$legacy_operations_snapshot_root" 2>/dev/null ||
			die 'Legacy Operations snapshot directory is not empty after cleanup.'
	fi
}

verify_terminal_cutover_state() {
	local rabbitmq_container_id queue_name actual_rabbitmq_user_names
	local remaining_legacy_queues listener_inventory retired_service entry_path
	local retired_container_id core_container_id
	local -a legacy_queue_names=()
	local -a legacy_rabbitmq_users=(
		winwidget-publisher
		winwidget-integration
		winwidget-maintenance
	)
	local -a retired_compose_services=(
		api
		outbox-publisher
		integration-worker
		maintenance-worker
		database-restore-worker
		migrate
	)
	validate_terminal_cutover_marker ||
		die 'Terminal microservices cutover marker is invalid.'
	verify_control_plane_convergence \
		"$terminal_marker_control_plane_sha256" \
		"$terminal_marker_event_id" \
		"$terminal_marker_source_revision"

	rabbitmq_container_id="$(compose_all ps --status running -q rabbitmq 2>/dev/null)"
	[[ -n "$rabbitmq_container_id" && "$rabbitmq_container_id" != *$'\n'* ]] ||
		die 'Exactly one running RabbitMQ container is required for terminal verification.'
	for source in campaigns reporting widgets billing identity platform support; do
		for suffix in '' .retry-v2.1 .retry-v2.2 .retry-v2.3 .dead-letter; do
			legacy_queue_names+=("winwidget.admin.audit.$source.v1$suffix")
		done
	done
	legacy_queue_names+=(
		winwidget.operations.admin.audit.core.v1
		winwidget.operations.admin.audit.core.v1.retry-v1
		winwidget.operations.admin.audit.core.v1.dead-letter
	)
	for base in \
		winwidget.core.billing.payment-details.v1 \
		winwidget.core.billing.subscription-details.v1 \
		winwidget.core.billing.affiliate.v1 \
		winwidget.maintenance.database-backup \
		winwidget.notification.delivery-outcome; do
		for suffix in '' .retry-v2.1 .retry-v2.2 .retry-v2.3 .dead-letter; do
			legacy_queue_names+=("$base$suffix")
		done
	done
	legacy_queue_names+=(
		winwidget.core.billing.settings.v1
		winwidget.core.billing.settings.v1.retry-v2.1
		winwidget.core.billing.settings.v1.retry-v2.2
		winwidget.core.billing.settings.v1.retry-v2.3
		winwidget.core.billing.settings.v1.dead-letter
	)
	for base in \
		winwidget.billing.offer.v1 \
		winwidget.billing.settings-source.v1; do
		for suffix in '' .retry.1 .retry.2 .retry.3 .dead-letter; do
			legacy_queue_names+=("$base$suffix")
		done
	done
	remaining_legacy_queues="$(
		docker exec "$rabbitmq_container_id" rabbitmqctl --silent \
			list_queues -p winwidget name
	)" || die 'Cannot verify the terminal RabbitMQ queue inventory.'
	for queue_name in "${legacy_queue_names[@]}"; do
		if awk -v queue="$queue_name" \
			'$1 == queue { found = 1 } END { exit(found ? 0 : 1) }' \
			<<<"$remaining_legacy_queues"; then
			die "Legacy RabbitMQ queue remains after terminal cutover: $queue_name"
		fi
	done
	actual_rabbitmq_user_names="$(
		docker exec "$rabbitmq_container_id" rabbitmqctl --silent list_users |
			awk 'NF { print $1 }' | LC_ALL=C sort
	)" || die 'Cannot verify the terminal RabbitMQ user inventory.'
	[[ "$actual_rabbitmq_user_names" == "$rabbitmq_expected_user_names" ]] ||
		die 'RabbitMQ user inventory differs from the exact apps-only contract.'
	for legacy_user in "${legacy_rabbitmq_users[@]}"; do
		if grep -Fqx -- "$legacy_user" <<<"$actual_rabbitmq_user_names"; then
			die "Legacy RabbitMQ user remains after terminal cutover: $legacy_user"
		fi
	done
	for retired_service in "${retired_compose_services[@]}"; do
		retired_container_id="$(find_project_service_container "$retired_service")"
		[[ -z "$retired_container_id" ]] ||
			die "Retired Compose container remains after terminal cutover: $retired_service"
	done

	core_container_id="$(
		find_exact_named_container winwidget-core-postgres-temporary
	)"
	[[ -z "$core_container_id" ]] ||
		die 'Temporary Core PostgreSQL container remains after terminal cutover.'
	! docker_volume_exists winwidget-core-postgres-temporary-data ||
		die 'Temporary Core PostgreSQL volume remains after terminal cutover.'
	for entry_path in \
		"$app_root/deploy/backend/.core-postgres-temporary-admin-password" \
		"$app_root/deploy/backend/.core-terminal-cleanup-v1" \
		"$app_root/deploy/backend/.database-restore-control-v1" \
		"$app_root/deploy/backend/database-restores" \
		"$app_root/deploy/backend/cutover-input" \
		"$app_root/deploy/backend/operations-cutover" \
		"$app_root/restore-staging/core-20260730" \
		"$app_root/restore-staging/core-cutover-20260731"; do
		[[ ! -e "$entry_path" && ! -L "$entry_path" ]] ||
			die 'A protected legacy Core/restore artifact remains after terminal cutover.'
	done

	command -v ss >/dev/null 2>&1 ||
		die 'The ss utility is required to prove retired Core port absence.'
	listener_inventory="$(ss -ltnH 2>/dev/null)" ||
		die 'Cannot read the production TCP listener inventory.'
	if awk '$4 ~ /:4200$/ { found = 1 } END { exit(found ? 0 : 1) }' \
		<<<"$listener_inventory"; then
		die 'A listener remains on the retired Core port 4200.'
	fi
}

if [[ "$deploy_mode" == 'cutover' ]]; then
	verify_cutover_input_inventory
	for snapshot_file in "$operations_snapshot_file" "$control_plane_snapshot_file"; do
		[[ -f "$snapshot_file" && ! -L "$snapshot_file" ]] ||
			die 'A protected Operations cutover snapshot is missing.'
		[[ "$(stat -c '%u:%g:%a:%h' "$snapshot_file")" == '0:0:600:1' ]] ||
			die 'Operations cutover snapshots must be root:root mode 0600.'
	done
	[[ "$(sha256sum "$operations_snapshot_file" | awk '{print $1}')" == "$operations_snapshot_sha256" ]] ||
		die 'Operations snapshot differs from its approved SHA-256.'
	[[ "$(sha256sum "$control_plane_snapshot_file" | awk '{print $1}')" == "$control_plane_snapshot_sha256" ]] ||
		die 'Operations control-plane snapshot differs from its approved SHA-256.'

	run_operations_cli_with_file \
		"$operations_snapshot_file" \
		/run/winwidget/operations.snapshot.json \
		dist/src/cutover/main.js import \
		--file /run/winwidget/operations.snapshot.json \
		--sha256 "$operations_snapshot_sha256" \
		>/dev/null
	run_operations_cli \
		dist/src/cutover/main.js activate \
		--sha256 "$operations_snapshot_sha256" >/dev/null
	run_operations_cli_with_file \
		"$control_plane_snapshot_file" \
		/run/winwidget/operations-control-plane.snapshot.json \
		dist/src/cutover/control-plane-bootstrap.js \
		--file /run/winwidget/operations-control-plane.snapshot.json \
		--sha256 "$control_plane_snapshot_sha256" \
		>/dev/null
fi

operations_status="$(
	run_operations_cli dist/src/cutover/main.js status 2>/dev/null
)" || die 'Cannot verify Operations ownership after migrations.'
if [[ "$deploy_mode" == 'cutover' ]]; then
	expected_operations_snapshot_sha256="$operations_snapshot_sha256"
	expected_operations_source_revision=''
else
	validate_terminal_cutover_marker ||
		die 'Routine deployment terminal marker is invalid.'
	expected_operations_snapshot_sha256="$terminal_marker_operations_sha256"
	expected_operations_source_revision="$terminal_marker_source_revision"
fi
operations_status_pattern='^\{"phase":"ACTIVE","sourceRevision":"([0-9a-f]{40})","snapshotSha256":"'"$expected_operations_snapshot_sha256"'","notes":[0-9]+,"adminEventLogs":[0-9]+\}$'
[[ "$operations_status" =~ $operations_status_pattern ]] ||
	die 'Operations ownership does not match the exact ACTIVE snapshot contract.'
operations_status_source_revision="${BASH_REMATCH[1]}"
[[ -z "$expected_operations_source_revision" ||
	"$operations_status_source_revision" ==
		"$expected_operations_source_revision" ]] ||
	die 'Operations ownership source revision differs from the terminal marker.'

compose_all up -d --no-build --force-recreate "${runtime_without_gateway[@]}"
wait_for_healthy_services "${runtime_without_gateway[@]}"
compose_all up -d --no-build --force-recreate operations-restore-worker
wait_for_healthy_services operations-restore-worker
compose_all up -d --no-build --force-recreate api-gateway
wait_for_healthy_services "${runtime_services[@]}"

for service_name in "${runtime_services[@]}"; do
	container_id="$(compose_all ps --status running -q "$service_name" 2>/dev/null)"
	case "$service_name" in
		api-gateway) expected_image="winwidget-api-gateway:git-$services_revision" ;;
		notification-delivery-worker) expected_image="winwidget-notification-delivery:git-$services_revision" ;;
		campaigns-service) expected_image="winwidget-campaigns:git-$services_revision" ;;
		reporting-service) expected_image="winwidget-reporting:git-$services_revision" ;;
		widgets-service) expected_image="winwidget-widgets:git-$services_revision" ;;
		billing-*) expected_image="winwidget-billing:git-$services_revision" ;;
		identity-*) expected_image="winwidget-identity:git-$services_revision" ;;
		platform-*) expected_image="winwidget-platform:git-$services_revision" ;;
		support-*) expected_image="winwidget-support:git-$services_revision" ;;
		operations-*) expected_image="winwidget-operations:git-$services_revision" ;;
		*) die 'Unexpected runtime service in image verification.' ;;
	esac
	container_image="$(docker inspect --format '{{.Config.Image}}' "$container_id" 2>/dev/null)" ||
		die "Cannot verify runtime image: $service_name"
	[[ "$container_image" == "$expected_image" ]] ||
		die "Runtime image differs from requested commit: $service_name"
	container_image_id="$(docker inspect --format '{{.Image}}' "$container_id" 2>/dev/null)" ||
		die "Cannot verify runtime image ID: $service_name"
	expected_image_id="${built_image_ids[$expected_image]:-}"
	[[ -n "$expected_image_id" && "$container_image_id" == "$expected_image_id" ]] ||
		die "Runtime image ID differs from the verified immutable build: $service_name"
done

wait_for_http_ok() {
	local url="$1"
	local _attempt
	for _attempt in {1..30}; do
		if curl --fail --silent --max-time 10 "$url" >/dev/null 2>&1; then
			return 0
		fi
		sleep 2
	done
	return 1
}

wait_for_http_revision() {
	local url="$1"
	local expected_revision="$2"
	local _attempt response
	for _attempt in {1..30}; do
		response="$(curl --fail --silent --max-time 10 "$url" 2>/dev/null || true)"
		if [[ "$response" =~ \"revision\"[[:space:]]*:[[:space:]]*\"$expected_revision\" ]]; then
			return 0
		fi
		sleep 2
	done
	return 1
}

verify_retired_core_public_routes_absent() {
	local uploads_status
	uploads_status="$(
		curl --silent --output /dev/null --write-out '%{http_code}' \
			--max-time 10 \
			'https://api.winwidget.ru/uploads/.winwidget-retired-core-probe'
	)" || return 1
	[[ "$uploads_status" == '404' ]]
}

verify_telegram_proxy_health() {
	compose_all run --rm --no-deps operations-worker node - \
		<<'VERIFY_TELEGRAM_PROXY_HEALTH' >/dev/null
(async () => {
	const response = await fetch(
		'https://tg.winwidget.ru/telegram-api-health',
		{
			redirect: 'manual',
			signal: AbortSignal.timeout(15000)
		}
	);
	if (
		response.status < 200 ||
		response.status >= 500 ||
		response.headers.get('x-winwidget-telegram-proxy') !== 'active'
	) throw new Error('Telegram proxy health contract failed');
	await response.body?.cancel();
})().catch(() => {
	process.stderr.write('Telegram proxy health verification failed.\n');
	process.exit(1);
});
VERIFY_TELEGRAM_PROXY_HEALTH
}

install_and_verify_backend_nginx() {
	local nginx_available_dir='/etc/nginx/sites-available'
	local nginx_enabled_dir='/etc/nginx/sites-enabled'
	local nginx_target='/etc/nginx/sites-available/api.winwidget.ru'
	local nginx_link='/etc/nginx/sites-enabled/api.winwidget.ru'
	local nginx_candidate nginx_backup current_sha256
	assert_root_owned_directory "$nginx_available_dir"
	assert_root_owned_directory "$nginx_enabled_dir"
	[[ -f "$nginx_target" && ! -L "$nginx_target" &&
		"$(realpath -e "$nginx_target")" == "$nginx_target" &&
		"$(stat -c '%u:%g:%a:%h' "$nginx_target")" == '0:0:644:1' ]] ||
		die 'Live backend Nginx config metadata is unsafe.'
	[[ -L "$nginx_link" && "$(readlink "$nginx_link")" == "$nginx_target" ]] ||
		die 'Live backend Nginx enabled symlink is not the exact reviewed target.'
	command -v nginx >/dev/null 2>&1 ||
		die 'Nginx is required on the backend VPS.'
	command -v systemctl >/dev/null 2>&1 &&
		systemctl is-active --quiet nginx ||
		die 'Backend Nginx systemd service is not active.'
	current_sha256="$(sha256sum "$nginx_target" | awk '{print $1}')"
	if [[ "$current_sha256" != "$backend_nginx_sha256" ]]; then
		nginx_candidate="$(mktemp "$nginx_available_dir/.api.winwidget.ru.candidate.XXXXXX")"
		nginx_backup="$(mktemp "$nginx_available_dir/.api.winwidget.ru.backup.XXXXXX")"
		if ! {
			printf '%s' "$backend_nginx_base64" |
				base64 --decode >"$nginx_candidate" &&
			[[ "$(sha256sum "$nginx_candidate" | awk '{print $1}')" ==
				"$backend_nginx_sha256" ]] &&
			chown 0:0 "$nginx_candidate" &&
			chmod 644 "$nginx_candidate" &&
			cp --reflink=auto --preserve=all -- "$nginx_target" "$nginx_backup" &&
			[[ "$(stat -c '%u:%g:%a:%h' "$nginx_backup")" == '0:0:644:1' ]] &&
			sync -f "$nginx_candidate" &&
			sync -f "$nginx_backup"
		}; then
			rm -f -- "$nginx_candidate" "$nginx_backup"
			die 'Cannot stage the apps-only backend Nginx config safely.'
		fi
		if ! mv -f -- "$nginx_candidate" "$nginx_target" ||
			! sync -f "$nginx_available_dir"; then
			rm -f -- "$nginx_candidate" ||
				die 'Failed backend Nginx candidate could not be removed.'
			if ! {
				mv -f -- "$nginx_backup" "$nginx_target" &&
					sync -f "$nginx_available_dir" &&
					nginx -t >/dev/null 2>&1
			}; then
				die 'Backend Nginx install rollback failed.'
			fi
			die 'Cannot install the apps-only backend Nginx config safely.'
		fi
		if ! nginx -t >/dev/null 2>&1; then
			mv -f -- "$nginx_backup" "$nginx_target"
			sync -f "$nginx_available_dir"
			nginx -t >/dev/null 2>&1 ||
				die 'Backend Nginx rollback validation failed.'
			die 'Apps-only backend Nginx config failed validation and was rolled back.'
		fi
		if ! systemctl reload nginx; then
			mv -f -- "$nginx_backup" "$nginx_target"
			sync -f "$nginx_available_dir"
			nginx -t >/dev/null 2>&1 && systemctl reload nginx ||
				die 'Backend Nginx reload rollback failed.'
			die 'Apps-only backend Nginx reload failed and was rolled back.'
		fi
		if [[ "$(sha256sum "$nginx_target" | awk '{print $1}')" !=
			"$backend_nginx_sha256" ||
			"$(stat -c '%u:%g:%a:%h' "$nginx_target")" != '0:0:644:1' ]] ||
			! nginx -t >/dev/null 2>&1; then
			mv -f -- "$nginx_backup" "$nginx_target"
			sync -f "$nginx_available_dir"
			nginx -t >/dev/null 2>&1 && systemctl reload nginx ||
				die 'Backend Nginx post-reload rollback failed.'
			die 'Apps-only backend Nginx post-reload verification failed and was rolled back.'
		fi
		rm -f -- "$nginx_backup"
		sync -f "$nginx_available_dir"
	fi
	[[ "$(sha256sum "$nginx_target" | awk '{print $1}')" ==
		"$backend_nginx_sha256" &&
		"$(stat -c '%u:%g:%a:%h' "$nginx_target")" == '0:0:644:1' ]] ||
		die 'Live backend Nginx config does not match the tracked apps-only artifact.'
	nginx -t >/dev/null 2>&1 ||
		die 'Live backend Nginx config validation failed after installation.'
}

install_and_verify_backend_nginx
wait_for_http_ok 'http://127.0.0.1:4100/health/ready' ||
	die 'Gateway local readiness check failed.'
wait_for_http_revision \
	'http://127.0.0.1:5200/health/deployment' "$services_revision" ||
	die 'Operations deployment revision check failed.'
wait_for_http_revision \
	'https://api.winwidget.ru/api/v1/health/deployment' "$services_revision" ||
	die 'Public Gateway deployment revision check failed.'
verify_retired_core_public_routes_absent ||
	die 'A retired Core public route remains reachable through backend Nginx.'
verify_telegram_proxy_health ||
	die 'Pinned Telegram proxy health check failed.'

if [[ "$deploy_mode" == 'cutover' ]]; then
	verify_control_plane_convergence \
		"$control_plane_snapshot_sha256" '' '' true
	[[ "$operations_status_source_revision" ==
		"$verified_control_plane_source_revision" ]] ||
		die 'Operations and control-plane snapshots have different source revisions.'
	rabbitmq_container_id="$(compose_all ps --status running -q rabbitmq 2>/dev/null)"
	[[ -n "$rabbitmq_container_id" && "$rabbitmq_container_id" != *$'\n'* ]] ||
		die 'Exactly one running RabbitMQ container is required for terminal cleanup.'

	legacy_queue_names=()
	for source in campaigns reporting widgets billing identity platform support; do
		for suffix in '' .retry-v2.1 .retry-v2.2 .retry-v2.3 .dead-letter; do
			legacy_queue_names+=("winwidget.admin.audit.$source.v1$suffix")
		done
	done
	legacy_queue_names+=(
		winwidget.operations.admin.audit.core.v1
		winwidget.operations.admin.audit.core.v1.retry-v1
		winwidget.operations.admin.audit.core.v1.dead-letter
	)
	for base in \
		winwidget.core.billing.payment-details.v1 \
		winwidget.core.billing.subscription-details.v1 \
		winwidget.core.billing.affiliate.v1 \
		winwidget.maintenance.database-backup \
		winwidget.notification.delivery-outcome; do
		for suffix in '' .retry-v2.1 .retry-v2.2 .retry-v2.3 .dead-letter; do
			legacy_queue_names+=("$base$suffix")
		done
	done
	legacy_queue_names+=(
		winwidget.core.billing.settings.v1
		winwidget.core.billing.settings.v1.retry-v2.1
		winwidget.core.billing.settings.v1.retry-v2.2
		winwidget.core.billing.settings.v1.retry-v2.3
		winwidget.core.billing.settings.v1.dead-letter
	)
	for base in \
		winwidget.billing.offer.v1 \
		winwidget.billing.settings-source.v1; do
		for suffix in '' .retry.1 .retry.2 .retry.3 .dead-letter; do
			legacy_queue_names+=("$base$suffix")
		done
	done

	legacy_queue_inventory="$(
		docker exec "$rabbitmq_container_id" rabbitmqctl --silent \
			list_queues -p winwidget name messages messages_ready \
			messages_unacknowledged consumers
	)"
	for queue_name in "${legacy_queue_names[@]}"; do
		queue_row="$(awk -v queue="$queue_name" '$1 == queue { print; count += 1 } END { if (count > 1) exit 1 }' <<<"$legacy_queue_inventory")" ||
			die 'Legacy RabbitMQ queue inventory is ambiguous.'
		[[ -n "$queue_row" ]] || continue
		read -r _queue_name messages messages_ready messages_unacknowledged consumers <<<"$queue_row"
		[[ "$messages" == '0' && "$messages_ready" == '0' &&
			"$messages_unacknowledged" == '0' && "$consumers" == '0' ]] ||
			die "Legacy RabbitMQ queue is not empty and unused: $queue_name"
		docker exec "$rabbitmq_container_id" rabbitmqctl delete_queue \
			-p winwidget "$queue_name" --if-empty --if-unused >/dev/null
	done

	legacy_rabbitmq_users=(
		winwidget-publisher
		winwidget-integration
		winwidget-maintenance
	)
	for legacy_user in "${legacy_rabbitmq_users[@]}"; do
		if ! docker exec "$rabbitmq_container_id" rabbitmqctl --silent list_users |
			awk '{ print $1 }' | grep -Fqx -- "$legacy_user"; then
			continue
		fi
		if docker exec "$rabbitmq_container_id" rabbitmqctl --silent \
			list_connections user | awk -v user="$legacy_user" '$1 == user { found = 1 } END { exit(found ? 0 : 1) }'; then
			die "Legacy RabbitMQ user still has a connection: $legacy_user"
		fi
		while IFS= read -r rabbitmq_vhost; do
			[[ -n "$rabbitmq_vhost" ]] || continue
			docker exec "$rabbitmq_container_id" rabbitmqctl clear_permissions \
				-p "$rabbitmq_vhost" "$legacy_user" >/dev/null 2>&1 || true
			docker exec "$rabbitmq_container_id" rabbitmqctl clear_topic_permissions \
				-p "$rabbitmq_vhost" "$legacy_user" >/dev/null 2>&1 || true
		done < <(
			docker exec "$rabbitmq_container_id" rabbitmqctl --silent list_vhosts name
		)
		[[ -z "$(docker exec "$rabbitmq_container_id" rabbitmqctl --silent list_user_permissions "$legacy_user" 2>/dev/null)" ]] ||
			die "Legacy RabbitMQ user still has resource permissions: $legacy_user"
		[[ -z "$(docker exec "$rabbitmq_container_id" rabbitmqctl --silent list_user_topic_permissions "$legacy_user" 2>/dev/null)" ]] ||
			die "Legacy RabbitMQ user still has topic permissions: $legacy_user"
		docker exec "$rabbitmq_container_id" rabbitmqctl delete_user \
			"$legacy_user" >/dev/null
	done
	actual_rabbitmq_user_names="$(
		docker exec "$rabbitmq_container_id" rabbitmqctl --silent list_users |
			awk 'NF { print $1 }' | LC_ALL=C sort
	)" || die 'Cannot verify the pre-terminal RabbitMQ user inventory.'
	[[ "$actual_rabbitmq_user_names" == "$rabbitmq_expected_user_names" ]] ||
		die 'RabbitMQ user inventory differs from the exact apps-only contract before Core cleanup.'

	retired_compose_services=(
		api
		outbox-publisher
		integration-worker
		maintenance-worker
		database-restore-worker
		migrate
	)
	for retired_service in "${retired_compose_services[@]}"; do
		retired_container_inventory="$(
			docker ps -aq \
				--filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
				--filter "label=com.docker.compose.service=$retired_service"
		)" || die "Cannot read retired Compose inventory: $retired_service"
		retired_container_ids=()
		if [[ -n "$retired_container_inventory" ]]; then
			mapfile -t retired_container_ids <<<"$retired_container_inventory"
		fi
		for retired_container_id in "${retired_container_ids[@]}"; do
			[[ "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.service" }}|{{.State.Running}}' "$retired_container_id")" == \
				"$COMPOSE_PROJECT_NAME|$retired_service|false" ]] ||
				die "Retired Compose target is running or has unexpected labels: $retired_service"
			docker rm "$retired_container_id" >/dev/null
		done
	done

	readonly core_postgres_container='winwidget-core-postgres-temporary'
	readonly core_postgres_image='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
	readonly core_postgres_image_id='sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
	readonly core_postgres_volume='winwidget-core-postgres-temporary-data'
	readonly core_postgres_secret="$app_root/deploy/backend/.core-postgres-temporary-admin-password"
	readonly core_postgres_cleanup_marker="$app_root/deploy/backend/.core-terminal-cleanup-v1"
	core_cleanup_marker_container_id=''
	validate_core_cleanup_marker() {
		local marker_file="$1"
		local -a marker_lines=()
		[[ -f "$marker_file" && ! -L "$marker_file" &&
			"$(stat -c '%u:%g:%a:%h' "$marker_file")" == '0:0:600:1' ]] ||
			return 1
		mapfile -t marker_lines <"$marker_file"
		[[ "${#marker_lines[@]}" == '5' &&
			"${marker_lines[0]}" == 'version=1' &&
			"${marker_lines[1]}" =~ ^services_revision=[0-9a-f]{40}$ &&
			"${marker_lines[2]}" =~ ^container_id=([0-9a-f]{64})$ &&
			"${marker_lines[3]}" == 'system_identifier=7668360958158979115' &&
			"${marker_lines[4]}" == "volume=$core_postgres_volume" ]] ||
			return 1
		core_cleanup_marker_container_id="${BASH_REMATCH[1]}"
	}
	core_cleanup_marker_present=false
	if [[ -e "$core_postgres_cleanup_marker" || -L "$core_postgres_cleanup_marker" ]]; then
		validate_core_cleanup_marker "$core_postgres_cleanup_marker" ||
			die 'Temporary Core PostgreSQL cleanup marker is unsafe.'
		core_cleanup_marker_present=true
	fi
	core_postgres_container_id="$(find_exact_named_container "$core_postgres_container")"
	if [[ -n "$core_postgres_container_id" ]]; then
		[[ "$core_postgres_container_id" =~ ^[0-9a-f]{64}$ ]] ||
			die 'Temporary Core PostgreSQL container ID is invalid.'
		if [[ "$core_cleanup_marker_present" == 'true' ]]; then
			[[ "$core_cleanup_marker_container_id" == "$core_postgres_container_id" ]] ||
				die 'Temporary Core PostgreSQL cleanup marker targets another container.'
		fi
		core_postgres_status="$(docker inspect --format '{{.State.Status}}' "$core_postgres_container_id")"
		[[ "$core_postgres_status" == 'running' || "$core_postgres_status" == 'exited' ]] ||
			die 'Temporary Core PostgreSQL container state is unsafe.'
		core_postgres_identity="$(
			docker inspect --format \
				'{{.HostConfig.RestartPolicy.Name}}|{{.Config.Image}}|{{.Image}}|{{index .Config.Labels "com.winwidget.owner"}}|{{index .Config.Labels "com.winwidget.purpose"}}|{{index .Config.Labels "com.winwidget.cleanup-after"}}|{{with index .Config.Labels "com.docker.compose.project"}}{{.}}{{end}}' \
				"$core_postgres_container_id"
		)"
		[[ "$core_postgres_identity" == \
			"unless-stopped|$core_postgres_image|$core_postgres_image_id|core-monolith|temporary-postgres|monolith-removal|" ]] ||
			die 'Temporary Core PostgreSQL container identity is unsafe.'
		[[ "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{.Type}}|{{.Name}}|{{.RW}}{{end}}{{end}}' "$core_postgres_container_id")" == \
			"volume|$core_postgres_volume|true" ]] ||
			die 'Temporary Core PostgreSQL data mount is unsafe.'
		[[ "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/run/secrets/core-postgres-admin-password"}}{{.Type}}|{{.Source}}|{{.RW}}{{end}}{{end}}' "$core_postgres_container_id")" == \
			"bind|$core_postgres_secret|false" ]] ||
			die 'Temporary Core PostgreSQL secret mount is unsafe.'
		[[ -f "$core_postgres_secret" && ! -L "$core_postgres_secret" &&
			"$(stat -c '%u:%g:%a' "$core_postgres_secret")" == '0:0:600' ]] ||
			die 'Temporary Core PostgreSQL secret file is unsafe.'
		[[ "$(docker port "$core_postgres_container_id" 5432/tcp 2>/dev/null)" == \
			'127.0.0.1:55434' ]] ||
			die 'Temporary Core PostgreSQL port boundary is unsafe.'
		core_postgres_environment="$(
			docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
				"$core_postgres_container_id"
		)"
		for expected_core_postgres_environment in \
			'POSTGRES_DB=default_db' \
			'POSTGRES_USER=winwidget_core_admin' \
			'POSTGRES_PASSWORD_FILE=/run/secrets/core-postgres-admin-password' \
			'PGDATA=/var/lib/postgresql/18/docker' \
			'POSTGRES_INITDB_ARGS=--locale=C.UTF-8 --encoding=UTF8 --auth-host=scram-sha-256 --data-checksums'; do
			[[ "$(grep -Fxc -- "$expected_core_postgres_environment" <<<"$core_postgres_environment" || true)" == '1' ]] ||
				die 'Temporary Core PostgreSQL environment identity is unsafe.'
		done
		[[ "$(docker volume inspect --format '{{.Driver}}|{{index .Labels "com.winwidget.owner"}}|{{index .Labels "com.winwidget.purpose"}}|{{index .Labels "com.winwidget.cleanup-after"}}' "$core_postgres_volume" 2>/dev/null)" == \
			'local|core-monolith|temporary-postgres|monolith-removal' ]] ||
			die 'Temporary Core PostgreSQL volume identity is unsafe.'
		[[ "$(docker ps -a --filter "volume=$core_postgres_volume" --format '{{.Names}}')" == \
			"$core_postgres_container" ]] ||
			die 'Temporary Core PostgreSQL volume attachment is ambiguous.'
		if [[ "$core_cleanup_marker_present" != 'true' ]]; then
			if [[ "$core_postgres_status" == 'exited' ]]; then
				docker start "$core_postgres_container_id" >/dev/null
			fi
			core_postgres_healthy=false
			for _attempt in {1..30}; do
				if [[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$core_postgres_container_id")" == 'healthy' ]]; then
					core_postgres_healthy=true
					break
				fi
				sleep 2
			done
			[[ "$core_postgres_healthy" == 'true' ]] ||
				die 'Temporary Core PostgreSQL did not become healthy.'
			core_control_data="$(
				docker exec "$core_postgres_container_id" \
					pg_controldata /var/lib/postgresql/18/docker
			)" || die 'Temporary Core PostgreSQL control data is unavailable.'
			core_system_identifier="$(awk -F: '/Database system identifier/ { gsub(/[[:space:]]/, "", $2); print $2 }' <<<"$core_control_data")"
			core_cluster_state="$(awk -F: '/Database cluster state/ { sub(/^[[:space:]]*/, "", $2); sub(/[[:space:]]*$/, "", $2); print $2 }' <<<"$core_control_data")"
			core_checksum_version="$(awk -F: '/Data page checksum version/ { gsub(/[[:space:]]/, "", $2); print $2 }' <<<"$core_control_data")"
			[[ "$core_system_identifier" == '7668360958158979115' &&
				"$core_cluster_state" == 'in production' &&
				"$core_checksum_version" == '1' ]] ||
				die 'Temporary Core PostgreSQL cluster fingerprint is unsafe.'
			docker exec "$core_postgres_container_id" pg_isready --quiet \
				--host 127.0.0.1 --username winwidget_core_admin --dbname default_db ||
				die 'Temporary Core PostgreSQL is not accepting connections.'
			core_cleanup_marker_tmp="$(mktemp "$deploy_state_directory/.core-cleanup-marker.XXXXXX")"
			printf '%s\n' \
				'version=1' \
				"services_revision=$services_revision" \
				"container_id=$core_postgres_container_id" \
				'system_identifier=7668360958158979115' \
				"volume=$core_postgres_volume" >"$core_cleanup_marker_tmp"
			chown 0:0 "$core_cleanup_marker_tmp"
			chmod 600 "$core_cleanup_marker_tmp"
			sync -f "$core_cleanup_marker_tmp"
			mv -f -- "$core_cleanup_marker_tmp" "$core_postgres_cleanup_marker"
			sync -f "$deploy_state_directory"
			validate_core_cleanup_marker "$core_postgres_cleanup_marker" ||
				die 'Temporary Core PostgreSQL cleanup marker could not be verified.'
			core_cleanup_marker_present=true
		fi
		if [[ "$(docker inspect --format '{{.State.Running}}' "$core_postgres_container_id")" == 'true' ]]; then
			docker stop --time 90 "$core_postgres_container_id" >/dev/null
		fi
		docker rm "$core_postgres_container_id" >/dev/null
	fi
	if docker_volume_exists "$core_postgres_volume"; then
		[[ "$core_cleanup_marker_present" == 'true' ]] ||
			die 'Temporary Core PostgreSQL volume remains without a cleanup marker.'
		[[ "$(docker volume inspect --format '{{.Driver}}|{{index .Labels "com.winwidget.owner"}}|{{index .Labels "com.winwidget.purpose"}}|{{index .Labels "com.winwidget.cleanup-after"}}' "$core_postgres_volume")" == \
			'local|core-monolith|temporary-postgres|monolith-removal' ]] ||
			die 'Temporary Core PostgreSQL volume identity is unsafe.'
		core_volume_container_ids="$(
			docker ps -a --filter "volume=$core_postgres_volume" --format '{{.ID}}'
		)" || die 'Cannot read temporary Core PostgreSQL volume attachments.'
		[[ -z "$core_volume_container_ids" ]] ||
			die 'Temporary Core PostgreSQL volume is still attached.'
		docker volume rm "$core_postgres_volume" >/dev/null
	fi
	if [[ -e "$core_postgres_secret" || -L "$core_postgres_secret" ]]; then
		[[ "$core_cleanup_marker_present" == 'true' &&
			-f "$core_postgres_secret" && ! -L "$core_postgres_secret" &&
			"$(stat -c '%u:%g:%a:%h' "$core_postgres_secret")" == '0:0:600:1' ]] ||
			die 'Temporary Core PostgreSQL secret cleanup state is unsafe.'
		rm -f -- "$core_postgres_secret"
	fi
	if [[ "$core_cleanup_marker_present" == 'true' ]]; then
		remaining_core_container_id="$(
			find_exact_named_container "$core_postgres_container"
		)"
		[[ -z "$remaining_core_container_id" ]] ||
			die 'Temporary Core PostgreSQL container remains after cleanup.'
		! docker_volume_exists "$core_postgres_volume" ||
			die 'Temporary Core PostgreSQL volume remains after cleanup.'
		[[ ! -e "$core_postgres_secret" && ! -L "$core_postgres_secret" ]] ||
			die 'Temporary Core PostgreSQL secret remains after cleanup.'
		rm -f -- "$core_postgres_cleanup_marker"
	elif docker_volume_exists "$core_postgres_volume" ||
		[[ -e "$core_postgres_secret" || -L "$core_postgres_secret" ]]; then
		die 'Partial temporary Core PostgreSQL cleanup state is unsafe.'
	fi

	legacy_restore_root="$app_root/deploy/backend/database-restores"
	if [[ -e "$legacy_restore_root" || -L "$legacy_restore_root" ]]; then
		[[ -d "$legacy_restore_root" && ! -L "$legacy_restore_root" &&
			"$(realpath -e "$legacy_restore_root")" == "$legacy_restore_root" &&
			"$(stat -c '%u:%g:%a' "$legacy_restore_root")" ==
				'1001:1001:700' &&
			"$(stat -c '%d' "$legacy_restore_root")" ==
				"$(stat -c '%d' "$deploy_state_directory")" ]] ||
			die 'Legacy restore root metadata differs from the live reviewed contract.'
		legacy_restore_directories=(
			uploads queued processing terminal locks gates fences permits receipts
		)
		legacy_restore_files=(
			worker-ready.json
			.database-restore-worker.singleton.lock
		)
		while IFS= read -r -d '' entry_path; do
			entry_name="$(basename "$entry_path")"
			allowed_legacy_restore_entry=false
			for allowed_entry_name in \
				"${legacy_restore_directories[@]}" \
				"${legacy_restore_files[@]}"; do
				if [[ "$entry_name" == "$allowed_entry_name" ]]; then
					allowed_legacy_restore_entry=true
					break
				fi
			done
			[[ "$allowed_legacy_restore_entry" == 'true' ]] ||
				die 'Legacy restore root contains an unexpected artifact.'
		done < <(find "$legacy_restore_root" -xdev -mindepth 1 -maxdepth 1 -print0)
		for entry_name in "${legacy_restore_directories[@]}"; do
			entry_path="$legacy_restore_root/$entry_name"
			[[ -e "$entry_path" || -L "$entry_path" ]] || continue
			[[ -d "$entry_path" && ! -L "$entry_path" &&
				"$(realpath -e "$entry_path")" == "$entry_path" &&
				"$(stat -c '%u:%g' "$entry_path")" == '1001:1001' &&
				"$(stat -c '%d' "$entry_path")" ==
					"$(stat -c '%d' "$legacy_restore_root")" ]] ||
				die "Legacy restore directory target is unsafe: $entry_name"
			find "$entry_path" -xdev -depth -delete
		done
		for entry_name in "${legacy_restore_files[@]}"; do
			entry_path="$legacy_restore_root/$entry_name"
			[[ -e "$entry_path" || -L "$entry_path" ]] || continue
			[[ -f "$entry_path" && ! -L "$entry_path" &&
				"$(realpath -e "$entry_path")" == "$entry_path" &&
				"$(stat -c '%u:%g' "$entry_path")" == '1001:1001' &&
				"$(stat -c '%d' "$entry_path")" ==
					"$(stat -c '%d' "$legacy_restore_root")" ]] ||
				die "Legacy restore file target is unsafe: $entry_name"
			rm -f -- "$entry_path"
		done
		rmdir "$legacy_restore_root" 2>/dev/null ||
			die 'Legacy restore root contains an unexpected artifact after cleanup.'
	fi
	legacy_restore_marker="$app_root/deploy/backend/.database-restore-control-v1"
	if [[ -e "$legacy_restore_marker" || -L "$legacy_restore_marker" ]]; then
		[[ -f "$legacy_restore_marker" && ! -L "$legacy_restore_marker" ]] ||
			die 'Legacy restore control marker is unsafe.'
		rm -f -- "$legacy_restore_marker"
	fi
	legacy_restore_staging_root="$app_root/restore-staging"
	legacy_restore_staging_names=(
		core-20260730
		core-cutover-20260731
	)
	if [[ -e "$legacy_restore_staging_root" || -L "$legacy_restore_staging_root" ]]; then
		[[ -d "$legacy_restore_staging_root" && ! -L "$legacy_restore_staging_root" &&
			"$(realpath -e "$legacy_restore_staging_root")" == "$legacy_restore_staging_root" &&
			"$(stat -c '%u:%g' "$legacy_restore_staging_root")" == '0:0' ]] ||
			die 'Legacy restore staging root is unsafe.'
		legacy_restore_staging_device="$(stat -c '%d' "$legacy_restore_staging_root")"
		for entry_name in "${legacy_restore_staging_names[@]}"; do
			entry_path="$legacy_restore_staging_root/$entry_name"
			[[ -e "$entry_path" || -L "$entry_path" ]] || continue
			[[ -d "$entry_path" && ! -L "$entry_path" &&
				"$(realpath -e "$entry_path")" == "$entry_path" &&
				"$(stat -c '%u:%g' "$entry_path")" == '0:0' &&
				"$(stat -c '%d' "$entry_path")" ==
					"$legacy_restore_staging_device" ]] ||
				die "Legacy restore staging target is unsafe: $entry_name"
			find "$entry_path" -xdev -depth -delete
		done
		legacy_restore_staging_remaining="$(
			find "$legacy_restore_staging_root" -xdev -mindepth 1 \
				-maxdepth 1 -print -quit
		)" || die 'Cannot verify the legacy restore staging root after cleanup.'
		if [[ -z "$legacy_restore_staging_remaining" ]]; then
			rmdir "$legacy_restore_staging_root" ||
				die 'Empty legacy restore staging root could not be removed.'
		fi
	fi

	remaining_legacy_queues="$(
		docker exec "$rabbitmq_container_id" rabbitmqctl --silent \
			list_queues -p winwidget name
	)"
	for queue_name in "${legacy_queue_names[@]}"; do
		if awk -v queue="$queue_name" '$1 == queue { found = 1 } END { exit(found ? 0 : 1) }' <<<"$remaining_legacy_queues"; then
			die "Legacy RabbitMQ queue remains after terminal cleanup: $queue_name"
		fi
	done
	for legacy_user in "${legacy_rabbitmq_users[@]}"; do
		if docker exec "$rabbitmq_container_id" rabbitmqctl --silent list_users |
			awk '{ print $1 }' | grep -Fqx -- "$legacy_user"; then
			die "Legacy RabbitMQ user remains after terminal cleanup: $legacy_user"
		fi
	done
	for retired_service in "${retired_compose_services[@]}"; do
		retired_container_id="$(find_project_service_container "$retired_service")"
		[[ -z "$retired_container_id" ]] ||
			die "Retired Compose container remains after terminal cleanup: $retired_service"
	done
	! docker_volume_exists "$core_postgres_volume" ||
		die 'Temporary Core PostgreSQL volume remains after terminal cleanup.'
	for entry_name in "${legacy_restore_staging_names[@]}"; do
		entry_path="$legacy_restore_staging_root/$entry_name"
		[[ ! -e "$entry_path" && ! -L "$entry_path" ]] ||
			die "Legacy restore staging target remains: $entry_name"
	done
	command -v ss >/dev/null 2>&1 ||
		die 'The ss utility is required to prove retired Core port absence.'
	listener_inventory="$(ss -ltnH 2>/dev/null)" ||
		die 'Cannot read the production TCP listener inventory.'
	if awk '$4 ~ /:4200$/ { found = 1 } END { exit(found ? 0 : 1) }' \
		<<<"$listener_inventory"; then
		die 'A listener remains on the retired Core port 4200.'
	fi
	wait_for_healthy_services "${runtime_services[@]}"
	wait_for_http_revision \
		'https://api.winwidget.ru/api/v1/health/deployment' "$services_revision" ||
		die 'Public Gateway revision check failed after terminal cleanup.'
fi

env_sha256_after="$(sha256sum "$env_file" | awk '{print $1}')"
[[ "$env_sha256_after" == "$env_sha256_before" &&
	"$env_sha256_after" == "$expected_env_sha256" ]] ||
	die 'Canonical production env changed during deployment.'
[[ "$(stat -c '%u:%g:%a:%h' "$env_file")" == '0:0:600:1' ]] ||
	die 'Canonical production env permissions changed during deployment.'
for service_env_file in "${service_env_files[@]}"; do
	[[ -f "$service_env_file" && ! -L "$service_env_file" &&
		"$(stat -c '%u:%g:%a:%h' "$service_env_file")" == '0:0:600:1' ]] ||
		die 'A service-owned production env changed type or permissions during deployment.'
done
[[ "$(service_env_manifest_sha256)" == "$service_env_manifest_sha256_before" ]] ||
	die 'A service-owned production env changed during deployment.'

if [[ "$deploy_mode" == 'cutover' ]]; then
	verify_cutover_input_inventory
	for snapshot_file in "$operations_snapshot_file" "$control_plane_snapshot_file"; do
		[[ -f "$snapshot_file" && ! -L "$snapshot_file" ]] ||
			die 'Protected cutover snapshot disappeared before final cleanup.'
	done
	[[ "$(sha256sum "$operations_snapshot_file" | awk '{print $1}')" == \
		"$operations_snapshot_sha256" ]] ||
		die 'Operations snapshot changed before final cleanup.'
	[[ "$(sha256sum "$control_plane_snapshot_file" | awk '{print $1}')" == \
		"$control_plane_snapshot_sha256" ]] ||
		die 'Operations control-plane snapshot changed before final cleanup.'
	write_terminal_cutover_marker
fi

cleanup_terminal_snapshot_artifacts
verify_terminal_cutover_state
wait_for_healthy_services "${runtime_services[@]}"
verify_telegram_proxy_health ||
	die 'Pinned Telegram proxy health check failed after terminal verification.'
wait_for_http_revision \
	'https://api.winwidget.ru/api/v1/health/deployment' "$services_revision" ||
	die 'Public Gateway revision check failed after terminal-state verification.'
verify_retired_core_public_routes_absent ||
	die 'A retired Core public route reappeared after terminal verification.'

printf 'Production services deployment completed: mode=%s infra=%s services=%s\n' \
	"$deploy_mode" "$infra_revision" "$services_revision"
REMOTE_CONTROLLER
