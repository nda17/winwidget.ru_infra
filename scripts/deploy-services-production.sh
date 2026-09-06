#!/usr/bin/env bash

set -euo pipefail
umask 077

usage() {
	cat >&2 <<'USAGE'
Usage:
	deploy-services-production.sh <40-hex-services-revision>

Required environment:
  INFRA_REVISION
  PRODUCTION_SSH_HOST
  PRODUCTION_SSH_PORT
  PRODUCTION_SSH_USER
  PRODUCTION_SSH_IDENTITY_FILE
  PRODUCTION_SSH_KNOWN_HOSTS_FILE
  EXPECTED_PRODUCTION_ENV_SHA256

Optional environment (all five values or none):
  FRONTEND_PRODUCTION_SSH_HOST
  FRONTEND_PRODUCTION_SSH_PORT
  FRONTEND_PRODUCTION_SSH_USER
  FRONTEND_PRODUCTION_SSH_IDENTITY_FILE
  FRONTEND_PRODUCTION_SSH_KNOWN_HOSTS_FILE

Scoped release inputs (only from the pinned reusable workflow):
  RELEASE_SCOPE (default all)
  EXPECTED_LIVE_REVISION
  EXPECTED_SERVICE_ENV_SHA256
  EXPECTED_SUPPORT_ENV_SHA256 (workers-bootstrap-recovery only)
  OPERATIONS_RUNTIME_REVISION (finalize only)
  OPERATIONS_EVIDENCE_SHA256 (finalize only)
USAGE
	exit 2
}

die() {
	printf '%s\n' "$1" >&2
	exit 1
}

[[ $# -eq 1 ]] || usage

services_revision="$1"
[[ "$services_revision" =~ ^[0-9a-f]{40}$ ]] ||
	die 'Services revision must be an immutable lowercase 40-hex commit.'

infra_revision="${INFRA_REVISION:-}"
[[ "$infra_revision" =~ ^[0-9a-f]{40}$ ]] ||
	die 'Infra revision must be an immutable lowercase 40-hex commit.'

release_scope="${RELEASE_SCOPE:-all}"
expected_live_revision="${EXPECTED_LIVE_REVISION:-}"
expected_service_env_sha256="${EXPECTED_SERVICE_ENV_SHA256:-}"
expected_operations_revision="${EXPECTED_OPERATIONS_REVISION:-}"
expected_operations_api_revision="${EXPECTED_OPERATIONS_API_REVISION:-}"
expected_operations_env_sha256="${EXPECTED_OPERATIONS_ENV_SHA256:-}"
expected_support_env_sha256="${EXPECTED_SUPPORT_ENV_SHA256:-}"
operations_runtime_revision="${OPERATIONS_RUNTIME_REVISION:-}"
operations_evidence_sha256="${OPERATIONS_EVIDENCE_SHA256:-}"
case "$release_scope" in
	all)
		[[ -z "$expected_live_revision$expected_service_env_sha256$operations_runtime_revision$operations_evidence_sha256$expected_operations_revision$expected_operations_env_sha256$expected_support_env_sha256" ]] ||
			die 'Scoped authorization cannot be attached to an all-services deployment.' ;;
	identity-with-operations-manifest | operations-runtime | operations-backlog-backup | operations-backlog-finalize | gateway-remove-notes | workers-bootstrap-recovery | operations-federation-config | operations-api-runtime | platform-marketing-runtime)
		[[ "$expected_live_revision" =~ ^[0-9a-f]{40}$ &&
			"$expected_service_env_sha256" =~ ^[0-9a-f]{64}$ ]] ||
			die 'Scoped deployment requires the approved live revision and owner env SHA256.'
		if [[ "$release_scope" == operations-backlog-finalize ]]; then
			[[ "$operations_runtime_revision" =~ ^[0-9a-f]{40}$ &&
				"$operations_evidence_sha256" =~ ^[0-9a-f]{64}$ &&
				"$expected_live_revision" == "$operations_runtime_revision" ]] ||
				die 'Operations finalization requires exact phase-A and restore evidence identities.'
		elif [[ "$release_scope" == operations-backlog-backup ]]; then
			[[ "$operations_runtime_revision" =~ ^[0-9a-f]{40}$ && "$expected_live_revision" == "$operations_runtime_revision" && -z "$operations_evidence_sha256" ]] ||
				die 'Operations backup requires the exact phase-A live revision and no restore evidence input.'
		else
			[[ -z "$operations_runtime_revision$operations_evidence_sha256" ]] ||
				die 'Destructive authorization is only valid for Operations finalization.'
		fi ;;
	*) die 'Unsupported production release scope.' ;;
esac
if [[ "$release_scope" == identity-with-operations-manifest || "$release_scope" == workers-bootstrap-recovery ]]; then
	[[ "$expected_operations_revision" =~ ^[a-f0-9]{40}$ && "$expected_operations_env_sha256" =~ ^[a-f0-9]{64}$ ]] ||
		die 'Coordinated Identity release requires the exact Operations companion identities.'
else
	[[ -z "$expected_operations_revision$expected_operations_env_sha256" ]] ||
		die 'Operations companion authorization is only valid for the coordinated Identity release.'
fi
if [[ -n "$expected_operations_api_revision" ]]; then
	[[ "$release_scope" == identity-with-operations-manifest && "$expected_operations_api_revision" =~ ^[a-f0-9]{40}$ ]] ||
		die 'Operations API baseline is only valid for coordinated Identity.'
fi
if [[ "$release_scope" == workers-bootstrap-recovery ]]; then
	[[ "$expected_support_env_sha256" =~ ^[a-f0-9]{64}$ && "$expected_operations_revision" == "$expected_live_revision" ]] ||
		die 'Worker recovery requires the exact Support env hash and a common approved live revision.'
else
	[[ -z "$expected_support_env_sha256" ]] || die 'Support authorization is only valid for worker recovery.'
fi

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

scoped_shell_file="$controller_root/scripts/deploy-identity-operations-scoped.sh"
scoped_node_file="$controller_root/scripts/scoped-service-release.mjs"
command -v gzip >/dev/null || die 'Scoped payload compression is unavailable.'
for scoped_file in "$scoped_shell_file" "$scoped_node_file"; do
	[[ -f "$scoped_file" && ! -L "$scoped_file" ]] ||
		die 'Tracked scoped deployment verifier is missing or unsafe.'
	git -C "$controller_root" ls-files --error-unmatch \
		"${scoped_file#"$controller_root/"}" >/dev/null 2>&1 ||
		die 'Scoped deployment verifier is not tracked by infra Git.'
	scoped_file_size="$(wc -c <"$scoped_file" | tr -d '[:space:]')"
	[[ "$scoped_file_size" =~ ^[0-9]+$ ]] || die 'Scoped payload size is invalid.'
	(( scoped_file_size > 0 && scoped_file_size <= 131072 )) ||
		die 'Scoped payload exceeds its bounded uncompressed size.'
