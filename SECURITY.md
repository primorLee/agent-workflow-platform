# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
security-advisory flow for this repository and include reproduction steps,
expected impact, affected component, and any suggested mitigation.

## Security boundaries

- The public FastAPI server supports numeric loopback binding only. Remote
  exposure requires a separately reviewed gateway or deployment adapter.
- No production credential, signing key, customer record, private endpoint, or
  original Git history belongs in this repository. Local secrets belong in
  ignored private files, process environments, or an OS secret store.
- The control-plane database and Python-worker state use dedicated marked roots
  and fail closed on links or unmarked legacy paths. POSIX enforces owner/mode;
  Windows rejects reparse points but requires an operator-restricted parent ACL.
- The Python and Go workers are trusted launchers, not OS sandboxes. Untrusted
  work requires a separate VM, container, or operating-system identity without
  mounted host credentials.
- Browser-build variables such as `VITE_*` are public. Never place an operator
  key or other secret in them.
- Local traces, task payloads, command output, artifacts, and workflow state may
  contain user data even when source-code redaction is enabled. Review them
  before sharing.
- This source preview contains no VM-agent self-updater or published VM binary. The manual
  VM installer requires a caller-supplied immutable artifact, digest, detached
  signature, trusted key, credential file, and compatible endpoint. Package and
  one-line lifecycle paths fail closed.
- Public pull requests must never run on a self-hosted runner that can reach a
  private network or credential store.

## Supported code

The latest `v0.1.x` source release and the default branch receive security
fixes. No binary distribution is currently supported.
