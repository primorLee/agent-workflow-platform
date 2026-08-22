---
title: Public service incident triage
tags: [incident, service, rollback, health-check, recovery]
trigger: An external health check fails, times out, or returns a gateway error
verified: 2026-08-22
priority: 1
status: active
---

# Goal

Separate process failure, deployment residue, schema drift, and proxy failure before changing production state.

## 1. Two-minute parallel triage

Collect, without mutating state:

```text
service-manager status <service>
service-manager logs <service> --since <window>
list recent deployment snapshots
check listener <local-port>
request local health endpoint
request external health endpoint
```

Record one timestamp window for all evidence. Branch on facts:

- process killed or restarting → deployment/runtime branch;
- traceback on startup → application/schema branch;
- process and local health good, external health bad → proxy/network branch;
- no conclusive evidence → preserve state and widen observation.

## 2A. Deployment residue or import shadowing

Compare the deployed file manifest with the release manifest. Look for stale files, unexpected import precedence, and cached bytecode. Restore by moving the broken tree to a forensic name and atomically promoting a known-good snapshot. Do not delete the broken tree before evidence is captured.

## 2B. Schema drift or partial migration

Capture the complete traceback, identify the actual datastore, compare live schema to the expected migration, and test the migration against a copy. Roll back application code only after confirming backward compatibility. Never experiment on the sole production database.

## 2C. Healthy process but external failure

Check reverse proxy health, upstream listener count, resource pressure, dependency connectivity, and local-versus-external requests. A reachable gateway does not prove the backend is healthy.

## 3. Recovery gate

All four must pass:

1. process remains healthy through several checks;
2. local request succeeds;
3. external request succeeds;
4. the original failing transaction succeeds.

Record duration, user-visible impact class, exact root cause, recovery action, and prevention. Update this recipe when the incident reveals a new branch.

## Anti-patterns

- restarting every component before collecting evidence;
- deleting a failed deployment instead of preserving it;
- treating one green probe as full recovery;
- editing proxy, app, and datastore simultaneously;
- publishing real endpoints or logs in an example.