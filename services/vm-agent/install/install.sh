#!/bin/sh
# Fail-closed manual installer for the AWP VM agent source preview.
# Package and one-line installation stay disabled until a signed tag exists.

set -eu

PROG="awp-vm-agent"
SVC_USER="awp-vm-agent"
SVC_GROUP="awp-vm-agent"
PREFIX="/usr/local/bin"
CONF_DIR="/etc/${PROG}"
DATA_DIR="/var/lib/${PROG}"
LOG_DIR="/var/log/${PROG}"
BIN_PATH="${PREFIX}/${PROG}"
SYSTEMD_TARGET="/etc/systemd/system/${PROG}.service"
INIT_TARGET="/etc/init.d/${PROG}"
MARKER="${CONF_DIR}/.awp-install-owner-v1"
LOCK_DIR="/run/lock"
LOCK_FILE="${LOCK_DIR}/${PROG}-install.lock"

RELEASE_BASE="${AWP_RELEASE_BASE_URL:-}"
VERSION="${AWP_AGENT_VERSION:-}"
BINARY_URL="${AWP_AGENT_BINARY_URL:-}"
SIGNATURE_URL="${AWP_AGENT_SIGNATURE_URL:-}"
BINARY_SHA256="${AWP_AGENT_BINARY_SHA256:-}"
PUBKEY_FILE="${AWP_AGENT_PUBKEY_FILE:-}"
API_KEY_FILE="${AWP_AGENT_API_KEY_FILE:-}"
SERVER_URL="${AWP_AGENT_SERVER_URL:-}"
AGENT_NAME="${AWP_AGENT_NAME:-$(hostname 2>/dev/null || printf 'awp-vm-agent')}"
ARCH=""
DRY_RUN=0
START_SERVICE=0
REPLACE_CONFIG=0
FORCE_UNKNOWN=0
UNINSTALL=0
TEST_MODE="${AWP_INSTALL_TEST_MODE:-0}"
TEST_ROOT="${AWP_INSTALL_TEST_ROOT:-}"
TEST_INIT="${AWP_INSTALL_TEST_INIT:-}"
TEST_INSTALL_ID="${AWP_INSTALL_TEST_INSTALL_ID:-}"
MUTATION_LOG="${AWP_INSTALL_MUTATION_LOG:-}"
TEST_META=""

die() { printf 'install.sh: error: %s\n' "$*" >&2; exit 1; }
deny() { printf 'install.sh: unsupported or unsafe: %s\n' "$*" >&2; exit 77; }
log() { printf 'install.sh: %s\n' "$*"; }
warn() { printf 'install.sh: warning: %s\n' "$*" >&2; }

usage() {
    cat <<'EOF'
Usage: install.sh [options]
  --release-base HTTPS_URL  explicit immutable release base
  --version VERSION         explicit release version (required with --release-base)
  --binary-url HTTPS_URL    explicit binary URL (alternative to base + version)
  --signature-url HTTPS_URL detached signature URL (default: BINARY_URL.asc)
  --binary-sha256 HEX       required expected binary SHA-256
  --pubkey FILE             required trusted release public-key file
  --api-key-file FILE       required local file containing only the agent API key
  --server-url WS_URL       required compatible VM-agent WebSocket endpoint
  --agent-name NAME         default: local hostname
  --arch amd64|arm64        default: auto-detect
  --replace-config          required for a marker-authorized reinstall
  --start                   explicitly enable and start after installation
  --dry-run                 verify inputs and artifact without host mutation
  --uninstall               delegate to the marker-validating uninstaller
  --force-distro-unknown    permit an unrecognised Linux distribution
  -h, --help                show this help

The manual installer is the only installation path in this source preview.
It never adopts an existing account or directory without its closed-schema,
root-owned identity marker. Package and one-line installation remain disabled.
EOF
}

need_arg() {
    [ "$#" -ge 2 ] || die "$1 requires a value"
    [ -n "$2" ] || die "$1 requires a non-empty value"
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --release-base) need_arg "$@"; RELEASE_BASE="$2"; shift 2 ;;
        --version) need_arg "$@"; VERSION="$2"; shift 2 ;;
        --binary-url) need_arg "$@"; BINARY_URL="$2"; shift 2 ;;
        --signature-url) need_arg "$@"; SIGNATURE_URL="$2"; shift 2 ;;
        --binary-sha256) need_arg "$@"; BINARY_SHA256="$2"; shift 2 ;;
        --pubkey) need_arg "$@"; PUBKEY_FILE="$2"; shift 2 ;;
        --api-key-file) need_arg "$@"; API_KEY_FILE="$2"; shift 2 ;;
        --server-url) need_arg "$@"; SERVER_URL="$2"; shift 2 ;;
        --agent-name) need_arg "$@"; AGENT_NAME="$2"; shift 2 ;;
        --arch) need_arg "$@"; ARCH="$2"; shift 2 ;;
        --replace-config) REPLACE_CONFIG=1; shift ;;
        --start) START_SERVICE=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        --force-distro-unknown) FORCE_UNKNOWN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown argument: $1 (see --help)" ;;
    esac
