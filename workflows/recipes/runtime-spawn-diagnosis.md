---
title: Runtime spawn format diagnosis
tags: [runtime, spawn, packaging, executable, platform]
trigger: Process creation fails before the child emits stdout or stderr
verified: 2026-08-22
priority: 2
status: active
---

# Goal

Distinguish missing files, permission failures, wrong executable format, and wrapper mistakes before blaming network or authentication.

## Decision sequence

1. capture platform, architecture, package source, and resolved executable path;
2. inspect file existence, size, permissions, and magic bytes;
3. run the exact executable directly with `--version`;
4. compare the launcher path with the installer manifest;
5. verify that a script has an interpreter and a native binary matches the host;
6. only after the process starts, investigate network and credentials.

A process that never spawned cannot have failed because of an upstream API.

## Common packaging defect

A package can contain a placeholder, text wrapper, or binary for another platform under the expected executable name. File existence checks pass, but native process creation fails. Validate executable identity during installation, not at first chat request.

## Required telemetry

Record platform, architecture, resolved provider, artifact version, checksum prefix, file type, spawn error category, and whether direct execution succeeded. Do not record tokens, user paths, or full environment dumps.

## Regression

Test every supported platform with a real packaged artifact plus deliberately wrong-format fixtures. Assert a specific diagnostic instead of a generic “start failed.”