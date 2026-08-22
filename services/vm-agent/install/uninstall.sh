#!/bin/sh
# Fail-closed uninstaller for the AWP VM agent source preview.
# It removes only marker-authorized executable/service targets and retains identity state.

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
TEST_MODE="${AWP_INSTALL_TEST_MODE:-0}"
TEST_ROOT="${AWP_INSTALL_TEST_ROOT:-}"
TEST_INIT="${AWP_INSTALL_TEST_INIT:-}"
MUTATION_LOG="${AWP_INSTALL_MUTATION_LOG:-}"
TEST_META=""

die() { printf 'uninstall.sh: error: %s\n' "$*" >&2; exit 1; }
deny() { printf 'uninstall.sh: unsupported or unsafe: %s\n' "$*" >&2; exit 77; }
log() { printf 'uninstall.sh: %s\n' "$*"; }

usage() {
    cat <<'EOF'
Usage: uninstall.sh
  -h, --help  show this help

The default operation removes only the marker-authorized binary and exact
service registration. It preserves the dedicated account, group, config,
credentials, data, logs, and ownership marker in retained state.
--purge is deliberately unsupported in this source preview.
EOF
}

PURGE=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --purge) PURGE=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown argument: $1 (see --help)" ;;
    esac
done
[ "$PURGE" -eq 0 ] || deny "--purge is disabled; preserved state requires an explicit administrator-owned migration"
[ "$(id -u)" -eq 0 ] || { [ "$TEST_MODE" = 1 ] && [ -n "$TEST_ROOT" ]; } || die "must run as root"

if [ "$TEST_MODE" = "1" ]; then
    [ -n "$TEST_ROOT" ] || deny "test mode requires an explicit test root"
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
else
    [ -z "$TEST_ROOT$TEST_INIT$MUTATION_LOG" ] || deny "test-only environment requires AWP_INSTALL_TEST_MODE=1"
fi

command -v flock >/dev/null 2>&1 || deny "flock is required"
command -v getent >/dev/null 2>&1 || deny "getent is required"

if [ -n "$TEST_INIT" ]; then
    [ "$TEST_MODE" = 1 ] || deny "test init override is test-only"
    INIT_SYS="$TEST_INIT"
elif [ -d /run/systemd/system ] || { command -v systemctl >/dev/null 2>&1 && [ -r /proc/1/comm ] && grep -q systemd /proc/1/comm; }; then
    INIT_SYS=systemd
elif [ -d /run/openrc ] || command -v rc-status >/dev/null 2>&1; then
    INIT_SYS=openrc
else
    INIT_SYS=sysv
fi
case "$INIT_SYS" in systemd|openrc|sysv) ;; *) deny "invalid init system" ;; esac

record_mutation() {
    if [ "$TEST_MODE" = 1 ] && [ -n "$MUTATION_LOG" ]; then printf '%s\n' "$1" >>"$MUTATION_LOG"; fi
}
exists_any() { [ -e "$1" ] || [ -L "$1" ]; }

