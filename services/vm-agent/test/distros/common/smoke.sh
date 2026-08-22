#!/bin/sh
#
# smoke.sh — runs inside each distro container.
#
# Assumed layout inside container (mounted in from the host):
#   /src/install/          vm-agent/install/ (install.sh, uninstall.sh, units)
#   /src/releases/         fake release tree produced by mk-test-release.sh
#   /src/test-keys/        test pubkey (mounted over install/keys/)
#
# What we check:
#   1. install.sh --dry-run exits 0
#   2. install.sh (real, using exact test mode plus explicit file:// release, SHA, and pubkey) completes
#   3. config permissions allow awp-vm-agent and deny a non-group account
#   4. /usr/local/bin/awp-vm-agent --version works
#   5. service is active (systemd / openrc / sysv appropriate)
#   6. agent log proves runtime inputs were readable and emits a heartbeat
#   7. uninstall.sh leaves /usr/local/bin/awp-vm-agent gone
#
# Exit 0 on full pass, non-zero with a diagnostic on fail.

set -eu

DISTRO_ID="${1:-unknown}"
INIT_SYS_EXPECT="${2:-systemd}"   # systemd / openrc / sysv

RED=$(printf '\033[31m'); GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m'); NC=$(printf '\033[0m')
PASS() { printf '%s[PASS]%s %s\n' "$GREEN" "$NC" "$1"; }
FAIL() { printf '%s[FAIL]%s %s\n' "$RED"   "$NC" "$1"; exit 1; }
INFO() { printf '%s[....]%s %s\n' "$YELLOW" "$NC" "$1"; }

INFO "smoke test on distro=${DISTRO_ID} init_expect=${INIT_SYS_EXPECT}"

# 0. Copy install assets into a writable spot + mount pubkey.
WORK=/tmp/install-work
rm -rf "$WORK"
mkdir -p "$WORK/install/keys"
cp -r /src/install/. "$WORK/install/"
cp /src/test-keys/awp-vm-agent-release-key.asc "$WORK/install/keys/awp-vm-agent-release-key.asc"

# Expose the signed fixture only through the exact installer test mode.
RELEASE_BASE="file:///src/releases"
PUBKEY="$WORK/install/keys/awp-vm-agent-release-key.asc"
API_KEY_FILE="$WORK/agent-api-key"
printf 'smoke-test-key\n' >"$API_KEY_FILE"
chmod 0600 "$API_KEY_FILE"
BINARY_SHA256="$(awk '$2 == "awp-vm-agent-linux-amd64" { print $1 }' /src/releases/v0.1.0-smoketest/SHA256SUMS)"
[ -n "$BINARY_SHA256" ] || FAIL "fixture digest missing"

# 1. --dry-run
INFO "step 1/7: install.sh --dry-run"
AWP_INSTALL_TEST_MODE=1 sh "$WORK/install/install.sh" --dry-run \
    --agent-name smoke-$$ \
    --release-base "$RELEASE_BASE" \
    --version v0.1.0-smoketest \
    --binary-sha256 "$BINARY_SHA256" \
    --pubkey "$PUBKEY" \
    --api-key-file "$API_KEY_FILE" \
    --server-url ws://127.0.0.1:8100/agent/connect \
    --arch amd64 \
    >/tmp/install-dryrun.log 2>&1 \
    || { cat /tmp/install-dryrun.log; FAIL "dry-run exited non-zero"; }
PASS "dry-run"

# 2. real install
INFO "step 2/7: install.sh (real) against test CDN"
AWP_INSTALL_TEST_MODE=1 sh "$WORK/install/install.sh" \
    --agent-name smoke-$$ \
    --release-base "$RELEASE_BASE" \
    --version v0.1.0-smoketest \
    --binary-sha256 "$BINARY_SHA256" \
    --pubkey "$PUBKEY" \
    --api-key-file "$API_KEY_FILE" \
    --server-url ws://127.0.0.1:8100/agent/connect \
    --arch amd64 \
    --force-distro-unknown \
    --start \
    >/tmp/install-real.log 2>&1 \
    || { cat /tmp/install-real.log; FAIL "install exited non-zero"; }
PASS "install (real)"

# 3. permission boundary
INFO "step 3/7: service credential permissions"
CONF_ROOT="/etc/awp-vm-agent"
CONFIG_FILE="$CONF_ROOT/config.yaml"
ENV_FILE="$CONF_ROOT/agent.env"

[ "$(stat -c '%U:%G:%a' "$CONF_ROOT")" = "root:awp-vm-agent:750" ] ||
    FAIL "config directory ownership or mode is not root:awp-vm-agent 0750"
[ "$(stat -c '%U:%G:%a' "$CONFIG_FILE")" = "root:awp-vm-agent:640" ] ||
    FAIL "config file ownership or mode is not root:awp-vm-agent 0640"
[ "$(stat -c '%U:%G:%a' "$ENV_FILE")" = "root:awp-vm-agent:640" ] ||
    FAIL "credential file ownership or mode is not root:awp-vm-agent 0640"

run_as_user() {
    target_user="$1"
    command_text="$2"
    if command -v runuser >/dev/null 2>&1; then
        runuser -s /bin/sh - "$target_user" -c "$command_text"
    else
        su -s /bin/sh - "$target_user" -c "$command_text"
    fi
}

run_as_user awp-vm-agent 'cd /etc/awp-vm-agent && cat config.yaml >/dev/null && cat agent.env >/dev/null' >/dev/null 2>&1 ||
    FAIL "service user cannot traverse and read its root-managed runtime inputs"

OUTSIDER="awp-smoke-outsider"
if id "$OUTSIDER" >/dev/null 2>&1; then
    FAIL "unexpected pre-existing outsider account in disposable smoke container"
elif command -v useradd >/dev/null 2>&1; then
    useradd --system --home-dir /nonexistent --shell /sbin/nologin "$OUTSIDER"
elif command -v adduser >/dev/null 2>&1; then
    adduser -S -D -H -s /sbin/nologin "$OUTSIDER"
else
    FAIL "useradd or adduser is required for permission-boundary smoke"
fi

if id -nG "$OUTSIDER" | tr ' ' '\n' | grep -qx awp-vm-agent; then
    FAIL "outsider account unexpectedly belongs to awp-vm-agent group"
fi
if run_as_user "$OUTSIDER" 'cd /etc/awp-vm-agent' >/dev/null 2>&1; then
    FAIL "non-group account can traverse config directory"
fi
if run_as_user "$OUTSIDER" 'cat /etc/awp-vm-agent/config.yaml >/dev/null' >/dev/null 2>&1; then
    FAIL "non-group account can read config file"
fi
if run_as_user "$OUTSIDER" 'cat /etc/awp-vm-agent/agent.env >/dev/null' >/dev/null 2>&1; then
    FAIL "non-group account can read credential file"
fi
PASS "root:awp-vm-agent permission boundary"

# 4. --version
INFO "step 4/7: awp-vm-agent --version"
if ! /usr/local/bin/awp-vm-agent --version >/tmp/version.log 2>&1; then
    cat /tmp/version.log
    FAIL "binary did not respond to --version"
fi
grep -q "awp-vm-agent" /tmp/version.log || FAIL "binary version output missing expected string"
PASS "--version ok ($(cat /tmp/version.log))"

# 5. service active
INFO "step 5/7: service started"
# In docker without full init we can't always rely on `systemctl is-active`.
# The smoke-stub runs via --daemon and writes to a log; check the log, and
# if systemctl is truly available also verify the unit status.
sleep 3

LOG_FILE="/var/log/awp-vm-agent/awp-vm-agent.log"
if [ ! -f "$LOG_FILE" ]; then
    # sysv init with runuser may have landed it elsewhere.
    LOG_FILE="/tmp/awp-vm-agent.log"
fi

case "$INIT_SYS_EXPECT" in
    systemd)
        if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
            if ! systemctl is-active awp-vm-agent.service >/dev/null 2>&1; then
                systemctl --no-pager status awp-vm-agent.service || true
                INFO "systemctl is-active returned non-active; checking heartbeat anyway"
            fi
        else
            INFO "container has no systemd runtime; skipping unit-active check, verifying heartbeat"
        fi
        ;;
    openrc)
        rc-service awp-vm-agent status || INFO "rc-service status non-zero; checking heartbeat"
        ;;
    sysv)
        /etc/init.d/awp-vm-agent status || INFO "init.d status non-zero; checking heartbeat"
        ;;
