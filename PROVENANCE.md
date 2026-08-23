# Provenance and public-release boundary

This repository is a curated public extraction of an abandoned commercial
prototype that was exercised in real development and deployment environments.
It is not a clean-room rewrite. The reusable desktop, orchestration, worker,
recovery, and operations mechanisms—and the regression tests that capture their
failure modes—were retained and generalized in place.

Product branding, private infrastructure identity,
credentials, customer data, domain-specific IC-design logic, and historical
runtime state are intentionally excluded. Commercial-only account integrations
are also excluded. The public examples use local endpoints, random or explicitly
supplied secrets, and synthetic state.

The public repository starts with a new Git history. That prevents removed
private material from remaining reachable through earlier commits while
preserving the implementation and tests of the reusable platform. The
[public-release boundary](docs/public-release-boundary.md) documents the exact
retained, replaced, excluded, and non-claimed surfaces.

## Extraction snapshot

The public extraction was prepared on 2026-08-22 from a retired production
desktop and service snapshot. The clean public package line starts at `0.1.0`;
historical component snapshot identifiers are disclosed only where they make
the extraction provenance concrete (for example, the desktop snapshot). Those
identifiers are not public tags and do not claim release-line continuity.
`v0.1.0` is the first public source tag; it does not publish an application or
VM binary. No private commit identifier, server name, username, or source
filesystem path is carried into the new history.