done

HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ "$UNINSTALL" -eq 1 ]; then
    [ -x "${HERE}/uninstall.sh" ] || die "uninstall.sh not found next to install.sh"
    exec "${HERE}/uninstall.sh"
fi

if [ "$TEST_MODE" = "1" ]; then
    if [ -n "$TEST_ROOT" ]; then
        case "$TEST_ROOT" in /*/awp-install-test.*|?:/*/awp-install-test.*) ;; *) deny "test root must be an absolute awp-install-test.* path" ;; esac
        case "$TEST_ROOT" in *[[:space:]]*|*'\'*) deny "invalid test root" ;; esac
        TEST_ROOT="${TEST_ROOT%/}"
        PREFIX="${TEST_ROOT}/usr/local/bin"
        CONF_DIR="${TEST_ROOT}/etc/${PROG}"
        DATA_DIR="${TEST_ROOT}/var/lib/${PROG}"
        LOG_DIR="${TEST_ROOT}/var/log/${PROG}"
        BIN_PATH="${PREFIX}/${PROG}"
        SYSTEMD_TARGET="${TEST_ROOT}/etc/systemd/system/${PROG}.service"
        INIT_TARGET="${TEST_ROOT}/etc/init.d/${PROG}"
        MARKER="${CONF_DIR}/.awp-install-owner-v1"
        LOCK_DIR="${TEST_ROOT}/run/lock"
        LOCK_FILE="${LOCK_DIR}/${PROG}-install.lock"
        TEST_META="${TEST_ROOT}/.awp-install-test-meta"
    fi
else
    [ -z "$TEST_ROOT$TEST_INIT$TEST_INSTALL_ID$MUTATION_LOG" ] || deny "test-only environment requires AWP_INSTALL_TEST_MODE=1"
fi

record_mutation() {
    if [ "$TEST_MODE" = "1" ] && [ -n "$MUTATION_LOG" ]; then printf '%s\n' "$1" >>"$MUTATION_LOG"; fi
}

validate_download_url() {
    _url="$1"; _label="$2"
    case "$_url" in https://*) ;; file://*) [ "$TEST_MODE" = 1 ] || die "${_label} file URL is test-only" ;; *) die "${_label} must use HTTPS" ;; esac
    case "$_url" in *'?'*|*'#'*|*'@'*|*'\'*|*[[:space:]]*) die "${_label} contains a forbidden URL component" ;; esac
}

validate_server_url() {
    _url="$1"
    case "$_url" in *'?'*|*'#'*|*'@'*|*'\'*|*'"'*|*[[:space:]]*) die "--server-url contains a forbidden component" ;; esac
    case "$_url" in
        wss://?*) return 0 ;;
        ws://?*)
            _authority="${_url#ws://}"; _authority="${_authority%%/*}"
            case "$_authority" in localhost|localhost:*|127.0.0.1|127.0.0.1:*|'[::1]'|'[::1]':*) return 0 ;; esac
            die "plain ws:// is limited to semantic loopback"
            ;;
        *) die "--server-url must use wss:// or loopback ws://" ;;
    esac
}

[ -n "$SERVER_URL" ] || die "--server-url is required"
validate_server_url "$SERVER_URL"
case "$AGENT_NAME" in *[!A-Za-z0-9._-]*|'') die "invalid --agent-name" ;; esac

if [ -z "$ARCH" ]; then
    case "$(uname -m 2>/dev/null || printf unknown)" in x86_64|amd64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) die "unsupported architecture" ;; esac
fi
case "$ARCH" in amd64|arm64) ;; *) die "--arch must be amd64 or arm64" ;; esac
case "$VERSION" in *[!A-Za-z0-9._+-]*) die "invalid --version" ;; esac

if [ -n "$BINARY_URL" ] && [ -n "$RELEASE_BASE" ]; then die "choose --binary-url or --release-base plus --version"; fi
if [ -z "$BINARY_URL" ]; then
    [ -n "$RELEASE_BASE" ] || die "--release-base or --binary-url is required"
    [ -n "$VERSION" ] || die "--version is required with --release-base"
    RELEASE_BASE="${RELEASE_BASE%/}"; validate_download_url "$RELEASE_BASE" "release base"
    BINARY_URL="${RELEASE_BASE}/${VERSION}/${PROG}-linux-${ARCH}"
