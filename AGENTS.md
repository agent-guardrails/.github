# AGENTS.md — rules for AI agents (agent-guardrails org)

Applies to every repository in this organization. A repo-specific AGENTS.md,
when present, adds to (and never replaces) these rules.

## Workflow: issue first, then board, then code

1. Every non-trivial change (bug, feature, refactor, docs) starts with a GitHub
   issue in the repo you are working in — create it **before** writing code.
   (A one-line typo fix may skip this.)
2. Link the issue to the org project
   ["Agent Guardrails Roadmap"](https://github.com/orgs/agent-guardrails/projects/1)
   and set its Status.
3. Reference the issue from commits (`#123`) and the PR description (`Closes #123`).
4. On merge the issue closes automatically — verify its Status on the board moved
   to Done.

## Shared contracts live in agent-guardrails/docs

- `spec/<family>/` — normative specs, `schemas/` — machine-readable contract,
  `adr/` — decisions (MADR, one decision per file).
- An implementation change that touches anything a spec describes (protocol,
  budgets/clamps, config semantics, security invariants) must update the matching
  spec **and** schema in the same PR.
- A real architectural choice (options were weighed) → new ADR with the next
  sequential number. Never edit an Accepted ADR — supersede it with a new one.

## Basics

- Tests and typecheck must pass before every push.
- Keep changes minimal and on-topic; no drive-by refactors or formatting churn.
- Never commit secrets, keys, or tokens. Never weaken fail-closed behavior.
