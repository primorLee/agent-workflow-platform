## Problem

Describe the user-visible or operational failure this change addresses.

## Boundary

State which path is wired by this change and which related paths remain optional or unsupported.

## Evidence

List the exact commands run and summarize their results. Include a regression test for every repaired failure mode.

## Checklist

- [ ] I kept credentials, private endpoints, customer data, and private paths out of the change.
- [ ] I did not describe a composition library as an already-mounted feature.
- [ ] I documented any change to delivery, persistence, network, or trust-boundary semantics.
- [ ] I used synthetic fixtures and bounded logs.
- [ ] I ran the focused component validator and the relevant public-boundary checks.
