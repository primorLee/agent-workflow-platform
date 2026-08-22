#!/bin/sh
# awp-vm-agent SysV service template.
# Persistent ownership is established only by marker-authorized install.sh.

### BEGIN INIT INFO
# Provides:          awp-vm-agent
# Required-Start:    $network $remote_fs
# Required-Stop:     $network $remote_fs
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Short-Description: Agent Workflow Platform VM Agent
### END INIT INFO

PROG=awp-vm-agent
EXEC=/usr/local/bin/awp-vm-agent
CONFIG=/etc/awp-vm-agent/config.yaml
ENVFILE=/etc/awp-vm-agent/agent.env
KEYFILE=/etc/awp-vm-agent/awp-vm-agent-release-key.asc
CONFDIR=/etc/awp-vm-agent
DATADIR=/var/lib/awp-vm-agent
LOGDIR=/var/log/awp-vm-agent
MARKER=${CONFDIR}/.awp-install-owner-v1
INITTARGET=/etc/init.d/awp-vm-agent
SYSTEMDTARGET=/etc/systemd/system/awp-vm-agent.service
RUNDIR=/run/${PROG}
PIDFILE=${RUNDIR}/${PROG}.pid
LOGFILE=${LOGDIR}/${PROG}.log
SVC_USER=awp-vm-agent
SVC_GROUP=awp-vm-agent

if [ -r /etc/rc.d/init.d/functions ]; then
    . /etc/rc.d/init.d/functions
    USE_FUNCTIONS=1
else
    USE_FUNCTIONS=0
fi

msg() {
    if [ "$USE_FUNCTIONS" = 1 ]; then action "$1" /bin/true; else echo "$1"; fi
}
unsafe() {
    echo "$PROG: unsafe lifecycle state: $*" >&2
    return 77
}
exists_any() { [ -e "$1" ] || [ -L "$1" ]; }
identity() { stat -c '%u:%g:%a' "$1" 2>/dev/null; }
require_dir() {
    [ ! -L "$1" ] && [ -d "$1" ] && [ "$(identity "$1")" = "$2" ] || unsafe "$1 directory contract mismatch"
}
require_file() {
    [ ! -L "$1" ] && [ -f "$1" ] && [ "$(identity "$1")" = "$2" ] || unsafe "$1 file contract mismatch"
}
validate_contract() {
    command -v getent >/dev/null 2>&1 || unsafe "getent is required"
    command -v stat >/dev/null 2>&1 || unsafe "stat is required"
    require_file "$MARKER" 0:0:400 || return 77
    [ "$(stat -c '%h' "$MARKER" 2>/dev/null)" = 1 ] || unsafe "marker link count mismatch" || return 77
    [ "$(awk 'END {print NR}' "$MARKER")" = 17 ] || unsafe "marker line count mismatch" || return 77
    [ "$(sed -n '1p' "$MARKER")" = schema=awp-vm-agent-owner-v1 ] || unsafe "marker schema mismatch" || return 77
    [ "$(sed -n '2p' "$MARKER")" = state=installed ] || unsafe "marker state mismatch" || return 77
    INSTALL_ID=$(sed -n '3s/^install-id=//p' "$MARKER")
    [ "$(sed -n '4p' "$MARKER")" = registered=1 ] || unsafe "service is not marker-registered" || return 77
    UID_M=$(sed -n '6s/^uid=//p' "$MARKER")
    GID_M=$(sed -n '8s/^gid=//p' "$MARKER")
    SHELL_M=$(sed -n '10s/^shell=//p' "$MARKER")
    [ "$(sed -n '5p' "$MARKER")" = user=$SVC_USER ] || unsafe "marker user mismatch" || return 77
    [ "$(sed -n '7p' "$MARKER")" = group=$SVC_GROUP ] || unsafe "marker group mismatch" || return 77
    [ "$(sed -n '9p' "$MARKER")" = home=$DATADIR ] || unsafe "marker home mismatch" || return 77
    [ "$(sed -n '11p' "$MARKER")" = conf=$CONFDIR ] || unsafe "marker conf mismatch" || return 77
    [ "$(sed -n '12p' "$MARKER")" = data=$DATADIR ] || unsafe "marker data mismatch" || return 77
    [ "$(sed -n '13p' "$MARKER")" = log=$LOGDIR ] || unsafe "marker log mismatch" || return 77
    [ "$(sed -n '14p' "$MARKER")" = binary=$EXEC ] || unsafe "marker binary mismatch" || return 77
    [ "$(sed -n '15p' "$MARKER")" = systemd=$SYSTEMDTARGET ] || unsafe "marker systemd mismatch" || return 77
    [ "$(sed -n '16p' "$MARKER")" = init=$INITTARGET ] || unsafe "marker init mismatch" || return 77
    [ "$(sed -n '17p' "$MARKER")" = init-system=sysv ] || unsafe "marker init-system mismatch" || return 77
    case "$INSTALL_ID" in *[!0-9a-f]*|'') unsafe "marker install-id mismatch"; return 77 ;; esac
    [ "${#INSTALL_ID}" = 64 ] || unsafe "marker install-id length mismatch" || return 77
    case "$UID_M:$GID_M" in *[!0-9:]*|*::*|'') unsafe "marker numeric identity mismatch"; return 77 ;; esac
    case "$SHELL_M" in /usr/sbin/nologin|/sbin/nologin) [ -x "$SHELL_M" ] || unsafe "nologin shell is missing" || return 77 ;; *) unsafe "marker shell mismatch"; return 77 ;; esac

    PW=$(getent passwd "$SVC_USER" 2>/dev/null) || unsafe "service account missing" || return 77
    GR=$(getent group "$SVC_GROUP" 2>/dev/null) || unsafe "service group missing" || return 77
    [ "$(printf '%s\n' "$PW" | awk 'END {print NR}')" = 1 ] || unsafe "service account is ambiguous" || return 77
    [ "$(printf '%s\n' "$GR" | awk 'END {print NR}')" = 1 ] || unsafe "service group is ambiguous" || return 77
    [ "$(printf '%s\n' "$PW" | awk -F: 'NF==7 {print $1 ":" $3 ":" $4 ":" $6 ":" $7}')" = "$SVC_USER:$UID_M:$GID_M:$DATADIR:$SHELL_M" ] || unsafe "service account differs from marker" || return 77
    [ "$(printf '%s\n' "$GR" | awk -F: 'NF>=3 {print $1 ":" $3}')" = "$SVC_GROUP:$GID_M" ] || unsafe "service group differs from marker" || return 77

    require_dir "$CONFDIR" "0:$GID_M:750" || return 77
    require_dir "$DATADIR" "$UID_M:$GID_M:750" || return 77
    require_dir "$LOGDIR" "$UID_M:$GID_M:750" || return 77
    require_file "$CONFIG" "0:$GID_M:640" || return 77
    require_file "$ENVFILE" "0:$GID_M:640" || return 77
    require_file "$KEYFILE" 0:0:644 || return 77
    require_file "$EXEC" 0:0:755 || return 77
    require_file "$INITTARGET" 0:0:755 || return 77
    if exists_any "$SYSTEMDTARGET"; then unsafe "foreign systemd target exists"; return 77; fi
    return 0
}
prepare_runtime() {
    if exists_any "$RUNDIR"; then
        require_dir "$RUNDIR" "$UID_M:$GID_M:750" || return 77
    else
        mkdir "$RUNDIR" || return 77
        chown "$SVC_USER:$SVC_GROUP" "$RUNDIR" || return 77
        chmod 0750 "$RUNDIR" || return 77
        require_dir "$RUNDIR" "$UID_M:$GID_M:750" || return 77
    fi
}
safe_pid() {
    [ -f "$PIDFILE" ] && [ ! -L "$PIDFILE" ] || return 1
    PID=$(cat "$PIDFILE" 2>/dev/null) || return 1
    case "$PID" in *[!0-9]*|'') return 1 ;; esac
    [ -r "/proc/$PID/status" ] && [ -L "/proc/$PID/exe" ] || return 1
    [ "$(awk '/^Uid:/ {print $2}' "/proc/$PID/status")" = "$UID_M" ] || return 1
    PROC_EXE="$(readlink -f "/proc/$PID/exe" 2>/dev/null)" || return 1
    if [ "$PROC_EXE" != "$EXEC" ]; then
        [ -r "/proc/$PID/cmdline" ] || return 1
        tr '\000' '\n' <"/proc/$PID/cmdline" | grep -Fx "$EXEC" >/dev/null 2>&1 || return 1
    fi
}

