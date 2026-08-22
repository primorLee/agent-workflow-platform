# Production lessons encoded in the platform

The project is intentionally opinionated. Its mechanisms were added after
ordinary Agent demos failed under long-running, multi-process, and partially
connected workloads.

## Durable evidence beats transient status

A process being alive does not prove that useful work is progressing, and a
single filesystem timestamp does not prove that a result is complete. The
platform records structured heartbeats, checkpoints, task transitions, and
artifact evidence. Completion gates verify durable outputs rather than trusting
one success flag.

## Resume state is a protocol

Cross-session recovery is not a chat summary. Run state is written atomically,
versioned, checked against a schema by the workflow gate, and paired with the
exact next action, blockers, and evidence. A new process can therefore
distinguish fresh work, recoverable work, and work that requires human input.

## Stalls require hysteresis

One missed heartbeat can be noise. The guardian evaluates heartbeat age,
requires three consecutive failed checks, and applies a cooldown before
escalating. Its structured event and recovery instruction carry session,
backlog, checkpoint, and status evidence without treating that context as a
second liveness signal.

## Failures should change the system

An incident is not closed when one run succeeds. The failure flywheel turns the
minimal reproducer into a recipe, a regression check, and an indexed recovery
path. Future agents load the smallest relevant lesson instead of rediscovering
the whole incident.

## Review roles should disagree on purpose

Implementation, specification review, and adversarial review use separate
contracts. The author supplies evidence; the specification reviewer checks the
requested behavior; the adversarial reviewer searches for false completion,
unsafe side effects, and missing configurations. Self-review alone cannot close
a task.

## Deployment must be reversible

Locks prevent overlapping releases. Health probes must exercise the real
boundary, and a failed probe returns to the last known-good artifact. Stable and
preview channels share the same verification path but never share mutable
release state.

## Local defaults are part of security

The public build starts on localhost, uses disposable development state, and
does not require a hosted account. Network access, remote execution, update
feeds, and credentials are explicit configuration choices rather than hidden
defaults.
