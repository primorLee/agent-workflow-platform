# Contributing

This project preserves a production-derived Agent workflow platform while
keeping private identity, deployment topology, credentials, customer data, and
vertical-specific logic outside the public tree.

## Before opening a pull request

1. Keep the change within one component where practical.
2. Add or update a regression test for every behavior change.
3. Describe the original failure mode, the invariant introduced, and the exact
   evidence that now passes.
4. Keep documentation honest about status: distinguish a mounted/runnable
   surface, a tested composition library, and an unverified extension point.
5. Run the component validator and the static public-boundary gate.
6. Confirm staged files and generated output contain no credentials, private
   keys, internal hostnames, customer data, production paths, or runtime state.

Do not submit real logs, private configuration, screenshots containing account
information, generated databases, local traces, worker state roots, or task
payloads copied from an operational environment. Synthetic fixtures must use
invalid credentials and reserved example addresses, but a `synthetic` filename
is never a waiver for dangerous file classes or content.

The root validator does not install dependencies. Keep install steps explicit,
then run the relevant command documented in
[`docs/getting-started.md`](docs/getting-started.md). Before a public release,
also run static validation with `--history` and independent full-history secret
scanners.
