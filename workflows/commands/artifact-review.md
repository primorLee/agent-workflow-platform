# `/artifact-review` — three-role adversarial audit

Audit a report, plan, design document, or release note with independent writer, critic, and final reviewer roles.

## 1. Select the artifact

Use the supplied path or the most recently changed substantial document. Read the complete artifact and the evidence it cites.

## 2. Blind critic

The critic receives the artifact and evidence locations, but not the writer's intent or desired conclusion. It checks:

1. every number has traceable provenance;
2. links, paths, and cited lines exist;
3. required sections and failure cases are present;
4. worst cases are not hidden behind averages;
5. claims follow from evidence rather than tone;
6. contradictions and vague improvement language are exposed;
7. later sections receive the same scrutiny as early sections;
8. reproduction instructions are executable.

The critic lists fatal issues first and cannot award more than five out of ten when a fatal issue remains.

## 3. Final reviewer

The final reviewer independently checks the critic's strongest claims. Score thresholds:

- 8–10: publishable;
- 7: small, bounded corrections;
- 0–6: return for rework.

Allow at most two writer rework rounds. The final reviewer owns the final decision and records disagreements with the critic.