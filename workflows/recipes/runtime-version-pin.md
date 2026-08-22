---
title: Deliberate agent runtime version pin
tags: [runtime, versioning, rollback, release]
trigger: A bundled agent runtime must be upgraded or rolled back safely
verified: 2026-08-22
priority: 2
status: active
---

# Goal

Make every installer, launcher, health check, and updater resolve one explicit runtime version.

## Single source of truth

Use `AWP_RUNTIME_PINNED_VERSION` or one checked-in manifest field. Do not duplicate a version in build scripts, update feeds, UI text, and tests.

## Upgrade

1. set the candidate pin in a branch;
2. fetch through the normal runtime provider;
3. verify archive checksum and executable identity;
4. run install, first launch, streaming, interruption, resume, and update tests;
5. verify both clean install and in-place upgrade;
6. publish the manifest only after artifacts exist for every supported platform.

## Emergency rollback

Restore the previous pin and manifest atomically. Confirm the updater accepts the downgrade policy, removes no user state, and starts the previous runtime. Keep the failed candidate available for forensic comparison.

## Unpinning

Auto-following an upstream latest tag removes reproducibility and rollback guarantees. Use it only in an explicitly unstable channel with a quarantine period.

## Verification

The UI version, launcher-resolved version, executable `--version`, artifact checksum record, and update manifest must all agree.