else
    validate_download_url "$BINARY_URL" "binary URL"
fi
[ -n "$SIGNATURE_URL" ] || SIGNATURE_URL="${BINARY_URL}.asc"
validate_download_url "$SIGNATURE_URL" "signature URL"

case "$BINARY_SHA256" in *[!0-9A-Fa-f]*|'') die "--binary-sha256 must be hexadecimal" ;; esac
[ "${#BINARY_SHA256}" -eq 64 ] || die "--binary-sha256 must contain 64 characters"
BINARY_SHA256="$(printf '%s' "$BINARY_SHA256" | tr 'A-F' 'a-f')"

[ -n "$PUBKEY_FILE" ] || die "--pubkey is required"
[ -f "$PUBKEY_FILE" ] && [ -r "$PUBKEY_FILE" ] && [ ! -L "$PUBKEY_FILE" ] || die "--pubkey must be a readable non-symlink file"
[ "$(id -u)" -eq 0 ] || { [ "$TEST_MODE" = 1 ] && { [ "$DRY_RUN" -eq 1 ] || [ -n "$TEST_ROOT" ]; }; } || die "must run as root"
[ -n "$API_KEY_FILE" ] || die "--api-key-file is required"
[ -f "$API_KEY_FILE" ] && [ -r "$API_KEY_FILE" ] && [ ! -L "$API_KEY_FILE" ] || die "--api-key-file must be a readable non-symlink file"
API_KEY="$(cat "$API_KEY_FILE")"
[ -n "$API_KEY" ] && [ "${#API_KEY}" -le 4096 ] || die "invalid API-key file"
case "$API_KEY" in *[!A-Za-z0-9._~+/=-]*) die "API-key file must contain one token" ;; esac

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v flock >/dev/null 2>&1 || deny "flock is required"
command -v getent >/dev/null 2>&1 || deny "getent is required"
if command -v sha256sum >/dev/null 2>&1; then sha256_file() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }
else die "sha256sum or shasum is required"; fi
if command -v gpg >/dev/null 2>&1; then GPG="$(command -v gpg)"
elif command -v gpg2 >/dev/null 2>&1; then GPG="$(command -v gpg2)"
else die "gpg is required"; fi

TMP_ROOT="${TMPDIR:-/tmp}"
STAGE="$(mktemp -d "${TMP_ROOT%/}/awp-vm-agent.XXXXXX" 2>/dev/null || mktemp -d -t awp-vm-agent.XXXXXX)" || die "could not create staging directory"
case "$STAGE" in *awp-vm-agent.*) ;; *) die "unexpected staging directory" ;; esac
trap 'rm -rf "$STAGE"' EXIT HUP INT TERM

download() {
    case "$1" in file://*) curl --fail --show-error --silent --proto '=file' --max-redirs 0 --output "$2" "$1" || die "download failed" ;;
    *) curl --fail --show-error --silent --proto '=https' --tlsv1.2 --max-redirs 0 --output "$2" "$1" || die "download failed" ;; esac
}

BIN_TMP="${STAGE}/${PROG}.new"; SIG_TMP="${STAGE}/${PROG}.new.asc"
download "$BINARY_URL" "$BIN_TMP"; download "$SIGNATURE_URL" "$SIG_TMP"
ACTUAL_SHA256="$(sha256_file "$BIN_TMP" | tr 'A-F' 'a-f')"
[ "$ACTUAL_SHA256" = "$BINARY_SHA256" ] || die "binary SHA-256 mismatch"
GNUPGHOME_STAGE="${STAGE}/gnupg"; if [ "$TEST_MODE" = 1 ]; then mkdir "$GNUPGHOME_STAGE"; chmod 0700 "$GNUPGHOME_STAGE" 2>/dev/null || :; else mkdir -m 0700 "$GNUPGHOME_STAGE"; fi
GNUPGHOME="$GNUPGHOME_STAGE" "$GPG" --batch --quiet --no-auto-key-retrieve --import "$PUBKEY_FILE" >/dev/null 2>&1 || die "could not import trusted public key"
GNUPGHOME="$GNUPGHOME_STAGE" "$GPG" --batch --quiet --no-auto-key-retrieve --verify "$SIG_TMP" "$BIN_TMP" >/dev/null 2>&1 || die "signature verification failed"
chmod 0755 "$BIN_TMP"; "$BIN_TMP" --version >/dev/null 2>&1 || die "verified artifact lacks --version"

