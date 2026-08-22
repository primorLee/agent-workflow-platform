---
title: Preserve SSE event and data pairing through filters
tags: [sse, streaming, redaction, parser, state-machine]
trigger: A streaming client crashes or misparses after a redaction/filtering change
verified: 2026-08-22
priority: 2
status: active
---

# Symptom

The upstream stream is valid, but the client fails only when a filter removes selected lines. Pinning or replacing the client appears to help inconsistently.

## Root cause

Server-Sent Events are records, not independent text lines. An `event:` line and its following `data:` lines form one logical unit. Dropping only the event name can reinterpret the retained data as the previous/default event and break the downstream state machine.

## Fix

Parse complete SSE records separated by blank lines. Decide whether to retain, redact, or drop the **whole record**. Preserve comments and retry fields according to an explicit policy. Never redact by line substring alone.

## Collision rule

A forbidden token can appear inside ordinary technical text. Match protocol fields and structured payload keys, not unrestricted substrings. Keep a regression corpus with near-collision words.

## Verification

Cover:

- one event with one data line;
- one event with multiple data lines;
- consecutive filtered and allowed events;
- an allowed payload containing a near-collision token;
- a chunk boundary between `event:` and `data:`;
- end-of-stream without a trailing blank line.

Assert both the emitted bytes and the downstream event sequence.