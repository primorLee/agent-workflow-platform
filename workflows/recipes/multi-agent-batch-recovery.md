---
title: Multi-agent batch recovery
tags: [subagents, batching, retry, ownership, checkpoint]
trigger: A parallel batch returns mixed success, failure, partial, or conflicting edits
verified: 2026-08-22
priority: 2
status: active
---

# Goal

Preserve verified work while preventing one failed worker from corrupting or blocking the entire batch.

## Reconcile

1. freeze worker results and owned-path declarations;
2. inspect each diff independently;
3. classify passed, failed, partial, conflict, or missing artifact;
4. run the declared check for passed work before merging;
5. preserve verified partial work behind a narrow commit or patch;
6. requeue only the remainder with failure evidence attached.

## Retry

A retry must state which hypothesis changed. Split unclear tasks, change ownership on conflicts, and quarantine a failure class after bounded repeated evidence. Do not launch a duplicate worker against the same files while the first may still be running.

## Close

Update task ids, batch status, heartbeat, and checkpoint. The batch summary reports verified results, not merely workers that returned successfully.