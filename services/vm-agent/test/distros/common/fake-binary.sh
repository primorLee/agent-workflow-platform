#!/bin/sh
# Fake awp-vm-agent binary for installer smoke tests.
#
# It must prove that the daemon identity can read both the installed config and
# the root-managed environment file. It never prints their contents.

set -eu

VERSION="0.1.0-smoketest"
MODE=""
CONFIG=""

usage() {
    printf '%s\n' "usage: awp-vm-agent --version | --daemon --config PATH" >&2
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --version|-V|version)
            [ -z "$MODE" ] || { usage; exit 64; }
            MODE="version"
            ;;
        --daemon)
            [ -z "$MODE" ] || { usage; exit 64; }
            MODE="daemon"
            ;;
        --config)
            shift
            [ "$#" -gt 0 ] || { usage; exit 64; }
            CONFIG="$1"
            ;;
        *)
            usage
            exit 64
            ;;
    esac
    shift
done

case "$MODE" in
    version)
        [ -z "$CONFIG" ] || { usage; exit 64; }
        echo "awp-vm-agent $VERSION (smoke-test stub)"
        ;;
    daemon)
        [ -n "$CONFIG" ] || { usage; exit 64; }
        ENV_FILE="${AWP_SMOKE_ENV_FILE:-/etc/awp-vm-agent/agent.env}"

        if ! CONFIG_CONTENT="$(cat "$CONFIG")"; then
            echo "smoke stub could not read configured runtime input" >&2
            exit 77
        fi
        if ! ENV_CONTENT="$(cat "$ENV_FILE")"; then
            echo "smoke stub could not read credential environment file" >&2
            exit 77
        fi
        case "$CONFIG_CONTENT" in
            *"server_url:"*"agent_name:"*) ;;
            *) echo "smoke stub received an invalid config shape" >&2; exit 77 ;;
        esac
        case "$ENV_CONTENT" in
            *"AWP_AGENT_API_KEY=smoke-test-key"*) ;;
            *) echo "smoke stub received an invalid environment shape" >&2; exit 77 ;;
        esac
        if [ "${AWP_AGENT_API_KEY:-}" != "smoke-test-key" ]; then
            echo "smoke stub did not inherit the service credential" >&2
            exit 77
        fi
        CONFIG_CONTENT=""
        ENV_CONTENT=""
        unset CONFIG_CONTENT ENV_CONTENT

        if [ "${AWP_SMOKE_ONESHOT:-0}" = "1" ]; then
            echo "runtime-inputs-readable"
            exit 0
        fi

        log="/var/log/awp-vm-agent/awp-vm-agent.log"
        [ -d "$(dirname "$log")" ] || log="/tmp/awp-vm-agent.log"
        echo "[$(date -u +%FT%TZ)] startup runtime-inputs-readable (pid=$$)" >> "$log"
        trap 'echo "[$(date -u +%FT%TZ)] SIGTERM received, draining" >> "$log"; exit 0' TERM INT
        while :; do
            echo "[$(date -u +%FT%TZ)] heartbeat" >> "$log"
            sleep 2
        done
        ;;
    *)
        usage
        exit 64
        ;;
esac
