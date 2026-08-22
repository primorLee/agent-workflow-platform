---
title: Electron builder symlink extraction without elevated privileges
tags: [electron, packaging, windows, symlink, cache]
trigger: A Windows package build fails while extracting signing-tool symlinks
verified: 2026-08-22
priority: 4
status: active
---

# Symptom

Archive extraction succeeds for ordinary files and then fails on a non-Windows symlink entry when the account cannot create symlinks.

## Root cause

The build helper downloads a cross-platform archive. The local build needs only the Windows payload, but the extractor still attempts to create unrelated symlinks before the cache is considered complete.

## Recovery options

1. **Canonical cache preparation** — populate the exact versioned cache directory from a verified archive while omitting unused platform entries. Record the archive checksum.
2. **Developer mode or equivalent privilege** — appropriate for managed developer machines.
3. **Controlled artifact mirror** — appropriate for CI when the mirror preserves checksums and provenance.

Never copy from an unknown random cache. Never disable signature verification to get past extraction.

## Verification

Build from a clean application workspace while reusing only the prepared tool cache. Confirm artifact creation, signature policy, application launch, and a second build that proves cache reuse.