#!/bin/sh
# mk-test-release.sh — build a "signed release" tree for smoke tests.
#
# Inputs  : test-keys/ (auto-created)
# Outputs : releases/v0.1.0-smoketest/awp-vm-agent-linux-amd64
#           releases/v0.1.0-smoketest/awp-vm-agent-linux-amd64.asc
#           releases/v0.1.0-smoketest/SHA256SUMS
#           releases/v0.1.0-smoketest/SHA256SUMS.asc
#           releases/latest.txt (content: v0.1.0-smoketest)
#           test-keys/awp-vm-agent-release-key.asc
#
# Idempotent: reuses an existing test keypair if one is present.

set -eu

HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
DISTROS_DIR="${HERE}/.."
KEYS_DIR="${DISTROS_DIR}/test-keys"
GNUPGHOME_TEST="${KEYS_DIR}/gnupg-test"
RELEASE_DIR="${DISTROS_DIR}/releases/v0.1.0-smoketest"

VERSION="v0.1.0-smoketest"
UID_EMAIL="awp-vm-agent-test@awpai.invalid"

mkdir -p "$KEYS_DIR" "$RELEASE_DIR"
chmod 0700 "$KEYS_DIR"

# 1. Create test key if absent.
if ! GNUPGHOME="$GNUPGHOME_TEST" gpg --list-secret-keys 2>/dev/null | grep -q "$UID_EMAIL"; then
    echo "[mk-test-release] generating throwaway test key"
    rm -rf "$GNUPGHOME_TEST"; mkdir -p "$GNUPGHOME_TEST"; chmod 0700 "$GNUPGHOME_TEST"
    cat >"${GNUPGHOME_TEST}/batch" <<EOF
%no-protection
Key-Type: RSA
Key-Length: 2048
Subkey-Type: RSA
Subkey-Length: 2048
Name-Real: Agent Workflow Platform Agent TEST
Name-Email: ${UID_EMAIL}
Expire-Date: 30
%commit
EOF
    GNUPGHOME="$GNUPGHOME_TEST" gpg --batch --quiet --generate-key "${GNUPGHOME_TEST}/batch"
    rm -f "${GNUPGHOME_TEST}/batch"
fi

# 2. Export pubkey.
GNUPGHOME="$GNUPGHOME_TEST" gpg --armor --export "$UID_EMAIL" > "${KEYS_DIR}/awp-vm-agent-release-key.asc"
echo "[mk-test-release] exported pubkey: ${KEYS_DIR}/awp-vm-agent-release-key.asc"

# 3. Build the "binary" (the fake stub).
cp "${HERE}/fake-binary.sh" "${RELEASE_DIR}/awp-vm-agent-linux-amd64"
chmod 0755 "${RELEASE_DIR}/awp-vm-agent-linux-amd64"
cp "${HERE}/fake-binary.sh" "${RELEASE_DIR}/awp-vm-agent-linux-arm64"
chmod 0755 "${RELEASE_DIR}/awp-vm-agent-linux-arm64"

# 4. Sign each arch's binary.
for arch in amd64 arm64; do
    bin="${RELEASE_DIR}/awp-vm-agent-linux-${arch}"
    sig="${bin}.asc"
    rm -f "$sig"
    GNUPGHOME="$GNUPGHOME_TEST" gpg --batch --yes --armor --detach-sign \
        --output "$sig" "$bin"
done

# 5. SHA256SUMS manifest.
(cd "$RELEASE_DIR" && \
    sha256sum awp-vm-agent-linux-amd64 awp-vm-agent-linux-arm64 > SHA256SUMS)

# 6. Sign SHA256SUMS.
rm -f "${RELEASE_DIR}/SHA256SUMS.asc"
GNUPGHOME="$GNUPGHOME_TEST" gpg --batch --yes --armor --detach-sign \
    --output "${RELEASE_DIR}/SHA256SUMS.asc" \
    "${RELEASE_DIR}/SHA256SUMS"

# 7. latest.txt
echo "$VERSION" > "${DISTROS_DIR}/releases/latest.txt"

echo "[mk-test-release] done: $RELEASE_DIR"
ls -la "$RELEASE_DIR"
