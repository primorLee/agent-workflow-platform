---
title: Inline local artifact rendering over IPC
tags: [artifact, rendering, ipc, sandbox, desktop]
trigger: An agent-generated image or report must appear inline without exposing the filesystem
verified: 2026-08-22
priority: 4
status: active
---

# Architecture

Keep seven links intact:

1. tool writes an artifact inside an allowed workspace;
2. backend validates canonical path and media type;
3. backend reads bounded bytes;
4. IPC response carries bytes plus declared type;
5. renderer converts to an object/data URL;
6. message model stores an artifact reference;
7. lifecycle code revokes temporary URLs.

## Decisions

- trust canonical path containment, not a user-supplied prefix;
- sniff a small allowlist of media signatures instead of trusting extension alone;
- cap decoded size before allocating renderer memory;
- never put raw local paths into HTML;
- distinguish missing artifact, rejected type, oversized artifact, and decode failure.

## Verification

Test traversal attempts, symlink escape, wrong extension, truncated data, oversized payload, multiple artifacts, reload, and URL cleanup. The UI must show a safe error card without crashing the stream.