start() {
    validate_contract || return 77
    prepare_runtime || return 77
    if exists_any "$PIDFILE"; then
        if safe_pid && kill -0 "$PID" 2>/dev/null; then echo "$PROG is already running (pid $PID)"; return 0; fi
        unsafe "pid file does not identify this service"; return 77
    fi
    echo -n "Starting $PROG: "
    if command -v runuser >/dev/null 2>&1; then
        runuser -s /bin/sh "$SVC_USER" -c "set -a; . $ENVFILE; set +a; nohup $EXEC --daemon --config $CONFIG >>$LOGFILE 2>&1 & echo \$! >$PIDFILE"
    else
        su -s /bin/sh "$SVC_USER" -c "set -a; . $ENVFILE; set +a; nohup $EXEC --daemon --config $CONFIG >>$LOGFILE 2>&1 & echo \$! >$PIDFILE"
    fi
    sleep 1
    if safe_pid && kill -0 "$PID" 2>/dev/null; then msg "OK"; return 0; fi
    echo "FAILED"
    rm -f "$PIDFILE"
    return 1
}

stop() {
    validate_contract || return 77
    prepare_runtime || return 77
    echo -n "Stopping $PROG: "
    if exists_any "$PIDFILE"; then
        safe_pid || { unsafe "pid file does not identify this service"; return 77; }
        kill -TERM "$PID"
        i=0
        while kill -0 "$PID" 2>/dev/null && [ "$i" -lt 120 ]; do sleep 1; i=$((i + 1)); done
        if kill -0 "$PID" 2>/dev/null; then kill -KILL "$PID"; fi
        rm -f "$PIDFILE"
    fi
    msg "OK"
}

status() {
    validate_contract || return 77
    prepare_runtime || return 77
    if exists_any "$PIDFILE"; then
        if safe_pid && kill -0 "$PID" 2>/dev/null; then echo "$PROG is running (pid $PID)"; return 0; fi
        unsafe "pid file does not identify this service"; return 77
    fi
    echo "$PROG is stopped"
    return 3
}

case "${1:-}" in
    start) start ;;
    stop) stop ;;
    restart) stop && start ;;
    status) status ;;
    *) echo "Usage: $0 {start|stop|restart|status}"; exit 2 ;;
esac
