# Manual installer public-key boundary

This directory intentionally contains no operator release key and has no
runtime consumer in the source preview. Package build and lifecycle paths are
disabled until a signed release exists.

The reviewed manual installer requires the caller to pass a local armored
public key with `--pubkey FILE`, independently supplies the expected SHA-256,
and accepts no default download endpoint. Obtain that public key through a
trusted channel separate from the artifact host. Never commit a private key,
passphrase, API key, populated keyring, or operator release key here.
