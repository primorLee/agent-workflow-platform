---
title: Extension host reload under agent fan-out
tags: [ide, extension-host, subagents, process-tree, file-watcher]
trigger: An IDE extension reloads repeatedly only while many subagents run
verified: 2026-08-22
priority: 3
status: active
---

# Diagnosis

Prove the reload before guessing:

1. correlate extension-host process ids and restart times;
2. inspect whether agent subprocesses are children of the extension host;
3. measure watcher scope and file churn;
4. check memory pressure and operating-system kill evidence;
5. compare the same fan-out from a plain terminal.

If terminal execution is stable but extension-panel execution reloads, the extension host is carrying orchestration load it was not designed to own. If watcher activity also covers generated outputs, both causes can amplify each other.

## Fix order

1. launch high-fan-out work from a terminal-owned process tree;
2. exclude generated state, logs, dependency trees, and artifacts from IDE watchers;
3. optionally configure the extension to use a terminal transport;
4. only then tune resource limits.

Do not reduce task scope merely to hide the process-ownership defect.

## Verification

Run the same bounded fan-out in the extension and terminal paths. Record extension-host pid stability, child ownership, watcher events, and task completion. A lower reload count without completed workers is not a fix.