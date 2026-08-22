#!/bin/sh
#
# run-all.sh — iterate the 7-distro install smoke matrix in docker.
#
# Usage:
#   bash services/vm-agent/test/distros/run-all.sh             # all 7
#   bash services/vm-agent/test/distros/run-all.sh rocky9      # just one
#
# Prereqs:
#   * docker (or podman — set env DOCKER=podman)
#   * gpg (for building the fake signed release)
#   * sha256sum
#
# Exits non-zero if any distro fails. Final output is a pass/fail matrix.

set -u

DOCKER="${DOCKER:-docker}"
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
VM_AGENT_ROOT="$(CDPATH= cd -- "${HERE}/../.." && pwd)"

DISTROS="centos7 rocky9 ubuntu2204 ubuntu2404 debian12 opensuse-leap-15 amazonlinux2"

# Init-system expected inside each image — kept in sync with Dockerfiles.
init_for_distro() {
    case "$1" in
        centos7|amazonlinux2)           echo sysv ;;
        *)                              echo systemd ;;
    esac
}

LOGDIR="${HERE}/logs"
mkdir -p "$LOGDIR"

# ----- sanity -----
if ! command -v "$DOCKER" >/dev/null 2>&1; then
    if [ "${DOCKER_SKIP:-0}" != "1" ]; then
        printf 'run-all.sh: %s not found on PATH\n' "$DOCKER" >&2
        printf '             export DOCKER=podman if you prefer podman\n' >&2
        printf '             export DOCKER_SKIP=1 to just do static checks\n' >&2
        exit 2
    fi
    printf 'run-all.sh: docker not on PATH and DOCKER_SKIP=1 — static checks only.\n'
fi

if ! command -v gpg >/dev/null 2>&1; then
    echo "run-all.sh: gpg not found — required to build the fake signed release" >&2
    exit 2
fi

# ----- build fake signed release -----
echo "[run-all] building fake signed release"
sh "${HERE}/common/mk-test-release.sh" || {
    echo "[run-all] failed to mk-test-release" >&2
    exit 2
}

if [ "${DOCKER_SKIP:-0}" = "1" ]; then
    echo "[run-all] DOCKER_SKIP=1 — skipping container runs (static only)"
    exit 0
fi

# ----- resolve list -----
if [ $# -gt 0 ]; then
    DISTROS="$*"
fi

passed=""
failed=""

for distro in $DISTROS; do
    init_sys="$(init_for_distro "$distro")"
    image_tag="awp-vm-agent-smoke-${distro}"
    dfile="${HERE}/${distro}/Dockerfile"
    if [ ! -f "$dfile" ]; then
        echo "[run-all] no Dockerfile for $distro, skipping"; continue
    fi

    log="${LOGDIR}/${distro}.log"
    echo
    echo "============================================================"
    echo "  distro = ${distro}   init = ${init_sys}"
    echo "============================================================"

    # 1. build
    if ! "$DOCKER" build -t "$image_tag" -f "$dfile" "${HERE}/${distro}" >"$log" 2>&1; then
        echo "[run-all] BUILD FAIL for $distro (see $log)"
        tail -n 20 "$log"
        failed="$failed $distro(build)"
        continue
    fi
    echo "[run-all] image built: $image_tag"

    # 2. run
    # Mount the repo's vm-agent as /src inside the container.
    if ! "$DOCKER" run --rm \
        -v "${VM_AGENT_ROOT}/install:/src/install:ro" \
        -v "${HERE}/test-keys:/src/test-keys:ro" \
        -v "${HERE}/releases:/src/releases:ro" \
        -v "${HERE}:/src/test/distros:ro" \
        "$image_tag" \
        >>"$log" 2>&1
    then
        echo "[run-all] SMOKE FAIL for $distro (see $log)"
        tail -n 40 "$log"
        failed="$failed $distro(smoke)"
        continue
    fi
    echo "[run-all] smoke pass: $distro"
    passed="$passed $distro"
done

echo
echo "============================================================"
echo "  SUMMARY"
echo "============================================================"
printf '  pass: %s\n' "${passed:-<none>}"
printf '  fail: %s\n' "${failed:-<none>}"

[ -z "$failed" ] || exit 1
exit 0
