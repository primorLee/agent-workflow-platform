# Throwaway test-only GPG keys

Do not use these fixtures for a real release. `common/mk-test-release.sh`
generates a disposable RSA keyring under `gnupg-test/` and exports only its
public key as `awp-vm-agent-release-key.asc`. Both paths are ignored by Git.

The keyring is reused on later local smoke runs until the operator deletes it;
`make clean` does not remove it. Remove `test-keys/gnupg-test/` and the exported
`.asc` file when the smoke run is complete. Before committing, verify that no
private key, public release key, passphrase, or generated release artifact has
entered the working tree.

The smoke harness passes the disposable public key explicitly with `--pubkey`
and passes the fixture digest with `--binary-sha256`. The installer does not
fall back to a bundled release key. Local `file://` access is enabled only for
the invocation with `AWP_INSTALL_TEST_MODE=1`; digest and detached-signature
verification still run.

Generate the fixtures from the repository root:

```bash
cd services/vm-agent
bash test/distros/common/mk-test-release.sh
```

Production release-key custody and signing are intentionally outside this test
harness and outside public CI.