DISTRO_ID=unknown; DISTRO_LIKE=""; DISTRO_VERSION=""
if [ -r /etc/os-release ]; then . /etc/os-release; DISTRO_ID="${ID:-unknown}"; DISTRO_LIKE="${ID_LIKE:-}"; DISTRO_VERSION="${VERSION_ID:-}"; fi
DISTRO_FAMILY=unknown
case "$DISTRO_ID" in
 centos|rhel|rocky|almalinux|ol|amzn|fedora) DISTRO_FAMILY=rhel ;;
 ubuntu|debian|linuxmint|pop) DISTRO_FAMILY=debian ;;
 opensuse-leap|opensuse-tumbleweed|sles|sled) DISTRO_FAMILY=suse ;;
 alpine) DISTRO_FAMILY=alpine ;;
 arch|manjaro|endeavouros) DISTRO_FAMILY=arch ;;
 *) case " $DISTRO_LIKE " in *' rhel '*|*' fedora '*|*' centos '*) DISTRO_FAMILY=rhel ;; *' debian '*|*' ubuntu '*) DISTRO_FAMILY=debian ;; *' suse '*|*' opensuse '*) DISTRO_FAMILY=suse ;; esac ;;
esac
[ "$DISTRO_FAMILY" != unknown ] || [ "$FORCE_UNKNOWN" -eq 1 ] || die "unsupported distribution"

if [ -n "$TEST_INIT" ]; then [ "$TEST_MODE" = 1 ] || deny "test init override is test-only"; INIT_SYS="$TEST_INIT"
elif [ -d /run/systemd/system ] || { command -v systemctl >/dev/null 2>&1 && [ -r /proc/1/comm ] && grep -q systemd /proc/1/comm; }; then INIT_SYS=systemd
elif [ -d /run/openrc ] || command -v rc-status >/dev/null 2>&1; then INIT_SYS=openrc
else INIT_SYS=sysv; fi
case "$INIT_SYS" in systemd|openrc|sysv) ;; *) deny "invalid init system" ;; esac
case "$INIT_SYS" in systemd) SERVICE_SOURCE="${HERE}/${PROG}.service" ;; openrc) SERVICE_SOURCE="${HERE}/openrc/${PROG}" ;; sysv) SERVICE_SOURCE="${HERE}/${PROG}.init.d" ;; esac
[ -f "$SERVICE_SOURCE" ] && [ ! -L "$SERVICE_SOURCE" ] || deny "required service asset is missing or unsafe"

if [ "$DRY_RUN" -eq 1 ]; then log "dry-run verified explicit inputs and signed artifact; no host mutation occurred"; exit 0; fi

test_meta_set() {
    _path="$1"; _uid="$2"; _gid="$3"; _mode="$4"; _meta_tmp="${TEST_META}.new.$$"
    if [ -f "$TEST_META" ]; then awk -F '\t' -v p="$_path" '$1 != p' "$TEST_META" >"$_meta_tmp"; else : >"$_meta_tmp"; fi
    printf '%s\t%s\t%s\t%s\n' "$_path" "$_uid" "$_gid" "$_mode" >>"$_meta_tmp"; mv -f "$_meta_tmp" "$TEST_META"
}
path_identity() {
    if [ -n "$TEST_META" ]; then awk -F '\t' -v p="$1" '$1 == p {print $2 ":" $3 ":" $4; found=1} END {if (!found) exit 1}' "$TEST_META"
    else stat -c '%u:%g:%a' "$1"; fi
}
path_nlink() { if [ -n "$TEST_META" ]; then printf '1\n'; else stat -c '%h' "$1"; fi; }
set_identity() {
    _path="$1"; _uid="$2"; _gid="$3"; _mode="$4"
    if [ -n "$TEST_META" ]; then chmod "$_mode" "$_path" 2>/dev/null || :; test_meta_set "$_path" "$_uid" "$_gid" "$_mode"
    else chown "${_uid}:${_gid}" "$_path"; chmod "$_mode" "$_path"; fi
}
prepare_identity() {
    if [ -n "$TEST_META" ]; then chmod "$4" "$1" 2>/dev/null || :; else chown "$2:$3" "$1"; chmod "$4" "$1"; fi
}
exists_any() { [ -e "$1" ] || [ -L "$1" ]; }
require_absent() { exists_any "$1" && deny "managed target exists without accepted contract: $1"; return 0; }
require_dir() {
    [ ! -L "$1" ] && [ -d "$1" ] || deny "managed directory type mismatch: $1"
    [ "$(path_identity "$1" 2>/dev/null || true)" = "$2:$3:$4" ] || deny "managed directory identity mismatch: $1"
}
require_file() {
    [ ! -L "$1" ] && [ -f "$1" ] || deny "managed file type mismatch: $1"
    [ "$(path_identity "$1" 2>/dev/null || true)" = "$2:$3:$4" ] || deny "managed file identity mismatch: $1"
}
require_marker_file() {
    require_file "$MARKER" 0 0 400
    [ "$(path_nlink "$MARKER" 2>/dev/null || true)" = 1 ] || deny "marker must have one link"
}