test_meta_set() {
    _path="$1"; _uid="$2"; _gid="$3"; _mode="$4"; _meta_tmp="${TEST_META}.new.$$"
    if [ -f "$TEST_META" ]; then awk -F '\t' -v p="$_path" '$1 != p' "$TEST_META" >"$_meta_tmp"; else : >"$_meta_tmp"; fi
    printf '%s\t%s\t%s\t%s\n' "$_path" "$_uid" "$_gid" "$_mode" >>"$_meta_tmp"
    mv -f "$_meta_tmp" "$TEST_META"
}
test_meta_remove() {
    [ -f "$TEST_META" ] || return 0
    _meta_tmp="${TEST_META}.new.$$"
    awk -F '\t' -v p="$1" '$1 != p' "$TEST_META" >"$_meta_tmp"
    mv -f "$_meta_tmp" "$TEST_META"
}
path_identity() {
    if [ -n "$TEST_META" ]; then
        awk -F '\t' -v p="$1" '$1 == p {print $2 ":" $3 ":" $4; found=1} END {if (!found) exit 1}' "$TEST_META"
    else
        stat -c '%u:%g:%a' "$1"
    fi
}
path_nlink() {
    if [ -n "$TEST_META" ]; then printf '1\n'; else stat -c '%h' "$1"; fi
}
set_identity() {
    if [ -n "$TEST_META" ]; then
        chmod "$4" "$1"
        test_meta_set "$1" "$2" "$3" "$4"
    else
        chown "$2:$3" "$1"
        chmod "$4" "$1"
    fi
}
require_absent() {
    if exists_any "$1"; then deny "retained target must be absent: $1"; fi
}
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
shell_allowed() {
    if [ -n "$TEST_ROOT" ]; then
        [ "$1" = "${TEST_ROOT}/usr/sbin/nologin" ] || [ "$1" = "${TEST_ROOT}/sbin/nologin" ]
    else
        [ "$1" = /usr/sbin/nologin ] || [ "$1" = /sbin/nologin ]
    fi
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
load_marker() {
    require_marker_file
    [ "$(awk 'END {print NR}' "$MARKER")" -eq 17 ] || deny "marker line count mismatch"
    [ "$(sed -n '1p' "$MARKER")" = schema=awp-vm-agent-owner-v1 ] || deny "marker schema mismatch"
    M_STATE="$(sed -n '2s/^state=//p' "$MARKER")"
    M_ID="$(sed -n '3s/^install-id=//p' "$MARKER")"
    M_REGISTERED="$(sed -n '4s/^registered=//p' "$MARKER")"
    M_UID="$(sed -n '6s/^uid=//p' "$MARKER")"
    M_GID="$(sed -n '8s/^gid=//p' "$MARKER")"
    M_SHELL="$(sed -n '10s/^shell=//p' "$MARKER")"
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
    [ "$(sed -n '2p' "$MARKER")" = "state=$M_STATE" ] || deny "marker state key mismatch"
    [ "$(sed -n '3p' "$MARKER")" = "install-id=$M_ID" ] || deny "marker install-id key mismatch"
    [ "$(sed -n '4p' "$MARKER")" = "registered=$M_REGISTERED" ] || deny "marker registered key mismatch"
    [ "$(sed -n '6p' "$MARKER")" = "uid=$M_UID" ] || deny "marker uid key mismatch"
    [ "$(sed -n '8p' "$MARKER")" = "gid=$M_GID" ] || deny "marker gid key mismatch"
    [ "$(sed -n '10p' "$MARKER")" = "shell=$M_SHELL" ] || deny "marker shell key mismatch"
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
    case "$INIT_SYS" in
        systemd) require_file "$SYSTEMD_TARGET" 0 0 644; require_absent "$INIT_TARGET" ;;
        openrc|sysv) require_file "$INIT_TARGET" 0 0 755; require_absent "$SYSTEMD_TARGET" ;;
    esac
}
validate_retained_targets() {
    [ "$M_REGISTERED" = 0 ] || deny "retained marker cannot be registered"
    require_absent "$BIN_PATH"
    require_absent "$SYSTEMD_TARGET"
    require_absent "$INIT_TARGET"
}
acquire_lock() {
    [ ! -L "$LOCK_DIR" ] && [ -d "$LOCK_DIR" ] || deny "lock directory is unsafe"
    if [ -z "$TEST_ROOT" ]; then
        case "$(stat -c '%u:%g:%a' "$LOCK_DIR" 2>/dev/null || true)" in 0:0:*) ;; *) deny "lock directory must be root-owned" ;; esac
    fi
    if exists_any "$LOCK_FILE"; then
        [ ! -L "$LOCK_FILE" ] && [ -f "$LOCK_FILE" ] || deny "lock file is unsafe"
        if [ -z "$TEST_ROOT" ]; then [ "$(stat -c '%u:%g:%a' "$LOCK_FILE" 2>/dev/null || true)" = 0:0:600 ] || deny "lock file identity mismatch"; fi
    else
        (umask 077; set -C; : >"$LOCK_FILE") 2>/dev/null || :
        [ ! -L "$LOCK_FILE" ] && [ -f "$LOCK_FILE" ] || deny "could not create safe lock file"
        chmod 0600 "$LOCK_FILE"
        if [ -z "$TEST_ROOT" ]; then [ "$(stat -c '%u:%g:%a' "$LOCK_FILE" 2>/dev/null || true)" = 0:0:600 ] || deny "new lock file identity mismatch"; fi
    fi
    exec 9>>"$LOCK_FILE"
    flock -n 9 || deny "another lifecycle operation holds the lock"
}
remove_exact() {
    _path="$1"
    exists_any "$_path" || return 0
    [ ! -L "$_path" ] && [ -f "$_path" ] || deny "refusing non-regular exact target: $_path"
    record_mutation "remove:$_path"
    rm -f "$_path"
    if [ -n "$TEST_META" ]; then test_meta_remove "$_path"; fi
}
deregister_service() {
    [ "$M_REGISTERED" = 1 ] || return 0
    record_mutation "service-stop:$INIT_SYS"
    if [ -n "$TEST_ROOT" ]; then return 0; fi
    case "$INIT_SYS" in
        systemd)
            systemctl stop "${PROG}.service"
            systemctl disable "${PROG}.service"
            ;;
        openrc)
            rc-service "$PROG" stop
            rc-update del "$PROG" default
            ;;
        sysv)
            "$INIT_TARGET" stop
            if command -v chkconfig >/dev/null 2>&1; then
                chkconfig "$PROG" off
                chkconfig --del "$PROG"
            elif command -v update-rc.d >/dev/null 2>&1; then
                update-rc.d -f "$PROG" remove
            else
                deny "no SysV deregistration tool is available"
            fi
            ;;
    esac
}
write_retained_marker() {
    record_mutation marker-write:retained:0
    _tmp="${CONF_DIR}/.awp-install-owner-v1.new.$$"
    [ ! -e "$_tmp" ] && [ ! -L "$_tmp" ] || deny "marker temp target exists"
    umask 077
    cat >"$_tmp" <<EOF
schema=awp-vm-agent-owner-v1
state=retained
install-id=${M_ID}
registered=0
user=${SVC_USER}
uid=${M_UID}
group=${SVC_GROUP}
gid=${M_GID}
home=${DATA_DIR}
shell=${M_SHELL}
conf=${CONF_DIR}
data=${DATA_DIR}
log=${LOG_DIR}
binary=${BIN_PATH}
systemd=${SYSTEMD_TARGET}
init=${INIT_TARGET}
init-system=${INIT_SYS}
EOF
    set_identity "$_tmp" 0 0 400
    mv -f "$_tmp" "$MARKER"
    set_identity "$MARKER" 0 0 400
}

acquire_lock
exists_any "$MARKER" || deny "ownership marker is missing"
load_marker
validate_persistent
if [ "$M_STATE" = retained ]; then
    validate_retained_targets
    log "already retained; no mutation occurred"
    exit 0
fi
validate_installed_targets
deregister_service
case "$INIT_SYS" in
    systemd)
        remove_exact "$SYSTEMD_TARGET"
        if [ -z "$TEST_ROOT" ]; then systemctl daemon-reload; fi
        ;;
    openrc|sysv) remove_exact "$INIT_TARGET" ;;
esac
remove_exact "$BIN_PATH"
write_retained_marker
log "removed exact service registration and binary; preserved account, config, credentials, data, logs, and marker"
