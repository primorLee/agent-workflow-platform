# `/stakeholder-brief` — diff-driven technical briefing

Generate a concise briefing from actual repository evidence, then pass it through the three-role review protocol.

## Evidence collection

Collect the previous briefing, current version, commits since that briefing, changed-file statistics, project status, gate results, and incident records. Every claimed change must map to a file, commit, test, or measured artifact.

## Writer

The writer produces version scope, concrete changes, repaired failures, measured indicators, unresolved risks, and next decisions. Ban empty phrases such as “improved robustness” unless followed by the failure mode, change, and verification.

## Blind critic

The critic verifies cited files and commits, searches for omitted high-impact changes, checks that indicators are reproducible, and looks for quality drop-off in later sections.

## Final reviewer

Score the brief from zero to ten. Eight or above can be delivered, seven receives bounded corrections, and six or below returns to the writer. Publish only the reviewed artifact, not intermediate drafts.