load_account() {
    _pw="$(getent passwd "$SVC_USER" 2>/dev/null)" || return 1
    _gr="$(getent group "$SVC_GROUP" 2>/dev/null)" || return 1
    [ "$(printf '%s\n' "$_pw" | awk 'END {print NR}')" -eq 1 ] || return 1
    [ "$(printf '%s\n' "$_gr" | awk 'END {print NR}')" -eq 1 ] || return 1
    ACC_NAME="$(printf '%s\n' "$_pw" | awk -F: 'NF==7 {print $1}')"
    ACC_UID="$(printf '%s\n' "$_pw" | awk -F: 'NF==7 {print $3}')"
    ACC_GID="$(printf '%s\n' "$_pw" | awk -F: 'NF==7 {print $4}')"
    ACC_HOME="$(printf '%s\n' "$_pw" | awk -F: 'NF==7 {print $6}')"
    ACC_SHELL="$(printf '%s\n' "$_pw" | awk -F: 'NF==7 {print $7}')"
    GR_NAME="$(printf '%s\n' "$_gr" | awk -F: 'NF>=3 {print $1}')"
    GR_GID="$(printf '%s\n' "$_gr" | awk -F: 'NF>=3 {print $3}')"
    [ "$ACC_NAME" = "$SVC_USER" ] && [ "$GR_NAME" = "$SVC_GROUP" ] || return 1
    case "$ACC_UID:$ACC_GID:$GR_GID" in *[!0-9:]*|*::*|'') return 1 ;; esac
    [ "$ACC_GID" = "$GR_GID" ] || return 1
}
shell_allowed() {
    if [ -n "$TEST_ROOT" ]; then [ "$1" = "${TEST_ROOT}/usr/sbin/nologin" ] || [ "$1" = "${TEST_ROOT}/sbin/nologin" ]
    else [ "$1" = /usr/sbin/nologin ] || [ "$1" = /sbin/nologin ]; fi
}
select_fresh_shell() {
    if [ -n "$TEST_ROOT" ]; then _shell_a="${TEST_ROOT}/usr/sbin/nologin"; _shell_b="${TEST_ROOT}/sbin/nologin"
    else _shell_a=/usr/sbin/nologin; _shell_b=/sbin/nologin; fi
    for _shell in "$_shell_a" "$_shell_b"; do [ -x "$_shell" ] && { printf '%s\n' "$_shell"; return 0; }; done
    return 1
}

load_marker() {
    require_marker_file
    [ "$(awk 'END {print NR}' "$MARKER")" -eq 17 ] || deny "marker line count mismatch"
    [ "$(sed -n '1p' "$MARKER")" = schema=awp-vm-agent-owner-v1 ] || deny "marker schema mismatch"
    M_STATE="$(sed -n '2s/^state=//p' "$MARKER")"; M_ID="$(sed -n '3s/^install-id=//p' "$MARKER")"; M_REGISTERED="$(sed -n '4s/^registered=//p' "$MARKER")"
    M_UID="$(sed -n '6s/^uid=//p' "$MARKER")"; M_GID="$(sed -n '8s/^gid=//p' "$MARKER")"; M_SHELL="$(sed -n '10s/^shell=//p' "$MARKER")"
    [ "$(sed -n '5p' "$MARKER")" = "user=$SVC_USER" ] || deny "marker user mismatch"
    [ "$(sed -n '7p' "$MARKER")" = "group=$SVC_GROUP" ] || deny "marker group mismatch"
    [ "$(sed -n '9p' "$MARKER")" = "home=$DATA_DIR" ] || deny "marker home mismatch"
    [ "$(sed -n '11p' "$MARKER")" = "conf=$CONF_DIR" ] || deny "marker conf mismatch"
    [ "$(sed -n '12p' "$MARKER")" = "data=$DATA_DIR" ] || deny "marker data mismatch"
    [ "$(sed -n '13p' "$MARKER")" = "log=$LOG_DIR" ] || deny "marker log mismatch"
    [ "$(sed -n '14p' "$MARKER")" = "binary=$BIN_PATH" ] || deny "marker binary mismatch"
    [ "$(sed -n '15p' "$MARKER")" = "systemd=$SYSTEMD_TARGET" ] || deny "marker systemd mismatch"
    [ "$(sed -n '16p' "$MARKER")" = "init=$INIT_TARGET" ] || deny "marker init mismatch"
    [ "$(sed -n '17p' "$MARKER")" = "init-system=$INIT_SYS" ] || deny "marker init system mismatch"
    case "$M_STATE" in installed|retained) ;; *) deny "marker state mismatch" ;; esac
    case "$M_REGISTERED" in 0|1) ;; *) deny "marker registered mismatch" ;; esac
    case "$M_ID" in *[!0-9a-f]*|'') deny "marker install-id mismatch" ;; esac
    [ "${#M_ID}" -eq 64 ] || deny "marker install-id length mismatch"
    case "$M_UID:$M_GID" in *[!0-9:]*|*::*|'') deny "marker numeric identity mismatch" ;; esac
    shell_allowed "$M_SHELL" && [ -x "$M_SHELL" ] || deny "marker shell mismatch"
    [ "$(sed -n '2p' "$MARKER")" = "state=$M_STATE" ] && [ "$(sed -n '3p' "$MARKER")" = "install-id=$M_ID" ] && [ "$(sed -n '4p' "$MARKER")" = "registered=$M_REGISTERED" ] || deny "marker key mismatch"
    [ "$(sed -n '6p' "$MARKER")" = "uid=$M_UID" ] && [ "$(sed -n '8p' "$MARKER")" = "gid=$M_GID" ] && [ "$(sed -n '10p' "$MARKER")" = "shell=$M_SHELL" ] || deny "marker identity key mismatch"
    load_account || deny "service account or group is missing"
    [ "$ACC_UID" = "$M_UID" ] && [ "$ACC_GID" = "$M_GID" ] && [ "$ACC_HOME" = "$DATA_DIR" ] && [ "$ACC_SHELL" = "$M_SHELL" ] || deny "service account differs from marker"
}

