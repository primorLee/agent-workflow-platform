# vm-agent install smoke matrix

Runs `install.sh` → `--version` smoke → service start → `uninstall.sh` inside a
clean container for each of the 7 target distros. Logs land in `./logs/`.

## Layout

```
test/distros/
├── README.md                    this file
├── run-all.sh                   orchestrator — iterates 7 distros, emits matrix
├── common/
│   ├── fake-binary.sh           stub `awp-vm-agent` used instead of the real Go binary
│   ├── mk-test-release.sh       builds a signed "release" dir into /releases/
│   └── smoke.sh                 per-container smoke: install → verify → uninstall
├── test-keys/                   THROWAWAY gpg keys for signature tests (see README)
│   └── README.md
├── centos7/Dockerfile           sysv init inside docker (no systemd)
├── rocky9/Dockerfile            systemd-in-docker
├── ubuntu2204/Dockerfile        systemd-in-docker
├── ubuntu2404/Dockerfile        systemd-in-docker
├── debian12/Dockerfile          systemd-in-docker
├── opensuse-leap-15/Dockerfile  systemd-in-docker
└── amazonlinux2/Dockerfile      sysv init (amzn2 ships systemd but runs poorly in docker)
```

## How signature verification is tested

Production release keys must remain outside CI. The smoke matrix uses only a
disposable test key:

1. `common/mk-test-release.sh` generates a throwaway GPG keypair under the
   ignored `test-keys/gnupg-test/` directory.
2. It signs the fake amd64 and arm64 binaries and writes `SHA256SUMS`.
3. It exports only the disposable public key.
4. `common/smoke.sh` copies that public key into a disposable work directory
   and passes it explicitly with `--pubkey` and the fixture SHA-256.
5. The local `file://` release is accepted only for the invocation with
   `AWP_INSTALL_TEST_MODE=1`; signature verification remains mandatory.

**No production private-key material enters `test/distros/` or CI.**

## Running

```
cd services/vm-agent
bash test/distros/run-all.sh               # run every distro, tee to /tmp/distro-install.log
bash test/distros/run-all.sh ubuntu2204    # single distro
```

Requires: docker (or podman via `DOCKER=podman`).

Exit code is non-zero if any distro fails; the final line is a pass/fail matrix.
