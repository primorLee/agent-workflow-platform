# Provenance and public boundary

This directory is a curated extraction of a production desktop client, not a greenfield mock. The public version keeps the horizontal engineering and removes retired commercial integrations and the former IC-design vertical.

The curated source snapshot came from desktop version `1.7.148`. The public package starts a separate preview line at `0.1.0`; that public number does not rewrite or claim continuity with the former commercial release history.

| Area | Retained from production | Removed or replaced for the public repository |
|---|---|---|
| Runtime lifecycle | single-instance lock, main/preload separation, stable/insiders channels, runtime download state machine, clean shutdown | signing material, private update endpoints, branded manifests |
| Agent execution | streamed CLI event parser, restart/exit handling, MCP configuration, session recovery, bounded stderr diagnostics | private identity payloads and vertical tool aliases |
| Remote workspace | SSH transport, TOFU host-key handling, progress/cancel flow, write jail, command guard, per-conversation isolation | vendor-tool detection, specialized runtimes, proprietary bridge adapters |
| UI/data path | real Vue stores, SSE rendering, artifacts, notifications, settings, health state, durable local demo sessions | billing, invite, customer-account administration, hosted-only defaults |
| Regression coverage | incident-derived tests for stale streams, cross-session isolation, retry/idempotency, credential migration, host-key mismatch, cleanup, and rollback | live production probes, remote account fixtures, opaque customer artifacts, vertical-specific fixtures |

The optional cloud-artifact protocol is retained as an adapter interface, but the public `8100` control plane does not claim to implement it. The default `8787` demo is deliberately local and deterministic.