validate_persistent() {
    require_dir "$CONF_DIR" 0 "$M_GID" 750
    require_dir "$DATA_DIR" "$M_UID" "$M_GID" 750
    require_dir "$LOG_DIR" "$M_UID" "$M_GID" 750
    require_file "${CONF_DIR}/config.yaml" 0 "$M_GID" 640
    require_file "${CONF_DIR}/agent.env" 0 "$M_GID" 640
    require_file "${CONF_DIR}/awp-vm-agent-release-key.asc" 0 0 644
    if exists_any "${CONF_DIR}/config.yaml.previous"; then require_file "${CONF_DIR}/config.yaml.previous" 0 "$M_GID" 640; fi
}
validate_installed_targets() {
    require_file "$BIN_PATH" 0 0 755
    case "$INIT_SYS" in systemd) require_file "$SYSTEMD_TARGET" 0 0 644; require_absent "$INIT_TARGET" ;; openrc|sysv) require_file "$INIT_TARGET" 0 0 755; require_absent "$SYSTEMD_TARGET" ;; esac
}
validate_retained_targets() {
    [ "$M_REGISTERED" = 0 ] || deny "retained marker cannot be registered"
    require_absent "$BIN_PATH"; require_absent "$SYSTEMD_TARGET"; require_absent "$INIT_TARGET"
}

acquire_lock() {
    [ ! -L "$LOCK_DIR" ] && [ -d "$LOCK_DIR" ] || deny "lock directory is unsafe"
    if [ -z "$TEST_ROOT" ]; then case "$(stat -c '%u:%g:%a' "$LOCK_DIR" 2>/dev/null || true)" in 0:0:*) ;; *) deny "lock directory must be root-owned" ;; esac; fi
    if exists_any "$LOCK_FILE"; then
        [ ! -L "$LOCK_FILE" ] && [ -f "$LOCK_FILE" ] || deny "lock file is unsafe"
        if [ -z "$TEST_ROOT" ]; then [ "$(stat -c '%u:%g:%a' "$LOCK_FILE" 2>/dev/null || true)" = 0:0:600 ] || deny "lock file identity mismatch"; fi
    else
        (umask 077; set -C; : >"$LOCK_FILE") 2>/dev/null || :
        [ ! -L "$LOCK_FILE" ] && [ -f "$LOCK_FILE" ] || deny "could not create safe lock file"
        chmod 0600 "$LOCK_FILE"
        if [ -z "$TEST_ROOT" ]; then [ "$(stat -c '%u:%g:%a' "$LOCK_FILE" 2>/dev/null || true)" = 0:0:600 ] || deny "new lock file identity mismatch"; fi
    fi
    exec 9>>"$LOCK_FILE"; flock -n 9 || deny "another lifecycle operation holds the lock"
}

