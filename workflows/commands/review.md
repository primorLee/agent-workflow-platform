# `/review` — architecture, code, API, pipeline, and security review

## Usage

- `/review architecture`
- `/review code <path>`
- `/review api <path>`
- `/review pipeline <path>`
- `/review security <path>`
- `/review` reviews the most recently changed high-risk scope.

## Parallel review roles

For architecture and broad code reviews, run three independent passes:

1. **Structure** — boundaries, dependencies, cycles, dead paths, state ownership.
2. **Consistency** — naming, error contracts, configuration, logging, persistence.
3. **Operational debt** — repeated incidents, missing tests, stale documentation, unsafe defaults.

For a narrow code review, use one implementation reviewer and one test reviewer. Neither should infer correctness only from a green test suite.

## Minimum checks

- functions with excessive length or nesting;
- broad exception handling that hides failures;
- hard-coded environment identity;
- command, query, path, and template injection;
- resources that are not closed or rolled back;
- missing boundary and failure-path tests;
- mocks that bypass the changed behavior;
- API code and documentation drift;
- recovery, timeout, retry, and idempotency behavior.

## Output

List actionable findings first, ordered by severity. Every finding includes a tight file location, failure scenario, impact, and smallest viable correction. If no actionable finding exists, say so and state the residual testing gaps.

Use the writer → blind critic → final reviewer protocol for externally published or high-impact review reports.