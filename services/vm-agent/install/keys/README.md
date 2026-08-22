# Installer release public key

The public repository does not define a production release key or download
endpoint. `install.sh` therefore requires `--pubkey FILE` on every run. Supply
an armored public key obtained through a trusted channel that is independent of
the artifact host, and review its fingerprint before installation.

Do not download the public key from the same unverified command that downloads
the binary. Never place a private key, passphrase, API key, or populated
production keyring in this directory.

The distro smoke harness may generate a disposable key outside this directory.
Local `file://` fixtures are accepted only when `AWP_INSTALL_TEST_MODE=1`; the
signature and caller-supplied SHA-256 checks remain mandatory in test mode.