fresh_preflight() {
    getent passwd "$SVC_USER" >/dev/null 2>&1 && deny "service account exists without marker"
    getent group "$SVC_GROUP" >/dev/null 2>&1 && deny "service group exists without marker"
    for _target in "$CONF_DIR" "$DATA_DIR" "$LOG_DIR" "$BIN_PATH" "$SYSTEMD_TARGET" "$INIT_TARGET"; do require_absent "$_target"; done
    FRESH_SHELL="$(select_fresh_shell)" || deny "a nologin shell is required"
}
create_account() {
    record_mutation "group-create:$SVC_GROUP"
    if command -v groupadd >/dev/null 2>&1; then
        if ! groupadd -r "$SVC_GROUP"; then if getent group "$SVC_GROUP" >/dev/null 2>&1; then deny "service group creation raced"; fi; deny "service group creation failed"; fi
    elif command -v addgroup >/dev/null 2>&1; then
        if ! addgroup -S "$SVC_GROUP"; then if getent group "$SVC_GROUP" >/dev/null 2>&1; then deny "service group creation raced"; fi; deny "service group creation failed"; fi
    else deny "groupadd or addgroup is required"; fi
    getent group "$SVC_GROUP" >/dev/null 2>&1 || deny "created group is not resolvable"

    record_mutation "user-create:$SVC_USER"
    if command -v useradd >/dev/null 2>&1; then
        if ! useradd -r -g "$SVC_GROUP" -M -d "$DATA_DIR" -s "$FRESH_SHELL" "$SVC_USER"; then if getent passwd "$SVC_USER" >/dev/null 2>&1; then deny "service user creation raced"; fi; deny "service user creation failed"; fi
    elif command -v adduser >/dev/null 2>&1; then
        if ! adduser -S -D -H -G "$SVC_GROUP" -s "$FRESH_SHELL" -h "$DATA_DIR" "$SVC_USER"; then if getent passwd "$SVC_USER" >/dev/null 2>&1; then deny "service user creation raced"; fi; deny "service user creation failed"; fi
    else deny "useradd or adduser is required"; fi
    load_account || deny "created account failed identity recheck"
    [ "$ACC_HOME" = "$DATA_DIR" ] && [ "$ACC_SHELL" = "$FRESH_SHELL" ] || deny "created account fields failed identity recheck"
}
generate_install_id() {
    if [ -n "$TEST_INSTALL_ID" ]; then _id="$TEST_INSTALL_ID"
    else [ -r /dev/urandom ] && command -v od >/dev/null 2>&1 || deny "secure install-id generation unavailable"; _id="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"; fi
    case "$_id" in *[!0-9a-f]*|'') deny "generated install-id is invalid" ;; esac
    [ "${#_id}" -eq 64 ] || deny "generated install-id has wrong length"; printf '%s\n' "$_id"
}

