# Retired public-key fixture

`test-signing.asc` is a public test fixture with no runtime caller in this
source preview. It is not a release trust root, credential, or proof of a
published sign-and-verify pipeline. The manual installer and distro matrix use
explicit caller-supplied or disposable keys instead.

Do not add a private half, passphrase, populated keyring, operator key, or
production identity to this directory. Before the first binary tag, either
remove this orphan fixture or introduce a separately reviewed direct test
consumer and a complete release-key custody procedure.