esac

# 6. runtime input proof and heartbeat
INFO "step 6/7: runtime input proof and heartbeat in log"
i=0
while [ "$i" -lt 15 ]; do
    if [ -f "$LOG_FILE" ] && grep -q "runtime-inputs-readable" "$LOG_FILE" 2>/dev/null && grep -q "heartbeat" "$LOG_FILE" 2>/dev/null; then
        break
    fi
    sleep 1
    i=$((i + 1))
done
if [ ! -f "$LOG_FILE" ] || ! grep -q "runtime-inputs-readable" "$LOG_FILE" 2>/dev/null || ! grep -q "heartbeat" "$LOG_FILE" 2>/dev/null; then
    echo "--- log dump ($LOG_FILE) ---"
    [ -f "$LOG_FILE" ] && tail -n 30 "$LOG_FILE" || echo "(log missing)"
    FAIL "runtime input proof or heartbeat missing from log within 15s"
fi
PASS "service identity read runtime inputs; heartbeat present ($(grep -c heartbeat "$LOG_FILE") lines)"

# 7. uninstall
INFO "step 7/7: uninstall"
sh "$WORK/install/uninstall.sh" >/tmp/uninstall.log 2>&1 \
    || { cat /tmp/uninstall.log; FAIL "uninstall exited non-zero"; }
if [ -x /usr/local/bin/awp-vm-agent ]; then
    FAIL "binary still present after uninstall"
fi
grep -qx 'state=retained' /etc/awp-vm-agent/.awp-install-owner-v1 ||
    FAIL "ownership marker did not enter retained state"
id awp-vm-agent >/dev/null 2>&1 || FAIL "dedicated account was removed"
[ -d /var/lib/awp-vm-agent ] && [ -d /var/log/awp-vm-agent ] ||
    FAIL "persistent state was removed"
PASS "uninstall retained account and persistent state"

printf '\n%s[SMOKE PASS]%s distro=%s init=%s\n' "$GREEN" "$NC" "$DISTRO_ID" "$INIT_SYS_EXPECT"