write_config_and_credential() {
    record_mutation config-write
    if [ -f "${CONF_DIR}/config.yaml" ]; then cp -p "${CONF_DIR}/config.yaml" "${CONF_DIR}/config.yaml.previous"; set_identity "${CONF_DIR}/config.yaml.previous" 0 "$OWNER_GID" 640; fi
    _tmp="${CONF_DIR}/.config.yaml.new.$$"; require_absent "$_tmp"; umask 077
    cat >"$_tmp" <<EOF
server_url: "${SERVER_URL}"
agent_name: "${AGENT_NAME}"
work_dir: "${DATA_DIR}"
log_file: "${LOG_DIR}/${PROG}.log"
log_level: info
max_concurrent_tasks: 2
heartbeat_interval: 15s
shutdown_timeout: 60s
EOF
    prepare_identity "$_tmp" 0 "$OWNER_GID" 640; mv -f "$_tmp" "${CONF_DIR}/config.yaml"; set_identity "${CONF_DIR}/config.yaml" 0 "$OWNER_GID" 640

    record_mutation credential-write; _tmp="${CONF_DIR}/.agent.env.new.$$"; require_absent "$_tmp"; umask 077
    printf 'AWP_AGENT_API_KEY=%s\n' "$API_KEY" >"$_tmp"; prepare_identity "$_tmp" 0 "$OWNER_GID" 640
    mv -f "$_tmp" "${CONF_DIR}/agent.env"; set_identity "${CONF_DIR}/agent.env" 0 "$OWNER_GID" 640
    API_KEY=""; unset API_KEY

    record_mutation release-key-write; _tmp="${CONF_DIR}/.release-key.new.$$"; require_absent "$_tmp"
    cp "$PUBKEY_FILE" "$_tmp"; prepare_identity "$_tmp" 0 0 644
    mv -f "$_tmp" "${CONF_DIR}/awp-vm-agent-release-key.asc"; set_identity "${CONF_DIR}/awp-vm-agent-release-key.asc" 0 0 644
}
write_binary_and_service() {
    record_mutation binary-write; _tmp="${PREFIX}/.${PROG}.new.$$"; require_absent "$_tmp"
    cp "$BIN_TMP" "$_tmp"; prepare_identity "$_tmp" 0 0 755; mv -f "$_tmp" "$BIN_PATH"; set_identity "$BIN_PATH" 0 0 755
    case "$INIT_SYS" in systemd) _target="$SYSTEMD_TARGET"; _mode=644 ;; openrc|sysv) _target="$INIT_TARGET"; _mode=755 ;; esac
    record_mutation "service-registration-write:$INIT_SYS"; _tmp="${_target}.new.$$"; require_absent "$_tmp"
    cp "$SERVICE_SOURCE" "$_tmp"; prepare_identity "$_tmp" 0 0 "$_mode"; mv -f "$_tmp" "$_target"; set_identity "$_target" 0 0 "$_mode"
}
write_marker() {
    _state="$1"; _registered="$2"; record_mutation "marker-write:${_state}:${_registered}"
    _tmp="${CONF_DIR}/.awp-install-owner-v1.new.$$"; require_absent "$_tmp"; umask 077
    cat >"$_tmp" <<EOF
schema=awp-vm-agent-owner-v1
state=${_state}
install-id=${INSTALL_ID}
registered=${_registered}
user=${SVC_USER}
uid=${OWNER_UID}
group=${SVC_GROUP}
gid=${OWNER_GID}
home=${DATA_DIR}
shell=${OWNER_SHELL}
conf=${CONF_DIR}
data=${DATA_DIR}
log=${LOG_DIR}
binary=${BIN_PATH}
systemd=${SYSTEMD_TARGET}
init=${INIT_TARGET}
init-system=${INIT_SYS}
EOF
    prepare_identity "$_tmp" 0 0 400; mv -f "$_tmp" "$MARKER"; set_identity "$MARKER" 0 0 400
}
activate_service() {
    [ "$START_SERVICE" -eq 1 ] || return 0
    [ -z "$TEST_ROOT" ] || deny "--start is unavailable in the filesystem test harness"
    case "$INIT_SYS" in
        systemd) systemctl daemon-reload; systemctl enable "${PROG}.service"; write_marker installed 1; systemctl start "${PROG}.service"; systemctl is-active --quiet "${PROG}.service" || deny "service did not become active" ;;
        openrc) rc-update add "$PROG" default; write_marker installed 1; rc-service "$PROG" start; rc-service "$PROG" status >/dev/null 2>&1 || deny "service did not become active" ;;
        sysv)
            if command -v chkconfig >/dev/null 2>&1; then chkconfig --add "$PROG"; chkconfig "$PROG" on
            elif command -v update-rc.d >/dev/null 2>&1; then update-rc.d "$PROG" defaults
            else deny "no SysV registration tool is available"; fi
            write_marker installed 1; "$INIT_TARGET" start; "$INIT_TARGET" status >/dev/null 2>&1 || deny "service did not become active"
            ;;
    esac
}

acquire_lock
if exists_any "$MARKER"; then
    load_marker; validate_persistent
    case "$M_STATE" in installed) validate_installed_targets; [ "$M_REGISTERED" = 0 ] || deny "uninstall registered service before reinstalling" ;; retained) validate_retained_targets ;; esac
    [ "$REPLACE_CONFIG" -eq 1 ] || deny "reinstall requires --replace-config"
    INSTALL_ID="$M_ID"; OWNER_UID="$M_UID"; OWNER_GID="$M_GID"; OWNER_SHELL="$M_SHELL"
else
    fresh_preflight; create_account
    OWNER_UID="$ACC_UID"; OWNER_GID="$ACC_GID"; OWNER_SHELL="$ACC_SHELL"; INSTALL_ID="$(generate_install_id)"
    record_mutation "directory-create:$CONF_DIR"; mkdir "$CONF_DIR"; set_identity "$CONF_DIR" 0 "$OWNER_GID" 750
    record_mutation "directory-create:$DATA_DIR"; mkdir "$DATA_DIR"; set_identity "$DATA_DIR" "$OWNER_UID" "$OWNER_GID" 750
    record_mutation "directory-create:$LOG_DIR"; mkdir "$LOG_DIR"; set_identity "$LOG_DIR" "$OWNER_UID" "$OWNER_GID" 750
fi

write_config_and_credential
write_binary_and_service
write_marker installed 0
if [ "$INIT_SYS" = systemd ] && [ -z "$TEST_ROOT" ]; then systemctl daemon-reload; fi
activate_service
log "installed verified binary under marker install-id $INSTALL_ID"
[ "$START_SERVICE" -eq 1 ] || warn "service is installed but not enabled or started"
log "installation complete (distribution=${DISTRO_ID} version=${DISTRO_VERSION} init=${INIT_SYS} account=${SVC_USER})"