done
scoped_shell_sha256="$(sha256sum "$scoped_shell_file" | awk '{print $1}')"
scoped_shell_base64="$(gzip -n -6 -c <"$scoped_shell_file" | base64 | tr -d '\n')"
scoped_node_sha256="$(sha256sum "$scoped_node_file" | awk '{print $1}')"
scoped_node_base64="$(gzip -n -6 -c <"$scoped_node_file" | base64 | tr -d '\n')"
[[ "$scoped_shell_sha256" =~ ^[a-f0-9]{64}$ && "$scoped_node_sha256" =~ ^[a-f0-9]{64}$ &&
	"$scoped_shell_base64" =~ ^[A-Za-z0-9+/]+={0,2}$ && "$scoped_node_base64" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] ||
	die 'Cannot encode the immutable scoped deployment payload.'
(( ${#scoped_shell_base64} + ${#scoped_node_base64} <= 90000 )) ||
	die 'Scoped payload exceeds the bounded SSH argument envelope.'

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

frontend_nginx_file="$controller_root/nginx/frontend.conf"
[[ -f "$frontend_nginx_file" && ! -L "$frontend_nginx_file" ]] ||
	die 'Tracked frontend Nginx config is missing or unsafe.'
git -C "$controller_root" ls-files --error-unmatch \
	nginx/frontend.conf >/dev/null 2>&1 ||
	die 'Frontend Nginx config is not tracked by infra Git.'
frontend_nginx_sha256="$(sha256sum "$frontend_nginx_file" | awk '{print $1}')"
[[ "$frontend_nginx_sha256" =~ ^[0-9a-f]{64}$ ]] ||
	die 'Cannot calculate frontend Nginx SHA-256.'
frontend_nginx_base64="$(base64 <"$frontend_nginx_file" | tr -d '\n')"
[[ -n "$frontend_nginx_base64" &&
	"$frontend_nginx_base64" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] ||
	die 'Cannot encode the frontend Nginx config.'

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

frontend_environment=(
	FRONTEND_PRODUCTION_SSH_HOST
	FRONTEND_PRODUCTION_SSH_PORT
	FRONTEND_PRODUCTION_SSH_USER
	FRONTEND_PRODUCTION_SSH_IDENTITY_FILE
	FRONTEND_PRODUCTION_SSH_KNOWN_HOSTS_FILE
)
frontend_environment_count=0
for variable_name in "${frontend_environment[@]}"; do
	if [[ -n "${!variable_name:-}" ]]; then
		frontend_environment_count=$((frontend_environment_count + 1))
	fi
done
if ((frontend_environment_count != 0 &&
	frontend_environment_count != ${#frontend_environment[@]})); then
	die 'Frontend production SSH settings must be configured as one complete group.'
fi
deploy_frontend_nginx='false'
if ((frontend_environment_count == ${#frontend_environment[@]})); then
	deploy_frontend_nginx='true'
fi
[[ "$release_scope" == all || "$deploy_frontend_nginx" == false ]] ||
	die 'Scoped backend deployment cannot change frontend Nginx.'

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

frontend_identity_file=''
frontend_known_hosts_file=''
if [[ "$deploy_frontend_nginx" == 'true' ]]; then
	[[ "$FRONTEND_PRODUCTION_SSH_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ ]] ||
		die 'Frontend production SSH host is invalid.'
	if [[ ! "$FRONTEND_PRODUCTION_SSH_PORT" =~ ^[0-9]{1,5}$ ]] ||
		((10#$FRONTEND_PRODUCTION_SSH_PORT < 1 ||
			10#$FRONTEND_PRODUCTION_SSH_PORT > 65535)); then
		die 'Frontend production SSH port is invalid.'
	fi
	[[ "$FRONTEND_PRODUCTION_SSH_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] ||
		die 'Frontend production SSH user is invalid.'
	frontend_identity_file="$FRONTEND_PRODUCTION_SSH_IDENTITY_FILE"
	frontend_known_hosts_file="$FRONTEND_PRODUCTION_SSH_KNOWN_HOSTS_FILE"
	[[ -f "$frontend_identity_file" && ! -L "$frontend_identity_file" ]] ||
		die 'Frontend production SSH identity file must be a regular non-symlink file.'
	[[ "$(stat -c '%a' "$frontend_identity_file" 2>/dev/null || stat -f '%Lp' "$frontend_identity_file")" == '600' ]] ||
		die 'Frontend production SSH identity file must have mode 0600.'
	ssh-keygen -y -P '' -f "$frontend_identity_file" >/dev/null 2>&1 ||
		die 'Frontend production SSH identity file is invalid or requires a passphrase.'
	[[ -s "$frontend_known_hosts_file" && ! -L "$frontend_known_hosts_file" ]] ||
		die 'Frontend production SSH known_hosts file must be a non-empty regular file.'
	[[ "$(stat -c '%a' "$frontend_known_hosts_file" 2>/dev/null || stat -f '%Lp' "$frontend_known_hosts_file")" == '600' ]] ||
		die 'Frontend production SSH known_hosts file must have mode 0600.'
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

printf -v remote_controller_arguments ' %q' \
	"$infra_revision" \
	"$services_revision" \
	"$EXPECTED_PRODUCTION_ENV_SHA256" \
	"$backend_nginx_sha256" \
	"$backend_nginx_base64" \
	"$release_scope" \
	"$expected_live_revision" \
	"$expected_service_env_sha256" \
	"$operations_runtime_revision" \
	"$operations_evidence_sha256" \
	"$scoped_shell_sha256" \
	"$scoped_shell_base64" \
	"$scoped_node_sha256" \
	"$scoped_node_base64" \
	"$expected_operations_revision" \
	"$expected_operations_env_sha256" \
	"$expected_support_env_sha256" \
	"$expected_operations_api_revision"
# The remote shell, not this local controller, must expand these variables.
# shellcheck disable=SC2016
remote_controller_command='set -euo pipefail
[[ "$(id -u)" == "0" ]]
controller_file="$(mktemp /opt/winwidget/deploy/backend/.production-controller.XXXXXX)"
trap '\''rm -f -- "$controller_file"'\'' EXIT
cat >"$controller_file"
chown 0:0 "$controller_file"
chmod 600 "$controller_file"
bash "$controller_file"'"$remote_controller_arguments"' </dev/null'

# Stage the complete controller before executing it. Otherwise a child command
# such as `docker compose up` can inherit SSH stdin and consume the unparsed
# remainder of a `bash -s` controller while still returning exit code 0.
# shellcheck disable=SC2029
ssh "${ssh_options[@]}" \
	"$PRODUCTION_SSH_USER@$PRODUCTION_SSH_HOST" \
	"$remote_controller_command" <<'REMOTE_CONTROLLER'
set -euo pipefail
umask 077

die() {
	printf '%s\n' "$1" >&2
	exit 1
}

infra_revision="$1"
services_revision="$2"
expected_env_sha256="$3"
backend_nginx_sha256="$4"
backend_nginx_base64="$5"
release_scope="$6"
export expected_live_revision="$7"
export expected_service_env_sha256="$8"
export operations_runtime_revision="$9"
export operations_evidence_sha256="${10}"
scoped_shell_sha256="${11}"
scoped_shell_base64="${12}"
scoped_node_sha256="${13}"
scoped_node_base64="${14}"
export expected_operations_revision="${15}"
export expected_operations_env_sha256="${16}"
export expected_support_env_sha256="${17}"
export expected_operations_api_revision="${18}"

[[ "$infra_revision" =~ ^[0-9a-f]{40}$ ]] ||
	die 'Remote infra revision is invalid.'
[[ "$services_revision" =~ ^[0-9a-f]{40}$ ]] ||
	die 'Remote services revision is invalid.'
[[ "$expected_env_sha256" =~ ^[0-9a-f]{64}$ ]] ||
	die 'Remote expected env SHA-256 is invalid.'
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
readonly backup_provenance_private_key_file="$app_root/deploy/backend/.database-backup-provenance-private-key.pem"
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

assert_backup_provenance_private_key() {
	local size
	[[ -f "$backup_provenance_private_key_file" &&
		! -L "$backup_provenance_private_key_file" &&
		"$(realpath -e "$backup_provenance_private_key_file")" == "$backup_provenance_private_key_file" &&
		"$(stat -c '%u:%g:%a:%h' "$backup_provenance_private_key_file")" == '0:0:600:1' ]] ||
		die 'Backup provenance private key must be the fixed root-owned mode 0600 file.'
	size="$(stat -c '%s' "$backup_provenance_private_key_file")"
	[[ "$size" =~ ^[0-9]+$ ]] ||
		die 'Backup provenance private key size is outside the safe boundary.'
	((size >= 64 && size <= 16384)) ||
		die 'Backup provenance private key size is outside the safe boundary.'
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

assert_backup_provenance_private_key
backup_provenance_private_key_identity_before="$(
	stat -c '%d:%i:%s' "$backup_provenance_private_key_file"
)"
backup_provenance_private_key_sha256_before="$(
	sha256sum "$backup_provenance_private_key_file" | awk '{print $1}'
)"
[[ "$backup_provenance_private_key_sha256_before" =~ ^[0-9a-f]{64}$ ]] ||
	die 'Cannot calculate backup provenance private key integrity hash.'

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

# Branch before any all-app env materialization, build, infrastructure changes,
# broker provisioning or migrations. The old all-services path stays intact.
# Even an accidental all caller must not bypass the destructive Notes gates.
if [[ "$release_scope" != all || -f "$release_root/apps/operations/prisma/migrations/20260910110000_remove_admin_backlog/migration.sql" ]]; then
	[[ "$scoped_shell_sha256" =~ ^[0-9a-f]{64}$ &&
		"$scoped_node_sha256" =~ ^[0-9a-f]{64}$ &&
		"$scoped_shell_base64" =~ ^[A-Za-z0-9+/]+={0,2}$ &&
		"$scoped_node_base64" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] ||
		die 'Invalid immutable scoped payload.'
	scoped_payload_directory="$(mktemp -d "$app_root/deploy/backend/.scoped-controller.XXXXXX")"
	chmod 700 "$scoped_payload_directory"
	cleanup_scoped_payload() {
		rm -f -- "$scoped_payload_directory/controller.sh" "$scoped_payload_directory/verifier.mjs"
		rmdir "$scoped_payload_directory"
	}
	trap cleanup_scoped_payload EXIT
	scoped_decode_payload() {
		local encoded="$1" destination="$2" size
		command -v gzip >/dev/null || die 'Scoped payload decompression is unavailable.'
		[[ "$encoded" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || die 'Invalid compressed scoped payload.'
		(( ${#scoped_shell_base64} + ${#scoped_node_base64} <= 90000 )) ||
			die 'Invalid bounded compressed scoped payload.'
		# The sentinel caps output even for a decompression bomb. pipefail also
		# rejects truncated archives and gzip errors before any code is exposed.
		printf '%s' "$encoded" | base64 --decode | gzip -dc | head -c 131073 >"$destination" ||
			die 'Scoped payload decompression failed.'
		size="$(wc -c <"$destination" | tr -d '[:space:]')"
		[[ "$size" =~ ^[0-9]+$ ]] || die 'Scoped payload size is invalid.'
		(( size > 0 && size <= 131072 )) ||
			die 'Scoped payload exceeds its bounded uncompressed size.'
	}
	scoped_decode_payload "$scoped_shell_base64" "$scoped_payload_directory/controller.sh"
	scoped_decode_payload "$scoped_node_base64" "$scoped_payload_directory/verifier.mjs"
	chmod 600 "$scoped_payload_directory/controller.sh" "$scoped_payload_directory/verifier.mjs"
	[[ "$(sha256sum "$scoped_payload_directory/controller.sh" | awk '{print $1}')" == "$scoped_shell_sha256" &&
		"$(sha256sum "$scoped_payload_directory/verifier.mjs" | awk '{print $1}')" == "$scoped_node_sha256" ]] ||
		die 'Scoped payload checksum mismatch.'
	# Only hash-verified public code crosses the non-root migration boundary.
	# The private parent, shell controller, env and snapshots retain their modes.
	chmod 444 "$scoped_payload_directory/verifier.mjs"
	# shellcheck disable=SC1091
	source "$scoped_payload_directory/controller.sh"
	if [[ "$release_scope" == all ]]; then
		scoped_assert_backlog_already_finalized
		cleanup_scoped_payload
		trap - EXIT
	else
		# Preserve safe recovery diagnostics outside redirected Compose calls.
		# Dynamic allocation must not collide with the inherited deploy-lock FD.
		exec {scoped_diagnostic_fd}>&2
		export scoped_diagnostic_fd
		scoped_deploy_main
		exit 0
	fi
fi

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

readonly backup_provenance_public_keyring="$release_root/apps/operations/restore-manifests/database-backup-provenance-public-keys.json"
assert_root_owned_file "$backup_provenance_public_keyring"
git -C "$release_root" ls-files --error-unmatch \
	'apps/operations/restore-manifests/database-backup-provenance-public-keys.json' \
	>/dev/null 2>&1 ||
	die 'Backup provenance public keyring is not tracked by the requested services revision.'

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
	--interactive \
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
const immutableBackupProvenanceRootEnvKeys = [
	'DATABASE_BACKUP_PROVENANCE_KEY_ID',
	'DATABASE_BACKUP_PROVENANCE_PRIVATE_KEY_HOST_FILE'
];
if (immutableBackupProvenanceRootEnvKeys.some(key => canonical.has(key))) fail();

const restoreReceiptHmacKey = canonical.get(
	'DATABASE_RESTORE_RECEIPT_HMAC_KEY_BASE64'
);
const restoreReceiptHmacKeyId = canonical.get(
	'DATABASE_RESTORE_RECEIPT_HMAC_KEY_ID'
);
const backupProvenanceKeyId = 'operations-backup-ed25519-2026-08-31';
const backupProvenancePublicKeyring = JSON.parse(
	fs.readFileSync(
		'/run/winwidget/apps/operations/restore-manifests/database-backup-provenance-public-keys.json',
		'utf8'
	)
);
if (
	typeof restoreReceiptHmacKey !== 'string' ||
	!/^[A-Za-z0-9+/]+={0,2}$/.test(restoreReceiptHmacKey) ||
	typeof restoreReceiptHmacKeyId !== 'string' ||
	!/^[A-Za-z0-9._:-]{1,80}$/.test(restoreReceiptHmacKeyId)
) fail();
if (
	typeof backupProvenanceKeyId !== 'string' ||
	!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(backupProvenanceKeyId) ||
	!backupProvenancePublicKeyring ||
	backupProvenancePublicKeyring.schemaVersion !== 1 ||
	backupProvenancePublicKeyring.domain !==
		'winwidget.operations.database-backup-provenance.v1' ||
	!Array.isArray(backupProvenancePublicKeyring.keys) ||
	backupProvenancePublicKeyring.keys.length < 1 ||
	backupProvenancePublicKeyring.keys.length > 16 ||
	!backupProvenancePublicKeyring.keys.some(
		key =>
			key &&
			typeof key === 'object' &&
			key.keyId === backupProvenanceKeyId &&
			typeof key.publicKeySpkiDerBase64 === 'string'
	)
) fail();
const decodedRestoreReceiptHmacKey = Buffer.from(
	restoreReceiptHmacKey,
	'base64'
);
const restoreReceiptHmacKeyIsValid =
	decodedRestoreReceiptHmacKey.length >= 32 &&
	decodedRestoreReceiptHmacKey.toString('base64').replace(/=+$/u, '') ===
		restoreReceiptHmacKey.replace(/=+$/u, '');
decodedRestoreReceiptHmacKey.fill(0);
if (!restoreReceiptHmacKeyIsValid) fail();

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
// CRM readers/producers stay opt-in. Empty optional credentials are allowed
// only while their exact feature is disabled; never copy example secrets.
const crmFlag = key => {
	const flag = canonical.get(key) ?? 'false';
	if (!['true', 'false'].includes(flag)) fail();
	return flag === 'true';
};
const crmPayments = crmFlag('BILLING_WINCRM_PAYMENTS_ENABLED');
const crmReconciliation = crmFlag('BILLING_WINCRM_RECONCILIATION_ENABLED');
const crmEligibility = crmFlag('BILLING_WINCRM_WIDGETS_ELIGIBILITY_ENABLED');
const crmWidgets = crmFlag('WIDGETS_WINCRM_CONNECTOR_ENABLED');
const crmEmail = crmFlag('WINCRM_INVITATION_EMAIL_ENABLED');
const crmEmailReader = (canonical.get('NOTIFICATION_DELIVERY_KINDS') ?? '')
	.split(',').includes('wincrm-invitation-email');
for (const [ownerKey, fallback] of [
	['billing:BILLING_WINCRM_PAYMENTS_ENABLED', 'false'],
	['billing:BILLING_WINCRM_RECONCILIATION_ENABLED', 'false'],
	['billing:BILLING_WINCRM_WIDGETS_ELIGIBILITY_ENABLED', 'false'],
	['billing:BILLING_WINCRM_PROVIDER_ASSERT_TOPOLOGY', 'false'],
	['billing:BILLING_WINCRM_FRONTEND_ORIGIN', 'https://crm.winwidget.ru'],
	['widgets:WIDGETS_WINCRM_CONNECTOR_ENABLED', 'false'],
	['widgets:WIDGETS_WINCRM_HTTP_TIMEOUT_MS', '3000'],
	['identity:WINCRM_INVITATION_EMAIL_ENABLED', 'false']
]) fallbacks.set(ownerKey, fallback);
for (const [ownerKey, optional] of [
	['billing:BILLING_CRM_ACCESS_COMMERCE_BASE_URL', !crmPayments],
	['billing:BILLING_CRM_ACCESS_COMMERCE_TOKEN', !crmPayments],
	['billing:BILLING_WINCRM_PROVIDER_RABBITMQ_URL', !crmPayments && !crmReconciliation],
	['billing:BILLING_WINCRM_WIDGETS_TOKEN', !crmEligibility],
	['billing:BILLING_WINCRM_CRM_INTAKE_TOKEN', !crmEligibility],
	['widgets:WIDGETS_CRM_INTAKE_TOKEN', !crmWidgets],
	['widgets:BILLING_WINCRM_WIDGETS_TOKEN', !crmWidgets],
	['identity:IDENTITY_NOTIFICATION_DELIVERY_TOKEN', !crmEmail && !crmEmailReader],
	['notification-delivery:IDENTITY_NOTIFICATION_DELIVERY_TOKEN', !crmEmailReader]
]) {
	if (!optional) continue;
	explicitlyOptionalEmptyValues.add(ownerKey);
	fallbacks.set(ownerKey, '');
}
overrides.set(
	'operations:DATABASE_RESTORE_STAGING_DIR',
	'/var/lib/winwidget-operations/restore-staging'
);
overrides.set(
	'operations:DATABASE_RESTORE_SEALED_DIR',
	'/var/lib/winwidget-operations/restore-sealed'
);
overrides.set(
	'operations:DATABASE_BACKUP_PROVENANCE_KEY_ID',
	'operations-backup-ed25519-2026-08-31'
);
overrides.set(
	'operations:DATABASE_BACKUP_PROVENANCE_PRIVATE_KEY_FILE',
	'/run/winwidget-operations-secrets/database-backup-provenance-private-key.pem'
);
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
	if [[ ! -f "$staged_env" || -L "$staged_env" ]]; then
		die "A materialized service env is missing or unsafe: $app_name (type)."
	fi
	staged_env_metadata="$(stat -c '%u:%g:%a:%h' "$staged_env")"
	[[ "$staged_env_metadata" == '0:0:600:1' ]] ||
		die "A materialized service env is missing or unsafe: $app_name (metadata $staged_env_metadata)."
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

operations_image_entrypoint="$(
	docker image inspect --format '{{json .Config.Entrypoint}}' \
		"winwidget-operations:git-$services_revision" 2>/dev/null
)" || die 'Cannot inspect the Operations image entrypoint.'
operations_image_user="$(
	docker image inspect --format '{{.Config.User}}' \
		"winwidget-operations:git-$services_revision" 2>/dev/null
)" || die 'Cannot inspect the Operations image runtime identity.'
[[ "$operations_image_entrypoint" == \
	'["/usr/local/bin/operations-entrypoint.sh"]' &&
	"$operations_image_user" == 'operations' ]] ||
	die 'Operations image entrypoint or default runtime identity is invalid.'

readonly operations_restore_host_root='/var/lib/winwidget-operations'
readonly operations_restore_staging='/var/lib/winwidget-operations/restore-staging'
readonly operations_restore_sealed='/var/lib/winwidget-operations/restore-sealed'
if [[ ! -e "$operations_restore_host_root" &&
	! -L "$operations_restore_host_root" ]]; then
	install -d -o root -g root -m 0755 "$operations_restore_host_root"
fi
assert_root_owned_directory "$operations_restore_host_root"
for operations_restore_storage in \
	"$operations_restore_staging" \
	"$operations_restore_sealed"; do
	if [[ ! -e "$operations_restore_storage" &&
		! -L "$operations_restore_storage" ]]; then
		install -d -o 1001 -g 1001 -m 0700 "$operations_restore_storage"
	fi
	[[ -d "$operations_restore_storage" && ! -L "$operations_restore_storage" &&
		"$(realpath -e "$operations_restore_storage")" == \
			"$operations_restore_storage" &&
		"$(stat -c '%u:%g:%a' "$operations_restore_storage")" == '1001:1001:700' ]] ||
		die 'Operations restore storage must be canonical UID/GID 1001 mode 0700.'
	docker run --rm \
		--interactive \
		--network none \
		--read-only \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=8m \
		--cap-drop ALL \
		--security-opt no-new-privileges \
		--pids-limit 32 \
		--log-driver none \
		--user 1001:1001 \
		--volume "$operations_restore_storage:/run/winwidget/restore-storage" \
		--entrypoint node \
		"winwidget-operations:git-$services_revision" - <<'RESTORE_STORAGE_PROBE'
const { randomUUID } = require('node:crypto');
const { open, unlink } = require('node:fs/promises');

(async () => {
	const path = `/run/winwidget/restore-storage/.write-probe-${randomUUID()}`;
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
done
[[ "$(stat -c '%d:%i' "$operations_restore_staging")" != \
	"$(stat -c '%d:%i' "$operations_restore_sealed")" ]] ||
	die 'Operations restore staging and sealed storage must not alias one host directory.'

docker run --rm \
	--interactive \
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
	const immutableBackupProvenanceRootEnvKeys = [
		'DATABASE_BACKUP_PROVENANCE_KEY_ID',
		'DATABASE_BACKUP_PROVENANCE_PRIVATE_KEY_HOST_FILE'
	];
	if (immutableBackupProvenanceRootEnvKeys.some(key => values.has(key))) fail();
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
	if (!Array.isArray(routes) || routes.length !== 42) fail();
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
	if (routes.filter(route => route.upstreamUrl === 'http://127.0.0.1:5200').length !== 7) fail();
} catch {
	process.stderr.write('Production env failed the apps-only services contract.\n');
	process.exit(1);
}
ENV_CONTRACT

compose_contract_validator=''
read -r -d '' compose_contract_validator <<'COMPOSE_CONTRACT' || true
const fs = require('node:fs');
const path = require('node:path');

function fail(reason = 'invalid production Compose contract') {
	throw new Error(reason);
}

function sorted(values) {
	return [...values].sort((left, right) => left.localeCompare(right));
}

function isPathEqualOrAncestor(ancestor, candidate) {
	if (
		typeof ancestor !== 'string' ||
		typeof candidate !== 'string' ||
		!path.posix.isAbsolute(ancestor) ||
		!path.posix.isAbsolute(candidate)
	) return false;
	const normalizedAncestor = path.posix.normalize(ancestor);
	const normalizedCandidate = path.posix.normalize(candidate);
	return (
		normalizedAncestor === normalizedCandidate ||
		normalizedCandidate.startsWith(
			normalizedAncestor === '/'
				? '/'
				: `${normalizedAncestor}/`
		)
	);
}

function validBase64HmacKey(value) {
	if (
		typeof value !== 'string' ||
		!/^[A-Za-z0-9+/]+={0,2}$/.test(value)
	) {
		return false;
	}
	const decoded = Buffer.from(value, 'base64');
	const valid =
		decoded.length >= 32 &&
		decoded.toString('base64').replace(/=+$/u, '') ===
			value.replace(/=+$/u, '');
	decoded.fill(0);
	return valid;
}

try {
	const config = JSON.parse(fs.readFileSync(0, 'utf8'));
	const services = config.services;
	if (!services || typeof services !== 'object' || Array.isArray(services)) fail();
	const backupProvenancePrivateKeyHostFile =
		'/opt/winwidget/deploy/backend/.database-backup-provenance-private-key.pem';
	const backupProvenanceSecretNames = Object.entries(config.secrets ?? {})
		.filter(([, secret]) => secret?.file === backupProvenancePrivateKeyHostFile)
		.map(([name]) => name);
	if (
		config.secrets?.['database-backup-provenance-private-key']?.file !==
			backupProvenancePrivateKeyHostFile ||
		JSON.stringify(backupProvenanceSecretNames) !==
			JSON.stringify(['database-backup-provenance-private-key'])
	) fail();
	const restoreWorker = services['operations-restore-worker'];
	const operationsApi = services['operations-api'];
	const operationsWorker = services['operations-worker'];
	if (!restoreWorker || !operationsApi || !operationsWorker) fail();
	for (const name of [
		'operations-api',
		'operations-outbox-publisher',
		'operations-migrate',
		'operations-restore-worker'
	]) {
		if (!services[name] || Object.hasOwn(services[name], 'user')) fail();
	}
	if (
		restoreWorker.labels?.['com.winwidget.singleton'] !== 'true' ||
		restoreWorker.deploy?.replicas !== 1
	) fail();
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
		['identity', 'IDENTITY', '55438'],
		['platform', 'PLATFORM', '55439'],
		['support', 'SUPPORT', '55440']
	];
	const expectedTopLevelSecrets = [
		'database-backup-provenance-private-key',
		'billing-postgres-admin-password',
		'operations-postgres-admin-password',
		...databaseTargets.map(([slug]) => `${slug}-postgres-admin-password`)
	].sort();
	if (
		JSON.stringify(Object.keys(config.secrets ?? {}).sort()) !==
		JSON.stringify(expectedTopLevelSecrets)
	) fail();
	const environment = restoreWorker.environment ?? {};
	const apiEnvironment = operationsApi.environment ?? {};
	const restoreReceiptEnvironmentKeys = [
		'DATABASE_RESTORE_RECEIPT_HMAC_KEY_BASE64',
		'DATABASE_RESTORE_RECEIPT_HMAC_KEY_ID'
	];
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
		'DATABASE_RESTORE_STAGING_DIR',
		'DATABASE_RESTORE_SEALED_DIR',
		'DATABASE_RESTORE_ARTIFACT_RETENTION_HOURS',
		'DATABASE_RESTORE_ENABLED',
		...restoreReceiptEnvironmentKeys
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
		!['false', 'true'].includes(environment.DATABASE_RESTORE_ENABLED) ||
		environment.DATABASE_RESTORE_STAGING_DIR !== '/var/lib/winwidget-operations/restore-staging' ||
		environment.DATABASE_RESTORE_SEALED_DIR !== '/var/lib/winwidget-operations/restore-sealed' ||
		environment.DATABASE_RESTORE_ARTIFACT_RETENTION_HOURS !== '168' ||
		environment.RABBITMQ_CONNECTION_NAME !== 'winwidget-operations-restore-worker' ||
		environment.RABBITMQ_ASSERT_TOPOLOGY !== 'true'
	) fail();
	if (
		apiEnvironment.DATABASE_RESTORE_ENABLED !==
			environment.DATABASE_RESTORE_ENABLED ||
		apiEnvironment.DATABASE_RESTORE_STAGING_DIR !==
			environment.DATABASE_RESTORE_STAGING_DIR ||
		'DATABASE_RESTORE_SEALED_DIR' in apiEnvironment ||
		!validBase64HmacKey(
			apiEnvironment.DATABASE_RESTORE_RECEIPT_HMAC_KEY_BASE64
		) ||
		apiEnvironment.DATABASE_RESTORE_RECEIPT_HMAC_KEY_BASE64 !==
			environment.DATABASE_RESTORE_RECEIPT_HMAC_KEY_BASE64 ||
		!/^[A-Za-z0-9._:-]{1,80}$/.test(
			apiEnvironment.DATABASE_RESTORE_RECEIPT_HMAC_KEY_ID ?? ''
		) ||
		apiEnvironment.DATABASE_RESTORE_RECEIPT_HMAC_KEY_ID !==
			environment.DATABASE_RESTORE_RECEIPT_HMAC_KEY_ID
	) fail();
	for (const [name, service] of Object.entries(services)) {
		const receiptKeyCount = restoreReceiptEnvironmentKeys.filter(key =>
			Object.hasOwn(service.environment ?? {}, key)
		).length;
		if (name === 'operations-api' || name === 'operations-restore-worker') {
			if (receiptKeyCount !== restoreReceiptEnvironmentKeys.length) fail();
		} else if (receiptKeyCount !== 0) fail();
	}
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

	const backupProvenanceEnvironmentKeys = [
		'DATABASE_BACKUP_PROVENANCE_KEY_ID',
		'DATABASE_BACKUP_PROVENANCE_PRIVATE_KEY_FILE'
	];
	for (const [name, service] of Object.entries(services)) {
		const count = backupProvenanceEnvironmentKeys.filter(key =>
			Object.hasOwn(service.environment ?? {}, key)
		).length;
		const backupProvenanceSecretMounts = (service.secrets ?? []).filter(
			secret => {
				const sourceSecret = config.secrets?.[secret.source];
				return (
					secret.source === 'database-backup-provenance-private-key' ||
					sourceSecret?.file === backupProvenancePrivateKeyHostFile ||
					secret.target ===
						'database-backup-provenance-private-key-source'
				);
			}
		).length;
		const privateBindMountCount = (service.volumes ?? []).filter(
			mount =>
				mount.type === 'bind' &&
				(isPathEqualOrAncestor(
					mount.source,
					backupProvenancePrivateKeyHostFile
				) ||
					isPathEqualOrAncestor(
						mount.target,
						'/run/secrets/database-backup-provenance-private-key-source'
					) ||
					isPathEqualOrAncestor(
						mount.target,
						'/run/winwidget-operations-secrets/database-backup-provenance-private-key.pem'
					))
		).length;
		const runtimeTmpfsCount = (service.tmpfs ?? []).filter(tmpfs =>
			tmpfs.startsWith('/run/winwidget-operations-secrets:')
		).length;
		if (
			name === 'operations-worker'
				? count !== backupProvenanceEnvironmentKeys.length ||
					backupProvenanceSecretMounts !== 1 ||
					privateBindMountCount !== 0 ||
					runtimeTmpfsCount !== 1
				: count !== 0 ||
					backupProvenanceSecretMounts !== 0 ||
					privateBindMountCount !== 0 ||
					runtimeTmpfsCount !== 0
		) fail();
	}
	if (
		operationsWorker.environment?.DATABASE_BACKUP_PROVENANCE_KEY_ID !==
			'operations-backup-ed25519-2026-08-31' ||
		operationsWorker.environment?.DATABASE_BACKUP_PROVENANCE_PRIVATE_KEY_FILE !==
			'/run/winwidget-operations-secrets/database-backup-provenance-private-key.pem' ||
		operationsWorker.user !== '0:0' ||
		Object.hasOwn(operationsWorker, 'init') ||
		operationsWorker.read_only !== true ||
		JSON.stringify(operationsWorker.security_opt ?? []) !==
			JSON.stringify(['no-new-privileges:true']) ||
		JSON.stringify(operationsWorker.cap_drop ?? []) !==
			JSON.stringify(['ALL']) ||
		JSON.stringify([...(operationsWorker.cap_add ?? [])].sort()) !==
			JSON.stringify(['CHOWN', 'SETGID', 'SETUID'].sort()) ||
		JSON.stringify([...(operationsWorker.tmpfs ?? [])].sort()) !==
			JSON.stringify(
				[
					'/run/winwidget-operations-secrets:size=64k,mode=0700,uid=0,gid=0,noexec,nosuid,nodev',
					'/tmp:size=64m,mode=1777,noexec,nosuid,nodev'
				].sort()
			) ||
		JSON.stringify((operationsWorker.healthcheck?.test ?? []).slice(0, 5)) !==
			JSON.stringify(['CMD', 'gosu', 'operations:nodejs', 'node', '-e']) ||
		JSON.stringify(operationsWorker.secrets ?? []) !==
			JSON.stringify([
				{
					source: 'database-backup-provenance-private-key',
					target: 'database-backup-provenance-private-key-source'
				}
			])
	) fail();

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

	const restoreStaging = environment.DATABASE_RESTORE_STAGING_DIR;
	const restoreSealed = environment.DATABASE_RESTORE_SEALED_DIR;
	for (const [name, service] of Object.entries(services)) {
		const mounts = service.volumes ?? [];
		const restoreMounts = mounts.filter(
			mount =>
				mount.source === restoreStaging ||
				mount.target === restoreStaging ||
				mount.source === restoreSealed ||
				mount.target === restoreSealed
		);
		if (name === 'operations-api') {
			if (
				mounts.length !== 1 ||
				restoreMounts.length !== 1 ||
				restoreMounts[0].type !== 'bind' ||
				restoreMounts[0].source !== restoreStaging ||
				restoreMounts[0].target !== restoreStaging
			) {
				fail(
					`restore mount ${name}: mounts=${mounts.length}, matches=${restoreMounts.length}, ` +
					`type=${restoreMounts[0]?.type ?? 'missing'}, ` +
					`sourceMatch=${restoreMounts[0]?.source === restoreStaging}, ` +
					`targetMatch=${restoreMounts[0]?.target === restoreStaging}`
				);
			}
		} else if (name === 'operations-restore-worker') {
			const expectedMounts = new Map([
				[restoreStaging, restoreStaging],
				[restoreSealed, restoreSealed]
			]);
			if (
				mounts.length !== 2 ||
				restoreMounts.length !== 2 ||
				restoreMounts.some(
					mount =>
						mount.type !== 'bind' ||
						expectedMounts.get(mount.source) !== mount.target
				)
			) fail(`restore mount ${name} does not isolate staging and sealed storage`);
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
	process.stdout.write(environment.DATABASE_RESTORE_ENABLED);
} catch (error) {
	const locations = [
		...(error instanceof Error ? error.stack ?? '' : '').matchAll(
			/\[eval\]:(\d+):(\d+)/g
		)
	];
	const location = locations[1]
		? `${locations[1][1]}:${locations[1][2]}`
		: 'unknown';
	const reason = error instanceof Error ? error.message : 'unknown';
	process.stderr.write(
		`Production Compose failed the Operations restore-worker contract (${location}; ${reason}).\n`
	);
	process.exit(1);
}
COMPOSE_CONTRACT

database_restore_enabled="$(
	compose_all config --format json 2>/dev/null |
	docker run --rm -i \
		--network none \
		--read-only \
		--cap-drop ALL \
		--security-opt no-new-privileges \
		--user 0:0 \
		--env "EXPECTED_SERVICES_REVISION=$services_revision" \
		--entrypoint node \
		"winwidget-api-gateway:git-$services_revision" \
		-e "$compose_contract_validator"
)" || die 'Production Compose apps-only hardening validation failed.'
[[ "$database_restore_enabled" == 'false' ||
	"$database_restore_enabled" == 'true' ]] ||
	die 'Production Compose returned an invalid restore gate.'
readonly database_restore_enabled
unset compose_contract_validator

crm_companion_validator_file="$release_root/.github/scripts/validate-crm-compose.mjs"
[[ -f "$crm_companion_validator_file" && ! -L "$crm_companion_validator_file" ]] ||
	die 'Exact CRM companion environment validator is missing or unsafe.'
crm_companion_validator=''
read -r -d '' crm_companion_validator <<'CRM_COMPANION_CONTRACT' || true
const fs = require('node:fs');
import('/run/winwidget/validate-crm-compose.mjs')
	.then(({ validateCrmCompanionCompose }) => {
		const config = JSON.parse(fs.readFileSync(0, 'utf8'));
		validateCrmCompanionCompose(config, process.env);
	})
	.catch(() => {
		process.stderr.write('Production CRM companion wiring is invalid; private details suppressed.\n');
		process.exitCode = 1;
	});
CRM_COMPANION_CONTRACT
compose_all config --format json 2>/dev/null |
	docker run --rm -i \
		--network none \
		--read-only \
		--cap-drop ALL \
		--security-opt no-new-privileges \
		--user 0:0 \
		--env-file "$env_file" \
		--volume "$crm_companion_validator_file:/run/winwidget/validate-crm-compose.mjs:ro" \
		--entrypoint node \
		"winwidget-api-gateway:git-$services_revision" \
		-e "$crm_companion_validator" ||
	die 'Production CRM companion environment validation failed.'
unset crm_companion_validator

compose_all run --rm --no-deps --interactive operations-worker node - \
	<<'VERIFY_BACKUP_PROVENANCE_KEY' >/dev/null
const {
	createPrivateKey,
	createPublicKey,
	timingSafeEqual
} = require('node:crypto');
const fs = require('node:fs');

const fail = () => {
	throw new Error('backup provenance key verification failed');
};

try {
	if (
		process.pid !== 1 ||
		process.getuid?.() !== 1001 ||
		process.getgid?.() !== 1001
	) fail();
	const processStatus = fs.readFileSync('/proc/1/status', 'utf8');
	const statusLineValue = name => {
		const prefix = `${name}:`;
		const line = processStatus
			.split('\n')
			.find(candidate => candidate.startsWith(prefix));
		return line?.slice(prefix.length).trim();
	};
	const zeroCapability = '0000000000000000';
	if (
		statusLineValue('Groups') !== '' ||
		statusLineValue('NoNewPrivs') !== '1' ||
		['CapInh', 'CapPrm', 'CapEff', 'CapAmb'].some(
			name => statusLineValue(name) !== zeroCapability
		)
	) fail();
	const privateKeyFile =
		process.env.DATABASE_BACKUP_PROVENANCE_PRIVATE_KEY_FILE ?? '';
	const runtimeKeyDirectory = '/run/winwidget-operations-secrets';
	const sourceKeyFile =
		'/run/secrets/database-backup-provenance-private-key-source';
	const keyId = process.env.DATABASE_BACKUP_PROVENANCE_KEY_ID ?? '';
	const runtimeKeyDirectoryStat = fs.lstatSync(runtimeKeyDirectory);
	const privateKeyStat = fs.lstatSync(privateKeyFile);
	const sourceKeyStat = fs.lstatSync(sourceKeyFile);
	if (
		privateKeyFile !==
			'/run/winwidget-operations-secrets/database-backup-provenance-private-key.pem' ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(keyId) ||
		!runtimeKeyDirectoryStat.isDirectory() ||
		runtimeKeyDirectoryStat.uid !== 0 ||
		runtimeKeyDirectoryStat.gid !== 1001 ||
		(runtimeKeyDirectoryStat.mode & 0o777) !== 0o710 ||
		!privateKeyStat.isFile() ||
		privateKeyStat.uid !== 1001 ||
		privateKeyStat.gid !== 1001 ||
		(privateKeyStat.mode & 0o777) !== 0o400 ||
		privateKeyStat.nlink !== 1 ||
		!sourceKeyStat.isFile() ||
		sourceKeyStat.uid !== 0 ||
		sourceKeyStat.gid !== 0 ||
		(sourceKeyStat.mode & 0o777) !== 0o600 ||
		sourceKeyStat.nlink !== 1
	) fail();
	try {
		const unexpectedSource = fs.readFileSync(sourceKeyFile);
		unexpectedSource.fill(0);
		fail();
	} catch (error) {
		if (error?.code !== 'EACCES') fail();
	}
	const privateKeyPem = fs.readFileSync(privateKeyFile);
	let privateKey;
	try {
		privateKey = createPrivateKey(privateKeyPem);
	} finally {
		privateKeyPem.fill(0);
	}
	if (privateKey.asymmetricKeyType !== 'ed25519') fail();
	const keyring = JSON.parse(
		fs.readFileSync(
			'/app/restore-manifests/database-backup-provenance-public-keys.json',
			'utf8'
		)
	);
	const matches = Array.isArray(keyring.keys)
		? keyring.keys.filter(key => key?.keyId === keyId)
		: [];
	if (matches.length !== 1) fail();
	const expectedPublicKey = createPublicKey({
		key: Buffer.from(matches[0].publicKeySpkiDerBase64, 'base64'),
		format: 'der',
		type: 'spki'
	});
	const actualPublicKey = createPublicKey(privateKey).export({
		format: 'der',
		type: 'spki'
	});
	const expectedPublicKeyDer = expectedPublicKey.export({
		format: 'der',
		type: 'spki'
	});
	if (
		expectedPublicKey.asymmetricKeyType !== 'ed25519' ||
		!Buffer.isBuffer(actualPublicKey) ||
		!Buffer.isBuffer(expectedPublicKeyDer) ||
		actualPublicKey.length !== expectedPublicKeyDer.length ||
		!timingSafeEqual(actualPublicKey, expectedPublicKeyDer)
	) fail();
} catch {
	process.stderr.write('Backup provenance private/public key gate failed.\n');
	process.exit(1);
}
VERIFY_BACKUP_PROVENANCE_KEY

# BEGIN WINWIDGET_DOCKER_CLEANUP
inspect_validated_project_container() {
	local container_id="$1" inspection
	local inspected_id raw_name state running paused restarting dead
	local project_name service_name container_number oneoff config_hash extra_field
	local container_name expected_hyphen_name expected_underscore_name
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] ||
		die 'Compose container ID is not an exact full Docker ID.'
	inspection="$(
		docker container inspect --format \
			'{{.Id}}|{{.Name}}|{{.State.Status}}|{{.State.Running}}|{{.State.Paused}}|{{.State.Restarting}}|{{.State.Dead}}|{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.service" }}|{{ index .Config.Labels "com.docker.compose.container-number" }}|{{ index .Config.Labels "com.docker.compose.oneoff" }}|{{ index .Config.Labels "com.docker.compose.config-hash" }}' \
			"$container_id"
	)" || die 'Cannot inspect an exact production Compose container.'
	IFS='|' read -r inspected_id raw_name state running paused restarting dead \
		project_name service_name container_number oneoff config_hash extra_field \
		<<<"$inspection"
	[[ "$inspected_id" == "$container_id" &&
		"$raw_name" =~ ^/[A-Za-z0-9][A-Za-z0-9_.-]*$ &&
		"$project_name" == "$COMPOSE_PROJECT_NAME" &&
		"$service_name" =~ ^[a-z0-9][a-z0-9-]*$ &&
		"$container_number" =~ ^[1-9][0-9]*$ &&
		"$oneoff" =~ ^(True|False)$ &&
		"$config_hash" =~ ^[0-9a-f]{64}$ && -z "$extra_field" ]] ||
		die 'Production Compose container identity or labels are ambiguous.'

	container_name="${raw_name#/}"
	expected_hyphen_name="${COMPOSE_PROJECT_NAME}-${service_name}-${container_number}"
	expected_underscore_name="${COMPOSE_PROJECT_NAME}_${service_name}_${container_number}"
	if [[ "$oneoff" == 'False' ]]; then
		[[ "$container_name" == "$expected_hyphen_name" ||
			"$container_name" == "$expected_underscore_name" ]] ||
			die 'Compose container name does not match its exact labels.'
	else
		[[ "$container_name" =~ ^${COMPOSE_PROJECT_NAME}-${service_name}-run-[a-z0-9]+$ ||
			"$container_name" =~ ^${COMPOSE_PROJECT_NAME}_${service_name}_run_[a-z0-9]+$ ]] ||
			die 'Compose one-off container name does not match its exact labels.'
	fi

	case "$state" in
		running)
			[[ "$running" == 'true' && "$paused" == 'false' &&
				"$restarting" == 'false' && "$dead" == 'false' ]] ||
				die 'Running Compose container state is internally inconsistent.'
			;;
		created | exited)
			[[ "$running" == 'false' && "$paused" == 'false' &&
				"$restarting" == 'false' && "$dead" == 'false' ]] ||
				die 'Stopped Compose container state is internally inconsistent.'
			;;
		dead)
			[[ "$running" == 'false' && "$paused" == 'false' &&
				"$restarting" == 'false' && "$dead" == 'true' ]] ||
				die 'Dead Compose container state is internally inconsistent.'
			;;
		*)
			die 'Compose container is paused, restarting, removing or in an unknown state.'
			;;
	esac

	printf '%s|%s|%s|%s|%s|%s|%s\n' \
		"$container_id" "$container_name" "$state" "$service_name" \
		"$container_number" "$oneoff" "$config_hash"
}

collect_validated_project_container_inventory() {
	local container_ids container_id
	container_ids="$(
		docker ps -aq --no-trunc \
			--filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" |
			LC_ALL=C sort
	)" || die 'Cannot read the exact production Compose container inventory.'
	[[ -n "$container_ids" ]] ||
		die 'Production Compose container inventory is empty.'
	while IFS= read -r container_id; do
		[[ -n "$container_id" ]] || continue
		inspect_validated_project_container "$container_id"
	done <<<"$container_ids"
}

verify_exact_project_container_inventory() {
	local inventory container_id container_name state service_name
	local container_number oneoff config_hash extra_field
	local expected_services actual_services
	local -a observed_services=()
	expected_services="$({
		printf '%s\n' "${infrastructure_services[@]}"
		printf '%s\n' "${runtime_services[@]}"
	} | LC_ALL=C sort)"
	inventory="$(collect_validated_project_container_inventory)" ||
		die 'Cannot validate the production Compose container inventory.'
	while IFS='|' read -r container_id container_name state service_name \
		container_number oneoff config_hash extra_field; do
		[[ "$container_id" =~ ^[0-9a-f]{64}$ &&
			"$container_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ &&
			"$service_name" =~ ^[a-z0-9][a-z0-9-]*$ &&
			"$container_number" =~ ^[1-9][0-9]*$ &&
			"$oneoff" =~ ^(True|False)$ &&
			"$config_hash" =~ ^[0-9a-f]{64}$ && -z "$extra_field" ]] ||
			die 'Validated Compose container inventory contains an invalid entry.'
		if [[ "$state" == 'running' ]]; then
			observed_services+=("$service_name")
		fi
	done <<<"$inventory"
	actual_services="$(printf '%s\n' "${observed_services[@]}" | LC_ALL=C sort)"
	[[ "$actual_services" == "$expected_services" ]] ||
		die 'Live running Compose service inventory differs from the exact manifest contract.'
}

capture_running_container_ids() {
	local running_ids container_id
	running_ids="$(docker ps --no-trunc --format '{{.ID}}' | LC_ALL=C sort)" ||
		die 'Cannot capture the global running Docker container inventory.'
	[[ -n "$running_ids" ]] ||
		die 'Global running Docker container inventory is empty.'
	while IFS= read -r container_id; do
		[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] ||
			die 'Global running Docker container inventory is ambiguous.'
	done <<<"$running_ids"
	printf '%s\n' "$running_ids"
}

capture_container_image_bindings() {
	local container_ids container_id binding inspected_id image_id extra_field
	local -a bindings=()
	container_ids="$(docker ps -aq --no-trunc | LC_ALL=C sort)" ||
		die 'Cannot capture the global Docker container inventory.'
	[[ -n "$container_ids" ]] ||
		die 'Global Docker container inventory is empty.'
	while IFS= read -r container_id; do
		[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] ||
			die 'Global Docker container inventory contains an invalid ID.'
		binding="$(
			docker container inspect --format '{{.Id}}|{{.Image}}' "$container_id"
		)" || die 'Cannot inspect a protected Docker container image binding.'
		IFS='|' read -r inspected_id image_id extra_field <<<"$binding"
		[[ "$inspected_id" == "$container_id" &&
			"$image_id" =~ ^sha256:[0-9a-f]{64}$ && -z "$extra_field" ]] ||
			die 'Docker container image binding is ambiguous.'
		bindings+=("$inspected_id|$image_id")
	done <<<"$container_ids"
	printf '%s\n' "${bindings[@]}" | LC_ALL=C sort
}

collect_obsolete_winwidget_image_references() {
	local protected_bindings="$1" image_inventory repository tag image_id
	local _digest extra_field image_reference seen_references=$'\n'
	local -a candidates=()
	image_inventory="$(
		docker image ls --no-trunc \
			--format '{{.Repository}}|{{.Tag}}|{{.ID}}|{{.Digest}}'
	)" || die 'Cannot inspect the Docker image inventory.'
	while IFS='|' read -r repository tag image_id _digest extra_field; do
		[[ -z "$extra_field" ]] ||
			die 'Docker image inventory contains an ambiguous entry.'
		[[ "$repository" == winwidget-* ]] || continue
		# The independent winwidget-crm release controller owns these references,
		# including unused candidate/rollback tags with no container binding.
		[[ "$repository" != winwidget-crm-* ]] || continue
		[[ "$repository" =~ ^winwidget-[a-z0-9][a-z0-9._-]*$ &&
			"$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ &&
			"$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] ||
			die 'A WinWidget image reference is not safe for exact cleanup.'
		image_reference="$repository:$tag"
		[[ "$seen_references" != *$'\n'"$image_reference"$'\n'* ]] ||
			die 'A WinWidget image reference is duplicated in Docker inventory.'
		seen_references+="$image_reference"$'\n'
		if ! awk -F'|' -v expected_image="$image_id" \
			'$2 == expected_image { found = 1 } END { exit(found ? 0 : 1) }' \
			<<<"$protected_bindings"; then
			candidates+=("$image_reference|$image_id")
		fi
	done <<<"$image_inventory"
	if ((${#candidates[@]})); then
		printf '%s\n' "${candidates[@]}" | LC_ALL=C sort
	fi
}

verify_project_has_no_stopped_containers() {
	local inventory container_id container_name state service_name
	local container_number oneoff config_hash extra_field
	inventory="$(collect_validated_project_container_inventory)" ||
		die 'Cannot validate Compose inventory after exact cleanup.'
	while IFS='|' read -r container_id container_name state service_name \
		container_number oneoff config_hash extra_field; do
		[[ "$state" == 'running' && -z "$extra_field" ]] ||
			die 'A stopped Compose project container remains after exact cleanup.'
	done <<<"$inventory"
}

cleanup_obsolete_winwidget_docker_resources() {
	local running_ids_before running_ids_current running_ids_after
	local project_inventory expected_record current_record
	local container_id container_name state service_name container_number oneoff
	local config_hash extra_field container_candidate_count=0
	local protected_bindings_before protected_bindings_current protected_bindings_after
	local image_candidates image_reference image_id resolved_image_id
	local image_candidate_count=0 remaining_candidates
	local -a container_candidates=()
	local -a obsolete_image_candidates=()

	running_ids_before="$(capture_running_container_ids)" ||
		die 'Cannot preserve the running Docker container set before cleanup.'
	project_inventory="$(collect_validated_project_container_inventory)" ||
		die 'Cannot inspect exact stopped Compose cleanup candidates.'
	while IFS='|' read -r container_id container_name state service_name \
		container_number oneoff config_hash extra_field; do
		[[ -z "$extra_field" ]] ||
			die 'Stopped Compose cleanup candidate is ambiguous.'
		if [[ "$state" != 'running' ]]; then
			container_candidates+=(
				"$container_id|$container_name|$state|$service_name|$container_number|$oneoff|$config_hash"
			)
		fi
	done <<<"$project_inventory"

	if ((${#container_candidates[@]})); then
		for expected_record in "${container_candidates[@]}"; do
			IFS='|' read -r container_id container_name state service_name \
				container_number oneoff config_hash extra_field <<<"$expected_record"
			[[ "$state" =~ ^(created|exited|dead)$ && -z "$extra_field" ]] ||
				die 'Stopped Compose cleanup target changed classification.'
			running_ids_current="$(capture_running_container_ids)" ||
				die 'Cannot recheck running containers before exact container removal.'
			[[ "$running_ids_current" == "$running_ids_before" ]] ||
				die 'Running Docker container set changed during stopped-container cleanup.'
			current_record="$(inspect_validated_project_container "$container_id")" ||
				die 'Cannot revalidate an exact stopped Compose cleanup target.'
			[[ "$current_record" == "$expected_record" ]] ||
				die 'Stopped Compose cleanup target changed after inventory capture.'
			docker container rm -- "$container_id" >/dev/null ||
				die 'Exact stopped Compose container removal failed.'
			if docker container inspect "$container_id" >/dev/null 2>&1; then
				die 'Exact stopped Compose container still exists after removal.'
			fi
			container_candidate_count=$((container_candidate_count + 1))
		done
	fi

	running_ids_current="$(capture_running_container_ids)" ||
		die 'Cannot recheck running containers after stopped-container cleanup.'
	[[ "$running_ids_current" == "$running_ids_before" ]] ||
		die 'Running Docker container set changed after stopped-container cleanup.'
	verify_project_has_no_stopped_containers
	verify_exact_project_container_inventory

	protected_bindings_before="$(capture_container_image_bindings)" ||
		die 'Cannot preserve container image bindings before image cleanup.'
	image_candidates="$(
		collect_obsolete_winwidget_image_references "$protected_bindings_before"
	)" || die 'Cannot classify unused WinWidget image references.'
	if [[ -n "$image_candidates" ]]; then
		while IFS= read -r expected_record; do
			[[ -n "$expected_record" ]] || continue
			obsolete_image_candidates+=("$expected_record")
		done <<<"$image_candidates"
	fi

	if ((${#obsolete_image_candidates[@]})); then
		for expected_record in "${obsolete_image_candidates[@]}"; do
			IFS='|' read -r image_reference image_id extra_field <<<"$expected_record"
			[[ "$image_reference" =~ ^winwidget-[a-z0-9][a-z0-9._-]*:[A-Za-z0-9_][A-Za-z0-9_.-]*$ &&
				"$image_id" =~ ^sha256:[0-9a-f]{64}$ && -z "$extra_field" ]] ||
				die 'Unused WinWidget image cleanup target is ambiguous.'
			protected_bindings_current="$(capture_container_image_bindings)" ||
				die 'Cannot recheck protected image bindings before exact image removal.'
			[[ "$protected_bindings_current" == "$protected_bindings_before" ]] ||
				die 'Docker container image bindings changed during image cleanup.'
			resolved_image_id="$(
				docker image inspect --format '{{.Id}}' "$image_reference"
			)" || die 'Unused WinWidget image reference disappeared before cleanup.'
			[[ "$resolved_image_id" == "$image_id" ]] ||
				die 'Unused WinWidget image reference changed after inventory capture.'
			if awk -F'|' -v expected_image="$image_id" \
				'$2 == expected_image { found = 1 } END { exit(found ? 0 : 1) }' \
				<<<"$protected_bindings_current"; then
				die 'A cleanup image became attached to a Docker container.'
			fi
			running_ids_current="$(capture_running_container_ids)" ||
				die 'Cannot recheck running containers before exact image removal.'
			[[ "$running_ids_current" == "$running_ids_before" ]] ||
				die 'Running Docker container set changed before exact image removal.'
			docker image rm --no-prune -- "$image_reference" >/dev/null ||
				die 'Exact unused WinWidget image reference removal failed.'
			running_ids_current="$(capture_running_container_ids)" ||
				die 'Cannot recheck running containers after exact image removal.'
			[[ "$running_ids_current" == "$running_ids_before" ]] ||
				die 'Running Docker container set changed after exact image removal.'
			if docker image inspect "$image_reference" >/dev/null 2>&1; then
				die 'Unused WinWidget image reference still exists after removal.'
			fi
			image_candidate_count=$((image_candidate_count + 1))
		done
	fi

	protected_bindings_after="$(capture_container_image_bindings)" ||
		die 'Cannot verify container image bindings after image cleanup.'
	[[ "$protected_bindings_after" == "$protected_bindings_before" ]] ||
		die 'Docker container image bindings changed after image cleanup.'
	remaining_candidates="$(
		collect_obsolete_winwidget_image_references "$protected_bindings_after"
	)" || die 'Cannot verify the final WinWidget image inventory.'
	[[ -z "$remaining_candidates" ]] ||
		die 'An unused tagged WinWidget image remains after exact cleanup.'
	running_ids_after="$(capture_running_container_ids)" ||
		die 'Cannot verify running containers after Docker cleanup.'
	[[ "$running_ids_after" == "$running_ids_before" ]] ||
		die 'Running Docker container set changed during exact Docker cleanup.'
	verify_project_has_no_stopped_containers
	verify_exact_project_container_inventory

	printf 'Exact WinWidget Docker cleanup completed: stopped_containers=%s image_references=%s\n' \
		"$container_candidate_count" "$image_candidate_count"
}
# END WINWIDGET_DOCKER_CLEANUP

verify_operations_database_boundary() {
	compose_all run --rm --no-deps --interactive \
		--entrypoint node \
		operations-api - <<'VERIFY_OPERATIONS_DATABASE_BOUNDARY' >/dev/null
const { PrismaClient } = require('@prisma/operations-client');

const databaseUrl = process.env.OPERATIONS_DATABASE_URL ?? '';
if (!databaseUrl) process.exit(1);
const client = new PrismaClient({
	datasources: { db: { url: databaseUrl } }
});
const expectedCriticalTables = [
	'admin_event_logs',
	'database_restore_jobs',
	'outbox_events',
	'scheduled_job_runs',
	'telegram_bot_settings'
];

(async () => {
	const [identityRows, roleRows, tableRows] = await Promise.all([
		client.$queryRaw`
			SELECT
				current_database()::text AS "databaseName",
				current_user::text AS "databaseUser",
				current_schema()::text AS "schemaName",
				pg_is_in_recovery() AS "inRecovery",
				pg_get_userbyid(database_entry.datdba)::text AS "databaseOwner",
				pg_get_userbyid(schema_entry.nspowner)::text AS "schemaOwner",
				has_schema_privilege(current_user, 'operations', 'USAGE') AS "schemaUsage",
				has_schema_privilege(current_user, 'operations', 'CREATE') AS "schemaCreate"
			FROM pg_database AS database_entry
			JOIN pg_namespace AS schema_entry
				ON schema_entry.nspname = 'operations'
			WHERE database_entry.datname = current_database()
		`,
		client.$queryRaw`
			SELECT
				role_entry.rolname::text AS "roleName",
				role_entry.rolsuper AS "superuser",
				role_entry.rolcreatedb AS "createDatabase",
				role_entry.rolcreaterole AS "createRole",
				role_entry.rolreplication AS "replication",
				role_entry.rolbypassrls AS "bypassRls"
			FROM pg_roles AS role_entry
			WHERE role_entry.rolname IN (
				'winwidget_operations_runtime',
				'winwidget_operations_migration'
			)
			ORDER BY role_entry.rolname
		`,
		client.$queryRaw`
			SELECT table_name::text AS "tableName"
			FROM information_schema.tables
			WHERE table_schema = 'operations'
				AND table_type = 'BASE TABLE'
				AND table_name IN (
					'admin_event_logs',
					'database_restore_jobs',
					'outbox_events',
					'scheduled_job_runs',
					'telegram_bot_settings'
				)
			ORDER BY table_name
		`
	]);
	if (
		identityRows.length !== 1 ||
		identityRows[0].databaseName !== 'winwidget_operations' ||
		identityRows[0].databaseUser !== 'winwidget_operations_runtime' ||
		identityRows[0].schemaName !== 'operations' ||
		identityRows[0].inRecovery !== false ||
		identityRows[0].databaseOwner !== 'winwidget_operations_admin' ||
		identityRows[0].schemaOwner !== 'winwidget_operations_migration' ||
		identityRows[0].schemaUsage !== true ||
		identityRows[0].schemaCreate !== false
	) throw new Error('invalid Operations database identity');
	if (
		roleRows.length !== 2 ||
		roleRows.some(
			role =>
				!['winwidget_operations_migration', 'winwidget_operations_runtime'].includes(
					role.roleName
				) ||
				role.superuser !== false ||
				role.createDatabase !== false ||
				role.createRole !== false ||
				role.replication !== false ||
				role.bypassRls !== false
		)
	) throw new Error('invalid Operations database role boundary');
	if (
		JSON.stringify(tableRows.map(row => row.tableName)) !==
		JSON.stringify(expectedCriticalTables)
	) throw new Error('missing Operations steady-state table');
})()
	.catch(() => {
		process.stderr.write('Operations database boundary preflight failed.\n');
		process.exitCode = 1;
	})
	.finally(async () => {
		await client.$disconnect();
	});
VERIFY_OPERATIONS_DATABASE_BOUNDARY
}

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

verify_operations_worker_runtime_identity() {
	local container_id
	local -a container_ids=()
	mapfile -t container_ids < <(
		compose_all ps --status running -q operations-worker 2>/dev/null
	)
	[[ "${#container_ids[@]}" -eq 1 &&
		"${container_ids[0]}" =~ ^[0-9a-f]{64}$ ]] ||
		die 'Operations worker must have exactly one running container for PID 1 verification.'
	container_id="${container_ids[0]}"

	docker exec --user 1001:1001 --interactive "$container_id" node - \
		<<'VERIFY_OPERATIONS_WORKER_RUNTIME_IDENTITY' >/dev/null
const fs = require('node:fs');

const fail = () => {
	throw new Error('operations worker runtime identity verification failed');
};

try {
	if (process.getuid?.() !== 1001 || process.getgid?.() !== 1001) fail();
	const status = fs.readFileSync('/proc/1/status', 'utf8');
	const processName = status.match(/^Name:\s+(.+)$/m)?.[1]?.trim();
	const uidValues = status.match(/^Uid:\s+(.+)$/m)?.[1]?.trim().split(/\s+/);
	const gidValues = status.match(/^Gid:\s+(.+)$/m)?.[1]?.trim().split(/\s+/);
	const statusLineValue = name => {
		const prefix = `${name}:`;
		const line = status
			.split('\n')
			.find(candidate => candidate.startsWith(prefix));
		return line?.slice(prefix.length).trim();
	};
	const zeroCapability = '0000000000000000';
	if (
		processName !== 'node' ||
		uidValues?.length !== 4 ||
		gidValues?.length !== 4 ||
		!uidValues.every(value => value === '1001') ||
		!gidValues.every(value => value === '1001') ||
		statusLineValue('Groups') !== '' ||
		statusLineValue('NoNewPrivs') !== '1' ||
		['CapInh', 'CapPrm', 'CapEff', 'CapAmb'].some(
			name => statusLineValue(name) !== zeroCapability
		)
	) fail();

	const privateKeyFile =
		process.env.DATABASE_BACKUP_PROVENANCE_PRIVATE_KEY_FILE ?? '';
	const runtimeKeyDirectory = '/run/winwidget-operations-secrets';
	const sourceKeyFile =
		'/run/secrets/database-backup-provenance-private-key-source';
	const runtimeKeyDirectoryStat = fs.lstatSync(runtimeKeyDirectory);
	const privateKeyStat = fs.lstatSync(privateKeyFile);
	const sourceKeyStat = fs.lstatSync(sourceKeyFile);
	if (
		privateKeyFile !==
			'/run/winwidget-operations-secrets/database-backup-provenance-private-key.pem' ||
		!runtimeKeyDirectoryStat.isDirectory() ||
		runtimeKeyDirectoryStat.uid !== 0 ||
		runtimeKeyDirectoryStat.gid !== 1001 ||
		(runtimeKeyDirectoryStat.mode & 0o777) !== 0o710 ||
		!privateKeyStat.isFile() ||
		privateKeyStat.uid !== 1001 ||
		privateKeyStat.gid !== 1001 ||
		(privateKeyStat.mode & 0o777) !== 0o400 ||
		privateKeyStat.nlink !== 1 ||
		!sourceKeyStat.isFile() ||
		sourceKeyStat.uid !== 0 ||
		sourceKeyStat.gid !== 0 ||
		(sourceKeyStat.mode & 0o777) !== 0o600 ||
		sourceKeyStat.nlink !== 1
	) fail();
	const privateKeyDescriptor = fs.openSync(privateKeyFile, 'r');
	fs.closeSync(privateKeyDescriptor);
	try {
		const unexpectedSource = fs.readFileSync(sourceKeyFile);
		unexpectedSource.fill(0);
		fail();
	} catch (error) {
		if (error?.code !== 'EACCES') fail();
	}
} catch {
	process.stderr.write('Operations worker PID 1 identity gate failed.\n');
	process.exit(1);
}
VERIFY_OPERATIONS_WORKER_RUNTIME_IDENTITY
}

verify_singleton_running_service() {
	local service_name="$1" container_id singleton_label
	local -a container_ids=()
	mapfile -t container_ids < <(
		compose_all ps --status running -q "$service_name" 2>/dev/null
	)
	[[ "${#container_ids[@]}" -eq 1 && -n "${container_ids[0]}" ]] ||
		die "Production singleton service must have exactly one running container: $service_name"
	container_id="${container_ids[0]}"
	singleton_label="$(
		docker inspect --format '{{ index .Config.Labels "com.winwidget.singleton" }}' \
			"$container_id" 2>/dev/null
	)" || die "Cannot verify singleton label: $service_name"
	[[ "$singleton_label" == 'true' ]] ||
		die "Production singleton label is missing: $service_name"
}

wait_for_healthy_services "${infrastructure_services[@]}"
wait_for_healthy_services "${runtime_services[@]}"
verify_exact_project_container_inventory
verify_operations_database_boundary

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

notification_topology_contract="$(
	docker run --rm \
		--interactive \
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
		--interactive \
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
		--interactive \
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
// This is a provisioned topology contract, not a product feature flag.
const crmContract = process.env.CRM_RABBITMQ_CONTRACT ?? 'disabled';
if (!['disabled', 'mvp-v1'].includes(crmContract)) process.exit(1);
const crmUsers = crmContract === 'mvp-v1' ? [
	'winwidget-crm-access-worker',
	'winwidget-crm-access-outbox-publisher',
	'winwidget-crm-intake-worker',
	'winwidget-crm-intake-publisher',
	'winwidget-crm-intake-widget-control-worker',
	'winwidget-crm-intake-widget-control-publisher',
	'winwidget-crm-intake-widget-transfer-worker',
	'winwidget-crm-intake-widget-transfer-publisher',
	'winwidget-billing-wincrm-provider-worker'
] : [];
const names = [admin, monitor, ...expectedServiceUsers, ...crmUsers];
if (
	names.some(name => !/^[A-Za-z0-9._-]+$/.test(name)) ||
	new Set(names).size !== names.length
) process.exit(1);
process.stdout.write(names.sort().join('\n'));
RABBITMQ_EXPECTED_USERS
)" || die 'Cannot extract the exact RabbitMQ user inventory contract.'
[[ -n "$rabbitmq_expected_user_names" ]] ||
	die 'RabbitMQ user inventory contract is empty.'

verify_current_rabbitmq_user_inventory() {
	local rabbitmq_container_id actual_user_names
	rabbitmq_container_id="$(compose_all ps --status running -q rabbitmq 2>/dev/null)"
	[[ -n "$rabbitmq_container_id" && "$rabbitmq_container_id" != *$'\n'* ]] ||
		die 'Exactly one running RabbitMQ container is required for the preflight.'
	actual_user_names="$(
		docker exec "$rabbitmq_container_id" rabbitmqctl --silent list_users |
			awk 'NF { print $1 }' | LC_ALL=C sort
	)" || die 'Cannot read the current RabbitMQ user inventory.'
	[[ "$actual_user_names" == "$rabbitmq_expected_user_names" ]] ||
		die 'Current RabbitMQ user inventory differs from the exact apps-only contract.'
}

verify_database_restore_activation_is_idle() {
	local rabbitmq_container_id queue_inventory queue_name queue_state
	[[ "$database_restore_enabled" == 'true' ]] || return 0

	compose_all run --rm --no-deps --interactive \
		--entrypoint node \
		operations-api - <<'VERIFY_DATABASE_RESTORE_ACTIVATION_IDLE' >/dev/null
const { PrismaClient } = require('@prisma/operations-client');

const databaseUrl = process.env.OPERATIONS_DATABASE_URL ?? '';
if (!databaseUrl) process.exit(1);
const client = new PrismaClient({
	datasources: { db: { url: databaseUrl } }
});

(async () => {
	const [jobs, permits, recoveryActions, outboxEvents, lease] =
		await Promise.all([
			client.databaseRestoreJob.count({
				where: {
					OR: [
						{ status: { in: ['QUEUED', 'PROCESSING'] } },
						{
							status: 'RECOVERY_REQUIRED',
							recoveryResolvedAt: null
						}
					]
				}
			}),
			client.databaseRestorePermit.count({
				where: {
					status: {
						in: ['PENDING_APPROVAL', 'APPROVED', 'CONSUMED']
					}
				}
			}),
			client.databaseRestoreRecoveryAction.count({
				where: { status: { notIn: ['RESOLVED', 'EXPIRED'] } }
			}),
			client.outboxEvent.count({
				where: {
					eventType: {
						in: [
							'operations.database-restore.requested.v1',
							'operations.database-restore.recovery-action.requested.v1'
						]
					},
					status: { in: ['PENDING', 'PROCESSING'] }
				}
			}),
			client.databaseRestoreExecutionLease.findUnique({
				where: { id: 'singleton' },
				select: {
					operationType: true,
					operationId: true,
					leaseOwner: true,
					leaseToken: true
				}
			})
		]);
	if (
		[jobs, permits, recoveryActions, outboxEvents].some(count => count !== 0) ||
		(lease && Object.values(lease).some(value => value !== null))
	) {
		throw new Error('database restore activation is not idle');
	}
})()
	.catch(() => {
		process.stderr.write('Database restore activation DB inventory is not idle.\n');
		process.exitCode = 1;
	})
	.finally(async () => {
		await client.$disconnect();
	});
VERIFY_DATABASE_RESTORE_ACTIVATION_IDLE

	rabbitmq_container_id="$(compose_all ps --status running -q rabbitmq 2>/dev/null)"
	[[ "$rabbitmq_container_id" =~ ^[0-9a-f]{64}$ ]] ||
		die 'Exactly one running RabbitMQ container is required for restore activation.'
	queue_inventory="$(
		docker exec "$rabbitmq_container_id" rabbitmqctl --silent \
			list_queues -p winwidget name messages_ready messages_unacknowledged
	)" || die 'Cannot read the database restore RabbitMQ queue inventory.'
	for queue_name in \
		winwidget.operations.database-restore.v1 \
		winwidget.operations.database-restore.v1.retry-v1; do
		queue_state="$(
			awk -v queue="$queue_name" \
				'$1 == queue { print $1 ":" $2 ":" $3 }' \
				<<<"$queue_inventory"
		)"
		[[ "$queue_state" == "$queue_name:0:0" ]] ||
			die 'Database restore activation RabbitMQ inventory is not idle.'
	done
}

verify_current_rabbitmq_user_inventory
verify_database_restore_activation_is_idle

docker run --rm \
	--interactive \
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
	--entrypoint node \
	"winwidget-operations:git-$services_revision" - <<'PROVISION_RABBITMQ'
const amqp = require('amqplib');
const constants = require('./dist/src/messaging/operations-messaging.constants.js');

const fail = () => {
	throw new Error('RabbitMQ provisioning contract failed');
};
const value = name => process.env[name] ?? '';
const crmContract = process.env.CRM_RABBITMQ_CONTRACT ?? 'disabled';
if (!['disabled', 'mvp-v1'].includes(crmContract)) fail();
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
	if (!expected.includes(response.status)) {
		const error = new Error('RabbitMQ Management API contract failed');
		error.code = `HTTP_${response.status}`;
		error.context = `${options.method ?? 'GET'}:${path}`;
		throw error;
	}
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
const exactQueuePattern = names => {
	const root = { terminal: false, children: new Map() };
	for (const name of [...names].sort()) {
		let node = root;
		for (const character of name) {
			if (!node.children.has(character)) {
				node.children.set(character, { terminal: false, children: new Map() });
			}
			node = node.children.get(character);
		}
		node.terminal = true;
	}
	const regexMetaCharacters = new Set([
		'\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|'
	]);
	const emit = node => {
		const branches = [...node.children].map(
			([character, child]) =>
				`${regexMetaCharacters.has(character) ? `\\${character}` : character}${emit(child)}`
		);
		if (node.terminal) branches.push('');
		if (branches.length === 1) return branches[0];
		return `(?:${branches.join('|')})`;
	};
	const pattern = `^${emit(root)}$`;
	if (Buffer.byteLength(pattern, 'utf8') > 1024) fail();
	return pattern;
};
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
if (
	crmContract === 'mvp-v1' &&
	(
		!notificationTopology.readRoutingKeys.includes(
			'notification.wincrm.invitation.email.requested.v1'
		) ||
		!notificationTopology.queueNames.includes(
			'winwidget.notification.wincrm.invitation.email'
		)
	)
) fail();
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
const widgetsWriteTopicPattern = '^(widgets\\.(widget|lead)\\.changed\\.v1|lead\\.(integration\\.(email|telegram|webhook|bitrix24|amo-crm)|limit\\.reached\\.(email|telegram))\\.v2|admin\\.audit\\.widgets\\.v1'
	+ (crmContract === 'mvp-v1' ? '|widgets\\.wincrm\\.lead-transfer\\.requested\\.v1' : '')
	+ ')$';
const identityWriteTopicPattern = '^(identity\\.user\\.changed\\.v1|billing\\.(identity\\.changed|referral\\.requested|lifecycle-repair\\.requested)\\.v1|admin\\.audit\\.identity\\.v1'
	+ (crmContract === 'mvp-v1' ? '|identity\\.wincrm\\.invitation-accepted\\.v1|notification\\.wincrm\\.invitation\\.email\\.requested\\.v1' : '')
	+ ')$';
const billingWriteTopicPattern = '^(payment\\.succeeded\\.v1|payment\\.notification\\.telegram\\.requested\\.v1|payment\\.auto-renewal\\.charge\\.requested\\.v1|notification\\.subscription-expiry\\.(email|telegram)\\.requested\\.v1|billing\\.(payment|subscription)(\\.details)?\\.changed\\.v1|billing\\.(affiliate|settings)\\.changed\\.v1|admin\\.audit\\.billing\\.v1'
	+ (crmContract === 'mvp-v1' ? '|billing\\.wincrm\\.provider-operation\\.requested\\.v1' : '')
	+ ')$';
const billingWriteResourcePattern = '^winwidget\\.(events|billing\\.(retry|dead-letter)'
	+ (crmContract === 'mvp-v1' ? '|billing\\.wincrm-provider\\.dead-letter' : '')
	+ ')$';

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
			{ exchange: 'winwidget.events', write: widgetsWriteTopicPattern, read: '^(identity\\.user\\.changed\\.v1|billing\\.subscription\\.changed\\.v1|lead\\.integration\\.(webhook|bitrix24|amo-crm)\\.v2)$' },
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
		configure: '^$', write: billingWriteResourcePattern, read: '^$',
		topics: [{ exchange: 'winwidget.events', write: billingWriteTopicPattern, read: '^$' }]
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
			{ exchange: 'winwidget.events', write: identityWriteTopicPattern, read: '^$' },
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
		configure: restoreQueuePattern,
		write: '^winwidget\\.retry$',
		read: restoreQueuePattern,
		topics: []
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
})().catch(error => {
	const locations = [
		...(error instanceof Error ? error.stack ?? '' : '').matchAll(
			/\[stdin\]:(\d+):(\d+)/g
		)
	];
	const location = locations[1]
		? `${locations[1][1]}:${locations[1][2]}`
		: locations[0]
			? `${locations[0][1]}:${locations[0][2]}`
			: 'unknown';
	const name =
		error instanceof Error && /^[A-Za-z0-9_-]+$/.test(error.name)
			? error.name
			: 'unknown';
	const rawCode = error && typeof error === 'object' ? error.code : undefined;
	const code =
		(typeof rawCode === 'string' || typeof rawCode === 'number') &&
		/^[A-Za-z0-9_-]+$/.test(String(rawCode))
			? String(rawCode)
			: 'unknown';
	const rawContext =
		error && typeof error === 'object' ? error.context : undefined;
	const context =
		typeof rawContext === 'string' &&
		/^[A-Z]+:\/api\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(rawContext)
			? rawContext
			: 'unknown';
	process.stderr.write(
		`RabbitMQ service identity or topology provisioning failed (${location}; ${name}; ${code}; ${context}).\n`
	);
	process.exit(1);
});
PROVISION_RABBITMQ

for migration_service in "${migration_services[@]}"; do
	compose_all run --rm --no-deps "$migration_service" >/dev/null 2>&1 ||
		die "Production migration failed: $migration_service"
done

verify_operations_service_identity() {
	compose_all run --rm --no-deps --interactive \
		--entrypoint node \
		operations-api - <<'VERIFY_OPERATIONS_SERVICE_IDENTITY' >/dev/null
const { PrismaClient } = require('@prisma/operations-client');

const databaseUrl = process.env.OPERATIONS_DATABASE_URL ?? '';
if (!databaseUrl) process.exit(1);
const client = new PrismaClient({
	datasources: { db: { url: databaseUrl } }
});

(async () => {
	const rows = await client.$queryRaw`
		SELECT
			id::text AS "id",
			service_name::text AS "serviceName",
			database_id::text AS "databaseId"
		FROM "operations"."service_identity"
		ORDER BY id
	`;
	if (
		rows.length !== 1 ||
		rows[0].id !== 'singleton' ||
		rows[0].serviceName !== 'operations-service' ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
			rows[0].databaseId
		)
	) throw new Error('invalid Operations service identity');
})()
	.catch(() => {
		process.stderr.write('Operations service identity verification failed.\n');
		process.exitCode = 1;
	})
	.finally(async () => {
		await client.$disconnect();
	});
VERIFY_OPERATIONS_SERVICE_IDENTITY
}

verify_operations_service_identity

verify_current_reporting_routing_projection() {
	local route_thread_id
	route_thread_id="$(
		compose_all run --rm --no-deps --interactive \
			--entrypoint node \
			operations-api - <<'VERIFY_CURRENT_OPERATIONS_ROUTING'
const { PrismaClient } = require('@prisma/operations-client');

const databaseUrl = process.env.OPERATIONS_DATABASE_URL ?? '';
const managementUrl = process.env.RABBITMQ_MANAGEMENT_URL ?? '';
const monitorUser = process.env.RABBITMQ_MONITOR_USER ?? '';
const monitorPassword = process.env.RABBITMQ_MONITOR_PASSWORD ?? '';
const vhost = process.env.RABBITMQ_VHOST ?? '';
if (!databaseUrl || !managementUrl || !monitorUser || !monitorPassword || vhost !== 'winwidget') {
	process.exit(1);
}
const client = new PrismaClient({
	datasources: { db: { url: databaseUrl } }
});

(async () => {
	const settings = await client.telegramBotSettings.findUnique({
		where: { id: 'singleton' },
		select: { operationalAlertsThreadId: true }
	});
	if (!settings) throw new Error('Operations Telegram settings are missing');

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
	if (!response.ok) throw new Error('Reporting settings binding is unavailable');
	const bindings = await response.json();
	if (!Array.isArray(bindings)) throw new Error('Reporting settings bindings are invalid');
	const current = bindings.filter(
		binding =>
			binding?.source === 'winwidget.events' &&
			binding?.destination === 'winwidget.reporting.settings' &&
			binding?.destination_type === 'queue' &&
			binding?.routing_key === 'operations.notification-routing.changed.v1'
	);
	if (bindings.length !== 1 || current.length !== 1) {
		throw new Error('Reporting settings binding differs from the current contract');
	}
	process.stdout.write(
		settings.operationalAlertsThreadId === null
			? 'null'
			: String(settings.operationalAlertsThreadId)
	);
})()
	.catch(() => {
		process.stderr.write('Current Operations routing verification failed.\n');
		process.exitCode = 1;
	})
	.finally(async () => {
		await client.$disconnect();
	});
VERIFY_CURRENT_OPERATIONS_ROUTING
	)" || die 'Current Operations routing verification failed.'
	[[ "$route_thread_id" == 'null' || "$route_thread_id" =~ ^[1-9][0-9]*$ ]] ||
		die 'Current Operations routing value is invalid.'

	compose_all run --rm --no-deps --interactive \
		--env "EXPECTED_OPERATIONAL_ALERTS_THREAD_ID=$route_thread_id" \
		--entrypoint node \
		reporting-service - <<'VERIFY_CURRENT_REPORTING_ROUTING' >/dev/null
const { PrismaClient } = require('@prisma/reporting-client');

const expectedRaw = process.env.EXPECTED_OPERATIONAL_ALERTS_THREAD_ID ?? '';
const databaseUrl = process.env.REPORTING_DATABASE_URL ?? '';
if (!(expectedRaw === 'null' || /^[1-9][0-9]*$/.test(expectedRaw)) || !databaseUrl) {
	process.exit(1);
}
const expected = expectedRaw === 'null' ? null : Number(expectedRaw);
if (expected !== null && !Number.isSafeInteger(expected)) process.exit(1);
const client = new PrismaClient({
	datasources: { db: { url: databaseUrl } }
});
const sleep = milliseconds =>
	new Promise(resolve => setTimeout(resolve, milliseconds));

(async () => {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		const settings = await client.reportingSettings.findUnique({
			where: { id: 'daily-summary' },
			select: { operationalAlertsThreadId: true }
		});
		if (settings?.operationalAlertsThreadId === expected) return;
		await sleep(2000);
	}
	throw new Error('Reporting routing projection did not converge');
})()
	.catch(() => {
		process.stderr.write('Current Reporting routing verification failed.\n');
		process.exitCode = 1;
	})
	.finally(async () => {
		await client.$disconnect();
	});
VERIFY_CURRENT_REPORTING_ROUTING
}

verify_steady_state_phase() {
	local phase="$1"
	local rabbitmq_container_id queue_name actual_rabbitmq_user_names
	local remaining_legacy_queues listener_inventory entry_path core_container_id
	local -a legacy_queue_names=()
	local -a legacy_rabbitmq_users=(
		winwidget-publisher
		winwidget-integration
		winwidget-maintenance
	)
	[[ "$phase" == 'pre_cleanup' || "$phase" == 'post_cleanup' ]] ||
		die 'Unknown steady-state verification phase.'

	# In both phases every project container must first pass exact Compose
	# identity/state validation and the running services must match the manifest.
	# Pre-cleanup may therefore contain only strictly validated stopped targets.
	verify_exact_project_container_inventory
	if [[ "$phase" == 'post_cleanup' ]]; then
		# Together with the exact running manifest this also proves that no retired
		# project service remains in either running or stopped state.
		verify_project_has_no_stopped_containers
	fi
	verify_operations_worker_runtime_identity
	verify_current_reporting_routing_projection
	rabbitmq_container_id="$(compose_all ps --status running -q rabbitmq 2>/dev/null)"
	[[ -n "$rabbitmq_container_id" && "$rabbitmq_container_id" != *$'\n'* ]] ||
		die 'Exactly one running RabbitMQ container is required for steady-state verification.'
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
	)" || die 'Cannot verify the steady-state RabbitMQ queue inventory.'
	for queue_name in "${legacy_queue_names[@]}"; do
		if awk -v queue="$queue_name" \
			'$1 == queue { found = 1 } END { exit(found ? 0 : 1) }' \
			<<<"$remaining_legacy_queues"; then
			die "Legacy RabbitMQ queue remains in steady state: $queue_name"
		fi
	done
	actual_rabbitmq_user_names="$(
		docker exec "$rabbitmq_container_id" rabbitmqctl --silent list_users |
			awk 'NF { print $1 }' | LC_ALL=C sort
	)" || die 'Cannot verify the steady-state RabbitMQ user inventory.'
	[[ "$actual_rabbitmq_user_names" == "$rabbitmq_expected_user_names" ]] ||
		die 'RabbitMQ user inventory differs from the exact apps-only contract.'
	for legacy_user in "${legacy_rabbitmq_users[@]}"; do
		if grep -Fqx -- "$legacy_user" <<<"$actual_rabbitmq_user_names"; then
			die "Legacy RabbitMQ user remains in steady state: $legacy_user"
		fi
	done
	core_container_id="$(
		find_exact_named_container winwidget-core-postgres-temporary
	)"
	[[ -z "$core_container_id" ]] ||
		die 'Temporary Core PostgreSQL container remains in steady state.'
	! docker_volume_exists winwidget-core-postgres-temporary-data ||
		die 'Temporary Core PostgreSQL volume remains in steady state.'
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
			die 'A protected legacy Core/restore artifact remains in steady state.'
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

compose_all up -d --no-build --force-recreate "${runtime_without_gateway[@]}"
wait_for_healthy_services "${runtime_without_gateway[@]}"
verify_database_restore_activation_is_idle
compose_all up -d --no-build --force-recreate operations-restore-worker
wait_for_healthy_services operations-restore-worker
verify_singleton_running_service operations-restore-worker
compose_all up -d --no-build --force-recreate api-gateway
wait_for_healthy_services "${runtime_services[@]}"
verify_operations_worker_runtime_identity

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
	compose_all run --rm --no-deps --interactive operations-worker node - \
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
	command -v systemctl >/dev/null 2>&1 ||
		die 'systemctl is required on the backend VPS.'
	systemctl is-active --quiet nginx ||
		die 'Backend Nginx systemd service is not active.'
	current_sha256="$(sha256sum "$nginx_target" | awk '{print $1}')"
	if [[ "$current_sha256" != "$backend_nginx_sha256" ]]; then
		nginx_candidate="$(mktemp "$nginx_available_dir/.api.winwidget.ru.candidate.XXXXXX")"
		nginx_backup="$(mktemp "$nginx_available_dir/.api.winwidget.ru.backup.XXXXXX")"
		if ! {
			printf '%s' "$backend_nginx_base64" |
				base64 --decode >"$nginx_candidate" &&
			[[ "$(sha256sum "$nginx_candidate" | awk '{print $1}')" == \
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
			if ! nginx -t >/dev/null 2>&1 || ! systemctl reload nginx; then
				die 'Backend Nginx reload rollback failed.'
			fi
			die 'Apps-only backend Nginx reload failed and was rolled back.'
		fi
		if [[ "$(sha256sum "$nginx_target" | awk '{print $1}')" != \
			"$backend_nginx_sha256" ||
			"$(stat -c '%u:%g:%a:%h' "$nginx_target")" != '0:0:644:1' ]] ||
			! nginx -t >/dev/null 2>&1; then
			mv -f -- "$nginx_backup" "$nginx_target"
			sync -f "$nginx_available_dir"
			if ! nginx -t >/dev/null 2>&1 || ! systemctl reload nginx; then
				die 'Backend Nginx post-reload rollback failed.'
			fi
			die 'Apps-only backend Nginx post-reload verification failed and was rolled back.'
		fi
		rm -f -- "$nginx_backup"
		sync -f "$nginx_available_dir"
	fi
	[[ "$(sha256sum "$nginx_target" | awk '{print $1}')" == \
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
	'http://127.0.0.1:5200/api/v1/health/deployment' "$services_revision" ||
	die 'Operations deployment revision check failed.'
wait_for_http_revision \
	'https://api.winwidget.ru/api/v1/health/deployment' "$services_revision" ||
	die 'Public Gateway deployment revision check failed.'
verify_retired_core_public_routes_absent ||
	die 'A retired Core public route remains reachable through backend Nginx.'
verify_telegram_proxy_health ||
	die 'Pinned Telegram proxy health check failed.'

env_sha256_after="$(sha256sum "$env_file" | awk '{print $1}')"
[[ "$env_sha256_after" == "$env_sha256_before" &&
	"$env_sha256_after" == "$expected_env_sha256" ]] ||
	die 'Canonical production env changed during deployment.'
[[ "$(stat -c '%u:%g:%a:%h' "$env_file")" == '0:0:600:1' ]] ||
	die 'Canonical production env permissions changed during deployment.'
assert_backup_provenance_private_key
[[ "$(stat -c '%d:%i:%s' "$backup_provenance_private_key_file")" == "$backup_provenance_private_key_identity_before" &&
	"$(sha256sum "$backup_provenance_private_key_file" | awk '{print $1}')" == "$backup_provenance_private_key_sha256_before" ]] ||
	die 'Backup provenance private key changed during deployment.'
for service_env_file in "${service_env_files[@]}"; do
	[[ -f "$service_env_file" && ! -L "$service_env_file" &&
		"$(stat -c '%u:%g:%a:%h' "$service_env_file")" == '0:0:600:1' ]] ||
		die 'A service-owned production env changed type or permissions during deployment.'
done
[[ "$(service_env_manifest_sha256)" == "$service_env_manifest_sha256_before" ]] ||
	die 'A service-owned production env changed during deployment.'

verify_steady_state_phase pre_cleanup
cleanup_obsolete_winwidget_docker_resources
verify_steady_state_phase post_cleanup
wait_for_healthy_services "${runtime_services[@]}"
verify_operations_worker_runtime_identity
verify_telegram_proxy_health ||
	die 'Pinned Telegram proxy health check failed after steady-state verification.'
wait_for_http_revision \
	'https://api.winwidget.ru/api/v1/health/deployment' "$services_revision" ||
	die 'Public Gateway revision check failed after steady-state verification.'
verify_retired_core_public_routes_absent ||
	die 'A retired Core public route reappeared after steady-state verification.'

printf 'Backend services deployment completed: infra=%s services=%s\n' \
	"$infra_revision" "$services_revision"
REMOTE_CONTROLLER

if [[ "$deploy_frontend_nginx" == 'true' ]]; then
frontend_ssh_options=(
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
	-o "UserKnownHostsFile=$frontend_known_hosts_file"
	-i "$frontend_identity_file"
	-p "$FRONTEND_PRODUCTION_SSH_PORT"
)

printf -v frontend_controller_arguments ' %q' \
	"$frontend_nginx_sha256" \
	"$frontend_nginx_base64"
# shellcheck disable=SC2016
frontend_controller_command='set -euo pipefail
[[ "$(id -u)" == "0" ]]
controller_file="$(mktemp /etc/nginx/.winwidget-frontend-controller.XXXXXX)"
trap '\''rm -f -- "$controller_file"'\'' EXIT
cat >"$controller_file"
chown 0:0 "$controller_file"
chmod 600 "$controller_file"
bash "$controller_file"'"$frontend_controller_arguments"' </dev/null'

# shellcheck disable=SC2029
ssh "${frontend_ssh_options[@]}" \
	"$FRONTEND_PRODUCTION_SSH_USER@$FRONTEND_PRODUCTION_SSH_HOST" \
	"$frontend_controller_command" <<'FRONTEND_CONTROLLER'
set -euo pipefail
umask 077

die() {
	printf '%s\n' "$1" >&2
	exit 1
}

frontend_nginx_sha256="$1"
frontend_nginx_base64="$2"
[[ "$frontend_nginx_sha256" =~ ^[0-9a-f]{64}$ &&
	"$frontend_nginx_base64" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] ||
	die 'Remote frontend Nginx artifact is invalid.'
[[ "$(id -u)" == '0' ]] ||
	die 'Frontend Nginx controller must run as root.'

assert_root_owned_directory() {
	local path="$1" mode
	[[ -d "$path" && ! -L "$path" && "$(realpath -e "$path")" == "$path" &&
		"$(stat -c '%u:%g' "$path")" == '0:0' ]] ||
		die "Root-owned frontend Nginx directory is unsafe: $path"
	mode="$(stat -c '%a' "$path")"
	[[ "$mode" =~ ^[0-7]{3,4}$ ]] ||
		die "Frontend Nginx directory mode is invalid: $path"
	(( (8#$mode & 8#022) == 0 )) ||
		die "Frontend Nginx directory is group/world writable: $path"
}

readonly nginx_available_dir='/etc/nginx/sites-available'
readonly nginx_enabled_dir='/etc/nginx/sites-enabled'
readonly nginx_target='/etc/nginx/sites-available/winwidget.ru'
readonly nginx_link='/etc/nginx/sites-enabled/winwidget.ru'
readonly nginx_lock='/run/lock/winwidget-frontend-nginx.lock'
assert_root_owned_directory /etc/nginx
assert_root_owned_directory "$nginx_available_dir"
assert_root_owned_directory "$nginx_enabled_dir"
[[ -f "$nginx_target" && ! -L "$nginx_target" &&
	"$(realpath -e "$nginx_target")" == "$nginx_target" &&
	"$(stat -c '%u:%g:%a:%h' "$nginx_target")" == '0:0:644:1' ]] ||
	die 'Live frontend Nginx config metadata is unsafe.'
[[ -L "$nginx_link" && "$(readlink "$nginx_link")" == "$nginx_target" ]] ||
	die 'Live frontend Nginx enabled symlink is not the exact reviewed target.'
command -v nginx >/dev/null 2>&1 ||
	die 'Nginx is required on the frontend VPS.'
command -v systemctl >/dev/null 2>&1 ||
	die 'systemctl is required on the frontend VPS.'
systemctl is-active --quiet nginx ||
	die 'Frontend Nginx systemd service is not active.'
command -v flock >/dev/null 2>&1 ||
	die 'flock is required on the frontend VPS.'
[[ ! -L "$nginx_lock" && (! -e "$nginx_lock" || -f "$nginx_lock") ]] ||
	die 'Frontend Nginx lock path is unsafe.'
exec {nginx_lock_fd}>"$nginx_lock"
chown 0:0 "$nginx_lock"
chmod 600 "$nginx_lock"
[[ "$(stat -c '%u:%g:%a:%h' "$nginx_lock")" == '0:0:600:1' ]] ||
	die 'Frontend Nginx lock identity is unsafe.'
flock -n "$nginx_lock_fd" ||
	die 'Another frontend Nginx deployment holds the lock.'

current_sha256="$(sha256sum "$nginx_target" | awk '{print $1}')"
if [[ "$current_sha256" != "$frontend_nginx_sha256" ]]; then
	nginx_candidate="$(mktemp "$nginx_available_dir/.winwidget.ru.candidate.XXXXXX")"
	nginx_backup="$(mktemp "$nginx_available_dir/.winwidget.ru.backup.XXXXXX")"
	if ! {
		printf '%s' "$frontend_nginx_base64" |
			base64 --decode >"$nginx_candidate" &&
			[[ "$(sha256sum "$nginx_candidate" | awk '{print $1}')" == \
				"$frontend_nginx_sha256" ]] &&
			chown 0:0 "$nginx_candidate" &&
			chmod 644 "$nginx_candidate" &&
			cp --reflink=auto --preserve=all -- "$nginx_target" "$nginx_backup" &&
			[[ "$(stat -c '%u:%g:%a:%h' "$nginx_backup")" == '0:0:644:1' ]] &&
			sync -f "$nginx_candidate" &&
			sync -f "$nginx_backup"
	}; then
		rm -f -- "$nginx_candidate" "$nginx_backup"
		die 'Cannot stage the frontend Nginx config safely.'
	fi
	if ! mv -f -- "$nginx_candidate" "$nginx_target" ||
		! sync -f "$nginx_available_dir"; then
		rm -f -- "$nginx_candidate" ||
			die 'Failed frontend Nginx candidate could not be removed.'
		if ! {
			mv -f -- "$nginx_backup" "$nginx_target" &&
				sync -f "$nginx_available_dir" &&
				nginx -t >/dev/null 2>&1
		}; then
			die 'Frontend Nginx install rollback failed.'
		fi
		die 'Cannot install the frontend Nginx config safely.'
	fi
	if ! nginx -t >/dev/null 2>&1; then
		mv -f -- "$nginx_backup" "$nginx_target"
		sync -f "$nginx_available_dir"
		nginx -t >/dev/null 2>&1 ||
			die 'Frontend Nginx validation rollback failed.'
		die 'Frontend Nginx config failed validation and was rolled back.'
	fi
	if ! systemctl reload nginx; then
		mv -f -- "$nginx_backup" "$nginx_target"
		sync -f "$nginx_available_dir"
		if ! nginx -t >/dev/null 2>&1 || ! systemctl reload nginx; then
			die 'Frontend Nginx reload rollback failed.'
		fi
		die 'Frontend Nginx reload failed and was rolled back.'
	fi
	if [[ "$(sha256sum "$nginx_target" | awk '{print $1}')" != \
		"$frontend_nginx_sha256" ||
		"$(stat -c '%u:%g:%a:%h' "$nginx_target")" != '0:0:644:1' ]] ||
		! nginx -t >/dev/null 2>&1; then
		mv -f -- "$nginx_backup" "$nginx_target"
		sync -f "$nginx_available_dir"
		if ! nginx -t >/dev/null 2>&1 || ! systemctl reload nginx; then
			die 'Frontend Nginx post-reload rollback failed.'
		fi
		die 'Frontend Nginx post-reload verification failed and was rolled back.'
	fi
	rm -f -- "$nginx_backup"
	sync -f "$nginx_available_dir"
fi

[[ "$(sha256sum "$nginx_target" | awk '{print $1}')" == \
	"$frontend_nginx_sha256" &&
	"$(stat -c '%u:%g:%a:%h' "$nginx_target")" == '0:0:644:1' ]] ||
	die 'Live frontend Nginx config does not match the tracked artifact.'
nginx -t >/dev/null 2>&1 ||
	die 'Live frontend Nginx config validation failed.'
curl --fail --silent --max-time 15 https://winwidget.ru/ >/dev/null 2>&1 ||
	die 'Public frontend health check failed after Nginx verification.'
FRONTEND_CONTROLLER
fi

printf 'Production steady-state deployment completed: infra=%s services=%s frontend_nginx=%s\n' \
	"$infra_revision" "$services_revision" "$deploy_frontend_nginx"
