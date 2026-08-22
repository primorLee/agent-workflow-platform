---
title: Batch document ingestion with measurable quality
tags: [documents, ingestion, deduplication, metadata, quality]
trigger: A collection of documents must be extracted into a searchable local index
verified: 2026-08-22
priority: 5
status: active
---

# Workflow

1. snapshot the pre-ingestion counts and quality distribution;
2. hash source files and normalize stable identifiers;
3. extract text and metadata while retaining per-field provenance;
4. validate required fields and quarantine failures;
5. deduplicate using identifier, content hash, and normalized title in that order;
6. commit records atomically;
7. compare post-ingestion counts, missing-field rates, duplicates, and parser errors to baseline.

## Retry policy

Retry only transient acquisition and parser failures. A document that repeatedly exceeds resource limits is split or quarantined with evidence; it is not silently skipped.

## Quality gate

Report total discovered, attempted, imported, deduplicated, quarantined, and failed. Sample records across sources, not only the easiest format. Preserve the original source reference so every extracted field can be audited.

## Privacy

Do not publish raw documents, personal metadata, access tokens, or private source locations as fixtures. Use generated examples for tests.