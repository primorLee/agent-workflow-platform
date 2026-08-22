# `/recipe` — verified operating procedures

Recipes turn recovered failures into executable, searchable procedures.

## Commands

- `/recipe` — list active recipes.
- `/recipe find <terms>` — search title, trigger, and tags.
- `/recipe use <name>` — execute and verify a recipe.
- `/recipe save <name>` — extract a reusable procedure from the current work.
- `/recipe update <name>` — revise steps or pitfalls and append change history.
- `/recipe retire <name>` — mark obsolete; do not delete evidence.

## Required recipe shape

Each recipe contains front matter with `title`, `tags`, `trigger`, `verified`, `priority`, and `status`, followed by goal, prerequisites, executable steps, pitfalls, anti-patterns, and a deterministic verification method. Use `templates/recipe.md`.

## Selection

1. filter to `active` or `superseded` recipes;
2. match trigger and tags to the task;
3. sort by priority ascending, successful uses descending, and verification date descending;
4. load the highest-ranked applicable recipe;
5. fall back to its predecessor only when the newer method does not cover the environment.

## Execution and evolution

Execute one step at a time and verify it before proceeding. On success, update the verification date and usage count. On failure, first apply documented pitfalls; if recovery requires new causal knowledge, update the recipe immediately.

Create a new version instead of mutating in place when the mechanism changes materially. Mark the previous recipe `superseded` and link both directions.

Save a new recipe when at least one is true:

- the procedure has more than three non-obvious steps;
- it recovered from a real error;
- it coordinates an external system;
- it is likely to recur.

A recipe must not contain credentials, private endpoints, personal data, real tenant material, or a raw run transcript.