# Public release boundary

The original prototype mixed reusable Agent-platform code with deployment
identity, domain-specific IC-design integrations, generated data, and runtime
history. This repository retains the reusable implementation while enforcing a
strict public boundary.

## Retained

- desktop runtime and session-management state machines;
- task, event, presence, retry, resume, and backpressure mechanisms;
- worker and VM-agent lifecycle management;
- workflow recipes, role-separated review, scheduler, guardian, and
  reproduction gates;
- health checks, locking, rollback, metrics, and local deployment examples;
- regression and fault-injection tests that do not contain production data;
- provider-neutral hosted adapters that remain disabled until explicit operator
  configuration is supplied.

## Replaced with configuration or synthetic fixtures

- service names, hostnames, ports, absolute paths, download locations, and
  update manifests;
- account identifiers, organization names, screenshots, log payloads, and
  historical run state;
- authentication fixtures and test keys.

## Excluded

- credentials, private keys, signing material, and credential stores;
- customer data and support records;
- IC-design recipes, PDK integrations, simulation assets, and warm-start data;
- billing, account-pool, private identity-injection, and hosted-service
  integrations tied to the retired product;
- private tunnels, network topology, and production deployment manifests;
- the original Git history and generated build artifacts.

## Deliberately not claimed

- no non-loopback FastAPI deployment or general-purpose remote gateway;
- no OS isolation from either worker allowlist;
- no CPU, memory, disk, container, or OS enforcement from session metadata;
- no mounted VM-agent WebSocket endpoint in the public FastAPI service;
- no control-plane release publishing or artifact route;
- no automatic VM-agent updater or published application/VM binary;
- no trace/log transport or notification delivery in the observability example.

Control-plane and Python-worker state use dedicated marked roots. The worker's
final `work_dir` must be absent on first start; later starts require its exact
marker. POSIX enforces private owner/mode, while Windows rejects links/reparse
points and requires an operator-restricted parent ACL. An old unmarked directory
is retained as-is and is never silently adopted or migrated. The registered
worker token stays below that state root, never in operator YAML.

The root release gate scans source files and reachable Git objects. Tests and
policy definitions receive the same rules as other files; unavoidable generic
security-handler strings require an exact rule + canonical path + semantic
fragment + line-hash allowance that is revalidated on every run.

Generated `dist`/`build` trees are not skipped. Desktop and admin CI build their
compiled outputs and rerun the boundary scanner over those bytes. Opaque test
binaries, archives, executable packages, databases, logs, unreadable files, and
files over the review-size limit fail closed; a `synthetic` filename is not a
waiver. Normal UI-owned image/font assets receive a byte-preserving metadata
scan.

[`verify_public_boundary_fail_closed.py`](../scripts/verify_public_boundary_fail_closed.py)
executes the scanner CLI against a suite of isolated bypass fixtures before the real
tree scan. This prevents an exception for policy files, tests, ignored build
output, or synthetic filenames from silently reopening the boundary.

The content rules also inspect camel-cased identifiers and single-line minified
output. Generic multi-user, tenant, optimization, and simulation vocabulary is
allowed; retired product surfaces and specialized editor/task identifiers are
blocked. Configured private-network fallbacks and disabled SSH host-key
verification are also release-blocking findings.

This custom gate is strongest at repository-specific identity,
specialized-domain content and names, forbidden file classes, paths, endpoints,
and known token shapes. It is not a substitute for an entropy/general secret
scanner. Every public source tag requires recorded full-history results from
independent tools such as Gitleaks and TruffleHog. Installer archives are not
produced by the current CI.
